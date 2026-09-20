/**
 * Boot: environment, a database one way or the other, listen, and shut down cleanly.
 *
 * The branch at the top is the whole developer-experience story. With `MONGODB_URI` set this is
 * an ordinary API server. Without it, it starts its own MongoDB and seeds it, so a checkout
 * runs with `npm install && npm run dev` and nothing else -- no account, no cluster, no Docker.
 */

import 'dotenv/config';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { close, connect } from './db.js';
import { startEmbeddedMongo } from './embedded.js';
import { seed } from './seed.js';

const config = loadConfig();

let stopEmbedded = null;
let uri = config.mongoUri;

if (uri === null) {
  console.warn('[api] MONGODB_URI unset -- starting an embedded MongoDB (development only)');
  const embedded = await startEmbeddedMongo({ dbName: config.dbName });
  uri = embedded.uri;
  stopEmbedded = embedded.stop;
}

const db = await connect(uri, config.dbName, { sessionTtlDays: config.sessionTtlDays });

if (config.mongoUri === null) {
  const result = await seed(db);
  console.log(`[api] seeded ${result.total} recipes (${result.inserted} new, ${result.updated} updated)`);
}

const server = createApp({ db, config }).listen(config.port, () => {
  console.log(`[api] listening on :${config.port}  db=${config.dbName}`);
  console.log(`[api] CORS: ${config.allowedOrigins.length === 0 ? 'any origin (set ALLOWED_ORIGIN before deploying)' : config.allowedOrigins.join(', ')}`);
});

/**
 * Both signals, and both matter. A container runtime sends SIGTERM and gives you seconds; Ctrl-C
 * sends SIGINT. Closing the client rather than exiting outright lets in-flight writes finish,
 * which on a shared cluster is the difference between a clean stop and a half-written score.
 */
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} -- shutting down`);
    server.close(async () => {
      await close();
      if (stopEmbedded !== null) await stopEmbedded();
      process.exit(0);
    });
    // A connection held open by a stuck client must not hold the deploy open with it.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
