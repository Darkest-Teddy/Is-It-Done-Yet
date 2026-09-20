import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleSpeech, speechConfig } from './speech.mjs';

/**
 * The relay, against a stub standing in for ElevenLabs.
 *
 * NO LIVE ELEVENLABS CALL HAS BEEN MADE FROM THIS REPOSITORY. What is proven here is the half
 * that is ours: the key never reaches the client, the upstream's body never reaches the client,
 * every failure is a status the browser knows how to read, and a missing key is a 503 rather
 * than a crash. The request the stub receives is asserted field by field, so if the upstream
 * contract is wrong it is wrong in a place somebody can see. See DECISIONS.md entry 25.
 */

/** The stub upstream. */
let upstream;
let upstreamBase = '';
let upstreamBehaviour = (_req, res) => {
  res.writeHead(200, { 'content-type': 'audio/mpeg' });
  res.end(AUDIO);
};
let upstreamSaw = [];

/** The relay under test, mounted the way `static.mjs` mounts it. */
let relay;
let relayBase = '';

const AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamSaw.push({
        url: req.url,
        key: req.headers['xi-api-key'],
        body: body === '' ? {} : JSON.parse(body),
      });
      upstreamBehaviour(req, res);
    });
  });
  upstreamBase = await listen(upstream);

  relay = createServer((req, res) => { void handleSpeech(req, res); });
  relayBase = await listen(relay);
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => relay.close(resolve));
});

const KEYS = [
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_BASE_URL',
  'ELEVENLABS_MODEL',
  'ELEVENLABS_TIMEOUT_MS',
  'ELEVENLABS_OUTPUT_FORMAT',
];

const configure = (patch = {}) => {
  for (const key of KEYS) delete process.env[key];
  process.env['ELEVENLABS_API_KEY'] = 'secret-key';
  process.env['ELEVENLABS_VOICE_ID'] = 'voice-abc';
  process.env['ELEVENLABS_BASE_URL'] = `${upstreamBase}/v1`;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
};

beforeEach(() => {
  upstreamSaw = [];
  upstreamBehaviour = (_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(AUDIO);
  };
  configure();
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

const post = (body, init = {}) =>
  fetch(relayBase, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });

describe('speechConfig', () => {
  it('is null with nothing set, which is a fresh checkout and not an error', () => {
    expect(speechConfig({})).toBeNull();
  });

  it('needs both a key and a voice -- a key alone cannot name an endpoint', () => {
    expect(speechConfig({ ELEVENLABS_API_KEY: 'k' })).toBeNull();
    expect(speechConfig({ ELEVENLABS_VOICE_ID: 'v' })).toBeNull();
  });

  it('defaults to the same model id the pre-generated bank already uses', () => {
    const cfg = speechConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v' });
    expect(cfg.model).toBe('eleven_turbo_v2_5');
    expect(cfg.baseUrl).toBe('https://api.elevenlabs.io/v1');
  });

  it('trims a trailing slash off the base, so two config styles produce one URL', () => {
    const cfg = speechConfig({
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_VOICE_ID: 'v',
      ELEVENLABS_BASE_URL: 'http://example.test/v1///',
    });
    expect(cfg.baseUrl).toBe('http://example.test/v1');
  });
});

describe('the relay', () => {
  it('returns audio bytes, not JSON with base64 in them', async () => {
    const response = await post({ text: 'Add two more tomato.' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AUDIO);
  });

  it('sends the key upstream and the text in the body', async () => {
    await post({ text: 'Slice thinner.' });
    expect(upstreamSaw).toHaveLength(1);
    expect(upstreamSaw[0].key).toBe('secret-key');
    expect(upstreamSaw[0].url).toBe('/v1/text-to-speech/voice-abc');
    expect(upstreamSaw[0].body).toEqual({
      text: 'Slice thinner.',
      model_id: 'eleven_turbo_v2_5',
    });
  });

  it('never lets the key back out to the client', async () => {
    const response = await post({ text: 'Slice thinner.' });
    const headers = JSON.stringify([...response.headers]);
    expect(headers).not.toContain('secret-key');
  });

  it('will not let the caller choose the voice', async () => {
    await post({ text: 'Slice thinner.', voiceId: 'someone-elses-voice', voice_id: 'x' });
    expect(upstreamSaw[0].url).toBe('/v1/text-to-speech/voice-abc');
  });

  it('will not let the caller choose the model either', async () => {
    await post({ text: 'Slice thinner.', model: 'something-expensive' });
    expect(upstreamSaw[0].body.model_id).toBe('eleven_turbo_v2_5');
  });

  it('says 503 with no key, which is what retires the tier in the browser', async () => {
    configure({ ELEVENLABS_API_KEY: null });
    const response = await post({ text: 'Slice thinner.' });
    expect(response.status).toBe(503);
    expect(upstreamSaw).toHaveLength(0);
  });

  it('does not forward the upstream body, which can carry account detail', async () => {
    upstreamBehaviour = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'quota for account acct_12345 exhausted' }));
    };
    const response = await post({ text: 'Slice thinner.' });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('acct_12345');
  });

  it('reports a spent quota as a plain 502, which the browser retries once', async () => {
    upstreamBehaviour = (_req, res) => { res.writeHead(429).end('slow down'); };
    expect((await post({ text: 'Slice thinner.' })).status).toBe(502);
  });

  it('refuses an empty request', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    expect((await post('not json at all')).status).toBe(400);
  });

  it('refuses a paragraph, so the ceiling cannot be edited out of the bundle', async () => {
    const response = await post({ text: 'a'.repeat(401) });
    expect(response.status).toBe(413);
    expect(upstreamSaw).toHaveLength(0);
  });

  it('refuses anything but a POST', async () => {
    expect((await fetch(relayBase)).status).toBe(405);
  });

  it('gives up on a slow upstream rather than holding the socket open', async () => {
    configure({ ELEVENLABS_TIMEOUT_MS: '80' });
    upstreamBehaviour = () => { /* never answers */ };
    const response = await post({ text: 'Slice thinner.' });
    expect(response.status).toBe(504);
  });

  it('treats an empty upstream body as a failure rather than as silence', async () => {
    upstreamBehaviour = (_req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(); };
    expect((await post({ text: 'Slice thinner.' })).status).toBe(502);
  });

  it('passes an output format through only when one is configured', async () => {
    await post({ text: 'Slice thinner.' });
    expect(upstreamSaw[0].url).not.toContain('output_format');

    configure({ ELEVENLABS_OUTPUT_FORMAT: 'mp3_22050_32' });
    await post({ text: 'Slice thinner.' });
    expect(upstreamSaw[1].url).toContain('output_format=mp3_22050_32');
  });
});
