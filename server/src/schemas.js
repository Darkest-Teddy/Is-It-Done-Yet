/**
 * Request shapes, as zod schemas.
 *
 * `.strict()` everywhere, which is the point of having them: an unknown field is rejected
 * rather than ignored. A silently dropped field is the failure mode that costs an afternoon --
 * the client swears it sent `thicknessMm`, the server swears it never arrived, and both are
 * telling the truth.
 */

import { z } from 'zod';

import { SOURCES, UNITS } from './config.js';

const trimmed = (max) => z.string().trim().min(1).max(max);

/** A measurable claim, mirroring `IngredientRequirement` in src/core/recipe.ts. */
const range = z.object({
  min: z.number().finite(),
  max: z.number().finite(),
}).strict().refine((r) => r.max >= r.min, { message: 'max must be >= min' });

export const ingredientSchema = z.object({
  name: trimmed(60),
  quantity: z.number().finite().nonnegative().max(10_000),
  unit: z.enum(UNITS),
  notes: z.string().trim().max(200).optional(),
}).strict();

export const stepSchema = z.object({
  order: z.number().int().min(0).max(200),
  text: trimmed(400),
  durationSec: z.number().int().min(0).max(86_400).optional(),
  technique: z.string().trim().max(60).optional(),
  /**
   * The coach half of a step. Carried here rather than in a parallel collection because
   * `src/core/recipe.ts` treats a step's id and its verifiability as part of the step itself:
   * split them apart and a recipe that round-trips through this API comes back unable to tick
   * itself off.
   */
  stepId: z.string().trim().max(60).optional(),
  verifiable: z.enum(['vision', 'cook-confirmed']).optional(),
  satisfies: z.array(trimmed(60)).max(20).optional(),
}).strict();

/**
 * The fields the coach needs that a plain recipe card has no room for.
 *
 * Optional, so a recipe typed in the headset is still a valid recipe. Present on every seeded
 * recipe, so the CaptainCook4D dishes survive the round trip intact.
 */
export const coachSchema = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard']),
  icon: z.string().trim().max(8),
  averageMinutes: z.number().finite().min(0).max(600),
  minMixRatio: z.number().finite().min(0).max(1),
  requires: z.array(z.object({
    ingredient: trimmed(60),
    count: range.optional(),
    areaShare: range.optional(),
    thicknessMm: range.optional(),
  }).strict()).max(40),
}).strict();

export const recipeInputSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase words joined by hyphens').max(64).optional(),
  title: trimmed(80),
  description: z.string().trim().max(600).optional(),
  servings: z.number().int().min(1).max(64).default(2),
  tags: z.array(trimmed(30)).max(12).default([]),
  ingredients: z.array(ingredientSchema).min(1).max(40),
  steps: z.array(stepSchema).min(1).max(60),
  coach: coachSchema.optional(),
}).strict();

/** What `npm run seed` is allowed to write. Source is trusted here and nowhere else. */
export const seedRecipeSchema = recipeInputSchema.extend({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  source: z.enum(SOURCES),
}).strict();

export const scoreInputSchema = z.object({
  name: z.string().max(200),
  /**
   * 0..100 with one decimal. The app's own score is 0..1, and converting at the boundary
   * rather than storing the raw fraction means the board reads as a percentage to a bystander
   * without anyone having to remember a scale factor.
   */
  score: z.number().finite().min(0).max(100),
  /**
   * A small bounded bag: the millimetre numbers behind the score. Bounded because this is the
   * one field a client can shape freely, and an unbounded object on a public endpoint is a
   * storage bill and a rendering hazard.
   */
  metrics: z.record(
    z.string().trim().min(1).max(32),
    z.union([z.number().finite(), z.string().trim().max(80), z.boolean()]),
  ).refine((m) => Object.keys(m).length <= 12, { message: 'at most 12 metrics' }).optional(),
  recipeSlug: z.string().trim().max(64).optional(),
}).strict();

export const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();

export const recipeQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();
