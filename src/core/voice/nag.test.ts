import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NAG_POLICY,
  emptyNag,
  faultKey,
  FULL_SERVICE_POLICY,
  GENTLE_POLICY,
  MIN_CONFIDENCE_TO_ACCUSE,
  mutedPolicy,
  nextInterruption,
  policyForIntensity,
  recordInterruption,
  recordSpoke,
  type NagState,
  type OpenFault,
} from './nag.js';

const fault = (patch: Partial<OpenFault> = {}): OpenFault => ({
  kind: 'ingredient-missing',
  ingredient: 'tomato',
  instruction: 'No tomato on the board -- the recipe needs it',
  severity: 'blocking',
  firstSeenMs: 0,
  clearedMs: null,
  ...patch,
});

/** Confident enough to be allowed to speak, so each test isolates the rule it is about. */
const SURE = 0.9;

describe('nextInterruption -- persistence', () => {
  it('says nothing about a fault that has only just appeared', () => {
    const now = 1000;
    expect(nextInterruption([fault({ firstSeenMs: now - 500 })], emptyNag(), now, SURE)).toBeNull();
  });

  it('speaks once the fault has stood long enough to be a fact about the kitchen', () => {
    const now = 10_000;
    const hit = nextInterruption(
      [fault({ firstSeenMs: now - DEFAULT_NAG_POLICY.minPersistenceMs })],
      emptyNag(), now, SURE,
    );
    expect(hit?.instruction).toContain('No tomato');
  });

  it('never interrupts about a fault the cook already cleared', () => {
    const now = 10_000;
    expect(nextInterruption(
      [fault({ firstSeenMs: 0, clearedMs: 5000 })], emptyNag(), now, SURE,
    )).toBeNull();
  });
});

describe('nextInterruption -- silence beats a false accusation', () => {
  it('says nothing at all below the confidence floor, however severe the fault', () => {
    const now = 60_000;
    expect(nextInterruption(
      [fault()], emptyNag(), now, MIN_CONFIDENCE_TO_ACCUSE - 0.01,
    )).toBeNull();
  });

  it('speaks at exactly the floor, so the threshold is a floor and not a gap', () => {
    const now = 60_000;
    expect(nextInterruption([fault()], emptyNag(), now, MIN_CONFIDENCE_TO_ACCUSE)).not.toBeNull();
  });

  /** A zero confidence is what an empty or unseen board produces. It must be total silence. */
  it('says nothing on a zero-confidence observation', () => {
    expect(nextInterruption([fault()], emptyNag(), 60_000, 0)).toBeNull();
  });
});

describe('nextInterruption -- one thing at a time', () => {
  it('picks the most severe open fault, not the first in the list', () => {
    const now = 60_000;
    const hit = nextInterruption([
      fault({ kind: 'cut-uneven', severity: 'minor', instruction: 'These are wandering' }),
      fault({ kind: 'count-short', severity: 'major', instruction: 'Add 2 more tomato' }),
      fault({ kind: 'ingredient-missing', severity: 'blocking', instruction: 'No mozzarella' }),
    ], emptyNag(), now, SURE);
    expect(hit?.instruction).toBe('No mozzarella');
  });

  it('breaks a tie on age -- the oldest is the one they are least likely to be fixing', () => {
    const now = 60_000;
    const hit = nextInterruption([
      fault({ ingredient: 'mozzarella', firstSeenMs: 40_000, instruction: 'newer' }),
      fault({ ingredient: 'tomato', firstSeenMs: 10_000, instruction: 'older' }),
    ], emptyNag(), now, SURE);
    expect(hit?.instruction).toBe('older');
  });

  it('returns one interruption, never a list', () => {
    const hit = nextInterruption(
      [fault({ ingredient: 'a' }), fault({ ingredient: 'b' })], emptyNag(), 60_000, SURE,
    );
    expect(hit).not.toBeNull();
    expect(Array.isArray(hit)).toBe(false);
  });
});

describe('nextInterruption -- do not nag', () => {
  const spoken = (at: number, key: string): NagState =>
    recordInterruption(emptyNag(), {
      key, instruction: 'x', severity: 'blocking', firstSeenMs: 0,
    }, at);

  /**
   * The failure this rule prevents: a cook who has been told to add salt and is reaching for
   * the salt is mid-fix, which looks identical to "still open". Repeating on "still open" gives
   * a chef that talks continuously until the problem happens to go away.
   */
  it('does not repeat the same correction while the cook is acting on it', () => {
    const at = 60_000;
    const state = spoken(at, faultKey(fault()));
    const soon = at + DEFAULT_NAG_POLICY.repeatAfterMs - 1;
    expect(nextInterruption([fault()], state, soon, SURE)).toBeNull();
  });

  it('will repeat it eventually, if it is still not fixed', () => {
    const at = 60_000;
    const state = spoken(at, faultKey(fault()));
    const later = at + DEFAULT_NAG_POLICY.repeatAfterMs + 1;
    expect(nextInterruption([fault()], state, later, SURE)).not.toBeNull();
  });

  it('holds its tongue for the cooldown even about something entirely different', () => {
    const at = 60_000;
    const state = spoken(at, 'something:else');
    const soon = at + DEFAULT_NAG_POLICY.cooldownMs - 1;
    expect(nextInterruption([fault()], state, soon, SURE)).toBeNull();
    expect(nextInterruption([fault()], state, at + DEFAULT_NAG_POLICY.cooldownMs, SURE))
      .not.toBeNull();
  });

  /** The backstop against a rotating cast of plausible faults under bad lighting. */
  it('stops entirely once the session ceiling is reached', () => {
    let state = emptyNag();
    let now = 60_000;
    for (let i = 0; i < DEFAULT_NAG_POLICY.maxPerSession; i++) {
      const hit = nextInterruption([fault({ ingredient: `x${i}` })], state, now, SURE);
      expect(hit, `interruption ${i}`).not.toBeNull();
      state = recordInterruption(state, hit!, now);
      now += DEFAULT_NAG_POLICY.cooldownMs;
    }
    expect(state.count).toBe(DEFAULT_NAG_POLICY.maxPerSession);
    expect(nextInterruption([fault({ ingredient: 'fresh' })], state, now, SURE)).toBeNull();
  });
});

describe('the intensity slider changes how often the chef speaks, not just how rudely', () => {
  it('runs from Gentle Nonna to Full Service', () => {
    expect(policyForIntensity(0)).toEqual(GENTLE_POLICY);
    expect(policyForIntensity(1)).toEqual(FULL_SERVICE_POLICY);
  });

  it('clamps nonsense rather than producing a nonsense policy', () => {
    expect(policyForIntensity(-5)).toEqual(GENTLE_POLICY);
    expect(policyForIntensity(99)).toEqual(FULL_SERVICE_POLICY);
    expect(policyForIntensity(Number.NaN)).toEqual(GENTLE_POLICY);
  });

  it('only mentions blockers at the gentle end', () => {
    const now = 600_000;
    const major = fault({ kind: 'count-short', severity: 'major' });
    expect(nextInterruption([major], emptyNag(), now, SURE, GENTLE_POLICY)).toBeNull();
    expect(nextInterruption([major], emptyNag(), now, SURE, FULL_SERVICE_POLICY)).not.toBeNull();
  });

  it('never mentions craft notes, at any intensity', () => {
    const now = 600_000;
    const minor = fault({ kind: 'cut-uneven', severity: 'minor' });
    for (let i = 0; i <= 10; i++) {
      expect(nextInterruption([minor], emptyNag(), now, SURE, policyForIntensity(i / 10)))
        .toBeNull();
    }
  });

  /** The cook must be able to switch it off, and off must mean off. */
  it('is completely silent when muted', () => {
    expect(nextInterruption([fault()], emptyNag(), 600_000, 1, mutedPolicy())).toBeNull();
  });
});

describe('faultKey', () => {
  /**
   * Excludes the measured value, exactly as `timeline.deficitKey` does: a cucumber drifting
   * from 8mm to 7mm while the cook works on it is one correction being acted on, not a fresh
   * thing to shout about.
   */
  it('is the same correction across a changing measurement', () => {
    expect(faultKey(fault({ instruction: '8mm' }))).toBe(faultKey(fault({ instruction: '7mm' })));
  });

  it('separates the same fault about different ingredients', () => {
    expect(faultKey(fault({ ingredient: 'tomato' })))
      .not.toBe(faultKey(fault({ ingredient: 'mozzarella' })));
  });

  it('handles a whole-board fault with no ingredient', () => {
    expect(faultKey(fault({ ingredient: null }))).toBe('ingredient-missing:');
  });
});

describe('recordSpoke -- the clock praise and correction share', () => {
  it('moves the clock without spending the correction budget', () => {
    const state: NagState = { spokenAtMs: { 'a:b': 10 }, lastAtMs: 10, count: 1 };
    const after = recordSpoke(state, 5000);
    expect(after.lastAtMs).toBe(5000);
    expect(after.count).toBe(1);
    expect(after.spokenAtMs).toEqual({ 'a:b': 10 });
  });

  it('makes the next correction wait, which is the whole point of sharing it', () => {
    const open = fault({ firstSeenMs: 0 });
    const state = recordSpoke(emptyNag(), 5000);
    expect(nextInterruption([open], state, 6000, 0.9, FULL_SERVICE_POLICY)).toBeNull();
    expect(
      nextInterruption([open], state, 5000 + FULL_SERVICE_POLICY.cooldownMs, 0.9, FULL_SERVICE_POLICY),
    ).not.toBeNull();
  });
});
