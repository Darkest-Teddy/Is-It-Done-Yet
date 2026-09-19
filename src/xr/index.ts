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
  launchXR,
  SessionMode,
  World,
  type Entity,
} from '@iwsdk/core';

import { emptyPantry, type Pantry } from '../core/pantry.js';
import { RECIPES } from '../core/recipe.js';
import { CoachSession } from '../app/session.js';
import { DEFAULT_SEGMENT_OPTIONS, segment, useOpenCv } from '../vision/segment.js';
import { RecipePanels } from './panels.js';

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

export interface XrCapabilities {
  readonly hasWebXR: boolean;
  readonly immersiveAr: boolean;
  readonly immersiveVr: boolean;
  readonly secureContext: boolean;
  readonly camera: string;
}

/**
 * What this device can actually do, checked rather than assumed.
 *
 * Reported on the page as well as the console because reading a headset console needs adb, and
 * every one of these being false has a different cause and a different fix. `immersiveAr: false`
 * on a Quest almost always means an insecure origin rather than a missing feature.
 */
export async function capabilities(): Promise<XrCapabilities> {
  const xr = navigator.xr;
  const supports = async (mode: SessionMode): Promise<boolean> => {
    try {
      return (await xr?.isSessionSupported(mode)) === true;
    } catch {
      return false;
    }
  };

  const camera = await probeCameras();
  return {
    hasWebXR: xr !== undefined,
    immersiveAr: await supports(SessionMode.ImmersiveAR),
    immersiveVr: await supports(SessionMode.ImmersiveVR),
    secureContext: window.isSecureContext,
    camera: camera.ok ? camera.detail : `none (${camera.detail})`,
  };
}

export interface BootResult {
  readonly caps: XrCapabilities;
  /**
   * Enters immersive AR. MUST be called from a user gesture.
   *
   * WebXR refuses `requestSession` outside a click or trigger press, and the rejection reads as
   * a generic security error rather than saying so. IWSDK offers a session via
   * `navigator.xr.offerSession()` where the browser supports it, but that is a suggestion the
   * browser may ignore -- an explicit button is the only entry path that always works.
   */
  readonly enterXR: () => void;
}

export async function boot(container: HTMLElement): Promise<BootResult> {
  useOpenCv(cv);

  const caps = await capabilities();
  log('capabilities', caps);

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

  if (world === null) {
    return { caps, enterXR: () => warn('cannot enter XR: the world failed to create') };
  }

  const recipe = RECIPES[0];
  if (recipe === undefined) throw new Error('no recipes defined');
  const session = new CoachSession(recipe);

  world.registerComponent(CameraSource);
  const cameraEntity = world.createEntity();
  // `facing: 'back'` is what a headset's world-facing camera would report. On hardware that
  // exposes nothing, this entity simply never reaches the Active state and `captureFrame`
  // keeps returning null -- which the loop treats as "not ready" rather than as an error.
  cameraEntity.addComponent(CameraSource, { facing: 'back', width: 1280, height: 720 });

  await mountPanels(world, session);

  if (probe.ok) {
    startAnalysisLoop(cameraEntity, session);
    log(`coaching "${recipe.name}" -- analysing every ${ANALYSE_INTERVAL_MS}ms`);
  } else {
    warn('analysis loop NOT started: no usable camera. The world renders and the menus work, but nothing is being coached.');
  }

  return {
    caps,
    enterXR: () => {
      launchXR(world, {
        sessionMode: SessionMode.ImmersiveAR,
        features: { handTracking: true, planeDetection: true, anchors: true },
      });
    },
  };
}

/**
 * Places the recipe library and preview in front of the player.
 *
 * Panels are parented to plain transform entities rather than anchored to a detected plane: a
 * menu should be where you are looking when the app starts, not wherever the room's geometry
 * happened to resolve. Anchoring belongs to the cooking surface, not to the menu.
 */
async function mountPanels(
  world: World,
  session: CoachSession,
  pantry: Pantry = emptyPantry(),
): Promise<RecipePanels | null> {
  try {
    const panels = await RecipePanels.load(pantry, RECIPES, {
      onStart: (recipe) => {
        log(`starting "${recipe.name}"`);
      },
    });

    // 1.6m out and slightly below eye level -- the distance UI stays readable at without
    // forcing the player to converge uncomfortably.
    for (const asset of [panels.library, panels.preview]) {
      const entity = world.createTransformEntity(asset);
      entity.object3D?.position.set(0, 1.3, -1.6);
    }

    log('panels mounted');
    return panels;
  } catch (err) {
    // A failed panel load must not take the world down with it: a running scene with no menu
    // is debuggable, a blank canvas is not.
    warn('panels failed to load', err);
    return null;
  }
}
