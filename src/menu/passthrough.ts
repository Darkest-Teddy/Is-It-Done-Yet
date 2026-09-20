/**
 * The headset's own view of the room, as a backdrop.
 *
 * The artboard painted a kitchen behind screens 2A and 2E -- brown counter, wooden rail, drawn
 * ingredients sitting on it at fixed coordinates. That was a stand-in for the thing the app is
 * actually about. On a 3S those two screens sit on the real counter, so the ground is the
 * passthrough camera and the drawn ingredients are gone: what appears over the counter is what
 * the scan actually found, where it actually found it.
 *
 * WHY getUserMedia AND NOT WebXR. Quest Browser does not implement the WebXR `camera-access`
 * feature descriptor. It does expose the passthrough cameras through MediaDevices, which on
 * Horizon OS sits on Camera2 -- different door, same room. That is what gate zero in the master
 * spec proved on this headset (DECISIONS #18), and it is why this app runs as a normal browser
 * page rather than inside an immersive session.
 *
 * ONE STREAM, SHARED. 2A and 2E both want the camera and the user moves between them; opening
 * a second stream while the first is live either fails or costs a visible black gap. So the
 * stream is owned here, reference-counted by the panels that want it, and released on a short
 * delay so a there-and-back navigation never restarts it.
 */

import { listCameras, open, type CameraDevice } from '../vision/camera.js';

export type PassthroughStatus =
  | 'idle'
  | 'starting'
  | 'live'
  /** Permission prompt dismissed or blocked for the origin. Recoverable: ask again. */
  | 'denied'
  /** No video input at all. Not recoverable from inside the page. */
  | 'missing'
  /** Not a secure context, so `mediaDevices` is undefined and the list reads as empty. */
  | 'insecure'
  /** Something else -- a camera held by another tab is the usual one. */
  | 'failed';

export interface PassthroughState {
  readonly status: PassthroughStatus;
  readonly stream: MediaStream | null;
  readonly devices: readonly CameraDevice[];
  readonly deviceId: string | null;
  /** Ready to show a human. Empty unless something went wrong. */
  readonly detail: string;
}

type Listener = (state: PassthroughState) => void;

/** Long enough to cover a panel change, short enough that a real exit still frees the camera. */
const RELEASE_DELAY_MS = 4000;

/**
 * Quest exposes several passthrough cameras and the first one is not reliably the one looking
 * where the cook is looking. Labels are the only signal available, so they are ranked -- and
 * when none match, the first device is used and nothing pretends otherwise.
 */
const PREFERRED_LABEL = /passthrough|world|front|environment|back|rgb/i;

class Passthrough {
  private state: PassthroughState = {
    status: 'idle', stream: null, devices: [], deviceId: null, detail: '',
  };

  private readonly listeners = new Set<Listener>();
  private holders = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;

  get current(): PassthroughState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<PassthroughState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** A panel that needs the camera calls this on mount and the returned function on unmount. */
  acquire(): () => void {
    this.holders += 1;
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    void this.start();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders > 0) return;
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        if (this.holders === 0) this.stop();
      }, RELEASE_DELAY_MS);
    };
  }

  /** Re-runs the whole open sequence. Wired to the "retry" button on the fault card. */
  async retry(deviceId?: string): Promise<void> {
    this.stop();
    await this.start(deviceId);
  }

  async start(deviceId?: string): Promise<void> {
    if (this.state.stream !== null && deviceId === undefined) return;
    if (this.starting !== null) return this.starting;

    this.starting = this.openStream(deviceId).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async openStream(deviceId?: string): Promise<void> {
    // `mediaDevices` is simply absent outside a secure context, so the usual "no cameras"
    // reading of an empty list is wrong here and the fix is completely different: serve over
    // https, or reach the laptop through `adb reverse` so the headset sees `localhost`.
    if (!window.isSecureContext || navigator.mediaDevices === undefined) {
      this.set({
        status: 'insecure',
        detail: 'The page is not on a secure origin, so the browser hides the cameras entirely. '
          + 'Run "npm run adb:reverse" and open http://localhost:8081, or serve over https.',
      });
      return;
    }

    this.set({ status: 'starting', detail: '' });

    try {
      const stream = await open(
        deviceId === undefined
          ? { width: 1280, height: 720 }
          : { deviceId, width: 1280, height: 720 },
      );

      // Labels stay blank until permission has been granted once, so the list is only worth
      // reading after the first successful open -- which is why this is here and not earlier.
      const devices = await listCameras().catch(() => [] as CameraDevice[]);
      const active = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? null;

      this.set({ status: 'live', stream, devices, deviceId: active, detail: '' });
    } catch (error) {
      const err = error as DOMException;
      const name = err?.name ?? 'Error';

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.set({
          status: 'denied',
          stream: null,
          detail: 'Camera permission was refused. Quest Browser asks once per origin -- tap the '
            + 'lock icon in the address bar to allow it, then retry.',
        });
        return;
      }

      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        this.set({
          status: 'missing',
          stream: null,
          detail: 'No video input was offered. On a 3S this usually means the build predates the '
            + 'v74 passthrough camera exposure.',
        });
        return;
      }

      this.set({
        status: 'failed',
        stream: null,
        detail: `${name}: ${err?.message ?? 'the camera could not be opened'}`,
      });
    }
  }

  private stop(): void {
    const { stream } = this.state;
    if (stream === null) return;
    for (const track of stream.getTracks()) track.stop();
    this.set({ status: 'idle', stream: null, detail: '' });
  }
}

export const passthrough = new Passthrough();

/**
 * Where the video's pixels actually land inside its element.
 *
 * `object-fit: cover` crops, so a detection at 0.5 of the frame width is not at 0.5 of the
 * element width. Overlay tags are positioned through this, or they drift off their ingredient
 * the moment the window is not the same aspect ratio as the camera -- which on a resizable
 * headset window is nearly always.
 */
export interface CoverBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function coverBox(
  video: HTMLVideoElement,
  boxWidth: number,
  boxHeight: number,
): CoverBox | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (vw === 0 || vh === 0 || boxWidth === 0 || boxHeight === 0) return null;

  const scale = Math.max(boxWidth / vw, boxHeight / vh);
  const width = vw * scale;
  const height = vh * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}
