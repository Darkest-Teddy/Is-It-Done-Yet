import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bark } from '../core/barks.js';
import { recipeById } from '../core/recipes.js';
import type { Score } from '../core/scoring.js';
import type { Effect, GameState } from '../core/voice/tools.js';
import { createAssistant, heardHandler, type Oracle } from './assistant.js';
import { createTyped, type SpeechProvider } from './stt.js';

const SANDWICH = recipeById('sandwich')!;

const score = (count: number): Score => ({
  meanMm: 6, sigmaMm: 1, meanAngleDeg: null,
  accuracy: 0.8, uniformity: 0.7, angleScore: null, total: 0.75, count,
});

const state = (): GameState => ({
  score: score(2), recipe: SANDWICH, intensity: 0.5, lastLine: null,
});

function harness(over: { oracle?: Oracle; provider?: SpeechProvider } = {}) {
  const spoken: string[] = [];
  const applied: Effect[] = [];
  const errors: string[] = [];
  const provider = over.provider ?? createTyped({ onHeard: () => {} });

  const assistant = createAssistant({
    provider,
    state,
    apply: (effect) => applied.push(effect),
    speak: (bark: Bark) => spoken.push(bark.line),
    onError: (message) => errors.push(message),
    oracle: over.oracle,
    oracleTimeoutMs: 100,
  });

  return { assistant, spoken, applied, errors, provider };
}

afterEach(() => { vi.useRealTimers(); });

describe('createAssistant: the local path', () => {
  it('answers a known question with no oracle present at all', () => {
    const { assistant, spoken, applied } = harness();
    assistant.hear('hey chef is it done yet');

    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('4 more slices');
    expect(applied).toEqual([]);
  });

  it('applies the effect the tools asked for, and speaks', () => {
    const { assistant, spoken, applied } = harness();
    assistant.hear('hey chef make it four millimetres');

    expect(applied).toEqual([{ kind: 'setTarget', mm: 4 }]);
    expect(spoken[0]).toContain('4 millimetres it is');
  });

  /** A room with 1500 people in it is full of sentences that are not for us. */
  it('stays silent for an utterance that was not addressed to the chef', () => {
    const { assistant, spoken, applied } = harness();
    assistant.hear('so then I told him make it four millimetres');

    expect(spoken).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('stops listening when asked for quiet, as well as reporting the effect', () => {
    const { assistant, applied, provider } = harness();
    provider.start();
    expect(provider.listening()).toBe(true);

    assistant.hear('hey chef quiet');

    expect(provider.listening()).toBe(false);
    expect(applied).toEqual([{ kind: 'stop' }]);
  });

  it('remembers its last line so "say that again" works', () => {
    const { assistant, spoken } = harness();
    assistant.hear('hey chef whats the target');
    const first = assistant.lastLine();
    assistant.hear('hey chef say that again');

    expect(first).not.toBeNull();
    expect(spoken[1]).toBe(first);
  });
});

describe('createAssistant: escalation', () => {
  it('admits the limit when there is no oracle', () => {
    const { assistant, spoken } = harness();
    assistant.hear('hey chef why is the sky blue');

    expect(spoken).toEqual(['Let me think about that one.', 'That one is beyond me. Ask me about your slices.']);
  });

  it('speaks the acknowledgement first, then the oracle answer', async () => {
    const oracle: Oracle = { name: 'test', ask: async () => 'Because of Rayleigh scattering.' };
    const { assistant, spoken } = harness({ oracle });

    assistant.hear('hey chef why is the sky blue');
    // The acknowledgement is synchronous: there must be no dead air while the model thinks.
    expect(spoken).toEqual(['Let me think about that one.']);

    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken[1]).toBe('Because of Rayleigh scattering.');
  });

  it('hands the oracle the live board state as context', async () => {
    const seen: string[] = [];
    const oracle: Oracle = {
      name: 'test',
      ask: async (_q, context) => { seen.push(context); return 'fine'; },
    };
    const { assistant } = harness({ oracle });
    assistant.hear('hey chef what do you think of my knife');

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toContain('Sandwich rounds');
    expect(seen[0]).toContain('2 slices cut');
  });

  it('strips the wake phrase before asking, so the model is not sent "hey chef"', async () => {
    const asked: string[] = [];
    const oracle: Oracle = {
      name: 'test',
      ask: async (question) => { asked.push(question); return 'fine'; },
    };
    const { assistant } = harness({ oracle });
    assistant.hear('hey chef why is the sky blue');

    await vi.waitFor(() => expect(asked).toEqual(['why is the sky blue']));
  });

  /**
   * Rule #9: every network call gets a timeout and a fallback. A model that never answers must
   * leave the chef talking, not mute.
   */
  it('abandons a slow oracle and still says something', async () => {
    const oracle: Oracle = { name: 'slow', ask: () => new Promise(() => {}) };
    const { assistant, spoken, errors } = harness({ oracle });

    assistant.hear('hey chef why is the sky blue');
    await vi.waitFor(() => expect(spoken).toHaveLength(2), { timeout: 2000 });

    expect(spoken[1]).toContain('Ask me about your slices');
    expect(errors[0]).toContain('did not answer in time');
  });

  it('survives an oracle that throws', async () => {
    const oracle: Oracle = { name: 'broken', ask: async () => { throw new Error('nope'); } };
    const { assistant, spoken } = harness({ oracle });

    assistant.hear('hey chef why is the sky blue');
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    expect(spoken[1]).toContain('Ask me about your slices');
  });

  it('ignores an empty answer rather than speaking silence', async () => {
    const oracle: Oracle = { name: 'empty', ask: async () => '   ' };
    const { assistant, spoken } = harness({ oracle });

    assistant.hear('hey chef why is the sky blue');
    await new Promise((r) => setTimeout(r, 50));
    expect(spoken).toEqual(['Let me think about that one.']);
  });

  it('never consults the oracle for something it understood', async () => {
    let calls = 0;
    const oracle: Oracle = { name: 'test', ask: async () => { calls++; return 'x'; } };
    const { assistant } = harness({ oracle });

    for (const phrase of ['is it done yet', 'whats the target', 'go easy on me', 'start over']) {
      assistant.hear(`hey chef ${phrase}`);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
  });
});

describe('heardHandler', () => {
  const collect = () => {
    const heard: string[] = [];
    const fake = { hear: (t: string) => heard.push(t) } as unknown as Parameters<
      typeof heardHandler
    >[0];
    return { heard, handler: heardHandler(fake) };
  };

  /** Chrome emits a running guess on nearly every syllable. Acting on them answers three times. */
  it('ignores interim results', () => {
    const { heard, handler } = collect();
    handler({ text: 'hey chef how', final: false });
    handler({ text: 'hey chef how am i', final: false });
    expect(heard).toEqual([]);

    handler({ text: 'hey chef how am i doing', final: true });
    expect(heard).toEqual(['hey chef how am i doing']);
  });

  /** The same settled transcript is commonly delivered twice across a session restart. */
  it('drops an identical final inside the repeat window', () => {
    const { heard, handler } = collect();
    handler({ text: 'hey chef make it four', final: true });
    handler({ text: 'hey chef make it four', final: true });
    expect(heard).toHaveLength(1);
  });

  it('allows the same phrase again once the window has passed', () => {
    const heard: string[] = [];
    const fake = { hear: (t: string) => heard.push(t) } as unknown as Parameters<
      typeof heardHandler
    >[0];
    const handler = heardHandler(fake, undefined, 0);

    handler({ text: 'hey chef make it four', final: true });
    handler({ text: 'hey chef make it four', final: true });
    expect(heard).toHaveLength(2);
  });

  it('ignores blank finals', () => {
    const { heard, handler } = collect();
    handler({ text: '   ', final: true });
    expect(heard).toEqual([]);
  });

  it('reports every transcript, interim included, for the screen', () => {
    const seen: boolean[] = [];
    const fake = { hear: () => {} } as unknown as Parameters<typeof heardHandler>[0];
    const handler = heardHandler(fake, (h) => seen.push(h.final));

    handler({ text: 'hey', final: false });
    handler({ text: 'hey chef', final: true });
    expect(seen).toEqual([false, true]);
  });
});

describe('createTyped', () => {
  it('feeds submitted text through only while started', () => {
    const heard: string[] = [];
    const typed = createTyped({ onHeard: (h) => heard.push(h.text) });

    typed.submit('ignored, not started');
    typed.start();
    typed.submit('hey chef is it done yet');

    expect(heard).toEqual(['hey chef is it done yet']);
  });

  it('is always available, which is the point of it', () => {
    expect(createTyped({ onHeard: () => {} }).available).toBe(true);
  });
});
