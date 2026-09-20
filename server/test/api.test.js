/**
 * The API against a real MongoDB.
 *
 * Grouped by the promise each block is defending, not by endpoint, because the interesting
 * failures here cross endpoints: a rank returned by POST /api/scores that disagrees with the
 * order GET /api/leaderboard renders is two correct-looking handlers and one broken feature.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { seed } from '../src/seed.js';
import { appWith, resetDatabase, startDatabase, stopDatabase } from './helpers.js';

let db;

beforeAll(async () => { db = await startDatabase(); });
afterAll(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(db); });

/** A minimal valid recipe body, spread-and-overridden per test. */
const recipeBody = (over = {}) => ({
  title: 'Test Salad',
  servings: 2,
  tags: ['test'],
  ingredients: [{ name: 'tomato', quantity: 2, unit: 'piece' }],
  steps: [{ order: 0, text: 'Slice the tomato' }],
  ...over,
});

const post = (app, path, body, headers = {}) => {
  const req = request(app).post(path).send(body);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
};

describe('health', () => {
  it('reports ok and the database name', async () => {
    const res = await request(appWith(db)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: 'test' });
  });
});

describe('name sanitising through the API', () => {
  it('stores the cleaned name, not the raw one', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: '  <b>Ada</b>  ', score: 50 }).expect(201);
    const res = await request(app).get('/api/leaderboard');
    expect(res.body.entries[0].name).toBe('bAdab');
  });

  it('strips zero-width characters before length is judged', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: '​​​', score: 50 }).expect(400);
  });

  it('rejects a blocked name with a generic message', async () => {
    const res = await post(appWith(db), '/api/scores', { name: 'fuck', score: 50 }).expect(400);
    expect(res.body.error.code).toBe('invalid_name');
    expect(res.body.error.message).not.toMatch(/block|profan/i);
  });

  it('caps a long name at 20 characters', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'a'.repeat(60), score: 50 }).expect(201);
    const res = await request(app).get('/api/leaderboard');
    expect(res.body.entries[0].name).toHaveLength(20);
  });
});

describe('score validation', () => {
  it.each([
    ['above range', 100.1],
    ['below range', -1],
  ])('rejects a score %s', async (_label, score) => {
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score }).expect(400);
    expect(res.body.error.code).toBe('invalid_score');
  });

  it('rejects a non-finite score', async () => {
    // JSON has no Infinity, so the wire form is a string -- which must not be coerced.
    await post(appWith(db), '/api/scores', { name: 'Ada', score: '88' }).expect(400);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 50, admin: true }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/Unrecognized key/i);
  });

  it('rejects an oversized metrics bag', async () => {
    const metrics = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, i]));
    await post(appWith(db), '/api/scores', { name: 'Ada', score: 50, metrics }).expect(400);
  });

  it('rounds to one decimal place', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'Ada', score: 88.26 }).expect(201);
    const res = await request(app).get('/api/leaderboard');
    expect(res.body.entries[0].score).toBe(88.3);
  });

  it('accepts and returns metrics without echoing them to the board', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'Ada', score: 50, metrics: { meanMm: 4.2, sigmaMm: 1.8 } }).expect(201);
    const res = await request(app).get('/api/leaderboard');
    expect(res.body.entries[0]).toEqual({
      rank: 1, name: 'Ada', score: 50, createdAt: expect.any(String),
    });
  });
});

describe('rank and the tie-break', () => {
  it('returns the rank a score just earned', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'Ada', score: 90 }).expect(201);
    const second = await post(app, '/api/scores', { name: 'Bo', score: 50 }).expect(201);
    expect(second.body).toMatchObject({ rank: 2, total: 2 });
  });

  it('breaks a tie towards whoever got there first', async () => {
    const app = appWith(db);
    const first = await post(app, '/api/scores', { name: 'Bo', score: 71.5 }).expect(201);
    const second = await post(app, '/api/scores', { name: 'Cy', score: 71.5 }).expect(201);
    expect(first.body.rank).toBe(1);
    expect(second.body.rank).toBe(2);

    const board = await request(app).get('/api/leaderboard');
    expect(board.body.entries.map((e) => e.name)).toEqual(['Bo', 'Cy']);
  });

  it('agrees with the order the leaderboard renders', async () => {
    const app = appWith(db);
    const names = ['Ada', 'Bo', 'Cy', 'Dee'];
    const scores = [88.3, 71.5, 71.5, 40];
    const ranks = [];
    for (let i = 0; i < names.length; i += 1) {
      const res = await post(app, '/api/scores', { name: names[i], score: scores[i] }).expect(201);
      ranks.push(res.body.rank);
    }
    expect(ranks).toEqual([1, 2, 3, 4]);

    const board = await request(app).get('/api/leaderboard');
    expect(board.body.entries.map((e) => [e.rank, e.name]))
      .toEqual([[1, 'Ada'], [2, 'Bo'], [3, 'Cy'], [4, 'Dee']]);
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    const app = appWith(db);
    for (let i = 0; i < 25; i += 1) {
      await post(app, '/api/scores', { name: `P${i}`, score: 100 - i }).expect(201);
    }
  });

  it('defaults to 20 entries', async () => {
    const res = await request(appWith(db)).get('/api/leaderboard');
    expect(res.body.entries).toHaveLength(20);
    expect(res.body.total).toBe(25);
  });

  it('continues rank numbering across an offset', async () => {
    const res = await request(appWith(db)).get('/api/leaderboard?limit=5&offset=20');
    expect(res.body.entries.map((e) => e.rank)).toEqual([21, 22, 23, 24, 25]);
    expect(res.body.entries[0].name).toBe('P20');
  });

  it('rejects a limit beyond the cap', async () => {
    await request(appWith(db)).get('/api/leaderboard?limit=101').expect(400);
  });

  it('returns an empty page past the end rather than an error', async () => {
    const res = await request(appWith(db)).get('/api/leaderboard?offset=500').expect(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(25);
  });
});

describe('hidden entries', () => {
  it('are excluded from the board, the total and the rank', async () => {
    const app = appWith(db);
    const bad = await post(app, '/api/scores', { name: 'Troll', score: 99 }).expect(201);
    await post(app, '/api/scores', { name: 'Ada', score: 50 }).expect(201);

    await db.collection('scores').updateOne(
      { name: 'Troll' }, { $set: { hidden: true } },
    );

    const board = await request(app).get('/api/leaderboard');
    expect(board.body.total).toBe(1);
    expect(board.body.entries.map((e) => e.name)).toEqual(['Ada']);
    expect(board.body.entries[0].rank).toBe(1);

    const next = await post(app, '/api/scores', { name: 'Cy', score: 10 }).expect(201);
    expect(next.body).toMatchObject({ rank: 2, total: 2 });
    expect(bad.body.id).toBeTruthy();
  });
});

describe('what the board gives away', () => {
  it('returns no address, id or user agent for an entry', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'Ada', score: 50, metrics: { meanMm: 4 } })
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'OculusBrowser/40.0')
      .expect(201);

    const res = await request(app).get('/api/leaderboard');
    const serialised = JSON.stringify(res.body);
    expect(Object.keys(res.body.entries[0]).sort()).toEqual(['createdAt', 'name', 'rank', 'score']);
    expect(serialised).not.toMatch(/203\.0\.113\.9/);
    expect(serialised).not.toMatch(/Oculus/i);
    expect(serialised).not.toMatch(/_id/);
  });

  it('never writes an address into the stored document', async () => {
    const app = appWith(db);
    await post(app, '/api/scores', { name: 'Ada', score: 50 })
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(201);

    const doc = await db.collection('scores').findOne({ name: 'Ada' });
    expect(JSON.stringify(doc)).not.toMatch(/203\.0\.113\.9/);
    expect(Object.keys(doc).sort()).toEqual(['_id', 'createdAt', 'hidden', 'name', 'score']);
  });
});

describe('rate limiting', () => {
  it('returns 429 once the window is spent', async () => {
    const app = appWith(db, { rateLimitMaxWrites: 3, rateLimitWindowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) {
      await post(app, '/api/scores', { name: `P${i}`, score: 10 }).expect(201);
    }
    const blocked = await post(app, '/api/scores', { name: 'P4', score: 10 }).expect(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });

  it('does not limit reads', async () => {
    const app = appWith(db, { rateLimitMaxWrites: 1, rateLimitWindowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/api/leaderboard').expect(200);
    }
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const app = appWith(db, { allowedOrigins: ['https://darkest-teddy.github.io'] });
    const res = await request(app).get('/api/leaderboard').set('Origin', 'https://darkest-teddy.github.io');
    expect(res.headers['access-control-allow-origin']).toBe('https://darkest-teddy.github.io');
  });

  it('withholds the header from an origin that is not configured', async () => {
    const app = appWith(db, { allowedOrigins: ['https://darkest-teddy.github.io'] });
    const res = await request(app).get('/api/leaderboard').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows any origin when none is configured, for local development', async () => {
    const app = appWith(db, { allowedOrigins: [] });
    const res = await request(app).get('/api/leaderboard').set('Origin', 'http://localhost:8081');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });

  it('tolerates a trailing slash in configuration', async () => {
    const app = appWith(db, { allowedOrigins: ['https://darkest-teddy.github.io'] });
    const res = await request(app).get('/api/leaderboard').set('Origin', 'https://darkest-teddy.github.io/');
    expect(res.headers['access-control-allow-origin']).toBe('https://darkest-teddy.github.io/');
  });
});

describe('recipes', () => {
  beforeEach(async () => { await seed(db); });

  it('lists the seeded recipes', async () => {
    const res = await request(appWith(db)).get('/api/recipes').expect(200);
    expect(res.body.recipes.length).toBeGreaterThanOrEqual(13);
    expect(res.body.recipes.map((r) => r.slug)).toContain('cucumber-raita');
  });

  it('caps limit at 50', async () => {
    await request(appWith(db)).get('/api/recipes?limit=51').expect(400);
  });

  it('finds a recipe by a partial word, not only a whole one', async () => {
    const res = await request(appWith(db)).get('/api/recipes?q=cucum').expect(200);
    expect(res.body.recipes.map((r) => r.slug)).toContain('cucumber-raita');
  });

  it('finds a recipe by an ingredient it contains', async () => {
    const res = await request(appWith(db)).get('/api/recipes?q=mozzarella').expect(200);
    expect(res.body.recipes.map((r) => r.slug)).toContain('caprese-bruschetta');
  });

  it('filters by tag', async () => {
    const res = await request(appWith(db)).get('/api/recipes?tag=ticket').expect(200);
    expect(res.body.recipes.every((r) => r.tags.includes('ticket'))).toBe(true);
  });

  it('fetches by slug and by id', async () => {
    const app = appWith(db);
    const bySlug = await request(app).get('/api/recipes/cucumber-raita').expect(200);
    expect(bySlug.body.title).toBe('Cucumber Raita');

    const byId = await request(app).get(`/api/recipes/${bySlug.body.id}`).expect(200);
    expect(byId.body.slug).toBe('cucumber-raita');
  });

  it('404s on an unknown slug and on a malformed id', async () => {
    await request(appWith(db)).get('/api/recipes/not-a-recipe').expect(404);
    await request(appWith(db)).get('/api/recipes/zzz').expect(404);
  });

  it('keeps the coach fields through a round trip', async () => {
    const res = await request(appWith(db)).get('/api/recipes/cucumber-raita').expect(200);
    expect(res.body.coach.requires.map((r) => r.ingredient)).toContain('cucumber');
    expect(res.body.steps[0]).toMatchObject({ stepId: 'rinse', verifiable: 'vision' });
  });
});

describe('creating a recipe', () => {
  it('accepts a valid one and forces source to user', async () => {
    const res = await post(appWith(db), '/api/recipes', recipeBody()).expect(201);
    expect(res.body).toMatchObject({ slug: 'test-salad', source: 'user', servings: 2 });
  });

  it('refuses a claimed source', async () => {
    await post(appWith(db), '/api/recipes', recipeBody({ source: 'builtin' })).expect(400);
  });

  it('sorts steps by order', async () => {
    const res = await post(appWith(db), '/api/recipes', recipeBody({
      steps: [{ order: 2, text: 'Serve' }, { order: 0, text: 'Slice' }, { order: 1, text: 'Salt' }],
    })).expect(201);
    expect(res.body.steps.map((s) => s.text)).toEqual(['Slice', 'Salt', 'Serve']);
  });

  it.each([
    ['no ingredients', { ingredients: [] }],
    ['no steps', { steps: [] }],
    ['a unit outside the enum', { ingredients: [{ name: 'tomato', quantity: 1, unit: 'handful' }] }],
    ['a non-numeric quantity', { ingredients: [{ name: 'tomato', quantity: 'two', unit: 'piece' }] }],
    ['an empty title', { title: '' }],
    ['an unknown field', { colour: 'red' }],
    ['servings out of range', { servings: 0 }],
  ])('rejects %s', async (_label, over) => {
    const res = await post(appWith(db), '/api/recipes', recipeBody(over)).expect(400);
    expect(res.body.error.code).toBe('invalid_recipe');
  });

  it('409s on a duplicate slug', async () => {
    const app = appWith(db);
    await post(app, '/api/recipes', recipeBody()).expect(201);
    const clash = await post(app, '/api/recipes', recipeBody()).expect(409);
    expect(clash.body.error.code).toBe('slug_taken');
  });

  it('demands x-api-key when WRITE_KEY is set', async () => {
    const app = appWith(db, { writeKey: 'sekrit' });
    await post(app, '/api/recipes', recipeBody()).expect(401);
    await post(app, '/api/recipes', recipeBody(), { 'x-api-key': 'sekrit' }).expect(201);
  });

  it('leaves scores open even when WRITE_KEY is set', async () => {
    await post(appWith(db, { writeKey: 'sekrit' }), '/api/scores', { name: 'Ada', score: 10 }).expect(201);
  });
});

describe('error handling', () => {
  it('rejects a body over 10kb', async () => {
    const res = await post(appWith(db), '/api/recipes', recipeBody({
      description: 'x'.repeat(20_000),
    })).expect(413);
    expect(res.body.error.code).toBe('too_large');
  });

  it('reports malformed JSON as such', async () => {
    const res = await request(appWith(db))
      .post('/api/scores')
      .set('Content-Type', 'application/json')
      .send('{nope')
      .expect(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('404s an unknown endpoint in the same error shape', async () => {
    const res = await request(appWith(db)).get('/api/nope').expect(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
  });

  it('never returns a stack trace', async () => {
    const res = await request(appWith(db)).get('/api/nope').expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/\bat \/|node_modules/);
  });
});

describe('seeding', () => {
  it('is idempotent', async () => {
    const first = await seed(db);
    expect(first.inserted).toBe(first.total);

    const second = await seed(db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(second.total);

    const count = await db.collection('recipes').countDocuments({});
    expect(count).toBe(first.total);
  });

  it('does not rewrite createdAt on a reseed', async () => {
    await seed(db);
    const before = await db.collection('recipes').findOne({ slug: 'cucumber-raita' });
    await seed(db);
    const after = await db.collection('recipes').findOne({ slug: 'cucumber-raita' });
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
  });
});
