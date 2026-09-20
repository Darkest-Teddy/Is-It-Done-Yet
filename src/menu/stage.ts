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

export function createStage(options: StageOptions): Stage {
  const { width, height, allowUpscale = true } = options;

  const board = h('div', {
    class: 'stage__board',
    style: { width: `${width}px`, height: `${height}px` },
  });

  const node = h('div', { class: 'stage' }, board);

  function fit(): void {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;

    const raw = Math.min(box.width / width, box.height / height);
    const scale = allowUpscale ? raw : Math.min(1, raw);
    board.style.transform = `scale(${scale})`;
  }

  // Three triggers, and all three earn their place. The stage is built DETACHED -- the caller
  // fills the board and appends the screen afterwards -- so the synchronous call below always
  // measures a zero box and bails. A ResizeObserver alone proved not to be enough either: it
  // does not reliably deliver a callback for the detached-to-attached transition, which left
  // the board sitting at 1:1 and overflowing the window. The rAF pass is the one that actually
  // lands the first fit, and the observer and the resize listener keep it right afterwards.
  const observer = new ResizeObserver(fit);
  observer.observe(node);
  window.addEventListener('resize', fit);
  const frame = requestAnimationFrame(fit);
  fit();

  return {
    node,
    board,
    destroy: () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', fit);
      observer.disconnect();
    },
  };
}
