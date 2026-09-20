/**
 * When the chef is allowed to say you did something right, and -- as in `nag.ts` -- mostly when
 * it is not.
 *
 * The unprompted path used to fire on one thing only: a `Deficit`. A coach that speaks only to
 * criticise is one people switch off, and it never shows anybody what good looks like. So this
 * is the second half of the autonomous watch, and it is built as the MIRROR of the first half
 * rather than as a second voice with opinions of its own.
 *
 * THE MIRROR, PRECISELY. Praise takes the same severity floor, the same persistence bar, the
 * same confidence floor, the same per-key repeat window and the same clock as correction. It
 * differs in one number -- a third of the session's budget -- and in one extra refusal of its
 * own. Being told you are doing well every ten seconds is worse than being told once when you
 * actually improved, so praise is deliberately RARER than correction; but rare by BUDGET, not
 * by silence, because a longer cooldown turned out to delete praise rather than delay it. See
 * `PRAISE_SHARE` for that, and `PRAISE_GRACE_MS` for what replaced it.
 *
 * FOUR REFUSALS, THE SAME FOUR.
 *
 * **Earned, not offered.** Every event here is a measurement that changed: a fault the chef
 * complained about is gone, evenness climbed and stayed climbed, a step finished with a clean
 * board. Praise for nothing is not neutral -- it spends the signal, and the next genuine
 * "that's it" means nothing because the cook has learned the chef says that anyway.
 *
 * **One thing at a time.** `nextPraise` returns one event or null, never a list.
 *
 * **Not twice for the same thing.** Keyed and rate-limited exactly like a correction, so a
 * fault that flickers closed and open again is one piece of good news, not four.
 *
 * **Silence below the confidence floor.** This matters MORE here than it does for correction,
 * and the failure mode is specific: when the camera stops seeing the board, `diff` reports
 * every requirement missing, those spans open, and when the view comes back they all close at
 * once. Read naively that is the cook heroically fixing four things in one second, and the
 * chef congratulating somebody for an occlusion is the same trust-destroying event as accusing
 * them of one. Which is why resolution praise is additionally gated on the chef having ACTUALLY
 * SPOKEN about the fault -- see `spokenKeys` below.
 *
 * Pure. No clock, no state of its own, no model: `nowMs` and the state come in and a new state
 * goes out, and the words come from `core/barks.ts` rather than from Qwen3. DECISIONS.md entry
 * 26 draws that line for interruptions and this stays on the same side of it -- an interruption
 * is spending attention it was not offered, and a model handed a scene description will invent
 * something to be pleased about just as readily as it will invent a mistake.
 */

import type { BarkKind } from '../barks.js';
import { barkFor } from '../barks.js';
import type { DeficitSpan } from '../timeline.js';
import type { Guidance } from './guidance.js';
import { GOOD_EVENNESS, TEXT_MAX_CHARS, toOverlay } from './guidance.js';
import { MIN_CONFIDENCE_TO_ACCUSE, type NagPolicy } from './nag.js';

/**
 * `GOOD_EVENNESS` lives in `guidance.ts` and is imported rather than restated.
 *
 * ONE NUMBER, TWO READERS. `localGuidance` uses it to decide whether to tell a cook their
 * slices are drifting; this file uses it to decide whether a climb earns `perfect` or `close`.
 * Two literals would let the chef call 84% drifting in one channel and praise it in another,
 * inside the same second, which reads as the system disagreeing with itself. The import points
 * this way, and only this way, so the module graph stays a line rather than a loop.
 */

/**
 * How much evenness must climb before the climb is a fact rather than a wobble.
 *
 * TUNED, not sourced. Evenness is recomputed per analysed frame from a handful of widths, so
 * it moves a couple of points on its own; eight is comfortably outside that and still small
 * enough that a cook who genuinely steadies their hand crosses it.
 */
export const MIN_EVENNESS_GAIN = 0.08;

/** How long a climb must hold before it is acknowledged. The "and held" in the rule. */
export const EVENNESS_HOLD_MS = 4000;

/**
 * Share of the session's interruption budget praise is allowed to spend.
 *
 * THIS IS WHERE "RARER THAN CORRECTION" LIVES, and it is the only place it lives. An earlier
 * draft also multiplied the cooldown, which turned out to delete praise rather than delay it:
 * a cook fixes the thing they were just told about within a few seconds, so the good news
 * always arrived inside the correction's own cooldown and was never spoken at all. A budget
 * makes praise rare; a longer cooldown made it impossible.
 * TUNED, not sourced.
 */
export const PRAISE_SHARE = 1 / 3;

/**
 * How long past the policy's own silence an event stays speakable.
 *
 * An event must outlive the silence the policy imposes, or the policy is silently discarding
 * praise instead of scheduling it -- which is the bug above, in a different shape. Past that,
 * good news goes stale: congratulating somebody for evenness that drifted away half a minute
 * ago describes a kitchen that no longer exists, and it teaches them the chef is not watching.
 * TUNED, not sourced.
 */
export const PRAISE_GRACE_MS = 8000;

/** Credited closures kept. A session is ninety seconds; this is a leak guard, not a policy. */
const CREDIT_MEMORY = 32;

const SEVERITY_RANK: Readonly<Record<string, number>> = { blocking: 0, major: 1, minor: 2 };

export type PraiseKind = 'resolved' | 'step-clean' | 'steadier';

/**
 * One measured improvement, in the shape `nextPraise` can rate-limit.
 *
 * `detail` is the measurement in words. It is not decoration: it is what makes the praise
 * checkable by the person receiving it, and a compliment somebody cannot check is one they
 * learn to ignore.
 */
export interface PraiseEvent {
  readonly kind: PraiseKind;
  /** `kind:subject`, matching `faultKey`'s shape. Excludes any measured value, as that does. */
  readonly key: string;
  readonly bark: BarkKind;
  readonly detail: string;
  /** Pinned over the board. Short by the same argument as `OVERLAY_MAX_WORDS`. */
  readonly overlay: string;
}

/** Everything the detector reads, flattened so a test can build one in five lines. */
export interface PraiseSignal {
  /** From `timeline.finalize`. Closed spans are where resolution praise comes from. */
  readonly spans: readonly DeficitSpan[];
  /**
   * Fault keys the chef has actually interrupted about, from `NagState.spokenAtMs`.
   *
   * THE LOAD-BEARING FIELD. Without it, "a deficit that resolved" includes every deficit the
   * camera invented while a hand was over the lens, and the chef congratulates a cook for
   * fixing four things that were never wrong. With it, resolution praise can only ever be
   * "you fixed the thing I told you about" -- which inherits the confidence gate the
   * correction already passed, and is in any case the only resolution a cook would recognise
   * as theirs.
   */
  readonly spokenKeys: ReadonlySet<string>;
  /** 0..1, or null when too few pieces were measured to have one. */
  readonly evenness: number | null;
  readonly doneCount: number;
  readonly stepCount: number;
  /** True when something blocking or major is open RIGHT NOW. Suppresses step praise. */
  readonly troubled: boolean;
}

export interface PraiseWatch {
  /** The evenness level last acknowledged. Never creeps silently -- see `observePraise`. */
  readonly heldEvenness: number | null;
  /** A climb that has cleared the gain bar and is proving it can hold. */
  readonly climbing: { readonly level: number; readonly sinceMs: number } | null;
  readonly doneCount: number;
  /** Closures already turned into an event, so one closure is one piece of good news. */
  readonly credited: readonly string[];
  /**
   * Detected and not yet spoken, newest of each key, oldest first.
   *
   * Events wait out the chef's silence and then expire. They have to wait, because the moment
   * a cook fixes what they were just told about is inside the cooldown of the correction that
   * told them -- an event that could not survive that would never be spoken at all. And they
   * have to expire, because good news has a shelf life: see `PRAISE_GRACE_MS`.
   */
  readonly pending: readonly PendingPraise[];
  /** False until the first observation has been folded in. */
  readonly started: boolean;
}

/** One event with the moment it was true attached. */
export interface PendingPraise extends PraiseEvent {
  readonly atMs: number;
}

export const emptyWatch = (): PraiseWatch => ({
  heldEvenness: null,
  climbing: null,
  doneCount: 0,
  credited: [],
  pending: [],
  started: false,
});

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const pct = (x: number): number => Math.round(x * 100);

/**
 * Folds one observation in and reports what just got better.
 *
 * The first observation seeds and emits nothing, whatever it contains. A session that opens
 * with three steps already satisfied would otherwise begin with the chef congratulating the
 * cook for work they had not done yet.
 */
export function observePraise(
  watch: PraiseWatch,
  signal: PraiseSignal,
  nowMs: number,
  policy: NagPolicy,
): PraiseWatch {
  const events: PraiseEvent[] = [];
  const credited = [...watch.credited];
  const floor = SEVERITY_RANK[policy.minSeverity] ?? 1;

  // ---- a fault the chef complained about is gone

  for (const span of signal.spans) {
    if (span.clearedMs === null) continue;
    const subject = `${span.kind}:${span.ingredient ?? ''}`;
    const closure = `${subject}@${span.clearedMs}`;
    if (credited.includes(closure)) continue;
    credited.push(closure);
    if (!watch.started) continue;

    // Every bar the correction had to clear, so the chef cannot be pleased about the passing of
    // something it would have refused to mention.
    if (!signal.spokenKeys.has(subject)) continue;
    if ((SEVERITY_RANK[span.severity] ?? 9) > floor) continue;
    if (span.clearedMs - span.firstSeenMs < policy.minPersistenceMs) continue;

    const heldSec = Math.round((span.clearedMs - span.firstSeenMs) / 1000);
    events.push({
      kind: 'resolved',
      key: `resolved:${subject}`,
      bark: 'improving',
      detail: `That fixed it — ${span.instruction.split(/\s--\s|\s–\s/)[0]?.trim() ?? span.instruction}`
        + ` had been open ${heldSec}s.`,
      // Not "Fixed. Good." -- `toOverlay` splits on the full stop and the second word is
      // the half that matters.
      overlay: 'That fixed it',
    });
  }

  // ---- a step finished with nothing wrong on the board

  if (watch.started && signal.doneCount > watch.doneCount && !signal.troubled) {
    events.push({
      kind: 'step-clean',
      key: `step-clean:${signal.doneCount}`,
      bark: 'perfect',
      detail: `Step ${signal.doneCount} of ${signal.stepCount} done, and nothing on the board `
        + 'contradicts the recipe.',
      overlay: 'Step done, clean',
    });
  }

  // ---- evenness climbed, and stayed climbed

  let heldEvenness = watch.heldEvenness;
  let climbing = watch.climbing;
  const even = signal.evenness === null ? null : clamp01(signal.evenness);

  if (even === null) {
    // No measurement is not a fall. The climb simply cannot be proved this frame, and a climb
    // that has to restart every time a hand crosses the board is a climb nobody ever completes.
    climbing = watch.climbing;
  } else if (heldEvenness === null) {
    heldEvenness = even;
    climbing = null;
  } else if (even >= heldEvenness + MIN_EVENNESS_GAIN) {
    // `level` tracks the MINIMUM sustained during the climb, so the praise quotes a number the
    // cook actually held rather than the peak they touched once.
    const level = climbing === null ? even : Math.min(climbing.level, even);
    const sinceMs = climbing === null ? nowMs : climbing.sinceMs;
    if (watch.started && nowMs - sinceMs >= EVENNESS_HOLD_MS) {
      events.push({
        kind: 'steadier',
        key: 'steadier',
        bark: level >= GOOD_EVENNESS ? 'perfect' : 'close',
        detail: `Evenness is ${pct(level)}%, up from ${pct(heldEvenness)}%, and it has held `
          + `for ${Math.round((nowMs - sinceMs) / 1000)}s.`,
        overlay: level >= GOOD_EVENNESS ? 'Keep that pace' : 'Steadier — keep going',
      });
      heldEvenness = level;
      climbing = null;
    } else {
      climbing = { level, sinceMs };
    }
  } else {
    // Fell back under the bar. Not held, so not praised, and the climb starts over.
    climbing = null;
  }

  // Newest of each key wins: a second evenness climb supersedes the first rather than queueing
  // behind it, so the chef never reports a number the cook has already moved past.
  const freshMs = praisePolicy(policy).freshnessMs;
  const byKey = new Map<string, PendingPraise>();
  for (const event of watch.pending) {
    if (nowMs - event.atMs <= freshMs) byKey.set(event.key, event);
  }
  for (const event of events) byKey.set(event.key, { ...event, atMs: nowMs });

  return {
    heldEvenness,
    climbing,
    doneCount: signal.doneCount,
    credited: credited.slice(-CREDIT_MEMORY),
    pending: [...byKey.values()].sort((a, b) => a.atMs - b.atMs),
    started: true,
  };
}

/** Drops one event, spoken or not. Pure; returns a new watch. */
export function forgetPraise(watch: PraiseWatch, key: string): PraiseWatch {
  return { ...watch, pending: watch.pending.filter((event) => event.key !== key) };
}

// ---------------------------------------------------------------------------------------------
// Whether to say it
// ---------------------------------------------------------------------------------------------

export interface PraisePolicy {
  readonly cooldownMs: number;
  readonly repeatAfterMs: number;
  readonly maxPerSession: number;
  readonly freshnessMs: number;
}

/**
 * The correction policy, made rarer by budget rather than by silence.
 *
 * THE COOLDOWN IS THE SAME NUMBER, DELIBERATELY. The chef already speaks at most once per
 * cooldown; praise takes some of those slots rather than adding slots of its own, so the rate
 * at which a cook is interrupted does not change at all -- only what some of the interruptions
 * are about. That is a stronger guarantee than a longer praise cooldown would have given, and
 * it is the one a cook actually experiences.
 *
 * Derived rather than written out so the intensity slider governs both halves of the chef with
 * one number, and so `mutedPolicy()` -- whose `maxPerSession` is zero -- silences praise for
 * free. SILENT has to mean silent; an off switch that leaves one voice running is not an off
 * switch, and it is the exact thing a person reaches for when they have had enough.
 */
export function praisePolicy(policy: NagPolicy): PraisePolicy {
  return {
    cooldownMs: policy.cooldownMs,
    repeatAfterMs: policy.repeatAfterMs,
    maxPerSession: Math.floor(policy.maxPerSession * PRAISE_SHARE),
    freshnessMs: policy.cooldownMs + PRAISE_GRACE_MS,
  };
}

export interface PraiseState {
  readonly spokenAtMs: Readonly<Record<string, number>>;
  readonly count: number;
}

export const emptyPraise = (): PraiseState => ({ spokenAtMs: {}, count: 0 });

export interface Praise {
  readonly kind: PraiseKind;
  readonly key: string;
  readonly bark: BarkKind;
  /** Straight out of `core/barks.ts`, which is what lets the pre-generated bank speak it. */
  readonly line: string;
  readonly detail: string;
  readonly overlay: string;
}

export interface PraiseOptions {
  readonly policy: NagPolicy;
  /** Master spec 9.5's slider, 0..1. Picks Gentle Nonna's words or Full Service's. */
  readonly intensity: number;
  readonly minConfidence?: number;
  readonly random?: () => number;
}

/**
 * The one thing worth being pleased about right now, or null -- which is the usual answer.
 *
 * `lastSpokeAtMs` is the last time the chef interrupted about ANYTHING, correction included.
 * Sharing that clock is what stops praise becoming a second voice on its own schedule: a cook
 * corrected two seconds ago does not then get congratulated, and the total rate at which the
 * chef speaks unprompted is still one number the slider controls.
 *
 * Order within one observation is an argument, not an accident: a fault the cook was told about
 * and fixed is the most earned thing available, a clean step is next, and a statistical climb
 * is last because it is the one a cook is least likely to be able to point at.
 */
const ORDER: readonly PraiseKind[] = ['resolved', 'step-clean', 'steadier'];

export function nextPraise(
  events: readonly PendingPraise[],
  state: PraiseState,
  lastSpokeAtMs: number | null,
  nowMs: number,
  confidence: number,
  opts: PraiseOptions,
): Praise | null {
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE_TO_ACCUSE;
  if (!(confidence >= minConfidence)) return null;

  const policy = praisePolicy(opts.policy);
  if (state.count >= policy.maxPerSession) return null;
  if (lastSpokeAtMs !== null && nowMs - lastSpokeAtMs < policy.cooldownMs) return null;

  const ranked = events
    .filter((event) => nowMs - event.atMs <= policy.freshnessMs)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  for (const event of ranked) {
    const last = state.spokenAtMs[event.key];
    if (last !== undefined && nowMs - last < policy.repeatAfterMs) continue;
    const bark = barkFor(event.bark, opts.intensity, opts.random ?? Math.random);
    return {
      kind: event.kind,
      key: event.key,
      bark: bark.kind,
      line: bark.line,
      detail: event.detail,
      overlay: event.overlay,
    };
  }
  return null;
}

/** Folds a spoken praise into the state. Pure; returns a new state. */
export function recordPraise(
  state: PraiseState,
  praise: Praise,
  nowMs: number,
): PraiseState {
  return {
    spokenAtMs: { ...state.spokenAtMs, [praise.key]: nowMs },
    count: state.count + 1,
  };
}

/**
 * Praise as the same three-channel answer everything else in this feature produces.
 *
 * Built here rather than at the renderer so `present()` stays the only writer of the three
 * channels and there is still exactly one `Guidance` behind them. The spoken line is the bark;
 * the panel gets the bark AND the measurement that earned it, because "well done" with no
 * evidence is the noise this whole file exists to avoid.
 */
export function praiseGuidance(praise: Praise): Guidance {
  const text = `${praise.line} ${praise.detail}`;
  return {
    speech: praise.line,
    overlay: toOverlay(praise.overlay),
    // Clipped like every other channel. `detail` quotes a deficit instruction, and those are
    // written to be complete rather than short.
    text: text.length <= TEXT_MAX_CHARS ? text : `${text.slice(0, TEXT_MAX_CHARS - 1).trimEnd()}…`,
    source: 'local',
    tone: 'praise',
  };
}
