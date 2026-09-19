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
  minAreaPx: 900,
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

export function segment(
  frame: ImageData,
  opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): Blob[] {
  const c = requireCv();

  // Every Mat below lives in the WASM heap and is NOT garbage collected. At 30fps a single
  // missed delete() exhausts the heap in well under a minute, and the failure looks like the
  // camera dying rather than like a leak. Hence one tracked list and one finally.
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(m: T): T => {
    owned.push(m);
    return m;
  };

  try {
    const rgba = own(c.matFromImageData(frame));
    const hsv = own(new c.Mat());
    const rgb = own(new c.Mat());
    c.cvtColor(rgba, rgb, c.COLOR_RGBA2RGB);
    c.cvtColor(rgb, hsv, c.COLOR_RGB2HSV);

    const satFloor = Math.round(Math.max(0, Math.min(1, opts.minSaturation)) * 255);
    const low = own(new c.Mat(frame.height, frame.width, c.CV_8UC3, [0, satFloor, 40, 0]));
    const high = own(new c.Mat(frame.height, frame.width, c.CV_8UC3, [179, 255, 255, 0]));
    const mask = own(new c.Mat());
    c.inRange(hsv, low, high, mask);

    const k = Math.max(1, opts.morphKernelPx | 1);
    const kernel = own(c.getStructuringElement(c.MORPH_ELLIPSE, new c.Size(k, k)));
    // Open first to kill speckle, then close to fill the pinholes that specular highlights
    // punch through the middle of a glossy tomato. The other order fills the speckle in.
    c.morphologyEx(mask, mask, c.MORPH_OPEN, kernel);
    c.morphologyEx(mask, mask, c.MORPH_CLOSE, kernel);

    const contours = own(new c.MatVector()) as unknown as CvContours;
    const hierarchy = own(new c.Mat());
    c.findContours(mask, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);

    const blobs: Blob[] = [];

    // Reused across every contour in this frame; see the note at the mean-colour call below.
    const blobMask = own(c.Mat.zeros(frame.height, frame.width, c.CV_8UC1));
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
      // The mask and the one-element vector are allocated once for the whole frame and reset
      // per contour. Allocating a full-frame Mat inside the loop costs an extra
      // width*height byte wipe per blob, which at 1280x720 with five blobs was the single
      // largest cost in the pipeline.
      blobMask.setTo(ZERO);
      one.set(0, contour);
      c.drawContours(blobMask, one, 0, WHITE, -1);
      const mean = c.mean(hsv, blobMask);

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
