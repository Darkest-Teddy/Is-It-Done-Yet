import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // Disables HTTP keep-alive before any test runs. See test/setup.js -- without it the suite
    // fails about one run in five with a socket-reuse parse error on an arbitrary test.
    setupFiles: ['test/setup.js'],
    // One mongod for the whole file, started in a beforeAll. Forking per test file would spawn
    // a database per file and turn a 5-second suite into a minute of process startup.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
