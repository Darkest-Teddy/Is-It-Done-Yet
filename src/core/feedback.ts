import type { CutRecord } from './metrics.js';

export interface CutFeedback {
  /** 0..1, drives haptic strength and audio amplitude. */
  readonly intensity: number;
  /** 0..1, how close to target thickness. Drives audio pitch. */
  readonly accuracy: number;
  readonly kind: 'clean' | 'uncertain';
}

export interface FeedbackOptions {
  readonly targetThicknessMm: number;
  readonly toleranceMm: number;
  /** A slice this thick reads as full intensity. */
  readonly maxThicknessMm: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Confidence below this makes the feedback audibly hesitant rather than confidently wrong. */
export const UNCERTAIN_BELOW = 0.5;

/**
 * One descriptor, two channels. Master spec 7.2 scales haptics by the cut's size; 12 maps chop
 * pitch to accuracy. Deriving both from one value means they cannot be tuned apart.
 */
export function feedbackForCut(record: CutRecord, opts: FeedbackOptions): CutFeedback {
  const intensity = opts.maxThicknessMm > 0 ? record.thicknessMm / opts.maxThicknessMm : 0;
  const accuracy = Math.exp(
    -Math.abs(record.thicknessMm - opts.targetThicknessMm) / opts.toleranceMm,
  );
  return {
    intensity: clamp01(intensity),
    accuracy: clamp01(accuracy),
    // A low-confidence measurement still gets feedback, but it says so. Silence would read as
    // "no cut detected" and send the player looking for a problem that is not there.
    kind: record.confidence < UNCERTAIN_BELOW ? 'uncertain' : 'clean',
  };
}
