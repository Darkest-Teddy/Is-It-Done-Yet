/**
 * `npm run seed` -- upserts the built-in recipes into whatever MONGODB_URI points at.
 *
 * With no MONGODB_URI it seeds the same persistent embedded database `npm run dev` uses, which
 * is what makes "clone and run" true rather than aspirational.
 */

import 'dotenv/config';

import { loadConfig } from '../src/config.js';
import { close, connect } from '../src/db.js';
import { startEmbeddedMongo } from '../src/embedded.js';
import { seed } from '../src/seed.js';

const config = loadConfig();
let stop = null;
let uri = config.mongoUri;

if (uri === null) {
  console.warn('[seed] MONGODB_URI unset -- seeding the embedded development database');
  const embedded = await startEmbeddedMongo({ dbName: config.dbName });
  uri = embedded.uri;
  stop = embedded.stop;
}

const db = await connect(uri, config.dbName);
const result = await seed(db);
console.log(`[seed] ${result.total} recipes: ${result.inserted} inserted, ${result.updated} updated`);

await close();
if (stop !== null) await stop();
