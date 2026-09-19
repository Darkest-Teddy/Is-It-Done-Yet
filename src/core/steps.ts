/**
 * Where the cook is in the recipe, derived rather than declared.
 *
 * The tracker never advances a counter or listens for a "next" press. It asks, for each step,
 * whether the board currently shows that step's work as done -- which means a cook who does
 * steps out of order, or who goes back and fixes step two after finishing step four, is
 * tracked correctly with no special handling. A stateful cursor would get all of that wrong,
 * and cooking is exactly the domain where people work out of order.
 *
 * A step is linked to its ingredients by `RecipeStep.satisfies`. Once no deficit mentions any
 * of them, the step has demonstrably been done.
 */

import type { Deficit } from './deficit.js';
import type { Recipe, RecipeStep } from './recipe.js';

export type StepStatus =
  /** Work remains, and we can point at what. */
  | 'blocked'
  /** Nothing observable is wrong with this step's ingredients. */
  | 'done'
  /** Cannot be judged from the board -- awaiting the cook's word. */
  | 'awaiting-confirmation'
  /** Vision step with nothing to check against. A recipe-authoring fault; see `unverifiableSteps`. */
  | 'unknown';

export interface StepProgress {
  readonly step: RecipeStep;
  readonly status: StepStatus;
  /** The deficits holding this step open. Empty unless blocked. */
  readonly blockers: readonly Deficit[];
}

export interface Process {
  readonly steps: readonly StepProgress[];
  /** First step not yet done. Null when the whole recipe is complete. */
  readonly currentStepId: string | null;
  readonly doneCount: number;
  readonly totalCount: number;
}

function statusOf(
  step: RecipeStep,
  deficits: readonly Deficit[],
  confirmed: ReadonlySet<string>,
): { status: StepStatus; blockers: readonly Deficit[] } {
  if (step.verifiable === 'cook-confirmed') {
    return {
      status: confirmed.has(step.id) ? 'done' : 'awaiting-confirmation',
      blockers: [],
    };
  }

  const owned = step.satisfies ?? [];
  // A vision step that claims no ingredients can never be shown to be done. Saying 'unknown'
  // keeps it out of the done count without silently inventing a pass, and `unverifiableSteps`
  // surfaces it as the authoring mistake it is.
  if (owned.length === 0) return { status: 'unknown', blockers: [] };

  const blockers = deficits.filter(
    (d) => d.ingredient !== null && owned.includes(d.ingredient),
  );
  return { status: blockers.length === 0 ? 'done' : 'blocked', blockers };
}

export function processState(
  recipe: Recipe,
  deficits: readonly Deficit[],
  confirmed: ReadonlySet<string> = new Set(),
): Process {
  const steps = recipe.steps.map((step) => {
    const { status, blockers } = statusOf(step, deficits, confirmed);
    return { step, status, blockers };
  });

  return {
    steps,
    currentStepId: steps.find((s) => s.status !== 'done')?.step.id ?? null,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalCount: steps.length,
  };
}

/**
 * Vision steps that claim no ingredients, and so can never complete.
 *
 * Worth calling at startup on any recipe Gemini produced from a photo: the model will happily
 * emit a step like "combine everything" with nothing attached, and the result is a process bar
 * that sticks at 80% forever with no way for the cook to find out why.
 */
export function unverifiableSteps(recipe: Recipe): readonly RecipeStep[] {
  return recipe.steps.filter(
    (s) => s.verifiable === 'vision' && (s.satisfies ?? []).length === 0,
  );
}
