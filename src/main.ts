import cv from '@techstark/opencv-js';

import { identify } from './core/ingredients.js';
import { FrameGrabber, listCameras, open } from './vision/camera.js';
import {
  type Blob, DEFAULT_SEGMENT_OPTIONS, segment, type SegmentOptions, useOpenCv,
} from './vision/segment.js';
import { decodeToImageData, firstImage } from './vision/imageSource.js';
import { drawTestPattern } from './vision/testPattern.js';

const statusEl = document.getElementById('status') as HTMLDivElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const controls = document.getElementById('controls') as HTMLElement;
const ctx = canvas.getContext('2d')!;

const status = (text: string): void => { statusEl.textContent = text; };

/** Every threshold gets a live slider. Rebuilding to retune one number is how you lose a day. */
const options: { -readonly [K in keyof SegmentOptions]: SegmentOptions[K] } = {
  ...DEFAULT_SEGMENT_OPTIONS,
};

/** Produces one frame, or null when the source has nothing ready yet. */
type Source = () => ImageData | null;

function slider(
  label: string, min: number, max: number, step: number,
  get: () => number, set: (v: number) => void,
): void {
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  const value = document.createElement('output');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  name.textContent = label;
  value.textContent = String(get());
  input.addEventListener('input', () => {
    set(Number(input.value));
    value.textContent = input.value;
  });
  wrap.append(name, value, input);
  controls.append(wrap);
}

function dropdown(label: string): HTMLSelectElement {
  const select = document.createElement('select');
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  wrap.append(name, select);
  controls.prepend(wrap);
  return select;
}

function drawBlob(blob: Blob): void {
  const named = identify(blob.features);
  const hue = blob.features.hueDeg;

  ctx.beginPath();
  blob.contour.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  // Outline in the blob's own measured hue: when a label is wrong, the colour shows you why
  // without having to read any of the numbers.
  ctx.strokeStyle = `hsl(${hue} 90% 55%)`;
  ctx.lineWidth = 3;
  ctx.stroke();

  const { x, y } = blob.centroid;
  const label = named === null
    ? 'unidentified'
    : `${named.name}  ${(named.confidence * 100).toFixed(0)}%`;
  const detail =
    `${hue.toFixed(0)}deg  ${blob.features.elongation.toFixed(1)}:1  ` +
    `sat ${blob.features.saturation.toFixed(2)}  sol ${blob.features.solidity.toFixed(2)}`;

  ctx.textAlign = 'center';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  const labelWidth = ctx.measureText(label).width;
  ctx.font = '400 12px ui-monospace, monospace';
  const boxWidth = Math.max(labelWidth, ctx.measureText(detail).width) + 18;

  ctx.fillStyle = 'rgba(10,12,16,0.85)';
  ctx.fillRect(x - boxWidth / 2, y - 26, boxWidth, 46);
  ctx.fillStyle = named === null ? '#f0a35e' : '#8ee06a';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(label, x, y - 7);
  ctx.fillStyle = '#9aa3ad';
  ctx.font = '400 12px ui-monospace, monospace';
  ctx.fillText(detail, x, y + 12);
}

/** Never throws. A camera that refuses or ignores permission must not take the page down. */
async function cameraSource(): Promise<Source | null> {
  try {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;

    const stream = await open();
    video.srcObject = stream;
    await video.play();
    const grabber = new FrameGrabber(video);

    // Device labels stay blank until permission has been granted at least once -- the browser
    // withholds them so a page cannot fingerprint your hardware before you consent. So the
    // picker is only worth building after the stream is live.
    const cameras = await listCameras();
    if (cameras.length > 1) {
      const select = dropdown('camera');
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.deviceId;
        option.textContent = camera.label;
        select.append(option);
      }
      select.addEventListener('change', () => {
        const current = video.srcObject as MediaStream | null;
        if (current !== null) for (const track of current.getTracks()) track.stop();
        void open({ deviceId: select.value, width: 1280, height: 720 })
          .then((next) => {
            video.srcObject = next;
            return video.play();
          })
          .catch((error: unknown) => {
            status(`could not switch camera: ${(error as Error).message}`);
          });
      });
    }

    return () => grabber.grab();
  } catch (error) {
    console.warn('[mise] camera unavailable, using the test pattern instead:', error);
    return null;
  }
}

/**
 * Still images, fed by drop, paste or the file picker.
 *
 * Returns null until something has been loaded, which the render loop already treats as "this
 * source has nothing yet" -- the same state a camera is in for its first frame or two.
 */
function imageSource(onLoad: (name: string) => void): {
  source: Source;
  load: (file: File) => void;
} {
  const scratch = document.createElement('canvas');
  let frame: ImageData | null = null;

  const load = (file: File): void => {
    void decodeToImageData(file, scratch)
      .then((decoded) => {
        frame = decoded;
        onLoad(`${file.name} · ${decoded.width}x${decoded.height}`);
      })
      .catch((error: unknown) => {
        onLoad(`could not decode ${file.name}: ${(error as Error).message}`);
      });
  };

  return { source: () => frame, load };
}

function testPatternSource(): Source {
  // Rendered once and reused. The scene is static, and its per-pixel noise pass is a JS loop
  // over ~3.7 million array entries -- running that every frame cost more than the entire
  // OpenCV pipeline did, and it was measuring nothing.
  const scratch = document.createElement('canvas');
  const frame = drawTestPattern(scratch);
  return () => frame;
}

async function start(): Promise<void> {
  const synthetic = testPatternSource();
  let camera: Source | null = null;
  let source: Source = synthetic;

  /**
   * Asks for the camera WITHOUT waiting for the answer, and adopts it whenever it arrives.
   *
   * getUserMedia never rejects on an ignored permission prompt -- the promise simply stays
   * pending. The first version awaited it against an 8 second timeout, which produced the
   * worst of both: you glance away, the page gives up, and clicking Allow a moment later does
   * nothing at all because the source was decided once at startup.
   *
   * Running it in the background removes the race rather than shortening it. The test pattern
   * is up instantly so the page is never blank, and permission granted a minute later still
   * switches the feed over. Nothing is ever waiting on a human.
   */
  const requestCamera = (): void => {
    if (camera !== null) return;
    status('waiting for camera permission...');
    void cameraSource().then((ready) => {
      if (ready === null) {
        status('camera refused -- showing the test pattern');
        return;
      }
      camera = ready;
      // Only steal the view if the user has not deliberately chosen something else meanwhile.
      if (modes.value === 'camera') source = ready;
    });
  };

  const images = imageSource((note) => {
    dropNote.textContent = note;
    // Loading an image is an unambiguous request to look at it, so switch without being asked.
    modes.value = 'image';
    source = images.source;
  });

  const modes = dropdown('source');
  for (const [value, text] of [
    ['camera', 'camera'], ['image', 'image'], ['test', 'test pattern'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    modes.append(option);
  }
  // Default to the camera: it is what the page is for, and the test pattern shows underneath
  // until permission arrives, so choosing it costs nothing if the answer never comes.
  modes.value = 'camera';
  modes.addEventListener('change', () => {
    if (modes.value === 'image') {
      source = images.source;
      return;
    }
    if (modes.value !== 'camera') {
      source = synthetic;
      return;
    }
    if (camera !== null) source = camera;
    else requestCamera();
  });

  const drop = document.createElement('div');
  drop.id = 'drop';
  drop.innerHTML =
    '<strong>drop an image</strong>' +
    '<span>or paste, or click to browse</span>' +
    '<em id="drop-note">nothing loaded</em>';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  drop.append(picker);
  controls.append(drop);
  const dropNote = document.getElementById('drop-note') as HTMLElement;

  drop.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file !== undefined) images.load(file);
  });

  // Drop and paste are bound to the whole document, not just the zone: aiming for a 200px
  // target while dragging a file is a needless bit of precision to demand.
  for (const type of ['dragenter', 'dragover'] as const) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    document.addEventListener(type, () => drop.classList.remove('over'));
  }
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = firstImage(event.dataTransfer?.items ?? null);
    if (file !== null) images.load(file);
  });
  document.addEventListener('paste', (event) => {
    const file = firstImage(event.clipboardData?.items ?? null);
    if (file !== null) images.load(file);
  });

  slider('saturation floor', 0.05, 0.6, 0.01,
    () => options.minSaturation, (v) => { options.minSaturation = v; });
  slider('min area px', 100, 8000, 100,
    () => options.minAreaPx, (v) => { options.minAreaPx = v; });
  slider('morph kernel', 1, 15, 2,
    () => options.morphKernelPx, (v) => { options.morphKernelPx = v; });

  requestCamera();

  let lastFrame = performance.now();
  let smoothedMs = 16;
  let segmentMs = 0;

  const tick = (): void => {
    const frame = source();
    if (frame !== null) {
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      ctx.putImageData(frame, 0, 0);

      let blobs: Blob[] = [];
      let failure: string | null = null;
      const segmentStart = performance.now();
      try {
        blobs = segment(frame, options);
      } catch (error) {
        failure = (error as Error).message;
      }
      // Timed separately from the frame delta on purpose. Frame delta includes whatever the
      // browser decides to do with requestAnimationFrame -- a backgrounded or throttled tab
      // reports 1fps however fast the pipeline is. Only this number says what the CV costs.
      segmentMs += (performance.now() - segmentStart - segmentMs) * 0.2;
      for (const blob of blobs) drawBlob(blob);

      const now = performance.now();
      // Exponentially smoothed: a raw per-frame figure is unreadable and hides the trend.
      smoothedMs += ((now - lastFrame) - smoothedMs) * 0.1;
      lastFrame = now;
      status(
        failure ??
        `${blobs.length} blob${blobs.length === 1 ? '' : 's'} · ` +
        `cv ${segmentMs.toFixed(1)}ms · ` +
        `frame ${smoothedMs.toFixed(1)}ms (${(1000 / smoothedMs).toFixed(0)}fps) · ` +
        `${frame.width}x${frame.height}`,
      );
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// OpenCV.js resolves its WASM asynchronously and builds differ in how they announce it, so
// handle both shapes: a thenable default export, and the classic onRuntimeInitialized callback.
const ready = typeof (cv as unknown as { then?: unknown }).then === 'function'
  ? (cv as unknown as Promise<typeof cv>)
  : new Promise<typeof cv>((resolve) => {
      (cv as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized =
        () => resolve(cv);
    });

ready
  .then((instance) => {
    useOpenCv(instance);
    return start();
  })
  .catch((error: unknown) => {
    status(`failed to start: ${(error as Error).message}`);
    console.error('[mise]', error);
  });
