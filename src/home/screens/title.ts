/**
 * Screen 1 -- the title, in the language of artboard 1A.
 *
 * Copy is the deployed page's, word for word: the wordmark, the one-line lede, and the two
 * mode cards with their blurbs. What changes is everything about how it is drawn.
 *
 * The deployed page sets this screen as a centred column on a flat cream ground with two
 * outlined rectangles under it. The artboard builds a physical object: a board standing off
 * the paper on a five-layer shadow, six ingredients scattered down its margins, a wordmark
 * carrying a six-layer cream outline, and two counter-tilted slabs that sit further off the
 * board than anything else on the screen because they are the only things meant to be pressed.
 *
 * TWO NUMBERS ON THIS SCREEN ARE REAL AND NOTHING ELSE IS INVENTED. The rank is
 * `progressFor(0)` -- rank 1, Prep Hand, because nothing has been scored yet and claiming
 * otherwise would be a lie told by the first thing a visitor reads. The library card's flag is
 * `RECIPES.length`, a literal count of the data. The artboard's own "5 runs" flag has no
 * equivalent here, so the first card's flag describes what the mode does instead of quoting a
 * statistic that does not exist.
 */

import { progressFor } from '../../core/rank.js';
import { RECIPES } from '../../core/recipe.js';
import { heroSize, heroUrl, type HeroIcon } from '../../menu/art.js';
import { button, h } from '../../menu/dom.js';
import type { Flow, Screen } from '../flow.js';

/** The document's six scattered hero icons, as shares of the board rather than artboard px. */
interface Scatter {
  readonly name: HeroIcon;
  readonly left?: string;
  readonly right?: string;
  readonly top: string;
  readonly width: string;
}

const SCATTER: readonly Scatter[] = [
  { name: 'tomato', left: '8%', top: '23%', width: '8.2%' },
  { name: 'lettuce', left: '3%', top: '50%', width: '9.4%' },
  { name: 'chili', left: '13%', top: '72%', width: '6.5%' },
  { name: 'cheese', right: '8%', top: '24%', width: '8.6%' },
  { name: 'patty', right: '4%', top: '51%', width: '9.1%' },
  { name: 'mushroom', right: '14%', top: '73%', width: '6.5%' },
];

/** The tile icon on each mode card. Carrot and ketchup, as the artboard pairs them on 1A. */
const MODE_ICON: Readonly<Record<'counter' | 'library', HeroIcon>> = {
  counter: 'carrot',
  library: 'ketchup',
};

const TILE_REM = 2.9;

function modeCard(
  kind: 'counter' | 'library',
  tone: 'red' | 'sun',
  tilt: number,
  flag: string,
  title: readonly string[],
  blurb: string,
  onPress: () => void,
): HTMLButtonElement {
  const icon = MODE_ICON[kind];

  const card = button(
    `t-mode t-mode--${tone}`,
    onPress,
    h('span', { class: 't-mode__flag', text: flag }),
    h(
      'span',
      { class: 't-mode__row' },
      h(
        'span',
        { class: 't-mode__tile' },
        h('img', {
          attrs: { src: heroUrl(icon), alt: '', draggable: 'false', decoding: 'async' },
          style: { width: `${heroSize(icon, TILE_REM)}rem`, objectFit: 'contain' },
        }),
      ),
      // Two lines, not one wrapped line. At 0.86 leading the wordmark look only holds if the
      // break is where the design puts it rather than wherever the box happens to run out.
      h('span', { class: 't-mode__title' }, ...title.map((line) => h('span', { text: line }))),
    ),
    h('span', { class: 't-mode__blurb', text: blurb }),
  );

  // The tilt is a custom property rather than part of a transform, because the hover and press
  // states translate as well and a transform set here would be overwritten by the one in the
  // stylesheet. `--tilt` lets the rotation and the travel compose.
  card.style.setProperty('--tilt', `${tilt}deg`);
  return card;
}

export function createTitle(flow: Flow): Screen {
  const rank = progressFor(0).current;

  const scatter = SCATTER.map((item) =>
    h('img', {
      class: 't-scatter',
      attrs: { src: heroUrl(item.name), alt: '', draggable: 'false', decoding: 'async' },
      style: {
        ...(item.left === undefined ? {} : { left: item.left }),
        ...(item.right === undefined ? {} : { right: item.right }),
        top: item.top,
        width: item.width,
      },
    }),
  );

  const board = h(
    'div',
    { class: 't-board' },
    ...scatter,
    h(
      'div',
      { class: 't-rank' },
      h('span', { class: 't-rank__badge', text: '1' }),
      h(
        'span',
        { class: 't-rank__text' },
        h('span', { class: 't-rank__tier', text: 'Rank 1' }),
        h('span', { class: 't-rank__title', text: rank.title }),
      ),
    ),
    h(
      'div',
      { class: 't-centre' },
      h(
        'h1',
        { class: 't-mark', style: { margin: '0' } },
        h(
          'span',
          { class: 't-mark__type' },
          h('span', { class: 't-mark__l1', style: { display: 'block' }, text: 'Is it done' }),
          h('span', { class: 't-mark__l2', style: { display: 'block' }, text: 'yet?' }),
        ),
        // After the type, not before it. The flag is absolutely positioned and a positioned
        // element paints above a static sibling only when it comes later in the DOM; put it
        // first and the wordmark's six-layer cream outline covers it.
        h('span', { class: 't-mark__ar', text: 'AR' }),
      ),
      h('p', {
        class: 't-lede',
        text: 'Real knife, real counter. The camera watches your board and calls the doneness.',
      }),
      h(
        'div',
        { class: 't-modes' },
        modeCard(
          'counter',
          'red',
          -1,
          'Live count',
          ['Count my', 'counter'],
          'Point the camera at your ingredients. The tally updates as you move things.',
          () => flow.show('s-counter'),
        ),
        modeCard(
          'library',
          'sun',
          1,
          `${RECIPES.length} dishes`,
          ['Recipe', 'library'],
          'Browse every dish and see what you can finish with what is already out.',
          () => flow.show('s-library'),
        ),
      ),
    ),
  );

  return { node: h('section', {}, board) };
}
