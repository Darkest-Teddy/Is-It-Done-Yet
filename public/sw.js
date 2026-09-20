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

/**
 * THE CACHE KEYS, AND WHY THERE ARE TWO LIFETIMES RATHER THAN ONE.
 *
 * `BUILD_ID` is rewritten by `vite.config.ts` at the end of every build with a hash of what the
 * build emitted. A hand-maintained `'iidy-v1'` sat here through several deploys, and the
 * consequence was measured rather than theorised: a worker registered by an earlier build went
 * on serving its cached copies, so a new deploy did not appear -- the same worker was even seen
 * serving a cached PRODUCTION bundle over the dev server on localhost. A headset that has opened
 * the site once is exactly the client that would pin an old bundle and show the old UI after the
 * deploy everything depends on.
 *
 * But bumping one version for everything is the other failure. `activate` deletes every cache
 * that is not current, and the runtime cache holds 15.5MB of OpenCV -- so a version-per-deploy
 * would re-download fifteen megabytes on a headset every time anyone pushes. The point of this
 * file is to stop doing that.
 *
 * So the split is by whether the URL encodes its own contents:
 *
 *   SHELL   versioned per build. The documents, the manifest, the icons, the fonts and the
 *           ingredient art -- everything Vite copies out of `public/` under a STABLE name, whose
 *           bytes can change without its URL changing. These must be dropped on a new build or
 *           the new UI does not appear. It is a few hundred KB, so dropping them costs nothing.
 *
 *   ASSETS  NOT versioned, on purpose. Everything under `/assets/`, which Vite fingerprints, so
 *           the name changes whenever the bytes do and a hit is the right bytes by construction.
 *           Keeping this across deploys is what makes a redeploy cheap on the headset. Entries
 *           belonging to superseded builds are never requested again and are left for the
 *           browser's own quota eviction; there is no correct moment to delete them, because a
 *           client still running the old build would still be asking for them.
 */
/**
 * `'dev'` IS THE UNSTAMPED DEFAULT AND IT IS NOT WHAT SHIPS. This file is copied verbatim into
 * `dist/`, and `serviceWorkerVersion()` in `vite.config.ts` then rewrites this one line with a
 * hash of what the build emitted -- so a deployed worker reads e.g. `'8be001ce8ee1'`. If the
 * rewrite ever fails to match, the build FAILS rather than warns, because an unstamped worker
 * keeps the previous build's shell key, `activate` below never purges it, and the deploy
 * silently serves the old UI. Do not change the shape of this line without changing that
 * plugin's pattern; `npm run build:deploy` will stop if you do.
 *
 * Reading `'dev'` here on a dev server is correct and deliberate: `app.html` unregisters any
 * worker it finds in DEV, so nothing is meant to be serving from a cache there at all.
 */
const BUILD_ID = 'dev';
const SHELL = `iidy-shell-${BUILD_ID}`;
const ASSETS = 'iidy-assets';

/** Content-addressed by Vite's own hashing, so it survives a deploy. See above. */
const isFingerprinted = (pathname) => pathname.includes('/assets/');

/**
 * Fetched on install. Kept minimal -- the big assets arrive through the runtime cache.
 *
 * `app.html` is here and listed before `index.html` because it is the front door: both
 * `server/static.mjs` and `vercel.json` answer `/` with it, and `index.html` is the laptop
 * debug app. Precaching only `index.html` meant an offline cold launch of `/app.html` -- before
 * its own navigation had ever been cached -- fell back to a different application entirely,
 * which is a stranger failure than showing nothing.
 *
 * `'./'` is deliberately NOT here, and the reason is a trap rather than a preference. On Vercel
 * the root is a redirect to `/app.html`, so `cache.add('./')` would store a response with
 * `redirected: true` under the key `/` -- and handing a redirected response to `respondWith`
 * for a NAVIGATION is a spec-level network error, not a slow path. The offline launch of the
 * installed icon, whose `start_url` is `./`, is exactly the navigation that would hit it. It
 * costs nothing to leave out: `./app.html` is what the fallback chain below reaches for, and a
 * host that serves `/` directly caches it on the first online visit anyway.
 */
const PRECACHE = [
  './app.html',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
];

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
    // Every shell but this build's, and nothing else. `iidy-assets` is deliberately spared, and
    // so is anything this worker did not write -- deleting an unrecognised cache is how you
    // break a second app sharing the origin.
    const keys = await caches.keys();
    const stale = keys.filter((k) => k.startsWith('iidy-') && k !== SHELL && k !== ASSETS);
    await Promise.all(stale.map((k) => caches.delete(k)));
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
        // Never cache a redirect under the requested key. A stored redirected response handed
        // back for a navigation is a network error rather than a slow path -- see PRECACHE --
        // and `/` is a redirect on Vercel. The browser follows it and the SW sees the second
        // navigation, which is the one worth keeping.
        if (fresh.type === 'basic' && !fresh.redirected) {
          const cache = await caches.open(SHELL);
          await cache.put(request, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        // The request's own cached copy first, then the front door, then the debug app. The
        // order matters: `./app.html` is what `/` serves on both hosts, so it is the right
        // answer for a launch from the installed icon as well as for a typed URL.
        return (await caches.match(request))
          ?? (await caches.match('./app.html'))
          ?? (await caches.match('./index.html'))
          ?? Response.error();
      }
    })());
    return;
  }

  // Which cache this belongs in is decided by the URL, not by the request, and that single
  // line is what makes a redeploy both correct and cheap. A fingerprinted name goes in the
  // cache that survives the deploy; a stable name goes in the one that does not.
  const cacheName = isFingerprinted(url.pathname) ? ASSETS : SHELL;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    // Scoped to one cache rather than `caches.match`, which searches every cache on the origin
    // in creation order. A stale entry answering here is precisely the pinned-old-bundle
    // failure this file is arranged to prevent, so the lookup says which cache it means.
    const hit = await cache.match(request);
    if (hit !== undefined) return hit;
    try {
      const fresh = await fetch(request);
      // Only store a complete, same-origin 200. Storing a 206 would hand back a truncated
      // WASM module later, which fails a long way from the cause.
      //
      // Not awaited: the write of a 15MB chunk must not sit between the browser and a response
      // it already has.
      if (fresh.status === 200 && fresh.type === 'basic') {
        void cache.put(request, fresh.clone()).catch(() => undefined);
      }
      return fresh;
    } catch (error) {
      // Offline last resort, so this one IS allowed to ignore the query string -- a cached copy
      // under a different cache-buster is better than nothing when there is no network.
      const fallback = await cache.match(request, { ignoreSearch: true });
      if (fallback !== undefined) return fallback;
      throw error;
    }
  })());
});
