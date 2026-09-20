import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localGuidance, parseModelGuidance, EMPTY_CONTEXT } from '../core/voice/guidance.js';
import {
  askQwen,
  configFromEnv,
  DEFAULT_QWEN_MODEL,
  DEFAULT_QWEN_TIMEOUT_MS,
  type QwenConfig,
} from './qwen.js';

/**
 * A real HTTP server rather than a mocked `fetch`.
 *
 * Nothing in this repo has called a live Qwen3 endpoint (DECISIONS.md #26), so the transport is
 * the part that CAN be proven here and the part most likely to be quietly wrong: the request
 * shape, the two response envelopes, and every failure path having a fallback rather than an
 * exception. A stubbed `fetch` would prove none of that -- it would prove the stub.
 */
let server: Server;
let base = '';
/** What the stub does next. Set per test. */
let behaviour: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => undefined;
/** The last body the stub received, so the request shape can be asserted. */
let received: Record<string, unknown> = {};

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
};

/** An OpenAI-shaped chat completion, which is what all four Qwen3 hosts return. */
const completion = (content: string): unknown => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        received = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
      } catch {
        received = {};
      }
      behaviour(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const direct = (patch: Partial<QwenConfig> = {}): QwenConfig => ({
  mode: 'direct',
  url: `${base}/v1`,
  apiKey: 'test-key',
  model: 'qwen3-test',
  timeoutMs: 2000,
  ...patch,
});

const relay = (patch: Partial<QwenConfig> = {}): QwenConfig => ({
  mode: 'relay',
  url: `${base}/api/guidance`,
  apiKey: '',
  model: 'qwen3-test',
  timeoutMs: 2000,
  ...patch,
});

describe('configFromEnv', () => {
  it('returns null on a fresh checkout, which is not an error', () => {
    expect(configFromEnv({})).toBeNull();
    expect(configFromEnv({ VITE_QWEN_API_KEY: '', VITE_GUIDANCE_RELAY: '' })).toBeNull();
  });

  /** The relay is the safe door; a browser key must never quietly win over it. */
  it('prefers the relay when both are configured', () => {
    const cfg = configFromEnv({
      VITE_GUIDANCE_RELAY: '/api/guidance',
      VITE_QWEN_API_KEY: 'sk-live',
      VITE_QWEN_BASE_URL: 'https://example.invalid/v1',
    });
    expect(cfg?.mode).toBe('relay');
    expect(cfg?.apiKey).toBe('');
  });

  it('falls to the browser key only when both halves of it are present', () => {
    expect(configFromEnv({ VITE_QWEN_API_KEY: 'sk-live' })).toBeNull();
    expect(configFromEnv({ VITE_QWEN_BASE_URL: 'https://example.invalid/v1' })).toBeNull();
    expect(configFromEnv({
      VITE_QWEN_API_KEY: 'sk-live',
      VITE_QWEN_BASE_URL: 'https://example.invalid/v1/',
    })).toEqual({
      mode: 'direct',
      url: 'https://example.invalid/v1',
      apiKey: 'sk-live',
      model: DEFAULT_QWEN_MODEL,
      timeoutMs: DEFAULT_QWEN_TIMEOUT_MS,
    });
  });

  it('takes an overridden model and timeout, and ignores a nonsense timeout', () => {
    const env = { VITE_GUIDANCE_RELAY: '/r', VITE_QWEN_MODEL: 'qwen/qwen3-32b' };
    expect(configFromEnv({ ...env, VITE_QWEN_TIMEOUT_MS: '1500' })?.timeoutMs).toBe(1500);
    expect(configFromEnv({ ...env, VITE_QWEN_TIMEOUT_MS: 'soon' })?.timeoutMs)
      .toBe(DEFAULT_QWEN_TIMEOUT_MS);
    expect(configFromEnv(env)?.model).toBe('qwen/qwen3-32b');
  });
});

describe('askQwen against a live OpenAI-compatible stub', () => {
  it('sends a plain chat-completions body and reads the completion back', async () => {
    behaviour = (_req, res) => json(res, 200, completion('{"speech":"Add the tomato."}'));
    const raw = await askQwen(direct(), 'SYSTEM', 'USER');

    expect(raw).toBe('{"speech":"Add the tomato."}');
    expect(received['model']).toBe('qwen3-test');
    expect(received['messages']).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ]);
    expect(received['response_format']).toEqual({ type: 'json_object' });
    // UNVERIFIED against a live server, but it must at least be sent -- see DECISIONS.md #26.
    expect(received['enable_thinking']).toBe(false);
  });

  it('accepts the relay envelope, so the two modes are interchangeable to the caller', async () => {
    behaviour = (_req, res) => json(res, 200, { content: '{"speech":"Relayed."}' });
    expect(await askQwen(relay(), 'SYSTEM', 'USER')).toBe('{"speech":"Relayed."}');
  });

  it('returns null rather than throwing on an upstream error', async () => {
    behaviour = (_req, res) => json(res, 500, { error: 'boom' });
    expect(await askQwen(direct(), 's', 'u')).toBeNull();
  });

  it('returns null on a body that is not JSON', async () => {
    behaviour = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>a proxy login page</html>');
    };
    expect(await askQwen(direct(), 's', 'u')).toBeNull();
  });

  it('returns null on a completion with no content', async () => {
    behaviour = (_req, res) => json(res, 200, { choices: [] });
    expect(await askQwen(direct(), 's', 'u')).toBeNull();
  });

  /** Rule #9. A stalled endpoint on venue wifi must cost a timeout, never the answer. */
  it('gives up on a slow endpoint instead of hanging', async () => {
    behaviour = (_req, res) => {
      setTimeout(() => json(res, 200, completion('too late')), 3000).unref();
    };
    const started = Date.now();
    expect(await askQwen(direct({ timeoutMs: 250 }), 's', 'u')).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns null when nothing is listening at all', async () => {
    // Port 9 is the discard service and refuses immediately on every platform.
    expect(await askQwen(direct({ url: 'http://127.0.0.1:9/v1' }), 's', 'u')).toBeNull();
  });
});

describe('the whole asked path, end to end over HTTP', () => {
  const fallback = localGuidance({
    ...EMPTY_CONTEXT,
    cameraLive: true,
    recipeName: 'Tomato Mozzarella Salad',
    stepNumber: 1,
    stepCount: 9,
    stepInstruction: 'Rinse a tomato',
    stepVerifiable: 'vision',
  });

  /**
   * The realistic Qwen3 reply, not the tidy one. A hybrid-reasoning model served through vLLM
   * or Ollama commonly returns its reasoning inside the content as a `<think>` block and wraps
   * the answer in a fence, and a client that only handles the tidy case fails in production
   * while passing every test.
   */
  it('survives a thinking block and a markdown fence and fills all three channels', async () => {
    behaviour = (_req, res) => json(res, 200, completion(
      '<think>The tomato is missing so that is the priority.</think>\n'
      + '```json\n'
      + '{"speech":"Rinse a tomato and slice it.","overlay":"Rinse and slice tomato",'
      + '"text":"Grit on the skin ends up in every slice."}\n'
      + '```',
    ));

    const raw = await askQwen(direct(), 'SYSTEM', 'USER');
    expect(raw).not.toBeNull();

    const answer = parseModelGuidance(raw!, fallback);
    expect(answer.source).toBe('model');
    expect(answer.speech).toBe('Rinse a tomato and slice it.');
    expect(answer.overlay).toBe('Rinse and slice tomato');
    expect(answer.text).toBe('Grit on the skin ends up in every slice.');
  });

  /** The path a venue with bad wifi actually gets, and it must still be a complete answer. */
  it('falls back to a complete three-channel local answer when the endpoint is dead', async () => {
    const raw = await askQwen(direct({ url: 'http://127.0.0.1:9/v1' }), 's', 'u');
    const answer = raw === null ? fallback : parseModelGuidance(raw, fallback);

    expect(answer).toBe(fallback);
    expect(answer.source).toBe('local');
    expect(answer.speech.length).toBeGreaterThan(0);
    expect(answer.overlay.length).toBeGreaterThan(0);
    expect(answer.text.length).toBeGreaterThan(0);
  });

  it('falls back whole when the model answers with prose instead of JSON', async () => {
    behaviour = (_req, res) => json(res, 200, completion('Sure! You should rinse the tomato.'));
    const raw = await askQwen(direct(), 's', 'u');
    expect(parseModelGuidance(raw!, fallback)).toBe(fallback);
  });
});
