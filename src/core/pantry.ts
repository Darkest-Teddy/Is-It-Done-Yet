/**
 * What is on the counter, and what it lets you cook.
 *
 * The pantry is produced by the setup scan and then confirmed by the cook. That confirmation
 * step is the whole accuracy strategy and it is not optional: no vision model counts a cluttered
 * counter perfectly, and a recipe list built on a miscount sends someone to make a dish they
 * cannot finish. A scan the cook has corrected is accurate by construction rather than on
 * average, which is the only kind of accuracy that survives a demo.
 *
 * So every item carries both a model `confidence` and a `confirmed` flag, and the UI is expected
 * to push anything uncertain in front of the cook before the recipe list is trusted.
 */

import type { Recipe } from './recipe.js';

export type Category =
  | 'vegetable'
  | 'fruit'
  | 'herb'
  | 'protein'
  | 'dairy'
  | 'grain'
  | 'pantry'
  | 'unknown';

export interface PantryItem {
  readonly ingredient: string;
  readonly count: number;
  readonly category: Category;
  /** 0..1 as reported by the scan. 1 once a human has confirmed it. */
  readonly confidence: number;
  /** True once the cook has seen and accepted this line. */
  readonly confirmed: boolean;
}

export interface Pantry {
  readonly items: readonly PantryItem[];
  readonly scannedAtMs: number;
}

/**
 * Below this, an unconfirmed item is treated as a question rather than a fact.
 *
 * TUNED, not sourced. The point is not the exact number -- it is that low-confidence items get
 * surfaced for confirmation instead of quietly deciding which recipes appear.
 */
export const NEEDS_CONFIRMATION_BELOW = 0.75;

export const emptyPantry = (): Pantry => ({ items: [], scannedAtMs: 0 });

/**
 * Emoji per ingredient, for the recipe list and the missing-ingredient rows.
 *
 * Emoji rather than image assets on purpose: nothing to load, nothing to license, no atlas, and
 * they render the same in a UIKitML panel as in the laptop debug view. Unknown ingredients fall
 * back to a neutral glyph rather than breaking layout.
 */
export const INGREDIENT_ICONS: Readonly<Record<string, string>> = {
  cucumber: '🥒',
  tomato: '🍅',
  'red onion': '🧅',
  onion: '🧅',
  carrot: '🥕',
  orange: '🍊',
  lemon: '🍋',
  lettuce: '🥬',
  avocado: '🥑',
  pepper: '🫑',
  olive: '🫒',
  cheese: '🧀',
  feta: '🧀',
  egg: '🥚',
  salt: '🧂',
  oil: '🫗',
};

export const iconFor = (ingredient: string): string =>
  INGREDIENT_ICONS[ingredient.toLowerCase()] ?? '🍽️';

export function countInPantry(pantry: Pantry, ingredient: string): number {
  return pantry.items
    .filter((i) => i.ingredient.toLowerCase() === ingredient.toLowerCase())
    .reduce((t, i) => t + i.count, 0);
}

/** Items the cook should be asked about before the recipe list is trusted. */
export function unconfirmed(pantry: Pantry): readonly PantryItem[] {
  return pantry.items.filter((i) => !i.confirmed && i.confidence < NEEDS_CONFIRMATION_BELOW);
}

/** Groups the counter for display. Categories with nothing in them are omitted. */
export function byCategory(pantry: Pantry): readonly { category: Category; items: readonly PantryItem[] }[] {
  const order: Category[] = ['vegetable', 'fruit', 'herb', 'protein', 'dairy', 'grain', 'pantry', 'unknown'];
  return order
    .map((category) => ({ category, items: pantry.items.filter((i) => i.category === category) }))
    .filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Matching recipes against the counter
// ---------------------------------------------------------------------------------------------

export interface IngredientMatch {
  readonly ingredient: string;
  readonly icon: string;
  /** Minimum the recipe needs. */
  readonly needed: number;
  readonly have: number;
  readonly satisfied: boolean;
}

export interface RecipeMatch {
  readonly recipe: Recipe;
  readonly matched: readonly IngredientMatch[];
  readonly missing: readonly IngredientMatch[];
  /** 0..1 share of required ingredients satisfied. Drives ordering in the library. */
  readonly completeness: number;
  readonly makeable: boolean;
}

export function matchRecipe(pantry: Pantry, recipe: Recipe): RecipeMatch {
  const lines: IngredientMatch[] = recipe.requires.map((req) => {
    const needed = req.count?.min ?? 1;
    const have = countInPantry(pantry, req.ingredient);
    return {
      ingredient: req.ingredient,
      icon: iconFor(req.ingredient),
      needed,
      have,
      satisfied: have >= needed,
    };
  });

  const matched = lines.filter((l) => l.satisfied);
  const missing = lines.filter((l) => !l.satisfied);

  return {
    recipe,
    matched,
    missing,
    completeness: lines.length === 0 ? 1 : matched.length / lines.length,
    makeable: missing.length === 0,
  };
}

/**
 * Every recipe, best first.
 *
 * Returns near-misses as well as makeable dishes rather than filtering them out. "You are one
 * tomato away from this" is more useful to a cook than a shorter list, and it is the thing a
 * recipe app can say that a cookbook cannot.
 */
export function rankRecipes(pantry: Pantry, recipes: readonly Recipe[]): readonly RecipeMatch[] {
  return recipes
    .map((r) => matchRecipe(pantry, r))
    .sort((a, b) => {
      if (a.makeable !== b.makeable) return a.makeable ? -1 : 1;
      if (a.completeness !== b.completeness) return b.completeness - a.completeness;
      // Tie-break toward the quicker dish: someone staring at a counter is usually hungry.
      return a.recipe.averageMinutes - b.recipe.averageMinutes;
    });
}

/**
 * The one dish to suggest when the cook presses "recommend".
 *
 * Only ever suggests something actually makeable -- recommending a dish whose ingredients are
 * absent is worse than staying quiet, because it costs the cook the time to find that out.
 * Among makeable dishes it prefers the harder one, since a recommendation should be worth
 * taking rather than the thing they would have picked anyway.
 */
export function recommend(pantry: Pantry, recipes: readonly Recipe[]): RecipeMatch | null {
  const rank: Record<Recipe['difficulty'], number> = { hard: 0, medium: 1, easy: 2 };
  const makeable = rankRecipes(pantry, recipes).filter((m) => m.makeable);
  if (makeable.length === 0) return null;

  return [...makeable].sort(
    (a, b) => rank[a.recipe.difficulty] - rank[b.recipe.difficulty],
  )[0] ?? null;
}

/**
 * Free-text search over name, description, tags and ingredient names.
 *
 * Every term must match something, so extra words narrow rather than widen -- typing more in a
 * headset is expensive, and a search that returns more results the harder you work is maddening.
 */
export function searchRecipes(recipes: readonly Recipe[], query: string): readonly Recipe[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return recipes;

  return recipes.filter((r) => {
    const haystack = [
      r.name,
      r.description,
      ...r.tags,
      ...r.requires.map((q) => q.ingredient),
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}
