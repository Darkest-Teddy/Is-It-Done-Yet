/**
 * Screen 2B -- the chef's pick, which is what the B button on the counter produces.
 *
 * One dish, large, with the reason it was chosen stated on the card. The artboard called the
 * badge "POPULAR THIS WEEK", which would need a service nobody has built; what it says here is
 * the actual basis for the choice, which is how much of the dish your counter already covers.
 *
 * "Pick another" walks down the ranking rather than reshuffling. A random pick that can serve
 * the same dish twice makes the button feel broken, and walking the list means the second
 * suggestion is genuinely the second-best fit.
 */

import { matchRecipe, rankRecipes, type RecipeMatch } from '../../core/pantry.js';
import { artFor, designRem } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { categoryFor, pretty } from '../catalogue.js';
import { art, button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';

const LEVEL: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 };

export function pickPanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const card = h('div', { class: 'card pick__card' });
  const footer = h('p', { class: 'note pick__footer' });

  /** Every dish, best fit first. Nothing is filtered out: an unmakeable dish is still a
   *  suggestion, it just says what it needs. */
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

  function paint(): void {
    const match = current();

    if (match === null) {
      fill(
        card,
        h('div', { class: 'pick__banner' }, h('span', { class: 'display d-md', text: 'Nothing to suggest yet' })),
        h(
          'div',
          { class: 'pick__body' },
          h('p', {
            class: 'prose',
            text: 'The recipe book is empty, which should not happen — reopen the app, or browse'
              + ' the library to see what loaded.',
          }),
        ),
      );
      footer.textContent = '';
      return;
    }

    const fresh = matchRecipe(ctx.state.pantry, match.recipe);
    const { recipe } = fresh;
    const onCounter = ctx.state.pantry.items.length;
    const level = LEVEL[recipe.difficulty] ?? 2;
    const list = ranked();

    fill(
      card,
      h(
        'div',
        { class: 'pick__banner' },
        h('span', {
          class: 'display d-md',
          text: fresh.makeable ? 'You can cook this right now' : 'Closest thing on your counter',
        }),
        h('span', {
          class: 'pill pill--sun',
          text: `${Math.round(fresh.completeness * 100)}% covered`,
        }),
      ),
      h(
        'div',
        { class: 'pick__body' },
        h(
          'div',
          { class: 'pick__hero' },
          art(artFor(recipe.requires[0]?.ingredient ?? recipe.name, 'unknown'), designRem(170), recipe.name),
        ),
        h(
          'div',
          { class: 'stack grow' },
          h('h1', { class: 'display d-xl', text: recipe.name }),
          h('p', { class: 'prose pick__blurb', text: recipe.description }),
          h(
            'div',
            { class: 'pick__meta' },
            h('span', {
              class: 'pill pill--leaf',
              text: onCounter === 0
                ? `Needs ${recipe.requires.length} ingredients`
                : `Uses ${fresh.matched.length} of the ${onCounter} things you have out`,
            }),
            h('span', { class: 'pill', text: `${recipe.averageMinutes} min` }),
            h('span', { class: 'pill', text: `Cook level ${level}` }),
            h('span', { class: 'pill', text: `${recipe.steps.length} steps` }),
          ),
          h(
            'div',
            { class: 'pick__strip' },
            ...recipe.requires.map((need) =>
              h(
                'div',
                {
                  class: `pick__chip${
                    fresh.missing.some((m) => m.ingredient === need.ingredient) ? ' is-missing' : ''
                  }`,
                  attrs: { title: pretty(need.ingredient) },
                },
                art(artFor(need.ingredient, categoryFor(need.ingredient)), designRem(46), need.ingredient),
              ),
            ),
          ),
          fresh.missing.length === 0
            ? null
            : h('p', {
                class: 'note pick__missing',
                text: `Still needs ${fresh.missing.map((m) => pretty(m.ingredient)).join(', ')}.`,
              }),
        ),
      ),
      h(
        'div',
        { class: 'pick__actions' },
        button('btn btn--hot btn--big pick__go', open, 'See the dish card'),
        button('btn btn--big', another, 'Pick another'),
      ),
    );

    footer.textContent = list.length < 2
      ? 'This is the only dish in the book so far.'
      : `${list.length - 1} more ${list.length === 2 ? 'dish fits' : 'dishes fit'} your counter — `
        + 'press "Pick another" to walk down the list.';
  }

  const rail = createRail(
    [
      { key: 'A', label: 'See the dish card', accent: true, onPress: open },
      { key: 'B', label: 'Pick another dish', onPress: another },
      { key: 'Y', label: 'Back to the counter', onPress: () => ctx.go('counter') },
      { key: '☰', label: 'Title', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
  );

  paint();

  const node = h(
    'section',
    { class: 'screen screen--night pick' },
    h(
      'header',
      { class: 'screen__head pick__head' },
      h('span', { class: 'pill pill--hot pill--display', text: "Chef's pick" }),
      h('span', { class: 'label pick__head-note', text: 'Chosen from what is on your counter' }),
    ),
    h('div', { class: 'screen__body pick__stage' }, card, footer),
    rail.node,
  );

  return { node, destroy: () => rail.destroy() };
}
