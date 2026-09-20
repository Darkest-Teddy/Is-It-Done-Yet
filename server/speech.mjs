/**
 * The ElevenLabs relay: a voice for sentences nobody wrote in advance.
 *
 * `src/audio/chef.ts` generates a bank of barks straight from the browser at load, and that
 * stays exactly as it is -- it runs once, on a booth laptop we own, and it is what makes a
 * reaction to a cut arrive with the cut. This file is for the other half. The in-cooking chef
 * answers in text Qwen3 phrased a moment ago, which by definition is not in that bank, and
 * DECISIONS.md entry 19 measured `speechSynthesis` as absent from Quest Browser rather than
 * merely unreliable. So on the headset every model-written answer was silent, and the tier that
 * fixes it has to exist somewhere a key can live.
 *
 * It lives here for the same reason `guidance.mjs` does. `.env.example` has carried the warning
 * since the OpenAI work landed: anything prefixed `VITE_` is inlined into the client bundle and
 * readable by anyone who opens the page, and this repo publishes a built app. An ElevenLabs key
 * in the bundle is a metered account handed to the internet.
 *
 * Zero dependencies, matching `guidance.mjs` and `static.mjs`. It is one `fetch` and a byte
 * copy; a framework for that is a supply chain to audit for no benefit.
 *
 * MOUNTED IN BOTH SERVERS, like the guidance relay. `vite.config.ts` mounts it on the dev
 * server, `static.mjs` mounts it for the built app, so what is developed against is what runs.
 *
 * THE CLIENT MAY NOT CHOOSE THE VOICE. The guidance relay lets a caller name a model, because
 * switching between a local Ollama and a hosted endpoint mid-demo is a legitimate thing to
 * want. There is no equivalent here: the voice is one decision made once for the whole app, and
 * a relay that synthesises into whatever voice the caller names is a metered account anybody
 * can point at anything.
 */

/** Where the ElevenLabs v1 API lives. An env override exists so a test can point at a stub. */
const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

/**
 * The same model id `src/audio/chef.ts` already uses for the bank, and deliberately the same.
 *
 * Two ids would mean the pre-written barks and the on-demand answers are spoken by two slightly
 * different renderings of the same voice, which is audible in a way that reads as a glitch. If
 * this is ever changed, change both.
 */
const DEFAULT_MODEL = 'eleven_turbo_v2_5';

const DEFAULT_TIMEOUT_MS = 6000;

/** A spoken line is one sentence. See `SPEECH_MAX_SYNTH_CHARS` in `core/voice/speech.ts`. */
const MAX_TEXT_CHARS = 400;

/** A request is that sentence and nothing else. Anything larger is not read. */
const MAX_BODY_BYTES = 8 * 1024;

/** Refuses to hand the browser something a decoder will choke on, however large. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/**
 * Reads the upstream out of the environment, or null when nothing is configured.
 *
 * Null is not an error, exactly as in `guidance.mjs`. It is the state of a fresh checkout, and
 * the browser falls back to whatever voice it does have -- the browser synthesiser on a laptop,
 * subtitles on the headset. The handler says so in a 503, and the browser treats that status as
 * "this deployment has no voice" and stops asking, rather than spending a timeout per line.
 *
 * BOTH the key and the voice are required. A key with no voice id cannot name an endpoint to
 * call, and guessing a default voice would bill a real account for a voice nobody chose.
 */
export function speechConfig(env = process.env) {
  const apiKey = env['ELEVENLABS_API_KEY'];
  const voiceId = env['ELEVENLABS_VOICE_ID'];
  if (!apiKey || !voiceId) return null;

  const timeoutMs = Number(env['ELEVENLABS_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
  return {
    apiKey,
    voiceId,
    baseUrl: (env['ELEVENLABS_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env['ELEVENLABS_MODEL'] ?? DEFAULT_MODEL,
    /**
     * UNVERIFIED if you set it. Left unset the API picks its own default, which is what the
     * browser-side bank generation has always relied on and is therefore the format known to
     * decode here. The override exists because a 32kbps mono clip is a quarter of the bytes on
     * venue wifi, but the format ids are ElevenLabs' and have not been called from this repo.
     */
    outputFormat: env['ELEVENLABS_OUTPUT_FORMAT'] ?? '',
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
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

const sendJson = (res, status, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

/**
 * POST `{ text }` -> audio bytes.
 *
 * Audio, not JSON with base64 in it. The browser hands the response straight to
 * `decodeAudioData`, which is the path `chef.ts` already uses for the bank and the one that is
 * known to work on the headset; base64 would be a third more bytes and a decode step for it.
 *
 * Every failure is a JSON body with an `error` string and a non-200 status, and the upstream
 * body is never forwarded -- it can carry request echoes and account detail, and the browser
 * has no use for either. The status is the part the browser reads: 503 means this deployment
 * has no voice and it should stop asking, anything else means it should fall back for now.
 */
export async function handleSpeech(req, res) {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'POST only' });
    return;
  }

  const cfg = speechConfig();
  if (cfg === null) {
    sendJson(res, 503, { error: 'ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID are not set' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'body was not JSON, or was too large' });
    return;
  }

  const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
  if (text === '') {
    sendJson(res, 400, { error: 'no text' });
    return;
  }
  if (text.length > MAX_TEXT_CHARS) {
    // The browser applies the same ceiling before it asks. This is the copy that cannot be
    // edited out of the bundle by whoever opens the page.
    sendJson(res, 413, { error: `text over ${MAX_TEXT_CHARS} characters` });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const query = cfg.outputFormat === ''
      ? ''
      : `?output_format=${encodeURIComponent(cfg.outputFormat)}`;
    const upstream = await fetch(
      `${cfg.baseUrl}/text-to-speech/${encodeURIComponent(cfg.voiceId)}${query}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'xi-api-key': cfg.apiKey,
          'content-type': 'application/json',
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: cfg.model }),
      },
    );

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.warn(`[speech] upstream ${upstream.status}`, detail.slice(0, 500));
      // 401 and 429 are the two that will actually happen -- a wrong key and a spent quota --
      // and both are reported as a plain 502 with nothing of the account in the body.
      sendJson(res, 502, { error: `upstream ${upstream.status}` });
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    if (audio.byteLength === 0) {
      sendJson(res, 502, { error: 'upstream returned no audio' });
      return;
    }
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      sendJson(res, 502, { error: 'upstream audio was implausibly large' });
      return;
    }

    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg',
      'content-length': audio.byteLength,
      // The browser holds its own cache keyed by the text (`core/voice/speech.ts`). A second
      // copy in the HTTP cache would only matter across reloads, and a stale clip of a line
      // that has since been rephrased is a chef saying something it no longer means.
      'cache-control': 'no-store',
    });
    res.end(audio);
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    if (!timedOut) console.warn('[speech] relay failed', error);
    sendJson(res, timedOut ? 504 : 502, { error: timedOut ? 'upstream timed out' : 'relay failed' });
  } finally {
    clearTimeout(timer);
  }
}
