/**
 * The headset entry point: an IWSDK world in passthrough, coached by `CoachSession`.
 *
 * Structure follows the spec's §5.2 rule that nothing may block a render frame. The capture
 * and analysis loop runs on its own timer at ~1Hz and never inside `onXRFrame`; a chopping
 * board does not move between frames, so there is nothing to gain from analysing at 90Hz and
 * a dropped session to lose.
 *
 * DIAGNOSTICS ARE LOUD ON PURPOSE. Whether Quest Browser exposes any camera to `getUserMedia`
 * is the open question this build exists to answer, and IWSDK's `CameraUtils` is a thin wrapper
 * over `getUserMedia` -- there is no passthrough-specific API in the package. If the device list
 * comes back empty, that is the answer, and it must be visible rather than looking like the app
 * merely failing to start.
 */

import cv from '@techstark/opencv-js';
import {
  CameraSource,
  CameraUtils,
  SessionMode,
  World,
  type Entity,
} from '@iwsdk/core';

import { RECIPES } from '../core/recipe.js';
import { CoachSession } from '../app/session.js';
import { DEFAULT_SEGMENT_OPTIONS, segment, useOpenCv } from '../vision/segment.js';

/** How often the board is analysed. Not tied to the render loop; see the file docstring. */
const ANALYSE_INTERVAL_MS = 1000;

/** Longest edge sent to segmentation. Full sensor resolution buys nothing and costs frame time. */
const ANALYSE_MAX_EDGE_PX = 960;

const log = (...args: unknown[]): void => console.info('[mise:xr]', ...args);
const warn = (...args: unknown[]): void => console.warn('[mise:xr]', ...args);

/**
 * Reports what cameras the runtime can actually see.
 *
 * Separated out and called before anything else is built, because its answer decides whether
 * the rest of this file can work at all.
 */
async function probeCameras(): Promise<{ ok: boolean; detail: string }> {
  if (navigator.mediaDevices === undefined) {
    return { ok: false, detail: 'navigator.mediaDevices is undefined -- almost always an insecure origin (needs HTTPS over LAN)' };
  }

  try {
    const devices = await CameraUtils.getDevices(true);
    if (devices.length === 0) {
      return {
        ok: false,
        detail: 'getUserMedia granted but enumerated zero video inputs -- the passthrough cameras are not exposed to the browser',
      };
    }
    return {
      ok: true,
      detail: devices.map((d) => `${d.label || '(unlabelled)'} [${d.facing}]`).join(', '),
    };
  } catch (err) {
    return { ok: false, detail: `camera request failed: ${String(err)}` };
  }
}

/** Downscales into a reusable canvas. One canvas, no per-capture allocation. */
class Downscaler {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;

  constructor() {
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
  }

  toImageData(source: HTMLCanvasElement, maxEdgePx: number): ImageData | null {
    const { width: w, height: h } = source;
    if (w === 0 || h === 0) return null;

    const scale = Math.min(1, maxEdgePx / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    if (this.canvas.width !== tw || this.canvas.height !== th) {
      this.canvas.width = tw;
      this.canvas.height = th;
    }
    this.ctx.drawImage(source, 0, 0, tw, th);
    return this.ctx.getImageData(0, 0, tw, th);
  }
}

/**
 * The ~1Hz analysis loop.
 *
 * Returns a stop function. Every tick is wrapped so that one bad frame -- a camera hiccup, an
 * OpenCV throw on a degenerate contour -- logs and continues instead of killing the interval
 * and silently ending all coaching for the rest of the session.
 */
function startAnalysisLoop(cameraEntity: Entity, session: CoachSession): () => void {
  const downscaler = new Downscaler();

  const tick = (): void => {
    try {
      const frame = CameraUtils.captureFrame(cameraEntity);
      if (frame === null) return; // camera not ready yet; normal for the first few ticks

      const image = downscaler.toImageData(frame, ANALYSE_MAX_EDGE_PX);
      if (image === null) return;

      const blobs = segment(image, DEFAULT_SEGMENT_OPTIONS);
      const state = session.ingest(blobs, performance.now());

      const line = state.top?.instruction ?? 'Board matches the recipe.';
      log(`${state.board.pieceCount} pieces · ${state.process.doneCount}/${state.process.totalCount} steps · ${line}`);
    } catch (err) {
      warn('analysis tick failed, continuing', err);
    }
  };

  const handle = setInterval(tick, ANALYSE_INTERVAL_MS);
  return () => clearInterval(handle);
}

export async function boot(container: HTMLElement): Promise<void> {
  useOpenCv(cv);

  const probe = await probeCameras();
  log(probe.ok ? `cameras: ${probe.detail}` : `NO USABLE CAMERA -- ${probe.detail}`);

  // World.create failing is close to invisible: a rejected promise here leaves a blank canvas
  // and an empty console, which reads as a rendering bug rather than a startup failure. The
  // catch is mandatory, not defensive. See DECISIONS.md #11.
  const world = await World.create(container, {
    xr: {
      // Passthrough. ImmersiveVR would render a black void over the real kitchen and every
      // "is this really MR" answer would be no.
      sessionMode: SessionMode.ImmersiveAR,
      features: {
        handTracking: true,
        planeDetection: true,
        anchors: true,
      },
    },
  }).catch((err: unknown) => {
    warn('World.create failed -- this is why the canvas is blank', err);
    return null;
  });

  if (world === null) return;

  const recipe = RECIPES[0];
  if (recipe === undefined) throw new Error('no recipes defined');
  const session = new CoachSession(recipe);

  world.registerComponent(CameraSource);
  const cameraEntity = world.createEntity();
  // `facing: 'back'` is what a headset's world-facing camera would report. On hardware that
  // exposes nothing, this entity simply never reaches the Active state and `captureFrame`
  // keeps returning null -- which the loop treats as "not ready" rather than as an error.
  cameraEntity.addComponent(CameraSource, { facing: 'back', width: 1280, height: 720 });

  if (probe.ok) {
    startAnalysisLoop(cameraEntity, session);
    log(`coaching "${recipe.name}" -- analysing every ${ANALYSE_INTERVAL_MS}ms`);
  } else {
    warn('analysis loop NOT started: no usable camera. The world will render, but nothing is being coached.');
  }
}
