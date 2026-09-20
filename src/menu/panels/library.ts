/**
 * Screen 2C -- the recipe library.
 *
 * The artboard's filter row was six chips with plausible names: "Cook with what I have",
 * "Under 20 min", "Knife work", "Breakfast", "No knife", "Level 3+". Half of them would return
 * nothing against the recipes that actually exist, and a filter that silently empties the list
 * reads as a broken search rather than as an honest empty result.
 *
 * So the chips are derived. Four are computed from recipe fields that genuinely exist, and the
 * rest are the real tags carried by the recipes in the book, most common first. Every chip is
 * therefore guaranteed to match at least one dish the moment it appears, and the row grows by
 * itself as the book grows.
 *
 * The counter panel stays on screen while you browse, which is the point of the whole layout:
 * you are choosing a dish BECAUSE of what is on the counter, so hiding the counter to show the
 * choice is exactly backwards.
 */

import { rankRecipes, searchRecipes, type RecipeMatch } from '../../core/pantry.js';
import type { Recipe } from '../../core/recipe.js';
import { artFor, GROUP_TINT, groupOf } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { art, button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };

const KNIFE_WORDS = /\b(slice|sliced|chop|chopped|cut|dice|diced|grate|grated|halve|halves)\b/i;

const usesKnife = (recipe: Recipe): boolean =>
  recipe.steps.some((step) => KNIFE_WORDS.test(step.instruction));

interface Filter {
  readonly id: string;
  readonly label: string;
  readonly test: (match: RecipeMatch) => boolean;
}

/** Computed filters first, then whatever tags the book actually carries. */
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
    .filter(([tag, count]) => tag !== 'captaincook4d' && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]): Filter => ({
      id: `tag:${tag}`,
      label: pretty(tag.replace(/-/g, ' ')),
      test: (m) => m.recipe.tags.includes(tag),
    }));

  return [...computed, ...tags];
}

export function libraryPanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const filters = filtersFor(ctx.state.recipes);

  const hits = h('span', { class: 'pill library__hits', text: '' });
  const grid = h('div', { class: 'library__grid scroll' });
  const chips = h('div', { class: 'library__filters' });
  const counterChips = h('div', { class: 'library__counter-chips scroll' });
  const counterNote = h('p', { class: 'note' });

  const search = h('input', {
    class: 'library__search-input',
    attrs: {
      type: 'search',
      placeholder: 'Search the book — say it or type it',
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

    return button(
      `press library__card${match.makeable ? ' is-ready' : ''}`,
      () => openDish(recipe),
      h(
        'div',
        { class: 'library__card-tile', style: { background: match.makeable ? 'var(--leaf)' : 'var(--cream-deep)' } },
        art(artFor(hero, categoryFor(hero)), 4.4, recipe.name),
      ),
      h('span', { class: 'display d-sm library__card-name', text: recipe.name }),
      h(
        'div',
        { class: 'library__card-meta' },
        h('span', { class: 'pill', text: `${recipe.averageMinutes} min` }),
        h('span', { class: 'pill', text: `Level ${level}` }),
      ),
      h('span', {
        class: `library__card-status${match.makeable ? ' is-ready' : ''}`,
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
        const chip = button(
          `btn library__chip${on ? ' is-on' : ''}`,
          () => {
            ctx.setState({ filter: on ? null : filter.id });
            paint();
          },
          filter.label,
        );
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
        ? [h('p', { class: 'note', text: 'Nothing counted yet. The list above is the whole book.' })]
        : items.map((item) =>
            h(
              'div',
              {
                class: 'library__counter-chip',
                style: { background: GROUP_TINT[groupOf(item.category)] },
                // The chip is icon-plus-count, as the artboard drew it. The name lives in the
                // tooltip and in the image's alt text rather than being dropped entirely --
                // a fallback icon is a category, not an identification, so the word matters.
                attrs: { title: `${pretty(item.ingredient)} ×${item.count}` },
              },
              art(artFor(item.ingredient, item.category), 2.1, pretty(item.ingredient)),
              h('span', { class: 'library__counter-count', text: `×${item.count}` }),
            ),
          )),
    );

    counterNote.textContent = items.length === 0
      ? 'Scan your counter and this list starts filtering every card.'
      : 'Every card above is ranked against these.';
  }

  function paint(): void {
    const matches = listed();
    const ready = matches.filter((match) => match.makeable).length;

    hits.textContent = matches.length === 0
      ? 'no matches'
      : `${matches.length} ${matches.length === 1 ? 'dish' : 'dishes'} · ${ready} ready to cook`;

    fill(
      grid,
      ...(matches.length === 0
        ? [
            h(
              'div',
              { class: 'library__empty' },
              h('span', { class: 'display d-md', text: 'Nothing matches' }),
              h('p', {
                class: 'note',
                text: ctx.state.filter === null
                  ? 'Try a shorter search — the book is small so far.'
                  : 'Clear the filter, or search the whole book instead.',
              }),
              ctx.state.filter === null
                ? null
                : button('btn btn--sun', () => {
                    ctx.setState({ filter: null });
                    paint();
                  }, 'Clear the filter'),
            ),
          ]
        : matches.map(recipeCard)),
    );

    paintFilters();
    paintCounter();
  }

  const rail = createRail(
    [
      {
        key: 'A',
        label: 'Open the first dish',
        accent: true,
        onPress: () => {
          const first = listed()[0];
          if (first !== undefined) openDish(first.recipe);
        },
      },
      { key: 'B', label: 'Cook something for me', onPress: () => ctx.go('pick') },
      { key: 'X', label: 'Back to the counter', onPress: () => ctx.go('counter') },
      { key: '☰', label: 'Title', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
  );

  paint();

  const node = h(
    'section',
    { class: 'screen screen--night library' },
    h(
      'header',
      { class: 'screen__head library__head' },
      h('h1', { class: 'display d-lg library__title', text: 'Recipe library' }),
      h('div', { class: 'library__search' }, search),
      hits,
    ),
    h(
      'div',
      { class: 'screen__body library__body' },
      h('div', { class: 'stack grow library__main' }, chips, grid),
      h(
        'div',
        { class: 'card library__counter' },
        h('h2', { class: 'display d-md', text: 'Your counter' }),
        counterNote,
        counterChips,
        h('hr', { class: 'divider' }),
        button('btn btn--sun library__close-btn', () => {
          ctx.setState({ filter: ctx.state.filter === 'close' ? null : 'close' });
          paint();
        }, 'Almost-there list'),
        h('p', {
          class: 'note',
          text: 'Dishes you could finish with three more things from the shop.',
        }),
      ),
    ),
    rail.node,
  );

  return { node, destroy: () => rail.destroy() };
}
