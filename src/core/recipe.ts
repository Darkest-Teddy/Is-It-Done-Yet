/**
 * What a finished board is supposed to look like.
 *
 * A recipe here is not a list of prose steps -- it is a set of *measurable claims* about the
 * finished board, plus the handful of steps that no camera can check. That split is the whole
 * design. `requires` is what `diff` can verify by looking; `steps` carries the rest, and each
 * one says honestly whether it is checkable or not.
 *
 * Ingredient names must match a profile in `ingredients.ts` exactly, or the requirement can
 * never be satisfied -- the tally it looks for will never appear. `validateRecipe` exists to
 * catch that at startup rather than in front of a judge.
 */

import type { Range } from './ingredients.js';

/**
 * Whether a step can be confirmed by looking at the board.
 *
 * `cook-confirmed` is not a cop-out, it is the honest answer for a whole class of real cooking.
 * Salt has no optical signature: a correctly seasoned salad and an unseasoned one are the same
 * photograph. Guessing would produce confident feedback with nothing behind it, which is worse
 * than silence because the cook cannot tell the two apart.
 */
export type Verifiability = 'vision' | 'cook-confirmed';

/** One measurable claim about a single ingredient on the finished board. */
export interface IngredientRequirement {
  /** Must match an `IngredientProfile.name` exactly. */
  readonly ingredient: string;
  /** How many separate pieces. Omit when the count genuinely does not matter. */
  readonly count?: Range;
  /** Share of total food area, 0..1. This is what catches "too much cucumber". */
  readonly areaShare?: Range;
  /** Target piece thickness in mm, checked against the blob's minor axis. */
  readonly thicknessMm?: Range;
}

export interface RecipeStep {
  readonly id: string;
  readonly instruction: string;
  readonly verifiable: Verifiability;
  /**
   * Ingredients whose requirements this step is responsible for.
   *
   * This is what lets a `vision` step complete itself: once no deficit mentions any of these
   * ingredients, the step has demonstrably been done. Without the link a step could only ever
   * be marked done by asking, which would make the process tracker a checklist the cook drives
   * rather than something the camera drives.
   *
   * Empty for `cook-confirmed` steps, which have nothing observable to attach to.
   */
  readonly satisfies?: readonly string[];
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Recipe {
  readonly id: string;
  readonly name: string;
  /** Shown on the preview screen before the cook commits. */
  readonly description: string;
  readonly difficulty: Difficulty;
  /** Typical completion time, minutes. What the preview screen promises. */
  readonly averageMinutes: number;
  /**
   * Emoji standing in for artwork.
   *
   * Deliberately not an image asset: emoji need no loading, no atlas and no licence, they
   * render identically in a UIKitML panel and in the laptop debug view, and they survive a
   * designer never arriving. Swap for real icons later by changing this field only.
   */
  readonly icon: string;
  /** Free-text tags the search bar matches against, beyond name and ingredients. */
  readonly tags: readonly string[];
  readonly requires: readonly IngredientRequirement[];
  readonly steps: readonly RecipeStep[];
  /**
   * An ingredient whose pieces cluster more tightly than this fraction of the board's own
   * spread has not been tossed through. 1.0 would demand perfect mixing and fire constantly;
   * 0 disables the check. TUNED, not sourced -- 0.55 separated "dumped in a corner" from
   * "tossed" on a hand-placed board and wants re-checking against a real one.
   */
  readonly minMixRatio: number;
}

/**
 * Only ingredients with a tuned profile in `ingredients.ts` can appear here.
 *
 * Notably absent: lettuce. It is the obvious salad base and it is deliberately left out,
 * because adding it means inventing an untested hue window and elongation range, and a profile
 * tuned against nothing will classify half the board as lettuce. Add it by colour-picking real
 * leaves under the venue lights, not by guessing here.
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: 'greek-ish',
    name: 'Greek-ish Salad',
    description: 'Cucumber, tomato and shaved red onion, dressed simply. Forgiving, fast, and hard to get wrong.',
    difficulty: 'easy',
    averageMinutes: 10,
    icon: '🥗',
    tags: ['salad', 'mediterranean', 'no-cook', 'quick'],
    requires: [
      { ingredient: 'cucumber', count: { min: 8, max: 14 }, areaShare: { min: 0.3, max: 0.5 }, thicknessMm: { min: 4, max: 7 } },
      { ingredient: 'tomato', count: { min: 6, max: 10 }, areaShare: { min: 0.3, max: 0.5 } },
      { ingredient: 'red onion', count: { min: 3, max: 8 }, areaShare: { min: 0.05, max: 0.2 }, thicknessMm: { min: 1, max: 3 } },
    ],
    steps: [
      { id: 'cut-cuc', instruction: 'Cut the cucumber into 5mm half-moons', verifiable: 'vision', satisfies: ['cucumber'] },
      { id: 'quarter-tom', instruction: 'Quarter the tomatoes', verifiable: 'vision', satisfies: ['tomato'] },
      { id: 'shave-onion', instruction: 'Shave the red onion thin', verifiable: 'vision', satisfies: ['red onion'] },
      { id: 'season', instruction: 'Salt, pepper, and oil to taste', verifiable: 'cook-confirmed' },
      { id: 'toss', instruction: 'Toss until evenly distributed', verifiable: 'vision', satisfies: ['cucumber', 'tomato', 'red onion'] },
    ],
    minMixRatio: 0.55,
  },
  {
    id: 'carrot-slaw',
    name: 'Carrot and Orange Slaw',
    description: 'Julienned carrot with orange segments and a sharp dressing. The knife work is the whole difficulty.',
    difficulty: 'medium',
    averageMinutes: 18,
    icon: '🥕',
    tags: ['slaw', 'citrus', 'no-cook', 'knife-skills'],
    requires: [
      { ingredient: 'carrot', count: { min: 10, max: 30 }, areaShare: { min: 0.45, max: 0.7 }, thicknessMm: { min: 1, max: 4 } },
      { ingredient: 'orange', count: { min: 4, max: 9 }, areaShare: { min: 0.2, max: 0.4 } },
      { ingredient: 'red onion', count: { min: 2, max: 6 }, areaShare: { min: 0.03, max: 0.15 } },
    ],
    steps: [
      { id: 'julienne', instruction: 'Julienne the carrot to 2mm', verifiable: 'vision', satisfies: ['carrot'] },
      { id: 'segment', instruction: 'Segment the orange', verifiable: 'vision', satisfies: ['orange'] },
      { id: 'dress', instruction: 'Dress and season to taste', verifiable: 'cook-confirmed' },
      { id: 'toss', instruction: 'Toss until evenly distributed', verifiable: 'vision', satisfies: ['carrot', 'orange', 'red onion'] },
    ],
    minMixRatio: 0.55,
  },
];

export function recipeById(id: string, recipes: readonly Recipe[] = RECIPES): Recipe | null {
  return recipes.find((r) => r.id === id) ?? null;
}

/**
 * Names in a recipe that no profile can ever produce.
 *
 * Returns the offenders rather than throwing so a caller can report all of them at once.
 * A requirement for an ingredient the classifier cannot name is not a small bug: the tally
 * stays empty forever, so it reads as a permanently missing ingredient and the cook is told
 * to add something they have already added.
 */
export function unknownIngredients(
  recipe: Recipe,
  knownNames: readonly string[],
): readonly string[] {
  return recipe.requires
    .map((r) => r.ingredient)
    .filter((name) => !knownNames.includes(name));
}
