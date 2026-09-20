import { describe, expect, it } from 'vitest';
import { boardState, type Piece } from './board.js';
import {
  DEFAULT_DIFF_OPTIONS,
  diff,
  isServable,
  topDeficit,
  type Deficit,
  type DeficitKind,
  type DiffOptions,
} from './deficit.js';
import type { Recipe } from './recipe.js';

const piece = (over: Partial<Piece> = {}): Piece => ({
  ingredient: 'cucumber',
  confidence: 0.9,
  areaPx: 1000,
  centroid: { x: 0, y: 0 },
  minorPx: 20,
  ...over,
});

/** Two ingredients, every check enabled, so tests can violate one rule at a time. */
const RECIPE: Recipe = {
  id: 'test',
  name: 'Test Salad',
  description: 'A fixture.',
  difficulty: 'easy',
  averageMinutes: 10,
  icon: '🥗',
  tags: [],
  requires: [
    {
      ingredient: 'cucumber',
      count: { min: 2, max: 4 },
      areaShare: { min: 0.4, max: 0.6 },
      thicknessMm: { min: 4, max: 6 },
    },
    { ingredient: 'tomato', count: { min: 2, max: 4 }, areaShare: { min: 0.4, max: 0.6 } },
  ],
  steps: [
    { id: 'chop', instruction: 'Chop everything', verifiable: 'vision' },
    { id: 'season', instruction: 'Salt to taste', verifiable: 'cook-confirmed' },
  ],
  minMixRatio: 0.55,
};

/** Scatters n pieces along a line so spread is non-trivial and mixing passes by default. */
const spread = (ingredient: string, n: number, over: Partial<Piece> = {}): Piece[] =>
  Array.from({ length: n }, (_unused, i) =>
    piece({ ingredient, centroid: { x: i * 50 - (n - 1) * 25, y: 0 }, ...over }),
  );

/** A board that satisfies RECIPE completely: 3 of each, equal area, 5mm, well mixed. */
const goodBoard = () =>
  boardState(
    [
      ...spread('cucumber', 3, { areaPx: 1000, minorPx: 20 }),
      ...spread('tomato', 3, { areaPx: 1000, minorPx: 20 }),
    ],
    4,
  );

const kinds = (ds: readonly Deficit[]): DeficitKind[] => ds.map((d) => d.kind);
const of = (ds: readonly Deficit[], kind: DeficitKind): Deficit | undefined =>
  ds.find((d) => d.kind === kind);

/** Seasoning confirmed, so the unavoidable confirmation prompt stays out of the way. */
const CONFIRMED: DiffOptions = {
  ...DEFAULT_DIFF_OPTIONS,
  confirmedSteps: new Set(['season']),
};

describe('diff', () => {
  it('finds nothing wrong with a correct board', () => {
    expect(diff(goodBoard(), RECIPE, CONFIRMED)).toEqual([]);
  });

  describe('missing ingredients', () => {
    it('reports a blocking deficit when an ingredient is absent', () => {
      const state = boardState(spread('cucumber', 3), 4);
      const d = of(diff(state, RECIPE, CONFIRMED), 'ingredient-missing');
      expect(d?.ingredient).toBe('tomato');
      expect(d?.severity).toBe('blocking');
    });

    it('does not also complain about the count of an ingredient that is not there', () => {
      const state = boardState(spread('cucumber', 3), 4);
      const found = diff(state, RECIPE, CONFIRMED).filter((d) => d.ingredient === 'tomato');
      // One deficit about tomato, not three derived from an empty tally.
      expect(kinds(found)).toEqual(['ingredient-missing']);
    });
  });

  describe('counts', () => {
    it('asks for more when short, naming how many', () => {
      const state = boardState([...spread('cucumber', 1), ...spread('tomato', 3)], 4);
      const d = of(diff(state, RECIPE, CONFIRMED), 'count-short');
      expect(d?.ingredient).toBe('cucumber');
      expect(d?.instruction).toContain('Add 1 more cucumber');
    });

    it('asks for fewer when over', () => {
      const state = boardState([...spread('cucumber', 6), ...spread('tomato', 3)], 4);
      const d = of(diff(state, RECIPE, CONFIRMED), 'count-excess');
      expect(d?.instruction).toContain('Take 2 cucumber off');
    });
  });

  describe('proportion', () => {
    it('flags an ingredient that dominates the bowl by area', () => {
      const state = boardState(
        [
          ...spread('cucumber', 3, { areaPx: 5000 }),
          ...spread('tomato', 3, { areaPx: 200 }),
        ],
        4,
      );
      const found = diff(state, RECIPE, CONFIRMED);
      expect(of(found, 'proportion-high')?.ingredient).toBe('cucumber');
      expect(of(found, 'proportion-low')?.ingredient).toBe('tomato');
    });
  });

  describe('thickness', () => {
    it('says cut thinner when slices are over the range', () => {
      const state = boardState(
        [...spread('cucumber', 3, { minorPx: 40 }), ...spread('tomato', 3)],
        4,
      );
      const d = of(diff(state, RECIPE, CONFIRMED), 'cut-too-thick');
      expect(d?.instruction).toContain('10mm');
      expect(d?.instruction).toContain('thinner');
    });

    it('stays silent about thickness when the board is uncalibrated', () => {
      const state = boardState([...spread('cucumber', 3), ...spread('tomato', 3)], null);
      const found = kinds(diff(state, RECIPE, CONFIRMED));
      expect(found).not.toContain('cut-too-thick');
      expect(found).not.toContain('cut-too-thin');
      expect(found).not.toContain('cut-uneven');
    });

    it('flags scatter above the CV threshold', () => {
      const state = boardState(
        [
          piece({ ingredient: 'cucumber', minorPx: 8, centroid: { x: -50, y: 0 } }),
          piece({ ingredient: 'cucumber', minorPx: 20, centroid: { x: 0, y: 0 } }),
          piece({ ingredient: 'cucumber', minorPx: 32, centroid: { x: 50, y: 0 } }),
          ...spread('tomato', 3),
        ],
        4,
      );
      expect(kinds(diff(state, RECIPE, CONFIRMED))).toContain('cut-uneven');
    });
  });

  describe('mixing', () => {
    it('flags an ingredient clumped in one corner', () => {
      const state = boardState(
        [
          // Cucumber piled together while tomato covers the board.
          piece({ ingredient: 'cucumber', centroid: { x: -200, y: 0 } }),
          piece({ ingredient: 'cucumber', centroid: { x: -198, y: 0 } }),
          piece({ ingredient: 'cucumber', centroid: { x: -196, y: 0 } }),
          ...spread('tomato', 3),
          piece({ ingredient: 'tomato', centroid: { x: 200, y: 0 } }),
        ],
        4,
      );
      const d = of(diff(state, RECIPE, CONFIRMED), 'unmixed');
      expect(d?.ingredient).toBe('cucumber');
    });

    it('does not judge mixing from too few pieces', () => {
      const opts: DiffOptions = { ...CONFIRMED, minPiecesForMixCheck: 99 };
      const state = boardState(
        [
          piece({ ingredient: 'cucumber', centroid: { x: -200, y: 0 } }),
          piece({ ingredient: 'cucumber', centroid: { x: -199, y: 0 } }),
          ...spread('tomato', 3),
        ],
        4,
      );
      expect(kinds(diff(state, RECIPE, opts))).not.toContain('unmixed');
    });
  });

  describe('unexpected ingredients', () => {
    it('mentions them, but only as a minor note', () => {
      const state = boardState(
        [...spread('cucumber', 3), ...spread('tomato', 3), ...spread('lemon', 2)],
        4,
      );
      const d = of(diff(state, RECIPE, CONFIRMED), 'unexpected-ingredient');
      expect(d?.ingredient).toBe('lemon');
      expect(d?.severity).toBe('minor');
    });
  });

  describe('steps the camera cannot check', () => {
    it('prompts for confirmation instead of assuming, and says why', () => {
      const d = of(diff(goodBoard(), RECIPE, DEFAULT_DIFF_OPTIONS), 'needs-confirmation');
      expect(d?.instruction).toContain('cannot see');
      expect(d?.instruction).toContain('Salt to taste');
    });

    it('stops prompting once confirmed', () => {
      const found = kinds(diff(goodBoard(), RECIPE, CONFIRMED));
      expect(found).not.toContain('needs-confirmation');
    });

    it('never prompts for a step vision can check', () => {
      const found = diff(goodBoard(), RECIPE, DEFAULT_DIFF_OPTIONS);
      expect(found.every((d) => !d.instruction.includes('Chop everything'))).toBe(true);
    });
  });

  describe('ordering', () => {
    it('puts a missing ingredient ahead of a craft note', () => {
      const state = boardState(spread('cucumber', 3, { minorPx: 40 }), 4);
      expect(topDeficit(diff(state, RECIPE, CONFIRMED))?.kind).toBe('ingredient-missing');
    });

    it('returns null for a clean board', () => {
      expect(topDeficit(diff(goodBoard(), RECIPE, CONFIRMED))).toBeNull();
    });
  });

  describe('isServable', () => {
    it('is true for a clean board', () => {
      expect(isServable(diff(goodBoard(), RECIPE, CONFIRMED))).toBe(true);
    });

    it('stays true when only craft notes remain', () => {
      const state = boardState(
        [...spread('cucumber', 3, { minorPx: 40 }), ...spread('tomato', 3)],
        4,
      );
      const found = diff(state, RECIPE, CONFIRMED);
      expect(kinds(found)).toContain('cut-too-thick');
      expect(isServable(found)).toBe(true);
    });

    it('is false when an ingredient is missing', () => {
      const state = boardState(spread('cucumber', 3), 4);
      expect(isServable(diff(state, RECIPE, CONFIRMED))).toBe(false);
    });
  });
});
