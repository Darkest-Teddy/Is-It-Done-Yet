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

/** `#RRGGBB`, uppercased on the way in so two spellings of one colour cannot both be stored. */
const hex = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'expected #RRGGBB').transform((v) => v.toUpperCase());

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
  /**
   * Does this step involve heat, or a blade?
   *
   * Load-bearing, not metadata. The headset reads these to decide when to collapse its HUD
   * into SAFE mode -- a small, calm, motionless pill -- because somebody is about to reach
   * toward a hot pan or pick up a knife.
   *
   * They were missing from this schema, which is `.strict()`, so two things were true at once:
   * no recipe could ever carry them, meaning safe mode could never fire; and a scan draft,
   * which does carry them, was rejected with a 400 on its way back in. Both silent.
   */
  hot: z.boolean().default(false),
  knife: z.boolean().default(false),
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

/**
 * Cover-colour hints, so a recipe card can be drawn with no image download.
 *
 * Three hex strings and nothing else. The app builds the whole card procedurally from these
 * plus the tags -- which is why there is no `imageUrl` field anywhere in this API. An image URL
 * is a network call on the critical path of a scrolling carousel, on venue wifi, in a headset.
 */
export const coverSchema = z.object({
  tint: hex,
  ink: hex,
  accent: hex,
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
  cover: coverSchema.optional(),
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
  /**
   * Issued by POST /api/sessions/start. Required: a score with no session is a score with no
   * evidence that a run happened at all. See src/sessions.js for exactly how much this is and
   * is not worth.
   */
  sessionId: z.string().trim().min(8).max(64),
  sessionToken: z.string().trim().min(8).max(200),
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

/* ------------------------------------------------------------------------- *
 * Coach: what the vision model is allowed to have said.
 *
 * Not `.strict()`, and that is the one deliberate exception in this file. An LLM that adds a
 * `"notes"` field it was not asked for is being chatty, not malicious, and rejecting the whole
 * answer over it means the coach goes silent for a harmless reason. Unknown keys are dropped
 * by zod's default stripping; the fields that matter are still exact.
 * ------------------------------------------------------------------------- */

export const OBSERVATION_STATUS = ['ok', 'warn', 'bad', 'unknown'];

export const observationSchema = z.object({
  item: trimmed(120),
  status: z.enum(OBSERVATION_STATUS),
  evidence: z.string().trim().max(200).default(''),
  /** Coerced: models write 0.8 and "0.8" about equally often, and both mean the same thing. */
  confidence: z.coerce.number().finite().min(0).max(1).default(0.5),
});

export const coachAnalysisSchema = z.object({
  observations: z.array(observationSchema).max(24).default([]),
  coachLine: z.string().trim().max(160).nullish().transform((v) => (v == null || v === '' ? null : v)),
  unsure: z.coerce.boolean().default(false),
});

/** A base64 data URI holding a JPEG or PNG. The only image form this API accepts. */
export const imageDataUriSchema = z.string()
  .regex(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'expected a base64 image data URI')
  .max(2_000_000);

export const analyzeInputSchema = z.object({
  image: imageDataUriSchema,
  recipeTitle: trimmed(120),
  stepText: trimmed(400),
  /**
   * The rubric the deterministic scorer will score against, sent verbatim so the model's
   * observations can be matched back to it by exact string. Capped at 12: past that the model
   * starts merging items, and a merged observation scores against nothing.
   */
  rubricItems: z.array(trimmed(120)).min(1).max(12),
  hot: z.boolean().default(false),
  knife: z.boolean().default(false),
}).strict();

export const scanInputSchema = z.object({
  image: imageDataUriSchema,
}).strict();

export const ingredientCheckInputSchema = z.object({
  image: imageDataUriSchema,
  wanted: z.array(trimmed(60)).min(1).max(24),
}).strict();

export const scannedStepSchema = z.object({
  order: z.coerce.number().int().min(0).max(200),
  text: trimmed(400),
  durationSec: z.coerce.number().int().min(0).max(86_400).nullish(),
  technique: z.string().trim().max(60).nullish(),
  hot: z.coerce.boolean().default(false),
  knife: z.coerce.boolean().default(false),
});

export const scannedRecipeSchema = z.object({
  title: trimmed(80),
  description: z.string().trim().max(600).nullish(),
  servings: z.coerce.number().int().min(1).max(64).default(2),
  tags: z.array(trimmed(30)).max(12).default([]),
  ingredients: z.array(z.object({
    name: trimmed(60),
    quantity: z.coerce.number().finite().nonnegative().max(10_000).default(1),
    unit: z.enum(UNITS).catch('piece'),
    notes: z.string().trim().max(200).nullish(),
  })).min(1).max(40),
  steps: z.array(scannedStepSchema).min(1).max(60),
  confidence: z.coerce.number().finite().min(0).max(1).default(0.5),
  /** What the model admits it could not read. Shown in the confirm form as a warning. */
  unreadable: z.array(z.string().trim().max(120)).max(20).default([]),
});

export const ingredientCheckSchema = z.object({
  found: z.array(z.object({
    name: trimmed(60),
    present: z.coerce.boolean(),
    confidence: z.coerce.number().finite().min(0).max(1).default(0.5),
    evidence: z.string().trim().max(120).default(''),
  })).max(24).default([]),
  unsure: z.coerce.boolean().default(false),
});

/* ------------------------------------------------------------------------- *
 * Sessions: the anti-replay token, and the recorded run behind the replay screen.
 * ------------------------------------------------------------------------- */

export const sessionStartSchema = z.object({
  recipeSlug: z.string().trim().max(64).optional(),
  /** Practice runs are recorded and never reach the global board. */
  practice: z.boolean().default(false),
}).strict();

/** One thing that happened, at a millisecond offset from the session's start. */
export const sessionEventSchema = z.object({
  atMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  kind: trimmed(40),
  stepIndex: z.number().int().min(0).max(200).optional(),
  label: z.string().trim().max(120).optional(),
  /** Signed: points are docked as well as awarded, and a replay must show both. */
  points: z.number().finite().min(-10_000).max(10_000).optional(),
  status: z.enum(OBSERVATION_STATUS).optional(),
}).strict();

/**
 * A replay thumbnail. 25KB each, 20 of them, which is the budget the spec sets and the reason
 * the sessions route gets its own 2MB body parser instead of the 10kb global one.
 */
export const sessionThumbSchema = z.object({
  atMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  jpeg: z.string().max(34_000).regex(/^[A-Za-z0-9+/=]+$/, 'expected bare base64, no data: prefix'),
}).strict();

export const sessionRecordSchema = z.object({
  sessionId: z.string().trim().min(8).max(64),
  sessionToken: z.string().trim().min(8).max(200),
  recipeSlug: z.string().trim().max(64).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  score: z.number().finite().min(0).max(100).optional(),
  events: z.array(sessionEventSchema).max(400).default([]),
  coachResults: z.array(z.object({
    atMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
    observations: z.array(observationSchema).max(24).default([]),
    coachLine: z.string().trim().max(160).nullable().default(null),
    unsure: z.boolean().default(false),
  })).max(120).default([]),
  thumbnails: z.array(sessionThumbSchema).max(20).default([]),
}).strict();
