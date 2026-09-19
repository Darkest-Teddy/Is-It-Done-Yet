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
  // CaptainCook4D recipe ingredients
  tomato: '\u{1F345}',
  'cherry tomato': '\u{1F345}',
  cucumber: '\u{1F952}',
  mozzarella: '\u{1F9C0}',
  cheese: '\u{1F9C0}',
  curd: '\u{1F95B}',
  yogurt: '\u{1F95B}',
  basil: '\u{1F33F}',
  cilantro: '\u{1F33F}',
  baguette: '\u{1F956}',
  bread: '\u{1F956}',
  'olive oil': '\u{1FAD7}',
  oil: '\u{1FAD7}',
  salt: '\u{1F9C2}',
  pepper: '\u{1F9C2}',
  // common extras a scan may turn up
  'red onion': '\u{1F9C5}',
  onion: '\u{1F9C5}',
  carrot: '\u{1F955}',
  orange: '\u{1F34A}',
  lemon: '\u{1F34B}',
  lettuce: '\u{1F96C}',
  avocado: '\u{1F951}',
  egg: '\u{1F95A}',
  mushroom: '\u{1F344}',
  garlic: '\u{1F9C4}',
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

// ---------------------------------------------------------------------------------------------
// The setup scan, and the confirmation that makes it trustworthy
// ---------------------------------------------------------------------------------------------

/** One line as the vision model reported it, before a human has looked at it. */
export interface RawScanItem {
  readonly ingredient: string;
  readonly count: number;
  readonly category: string;
  readonly confidence: number;
}

const CATEGORIES: readonly Category[] = [
  'vegetable', 'fruit', 'herb', 'protein', 'dairy', 'grain', 'pantry', 'unknown',
];

const asCategory = (raw: string): Category =>
  (CATEGORIES as readonly string[]).includes(raw) ? (raw as Category) : 'unknown';

/**
 * Turns a raw scan into a pantry, normalising as it goes.
 *
 * Nothing arrives confirmed. That is the point: the scan is a proposal, and the confirm screen
 * is what turns it into fact. Counts are floored at 1 and rounded -- a model returning 2.5
 * tomatoes is telling you it is unsure, which belongs in `confidence`, not in a fractional
 * tomato that then fails an integer requirement for no visible reason.
 *
 * Duplicate lines for one ingredient are merged, keeping the LOWEST confidence of the group.
 * Merging is where a scan is most likely to be wrong, so the merged line should inherit the
 * doubt rather than the reassurance.
 */
export function pantryFromScan(
  items: readonly RawScanItem[],
  scannedAtMs: number,
): Pantry {
  const merged = new Map<string, PantryItem>();

  for (const raw of items) {
    const ingredient = raw.ingredient.trim().toLowerCase();
    if (ingredient === '') continue;

    const count = Math.max(1, Math.round(raw.count));
    const confidence = Math.min(1, Math.max(0, raw.confidence));
    const existing = merged.get(ingredient);

    merged.set(ingredient, existing === undefined
      ? { ingredient, count, category: asCategory(raw.category), confidence, confirmed: false }
      : {
          ...existing,
          count: existing.count + count,
          confidence: Math.min(existing.confidence, confidence),
        });
  }

  return { items: [...merged.values()], scannedAtMs };
}

const mapItems = (
  pantry: Pantry,
  fn: (item: PantryItem) => PantryItem | null,
): Pantry => ({
  ...pantry,
  items: pantry.items.map(fn).filter((i): i is PantryItem => i !== null),
});

/** Marks one line as checked by a human. Its confidence becomes certainty. */
export function confirmItem(pantry: Pantry, ingredient: string): Pantry {
  return mapItems(pantry, (i) =>
    i.ingredient === ingredient ? { ...i, confirmed: true, confidence: 1 } : i);
}

/** Accepts the whole scan as-is. The "looks right" button. */
export function confirmAll(pantry: Pantry): Pantry {
  return mapItems(pantry, (i) => ({ ...i, confirmed: true, confidence: 1 }));
}

/**
 * Nudges a count, which also confirms the line -- editing a number IS checking it.
 *
 * Dropping to zero removes the item rather than leaving a zero-count line, because "0 tomatoes"
 * and "no tomatoes" would otherwise both appear and match differently.
 */
export function adjustCount(pantry: Pantry, ingredient: string, delta: number): Pantry {
  return mapItems(pantry, (i) => {
    if (i.ingredient !== ingredient) return i;
    const count = i.count + delta;
    return count <= 0 ? null : { ...i, count, confirmed: true, confidence: 1 };
  });
}

/** Removes a line the scan hallucinated. */
export function removeItem(pantry: Pantry, ingredient: string): Pantry {
  return mapItems(pantry, (i) => (i.ingredient === ingredient ? null : i));
}

/** Adds something the scan missed. Confirmed by definition -- a human typed it. */
export function addItem(
  pantry: Pantry,
  ingredient: string,
  count: number,
  category: Category = 'unknown',
): Pantry {
  const name = ingredient.trim().toLowerCase();
  if (name === '' || count <= 0) return pantry;

  const existing = pantry.items.find((i) => i.ingredient === name);
  if (existing !== undefined) return adjustCount(pantry, name, count);

  return {
    ...pantry,
    items: [...pantry.items, {
      ingredient: name, count: Math.round(count), category, confidence: 1, confirmed: true,
    }],
  };
}

/** True once nothing is left for the cook to check. Gates entry to the recipe library. */
export function isReviewed(pantry: Pantry): boolean {
  return unconfirmed(pantry).length === 0;
}
