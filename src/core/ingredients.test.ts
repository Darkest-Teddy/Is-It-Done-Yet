import { describe, expect, it } from 'vitest';
import {
  classify, hueDistanceDeg, identify, type IngredientProfile, PROFILES,
  scoreProfile, type ShapeFeatures,
} from './ingredients.js';

const features = (over: Partial<ShapeFeatures> = {}): ShapeFeatures => ({
  hueDeg: 0, saturation: 0.8, value: 0.7,
  elongation: 1.1, solidity: 0.96, circularity: 0.9,
  ...over,
});

const CUCUMBER = features({ hueDeg: 95, saturation: 0.5, elongation: 6.0, solidity: 0.95 });
const TOMATO = features({ hueDeg: 2, saturation: 0.8, elongation: 1.1, solidity: 0.96 });
const ORANGE = features({ hueDeg: 28, saturation: 0.75, elongation: 1.1, solidity: 0.95 });
const CARROT = features({ hueDeg: 24, saturation: 0.7, elongation: 6.0, solidity: 0.92 });

describe('hueDistanceDeg', () => {
  it('is the shortest way round the circle', () => {
    expect(hueDistanceDeg(10, 40)).toBe(30);
    expect(hueDistanceDeg(40, 10)).toBe(30);
  });

  it('wraps through zero, which is where ripe red lives', () => {
    // The whole reason this function exists. A plain abs(a - b) gives 354 here and splits
    // every tomato in half.
    expect(hueDistanceDeg(358, 4)).toBe(6);
    expect(hueDistanceDeg(350, 10)).toBe(20);
  });

  it('never exceeds half the circle', () => {
    expect(hueDistanceDeg(0, 180)).toBe(180);
    expect(hueDistanceDeg(0, 181)).toBe(179);
  });

  it('normalises out-of-range and negative hues', () => {
    expect(hueDistanceDeg(-10, 10)).toBe(20);
    expect(hueDistanceDeg(370, 10)).toBe(0);
  });
});

describe('identify on clean produce', () => {
  it.each([
    ['cucumber', CUCUMBER],
    ['tomato', TOMATO],
    ['orange', ORANGE],
    ['carrot', CARROT],
  ])('names a %s', (expected, f) => {
    expect(identify(f)?.name).toBe(expected);
  });

  it('still names a tomato whose hue sits below zero', () => {
    // Same fruit, hue read as 358 instead of 2 -- a one-degree lighting shift in practice.
    expect(identify(features({ hueDeg: 358, elongation: 1.1 }))?.name).toBe('tomato');
  });

  it('separates carrot from orange on elongation alone, their hues being nearly identical', () => {
    expect(hueDistanceDeg(24, 28)).toBe(4);
    expect(identify(CARROT)?.name).toBe('carrot');
    expect(identify(ORANGE)?.name).toBe('orange');
  });
});

describe('scoreProfile refusals', () => {
  const profile = PROFILES.find((p) => p.name === 'tomato') as IngredientProfile;

  it('scores zero for a washed-out blob rather than matching on a stray red pixel', () => {
    expect(scoreProfile(features({ saturation: 0.1 }), profile)).toBe(0);
  });

  it('scores zero for a ragged, non-convex blob', () => {
    expect(scoreProfile(features({ solidity: 0.4 }), profile)).toBe(0);
  });

  it('scores zero on non-finite features instead of returning NaN', () => {
    expect(scoreProfile(features({ hueDeg: Number.NaN }), profile)).toBe(0);
    expect(scoreProfile(features({ elongation: Number.POSITIVE_INFINITY }), profile)).toBe(0);
  });

  it('falls to exp(-1) at exactly one hue tolerance from the centre', () => {
    // Centre 2, tolerance 14 -> hue 16 is one tolerance out, shape term is 1 inside the range.
    expect(scoreProfile(features({ hueDeg: 16 }), profile)).toBeCloseTo(Math.exp(-1), 12);
  });
});

describe('classify', () => {
  it('ranks best first and drops the impossible', () => {
    const ranked = classify(CUCUMBER);
    expect(ranked[0]?.name).toBe('cucumber');
    expect(ranked.every((c) => c.confidence > 0)).toBe(true);
  });

  it('returns nothing at all for a grey blob', () => {
    expect(classify(features({ saturation: 0.02 }))).toHaveLength(0);
  });
});

describe('identify refuses rather than guessing', () => {
  it('returns null when nothing clears the confidence floor', () => {
    expect(identify(features({ saturation: 0.02 }))).toBeNull();
  });

  it('returns null when the top two candidates are too close to separate', () => {
    // Two profiles differing only in a hue centre 4 degrees apart: a blob between them scores
    // almost identically against both. Naming one would produce a label that flickers between
    // them frame to frame, which reads as broken rather than as unsure.
    const twins: IngredientProfile[] = [
      { name: 'twin-a', hueCentreDeg: 100, hueToleranceDeg: 40, minSaturation: 0.2,
        elongation: { min: 1, max: 10 }, minSolidity: 0.5 },
      { name: 'twin-b', hueCentreDeg: 104, hueToleranceDeg: 40, minSaturation: 0.2,
        elongation: { min: 1, max: 10 }, minSolidity: 0.5 },
    ];
    const between = features({ hueDeg: 102, elongation: 3 });
    const ranked = classify(between, twins);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.confidence / ranked[1]!.confidence).toBeLessThan(1.5);
    expect(identify(between, 0.35, 1.5, twins)).toBeNull();
  });

  it('names the winner once the margin is genuinely there', () => {
    const clear: IngredientProfile[] = [
      { name: 'near', hueCentreDeg: 100, hueToleranceDeg: 10, minSaturation: 0.2,
        elongation: { min: 1, max: 10 }, minSolidity: 0.5 },
      { name: 'far', hueCentreDeg: 160, hueToleranceDeg: 10, minSaturation: 0.2,
        elongation: { min: 1, max: 10 }, minSolidity: 0.5 },
    ];
    expect(identify(features({ hueDeg: 100, elongation: 3 }), 0.35, 1.5, clear)?.name).toBe('near');
  });
});
