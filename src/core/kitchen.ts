/**
 * What the cook did, and everything that is wrong with it.
 *
 * This replaces the vision pipeline's `BoardState`, and it is a strictly better foundation for
 * coaching. A camera could never see salt -- a seasoned salad and an unseasoned one are the
 * same photograph -- so the single most common fault in home cooking was unreachable in
 * principle. Virtual interactions have no such limit: salting is an action, tasting is an
 * action, drying the leaves is an action. Every deficit below is a fact about what happened
 * rather than an inference from pixels, which is also what lets a language model be handed
 * ground truth instead of an image to guess at.
 *
 * The action log is append-only and the bowl is derived from it. Undo is dropping the last
 * action, the summary replays without special-casing, and nothing can drift out of sync with
 * what actually happened.
 *
 * The faults modelled here are the ones that actually ruin dishes, not the ones that are easy
 * to detect. Several -- tasting, drying, dressing early -- are invisible to any camera and are
 * exactly why the virtual model is worth having.
 */

import type { Deficit, Severity } from './deficit.js';
import type { Range } from './ingredients.js';

export type CookAction =
  /** Ingredient into the bowl. `delicate` items bruise if they go in before tossing. */
  | { readonly kind: 'add'; readonly ingredient: string; readonly count: number; readonly atMs: number; readonly delicate?: boolean }
  /** Seasoning applied. Pinches, because that is what the gesture produces. */
  | { readonly kind: 'season'; readonly seasoning: string; readonly amount: number; readonly atMs: number }
  /** Dressing poured, in millilitres. */
  | { readonly kind: 'dress'; readonly ml: number; readonly atMs: number }
  | { readonly kind: 'toss'; readonly seconds: number; readonly atMs: number }
  /** Dressed-and-waiting: the cold kitchen's version of time on the heat. */
  | { readonly kind: 'rest'; readonly seconds: number; readonly atMs: number }
  | { readonly kind: 'wash'; readonly ingredient: string; readonly atMs: number }
  | { readonly kind: 'dry'; readonly ingredient: string; readonly atMs: number }
  | { readonly kind: 'taste'; readonly atMs: number }
  | { readonly kind: 'serve'; readonly atMs: number };

export interface Tally {
  readonly name: string;
  readonly count: number;
}

export interface BowlState {
  readonly contents: readonly Tally[];
  readonly seasonings: readonly Tally[];
  readonly dressingMl: number;
  readonly tossSeconds: number;
  readonly restSeconds: number;
  /** Ingredients in the order they first went in. Order is scoreable; a set would lose it. */
  readonly order: readonly string[];
  readonly washed: readonly string[];
  readonly dried: readonly string[];
  /** Total pieces in the bowl -- the proxy for how full it is. */
  readonly totalPieces: number;
  readonly tasteCount: number;
  /** Null until the cook tastes, dresses or serves. Times drive the ordering faults. */
  readonly firstDressedAtMs: number | null;
  readonly lastAddedAtMs: number | null;
  readonly servedAtMs: number | null;
  /** Delicate ingredients that went in before the last tossing bout, so got crushed. */
  readonly crushed: readonly string[];
  readonly actionCount: number;
}

function accumulate(pairs: readonly (readonly [string, number])[]): Tally[] {
  const totals = new Map<string, number>();
  for (const [name, n] of pairs) totals.set(name, (totals.get(name) ?? 0) + n);
  return [...totals].map(([name, count]) => ({ name, count }));
}

const firstAt = (actions: readonly CookAction[], kind: CookAction['kind']): number | null =>
  actions.find((a) => a.kind === kind)?.atMs ?? null;

export function bowlFrom(actions: readonly CookAction[]): BowlState {
  const adds = actions.filter((a): a is Extract<CookAction, { kind: 'add' }> => a.kind === 'add');
  const seasons = actions.filter((a): a is Extract<CookAction, { kind: 'season' }> => a.kind === 'season');

  const order: string[] = [];
  for (const a of adds) if (!order.includes(a.ingredient)) order.push(a.ingredient);

  const sumSeconds = (kind: 'toss' | 'rest'): number =>
    actions.reduce((t, a) => (a.kind === kind ? t + a.seconds : t), 0);

  // A delicate ingredient is crushed if any tossing happened after it went in. Checking against
  // tossing specifically, rather than against "later actions", is what makes this a real fault
  // instead of a rule about ordering for its own sake.
  const tossTimes = actions.filter((a) => a.kind === 'toss').map((a) => a.atMs);
  const crushed = [
    ...new Set(
      adds
        .filter((a) => a.delicate === true && tossTimes.some((t) => t > a.atMs))
        .map((a) => a.ingredient),
    ),
  ];

  return {
    contents: accumulate(adds.map((a) => [a.ingredient, a.count] as const)),
    seasonings: accumulate(seasons.map((a) => [a.seasoning, a.amount] as const)),
    dressingMl: actions.reduce((t, a) => (a.kind === 'dress' ? t + a.ml : t), 0),
    tossSeconds: sumSeconds('toss'),
    restSeconds: sumSeconds('rest'),
    order,
    washed: [...new Set(actions.filter((a) => a.kind === 'wash').map((a) => a.ingredient))],
    dried: [...new Set(actions.filter((a) => a.kind === 'dry').map((a) => a.ingredient))],
    totalPieces: adds.reduce((t, a) => t + a.count, 0),
    tasteCount: actions.filter((a) => a.kind === 'taste').length,
    firstDressedAtMs: firstAt(actions, 'dress'),
    lastAddedAtMs: adds.length === 0 ? null : Math.max(...adds.map((a) => a.atMs)),
    servedAtMs: firstAt(actions, 'serve'),
    crushed,
    actionCount: actions.length,
  };
}

export function countOf(tallies: readonly Tally[], name: string): number {
  return tallies.find((t) => t.name === name)?.count ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------------------------

export interface SeasoningRequirement {
  readonly seasoning: string;
  readonly pinches: Range;
}

/**
 * A timing band. Both ends are scored, which is the point.
 *
 * "Overcooking" and "undercooking" are one mechanic seen from two sides, and a band expresses
 * both with no special case. For a cold dish the bands are tossing and resting rather than
 * heat, but nothing about the shape changes when a hot dish is added.
 */
export interface TimingRequirement {
  readonly seconds: Range;
}

export interface KitchenRules {
  readonly seasonings: readonly SeasoningRequirement[];
  /** Millilitres of dressing per piece in the bowl. A ratio, so it scales with portion size. */
  readonly dressingMlPerPiece: Range;
  readonly toss: TimingRequirement;
  readonly rest: TimingRequirement;
  /** Ingredients that must be washed before use. */
  readonly mustWash: readonly string[];
  /** Ingredients that must be dried before dressing, or the dressing slides off. */
  readonly mustDry: readonly string[];
  /** Above this the bowl cannot be tossed without throwing half of it on the counter. */
  readonly bowlCapacityPieces: number;
  /** Seconds after dressing before the dish is past its best. */
  readonly servePromptlyWithinSec: number;
  /** The order the recipe builds in. */
  readonly buildOrder: readonly string[];
}

export const DEFAULT_RULES: KitchenRules = {
  seasonings: [{ seasoning: 'salt', pinches: { min: 2, max: 5 } }],
  // TUNED, not sourced: roughly a tablespoon of vinaigrette per four pieces, which is the
  // lightly-dressed end of normal. Wants checking against a real bowl before anyone trusts it.
  dressingMlPerPiece: { min: 1.5, max: 4 },
  toss: { seconds: { min: 6, max: 20 } },
  rest: { seconds: { min: 0, max: 120 } },
  mustWash: [],
  mustDry: [],
  bowlCapacityPieces: 40,
  servePromptlyWithinSec: 180,
  buildOrder: [],
};

// ---------------------------------------------------------------------------------------------
// The faults
// ---------------------------------------------------------------------------------------------

/** How far outside a range, relative to the bound missed. Zero when inside. */
function outByFraction(x: number, r: Range): number {
  if (x < r.min) return r.min === 0 ? r.min - x : (r.min - x) / r.min;
  if (x > r.max) return r.max === 0 ? x - r.max : (x - r.max) / r.max;
  return 0;
}

const make = (
  kind: Deficit['kind'],
  ingredient: string | null,
  observed: number | null,
  required: Range | null,
  severity: Severity,
  magnitude: number,
  instruction: string,
): Deficit => ({ kind, ingredient, observed, required, severity, magnitude, instruction });

const round = (x: number): number => Math.round(x);

/**
 * Every fault in the bowl, worst first.
 *
 * Pure and total: same actions and rules in, same list out, no clock and no I/O. The caller
 * supplies `nowMs` so an unfinished session can still be judged on elapsed time, and so a
 * recorded session replays to identical results.
 */
export function faults(bowl: BowlState, rules: KitchenRules, nowMs: number): Deficit[] {
  const found: Deficit[] = [];
  const nothingYet = bowl.totalPieces === 0;

  // --- Seasoning. The most common fault in home cooking, and invisible to any camera. ---
  for (const req of rules.seasonings) {
    const got = countOf(bowl.seasonings, req.seasoning);
    if (got >= req.pinches.min && got <= req.pinches.max) continue;
    const low = got < req.pinches.min;
    found.push(make(
      low ? 'seasoning-low' : 'seasoning-high',
      req.seasoning, got, req.pinches, 'major',
      outByFraction(got, req.pinches),
      low
        ? got === 0
          ? `No ${req.seasoning} yet — this is the one thing most people under-do`
          : `More ${req.seasoning} — ${got} pinches in, wants ${req.pinches.min}–${req.pinches.max}`
        : `Too much ${req.seasoning} — ${got} pinches against ${req.pinches.max} max, and you cannot take it out`,
    ));
  }

  // --- Washing. Skipped constantly. Blocking because it is a safety matter, not a taste one. ---
  for (const item of rules.mustWash) {
    if (countOf(bowl.contents, item) === 0) continue;
    if (bowl.washed.includes(item)) continue;
    found.push(make(
      'unwashed', item, null, null, 'blocking', 1,
      `The ${item} went in unwashed — take it out and rinse it`,
    ));
  }

  // --- Wet leaves. The invisible cause of a dish that never comes together. ---
  for (const item of rules.mustDry) {
    if (countOf(bowl.contents, item) === 0) continue;
    if (bowl.dried.includes(item)) continue;
    found.push(make(
      'wet-greens', item, null, null,
      // Major, not minor: dressing will not cling to a wet leaf, so this quietly defeats
      // everything the cook does afterwards.
      'major', 0.9,
      `The ${item} is still wet — dressing slides straight off, spin or pat it dry first`,
    ));
  }

  // --- Overcrowding. Everyone does it, and it makes tossing physically impossible. ---
  if (bowl.totalPieces > rules.bowlCapacityPieces) {
    found.push(make(
      'overcrowded', null, bowl.totalPieces,
      { min: 0, max: rules.bowlCapacityPieces }, 'major',
      outByFraction(bowl.totalPieces, { min: 0, max: rules.bowlCapacityPieces }),
      `Bowl is overfull at ${bowl.totalPieces} pieces — you cannot toss this without wearing it`,
    ));
  }

  // --- Dressing, as a ratio to what is in the bowl rather than an absolute. ---
  if (!nothingYet && bowl.dressingMl > 0) {
    const perPiece = bowl.dressingMl / bowl.totalPieces;
    const r = rules.dressingMlPerPiece;
    if (perPiece < r.min || perPiece > r.max) {
      const under = perPiece < r.min;
      found.push(make(
        under ? 'under-dressed' : 'over-dressed', null, perPiece, r, 'major',
        outByFraction(perPiece, r),
        under
          ? `Under-dressed — ${round(bowl.dressingMl)}ml for ${bowl.totalPieces} pieces reads dry`
          : `Over-dressed — ${round(bowl.dressingMl)}ml is drowning ${bowl.totalPieces} pieces, and it cannot be undone`,
      ));
    }
  }

  // --- Dressing before everything is in. Ordering fault with a real consequence. ---
  if (bowl.firstDressedAtMs !== null && bowl.lastAddedAtMs !== null
      && bowl.lastAddedAtMs > bowl.firstDressedAtMs) {
    found.push(make(
      'dressed-too-early', null, null, null, 'major', 0.8,
      'You dressed before everything was in — the later ingredients go in unseasoned',
    ));
  }

  // --- Delicate things crushed under the tossing. ---
  for (const item of bowl.crushed) {
    found.push(make(
      'delicate-crushed', item, null, null, 'minor', 0.5,
      `The ${item} went in before tossing and got bruised — fold delicate things in at the end`,
    ));
  }

  // --- Tossing, both ends of the band. ---
  if (!nothingYet) {
    const t = rules.toss.seconds;
    if (bowl.tossSeconds < t.min || bowl.tossSeconds > t.max) {
      const under = bowl.tossSeconds < t.min;
      found.push(make(
        under ? 'under-mixed' : 'over-mixed', null, bowl.tossSeconds, t,
        under ? 'major' : 'minor',
        outByFraction(bowl.tossSeconds, t),
        under
          ? `Keep tossing — ${round(bowl.tossSeconds)}s so far, and the seasoning is still sitting in one place`
          : `Stop tossing — ${round(bowl.tossSeconds)}s is past ${t.max}s and the leaves are bruising`,
      ));
    }
  }

  // --- Build order. ---
  if (rules.buildOrder.length > 0) {
    const got = bowl.order.filter((i) => rules.buildOrder.includes(i));
    const wanted = rules.buildOrder.filter((i) => got.includes(i));
    const firstWrong = got.findIndex((name, i) => wanted[i] !== name);
    if (firstWrong !== -1) {
      found.push(make(
        'wrong-order', got[firstWrong] ?? null, firstWrong, null,
        // Minor deliberately: order matters far less in a cold dish than a walkthrough implies,
        // and calling it blocking would teach the player to distrust the ranking.
        'minor', 1 / (firstWrong + 1),
        `${got[firstWrong]} went in before ${wanted[firstWrong]} — the recipe builds the other way round`,
      ));
    }
  }

  // --- Never tasted. The most-repeated advice in every kitchen there has ever been. ---
  if (!nothingYet && bowl.tasteCount === 0) {
    found.push(make(
      'not-tasted', null, 0, null, 'major', 0.85,
      'You have not tasted it once — taste before it leaves the bowl',
    ));
  }

  // --- Resting and serving. ---
  const r = rules.rest.seconds;
  if (bowl.restSeconds > r.max) {
    found.push(make(
      'over-rested', null, bowl.restSeconds, r, 'minor',
      outByFraction(bowl.restSeconds, r),
      `Sat for ${round(bowl.restSeconds)}s — past ${r.max}s the dressing goes limp`,
    ));
  }

  if (bowl.firstDressedAtMs !== null && bowl.servedAtMs === null) {
    const sinceSec = (nowMs - bowl.firstDressedAtMs) / 1000;
    if (sinceSec > rules.servePromptlyWithinSec) {
      found.push(make(
        'served-late', null, sinceSec, null, 'major', 0.7,
        `Dressed ${round(sinceSec)}s ago and still not served — it is turning to soup`,
      ));
    }
  }

  const RANK: Record<Severity, number> = { blocking: 0, major: 1, minor: 2 };
  return found.sort((a, b) =>
    RANK[a.severity] - RANK[b.severity] || b.magnitude - a.magnitude);
}
