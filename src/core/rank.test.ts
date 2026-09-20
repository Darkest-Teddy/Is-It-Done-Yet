import { describe, expect, it } from 'vitest';
import { critiqueOf, progressFor, RANKS, rankFor } from './rank.js';
import type { Score } from './scoring.js';

const score = (over: Partial<Score> = {}): Score => ({
  meanMm: 5, sigmaMm: 0.4, meanAngleDeg: null,
  accuracy: 0.9, uniformity: 0.9, angleScore: null,
  total: 0.9, count: 12,
  ...over,
});

describe('rankFor', () => {
  it('puts a zero score at the bottom rather than returning nothing', () => {
    expect(rankFor(0).id).toBe('prep');
  });

  it('awards the highest tier a total qualifies for, not the first match', () => {
    expect(rankFor(0.99).id).toBe('executive');
  });

  it('is inclusive at a tier boundary', () => {
    const sous = RANKS.find((r) => r.id === 'sous');
    expect(sous).toBeDefined();
    expect(rankFor(sous!.minTotal).id).toBe('sous');
  });

  it('drops a hair below a boundary into the tier beneath', () => {
    const sous = RANKS.find((r) => r.id === 'sous');
    expect(rankFor(sous!.minTotal - 0.001).id).toBe('line');
  });

  it('clamps out-of-range input instead of falling through', () => {
    expect(rankFor(-5).id).toBe('prep');
    expect(rankFor(99).id).toBe('executive');
  });

  it('never returns a rank whose threshold the score has not met', () => {
    for (let t = 0; t <= 1.0001; t += 0.01) {
      expect(rankFor(t).minTotal).toBeLessThanOrEqual(t + 1e-9);
    }
  });
});

describe('progressFor', () => {
  it('names the next rung so the screen can say what to chase', () => {
    const p = progressFor(0.62);
    expect(p.current.id).toBe('line');
    expect(p.next?.id).toBe('sous');
  });

  it('reports how much more is needed', () => {
    const p = progressFor(0.71);
    expect(p.remaining).toBeCloseTo(0.04);
  });

  it('is zero-fraction at the very start of a tier', () => {
    expect(progressFor(0.6).fraction).toBeCloseTo(0);
  });

  it('approaches one at the top of a tier', () => {
    expect(progressFor(0.7499).fraction).toBeGreaterThan(0.99);
  });

  it('tops out cleanly with no next rank', () => {
    const p = progressFor(1);
    expect(p.next).toBeNull();
    expect(p.fraction).toBe(1);
    expect(p.remaining).toBe(0);
  });
});

describe('critiqueOf', () => {
  it('says nothing happened when nothing was cut', () => {
    expect(critiqueOf(score({ count: 0 }), 5)).toBe('No cuts recorded.');
  });

  it('blames thickness when accuracy is the weaker half, and says which way', () => {
    const s = score({ accuracy: 0.4, uniformity: 0.95, meanMm: 8 });
    expect(critiqueOf(s, 5)).toContain('3.0mm thick');
  });

  it('says thin rather than thick when the slices undershoot', () => {
    const s = score({ accuracy: 0.4, uniformity: 0.95, meanMm: 3 });
    expect(critiqueOf(s, 5)).toContain('2.0mm thin');
  });

  it('blames scatter when uniformity is the weaker half', () => {
    const s = score({ accuracy: 0.95, uniformity: 0.4, sigmaMm: 2.2 });
    expect(critiqueOf(s, 5)).toContain('2.2mm between slices');
  });
});
