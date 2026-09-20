# Is It Done Yet — the Quest 3S mixed-reality cooking coach

A headset app that watches your counter through the passthrough cameras, walks you through a
recipe, and tells you what it can see. The score is computed locally and deterministically; the
commentary comes from an open-weight vision model running behind your own server.

**The two things this app says about itself, up front:**

- **Heat is an estimate.** There is no thermometer anywhere in this system. Heat is inferred
  from colour, smoke and bubbling in a camera frame, and the UI shows it as a band whose width
  is the uncertainty — never a needle. Trust your own eyes over it.
- **Take the headset off for anything sharp or hot.** Do not wear it near an open flame, near
  hot oil, or while cutting. Set the pan down, then look. The app enforces this as far as
  software can: any step flagged hot or knife collapses the HUD to a small, calm, motionless
  pill.

---

## Setup

### 1. The server

```bash
cd server
npm install
cp .env.example .env     # then edit it — see below
npm run dev              # :3000, with an embedded MongoDB if MONGODB_URI is unset
npm test                 # 192 tests, no network, no API calls
```

With `MONGODB_URI` unset the server starts its own MongoDB and seeds it, so a fresh checkout
runs with nothing else installed.

#### Environment

Everything has a working default except the model key. Full annotated list in
`server/.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `MONGODB_URI` | *(unset)* | Atlas or any mongod. Unset starts an embedded one. |
| `PORT` | `3000` | |
| `ALLOWED_ORIGIN` | *(empty)* | Comma-separated **origins**, never paths. Empty means any, which is right locally and wrong in production. |
| `TRUST_PROXY` | `false` | Set to `1` behind Render/Railway/Fly, or the rate limiter buckets the whole venue under the proxy's address. |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible `/chat/completions`. |
| `LLM_API_KEY_ENV_NAME` | `GROQ_API_KEY` | The **name** of the variable holding the key. The key itself never enters the config object. |
| `GROQ_API_KEY` | *(unset)* | **You set this in `server/.env`.** Without it the coach reports offline and everything else works. |
| `COACH_MODEL` | `qwen/qwen3.8-27b` | Groq's currently documented vision model. They retire models — check <https://console.groq.com/docs/vision> when the coach starts 404ing. |
| `LLM_REASONING_EFFORT` | `none` | Instruct mode. Qwen 3.8 defaults to thinking, and a chain of thought in front of four JSON fields costs seconds the 3-second loop lacks. |
| `SESSION_SECRET` | *(random per boot)* | Only set it when running more than one instance. |
| `MIN_RUN_SECONDS` | `20` | Floor on any run, before the recipe's own timed steps. |
| `SESSION_TTL_DAYS` | `7` | Recorded sessions hold photos of a kitchen. They expire. |

### 2. Expose it over HTTPS

A Quest blocks cleartext HTTP by default, so a headset cannot reach `http://localhost:3000`.
Either run a tunnel (`cloudflared tunnel --url http://localhost:3000`, `ngrok http 3000`) and
paste the HTTPS URL into `ApiClient.BaseUrl`, or add a network security config permitting
cleartext to your LAN address. The tunnel is less work and is what the demo uses.

### 3. The Unity project

Unity Hub → **Add → Add project from disk** → `<repo>/unity`. Editor **6000.6.2f1**.

Then, once:

```bash
tools/unity/compile.sh -executeMethod IsItDoneYet.Design.Editor.FontAssetBuilder.BuildAllBatch
```

That bakes the SDF atlases and imports `design/tokens.json`. Quit the Editor first — batchmode
cannot take the project lock from a running one.

Set `ApiClient.BaseUrl` to your server, then **Build And Run** with the Meta Quest build
profile.

---

## The API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Which coach model is configured, and whether a key is present. Never the key. |
| `GET` | `/api/recipes` | `?q=` substring + full-text, `?tag=`, `?limit=` |
| `GET` | `/api/recipes/:idOrSlug` | |
| `POST` | `/api/recipes` | Validated; `source` is forced to `user`. |
| `POST` | `/api/sessions/start` | Issues the session id and HMAC token a score needs. |
| `POST` | `/api/sessions` | Stores a recorded run: events, coach results, ≤20 thumbnails ≤25KB. TTL indexed. |
| `GET` | `/api/sessions/:id` | Reads one back for the replay screen. |
| `POST` | `/api/scores` | Requires a valid, unconsumed, old-enough session. |
| `GET` | `/api/leaderboard` | `?limit=`, `?offset=` |
| `POST` | `/api/coach/analyze` | Image + step + rubric → validated observations. Never 5xx. |
| `POST` | `/api/recipes/scan` | Image → an editable **draft**. Saves nothing. |
| `POST` | `/api/ingredients/check` | Image + wanted list → what it can see. |

The three coach routes answer `200` with `offline: true` when the model is unreachable, rather
than an error status — the headset's scoring is local, so losing the coach costs commentary and
an error status would make a talkative feature look broken.

---

## A two-minute demo

**0:00 — hand them the headset.** Onboarding is four cards. Let them read the camera card and
the "heat is a guess" card; do not narrate over them.

**0:20 — the recipe shelf.** Cards curve around them, covers drawn procedurally. Pick
something short.

**0:35 — the checklist.** Put two of the ingredients on the counter and leave one off. Within
about eight seconds the two go green with a drawn check; the third stays amber. Say the line
that matters: *amber means the camera cannot see it, not that you do not have it.*

**1:00 — start the run.** Step rail on the left, timer ring with the min-to-max window as a
coloured band. Let a step run under its minimum and finish it early — the score docks, and the
dock **names its reason** under the number.

**1:20 — the hot step.** The HUD collapses to one calm pill, motion stops, the palette goes
gold. This is the beat worth pausing on: it is the app getting out of the way, and it happens
without being asked.

**1:40 — cover the pan with your hand.** The coach says *"Can't see the pan"* rather than
guessing. Then uncover it and let two frames agree before it speaks again.

**1:55 — finish.** The score submits, the board on the wall animates the rank change.

**If the wifi is dead:** do the whole thing anyway. The only difference is the coach saying it
is offline. Say that out loud — it is the most interesting thing about the architecture.

---

## Known limits

Stated plainly, because most of these are visible in a two-minute demo.

- **Heat is an estimate from visual cues.** No thermometer. The gauge shows a band, and it
  widens when the model is unsure.
- **Client scores can be faked.** The score is computed on the headset, so anyone who can run a
  proxy can post any number with a valid token. The session token stops the cheap version — a
  loop posting 9,999 at a URL read off the network tab — and nothing more. Real defence needs
  server-side scoring over the whole event log.
- **Frames leave the device.** Every ~3 seconds a 512px JPEG of your counter goes to your
  server and on to a model provider. Nothing is stored on the headset; recorded sessions expire
  after 7 days. Consent is asked for once, explained first, and revocable from the menu at any
  time — everything except the commentary keeps working without it.
- **The headset camera is not a good camera.** It is fixed exposure, wide angle, and moves with
  your head. Motion blur while you are looking around is normal and the model will say it
  cannot see things.
- **Model availability changes.** Groq retires models. When the coach starts reporting offline,
  check `/api/health` and then <https://console.groq.com/docs/vision>.
- **Names are ASCII only.** The board's filter drops anything else, which excludes anyone whose
  name is not written in Latin script. Widen it the same day the font atlas does.
- **`unity/Assets/Scripts/Perception/` does not compile** and is not meant to. It needs OpenCV
  for Unity, which is not in this repository. See `unity/PROJECT.md`.

## What has not been verified

- **Nothing here has run on a headset.** It compiles, tests pass, and an Android development
  APK builds. That is all.
- No real LLM call has been made. Every test uses a fixture; the suite never touches a network.
- The Meta XR Simulator has not been run against this build.
- No frame time, draw-call count or thermal behaviour has been measured on a device.
- Legibility over real passthrough is untested. The design previews are orthographic renders
  against a flat ground.

## Layout

```
design/      tokens, reference captures, icons, fonts, previews, deviations
server/      Node API: recipes, leaderboard, sessions, the three coach routes
tools/       design extraction (Playwright, sharp) and Unity batchmode wrappers
unity/       the Quest project
  Assets/IsItDoneYet/Core/     framework-light, terminal-testable
  Assets/IsItDoneYet/Design/   tokens, themes, shaders, components, gallery
  Assets/IsItDoneYet/App/      frames, network, HUD, features
  Assets/IsItDoneYet/Audio/    procedurally synthesised sound
  Assets/IsItDoneYet/Tests/    142 EditMode tests
```
