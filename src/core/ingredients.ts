/**
 * Ingredient identification from colour and shape.
 *
 * Deliberately classical: an HSV hue window plus two shape ratios, no model and no network.
 * A cucumber on a light board is one of the easiest segmentation problems there is, and a
 * 30fps local answer beats a 1Hz cloud one for anything the overlay has to track.
 *
 * Hue lives in DEGREES [0, 360) here. OpenCV packs 8-bit hue into [0, 179], so the adapter in
 * src/vision doubles it at the boundary. Keeping the domain model in real degrees means the
 * numbers below can be checked against a colour picker instead of against OpenCV's convention.
 */

/** Feature vector for one segmented blob. Everything here is unitless or in degrees. */
export interface ShapeFeatures {
  /** Dominant hue of the blob, degrees [0, 360). */
  readonly hueDeg: number;
  /** 0..1 */
  readonly saturation: number;
  /** 0..1 */
  readonly value: number;
  /** Major axis / minor axis of the minimum-area rectangle. 1.0 is square-ish. */
  readonly elongation: number;
  /** contourArea / convexHullArea. Smooth convex produce sits above ~0.93. */
  readonly solidity: number;
  /** 4*pi*area / perimeter^2. A perfect circle is 1.0. */
  readonly circularity: number;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface IngredientProfile {
  readonly name: string;
  /** Centre of the hue window, degrees. May sit anywhere in [0, 360). */
  readonly hueCentreDeg: number;
  /** Half-width of the hue window, degrees. Scores fall off smoothly past it. */
  readonly hueToleranceDeg: number;
  /** Below this the blob is too washed out to trust the hue at all. */
  readonly minSaturation: number;
  readonly elongation: Range;
  readonly minSolidity: number;
}

/**
 * TUNED, not sourced. These came from colour-picking ripe supermarket produce under mixed
 * daylight, and they are the single thing most likely to need adjusting at the venue -- hall
 * lighting is usually a green-heavy fluorescent that shifts every hue window a few degrees.
 * Re-check them on site with a live histogram before trusting any of it.
 */
export const PROFILES: readonly IngredientProfile[] = [
  {
    name: 'cucumber',
    // The window has to hold the stub for the WHOLE session, and a stub gets shorter while its
    // diameter does not. At 42mm diameter the old 2.6 floor stopped matching once the stub fell
    // below 109mm -- about nine 8mm cuts into a 180mm cucumber -- so tracking died partway
    // through the demo and looked like a vision failure. 1.6 holds it down to 67mm. The 20
    // ceiling is for slices seen edge-on, which are 42/t:1 and clear the old 12 under 3.5mm.
    hueCentreDeg: 95, hueToleranceDeg: 25, minSaturation: 0.25,
    elongation: { min: 1.6, max: 20 }, minSolidity: 0.9,
  },
  {
    name: 'tomato',
    // Ripe red sits either side of 0, which is exactly the case a naive min/max window breaks on.
    hueCentreDeg: 2, hueToleranceDeg: 14, minSaturation: 0.45,
    elongation: { min: 1, max: 1.4 }, minSolidity: 0.93,
  },
  {
    name: 'orange',
    hueCentreDeg: 28, hueToleranceDeg: 12, minSaturation: 0.5,
    elongation: { min: 1, max: 1.3 }, minSolidity: 0.93,
  },
  {
    name: 'carrot',
    // Overlaps orange in hue almost entirely; elongation is what separates them.
    hueCentreDeg: 24, hueToleranceDeg: 14, minSaturation: 0.5,
    elongation: { min: 3, max: 12 }, minSolidity: 0.88,
  },
  {
    name: 'lemon',
    hueCentreDeg: 54, hueToleranceDeg: 12, minSaturation: 0.45,
    elongation: { min: 1.1, max: 1.8 }, minSolidity: 0.93,
  },
  {
    name: 'red onion',
    hueCentreDeg: 300, hueToleranceDeg: 30, minSaturation: 0.2,
    elongation: { min: 1, max: 1.5 }, minSolidity: 0.9,
  },
];

/**
 * Shortest angular distance between two hues, in degrees, always in [0, 180].
 *
 * Hue is a circle, so red at 358 and red at 4 are six degrees apart, not 354. A plain
 * `Math.abs(a - b)` -- or a `min <= h && h <= max` window -- splits ripe tomato straight down
 * the middle and classifies half of every tomato as nothing at all.
 */
export function hueDistanceDeg(a: number, b: number): number {
  const raw = Math.abs(((a % 360) + 360) % 360 - (((b % 360) + 360) % 360));
  return Math.min(raw, 360 - raw);
}

export interface Candidate {
  readonly name: string;
  /** 0..1. Not a probability -- a similarity, and it does not sum to one across candidates. */
  readonly confidence: number;
}

/** Smooth falloff: 1.0 at the centre, ~0.37 at one tolerance out, asymptotic to 0. */
const falloff = (distance: number, tolerance: number): number =>
  tolerance <= 0 ? (distance === 0 ? 1 : 0) : Math.exp(-distance / tolerance);

/** How far outside a range a value sits. Zero when inside. */
const excess = (x: number, r: Range): number =>
  x < r.min ? r.min - x : x > r.max ? x - r.max : 0;

export function scoreProfile(f: ShapeFeatures, p: IngredientProfile): number {
  if (!Number.isFinite(f.hueDeg) || !Number.isFinite(f.elongation)) return 0;

  // A grey blob has no meaningful hue, so scoring it against a hue window is noise. Rejecting
  // outright is honest; letting a washed-out highlight match "tomato" on a stray red pixel is not.
  if (f.saturation < p.minSaturation) return 0;
  if (f.solidity < p.minSolidity) return 0;

  const hue = falloff(hueDistanceDeg(f.hueDeg, p.hueCentreDeg), p.hueToleranceDeg);
  // Elongation is a ratio, so being 2x outside the window matters more at small values than the
  // absolute difference suggests. A quarter-unit tolerance keeps a 3.2 cucumber near a 3.0 floor.
  const shape = falloff(excess(f.elongation, p.elongation), 0.25);

  return hue * shape;
}

/**
 * Ranks every profile against one blob, best first.
 *
 * Returns all of them rather than a single winner on purpose. Carrot and orange share a hue
 * window almost exactly and are told apart only by elongation, so the runner-up's score is the
 * caller's evidence about how sure the answer really is. A bare label throws that away.
 */
export function classify(
  f: ShapeFeatures,
  profiles: readonly IngredientProfile[] = PROFILES,
): readonly Candidate[] {
  return profiles
    .map((p) => ({ name: p.name, confidence: scoreProfile(f, p) }))
    .filter((c) => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

/** The winner, but only when it is clearly ahead of the runner-up. */
export function identify(
  f: ShapeFeatures,
  minConfidence = 0.35,
  minMargin = 1.5,
  profiles: readonly IngredientProfile[] = PROFILES,
): Candidate | null {
  const ranked = classify(f, profiles);
  const best = ranked[0];
  if (best === undefined || best.confidence < minConfidence) return null;

  const runnerUp = ranked[1];
  // Two near-tied candidates mean the features genuinely do not separate them. Naming one
  // anyway produces a label that flickers between them frame to frame, which reads to a player
  // as the system being broken rather than as the system being unsure.
  if (runnerUp !== undefined && best.confidence < runnerUp.confidence * minMargin) return null;

  return best;
}
