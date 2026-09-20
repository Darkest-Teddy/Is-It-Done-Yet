import { describe, expect, it } from 'vitest';
import { boardState, tallyFor, type Piece } from './board.js';

/** A piece with sane defaults, so each test only states the field it is actually about. */
const piece = (over: Partial<Piece> = {}): Piece => ({
  ingredient: 'cucumber',
  confidence: 0.9,
  areaPx: 1000,
  centroid: { x: 0, y: 0 },
  minorPx: 10,
  ...over,
});

describe('boardState', () => {
  it('is empty for no pieces, and reports no area rather than dividing by zero', () => {
    const s = boardState([]);
    expect(s.tallies).toEqual([]);
    expect(s.totalAreaPx).toBe(0);
    expect(s.pieceCount).toBe(0);
    expect(s.spreadPx).toBe(0);
  });

  it('groups pieces by ingredient and counts them', () => {
    const s = boardState([
      piece({ ingredient: 'cucumber' }),
      piece({ ingredient: 'cucumber' }),
      piece({ ingredient: 'tomato' }),
    ]);
    expect(tallyFor(s, 'cucumber')?.count).toBe(2);
    expect(tallyFor(s, 'tomato')?.count).toBe(1);
    expect(s.pieceCount).toBe(3);
  });

  it('reports area share as a fraction of the board, summing to one', () => {
    const s = boardState([
      piece({ ingredient: 'cucumber', areaPx: 3000 }),
      piece({ ingredient: 'tomato', areaPx: 1000 }),
    ]);
    expect(tallyFor(s, 'cucumber')?.areaShare).toBeCloseTo(0.75);
    expect(tallyFor(s, 'tomato')?.areaShare).toBeCloseTo(0.25);
    const total = s.tallies.reduce((a, t) => a + t.areaShare, 0);
    expect(total).toBeCloseTo(1);
  });

  it('sorts tallies by area so the dominant ingredient leads', () => {
    const s = boardState([
      piece({ ingredient: 'tomato', areaPx: 500 }),
      piece({ ingredient: 'cucumber', areaPx: 5000 }),
    ]);
    expect(s.tallies[0]?.ingredient).toBe('cucumber');
  });

  it('drops pieces below the confidence floor', () => {
    const s = boardState([piece({ confidence: 0.9 }), piece({ confidence: 0.1 })]);
    expect(s.pieceCount).toBe(1);
  });

  it('drops zero-area pieces, which would otherwise poison the area share', () => {
    const s = boardState([piece({ areaPx: 1000 }), piece({ areaPx: 0 })]);
    expect(s.pieceCount).toBe(1);
  });

  describe('thickness', () => {
    it('is null without calibration rather than silently reporting pixels as millimetres', () => {
      const s = boardState([piece({ minorPx: 10 })]);
      expect(tallyFor(s, 'cucumber')?.meanThicknessMm).toBeNull();
    });

    it('is null for a non-positive calibration', () => {
      const s = boardState([piece({ minorPx: 10 })], 0);
      expect(tallyFor(s, 'cucumber')?.meanThicknessMm).toBeNull();
    });

    it('converts the minor axis through the calibration', () => {
      const s = boardState([piece({ minorPx: 20 }), piece({ minorPx: 40 })], 4);
      expect(tallyFor(s, 'cucumber')?.meanThicknessMm).toBeCloseTo(7.5);
    });
  });

  describe('thicknessCvPct', () => {
    it('is null for a single piece, where spread is undefined rather than zero', () => {
      const s = boardState([piece({ minorPx: 20 })], 4);
      expect(tallyFor(s, 'cucumber')?.thicknessCvPct).toBeNull();
    });

    it('is zero for identical pieces', () => {
      const s = boardState([piece({ minorPx: 20 }), piece({ minorPx: 20 })], 4);
      expect(tallyFor(s, 'cucumber')?.thicknessCvPct).toBeCloseTo(0);
    });

    it('scales with relative scatter, not absolute -- the point of using a CV', () => {
      const thin = boardState([piece({ minorPx: 8 }), piece({ minorPx: 12 })], 4);
      const thick = boardState([piece({ minorPx: 80 }), piece({ minorPx: 120 })], 4);
      // Same 20% scatter at two very different thicknesses must score the same.
      expect(tallyFor(thin, 'cucumber')?.thicknessCvPct).toBeCloseTo(
        tallyFor(thick, 'cucumber')?.thicknessCvPct ?? -1,
      );
    });
  });

  describe('spread', () => {
    it('is zero for a single piece', () => {
      const s = boardState([piece({ centroid: { x: 5, y: 5 } })]);
      expect(tallyFor(s, 'cucumber')?.spreadPx).toBeCloseTo(0);
    });

    it('measures RMS distance from the ingredient centroid', () => {
      const s = boardState([
        piece({ centroid: { x: -3, y: 0 } }),
        piece({ centroid: { x: 3, y: 0 } }),
      ]);
      expect(tallyFor(s, 'cucumber')?.spreadPx).toBeCloseTo(3);
    });

    it('is smaller than the board spread when one ingredient is clumped', () => {
      const s = boardState([
        // Cucumber clustered tightly at the left.
        piece({ ingredient: 'cucumber', centroid: { x: -100, y: 0 } }),
        piece({ ingredient: 'cucumber', centroid: { x: -98, y: 0 } }),
        // Tomato spread across the rest of the board.
        piece({ ingredient: 'tomato', centroid: { x: 0, y: 0 } }),
        piece({ ingredient: 'tomato', centroid: { x: 100, y: 0 } }),
      ]);
      const cuc = tallyFor(s, 'cucumber');
      expect(cuc).not.toBeNull();
      expect(cuc!.spreadPx).toBeLessThan(s.spreadPx);
    });
  });
});
