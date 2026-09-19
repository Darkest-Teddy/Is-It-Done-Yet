import type { Box } from './types.js';

/**
 * Turning a normalised detection box into the pixel rectangle that actually gets read.
 *
 * Pure, because getting this wrong is silent. Every mistake here -- cropping from the wrong
 * image, forgetting the padding, upscaling by the wrong factor -- produces a crop that looks
 * fine in a debug view and reads as gibberish, and the natural reaction is to blame the OCR
 * engine and start swapping engines.
 */

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CropOptions {
  /** Fraction of the box's own size added on every side. */
  readonly padFrac: number;
  /**
   * The x-height Tesseract wants, in pixels.
   *
   * This is the single most impactful number in the whole OCR path. Tesseract is trained on
   * roughly 300dpi scans and its accuracy falls off a cliff below about 20px of x-height;
   * around 30-40px it is at its best and more buys nothing. Passthrough text at arm's length is
   * routinely 8-12px, so the upscale is not a nicety -- it is the difference between reading
   * the label and not.
   */
  readonly targetTextPx: number;
  /** Never upscale past this; beyond it the interpolation is inventing detail, slowly. */
  readonly maxUpscale: number;
}

export const DEFAULT_CROP_OPTIONS: CropOptions = {
  padFrac: 0.12,
  targetTextPx: 32,
  maxUpscale: 4,
};

/**
 * Normalised box to a padded pixel rect, clamped to the frame.
 *
 * The padding matters more than it looks. Detectors are trained to draw a box tight around the
 * glyphs, and Tesseract's own line-finding wants a margin of background to work against -- a
 * pixel-tight crop routinely loses ascenders and the first character. Clamping afterwards
 * means a box against the edge of frame simply gets less padding on that side rather than an
 * out-of-bounds read.
 */
export function boxToRect(
  box: Box, widthPx: number, heightPx: number, opts: CropOptions = DEFAULT_CROP_OPTIONS,
): PixelRect | null {
  if (!(widthPx > 0) || !(heightPx > 0)) return null;
  const values = [box.x, box.y, box.w, box.h];
  if (!values.every((v) => Number.isFinite(v))) return null;
  if (!(box.w > 0) || !(box.h > 0)) return null;

  const padX = box.w * opts.padFrac * widthPx;
  const padY = box.h * opts.padFrac * heightPx;

  const left = Math.max(0, Math.floor(box.x * widthPx - padX));
  const top = Math.max(0, Math.floor(box.y * heightPx - padY));
  const right = Math.min(widthPx, Math.ceil((box.x + box.w) * widthPx + padX));
  const bottom = Math.min(heightPx, Math.ceil((box.y + box.h) * heightPx + padY));

  const w = right - left;
  const h = bottom - top;
  if (w < 1 || h < 1) return null;
  return { x: left, y: top, w, h };
}

/**
 * How much to enlarge a crop so its text lands in Tesseract's comfortable range.
 *
 * Estimated from the crop's HEIGHT, on the assumption that a text region is roughly one line
 * tall. For a multi-line region that overestimates the x-height and so under-upscales, which
 * fails in the safe direction -- slightly small text still reads, whereas a crop blown up 8x
 * is slow and no more legible.
 *
 * Never returns less than 1. Downscaling a crop to hit a target would be throwing away the
 * only signal there is.
 */
export function upscaleFactor(
  rect: PixelRect, opts: CropOptions = DEFAULT_CROP_OPTIONS,
): number {
  if (!(rect.h > 0)) return 1;
  // An x-height is roughly half a line box for most Latin type.
  const estimatedTextPx = rect.h * 0.5;
  const wanted = opts.targetTextPx / estimatedTextPx;
  return Math.min(opts.maxUpscale, Math.max(1, wanted));
}

/**
 * Whether a crop is worth sending to OCR at all.
 *
 * A region only a few pixels tall carries no recoverable glyph information, and upscaling it
 * produces a confident-looking read of pure interpolation noise. Refusing is better than
 * reading: `textVote` treats a missing read as no evidence, but a wrong read is evidence for
 * the wrong answer and takes several good frames to outvote.
 */
export function worthReading(rect: PixelRect, minHeightPx = 10): boolean {
  return rect.h >= minHeightPx && rect.w >= minHeightPx;
}
