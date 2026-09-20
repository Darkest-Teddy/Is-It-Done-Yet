/**
 * The HTTP surface: two collections, six endpoints, and the rules that keep a public board
 * from becoming a liability.
 *
 * Built as a factory taking an already-connected database rather than reaching for a module
 * global, because that is what lets the integration tests run the real app against a real
 * (in-memory) Mongo. A test that stubs the database tests the stub.
 *
 * Express 5 forwards a rejected promise from a handler to the error middleware on its own, so
 * there is no async wrapper here. On Express 4 there would have to be, and its absence would
 * be the bug: the request would hang instead of erroring.
 */

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ObjectId } from 'mongodb';

import { analyze, checkIngredients, scanRecipe } from './coach.js';
import { coverFor } from './cover.js';
import { createLlm } from './llm.js';
import {
  analyzeInputSchema,
  ingredientCheckInputSchema,
  leaderboardQuerySchema,
  recipeInputSchema,
  recipeQuerySchema,
  scanInputSchema,
  scoreInputSchema,
  sessionRecordSchema,
  sessionStartSchema,
} from './schemas.js';
import { normalizeName, slugify } from './sanitize.js';
import { UNITS } from './config.js';
import { checkPlausible, newSessionId, requiredSecondsFor, signSession, verifySession } from './sessions.js';

/** One error shape for everything. A client that can parse one failure can parse all of them. */
function fail(res, status, code, message, details) {
  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

/** zod's tree is verbose; the client only needs the path and the sentence. */
const issuesOf = (error) => error.issues.slice(0, 10).map((i) => ({
  path: i.path.join('.'),
  message: i.message,
}));

/** Rounds to the one decimal place the board displays, so stored and shown never disagree. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The public projection.
 *
 * Written as an allowlist rather than by deleting fields, so a column added later is invisible
 * until somebody decides it should be public. There is nothing to redact today -- no IP is ever
 * stored -- and that stays true only if this stays an allowlist.
 */
const publicEntry = (doc, rank) => ({
  rank,
  name: doc.name,
  score: doc.score,
  createdAt: doc.createdAt.toISOString(),
});

const publicRecipe = (doc) => ({
  id: doc._id.toString(),
  slug: doc.slug,
  title: doc.title,
  description: doc.description ?? null,
  servings: doc.servings,
  tags: doc.tags,
  source: doc.source,
  ingredients: doc.ingredients,
  steps: doc.steps,
  coach: doc.coach ?? null,
  /**
   * Always present, never null. A stored cover wins; otherwise one is derived from the slug
   * and tags, so a recipe seeded before covers existed still draws a card rather than a hole.
   */
  cover: doc.cover ?? coverFor(doc),
  createdAt: doc.createdAt.toISOString(),
});

/**
 * Decoded size of a base64 data URI, without decoding it.
 *
 * `Buffer.from(uri, 'base64')` to measure a 2MB string allocates 2MB to throw it away, once per
 * request, on the endpoint that gets one every three seconds per headset.
 */
function base64Bytes(dataUri) {
  const payload = dataUri.slice(dataUri.indexOf(',') + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

export function createApp({ db, config, llm = createLlm(config) }) {
  const app = express();

  // Off by default. Express trusts nothing unless told, and a proxy hop that is not accounted
  // for makes every request look like it came from the proxy -- which is one rate-limit bucket
  // for the entire venue.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // This serves JSON to a WebXR page on another origin and never serves HTML of its own, so the
  // header set aimed at documents is noise. CSP in particular would apply to nothing.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  /**
   * An empty ALLOWED_ORIGIN means "any origin", which is right for local development and wrong
   * for a deployment -- so the deployment docs set it and this default never reaches one
   * silently. Configured origins are matched exactly; a request with no Origin header at all
   * (curl, a health check, a server-to-server call) is allowed, because CORS is a browser
   * mechanism and refusing those buys nothing.
   */
  const allowed = config.allowedOrigins;
  app.use(cors({
    origin(origin, callback) {
      if (origin === undefined || allowed.length === 0) return callback(null, true);
      return callback(null, allowed.includes(origin.replace(/\/+$/, '')));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    maxAge: 600,
  }));

  /**
   * Two body limits, and the order matters.
   *
   * body-parser marks a request it has parsed and every later parser skips it, so mounting the
   * generous limits FIRST on their own paths and the strict one after gives each route the
   * ceiling it needs. Registering the 10kb one first would cap everything at 10kb and the
   * coach would 413 on every frame.
   *
   * 2mb for sessions: twenty 25KB JPEGs is 500KB, and base64 inflates by a third.
   * 1mb for the coach: one 60KB frame with room for a bad camera day.
   */
  app.use('/api/sessions', express.json({ limit: '2mb' }));
  app.use('/api/coach', express.json({ limit: '1mb' }));
  app.use('/api/recipes/scan', express.json({ limit: '1mb' }));
  app.use('/api/ingredients', express.json({ limit: '1mb' }));

  // 10kb for everything else. A recipe is a page of text; anything larger is a mistake or an
  // attack, and either way the answer is the same.
  app.use(express.json({ limit: '10kb' }));

  const writeLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMaxWrites,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // In-memory store, which is deliberate: the counters vanish on restart and no address is
    // ever written to disk. A shared store would mean persisting who visited.
    handler: (_req, res) => fail(res, 429, 'rate_limited', 'too many writes, slow down'),
  });

  const recipes = db.collection('recipes');
  const scores = db.collection('scores');
  const sessions = db.collection('sessions');

  /**
   * A separate, tighter bucket for the endpoints that cost money.
   *
   * The write limiter is deliberately generous because a venue NATs hundreds of people behind
   * one address. An LLM call is not free, so it gets its own window -- still generous enough
   * for a headset posting every three seconds (20/minute), with headroom for two of them.
   */
  const coachLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMaxCoachCalls,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => fail(res, 429, 'rate_limited', 'too many coach calls, slow down'),
  });

  /** Shared by all three vision routes: validate, then bound the decoded image. */
  const guardImage = (res, dataUri) => {
    const bytes = base64Bytes(dataUri);
    if (bytes > config.llm.maxImageBytes) {
      fail(res, 413, 'image_too_large', `image is ${bytes} bytes, limit is ${config.llm.maxImageBytes}`);
      return false;
    }
    return true;
  };

  app.get('/api/health', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({
      ok: true,
      db: db.databaseName,
      time: new Date().toISOString(),
      // Models and whether a key is present. Never the key, never the base URL -- a base URL
      // can carry credentials in its userinfo and this endpoint is public.
      coach: llm.describe(),
    });
  });

  app.get('/api/recipes', async (req, res) => {
    const parsed = recipeQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, 'invalid_query', 'bad query parameters', issuesOf(parsed.error));
    const { q, tag, limit } = parsed.data;

    const base = tag === undefined ? {} : { tags: tag };

    if (q === undefined || q === '') {
      const docs = await recipes.find(base).sort({ title: 1 }).limit(limit).toArray();
      return res.json({ recipes: docs.map(publicRecipe), total: docs.length });
    }

    /**
     * Two queries, merged -- NOT one `$or`.
     *
     * Mongo refuses to plan a `$text` clause inside an `$or` beside clauses its indexes do not
     * cover ("Failed to produce a solution for TEXT under OR"), and it refuses at query time
     * with a 500, not at index time. Both halves are wanted: `$text` matches whole words across
     * title and tags with the index and gives a relevance score, while the regex is what makes
     * a search bar feel alive, because a cook typing "toma" has not finished the word yet.
     */
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [byText, bySubstring] = await Promise.all([
      recipes.find({ ...base, $text: { $search: q } }, { projection: { relevance: { $meta: 'textScore' } } })
        .sort({ relevance: { $meta: 'textScore' } })
        .limit(limit)
        .toArray()
        // A text index can be missing on a database somebody pointed us at by hand. Degrading to
        // substring-only beats a 500 on the one screen a judge is looking at.
        .catch(() => []),
      recipes.find({
        ...base,
        $or: [
          { title: { $regex: escaped, $options: 'i' } },
          { 'ingredients.name': { $regex: escaped, $options: 'i' } },
          { tags: { $regex: escaped, $options: 'i' } },
        ],
      }).sort({ title: 1 }).limit(limit).toArray(),
    ]);

    const seen = new Set();
    const merged = [];
    for (const doc of [...byText, ...bySubstring]) {
      if (seen.has(doc.slug)) continue;
      seen.add(doc.slug);
      merged.push(doc);
      if (merged.length === limit) break;
    }

    res.json({ recipes: merged.map(publicRecipe), total: merged.length });
  });

  app.get('/api/recipes/:idOrSlug', async (req, res) => {
    const key = req.params.idOrSlug;
    const or = [{ slug: key }];
    if (ObjectId.isValid(key) && String(new ObjectId(key)) === key) or.push({ _id: new ObjectId(key) });

    const doc = await recipes.findOne({ $or: or });
    if (doc === null) return fail(res, 404, 'not_found', 'no recipe with that id or slug');
    res.json(publicRecipe(doc));
  });

  app.post('/api/recipes', writeLimiter, async (req, res) => {
    if (config.writeKey !== null && req.get('x-api-key') !== config.writeKey) {
      return fail(res, 401, 'unauthorized', 'x-api-key required to create recipes');
    }

    const parsed = recipeInputSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_recipe', 'recipe did not validate', issuesOf(parsed.error));

    const input = parsed.data;
    const slug = input.slug ?? slugify(input.title);
    if (slug === null) return fail(res, 400, 'invalid_recipe', 'title has no usable characters for a slug');

    const doc = {
      slug,
      title: input.title,
      servings: input.servings,
      tags: input.tags,
      ingredients: input.ingredients,
      steps: [...input.steps].sort((a, b) => a.order - b.order),
      // Forced, never taken from the body. A client cannot promote its own recipe into the
      // built-in set and inherit the trust the app places in those.
      source: 'user',
      createdAt: new Date(),
    };
    if (input.description !== undefined) doc.description = input.description;
    if (input.coach !== undefined) doc.coach = input.coach;

    try {
      const { insertedId } = await recipes.insertOne(doc);
      return res.status(201).json(publicRecipe({ ...doc, _id: insertedId }));
    } catch (error) {
      if (error?.code === 11000) return fail(res, 409, 'slug_taken', `a recipe with slug "${slug}" already exists`);
      throw error;
    }
  });

  app.post('/api/scores', writeLimiter, async (req, res) => {
    const parsed = scoreInputSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_score', 'score did not validate', issuesOf(parsed.error));

    const name = normalizeName(parsed.data.name);
    if (!name.ok) return fail(res, 400, 'invalid_name', name.reason);

    const { sessionId, sessionToken } = parsed.data;
    if (!verifySession(sessionId, sessionToken, config.sessionSecret)) {
      return fail(res, 401, 'bad_session', 'session token does not match, start a new run');
    }
    const session = await sessions.findOne({ _id: sessionId });
    if (session === null) {
      // Also the answer when a session aged out of the TTL window mid-run. Both cases mean the
      // same thing to the cook: this run can no longer be submitted.
      return fail(res, 404, 'no_session', 'no such session, start a new run');
    }
    if (session.practice) {
      return fail(res, 409, 'practice_run', 'practice runs are not ranked');
    }

    const plausible = checkPlausible(session, {
      minRunSeconds: config.minRunSeconds,
      maxRunSeconds: config.maxRunSeconds,
    });
    if (!plausible.ok) return fail(res, 409, 'implausible', plausible.reason);

    /**
     * Consume first, write second.
     *
     * `findOneAndUpdate` with `consumedAt: null` in the filter is the atomic half: two requests
     * racing with one token means exactly one of them matches, and the loser gets the same 409
     * a deliberate replay would. Checking then updating would let both through.
     */
    const claimed = await sessions.findOneAndUpdate(
      { _id: sessionId, consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
    if (claimed === null) return fail(res, 409, 'implausible', 'session already used');

    const doc = {
      name: name.name,
      score: round1(parsed.data.score),
      hidden: false,
      createdAt: new Date(),
    };
    if (parsed.data.metrics !== undefined) doc.metrics = parsed.data.metrics;
    if (parsed.data.recipeSlug !== undefined) doc.recipeSlug = parsed.data.recipeSlug;
    else if (session.recipeSlug != null) doc.recipeSlug = session.recipeSlug;
    doc.sessionId = sessionId;

    const { insertedId } = await scores.insertOne(doc);

    // Counted rather than paged to: the rank is "how many beat you", which is one query whose
    // cost does not grow with where you landed. The tie-break must match the leaderboard sort
    // exactly or a row can be told rank 4 and then render fifth.
    const ahead = await scores.countDocuments({
      hidden: false,
      $or: [
        { score: { $gt: doc.score } },
        { score: doc.score, createdAt: { $lt: doc.createdAt } },
      ],
    });
    const total = await scores.countDocuments({ hidden: false });

    res.status(201).json({ id: insertedId.toString(), rank: ahead + 1, total });
  });

  app.get('/api/leaderboard', async (req, res) => {
    const parsed = leaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, 'invalid_query', 'bad query parameters', issuesOf(parsed.error));
    const { limit, offset } = parsed.data;

    const [docs, total] = await Promise.all([
      scores.find({ hidden: false })
        .sort({ score: -1, createdAt: 1 })
        .skip(offset)
        .limit(limit)
        .toArray(),
      scores.countDocuments({ hidden: false }),
    ]);

    res.json({
      entries: docs.map((doc, i) => publicEntry(doc, offset + i + 1)),
      total,
      limit,
      offset,
    });
  });

  /* --------------------------------------------------------------------- *
   * Sessions
   * --------------------------------------------------------------------- */

  /**
   * Start a run. Cheap, unauthenticated, rate-limited.
   *
   * `requiredSeconds` is computed HERE from the recipe the cook named, and stored on the
   * session. Computing it at submit time from a slug the client sends would let a client pick
   * a recipe with no timed steps and submit instantly against a different one.
   */
  app.post('/api/sessions/start', writeLimiter, async (req, res) => {
    const parsed = sessionStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'invalid_session', 'bad session request', issuesOf(parsed.error));

    const recipe = parsed.data.recipeSlug === undefined
      ? null
      : await recipes.findOne({ slug: parsed.data.recipeSlug });

    const sessionId = newSessionId();
    const createdAt = new Date();
    const doc = {
      _id: sessionId,
      createdAt,
      practice: parsed.data.practice,
      requiredSeconds: requiredSecondsFor(recipe),
      consumedAt: null,
      recorded: false,
    };
    if (recipe !== null) doc.recipeSlug = recipe.slug;

    await sessions.insertOne(doc);

    res.status(201).json({
      sessionId,
      token: signSession(sessionId, config.sessionSecret),
      startedAt: createdAt.toISOString(),
      requiredSeconds: doc.requiredSeconds,
      minRunSeconds: config.minRunSeconds,
      practice: doc.practice,
    });
  });

  /**
   * Store a recorded run, for the replay screen.
   *
   * Separate from the score submit on purpose: a practice run is worth replaying and is not
   * worth ranking, and a run whose score was rejected as implausible is still a run the cook
   * may want to watch. `$set` rather than insert so a re-POST of the same session overwrites
   * rather than duplicating -- a flaky connection retrying should not double the storage.
   */
  app.post('/api/sessions', writeLimiter, async (req, res) => {
    const parsed = sessionRecordSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_session', 'session did not validate', issuesOf(parsed.error));

    const { sessionId, sessionToken, ...record } = parsed.data;
    if (!verifySession(sessionId, sessionToken, config.sessionSecret)) {
      return fail(res, 401, 'bad_session', 'session token does not match');
    }

    const result = await sessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          recorded: true,
          recordedAt: new Date(),
          durationMs: record.durationMs,
          events: record.events,
          coachResults: record.coachResults,
          thumbnails: record.thumbnails,
          ...(record.score === undefined ? {} : { score: record.score }),
          ...(record.recipeSlug === undefined ? {} : { recipeSlug: record.recipeSlug }),
        },
      },
    );
    if (result.matchedCount === 0) return fail(res, 404, 'no_session', 'no such session, start a new run');

    res.status(201).json({ id: sessionId, thumbnails: record.thumbnails.length, events: record.events.length });
  });

  /**
   * Read a recorded run back.
   *
   * No token required, and that is a deliberate, bounded decision: the id is 128 bits of
   * randomness, so this is an unguessable-URL secret rather than an authenticated one. It is
   * what lets a replay be handed to the person at the next headset. Sessions carry no name and
   * no address, and they expire; see the TTL index in src/db.js.
   */
  app.get('/api/sessions/:id', async (req, res) => {
    const doc = await sessions.findOne({ _id: req.params.id });
    if (doc === null || doc.recorded !== true) return fail(res, 404, 'not_found', 'no recorded session with that id');

    res.json({
      id: doc._id,
      recipeSlug: doc.recipeSlug ?? null,
      practice: doc.practice === true,
      score: doc.score ?? null,
      durationMs: doc.durationMs ?? 0,
      events: doc.events ?? [],
      coachResults: doc.coachResults ?? [],
      thumbnails: doc.thumbnails ?? [],
      createdAt: doc.createdAt.toISOString(),
    });
  });

  /* --------------------------------------------------------------------- *
   * Coach: the three routes that spend money and can always be told "no".
   *
   * None of them 500s when the model is unreachable. Each returns 200 with `offline: true`,
   * because the headset's scoring engine is deterministic and local -- losing the coach costs
   * commentary, and an error status would make the client treat a talkative feature as a
   * broken one.
   * --------------------------------------------------------------------- */

  app.post('/api/coach/analyze', coachLimiter, async (req, res) => {
    const parsed = analyzeInputSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_request', 'analyze request did not validate', issuesOf(parsed.error));
    if (!guardImage(res, parsed.data.image)) return undefined;

    const result = await analyze(llm, {
      imageDataUri: parsed.data.image,
      recipeTitle: parsed.data.recipeTitle,
      stepText: parsed.data.stepText,
      rubricItems: parsed.data.rubricItems,
      hot: parsed.data.hot,
      knife: parsed.data.knife,
    });
    return res.json(result);
  });

  app.post('/api/recipes/scan', coachLimiter, async (req, res) => {
    const parsed = scanInputSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_request', 'scan request did not validate', issuesOf(parsed.error));
    if (!guardImage(res, parsed.data.image)) return undefined;

    const result = await scanRecipe(llm, { imageDataUri: parsed.data.image, units: UNITS });
    return res.json(result);
  });

  app.post('/api/ingredients/check', coachLimiter, async (req, res) => {
    const parsed = ingredientCheckInputSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'invalid_request', 'check request did not validate', issuesOf(parsed.error));
    if (!guardImage(res, parsed.data.image)) return undefined;

    const result = await checkIngredients(llm, { imageDataUri: parsed.data.image, wanted: parsed.data.wanted });
    return res.json(result);
  });

  /**
   * A preflight from a disallowed origin gets a bare 204, not a 404.
   *
   * What actually blocks the request is the ABSENCE of `Access-Control-Allow-Origin`; the cors
   * middleware has already decided by here. Answering 404 would be true of nothing -- the path
   * exists -- and would send whoever debugs it looking for a routing bug.
   */
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.use((_req, res) => fail(res, 404, 'not_found', 'no such endpoint'));

  // Four arguments, or Express does not recognise it as error middleware and the process prints
  // a stack to the client instead.
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.too.large') return fail(res, 413, 'too_large', 'request body over 10kb');
    if (error instanceof SyntaxError && 'body' in error) return fail(res, 400, 'invalid_json', 'body is not valid JSON');
    console.error('[api] unhandled', error);
    // Never the message: it can carry a hostname, a query, or a fragment of a connection string.
    return fail(res, 500, 'internal', 'something went wrong');
  });

  return app;
}
