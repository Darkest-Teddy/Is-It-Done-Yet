/**
 * Every knob the server has, read once from the environment.
 *
 * Read once rather than per-request so that a misconfiguration is a startup failure with a
 * readable message instead of a 500 an hour into a demo. The defaults are chosen for the
 * hackathon case: no account, no cluster, `npm run dev` works on a laptop with nothing
 * installed.
 */

/** Units an ingredient quantity may carry. Fixed so the UI can render a `<select>`. */
export const UNITS = ['g', 'ml', 'tsp', 'tbsp', 'cup', 'piece', 'pinch'];

/** Where a recipe came from. `user` is anything POSTed; the API never lets a client claim more. */
export const SOURCES = ['builtin', 'user', 'captaincook4d'];

/** Unset and empty are the same thing everywhere in this file. */
const blank = (raw) => raw === undefined || raw.trim() === '';

const num = (raw, fallback) => {
  if (blank(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`expected a number, got ${JSON.stringify(raw)}`);
  return value;
};

/**
 * Splits ALLOWED_ORIGIN into an origin list.
 *
 * Origins only -- scheme, host and port, never a path. A browser sends `Origin:
 * https://example.github.io`, so an entry with a trailing path or slash can never match and the
 * failure looks like CORS being broken rather than being misconfigured. Trailing slashes are
 * stripped rather than rejected because pasting one is the single most common mistake here.
 */
export function parseOrigins(raw) {
  if (blank(raw)) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s !== '');
}

export function loadConfig(env = process.env) {
  return {
    /**
     * Empty counts as unset, not as a connection string.
     *
     * `.env.example` ships `MONGODB_URI=` so the variable is visible and obviously optional,
     * and dotenv reads that as `''`. Without this the driver is handed an empty string and the
     * process dies on "Invalid scheme" -- which reads as the URI being wrong rather than absent,
     * and skips the embedded database that was supposed to be the whole zero-setup story.
     */
    mongoUri: blank(env.MONGODB_URI) ? null : env.MONGODB_URI,
    dbName: blank(env.DB_NAME) ? 'isitdone' : env.DB_NAME,
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGIN),
    port: num(env.PORT, 3000),
    /**
     * Passed straight to Express. Behind Render, Railway or Fly this must be set (`1` is right
     * for a single proxy) or express-rate-limit buckets every visitor into one key -- the proxy's
     * -- and the first ten writes lock out the venue.
     */
    trustProxy: blank(env.TRUST_PROXY) ? false
      : env.TRUST_PROXY === 'true' ? true
      : env.TRUST_PROXY === 'false' ? false
      : num(env.TRUST_PROXY, 0),
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
    /**
     * Deliberately generous. A hackathon venue NATs hundreds of people behind one address, so a
     * per-IP limit tuned for the open internet reads to the room as the leaderboard being down.
     * This deters a script, not a determined person; see the note in the PR description.
     */
    rateLimitMaxWrites: num(env.RATE_LIMIT_MAX_WRITES, 120),
    /** Optional. When set, POST /api/recipes demands `x-api-key`. Scores stay open. */
    writeKey: blank(env.WRITE_KEY) ? null : env.WRITE_KEY,
  };
}
