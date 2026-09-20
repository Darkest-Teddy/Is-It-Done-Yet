/**
 * The offline path, which is the one that has to work in front of a judge.
 *
 * Vitest runs with no `VITE_API_URL`, which is exactly the unconfigured case: every call must
 * resolve to a failure value, promptly, without touching the network and without throwing.
 * Master spec rule #9 -- a timeout and a fallback on every network call -- is only true if the
 * absent-server case is the one that is actually exercised.
 */

import { describe, expect, it } from 'vitest';

import { RECIPES } from '../core/recipe.js';
import {
  API_BASE, configured, createRecipe, fetchLeaderboard, fetchRecipe, fetchRecipes, health,
  submitScore,
} from './api.js';
import { toDoc } from '../core/recipeDoc.js';

describe('with no VITE_API_URL', () => {
  it('reports itself unconfigured', () => {
    expect(API_BASE).toBeNull();
    expect(configured).toBe(false);
  });

  it('fails every call rather than throwing', async () => {
    const calls = [
      fetchRecipes(),
      fetchRecipes('cucumber'),
      fetchRecipe('cucumber-raita'),
      createRecipe(toDoc(RECIPES[0]!)),
      submitScore({ name: 'Ada', score: 50 }),
      fetchLeaderboard(),
    ];

    for (const result of await Promise.all(calls)) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.offline).toBe(true);
    }
  });

  it('reports the health check as false, not as an exception', async () => {
    await expect(health()).resolves.toBe(false);
  });
});
