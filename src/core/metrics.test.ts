import { describe, expect, it } from 'vitest';
import {
  crossCheck, emptySession, recordCut, type SliceMeasurement,
} from './metrics.js';

const side = (thicknessMm: number, extra: Partial<SliceMeasurement> = {}): SliceMeasurement => ({
  thicknessMm, method: 'side-profile', confidence: 0.9, ...extra,
});

const stub = (thicknessMm: number, extra: Partial<SliceMeasurement> = {}): SliceMeasurement => ({
  thicknessMm, method: 'stub-delta', confidence: 0.7, ...extra,
});

describe('recordCut', () => {
  it('indexes records from zero, in arrival order', () => {
    let s = emptySession();
    s = recordCut(s, side(3.0)).session;
    s = recordCut(s, side(3.2)).session;
    s = recordCut(s, side(2.8)).session;

    expect(s.records.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(s.records.map((r) => r.thicknessMm)).toEqual([3.0, 3.2, 2.8]);
  });

  it('carries the measurement through unchanged, method and confidence included', () => {
    const { record } = recordCut(emptySession(), stub(4.1, { confidence: 0.42 }));
    expect(record.method).toBe('stub-delta');
    expect(record.confidence).toBe(0.42);
  });

  it('leaves an unmeasured angle absent rather than defaulting it to zero', () => {
    const { record } = recordCut(emptySession(), side(3.0));
    expect(record.angleDeviationDeg).toBeUndefined();
    // A zero here would assert a flawless square cut the camera never actually judged.
    expect('angleDeviationDeg' in record && record.angleDeviationDeg === 0).toBe(false);
  });

  it('preserves a measured angle of exactly zero, which is a real square cut', () => {
    const { record } = recordCut(emptySession(), side(3.0, { angleDeviationDeg: 0 }));
    expect(record.angleDeviationDeg).toBe(0);
  });

  it('does not mutate the session it was given', () => {
    const first = emptySession();
    recordCut(first, side(3.0));
    expect(first.records).toHaveLength(0);
  });
});

describe('crossCheck', () => {
  it('agrees when two methods land within tolerance', () => {
    const result = crossCheck(side(3.0), stub(3.2), 0.5);
    expect(result.agree).toBe(true);
    expect(result.deltaMm).toBeCloseTo(0.2, 10);
  });

  it('disagrees past tolerance and names both readings', () => {
    const result = crossCheck(side(3.0), stub(6.5), 0.5);
    expect(result.agree).toBe(false);
    if (result.agree) throw new Error('unreachable');
    expect(result.reason).toContain('side-profile');
    expect(result.reason).toContain('3.00mm');
    expect(result.reason).toContain('stub-delta');
    expect(result.reason).toContain('6.50mm');
  });

  it('treats a delta exactly at tolerance as agreement', () => {
    expect(crossCheck(side(3.0), stub(3.5), 0.5).agree).toBe(true);
  });

  it('refuses a non-finite measurement instead of reporting agreement', () => {
    // NaN fails every comparison, so a naive `delta > tolerance` test returns false and the
    // pair reads as agreeing. That is the worst possible answer: two broken measurements
    // confirming each other.
    const result = crossCheck(side(Number.NaN), stub(3.0), 0.5);
    expect(result.agree).toBe(false);
  });

  it('is symmetric in its arguments', () => {
    const a = crossCheck(side(3.0), stub(4.0), 0.5);
    const b = crossCheck(stub(4.0), side(3.0), 0.5);
    expect(a.agree).toBe(b.agree);
    expect(a.deltaMm).toBeCloseTo(b.deltaMm, 10);
  });
});
