# Running a web app on Quest without a cable

How to get **any** web app onto a Quest 3/3S as a standalone, installable app with no laptop
attached. Written to be app-agnostic: nothing here is specific to this repo, and the same three
requirements apply to whatever you deploy next.

Measured against a Quest 3S, Horizon OS v207, OculusBrowser 152. Findings that back the
gotchas are in `DECISIONS.md` entries 18–21.

---

## 1. The three requirements

Everything else is detail. These are the ones that will actually stop you.

| # | Requirement | Why | Symptom if missing |
|---|---|---|---|
| 1 | **HTTPS origin** | `getUserMedia` (camera and mic) and PWA install both need a *secure context* | Camera silently blocked; no Install option |
| 2 | **Web app manifest** | Tells the browser it is installable, and supplies the name and icon | Install option never appears |
| 3 | **Service worker** | Required for install, and what makes it work with no network | Install option never appears; app dies on bad wifi |

**`localhost` counts as a secure context**, which is why `adb reverse` works for development. A
LAN IP over plain `http://` does **not** — that is the trap. `http://10.0.0.5:8081` will load
the page and then fail the camera with no useful error.

---

## 2. Choose where it is hosted

| Option | HTTPS | Good for | Cost |
|---|---|---|---|
| **Vercel** | automatic | The demo. Push once, get a permanent URL | free |
| Netlify / Cloudflare Pages | automatic | Same | free |
| GitHub Pages | automatic | Static only, slower to update | free |
| `cloudflared` / `ngrok` tunnel | automatic | Testing a *local* server over HTTPS without deploying | free |
| Self-signed cert on LAN | manual | Nothing. Quest Browser's cert interstitial is painful | — |

**Recommendation: Vercel.** The CLI is already installed here, it is named in `CLAUDE.md`, and a
deploy is one command. The tunnel option is worth knowing for the case where you want the
headset hitting a *live dev server* over HTTPS — useful when iterating on camera code without
rebuilding.

---

## 3. The files you need

Three files plus icons. They are app-agnostic — **copy them into any static or Vite app's
`public/` directory** and they work.

```
public/
├── manifest.webmanifest      name, icons, display: standalone
├── sw.js                     offline cache
└── icons/
    ├── icon-192.png
    ├── icon-512.png
    └── icon-512-maskable.png
```

And in `index.html`:

```html
<link rel="manifest" href="./manifest.webmanifest" />
<link rel="icon" href="./icons/icon-192.png" />
<meta name="theme-color" content="#0b0d11" />
```

And register the worker — **gated on the dev flag, not on hostname**:

```ts
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* never fatal */ });
  });
}
```

> **Why not gate on hostname.** The headset reaches your dev server *as* `localhost` through
> `adb reverse`, so a hostname check disables the worker in exactly the place you need to test
> it, while leaving it enabled against your laptop dev server — where it caches module output
> Vite is simultaneously rewriting and serves stale code that survives a hard reload. That is an
> afternoon lost to a bug you already fixed.

Generate icons with anything. There is a PIL snippet in this repo's history, but any 192px and
512px PNG will do. The `maskable` variant needs ~10% extra padding so a circular crop does not
clip the artwork.

---

## 4. Deploy

```bash
npm run build            # produces dist/
npx vercel login         # once
npx vercel --prod        # prints your https://... URL
```

Vercel auto-detects Vite and serves `dist/`. If it guesses wrong, set **Build Command**
`npm run build` and **Output Directory** `dist` in the project settings.

For a non-Vite app, any static host works — the requirements in §1 are all that matter.

---

## 5. Install it on the headset

1. Open the HTTPS URL in **Quest Browser**
2. **⋮ menu → Install** (may read "Install app" or "Add to apps")
3. It appears in the Quest app library with your icon
4. Launch it from there — standalone window, no browser chrome, **no cable**

First launch caches the bundle. After that it runs with the network off.

---

## 6. Verify it actually worked

Do not trust the Install button alone. From the laptop:

```bash
npm run devtools     # adb forward tcp:9222 localabstract:chrome_devtools_remote
curl -s http://localhost:9222/json | grep -o '"url": "[^"]*"'
```

Then evaluate in the live page (see `scripts` in this repo, or `chrome://inspect`):

```js
(await navigator.serviceWorker.getRegistrations()).length   // >= 1
navigator.serviceWorker.controller                          // not null
isSecureContext                                             // true
await caches.keys()                                         // your cache names
```

**The real test:** turn wifi off on the headset, launch from the app library. If it runs, you
are done.

---

## 7. Gotchas, all measured on device

| Gotcha | Detail |
|---|---|
| **No `SpeechRecognition`** | The constructor is `undefined` in Quest Browser. Not a permission, not a setting — Meta never shipped the Web Speech API. Use cloud STT over a WebSocket |
| **No `speechSynthesis`** | Also `undefined`. Any browser text-to-speech fallback is silent on headset. Plan for real audio or on-screen text |
| **`getUserMedia` works, and survives an immersive session** | 1280×960 @30fps. Cameras enumerate as `0 front`, `1 back`, `2 back`. WebXR's `camera-access` feature is *not* supported — `getUserMedia` is the working door |
| **Heavy CPU work destroys an XR session** | A 72Hz session has a 13.9ms budget. This repo's OpenCV pass costs 87ms, which is fine in a 2D panel and nauseating inside a session. Offload to a Web Worker before going immersive |
| **`adb reverse` does not survive** | Unplug, reboot or deep sleep kills it. Re-run it. This is the cause of most "the page won't load" |
| **Keep the guardian enabled** | Disabling it in developer mode makes passthrough render **black** in recordings and casts, which silently ruins a demo video |
| **Quest 3S has no 3.5mm jack** | Quest 3 does. Use USB-C or an adapter for wired audio |

---

## 8. The fast path for a new app

When the real application lands:

```bash
cp -r public/manifest.webmanifest public/sw.js public/icons  <new-app>/public/
# edit the manifest's name/description
# add the <link> tags and the registration snippet
npm run build && npx vercel --prod
```

Then §5. The whole loop is a few minutes once the pipeline exists, which is the argument for
proving it with a throwaway app **before** the one that matters arrives.
