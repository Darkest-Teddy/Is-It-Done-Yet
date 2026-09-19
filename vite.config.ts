import { mkdirSync, writeFileSync } from 'node:fs';
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

export default defineConfig({
  plugins: [questResults()],
  // 0.0.0.0 so a phone or the Beam Pro on the same LAN can open it; the CV all runs locally.
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: { outDir: 'dist', sourcemap: true, target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  base: './',
});
