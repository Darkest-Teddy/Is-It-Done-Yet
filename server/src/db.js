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
export async function ensureIndexes(database, { sessionTtlDays = 7 } = {}) {
  await database.collection('recipes').createIndex({ slug: 1 }, { unique: true, name: 'slug_unique' });
  await database.collection('recipes').createIndex(
    { title: 'text', tags: 'text' },
    { name: 'recipe_text', weights: { title: 10, tags: 4 } },
  );
  await database.collection('scores').createIndex(
    { hidden: 1, score: -1, createdAt: 1 },
    { name: 'leaderboard' },
  );

  /**
   * Sessions expire, and this is the only mechanism that makes them expire.
   *
   * A recorded session carries up to twenty JPEGs of somebody's kitchen. Nothing else in this
   * server deletes anything, so without a TTL index those photographs are kept forever by
   * default -- which is a decision nobody made.
   */
  await ensureTtlIndex(database, 'sessions', sessionTtlDays);
  await database.collection('sessions').createIndex({ recipeSlug: 1, createdAt: -1 }, { name: 'by_recipe' });
}

/**
 * `createIndex` with a different `expireAfterSeconds` than the live index does not update it --
 * it fails with IndexOptionsConflict (85). Changing the retention window therefore has to go
 * through `collMod`, and a server that cannot do that (a read-only user, an old mongod) should
 * still start: the old window is wrong, not dangerous.
 */
async function ensureTtlIndex(database, collectionName, days) {
  const expireAfterSeconds = Math.max(60, Math.round(days * 86_400));
  const name = 'session_ttl';
  try {
    await database.collection(collectionName).createIndex({ createdAt: 1 }, { name, expireAfterSeconds });
  } catch (error) {
    if (error?.code !== 85) throw error;
    try {
      await database.command({ collMod: collectionName, index: { name, expireAfterSeconds } });
    } catch (modError) {
      console.warn(`[api] could not change the session TTL window: ${modError.message}`);
    }
  }
}

export async function connect(uri, dbName, indexOptions = {}) {
  if (db !== null) return db;
  client = new MongoClient(uri, {
    // Fail fast rather than hang: a wrong URI at a venue should say so in seconds.
    serverSelectionTimeoutMS: 8_000,
    retryWrites: true,
  });
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes(db, indexOptions);
  return db;
}

export async function close() {
  if (client !== null) await client.close();
  client = null;
  db = null;
}
