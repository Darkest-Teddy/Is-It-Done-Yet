export interface TunableDef {
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  /** Groups the debug panel. Purely presentational. */
  readonly group: 'vision' | 'measurement' | 'scoring' | 'feedback';
}

/**
 * Every magic number, one typed registry with bounds. Master spec rule #11.
 *
 * The debug panel is generated from this table, which is the entire point of it: rebuilding at
 * the venue to retune a saturation threshold is how you lose a Saturday. Hall lighting is
 * usually a green-heavy fluorescent that shifts every hue window a few degrees, and the only
 * number that helps is the one you can drag while watching the overlay.
 *
 * This table used to describe a different program. It carried blade geometry, lathe
 * tessellation, sweep planarity residuals and hand-safety distances for an analytic cut-plane
 * simulation against a virtual solid -- the build recorded in DECISIONS entries 1 through 11,
 * which is not the build in this repository. Those keys were pinned by tests and cited in
 * PHYSICS.md, so they read to anyone opening the file as live configuration. They configured
 * nothing at all. They are gone; see DECISIONS entry 12.
 */
export const TUNABLE_DEFS = {
  // --- vision ----------------------------------------------------------------
  /**
   * TUNED, not sourced. Produce against a light board separates on SATURATION rather than on
   * hue or brightness -- a white board stays near-achromatic however bright the hall is, while
   * a cucumber is strongly coloured. First slider to touch on arrival.
   */
  MIN_SATURATION: {
    label: 'Saturation floor', default: 0.22, min: 0.02, max: 0.7, step: 0.01, unit: '',
    group: 'vision',
  },
  MIN_AREA_PX: {
    label: 'Minimum blob area', default: 300, min: 50, max: 8000, step: 50, unit: 'px2',
    group: 'vision',
  },
  MORPH_KERNEL_PX: {
    label: 'Morphology kernel', default: 5, min: 1, max: 15, step: 2, unit: 'px',
    group: 'vision',
  },
  /**
   * The hue window that decides what counts as food at all.
   *
   * Tracking takes the longest blob in frame as the stub, so anything longer than the cucumber
   * that survives segmentation becomes the measurement. A bare forearm under warm hall light
   * sits near hue 25, clears the saturation floor, and is both elongated and highly convex --
   * everything the stub test looks for. Gating on hue first is what stops the app confidently
   * measuring somebody's arm.
   */
  PRODUCE_HUE_DEG: {
    label: 'Produce hue centre', default: 95, min: 0, max: 359, step: 1, unit: 'deg',
    group: 'vision',
  },
  PRODUCE_HUE_TOLERANCE_DEG: {
    label: 'Produce hue tolerance', default: 35, min: 5, max: 180, step: 1, unit: 'deg',
    group: 'vision',
  },

  // --- measurement -----------------------------------------------------------
  /**
   * The in-scene ruler. Measure the actual cucumber once and type it in.
   *
   * Everything downstream is a ratio against this, so it is the only absolute length in the
   * program, and the only number where a mistake cannot be caught by any internal check.
   */
  CUCUMBER_DIAMETER_MM: {
    label: 'Cucumber diameter', default: 42, min: 10, max: 120, step: 0.5, unit: 'mm',
    group: 'measurement',
  },
  SETTLE_FRAMES: {
    label: 'Settle window', default: 5, min: 2, max: 30, step: 1, unit: 'frames',
    group: 'measurement',
  },
  SETTLE_BAND_MM: {
    label: 'Settle band', default: 0.5, min: 0.05, max: 5, step: 0.05, unit: 'mm',
    group: 'measurement',
  },
  MIN_CUT_MM: {
    label: 'Smallest cut worth recording', default: 1, min: 0.2, max: 10, step: 0.1, unit: 'mm',
    group: 'measurement',
  },
  MAX_CUT_MM: {
    label: 'Largest plausible cut', default: 25, min: 5, max: 100, step: 1, unit: 'mm',
    group: 'measurement',
  },
  MAX_SCALE_RESIDUAL: {
    label: 'Diameter drift before a change is a shove', default: 0.03,
    min: 0.005, max: 0.2, step: 0.005, unit: '',
    group: 'measurement',
  },
  SLICE_MAJOR_TOLERANCE: {
    label: 'Slice long side vs stub diameter', default: 0.15,
    min: 0.02, max: 0.5, step: 0.01, unit: '',
    group: 'measurement',
  },
  MAX_SLICE_ASPECT: {
    label: 'Squarest a blob may be and still be edge-on', default: 0.6,
    min: 0.1, max: 0.95, step: 0.05, unit: '',
    group: 'measurement',
  },
  /**
   * Counted in frames, so it has to be read against the frame rate the pipeline actually
   * achieves -- about 8fps at 720p. Five frames is therefore ~600ms, which is the interval
   * intended: nobody cuts twice that fast with a bench scraper, and the slice still has to be
   * moved clear. At the 15 this started at the camera would have ignored nearly two seconds.
   */
  REFRACTORY_FRAMES: {
    label: 'Ignore after a cut', default: 5, min: 0, max: 120, step: 1, unit: 'frames',
    group: 'measurement',
  },
  BUDGET_SLACK: {
    label: 'Recorded plus remaining, over original', default: 1.05,
    min: 1, max: 1.5, step: 0.01, unit: '',
    group: 'measurement',
  },
  /**
   * DECISIONS entry 4: the two methods measure genuinely different quantities -- side-profile is
   * perpendicular, stub-delta is axial, and on a slanted cut they differ by cos(angle). So this
   * is a reporting threshold and never a gate. A disagreement is information, not a reason to
   * discard a record.
   */
  CROSSCHECK_TOLERANCE_MM: {
    label: 'Cross-check agreement', default: 1.5, min: 0.1, max: 10, step: 0.1, unit: 'mm',
    group: 'measurement',
  },

  // --- scoring ---------------------------------------------------------------
  /**
   * 6mm, not master spec 7.4's 3mm, and the tolerance is 2mm rather than 0.5mm.
   * DECISIONS entry 14 carries the argument; the short version is arithmetic.
   *
   * accuracy = exp(-|mean - target| / tolerance). Against a 3mm target at 0.5mm tolerance a
   * 6mm mean scores 0.0025 and an 8mm mean scores 0.000045. A person cutting a cucumber with a
   * blunt bench scraper produces 5-10mm rounds, so every score on the board would have read
   * zero all night -- not because the measurement failed, but because the target was set for a
   * knife skill nobody in the room has.
   *
   * The spec's own demo beat expects "6.1mm average, +/-3.2mm" improving to "+/-1.4mm". That
   * beat is carried by SIGMA, which is what actually improves in ninety seconds. Targeting 6mm
   * keeps the accuracy term on a live gradient too (0.61 at 5mm, 1.0 at 6mm, 0.37 at 8mm) so
   * both halves of the score move. The slider still reaches 0.5mm for anyone who wants it.
   */
  TARGET_THICKNESS_MM: {
    label: 'Target thickness', default: 6, min: 0.5, max: 30, step: 0.1, unit: 'mm',
    group: 'scoring',
  },
  TOLERANCE_MM: {
    label: 'Thickness tolerance', default: 2, min: 0.1, max: 5, step: 0.1, unit: 'mm',
    group: 'scoring',
  },
  TARGET_SIGMA_MM: {
    label: 'Target sigma', default: 2, min: 0.1, max: 5, step: 0.1, unit: 'mm',
    group: 'scoring',
  },
  /**
   * Retained although nothing measures an angle yet. One fixed camera cannot resolve cut slant,
   * so every record leaves angleDeviationDeg undefined and scoreSession renormalises the two
   * surviving weights rather than defaulting the angle to zero. Kept because this is the key a
   * second camera would populate, and scoring.ts already reads it when one does.
   */
  ANGLE_TOLERANCE_DEG: {
    label: 'Angle tolerance', default: 5, min: 0.5, max: 45, step: 0.5, unit: 'deg',
    group: 'scoring',
  },

  // --- feedback --------------------------------------------------------------
  /**
   * Master spec 9.5: Gentle Nonna at 0, Full Service at 1.
   *
   * Listed there as the funniest control in the game AND as an accessibility feature, and it is
   * genuinely both. A theatrical chef shouting at somebody already nervous about a knife is a
   * bad first thirty seconds, and a judge who wants to be shouted at should be able to ask.
   */
  CHEF_INTENSITY: {
    label: 'Chef intensity (nonna to full service)', default: 1,
    min: 0, max: 1, step: 0.1, unit: '',
    group: 'feedback',
  },
  MAX_THICKNESS_MM: {
    label: 'Thickness reading as full intensity', default: 15,
    min: 2, max: 60, step: 0.5, unit: 'mm',
    group: 'feedback',
  },
  AUDIO_BASE_HZ: {
    label: 'Chop base frequency', default: 320, min: 60, max: 1200, step: 10, unit: 'Hz',
    group: 'feedback',
  },
  AUDIO_PITCH_RANGE_HZ: {
    label: 'Chop pitch range across accuracy', default: 480,
    min: 0, max: 2000, step: 10, unit: 'Hz',
    group: 'feedback',
  },
  AUDIO_BURST_MS: {
    label: 'Chop burst duration', default: 90, min: 10, max: 500, step: 5, unit: 'ms',
    group: 'feedback',
  },
  AUDIO_BANDPASS_Q: {
    label: 'Chop bandpass Q', default: 6, min: 0.5, max: 30, step: 0.5, unit: '',
    group: 'feedback',
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
