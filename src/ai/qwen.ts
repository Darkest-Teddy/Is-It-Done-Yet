/**
 * Qwen3, for the one job the rule engine genuinely cannot do: phrasing and prioritising
 * guidance for a cook who is stuck.
 *
 * What it is NOT used for is the same thing `src/ai/openai.ts` says in its header, and it
 * matters more here because this path can interrupt somebody unasked. `deficit.ts` decides
 * what is wrong. `timeline.ts` decides whether it has persisted. `nag.ts` decides whether it is
 * worth saying. All three are pure, tested and offline. The model is handed those conclusions
 * as text and asked to say them well. It is never asked whether the cook has made a mistake,
 * because a model looking at a scene description will happily invent one, and an invented
 * accusation is the single most expensive failure this feature has.
 *
 * TWO DOORS, AND THE FIRST ONE IS THE RIGHT ONE.
 *
 * `relay` posts to our own server, which holds the key. `.env.example` already warns that a
 * `VITE_`-prefixed key is inlined into the client bundle and readable by anyone who opens the
 * page, and this repo publishes a built app -- so a browser key is a booth-laptop convenience
 * and nothing more. The relay is `server/guidance.mjs`; the dev server mounts it too.
 *
 * `direct` posts to an OpenAI-compatible `/chat/completions` from the browser. It exists
 * because it is the fastest way to try this on a laptop with no server running, and because
 * some self-hosted endpoints (Ollama, vLLM) are on the same LAN as the headset anyway.
 *
 * NO PROVIDER IS HARDCODED. Qwen3 is served by Alibaba's DashScope OpenAI-compatible endpoint,
 * by OpenRouter, and by anything running vLLM or Ollama, and they differ in exactly two things
 * a client cares about: the base URL and the model id. Both are configuration. The request
 * body below is plain OpenAI chat-completions, which all four speak.
 *
 * Returns null rather than throwing, always. The caller has `localGuidance`, which is a
 * complete answer on its own, so a dead network costs phrasing and nothing else.
 */

export type QwenMode = 'relay' | 'direct';

export interface QwenConfig {
  readonly mode: QwenMode;
  /** Relay: the path or URL to POST to. Direct: the OpenAI-compatible base, without `/chat/...`. */
  readonly url: string;
  /** Empty in relay mode -- that is the point of relay mode. */
  readonly apiKey: string;
  readonly model: string;
  /** Per-request ceiling. A late answer is worse than no answer; see `localGuidance`. */
  readonly timeoutMs: number;
}

/** Where `server/guidance.mjs` is mounted, in both the dev server and the static server. */
export const DEFAULT_RELAY_PATH = '/api/guidance';

/**
 * UNVERIFIED. This is a plausible DashScope-style id and it has not been called from this repo.
 *
 * Model ids are the thing most likely to be stale in this file and they differ per provider for
 * the same weights -- DashScope lists bare ids, OpenRouter namespaces them (`qwen/...`), Ollama
 * uses a tag (`qwen3:8b`). Set `VITE_QWEN_MODEL` (or `QWEN_MODEL` on the relay) to whatever the
 * provider you chose actually lists, rather than debugging a 404 at the table. Same warning as
 * `DEFAULT_OPENAI_CONFIG.model` carries, for the same reason.
 */
export const DEFAULT_QWEN_MODEL = 'qwen3-32b';

export const DEFAULT_QWEN_TIMEOUT_MS = 6000;

/**
 * Reads the config out of the environment, preferring the relay.
 *
 * Returns null when nothing is configured, which is the normal state of a fresh checkout and is
 * not an error: the whole feature runs from `localGuidance` in that case. The caller must treat
 * null as "no model" and never as "broken".
 */
export function configFromEnv(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<
    string,
    string | undefined
  >,
): QwenConfig | null {
  const timeoutMs = Number.parseInt(env['VITE_QWEN_TIMEOUT_MS'] ?? '', 10);
  const common = {
    model: env['VITE_QWEN_MODEL'] ?? DEFAULT_QWEN_MODEL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_QWEN_TIMEOUT_MS,
  };

  const relay = env['VITE_GUIDANCE_RELAY'];
  if (relay !== undefined && relay !== '') {
    return { ...common, mode: 'relay', url: relay, apiKey: '' };
  }

  const apiKey = env['VITE_QWEN_API_KEY'];
  const baseUrl = env['VITE_QWEN_BASE_URL'];
  if (apiKey !== undefined && apiKey !== '' && baseUrl !== undefined && baseUrl !== '') {
    return { ...common, mode: 'direct', url: baseUrl.replace(/\/+$/, ''), apiKey };
  }

  return null;
}

/** Rejects on timeout rather than hanging, and aborts the request rather than leaking it. */
async function post(
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    // An abort is the timeout firing, which is expected on venue wifi and is not a bug.
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.info('[qwen] timed out, using the local answer');
    } else {
      console.warn('[qwen] call failed', error);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Digs the assistant message out of an OpenAI-shaped completion. */
function contentOf(body: unknown): string | null {
  const choices = (body as { choices?: { message?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}

/**
 * One round trip. Returns the raw assistant message, or null.
 *
 * Raw on purpose: Qwen3 is a hybrid-reasoning family and some servers deliver the reasoning
 * inside the message content as a `<think>` block. Cleaning that up is
 * `guidance.stripThinking`, which is pure and tested, so this file stays a transport and the
 * parsing stays provable.
 */
export async function askQwen(
  cfg: QwenConfig,
  system: string,
  user: string,
): Promise<string | null> {
  const response =
    cfg.mode === 'relay'
      ? await post(cfg.url, { system, user, model: cfg.model }, cfg.timeoutMs)
      : await post(
          `${cfg.url}/chat/completions`,
          {
            model: cfg.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.3,
            max_tokens: 400,
            // Widely supported; `json_schema` is not, across the four ways Qwen3 gets served,
            // which is why `parseModelGuidance` validates by hand instead of trusting a schema.
            response_format: { type: 'json_object' },
            // Qwen3's thinking switch. DashScope and recent vLLM builds read it; OpenRouter and
            // Ollama ignore an unknown field. UNVERIFIED against a live endpoint from here --
            // `stripThinking` is the defence that does not depend on it being honoured.
            enable_thinking: false,
          },
          cfg.timeoutMs,
          { authorization: `Bearer ${cfg.apiKey}` },
        );

  if (response === null) return null;
  if (!response.ok) {
    console.warn(
      `[qwen] ${response.status} ${response.statusText}`,
      await response.text().catch(() => ''),
    );
    return null;
  }

  try {
    const body: unknown = await response.json();
    // The relay hands back `{ content }` already unwrapped; a direct call hands back the full
    // completion. Accept either so the two modes are interchangeable to the caller.
    const direct = (body as { content?: unknown }).content;
    if (typeof direct === 'string' && direct.trim() !== '') return direct;
    return contentOf(body);
  } catch (error) {
    console.warn('[qwen] response was not JSON', error);
    return null;
  }
}
