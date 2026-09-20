/**
 * Screen 4 -- the dish card, in the language of artboard 2D.
 *
 * The closest mapping of the four. The deployed page already has the right content in the
 * right two columns; what it does not have is the artboard's hierarchy, and that hierarchy is
 * most of why 2D reads as a poster rather than as a detail view:
 *
 *   - a soft-yellow HERO BAND recessed into the top of the card, with the dish's mark in it
 *     and a red flag clipped over its bottom corner;
 *   - the dish name at 70px Ranchers on a 0.84 leading, in red -- four times the size the
 *     deployed page sets it, and the single largest piece of type on any screen but the title;
 *   - three stat tiles TINTED by what they measure (pink difficulty, sky time, leaf steps) and
 *     inset so they read as pressed into the card face, against the deployed page's three
 *     identical grey boxes;
 *   - a right column where the ingredient list is leaf-green for what is on the counter and
 *     the artboard's dashed "optional" treatment for what is not, so the two states differ in
 *     fill AND in border style and survive being read in greyscale;
 *   - and one saturated red slab for the only action on the screen.
 *
 * The ingredient rows use real pictures via `artFor` rather than the deployed page's emoji.
 * The recipe's own mark stays an emoji in the hero band, because that is what the recipe data
 * carries and `src/core/recipe.ts` defends the choice; `artFor` is for ingredients, and this
 * is the screen with the most of them.
 *
 * THE ONE PLACE THE COPY DELIBERATELY LEAVES THE DEPLOYED PAGE. That page's only action says
 * "Start cooking", and pressing it writes "step tracking is not wired up yet" into the note
 * beside it. It is honest on the second press and a promise the app cannot keep on the first,
 * which is the wrong way round: the label is what a visitor reads and commits to, the note is
 * what they read after being let down. There is no guided cook in this flow to start -- the
 * cutting screen lives on `app.html` and has no idea which dish was picked -- so the button is
 * labelled for what it can actually do, which turns out to be worth more than the dead end it
 * replaces. `recipe.steps` is real, cited data (`src/core/recipe.ts`), and every step already
 * carries `verifiable`, so each line can say whether the camera can check it or whether the
 * cook has to. That last part is the honest version of the claim the deployed button was
 * making, and it fits in the same slab.
 */

import { matchRecipe, type RecipeMatch } from '../../core/pantry.js';
import { artFor } from '../../menu/art.js';
import { button, fill, h } from '../../menu/dom.js';
import type { Flow, Screen } from '../flow.js';

export function createDish(flow: Flow): Screen {
  const tag = h('span', { class: 'pill', text: '—' });

  const heroMark = h('span', { text: '' });
  const heroFlag = h('span', { class: 'd-hero__flag', text: '—' });
  const name = h('h2', { class: 'd-name', text: '—' });
  const blurb = h('p', { class: 'prose d-blurb', text: '' });

  const statTime = h('div', { class: 'd-stat__value', text: '—' });
  const statLevel = h('div', { class: 'd-stat__value', text: '—' });
  const statSteps = h('div', { class: 'd-stat__value', text: '—' });

  const stat = (tone: string, label: string, value: HTMLElement): HTMLElement =>
    h('div', { class: `d-stat d-stat--${tone}` }, h('div', { class: 'd-stat__label', text: label }), value);

  const main = h(
    'div',
    { class: 'card d-card' },
    h('div', { class: 'd-hero' }, heroMark, heroFlag),
    h(
      'div',
      { class: 'd-body' },
      name,
      blurb,
      h(
        'div',
        { class: 'd-stats' },
        stat('sky', 'Average time', statTime),
        stat('pink', 'Difficulty', statLevel),
        stat('leaf', 'Steps', statSteps),
      ),
    ),
  );

  const ingCount = h('span', { class: 'd-ing__count', text: '—' });
  const ingList = h('div', { class: 'd-ing__list scroll' });

  const ingCard = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'd-ing__head' },
      h('span', { class: 'd-ing__title', text: 'Ingredients' }),
      ingCount,
    ),
    ingList,
  );

  const startNote = h('p', { class: 'd-next__note', text: '—' });
  const startTitle = h('span', { class: 'd-start__title', text: 'Show the steps' });

  const startBtn = button(
    'press press--red d-start',
    () => toggleSteps(),
    h('span', { class: 'd-next__label', text: 'Method' }),
    startNote,
    startTitle,
  );

  const stepList = h('div', { class: 'd-steps' });
  const stepCard = h(
    'div',
    { class: 'card d-steps__card' },
    h(
      'div',
      { class: 'd-ing__head' },
      h('span', { class: 'd-ing__title', text: 'Method' }),
      h('span', { class: 'd-ing__count', text: 'from the recipe' }),
    ),
    stepList,
  );
  stepCard.hidden = true;

  const node = h(
    'section',
    {},
    h(
      'div',
      { class: 'head' },
      button('btn', () => flow.show('s-library'), '← Library'),
      h('span', { class: 'head__spacer' }),
      tag,
    ),
    h('div', { class: 'dish' }, main, h('div', { class: 'd-side' }, ingCard, startBtn, stepCard)),
  );

  let showing: RecipeMatch | null = null;
  let stepsOpen = false;

  /**
   * Reveal the recipe's own steps.
   *
   * Every line is `recipe.steps`, unedited, and each one is tagged with what `verifiable`
   * already says about it: a `vision` step is something the counter camera can confirm, a
   * `cook-confirmed` step is one only the cook can. Saying which is which is the difference
   * between a method list and a claim that the app is watching you follow it.
   */
  function toggleSteps(): void {
    if (showing === null) return;
    stepsOpen = !stepsOpen;
    stepCard.hidden = !stepsOpen;
    startTitle.textContent = stepsOpen ? 'Hide the steps' : 'Show the steps';
    if (stepsOpen) stepCard.scrollIntoView({ block: 'nearest' });
  }

  function renderSteps(match: RecipeMatch): void {
    fill(stepList);
    match.recipe.steps.forEach((step, index) => {
      stepList.append(
        h(
          'div',
          { class: 'd-step' },
          h('span', { class: 'd-step__n', text: String(index + 1) }),
          h(
            'span',
            { class: 'd-step__body' },
            h('span', { class: 'd-step__text', style: { display: 'block' }, text: step.instruction }),
            h('span', {
              class: step.verifiable === 'vision' ? 'd-step__tag is-seen' : 'd-step__tag',
              text: step.verifiable === 'vision' ? 'camera can check this' : 'you confirm this one',
            }),
          ),
        ),
      );
    });
  }

  function render(): void {
    // Re-matched against the CURRENT counter rather than reusing the match that opened this
    // screen. The camera keeps running behind the library, so a card opened two screens ago
    // can easily be describing a counter that has since changed.
    const base = showing ?? flow.selected;
    if (base === null) return;

    const match = matchRecipe(flow.pantry, base.recipe);
    showing = match;

    const { recipe } = match;

    tag.textContent = recipe.tags.join(' · ');
    heroMark.textContent = recipe.icon;
    heroFlag.textContent = recipe.difficulty;
    name.textContent = recipe.name;
    blurb.textContent = recipe.description;

    statTime.textContent = `${recipe.averageMinutes} min`;
    statLevel.textContent = recipe.difficulty;
    statSteps.textContent = String(recipe.steps.length);

    ingCount.textContent = `${match.matched.length} of ${recipe.requires.length} on the counter`;
    ingCount.classList.toggle('is-short', !match.makeable);

    fill(ingList);
    for (const line of recipe.requires) {
      const have = match.matched.find((m) => m.ingredient === line.ingredient);

      ingList.append(
        h(
          'div',
          { class: have === undefined ? 'd-row is-missing' : 'd-row' },
          h('img', {
            class: 'd-row__icon',
            attrs: { src: artFor(line.ingredient), alt: '', decoding: 'async', loading: 'lazy' },
          }),
          h('span', { class: 'd-row__name', text: line.ingredient }),
          h('span', { class: 'd-row__have', text: have === undefined ? 'not seen' : `${have.have} ✓` }),
        ),
      );
    }

    // Never disabled. Readiness is what the count and the note above report; the method is
    // readable either way, and greying out the only action on the screen because a tomato is
    // missing would withhold the part of the recipe that does not depend on the counter.
    startTitle.textContent = stepsOpen ? 'Hide the steps' : 'Show the steps';
    startNote.textContent = match.makeable
      ? `${recipe.steps.length} steps, about ${recipe.averageMinutes} minutes. Everything is on the counter.`
      : `${recipe.steps.length} steps, about ${recipe.averageMinutes} minutes. ` +
        `Still need: ${match.missing.map((m) => m.ingredient).join(', ')}.`;

    renderSteps(match);
  }

  return {
    node,
    onShow: () => {
      // A fresh pick replaces whatever was showing; a return to this screen keeps it.
      if (flow.selected !== null && flow.selected.recipe.id !== showing?.recipe.id) {
        showing = flow.selected;
        // A new dish collapses the method. Leaving it open would scroll the visitor into the
        // middle of a different recipe's steps without their having asked for them.
        stepsOpen = false;
        stepCard.hidden = true;
      }
      render();
    },
  };
}
