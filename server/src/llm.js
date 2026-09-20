/**
 * One OpenAI-compatible chat client, pointed wherever the environment says.
 *
 * Provider-agnostic on purpose. Groq is the default because it serves an open-weight
 * multimodal model fast enough to sit in a 3-second loop, but nothing in this file knows that:
 * it speaks `/chat/completions` and reads a base URL, a model name and a key out of config. A
 * second provider is the same object with different strings.
 *
 * The API key is never in config and never in a log line. Config carries the NAME of the
 * environment variable; the key is read from `process.env` at call time and passed straight to
 * `fetch`. That means a config dump, an error report or a `JSON.stringify(config)` in a hurry
 * cannot leak it.
 */

/** Thrown for anything the caller might retry or fall back from. Carries no response body. */
export class LlmError extends Error {
  constructor(message, { status = null, retryable = false, provider = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 429 and 5xx are worth another go; 400 and 401 are not.
 *
 * A 400 from a vision endpoint is almost always the image -- too big, wrong mime, too many --
 * and retrying it just spends the same seconds again before failing the same way.
 */
const isRetryableStatus = (status) => status === 429 || status === 408 || status >= 500;

/**
 * Full jitter, capped.
 *
 * Deterministic backoff from a headset that posts on a fixed 3-second timer would line every
 * retry up with every other retry. `random` is injectable so the tests are not.
 */
function backoffMs(attempt, retryAfterSec, random) {
  if (retryAfterSec !== null) return Math.min(retryAfterSec * 1000, 8_000);
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return Math.round(random() * ceiling);
}

function retryAfterSeconds(headers) {
  const raw = headers?.get?.('retry-after');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * One provider: where to send, which model, and which env var holds the key.
 *
 * @param {object} spec
 * @param {string} spec.baseUrl
 * @param {string} spec.model
 * @param {string} spec.apiKeyEnvName
 * @param {string|null} spec.reasoningEffort
 */
export function createProvider(spec, { env = process.env, fetchImpl = fetch, random = Math.random } = {}) {
  const baseUrl = spec.baseUrl.replace(/\/+$/, '');

  return {
    name: spec.name,
    model: spec.model,
    /** True when the key is actually present. Checked before a call, reported by /api/health. */
    get configured() {
      const key = env[spec.apiKeyEnvName];
      return typeof key === 'string' && key.trim() !== '';
    },

    /**
     * @param {object} req
     * @param {Array} req.messages  OpenAI chat messages, image parts included.
     * @param {boolean} [req.json]  Ask for `response_format: json_object`.
     * @param {number} [req.maxTokens]
     * @param {number} [req.timeoutMs]
     * @param {number} [req.maxRetries]
     * @returns {Promise<string>} the assistant's message content
     */
    async chat({ messages, json = true, maxTokens = 700, temperature = 0.1, timeoutMs, maxRetries }) {
      const key = env[spec.apiKeyEnvName];
      if (typeof key !== 'string' || key.trim() === '') {
        throw new LlmError(`${spec.apiKeyEnvName} is not set`, { retryable: false, provider: spec.name });
      }

      const body = {
        model: spec.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      };
      if (json) body.response_format = { type: 'json_object' };
      /**
       * Instruct mode, not thinking mode.
       *
       * Qwen 3.8 on Groq ships both in one model and defaults to thinking. A chain of thought
       * in front of the JSON costs seconds and tokens for a task that is "look at this pan and
       * fill in four fields" -- and the coach loop has a 3-second budget for the whole round
       * trip. `reasoning_effort: "none"` is the documented switch. Set LLM_REASONING_EFFORT
       * empty to omit the field entirely for a provider that rejects it.
       */
      if (spec.reasoningEffort !== null) body.reasoning_effort = spec.reasoningEffort;

      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(backoffMs(attempt - 1, lastError?.retryAfterSec ?? null, random));

        /**
         * A timeout per attempt, not per call, and always cleared.
         *
         * An AbortController whose timer is never cleared keeps the event loop alive for the
         * full duration after a fast success, which turns `npm test` into a process that will
         * not exit.
         */
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
          response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          lastError = new LlmError(
            error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'network error',
            { retryable: true, provider: spec.name },
          );
          continue;
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          // The body is read and discarded rather than surfaced: an upstream error body can
          // echo the request, and the request contains a photograph of somebody's kitchen.
          await response.text().catch(() => '');
          lastError = new LlmError(`upstream ${response.status}`, {
            status: response.status,
            retryable,
            provider: spec.name,
          });
          lastError.retryAfterSec = retryAfterSeconds(response.headers);
          if (!retryable) throw lastError;
          continue;
        }

        let payload;
        try {
          payload = await response.json();
        } catch {
          lastError = new LlmError('upstream returned non-JSON', { retryable: true, provider: spec.name });
          continue;
        }

        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          lastError = new LlmError('upstream returned an empty completion', { retryable: true, provider: spec.name });
          continue;
        }
        return content;
      }

      throw lastError ?? new LlmError('exhausted retries', { retryable: true, provider: spec.name });
    },
  };
}

/**
 * The primary provider, and the fallback if one is configured.
 *
 * `call` tries primary, then fallback, then gives up. Giving up is not an error the caller has
 * to handle as an exception -- see `src/coach.js`, which turns it into an honest "coach
 * offline" answer, because a coach that is quiet is a usable app and a 500 is not.
 */
export function createLlm(config, deps = {}) {
  const primary = createProvider({ name: 'primary', ...config.llm.primary }, deps);
  const fallback = config.llm.fallback === null
    ? null
    : createProvider({ name: 'fallback', ...config.llm.fallback }, deps);

  return {
    primary,
    fallback,
    get configured() {
      return primary.configured || (fallback !== null && fallback.configured);
    },
    /** Which upstreams are live, for /api/health. No keys, no URLs with credentials in them. */
    describe() {
      return {
        primary: { model: primary.model, configured: primary.configured },
        fallback: fallback === null ? null : { model: fallback.model, configured: fallback.configured },
      };
    },
    async chat(request) {
      const options = {
        timeoutMs: config.llm.timeoutMs,
        maxRetries: config.llm.maxRetries,
        ...request,
      };
      try {
        if (!primary.configured && fallback !== null) throw new LlmError('primary not configured', { retryable: true });
        return { text: await primary.chat(options), provider: primary.name, model: primary.model };
      } catch (primaryError) {
        if (fallback === null || !fallback.configured) throw primaryError;
        console.warn(`[llm] primary failed (${primaryError.message}) -- trying fallback`);
        return { text: await fallback.chat(options), provider: fallback.name, model: fallback.model };
      }
    },
  };
}
