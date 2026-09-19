import { describe, expect, it } from 'vitest';
import type { ShapeFeatures } from '../core/ingredients.js';
import { calibrate, piecesFrom } from './pieces.js';
import type { Blob } from './segment.js';

/** A blob shaped like a cucumber slice unless a test says otherwise. */
const blob = (features: Partial<ShapeFeatures>, over: Partial<Omit<Blob, 'features'>> = {}): Blob => ({
  features: {
    hueDeg: 95,
    saturation: 0.5,
    value: 0.6,
    elongation: 4,
    solidity: 0.95,
    circularity: 0.5,
    ...features,
  },
  areaPx: 1200,
  centroid: { x: 10, y: 20 },
  rect: { centre: { x: 10, y: 20 }, majorPx: 80, minorPx: 20, angleDeg: 0 },
  contour: [],
  ...over,
});

describe('piecesFrom', () => {
  it('names a blob that matches a profile', () => {
    const [p] = piecesFrom([blob({})]);
    expect(p?.ingredient).toBe('cucumber');
    expect(p?.confidence).toBeGreaterThan(0);
  });

  it('carries area and centroid through unchanged', () => {
    const [p] = piecesFrom([blob({}, { areaPx: 999, centroid: { x: 3, y: 4 } })]);
    expect(p?.areaPx).toBe(999);
    expect(p?.centroid).toEqual({ x: 3, y: 4 });
  });

  it('takes thickness from the oriented rect minor axis, not the major', () => {
    const [p] = piecesFrom([
      blob({}, { rect: { centre: { x: 0, y: 0 }, majorPx: 200, minorPx: 12, angleDeg: 37 } }),
    ]);
    expect(p?.minorPx).toBe(12);
  });

  it('drops a blob no profile claims, rather than inventing a label', () => {
    // Grey: saturation below every profile's floor, so nothing scores above zero.
    expect(piecesFrom([blob({ saturation: 0.01 })])).toEqual([]);
  });

  it('keeps the confident blobs and drops the unnamed ones from the same frame', () => {
    const named = piecesFrom([blob({}), blob({ saturation: 0.01 }), blob({})]);
    expect(named).toHaveLength(2);
  });
});

describe('calibrate', () => {
  it('returns pixels per millimetre', () => {
    expect(calibrate(600, 300)).toBeCloseTo(2);
  });

  it.each([
    ['zero pixels', 0, 300],
    ['zero millimetres', 600, 0],
    ['negative width', -600, 300],
    ['NaN', Number.NaN, 300],
    ['Infinity', Number.POSITIVE_INFINITY, 300],
  ])('returns null for %s rather than a poisoned scale', (_label, px, mm) => {
    expect(calibrate(px, mm)).toBeNull();
  });
});
