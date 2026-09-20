# `server/` — recipe book and leaderboard API

Express 5 + MongoDB. Its own package, its own lockfile, no build step.

## Run it, with nothing installed

```bash
cd server
npm install
npm run dev
```

With `MONGODB_URI` unset the server starts an **embedded MongoDB** (`mongodb-memory-server`,
a devDependency), keeps its data in `server/.data/` (gitignored) so a restart does not lose the
board, seeds the built-in recipes, and listens on `:3000`.

There is nothing to sign up for. To use a real cluster instead, put `MONGODB_URI` in
`server/.env` — see [`.env.example`](./.env.example) and [`DEPLOY.md`](./DEPLOY.md). A local
`mongod` in Docker is a third option: `docker compose up -d`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Serve the API. Embedded database when `MONGODB_URI` is unset. |
| `npm run seed` | Upsert the built-in recipes by slug. Idempotent. |
| `npm test` | Vitest + supertest against a real in-memory MongoDB. |
| `npm run smoke` | Start on a random port, seed, post scores including a tie, print the real responses. |
| `npm run recipes:export` | Regenerate `src/builtin-recipes.json` from `src/core/recipe.ts`. |
| `npm run hide -- <id>` | Take a score off the public board. |
| `npm run unhide -- <id>` | Put it back. |

## API

| | |
|---|---|
| `GET /api/health` | `{ ok, db, time }`. Pings Mongo, so it fails when the database is unreachable. |
| `GET /api/recipes?q=&tag=&limit=` | `limit` caps at 50. `q` matches title, tags and ingredient names, whole word or partial. |
| `GET /api/recipes/:idOrSlug` | One recipe. 404 on an unknown slug or a malformed id. |
| `POST /api/recipes` | Validated, rate-limited, `source` forced to `user`. 409 on a duplicate slug. `x-api-key` required when `WRITE_KEY` is set. |
| `POST /api/scores` | `{ name, score, metrics?, recipeSlug? }` → `201 { id, rank, total }`. |
| `GET /api/leaderboard?limit=20&offset=0` | `{ entries: [{ rank, name, score, createdAt }], total, limit, offset }`. Score descending, earlier submission wins a tie. Hidden rows excluded. |

Errors are always `{ error: { code, message, details? } }`. Never a stack trace.

## The two collections

**`recipes`** — unique index on `slug`, text index on `title` + `tags`. The document shape is a
recipe card (`ingredients: [{ name, quantity, unit, notes? }]`, `steps: [{ order, text,
durationSec?, technique? }]`) plus the coach fields that `src/core/recipe.ts` needs: per-step
`stepId`/`verifiable`/`satisfies`, and a `coach` object holding `difficulty`, `icon`,
`averageMinutes`, `minMixRatio` and the measurable `requires` claims. That is what makes the
round trip lossless without a second recipe model.

`src/builtin-recipes.json` is **generated** from `src/core/recipe.ts` (the three CaptainCook4D
dishes) and `src/core/recipes.ts` (the ten cutting tickets, as `cut-<id>`). It is committed
because the Docker build context is `server/` only. `npm test` fails if it has drifted.

**`scores`** — `{ name, score, metrics?, recipeSlug?, hidden, createdAt }`, compound index
`{ hidden: 1, score: -1, createdAt: 1 }` matching the leaderboard sort exactly.

## What is stored about a person

A name they typed and a number. **No IP address, no user agent, no account, no identifier of
any kind** — there is a test asserting exactly that, on the response and on the stored
document. Rate-limit counters are per-address and in memory only; they are never written down
and they vanish on restart.

Names are NFKC-normalised, stripped of control and zero-width characters, reduced to
`[A-Za-z0-9 ._-]`, capped at 20 characters, and run past a small blocklist. The client renders
them as text, never as HTML.

## Limits worth stating

Scores arrive from the client, so validation and rate limits deter casual abuse and nothing
more — anyone with the developer console can post any number. The fix is a server-issued
session token tying a score to a real session with a minimum duration; it is not built.

The board shows names publicly. `npm run hide` takes a row down without destroying it.
