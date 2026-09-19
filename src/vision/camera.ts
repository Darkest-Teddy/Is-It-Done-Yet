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

/**
 * 720p, and the reasoning went the other way first, so the measurements are recorded here.
 *
 * The obvious argument is that linear resolution is measurement resolution: thickness is read
 * off a silhouette a handful of pixels tall, and the pixel pitch sets the quantisation floor of
 * the headline number. That argues for the 1080p the Pocket 3 can deliver.
 *
 * It is the wrong trade, because the segmentation pipeline is purely pixel-bound. Measured in
 * the browser on the synthetic scene, five blobs, after the buffer reuse in segment.ts:
 *
 *     640x360    28ms     35fps
 *     1280x720  118ms      8fps
 *     1920x1080 259ms      4fps
 *
 * Cut detection needs a stub reading to hold still for several consecutive frames before it will
 * commit, so the frame RATE sets how long a person has to hold the board steady: 0.6s at 720p
 * against 1.25s at 1080p, before the refractory window on top. And the precision 1080p buys is
 * precision the scoring cannot use. Over a board-filling frame 720p is about 0.52mm/px, so a
 * 6mm slice is ~11px and half-pixel quantisation is +/-0.26mm -- already an eighth of the 2mm
 * tolerance, and stub-delta reads a ~345px length where it matters even less.
 *
 * So: resolution to the point where it stops limiting the answer, then frame rate. The
 * "ideal" constraint below degrades gracefully on hardware that cannot do even this.
 */
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
