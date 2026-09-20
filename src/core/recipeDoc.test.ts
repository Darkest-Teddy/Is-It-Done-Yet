import { describe, expect, it } from 'vitest';

import { RECIPES } from './recipe.js';
import { toDoc, toRecipe, toRecipes } from './recipeDoc.js';

const raita = RECIPES.find((r) => r.id === 'cucumber-raita')!;

describe('round trip', () => {
  it.each(RECIPES.map((r) => [r.id, r] as const))('restores %s unchanged', (_id, recipe) => {
    expect(toRecipe(toDoc(recipe))).toEqual(recipe);
  });
});

describe('toRecipe', () => {
  it('rejects anything that is not an object', () => {
    expect(toRecipe(null)).toBeNull();
    expect(toRecipe('recipe')).toBeNull();
    expect(toRecipe([])).toBeNull();
  });

  it('rejects a document with no slug or no title', () => {
    const doc = toDoc(raita);
    expect(toRecipe({ ...doc, slug: '' })).toBeNull();
    expect(toRecipe({ ...doc, title: undefined })).toBeNull();
  });

  it('rejects a document whose steps all fail to narrow', () => {
    expect(toRecipe({ ...toDoc(raita), steps: [{ order: 0 }, { order: 1, text: 7 }] })).toBeNull();
  });

  it('keeps the usable steps and drops the rest', () => {
    const doc = toDoc(raita);
    const result = toRecipe({ ...doc, steps: [{ order: 0, text: 'Chop' }, { order: 1 }] });
    expect(result?.steps).toHaveLength(1);
  });

  it('sorts steps by order regardless of array position', () => {
    const result = toRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [], ingredients: [],
      steps: [{ order: 2, text: 'Serve' }, { order: 0, text: 'Slice' }, { order: 1, text: 'Salt' }],
    });
    expect(result?.steps.map((s) => s.instruction)).toEqual(['Slice', 'Salt', 'Serve']);
  });

  it('treats an unstated verifiability as cook-confirmed, never vision', () => {
    const result = toRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [], ingredients: [],
      steps: [{ order: 0, text: 'Season to taste' }],
    });
    expect(result?.steps[0]?.verifiable).toBe('cook-confirmed');
  });

  it('synthesises step ids when the document carries none', () => {
    const result = toRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [], ingredients: [],
      steps: [{ order: 0, text: 'One' }, { order: 1, text: 'Two' }],
    });
    expect(result?.steps.map((s) => s.id)).toEqual(['step-1', 'step-2']);
  });

  it('falls back to the ingredient list when there is no coach block', () => {
    const result = toRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [],
      ingredients: [{ name: 'tomato', quantity: 3, unit: 'piece' }],
      steps: [{ order: 0, text: 'Slice' }],
    });
    expect(result?.requires).toEqual([{ ingredient: 'tomato', count: { min: 3, max: 3 } }]);
  });

  it('keeps a thickness range from the coach block', () => {
    const result = toRecipe({
      slug: 'x', title: 'X', servings: 1, tags: [], ingredients: [],
      steps: [{ order: 0, text: 'Cut' }],
      coach: {
        difficulty: 'hard', icon: '🔪', averageMinutes: 3, minMixRatio: 0,
        requires: [{ ingredient: 'cucumber', count: { min: 8, max: 8 }, thicknessMm: { min: 1.5, max: 3.5 } }],
      },
    });
    expect(result?.requires[0]?.thicknessMm).toEqual({ min: 1.5, max: 3.5 });
    expect(result?.difficulty).toBe('hard');
  });

  it('ignores a difficulty outside the enum rather than trusting it', () => {
    const doc = toDoc(raita);
    const result = toRecipe({ ...doc, coach: { ...doc.coach, difficulty: 'impossible' } });
    expect(result?.difficulty).toBe('easy');
  });

  it('drops a NaN or infinite number instead of carrying it into scoring', () => {
    const doc = toDoc(raita);
    const result = toRecipe({
      ...doc,
      coach: { ...doc.coach, averageMinutes: Number.NaN, minMixRatio: Number.POSITIVE_INFINITY },
    });
    expect(result?.averageMinutes).toBe(10);
    expect(result?.minMixRatio).toBe(0.55);
  });
});

describe('toRecipes', () => {
  it('returns empty for anything that is not an array', () => {
    expect(toRecipes(null)).toEqual([]);
    expect(toRecipes({ recipes: [] })).toEqual([]);
  });

  it('keeps the good rows and drops the broken ones', () => {
    expect(toRecipes([toDoc(raita), null, { slug: 'x' }])).toHaveLength(1);
  });
});
