import { beforeEach, describe, expect, it } from 'vitest';
import {
  allTunables, resetTunables, setTunable, tunable, TUNABLE_DEFS, type TunableKey,
} from './tunables.js';

describe('tunables', () => {
  beforeEach(() => resetTunables());

  it('returns the declared default before any override', () => {
    // Deliberately compared against the registry rather than against a literal. These assert the
    // MECHANISM -- default lookup, clamping, reset -- and re-pinning a value in each of them
    // meant one sourced number lived in four places, so changing it broke three tests that were
    // not about it. The values are pinned once, below.
    expect(tunable('TARGET_THICKNESS_MM')).toBe(TUNABLE_DEFS.TARGET_THICKNESS_MM.default);
    expect(tunable('MIN_SATURATION')).toBe(TUNABLE_DEFS.MIN_SATURATION.default);
  });

  it('takes an override', () => {
    setTunable('TARGET_THICKNESS_MM', 4);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(4);
  });

  it('clamps an override to the declared bounds rather than accepting it', () => {
    setTunable('MIN_SATURATION', 99);
    expect(tunable('MIN_SATURATION')).toBe(TUNABLE_DEFS.MIN_SATURATION.max);
    setTunable('MIN_SATURATION', -99);
    expect(tunable('MIN_SATURATION')).toBe(TUNABLE_DEFS.MIN_SATURATION.min);
  });

  it('ignores a non-finite override rather than poisoning the registry', () => {
    setTunable('TARGET_THICKNESS_MM', Number.NaN);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(TUNABLE_DEFS.TARGET_THICKNESS_MM.default);
    setTunable('TARGET_THICKNESS_MM', Number.POSITIVE_INFINITY);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(TUNABLE_DEFS.TARGET_THICKNESS_MM.default);
  });

  it('resets every override', () => {
    setTunable('TARGET_THICKNESS_MM', 7);
    setTunable('MIN_AREA_PX', 1000);
    resetTunables();
    expect(tunable('TARGET_THICKNESS_MM')).toBe(TUNABLE_DEFS.TARGET_THICKNESS_MM.default);
    expect(tunable('MIN_AREA_PX')).toBe(TUNABLE_DEFS.MIN_AREA_PX.default);
  });

  it('enumerates every key with its live value', () => {
    setTunable('TARGET_THICKNESS_MM', 4);
    const view = allTunables().find((t) => t.key === 'TARGET_THICKNESS_MM');
    expect(view?.value).toBe(4);
    expect(view?.default).toBe(TUNABLE_DEFS.TARGET_THICKNESS_MM.default);
    expect(allTunables()).toHaveLength(Object.keys(TUNABLE_DEFS).length);
  });

  /**
   * The values that carry an argument somewhere are pinned here, once.
   *
   * Changing one of these should break a test loudly enough that the reasoning gets updated in
   * the same commit -- which is exactly what happened to the thickness target, and why the note
   * beside it in the registry now explains why it is not the master spec's 3mm.
   */
  it('pins the values that a document argues for', () => {
    const expected: Record<string, number> = {
      // DECISIONS entry 14. Master spec §7.4 says 3mm / 0.5mm; a 3mm target scores every cut a
      // real person makes as zero, so both moved together.
      TARGET_THICKNESS_MM: 6,
      TOLERANCE_MM: 2,
      TARGET_SIGMA_MM: 2,
      // Master spec §7.4, unchanged.
      ANGLE_TOLERANCE_DEG: 5,
      // The in-scene ruler. A supermarket cucumber, and the only absolute length in the program.
      CUCUMBER_DIAMETER_MM: 42,
    };

    for (const [key, value] of Object.entries(expected)) {
      expect(TUNABLE_DEFS[key as TunableKey].default, `${key} drifted from its rationale`)
        .toBe(value);
    }
  });

  it('documents every tunable, so the panel cannot show a blank row', () => {
    for (const t of allTunables()) {
      expect(t.label.length, `${t.key} has no label`).toBeGreaterThan(0);
      expect(t.min, `${t.key} has an empty range`).toBeLessThan(t.max);
      expect(t.step, `${t.key} has a non-positive step`).toBeGreaterThan(0);
      expect(t.default, `${t.key} defaults below its own minimum`).toBeGreaterThanOrEqual(t.min);
      expect(t.default, `${t.key} defaults above its own maximum`).toBeLessThanOrEqual(t.max);
    }
  });

  /**
   * Guards the pivot recorded in DECISIONS entry 12. The registry used to be full of keys for a
   * simulation that is not in this repository, and they read as live configuration to anyone who
   * opened the file. If one comes back, it should come back with code that reads it.
   */
  it('carries no key from the simulation this repository no longer contains', () => {
    const gone = [
      'MIN_SWEEP_M', 'MIN_CROSS_SIN', 'MAX_PLANARITY_RESIDUAL_M', 'MAX_SWEEP_SUBDIVISIONS',
      'MIN_AXIS_DOT', 'CUCUMBER_LENGTH_M', 'CUCUMBER_RADIUS_M', 'LATHE_RADIAL_SEGMENTS',
      'LATHE_PROFILE_SEGMENTS', 'MAX_FRAGMENTS', 'FRAGMENT_SLEEP_S', 'FRAGMENT_DESPAWN_S',
      'RIBBON_LIFETIME_S', 'CLAW_THRESHOLD', 'DANGER_MM', 'WARN_MM', 'SAFETY_DEBOUNCE_FRAMES',
      'BLADE_LENGTH_M', 'BLADE_HEEL_OFFSET_M',
    ];
    for (const key of gone) {
      expect(Object.keys(TUNABLE_DEFS), `${key} is back without code that reads it`)
        .not.toContain(key);
    }
  });
});
