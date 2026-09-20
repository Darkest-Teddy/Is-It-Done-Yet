import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // One mongod for the whole file, started in a beforeAll. Forking per test file would spawn
    // a database per file and turn a 5-second suite into a minute of process startup.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
