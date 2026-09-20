/**
 * Every knob the server has, read once from the environment.
 *
 * Read once rather than per-request so that a misconfiguration is a startup failure with a
 * readable message instead of a 500 an hour into a demo. The defaults are chosen for the
 * hackathon case: no account, no cluster, `npm run dev` works on a laptop with nothing
 * installed.
 */

import { randomBytes } from 'node:crypto';

/**
 * The default coach model.
 *
 * Groq's currently documented vision model: a 27B open-weight Qwen multimodal, 131K context,
 * JSON mode, 3 images per request at 2048 tokens each. Named here rather than inline so the
 * one place to change it when Groq retires it is obvious -- they do retire them, and a stale
 * id fails as a 404 from the upstream, which the coach reports as "offline".
 */
export const DEFAULT_COACH_MODEL = 'qwen/qwen3.8-27b';

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
    /**
     * A separate, tighter bucket for the LLM routes, because those cost money per call. A
     * headset posts a frame every ~3s -- 20 a minute -- so this is room for two of them plus a
     * scan or two, and far short of what a loop could spend.
     */
    rateLimitMaxCoachCalls: num(env.RATE_LIMIT_MAX_COACH, 60),
    /** Optional. When set, POST /api/recipes demands `x-api-key`. Scores stay open. */
    writeKey: blank(env.WRITE_KEY) ? null : env.WRITE_KEY,

    /**
     * The coach's upstream.
     *
     * Note what is NOT here: the API key. `apiKeyEnvName` is the NAME of the variable that
     * holds it, and `src/llm.js` reads `process.env[name]` at call time. A config object that
     * never contains the key cannot leak it through a log line, an error report, or the health
     * endpoint -- and every one of those has leaked a key for somebody at some point.
     */
    llm: {
      primary: {
        baseUrl: blank(env.LLM_BASE_URL) ? 'https://api.groq.com/openai/v1' : env.LLM_BASE_URL,
        model: blank(env.COACH_MODEL) ? DEFAULT_COACH_MODEL : env.COACH_MODEL,
        apiKeyEnvName: blank(env.LLM_API_KEY_ENV_NAME) ? 'GROQ_API_KEY' : env.LLM_API_KEY_ENV_NAME,
        /**
         * Instruct mode. Qwen 3.8 ships thinking and instruct in one model and defaults to
         * thinking; a chain of thought in front of four JSON fields costs seconds the 3-second
         * coach loop does not have. Set LLM_REASONING_EFFORT empty to omit the field for a
         * provider that rejects it.
         */
        reasoningEffort: env.LLM_REASONING_EFFORT === undefined ? 'none'
          : env.LLM_REASONING_EFFORT.trim() === '' ? null
          : env.LLM_REASONING_EFFORT.trim(),
      },
      /** A second provider, tried only when the first fails. Absent unless a base URL is set. */
      fallback: blank(env.LLM_FALLBACK_BASE_URL) ? null : {
        baseUrl: env.LLM_FALLBACK_BASE_URL,
        model: blank(env.LLM_FALLBACK_MODEL) ? DEFAULT_COACH_MODEL : env.LLM_FALLBACK_MODEL,
        apiKeyEnvName: blank(env.LLM_FALLBACK_API_KEY_ENV_NAME) ? 'LLM_FALLBACK_API_KEY' : env.LLM_FALLBACK_API_KEY_ENV_NAME,
        reasoningEffort: blank(env.LLM_FALLBACK_REASONING_EFFORT) ? null : env.LLM_FALLBACK_REASONING_EFFORT.trim(),
      },
      /**
       * Shorter than it looks. The headset posts a frame every ~3s and drops any frame while a
       * request is in flight, so a 12s timeout already means three skipped frames -- past that
       * the advice is about a pan that has moved on.
       */
      timeoutMs: num(env.LLM_TIMEOUT_MS, 12_000),
      maxRetries: num(env.LLM_MAX_RETRIES, 2),
      /** Guard on the decoded image. 60KB is what the headset aims for; this is the ceiling. */
      maxImageBytes: num(env.LLM_MAX_IMAGE_BYTES, 400_000),
    },

    /**
     * HMAC key for session tokens. Random per boot when unset, which is the right default:
     * tokens then die with the process instead of being signed by a key that shipped in a
     * repository. Set it only when running more than one instance behind a load balancer.
     */
    sessionSecret: blank(env.SESSION_SECRET) ? randomBytes(32).toString('hex') : env.SESSION_SECRET,
    /** Floor on any run, before the recipe's own timed steps are considered. */
    minRunSeconds: num(env.MIN_RUN_SECONDS, 20),
    maxRunSeconds: num(env.MAX_RUN_SECONDS, 4 * 60 * 60),
    /** Recorded sessions expire. They hold photographs of somebody's kitchen. */
    sessionTtlDays: num(env.SESSION_TTL_DAYS, 7),
  };
}
