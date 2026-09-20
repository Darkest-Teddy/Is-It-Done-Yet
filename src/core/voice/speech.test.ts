import { describe, expect, it } from 'vitest';

import {
  afterFailure,
  afterSuccess,
  chooseTier,
  fallbackTier,
  FRESH_RELAY,
  isWorthSynthesising,
  MAX_RELAY_STRIKES,
  MAX_REMEMBERED_CLIPS,
  remember,
  speechKey,
  SPEECH_MAX_SYNTH_CHARS,
  type SpeechCapabilities,
} from './speech.js';

/** Nothing available. Every test below turns exactly the flags it is about back on. */
const NOTHING: SpeechCapabilities = {
  inBank: false,
  inCache: false,
  canSynthesise: false,
  hasBrowserVoice: false,
};

const caps = (patch: Partial<SpeechCapabilities> = {}): SpeechCapabilities => ({
  ...NOTHING,
  ...patch,
});

describe('speechKey', () => {
  it('collapses the whitespace two assemblies of one sentence differ by', () => {
    expect(speechKey('Add  two\n tomato.')).toBe('Add two tomato.');
    expect(speechKey('  Slice thinner.  ')).toBe('Slice thinner.');
  });

  it('is the same key for the same sentence built two ways', () => {
    // A template with an empty slot in it, and a model reply with a stray newline.
    expect(speechKey('Step 2.  Slice thinner.')).toBe(speechKey('Step 2.\nSlice thinner.'));
  });

  it('keeps case and punctuation, because those are prosody and not formatting', () => {
    expect(speechKey('Stop.')).not.toBe(speechKey('stop'));
    expect(speechKey('STOP')).not.toBe(speechKey('stop'));
  });

  it('collapses whitespace-only text to the empty key', () => {
    expect(speechKey('   \n\t ')).toBe('');
  });
});

describe('isWorthSynthesising', () => {
  it('refuses empty and whitespace-only text', () => {
    expect(isWorthSynthesising('')).toBe(false);
    expect(isWorthSynthesising('   ')).toBe(false);
  });

  it('accepts a spoken sentence', () => {
    expect(isWorthSynthesising('Add two more tomato before you move on.')).toBe(true);
  });

  it('refuses a paragraph that reached the speaker by mistake', () => {
    expect(isWorthSynthesising('a'.repeat(SPEECH_MAX_SYNTH_CHARS + 1))).toBe(false);
  });

  it('measures the normalised text, not the raw text', () => {
    // Padding is not billable and must not tip a legitimate sentence over the ceiling.
    const padded = `${' '.repeat(200)}Slice thinner.${' '.repeat(200)}`;
    expect(padded.length).toBeGreaterThan(SPEECH_MAX_SYNTH_CHARS);
    expect(isWorthSynthesising(padded)).toBe(true);
  });
});

describe('chooseTier', () => {
  it('plays the pre-generated clip when there is one, network or not', () => {
    expect(chooseTier('There we go.', caps({ inBank: true, canSynthesise: true }))).toBe('bank');
  });

  it('prefers the bank over an identical clip already synthesised', () => {
    expect(chooseTier('There we go.', caps({ inBank: true, inCache: true }))).toBe('bank');
  });

  it('plays a clip it synthesised earlier rather than paying for it twice', () => {
    expect(chooseTier('Add two tomato.', caps({ inCache: true, canSynthesise: true })))
      .toBe('cache');
  });

  it('synthesises novel text even though the browser voice would be instant', () => {
    expect(chooseTier('Add two tomato.', caps({ canSynthesise: true, hasBrowserVoice: true })))
      .toBe('relay');
  });

  it('falls to the browser voice with no relay', () => {
    expect(chooseTier('Add two tomato.', caps({ hasBrowserVoice: true }))).toBe('browser');
  });

  it('is silent with no relay and no browser voice -- the headset case', () => {
    expect(chooseTier('Add two tomato.', caps())).toBe('silent');
  });

  it('never routes text to the relay that the relay would refuse', () => {
    const tooLong = 'a'.repeat(SPEECH_MAX_SYNTH_CHARS + 1);
    expect(chooseTier(tooLong, caps({ canSynthesise: true, hasBrowserVoice: true })))
      .toBe('browser');
    expect(chooseTier(tooLong, caps({ canSynthesise: true }))).toBe('silent');
  });

  it('says nothing about nothing, whatever is available', () => {
    const everything = caps({
      inBank: true,
      inCache: true,
      canSynthesise: true,
      hasBrowserVoice: true,
    });
    expect(chooseTier('', everything)).toBe('silent');
    expect(chooseTier('   ', everything)).toBe('silent');
  });
});

describe('fallbackTier', () => {
  it('hands a failed synthesis to the browser voice when there is one', () => {
    expect(fallbackTier(caps({ hasBrowserVoice: true }))).toBe('browser');
  });

  it('is silent on the headset, which is what the subtitle is for', () => {
    expect(fallbackTier(caps())).toBe('silent');
  });

  it('does not send a failed synthesis back to the relay', () => {
    // The caller has already spent its timeout. Spending a second one is the thing this
    // function exists to refuse.
    expect(fallbackTier(caps({ canSynthesise: true }))).toBe('silent');
  });
});

describe('remember', () => {
  it('stores and reads back', () => {
    const cache = new Map<string, number>();
    remember(cache, 'a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('evicts the oldest once the cap is reached', () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < 5; i++) remember(cache, `line ${i}`, i, 3);
    expect([...cache.keys()]).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('replaces in place without disturbing the order', () => {
    const cache = new Map<string, number>();
    remember(cache, 'a', 1, 2);
    remember(cache, 'b', 2, 2);
    remember(cache, 'a', 9, 2);
    expect([...cache.keys()]).toEqual(['a', 'b']);
    expect(cache.get('a')).toBe(9);
  });

  it('stores nothing at all when the cap is zero', () => {
    const cache = new Map<string, number>();
    remember(cache, 'a', 1, 0);
    expect(cache.size).toBe(0);
  });

  it('defaults to a cap that holds a session of distinct lines', () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < MAX_REMEMBERED_CLIPS + 4; i++) remember(cache, `line ${i}`, i);
    expect(cache.size).toBe(MAX_REMEMBERED_CLIPS);
  });
});

describe('relay health', () => {
  it('tolerates one failure, because venue wifi is weather', () => {
    const once = afterFailure(FRESH_RELAY, 502);
    expect(once.disabled).toBe(false);
    expect(once.strikes).toBe(1);
  });

  it('gives up after the strike limit', () => {
    let health = FRESH_RELAY;
    for (let i = 0; i < MAX_RELAY_STRIKES; i++) health = afterFailure(health, null);
    expect(health.disabled).toBe(true);
  });

  it('gives up immediately on a status that means this deployment has no voice', () => {
    expect(afterFailure(FRESH_RELAY, 503).disabled).toBe(true);
    expect(afterFailure(FRESH_RELAY, 404).disabled).toBe(true);
  });

  it('keeps trying through a spent quota or a bad key, which the relay reports as 502', () => {
    expect(afterFailure(FRESH_RELAY, 502).disabled).toBe(false);
    expect(afterFailure(FRESH_RELAY, 504).disabled).toBe(false);
  });

  it('clears the record on a success, so two failures an hour apart are not fatal', () => {
    const once = afterFailure(FRESH_RELAY, null);
    expect(afterSuccess(once)).toEqual(FRESH_RELAY);
    expect(afterFailure(afterSuccess(once), null).disabled).toBe(false);
  });

  it('cannot be revived once disabled', () => {
    const dead = afterFailure(FRESH_RELAY, 503);
    expect(afterSuccess(dead).disabled).toBe(true);
    expect(afterFailure(dead, 502)).toBe(dead);
  });
});
