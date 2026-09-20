/**
 * The two detectors behind the counter screen.
 *
 * This is the file the deployed page's own HTML comment points at as `src/ui/scan.ts`. That
 * file is not in this repository and never was (DECISIONS.md #27), so this is a rebuild of it
 * from the behaviour the shipped bundle exhibits -- the same constants, the same two-detector
 * split, the same failure copy.
 *
 * TWO DETECTORS, ON PURPOSE, and they are not redundant.
 *
 * The LIVE COUNT is local: OpenCV segments the frame, `src/core/ingredients.ts` names each
 * blob against six hand-tuned profiles, and a short stability window turns a flickering
 * per-frame answer into a steady tally. It runs four times a second, works with no network at
 * all, and follows an ingredient as it is moved around the board -- but it knows six things.
 *
 * "IDENTIFY EVERYTHING" is one call to a vision model behind `api/vision`. It can name
 * anything and takes a couple of seconds, so it is a button rather than a loop.
 *
 * Neither replaces the other, and the UI shows which said what: a cloud-named chip is tinted
 * leaf, a low-confidence local one is dashed amber. A cook looking at a wrong line needs to
 * know which detector to distrust.
 *
 * WHAT THIS FILE WILL NOT DO. `api/vision` does not exist in this repository -- the deployed
 * page had a relay behind it that was never pushed. So the probe below is honest about that:
 * when the endpoint is absent the button disables itself and says so, rather than failing at
 * the moment someone presses it in front of an audience.
 */

import { hueDistanceDeg, identify } from '../core/ingredients.js';
import type { Category, RawScanItem } from '../core/pantry.js';
import { loadVision } from '../menu/vision.js';
import { DEFAULT_SEGMENT_OPTIONS, segment, type Blob } from '../vision/segment.js';

// --------------------------------------------------------------------------------------------
// Tuning
// --------------------------------------------------------------------------------------------

/** How often a pass is attempted. A floor, not a promise -- see `AnalysisLoop` below. */
const TICK_MS = 250;

/**
 * Longest edge the segmenter ever sees.
 *
 * Not a quality knob. `src/vision/camera.ts` records the measurements: segmentation is purely
 * pixel-bound, costing 28ms at 640x360 against 259ms at 1080p, and it is synchronous WASM on
 * the main thread. Handing it a full camera frame would lock the page for a quarter of a
 * second, four times a second.
 */
const ANALYSIS_MAX_EDGE = 640;

/**
 * The produce window: hues within 75 degrees of 60 (yellow-green).
 *
 * Wide, deliberately. It covers green through yellow into orange, which is where every profile
 * in `PROFILES` lives, and it discards the blue-through-magenta half of the wheel -- hands,
 * sleeves, a phone on the counter, the blue of a tea towel. A tighter window starts dropping
 * real tomatoes under warm kitchen light.
 */
const PRODUCE_HUE_CENTRE_DEG = 60;
const PRODUCE_HUE_TOLERANCE_DEG = 75;

/** Frames the stability window remembers, and the share of them an item must appear in. */
const WINDOW_FRAMES = 6;
const MIN_PRESENCE = 0.5;

/** Longest edge of the JPEG sent to the cloud model, and how long to wait for it. */
const CLOUD_MAX_EDGE = 768;
const CLOUD_TIMEOUT_MS = 45_000;

/**
 * Which category each locally-nameable ingredient belongs to.
 *
 * Only six entries because the local classifier only knows six things. Anything the cloud
 * model names carries its own category and does not come through here.
 */
const LOCAL_CATEGORY: Readonly<Record<string, Category>> = {
  cucumber: 'vegetable',
  tomato: 'vegetable',
  carrot: 'vegetable',
  'red onion': 'vegetable',
  orange: 'fruit',
  lemon: 'fruit',
};

export const categoryOf = (ingredient: string): Category =>
  LOCAL_CATEGORY[ingredient.toLowerCase()] ?? 'unknown';

// --------------------------------------------------------------------------------------------
// The stability window
// --------------------------------------------------------------------------------------------

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

export interface StableCount {
  readonly ingredient: string;
  readonly count: number;
  /** Share of remembered frames this ingredient appeared in, 0..1. Used as its confidence. */
  readonly stability: number;
}

/**
 * Turns a flickering per-frame answer into a tally a person can read.
 *
 * Segmentation is not stable frame to frame: a specular glint splits a cucumber in two, a hand
 * passing over the board removes it entirely, and the raw count jumps between 2 and 4 several
 * times a second. A number doing that is unreadable, and worse, it reads as the system being
 * broken rather than as the system being unsure.
 *
 * So: remember the last six frames, require an ingredient to have appeared in at least half of
 * them before reporting it at all, and report the MEDIAN of its counts rather than the mean.
 * Median because the failure mode is a spike -- one frame that saw six tomatoes because a
 * shadow fell across one -- and a mean carries a spike into the answer where a median ignores
 * it. This is the same hysteresis idea as the confirmation gate in the master spec's §10.2,
 * at a smaller scale.
 */
export class StabilityWindow {
  private readonly frames: Map<string, number>[] = [];

  constructor(private readonly windowFrames = WINDOW_FRAMES) {}

  push(names: readonly string[]): void {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    this.frames.push(counts);
    while (this.frames.length > this.windowFrames) this.frames.shift();
  }

  clear(): void {
    this.frames.length = 0;
  }

  /** False until enough frames have been seen for a reading to mean anything. */
  get warm(): boolean {
    return this.frames.length >= Math.ceil(this.windowFrames / 2);
  }

  read(): readonly StableCount[] {
    if (this.frames.length === 0) return [];

    const seen = new Set<string>();
    for (const frame of this.frames) for (const name of frame.keys()) seen.add(name);

    const out: StableCount[] = [];
    for (const ingredient of seen) {
      const counts = this.frames.map((f) => f.get(ingredient) ?? 0);
      const presence = counts.filter((c) => c > 0).length / this.frames.length;
      if (presence < MIN_PRESENCE) continue;

      const count = median(counts);
      if (count < 1) continue;
      out.push({ ingredient, count, stability: presence });
    }

    return out.sort((a, b) => b.count - a.count || a.ingredient.localeCompare(b.ingredient));
  }
}

// --------------------------------------------------------------------------------------------
// The local pass
// --------------------------------------------------------------------------------------------

export interface LocalPass {
  /** Named blobs, in analysis-canvas pixels, for the overlay to draw. */
  readonly blobs: readonly Blob[];
  /** One label per blob, aligned by index. Null where nothing could be named. */
  readonly labels: readonly (string | null)[];
  readonly width: number;
  readonly height: number;
  readonly elapsedMs: number;
}

/** Downscales a video frame into a reusable canvas. One context, one buffer, no per-frame alloc. */
class FrameReader {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly maxEdge = ANALYSIS_MAX_EDGE) {
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

    // Draw straight into the small canvas rather than grabbing full resolution and scaling
    // after: a full-resolution getImageData is the most expensive call in the loop and its
    // result would be thrown away immediately.
    this.ctx.drawImage(video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}

/**
 * A self-throttling analysis loop.
 *
 * `TICK_MS` is a floor. When a pass overruns it, the next one waits twice however long the
 * last one actually took, so a slow machine degrades to a less fresh tally instead of to a
 * locked-up page. The `<video>` underneath is composited by the browser and is unaffected
 * either way, which is the whole reason the camera is a DOM element rather than something
 * drawn into a canvas.
 */
export class AnalysisLoop {
  private readonly reader = new FrameReader();
  private raf = 0;
  private nextAt = 0;
  private running = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onPass: (pass: LocalPass) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const tick = (now: number): void => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (now < this.nextAt) return;

      const pass = this.once();
      if (pass === null) {
        this.nextAt = now + TICK_MS;
        return;
      }
      this.nextAt = now + Math.max(TICK_MS, pass.elapsedMs * 2);
      this.onPass(pass);
    };

    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** One synchronous pass. Null when the video has no frame yet or segmentation threw. */
  private once(): LocalPass | null {
    const frame = this.reader.read(this.video);
    if (frame === null) return null;

    const started = performance.now();
    let all: readonly Blob[];
    try {
      all = segment(frame, DEFAULT_SEGMENT_OPTIONS);
    } catch (error) {
      console.warn('[home] segmentation failed', error);
      return null;
    }

    const blobs = all.filter(
      (b) => hueDistanceDeg(b.features.hueDeg, PRODUCE_HUE_CENTRE_DEG) <= PRODUCE_HUE_TOLERANCE_DEG,
    );
    const labels = blobs.map((b) => identify(b.features)?.name ?? null);

    return {
      blobs,
      labels,
      width: frame.width,
      height: frame.height,
      elapsedMs: performance.now() - started,
    };
  }
}

/**
 * Draws the pass onto the overlay canvas sitting on the video.
 *
 * Named blobs get the brand red and their label; unnamed ones get a muted outline and no text.
 * Showing the unnamed ones matters: "the segmenter found five things and could name two" is a
 * different situation from "the segmenter found two things", and only one of them is fixed by
 * moving the ingredient.
 */
export function drawOverlay(canvas: HTMLCanvasElement, pass: LocalPass): void {
  if (canvas.width !== pass.width || canvas.height !== pass.height) {
    canvas.width = pass.width;
    canvas.height = pass.height;
  }

  const ctx = canvas.getContext('2d');
  if (ctx === null) return;

  ctx.clearRect(0, 0, pass.width, pass.height);
  ctx.lineWidth = Math.max(2, Math.round(pass.width / 260));
  ctx.lineJoin = 'round';

  const fontPx = Math.max(12, Math.round(pass.width / 34));
  ctx.font = `800 ${fontPx}px 'Hanken Grotesk', system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';

  pass.blobs.forEach((blob, i) => {
    const label = pass.labels[i] ?? null;
    ctx.strokeStyle = label === null ? 'rgba(255,243,228,.4)' : '#F5230E';

    ctx.beginPath();
    blob.contour.forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (label === null) return;

    // Cream behind the red, so a label over a pale cucumber is still readable. Cheaper and
    // steadier than measuring the text and filling a plate behind it.
    const text = label.toUpperCase();
    const x = blob.centroid.x + 6;
    const y = blob.centroid.y - 6;
    ctx.lineWidth = Math.max(3, fontPx / 4);
    ctx.strokeStyle = '#FFF3E4';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#F5230E';
    ctx.fillText(text, x, y);
    ctx.lineWidth = Math.max(2, Math.round(pass.width / 260));
  });
}

/** Loads the OpenCV WASM. Resolves false rather than throwing: the page works without it. */
export const loadSegmenter = loadVision;

// --------------------------------------------------------------------------------------------
// The cloud pass
// --------------------------------------------------------------------------------------------

export type CloudScan =
  | { readonly ok: true; readonly items: readonly RawScanItem[]; readonly notes: string }
  | { readonly ok: false; readonly reason: string };

/** Grabs a still out of the video as a data URL, bounded and compressed. */
function stillFrom(video: HTMLVideoElement): string | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (vw === 0 || vh === 0) return null;

  const k = Math.min(1, CLOUD_MAX_EDGE / Math.max(vw, vh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vw * k));
  canvas.height = Math.max(1, Math.round(vh * k));

  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * Whether the relay behind `api/vision` is reachable and has a key.
 *
 * Checked at startup rather than at press time. A button that fails the moment someone uses it
 * is worse than a button that says up front it cannot be used -- particularly in front of an
 * audience, where the failure is read as the whole app being broken.
 */
export async function cloudConfigured(): Promise<boolean> {
  try {
    const res = await fetch('api/vision', { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { configured?: unknown };
    return body.configured === true;
  } catch {
    return false;
  }
}

/** One call to the vision model. Every failure comes back as text a person can act on. */
export async function cloudScan(video: HTMLVideoElement): Promise<CloudScan> {
  const imageDataUrl = stillFrom(video);
  if (imageDataUrl === null) return { ok: false, reason: 'The camera has not produced a frame yet.' };

  // Aborted rather than merely ignored on timeout: an abandoned request still holds a
  // connection, and venue wifi has few to spare.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLOUD_TIMEOUT_MS);

  try {
    const res = await fetch('api/vision', {
      method: 'POST',
      signal: abort.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });

    const body = (await res.json().catch(() => null)) as
      | { items?: RawScanItem[]; notes?: string; error?: string; detail?: string }
      | null;

    if (!res.ok || body === null) {
      if (body?.error === 'no_key') {
        return { ok: false, reason: 'Cloud scan is off on this deployment — no API key set. The live count still works.' };
      }
      if (body?.error === 'timeout') {
        return { ok: false, reason: 'The model took too long. Try again, or keep using the live count.' };
      }
      return { ok: false, reason: body?.detail ?? `Scan failed (${res.status}).` };
    }

    const items = body.items ?? [];
    return {
      ok: true,
      items,
      notes: body.notes ?? (items.length === 0 ? 'Nothing recognised on the counter.' : ''),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      reason: aborted ? 'Scan timed out after 45s.' : `Scan failed: ${String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
