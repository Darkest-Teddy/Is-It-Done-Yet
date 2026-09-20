/**
 * Service worker. Two jobs, and the second is the one that matters here.
 *
 * It makes the app installable -- Quest Browser will not offer "Install" without one -- and it
 * makes the app work with no network at all, which master spec rule #12 asks for directly and
 * rule #9 implies everywhere. Venue wifi at a 1500-person event is saturated, and the demo has
 * to survive that.
 *
 * WHY THIS MATTERS MORE HERE THAN ON A NORMAL SITE. The bundle is ~15MB, nearly all of it the
 * OpenCV WASM binary. Fetching that over hall wifi while a judge waits is the difference
 * between a demo and an apology. Cached once, it never touches the network again.
 *
 * STRATEGY, and the split is deliberate:
 *
 *   Navigation  -> network first, cache fallback. A stale HTML shell pointing at hashed asset
 *                  names that no longer exist is the classic way to ship a white screen, so
 *                  the document is always re-fetched when the network allows.
 *   Everything  -> cache first. Vite fingerprints asset filenames, so a cached hit is by
 *   else          definition the right bytes and re-validating it would only cost latency.
 *
 * Nothing here caches opaque cross-origin responses or anything but GET: a partial or opaque
 * body written into the cache is indistinguishable from a good one on the way back out, and
 * the failure shows up much later as a corrupt WASM module.
 */

const VERSION = 'iidy-v1';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

/** Fetched on install. Kept minimal -- the big assets arrive through the runtime cache. */
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: addAll is atomic, so one 404 throws away the whole precache
    // and the install fails silently with no cached shell at all.
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch { /* skip */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same origin only. A cross-origin response is opaque, so its status cannot be read and a
  // failure would be cached as though it had succeeded.
  if (url.origin !== self.location.origin) return;
  // The diagnostic endpoint must always hit the server; a cached "ok" would be a lie.
  if (url.pathname.endsWith('/quest-results')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(request))
          ?? (await caches.match('./index.html'))
          ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit !== undefined) return hit;
    try {
      const fresh = await fetch(request);
      // Only store a complete, same-origin 200. Storing a 206 would hand back a truncated
      // WASM module later, which fails a long way from the cause.
      if (fresh.status === 200 && fresh.type === 'basic') {
        const cache = await caches.open(RUNTIME);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (error) {
      const fallback = await caches.match(request, { ignoreSearch: true });
      if (fallback !== undefined) return fallback;
      throw error;
    }
  })());
});
