import { describe, expect, it } from 'vitest';
import {
  addItem,
  adjustCount,
  byCategory,
  confirmAll,
  confirmItem,
  isReviewed,
  pantryFromScan,
  removeItem,
  countInPantry,
  iconFor,
  matchRecipe,
  NEEDS_CONFIRMATION_BELOW,
  rankRecipes,
  recommend,
  searchRecipes,
  unconfirmed,
  type Pantry,
  type PantryItem,
} from './pantry.js';
import type { Recipe } from './recipe.js';

const item = (over: Partial<PantryItem> = {}): PantryItem => ({
  ingredient: 'tomato',
  count: 6,
  category: 'vegetable',
  confidence: 0.95,
  confirmed: false,
  ...over,
});

const pantry = (items: PantryItem[]): Pantry => ({ items, scannedAtMs: 0 });

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  id: 'r',
  name: 'Test Dish',
  description: 'A dish for testing.',
  difficulty: 'easy',
  averageMinutes: 10,
  icon: '🥗',
  tags: [],
  requires: [{ ingredient: 'tomato', count: { min: 4, max: 8 } }],
  steps: [],
  minMixRatio: 0.55,
  ...over,
});

describe('countInPantry', () => {
  it('sums duplicate lines for the same ingredient', () => {
    const p = pantry([item({ count: 3 }), item({ count: 4 })]);
    expect(countInPantry(p, 'tomato')).toBe(7);
  });

  it('is case-insensitive, since scan output casing is not guaranteed', () => {
    expect(countInPantry(pantry([item({ ingredient: 'Red Onion', count: 2 })]), 'red onion')).toBe(2);
  });

  it('is zero for something absent', () => {
    expect(countInPantry(pantry([item()]), 'carrot')).toBe(0);
  });
});

describe('unconfirmed', () => {
  it('surfaces low-confidence items the cook has not checked', () => {
    const p = pantry([item({ confidence: 0.4 }), item({ ingredient: 'carrot', confidence: 0.99 })]);
    expect(unconfirmed(p).map((i) => i.ingredient)).toEqual(['tomato']);
  });

  it('stays quiet once the cook has confirmed, however low the model scored it', () => {
    const p = pantry([item({ confidence: 0.1, confirmed: true })]);
    expect(unconfirmed(p)).toEqual([]);
  });

  it('does not question a confident item', () => {
    const p = pantry([item({ confidence: NEEDS_CONFIRMATION_BELOW + 0.01 })]);
    expect(unconfirmed(p)).toEqual([]);
  });
});

describe('byCategory', () => {
  it('groups and omits empty categories', () => {
    const p = pantry([
      item({ ingredient: 'tomato', category: 'vegetable' }),
      item({ ingredient: 'orange', category: 'fruit' }),
    ]);
    expect(byCategory(p).map((g) => g.category)).toEqual(['vegetable', 'fruit']);
  });
});

describe('iconFor', () => {
  it('finds a known ingredient regardless of case', () => {
    expect(iconFor('Cucumber')).toBe('🥒');
  });

  it('falls back rather than returning empty and breaking layout', () => {
    expect(iconFor('quinoa')).toBe('🍽️');
  });
});

describe('matchRecipe', () => {
  it('marks a recipe makeable when the counter covers it', () => {
    const m = matchRecipe(pantry([item({ count: 6 })]), recipe());
    expect(m.makeable).toBe(true);
    expect(m.missing).toEqual([]);
    expect(m.completeness).toBe(1);
  });

  it('reports what is short, with how many are needed and held', () => {
    const m = matchRecipe(pantry([item({ count: 1 })]), recipe());
    expect(m.makeable).toBe(false);
    expect(m.missing[0]).toMatchObject({ ingredient: 'tomato', needed: 4, have: 1 });
  });

  it('carries an icon on every line for the UI', () => {
    const m = matchRecipe(pantry([]), recipe());
    expect(m.missing[0]?.icon).toBe('🍅');
  });

  it('reports partial completeness across several ingredients', () => {
    const r = recipe({
      requires: [
        { ingredient: 'tomato', count: { min: 2, max: 4 } },
        { ingredient: 'cucumber', count: { min: 2, max: 4 } },
      ],
    });
    const m = matchRecipe(pantry([item({ count: 3 })]), r);
    expect(m.completeness).toBeCloseTo(0.5);
  });
});

describe('rankRecipes', () => {
  const makeable = recipe({ id: 'have', name: 'Have It', averageMinutes: 30 });
  const nearMiss = recipe({
    id: 'near', name: 'Nearly',
    requires: [
      { ingredient: 'tomato', count: { min: 2, max: 4 } },
      { ingredient: 'carrot', count: { min: 2, max: 4 } },
    ],
  });

  it('puts makeable dishes ahead of near misses', () => {
    const ranked = rankRecipes(pantry([item({ count: 6 })]), [nearMiss, makeable]);
    expect(ranked[0]?.recipe.id).toBe('have');
  });

  it('keeps near misses in the list rather than hiding them', () => {
    const ranked = rankRecipes(pantry([item({ count: 6 })]), [nearMiss, makeable]);
    expect(ranked.map((m) => m.recipe.id)).toContain('near');
  });

  it('breaks ties toward the quicker dish', () => {
    const slow = recipe({ id: 'slow', averageMinutes: 40 });
    const fast = recipe({ id: 'fast', averageMinutes: 5 });
    const ranked = rankRecipes(pantry([item({ count: 6 })]), [slow, fast]);
    expect(ranked[0]?.recipe.id).toBe('fast');
  });
});

describe('recommend', () => {
  it('never suggests a dish the counter cannot make', () => {
    const impossible = recipe({ requires: [{ ingredient: 'truffle', count: { min: 1, max: 2 } }] });
    expect(recommend(pantry([item({ count: 6 })]), [impossible])).toBeNull();
  });

  it('returns null on an empty counter rather than guessing', () => {
    expect(recommend(pantry([]), [recipe()])).toBeNull();
  });

  it('prefers the more ambitious dish among those that are makeable', () => {
    const easy = recipe({ id: 'easy', difficulty: 'easy' });
    const hard = recipe({ id: 'hard', difficulty: 'hard' });
    expect(recommend(pantry([item({ count: 6 })]), [easy, hard])?.recipe.id).toBe('hard');
  });
});

describe('searchRecipes', () => {
  const greek = recipe({ id: 'g', name: 'Greek Salad', tags: ['mediterranean'] });
  const slaw = recipe({
    id: 's', name: 'Carrot Slaw', tags: ['citrus'],
    requires: [{ ingredient: 'carrot', count: { min: 1, max: 2 } }],
  });
  const all = [greek, slaw];

  it('returns everything for an empty query', () => {
    expect(searchRecipes(all, '   ')).toHaveLength(2);
  });

  it('matches on name', () => {
    expect(searchRecipes(all, 'greek').map((r) => r.id)).toEqual(['g']);
  });

  it('matches on tag', () => {
    expect(searchRecipes(all, 'citrus').map((r) => r.id)).toEqual(['s']);
  });

  it('matches on an ingredient the recipe needs', () => {
    expect(searchRecipes(all, 'carrot').map((r) => r.id)).toEqual(['s']);
  });

  it('narrows with extra terms rather than widening', () => {
    expect(searchRecipes(all, 'greek carrot')).toEqual([]);
  });

  it('ignores case', () => {
    expect(searchRecipes(all, 'GREEK').map((r) => r.id)).toEqual(['g']);
  });
});

describe('pantryFromScan', () => {
  const raw = (over = {}) => ({
    ingredient: 'Tomato', count: 4, category: 'vegetable', confidence: 0.9, ...over,
  });

  it('normalises names to lowercase so requirements can match', () => {
    expect(pantryFromScan([raw()], 0).items[0]?.ingredient).toBe('tomato');
  });

  it('arrives unconfirmed -- a scan is a proposal, not a fact', () => {
    expect(pantryFromScan([raw()], 0).items[0]?.confirmed).toBe(false);
  });

  it('rounds and floors counts, so a hedged 2.5 does not become a fractional tomato', () => {
    expect(pantryFromScan([raw({ count: 2.5 })], 0).items[0]?.count).toBe(3);
    expect(pantryFromScan([raw({ count: 0 })], 0).items[0]?.count).toBe(1);
  });

  it('clamps confidence into 0..1', () => {
    expect(pantryFromScan([raw({ confidence: 4 })], 0).items[0]?.confidence).toBe(1);
    expect(pantryFromScan([raw({ confidence: -1 })], 0).items[0]?.confidence).toBe(0);
  });

  it('falls back to unknown for a category it does not recognise', () => {
    expect(pantryFromScan([raw({ category: 'nonsense' })], 0).items[0]?.category).toBe('unknown');
  });

  it('drops blank names rather than creating an unmatchable line', () => {
    expect(pantryFromScan([raw({ ingredient: '  ' })], 0).items).toEqual([]);
  });

  describe('merging duplicates', () => {
    it('sums the counts', () => {
      const p = pantryFromScan([raw({ count: 2 }), raw({ count: 3 })], 0);
      expect(p.items).toHaveLength(1);
      expect(p.items[0]?.count).toBe(5);
    });

    it('inherits the LOWEST confidence, because merging is where a scan goes wrong', () => {
      const p = pantryFromScan([raw({ confidence: 0.95 }), raw({ confidence: 0.3 })], 0);
      expect(p.items[0]?.confidence).toBeCloseTo(0.3);
    });
  });
});

describe('confirmation', () => {
  const scanned = () => pantryFromScan(
    [{ ingredient: 'tomato', count: 4, category: 'vegetable', confidence: 0.4 }], 0);

  it('confirmItem makes one line certain', () => {
    const p = confirmItem(scanned(), 'tomato');
    expect(p.items[0]).toMatchObject({ confirmed: true, confidence: 1 });
  });

  it('confirmAll clears the whole review queue', () => {
    expect(isReviewed(scanned())).toBe(false);
    expect(isReviewed(confirmAll(scanned()))).toBe(true);
  });

  it('adjustCount also confirms, because editing a number is checking it', () => {
    const p = adjustCount(scanned(), 'tomato', 1);
    expect(p.items[0]).toMatchObject({ count: 5, confirmed: true });
  });

  it('adjusting to zero removes the line rather than leaving a zero-count ghost', () => {
    expect(adjustCount(scanned(), 'tomato', -4).items).toEqual([]);
  });

  it('removeItem deletes a hallucinated line', () => {
    expect(removeItem(scanned(), 'tomato').items).toEqual([]);
  });

  it('addItem adds what the scan missed, already confirmed', () => {
    const p = addItem(scanned(), 'Basil', 2, 'herb');
    expect(p.items.find((i) => i.ingredient === 'basil')).toMatchObject({
      count: 2, confirmed: true, category: 'herb',
    });
  });

  it('addItem on an existing ingredient tops it up instead of duplicating', () => {
    const p = addItem(scanned(), 'tomato', 2);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.count).toBe(6);
  });

  it('addItem ignores blank names and non-positive counts', () => {
    expect(addItem(scanned(), '  ', 3).items).toHaveLength(1);
    expect(addItem(scanned(), 'basil', 0).items).toHaveLength(1);
  });
});
