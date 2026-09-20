import { describe, expect, it } from 'vitest';
import { allLines, barkFor, type BarkOptions, pickBark } from './barks.js';
import type { CutFeedback } from './feedback.js';
import type { CutRecord } from './metrics.js';
import type { Score } from './scoring.js';

const OPTS: BarkOptions = { intensity: 1, targetThicknessMm: 6 };

const record = (thicknessMm: number): CutRecord =>
  ({ thicknessMm, method: 'stub-delta', confidence: 0.9, index: 0 });

const score = (over: Partial<Score> = {}): Score => ({
  meanMm: 6, sigmaMm: 0.4, meanAngleDeg: null,
  accuracy: 0.9, uniformity: 0.9, angleScore: null, total: 0.9, count: 5, ...over,
});

const feedback = (over: Partial<CutFeedback> = {}): CutFeedback =>
  ({ intensity: 0.4, accuracy: 0.9, kind: 'clean', ...over });

/** Deterministic, so a test asserts the CHOICE rather than a lucky draw. */
const first = (): number => 0;

describe('pickBark', () => {
  it('praises a slice on target', () => {
    expect(pickBark(record(6), score(), feedback(), OPTS, first).kind).toBe('perfect');
  });

  it('says so when the slice was thick, and the other thing when it was thin', () => {
    const missed = feedback({ accuracy: 0.2 });
    expect(pickBark(record(11), score(), missed, OPTS, first).kind).toBe('thick');
    expect(pickBark(record(2), score(), missed, OPTS, first).kind).toBe('thin');
  });

  it('has a middle gear between right and wrong', () => {
    expect(pickBark(record(7), score(), feedback({ accuracy: 0.7 }), OPTS, first).kind)
      .toBe('close');
  });

  /**
   * The ordering that matters most. Commenting on the thickness of a slice the camera could not
   * actually see is how the chef ends up confidently wrong in front of a judge, so low
   * confidence outranks everything including a reading that happens to look perfect.
   */
  it('admits it could not see, in preference to any opinion about the slice', () => {
    const unsure = feedback({ kind: 'uncertain', accuracy: 0.99 });
    expect(pickBark(record(6), score(), unsure, OPTS, first).kind).toBe('uncertain');
  });

  it('pushes on spread once there are enough slices for spread to mean anything', () => {
    const wobbly = score({ uniformity: 0.2, count: 4 });
    expect(pickBark(record(8), wobbly, feedback({ accuracy: 0.4 }), OPTS, first).kind)
      .toBe('uneven');
  });

  it('stays quiet about spread when two slices is all there is to judge', () => {
    const early = score({ uniformity: 0.2, count: 2 });
    expect(pickBark(record(9), early, feedback({ accuracy: 0.3 }), OPTS, first).kind)
      .not.toBe('uneven');
  });

  it('greets the first slice rather than critiquing it', () => {
    expect(pickBark(record(9), score({ count: 1 }), feedback({ accuracy: 0.3 }), OPTS, first).kind)
      .toBe('first');
  });

  it('says something different at Gentle Nonna than at Full Service', () => {
    const gentle = pickBark(record(6), score(), feedback(), { ...OPTS, intensity: 0 }, first);
    const full = pickBark(record(6), score(), feedback(), { ...OPTS, intensity: 1 }, first);
    expect(gentle.kind).toBe(full.kind);
    expect(gentle.line).not.toBe(full.line);
  });

  it('never indexes past the end of a line set, whatever the generator returns', () => {
    for (const rng of [() => 0, () => 0.999999, () => 1, () => -0.5]) {
      const bark = pickBark(record(6), score(), feedback(), OPTS, rng);
      expect(typeof bark.line).toBe('string');
      expect(bark.line.length).toBeGreaterThan(0);
    }
  });
});

describe('allLines', () => {
  it('lists every line, which is what gets pre-generated at load', () => {
    const lines = allLines();
    expect(lines.length).toBeGreaterThan(20);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect(line.trim()).toBe(line);
  });
});

describe('barkFor -- a line of a named kind, with no cut to judge', () => {
  it('returns a line the bank actually holds, which is what lets a headset speak it', () => {
    for (const kind of ['perfect', 'close', 'improving'] as const) {
      const bark = barkFor(kind, 1, () => 0);
      expect(bark.kind).toBe(kind);
      expect(allLines()).toContain(bark.line);
    }
  });

  it('follows the intensity slider the same way pickBark does', () => {
    expect(barkFor('perfect', 0, () => 0).line).not.toBe(barkFor('perfect', 1, () => 0).line);
  });

  it('never indexes past the end of a line set, whatever the generator returns', () => {
    for (const r of [-1, 0, 0.999, 1, 7]) {
      expect(barkFor('improving', 1, () => r).line).not.toBeUndefined();
    }
  });
});
