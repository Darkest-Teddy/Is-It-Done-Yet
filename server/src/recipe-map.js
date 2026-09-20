/**
 * The one translation between the app's `Recipe` and the stored document.
 *
 * Both directions live here, side by side, so that a field added to one and forgotten in the
 * other is visible in a diff rather than discovered when a recipe comes back from the API
 * missing its steps.
 *
 * The document shape is the generic one a recipe card needs -- title, ingredients with a
 * quantity and a unit, ordered steps. Everything the *coach* needs that a card has no slot for
 * (the measurable claims in `requires`, per-step verifiability) rides along under `coach` and
 * on the step. That is what makes the round trip lossless without inventing a second recipe
 * model, which rule 8 of the master spec exists to prevent.
 */

/**
 * `requires` carries counts as ranges, not amounts, because the camera counts pieces and cannot
 * weigh anything. A card still has to show a number, so the low end of the range becomes the
 * quantity and the exact range is preserved under `coach.requires` for the diff to use.
 */
function ingredientFrom(requirement) {
  const quantity = requirement.count?.min ?? 1;
  const ingredient = { name: requirement.ingredient, quantity, unit: 'piece' };
  if (requirement.count !== undefined && requirement.count.max !== requirement.count.min) {
    ingredient.notes = `${requirement.count.min}-${requirement.count.max}`;
  }
  return ingredient;
}

export function toRecipeDoc(recipe, source = 'builtin') {
  return {
    slug: recipe.id,
    title: recipe.name,
    description: recipe.description,
    // Not in the app's model. The dataset dishes are recorded as one-or-two portions and the
    // field has to be a number, so it is stated here rather than defaulted invisibly downstream.
    servings: 2,
    tags: [...recipe.tags],
    source,
    ingredients: recipe.requires.map(ingredientFrom),
    steps: recipe.steps.map((step, index) => {
      const out = { order: index, text: step.instruction, stepId: step.id, verifiable: step.verifiable };
      if (step.satisfies !== undefined && step.satisfies.length > 0) out.satisfies = [...step.satisfies];
      return out;
    }),
    coach: {
      difficulty: recipe.difficulty,
      icon: recipe.icon,
      averageMinutes: recipe.averageMinutes,
      minMixRatio: recipe.minMixRatio,
      requires: recipe.requires.map((r) => {
        const out = { ingredient: r.ingredient };
        if (r.count !== undefined) out.count = { min: r.count.min, max: r.count.max };
        if (r.areaShare !== undefined) out.areaShare = { min: r.areaShare.min, max: r.areaShare.max };
        if (r.thicknessMm !== undefined) out.thicknessMm = { min: r.thicknessMm.min, max: r.thicknessMm.max };
        return out;
      }),
    },
  };
}

/**
 * Document back to the app's `Recipe`.
 *
 * Kept in sync with `src/core/recipeDoc.ts` on the client, which does the same job in
 * TypeScript against untrusted input. This copy exists for the server's own tests: a mapping
 * only one side can exercise is a mapping nobody checks.
 */
export function toAppRecipe(doc) {
  const coach = doc.coach ?? null;
  return {
    id: doc.slug,
    name: doc.title,
    description: doc.description ?? '',
    difficulty: coach?.difficulty ?? 'easy',
    averageMinutes: coach?.averageMinutes ?? 10,
    icon: coach?.icon ?? '🍽️',
    tags: doc.tags ?? [],
    requires: coach?.requires ?? doc.ingredients.map((i) => ({
      ingredient: i.name,
      count: { min: i.quantity, max: i.quantity },
    })),
    steps: [...doc.steps].sort((a, b) => a.order - b.order).map((step, index) => {
      const out = {
        id: step.stepId ?? `step-${index + 1}`,
        instruction: step.text,
        // A step with no stated verifiability is `cook-confirmed`, never `vision`. Guessing the
        // other way produces a step that can never complete, because nothing in the deficit list
        // is attached to it, and the cook is stuck staring at an instruction they already did.
        verifiable: step.verifiable ?? 'cook-confirmed',
      };
      if (step.satisfies !== undefined) out.satisfies = [...step.satisfies];
      return out;
    }),
    minMixRatio: coach?.minMixRatio ?? 0.55,
  };
}

/**
 * A cutting ticket from `src/core/recipes.ts` as a recipe document.
 *
 * Seeded alongside the dishes so that `recipeSlug` on a score points at something the recipe
 * endpoints can actually return. A leaderboard row that names a ticket nobody can look up is a
 * dead reference, and the fix -- a second collection of tickets -- would be the parallel model
 * this file exists to avoid.
 *
 * The thickness target survives as a `thicknessMm` range on the coach requirement, which is the
 * same field the diff already uses for "slices too thick", so nothing new has to understand it.
 */
export function toTicketDoc(ticket) {
  return {
    slug: `cut-${ticket.id}`,
    title: ticket.name,
    description: ticket.note,
    servings: 1,
    tags: ['cutting', 'ticket', ticket.ingredient],
    source: 'builtin',
    ingredients: [{ name: ticket.ingredient, quantity: 1, unit: 'piece' }],
    steps: [{
      order: 0,
      stepId: 'cut',
      text: `Cut ${ticket.sliceCount} slices of ${ticket.ingredient} at ${ticket.targetThicknessMm}mm, within ${ticket.toleranceMm}mm.`,
      technique: 'knife',
      verifiable: 'vision',
      satisfies: [ticket.ingredient],
    }],
    coach: {
      difficulty: ticket.toleranceMm <= 1 ? 'hard' : ticket.toleranceMm <= 2 ? 'medium' : 'easy',
      icon: '\u{1F52A}',
      averageMinutes: 3,
      minMixRatio: 0,
      requires: [{
        ingredient: ticket.ingredient,
        count: { min: ticket.sliceCount, max: ticket.sliceCount },
        thicknessMm: {
          min: ticket.targetThicknessMm - ticket.toleranceMm,
          max: ticket.targetThicknessMm + ticket.toleranceMm,
        },
      }],
    },
  };
}
