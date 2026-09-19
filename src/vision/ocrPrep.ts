import {
  boxToRect, type CropOptions, DEFAULT_CROP_OPTIONS, type PixelRect, upscaleFactor, worthReading,
} from '../core/perception/crop.js';
import type { Box } from '../core/perception/types.js';

/**
 * OpenCV preprocessing for an OCR crop.
 *
 * This module is where most of the OCR accuracy in the project comes from, and almost none of
 * it comes from the OCR engine. Tesseract on a raw passthrough frame reads close to nothing;
 * Tesseract on a deskewed, upscaled, contrast-normalised crop of a single label reads it. The
 * work is all here.
 *
 * THE RULE THAT MATTERS MOST: crop from the FULL-RESOLUTION frame, never from the downscaled
 * copy that was sent to the detector. Detection runs at 640px because a detector does not need
 * more; OCR needs every pixel there is. Cropping a 120x40 region out of the 640px copy and
 * upscaling it 4x is upscaling something that was already thrown away -- it looks like it is
 * working, produces a plausible blurry crop, and reads as gibberish. This is the single
 * easiest way to lose the entire feature while believing it is implemented.
 *
 * THE SECOND RULE: do not over-process. Tesseract runs its own Otsu binarisation internally
 * and is good at it. Handing it an already-binarised image usually makes things worse, because
 * any threshold applied here is applied with less information than Tesseract has. Give it a
 * clean, large, well-exposed GREYSCALE image and stop. Binarise only when the lighting across
 * the crop is genuinely uneven -- a headset shadow falling across half a label -- and then use
 * an adaptive threshold, never a global one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cv = any;

let cv: Cv | null = null;

/** Shares the instance with `segment.ts`. Call once, after the runtime reports ready. */
export function useOpenCv(instance: Cv): void {
  cv = instance;
}

function requireCv(): Cv {
  if (cv === null) {
    throw new Error('OpenCV is not loaded. Call useOpenCv(cv) once the runtime is ready.');
  }
  return cv;
}

export interface PrepOptions extends CropOptions {
  /**
   * Correct the text baseline angle before reading.
   *
   * Tesseract tolerates a couple of degrees and degrades fast past about five. A label on a jar
   * seen from a headset is rarely level.
   */
  readonly deskew: boolean;
  /**
   * Equalise local contrast with CLAHE.
   *
   * Plain histogram equalisation is the wrong tool here: it is global, so a bright highlight on
   * a glossy label drags the whole curve and crushes the text into a few levels. CLAHE works
   * in tiles and leaves the rest of the crop alone.
   */
  readonly clahe: boolean;
  /**
   * Adaptive threshold. Off by default, deliberately -- see the note at the top of the file.
   * Turn it on only for genuinely uneven lighting.
   */
  readonly binarize: boolean;
}

export const DEFAULT_PREP_OPTIONS: PrepOptions = {
  ...DEFAULT_CROP_OPTIONS,
  deskew: true,
  clahe: true,
  binarize: false,
};

export interface PreparedCrop {
  readonly canvas: HTMLCanvasElement;
  readonly rect: PixelRect;
  readonly upscale: number;
  /** Degrees of rotation that were corrected out, for the debug overlay. */
  readonly deskewedDeg: number;
}

/**
 * Estimates the text baseline angle from the crop itself.
 *
 * Threshold, dilate horizontally so the glyphs of a word merge into one blob, then take the
 * minimum-area rectangle of the largest blob. A line of text is a long thin rectangle and its
 * long axis IS the baseline, which is why this works at all without knowing anything about
 * characters.
 *
 * Returns 0 rather than a guess when nothing convincing is found. A deskew step that trusts a
 * fabricated angle rotates readable text into unreadable text, which is strictly worse than
 * not deskewing.
 */
export function estimateSkewDeg(c: Cv, grey: any): number {
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(m: T): T => { owned.push(m); return m; };
  try {
    const bin = own(new c.Mat());
    c.threshold(grey, bin, 0, 255, c.THRESH_BINARY_INV + c.THRESH_OTSU);

    // Wide and short: merge letters into words and words into lines, without merging the line
    // above into the line below.
    const kernel = own(c.getStructuringElement(c.MORPH_RECT, new c.Size(15, 3)));
    c.morphologyEx(bin, bin, c.MORPH_CLOSE, kernel);

    const contours = own(new c.MatVector());
    const hierarchy = own(new c.Mat());
    c.findContours(bin, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

    let bestArea = 0;
    let angle = 0;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = c.contourArea(contour);
      if (area <= bestArea) continue;
      const r = c.minAreaRect(contour);
      const long = Math.max(r.size.width, r.size.height);
      const short = Math.min(r.size.width, r.size.height);
      // Only trust a blob that is actually line-shaped. A square blob's "angle" is arbitrary.
      if (short <= 0 || long / short < 2.5) continue;
      bestArea = area;
      angle = r.size.width >= r.size.height ? r.angle : r.angle + 90;
    }

    // Fold into [-45, 45]. Past that the text is not skewed, it is sideways, and rotating by
    // the folded angle would be wrong -- that case needs a 90 degree decision this does not make.
    while (angle > 45) angle -= 90;
    while (angle < -45) angle += 90;
    return Math.abs(angle) < 45 ? angle : 0;
  } finally {
    for (const m of owned) { try { m.delete(); } catch { /* already gone */ } }
  }
}

/**
 * Crops a region out of the full-resolution frame and prepares it for OCR.
 *
 * Returns null when the region is too small to carry recoverable text, rather than returning a
 * crop that will produce a confident wrong reading.
 */
export function prepareCrop(
  frame: HTMLCanvasElement,
  box: Box,
  opts: PrepOptions = DEFAULT_PREP_OPTIONS,
): PreparedCrop | null {
  const c = requireCv();
  const rect = boxToRect(box, frame.width, frame.height, opts);
  if (rect === null || !worthReading(rect)) return null;

  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(m: T): T => { owned.push(m); return m; };

  try {
    // Lift the crop out with a plain 2D context first. Going through OpenCV for this would mean
    // pulling the whole frame into the WASM heap to keep a hundredth of it.
    const cut = document.createElement('canvas');
    cut.width = rect.w;
    cut.height = rect.h;
    const cutCtx = cut.getContext('2d', { willReadFrequently: true });
    if (cutCtx === null) return null;
    cutCtx.drawImage(frame, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

    const src = own(c.matFromImageData(cutCtx.getImageData(0, 0, rect.w, rect.h)));
    const grey = own(new c.Mat());
    c.cvtColor(src, grey, c.COLOR_RGBA2GRAY);

    const deskewedDeg = opts.deskew ? estimateSkewDeg(c, grey) : 0;
    if (Math.abs(deskewedDeg) > 0.5) {
      const centre = new c.Point(grey.cols / 2, grey.rows / 2);
      const m = own(c.getRotationMatrix2D(centre, deskewedDeg, 1));
      // BORDER_REPLICATE, not a constant fill: a black wedge in the corner of a rotated crop
      // is a high-contrast edge, and Tesseract's line finder will happily treat it as a glyph.
      c.warpAffine(grey, grey, m, new c.Size(grey.cols, grey.rows),
        c.INTER_LINEAR, c.BORDER_REPLICATE, new c.Scalar());
    }

    if (opts.clahe) {
      const clahe = own(new c.CLAHE(2.0, new c.Size(8, 8)));
      clahe.apply(grey, grey);
    }

    const upscale = upscaleFactor(rect, opts);
    if (upscale > 1.01) {
      // CUBIC for upscaling. LINEAR is softer and Tesseract wants crisp stroke edges more than
      // it wants smooth gradients.
      c.resize(grey, grey, new c.Size(0, 0), upscale, upscale, c.INTER_CUBIC);
    }

    if (opts.binarize) {
      // Adaptive, never global: a global threshold on unevenly lit text erases whichever half
      // of the label is in shadow, and does it silently.
      c.adaptiveThreshold(grey, grey, 255, c.ADAPTIVE_THRESH_GAUSSIAN_C,
        c.THRESH_BINARY, 31, 10);
    }

    const out = document.createElement('canvas');
    c.imshow(out, grey);
    return { canvas: out, rect, upscale, deskewedDeg };
  } finally {
    for (const m of owned) { try { m.delete(); } catch { /* already gone */ } }
  }
}

/**
 * Downscales a full frame for the DETECTOR, leaving the original alone for OCR.
 *
 * Master spec 10.3: never send 1920x1080. The returned canvas is a separate object precisely so
 * that the full-resolution frame survives for `prepareCrop` to cut from.
 */
export function downscaleForDetection(
  frame: HTMLCanvasElement, longestEdgePx = 640,
): HTMLCanvasElement {
  const scale = Math.min(1, longestEdgePx / Math.max(frame.width, frame.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(frame.width * scale));
  out.height = Math.max(1, Math.round(frame.height * scale));
  const ctx = out.getContext('2d');
  if (ctx !== null) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, 0, 0, out.width, out.height);
  }
  return out;
}
