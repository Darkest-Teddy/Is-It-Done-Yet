/**
 * The deployed build. `npm run build:deploy`, and `vercel.json` names it as the build command.
 *
 * It was a `node -e` one-liner in `package.json`, which is where it stopped being readable --
 * this does the same three things and can carry the argument for each.
 *
 * NO SOURCEMAPS. About 60MB of them, dominated by OpenCV and the font bundles, for a debugging
 * aid nobody opens on a headset. A Quest pulling those over venue wifi is the slowest possible
 * first load.
 *
 * THE TWO RELAY PATHS, WHICH ARE THE INTERESTING PART. `configFromEnv` in `src/ai/qwen.ts` and
 * `speechRelayFromEnv` in `src/audio/chef.ts` are both opt-in, and both headers give the same
 * reason: a checkout with nothing configured must not POST to a route that is not mounted.
 * That reason was exactly right when the only deployment was a static host with no server
 * behind it -- which is the deployment this repository has actually had.
 *
 * It no longer describes the deployed build. The routes are mounted in all three places now:
 * `vite.config.ts` for the dev server, `server/static.mjs` for `npm start`, and `api/*.js` for
 * Vercel. Leaving the client opted out there means the relay answers and nobody asks, so the
 * chef falls back to its local line while a working voice sits behind a URL the bundle does not
 * contain -- and the failure is invisible, because the local fallback is good.
 *
 * So the opt-in stays the default for a fresh checkout and `npm run dev`, and the DEPLOY build
 * opts in, which is the one place the routes are known to exist. An explicit value in the
 * environment still wins, so a Vercel project variable or a shell export overrides either.
 *
 * Nothing here makes the relays required. Unconfigured, `/api/guidance` and `/api/speech`
 * answer 503, `src/core/voice/speech.ts` retires the tier on the first 404 or 503, and the app
 * is exactly as playable as it was with no routes at all -- master spec rule #9.
 */

import { spawn } from 'node:child_process';

/** Sets a variable only if the environment has not already said something about it. */
function preferExisting(name, value) {
  const current = process.env[name];
  if (current === undefined || current === '') process.env[name] = value;
}

process.env['VITE_SOURCEMAP'] = '0';
preferExisting('VITE_GUIDANCE_RELAY', '/api/guidance');
preferExisting('VITE_SPEECH_RELAY', '/api/speech');

const child = spawn('npx', ['vite', 'build'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

// Propagated rather than swallowed: a build that failed must fail the deploy, not publish the
// previous `dist/` and look like it worked.
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 1));
});
