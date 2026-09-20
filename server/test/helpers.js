/**
 * One real MongoDB for the suite, and an app wired to it.
 *
 * The tests talk to genuine Mongo rather than a double on purpose: the things most likely to
 * break here are database behaviours -- the unique index on slug, `$text` refusing to sit under
 * an `$or`, the exact sort that makes the tie-break work. A stub agrees with whatever the code
 * believes, which is precisely the belief under test.
 */

import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureIndexes } from '../src/db.js';

let mongod = null;
let client = null;

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
  ]);
  await ensureIndexes(db);
}

export function appWith(db, overrides = {}) {
  return createApp({ db, config: { ...loadConfig({}), ...overrides } });
}
