/**
 * Screen 2C -- the recipe library.
 *
 * Built at the artboard's 1440x810: the 980px grid at left 40 / top 176 in three columns, the
 * 340px counter rail on the right, the pill search bar across the top.
 *
 * TWO DEPARTURES.
 *
 * The document's search field shows the static word "tomato" and a hint about a pinned
 * keyboard. That is a filled-in state, not a read-only label, so it is a real `<input>` here;
 * Quest Browser raises the system keyboard on focus, which is the pinned keyboard the hint
 * means.
 *
 * The filter row is derived rather than transcribed. The document lists "Cook with what I
 * have", "Under 20 min", "Knife work", "Breakfast", "No knife", "Level 3+"; against the recipes
 * that actually exist, half of those match nothing, and a filter that silently empties the list
 * reads as a broken search rather than an honest empty result. So four are computed from recipe
 * fields that exist and the rest are the real tags the book carries, most common first. Every
 * chip is therefore guaranteed to match at least one dish the moment it appears.
 */

import { rankRecipes, searchRecipes, type RecipeMatch } from '../../core/pantry.js';
import type { Recipe } from '../../core/recipe.js';
import { artFor, GROUP_TINT, groupOf, heroSize, type HeroIcon } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };
const KNIFE_WORDS = /\b(slice|sliced|chop|chopped|cut|dice|diced|grate|grated|halve|halves)\b/i;

/** Artboard widths: card art 88, counter chips 36 with the optical table trimming the rest. */
const CARD_ICON = 88;
const CHIP_ICON = 36;

const usesKnife = (recipe: Recipe): boolean =>
  recipe.steps.some((step) => KNIFE_WORDS.test(step.instruction));

const img = (src: string, width: number): HTMLImageElement =>
  h('img', {
    attrs: { src, alt: '', draggable: 'false', decoding: 'async', loading: 'lazy' },
    style: { width: `${width}px` },
  });

/** Optical sizing only applies to the hero set; a library icon has no such table. */
function iconWidth(src: string, base: number): number {
  const stem = src.split('/').pop()?.replace('.png', '') ?? '';
  return heroSize(stem as HeroIcon, base);
}

interface Filter {
  readonly id: string;
  readonly label: string;
  readonly test: (match: RecipeMatch) => boolean;
}

function filtersFor(recipes: readonly Recipe[]): readonly Filter[] {
  const computed: Filter[] = [
    { id: 'have', label: 'Cook with what I have', test: (m) => m.makeable },
    { id: 'close', label: 'Almost there', test: (m) => !m.makeable && m.missing.length <= 3 },
    { id: 'quick', label: 'Under 20 min', test: (m) => m.recipe.averageMinutes < 20 },
    { id: 'knife', label: 'Knife work', test: (m) => usesKnife(m.recipe) },
    { id: 'no-knife', label: 'No knife', test: (m) => !usesKnife(m.recipe) },
  ];

  const counts = new Map<string, number>();
  for (const recipe of recipes) {
    for (const tag of recipe.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  // `captaincook4d` names the dataset the steps came from, not anything a cook would filter on.
  const tags = [...counts.entries()]
    .filter(([tag]) => tag !== 'captaincook4d')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]): Filter => ({
      id: `tag:${tag}`,
      label: pretty(tag.replace(/-/g, ' ')),
      test: (m) => m.recipe.tags.includes(tag),
    }));

  return [...computed, ...tags];
}

export function libraryPanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const stage = createStage({ width: 1440, height: 810 });
  const filters = filtersFor(ctx.state.recipes);

  const hits = h('span', { class: 'y-search__hits', text: '' });
  const grid = h('div', { class: 'y-grid' });
  const chips = h('div', { class: 'y-filters' });
  const counterChips = h('div', { class: 'y-chips' });
  const counterNote = h('div', { class: 'y-counter__note' });

  const search = h('input', {
    class: 'y-search__input',
    attrs: {
      type: 'search',
      placeholder: 'say it or type it on the pinned keyboard',
      'aria-label': 'Search recipes',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    },
  });
  search.value = ctx.state.query;
  search.addEventListener('input', () => {
    ctx.setState({ query: search.value });
    paint();
  });

  const almost = button('y-more__btn', () => {
    ctx.setState({ filter: ctx.state.filter === 'close' ? null : 'close' });
    paint();
  }, 'Almost-there list');

  function listed(): readonly RecipeMatch[] {
    const found = searchRecipes(ctx.state.recipes, ctx.state.query);
    const ranked = rankRecipes(ctx.state.pantry, found);
    const active = filters.find((filter) => filter.id === ctx.state.filter);
    return active === undefined ? ranked : ranked.filter(active.test);
  }

  function openDish(recipe: Recipe): void {
    ctx.setState({ selectedRecipeId: recipe.id });
    ctx.go('dish', { recipeId: recipe.id });
  }

  function recipeCard(match: RecipeMatch): HTMLElement {
    const { recipe } = match;
    const level = LEVEL[recipe.difficulty] ?? 2;
    const hero = recipe.requires[0]?.ingredient ?? recipe.name;
    const src = artFor(hero, categoryFor(hero));

    return button(
      'y-card',
      () => openDish(recipe),
      h(
        'div',
        {
          class: 'y-card__tile',
          style: { background: match.makeable ? '#CDE6C7' : '#F7E3CC' },
        },
        img(src, iconWidth(src, CARD_ICON)),
      ),
      h('div', { class: 'y-card__name', text: recipe.name }),
      h(
        'div',
        { class: 'y-card__meta' },
        h('span', {
          class: 'y-card__pill',
          text: `${recipe.averageMinutes} min`,
          style: { background: '#C4DAEE', color: '#2F4D68' },
        }),
        h('span', {
          class: 'y-card__pill',
          text: `Level ${level}`,
          style: { background: '#F9D3B4', color: '#8A4B21' },
        }),
      ),
      h('div', {
        class: `y-card__have${match.makeable ? ' is-ready' : ''}`,
        text: match.makeable
          ? 'Everything is on your counter'
          : `Missing ${match.missing.length}: ${match.missing.map((m) => pretty(m.ingredient)).join(', ')}`,
      }),
    );
  }

  function paintFilters(): void {
    fill(
      chips,
      ...filters.map((filter) => {
        const on = ctx.state.filter === filter.id;
        const chip = button(`y-chip${on ? ' is-on' : ''}`, () => {
          ctx.setState({ filter: on ? null : filter.id });
          paint();
        }, filter.label);
        chip.setAttribute('aria-pressed', String(on));
        return chip;
      }),
    );
  }

  function paintCounter(): void {
    const items = ctx.state.pantry.items;

    fill(
      counterChips,
      ...(items.length === 0
        ? [h('div', { class: 'y-counter__note', text: 'Nothing counted yet.' })]
        : items.map((item) => {
            const src = artFor(item.ingredient, item.category);
            return h(
              'div',
              {
                class: 'y-chip-item',
                style: { background: GROUP_TINT[groupOf(item.category)] },
                attrs: { title: `${pretty(item.ingredient)} ×${item.count}` },
              },
              img(src, iconWidth(src, CHIP_ICON)),
              h('span', { text: `×${item.count}` }),
            );
          })),
    );

    counterNote.textContent = items.length === 0
      ? 'Scan your counter and this starts filtering.'
      : 'Filters every card above.';
  }

  function paint(): void {
    const matches = listed();
    hits.textContent = matches.length === 0 ? 'no hits' : `${matches.length} hits`;

    fill(
      grid,
      ...(matches.length === 0
        ? [
            h(
              'div',
              { class: 'y-empty' },
              h('div', { class: 'y-empty__title', text: 'Nothing matches' }),
              h('div', {
                class: 'y-empty__note',
                text: ctx.state.filter === null
                  ? 'Try a shorter search — the book is small so far.'
                  : 'Clear the filter, or search the whole book instead.',
              }),
            ),
          ]
        : matches.map(recipeCard)),
    );

    almost.classList.toggle('is-on', ctx.state.filter === 'close');
    paintFilters();
    paintCounter();
  }

  const rail = createRail(
    [
      {
        key: 'A',
        label: 'Open dish card',
        accent: true,
        onPress: () => {
          const first = listed()[0];
          if (first !== undefined) openDish(first.recipe);
        },
      },
      { key: 'B', label: 'Cook something for me', onPress: () => ctx.go('pick') },
      { key: 'Y', label: 'Back to the counter', onPress: () => ctx.go('counter') },
      { key: '☰', label: 'Menu', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
    'board',
  );

  paint();

  stage.board.classList.add('b2');
  stage.board.append(
    h(
      'div',
      { class: 'y-head' },
      h('div', { class: 'y-title', text: 'Recipe library' }),
      h(
        'div',
        { class: 'y-search' },
        h('div', { class: 'y-search__glass' }),
        search,
        hits,
      ),
    ),
    chips,
    grid,
    h(
      'div',
      { class: 'y-counter' },
      h('div', { class: 'y-counter__title', text: 'Your counter' }),
      counterNote,
      counterChips,
      h(
        'div',
        { class: 'y-more' },
        h('div', { class: 'y-more__title', text: 'Missing a lot?' }),
        h('div', {
          class: 'y-more__note',
          text: 'Show recipes that need three items or fewer from the shop.',
        }),
        almost,
      ),
    ),
    rail.node,
  );

  const node = h('section', { class: 'screen screen--board library' }, stage.node);

  return {
    node,
    destroy: () => {
      stage.destroy();
      rail.destroy();
    },
  };
}
