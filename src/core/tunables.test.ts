import { beforeEach, describe, expect, it } from 'vitest';
import {
  allTunables, resetTunables, setTunable, tunable, TUNABLE_DEFS, type TunableKey,
} from './tunables.js';

describe('tunables', () => {
  beforeEach(() => resetTunables());

  it('returns the declared default before any override', () => {
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
    expect(tunable('CLAW_THRESHOLD')).toBe(1.3);
  });

  it('applies an override', () => {
    setTunable('TARGET_THICKNESS_MM', 5);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(5);
  });

  it('clamps an override to the declared bounds', () => {
    const def = TUNABLE_DEFS.TARGET_THICKNESS_MM;
    setTunable('TARGET_THICKNESS_MM', def.max + 100);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(def.max);
    setTunable('TARGET_THICKNESS_MM', def.min - 100);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(def.min);
  });

  it('ignores a non-finite override rather than poisoning the registry', () => {
    setTunable('TARGET_THICKNESS_MM', NaN);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
  });

  it('resets every override', () => {
    setTunable('TARGET_THICKNESS_MM', 7);
    resetTunables();
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
  });

  it('enumerates every tunable with its current value, for panel generation', () => {
    setTunable('DANGER_MM', 25);
    const found = allTunables().find((t) => t.key === 'DANGER_MM');
    expect(found).toMatchObject({ key: 'DANGER_MM', value: 25, unit: 'mm' });
  });

  it('declares every default inside its own bounds', () => {
    for (const t of allTunables()) {
      expect(t.value, `${t.key} default out of bounds`).toBeGreaterThanOrEqual(t.min);
      expect(t.value, `${t.key} default out of bounds`).toBeLessThanOrEqual(t.max);
    }
  });

  it('pins every default against the value PHYSICS.md records a source for', () => {
    // Until the harness was wired to this table, nothing outside this file imported it at all:
    // MIN_SWEEP_M could go 0.004 -> 0.04, MIN_AXIS_DOT 0.26 -> 0.9, CUCUMBER_RADIUS_M
    // 0.021 -> 0.04, and the whole suite stayed green. Wiring the harness in fixes half of
    // that -- a mutated value now reaches the solver -- but not the other half: PLANE_OPTS and
    // CUT_OPTS are built FROM these defaults, so an identity check between the two would move
    // together with any mutation and prove nothing.
    //
    // So the values are pinned literally, here, against PHYSICS.md's constants table. That
    // table is the source of record; changing a sourced constant should break a test loudly
    // enough that the document gets updated in the same commit.
    const expected: Record<string, number> = {
      // Master spec §7.5.
      CLAW_THRESHOLD: 1.3,
      DANGER_MM: 20,
      // Master spec §7.6.
      CUCUMBER_LENGTH_M: 0.18,
      CUCUMBER_RADIUS_M: 0.021,
      LATHE_PROFILE_SEGMENTS: 24,
      // Deliberately NOT §7.6's 32 -- see the note on the definition. This is the simulation's
      // ring and quadrature resolution, not the visual mesh's draw-call budget.
      LATHE_RADIAL_SEGMENTS: 64,
      // Master spec §7.4, verbatim.
      TARGET_THICKNESS_MM: 3,
      TOLERANCE_MM: 0.5,
      TARGET_SIGMA_MM: 0.5,
      ANGLE_TOLERANCE_DEG: 5,
      // TUNED, not sourced -- but still load-bearing, and still documented.
      WARN_MM: 45,
      MIN_SWEEP_M: 0.004,
      MIN_CROSS_SIN: 0.17,
      MAX_PLANARITY_RESIDUAL_M: 0.002,
      MIN_AXIS_DOT: 0.26,
      MAX_SWEEP_SUBDIVISIONS: 8,
      SAFETY_DEBOUNCE_FRAMES: 4,
    };

    for (const [key, value] of Object.entries(expected)) {
      expect(TUNABLE_DEFS[key as TunableKey].default, `${key} drifted from PHYSICS.md`)
        .toBe(value);
    }
  });

  it('documents every tunable, so the panel cannot show a blank row', () => {
    for (const t of allTunables()) {
      expect(t.label.length, `${t.key} has no label`).toBeGreaterThan(0);
      expect(t.min, `${t.key} has an empty range`).toBeLessThan(t.max);
      expect(t.step, `${t.key} has a non-positive step`).toBeGreaterThan(0);
    }
  });
});
