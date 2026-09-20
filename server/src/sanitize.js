/**
 * Turning a name typed in a headset into something safe to render on a public board.
 *
 * Pure and dependency-free so the rules can be tested exhaustively without a database. The
 * board is the one place in this project where a stranger's input is shown to a room, so the
 * filter is a whitelist: everything not explicitly allowed is gone, rather than a blacklist of
 * the tricks somebody thought of.
 */

export const NAME_MIN = 1;
export const NAME_MAX = 20;

/**
 * Characters a name may keep. Letters, digits, space, and three punctuation marks people
 * actually use in handles.
 *
 * ASCII-only on purpose, and this is a real tradeoff worth naming: it excludes anyone whose
 * name is not written in Latin script. The board is rendered in a UIKit panel with a bitmap
 * font atlas that has no glyphs beyond Latin-1, so a Devanagari name renders as a row of
 * tofu boxes -- visibly broken rather than merely unsupported. Widen this the same day the
 * font does.
 */
const ALLOWED = /[^A-Za-z0-9 ._-]/g;

/** Zero-width and bidi controls. Invisible, and the standard way to spoof or wreck a row. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

/**
 * Words that get a generic rejection.
 *
 * Short and English-only, and that is the honest scope: this stops the four words a teenager
 * tries at a booth, not a determined person. Matched on the letters only, with digits folded
 * back to letters, so `sh1t` and `s.h.i.t` do not walk straight through. Pretending it is
 * more than that would be worse than having none.
 */
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'nazi', 'bitch',
  'whore', 'slut', 'dick', 'cock', 'pussy', 'wank', 'bastard', 'twat',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', $: 's', '@': 'a' };

/** Collapses a name to bare letters so spacing and digit tricks do not defeat the blocklist. */
function fold(name) {
  return name
    .toLowerCase()
    .replace(/[0-9$@]/g, (c) => LEET[c] ?? '')
    .replace(/[^a-z]/g, '');
}

export function isBlocked(name) {
  const folded = fold(name);
  return BLOCKED.some((word) => folded.includes(word));
}

/**
 * NFKC-normalise, strip the invisible, drop what is not allowed, collapse runs of spaces.
 *
 * NFKC first and deliberately: it folds the fullwidth and mathematical alphabets onto plain
 * ASCII, so `ｆｕｃｋ` and `𝐟𝐮𝐜𝐤` become the same string the blocklist already knows about.
 * Doing it after the whitelist would instead delete them silently and let the next variant
 * through.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(ALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/**
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 *
 * The blocked case returns the same wording as the empty case on purpose. Telling somebody
 * exactly which of their characters tripped a filter is a tutorial on getting past it.
 */
export function normalizeName(raw) {
  const name = cleanName(raw);
  if (name.length < NAME_MIN) {
    return { ok: false, reason: 'name must be 1-20 characters of letters, numbers, space, dot, underscore or hyphen' };
  }
  if (isBlocked(name)) {
    return { ok: false, reason: 'name must be 1-20 characters of letters, numbers, space, dot, underscore or hyphen' };
  }
  return { ok: true, name };
}

/** Lowercase, hyphenated, bounded. Used when a POSTed recipe brings no slug of its own. */
export function slugify(title) {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug === '' ? null : slug;
}
