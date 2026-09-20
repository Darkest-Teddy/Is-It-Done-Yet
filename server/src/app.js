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

import { leaderboardQuerySchema, recipeInputSchema, recipeQuerySchema, scoreInputSchema } from './schemas.js';
import { normalizeName, slugify } from './sanitize.js';

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
  createdAt: doc.createdAt.toISOString(),
});

export function createApp({ db, config }) {
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

  // 10kb. A recipe is a page of text; anything larger is a mistake or an attack, and either way
  // the answer is the same.
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

  app.get('/api/health', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ ok: true, db: db.databaseName, time: new Date().toISOString() });
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

    const doc = {
      name: name.name,
      score: round1(parsed.data.score),
      hidden: false,
      createdAt: new Date(),
    };
    if (parsed.data.metrics !== undefined) doc.metrics = parsed.data.metrics;
    if (parsed.data.recipeSlug !== undefined) doc.recipeSlug = parsed.data.recipeSlug;

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
