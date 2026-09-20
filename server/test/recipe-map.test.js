/**
 * The generated recipe file against the app's own table.
 *
 * This is the guard that makes "one source of truth" a fact rather than an intention. Editing
 * `src/core/recipe.ts` without re-running `npm run recipes:export` fails here, which is the
 * only moment anyone would notice before a seeded recipe silently disagrees with the coach.
 */

import { describe, expect, it } from 'vitest';

import { RECIPES as DISHES } from '../../src/core/recipe.ts';
import { RECIPES as TICKETS } from '../../src/core/recipes.ts';
import generated from '../src/builtin-recipes.json' with { type: 'json' };
import { toAppRecipe, toRecipeDoc, toTicketDoc } from '../src/recipe-map.js';
import { builtinRecipes } from '../src/seed.js';

describe('builtin-recipes.json', () => {
  it('matches what the exporter would write today', () => {
    const expected = [
      ...DISHES.map((r) => toRecipeDoc(r, 'captaincook4d')),
      ...TICKETS.map(toTicketDoc),
    ];
    expect(generated).toEqual(expected);
  });

  it('validates against the schema the API enforces', () => {
    expect(builtinRecipes()).toHaveLength(generated.length);
  });

  it('covers every dish and every cutting ticket', () => {
    const slugs = new Set(generated.map((r) => r.slug));
    for (const dish of DISHES) expect(slugs.has(dish.id)).toBe(true);
    for (const ticket of TICKETS) expect(slugs.has(`cut-${ticket.id}`)).toBe(true);
  });
});

describe('round trip', () => {
  it.each(DISHES.map((r) => [r.id, r]))('restores %s unchanged', (_id, recipe) => {
    const restored = toAppRecipe(toRecipeDoc(recipe, 'captaincook4d'));
    expect(restored).toEqual({
      id: recipe.id,
      name: recipe.name,
      description: recipe.description,
      difficulty: recipe.difficulty,
      averageMinutes: recipe.averageMinutes,
      icon: recipe.icon,
      tags: [...recipe.tags],
      requires: recipe.requires.map((r) => ({ ...r })),
      steps: recipe.steps.map((s) => (s.satisfies === undefined || s.satisfies.length === 0
        ? { id: s.id, instruction: s.instruction, verifiable: s.verifiable }
        : { id: s.id, instruction: s.instruction, verifiable: s.verifiable, satisfies: [...s.satisfies] })),
      minMixRatio: recipe.minMixRatio,
    });
  });

  it('defaults a step with no stated verifiability to cook-confirmed, never vision', () => {
    const restored = toAppRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [], ingredients: [],
      steps: [{ order: 0, text: 'Do the thing' }],
    });
    expect(restored.steps[0].verifiable).toBe('cook-confirmed');
  });
});
