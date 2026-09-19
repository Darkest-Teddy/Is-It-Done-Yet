import { describe, expect, it } from 'vitest';
import type { CutRecord } from './metrics.js';
import { formatScore, scoreSession, type ScoringOptions } from './scoring.js';

const OPTS: ScoringOptions = {
  targetThicknessMm: 3,
  toleranceMm: 0.5,
  targetSigmaMm: 0.5,
  angleToleranceDeg: 5,
};

function record(thicknessMm: number, angleDeviationDeg?: number): CutRecord {
  return {
    index: 0, thicknessMm, method: 'side-profile', confidence: 0.9,
    ...(angleDeviationDeg === undefined ? {} : { angleDeviationDeg }),
  };
}

describe('scoreSession', () => {
  it('returns a zeroed score for an empty session', () => {
    const s = scoreSession([], OPTS);
    expect(s.count).toBe(0);
    expect(s.total).toBe(0);
    expect(s.meanAngleDeg).toBeNull();
  });

  it('scores a flawless session at the target near 1', () => {
    const s = scoreSession([record(3, 0), record(3, 0), record(3, 0)], OPTS);
    expect(s.meanMm).toBeCloseTo(3, 10);
    expect(s.sigmaMm).toBeCloseTo(0, 10);
    expect(s.total).toBeCloseTo(1, 10);
  });

  it('uses the population sigma, not the sample sigma', () => {
    // Two cuts at 2 and 4: population sigma is 1, sample sigma would be sqrt(2).
    expect(scoreSession([record(2), record(4)], OPTS).sigmaMm).toBeCloseTo(1, 10);
  });

  it('penalises a biased session through accuracy', () => {
    const onTarget = scoreSession([record(3), record(3)], OPTS);
    const biased = scoreSession([record(4), record(4)], OPTS);
    expect(biased.sigmaMm).toBeCloseTo(onTarget.sigmaMm, 10);
    expect(biased.accuracy).toBeLessThan(onTarget.accuracy);
  });

  it('penalises a scattered session through uniformity even when the mean is perfect', () => {
    const scattered = scoreSession([record(1), record(5)], OPTS);
    expect(scattered.meanMm).toBeCloseTo(3, 10);
    // sigma is exactly 2 for [1,5], so uniformity is exp(-2/0.5) = exp(-4).
    expect(scattered.uniformity).toBeCloseTo(Math.exp(-4), 12);
  });
});

describe('scoreSession without measured angles', () => {
  it('reports both angle fields as null rather than zero', () => {
    const s = scoreSession([record(3), record(3)], OPTS);
    expect(s.meanAngleDeg).toBeNull();
    expect(s.angleScore).toBeNull();
  });

  it('still reaches 1.0 on a flawless session, by renormalising the surviving weights', () => {
    // Without renormalisation the angle term's 0.15 would simply vanish and a perfect
    // angle-blind session would cap at 0.85, reading as worse than it was.
    expect(scoreSession([record(3), record(3)], OPTS).total).toBeCloseTo(1, 10);
  });

  it('averages the angle only over slices that carry one', () => {
    // 10 degrees measured on one slice; the other is unmeasured and must not pull it toward 0.
    const s = scoreSession([record(3, 10), record(3)], OPTS);
    expect(s.meanAngleDeg).toBeCloseTo(10, 10);
  });

  it('scores an angled session below an equivalent square one', () => {
    const square = scoreSession([record(3, 0)], OPTS);
    const angled = scoreSession([record(3, 10)], OPTS);
    expect(angled.total).toBeLessThan(square.total);
  });
});

describe('formatScore', () => {
  it('says so plainly when nothing has been cut', () => {
    expect(formatScore(scoreSession([], OPTS), OPTS)).toBe('No cuts yet.');
  });

  it('reads as plain millimetres, per master spec 7.4', () => {
    const s = scoreSession([record(3.0), record(3.0)], OPTS);
    expect(formatScore(s, OPTS)).toBe('3.0mm average, ±0.0mm. Target 3mm, ±0.5mm.');
  });

  it('trims trailing zeros from the target but not from the measurement', () => {
    const s = scoreSession([record(4.25), record(4.25)], OPTS);
    expect(formatScore(s, OPTS)).toBe('4.3mm average, ±0.0mm. Target 3mm, ±0.5mm.');
  });
});
