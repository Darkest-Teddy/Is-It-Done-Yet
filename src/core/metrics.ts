/**
 * Slice measurements as they arrive from the camera.
 *
 * The previous version of this module derived thickness from an analytic cut plane against a
 * virtual lathe solid. That is gone: the food is real now, so thickness is *observed*, not
 * computed, and every number here carries the error characteristics of the method that produced
 * it rather than the exactness of arithmetic.
 */

/**
 * How a slice's thickness was obtained. These are not interchangeable.
 *
 * `side-profile` measures the disc's height directly from a camera at board level. It is the
 * true perpendicular thickness and it needs no inference.
 *
 * `stub-delta` infers thickness from how much shorter the uncut stub became between two frames.
 * An overhead camera can only ever produce this one, because a slice lying flat shows its
 * DIAMETER to a camera above it, never its height. It is also an AXIAL delta: for a slanted cut
 * the true thickness is smaller by cos(angle), which a silhouette cannot recover.
 */
export type MeasurementMethod = 'side-profile' | 'stub-delta';

export interface SliceMeasurement {
  readonly thicknessMm: number;
  readonly method: MeasurementMethod;
  /** 0..1 from the vision layer. Low-confidence slices are still recorded, but flagged. */
  readonly confidence: number;
  /**
   * Slant of the cut face away from perpendicular, when the side view can resolve it.
   *
   * Absent rather than zero when unmeasured. Defaulting it to zero would assert a flawless
   * square cut on every slice the camera could not actually judge, which inflates the score in
   * the one direction nobody would question.
   */
  readonly angleDeviationDeg?: number;
}

export interface CutRecord extends SliceMeasurement {
  readonly index: number;
}

export interface Session {
  readonly records: readonly CutRecord[];
}

export const emptySession = (): Session => ({ records: [] });

/** Appends one measured slice to the session. */
export function recordCut(
  session: Session,
  measurement: SliceMeasurement,
): { session: Session; record: CutRecord } {
  const record: CutRecord = { ...measurement, index: session.records.length };
  return { session: { records: [...session.records, record] }, record };
}

export type CrossCheck =
  | { readonly agree: true; readonly deltaMm: number }
  | { readonly agree: false; readonly deltaMm: number; readonly reason: string };

/**
 * Compares two independent measurements of the same slice.
 *
 * With an overhead and a side camera, every slice is measured twice by methods that fail in
 * unrelated ways -- occlusion and segmentation drift for one, perspective and the cos(angle)
 * blind spot for the other. Agreement is therefore evidence; disagreement means one of them is
 * wrong and we do not yet know which.
 *
 * Reporting the disagreement is the whole point. A single camera that has lost track produces a
 * confident wrong number with no way to notice, which is exactly the failure a judge with a
 * ruler will find.
 */
export function crossCheck(
  a: SliceMeasurement,
  b: SliceMeasurement,
  toleranceMm: number,
): CrossCheck {
  const deltaMm = Math.abs(a.thicknessMm - b.thicknessMm);
  if (!Number.isFinite(deltaMm)) {
    return { agree: false, deltaMm: Number.NaN, reason: 'a measurement was not a finite number' };
  }
  if (deltaMm > toleranceMm) {
    return {
      agree: false,
      deltaMm,
      reason:
        `${a.method} says ${a.thicknessMm.toFixed(2)}mm, ` +
        `${b.method} says ${b.thicknessMm.toFixed(2)}mm`,
    };
  }
  return { agree: true, deltaMm };
}
