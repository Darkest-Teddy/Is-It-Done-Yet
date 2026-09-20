/**
 * What the two camera screens actually read off the counter.
 *
 * Thin on purpose. The segmentation, the naming and the tallying already exist in
 * `src/vision` and `src/core` and are tested without a browser; this file is only the bit that
 * gets a frame out of a `<video>`, sizes it sensibly, and hands the result back in a shape the
 * panels can render.
 *
 * TWO RULES, BOTH FROM THE MASTER SPEC.
 *
 * Never block the render loop. OpenCV is synchronous WASM on the main thread, and at full
 * camera resolution it costs a quarter of a second per frame -- `lab.html` measured 259ms at
 * 1080p against 28ms at 640x360. So analysis is throttled, runs on a small canvas, and skips
 * itself whenever the previous pass ran long. The `<video>` underneath is composited by the
 * browser and is completely unaffected either way, which is the whole reason the passthrough
 * backdrop is a DOM element rather than something drawn into a canvas.
 *
 * Load the WASM only when a camera screen is first opened. It is a ~15MB download; making the
 * title screen wait for it would put half a minute of blank between a judge picking up the
 * headset and anything happening.
 */

import { identify } from '../core/ingredients.js';
import { DEFAULT_SEGMENT_OPTIONS, segment, useOpenCv, type Blob, type SegmentOptions }
  from '../vision/segment.js';

export interface Detection {
  readonly ingredient: string;
  readonly confidence: number;
  /** Centre in frame coordinates, 0..1 across and down. Resolution-independent on purpose. */
  readonly x: number;
  readonly y: number;
  /** Short side of the oriented rect, in analysis pixels. Slice thickness, uncalibrated. */
  readonly minorPx: number;
  readonly areaPx: number;
}

export interface Analysis {
  readonly detections: readonly Detection[];
  /** Blobs the segmenter found but no profile would claim. Worth showing as a count, not a name. */
  readonly unnamed: number;
  readonly elapsedMs: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

export const EMPTY_ANALYSIS: Analysis = {
  detections: [], unnamed: 0, elapsedMs: 0, frameWidth: 0, frameHeight: 0,
};

let cvReady: Promise<boolean> | null = null;

/**
 * Loads OpenCV once, resolving false rather than throwing if it cannot be had.
 *
 * False is a legitimate outcome, not an error: the app is still usable without the scan (every
 * ingredient can be added by hand), and a rejected promise here would take a whole screen down
 * with it over an optional capability.
 */
export function loadVision(timeoutMs?: number): Promise<boolean> {
  cvReady ??= (async () => {
    try {
      const module = await import('@techstark/opencv-js');
      const cv = module.default as unknown;

      // OpenCV.js resolves its WASM asynchronously and builds differ in how they announce it:
      // some export a thenable, older ones call `onRuntimeInitialized`. Handle both, the same
      // way `src/main.ts` does.
      const instance = typeof (cv as { then?: unknown }).then === 'function'
        ? await (cv as Promise<unknown>)
        : await new Promise<unknown>((resolve) => {
            (cv as { onRuntimeInitialized: () => void }).onRuntimeInitialized = () => resolve(cv);
          });

      useOpenCv(instance);
      return true;
    } catch (error) {
      console.warn('[menu] OpenCV unavailable, scanning disabled', error);
      return false;
    }
  })();

  const work = cvReady;
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;

  // The caller is released on a timer; the load is not cancelled. That asymmetry is the point.
  //
  // Two things here can wait forever and neither of them rejects. The chunk is ~15MB, and a
  // stalled fetch on venue wifi produces no error at all -- it simply does not arrive. Worse,
  // the `onRuntimeInitialized` promise above has no rejection path and no timer: a build that
  // never announces its runtime leaves that `await` unsettled for the life of the page. The
  // loading screen awaited this with no ceiling, had no rail and no Escape handler, so the
  // only way out of either failure was to take the headset off. That is the worst shape a
  // failure can have in a demo -- it is indistinguishable from the app having crashed, and it
  // happens on exactly the network the venue will have.
  //
  // Releasing the caller rather than cancelling the work means a slow load still lands: the
  // memoised promise keeps going, `useOpenCv` still runs when it arrives, and the next caller
  // -- the counter screen's Scan button -- gets `true` from the same promise. A cancelled load
  // would have to be started again, and the second `onRuntimeInitialized` assignment would
  // never fire because the first one already consumed the callback.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[menu] OpenCV still loading after ${timeoutMs}ms, continuing without it`);
      resolve(false);
    }, timeoutMs);
    void work.then(
      (ok) => { clearTimeout(timer); resolve(ok); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
}

export const isVisionLoaded = (): boolean => cvReady !== null;

/**
 * Pulls frames out of a video at a bounded size.
 *
 * Draws the video straight into the small canvas rather than grabbing full resolution and
 * scaling after: a full-resolution `getImageData` is the single most expensive thing in the
 * loop and it would be thrown away immediately.
 */
export class FrameReader {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private maxEdge = 480) {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
  }

  read(video: HTMLVideoElement): ImageData | null {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (vw === 0 || vh === 0) return null;

    const k = Math.min(1, this.maxEdge / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * k));
    const h = Math.max(1, Math.round(vh * k));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}

function toDetections(blobs: readonly Blob[], width: number, height: number): {
  detections: Detection[];
  unnamed: number;
} {
  const detections: Detection[] = [];
  let unnamed = 0;

  for (const blob of blobs) {
    const named = identify(blob.features);
    if (named === null) {
      unnamed += 1;
      continue;
    }
    detections.push({
      ingredient: named.name,
      confidence: named.confidence,
      x: blob.centroid.x / width,
      y: blob.centroid.y / height,
      // The oriented rect's minor axis is the thickness of a slice: for a cucumber round the
      // major axis is its diameter and the minor is how thick it was cut.
      minorPx: blob.rect.minorPx,
      areaPx: blob.areaPx,
    });
  }

  return { detections, unnamed };
}

/** One synchronous pass. Returns null when the video has no frame yet or OpenCV is not loaded. */
export function analyseFrame(
  video: HTMLVideoElement,
  reader: FrameReader,
  opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): Analysis | null {
  const frame = reader.read(video);
  if (frame === null) return null;

  const started = performance.now();
  let blobs: Blob[] = [];
  try {
    blobs = segment(frame, opts);
  } catch (error) {
    console.warn('[menu] segmentation failed', error);
    return null;
  }

  const { detections, unnamed } = toDetections(blobs, frame.width, frame.height);
  return {
    detections,
    unnamed,
    elapsedMs: performance.now() - started,
    frameWidth: frame.width,
    frameHeight: frame.height,
  };
}

/**
 * A self-throttling analysis loop.
 *
 * `intervalMs` is a floor, not a promise: if a pass takes longer than the interval the next one
 * waits for twice however long the last one actually took. On a headset that is the difference
 * between a screen that gets slightly less fresh under load and one that locks up entirely.
 */
export class AnalysisLoop {
  private raf = 0;
  private nextAt = 0;
  private running = false;
  private readonly reader: FrameReader;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onResult: (analysis: Analysis) => void,
    private readonly intervalMs = 220,
    maxEdge = 420,
  ) {
    this.reader = new FrameReader(maxEdge);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (now < this.nextAt) return;

      const analysis = analyseFrame(this.video, this.reader);
      if (analysis === null) {
        this.nextAt = now + this.intervalMs;
        return;
      }
      this.nextAt = now + Math.max(this.intervalMs, analysis.elapsedMs * 2);
      this.onResult(analysis);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

/**
 * How even a set of cuts is, from the spread of their short sides.
 *
 * Deliberately scale-free. Everything else about slice measurement needs pixels-per-millimetre
 * and therefore a calibration step, but the coefficient of variation cancels the scale out:
 * ten slices all 40px across score exactly the same as ten slices all 4mm across, and that is
 * the number the competitive round is really about. Calling it "94% even" is honest in a way
 * that quoting millimetres off an uncalibrated camera would not be.
 */
export function evenness(widths: readonly number[]): number | null {
  if (widths.length < 3) return null;
  const mean = widths.reduce((sum, w) => sum + w, 0) / widths.length;
  if (mean <= 0) return null;
  const variance = widths.reduce((sum, w) => sum + (w - mean) ** 2, 0) / widths.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, Math.min(1, 1 - cv));
}
