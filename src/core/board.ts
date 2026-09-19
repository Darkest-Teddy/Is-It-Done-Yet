/**
 * What is actually on the board right now, aggregated per ingredient.
 *
 * This is the observation half of the system: `diff` compares a `BoardState` against a
 * `Recipe` and everything the cook is told follows from that one comparison.
 *
 * `Piece` is declared here rather than imported from `src/vision` on purpose. The core must
 * stay runnable without OpenCV -- every test below builds pieces by hand -- and the dependency
 * direction in this repo already runs vision -> core, never the reverse. The vision layer
 * adapts its `Blob` into this shape at the boundary.
 */

export interface PointPx {
  readonly x: number;
  readonly y: number;
}

/** One identified item on the board. The vision layer produces these from segmented blobs. */
export interface Piece {
  /** Matches an `IngredientProfile.name`. */
  readonly ingredient: string;
  /** 0..1 similarity from `identify`. Not a probability. */
  readonly confidence: number;
  readonly areaPx: number;
  readonly centroid: PointPx;
  /** Shorter side of the blob's oriented rect -- for a slice, this is its thickness. */
  readonly minorPx: number;
}

export interface IngredientTally {
  readonly ingredient: string;
  readonly count: number;
  readonly areaPx: number;
  /** Fraction of all food area on the board, 0..1. */
  readonly areaShare: number;
  /** Null when no calibration was supplied -- never silently zero. */
  readonly meanThicknessMm: number | null;
  /**
   * Coefficient of variation of thickness, as a percent. This is the uniformity number.
   *
   * A CV rather than a standard deviation because unevenness is proportional: 1mm of scatter
   * is sloppy on a 2mm julienne and invisible on a 20mm wedge. Null below two pieces, where
   * spread is not a meaningful quantity rather than being zero.
   */
  readonly thicknessCvPct: number | null;
  readonly centroid: PointPx;
  /** RMS distance of this ingredient's pieces from their own centroid. */
  readonly spreadPx: number;
}

export interface BoardState {
  readonly tallies: readonly IngredientTally[];
  readonly totalAreaPx: number;
  readonly pieceCount: number;
  /** RMS distance of every piece from the board centroid. The yardstick for mixing. */
  readonly spreadPx: number;
}

/**
 * Pieces below this confidence are dropped before tallying.
 *
 * `identify` already refuses to name a blob whose top two candidates are close, so anything
 * arriving here is unambiguous; this is a second floor against a confident-but-weak match on
 * a shadow. TUNED, not sourced.
 */
export const MIN_PIECE_CONFIDENCE = 0.35;

const mean = (xs: readonly number[]): number =>
  xs.reduce((a, b) => a + b, 0) / xs.length;

/** RMS distance from a point. Zero for a single item, which is correct -- it has no spread. */
function rmsDistance(points: readonly PointPx[], from: PointPx): number {
  if (points.length === 0) return 0;
  const sq = points.reduce((acc, p) => {
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    return acc + dx * dx + dy * dy;
  }, 0);
  return Math.sqrt(sq / points.length);
}

function centroidOf(points: readonly PointPx[]): PointPx {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: mean(points.map((p) => p.x)),
    y: mean(points.map((p) => p.y)),
  };
}

/**
 * Aggregates identified pieces into a per-ingredient view of the board.
 *
 * @param pxPerMm Calibration from the board's known width. Null when uncalibrated, which makes
 *   every thickness null rather than reporting pixels as though they were millimetres. A
 *   thickness silently in the wrong unit is the failure this repo has already been bitten by
 *   once (see DECISIONS.md entry 5), so it is made unrepresentable instead.
 */
export function boardState(
  pieces: readonly Piece[],
  pxPerMm: number | null = null,
  minConfidence: number = MIN_PIECE_CONFIDENCE,
): BoardState {
  const kept = pieces.filter((p) => p.confidence >= minConfidence && p.areaPx > 0);
  const totalAreaPx = kept.reduce((a, p) => a + p.areaPx, 0);

  const byIngredient = new Map<string, Piece[]>();
  for (const p of kept) {
    const list = byIngredient.get(p.ingredient);
    if (list === undefined) byIngredient.set(p.ingredient, [p]);
    else list.push(p);
  }

  const tallies: IngredientTally[] = [];
  for (const [ingredient, group] of byIngredient) {
    const areaPx = group.reduce((a, p) => a + p.areaPx, 0);
    const points = group.map((p) => p.centroid);
    const centroid = centroidOf(points);

    const thicknesses =
      pxPerMm === null || pxPerMm <= 0 ? [] : group.map((p) => p.minorPx / pxPerMm);
    const meanThicknessMm = thicknesses.length === 0 ? null : mean(thicknesses);

    let thicknessCvPct: number | null = null;
    if (thicknesses.length >= 2 && meanThicknessMm !== null && meanThicknessMm > 0) {
      const variance = mean(thicknesses.map((t) => (t - meanThicknessMm) ** 2));
      thicknessCvPct = (Math.sqrt(variance) / meanThicknessMm) * 100;
    }

    tallies.push({
      ingredient,
      count: group.length,
      areaPx,
      areaShare: totalAreaPx === 0 ? 0 : areaPx / totalAreaPx,
      meanThicknessMm,
      thicknessCvPct,
      centroid,
      spreadPx: rmsDistance(points, centroid),
    });
  }

  tallies.sort((a, b) => b.areaPx - a.areaPx);

  const allPoints = kept.map((p) => p.centroid);
  return {
    tallies,
    totalAreaPx,
    pieceCount: kept.length,
    spreadPx: rmsDistance(allPoints, centroidOf(allPoints)),
  };
}

export function tallyFor(state: BoardState, ingredient: string): IngredientTally | null {
  return state.tallies.find((t) => t.ingredient === ingredient) ?? null;
}
