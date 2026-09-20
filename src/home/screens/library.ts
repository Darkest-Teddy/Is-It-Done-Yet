/**
 * Screen 3 -- the recipe library, in the language of artboard 2C.
 *
 * The artboard lays this out as a three-column grid of cards with a search field and filter
 * chips above them. The deployed page has neither, and this is one of the places the deployed
 * page wins: a full-width row can carry the dish name, its meta AND its readiness on one line,
 * where a grid card has to drop one of the three. Search and filters are not reproduced
 * because they do not exist in the flow being rebuilt, and drawing a search box that filters
 * nothing would be worse than drawing none.
 *
 * So the list stays a list and what changes is the material of a row: the artboard's inset
 * picture tile, its display-face name, and its tinted meta pills, all on a `.press` slab that
 * lifts on hover and sinks under a press. The deployed page's rows are flat outlined
 * rectangles with a bare emoji and 12px tracking-less meta text.
 *
 * Every dish is listed, makeable or not, and `rankRecipes` puts the makeable ones first. That
 * is the deployed page's behaviour and it is the right one: "you are one tomato away from
 * this" is more useful to a cook than a shorter list, and it is the thing a recipe app can say
 * that a cookbook cannot.
 */

import { rankRecipes, type RecipeMatch } from '../../core/pantry.js';
import { RECIPES } from '../../core/recipe.js';
import { button, fill, h } from '../../menu/dom.js';
import type { Flow, Screen } from '../flow.js';

function row(match: RecipeMatch, onPick: () => void): HTMLButtonElement {
  const { recipe } = match;

  const status = match.makeable
    ? h('span', { class: 'lib-row__status is-ok', text: 'Ready to cook' })
    : h(
        'span',
        { class: 'lib-row__status is-warn' },
        h('span', { text: `Missing ${match.missing.length}` }),
        h('span', { class: 'lib-row__missing', text: match.missing.map((m) => m.icon).join(' ') }),
      );

  return button(
    'press lib-row',
    onPick,
    h('span', { class: 'lib-row__tile', text: recipe.icon }),
    h(
      'span',
      { class: 'lib-row__body' },
      h('span', { class: 'lib-row__name', style: { display: 'block' }, text: recipe.name }),
      h(
        'span',
        { class: 'lib-row__meta' },
        h('span', { class: 'pill pill--sky', text: `${recipe.averageMinutes} min` }),
        h('span', { class: 'pill pill--pink', text: recipe.difficulty }),
      ),
    ),
    status,
  );
}

export function createLibrary(flow: Flow): Screen {
  const count = h('span', { class: 'pill pill--sun', text: '—' });
  const rows = h('div', { class: 'lib-rows' });

  const node = h(
    'section',
    {},
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'head__title', text: 'Recipe library' }),
      count,
      h('span', { class: 'head__spacer' }),
      button('btn', () => flow.show('s-counter'), '← Counter'),
    ),
    rows,
  );

  function render(): void {
    const ranked = rankRecipes(flow.pantry, RECIPES);
    const ready = ranked.filter((m) => m.makeable).length;
    count.textContent = `${ready} of ${ranked.length} ready`;

    fill(rows);
    if (ranked.length === 0) {
      rows.append(h('div', { class: 'lib-empty note', text: 'No recipes are loaded.' }));
      return;
    }

    for (const match of ranked) rows.append(row(match, () => flow.openDish(match)));
  }

  // Re-ranked whenever the counter changes rather than only when the screen opens, so walking
  // back from the dish card after the camera has seen something new does not show a stale list.
  flow.subscribe(render);

  return { node, onShow: render };
}
