/**
 * The passthrough backdrop as a mountable thing, shared by 2A and 2E.
 *
 * Holds the camera for as long as it is on screen, shows the right message when it cannot be
 * had, and places overlay markers in FRAME coordinates so a caller never has to think about
 * where the video's pixels actually landed.
 *
 * That last part is the whole reason this file exists. `object-fit: cover` crops, so a
 * detection at 0.5 across the frame is not at 0.5 across the element unless the window happens
 * to match the camera's aspect ratio -- which on a resizable headset window it essentially
 * never does. A tag placed by naive percentage drifts off its ingredient the moment somebody
 * resizes the tab, and the whole screen stops being believable.
 */

import { coverBox, passthrough, type PassthroughStatus } from './passthrough.js';
import { button, fill, h } from './dom.js';

export interface OverlayMarker {
  /** Position in frame coordinates, 0..1 across and down. */
  readonly x: number;
  readonly y: number;
  readonly node: HTMLElement;
}

export interface PassthroughView {
  readonly node: HTMLElement;
  video(): HTMLVideoElement | null;
  status(): PassthroughStatus;
  onStatusChange(listener: () => void): () => void;
  setOverlay(markers: readonly OverlayMarker[]): void;
  destroy(): void;
}

export interface PassthroughOptions {
  /** Darkens the camera so cream panels stay readable over a bright counter. */
  readonly scrim?: boolean;
  /**
   * Draw the built-in fault card. On by default.
   *
   * The screens built on a scaled artboard turn this OFF and report the camera themselves. The
   * card is positioned in window coordinates while their panels are positioned in artboard
   * coordinates, so the two collide at any scale but one -- and the screen knows where its own
   * empty space is, which this file cannot.
   */
  readonly fault?: boolean;
}

const FAULT_TITLE: Readonly<Record<PassthroughStatus, string>> = {
  idle: 'Camera not started',
  starting: 'Opening the camera…',
  live: '',
  denied: 'Camera permission refused',
  missing: 'No camera offered',
  insecure: 'Insecure origin',
  failed: 'Camera could not open',
};

export function mountPassthrough(options: PassthroughOptions = {}): PassthroughView {
  const video = h('video', {
    class: 'pass__video',
    attrs: { playsinline: true, muted: true, autoplay: true },
  });
  // Set as properties too: the attributes alone are not enough for autoplay on every browser,
  // and a muted video is the only kind allowed to start without a gesture.
  video.muted = true;
  video.playsInline = true;

  const overlay = h('div', { class: 'pass__overlay' });
  const fault = h('div', { class: 'pass__fault' });

  const node = h(
    'div',
    { class: 'pass' },
    video,
    options.scrim === true ? h('div', { class: 'pass__scrim' }) : null,
    overlay,
    fault,
  );

  const release = passthrough.acquire();
  const listeners = new Set<() => void>();
  let markers: readonly OverlayMarker[] = [];
  let status: PassthroughStatus = passthrough.current.status;

  const unsubscribe = passthrough.subscribe((state) => {
    status = state.status;

    if (state.stream !== null && video.srcObject !== state.stream) {
      video.srcObject = state.stream;
      // Autoplay can still be refused; there is nothing to recover to, so this is logged and
      // the fault card below reports the camera as not live.
      void video.play().catch((error: unknown) => console.warn('[menu] video play refused', error));
    }
    if (state.stream === null) video.srcObject = null;

    paintFault(state.status, state.detail);
    place();
    for (const listener of listeners) listener();
  });

  function paintFault(state: PassthroughStatus, detail: string): void {
    if (options.fault === false) {
      fault.style.display = 'none';
      fill(fault);
      return;
    }
    if (state === 'live') {
      fault.style.display = 'none';
      fill(fault);
      return;
    }

    fault.style.display = '';
    fill(
      fault,
      h(
        'div',
        { class: 'pass__fault-card' },
        h(
          'div',
          { class: 'pass__fault-text' },
          h('span', { class: 'display d-sm', text: FAULT_TITLE[state] }),
          detail === '' ? null : h('p', { class: 'note', text: detail }),
        ),
        state === 'starting' || state === 'idle'
          ? null
          : button('btn btn--sun', () => void passthrough.retry(), 'Retry'),
      ),
    );
  }

  /** Re-places every marker against the video's current cover box. */
  function place(): void {
    const box = coverBox(video, node.clientWidth, node.clientHeight);
    if (box === null) return;
    for (const marker of markers) {
      marker.node.style.left = `${box.left + marker.x * box.width}px`;
      marker.node.style.top = `${box.top + marker.y * box.height}px`;
    }
  }

  function setOverlay(next: readonly OverlayMarker[]): void {
    markers = next;
    overlay.replaceChildren(...next.map((marker) => marker.node));
    place();
  }

  // Both matter: the element box changes when the window is resized, and the FRAME box changes
  // the moment the stream reports its real dimensions, which lags the first paint.
  const observer = new ResizeObserver(place);
  observer.observe(node);
  video.addEventListener('loadedmetadata', place);

  paintFault(status, passthrough.current.detail);

  return {
    node,
    video: () => (status === 'live' ? video : null),
    status: () => status,
    onStatusChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setOverlay,
    destroy: () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', place);
      unsubscribe();
      listeners.clear();
      video.srcObject = null;
      release();
    },
  };
}
