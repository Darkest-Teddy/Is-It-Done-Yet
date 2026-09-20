/**
 * Screen 1B -- loading.
 *
 * The artboard built a burger by dropping each layer in from off-screen on a 2.8s loop. That
 * loop is the clearest example of what the brief meant by placeholder animation: it ran forever
 * at a fixed speed, so it told you nothing about whether anything was actually loading, and on
 * a fast connection it delayed a screen that was already ready.
 *
 * Same picture, real meaning. There are six layers and six things that genuinely have to
 * happen before a camera screen can work. A layer goes from outline to solid when its step
 * finishes, so the stack IS the progress bar -- and if one step is slow, the layer it belongs
 * to is the one still hollow, which is a far better diagnostic than a spinner.
 *
 * The heavy step is OpenCV: about 15MB of WASM, and the reason this screen exists at all
 * rather than the title screen going straight to the counter.
 */

import type { AppContext, Panel, Route, RouteParams } from '../app.js';
import { h, svg } from '../dom.js';
import { createStage } from '../stage.js';
import { loadVision } from '../vision.js';
import { passthrough } from '../passthrough.js';

/** The stack, drawn top-down. Paths lifted verbatim from the design document. */
/** Each layer at its artboard position: the document's s1..s6 blocks, verbatim. */
const LAYERS: readonly {
  id: string;
  label: string;
  ratio: number;
  bottom: number;
  width: number;
  marginLeft: number;
  markup: string;
}[] = [
  {
    id: 'ready',
    bottom: 186,
    width: 290,
    marginLeft: -145,
    label: 'Kitchen ready',
    ratio: 290 / 152,
    markup: `<svg viewBox="0 0 290 152" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M6 138 C6 62 68 10 145 10 C222 10 284 62 284 138 C284 145 277 148 268 148 H22 C13 148 6 145 6 138 Z" fill="#F79B3E"/><ellipse cx="112" cy="64" rx="66" ry="36" fill="#FCC077" stroke="none" opacity=".85"/><path d="M232 46 C262 74 276 108 276 138 C276 145 271 148 264 148 H222 C240 120 246 80 232 46 Z" fill="#EE8A2A" stroke="none"/><g fill="#FFFFFF" stroke="none"><ellipse cx="108" cy="72" rx="4.5" ry="8" transform="rotate(-22 108 72)"/><ellipse cx="146" cy="58" rx="4.5" ry="8" transform="rotate(10 146 58)"/><ellipse cx="186" cy="66" rx="4.5" ry="8" transform="rotate(-14 186 66)"/><ellipse cx="128" cy="94" rx="4.5" ry="8" transform="rotate(18 128 94)"/><ellipse cx="172" cy="96" rx="4.5" ry="8" transform="rotate(-8 172 96)"/><ellipse cx="214" cy="88" rx="4.5" ry="8" transform="rotate(24 214 88)"/></g></g></svg>`,
  },
  {
    id: 'camera',
    bottom: 152,
    width: 300,
    marginLeft: -150,
    label: 'Passthrough camera',
    ratio: 300 / 58,
    markup: `<svg viewBox="0 0 300 58" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M8 10 H292 V26 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 q -17.75 30 -35.5 0 Z" fill="#6FC13C"/><path d="M8 13 H292 V21 H8 Z" fill="#8AD455" stroke="none"/></g></svg>`,
  },
  {
    id: 'vision',
    bottom: 138,
    width: 288,
    marginLeft: -144,
    label: 'Vision engine',
    ratio: 288 / 56,
    markup: `<svg viewBox="0 0 288 56" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M10 28 C10 14 24 8 44 8 H244 C264 8 278 14 278 28 C278 42 264 48 244 48 H44 C24 48 10 42 10 28 Z" fill="#E8342A"/><path d="M40 20 C40 16 48 15 58 15 H150 C160 15 166 17 166 20 C166 24 158 25 148 25 H58 C48 25 40 24 40 20 Z" fill="#F4685C" stroke="none"/></g></svg>`,
  },
  {
    id: 'art',
    bottom: 112,
    width: 300,
    marginLeft: -150,
    label: 'Ingredient art',
    ratio: 300 / 48,
    markup: `<svg viewBox="0 0 300 48" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M6 8 H294 V20 C294 27 288 31 279 31 H268 C267 41 259 45 251 45 C243 45 236 40 235 31 H121 C120 42 112 46 103 46 C94 46 87 41 86 31 H21 C12 31 6 27 6 20 Z" fill="#F6B93B"/><path d="M18 12 H282 V19 H18 Z" fill="#FCD268" stroke="none"/></g></svg>`,
  },
  {
    id: 'recipes',
    bottom: 56,
    width: 292,
    marginLeft: -146,
    label: 'Recipe book',
    ratio: 292 / 76,
    markup: `<svg viewBox="0 0 292 76" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M8 30 C8 16 22 8 44 8 H248 C270 8 284 16 284 30 V46 C284 60 270 68 248 68 H44 C22 68 8 60 8 46 Z" fill="#A8555C"/><path d="M14 46 C30 60 60 66 146 66 C232 66 262 60 278 46 C278 60 262 68 248 68 H44 C30 68 14 60 14 46 Z" fill="#8E4348" stroke="none"/></g></svg>`,
  },
  {
    id: 'fonts',
    bottom: 0,
    width: 280,
    marginLeft: -140,
    label: 'Typefaces',
    ratio: 280 / 84,
    markup: `<svg viewBox="0 0 280 84" xmlns="http://www.w3.org/2000/svg"><g stroke="#46101A" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"><path d="M6 10 H274 V44 C274 66 244 78 140 78 C36 78 6 66 6 44 Z" fill="#F79B3E"/><path d="M30 62 C60 74 220 74 250 62 C236 74 196 78 140 78 C84 78 44 74 30 62 Z" fill="#E8862C" stroke="none"/></g></svg>`,
  },
];

/**
 * How long the loading screen waits on the camera before moving on.
 *
 * Long enough for an already-granted permission to come back, short enough that somebody who
 * has not answered the prompt yet is not left staring at a burger.
 */
const CAMERA_WAIT_MS = 4000;

/**
 * How long the loading screen waits on the vision engine before moving on without it.
 *
 * The chunk is about 15MB and it is the only thing on this screen that can take real time. The
 * number is a wifi budget rather than a preference: 15MB in 25s is about 5 Mbit/s, which is a
 * pessimistic-but-real share of a saturated hall network, so a link that would have finished
 * usually has. Past that the honest thing is to hand the cook a counter they can type into
 * rather than a burger that never fills.
 *
 * The load is not cancelled when this expires -- see `loadVision`. It keeps going, and the
 * counter screen's Scan button picks it up when it lands. TUNED, not sourced.
 */
const VISION_WAIT_MS = 25_000;

/** Steps in the order they are started, bottom of the stack upward. */
const STEP_ORDER = ['fonts', 'recipes', 'art', 'vision', 'camera', 'ready'] as const;

const CAPTION: Readonly<Record<string, string>> = {
  fonts: 'Setting the type…',
  recipes: 'Opening the recipe book…',
  art: 'Plating the ingredients…',
  vision: 'Waking the vision engine…',
  camera: 'Asking for the passthrough camera…',
  ready: 'Service.',
};

/** Warms an image so the first screen that needs it does not pop it in a frame late. */
function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    image.src = url;
  });
}

export function loadingPanel(ctx: AppContext, params: RouteParams): Panel {
  const next: Route = params.next ?? 'counter';
  const done = new Set<string>();
  let cancelled = false;

  const layerNodes = new Map<string, HTMLElement>();

  const stack = h(
    'div',
    { class: 'l-stack', attrs: { 'aria-hidden': 'true' } },
    h('div', { class: 'l-shadow' }),
    ...LAYERS.map((layer) => {
      const node = h(
        'div',
        {
          class: 'l-layer',
          style: {
            bottom: `${layer.bottom}px`,
            width: `${layer.width}px`,
            marginLeft: `${layer.marginLeft}px`,
            aspectRatio: String(layer.ratio),
          },
        },
        svg(layer.markup),
      );
      layerNodes.set(layer.id, node);
      return node;
    }),
  );

  const caption = h('div', { class: 'l-caption', text: CAPTION['fonts'] ?? '' });
  const fill = h('div', { class: 'l-meter__fill', style: { width: '0%' } });
  const steps = h('div', { class: 'l-steps' });

  const modeLabel = h('div', {
    class: 'l-mode',
    text: next === 'cutting' ? 'Competitive cutting' : 'Recipe sandbox',
  });

  function paint(): void {
    for (const layer of LAYERS) {
      layerNodes.get(layer.id)?.classList.toggle('is-done', done.has(layer.id));
    }
    fill.style.width = `${Math.round((done.size / STEP_ORDER.length) * 100)}%`;

    const pending = STEP_ORDER.find((id) => !done.has(id));
    caption.textContent = pending === undefined ? CAPTION['ready'] ?? '' : CAPTION[pending] ?? '';

    steps.replaceChildren(
      ...STEP_ORDER.map((id) =>
        h(
          'div',
          { class: `l-step${done.has(id) ? ' is-done' : ''}` },
          h('span', { class: 'l-tick', text: done.has(id) ? '✓' : '·' }),
          h('span', { text: LAYERS.find((layer) => layer.id === id)?.label ?? id }),
        ),
      ),
    );
  }

  function complete(id: string): void {
    if (cancelled) return;
    done.add(id);
    paint();
  }

  async function run(): Promise<void> {
    // Fonts first: they are small, they are already in flight from the stylesheet, and having
    // them settled before anything else appears is what stops the later screens reflowing.
    await document.fonts.ready.catch(() => undefined);
    complete('fonts');

    complete('recipes');

    // A handful of icons the next screen will certainly want. Not all 437 -- that would be
    // 13MB for pictures nobody has asked to see yet.
    await Promise.all(
      ['bun-top', 'patty', 'lettuce', 'ketchup', 'tomato', 'onion', 'egg', 'cheese'].map((name) =>
        preload(`${import.meta.env.BASE_URL}menu/icons/${name}.png`),
      ),
    );
    complete('art');

    // The expensive one, and the only step on this screen with a ceiling worth arguing about.
    // It resolves false rather than throwing when the WASM cannot be had, and the app stays
    // usable -- every ingredient can still be entered by hand. The ceiling is there because
    // neither of its two slow paths ever rejects: a stalled 15MB fetch and a runtime that
    // never announces itself both look exactly like a screen that has stopped. This panel has
    // no rail and no Escape, so without the ceiling the only exit was the headset.
    await loadVision(VISION_WAIT_MS);
    complete('vision');

    // Raced against a timeout, and that race is load-bearing rather than defensive. A camera
    // permission prompt is answered by a person, and `getUserMedia` does not resolve until they
    // answer it -- so awaiting it plainly means a loading screen that sits at 80% indefinitely
    // while the prompt waits behind the headset's own UI. The camera keeps opening in the
    // background either way, and the counter and cutting screens both report its real state
    // themselves, including "still starting".
    await Promise.race([
      passthrough.start().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, CAMERA_WAIT_MS)),
    ]);
    complete('camera');

    complete('ready');

    if (cancelled) return;
    ctx.go(next);
  }

  paint();
  void run();

  const stage = createStage({ width: 1600, height: 900 });
  stage.board.classList.add('l-board');
  stage.board.append(
    h(
      'div',
      { class: 'l-centre' },
      stack,
      h(
        'div',
        { class: 'l-readout' },
        caption,
        h('div', { class: 'l-meter' }, fill),
        modeLabel,
        steps,
      ),
    ),
    h('div', {
      class: 'l-tip',
      text: 'Tip · curl your fingers, knuckles guide the blade',
    }),
    h('div', { class: 'l-hem' }),
  );

  const node = h('section', { class: 'screen screen--board loading' }, stage.node);

  return {
    node,
    destroy: () => {
      cancelled = true;
      stage.destroy();
    },
  };
}
