import { describe, expect, it } from 'vitest';

import { allLines } from '../barks.js';
import type { DeficitSpan } from '../timeline.js';
import { GOOD_EVENNESS, OVERLAY_MAX_WORDS, TEXT_MAX_CHARS } from './guidance.js';
import { FULL_SERVICE_POLICY, mutedPolicy, type NagPolicy } from './nag.js';
import {
  emptyPraise,
  emptyWatch,
  EVENNESS_HOLD_MS,
  MIN_EVENNESS_GAIN,
  nextPraise,
  observePraise,
  praiseGuidance,
  praisePolicy,
  recordPraise,
  PRAISE_GRACE_MS,
  type PendingPraise,
  type PraiseSignal,
  type PraiseWatch,
} from './praise.js';

const POLICY = FULL_SERVICE_POLICY;

const span = (patch: Partial<DeficitSpan> = {}): DeficitSpan => ({
  kind: 'count-short',
  ingredient: 'tomato',
  instruction: 'Add 2 more tomato -- 1 on the board, recipe wants 3-4',
  severity: 'major',
  firstSeenMs: 0,
  clearedMs: 10_000,
  ...patch,
});

const signal = (patch: Partial<PraiseSignal> = {}): PraiseSignal => ({
  spans: [],
  spokenKeys: new Set<string>(),
  evenness: null,
  doneCount: 0,
  stepCount: 9,
  troubled: false,
  ...patch,
});

/** Seeds the watch, because the first observation deliberately never praises. */
function started(first: PraiseSignal = signal(), policy: NagPolicy = POLICY): PraiseWatch {
  return observePraise(emptyWatch(), first, 0, policy);
}

/**
 * What was detected at `nowMs`, as opposed to what is still queued from earlier.
 *
 * `pending` holds events until they are spoken or go stale, so asking "did anything happen
 * this frame" means filtering by the moment rather than reading the whole queue.
 */
const kinds = (watch: PraiseWatch, nowMs: number): string[] =>
  watch.pending.filter((e) => e.atMs === nowMs).map((e) => e.kind);

const at = (watch: PraiseWatch, nowMs: number): PendingPraise | undefined =>
  watch.pending.find((e) => e.atMs === nowMs);

describe('observePraise -- the first observation only seeds', () => {
  it('says nothing about a session it has just joined, however good it looks', () => {
    const watch = observePraise(
      emptyWatch(),
      signal({
        spans: [span()],
        spokenKeys: new Set(['count-short:tomato']),
        doneCount: 4,
      }),
      20_000,
      POLICY,
    );
    expect(watch.pending).toEqual([]);
    // And it has taken the credit, so the same closure cannot arrive again a frame later.
    expect(watch.started).toBe(true);
    const next = observePraise(watch, signal({
      spans: [span()], spokenKeys: new Set(['count-short:tomato']), doneCount: 4,
    }), 21_000, POLICY);
    expect(next.pending).toEqual([]);
  });
});

describe('observePraise -- a fault the chef complained about is gone', () => {
  const resolved = (patch: Partial<PraiseSignal> = {}): PraiseWatch =>
    observePraise(
      started(),
      signal({ spans: [span()], spokenKeys: new Set(['count-short:tomato']), ...patch }),
      12_000,
      POLICY,
    );

  it('is pleased when the fault it mentioned closes', () => {
    const watch = resolved();
    expect(kinds(watch, 12_000)).toEqual(['resolved']);
    expect(at(watch, 12_000)!.bark).toBe('improving');
    expect(at(watch, 12_000)!.detail).toContain('Add 2 more tomato');
    // The evidence, not just the compliment.
    expect(at(watch, 12_000)!.detail).toMatch(/10s/);
  });

  it('SAYS NOTHING about a fault it never mentioned, which is the occlusion guard', () => {
    // A hand over the lens opens every requirement as missing and closes them all when it
    // moves. Unguarded that reads as the cook fixing four things at once.
    expect(kinds(resolved({ spokenKeys: new Set() }), 12_000)).toEqual([]);
  });

  it('ignores a fault too short-lived to have been a fact about the kitchen', () => {
    const brief = span({ firstSeenMs: 9000, clearedMs: 10_000 });
    const watch = observePraise(
      started(),
      signal({ spans: [brief], spokenKeys: new Set(['count-short:tomato']) }),
      12_000,
      POLICY,
    );
    expect(kinds(watch, 12_000)).toEqual([]);
  });

  it('ignores craft notes it would never have interrupted about', () => {
    const minor = span({ severity: 'minor' });
    const watch = observePraise(
      started(),
      signal({ spans: [minor], spokenKeys: new Set(['count-short:tomato']) }),
      12_000,
      POLICY,
    );
    expect(kinds(watch, 12_000)).toEqual([]);
  });

  it('is pleased once per closure, not once per frame for the rest of the session', () => {
    const after = resolved();
    const again = observePraise(
      after,
      signal({ spans: [span()], spokenKeys: new Set(['count-short:tomato']) }),
      13_000,
      POLICY,
    );
    expect(kinds(again, 13_000)).toEqual([]);
  });

  it('still says nothing about a span that is open', () => {
    const watch = observePraise(
      started(),
      signal({ spans: [span({ clearedMs: null })], spokenKeys: new Set(['count-short:tomato']) }),
      12_000,
      POLICY,
    );
    expect(kinds(watch, 12_000)).toEqual([]);
  });
});

describe('observePraise -- a step finished with a clean board', () => {
  it('notices the step going by', () => {
    const watch = observePraise(started(), signal({ doneCount: 1 }), 5000, POLICY);
    expect(kinds(watch, 5000)).toEqual(['step-clean']);
    expect(at(watch, 5000)!.bark).toBe('perfect');
    expect(at(watch, 5000)!.detail).toContain('Step 1 of 9');
  });

  it('stays quiet when something blocking or major is open right now', () => {
    const watch = observePraise(started(), signal({ doneCount: 1, troubled: true }), 5000, POLICY);
    expect(kinds(watch, 5000)).toEqual([]);
    // But the count still advances, so the suppressed step is not praised later out of nowhere.
    expect(watch.doneCount).toBe(1);
    expect(kinds(observePraise(watch, signal({ doneCount: 1 }), 6000, POLICY), 6000)).toEqual([]);
  });

  it('says nothing when the step count goes backwards, which an unconfirm does', () => {
    const one = observePraise(started(), signal({ doneCount: 2 }), 5000, POLICY);
    expect(kinds(observePraise(one, signal({ doneCount: 1 }), 6000, POLICY), 6000)).toEqual([]);
  });
});

describe('observePraise -- evenness climbed AND held', () => {
  const base = 0.60;
  const up = base + MIN_EVENNESS_GAIN + 0.02;

  const seeded = (): PraiseWatch => started(signal({ evenness: base }));

  it('waits out the hold before it is willing to call it an improvement', () => {
    let watch = seeded();
    watch = observePraise(watch, signal({ evenness: up }), 1000, POLICY);
    expect(kinds(watch, 1000)).toEqual([]);
    watch = observePraise(watch, signal({ evenness: up }), 1000 + EVENNESS_HOLD_MS - 1, POLICY);
    expect(kinds(watch, 1000 + EVENNESS_HOLD_MS - 1)).toEqual([]);
    watch = observePraise(watch, signal({ evenness: up }), 1000 + EVENNESS_HOLD_MS, POLICY);
    expect(kinds(watch, 1000 + EVENNESS_HOLD_MS)).toEqual(['steadier']);
  });

  it('drops the climb the moment it falls back under the bar', () => {
    let watch = seeded();
    watch = observePraise(watch, signal({ evenness: up }), 1000, POLICY);
    watch = observePraise(watch, signal({ evenness: base }), 2000, POLICY);
    expect(watch.climbing).toBeNull();
    watch = observePraise(watch, signal({ evenness: up }), 2000 + EVENNESS_HOLD_MS, POLICY);
    expect(kinds(watch, 2000 + EVENNESS_HOLD_MS)).toEqual([]);
  });

  it('does not let a frame with nothing measured restart the climb', () => {
    let watch = seeded();
    watch = observePraise(watch, signal({ evenness: up }), 1000, POLICY);
    watch = observePraise(watch, signal({ evenness: null }), 2000, POLICY);
    watch = observePraise(watch, signal({ evenness: up }), 1000 + EVENNESS_HOLD_MS, POLICY);
    expect(kinds(watch, 1000 + EVENNESS_HOLD_MS)).toEqual(['steadier']);
  });

  it('quotes the level actually sustained rather than the peak it touched once', () => {
    let watch = started(signal({ evenness: base }));
    watch = observePraise(watch, signal({ evenness: 0.95 }), 1000, POLICY);
    watch = observePraise(watch, signal({ evenness: 0.71 }), 2000, POLICY);
    watch = observePraise(watch, signal({ evenness: 0.90 }), 1000 + EVENNESS_HOLD_MS, POLICY);
    expect(kinds(watch, 1000 + EVENNESS_HOLD_MS)).toEqual(['steadier']);
    expect(at(watch, 1000 + EVENNESS_HOLD_MS)!.detail).toContain('71%');
    expect(watch.heldEvenness).toBeCloseTo(0.71, 5);
  });

  it('calls a climb that reached good "perfect" and one that did not "close"', () => {
    const climb = (from: number, to: number): PendingPraise => {
      let watch = started(signal({ evenness: from }));
      watch = observePraise(watch, signal({ evenness: to }), 1000, POLICY);
      watch = observePraise(watch, signal({ evenness: to }), 1000 + EVENNESS_HOLD_MS, POLICY);
      return at(watch, 1000 + EVENNESS_HOLD_MS)!;
    };
    expect(climb(0.70, GOOD_EVENNESS + 0.01).bark).toBe('perfect');
    expect(climb(0.50, 0.70).bark).toBe('close');
  });

  it('never lets the bar creep, so slow steady improvement still earns a word', () => {
    // Each step is under the gain threshold on its own; together they are not.
    let watch = started(signal({ evenness: 0.60 }));
    watch = observePraise(watch, signal({ evenness: 0.64 }), 1000, POLICY);
    expect(watch.heldEvenness).toBeCloseTo(0.60, 5);
    watch = observePraise(watch, signal({ evenness: 0.69 }), 2000, POLICY);
    watch = observePraise(watch, signal({ evenness: 0.69 }), 2000 + EVENNESS_HOLD_MS, POLICY);
    expect(kinds(watch, 2000 + EVENNESS_HOLD_MS)).toEqual(['steadier']);
  });
});

describe('praisePolicy -- rarer than correction, and off when correction is off', () => {
  it('takes slots from the chef rather than adding slots of its own', () => {
    expect(praisePolicy(POLICY).cooldownMs).toBe(POLICY.cooldownMs);
  });

  it('keeps an event alive at least as long as it is required to stay quiet', () => {
    // Otherwise the policy deletes praise rather than delaying it -- the cook fixes what they
    // were just told about well inside that correction's own cooldown.
    expect(praisePolicy(POLICY).freshnessMs).toBe(POLICY.cooldownMs + PRAISE_GRACE_MS);
  });

  it('is allowed fewer words per session than corrections are', () => {
    expect(praisePolicy(POLICY).maxPerSession).toBeLessThan(POLICY.maxPerSession);
  });

  it('is silenced by the off switch, because SILENT has to mean silent', () => {
    expect(praisePolicy(mutedPolicy()).maxPerSession).toBe(0);
  });
});

describe('nextPraise -- the refusals', () => {
  const event = (patch: Partial<PendingPraise> = {}): PendingPraise => ({
    kind: 'resolved',
    key: 'resolved:count-short:tomato',
    bark: 'improving',
    detail: 'That fixed it.',
    overlay: 'That fixed it',
    atMs: 0,
    ...patch,
  });

  const opts = { policy: POLICY, intensity: 1, random: (): number => 0 };

  it('says something when every bar is cleared', () => {
    expect(nextPraise([event()], emptyPraise(), null, 0, 0.9, opts)).not.toBeNull();
  });

  it('is silent below the confidence floor, exactly as a correction is', () => {
    expect(nextPraise([event()], emptyPraise(), null, 0, 0.2, opts)).toBeNull();
  });

  it('shares the chef\'s clock rather than keeping one of its own', () => {
    const justSpoke = 1000;
    const cooldown = praisePolicy(POLICY).cooldownMs;
    const fresh = event({ atMs: justSpoke });
    expect(nextPraise([fresh], emptyPraise(), justSpoke, justSpoke + 1, 0.9, opts)).toBeNull();
    expect(
      nextPraise([fresh], emptyPraise(), justSpoke, justSpoke + cooldown, 0.9, opts),
    ).not.toBeNull();
  });

  it('lets good news go stale rather than reporting a kitchen that has moved on', () => {
    const stale = praisePolicy(POLICY).freshnessMs + 1;
    expect(nextPraise([event()], emptyPraise(), null, stale, 0.9, opts)).toBeNull();
  });

  it('will not repeat the same good news while the repeat window is open', () => {
    const state = recordPraise(emptyPraise(), nextPraise([event()], emptyPraise(), null, 0, 0.9, opts)!, 0);
    expect(nextPraise([event()], state, null, 1000, 0.9, opts)).toBeNull();
    const later = praisePolicy(POLICY).repeatAfterMs;
    expect(
      nextPraise([event({ atMs: later })], state, null, later, 0.9, opts),
    ).not.toBeNull();
  });

  it('stops for the session once its budget is spent', () => {
    let state = emptyPraise();
    const max = praisePolicy(POLICY).maxPerSession;
    for (let i = 0; i < max; i++) {
      const hit = nextPraise([event({ key: `k${i}` })], state, null, 0, 0.9, opts);
      expect(hit).not.toBeNull();
      state = recordPraise(state, hit!, 0);
    }
    expect(nextPraise([event({ key: 'last' })], state, null, 0, 0.9, opts)).toBeNull();
  });

  it('says nothing at all when the chef is muted', () => {
    expect(
      nextPraise([event()], emptyPraise(), null, 0, 0.9, { ...opts, policy: mutedPolicy() }),
    ).toBeNull();
  });

  it('says one thing, and the most earned thing, never a list', () => {
    const hit = nextPraise(
      [event({ kind: 'steadier', key: 'steadier' }),
       event({ kind: 'step-clean', key: 'step-clean:1' }),
       event()],
      emptyPraise(), null, 0, 0.9, opts,
    );
    expect(hit?.kind).toBe('resolved');
  });

  it('takes its words from the bark bank, which is what lets the headset speak them', () => {
    const hit = nextPraise([event()], emptyPraise(), null, 0, 0.9, opts);
    expect(allLines()).toContain(hit!.line);
  });

  it('follows the intensity slider into Gentle Nonna\'s register', () => {
    const gentle = nextPraise([event()], emptyPraise(), null, 0, 0.9, { ...opts, intensity: 0 });
    const full = nextPraise([event()], emptyPraise(), null, 0, 0.9, { ...opts, intensity: 1 });
    expect(gentle!.line).not.toBe(full!.line);
  });
});

describe('praiseGuidance -- one answer, three channels, the third tone', () => {
  const praise = {
    kind: 'resolved' as const,
    key: 'resolved:count-short:tomato',
    bark: 'improving' as const,
    line: 'There. You are getting the feel of it.',
    detail: 'That fixed it — Add 2 more tomato had been open 10s.',
    overlay: 'That fixed it',
  };

  it('is marked as praise, so nothing paints it in the correction\'s red', () => {
    expect(praiseGuidance(praise).tone).toBe('praise');
  });

  it('never consults a model, so it is always local', () => {
    expect(praiseGuidance(praise).source).toBe('local');
  });

  it('speaks the bark and writes the measurement that earned it', () => {
    const g = praiseGuidance(praise);
    expect(g.speech).toBe(praise.line);
    expect(g.text).toContain(praise.detail);
  });

  it('keeps the panel inside its budget, however long the deficit it is quoting', () => {
    const g = praiseGuidance({ ...praise, detail: 'x'.repeat(900) });
    expect(g.text.length).toBeLessThanOrEqual(TEXT_MAX_CHARS);
  });

  it('keeps the pin inside the overlay budget like every other message', () => {
    for (const overlay of ['That fixed it', 'Step done, clean', 'Steadier — keep going']) {
      const g = praiseGuidance({ ...praise, overlay });
      expect(g.overlay.split(/\s+/).length).toBeLessThanOrEqual(OVERLAY_MAX_WORDS);
    }
  });
});
