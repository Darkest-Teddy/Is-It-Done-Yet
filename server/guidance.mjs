/**
 * The Qwen3 relay: the one place a model key is allowed to exist.
 *
 * `.env.example` has carried the warning since the OpenAI integration landed -- anything
 * prefixed `VITE_` is inlined into the client bundle and readable by anyone who opens the page,
 * and this repo publishes a built app. A browser-held key is therefore a booth-laptop
 * convenience with a short life, not a deployment strategy. This file is the deployment
 * strategy: the key lives in the server's environment, the browser posts a prompt, and the
 * answer comes back with nothing sensitive attached.
 *
 * Zero dependencies, matching `static.mjs`. It is one `fetch` to an OpenAI-compatible endpoint;
 * a framework for that is a supply chain to audit for no benefit.
 *
 * NO PROVIDER IS HARDCODED. Qwen3 is served by Alibaba's DashScope OpenAI-compatible endpoint,
 * by OpenRouter, and by anything running vLLM or Ollama. They differ in the base URL and the
 * model id, both of which are environment variables here. Nothing else changes.
 *
 * MOUNTED IN BOTH SERVERS. `vite.config.ts` mounts it on the dev server so the relay works
 * under `npm run dev`; `static.mjs` mounts it for the built app. Same handler, so what is
 * tested in dev is what runs.
 */

const UPSTREAM_TIMEOUT_MS = Number(process.env['QWEN_TIMEOUT_MS'] ?? 8000);

/** A prompt is a few kilobytes. Anything larger is not a prompt and is not read. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * UNVERIFIED default, and it is the likeliest thing in this file to be wrong.
 *
 * Model ids differ per provider for the same weights: DashScope lists bare ids, OpenRouter
 * namespaces them (`qwen/...`), Ollama uses a tag (`qwen3:8b`). Set `QWEN_MODEL` to whatever
 * the provider you chose actually lists rather than debugging a 404 at the table.
 */
const DEFAULT_MODEL = 'qwen3-32b';

/**
 * Reads the upstream out of the environment, or null when nothing is configured.
 *
 * Null is not an error. It is the state of a fresh checkout, and the browser falls back to
 * `localGuidance`, which is a complete answer on its own. The handler says so plainly in a 503
 * rather than pretending to have tried.
 */
export function guidanceConfig(env = process.env) {
  const baseUrl = env['QWEN_BASE_URL'];
  const apiKey = env['QWEN_API_KEY'];
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    // Blank is legitimate: a local Ollama or an unauthenticated vLLM on the same LAN needs no
    // key, and demanding one would rule out the offline-friendliest way to serve this.
    apiKey: apiKey ?? '',
    model: env['QWEN_MODEL'] ?? DEFAULT_MODEL,
    timeoutMs: Number.isFinite(UPSTREAM_TIMEOUT_MS) ? UPSTREAM_TIMEOUT_MS : 8000,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const send = (res, status, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

/**
 * POST `{ system, user, model? }` -> `{ content }`.
 *
 * The client may name a model; it may not name a base URL or supply a key. That asymmetry is
 * the point -- a relay that forwards wherever the caller says is an open proxy with our
 * credentials on it.
 *
 * Every failure is a JSON body with an `error` string and a non-200 status. The browser treats
 * all of them identically (fall back to the local answer), so the distinction is for whoever is
 * reading the logs at 4am, not for the app.
 */
export async function handleGuidance(req, res) {
  if ((req.method ?? 'GET') !== 'POST') {
    send(res, 405, { error: 'POST only' });
    return;
  }

  const cfg = guidanceConfig();
  if (cfg === null) {
    send(res, 503, { error: 'QWEN_BASE_URL is not set on this server' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: 'body was not JSON, or was too large' });
    return;
  }

  const system = typeof parsed?.system === 'string' ? parsed.system : '';
  const user = typeof parsed?.user === 'string' ? parsed.user : '';
  if (user === '') {
    send(res, 400, { error: 'no prompt' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey === '' ? {} : { authorization: `Bearer ${cfg.apiKey}` }),
      },
      body: JSON.stringify({
        // The client may pick the model, because a demo switching between a local Ollama and a
        // hosted endpoint is a legitimate thing to want. It may not pick where it goes.
        model: typeof parsed?.model === 'string' && parsed.model !== '' ? parsed.model : cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        // Qwen3's thinking switch. DashScope and recent vLLM builds read it; OpenRouter and
        // Ollama ignore an unknown field. UNVERIFIED against a live endpoint. The browser's
        // `stripThinking` is the defence that does not depend on it being honoured.
        enable_thinking: false,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.warn(`[guidance] upstream ${upstream.status}`, detail.slice(0, 500));
      // The upstream body is NOT forwarded. It can carry request echoes and account detail, and
      // the browser has no use for either -- it falls back to the local answer regardless.
      send(res, 502, { error: `upstream ${upstream.status}` });
      return;
    }

    const body = await upstream.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      send(res, 502, { error: 'upstream returned no content' });
      return;
    }
    send(res, 200, { content });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    if (!timedOut) console.warn('[guidance] relay failed', error);
    send(res, timedOut ? 504 : 502, { error: timedOut ? 'upstream timed out' : 'relay failed' });
  } finally {
    clearTimeout(timer);
  }
}
