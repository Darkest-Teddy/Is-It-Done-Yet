/**
 * `npm run hide -- <scoreId>` and `npm run unhide -- <scoreId>`.
 *
 * Hiding rather than deleting, because the row is evidence: if somebody puts something vile on
 * the board, the useful sequence is get it off the screen now and look at how it got past the
 * filter afterwards. A delete makes the second half impossible.
 *
 * Deliberately a CLI and not an endpoint. A moderation route needs an auth story, and the only
 * honest one for a weekend project is "the person with shell access", which is this.
 */

import 'dotenv/config';
import { ObjectId } from 'mongodb';

import { loadConfig } from '../src/config.js';
import { close, connect } from '../src/db.js';
import { startEmbeddedMongo } from '../src/embedded.js';

const [action, id] = process.argv.slice(2);

if (action !== 'hide' && action !== 'unhide') {
  console.error('usage: npm run hide -- <scoreId>   |   npm run unhide -- <scoreId>');
  process.exit(2);
}
if (id === undefined || !ObjectId.isValid(id)) {
  console.error(`not a valid score id: ${id ?? '(missing)'}`);
  process.exit(2);
}

const config = loadConfig();
let stop = null;
let uri = config.mongoUri;

if (uri === null) {
  const embedded = await startEmbeddedMongo({ dbName: config.dbName });
  uri = embedded.uri;
  stop = embedded.stop;
}

const db = await connect(uri, config.dbName);
const result = await db.collection('scores').updateOne(
  { _id: new ObjectId(id) },
  { $set: { hidden: action === 'hide' } },
);

if (result.matchedCount === 0) console.error(`no score with id ${id}`);
else console.log(`${action === 'hide' ? 'hidden' : 'unhidden'}: ${id}`);

await close();
if (stop !== null) await stop();
process.exit(result.matchedCount === 0 ? 1 : 0);
