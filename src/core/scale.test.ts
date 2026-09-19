import { describe, expect, it } from 'vitest';
import {
  agreement, areaPxToMm2, calibrate, distancePx, MIN_REFERENCE_PX, pxToMm, scaleFromDiameter,
} from './scale.js';

describe('calibrate', () => {
  it('divides the known length by the pixels it spanned', () => {
    expect(calibrate(200, 100)?.mmPerPx).toBeCloseTo(0.5, 9);
  });

  it('keeps what it was calibrated against, not just what it concluded', () => {
    const c = calibrate(200, 100);
    expect(c?.referencePx).toBe(200);
    expect(c?.referenceMm).toBe(100);
  });

  it('refuses a reference too short to be anything but a misclick', () => {
    expect(calibrate(MIN_REFERENCE_PX - 1, 100)).toBeNull();
  });

  it('refuses nonsense rather than returning a scale that multiplies every later reading', () => {
    expect(calibrate(200, 0)).toBeNull();
    expect(calibrate(200, -50)).toBeNull();
    expect(calibrate(Number.NaN, 100)).toBeNull();
    expect(calibrate(200, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('pxToMm', () => {
  it('converts once calibrated', () => {
    expect(pxToMm(calibrate(200, 100), 40)).toBeCloseTo(20, 9);
  });

  /** The distinction the whole module exists for: absent, not zero, and not a guess of 1. */
  it('is null when uncalibrated, so no wrong millimetre figure can be displayed', () => {
    expect(pxToMm(null, 40)).toBeNull();
  });

  it('is null for a non-finite pixel count', () => {
    expect(pxToMm(calibrate(200, 100), Number.NaN)).toBeNull();
  });
});

describe('areaPxToMm2', () => {
  it('scales with the SQUARE of the length scale', () => {
    // 0.5 mm/px, so one pixel is 0.25 mm2 -- not 0.5.
    expect(areaPxToMm2(calibrate(200, 100), 100)).toBeCloseTo(25, 9);
  });

  it('is null when uncalibrated', () => {
    expect(areaPxToMm2(null, 100)).toBeNull();
  });
});

describe('scaleFromDiameter', () => {
  it('gives the same scale the ruler would have, from the cucumber itself', () => {
    expect(scaleFromDiameter(84, 42)?.mmPerPx).toBeCloseTo(0.5, 9);
  });

  /** The property that makes it worth having: the answer does not move when the camera does. */
  it('is unchanged when everything in frame scales together', () => {
    const near = scaleFromDiameter(84, 42)!;
    const far = scaleFromDiameter(42, 42)!;
    expect(pxToMm(near, 168)).toBeCloseTo(84, 9);
    expect(pxToMm(far, 84)).toBeCloseTo(84, 9);
  });
});

describe('agreement', () => {
  it('is 1 when two independent scales say the same thing', () => {
    expect(agreement(calibrate(200, 100), scaleFromDiameter(84, 42))).toBeCloseTo(1, 9);
  });

  it('drifts off 1 when one of them has gone stale', () => {
    // The tripod was knocked 10% closer; the stored ruler scale did not notice.
    expect(agreement(calibrate(200, 100), scaleFromDiameter(92.4, 42))).toBeCloseTo(1.1, 6);
  });

  it('is null when either side is uncalibrated', () => {
    expect(agreement(null, scaleFromDiameter(84, 42))).toBeNull();
    expect(agreement(calibrate(200, 100), null)).toBeNull();
  });
});

describe('distancePx', () => {
  it('is the euclidean distance between two clicks', () => {
    expect(distancePx({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
