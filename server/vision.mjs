/**
 * `/api/vision` -- open-vocabulary ingredient identification.
 *
 * THE GAP THIS FILLS. Three pieces of this already existed and two of the three connections
 * did not. The deployed site answers `/api/vision` and has since before this branch, but that
 * function's source is in no commit on any ref -- it was deployed from a working tree, the same
 * way the cook-flow page was (entry 27). `server/vision-relay.mjs` arrived from main and is a
 * faithful transport, but it is only a transport: it forwards an OpenRouter-shaped body and has
 * no opinion about ingredients. And `src/home/scan.ts` has always called `api/vision` and
 * handled its absence gracefully. So the client spoke a contract, the transport spoke another,
 * and nothing in the repository translated between them.
 *
 * This is that translation: prompt in, `RawScanItem[]` out, matching byte-for-byte the shape the
 * live endpoint already returns, because `scan.ts` was written against it.
 *
 * WHY IT IS NOT IN THE RELAY. The relay deliberately knows nothing about cooking -- its own
 * header says the headset should not know or care which model is answering. Teaching it about
 * ingredients would make it a cooking component, and then pointing it at a local Ollama for a
 * different task would mean editing prompt text in a file about transport. Keeping the prompt
 * here means the relay stays swappable and this file stays the only thing that has to change
 * when the vision model's habits change.
 *
 * WHAT THIS DOES NOT DO. It does not decide the cook is wrong. A vision model naming an
 * ingredient is a proposal with a confidence, and it enters the pantry as one -- the counter
 * panel's "fix by hand" is what turns it into fact. Entry 26 explains why the unprompted path
 * never consults a model; this file is on the asked-for side of that line, and it stays there.
 */

const DEFAULT_MODEL = 'qwen/qwen3-vl-30b-a3b-instruct';
const DEFAULT_UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';

/** A frame is large. This ceiling is generous for one image and still refuses a hostile body. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Config, or null when no key is set.
 *
 * Null is a first-class answer, not an error: `scan.ts` asks `GET /api/vision` precisely so it
 * can disable the button with an honest label rather than offer a control that fails under
 * someone's finger.
 */
export function visionConfig(env = process.env) {
  const apiKey = env['OPENROUTER_API_KEY'];
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return null;
  // `VISION_UPSTREAM` is a NAME in main's relay convention ("openrouter", "ollama"), not a URL,
  // and this file read it as one -- which produced a 502 that blamed the model for a config
  // string. Only an explicit URL overrides the default; a bare name selects it.
  const upstreamRaw = env['VISION_UPSTREAM']?.trim() ?? '';
  const upstream = /^https?:\/\//i.test(upstreamRaw) ? upstreamRaw : DEFAULT_UPSTREAM;

  return {
    apiKey: apiKey.trim(),
    upstream,
    model: env['VISION_MODEL']?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(env['VISION_TIMEOUT_MS']) || DEFAULT_TIMEOUT_MS,
  };
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The prompt.
 *
 * Three things in it are load-bearing. It asks for JSON only, because a model that narrates
 * before answering makes the parse below fail on otherwise perfect output. It asks for a
 * confidence per item, because the pantry stores one and a fabricated 1.0 would present a guess
 * as a certainty. And it says explicitly not to invent: a vision model asked to list
 * ingredients will pad the list toward a plausible recipe, and a phantom ingredient is worse
 * than a missed one -- the cook is told they have something they do not.
 */
const PROMPT = [
  'You are looking at a photograph of a kitchen counter or chopping board.',
  'List ONLY the food ingredients you can actually see. Do not guess at ingredients that a',
  'recipe might need but which are not visible. Do not include utensils, containers, hands,',
  'boards or appliances.',
  '',
  'Reply with JSON only, no prose and no code fence, in exactly this shape:',
  '{"items":[{"ingredient":"tomato","count":3,"category":"vegetable","confidence":0.9}]}',
  '',
  'Rules:',
  '- ingredient: lower case, singular, the common name ("mozzarella", not "cheese ball")',
  '- count: how many distinct pieces you can see, as an integer, at least 1',
  '- category: one of vegetable, fruit, herb, protein, dairy, grain, pantry, unknown',
  '- confidence: 0 to 1, your honest certainty that this ingredient is present',
  '- if you can see no food at all, reply {"items":[]}',
].join('\n');

const CATEGORIES = new Set([
  'vegetable', 'fruit', 'herb', 'protein', 'dairy', 'grain', 'pantry', 'unknown',
]);

/**
 * Narrows whatever the model said into `RawScanItem[]`.
 *
 * Every field is clamped rather than trusted. A model that returns `count: 0`, a category it
 * invented, or a confidence of 3 is not an error worth failing the scan over -- it is a value
 * worth correcting, because the rest of the answer is usually fine. What IS rejected is an item
 * with no usable name, since that cannot be shown or matched against a recipe.
 */
export function parseItems(raw) {
  let text = String(raw ?? '').trim();

  // Models fence JSON even when told not to, and some emit a <think> block first. Both are
  // stripped rather than treated as a failure, because the JSON after them is usually correct.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();

  // Last resort: the first balanced-looking object in the string.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const stop = text.lastIndexOf('}');
    if (start === -1 || stop <= start) return null;
    text = text.slice(start, stop + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : null;
  if (items === null) return null;

  const out = [];
  for (const item of items) {
    const ingredient = String(item?.ingredient ?? '').trim().toLowerCase();
    if (ingredient === '') continue;

    const count = Number(item?.count);
    const confidence = Number(item?.confidence);
    const category = String(item?.category ?? '').trim().toLowerCase();

    out.push({
      ingredient,
      count: Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1,
      category: CATEGORIES.has(category) ? category : 'unknown',
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    });
  }
  return out;
}

/**
 * GET reports whether the endpoint can answer; POST takes `{imageDataUrl}` and returns
 * `{items, notes}`. Both shapes are the deployed endpoint's, because `scan.ts` speaks them.
 */
export async function handleVision(req, res, env = process.env) {
  const cfg = visionConfig(env);

  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      configured: cfg !== null,
      defaultModel: cfg?.model ?? DEFAULT_MODEL,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed');
    return;
  }

  if (cfg === null) {
    // 503 rather than 500: the endpoint is fine, it is unconfigured, and the client disables
    // the control on exactly this signal rather than showing the cook a failure.
    sendJson(res, 503, { error: 'OPENROUTER_API_KEY is not set' });
    return;
  }

  let imageDataUrl;
  try {
    const parsed = JSON.parse(await readBody(req));
    imageDataUrl = parsed?.imageDataUrl;
  } catch {
    sendJson(res, 400, { error: 'body was not JSON' });
    return;
  }

  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    sendJson(res, 400, { error: 'imageDataUrl must be a data:image/... URL' });
    return;
  }

  const timer = AbortSignal.timeout(cfg.timeoutMs);
  try {
    const upstream = await fetch(cfg.upstream, {
      method: 'POST',
      signal: timer,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
      }),
    });

    if (!upstream.ok) {
      // The upstream body is never forwarded -- it can carry account and key detail, and the
      // client has no use for it. The status is enough to tell rate-limit from refusal.
      sendJson(res, 502, { error: `vision upstream returned ${upstream.status}` });
      return;
    }

    const payload = await upstream.json();
    const items = parseItems(payload?.choices?.[0]?.message?.content);

    if (items === null) {
      sendJson(res, 502, { error: 'the vision model did not return usable JSON' });
      return;
    }

    sendJson(res, 200, {
      items,
      notes: items.length === 0 ? 'No food recognised in that frame.' : '',
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    sendJson(res, timedOut ? 504 : 502, {
      error: timedOut ? 'the vision model did not answer in time' : 'the vision model could not be reached',
    });
  }
}
