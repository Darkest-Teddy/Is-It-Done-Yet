/**
 * Screen 2D -- the dish card.
 *
 * Built at the artboard's 1440x810: main card at left 48 / top 92 / width 820, right column at
 * right 48 / width 474, a 250px hero band in `#FBE3A0` with three overlapping icons, and the
 * name below at 70px Ranchers.
 *
 * THREE DEPARTURES.
 *
 * `idy-bob3` on the hero patty and `idy-press` on the HOLD chip are gone with the rest of the
 * animations; the rotations and offsets around them stay.
 *
 * "+180 XP" needs an XP system nobody has built. The badge carries the number of steps in the
 * recipe instead, which is the thing somebody weighing up a dish actually wants.
 *
 * "Your best: NOT COOKED" implies per-dish history that is not stored. What IS stored is the
 * best competitive round this device has posted, so the tile says that and says which thing it
 * is measuring.
 */

import { matchRecipe } from '../../core/pantry.js';
import { rankFor } from '../../core/rank.js';
import type { Recipe } from '../../core/recipe.js';
import { artFor, heroSize, type HeroIcon } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { button, h, svg } from '../dom.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };
const KNIFE_WORDS = /\b(slice|sliced|chop|chopped|cut|dice|diced|grate|grated|halve|halves)\b/i;

/** Artboard widths: hero 180 / 104 / 96, ingredient rows 34. */
const ROW_ICON = 34;

const img = (src: string, width: number): HTMLImageElement =>
  h('img', {
    attrs: { src, alt: '', draggable: 'false', decoding: 'async' },
    style: { width: `${width}px` },
  });

function iconWidth(src: string, base: number): number {
  const stem = src.split('/').pop()?.replace('.png', '') ?? '';
  return heroSize(stem as HeroIcon, base);
}

/** The artboard's chevron: filled for each level earned, pale for the rest. */
const chevron = (filled: boolean): SVGElement =>
  svg(
    '<svg viewBox="0 0 24 24" width="26" height="26" xmlns="http://www.w3.org/2000/svg">'
    + `<path d="M4 19 L15 8 L19 4 L21 6 L17 10 L6 21 Z" fill="${filled ? '#F5230E' : '#E4CBB2'}"`
    + ' stroke="#46101A" stroke-width="2.4" stroke-linejoin="round"/></svg>',
  );

interface TileTint { readonly background: string; readonly label: string; }

const TILE: readonly TileTint[] = [
  { background: '#F9D3B4', label: '#8A4B21' },
  { background: '#C4DAEE', label: '#2F4D68' },
  { background: '#CDE6C7', label: '#2F5A26' },
  { background: '#FBE3A0', label: '#8A6A2E' },
];

function statTile(index: number, label: string, value: Node | string): HTMLElement {
  const tint = TILE[index] ?? TILE[0]!;
  return h(
    'div',
    { class: 'd-stat', style: { background: tint.background } },
    h('div', { class: 'd-stat__label', text: label, style: { color: tint.label } }),
    typeof value === 'string'
      ? h('div', { class: 'd-stat__value', text: value })
      : h('div', { class: 'd-chevrons' }, value),
  );
}

export function dishPanel(ctx: AppContext, params: RouteParams): Panel {
  const stage = createStage({ width: 1440, height: 810 });
  const id = params.recipeId ?? ctx.state.selectedRecipeId;
  const recipe: Recipe | null = ctx.state.recipes.find((r) => r.id === id) ?? null;

  if (recipe === null) {
    const rail = createRail(
      [{ key: 'Y', label: 'Back to the library', onPress: () => ctx.go('library') }],
      () => ctx.go('library'),
      'board',
    );
    stage.board.classList.add('b2');
    stage.board.append(
      h('div', { class: 'd-missing' },
        h('div', { class: 'd-name', text: 'Not in the book' }),
        button('d-practise', () => ctx.go('library'), 'Back to the library')),
      rail.node,
    );
    return {
      node: h('section', { class: 'screen screen--board dish' }, stage.node),
      destroy: () => { stage.destroy(); rail.destroy(); },
    };
  }

  ctx.setState({ selectedRecipeId: recipe.id });

  const match = matchRecipe(ctx.state.pantry, recipe);
  const level = LEVEL[recipe.difficulty] ?? 2;
  const cuts = recipe.steps.filter((step) => KNIFE_WORDS.test(step.instruction)).length;
  const index = ctx.state.recipes.findIndex((r) => r.id === recipe.id) + 1;
  const best = ctx.state.best;

  function start(practice: boolean): void {
    if (!practice && !match.makeable) return;
    ctx.go('cutting', { recipeId: recipe?.id, practice });
  }

  const heroSrcs = recipe.requires.slice(0, 3).map((need) =>
    artFor(need.ingredient, categoryFor(need.ingredient)));

  const hero = h(
    'div',
    { class: 'd-hero' },
    img(heroSrcs[0] ?? '', 180),
    heroSrcs[1] === undefined ? null : h(
      'div',
      { class: 'd-hero__side', style: { left: '130px', bottom: '26px', transform: 'rotate(-8deg)' } },
      img(heroSrcs[1], 104),
    ),
    heroSrcs[2] === undefined ? null : h(
      'div',
      { class: 'd-hero__side', style: { right: '150px', top: '34px', transform: 'rotate(11deg)' } },
      img(heroSrcs[2], 96),
    ),
    h('div', {
      class: 'd-hero__flag',
      text: `${recipe.steps.length} steps`,
    }),
  );

  const startButton = button(
    'd-start',
    () => start(false),
    h('div', {
      class: 'd-start__title',
      text: match.makeable ? 'Start cooking' : `Missing ${match.missing.length}`,
    }),
    h(
      'div',
      { class: 'd-start__hint' },
      h('div', { class: 'd-start__key', text: match.makeable ? 'HOLD' : '—' }),
      h('div', {
        class: 'd-start__label',
        text: match.makeable ? 'Right trigger to begin' : 'Add them on the counter first',
      }),
    ),
  );
  startButton.disabled = !match.makeable;

  const rows = recipe.requires.map((need) => {
    const line = match.matched.find((m) => m.ingredient === need.ingredient)
      ?? match.missing.find((m) => m.ingredient === need.ingredient);
    const have = line?.have ?? 0;
    const needed = line?.needed ?? need.count?.min ?? 1;
    const ok = line !== undefined && line.satisfied;
    const src = artFor(need.ingredient, categoryFor(need.ingredient));

    return h(
      'div',
      { class: `d-row${ok ? '' : ' is-missing'}` },
      img(src, iconWidth(src, ROW_ICON)),
      h('span', { class: 'd-row__name', text: pretty(need.ingredient) }),
      h('span', {
        class: 'd-row__have',
        text: ok ? `${have} ✓` : `need ${Math.max(1, needed - have)}`,
      }),
    );
  });

  const rail = createRail(
    [
      {
        key: 'TRIG',
        label: match.makeable ? 'Start cooking' : 'Missing ingredients',
        accent: match.makeable,
        disabled: !match.makeable,
        shortcut: 'enter',
        onPress: () => start(false),
      },
      { key: 'X', label: 'Practise the knife work first', onPress: () => start(true) },
      { key: 'Y', label: 'Back', onPress: () => ctx.back() },
      { key: '☰', label: 'Menu', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
    'board',
  );

  stage.board.classList.add('b2');
  stage.board.append(
    h(
      'div',
      { class: 'd-head' },
      button('d-back', () => ctx.back(), '← Library'),
      h('div', {
        class: 'd-index',
        text: `Dish ${index} of ${ctx.state.recipes.length} · ${recipe.tags[0] ?? 'recipe'}`,
      }),
    ),
    h(
      'div',
      { class: 'd-card' },
      hero,
      h(
        'div',
        { class: 'd-body' },
        h('div', { class: 'd-name', text: recipe.name }),
        h('p', { class: 'd-blurb', text: recipe.description }),
        h(
          'div',
          { class: 'd-stats' },
          statTile(0, 'Difficulty', h(
            'div',
            { class: 'd-chevrons' },
            chevron(level >= 1),
            chevron(level >= 2),
            chevron(level >= 3),
            h('span', { text: `Level ${level}` }),
          )),
          statTile(1, 'Average time', `${recipe.averageMinutes} min`),
          statTile(2, 'Knife work', cuts === 0 ? 'No knife' : `${cuts} cut${cuts === 1 ? '' : 's'}`),
          statTile(3, 'Your best round', best <= 0 ? 'Not cut yet' : rankFor(best).title),
        ),
      ),
    ),
    h(
      'div',
      { class: 'd-side' },
      h(
        'div',
        { class: 'd-ing' },
        h(
          'div',
          { class: 'd-ing__head' },
          h('div', { class: 'd-ing__title', text: 'Ingredients' }),
          h('div', {
            class: `d-ing__count${match.makeable ? '' : ' is-short'}`,
            text: `${match.matched.length} of ${recipe.requires.length} on the counter`,
          }),
        ),
        h('div', { class: 'd-ing__list' }, ...rows),
      ),
      startButton,
      button('d-practise', () => start(true), 'Practise the knife work first'),
    ),
    rail.node,
  );

  const node = h('section', { class: 'screen screen--board dish' }, stage.node);

  return {
    node,
    destroy: () => {
      stage.destroy();
      rail.destroy();
    },
  };
}
