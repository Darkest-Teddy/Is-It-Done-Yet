import type { SliceMeasurement } from './metrics.js';

/**
 * Turns a stream of segmented blobs into cut events.
 *
 * This is the module that decides whether the demo works. Everything upstream of it is a
 * silhouette, and everything downstream is arithmetic on a number this file chose to believe.
 *
 * THE MEASUREMENT. Master spec 7.3 measures the stub rather than the slices: between two cuts
 * the uncut remainder gets shorter by exactly the thickness that came off. That is a length
 * lying in the image plane, which is the one thing a single fixed camera reads well.
 *
 * THE RULER IS IN THE PICTURE. The stub's own diameter is a physically constant quantity,
 * visible in the same blob, at the same depth, in the same frame as the length being measured.
 * Scaling by it rather than by a stored mm/px makes the measurement self-correcting: nudge the
 * cucumber toward the camera and both its length and its diameter grow by the same factor, so
 * the ratio cancels. A stored calibration cannot do that, and fails silently when the stand is
 * knocked -- which it will be.
 *
 * WHY THE DEBOUNCE IS NOT THE SAFETY RING'S. DECISIONS entry 10 argues the safety ring must
 * escalate instantly and relax slowly, because a warning that arrives late arrives after the
 * injury. A cut event has the opposite cost structure, and copying that asymmetry here would
 * invert the risk: a false cut is written into the session permanently and corrupts both the
 * mean and the sigma, while a missed cut merely fails to render. So cut detection is SLOW TO
 * CONFIRM AND CHEAP TO MISS. It settles first and asks questions afterwards.
 */

export interface TrackBlob {
  /** Longer side of the oriented rectangle, pixels. */
  readonly majorPx: number;
  /** Shorter side, pixels. */
  readonly minorPx: number;
  readonly areaPx: number;
  readonly hueDeg: number;
}

export interface TrackOptions {
  /** The cucumber's diameter, measured once with a ruler. This is the in-scene ruler's length. */
  readonly knownDiameterMm: number;
  /** Frames a reading must hold before it may be compared with the baseline. */
  readonly settleFrames: number;
  /** Spread across the settle window, above which the stub is still moving. */
  readonly settleBandMm: number;
  readonly minCutMm: number;
  readonly maxCutMm: number;
  /** Residual diameter change after normalisation, above which the stub moved rather than shrank. */
  readonly maxScaleResidual: number;
  /** How far a slice's long side may differ from the stub diameter and still count as a slice. */
  readonly sliceMajorTolerance: number;
  /** A blob squarer than this is a disc seen face-on, not edge-on. */
  readonly maxSliceAspect: number;
  readonly refractoryFrames: number;
  /** Recorded slices plus the remaining stub may exceed the original length by this factor. */
  readonly budgetSlack: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  knownDiameterMm: 42,
  settleFrames: 5,
  settleBandMm: 0.5,
  minCutMm: 1,
  maxCutMm: 25,
  maxScaleResidual: 0.03,
  sliceMajorTolerance: 0.15,
  maxSliceAspect: 0.6,
  refractoryFrames: 15,
  budgetSlack: 1.05,
};

interface Reading {
  readonly lengthPx: number;
  readonly diameterPx: number;
}

export interface TrackState {
  /** The settle window, newest last. */
  readonly window: readonly Reading[];
  /** The last reading a cut was measured against. Null until the stub first settles. */
  readonly baseline: Reading | null;
  readonly originalLengthMm: number | null;
  readonly recordedMm: number;
  readonly refractory: number;
}

/** Why a candidate change was not recorded. Null only when a cut actually was. */
export type Rejection =
  | 'no-stub'
  | 'settling'
  | 'baseline-set'
  | 'refractory'
  | 'below-threshold'
  | 'stub-moved'
  | 'implausible-thickness'
  | 'over-budget';

export interface TrackResult {
  readonly state: TrackState;
  /** The recorded cut, measured from the stub. Null on every frame that is not a cut. */
  readonly cut: SliceMeasurement | null;
  /**
   * Thickness read directly off the slices lying in frame, in millimetres.
   *
   * An independent observation of the same quantity, failing in unrelated ways, which is what
   * makes `crossCheck` in metrics.ts worth running. Null when no slice is confidently edge-on.
   */
  readonly sideProfileMm: number | null;
  readonly stubLengthMm: number | null;
  readonly sliceCount: number;
  readonly rejection: Rejection | null;
}

export const emptyTrack = (): TrackState => ({
  window: [], baseline: null, originalLengthMm: null, recordedMm: 0, refractory: 0,
});

/**
 * Median, not mean, and not an EMA.
 *
 * An EMA at alpha 0.3 needs about seven frames to reach 90% of a step, and it smears an
 * occlusion transient straight into the estimate that is about to be differenced. A median over
 * the settle window is immune to exactly the spikes being rejected: a hand crossing one end of
 * the stub for two frames out of five moves the median by nothing at all.
 */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The stub is the longest blob in frame. A slice is never longer than the cucumber it came off. */
function findStub(blobs: readonly TrackBlob[]): TrackBlob | null {
  let best: TrackBlob | null = null;
  for (const b of blobs) if (best === null || b.majorPx > best.majorPx) best = b;
  return best;
}

/**
 * Finds slices by pose rather than by classification.
 *
 * Deliberately NOT routed through `identify()`. The cucumber profile is shaped for a whole
 * cucumber and a slice fails it at both ends -- flat-on it is a disc at 1:1, and edge-on a 6mm
 * slice off a 42mm cucumber is 7:1 while a 3mm one is 14:1. The tests that actually separate the
 * poses are scale-free and need no calibration at all:
 *
 *   - a disc seen edge-on shows its DIAMETER as the long side, whatever else is true, and that
 *     diameter is the stub's own short side in the same frame at the same depth;
 *   - a disc seen face-on has both sides equal to the diameter, so an aspect near 1 is a face;
 *   - a leaning disc foreshortens its long side below the diameter and fails the first test.
 *
 * When none of them passes this returns nothing rather than a number. metrics.ts already models
 * that discipline by leaving an unmeasured angle undefined instead of defaulting it to zero.
 */
function findSlices(
  blobs: readonly TrackBlob[], stub: TrackBlob, opts: TrackOptions,
): TrackBlob[] {
  return blobs.filter((b) => {
    if (b === stub) return false;
    if (b.majorPx <= 0 || stub.minorPx <= 0) return false;
    if (b.minorPx / b.majorPx > opts.maxSliceAspect) return false;
    return Math.abs(b.majorPx / stub.minorPx - 1) <= opts.sliceMajorTolerance;
  });
}

export function observe(
  state: TrackState, blobs: readonly TrackBlob[], opts: TrackOptions = DEFAULT_TRACK_OPTIONS,
): TrackResult {
  const stub = findStub(blobs);

  // An absent stub is not evidence of anything. The window is cleared so a reading from before
  // an occlusion cannot be blended with one from after it, but the BASELINE survives: it is what
  // the next settled reading has to be compared against.
  if (stub === null) {
    return {
      state: { ...state, window: [] },
      cut: null, sideProfileMm: null, stubLengthMm: null, sliceCount: 0, rejection: 'no-stub',
    };
  }

  const window = [...state.window, { lengthPx: stub.majorPx, diameterPx: stub.minorPx }]
    .slice(-opts.settleFrames);

  const slices = findSlices(blobs, stub, opts);
  const sliceCount = slices.length;
  const mmPerPxNow = stub.minorPx > 0 ? opts.knownDiameterMm / stub.minorPx : Number.NaN;
  const sideProfileMm = sliceCount > 0
    ? median(slices.map((s) => s.minorPx * mmPerPxNow))
    : null;
  const stubLengthMm = Number.isFinite(mmPerPxNow) ? stub.majorPx * mmPerPxNow : null;

  const quiet = (rejection: Rejection, next: TrackState): TrackResult => ({
    state: next, cut: null, sideProfileMm, stubLengthMm, sliceCount, rejection,
  });

  const settled: TrackState = { ...state, window };

  // Checked before settling, so the count is frames rather than settled frames. After a cut the
  // stub is stationary and settles immediately, so a refractory measured in settled frames would
  // expire at the same moment either way -- but the whole point is to cover the interval where
  // the hand is still moving the slice away, which is exactly when frames do NOT settle.
  if (state.refractory > 0) {
    return quiet('refractory', { ...settled, refractory: state.refractory - 1 });
  }

  if (window.length < opts.settleFrames) return quiet('settling', settled);

  const lengths = window.map((r) => r.lengthPx);
  const medLength = median(lengths);
  const medDiameter = median(window.map((r) => r.diameterPx));
  if (!(medDiameter > 0)) return quiet('settling', settled);

  const spreadMm = Math.max(...lengths.map((l) => Math.abs(l - medLength)))
    * (opts.knownDiameterMm / medDiameter);
  if (!(spreadMm <= opts.settleBandMm)) return quiet('settling', settled);

  const now: Reading = { lengthPx: medLength, diameterPx: medDiameter };

  if (state.baseline === null) {
    return quiet('baseline-set', {
      ...settled,
      baseline: now,
      originalLengthMm: medLength * (opts.knownDiameterMm / medDiameter),
    });
  }

  // A real cut removes LENGTH and leaves DIAMETER alone. A nudge in depth, or a yaw off
  // perpendicular, changes both in proportion. Normalising by the diameter ratio removes the
  // second before differencing the first, which matters here because this differences a ~180mm
  // number to extract a ~6mm one: an uncorrected 1% scale drift is 1.8mm of phantom thickness.
  const scaleRatio = state.baseline.diameterPx / now.diameterPx;
  const normalisedLengthPx = now.lengthPx * scaleRatio;
  const baselineMmPerPx = opts.knownDiameterMm / state.baseline.diameterPx;
  const thicknessMm = (state.baseline.lengthPx - normalisedLengthPx) * baselineMmPerPx;

  // An INCREASE is never a cut. It is recovery from an occlusion that shortened the silhouette
  // while the baseline was being taken, so the baseline is the thing that was wrong. Raise it
  // and record nothing. This -- not the settle window -- is what makes a hand crossing the stub
  // a no-op: a hand resting still over one end produces a perfectly SETTLED short reading, which
  // settling alone would have happily called a cut.
  if (thicknessMm < 0) {
    // The original length was measured against the same bad baseline, so it is an underestimate
    // by the same amount. Leaving it behind makes the budget invariant below fire on the first
    // honest cut after the occlusion clears -- the session would refuse to record anything at
    // all, having quietly decided the cucumber was shorter than it is.
    const correctedMm = now.lengthPx * (opts.knownDiameterMm / now.diameterPx);
    return quiet('below-threshold', {
      ...settled,
      baseline: now,
      originalLengthMm: Math.max(state.originalLengthMm ?? 0, correctedMm),
    });
  }

  if (thicknessMm < opts.minCutMm) return quiet('below-threshold', settled);

  if (Math.abs(scaleRatio - 1) > opts.maxScaleResidual) return quiet('stub-moved', settled);

  // Master spec 7.3: "A mismatch means tracking failure -- flag it, do not report a wrong number."
  if (thicknessMm > opts.maxCutMm) return quiet('implausible-thickness', settled);

  const recordedMm = state.recordedMm + thicknessMm;
  const stubNowMm = now.lengthPx * (opts.knownDiameterMm / now.diameterPx);
  if (state.originalLengthMm !== null
    && recordedMm + stubNowMm > state.originalLengthMm * opts.budgetSlack) {
    return quiet('over-budget', settled);
  }

  // Corroboration lowers CONFIDENCE rather than suppressing the record. A slice that rolled out
  // of frame is not evidence that the cut did not happen, and feedback.ts already turns a
  // confidence below 0.5 into audibly hesitant feedback rather than a confident wrong answer.
  const cut: SliceMeasurement = {
    thicknessMm,
    method: 'stub-delta',
    confidence: sliceCount > 0 ? 0.9 : 0.45,
  };

  return {
    state: { ...settled, baseline: now, recordedMm, refractory: opts.refractoryFrames },
    cut,
    sideProfileMm,
    stubLengthMm,
    sliceCount,
    rejection: null,
  };
}
