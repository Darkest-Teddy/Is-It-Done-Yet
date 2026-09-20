#!/usr/bin/env node
/**
 * A thin relay between the headset and whichever vision model is answering today.
 *
 * WHY THIS EXISTS. Two reasons, and the second one outlived the first.
 *
 * The original reason was keys. An APK is a zip file. A key compiled into one is extracted in
 * minutes, and it is your key with your billing and your rate limit attached. There is no
 * obfuscation that changes this -- the request has to carry the key in plaintext eventually, so
 * anyone with the build and a proxy has it. The only real fix is that the device never holds the
 * key at all.
 *
 * The second reason is that the headset should not know or care WHICH model is answering.
 * Swapping a cloud model for one running on this laptop is an env var here and a rebuild of
 * nothing. The Unity side posts a chat-completions body to one URL forever.
 *
 * Both upstreams below speak the OpenAI chat-completions dialect, which is the only reason one
 * relay can serve both. That is a property of the wire format, not a coincidence.
 *
 *   # hosted Qwen, needs a free OpenRouter key and working wifi
 *   OPENROUTER_API_KEY=sk-or-... node server/vision-relay.mjs
 *
 *   # local Qwen, needs no key and no internet at all
 *   VISION_UPSTREAM=ollama node server/vision-relay.mjs
 *
 *   # then point VlmVisionProvider.relayUrl at http://<your-lan-ip>:8787/vision
 *
 * Deliberately dependency-free and deliberately one file. Node 18+ has fetch and http built in,
 * so this runs with `node server/vision-relay.mjs` and nothing else -- no install step to fail
 * on venue wifi at 3am, and nothing to go wrong between deciding you need it and having it.
 *
 * For anything public, put this behind Vercel or a tunnel and add real auth. On a hackathon LAN
 * the exposure is the room you are standing in, which is a different risk than the internet.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

/**
 * The upstreams this relay knows how to reach.
 *
 * `ollama` is the one that survives the demo. Master spec rule 12 says to pick what works on bad
 * wifi, and a model running on this laptop has no wifi to be bad -- the headset reaches the relay
 * over the LAN and the relay reaches the model over loopback. Nothing leaves the table.
 *
 * `openrouter` is the default anyway, because on the hardware in this bag Qwen-VL runs on an
 * Intel iGPU at somewhere between five and fifteen seconds an identification. That is usable but
 * not comfortable, and the hosted 72B is both faster and much better at naming a vegetable. Keep
 * the local path rehearsed and switch to it the moment the venue network starts lying to you.
 */
const UPSTREAMS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    // VERIFIED AGAINST THE LIVE CATALOGUE, and the first draft of this list was wrong -- it
    // named `qwen/qwen2.5-vl-72b-instruct:free` and `...-32b-instruct:free`, neither of which
    // exists. Both were written from memory. Check before trusting a model ID here:
    //
    //   curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"qwen/[^"]*"'
    //
    // Order is deliberate: the default first, the zero-cost option second.
    models: [
      // Modern Qwen3-VL, a fraction of a cent per call, ~1-2s. The tested default.
      'qwen/qwen3-vl-30b-a3b-instruct',
      // The only genuinely free Qwen that accepts images. Rate-limited upstream often enough
      // that it is a bonus, not a plan -- it 429'd on every attempt the day this was written.
      'qwen/qwen3.8-27b:free',
      // Larger, still cheap. Reach for it if the 30B starts guessing on hard ingredients.
      'qwen/qwen3-vl-235b-a22b-instruct',
    ],
    timeoutMs: 20_000,
    // Optional and free: OpenRouter attributes traffic to a named app rather than to an
    // anonymous key. Costs nothing and makes the dashboard legible.
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/Darkest-Teddy/Is-It-Done-Yet',
      'X-Title': 'Is It Done Yet',
    },
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1/chat/completions',
    keyEnv: null, // Loopback to a process you started. There is no key and nothing to protect.
    models: ['qwen2.5vl:3b', 'qwen2.5vl:7b'],
    // Three times the hosted budget, and measured rather than guessed: qwen2.5vl:3b on an
    // Intel iGPU answered in 20-26s warm, at 512px. A 20s timeout would have discarded two
    // answers out of three that were already on their way. 60s sits above the client's 45s so
    // the headset is always the one that gives up first.
    timeoutMs: 60_000,
  },
};

/**
 * Upstream selection, in precedence order: `--upstream=x`, then VISION_UPSTREAM, then hosted.
 *
 * The CLI flag exists because npm scripts have to work on Windows, where `VAR=val node ...` is
 * not a thing -- cmd.exe parses it as a command name and fails. The alternative was a
 * cross-env dependency, which this file is specifically built to avoid.
 */
const flag = process.argv.find((a) => a.startsWith('--upstream='));
const UPSTREAM_NAME = flag ? flag.slice('--upstream='.length) : (process.env.VISION_UPSTREAM ?? 'openrouter');
const UPSTREAM = UPSTREAMS[UPSTREAM_NAME];

if (!UPSTREAM) {
  console.error(`VISION_UPSTREAM='${UPSTREAM_NAME}' is not one of: ${Object.keys(UPSTREAMS).join(', ')}`);
  process.exit(1);
}

const KEY = UPSTREAM.keyEnv ? (process.env[UPSTREAM.keyEnv] ?? '') : '';

if (UPSTREAM.keyEnv && KEY === '') {
  console.error(`${UPSTREAM.keyEnv} is not set, and upstream '${UPSTREAM_NAME}' needs it.`);
  console.error('A relay with no key is just an open proxy that returns 401s.');
  console.error('');
  console.error('Either set it, or run the local model instead, which needs no key:');
  console.error('  VISION_UPSTREAM=ollama node server/vision-relay.mjs');
  process.exit(1);
}

/**
 * Models this relay will forward. An open relay is a bill waiting to happen.
 *
 * VISION_MODELS (comma-separated) adds to the list rather than replacing it, because the failure
 * this guards against is a runaway client, not a typo by the person starting the process. When a
 * free-tier model ID changes upstream you want to be one env var from working, not one commit.
 */
const ALLOWED_MODELS = new Set([
  ...UPSTREAM.models,
  ...(process.env.VISION_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean),
]);

// Images are a few hundred kilobytes of base64. The cap stops a malformed or hostile client
// from holding the process open forever feeding it bytes.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

let requests = 0;
let failures = 0;

const server = createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // A health endpoint earns its three lines: it answers "is the relay up, or is the headset
  // failing for some other reason" without unplugging anything. It also reports which upstream
  // is live, which is the question you actually have at 3am after flipping the env var.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstream: UPSTREAM_NAME,
      models: [...ALLOWED_MODELS],
      requests,
      failures,
    }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/vision')) {
    res.writeHead(404, cors);
    res.end('not found');
    return;
  }

  let body = '';
  let size = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, cors);
      res.end('payload too large');
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    if (aborted) return;
    requests++;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      failures++;
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body was not JSON' }));
      return;
    }

    if (!ALLOWED_MODELS.has(parsed.model)) {
      failures++;
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      // Naming the upstream matters here: "model not allowed: gpt-4o-mini" is baffling until you
      // realise the relay is pointed at Ollama and the headset was never rebuilt.
      res.end(JSON.stringify({
        error: `model not allowed on upstream '${UPSTREAM_NAME}': ${parsed.model}`,
        allowed: [...ALLOWED_MODELS],
      }));
      return;
    }

    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
          ...(UPSTREAM.extraHeaders ?? {}),
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM.timeoutMs),
      });

      const text = await upstream.text();
      const ms = Date.now() - started;
      if (!upstream.ok) failures++;
      console.log(`${upstream.status} ${ms}ms  ${(size / 1024).toFixed(0)}kb  ${parsed.model}`);

      res.writeHead(upstream.status, { ...cors, 'Content-Type': 'application/json' });
      res.end(text);
    } catch (error) {
      failures++;
      console.error('upstream failed:', error.message);
      // 502 rather than 500: this relay is fine, the thing behind it is not, and the client
      // should fall back rather than retry into a wall.
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream failed', detail: error.message }));
    }
  });
});

// 0.0.0.0 so the headset can reach it over the LAN. localhost would bind only this machine,
// which is the one device that does not need it.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`vision relay on http://0.0.0.0:${PORT}/vision`);
  console.log(`upstream: ${UPSTREAM_NAME} -> ${UPSTREAM.url}`);
  console.log(`models:   ${[...ALLOWED_MODELS].join(', ')}`);
  if (!UPSTREAM.keyEnv) console.log('no key needed; this upstream is local');
  console.log(`point VlmVisionProvider.relayUrl at http://<this-machine-lan-ip>:${PORT}/vision`);
});
