/**
 * Camera access, kept behind an interface so everything downstream is source-agnostic.
 *
 * A DJI Pocket 3 in UVC mode, a $20 USB webcam and a laptop's built-in camera all arrive here
 * as the same thing. That matters more than it sounds: the rig will change at least once before
 * judging, and nothing but this file should have to notice.
 */

export interface CameraDevice {
  readonly deviceId: string;
  readonly label: string;
}

export interface CameraOptions {
  readonly deviceId?: string;
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_CAMERA_OPTIONS: CameraOptions = { width: 1280, height: 720 };

/**
 * Lists video inputs.
 *
 * Labels are blank until permission has been granted at least once -- the browser withholds
 * them to stop a page fingerprinting your hardware before you consent. So call this AFTER
 * `open`, or the picker shows a list of empty strings and looks broken.
 */
export async function listCameras(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1}` }));
}

export async function open(
  opts: CameraOptions = DEFAULT_CAMERA_OPTIONS,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      // `ideal`, not `exact`: an exact resolution a camera cannot produce is an
      // OverconstrainedError rather than a downgrade, which turns a cosmetic preference into a
      // hard failure on whatever hardware happens to be on the table.
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      ...(opts.deviceId === undefined ? {} : { deviceId: { exact: opts.deviceId } }),
    },
    audio: false,
  });
}

/** Pulls frames into a reusable canvas. One context, one buffer, no per-frame allocation. */
export class FrameGrabber {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly video: HTMLVideoElement) {
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
  }

  get width(): number { return this.video.videoWidth; }
  get height(): number { return this.video.videoHeight; }

  /** Null until the video element has real dimensions, which lags the stream by a frame or two. */
  grab(): ImageData | null {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (w === 0 || h === 0) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h);
  }
}
