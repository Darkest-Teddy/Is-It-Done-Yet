/**
 * The OpenAI-compatible client, against a fetch double.
 *
 * Never a real upstream. Everything worth testing here is behaviour under failure -- what gets
 * retried, what does not, what the timeout does, whether the key can leak -- and none of that
 * is observable by calling a healthy API.
 */

import { describe, expect, it, vi } from 'vitest';

import { createLlm, createProvider, LlmError } from '../src/llm.js';
import { loadConfig } from '../src/config.js';

const ok = (content) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ choices: [{ message: { content } }] }),
  text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
});

const err = (status, headers = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
  text: async () => 'upstream said no',
});

const spec = {
  name: 'test',
  baseUrl: 'https://example.test/v1/',
  model: 'test-model',
  apiKeyEnvName: 'TEST_KEY',
  reasoningEffort: 'none',
};

// No jitter in tests: a random backoff would make the suite's duration random too.
const deps = (fetchImpl, env = { TEST_KEY: 'secret-value' }) => ({ fetchImpl, env, random: () => 0 });

describe('request shape', () => {
  it('posts to <baseUrl>/chat/completions with exactly one slash', async () => {
    const fetchImpl = vi.fn(async () => ok('{}'));
    await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 100, maxRetries: 0 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/v1/chat/completions');
  });

  it('asks for JSON mode and instruct mode', async () => {
    const fetchImpl = vi.fn(async () => ok('{}'));
    await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 100, maxRetries: 0 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBe('none');
    expect(body.model).toBe('test-model');
  });

  it('omits reasoning_effort entirely when it is null', async () => {
    const fetchImpl = vi.fn(async () => ok('{}'));
    await createProvider({ ...spec, reasoningEffort: null }, deps(fetchImpl))
      .chat({ messages: [], timeoutMs: 100, maxRetries: 0 });
    expect('reasoning_effort' in JSON.parse(fetchImpl.mock.calls[0][1].body)).toBe(false);
  });

  it('sends the key as a bearer token and nowhere else', async () => {
    const fetchImpl = vi.fn(async () => ok('{}'));
    await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 100, maxRetries: 0 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer secret-value');
    expect(url).not.toMatch(/secret-value/);
    expect(init.body).not.toMatch(/secret-value/);
  });
});

describe('configuration', () => {
  it('reports unconfigured when the named variable is missing', () => {
    expect(createProvider(spec, deps(vi.fn(), {})).configured).toBe(false);
  });

  it('treats a whitespace-only key as unset', () => {
    expect(createProvider(spec, deps(vi.fn(), { TEST_KEY: '   ' })).configured).toBe(false);
  });

  it('refuses to call without a key, and names the variable rather than the value', async () => {
    const fetchImpl = vi.fn();
    await expect(createProvider(spec, deps(fetchImpl, {})).chat({ messages: [], timeoutMs: 10, maxRetries: 0 }))
      .rejects.toThrow('TEST_KEY is not set');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('retries', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(err(429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(ok('{"ok":true}'));
    const text = await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 2 });
    expect(text).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(err(503)).mockResolvedValueOnce(ok('{}'));
    await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 -- the image is wrong and will be wrong again', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(400));
    await expect(createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 3 }))
      .rejects.toBeInstanceOf(LlmError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(401));
    await expect(createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 3 }))
      .rejects.toThrow('upstream 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(err(500));
    await expect(createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 2 }))
      .rejects.toThrow('upstream 500');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries an empty completion rather than returning one', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ...ok(''), json: async () => ({ choices: [{ message: { content: '' } }] }) })
      .mockResolvedValueOnce(ok('{"second":true}'));
    const text = await createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 200, maxRetries: 1 });
    expect(text).toBe('{"second":true}');
  });
});

describe('timeout', () => {
  it('aborts a hanging request and says so', async () => {
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));
    await expect(createProvider(spec, deps(fetchImpl)).chat({ messages: [], timeoutMs: 20, maxRetries: 0 }))
      .rejects.toThrow('timed out after 20ms');
  });
});

describe('fallback provider', () => {
  const config = () => ({
    ...loadConfig({}),
    llm: {
      primary: { baseUrl: 'https://primary.test/v1', model: 'p', apiKeyEnvName: 'P_KEY', reasoningEffort: 'none' },
      fallback: { baseUrl: 'https://fallback.test/v1', model: 'f', apiKeyEnvName: 'F_KEY', reasoningEffort: null },
      timeoutMs: 200,
      maxRetries: 0,
      maxImageBytes: 400_000,
    },
  });

  it('falls through to the second provider when the first fails', async () => {
    const fetchImpl = vi.fn(async (url) => (url.startsWith('https://primary') ? err(500) : ok('{"from":"fallback"}')));
    const llm = createLlm(config(), { fetchImpl, env: { P_KEY: 'a', F_KEY: 'b' }, random: () => 0 });
    const result = await llm.chat({ messages: [] });
    expect(result.text).toBe('{"from":"fallback"}');
    expect(result.model).toBe('f');
  });

  it('skips an unconfigured primary instead of failing on it', async () => {
    const fetchImpl = vi.fn(async () => ok('{"from":"fallback"}'));
    const llm = createLlm(config(), { fetchImpl, env: { F_KEY: 'b' }, random: () => 0 });
    await llm.chat({ messages: [] });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/fallback\.test/);
  });

  it('throws the primary error when there is no usable fallback', async () => {
    const fetchImpl = vi.fn(async () => err(500));
    const llm = createLlm(config(), { fetchImpl, env: { P_KEY: 'a' }, random: () => 0 });
    await expect(llm.chat({ messages: [] })).rejects.toThrow('upstream 500');
  });

  it('describes its providers without exposing a key or a base URL', () => {
    const llm = createLlm(config(), { fetchImpl: vi.fn(), env: { P_KEY: 'a' }, random: () => 0 });
    const described = JSON.stringify(llm.describe());
    expect(described).not.toMatch(/P_KEY|"a"|primary\.test/);
    expect(JSON.parse(described)).toEqual({
      primary: { model: 'p', configured: true },
      fallback: { model: 'f', configured: false },
    });
  });
});
