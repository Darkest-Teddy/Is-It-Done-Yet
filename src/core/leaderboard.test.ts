import { describe, expect, it } from 'vitest';
import { add, entryFrom, type Entry, MAX_ENTRIES, parseEntries, positionOf, rank } from './leaderboard.js';
import type { Score } from './scoring.js';

const score = (over: Partial<Score> = {}): Score => ({
  meanMm: 6, sigmaMm: 0.4, meanAngleDeg: null,
  accuracy: 0.9, uniformity: 0.9, angleScore: null, total: 0.9, count: 6, ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  name: 'a', recipeId: 'sandwich', meanMm: 6, sigmaMm: 0.4, total: 0.9, cuts: 6, at: 1000, ...over,
});

describe('entryFrom', () => {
  it('carries the score through', () => {
    const e = entryFrom('Dana', 'sandwich', score(), 1234)!;
    expect(e).toMatchObject({ name: 'Dana', recipeId: 'sandwich', cuts: 6, at: 1234 });
  });

  /** Otherwise the board fills with people who picked up the knife and put it down again. */
  it('refuses a session with no cuts in it', () => {
    expect(entryFrom('Dana', 'sandwich', score({ count: 0 }), 1)).toBeNull();
  });

  it('names an empty entry rather than showing a blank row', () => {
    expect(entryFrom('   ', 'sandwich', score(), 1)?.name).toBe('anonymous');
  });

  it('caps a name that would push the board sideways', () => {
    const e = entryFrom('x'.repeat(100), 'sandwich', score(), 1)!;
    expect(e.name).toHaveLength(24);
  });
});

describe('rank', () => {
  it('puts the best total first', () => {
    const ranked = rank([entry({ name: 'low', total: 0.2 }), entry({ name: 'high', total: 0.8 })]);
    expect(ranked.map((e) => e.name)).toEqual(['high', 'low']);
  });

  it('breaks a tie on slice count, twelve slices being harder than three', () => {
    const ranked = rank([entry({ name: 'few', cuts: 3 }), entry({ name: 'many', cuts: 12 })]);
    expect(ranked[0]!.name).toBe('many');
  });

  it('breaks a full tie on recency, so the person who just played can find themselves', () => {
    const ranked = rank([entry({ name: 'old', at: 1 }), entry({ name: 'new', at: 2 })]);
    expect(ranked[0]!.name).toBe('new');
  });

  it('does not mutate what it was given', () => {
    const input = [entry({ total: 0.1 }), entry({ total: 0.9 })];
    const copy = [...input];
    rank(input);
    expect(input).toEqual(copy);
  });
});

describe('add', () => {
  it('inserts in rank order', () => {
    const board = add([entry({ name: 'a', total: 0.5 })], entry({ name: 'b', total: 0.7 }));
    expect(board.map((e) => e.name)).toEqual(['b', 'a']);
  });

  it('keeps the board bounded across a long night', () => {
    let board: readonly Entry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 20; i++) {
      board = add(board, entry({ name: `p${i}`, total: i / 100, at: i }));
    }
    expect(board).toHaveLength(MAX_ENTRIES);
    // And it is the WORST that fell off, not the newest.
    expect(board[0]!.total).toBeGreaterThan(board[board.length - 1]!.total);
  });
});

describe('positionOf', () => {
  it('is one-based, so it reads as a position', () => {
    expect(positionOf([], entry())).toBe(1);
  });

  it('counts only the entries genuinely ahead', () => {
    const board = [entry({ total: 0.95 }), entry({ total: 0.85 }), entry({ total: 0.5 })];
    expect(positionOf(board, entry({ total: 0.9 }))).toBe(2);
  });

  it('does not add the entry it was asked about', () => {
    const board = [entry({ total: 0.95 })];
    positionOf(board, entry({ total: 0.9 }));
    expect(board).toHaveLength(1);
  });
});

describe('parseEntries', () => {
  it('reads back what was written', () => {
    const board = [entry({ name: 'a' }), entry({ name: 'b' })];
    expect(parseEntries(JSON.parse(JSON.stringify(board)))).toEqual(board);
  });

  /** Rows on disk are input, not trusted state: a half-written file must not crash the board. */
  it('drops rows that are not entries, rather than trusting or throwing', () => {
    expect(parseEntries([entry(), null, 'nope', {}, { name: 'x', recipeId: 'y' },
      { ...entry(), total: Number.NaN }])).toHaveLength(1);
  });

  it('returns nothing for anything that is not a list', () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries({ entries: [] })).toEqual([]);
    expect(parseEntries('[]')).toEqual([]);
  });
});
