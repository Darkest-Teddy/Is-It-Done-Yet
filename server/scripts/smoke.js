/**
 * `npm run smoke` -- starts the real server on a random port against an ephemeral database,
 * seeds it, posts scores including a deliberate tie, and prints what came back.
 *
 * Exists because a passing test suite and a working server are different claims. This one talks
 * HTTP to a listening socket, so it also covers the things a supertest run skips: the listener,
 * CORS preflight, the JSON body limit and the 404 handler.
 *
 * Every number it prints is the server's own answer. Nothing here is asserted into existence.
 */

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, close } from '../src/db.js';
import { startEmbeddedMongo } from '../src/embedded.js';
import { seed } from '../src/seed.js';

const embedded = await startEmbeddedMongo({ persistent: false, dbName: 'smoke' });
const db = await connect(embedded.uri, 'smoke');
const config = { ...loadConfig({}), allowedOrigins: ['https://darkest-teddy.github.io'] };
const server = createApp({ db, config }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const show = (label, value) => console.log(`\n--- ${label}\n${JSON.stringify(value, null, 2)}`);

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep the raw text */ }
  return { status: res.status, body: parsed, headers: res.headers };
};

console.log(`[smoke] server on ${base}`);

show('GET /api/health', (await call('GET', '/api/health')).body);

const seeded = await seed(db);
console.log(`\n--- seed\n${JSON.stringify(seeded)}`);

const recipes = await call('GET', '/api/recipes?limit=3');
show('GET /api/recipes?limit=3', {
  status: recipes.status,
  total: recipes.body.total,
  titles: recipes.body.recipes.map((r) => `${r.slug} (${r.source}, ${r.steps.length} steps)`),
});

const raita = await call('GET', '/api/recipes/cucumber-raita');
show('GET /api/recipes/cucumber-raita', {
  status: raita.status,
  title: raita.body.title,
  ingredients: raita.body.ingredients.map((i) => `${i.quantity} ${i.unit} ${i.name}`),
  firstStep: raita.body.steps[0],
});

show('GET /api/recipes?q=cucumber', (await call('GET', '/api/recipes?q=cucumber')).body.recipes.map((r) => r.slug));

// A tie on purpose: Bo and Cy both score 71.5, and the earlier submission must rank higher.
const posts = [
  { name: 'Ada', score: 88.25, recipeSlug: 'cut-sunomono', metrics: { meanMm: 2.6, sigmaMm: 0.3, cuts: 8 } },
  { name: 'Bo', score: 71.5, recipeSlug: 'cut-tzatziki', metrics: { meanMm: 4.9, sigmaMm: 1.1, cuts: 8 } },
  { name: 'Cy', score: 71.5, recipeSlug: 'cut-tzatziki', metrics: { meanMm: 5.1, sigmaMm: 1.2, cuts: 8 } },
  { name: '  <script>alert(1)</script>  ', score: 40, metrics: { cuts: 3 } },
];

for (const post of posts) {
  const res = await call('POST', '/api/scores', post);
  console.log(`\n--- POST /api/scores  name=${JSON.stringify(post.name)} score=${post.score}\n  ${res.status} ${JSON.stringify(res.body)}`);
}

show('POST /api/scores (empty name)', (await call('POST', '/api/scores', { name: '  ', score: 10 })).body);
show('POST /api/scores (score out of range)', (await call('POST', '/api/scores', { name: 'Dee', score: 101 })).body);
show('POST /api/scores (unknown field)', (await call('POST', '/api/scores', { name: 'Dee', score: 10, cheat: true })).body);

show('GET /api/leaderboard?limit=20', (await call('GET', '/api/leaderboard?limit=20')).body);
show('GET /api/leaderboard?limit=2&offset=2', (await call('GET', '/api/leaderboard?limit=2&offset=2')).body);

const preflight = await fetch(`${base}/api/scores`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
});
console.log(`\n--- CORS preflight from https://evil.example\n  ${preflight.status}  allow-origin=${preflight.headers.get('access-control-allow-origin') ?? '(none)'}`);

const allowedPreflight = await fetch(`${base}/api/scores`, {
  method: 'OPTIONS',
  headers: { Origin: 'https://darkest-teddy.github.io', 'Access-Control-Request-Method': 'POST' },
});
console.log(`--- CORS preflight from https://darkest-teddy.github.io\n  ${allowedPreflight.status}  allow-origin=${allowedPreflight.headers.get('access-control-allow-origin') ?? '(none)'}`);

show('GET /api/nope', (await call('GET', '/api/nope')).body);

server.close();
await close();
await embedded.stop();
console.log('\n[smoke] done');
