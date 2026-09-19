export interface TunableDef {
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

/**
 * Every magic number in the simulation. Master spec rule #11.
 *
 * The debug panel is generated from this table, and `harness/runScript.ts` builds its option
 * objects from the same defaults, so tests exercise the real values rather than a parallel set
 * that drifts.
 *
 * That second sentence used to be false. The harness kept hand-copied literals, nothing outside
 * this file's own test imported the registry at all, and the drift it warned about had already
 * happened: `LATHE_RADIAL_SEGMENTS` said 32 while the harness and every test ran at 64. The
 * harness now reads `TUNABLE_DEFS[...].default` directly, so a divergence is no longer
 * expressible.
 *
 * Why `.default` rather than `tunable()`: a debug-panel override must not be able to change the
 * numbers a recorded cut script replays against. The harness wants the declared value, not the
 * live one.
 */
export const TUNABLE_DEFS = {
  // --- cut plane -------------------------------------------------------------
  MIN_SWEEP_M: {
    label: 'Minimum sweep', default: 0.004, min: 0.0005, max: 0.05, step: 0.0005, unit: 'm',
  },
  MIN_CROSS_SIN: {
    label: 'Minimum blade/sweep angle (sin)', default: 0.17, min: 0.01, max: 0.7, step: 0.01, unit: '',
  },
  MAX_PLANARITY_RESIDUAL_M: {
    label: 'Max planarity residual', default: 0.002, min: 0.0001, max: 0.02, step: 0.0001, unit: 'm',
  },
  MAX_SWEEP_SUBDIVISIONS: {
    label: 'Max sweep subdivisions', default: 8, min: 1, max: 32, step: 1, unit: '',
  },
  MIN_AXIS_DOT: {
    label: 'Min |normal . axis| before a cut counts as lengthwise',
    default: 0.26, min: 0.05, max: 0.95, step: 0.01, unit: '',
  },

  // --- cucumber --------------------------------------------------------------
  CUCUMBER_LENGTH_M: {
    label: 'Cucumber length', default: 0.18, min: 0.05, max: 0.4, step: 0.005, unit: 'm',
  },
  CUCUMBER_RADIUS_M: {
    label: 'Cucumber radius', default: 0.021, min: 0.005, max: 0.06, step: 0.001, unit: 'm',
  },
  /**
   * 64, not master spec §7.6's 32, and the divergence is deliberate.
   *
   * §7.6's "32 radial segments. More is draw-call budget you need elsewhere" is a statement
   * about `new THREE.LatheGeometry(...)` -- a GPU cost, for the visual mesh. The same spec
   * raises that mesh to 48 segments in its materials pass, so 32 was never a correctness
   * figure and the spec does not treat it as fixed. This key feeds the simulation, where the
   * count sets the cap-ring resolution and the outer quadrature, costs microseconds in a
   * headless module, and has no draw calls at all.
   *
   * Measured, on a 0.021 m cylinder cut at 30 degrees with the normal rotated out of the x-y
   * plane so the ring's extremes do not land on sample points: wedge error 1.57e-3 relative at
   * 32 segments against 8.85e-4 at 64, or 0.038 mm against 0.021 mm. Both sit well inside the
   * 0.5 mm scoring tolerance, so this is not the decisive argument -- but the improvement is
   * free. Volume is indifferent either way: the theta sum is spectrally accurate for a periodic
   * integrand, and 32, 64 and 512 segments agree to 2e-13 relative.
   *
   * The decisive argument is that 64 is what the harness, every test and every accuracy figure
   * in PHYSICS.md are already stated at ("clamped 23 of 64 ring entries", the wedge figures).
   * Moving the harness to 32 would invalidate those figures to match a number chosen for a
   * draw-call budget this module does not pay.
   *
   * When a renderer exists it should get its own key for mesh tessellation rather than reusing
   * this one. The two are only coupled because `volumeOf` requires a cap ring to be indexed at
   * the same segment count it was built at.
   */
  LATHE_RADIAL_SEGMENTS: {
    label: 'Lathe radial segments', default: 64, min: 8, max: 96, step: 1, unit: '',
  },
  LATHE_PROFILE_SEGMENTS: {
    label: 'Lathe profile segments', default: 24, min: 4, max: 64, step: 1, unit: '',
  },

  // --- scoring ---------------------------------------------------------------
  TARGET_THICKNESS_MM: {
    label: 'Target thickness', default: 3, min: 0.5, max: 30, step: 0.1, unit: 'mm',
  },
  TOLERANCE_MM: {
    label: 'Thickness tolerance', default: 0.5, min: 0.1, max: 5, step: 0.1, unit: 'mm',
  },
  TARGET_SIGMA_MM: {
    label: 'Target sigma', default: 0.5, min: 0.1, max: 5, step: 0.1, unit: 'mm',
  },
  ANGLE_TOLERANCE_DEG: {
    label: 'Angle tolerance', default: 5, min: 0.5, max: 45, step: 0.5, unit: 'deg',
  },

  // --- fragments and ribbon --------------------------------------------------
  MAX_FRAGMENTS: {
    label: 'Max fragments', default: 40, min: 4, max: 120, step: 1, unit: '',
  },
  FRAGMENT_SLEEP_S: {
    label: 'Fragment sleep delay', default: 2, min: 0.2, max: 10, step: 0.1, unit: 's',
  },
  FRAGMENT_DESPAWN_S: {
    label: 'Fragment despawn delay', default: 8, min: 1, max: 60, step: 0.5, unit: 's',
  },
  RIBBON_LIFETIME_S: {
    label: 'Ribbon lifetime', default: 2, min: 0.2, max: 10, step: 0.1, unit: 's',
  },

  // --- hand safety -----------------------------------------------------------
  CLAW_THRESHOLD: {
    label: 'Claw extension threshold', default: 1.3, min: 1, max: 2, step: 0.01, unit: '',
  },
  DANGER_MM: {
    label: 'Danger distance', default: 20, min: 2, max: 100, step: 1, unit: 'mm',
  },
  WARN_MM: {
    label: 'Warning distance', default: 45, min: 5, max: 200, step: 1, unit: 'mm',
  },
  SAFETY_DEBOUNCE_FRAMES: {
    label: 'Safety de-escalation frames', default: 4, min: 1, max: 30, step: 1, unit: '',
  },

  // --- feedback --------------------------------------------------------------
  HAPTIC_SCALE: {
    label: 'Haptic intensity scale', default: 1, min: 0, max: 2, step: 0.05, unit: '',
  },
  AUDIO_BASE_HZ: {
    label: 'Chop base frequency', default: 320, min: 60, max: 1200, step: 10, unit: 'Hz',
  },
  AUDIO_PITCH_RANGE_HZ: {
    label: 'Chop pitch range across accuracy', default: 480, min: 0, max: 2000, step: 10, unit: 'Hz',
  },
  AUDIO_BURST_MS: {
    label: 'Chop burst duration', default: 90, min: 10, max: 500, step: 5, unit: 'ms',
  },
  AUDIO_BANDPASS_Q: {
    label: 'Chop bandpass Q', default: 6, min: 0.5, max: 30, step: 0.5, unit: '',
  },

  // --- blade geometry (consumed by BladeSystem in a later milestone) ---------
  BLADE_LENGTH_M: {
    label: 'Blade heel-to-tip length', default: 0.15, min: 0.04, max: 0.4, step: 0.005, unit: 'm',
  },
  BLADE_HEEL_OFFSET_M: {
    label: 'Heel offset ahead of the controller grip',
    default: 0.03, min: -0.1, max: 0.3, step: 0.005, unit: 'm',
  },
} as const satisfies Record<string, TunableDef>;

export type TunableKey = keyof typeof TUNABLE_DEFS;

export interface TunableView extends TunableDef {
  readonly key: TunableKey;
  readonly value: number;
}

const overrides = new Map<TunableKey, number>();

export function tunable(key: TunableKey): number {
  const override = overrides.get(key);
  return override ?? TUNABLE_DEFS[key].default;
}

/** Clamps to the declared bounds. A non-finite value is ignored, never stored. */
export function setTunable(key: TunableKey, value: number): void {
  if (!Number.isFinite(value)) return;
  const def = TUNABLE_DEFS[key];
  overrides.set(key, Math.min(def.max, Math.max(def.min, value)));
}

export function resetTunables(): void {
  overrides.clear();
}

export function allTunables(): readonly TunableView[] {
  return (Object.keys(TUNABLE_DEFS) as TunableKey[]).map((key) => ({
    ...TUNABLE_DEFS[key],
    key,
    value: tunable(key),
  }));
}
