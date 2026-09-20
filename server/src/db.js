/**
 * One MongoClient for the process, and the indexes the queries depend on.
 *
 * One client, not one per request: the driver pools connections internally, and a new client
 * per request is both a handshake per request and a slow leak that only shows up under the
 * one load that matters -- a queue of people at the booth.
 */

import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Indexes are created at startup rather than by hand.
 *
 * `createIndex` is idempotent, so this costs nothing on a warm database and means a fresh
 * cluster is correct the first time somebody points the server at it. The leaderboard index
 * is compound and ordered to match the sort exactly: filter on `hidden`, then `score`
 * descending, then `createdAt` ascending as the tie-break. A different order and Mongo sorts
 * in memory, which is fine at booth scale and wrong to ship.
 */
export async function ensureIndexes(database) {
  await database.collection('recipes').createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
  await database.collection('recipes').createIndex(
    { title: 'text', tags: 'text' },
    { name: 'recipe_text', weights: { title: 10, tags: 4 } },
  );
  await database.collection('scores').createIndex(
    { hidden: 1, score: -1, createdAt: 1 },
    { name: 'leaderboard' },
  );
}

export async function connect(uri, dbName) {
  if (db !== null) return db;
  client = new MongoClient(uri, {
    // Fail fast rather than hang: a wrong URI at a venue should say so in seconds.
    serverSelectionTimeoutMS: 8_000,
    retryWrites: true,
  });
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes(db);
  return db;
}

export async function close() {
  if (client !== null) await client.close();
  client = null;
  db = null;
}
