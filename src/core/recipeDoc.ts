/**
 * The wire shape of a recipe, and the narrowing between it and `Recipe`.
 *
 * Everything coming back from the API is input, not state -- exactly like the rows
 * `parseEntries` in leaderboard.ts reads off disk. A dish that fails to narrow is dropped and
 * the rest of the list still renders, because a malformed recipe should cost that recipe and
 * not the recipe book.
 *
 * Pure, so the whole mapping is testable without a server. The server holds the same mapping in
 * `server/src/recipe-map.js`; a test on each side checks it against the real `RECIPES` table,
 * which is what keeps the two honest.
 */

import type { Range } from './ingredients.js';
import type { Difficulty, IngredientRequirement, Recipe, RecipeStep, Verifiability } from './recipe.js';

/** Units the server accepts. Mirrors `UNITS` in `server/src/config.js`. */
export const UNITS = ['g', 'ml', 'tsp', 'tbsp', 'cup', 'piece', 'pinch'] as const;
export type Unit = (typeof UNITS)[number];

export interface DocIngredient {
  readonly name: string;
  readonly quantity: number;
  readonly unit: Unit;
  readonly notes?: string;
}

export interface DocStep {
  readonly order: number;
  readonly text: string;
  readonly durationSec?: number;
  readonly technique?: string;
  readonly stepId?: string;
  readonly verifiable?: Verifiability;
  readonly satisfies?: readonly string[];
}

/**
 * The coach half: the measurable claims a recipe card has no slot for.
 *
 * Optional on the wire, because a recipe typed into a headset has no measurable claims and is
 * still a recipe. Absent, the ingredients themselves become loose count requirements.
 */
export interface DocCoach {
  readonly difficulty: Difficulty;
  readonly icon: string;
  readonly averageMinutes: number;
  readonly minMixRatio: number;
  readonly requires: readonly IngredientRequirement[];
}

/**
 * A recipe on its way to the server, before it has a slug.
 *
 * Separate from `RecipeDoc` rather than making `slug` optional there, so that nothing reading a
 * recipe BACK from the API has to handle the case of a recipe with no slug -- which cannot
 * happen, because the server derives one from the title on insert.
 */
export interface NewRecipeDoc {
  readonly title: string;
  readonly description?: string;
  readonly servings: number;
  readonly tags: readonly string[];
  readonly ingredients: readonly DocIngredient[];
  readonly steps: readonly DocStep[];
  readonly coach?: DocCoach;
}

export interface RecipeDoc {
  readonly id?: string;
  readonly slug: string;
  readonly title: string;
  readonly description?: string | null;
  readonly servings: number;
  readonly tags: readonly string[];
  readonly source?: string;
  readonly ingredients: readonly DocIngredient[];
  readonly steps: readonly DocStep[];
  readonly coach?: DocCoach | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);

function range(v: unknown): Range | undefined {
  if (!isObject(v)) return undefined;
  const min = num(v.min);
  const max = num(v.max);
  if (min === null || max === null) return undefined;
  return { min, max };
}

function requirement(v: unknown): IngredientRequirement | null {
  if (!isObject(v)) return null;
  const ingredient = str(v.ingredient);
  if (ingredient === null) return null;

  const out: { -readonly [K in keyof IngredientRequirement]: IngredientRequirement[K] } = { ingredient };
  const count = range(v.count);
  const areaShare = range(v.areaShare);
  const thicknessMm = range(v.thicknessMm);
  if (count !== undefined) out.count = count;
  if (areaShare !== undefined) out.areaShare = areaShare;
  if (thicknessMm !== undefined) out.thicknessMm = thicknessMm;
  return out;
}

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * A document into the recipe the coach runs on. Null when it is too broken to use.
 *
 * A step whose `verifiable` is absent becomes `cook-confirmed`, never `vision`. Guessing the
 * other way makes a step that can never complete -- nothing in the deficit list is attached to
 * it -- so the cook stares at an instruction they finished two minutes ago and the app looks
 * like the camera has failed.
 */
export function toRecipe(doc: unknown): Recipe | null {
  if (!isObject(doc)) return null;

  const slug = str(doc.slug);
  const title = str(doc.title);
  if (slug === null || title === null) return null;
  if (!Array.isArray(doc.steps) || !Array.isArray(doc.ingredients)) return null;

  const coach = isObject(doc.coach) ? doc.coach : null;

  const steps: RecipeStep[] = [...(doc.steps as unknown[])]
    .filter(isObject)
    .sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))
    .map((raw, index): RecipeStep | null => {
      const text = str(raw.text);
      if (text === null) return null;
      const verifiable: Verifiability = raw.verifiable === 'vision' ? 'vision' : 'cook-confirmed';
      const satisfies = Array.isArray(raw.satisfies)
        ? (raw.satisfies as unknown[]).map(str).filter((s): s is string => s !== null)
        : undefined;
      const step: { -readonly [K in keyof RecipeStep]: RecipeStep[K] } = {
        id: str(raw.stepId) ?? `step-${index + 1}`,
        instruction: text,
        verifiable,
      };
      if (satisfies !== undefined && satisfies.length > 0) step.satisfies = satisfies;
      return step;
    })
    .filter((s): s is RecipeStep => s !== null);

  if (steps.length === 0) return null;

  const requires = Array.isArray(coach?.requires)
    ? (coach.requires as unknown[]).map(requirement).filter((r): r is IngredientRequirement => r !== null)
    : (doc.ingredients as unknown[]).filter(isObject).map((i): IngredientRequirement | null => {
      const name = str(i.name);
      if (name === null) return null;
      const quantity = num(i.quantity) ?? 1;
      return { ingredient: name, count: { min: quantity, max: quantity } };
    }).filter((r): r is IngredientRequirement => r !== null);

  const difficulty = DIFFICULTIES.find((d) => d === coach?.difficulty) ?? 'easy';

  return {
    id: slug,
    name: title,
    description: str(doc.description) ?? '',
    difficulty,
    averageMinutes: num(coach?.averageMinutes) ?? 10,
    icon: str(coach?.icon) ?? '🍽️',
    tags: Array.isArray(doc.tags)
      ? (doc.tags as unknown[]).map(str).filter((t): t is string => t !== null)
      : [],
    requires,
    steps,
    minMixRatio: num(coach?.minMixRatio) ?? 0.55,
  };
}

/** Drops what will not narrow rather than failing the whole response. */
export function toRecipes(raw: unknown): readonly Recipe[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map(toRecipe).filter((r): r is Recipe => r !== null);
}

/**
 * A `Recipe` as a document the API will accept.
 *
 * `requires` carries counts as ranges because the camera counts pieces and cannot weigh
 * anything; a card still has to print a number, so the low end becomes the quantity and the
 * range survives intact under `coach`.
 */
export function toDoc(recipe: Recipe): RecipeDoc {
  return {
    slug: recipe.id,
    title: recipe.name,
    description: recipe.description,
    servings: 2,
    tags: [...recipe.tags],
    ingredients: recipe.requires.map((r) => {
      const quantity = r.count?.min ?? 1;
      const ingredient: { -readonly [K in keyof DocIngredient]: DocIngredient[K] } = {
        name: r.ingredient, quantity, unit: 'piece',
      };
      if (r.count !== undefined && r.count.max !== r.count.min) {
        ingredient.notes = `${r.count.min}-${r.count.max}`;
      }
      return ingredient;
    }),
    steps: recipe.steps.map((step, index) => {
      const out: { -readonly [K in keyof DocStep]: DocStep[K] } = {
        order: index, text: step.instruction, stepId: step.id, verifiable: step.verifiable,
      };
      if (step.satisfies !== undefined && step.satisfies.length > 0) out.satisfies = [...step.satisfies];
      return out;
    }),
    coach: {
      difficulty: recipe.difficulty,
      icon: recipe.icon,
      averageMinutes: recipe.averageMinutes,
      minMixRatio: recipe.minMixRatio,
      requires: recipe.requires,
    },
  };
}
