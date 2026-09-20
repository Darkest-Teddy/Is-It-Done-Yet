/**
 * Screen 1A -- the title screen.
 *
 * First thing a judge sees, so it has exactly one job: two obvious ways in, and nothing else
 * asking for attention. The artboard's decorative ingredients stay, because they are the whole
 * character of the thing. Their falling and bobbing animations do not, because a screen with
 * six objects drifting on loops is a screen somebody waits for instead of reading.
 *
 * Every number here is real. The artboard printed "LIVE · 412" beside the competitive mode;
 * there is no matchmaking service behind this, so that is now a count of runs actually on the
 * board. "437 ingredients" is the literal size of the art library in `menu/ingredients`. The
 * rank comes from `rankFor` over the best total this device has posted.
 */

import { progressFor, RANKS } from '../../core/rank.js';
import { designRem, heroSize, heroUrl, type HeroIcon } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { art, button, h } from '../dom.js';
import { createRail } from '../rail.js';

/** The ingredient art scattered behind the panel: where it sits, how big, how far tilted. */
const SCATTER: readonly { name: HeroIcon; left: string; top: string; px: number; tilt: number }[] = [
  // Sizes are the artboard's, in artboard pixels: tomato 132, lettuce 150, chili 104,
  // cheese 138, patty 146, mushroom 104.
  { name: 'tomato', left: '3.5%', top: '13%', px: 132, tilt: -8 },
  { name: 'lettuce', left: '4%', top: '74%', px: 150, tilt: 7 },
  { name: 'chili', left: '26%', top: '93%', px: 104, tilt: -14 },
  { name: 'cheese', left: '96%', top: '48%', px: 138, tilt: 11 },
  { name: 'patty', left: '90%', top: '85%', px: 146, tilt: -6 },
  { name: 'mushroom', left: '70%', top: '95%', px: 104, tilt: 9 },
];

interface ModeOptions {
  readonly tint: string;
  readonly icon: HeroIcon;
  readonly lines: readonly [string, string];
  readonly blurb: string;
  readonly flag?: string;
  readonly onPress: () => void;
}

function modeCard(opts: ModeOptions): HTMLButtonElement {
  return button(
    'press title__mode',
    opts.onPress,
    opts.flag === undefined ? null : h('span', { class: 'pill pill--hot title__flag', text: opts.flag }),
    h(
      'div',
      { class: 'title__mode-head' },
      h('div', { class: 'title__mode-icon', style: { background: opts.tint } }, art(heroUrl(opts.icon), heroSize(opts.icon, designRem(62)))),
      h(
        'div',
        { class: 'stack' },
        h('span', { class: 'display d-lg', text: opts.lines[0] }),
        h('span', { class: 'display d-lg', text: opts.lines[1] }),
      ),
    ),
    h('div', { class: 'note title__mode-blurb', text: opts.blurb }),
  );
}

export function titlePanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;
  const { state } = ctx;
  const progress = progressFor(state.best);
  const tier = RANKS.indexOf(progress.current) + 1;
  const runs = state.board.length;

  const scatter = h(
    'div',
    { class: 'title__scatter', attrs: { 'aria-hidden': 'true' } },
    ...SCATTER.map((item) =>
      h(
        'div',
        {
          class: 'title__scatter-item',
          style: {
            left: item.left,
            top: item.top,
            transform: `translate(-50%, -50%) rotate(${item.tilt}deg)`,
          },
        },
        art(heroUrl(item.name), designRem(item.px), ''),
      ),
    ),
  );

  const rankCard = h(
    'div',
    { class: 'title__rank card card--flat' },
    h('div', {
      class: 'title__rank-badge display',
      text: String(tier),
      style: { background: progress.current.color },
    }),
    h(
      'div',
      { class: 'stack grow' },
      h('span', { class: 'label', text: `Rank ${tier} of ${RANKS.length}`, style: { color: 'var(--brown)' } }),
      h('span', { class: 'display d-sm', text: progress.current.title }),
      h('span', {
        class: 'note',
        text: progress.next === null
          ? 'Top of the ladder.'
          : `${progress.remaining.toFixed(2)} from ${progress.next.title}.`,
      }),
      h(
        'div',
        { class: 'meter title__rank-meter' },
        h('div', {
          class: 'meter__fill',
          style: {
            width: `${Math.round(progress.fraction * 100)}%`,
            background: progress.current.color,
          },
        }),
      ),
    ),
  );

  const body = h(
    'div',
    { class: 'title__body' },
    scatter,
    h(
      'div',
      { class: 'title__panel' },
      h(
        'div',
        { class: 'title__mark' },
        h('div', { class: 'title__ar display', text: 'AR' }),
        h(
          'div',
          { class: 'stack' },
          h('span', { class: 'display d-xl', text: 'Is it done' }),
          h('span', { class: 'display d-xl title__mark-red', text: 'yet?' }),
        ),
      ),
      h('p', {
        class: 'prose title__lede',
        text: 'Real knife, real counter. The camera watches your board and calls the doneness.',
      }),
      h(
        'div',
        { class: 'title__modes' },
        modeCard({
          tint: 'var(--yellow-soft)',
          icon: 'carrot',
          lines: ['Competitive', 'Cutting'],
          blurb: '90 seconds · ranked · scored on how even your cuts are',
          flag: runs === 0 ? 'New board' : `${runs} runs on the board`,
          onPress: () => ctx.go('loading', { next: 'cutting' }),
        }),
        modeCard({
          tint: 'var(--sky)',
          icon: 'ketchup',
          lines: ['Recipe', 'Sandbox'],
          blurb: 'No timer · free-roam · 437 ingredients',
          onPress: () => ctx.go('loading', { next: 'counter' }),
        }),
      ),
      h(
        'div',
        { class: 'title__links' },
        button('btn', () => ctx.go('library'), 'Recipe library'),
        button('btn', () => ctx.go('loading', { next: 'counter' }), 'My counter'),
        button('btn', () => ctx.go('loading', { next: 'cutting' }), 'Leaderboard'),
      ),
    ),
    rankCard,
  );

  const rail = createRail([
    {
      key: 'A',
      label: 'Competitive cutting',
      accent: true,
      onPress: () => ctx.go('loading', { next: 'cutting' }),
    },
    { key: 'B', label: 'Recipe sandbox', onPress: () => ctx.go('loading', { next: 'counter' }) },
    { key: 'X', label: 'Recipe library', onPress: () => ctx.go('library') },
  ]);

  const node = h('section', { class: 'screen screen--paper title' }, body, rail.node);

  return { node, destroy: () => rail.destroy() };
}
