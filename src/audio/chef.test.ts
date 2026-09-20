import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createChef, speechRelayFromEnv } from './chef.js';
import { MAX_RELAY_STRIKES } from '../core/voice/speech.js';

/**
 * A real HTTP server for the relay, and a fake AudioContext for the speaker.
 *
 * The transport is the part that CAN be proven from a terminal and the part most likely to be
 * quietly wrong: the request shape, the tier order, the cache, and every failure path ending in
 * a fallback rather than in silence. A stubbed `fetch` would prove the stub. What cannot be
 * proven here is the decode -- `decodeAudioData` needs a real audio device -- so the context
 * below is a fake that records what it was asked to play, and the live ElevenLabs call is
 * UNVERIFIED from this repository. See DECISIONS.md entry 28.
 */
let server: Server;
let relayUrl = '';
/** What the stub relay does next. Set per test. */
let behaviour: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => undefined;
/** Every body the stub relay received, so the request shape and the call count can be asserted. */
let received: Record<string, unknown>[] = [];
/** Responses deliberately left hanging, ended in `afterEach` so teardown cannot block. */
let hanging: ServerResponse[] = [];

/** Stands in for an mp3 body. The fake context never looks inside it. */
const AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03, 0x04]);

const sendAudio = (res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': AUDIO.byteLength });
  res.end(AUDIO);
};

const sendError = (res: ServerResponse, status: number): void => {
  const text = JSON.stringify({ error: 'nope' });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
};

// ------------------------------------------------------------------------------ fake speaker

interface Played {
  readonly byteLength: number;
}

let played: Played[] = [];
let stopped = 0;

class FakeSource {
  public buffer: Played | null = null;
  public onended: (() => void) | null = null;
  connect(): void { /* nothing to connect to */ }
  start(): void {
    if (this.buffer !== null) played.push(this.buffer);
  }
  stop(): void { stopped++; }
}

const fakeContext = (): AudioContext => ({
  state: 'running',
  destination: {},
  createBufferSource: () => new FakeSource(),
  decodeAudioData: async (bytes: ArrayBuffer) => ({ byteLength: bytes.byteLength }),
  resume: async () => undefined,
}) as unknown as AudioContext;

// ------------------------------------------------------------------------------ fake tier 3

let spokenInBrowser: string[] = [];

function installBrowserVoice(): void {
  (globalThis as Record<string, unknown>)['speechSynthesis'] = {
    cancel: () => undefined,
    speak: (u: { text: string }) => spokenInBrowser.push(u.text),
  };
  (globalThis as Record<string, unknown>)['SpeechSynthesisUtterance'] =
    class { constructor(public text: string) {} };
}

function removeBrowserVoice(): void {
  // What Quest Browser looks like. DECISIONS.md entry 19.
  delete (globalThis as Record<string, unknown>)['speechSynthesis'];
  delete (globalThis as Record<string, unknown>)['SpeechSynthesisUtterance'];
}

// ------------------------------------------------------------------------------ fake tier 1

/** ElevenLabs calls the bank makes direct, intercepted so a test never reaches the internet. */
let bankCalls: string[] = [];
let bankResponds: () => Response = () => new Response(AUDIO, { status: 200 });
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk as string; });
    req.on('end', () => {
      try {
        received.push(body === '' ? {} : (JSON.parse(body) as Record<string, unknown>));
      } catch {
        received.push({});
      }
      behaviour(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  relayUrl = `http://127.0.0.1:${address.port}/api/speech`;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.elevenlabs.io')) {
      bankCalls.push(url);
      return bankResponds();
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  behaviour = (_req, res) => sendAudio(res);
  received = [];
  played = [];
  stopped = 0;
  spokenInBrowser = [];
  bankCalls = [];
  bankResponds = () => new Response(AUDIO, { status: 200 });
  hanging = [];
  installBrowserVoice();
});

afterEach(() => {
  for (const res of hanging) res.end();
  hanging = [];
  removeBrowserVoice();
});

const tick = (ms = 5): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Waits until the fire-and-forget synthesis has actually done the thing.
 *
 * Polled rather than slept, because the whole tier is deliberately not awaitable by its caller
 * -- rule #10 -- and a fixed sleep tuned on one machine is a test that fails on a slower one at
 * 4am for reasons that have nothing to do with the code.
 */
const waitFor = async (done: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await tick();
};

/** Waits long enough that anything that was going to happen has. For negative assertions. */
const settle = (ms = 250): Promise<void> => tick(ms);

const bark = (line: string) => ({ kind: 'improving' as const, line });

describe('speechRelayFromEnv', () => {
  it('is opt-in, so a checkout with nothing configured asks for nothing', () => {
    expect(speechRelayFromEnv({})).toBeNull();
    expect(speechRelayFromEnv({ VITE_SPEECH_RELAY: '' })).toBeNull();
  });

  it('reads the path when it is set', () => {
    expect(speechRelayFromEnv({ VITE_SPEECH_RELAY: '/api/speech' })).toBe('/api/speech');
  });
});

describe('with no relay configured -- the behaviour that must not change', () => {
  it('speaks novel text through the browser voice and asks the network for nothing', async () => {
    const chef = createChef(fakeContext(), {});
    chef.say(bark('Add two more tomato.'));
    await settle();

    expect(received).toHaveLength(0);
    expect(spokenInBrowser).toEqual(['Add two more tomato.']);
    expect(chef.lastTier()).toBe('browser');
  });

  it('is silent on a headset, exactly as it was before this tier existed', async () => {
    removeBrowserVoice();
    const chef = createChef(fakeContext(), {});
    chef.say(bark('Add two more tomato.'));
    await settle();

    expect(received).toHaveLength(0);
    expect(played).toHaveLength(0);
    expect(chef.lastTier()).toBe('silent');
  });

  it('primes nothing, so no credit is spent by a panel that cannot use it', async () => {
    const chef = createChef(fakeContext(), {});
    chef.prime('Let me look.');
    await settle();
    expect(received).toHaveLength(0);
  });
});

describe('the on-demand tier', () => {
  it('synthesises a line nobody wrote in advance and plays it', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Add two more tomato before you move on.'));
    await waitFor(() => played.length >= 1);

    expect(received).toEqual([{ text: 'Add two more tomato before you move on.' }]);
    expect(played).toHaveLength(1);
    expect(played[0]?.byteLength).toBe(AUDIO.byteLength);
    expect(spokenInBrowser).toHaveLength(0);
    expect(chef.lastTier()).toBe('relay');
    expect(chef.tier()).toBe('elevenlabs');
  });

  it('is preferred over the browser voice even though the browser voice is instant', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Slice thinner, same angle.'));
    await waitFor(() => played.length >= 1);
    expect(spokenInBrowser).toHaveLength(0);
    expect(played).toHaveLength(1);
  });

  it('pays for a line once and plays it from the cache afterwards', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => played.length >= 1);
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => played.length >= 2);

    expect(received).toHaveLength(1);
    expect(played).toHaveLength(2);
  });

  it('treats the same sentence assembled two ways as one clip', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Add two  more tomato.'));
    await waitFor(() => played.length >= 1);
    chef.say(bark('  Add two more tomato.  '));
    await waitFor(() => played.length >= 2);

    expect(received).toHaveLength(1);
    // Normalised before it is sent, so the relay never bills for the padding either.
    expect(received[0]).toEqual({ text: 'Add two more tomato.' });
    expect(played).toHaveLength(2);
  });

  it('makes one request when two callers want the same line at once', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.prime('Let me look.');
    chef.say(bark('Let me look.'));
    await waitFor(() => played.length >= 1);
    await settle();

    expect(received).toHaveLength(1);
    expect(played).toHaveLength(1);
  });

  it('primes a clip without speaking it, so the next ask is instant', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.prime('Let me look.');
    await waitFor(() => received.length >= 1);
    await settle();
    expect(received).toHaveLength(1);
    expect(played).toHaveLength(0);

    chef.say(bark('Let me look.'));
    await waitFor(() => played.length >= 1);
    expect(received).toHaveLength(1);
    expect(played).toHaveLength(1);
    expect(chef.lastTier()).toBe('cache');
  });

  it('cuts off the previous clip rather than talking over itself', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Let me look.'));
    await waitFor(() => played.length >= 1);
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => played.length >= 2);
    expect(stopped).toBeGreaterThan(0);
  });

  it('refuses to spend a call on a paragraph that reached the speaker by mistake', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('a'.repeat(500)));
    await settle();

    expect(received).toHaveLength(0);
    expect(spokenInBrowser).toHaveLength(1);
  });

  it('does nothing at all with an empty line', async () => {
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('   '));
    await settle();
    expect(received).toHaveLength(0);
    expect(spokenInBrowser).toHaveLength(0);
    expect(played).toHaveLength(0);
  });
});

describe('when the relay does not deliver', () => {
  it('falls to the browser voice rather than going quiet', async () => {
    behaviour = (_req, res) => sendError(res, 502);
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => spokenInBrowser.length >= 1);

    expect(spokenInBrowser).toEqual(['Add two more tomato.']);
    expect(chef.lastTier()).toBe('browser');
  });

  it('falls to silence on a headset, where the subtitle is the whole answer', async () => {
    removeBrowserVoice();
    behaviour = (_req, res) => sendError(res, 502);
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => received.length >= 1);
    await settle();

    expect(played).toHaveLength(0);
    // It tried, which is the difference between this and having no relay at all.
    expect(received).toHaveLength(1);
  });

  it('stops asking immediately when the server says it has no voice configured', async () => {
    behaviour = (_req, res) => sendError(res, 503);
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    chef.say(bark('First line.'));
    await waitFor(() => spokenInBrowser.length >= 1);
    chef.say(bark('Second line.'));
    await waitFor(() => spokenInBrowser.length >= 2);
    await settle();

    expect(received).toHaveLength(1);
    expect(spokenInBrowser).toEqual(['First line.', 'Second line.']);
  });

  it('tolerates one bad request, then gives up', async () => {
    behaviour = (_req, res) => sendError(res, 502);
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    for (let i = 0; i < MAX_RELAY_STRIKES + 2; i++) {
      chef.say(bark(`Line ${i}.`));
      await waitFor(() => spokenInBrowser.length >= i + 1);
    }
    await settle();
    expect(received).toHaveLength(MAX_RELAY_STRIKES);
  });

  it('forgets the strike after a success, so two failures an hour apart are not fatal', async () => {
    let calls = 0;
    behaviour = (_req, res) => {
      calls++;
      if (calls === 1 || calls === 3) sendError(res, 502);
      else sendAudio(res);
    };
    const chef = createChef(fakeContext(), { speechRelay: relayUrl });
    for (let i = 0; i < 4; i++) {
      chef.say(bark(`Line ${i}.`));
      await waitFor(() => received.length >= i + 1);
      await tick(40);
    }
    // Fail, succeed, fail, succeed -- four attempts, never two in a row, never retired.
    expect(received).toHaveLength(4);
  });

  it('abandons a slow relay instead of hanging, and speaks anyway', async () => {
    behaviour = (_req, res) => { hanging.push(res); };
    const chef = createChef(fakeContext(), { speechRelay: relayUrl, speechTimeoutMs: 60 });
    chef.say(bark('Add two more tomato.'));
    await waitFor(() => spokenInBrowser.length >= 1);

    expect(spokenInBrowser).toEqual(['Add two more tomato.']);
  });

  it('has nowhere to play a clip with no AudioContext, so it never asks for one', async () => {
    const chef = createChef(null, { speechRelay: relayUrl });
    chef.say(bark('Add two more tomato.'));
    await settle();

    expect(received).toHaveLength(0);
    expect(spokenInBrowser).toEqual(['Add two more tomato.']);
  });
});

describe('the pre-generated bank still comes first', () => {
  it('plays a pre-written bark without touching the relay', async () => {
    const chef = createChef(fakeContext(), {
      apiKey: 'test-key',
      voiceId: 'test-voice',
      speechRelay: relayUrl,
    });
    await chef.ready;
    expect(bankCalls.length).toBeGreaterThan(0);

    played = [];
    // `allLines()` is what the bank is built from; this is the first of them.
    const { allLines } = await import('../core/barks.js');
    const line = allLines()[0] ?? '';
    chef.say(bark(line));
    await waitFor(() => played.length >= 1);
    await settle();

    expect(received).toHaveLength(0);
    expect(played).toHaveLength(1);
    expect(chef.lastTier()).toBe('bank');
  });

  it('leaves the bank to its own key and does not route it through the relay', async () => {
    const chef = createChef(fakeContext(), { apiKey: 'test-key', voiceId: 'test-voice' });
    await chef.ready;
    expect(bankCalls.every((url) => url.startsWith('https://api.elevenlabs.io'))).toBe(true);
    expect(received).toHaveLength(0);
  });

  it('still answers novel text through the relay while the bank is loaded', async () => {
    const chef = createChef(fakeContext(), {
      apiKey: 'test-key',
      voiceId: 'test-voice',
      speechRelay: relayUrl,
    });
    await chef.ready;
    chef.say(bark('A sentence Qwen3 wrote just now.'));
    await waitFor(() => played.length >= 1);

    expect(received).toEqual([{ text: 'A sentence Qwen3 wrote just now.' }]);
  });

  it('is unaffected by a dead bank -- the on-demand tier is a separate key', async () => {
    bankResponds = () => new Response('nope', { status: 401 });
    const chef = createChef(fakeContext(), {
      apiKey: 'bad-key',
      voiceId: 'test-voice',
      speechRelay: relayUrl,
    });
    await chef.ready;
    chef.say(bark('A sentence Qwen3 wrote just now.'));
    await waitFor(() => played.length >= 1);

    expect(played).toHaveLength(1);
  });
});
