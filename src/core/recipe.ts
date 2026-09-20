/**
 * What a finished dish is supposed to look like.
 *
 * A recipe here is not prose -- it is a set of *measurable claims*, plus the handful of steps
 * no camera or sensor can check. That split is the whole design. `requires` is what the pantry
 * and the bowl can be diffed against; `steps` carries the rest, each saying honestly whether it
 * is checkable.
 *
 * Ingredient names must match what the scan can produce, or a requirement can never be
 * satisfied -- the tally it looks for never appears, and the cook is told forever to add
 * something already in front of them. `unknownIngredients` exists to catch that at startup
 * rather than in front of a judge.
 */

import type { Range } from './ingredients.js';

/**
 * Whether a step can be confirmed by looking.
 *
 * `cook-confirmed` is not a cop-out, it is the honest answer for a whole class of real cooking.
 * Salt has no optical signature: a seasoned dish and an unseasoned one are the same photograph.
 * Guessing produces confident feedback with nothing behind it, which is worse than silence
 * because the cook cannot tell the two apart.
 */
export type Verifiability = 'vision' | 'cook-confirmed';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** One measurable claim about a single ingredient. */
export interface IngredientRequirement {
  readonly ingredient: string;
  /** How many separate units. Omit when the count genuinely does not matter. */
  readonly count?: Range;
  /** Share of total food area, 0..1. Catches "too much cucumber". */
  readonly areaShare?: Range;
  /** Target piece thickness in mm. */
  readonly thicknessMm?: Range;
}

export interface RecipeStep {
  readonly id: string;
  readonly instruction: string;
  readonly verifiable: Verifiability;
  /**
   * Ingredients whose requirements this step is responsible for.
   *
   * This is what lets a `vision` step complete itself: once no deficit mentions any of these,
   * the step has demonstrably been done. Without the link a step could only ever be ticked off
   * by asking, which would make the tracker a checklist the cook drives rather than something
   * the system drives.
   *
   * Empty for `cook-confirmed` steps, which have nothing observable to attach to.
   */
  readonly satisfies?: readonly string[];
}

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
   * render identically in a UIKitML panel and in a browser, and they survive a designer never
   * arriving. Swap for real icons later by changing this field only.
   */
  readonly icon: string;
  /** Free-text tags the search bar matches, beyond name and ingredients. */
  readonly tags: readonly string[];
  readonly requires: readonly IngredientRequirement[];
  readonly steps: readonly RecipeStep[];
  /**
   * An ingredient clustering more tightly than this fraction of the bowl's own spread has not
   * been mixed through. 1.0 would demand perfection and fire constantly; 0 disables the check.
   */
  readonly minMixRatio: number;
}

/**
 * Recipes taken from CaptainCook4D, not invented here.
 *
 * Step text is the dataset's own wording, reordered into the sequence a cook actually works in
 * -- the task graphs number steps by id, not by order. Keeping the wording verbatim matters:
 * the dataset's ~2,400 annotated errors are described against these exact strings, so a
 * critique can be checked against how real people were observed getting this wrong rather than
 * against our guesses.
 *
 * Chosen for data volume against simplicity. Cucumber Raita is the most-recorded recipe in the
 * set (20 recordings); Tomato Mozzarella Salad has the fewest steps of any well-covered one
 * (9); Caprese Bruschetta is the only short recipe exercising all seven error categories.
 *
 * Deliberately absent despite ample data: Scrambled Eggs (23 steps), Broccoli Stir Fry (25),
 * Mug Cake (20). Too long to walk someone through in a demo.
 */
export const RECIPES: readonly Recipe[] = [
  {
    id: 'tomato-mozzarella-salad',
    name: 'Tomato Mozzarella Salad',
    description:
      'Sliced tomato, olive oil, mozzarella and seasoning on a platter. Nine steps, no heat, and it comes apart as fast as it goes together.',
    difficulty: 'easy',
    averageMinutes: 8,
    icon: '🍅',
    tags: ['salad', 'no-cook', 'italian', 'quick', 'captaincook4d'],
    requires: [
      { ingredient: 'tomato', count: { min: 1, max: 3 } },
      { ingredient: 'mozzarella', count: { min: 1, max: 2 } },
      { ingredient: 'olive oil', count: { min: 1, max: 1 } },
      { ingredient: 'salt', count: { min: 1, max: 1 } },
    ],
    steps: [
      { id: 'rinse', instruction: 'Rinse a tomato', verifiable: 'vision', satisfies: ['tomato'] },
      { id: 'dry', instruction: 'Gently dry it with a paper or tea towel', verifiable: 'vision', satisfies: ['tomato'] },
      { id: 'slice', instruction: 'Slice one tomato into about 1/2 inch thick slices', verifiable: 'vision', satisfies: ['tomato'] },
      { id: 'place', instruction: 'Place the slices on a platter in a single layer', verifiable: 'vision', satisfies: ['tomato'] },
      { id: 'oil', instruction: 'Add a drizzle of extra-virgin olive oil, about 1 tablespoon', verifiable: 'vision', satisfies: ['olive oil'] },
      { id: 'salt', instruction: 'Season the tomato slices with salt', verifiable: 'cook-confirmed' },
      { id: 'pepper', instruction: 'Season the platter with 1/4 teaspoon black pepper', verifiable: 'cook-confirmed' },
      { id: 'mozzarella', instruction: 'Sprinkle mozzarella over the tomato throughout the platter', verifiable: 'vision', satisfies: ['mozzarella'] },
      { id: 'garnish', instruction: 'Garnish the platter with italian seasoning', verifiable: 'cook-confirmed' },
    ],
    minMixRatio: 0.55,
  },
  {
    id: 'cucumber-raita',
    name: 'Cucumber Raita',
    description:
      'Grated cucumber folded through whisked curd with cumin and chaat masala. The most-recorded dish in the dataset, and almost every mistake in it is one of order.',
    difficulty: 'easy',
    averageMinutes: 10,
    icon: '🥒',
    tags: ['raita', 'no-cook', 'indian', 'yogurt', 'captaincook4d'],
    requires: [
      { ingredient: 'cucumber', count: { min: 1, max: 2 } },
      { ingredient: 'curd', count: { min: 1, max: 1 } },
      { ingredient: 'cilantro', count: { min: 1, max: 1 } },
      { ingredient: 'salt', count: { min: 1, max: 1 } },
    ],
    steps: [
      { id: 'rinse', instruction: 'Rinse 1 medium sized cucumber', verifiable: 'vision', satisfies: ['cucumber'] },
      { id: 'peel', instruction: 'Peel the cucumber', verifiable: 'vision', satisfies: ['cucumber'] },
      { id: 'chop', instruction: 'Chop or grate the cucumber', verifiable: 'vision', satisfies: ['cucumber'] },
      { id: 'whisk', instruction: 'Whisk 1 cup of chilled curd in a mixing bowl until smooth', verifiable: 'vision', satisfies: ['curd'] },
      { id: 'salt', instruction: 'Add 1/4 teaspoon salt to the bowl', verifiable: 'cook-confirmed' },
      { id: 'chilli', instruction: 'Add 1/4 teaspoon of red chilli powder to the bowl', verifiable: 'cook-confirmed' },
      { id: 'cumin', instruction: 'Add 1 teaspoon of cumin powder to the bowl', verifiable: 'cook-confirmed' },
      { id: 'chaat', instruction: 'Add 1/2 teaspoon of chaat masala powder to the bowl', verifiable: 'cook-confirmed' },
      { id: 'fold', instruction: 'Add the chopped cucumber to the whisked curd', verifiable: 'vision', satisfies: ['cucumber'] },
      { id: 'cilantro', instruction: 'Add 1 tablespoon of chopped cilantro leaves to the bowl', verifiable: 'vision', satisfies: ['cilantro'] },
      { id: 'combine', instruction: 'Combine all the ingredients in the bowl', verifiable: 'vision', satisfies: ['cucumber', 'curd', 'cilantro'] },
    ],
    minMixRatio: 0.55,
  },
  {
    id: 'caprese-bruschetta',
    name: 'Caprese Bruschetta',
    description:
      'Cherry tomato, mozzarella and basil spooned onto toasted baguette. The only short recipe here that can go wrong in all seven ways the dataset records.',
    difficulty: 'medium',
    averageMinutes: 15,
    icon: '🍞',
    tags: ['bruschetta', 'italian', 'toast', 'captaincook4d'],
    requires: [
      { ingredient: 'cherry tomato', count: { min: 4, max: 12 } },
      { ingredient: 'mozzarella', count: { min: 1, max: 2 } },
      { ingredient: 'basil', count: { min: 1, max: 3 } },
      { ingredient: 'baguette', count: { min: 1, max: 1 } },
      { ingredient: 'olive oil', count: { min: 1, max: 1 } },
    ],
    steps: [
      { id: 'cut-tomato', instruction: 'Cut 1/4 cup of cherry tomatoes into halves', verifiable: 'vision', satisfies: ['cherry tomato'] },
      { id: 'bowl-tomato', instruction: 'Add the cut cherry tomatoes to a bowl', verifiable: 'vision', satisfies: ['cherry tomato'] },
      { id: 'bowl-mozzarella', instruction: 'Add 1/8 cup shredded mozzarella to the bowl', verifiable: 'vision', satisfies: ['mozzarella'] },
      { id: 'bowl-basil', instruction: 'Add 1/16 cup basil to the bowl', verifiable: 'vision', satisfies: ['basil'] },
      { id: 'bowl-salt', instruction: 'Add 1/4 tsp salt to the bowl', verifiable: 'cook-confirmed' },
      { id: 'bowl-pepper', instruction: 'Add 1/4 tsp pepper to the bowl', verifiable: 'cook-confirmed' },
      { id: 'combine', instruction: 'Combine the contents of the bowl', verifiable: 'vision', satisfies: ['cherry tomato', 'mozzarella', 'basil'] },
      { id: 'slice', instruction: 'Slice two 1/2 inch thick rounds from a baguette, cut slanted', verifiable: 'vision', satisfies: ['baguette'] },
      { id: 'brush', instruction: 'Brush both sides of the 2 slices with olive oil', verifiable: 'vision', satisfies: ['olive oil'] },
      { id: 'toast', instruction: 'Toast both sides for 2 to 3 minutes until lightly charred, then transfer to a plate', verifiable: 'cook-confirmed' },
      { id: 'spoon', instruction: 'Spoon the mixture from the bowl onto the bread', verifiable: 'vision', satisfies: ['baguette'] },
    ],
    minMixRatio: 0.55,
  },
];

export function recipeById(id: string, recipes: readonly Recipe[] = RECIPES): Recipe | null {
  return recipes.find((r) => r.id === id) ?? null;
}

/**
 * Names in a recipe that the scan can never produce.
 *
 * Returns the offenders rather than throwing, so a caller can report all of them at once. A
 * requirement for an ingredient nothing can name is not a small bug: the tally stays empty
 * forever, so it reads as permanently missing and the cook is told to add what is already there.
 */
export function unknownIngredients(
  recipe: Recipe,
  knownNames: readonly string[],
): readonly string[] {
  return recipe.requires
    .map((r) => r.ingredient)
    .filter((name) => !knownNames.includes(name));
}
