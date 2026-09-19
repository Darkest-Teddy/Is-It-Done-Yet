/**
 * The gap between the board in front of you and the recipe you are cooking.
 *
 * A `Deficit` is one specific, actionable thing that is wrong right now. This is the spine of
 * the whole system: the live coach renders the most severe deficit, and the end-of-session
 * report is the same deficits with timestamps. Building the summary as a second, separate
 * analysis would let the two disagree -- and a report that contradicts what the cook was told
 * while cooking destroys trust in both.
 *
 * `diff` is pure and total: same board and recipe in, same list out, no clock and no I/O.
 */

import type { BoardState, IngredientTally } from './board.js';
import { tallyFor } from './board.js';
import type { Range } from './ingredients.js';
import type { Recipe } from './recipe.js';

export type DeficitKind =
  | 'ingredient-missing'
  | 'count-short'
  | 'count-excess'
  | 'proportion-low'
  | 'proportion-high'
  | 'cut-too-thick'
  | 'cut-too-thin'
  | 'cut-uneven'
  | 'unmixed'
  | 'unexpected-ingredient'
  | 'needs-confirmation'
  // Produced by `kitchen.ts` from the action log rather than from measurement. These are facts
  // about what the cook did, not inferences from pixels -- a virtual pinch of salt is counted,
  // where a real one was invisible to any camera. Several of these (tasting, drying, dressing
  // early) are the faults that most often ruin a dish AND are exactly the ones no camera could
  // ever have caught, which is the argument for the virtual model in one line.
  | 'seasoning-low'
  | 'seasoning-high'
  | 'unwashed'
  | 'wet-greens'
  | 'overcrowded'
  | 'under-dressed'
  | 'over-dressed'
  | 'dressed-too-early'
  | 'delicate-crushed'
  | 'under-mixed'
  | 'over-mixed'
  | 'wrong-order'
  | 'not-tasted'
  | 'under-rested'
  | 'over-rested'
  | 'served-late';

/**
 * `blocking` means the dish is not the dish -- an ingredient simply is not there.
 * `major` is present but wrong enough to taste. `minor` is craft.
 *
 * The ranking exists because the live coach shows exactly one message. Telling someone their
 * onion is 1mm thick while they have forgotten the tomato entirely is technically true and
 * completely useless.
 */
export type Severity = 'blocking' | 'major' | 'minor';

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, major: 1, minor: 2 };

export interface Deficit {
  readonly kind: DeficitKind;
  /** Null for whole-board deficits and for confirmation prompts. */
  readonly ingredient: string | null;
  /** What we measured. Null when the deficit is not numeric. */
  readonly observed: number | null;
  /** What the recipe asked for. Null when the deficit is not numeric. */
  readonly required: Range | null;
  readonly severity: Severity;
  /** How far out of range, as a fraction of the bound missed. Sorts within a severity. */
  readonly magnitude: number;
  /** What the cook should physically do about it. Rendered verbatim. */
  readonly instruction: string;
}

export interface DiffOptions {
  /** Step ids the cook has confirmed. Steps that vision cannot check live here. */
  readonly confirmedSteps: ReadonlySet<string>;
  /**
   * Thickness scatter above this is called out as uneven. A coefficient of variation, percent.
   * TUNED, not sourced -- 25% was where hand-cut slices started looking careless rather than
   * handmade, and it wants re-checking against real boards.
   */
  readonly maxThicknessCvPct: number;
  /** Below this many pieces, spread is too noisy to judge mixing from. */
  readonly minPiecesForMixCheck: number;
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  confirmedSteps: new Set(),
  maxThicknessCvPct: 25,
  minPiecesForMixCheck: 3,
};

/** How far outside a range, relative to the bound that was missed. Zero when inside. */
function outByFraction(x: number, r: Range): number {
  if (x < r.min) return r.min === 0 ? r.min - x : (r.min - x) / r.min;
  if (x > r.max) return r.max === 0 ? x - r.max : (x - r.max) / r.max;
  return 0;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

const pct = (x: number): number => Math.round(x * 100);

function countDeficit(t: IngredientTally, range: Range): Deficit | null {
  if (t.count >= range.min && t.count <= range.max) return null;
  const short = t.count < range.min;
  const wanted = short ? range.min : range.max;
  const delta = short ? wanted - t.count : t.count - wanted;
  return {
    kind: short ? 'count-short' : 'count-excess',
    ingredient: t.ingredient,
    observed: t.count,
    required: range,
    severity: 'major',
    magnitude: outByFraction(t.count, range),
    instruction: short
      ? `Add ${delta} more ${t.ingredient} -- ${t.count} on the board, recipe wants ${range.min}-${range.max}`
      : `Take ${delta} ${t.ingredient} off -- ${t.count} on the board, recipe wants ${range.min}-${range.max}`,
  };
}

function proportionDeficit(t: IngredientTally, range: Range): Deficit | null {
  if (t.areaShare >= range.min && t.areaShare <= range.max) return null;
  const low = t.areaShare < range.min;
  const band = `${pct(range.min)}-${pct(range.max)}%`;
  return {
    kind: low ? 'proportion-low' : 'proportion-high',
    ingredient: t.ingredient,
    observed: t.areaShare,
    required: range,
    severity: 'major',
    magnitude: outByFraction(t.areaShare, range),
    instruction: low
      ? `More ${t.ingredient} -- it is ${pct(t.areaShare)}% of the bowl, should be ${band}`
      : `Less ${t.ingredient} -- it is ${pct(t.areaShare)}% of the bowl, should be ${band}`,
  };
}

function thicknessDeficit(t: IngredientTally, range: Range): Deficit | null {
  const mm = t.meanThicknessMm;
  if (mm === null) return null;
  if (mm >= range.min && mm <= range.max) return null;
  const thick = mm > range.max;
  const direction = thick ? 'thinner' : 'thicker';
  return {
    kind: thick ? 'cut-too-thick' : 'cut-too-thin',
    ingredient: t.ingredient,
    observed: mm,
    required: range,
    severity: 'minor',
    magnitude: outByFraction(mm, range),
    instruction: `${t.ingredient} is cut at ${round1(mm)}mm -- recipe wants ${range.min}-${range.max}mm, cut ${direction}`,
  };
}

function evennessDeficit(t: IngredientTally, maxCvPct: number): Deficit | null {
  const cv = t.thicknessCvPct;
  if (cv === null || cv <= maxCvPct) return null;
  return {
    kind: 'cut-uneven',
    ingredient: t.ingredient,
    observed: cv,
    required: { min: 0, max: maxCvPct },
    severity: 'minor',
    magnitude: outByFraction(cv, { min: 0, max: maxCvPct }),
    instruction: `Your ${t.ingredient} slices vary by ${Math.round(cv)}% -- keep the blade at a steady thickness`,
  };
}

/**
 * Mixing, judged as an ingredient's spread relative to the board's own spread.
 *
 * An absolute distance would be wrong: the same salad in a dinner plate and in a mixing bowl
 * has the same mixing and wildly different pixel spreads. The ratio is scale-free and needs no
 * calibration, which also means it survives the camera being moved mid-demo.
 *
 * Returns null below `minPiecesForMixCheck`, where the spread of two or three blobs is noise
 * rather than a fact about how well the salad was tossed.
 */
function mixDeficit(t: IngredientTally, board: BoardState, opts: DiffOptions, minRatio: number): Deficit | null {
  if (t.count < opts.minPiecesForMixCheck) return null;
  if (board.spreadPx <= 0) return null;

  const ratio = t.spreadPx / board.spreadPx;
  if (ratio >= minRatio) return null;

  return {
    kind: 'unmixed',
    ingredient: t.ingredient,
    observed: ratio,
    required: { min: minRatio, max: 1 },
    severity: 'minor',
    magnitude: minRatio - ratio,
    instruction: `The ${t.ingredient} is all in one place -- toss it through`,
  };
}

export function diff(
  state: BoardState,
  recipe: Recipe,
  opts: DiffOptions = DEFAULT_DIFF_OPTIONS,
): readonly Deficit[] {
  const found: Deficit[] = [];

  for (const req of recipe.requires) {
    const t = tallyFor(state, req.ingredient);

    // A missing ingredient short-circuits every other check on it. Reporting that the cucumber
    // is also too thin when there is no cucumber would be noise generated from an empty tally.
    if (t === null || t.count === 0) {
      found.push({
        kind: 'ingredient-missing',
        ingredient: req.ingredient,
        observed: 0,
        required: req.count ?? null,
        severity: 'blocking',
        magnitude: 1,
        instruction: `No ${req.ingredient} on the board -- the recipe needs it`,
      });
      continue;
    }

    const checks = [
      req.count === undefined ? null : countDeficit(t, req.count),
      req.areaShare === undefined ? null : proportionDeficit(t, req.areaShare),
      req.thicknessMm === undefined ? null : thicknessDeficit(t, req.thicknessMm),
      evennessDeficit(t, opts.maxThicknessCvPct),
      mixDeficit(t, state, opts, recipe.minMixRatio),
    ];
    for (const d of checks) if (d !== null) found.push(d);
  }

  // Anything on the board the recipe never asked for. Minor by design: a cook adding feta to a
  // Greek salad is not making a mistake, and shouting about it would make the coach feel like a
  // rules engine rather than a teacher.
  const required = new Set(recipe.requires.map((r) => r.ingredient));
  for (const t of state.tallies) {
    if (required.has(t.ingredient)) continue;
    found.push({
      kind: 'unexpected-ingredient',
      ingredient: t.ingredient,
      observed: t.count,
      required: null,
      severity: 'minor',
      magnitude: t.areaShare,
      instruction: `${t.count} ${t.ingredient} on the board that this recipe does not call for`,
    });
  }

  // Steps no camera can check. Surfaced rather than assumed done, and phrased so the cook knows
  // the system is not pretending to see something it cannot.
  for (const step of recipe.steps) {
    if (step.verifiable !== 'cook-confirmed') continue;
    if (opts.confirmedSteps.has(step.id)) continue;
    found.push({
      kind: 'needs-confirmation',
      ingredient: null,
      observed: null,
      required: null,
      severity: 'minor',
      magnitude: 0,
      instruction: `I cannot see this one: ${step.instruction}. Confirm when done.`,
    });
  }

  return found.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : b.magnitude - a.magnitude;
  });
}

/** The single thing worth saying out loud right now, or null when the board is correct. */
export function topDeficit(deficits: readonly Deficit[]): Deficit | null {
  return deficits[0] ?? null;
}

/** A board with no blocking or major deficits is servable, craft notes aside. */
export function isServable(deficits: readonly Deficit[]): boolean {
  return !deficits.some((d) => d.severity === 'blocking' || d.severity === 'major');
}
