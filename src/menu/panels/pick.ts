/**
 * Screen 2B -- the chef's pick, which is what the B button on the counter produces.
 *
 * Built at the artboard's 1440x810. The card is 840 wide, pinned at top 74 and tilted a degree,
 * with a red banner, a 230px hero tile, a 64px Ranchers name and three tinted meta pills --
 * every number from the folder's design document.
 *
 * TWO DEPARTURES.
 *
 * `idy-pop`, the half-second scale-in on the card, is gone with the rest of the animations.
 *
 * The banner's "POPULAR THIS WEEK" needs a popularity service nobody has built. It carries the
 * actual basis for the choice instead: how much of the dish your counter already covers. The
 * artboard's "Uses 9 of your 12 items" pill is real and stays, computed rather than written.
 *
 * "Pick another" walks down the ranking rather than reshuffling. A random pick that can serve
 * the same dish twice makes the button feel broken, and walking the list means the second
 * suggestion is genuinely the second-best fit.
 */

import { matchRecipe, rankRecipes, type RecipeMatch } from '../../core/pantry.js';
import { artFor, heroSize, type HeroIcon } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };

/** Artboard widths: the ingredient strip runs at 46, with ketchup optically smaller at 34. */
const STRIP_ICON = 46;

const img = (src: string, width: number, missing = false): HTMLImageElement =>
  h('img', {
    class: missing ? 'is-missing' : '',
    attrs: { src, alt: '', draggable: 'false', decoding: 'async' },
    style: { width: `${width}px` },
  });

/** The three tinted pills, in the document's order and colours. */
const META_TINT: readonly { background: string; color: string }[] = [
  { background: '#CDE6C7', color: '#2F5A26' },
  { background: '#C4DAEE', color: '#2F4D68' },
  { background: '#F9D3B4', color: '#8A4B21' },
];

export function pickPanel(ctx: AppContext, _params: RouteParams): Panel {
  const stage = createStage({ width: 1440, height: 810 });
  void _params;

  const card = h('div', { class: 'p-card' });
  const footer = h('div', { class: 'p-footer' });

  const ranked = (): readonly RecipeMatch[] => rankRecipes(ctx.state.pantry, ctx.state.recipes);

  function current(): RecipeMatch | null {
    const list = ranked();
    if (list.length === 0) return null;
    return list[ctx.state.pickIndex % list.length] ?? null;
  }

  function open(): void {
    const match = current();
    if (match === null) return;
    ctx.setState({ selectedRecipeId: match.recipe.id });
    ctx.go('dish', { recipeId: match.recipe.id });
  }

  function another(): void {
    const list = ranked();
    if (list.length < 2) return;
    ctx.setState({ pickIndex: (ctx.state.pickIndex + 1) % list.length });
    paint();
  }

  function metaPill(index: number, text: string): HTMLElement {
    const tint = META_TINT[index] ?? META_TINT[0]!;
    return h('div', {
      class: 'p-meta__pill',
      text,
      style: { background: tint.background, color: tint.color },
    });
  }

  function paint(): void {
    const match = current();

    if (match === null) {
      fill(
        card,
        h('div', { class: 'p-banner' },
          h('div', { class: 'p-banner__title', text: 'Nothing to suggest yet' })),
        h('div', { class: 'p-body' },
          h('p', { class: 'p-blurb', text: 'The recipe book is empty. Browse the library to see what loaded.' })),
      );
      footer.textContent = '';
      return;
    }

    const fresh = matchRecipe(ctx.state.pantry, match.recipe);
    const { recipe } = fresh;
    const onCounter = ctx.state.pantry.items.length;
    const level = LEVEL[recipe.difficulty] ?? 2;
    const list = ranked();
    const heroName = recipe.requires[0]?.ingredient ?? recipe.name;

    const alt = button('p-alt', another, 'Pick another');
    alt.disabled = list.length < 2;

    fill(
      card,
      h(
        'div',
        { class: 'p-banner' },
        h('div', {
          class: 'p-banner__title',
          text: fresh.makeable ? 'You can cook this right now' : 'Closest thing on your counter',
        }),
        h('div', {
          class: 'p-banner__flag',
          text: `${Math.round(fresh.completeness * 100)}% covered`,
        }),
      ),
      h(
        'div',
        { class: 'p-body' },
        h('div', { class: 'p-hero' }, img(artFor(heroName, categoryFor(heroName)), 170)),
        h(
          'div',
          { class: 'p-main' },
          h('div', { class: 'p-name', text: recipe.name }),
          h('p', { class: 'p-blurb', text: recipe.description }),
          h(
            'div',
            { class: 'p-meta' },
            metaPill(0, onCounter === 0
              ? `Needs ${recipe.requires.length} ingredients`
              : `Uses ${fresh.matched.length} of your ${onCounter} items`),
            metaPill(1, `${recipe.averageMinutes} min`),
            metaPill(2, `Cook level ${level}`),
          ),
          h(
            'div',
            { class: 'p-strip' },
            ...recipe.requires.map((need) => {
              const missing = fresh.missing.some((m) => m.ingredient === need.ingredient);
              const src = artFor(need.ingredient, categoryFor(need.ingredient));
              // Optical sizing applies only to the hero set; a library icon has no such table.
              const stem = src.split('/').pop()?.replace('.png', '') ?? '';
              const width = heroSize(stem as HeroIcon, STRIP_ICON);
              const node = img(src, width, missing);
              node.title = pretty(need.ingredient);
              return node;
            }),
          ),
        ),
      ),
      h('div', { class: 'p-actions' }, button('p-go', open, 'See the dish card'), alt),
    );

    footer.textContent = list.length < 2
      ? 'This is the only dish in the book so far'
      : `${list.length - 1} more ${list.length === 2 ? 'dish fits' : 'dishes fit'} your counter`
        + ' — press pick another to flip through';
  }

  const rail = createRail(
    [
      { key: 'A', label: 'See the dish card', accent: true, onPress: open },
      { key: 'B', label: 'Pick another dish', onPress: another },
      { key: 'Y', label: 'Back to the counter', onPress: () => ctx.go('counter') },
      { key: '☰', label: 'Menu', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
    'board',
  );

  paint();

  stage.board.classList.add('b2');
  stage.board.append(
    h('div', { class: 'p-floor' }),
    h('div', { class: 'p-rail-trim' }),
    card,
    footer,
    rail.node,
  );

  const node = h('section', { class: 'screen screen--board pick' }, stage.node);

  return {
    node,
    destroy: () => {
      stage.destroy();
      rail.destroy();
    },
  };
}
