/**
 * One real MongoDB for the suite, and an app wired to it.
 *
 * The tests talk to genuine Mongo rather than a double on purpose: the things most likely to
 * break here are database behaviours -- the unique index on slug, `$text` refusing to sit under
 * an `$or`, the exact sort that makes the tie-break work. A stub agrees with whatever the code
 * believes, which is precisely the belief under test.
 *
 * The LLM is the exception and is ALWAYS a double. These tests must never reach an upstream:
 * a suite that spends money is a suite people stop running, and one that fails when a venue's
 * wifi drops is worse than no suite at all.
 */

import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureIndexes } from '../src/db.js';
import { signSession } from '../src/sessions.js';

let mongod = null;
let client = null;

/**
 * A fixed signing key for the whole suite.
 *
 * `loadConfig` generates a random secret per call, which is the right production default and
 * would make every `appWith(db)` in a test file sign tokens the next one rejects.
 */
export const TEST_SECRET = 'test-session-secret-not-used-anywhere-real';

export async function startDatabase() {
  mongod = await MongoMemoryServer.create({ instance: { dbName: 'test' } });
  client = new MongoClient(mongod.getUri());
  await client.connect();
  return client.db('test');
}

export async function stopDatabase() {
  if (client !== null) await client.close();
  if (mongod !== null) await mongod.stop();
  client = null;
  mongod = null;
}

/** Drops everything and rebuilds the indexes, so each test starts from a known empty board. */
export async function resetDatabase(db) {
  await Promise.all([
    db.collection('recipes').deleteMany({}),
    db.collection('scores').deleteMany({}),
    db.collection('sessions').deleteMany({}),
  ]);
  await ensureIndexes(db);
}

/**
 * An LLM double.
 *
 * `replies` is a queue of strings, each returned as one completion. An empty queue throws,
 * which is how the "coach offline" paths are exercised -- the same way a real outage reaches
 * the code.
 */
export function fakeLlm(replies = [], { model = 'fake-model' } = {}) {
  const queue = [...replies];
  const calls = [];
  return {
    calls,
    configured: true,
    describe: () => ({ primary: { model, configured: true }, fallback: null }),
    async chat(request) {
      calls.push(request);
      if (queue.length === 0) throw new Error('fake llm: no reply queued');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { text: next, provider: 'fake', model };
    },
  };
}

export function testConfig(overrides = {}) {
  return { ...loadConfig({}), sessionSecret: TEST_SECRET, ...overrides };
}

/**
 * @param overrides.llm        an LLM double (see `fakeLlm`)
 * @param overrides.llmConfig  a partial merged into `config.llm` -- the knobs, not the client
 * @param overrides.*          anything else merged into the top level of config
 */
export function appWith(db, overrides = {}) {
  const { llm, llmConfig, ...configOverrides } = overrides;
  const base = testConfig(configOverrides);
  return createApp({
    db,
    config: llmConfig === undefined ? base : { ...base, llm: { ...base.llm, ...llmConfig } },
    // Default to an LLM with nothing queued: any test that reaches it without saying so gets
    // the offline path rather than a network call.
    llm: llm ?? fakeLlm(),
  });
}

/**
 * Inserts a session directly, so a score test does not have to wait out `minRunSeconds`.
 *
 * Backdating the document is the honest way to do it: the plausibility check reads
 * `createdAt`, so this exercises the real rule rather than a test-only bypass.
 */
export async function makeSession(db, { ageSeconds = 120, practice = false, recipeSlug, requiredSeconds = 0 } = {}) {
  const sessionId = `sess-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
  const doc = {
    _id: sessionId,
    createdAt: new Date(Date.now() - ageSeconds * 1000),
    practice,
    requiredSeconds,
    consumedAt: null,
    recorded: false,
  };
  if (recipeSlug !== undefined) doc.recipeSlug = recipeSlug;
  await db.collection('sessions').insertOne(doc);
  return { sessionId, sessionToken: signSession(sessionId, TEST_SECRET) };
}

/**
 * A pool of ready sessions, so a score test can stay synchronous at the call site.
 *
 * supertest's request object is thenable and `.expect()` chains off it, so a `postScore` that
 * had to `await` a database insert first would force every existing assertion to be rewritten
 * as `(await postScore(...)).expect(201)`. Seeding the pool in `beforeEach` and shifting from
 * it synchronously keeps the tests reading the way they did.
 */
export async function seedSessions(db, count, options = {}) {
  const made = [];
  for (let i = 0; i < count; i++) made.push(await makeSession(db, options));
  return made;
}
