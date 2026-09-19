import { describe, expect, it } from 'vitest';
import { feedbackForCut, type FeedbackOptions, UNCERTAIN_BELOW } from './feedback.js';
import type { CutRecord } from './metrics.js';

const OPTS: FeedbackOptions = { targetThicknessMm: 3, toleranceMm: 0.5, maxThicknessMm: 10 };

const record = (thicknessMm: number, confidence = 0.9): CutRecord => ({
  index: 0, thicknessMm, method: 'side-profile', confidence,
});

describe('feedbackForCut', () => {
  it('peaks accuracy at the target thickness', () => {
    expect(feedbackForCut(record(3), OPTS).accuracy).toBeCloseTo(1, 10);
  });

  it('falls off as thickness drifts from the target, in both directions', () => {
    const thin = feedbackForCut(record(1.5), OPTS).accuracy;
    const thick = feedbackForCut(record(4.5), OPTS).accuracy;
    expect(thin).toBeLessThan(0.1);
    expect(thick).toBeLessThan(0.1);
    // Equal distance from target means equal accuracy.
    expect(feedbackForCut(record(2.5), OPTS).accuracy)
      .toBeCloseTo(feedbackForCut(record(3.5), OPTS).accuracy, 10);
  });

  it('scales intensity with thickness and clamps at the maximum', () => {
    expect(feedbackForCut(record(5), OPTS).intensity).toBeCloseTo(0.5, 10);
    expect(feedbackForCut(record(50), OPTS).intensity).toBe(1);
  });

  it('never emits a negative or non-finite channel', () => {
    for (const t of [-5, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = feedbackForCut(record(t), OPTS);
      expect(f.intensity).toBeGreaterThanOrEqual(0);
      expect(f.intensity).toBeLessThanOrEqual(1);
      expect(f.accuracy).toBeGreaterThanOrEqual(0);
      expect(f.accuracy).toBeLessThanOrEqual(1);
    }
  });

  it('survives a zero maxThicknessMm without dividing by it', () => {
    const f = feedbackForCut(record(3), { ...OPTS, maxThicknessMm: 0 });
    expect(f.intensity).toBe(0);
  });

  it('marks a low-confidence measurement uncertain rather than staying silent', () => {
    // Silence would read as "no cut detected" and send the player hunting a phantom problem.
    expect(feedbackForCut(record(3, UNCERTAIN_BELOW - 0.01), OPTS).kind).toBe('uncertain');
    expect(feedbackForCut(record(3, UNCERTAIN_BELOW), OPTS).kind).toBe('clean');
  });
});
