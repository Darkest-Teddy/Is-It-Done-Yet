import { defineConfig } from 'vitest/config';

// Deliberately separate from vite.config.ts, though the reason has changed. It used to be that
// vitest would otherwise adopt the IWSDK dev plugin -- emulator injection, headless browser,
// scene validation -- merely to run headless unit tests. That plugin is gone with the rest of
// the XR build (DECISIONS entry 12). Keeping the split still buys something: vite.config.ts
// binds 0.0.0.0:8081 and sets a build target, none of which a test run should inherit or race
// against while the dev server is up.
export default defineConfig({
  // `server/` is its own package with its own vitest, its own dependencies and a real MongoDB
  // to start. Picked up from here it would fail on imports this package has never installed,
  // and it would report as the app's tests failing. Run it with `npm --prefix server test`.
  test: { exclude: ['node_modules/**', 'dist/**', 'server/**'] },
});
