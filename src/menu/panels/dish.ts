/**
 * Screen 2D -- the dish card.
 *
 * The last screen before somebody picks up a knife, so it answers exactly the questions that
 * matter at that moment: what am I making, how long, how hard, and have I got the things.
 *
 * Two changes from the artboard, both for the same reason. It showed "+180 XP", and there is no
 * XP system, so that is gone rather than printed as decoration. It showed "Your best: NOT
 * COOKED", which implies per-dish history that is not stored; what is stored is the best
 * competitive round this device has posted, so that is what the tile says and it says which
 * thing it is measuring.
 *
 * Start is blocked when an ingredient is missing, and blocked visibly rather than hidden. A
 * control that vanishes leaves you wondering what you did wrong; one that is still there and
 * says "missing 2 ingredients" has already answered the question.
 */

import { matchRecipe } from '../../core/pantry.js';
import { rankFor } from '../../core/rank.js';
import type { Recipe } from '../../core/recipe.js';
import { artFor, designRem } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { art, button, h, svg } from '../dom.js';
import { createRail } from '../rail.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };

const KNIFE_WORDS = /\b(slice|sliced|chop|chopped|cut|dice|diced|grate|grated|halve|halves)\b/i;

/** The artboard's chevron, filled for each level earned and pale for the rest. */
const chevron = (filled: boolean): SVGElement =>
  svg(
    `<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">`
    + `<path d="M4 19 L15 8 L19 4 L21 6 L17 10 L6 21 Z" fill="${filled ? '#F5230E' : '#E4CBB2'}"`
    + ` stroke="#46101A" stroke-width="2.4" stroke-linejoin="round"/></svg>`,
  );

function statTile(label: string, value: Node | string): HTMLElement {
  return h(
    'div',
    { class: 'dish__stat' },
    h('span', { class: 'label', text: label, style: { color: 'var(--brown)' } }),
    typeof value === 'string'
      ? h('span', { class: 'display d-sm', text: value })
      : h('div', { class: 'dish__stat-value' }, value),
  );
}

export function dishPanel(ctx: AppContext, params: RouteParams): Panel {
  const id = params.recipeId ?? ctx.state.selectedRecipeId;
  const recipe: Recipe | null = ctx.state.recipes.find((r) => r.id === id) ?? null;

  if (recipe === null) {
    const rail = createRail(
      [{ key: 'Y', label: 'Back to the library', onPress: () => ctx.go('library') }],
      () => ctx.go('library'),
    );
    return {
      node: h(
        'section',
        { class: 'screen screen--night dish' },
        h('div', { class: 'screen__head' }),
        h(
          'div',
          { class: 'screen__body dish__missing' },
          h('div', { class: 'card' },
            h('h1', { class: 'display d-lg', text: 'That dish is not in the book' }),
            h('p', { class: 'note', text: 'It may have been renamed. Pick another from the library.' }),
            button('btn btn--sun', () => ctx.go('library'), 'Back to the library')),
        ),
        rail.node,
      ),
      destroy: () => rail.destroy(),
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

  const startButton = button(
    `press press--red dish__start${match.makeable ? '' : ' is-blocked'}`,
    () => start(false),
    h('span', {
      class: 'display d-lg',
      text: match.makeable ? 'Start cooking' : `Missing ${match.missing.length}`,
    }),
    h(
      'div',
      { class: 'dish__start-hint' },
      h('span', { class: 'pill pill--sun', text: 'Enter' }),
      h('span', {
        class: 'label',
        text: match.makeable ? 'or point and press' : 'add them on the counter first',
      }),
    ),
  );
  startButton.disabled = !match.makeable;

  const ingredientRows = recipe.requires.map((need) => {
    const line = match.matched.find((m) => m.ingredient === need.ingredient)
      ?? match.missing.find((m) => m.ingredient === need.ingredient);
    const have = line?.have ?? 0;
    const needed = line?.needed ?? need.count?.min ?? 1;
    const ok = line !== undefined && line.satisfied;

    return h(
      'div',
      { class: `dish__ing${ok ? ' is-ok' : ''}` },
      art(artFor(need.ingredient, categoryFor(need.ingredient)), designRem(34), need.ingredient),
      h('span', { class: 'dish__ing-name grow truncate', text: pretty(need.ingredient) }),
      h('span', {
        class: `dish__ing-amount${ok ? ' is-ok' : ''}`,
        text: ok ? `${have} ✓` : `need ${Math.max(1, needed - have)} more`,
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
      { key: 'X', label: 'Practise the knife work', onPress: () => start(true) },
      { key: 'Y', label: 'Back', onPress: () => ctx.back() },
      { key: '☰', label: 'Title', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
  );

  const node = h(
    'section',
    { class: 'screen screen--night dish' },
    h(
      'header',
      { class: 'screen__head dish__head' },
      button('btn dish__back', () => ctx.back(), '← Back'),
      h('span', {
        class: 'label dish__index',
        text: `Dish ${index} of ${ctx.state.recipes.length} · ${recipe.tags[0] ?? 'recipe'}`,
      }),
      h('span', {
        class: `pill ${match.makeable ? 'pill--leaf' : 'pill--sun'}`,
        text: match.makeable
          ? 'Everything is on your counter'
          : `${match.missing.length} still missing`,
      }),
    ),
    h(
      'div',
      { class: 'screen__body dish__body' },
      h(
        'div',
        { class: 'card dish__hero' },
        h(
          'div',
          { class: 'dish__hero-art' },
          // The artboard's cluster steps down in size -- 180, 104, 96 -- so the first
          // ingredient reads as the hero and the other two as supporting.
          ...recipe.requires.slice(0, 3).map((need, i) =>
            h(
              'div',
              { class: `dish__hero-chip dish__hero-chip--${i}`, style: { zIndex: String(3 - i) } },
              art(
                artFor(need.ingredient, categoryFor(need.ingredient)),
                designRem([180, 104, 96][i] ?? 96),
                need.ingredient,
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'stack grow' },
          h('h1', { class: 'display d-xl', text: recipe.name }),
          h('p', { class: 'prose dish__blurb', text: recipe.description }),
          h(
            'div',
            { class: 'dish__stats' },
            statTile(
              'Difficulty',
              h(
                'div',
                { class: 'dish__chevrons' },
                chevron(level >= 1),
                chevron(level >= 2),
                chevron(level >= 3),
                h('span', { class: 'label dish__level', text: `Level ${level}` }),
              ),
            ),
            statTile('Average time', `${recipe.averageMinutes} min`),
            statTile('Knife work', cuts === 0 ? 'No knife' : `${cuts} cutting step${cuts === 1 ? '' : 's'}`),
            statTile('Your best round', best <= 0 ? 'Not cut yet' : rankFor(best).title),
          ),
        ),
      ),
      h(
        'div',
        { class: 'dish__lower' },
        h(
          'div',
          { class: 'card dish__ingredients' },
          h(
            'div',
            { class: 'row dish__ing-head' },
            h('h2', { class: 'display d-md grow', text: 'Ingredients' }),
            h('span', {
              class: 'label',
              text: `${match.matched.length} of ${recipe.requires.length} on the counter`,
              style: { color: 'var(--brown)' },
            }),
          ),
          h('div', { class: 'dish__ing-list scroll' }, ...ingredientRows),
        ),
        h(
          'div',
          { class: 'stack dish__start-col' },
          startButton,
          button('btn btn--big', () => start(true), 'Practise the knife work first'),
          h('p', {
            class: 'note dish__start-note',
            text: 'Practice runs are not timed and never post to the board.',
          }),
        ),
      ),
    ),
    rail.node,
  );

  return { node, destroy: () => rail.destroy() };
}
