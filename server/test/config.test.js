/**
 * Environment parsing. Cheap tests guarding the bug that cost a live start: dotenv turns a
 * declared-but-empty variable into `''`, which is not `undefined`, and `''` reached the Mongo
 * driver as a connection string.
 */

import { describe, expect, it } from 'vitest';

import { loadConfig, parseOrigins } from '../src/config.js';

describe('loadConfig', () => {
  it('treats a declared-but-empty variable as unset', () => {
    const config = loadConfig({ MONGODB_URI: '', DB_NAME: '', WRITE_KEY: '', TRUST_PROXY: '', PORT: '' });
    expect(config.mongoUri).toBeNull();
    expect(config.dbName).toBe('isitdone');
    expect(config.writeKey).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.port).toBe(3000);
  });

  it('keeps a real URI', () => {
    expect(loadConfig({ MONGODB_URI: 'mongodb://127.0.0.1:27017' }).mongoUri).toBe('mongodb://127.0.0.1:27017');
  });

  it('reads trust proxy as a boolean or a hop count', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('throws on a non-numeric number rather than silently defaulting', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow();
  });
});

describe('parseOrigins', () => {
  it('splits, trims and drops trailing slashes', () => {
    expect(parseOrigins(' https://a.example/ , https://b.example ')).toEqual(['https://a.example', 'https://b.example']);
  });

  it('returns empty for unset or blank', () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins('   ')).toEqual([]);
  });
});
