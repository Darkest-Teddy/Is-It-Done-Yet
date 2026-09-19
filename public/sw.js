/**
 * Service worker. Exists because Quest will not treat a page as installable without one that
 * has a fetch handler -- and the failure is silent: the Install option simply never appears.
 *
 * Strategy is NETWORK-FIRST with a cache fallback, not cache-first. During a build like this
 * one the code changes constantly, and a cache-first worker serves yesterday's bundle from an
 * installed app with no obvious way to clear it. That failure mode costs hours and looks like
 * "my changes stopped working", so it is worth the slightly slower cold start.
 *
 * Vite's dev endpoints are never cached; caching a hot-module URL breaks reloading outright.
 */

const CACHE = 'is-it-done-yet-v1';

const SHELL = [
  '/xr.html',
  '/manifest.webmanifest',
  '/ui/library.uikitml',
  '/ui/preview.uikitml',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Individually, so one missing file does not fail the whole install the way addAll would.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Dev-server and API traffic must always go to the network. */
function isUncacheable(url) {
  return (
    url.pathname.startsWith('/@vite') ||
    url.pathname.startsWith('/@fs') ||
    url.pathname.startsWith('/@id') ||
    url.pathname.startsWith('/node_modules/.vite') ||
    url.pathname.startsWith('/src/') ||
    url.origin !== self.location.origin
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isUncacheable(url)) return; // fall through to the network untouched

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache real successes. Caching an opaque or error response is how a 404 becomes
        // permanent for every future load.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit ?? Response.error()),
      ),
  );
});
