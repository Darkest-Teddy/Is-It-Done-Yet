import type { CutRecord } from './metrics.js';

export interface ScoringOptions {
  readonly targetThicknessMm: number;
  readonly toleranceMm: number;
  readonly targetSigmaMm: number;
  readonly angleToleranceDeg: number;
}

export interface Score {
  readonly meanMm: number;
  readonly sigmaMm: number;
  /** Null when no slice in the session carried a measured angle. */
  readonly meanAngleDeg: number | null;
  readonly accuracy: number;
  readonly uniformity: number;
  /** Null for the same reason as `meanAngleDeg`; the weight is redistributed, not defaulted. */
  readonly angleScore: number | null;
  readonly total: number;
  readonly count: number;
}

const ZERO: Score = {
  meanMm: 0, sigmaMm: 0, meanAngleDeg: null,
  accuracy: 0, uniformity: 0, angleScore: null, total: 0, count: 0,
};

/** Master spec 7.4. DECISIONS entry 2 defines angleScore as an exponential falloff. */
const W_ACCURACY = 0.5;
const W_UNIFORMITY = 0.35;
const W_ANGLE = 0.15;

export function scoreSession(records: readonly CutRecord[], opts: ScoringOptions): Score {
  const n = records.length;
  if (n === 0) return ZERO;

  const meanMm = records.reduce((a, r) => a + r.thicknessMm, 0) / n;
  const variance = records.reduce((a, r) => a + (r.thicknessMm - meanMm) ** 2, 0) / n;
  const sigmaMm = Math.sqrt(variance);

  const accuracy = Math.exp(-Math.abs(meanMm - opts.targetThicknessMm) / opts.toleranceMm);
  const uniformity = Math.exp(-sigmaMm / opts.targetSigmaMm);

  // Averaged over the slices that actually carry an angle, never over all of them. Treating an
  // unmeasured angle as zero would score a slice the camera could not judge as a perfect
  // square cut, and it would do so silently.
  const angles = records
    .map((r) => r.angleDeviationDeg)
    .filter((a): a is number => a !== undefined);

  if (angles.length === 0) {
    // No angle anywhere in the session, so there is no angle term to weigh. Renormalising the
    // two surviving weights keeps `total` on the same 0..1 scale as a session that has angles --
    // otherwise an angle-blind session could never exceed 0.85 and would look worse than it was.
    const scale = W_ACCURACY + W_UNIFORMITY;
    return {
      meanMm, sigmaMm, meanAngleDeg: null, accuracy, uniformity, angleScore: null,
      total: (W_ACCURACY * accuracy + W_UNIFORMITY * uniformity) / scale,
      count: n,
    };
  }

  const meanAngleDeg = angles.reduce((a, b) => a + b, 0) / angles.length;
  const angleScore = Math.exp(-meanAngleDeg / opts.angleToleranceDeg);

  return {
    meanMm, sigmaMm, meanAngleDeg, accuracy, uniformity, angleScore,
    total: W_ACCURACY * accuracy + W_UNIFORMITY * uniformity + W_ANGLE * angleScore,
    count: n,
  };
}

const trim = (x: number, places: number): string =>
  Number.parseFloat(x.toFixed(places)).toString();

/**
 * Master spec 7.4: "Display plain numbers. A judge parses that in one second.
 * 'Score: 72/100' tells them nothing."
 */
export function formatScore(score: Score, opts: ScoringOptions): string {
  if (score.count === 0) return 'No cuts yet.';
  return (
    `${score.meanMm.toFixed(1)}mm average, ±${score.sigmaMm.toFixed(1)}mm. ` +
    `Target ${trim(opts.targetThicknessMm, 1)}mm, ±${trim(opts.toleranceMm, 1)}mm.`
  );
}
