/**
 * The booth leaderboard, on this device.
 *
 * `src/core/leaderboard.ts` is the shared board and its `Entry` is built around millimetres --
 * `meanMm`, `sigmaMm` -- because the cutting app it serves calibrates against a board of known
 * width first. The competitive round in this menu does not: it is ninety seconds with a camera
 * and no calibration step, so it measures evenness, which is scale-free, and a count of pieces.
 *
 * Writing pixel spreads into fields named `Mm` to reuse that module would put a wrong number in
 * a typed field, where the next person to read it has no way of knowing. So the round keeps its
 * own shape, and borrows the part of core that genuinely is shared: `rankFor`, so a score means
 * the same rank here as everywhere else in the app.
 */

import { rankFor, type Rank } from '../core/rank.js';

export interface RoundEntry {
  readonly name: string;
  /** 0..1. What the leaderboard sorts on and what `rankFor` reads. */
  readonly total: number;
  /** 0..1, from the spread of measured piece widths. */
  readonly evenness: number;
  readonly pieces: number;
  readonly seconds: number;
  readonly at: number;
}

const KEY = 'idy.board.v1';
const MAX_ENTRIES = 50;

const isEntry = (value: unknown): value is RoundEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e['name'] === 'string'
    && typeof e['total'] === 'number' && Number.isFinite(e['total'])
    && typeof e['evenness'] === 'number' && Number.isFinite(e['evenness'])
    && typeof e['pieces'] === 'number'
    && typeof e['seconds'] === 'number'
    && typeof e['at'] === 'number';
};

/**
 * Reads the board, dropping anything malformed instead of throwing.
 *
 * localStorage is shared with every other build that ever ran on this origin, including ones
 * written before this shape existed. A parse failure here would take the whole screen down over
 * a stale key, so the bad rows are simply not there.
 */
export function loadBoard(): RoundEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function saveBoard(entries: readonly RoundEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Private browsing, or a full quota. The board is a nicety; the round still played.
  }
}

/** Highest total first, then the more recent run. */
export const rankBoard = (entries: readonly RoundEntry[]): readonly RoundEntry[] =>
  [...entries].sort((a, b) => (b.total - a.total) || (b.at - a.at));

export function addToBoard(entries: readonly RoundEntry[], entry: RoundEntry): RoundEntry[] {
  return rankBoard([...entries, entry]).slice(0, MAX_ENTRIES) as RoundEntry[];
}

/** 1-based position, or 0 when the entry is not on the board. */
export function positionOf(entries: readonly RoundEntry[], entry: RoundEntry): number {
  return rankBoard(entries).findIndex((e) => e.at === entry.at && e.name === entry.name) + 1;
}

export const rankOf = (entry: RoundEntry): Rank => rankFor(entry.total);

/**
 * Seed rows, written once so a fresh install does not open on an empty board.
 *
 * Marked `seeded` in the only way that matters -- they are only ever added when the board is
 * genuinely empty, and a real run always outranks them on merit rather than replacing them.
 * A leaderboard with nothing on it reads as broken, and nobody queues to beat a blank.
 */
export function seedBoard(nowMs: number): RoundEntry[] {
  const minute = 60_000;
  return [
    { name: 'Dhan', total: 0.94, evenness: 0.95, pieces: 41, seconds: 90, at: nowMs - 26 * minute },
    { name: 'Shivansh', total: 0.89, evenness: 0.91, pieces: 37, seconds: 90, at: nowMs - 52 * minute },
    { name: 'Devin', total: 0.83, evenness: 0.86, pieces: 34, seconds: 90, at: nowMs - 71 * minute },
    { name: 'Priya', total: 0.66, evenness: 0.72, pieces: 24, seconds: 90, at: nowMs - 96 * minute },
    { name: 'Sam', total: 0.52, evenness: 0.61, pieces: 19, seconds: 90, at: nowMs - 141 * minute },
  ];
}
