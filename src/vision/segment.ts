import type { ShapeFeatures } from '../core/ingredients.js';

/**
 * Turns a camera frame into blobs with the features `src/core/ingredients` classifies.
 *
 * This is the only place OpenCV appears. Everything downstream -- identification, measurement,
 * scoring, recipe checking -- takes plain numbers, which is what lets all of it be tested
 * without a camera, a browser, or a WASM runtime.
 *
 * SEGMENTATION STRATEGY: produce against a light board separates on SATURATION, not on hue or
 * brightness. A white board is almost achromatic however bright the hall lights are, whereas a
 * cucumber, tomato or carrot is strongly coloured. Thresholding on brightness instead would put
 * every shadow your own arm casts into the foreground.
 */

/** Minimal surface of the OpenCV.js global this module actually uses. */
interface CvMat {
  delete(): void;
  data32S: Int32Array;
  rows: number;
}
interface CvContours {
  delete(): void;
  size(): number;
  get(i: number): CvMat;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
type Cv = any;

let cv: Cv | null = null;

/** Hands the module its OpenCV instance. Call once, after the runtime reports ready. */
export function useOpenCv(instance: Cv): void {
  cv = instance;
}

function requireCv(): Cv {
  if (cv === null) {
    throw new Error('OpenCV is not loaded. Call useOpenCv(cv) once cv.onRuntimeInitialized fires.');
  }
  return cv;
}

export interface PointPx { readonly x: number; readonly y: number; }

export interface OrientedRect {
  readonly centre: PointPx;
  /** Always the longer side. */
  readonly majorPx: number;
  /** Always the shorter side. */
  readonly minorPx: number;
  /** Rotation of the major axis from the image x-axis, degrees. */
  readonly angleDeg: number;
}

export interface Blob {
  readonly features: ShapeFeatures;
  readonly areaPx: number;
  readonly centroid: PointPx;
  readonly rect: OrientedRect;
  readonly contour: readonly PointPx[];
}

export interface SegmentOptions {
  /**
   * Saturation floor, 0..1. Anything below is treated as board, not food.
   * TUNED, not sourced -- re-check under venue lighting, which is usually green-heavy
   * fluorescent and lifts the apparent saturation of everything including the board.
   */
  readonly minSaturation: number;
  /** Blobs smaller than this are noise: crumbs, specular glints, JPEG mush. */
  readonly minAreaPx: number;
  /** Kernel size for the open/close that removes speckle and fills pinholes. Odd, >= 1. */
  readonly morphKernelPx: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  minSaturation: 0.22,
  // 300, not 900. A slice seen edge-on is a thin sliver: 42mm x 6mm at 0.52mm/px is ~930px2 and
  // a 4mm one is 620px2, so the old floor silently discarded the very thing being measured.
  minAreaPx: 300,
  morphKernelPx: 5,
};

/**
 * OpenCV packs 8-bit hue into [0, 179] so it fits a byte -- it is degrees halved, not degrees.
 * `src/core` works in real degrees so its windows can be checked against a colour picker, so
 * the doubling happens here, once, at the boundary. Forgetting it does not throw: it silently
 * maps every hue into the red-through-green half of the wheel, and tomatoes start reading as
 * plausible-looking nonsense.
 */
const CV_HUE_TO_DEGREES = 2;

interface CvMatLike { delete(): void; data: Uint8Array; roi(r: unknown): CvMatLike;
  setTo(s: unknown): void }

/**
 * Per-frame working buffers, kept between frames.
 *
 * Measured at 1920x1080: allocating these inside the frame cost ~250ms REGARDLESS of how many
 * blobs were found -- 4fps, and a pipeline far too sluggish to detect a cut against. Almost
 * none of it was pixel work. The two bound Mats alone are 6MB each, allocated and filled with a
 * constant on every frame, purely because the JS binding of inRange takes Mats where the C++
 * API takes Scalars.
 *
 * These are deliberately NOT in the per-frame owned list. They are freed when the frame size,
 * the kernel or the saturation floor changes, and they are the one place in this file where a
 * Mat legitimately outlives the call that created it.
 */
interface Scratch {
  readonly width: number;
  readonly height: number;
  readonly kernelPx: number;
  readonly satFloor: number;
  readonly rgba: CvMatLike;
  readonly rgb: CvMatLike;
  readonly hsv: CvMatLike;
  readonly mask: CvMatLike;
  readonly low: CvMatLike;
  readonly high: CvMatLike;
  readonly kernel: CvMatLike;
  readonly blobMask: CvMatLike;
}

let scratch: Scratch | null = null;

/** Frees the cached buffers. Exported so a teardown or a test can prove nothing is retained. */
export function releaseScratch(): void {
  if (scratch === null) return;
  const s = scratch;
  scratch = null;
  for (const m of [s.rgba, s.rgb, s.hsv, s.mask, s.low, s.high, s.kernel, s.blobMask]) {
    try { m.delete(); } catch { /* already gone; a double delete must not mask a real error */ }
  }
}

function getScratch(
  c: Cv, width: number, height: number, kernelPx: number, satFloor: number,
): Scratch {
  if (scratch !== null && scratch.width === width && scratch.height === height
    && scratch.kernelPx === kernelPx && scratch.satFloor === satFloor) {
    return scratch;
  }
  releaseScratch();
  scratch = {
    width, height, kernelPx, satFloor,
    rgba: new c.Mat(height, width, c.CV_8UC4) as CvMatLike,
    rgb: new c.Mat(height, width, c.CV_8UC3) as CvMatLike,
    hsv: new c.Mat(height, width, c.CV_8UC3) as CvMatLike,
    mask: new c.Mat(height, width, c.CV_8UC1) as CvMatLike,
    low: new c.Mat(height, width, c.CV_8UC3, [0, satFloor, 40, 0]) as CvMatLike,
    high: new c.Mat(height, width, c.CV_8UC3, [179, 255, 255, 0]) as CvMatLike,
    kernel: c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(kernelPx, kernelPx)) as CvMatLike,
    blobMask: c.Mat.zeros(height, width, c.CV_8UC1) as CvMatLike,
  };
  return scratch;
}

export function segment(
  frame: ImageData,
  opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): Blob[] {
  const c = requireCv();

  // Every Mat created HERE lives in the WASM heap and is NOT garbage collected. At 30fps a
  // single missed delete() exhausts the heap in well under a minute, and the failure looks like
  // the camera dying rather than like a leak. Hence one tracked list and one finally. The
  // cached scratch buffers above are the deliberate exception, freed on a size change.
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(m: T): T => {
    owned.push(m);
    return m;
  };

  try {
    const satFloor = Math.round(Math.max(0, Math.min(1, opts.minSaturation)) * 255);
    const k = Math.max(1, opts.morphKernelPx | 1);
    const buf = getScratch(c, frame.width, frame.height, k, satFloor);
    const { rgba, rgb, hsv, mask, low, high, kernel, blobMask } = buf;

    rgba.data.set(frame.data);
    c.cvtColor(rgba, rgb, c.COLOR_RGBA2RGB);
    c.cvtColor(rgb, hsv, c.COLOR_RGB2HSV);
    c.inRange(hsv, low, high, mask);

    // Open first to kill speckle, then close to fill the pinholes that specular highlights
    // punch through the middle of a glossy tomato. The other order fills the speckle in.
    c.morphologyEx(mask, mask, c.MORPH_OPEN, kernel);
    c.morphologyEx(mask, mask, c.MORPH_CLOSE, kernel);

    const contours = own(new c.MatVector()) as unknown as CvContours;
    const hierarchy = own(new c.Mat());
    c.findContours(mask, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

    const blobs: Blob[] = [];

    const one = own(new c.MatVector());
    one.push_back(own(new c.Mat()));
    const ZERO = new c.Scalar(0);
    const WHITE = new c.Scalar(255);
    const hull = own(new c.Mat());

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const areaPx = c.contourArea(contour);
      if (areaPx < opts.minAreaPx) continue;

      const perimeterPx = c.arcLength(contour, true);
      if (perimeterPx <= 0) continue;

      c.convexHull(contour, hull);
      const hullArea = c.contourArea(hull);

      const r = c.minAreaRect(contour);
      const majorPx = Math.max(r.size.width, r.size.height);
      const minorPx = Math.min(r.size.width, r.size.height);
      if (minorPx <= 0) continue;

      // Mean colour over THIS blob only. Averaging the whole frame would blend the board in
      // and desaturate every reading toward grey.
      //
      // Everything here is bounded by the blob's own bounding box. The mask is shared across
      // the frame, but a filled contour only dirties pixels inside its own bounds, so both the
      // average and the clear stay proportional to the blob rather than to the frame. Doing it
      // full-frame -- a 2MP masked mean plus a 2MP wipe per blob -- cost more at 1080p than the
      // rest of this loop put together.
      const bb = c.boundingRect(contour);
      one.set(0, contour);
      c.drawContours(blobMask, one, 0, WHITE, -1);
      const maskRoi = blobMask.roi(bb);
      const hsvRoi = hsv.roi(bb);
      const mean = c.mean(hsvRoi, maskRoi);
      maskRoi.setTo(ZERO);
      maskRoi.delete();
      hsvRoi.delete();

      blobs.push({
        areaPx,
        centroid: { x: r.center.x, y: r.center.y },
        rect: {
          centre: { x: r.center.x, y: r.center.y },
          majorPx,
          minorPx,
          // minAreaRect's angle describes width, which may be the shorter side. Re-express it
          // against the major axis so the number always means the same thing downstream.
          angleDeg: r.size.width >= r.size.height ? r.angle : r.angle + 90,
        },
        contour: readContour(contour),
        features: {
          hueDeg: mean[0] * CV_HUE_TO_DEGREES,
          saturation: mean[1] / 255,
          value: mean[2] / 255,
          elongation: majorPx / minorPx,
          solidity: hullArea > 0 ? areaPx / hullArea : 0,
          circularity: (4 * Math.PI * areaPx) / (perimeterPx * perimeterPx),
        },
      });
    }

    return blobs;
  } finally {
    for (const m of owned) {
      try {
        m.delete();
      } catch {
        // A double-delete must not mask the real error on the way out of a failed frame.
      }
    }
  }
}

/** OpenCV.js stores a contour as a flat Int32Array of interleaved x, y. */
function readContour(contour: CvMat): PointPx[] {
  const data = contour.data32S;
  const points: PointPx[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    points.push({ x: data[i]!, y: data[i + 1]! });
  }
  return points;
}
