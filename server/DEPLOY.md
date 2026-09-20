# Deploying the API

The front end is served over HTTPS from GitHub Pages, so **the API must be HTTPS too**. A
browser will not let an `https://` page call an `http://` API, and the failure appears in the
console as a mixed-content block rather than as anything about the server.

Nothing here is required to develop. With no `MONGODB_URI` the server runs its own MongoDB --
see [README](./README.md).

---

## 1. A database (MongoDB Atlas, free tier)

The free **M0** shared cluster is enough: this stores a few hundred small documents.

1. <https://cloud.mongodb.com> → **Create** → **M0 Free**. Pick the region nearest the venue.
2. **Database Access** → **Add New Database User** → password auth. Generate a password, keep
   it out of chat and out of the repo.
3. **Network Access** → **Add IP Address**.
   - For a weekend: `0.0.0.0/0` ("allow access from anywhere"). This is the pragmatic hackathon
     choice and it is genuinely open — anyone holding the username and password can connect
     from any address on the internet.
   - **Tighten this afterwards** to the host's egress addresses, or delete the cluster.
4. **Connect** → **Drivers** → copy the `mongodb+srv://...` string and put your password in it.

Via the CLI instead, if you have one and are logged in (`atlas auth login`):

```bash
atlas clusters create isitdone --tier M0 --provider AWS --region US_EAST_1
atlas dbusers create --username isitdone_app --role readWrite@isitdone   # prompts for a password
atlas accessLists create 0.0.0.0/0 --comment "hackathon - tighten later"
atlas clusters connectionStrings describe isitdone
```

Put the result in `server/.env` (gitignored). Never in `render.yaml`, a workflow file, or any
`VITE_`-prefixed variable — anything `VITE_` is compiled into the public bundle.

## 2. The service

### Render (blueprint included)

`render.yaml` is at the repo root and already sets `rootDir: server`, the health check and
`TRUST_PROXY=1`.

1. <https://dashboard.render.com> → **New** → **Blueprint** → pick this repository.
2. It prompts for `MONGODB_URI` (marked `sync: false`, so it is never in the repo). Paste it.
3. Confirm `ALLOWED_ORIGIN` is your Pages origin, **origin only**:
   `https://darkest-teddy.github.io` — no `/Is-It-Done-Yet` on the end. A path there can never
   match the `Origin` header a browser sends, and it reads as CORS being broken.
4. Deploy. Then seed once, from the Render shell or locally against the same URI:

```bash
cd server
MONGODB_URI='...' npm run seed
```

### Fly.io / Railway / anything that takes a container

`server/Dockerfile` is multi-stage, runs as the `node` user, and installs production
dependencies only.

```bash
cd server
fly launch --no-deploy            # or: railway init
fly secrets set MONGODB_URI='...' ALLOWED_ORIGIN='https://darkest-teddy.github.io' TRUST_PROXY=1
fly deploy
```

Whatever the host, set: `MONGODB_URI`, `ALLOWED_ORIGIN`, `TRUST_PROXY=1`, and optionally
`DB_NAME`, `RATE_LIMIT_MAX_WRITES`, `WRITE_KEY`.

## 3. Point the front end at it

`VITE_API_URL` is read at **build** time, not at runtime — changing it means rebuilding.

Locally:

```bash
VITE_API_URL=https://is-it-done-yet-api.onrender.com npm run build:pages
```

For the GitHub Pages build, set it as a repository **variable** (not a secret; it is a public
URL and secrets are not exposed to `vars`):

```bash
gh variable set VITE_API_URL --body 'https://is-it-done-yet-api.onrender.com'
```

Any deploy workflow needs it passed through to the build step:

```yaml
- run: npm run build:pages
  env:
    VITE_API_URL: ${{ vars.VITE_API_URL }}
```

With `VITE_API_URL` unset the app still runs: the recipe book falls back to the bundled
built-in recipes and the leaderboard shows the local booth board instead of the global one.

## 4. Check it

```bash
curl -s https://YOUR-API/api/health
curl -s 'https://YOUR-API/api/recipes?limit=3' | head -c 400
curl -s -X POST https://YOUR-API/api/scores \
  -H 'content-type: application/json' \
  -d '{"name":"smoke","score":42.5}'
curl -s 'https://YOUR-API/api/leaderboard?limit=5'
```

The first request after idle on Render's free plan takes ~30s while the instance wakes. The
front-end client has a timeout well under that, so **warm the API before judging** by loading
any endpoint once.

## 5. Moderation

```bash
cd server
MONGODB_URI='...' npm run hide -- 6aaf44195e2d75fccb8561d9
MONGODB_URI='...' npm run unhide -- 6aaf44195e2d75fccb8561d9
```

Get the id from the `POST /api/scores` response, or from the `scores` collection.
