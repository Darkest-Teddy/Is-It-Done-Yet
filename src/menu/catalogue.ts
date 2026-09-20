/**
 * The ingredients this app can name, and what kind of thing each one is.
 *
 * Two jobs. It gives the scan a category for the handful of things the vision profiles can
 * actually identify, and it gives "fix by hand" a list to pick from.
 *
 * The list is built from what the rest of the app already depends on -- every ingredient named
 * by a recipe in `src/core/recipe.ts`, plus everything `src/core/ingredients.ts` has a vision
 * profile for -- and only then padded with common extras. Built that way round it cannot drift:
 * an ingredient a recipe needs is always offerable, so a cook is never stuck unable to tell the
 * app about something a dish on the list requires.
 */

import { PROFILES } from '../core/ingredients.js';
import type { Category } from '../core/pantry.js';
import { RECIPES } from '../core/recipe.js';

/** Everything with a known kind. Anything absent is 'unknown', which is a real answer. */
const KIND: Readonly<Record<string, Category>> = {
  // vision profiles
  cucumber: 'vegetable',
  tomato: 'vegetable',
  'cherry tomato': 'vegetable',
  carrot: 'vegetable',
  'red onion': 'vegetable',
  onion: 'vegetable',
  orange: 'fruit',
  lemon: 'fruit',
  lime: 'fruit',

  // greens
  lettuce: 'vegetable',
  romaine: 'vegetable',
  spinach: 'vegetable',
  mushroom: 'vegetable',
  garlic: 'vegetable',
  chili: 'vegetable',
  'bell pepper': 'vegetable',
  broccoli: 'vegetable',
  potato: 'vegetable',
  basil: 'herb',
  cilantro: 'herb',
  parsley: 'herb',

  // protein and dairy
  mozzarella: 'dairy',
  cheese: 'dairy',
  cheddar: 'dairy',
  curd: 'dairy',
  yogurt: 'dairy',
  butter: 'dairy',
  cream: 'dairy',
  milk: 'dairy',
  egg: 'protein',
  beef: 'protein',
  'ground beef': 'protein',
  patty: 'protein',
  steak: 'protein',
  chicken: 'protein',
  salmon: 'protein',
  bacon: 'protein',
  shrimp: 'protein',
  tofu: 'protein',

  // carbs
  baguette: 'grain',
  bread: 'grain',
  bun: 'grain',
  'brioche bun': 'grain',
  rice: 'grain',
  pasta: 'grain',
  noodles: 'grain',
  flour: 'grain',

  // pantry
  'olive oil': 'pantry',
  oil: 'pantry',
  salt: 'pantry',
  pepper: 'pantry',
  'black pepper': 'pantry',
  sugar: 'pantry',
  honey: 'pantry',
  vinegar: 'pantry',
  ketchup: 'pantry',
  mayonnaise: 'pantry',
  'soy sauce': 'pantry',
  'italian seasoning': 'pantry',
  'chaat masala': 'pantry',
  'cumin powder': 'pantry',
  'chilli powder': 'pantry',
};

export const categoryFor = (ingredient: string): Category =>
  KIND[ingredient.trim().toLowerCase()] ?? 'unknown';

/**
 * What "fix by hand" offers, ordered so the things a recipe on the list actually needs come
 * first. Everything the recipes require, then everything the camera can recognise, then the
 * rest of the known kinds.
 */
export const ADDABLE: readonly string[] = (() => {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (name: string): void => {
    const key = name.trim().toLowerCase();
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  };

  for (const recipe of RECIPES) for (const need of recipe.requires) push(need.ingredient);
  for (const profile of PROFILES) push(profile.name);
  for (const name of Object.keys(KIND)) push(name);

  return ordered;
})();

/** True when a recipe in the book asks for this. Used to mark the useful rows in the picker. */
export const REQUIRED_BY_A_RECIPE: ReadonlySet<string> = new Set(
  RECIPES.flatMap((recipe) => recipe.requires.map((need) => need.ingredient.toLowerCase())),
);

/** Title Case for display. The pantry stores everything lower case, on purpose. */
export const pretty = (ingredient: string): string =>
  ingredient.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
