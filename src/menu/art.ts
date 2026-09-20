/**
 * Which picture goes with which ingredient.
 *
 * The design zip ships two asset sets and they are not interchangeable:
 *
 *   `menu/icons/*.png`        12 hand-picked hero icons (bun, patty, cheese, tomato, lettuce,
 *                             onion, ketchup, egg, mushroom, carrot, chili). These are the ones
 *                             the artboard uses in the tally rows and on the dish card, and
 *                             they are the ones drawn to read at a glance.
 *   `menu/ingredients/*.png`  437 icons in four categories -- carb (50), condiment (130),
 *                             green (140), protein (117). This is the library the title screen
 *                             is talking about when it says "437 ingredients". It arrived
 *                             unnamed, as `carb (1).png` through `Protein (117).png`.
 *
 * So: a hero icon when one exists, a library icon when the ingredient is one of the ones
 * identified by eye below, and otherwise a stable pick from the right category.
 *
 * The fallback is stable, not random, and that matters more than it looks. `hash(name)`
 * means "mozzarella" is the same picture on the counter, in the library list and on the dish
 * card. Picking at render time would make the same ingredient change appearance as it moved
 * between panels, which reads as a different ingredient.
 *
 * The fallback is honest about what it is: within the right category, so a pantry item never
 * gets drawn as a fish, but nobody should read a fallback icon as a species identification.
 */

import type { Category } from '../core/pantry.js';

const BASE = `${import.meta.env.BASE_URL}menu/`;

/** Hero icons, by file stem. */
const HERO = [
  'bun-bottom', 'bun-top', 'carrot', 'cheese', 'chili',
  'egg', 'ketchup', 'lettuce', 'mushroom', 'onion', 'patty', 'tomato',
] as const;

export type HeroIcon = (typeof HERO)[number];

export const heroUrl = (name: HeroIcon): string => `${BASE}icons/${name}.png`;

/**
 * Ingredients the hero set draws, and therefore the ones the design itself uses.
 *
 * Everything else falls through to the 437-icon library below. Kept as its own table rather
 * than folded into `NAMED` so the precedence is impossible to misread.
 */
const HERO_FOR: Readonly<Record<string, HeroIcon>> = {
  tomato: 'tomato',
  'cherry tomato': 'tomato',
  lettuce: 'lettuce',
  romaine: 'lettuce',
  cabbage: 'lettuce',
  onion: 'onion',
  'red onion': 'onion',
  cheese: 'cheese',
  cheddar: 'cheese',
  mushroom: 'mushroom',
  carrot: 'carrot',
  egg: 'egg',
  chili: 'chili',
  'chilli powder': 'chili',
  ketchup: 'ketchup',
  beef: 'patty',
  'ground beef': 'patty',
  patty: 'patty',
  bun: 'bun-top',
  'brioche bun': 'bun-top',
  bread: 'bun-bottom',
};

/** How many icons each category folder holds. Used to bound the fallback pick. */
const LIBRARY_SIZE: Readonly<Record<string, number>> = {
  carb: 50,
  condiment: 130,
  green: 140,
  protein: 117,
};

const libraryUrl = (folder: string, index: number): string =>
  `${BASE}ingredients/${folder}-${String(index).padStart(3, '0')}.png`;

/**
 * Ingredients whose picture was found by eye in the 437.
 *
 * Every entry here was looked at. Anything not on this list falls through to the category
 * pick rather than being guessed at, because a confidently wrong picture is worse than an
 * obviously generic one -- a cook glancing at the counter panel reads the icon, not the word.
 */
const NAMED: Readonly<Record<string, string>> = {
  // greens and vegetables
  cucumber: libraryUrl('green', 27),
  basil: libraryUrl('green', 45),
  cilantro: libraryUrl('green', 12),
  coriander: libraryUrl('green', 12),
  parsley: libraryUrl('green', 2),
  spinach: libraryUrl('green', 79),
  garlic: libraryUrl('green', 9),
  lime: libraryUrl('green', 51),
  broccoli: libraryUrl('green', 61),
  olive: libraryUrl('green', 67),
  potato: libraryUrl('green', 72),
  ginger: libraryUrl('green', 85),
  asparagus: libraryUrl('green', 81),
  corn: libraryUrl('green', 132),
  'bell pepper': libraryUrl('green', 59),

  // protein and dairy
  mozzarella: libraryUrl('protein', 37),
  tofu: libraryUrl('protein', 93),
  butter: libraryUrl('protein', 107),
  'fried egg': libraryUrl('protein', 74),
  steak: libraryUrl('protein', 50),
  bacon: libraryUrl('protein', 14),
  salmon: libraryUrl('protein', 15),
  shrimp: libraryUrl('protein', 20),
  chicken: libraryUrl('protein', 45),

  // carbs
  baguette: libraryUrl('carb', 4),
  toast: libraryUrl('carb', 3),
  rice: libraryUrl('carb', 18),
  pasta: libraryUrl('carb', 13),
  noodles: libraryUrl('carb', 17),
  flour: libraryUrl('carb', 22),
  croissant: libraryUrl('carb', 1),

  // pantry
  'olive oil': libraryUrl('condiment', 38),
  oil: libraryUrl('condiment', 22),
  salt: libraryUrl('condiment', 50),
  curd: libraryUrl('condiment', 36),
  yogurt: libraryUrl('condiment', 36),
  cream: libraryUrl('condiment', 96),
  milk: libraryUrl('condiment', 77),
  mayonnaise: libraryUrl('condiment', 33),
  'soy sauce': libraryUrl('condiment', 2),
  honey: libraryUrl('condiment', 89),
  sugar: libraryUrl('condiment', 108),
  vinegar: libraryUrl('condiment', 22),
  'chaat masala': libraryUrl('condiment', 14),
  'cumin powder': libraryUrl('condiment', 14),
  'italian seasoning': libraryUrl('condiment', 126),
  'black pepper': libraryUrl('condiment', 80),
  pepper: libraryUrl('condiment', 80),
};

/** Where an unrecognised ingredient of each category is drawn from. */
const CATEGORY_FOLDER: Readonly<Record<Category, string>> = {
  vegetable: 'green',
  fruit: 'green',
  herb: 'green',
  protein: 'protein',
  dairy: 'protein',
  grain: 'carb',
  pantry: 'condiment',
  unknown: 'condiment',
};

/** FNV-1a. Any stable hash would do; this one is four lines and has no collisions that matter. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The picture for an ingredient.
 *
 * `category` only steers the fallback, so it is fine to pass 'unknown' when a scan could not
 * work out what kind of thing it was looking at.
 */
export function artFor(ingredient: string, category: Category = 'unknown'): string {
  const key = ingredient.trim().toLowerCase();

  // Hero set first, and this order is the whole point. The design document places 42 images
  // across its seven screens and every single one is from `menu/icons` -- the tomato on the
  // counter, the patty on the dish card, the ketchup in the sauce row. Reaching into the
  // 437-icon library for an ingredient the hero set already draws would quietly swap the art
  // direction for something adjacent, so the library is strictly the fallback.
  const hero = HERO_FOR[key];
  if (hero !== undefined) return heroUrl(hero);

  const named = NAMED[key];
  if (named !== undefined) return named;

  const folder = CATEGORY_FOLDER[category] ?? 'condiment';
  const size = LIBRARY_SIZE[folder] ?? 1;
  return libraryUrl(folder, (hash(key) % size) + 1);
}

/** True when `artFor` had a picture of this exact thing rather than a category stand-in. */
export const isNamedArt = (ingredient: string): boolean => {
  const key = ingredient.trim().toLowerCase();
  return HERO_FOR[key] !== undefined || NAMED[key] !== undefined;
};

/**
 * A size from the design document, in rem.
 *
 * The artboard is 1440px wide and this layout's rem tops out around 16.5px at that width, so
 * dividing by 16.5 reproduces the design's proportions at any window size instead of freezing
 * them at one. Call sites read `designRem(42)` rather than `2.54`, so they stay checkable
 * against the document.
 */
export const designRem = (artboardPx: number): number =>
  Math.round((artboardPx / 16.5) * 100) / 100;

/**
 * Per-icon optical scale.
 *
 * The design never draws these at one size: a 42px tomato sits beside a 34px ketchup, a 36px
 * onion beside a 26px ketchup. That is not inconsistency, it is optical sizing -- the ketchup
 * bottle is tall and narrow, so matching its WIDTH to a round tomato would make it tower over
 * the row. Same reason the chili and the egg run slightly small. Encoded here so every call
 * site gets the correction for free instead of each one rediscovering it.
 */
const OPTICAL: Readonly<Partial<Record<HeroIcon, number>>> = {
  ketchup: 0.78,
  egg: 0.86,
  chili: 0.74,
  mushroom: 0.93,
  'bun-bottom': 0.95,
};

/** The width to draw a hero icon at, given the size its neighbours use. */
export const heroSize = (name: HeroIcon, baseRem: number): number =>
  Math.round(baseRem * (OPTICAL[name] ?? 1) * 100) / 100;

/**
 * Tint class for a chip or tag, so a counter full of ingredients still groups by eye. Mirrors
 * the artboard, which coloured its tally rows green / pink / blue / soft-yellow by group.
 */
export function tintFor(category: Category): string {
  switch (category) {
    case 'protein':
    case 'dairy':
      return 'protein';
    case 'grain':
      return 'grain';
    case 'pantry':
      return 'pantry';
    default:
      return 'green';
  }
}

/**
 * The four groups the counter panel tallies into.
 *
 * The artboard showed Carbs / Protein / Greens / Sauce, which is the shape a cook thinks in,
 * not the eight-way `Category` the scan produces. This is the mapping between them.
 */
export type CounterGroup = 'carbs' | 'protein' | 'greens' | 'sauce';

export const GROUP_ORDER: readonly CounterGroup[] = ['carbs', 'protein', 'greens', 'sauce'];

export const GROUP_LABEL: Readonly<Record<CounterGroup, string>> = {
  carbs: 'Carbs',
  protein: 'Protein',
  greens: 'Greens',
  sauce: 'Sauce',
};

export const GROUP_ICON: Readonly<Record<CounterGroup, HeroIcon>> = {
  carbs: 'bun-top',
  protein: 'patty',
  greens: 'lettuce',
  sauce: 'ketchup',
};

export const GROUP_TINT: Readonly<Record<CounterGroup, string>> = {
  carbs: 'var(--yellow-soft)',
  protein: 'var(--pink)',
  greens: 'var(--leaf)',
  sauce: 'var(--sky)',
};

export const GROUP_INK: Readonly<Record<CounterGroup, string>> = {
  carbs: '#8a6a2e',
  protein: '#9a4e44',
  greens: '#3f6b33',
  sauce: '#3d5c78',
};

export function groupOf(category: Category): CounterGroup {
  switch (category) {
    case 'grain':
      return 'carbs';
    case 'protein':
    case 'dairy':
      return 'protein';
    case 'pantry':
      return 'sauce';
    default:
      return 'greens';
  }
}
