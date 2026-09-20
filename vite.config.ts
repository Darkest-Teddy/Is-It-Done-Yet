import { mkdirSync, writeFileSync } from 'node:fs';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

/**
 * Catches results POSTed by `public/quest-check.html` and writes them to `results/`.
 *
 * Exists because getting text OUT of a headset is genuinely awkward -- there is no shared
 * clipboard with the laptop, and the alternative is reading a diagnostic aloud through a
 * face-mounted display or screenshotting and `adb pull`-ing it. One tap in the headset putting
 * a file on the laptop is the difference between running this check once and running it after
 * every change.
 *
 * `apply: 'serve'` keeps it out of the production build entirely: this writes arbitrary POST
 * bodies to disk, which is fine for a dev server on localhost and is not something to ship.
 */
function questResults(): Plugin {
  return {
    name: 'quest-results',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/quest-results', (req, res, next) => {
        if (req.method !== 'POST') { next(); return; }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            mkdirSync('results', { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = `results/quest-check-${stamp}.txt`;
            writeFileSync(file, body);
            server.config.logger.info(`\n[quest-check] ${file}\n${body}\n`);
            res.statusCode = 200;
            res.end('ok');
          } catch (error) {
            server.config.logger.error(`[quest-check] ${(error as Error).message}`);
            res.statusCode = 500;
            res.end('failed');
          }
        });
      });
    },
  };
}

/**
 * Mounts the Qwen3 guidance relay on the dev server.
 *
 * The same handler `server/static.mjs` mounts for the built app, so what gets exercised while
 * building the feature is what runs on the deployed one. Without this, the relay would only
 * exist in production and the only way to develop against a model would be a `VITE_`-prefixed
 * key in the browser -- which is exactly the thing `.env.example` warns about and the relay
 * exists to avoid.
 *
 * With `QWEN_BASE_URL` unset the handler answers 503 and the app falls back to its local
 * guidance, which is a complete answer on its own. Nothing here is required for the app to run.
 */
function guidanceRelay(): Plugin {
  return {
    name: 'guidance-relay',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/guidance', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        void import('./server/guidance.mjs')
          .then((module) => (module as { handleGuidance: (a: unknown, b: unknown) => Promise<void> })
            .handleGuidance(req, res))
          .catch((error: unknown) => {
            server.config.logger.error(`[guidance] ${(error as Error).message}`);
            res.statusCode = 500;
            res.end('{"error":"relay unavailable"}');
          });
      });
    },
  };
}

/**
 * Mounts the ElevenLabs speech relay on the dev server, for the same reasons as above.
 *
 * Kept as its own plugin rather than folded into `guidanceRelay` because the two fail
 * independently: a deployment can have a model and no voice, or a voice and no model, and a
 * single plugin mounting both would make that read as one switch.
 *
 * With no key the handler answers 503, the browser marks the tier dead after the first one and
 * stops asking, and the chef falls back to whatever voice the browser has. On the headset that
 * is nothing (DECISIONS.md entry 19) and the subtitle carries the answer alone -- which is the
 * behaviour this repo shipped before the relay existed, not a regression introduced by it.
 */
function speechRelay(): Plugin {
  return {
    name: 'speech-relay',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/speech', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        void import('./server/speech.mjs')
          .then((module) => (module as { handleSpeech: (a: unknown, b: unknown) => Promise<void> })
            .handleSpeech(req, res))
          .catch((error: unknown) => {
            server.config.logger.error(`[speech] ${(error as Error).message}`);
            res.statusCode = 500;
            res.end('{"error":"relay unavailable"}');
          });
      });
    },
  };
}

/**
 * HTTPS, and the two ways a headset reaches this server.
 *
 * OVER USB (`npm run adb:reverse`, then `npm run dev:usb`): the headset sees this as
 * `http://localhost:8081`, which IS a secure context on plain HTTP. That is the route
 * `quest-check.html` documents, and it is what makes the camera and microphone reachable at
 * all without wrestling a certificate. HTTPS there would add an interstitial for nothing.
 *
 * OVER LAN (default): a LAN IP gets no `localhost` exemption, so `getUserMedia` and WebXR both
 * require HTTPS. The cert is self-signed, so Quest Browser shows an interstitial that must be
 * accepted by hand -- browser automation cannot dismiss it. Without HTTPS the camera list
 * silently comes back empty and reads as "no cameras" rather than "insecure origin".
 */
const useHttps = process.env['VITE_HTTPS'] !== '0';

export default defineConfig({
  plugins: useHttps
    ? [questResults(), guidanceRelay(), speechRelay(), basicSsl()]
    : [questResults(), guidanceRelay(), speechRelay()],

  // 0.0.0.0 so the headset, a phone, or the Beam Pro on the same LAN can open it.
  server: { host: '0.0.0.0', port: 8081, open: false },

  build: {
    outDir: 'dist',
    // Sourcemaps locally, never in a deployed build: ~60MB here (OpenCV and the font bundles
    // dominate), and a headset pulling them over venue wifi is the slowest possible first
    // load, for a debugging aid nobody uses on the device.
    //
    // `VITE_SOURCEMAP=0` is the explicit switch, used by `npm run build:deploy`. The
    // `VITE_BASE` clause is kept because the GitHub Pages build has always relied on it, but
    // deploying to a root domain needs a way to turn maps off that is not a side effect of
    // setting a base path.
    sourcemap: process.env['VITE_SOURCEMAP'] !== '0' && process.env['VITE_BASE'] === undefined,
    target: 'esnext',
    // Every page is a real entry point. Without listing them Vite builds only index.html and
    // the others silently never reach the bundle -- the app appears to deploy, then 404s.
    // Object form, not the bare string the IWSDK scaffold used: that one fails the dependency
    // scan outright under Vite 7 (DECISIONS.md #11).
    rollupOptions: {
      input: { main: 'index.html', xr: 'xr.html', app: 'app.html', homev2: 'homev2.html' },
    },
  },

  esbuild: { target: 'esnext' },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
    // Load-bearing, do not remove. Without it the Havok .wasm request falls through to the SPA
    // HTML fallback, so WebAssembly.instantiate receives `<!do` instead of the wasm magic
    // number. The resulting promise never resolves AND never rejects: World.create hangs
    // forever and the app is a blank canvas with an empty console. See DECISIONS.md #11.
    exclude: ['@babylonjs/havok'],
  },

  /**
   * Public path. Root for local dev; `npm run build:pages` sets `VITE_BASE` for the GitHub
   * Pages subpath.
   *
   * NOT `'./'`. A relative base breaks a PWA: the service worker's scope and the manifest's
   * start_url resolve against the document, so a page opened one level deep registers a worker
   * controlling the wrong path and the Install option silently never appears.
   */
  base: process.env['VITE_BASE'] ?? '/',
});
