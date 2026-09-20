/**
 * The session and coach routes, end to end against a real MongoDB and a fake model.
 *
 * The block that matters most is "score submission": it is the only place in this project where
 * a stranger's number reaches a public board, and the three gates in front of it (signature,
 * single use, minimum duration) are only correct together.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { appWith, fakeLlm, makeSession, resetDatabase, startDatabase, stopDatabase, TEST_SECRET } from './helpers.js';
import { signSession } from '../src/sessions.js';

let db;
beforeAll(async () => { db = await startDatabase(); });
afterAll(async () => { await stopDatabase(); });
beforeEach(async () => { await resetDatabase(db); });

const post = (app, path, body) => request(app).post(path).send(body);
const IMAGE = `data:image/jpeg;base64,${'A'.repeat(400)}`;

const analyzeBody = (over = {}) => ({
  image: IMAGE,
  recipeTitle: 'Smash Burger',
  stepText: 'Press the patty flat',
  rubricItems: ['crust has formed'],
  ...over,
});

describe('starting a session', () => {
  it('returns an id and a token that verifies', async () => {
    const res = await post(appWith(db), '/api/sessions/start', {}).expect(201);
    expect(res.body.sessionId).toBeTypeOf('string');
    expect(res.body.token).toBe(signSession(res.body.sessionId, TEST_SECRET));
  });

  it('carries the flat minimum back to the client so the HUD can show it', async () => {
    const res = await post(appWith(db), '/api/sessions/start', {}).expect(201);
    expect(res.body.minRunSeconds).toBe(20);
    expect(res.body.requiredSeconds).toBe(0);
  });

  /**
   * The floor comes from the recipe the server looked up, not from anything the client sent.
   * 0.4 x (120 + 180) = 120.
   */
  it('computes the floor from the stored recipe, not from the request', async () => {
    await db.collection('recipes').insertOne({
      slug: 'slow-thing', title: 'Slow Thing', servings: 2, tags: [], ingredients: [], source: 'builtin', createdAt: new Date(),
      steps: [{ order: 0, text: 'simmer', durationSec: 120 }, { order: 1, text: 'rest', durationSec: 180 }],
    });
    const res = await post(appWith(db), '/api/sessions/start', { recipeSlug: 'slow-thing' }).expect(201);
    expect(res.body.requiredSeconds).toBe(120);
  });

  it('starts a practice run when asked', async () => {
    const res = await post(appWith(db), '/api/sessions/start', { practice: true }).expect(201);
    expect(res.body.practice).toBe(true);
  });

  it('rejects an unknown field', async () => {
    await post(appWith(db), '/api/sessions/start', { practice: false, cheat: true }).expect(400);
  });

  it('survives an unknown recipe slug rather than 404ing the run', async () => {
    const res = await post(appWith(db), '/api/sessions/start', { recipeSlug: 'no-such-dish' }).expect(201);
    expect(res.body.requiredSeconds).toBe(0);
  });
});

describe('score submission', () => {
  it('accepts a score backed by a valid, old-enough session', async () => {
    const session = await makeSession(db, { ageSeconds: 120 });
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 88, ...session }).expect(201);
    expect(res.body.rank).toBe(1);
  });

  it('rejects a forged token', async () => {
    const session = await makeSession(db);
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 99, sessionId: session.sessionId, sessionToken: 'forged-token-value' }).expect(401);
    expect(res.body.error.code).toBe('bad_session');
  });

  it('rejects a well-formed token for a session that does not exist', async () => {
    const sessionId = 'ghost-session-id';
    await post(appWith(db), '/api/scores', {
      name: 'Ada', score: 99, sessionId, sessionToken: signSession(sessionId, TEST_SECRET),
    }).expect(404);
  });

  it('rejects a score with no session at all', async () => {
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 99 }).expect(400);
    expect(res.body.error.code).toBe('invalid_score');
  });

  it('rejects a run shorter than the minimum', async () => {
    const session = await makeSession(db, { ageSeconds: 3 });
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 99, ...session }).expect(409);
    expect(res.body.error.code).toBe('implausible');
    expect(res.body.error.message).toMatch(/needs at least 20s/);
  });

  it("rejects a run shorter than the recipe's own timed steps", async () => {
    const session = await makeSession(db, { ageSeconds: 60, requiredSeconds: 300 });
    await post(appWith(db), '/api/scores', { name: 'Ada', score: 99, ...session }).expect(409);
  });

  /** The replay attack this whole mechanism exists for. */
  it('consumes a session, so the same token cannot post twice', async () => {
    const app = appWith(db);
    const session = await makeSession(db, { ageSeconds: 120 });
    await post(app, '/api/scores', { name: 'Ada', score: 88, ...session }).expect(201);
    const second = await post(app, '/api/scores', { name: 'Ada', score: 99, ...session }).expect(409);
    expect(second.body.error.code).toBe('implausible');
    expect(await db.collection('scores').countDocuments({})).toBe(1);
  });

  it('lets exactly one of two racing submissions through', async () => {
    const app = appWith(db);
    const session = await makeSession(db, { ageSeconds: 120 });
    const results = await Promise.all([
      post(app, '/api/scores', { name: 'Ada', score: 88, ...session }),
      post(app, '/api/scores', { name: 'Ada', score: 88, ...session }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.collection('scores').countDocuments({})).toBe(1);
  });

  it('keeps a practice run off the board', async () => {
    const session = await makeSession(db, { ageSeconds: 120, practice: true });
    const res = await post(appWith(db), '/api/scores', { name: 'Ada', score: 99, ...session }).expect(409);
    expect(res.body.error.code).toBe('practice_run');
    expect(await db.collection('scores').countDocuments({})).toBe(0);
  });

  it("inherits the session's recipe when the body does not name one", async () => {
    const session = await makeSession(db, { ageSeconds: 120, recipeSlug: 'smash-burger' });
    await post(appWith(db), '/api/scores', { name: 'Ada', score: 70, ...session }).expect(201);
    expect((await db.collection('scores').findOne({ name: 'Ada' })).recipeSlug).toBe('smash-burger');
  });
});

describe('recorded sessions', () => {
  const record = (session, over = {}) => ({
    ...session,
    durationMs: 120_000,
    events: [{ atMs: 1000, kind: 'step-complete', stepIndex: 0, points: 120 }],
    coachResults: [{ atMs: 2000, observations: [], coachLine: 'Nice.', unsure: false }],
    thumbnails: [{ atMs: 2000, jpeg: 'AAAA' }],
    ...over,
  });

  it('stores and reads back a run', async () => {
    const app = appWith(db);
    const session = await makeSession(db);
    await post(app, '/api/sessions', record(session)).expect(201);

    const res = await request(app).get(`/api/sessions/${session.sessionId}`).expect(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.thumbnails[0].jpeg).toBe('AAAA');
  });

  it('records a practice run too -- it is worth replaying, just not ranking', async () => {
    const app = appWith(db);
    const session = await makeSession(db, { practice: true });
    await post(app, '/api/sessions', record(session)).expect(201);
    expect((await request(app).get(`/api/sessions/${session.sessionId}`)).body.practice).toBe(true);
  });

  it('overwrites rather than duplicating when a flaky client retries', async () => {
    const app = appWith(db);
    const session = await makeSession(db);
    await post(app, '/api/sessions', record(session)).expect(201);
    await post(app, '/api/sessions', record(session, { events: [] })).expect(201);
    expect((await request(app).get(`/api/sessions/${session.sessionId}`)).body.events).toEqual([]);
    expect(await db.collection('sessions').countDocuments({})).toBe(1);
  });

  it('rejects a recording with a forged token', async () => {
    const session = await makeSession(db);
    await post(appWith(db), '/api/sessions', record({ sessionId: session.sessionId, sessionToken: 'nope-not-a-token' })).expect(401);
  });

  it('404s a session that was started but never recorded', async () => {
    const session = await makeSession(db);
    await request(appWith(db)).get(`/api/sessions/${session.sessionId}`).expect(404);
  });

  it('refuses more than twenty thumbnails', async () => {
    const session = await makeSession(db);
    const many = Array.from({ length: 21 }, (_, i) => ({ atMs: i * 1000, jpeg: 'AA' }));
    await post(appWith(db), '/api/sessions', record(session, { thumbnails: many })).expect(400);
  });

  it('refuses a thumbnail over 25KB of base64', async () => {
    const session = await makeSession(db);
    const huge = [{ atMs: 0, jpeg: 'A'.repeat(40_000) }];
    await post(appWith(db), '/api/sessions', record(session, { thumbnails: huge })).expect(400);
  });

  it('refuses a data: prefix on a thumbnail, which would double the stored bytes', async () => {
    const session = await makeSession(db);
    await post(appWith(db), '/api/sessions', record(session, { thumbnails: [{ atMs: 0, jpeg: 'data:image/jpeg;base64,AAAA' }] })).expect(400);
  });
});

describe('POST /api/coach/analyze', () => {
  it('returns the model answer when the model behaves', async () => {
    const llm = fakeLlm([JSON.stringify({
      observations: [{ item: 'crust has formed', status: 'ok', evidence: 'dark edge', confidence: 0.9 }],
      coachLine: 'Flip it.',
      unsure: false,
    })]);
    const res = await post(appWith(db, { llm }), '/api/coach/analyze', analyzeBody()).expect(200);
    expect(res.body.observations[0].status).toBe('ok');
    expect(res.body.offline).toBe(false);
  });

  /** 200 and `offline: true`, never a 5xx -- the headset must keep scoring locally. */
  it('answers 200 with offline:true when the upstream is down', async () => {
    const llm = fakeLlm([new Error('upstream 503')]);
    const res = await post(appWith(db, { llm }), '/api/coach/analyze', analyzeBody()).expect(200);
    expect(res.body).toMatchObject({ offline: true, unsure: true, observations: [] });
  });

  it('rejects a body that is not an image data URI', async () => {
    await post(appWith(db), '/api/coach/analyze', analyzeBody({ image: 'https://example.com/pan.jpg' })).expect(400);
  });

  it('rejects an image over the configured byte ceiling', async () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    const res = await post(appWith(db, { llmConfig: { maxImageBytes: 1000 } }), '/api/coach/analyze', analyzeBody({ image: big }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('image_too_large');
  });

  it('rejects more than twelve rubric items', async () => {
    const items = Array.from({ length: 13 }, (_, i) => `item ${i}`);
    await post(appWith(db), '/api/coach/analyze', analyzeBody({ rubricItems: items })).expect(400);
  });

  it('rejects an unknown field', async () => {
    await post(appWith(db), '/api/coach/analyze', analyzeBody({ pleaseSayOk: true })).expect(400);
  });
});

describe('POST /api/recipes/scan', () => {
  it('returns an editable draft and saves nothing', async () => {
    const llm = fakeLlm([JSON.stringify({
      title: 'Tomato Salad', servings: 2, tags: [],
      ingredients: [{ name: 'tomato', quantity: 3, unit: 'piece' }],
      steps: [{ order: 0, text: 'Slice', hot: false, knife: true }],
      confidence: 0.8, unreadable: [],
    })]);
    const res = await post(appWith(db, { llm }), '/api/recipes/scan', { image: IMAGE }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.draft.title).toBe('Tomato Salad');
    expect(await db.collection('recipes').countDocuments({})).toBe(0);
  });

  it('goes offline rather than 500 when the model is unreachable', async () => {
    const res = await post(appWith(db, { llm: fakeLlm([new Error('down')]) }), '/api/recipes/scan', { image: IMAGE }).expect(200);
    expect(res.body).toMatchObject({ ok: false, offline: true });
  });

  /** The scan route must not shadow GET /api/recipes/:idOrSlug. */
  it('does not collide with the recipe-by-slug route', async () => {
    await db.collection('recipes').insertOne({
      slug: 'scan', title: 'A dish called scan', servings: 1, tags: [], ingredients: [], steps: [], source: 'builtin', createdAt: new Date(),
    });
    const res = await request(appWith(db)).get('/api/recipes/scan').expect(200);
    expect(res.body.title).toBe('A dish called scan');
  });
});

describe('POST /api/ingredients/check', () => {
  it('answers per requested item', async () => {
    const llm = fakeLlm([JSON.stringify({
      found: [{ name: 'tomato', present: true, confidence: 0.9, evidence: 'three on the board' }],
      unsure: false,
    })]);
    const res = await post(appWith(db, { llm }), '/api/ingredients/check', { image: IMAGE, wanted: ['tomato'] }).expect(200);
    expect(res.body.found[0]).toMatchObject({ name: 'tomato', present: true });
  });

  it('goes offline rather than 500', async () => {
    const res = await post(appWith(db, { llm: fakeLlm([new Error('down')]) }), '/api/ingredients/check', { image: IMAGE, wanted: ['tomato'] }).expect(200);
    expect(res.body).toMatchObject({ offline: true, found: [] });
  });

  it('requires at least one wanted item', async () => {
    await post(appWith(db), '/api/ingredients/check', { image: IMAGE, wanted: [] }).expect(400);
  });
});

describe('health', () => {
  it('reports the coach model without leaking a key or a base URL', async () => {
    const res = await request(appWith(db)).get('/api/health').expect(200);
    expect(res.body.coach.primary.model).toBe('fake-model');
    expect(JSON.stringify(res.body)).not.toMatch(/groq\.com|api[_-]?key|Bearer/i);
  });
});
