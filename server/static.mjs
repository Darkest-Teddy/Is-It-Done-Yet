/**
 * The static server the deployed build runs behind.
 *
 * Zero dependencies on purpose. This serves a directory of fingerprinted files and nothing
 * else -- there is no API, no session, no database -- and a framework to do that is a supply
 * chain to audit and a cold start to pay for no benefit. Node's own http module is enough.
 *
 * Three things here are load-bearing rather than taste:
 *
 * CONTENT TYPES, ESPECIALLY `.wasm`. `WebAssembly.instantiateStreaming` rejects any response
 * that is not `application/wasm`, and the rejection reads as a generic compile error rather
 * than as a header problem. A static server that guesses wrong here breaks the vision engine
 * with no clue as to why. Same class of failure the Havok note in `vite.config.ts` records.
 *
 * CACHING, SPLIT BY KIND. Vite fingerprints everything under `/assets`, so those are immutable
 * for a year. HTML is not fingerprinted and must never be cached, or a browser holds a stale
 * document pointing at asset names that no longer exist -- the classic way to ship a white
 * screen after a deploy.
 *
 * `/` SERVES THE MENU. The repository has four entry points and `index.html` is the laptop
 * debug app, which is not what anyone opening the deployed URL on a headset wants. The root
 * serves `app.html`; every other page stays reachable at its own path.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(process.env['STATIC_ROOT'] ?? 'dist');
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';

/** What the root path serves. See the header. */
const INDEX = process.env['STATIC_INDEX'] ?? 'app.html';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  // Not optional -- see the header.
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolves a request path to a file inside ROOT, or null.
 *
 * Returns null rather than throwing for anything that escapes ROOT. `normalize` collapses the
 * `..` segments and the prefix check catches what is left, which together are what stop a
 * request for `/../../.env` reading a file next to the build.
 */
function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null; // malformed percent-encoding
  }

  if (decoded === '/' || decoded === '') decoded = `/${INDEX}`;

  const candidate = resolve(join(ROOT, normalize(decoded)));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

function cacheFor(pathname, file) {
  if (file.endsWith('.html')) return 'no-cache';
  // Fingerprinted by Vite, so the name changes whenever the bytes do.
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  // Everything else is copied verbatim out of public/ and keeps a stable name, so it is
  // revalidated rather than trusted for a year.
  return 'public, max-age=3600';
}

const server = createServer((req, res) => {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }

  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  const file = resolveFile(req.url ?? '/');
  if (file === null) {
    res.writeHead(400).end('bad request');
    return;
  }

  void (async () => {
    let info;
    try {
      info = await stat(file);
      if (info.isDirectory()) {
        info = await stat(join(file, 'index.html'));
      }
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    const target = info.isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': cacheFor(pathname, target),
      // The app is same-origin only; nothing here should be framed by another site.
      'x-content-type-options': 'nosniff',
    });

    if (method === 'HEAD') {
      res.end();
      return;
    }

    createReadStream(target)
      .on('error', () => res.destroy())
      .pipe(res);
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`[static] serving ${ROOT} on http://${HOST}:${PORT}  (/ -> ${INDEX})`);
});
