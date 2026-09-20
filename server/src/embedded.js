/**
 * An in-process MongoDB, so `npm run dev` needs no account, no Docker and no cluster.
 *
 * This is the single biggest thing standing between a teammate and a working checkout at 3am.
 * `mongodb-memory-server` downloads a real mongod binary once and runs it as a child process,
 * so what the tests exercise is genuine Mongo -- indexes, `$text`, upserts, duplicate-key
 * errors -- rather than a fake that agrees with whatever the code does.
 *
 * The data directory is persistent (`server/.data/`) rather than a temp folder, so restarting
 * the dev server does not wipe the board you were just looking at. Tests pass their own
 * ephemeral instance instead; a test suite that remembers yesterday is a test suite that lies.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = resolve(here, '../.data');

/** Imported lazily: it is a devDependency and must not be required by a production image. */
async function serverClass() {
  try {
    const mod = await import('mongodb-memory-server');
    return mod.MongoMemoryServer;
  } catch {
    throw new Error(
      'MONGODB_URI is not set and mongodb-memory-server is not installed.\n'
      + 'Either run `npm install` in server/ (dev), or set MONGODB_URI (production).',
    );
  }
}

/**
 * @param {{ persistent?: boolean, dbPath?: string, dbName?: string }} [options]
 * @returns {Promise<{ uri: string, stop: () => Promise<void> }>}
 */
export async function startEmbeddedMongo(options = {}) {
  const { persistent = true, dbPath = DEFAULT_DB_PATH, dbName = 'isitdone' } = options;
  const MongoMemoryServer = await serverClass();

  const instance = { dbName };
  if (persistent) {
    mkdirSync(dbPath, { recursive: true });
    instance.dbPath = dbPath;
    // Without this the storage engine wipes the directory on boot and "persistent" is a lie.
    instance.storageEngine = 'wiredTiger';
  }

  const mongod = await MongoMemoryServer.create({ instance });
  return { uri: mongod.getUri(), stop: () => mongod.stop() };
}
