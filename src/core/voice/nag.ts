/**
 * When the chef is allowed to interrupt, and -- far more of this file -- when it is not.
 *
 * The detection half of unprompted coaching already exists and is not rebuilt here.
 * `deficit.ts` decides what is wrong, `kitchen.ts` adds the faults no camera could see, and
 * `timeline.ts` decides what has *persisted*. What is missing is the judgement about whether a
 * true observation is worth saying out loud right now, and that judgement is the entire
 * difference between a coach and a smoke alarm.
 *
 * FOUR RULES, AND EVERY ONE OF THEM IS A REFUSAL.
 *
 * **Persisted, not seen.** A deficit present in one frame is segmentation noise; a deficit
 * present for three seconds is a fact about the kitchen. `timeline.ts` already tracks exactly
 * that, so this reads its spans rather than inventing a second debouncer -- two debouncers
 * disagreeing about whether something is happening is a bug nobody ever finds.
 *
 * **One thing at a time.** `topDeficit` already argues that telling someone their onion is 1mm
 * thick while they have forgotten the tomato is useless. The same holds harder when nobody
 * asked: an unprompted list is not advice, it is noise with punctuation.
 *
 * **Never the same correction twice while they are working on it.** A cook who has been told
 * to add salt and is reaching for the salt does not need to be told again in four seconds. The
 * deficit is still open -- that is what being mid-fix looks like -- so repeating on "still
 * open" would produce a chef that talks continuously until the moment the problem goes away.
 *
 * **Silence beats a false accusation.** `observationConfidence` in `guidance.ts` holds the
 * argument; this file holds the gate. Below the threshold nothing is said at all, because
 * being told you made a mistake you did not make does not cost one correction, it costs every
 * correction after it.
 *
 * Pure. No clock, no state of its own: `nowMs` and the `NagState` both come in, and a new state
 * goes out. Which means the whole nagging policy is provable from a terminal against a list of
 * timestamps, and a demo that talks too much can be diagnosed from a test rather than from a
 * headset.
 */

export type NagSeverity = 'blocking' | 'major' | 'minor';

/**
 * Below this, nothing measured is quoted back as fact and nothing is ever said unprompted.
 *
 * Lives here rather than in `guidance.ts` so there is exactly one number: the gate that decides
 * whether to interrupt and the ladder that decides whether to cite a fault must agree, or the
 * chef ends up refusing to interrupt about a fault it is simultaneously happy to read aloud.
 * TUNED, not sourced -- see `observationConfidence` for how the input is built.
 */
export const MIN_CONFIDENCE_TO_ACCUSE = 0.55;

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  blocking: 0,
  major: 1,
  minor: 2,
};

/**
 * One open problem, in the shape `timeline.ts` already produces.
 *
 * Structural rather than an import of `DeficitSpan` so this file stays usable against the
 * `kitchen.ts` fault list too, and so a test can build one by hand in three lines.
 */
export interface OpenFault {
  readonly kind: string;
  readonly ingredient: string | null;
  readonly instruction: string;
  readonly severity: string;
  readonly firstSeenMs: number;
  /** Null while still present. A cleared fault is never interrupted about. */
  readonly clearedMs: number | null;
}

export interface NagPolicy {
  /** How long a fault must have stood before it is worth interrupting over. */
  readonly minPersistenceMs: number;
  /** Minimum gap between any two interruptions, whatever they are about. */
  readonly cooldownMs: number;
  /** How long before the SAME correction may be repeated. */
  readonly repeatAfterMs: number;
  /** Nothing less severe than this is ever spoken unprompted. */
  readonly minSeverity: NagSeverity;
  /**
   * Hard ceiling on unprompted interruptions per session.
   *
   * A backstop against a pathological board -- bad lighting producing a rotating cast of
   * plausible faults, each one new, each one passing every other rule. Without a ceiling that
   * is a chef that talks for ninety seconds straight and a judge who takes the headset off.
   */
  readonly maxPerSession: number;
}

/**
 * Full Service, in master spec 9.5's terms: majors and blockers, spoken promptly.
 *
 * Every number here is TUNED, not sourced. They were chosen so that a genuine mistake is
 * mentioned once within a few seconds and then left alone, which is how a good line cook
 * corrects somebody. They belong on debug sliders (rule #11) before anyone trusts them in
 * front of a judge.
 */
export const FULL_SERVICE_POLICY: NagPolicy = {
  minPersistenceMs: 3000,
  cooldownMs: 12_000,
  repeatAfterMs: 45_000,
  minSeverity: 'major',
  maxPerSession: 12,
};

/** Gentle Nonna: only things that mean the dish is not the dish, and rarely. */
export const GENTLE_POLICY: NagPolicy = {
  minPersistenceMs: 6000,
  cooldownMs: 30_000,
  repeatAfterMs: 90_000,
  minSeverity: 'blocking',
  maxPerSession: 5,
};

export const DEFAULT_NAG_POLICY: NagPolicy = FULL_SERVICE_POLICY;

/**
 * Master spec 9.5's intensity slider, applied to interruptions rather than to vocabulary.
 *
 * Making the slider change *how often the chef speaks* and not merely *how rudely* is what
 * turns it from a joke control into the accessibility feature the spec claims it is. Somebody
 * who finds an interrupting assistant stressful has a real setting here, and the cook can turn
 * it off entirely -- see `mutedPolicy`.
 */
export function policyForIntensity(intensity: number): NagPolicy {
  const t = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
  const lerp = (a: number, b: number): number => Math.round(a + (b - a) * t);
  return {
    minPersistenceMs: lerp(GENTLE_POLICY.minPersistenceMs, FULL_SERVICE_POLICY.minPersistenceMs),
    cooldownMs: lerp(GENTLE_POLICY.cooldownMs, FULL_SERVICE_POLICY.cooldownMs),
    repeatAfterMs: lerp(GENTLE_POLICY.repeatAfterMs, FULL_SERVICE_POLICY.repeatAfterMs),
    minSeverity: t >= 0.5 ? 'major' : 'blocking',
    maxPerSession: lerp(GENTLE_POLICY.maxPerSession, FULL_SERVICE_POLICY.maxPerSession),
  };
}

/** The off switch, as a policy rather than as a branch the caller has to remember. */
export const mutedPolicy = (): NagPolicy => ({ ...GENTLE_POLICY, maxPerSession: 0 });

export interface NagState {
  /** Last time each fault key was spoken about. Keyed as `kind:ingredient`. */
  readonly spokenAtMs: Readonly<Record<string, number>>;
  /** Last interruption of any kind. Null before the first one. */
  readonly lastAtMs: number | null;
  readonly count: number;
}

export const emptyNag = (): NagState => ({ spokenAtMs: {}, lastAtMs: null, count: 0 });

export interface Interruption {
  readonly key: string;
  readonly instruction: string;
  readonly severity: string;
  readonly firstSeenMs: number;
}

/**
 * Two faults are the same correction if they are the same kind about the same ingredient.
 *
 * Identical to `timeline.deficitKey` and deliberately so -- the measured value is excluded, so
 * a cucumber drifting from 8mm to 7mm while the cook works on it is one correction being acted
 * on rather than a fresh thing to shout about.
 */
export const faultKey = (fault: {
  readonly kind: string;
  readonly ingredient: string | null;
}): string => `${fault.kind}:${fault.ingredient ?? ''}`;

/**
 * The one thing worth interrupting about right now, or null -- which is the usual answer.
 *
 * @param confidence from `observationConfidence`. Below `minConfidence` this returns null
 *   without looking at the faults at all, because at that point the fault list is a description
 *   of a frame nobody can vouch for.
 */
export function nextInterruption(
  faults: readonly OpenFault[],
  state: NagState,
  nowMs: number,
  confidence: number,
  policy: NagPolicy = DEFAULT_NAG_POLICY,
  minConfidence = MIN_CONFIDENCE_TO_ACCUSE,
): Interruption | null {
  if (!(confidence >= minConfidence)) return null;
  if (state.count >= policy.maxPerSession) return null;
  if (state.lastAtMs !== null && nowMs - state.lastAtMs < policy.cooldownMs) return null;

  const floor = SEVERITY_RANK[policy.minSeverity] ?? 1;
  const open = faults
    .filter(
      (fault) =>
        fault.clearedMs === null
        && (SEVERITY_RANK[fault.severity] ?? Number.MAX_SAFE_INTEGER) <= floor
        && nowMs - fault.firstSeenMs >= policy.minPersistenceMs,
    )
    .sort((a, b) => {
      const bySeverity =
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      // Oldest first within a severity: the thing that has been wrong longest is the thing
      // they are least likely to be already fixing.
      return bySeverity !== 0 ? bySeverity : a.firstSeenMs - b.firstSeenMs;
    });

  for (const fault of open) {
    const key = faultKey(fault);
    const last = state.spokenAtMs[key];
    if (last !== undefined && nowMs - last < policy.repeatAfterMs) continue;
    return {
      key,
      instruction: fault.instruction,
      severity: fault.severity,
      firstSeenMs: fault.firstSeenMs,
    };
  }
  return null;
}

/** Folds a spoken interruption into the state. Pure; returns a new state. */
export function recordInterruption(
  state: NagState,
  interruption: Interruption,
  nowMs: number,
): NagState {
  return {
    spokenAtMs: { ...state.spokenAtMs, [interruption.key]: nowMs },
    lastAtMs: nowMs,
    count: state.count + 1,
  };
}
