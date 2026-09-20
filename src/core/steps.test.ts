import { describe, expect, it } from 'vitest';
import type { Deficit } from './deficit.js';
import type { Recipe } from './recipe.js';
import { processState, unverifiableSteps } from './steps.js';

const deficit = (over: Partial<Deficit> = {}): Deficit => ({
  kind: 'count-short',
  ingredient: 'cucumber',
  observed: 1,
  required: { min: 2, max: 4 },
  severity: 'major',
  magnitude: 0.5,
  instruction: 'Add 1 more cucumber',
  ...over,
});

const RECIPE: Recipe = {
  id: 'test',
  name: 'Test Salad',
  description: 'A fixture.',
  difficulty: 'easy',
  averageMinutes: 10,
  icon: '🥗',
  tags: [],
  requires: [
    { ingredient: 'cucumber', count: { min: 2, max: 4 } },
    { ingredient: 'tomato', count: { min: 2, max: 4 } },
  ],
  steps: [
    { id: 'cut', instruction: 'Cut the cucumber', verifiable: 'vision', satisfies: ['cucumber'] },
    { id: 'quarter', instruction: 'Quarter the tomato', verifiable: 'vision', satisfies: ['tomato'] },
    { id: 'season', instruction: 'Salt to taste', verifiable: 'cook-confirmed' },
  ],
  minMixRatio: 0.55,
};

describe('processState', () => {
  it('marks a vision step done when nothing is wrong with its ingredients', () => {
    const p = processState(RECIPE, [], new Set());
    expect(p.steps.find((s) => s.step.id === 'cut')?.status).toBe('done');
  });

  it('blocks a step whose ingredient has a deficit, and names the blocker', () => {
    const p = processState(RECIPE, [deficit({ ingredient: 'cucumber' })], new Set());
    const cut = p.steps.find((s) => s.step.id === 'cut');
    expect(cut?.status).toBe('blocked');
    expect(cut?.blockers).toHaveLength(1);
  });

  it('does not block a step on another ingredient’s deficit', () => {
    const p = processState(RECIPE, [deficit({ ingredient: 'tomato' })], new Set());
    expect(p.steps.find((s) => s.step.id === 'cut')?.status).toBe('done');
    expect(p.steps.find((s) => s.step.id === 'quarter')?.status).toBe('blocked');
  });

  describe('steps the camera cannot check', () => {
    it('awaits confirmation rather than assuming done', () => {
      const p = processState(RECIPE, [], new Set());
      expect(p.steps.find((s) => s.step.id === 'season')?.status).toBe('awaiting-confirmation');
    });

    it('completes once confirmed', () => {
      const p = processState(RECIPE, [], new Set(['season']));
      expect(p.steps.find((s) => s.step.id === 'season')?.status).toBe('done');
    });

    it('is never blocked by a board deficit, having no ingredients of its own', () => {
      const p = processState(RECIPE, [deficit({ ingredient: 'cucumber' })], new Set(['season']));
      expect(p.steps.find((s) => s.step.id === 'season')?.status).toBe('done');
    });
  });

  describe('currentStepId', () => {
    it('is the first step that is not done', () => {
      const p = processState(RECIPE, [deficit({ ingredient: 'tomato' })], new Set());
      expect(p.currentStepId).toBe('quarter');
    });

    it('skips past a completed early step to the outstanding later one', () => {
      const p = processState(RECIPE, [], new Set());
      // Both vision steps pass; seasoning is still unconfirmed.
      expect(p.currentStepId).toBe('season');
    });

    it('is null when the whole recipe is complete', () => {
      const p = processState(RECIPE, [], new Set(['season']));
      expect(p.currentStepId).toBeNull();
    });
  });

  it('tracks how many steps are done out of the total', () => {
    const p = processState(RECIPE, [deficit({ ingredient: 'cucumber' })], new Set());
    expect(p.doneCount).toBe(1);
    expect(p.totalCount).toBe(3);
  });

  it('tracks progress regardless of the order the cook worked in', () => {
    // Later step finished, earlier one still outstanding. A cursor would report this wrong.
    const p = processState(RECIPE, [deficit({ ingredient: 'cucumber' })], new Set(['season']));
    expect(p.steps.find((s) => s.step.id === 'quarter')?.status).toBe('done');
    expect(p.steps.find((s) => s.step.id === 'season')?.status).toBe('done');
    expect(p.currentStepId).toBe('cut');
    expect(p.doneCount).toBe(2);
  });
});

describe('unverifiableSteps', () => {
  it('finds a vision step that claims no ingredients and so can never complete', () => {
    const broken: Recipe = {
      ...RECIPE,
      steps: [{ id: 'combine', instruction: 'Combine everything', verifiable: 'vision' }],
    };
    expect(unverifiableSteps(broken).map((s) => s.id)).toEqual(['combine']);
    // And it is kept out of the done count rather than silently passing.
    expect(processState(broken, [], new Set()).doneCount).toBe(0);
    expect(processState(broken, [], new Set()).steps[0]?.status).toBe('unknown');
  });

  it('is empty for a well-formed recipe', () => {
    expect(unverifiableSteps(RECIPE)).toEqual([]);
  });

  it('does not flag cook-confirmed steps, which are meant to have no ingredients', () => {
    const onlyConfirm: Recipe = {
      ...RECIPE,
      steps: [{ id: 'season', instruction: 'Salt to taste', verifiable: 'cook-confirmed' }],
    };
    expect(unverifiableSteps(onlyConfirm)).toEqual([]);
  });
});
