/**
 * Pixels to millimetres.
 *
 * The one primitive the repo was missing. Everything upstream of here -- segmentation, contours,
 * oriented rectangles -- speaks in pixels, and every number a judge can check speaks in
 * millimetres. Nothing converted between the two, so no real measurement existed.
 *
 * Uncalibrated is represented as `null` rather than as a default scale, for the same reason
 * `metrics.ts` leaves an unmeasured angle `undefined` instead of zero: a made-up scale produces
 * a confident wrong millimetre figure, and a wrong millimetre figure is exactly the failure a
 * judge with a ruler finds in the first ten seconds.
 */

export interface Calibration {
  readonly mmPerPx: number;
  /** Kept so the panel can say what it was calibrated against, not just what it concluded. */
  readonly referenceMm: number;
  readonly referencePx: number;
}

/** `null` means nobody has calibrated yet. It is not a scale of 1. */
export type Scale = Calibration | null;

/**
 * Builds a calibration from a reference of known length.
 *
 * Returns null rather than throwing on nonsense input. A stray double-click produces a
 * two-pixel reference, and a 0.5mm/px scale derived from it would silently multiply every
 * later reading by twenty.
 */
export function calibrate(referencePx: number, referenceMm: number): Calibration | null {
  if (!Number.isFinite(referencePx) || !Number.isFinite(referenceMm)) return null;
  if (referencePx < MIN_REFERENCE_PX || referenceMm <= 0) return null;
  return { mmPerPx: referenceMm / referencePx, referenceMm, referencePx };
}

/**
 * A reference shorter than this is treated as a misclick.
 *
 * TUNED, not sourced. At 1280x720 a credit card's long edge across a board-filling frame is
 * several hundred pixels, so 20 rejects only accidents.
 */
export const MIN_REFERENCE_PX = 20;

/** Null when uncalibrated or when the input is not a finite pixel count. */
export function pxToMm(scale: Scale, px: number): number | null {
  if (scale === null || !Number.isFinite(px)) return null;
  return px * scale.mmPerPx;
}

/**
 * Areas scale with the SQUARE of a length scale.
 *
 * Separate from `pxToMm` because reaching for the linear conversion on an area is a mistake that
 * does not look like one -- it returns a plausible number in plausible units and is wrong by a
 * factor of a few hundred.
 */
export function areaPxToMm2(scale: Scale, areaPx: number): number | null {
  if (scale === null || !Number.isFinite(areaPx)) return null;
  return areaPx * scale.mmPerPx * scale.mmPerPx;
}

/**
 * Scale taken from something of known size that is IN the frame, every frame.
 *
 * The cucumber's diameter is the reference this project actually has: constant while the length
 * is not, visible in the same blob at the same depth as the thing being measured, and free.
 * Where a stored calibration goes stale the moment the stand is bumped, this one re-derives
 * itself and cannot.
 *
 * The residual is that a cucumber tapers, so the diameter at the cut face drifts a few percent
 * over the length of a session. That is a slow bias of known sign, which is a much better thing
 * to own than the silent step change a knocked tripod puts into a stored number.
 */
export function scaleFromDiameter(diameterPx: number, knownDiameterMm: number): Calibration | null {
  return calibrate(diameterPx, knownDiameterMm);
}

/**
 * Ratio between two scales, for showing that they still agree.
 *
 * Calibrating once with a ruler AND deriving the scale in-scene every frame gives two numbers
 * that should track each other. Displaying the ratio turns "the stand got knocked" from an
 * invisible corruption of every later measurement into a number drifting off 1.00 on screen.
 */
export function agreement(a: Scale, b: Scale): number | null {
  if (a === null || b === null || b.mmPerPx === 0) return null;
  return a.mmPerPx / b.mmPerPx;
}

/** Distance between two pixel points. Used by the two-click calibration gesture. */
export function distancePx(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
