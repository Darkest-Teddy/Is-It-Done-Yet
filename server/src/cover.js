/**
 * A recipe's cover colours, derived rather than stored.
 *
 * The recipe book draws its cards procedurally -- a tinted panel, a dark outline, an accent
 * pill -- so a recipe needs three colours and no image. Deriving them from the slug and tags
 * rather than storing them means every recipe ever written already has a cover, including the
 * thirteen seeded before this file existed and the one a cook scans off a card tonight.
 *
 * The palette is lifted verbatim from design/tokens.json. Tints are the five card fills from
 * the reference; the ink is the single outline colour the whole design uses.
 */

/** Card fills, in the order the reference uses them. Indexed by hash when no tag matches. */
export const COVER_TINTS = ['#FBE3A0', '#CDE6C7', '#F9C7BE', '#C4DAEE', '#F9D3B4'];

/** Every panel in the reference is outlined in this one colour. Nothing else is. */
export const COVER_INK = '#46101A';

export const COVER_ACCENTS = { warm: '#F5230E', gold: '#FBD24B' };

/**
 * Tag to tint, checked in order.
 *
 * Ordered rather than a plain map because a recipe is tagged "salad" AND "quick", and the
 * first entry that matches should win deterministically. An object's key order would work
 * today and quietly stop working the day somebody reformats the file.
 */
const BY_TAG = [
  [['beef', 'burger', 'steak', 'pork', 'lamb'], '#F9C7BE'],
  [['salad', 'greens', 'vegetarian', 'vegan', 'no-cook'], '#CDE6C7'],
  [['breakfast', 'egg', 'baking', 'bread', 'dessert'], '#FBE3A0'],
  [['seafood', 'fish', 'soup', 'noodles'], '#C4DAEE'],
  [['spicy', 'chili', 'curry', 'fried'], '#F9D3B4'],
];

/**
 * FNV-1a over the slug.
 *
 * Any stable hash would do; what matters is that it is stable. A recipe whose cover colour
 * changes between two loads of the same list reads as a rendering bug, and the carousel
 * animates the change.
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * @param {{slug?: string, title?: string, tags?: string[]}} recipe
 * @returns {{tint: string, ink: string, accent: string}}
 */
export function coverFor(recipe) {
  const tags = Array.isArray(recipe?.tags) ? recipe.tags.map((t) => String(t).toLowerCase()) : [];
  const key = String(recipe?.slug ?? recipe?.title ?? '');

  let tint = null;
  for (const [words, colour] of BY_TAG) {
    if (tags.some((tag) => words.includes(tag))) { tint = colour; break; }
  }
  if (tint === null) tint = COVER_TINTS[hash(key) % COVER_TINTS.length];

  // Gold on the greens and blues, warm red elsewhere: the reference only ever puts the red
  // accent on a warm card, and a red pill on the green card is the one pairing that reads as
  // an error state rather than a highlight.
  const accent = tint === '#CDE6C7' || tint === '#C4DAEE' ? COVER_ACCENTS.gold : COVER_ACCENTS.warm;

  return { tint, ink: COVER_INK, accent };
}
