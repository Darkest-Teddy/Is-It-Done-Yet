/**
 * A screen built at its true artboard size, scaled to fit whatever window it lands in.
 *
 * This replaces the fluid-grid approach the first version of these panels used, and the reason
 * is worth writing down because it reverses an earlier decision.
 *
 * The design document is not a description of a layout, it IS the layout: 1600x900 and 1440x810
 * boxes with every element absolutely positioned, rotated a degree and a half, and carrying
 * five-layer shadow stacks. Re-flowing that into a responsive grid loses the composition --
 * which is exactly what happened, and what this fixes. A centred wordmark with a cream outline
 * and two tilted cards under it is not the same screen as a left-aligned column, no matter how
 * faithfully the individual elements are reproduced.
 *
 * So: build at artboard coordinates, then `transform: scale()` the whole thing. Every position,
 * size, rotation and shadow is exactly the number in the document, and the only variable is one
 * scale factor. It also handles a resizable Quest Browser window for free, which the artboard
 * itself does not.
 *
 * THE TRADE-OFF, stated plainly. Scaling down shrinks text: the "RANK 3" label on the title
 * screen is 9px in the artboard, so in a 1400px-wide window it renders at about 8px. The
 * artboard chose that size for a monitor. Anything that must stay legible in a headset gets a
 * floor applied at the call site rather than silently being left tiny -- see `MIN_LEGIBLE_PX`.
 */

import { h } from './dom.js';

export interface StageOptions {
  /** Artboard width in design pixels. 1600 for the 1x screens, 1440 for the 2x ones. */
  readonly width: number;
  readonly height: number;
  /**
   * Allow scaling past 1:1 on a window bigger than the artboard.
   *
   * On by default. A Quest Browser window can be dragged wider than 1600px, and pinning the
   * design to its native size there would leave it marooned in the middle of the screen at the
   * exact moment there is room to make it readable.
   */
  readonly allowUpscale?: boolean;
}

export interface Stage {
  /** Put this in the screen. It fills its parent and centres the scaled artboard. */
  readonly node: HTMLElement;
  /** Build the screen's contents in here, in artboard coordinates. */
  readonly board: HTMLElement;
  readonly destroy: () => void;
}

/**
 * Below this, a design-pixel size is too small to read through a lens at arm's length.
 *
 * Applied by call sites to the handful of labels the artboard set for a monitor. It is a floor,
 * not a rescale: the element keeps its position and its box, and only the type stops shrinking.
 */
export const MIN_LEGIBLE_PX = 12;

/** How many times to retry the first fit before giving up, and how long to wait between. */
const MAX_FIT_ATTEMPTS = 20;
const FIT_RETRY_MS = 32;

export function createStage(options: StageOptions): Stage {
  const { width, height, allowUpscale = true } = options;

  const board = h('div', {
    class: 'stage__board',
    style: { width: `${width}px`, height: `${height}px` },
  });

  const node = h('div', { class: 'stage' }, board);

  /** Returns false when the element has no box yet, so the caller can try again. */
  function fit(): boolean {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;

    const raw = Math.min(box.width / width, box.height / height);
    const scale = allowUpscale ? raw : Math.min(1, raw);
    board.style.transform = `scale(${scale})`;
    return true;
  }

  // Getting the FIRST fit to land is the whole difficulty here, and it is worth writing down
  // because two obvious approaches both fail silently.
  //
  // The stage is built DETACHED: a panel calls `createStage`, fills the board, and only then is
  // the screen appended. So the synchronous call below measures a zero box and bails. A
  // ResizeObserver does not reliably deliver a callback for the detached-to-attached transition
  // either. And `requestAnimationFrame` -- the obvious fix -- DOES NOT RUN AT ALL IN A HIDDEN
  // TAB, so a build opened in a background tab would render every board at 1:1, overflowing the
  // window, and stay that way until something else happened to resize it. That failure looks
  // like a cropped design rather than like a missing transform, which is what makes it
  // expensive to find.
  //
  // A timer fires either way, throttled but reliable. So: retry on a short timeout until the
  // element actually has a box. Bounded, because a stage that never gets one is a bug to see
  // rather than a loop to run forever.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const tryFit = (): void => {
    timer = null;
    if (fit() || attempts >= MAX_FIT_ATTEMPTS) return;
    attempts += 1;
    timer = setTimeout(tryFit, FIT_RETRY_MS);
  };

  // Named, not an inline arrow: `removeEventListener` compares by reference, and a fresh arrow
  // in the remove call would leave the listener attached for the life of the page.
  const onResize = (): void => void fit();

  const observer = new ResizeObserver(onResize);
  observer.observe(node);
  window.addEventListener('resize', onResize);
  tryFit();

  return {
    node,
    board,
    destroy: () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    },
  };
}
