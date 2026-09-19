import type { Score } from './scoring.js';

/**
 * The booth leaderboard.
 *
 * Master spec 12 wants shared scores on a monitor beside the table, because people come back to
 * beat their number, a crowd forms, and judges notice crowds. That effect needs the scores to
 * persist and to be visible. It does not need a server: at a booth with one laptop, every
 * player is on the same machine, so local storage IS the shared store. Rule #12 again --
 * whatever survives bad wifi.
 *
 * This module is pure. It takes and returns plain data and knows nothing about storage; the
 * caller supplies the rows and decides where to keep them. That is what makes the ranking
 * rules testable, and it is the seam a real server would slot into without touching any of the
 * logic below.
 */

export interface Entry {
  readonly name: string;
  readonly recipeId: string;
  readonly meanMm: number;
  readonly sigmaMm: number;
  readonly total: number;
  readonly cuts: number;
  /** Epoch milliseconds. */
  readonly at: number;
}

export const MAX_ENTRIES = 50;

export function entryFrom(
  name: string, recipeId: string, score: Score, at: number,
): Entry | null {
  // A session with nothing in it is not a result. Recording zero-cut entries would fill the
  // board with people who picked up the knife and put it down again.
  if (score.count === 0) return null;
  const trimmed = name.trim();
  return {
    name: trimmed === '' ? 'anonymous' : trimmed.slice(0, 24),
    recipeId,
    meanMm: score.meanMm,
    sigmaMm: score.sigmaMm,
    total: score.total,
    cuts: score.count,
    at,
  };
}

/**
 * Best first.
 *
 * Ranked on the aggregate score rather than on raw consistency, so that hitting the ticket you
 * were actually given counts for something. Ties break on slice count -- twelve consistent
 * slices is a harder thing than three -- and then on recency, so the most recent of two
 * identical runs sits higher and the person who just played can find themselves.
 */
export function rank(entries: readonly Entry[]): readonly Entry[] {
  return [...entries].sort((a, b) =>
    b.total - a.total || b.cuts - a.cuts || b.at - a.at);
}

/** Adds an entry and keeps the board bounded, so a long night cannot grow it without limit. */
export function add(entries: readonly Entry[], entry: Entry): readonly Entry[] {
  return rank([...entries, entry]).slice(0, MAX_ENTRIES);
}

/**
 * Where a score WOULD land, without adding it.
 *
 * One-based, so it reads as a position. Shown live while somebody is still cutting, which is
 * the thing that actually makes them want another go.
 */
export function positionOf(entries: readonly Entry[], entry: Entry): number {
  return rank(entries).filter((e) =>
    e.total > entry.total
    || (e.total === entry.total && e.cuts > entry.cuts)).length + 1;
}

/** Narrows anything read back from storage. Rows on disk are input, not trusted state. */
export function parseEntries(raw: unknown): readonly Entry[] {
  if (!Array.isArray(raw)) return [];
  const out: Entry[] = [];
  for (const row of raw as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.recipeId !== 'string') continue;
    const nums = [r.meanMm, r.sigmaMm, r.total, r.cuts, r.at];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    out.push({
      name: r.name, recipeId: r.recipeId,
      meanMm: r.meanMm as number, sigmaMm: r.sigmaMm as number,
      total: r.total as number, cuts: r.cuts as number, at: r.at as number,
    });
  }
  return out;
}
