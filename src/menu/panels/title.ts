/**
 * Screen 1A -- the title screen.
 *
 * Built at the artboard's own 1600x900 and scaled to fit the window (see `stage.ts`). Every
 * number below is the number in the design document: the tomato really is at left 132 / top 206
 * at 132px wide, the wordmark really is 132px Ranchers rotated -1.6 degrees under a six-layer
 * cream outline, and the two mode cards really are tilted a degree in opposite directions.
 *
 * This replaced a version that reproduced the right ELEMENTS in the wrong COMPOSITION -- built
 * from the document's markup with the inline styles stripped off, which threw away the entire
 * layout. Left-aligned instead of centred, cream cards instead of red and yellow, the rank chip
 * on the wrong side. Reading the styles is the whole job here; the elements were never the hard
 * part.
 *
 * TWO DELIBERATE DEPARTURES, both from the brief rather than from taste.
 *
 * The bobbing on the six scattered ingredients and the sizzle on the LIVE badge are gone --
 * `idy-bob` / `idy-bob2` / `idy-bob3` / `idy-sizzle`, decorative loops with nothing behind them.
 * Their positions, sizes, rotations and drop-shadows are kept exactly.
 *
 * "LIVE · 412" is a player count with no service behind it, so the badge carries the number that
 * is actually true: how many runs are on the board.
 *
 * Line-heights follow the v2 export (1.2, not the original 0.8/0.86), which is the fix that
 * re-export exists to deliver -- Ranchers has tall caps and the tight values clipped them.
 */

import { progressFor, RANKS } from '../../core/rank.js';
import { heroUrl, type HeroIcon } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { button, h } from '../dom.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';

const W = 1600;
const H = 900;

/** The cream outline the wordmark carries in the document, verbatim. */
const WORDMARK_SHADOW = [
  '0 8px 0 #FFF3E4',
  '8px 0 0 #FFF3E4',
  '-8px 0 0 #FFF3E4',
  '0 -8px 0 #FFF3E4',
  '7px 7px 0 #FFF3E4',
  '-7px 7px 0 #FFF3E4',
  '12px 15px 0 rgba(59,42,27,.14)',
].join(', ');

/** The drop-shadow pair every scattered ingredient carries. */
const SCATTER_SHADOW =
  'drop-shadow(0 4px 0 rgba(59,42,27,.22)) drop-shadow(7px 12px 12px rgba(59,42,27,.35))';

/** Positioned as the document positions them: `left` for the left group, `right` for the right. */
interface Scatter {
  readonly name: HeroIcon;
  readonly left?: number;
  readonly right?: number;
  readonly top: number;
  readonly width: number;
}

const SCATTER: readonly Scatter[] = [
  { name: 'tomato', left: 132, top: 206, width: 132 },
  { name: 'lettuce', left: 44, top: 452, width: 150 },
  { name: 'chili', left: 214, top: 648, width: 104 },
  { name: 'cheese', right: 126, top: 212, width: 138 },
  { name: 'patty', right: 58, top: 462, width: 146 },
  { name: 'mushroom', right: 222, top: 656, width: 104 },
];

interface ModeSpec {
  readonly icon: HeroIcon;
  readonly iconWidth: number;
  readonly iconTilt: number;
  readonly lines: readonly [string, string];
  readonly blurb: string;
  readonly background: string;
  readonly ink: string;
  readonly blurbInk: string;
  readonly tilt: number;
  readonly flag?: string;
  readonly onPress: () => void;
}

function modeCard(spec: ModeSpec): HTMLButtonElement {
  const icon = h('img', {
    attrs: { src: heroUrl(spec.icon), alt: '', draggable: 'false', decoding: 'async' },
    style: { width: `${spec.iconWidth}px`, transform: `rotate(${spec.iconTilt}deg)` },
  });

  const card = button(
    't-mode',
    spec.onPress,
    spec.flag === undefined ? null : h('span', { class: 't-mode__flag', text: spec.flag }),
    h(
      'span',
      { class: 't-mode__row' },
      h('span', { class: 't-mode__tile' }, icon),
      h(
        'span',
        { class: 't-mode__title', style: { color: spec.ink } },
        h('span', { text: spec.lines[0] }),
        h('span', { text: spec.lines[1] }),
      ),
    ),
    h('span', { class: 't-mode__blurb', text: spec.blurb, style: { color: spec.blurbInk } }),
  );

  card.style.background = spec.background;
  card.style.setProperty('--tilt', `${spec.tilt}deg`);
  return card;
}

export function titlePanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const { state } = ctx;
  const progress = progressFor(state.best);
  const tier = RANKS.indexOf(progress.current) + 1;
  const runs = state.board.length;

  const stage = createStage({ width: W, height: H });

  const scatter = SCATTER.map((item) =>
    h('img', {
      class: 't-scatter',
      attrs: { src: heroUrl(item.name), alt: '', draggable: 'false', decoding: 'async' },
      style: {
        ...(item.left === undefined ? {} : { left: `${item.left}px` }),
        ...(item.right === undefined ? {} : { right: `${item.right}px` }),
        top: `${item.top}px`,
        width: `${item.width}px`,
        filter: SCATTER_SHADOW,
      },
    }),
  );

  const rankChip = h(
    'div',
    { class: 't-rank' },
    h('span', { class: 't-rank__badge', text: String(tier) }),
    h(
      'span',
      { class: 't-rank__text' },
      h('span', { class: 't-rank__tier', text: `Rank ${tier}` }),
      h('span', { class: 't-rank__title', text: progress.current.title }),
    ),
  );

  // The artboard's two corner buttons -- a levels glyph and a ring -- are drawn but never
  // labelled, so they are wired to the two things this screen can honestly offer.
  const corner = h(
    'div',
    { class: 't-corner' },
    button(
      't-corner__btn',
      () => ctx.go('loading', { next: 'cutting' }),
      h('span', { class: 't-bars' }, h('i', null), h('i', null), h('i', null)),
    ),
    button('t-corner__btn', () => ctx.go('loading', { next: 'counter' }), h('span', { class: 't-ring' })),
  );

  const wordmark = h(
    'div',
    { class: 't-mark' },
    h('span', { class: 't-mark__ar', text: 'AR' }),
    h(
      'div',
      { class: 't-mark__type', style: { textShadow: WORDMARK_SHADOW } },
      h('div', { class: 't-mark__l1', text: 'Is it done' }),
      h('div', { class: 't-mark__l2', text: 'yet?' }),
    ),
  );

  const centre = h(
    'div',
    { class: 't-centre' },
    wordmark,
    h('p', {
      class: 't-lede',
      text: 'Real knife, real counter. The camera watches your board and calls the doneness.',
    }),
    h(
      'div',
      { class: 't-modes' },
      modeCard({
        icon: 'carrot',
        iconWidth: 62,
        iconTilt: -14,
        lines: ['Competitive', 'Cutting'],
        blurb: '1v1 knife work · 90 seconds · ranked',
        background: '#F5230E',
        ink: '#FFF3E4',
        blurbInk: '#FFD9C9',
        tilt: -1,
        flag: runs === 0 ? 'New board' : `${runs} runs`,
        onPress: () => ctx.go('loading', { next: 'cutting' }),
      }),
      modeCard({
        icon: 'ketchup',
        iconWidth: 54,
        iconTilt: 10,
        lines: ['Recipe', 'Sandbox'],
        blurb: 'No timer · free-roam · 437 ingredients',
        background: '#FBD24B',
        ink: '#3B2A1B',
        blurbInk: '#6B4427',
        tilt: 1,
        onPress: () => ctx.go('loading', { next: 'counter' }),
      }),
    ),
    h(
      'div',
      { class: 't-links' },
      button('t-link', () => ctx.go('library'), 'How to play'),
      button('t-link', () => ctx.go('loading', { next: 'counter' }), 'My kitchen'),
      button('t-link', () => ctx.go('loading', { next: 'cutting' }), 'Leaderboard'),
    ),
  );

  stage.board.classList.add('t-board');
  stage.board.append(h('div', { class: 't-stripes' }), ...scatter, rankChip, corner, centre);

  // The artboard draws no controller rail on 1A -- that strip is a 2x-screen element -- so this
  // screen keeps the keyboard bindings and draws nothing.
  const rail = createRail([
    { key: 'A', label: 'Competitive cutting', onPress: () => ctx.go('loading', { next: 'cutting' }) },
    { key: 'B', label: 'Recipe sandbox', onPress: () => ctx.go('loading', { next: 'counter' }) },
    { key: 'X', label: 'Recipe library', onPress: () => ctx.go('library') },
  ]);
  rail.node.classList.add('sr');

  const node = h('section', { class: 'screen screen--board title' }, stage.node, rail.node);

  return {
    node,
    destroy: () => {
      stage.destroy();
      rail.destroy();
    },
  };
}
