/**
 * OpenAI, used for the two jobs a language model is genuinely better at than we are: phrasing
 * live guidance when the cook asks for it, and writing the debrief at the end.
 *
 * What it is NOT used for: deciding what is wrong. `kitchen.ts` already knows, exactly, because
 * every fault is derived from a recorded action rather than inferred from a picture. The model
 * is handed those facts as text and asked to reason about priority and phrasing. This is the
 * whole reason the virtual-interaction model is worth having -- there is no perception step for
 * it to hallucinate through, so it cannot tell the cook they added four tomatoes when they
 * added two.
 *
 * Every function returns null rather than throwing. The caller always has a local fallback:
 * `Deficit.instruction` is already a complete, usable sentence, so a dead network costs polish
 * and nothing else. Nothing here may ever block a render frame.
 *
 * SECURITY: a key in `VITE_` env is inlined into the client bundle and readable by anyone who
 * opens the page. Acceptable for a laptop at a booth; NOT safe for a hosted deployment. If this
 * is ever put on a public URL these calls must move behind a server that holds the key.
 */

import type { Deficit } from '../core/deficit.js';
import type { BowlState } from '../core/kitchen.js';
import type { Recipe } from '../core/recipe.js';
import type { Process } from '../core/steps.js';
import type { DeficitSpan } from '../core/timeline.js';

export type { DeficitSpan };

export interface OpenAIConfig {
  readonly apiKey: string;
  /**
   * Model id. OpenAI's naming moves fast and this is the likeliest thing here to be stale --
   * check it against the current model list rather than debugging a 404 at the table.
   */
  readonly model: string;
  readonly baseUrl: string;
  /** Guidance must never outlive its usefulness; a late answer is worse than no answer. */
  readonly timeoutMs: number;
}

export const DEFAULT_OPENAI_CONFIG: Omit<OpenAIConfig, 'apiKey'> = {
  model: 'gpt-4.1-mini',
  baseUrl: 'https://api.openai.com/v1',
  timeoutMs: 6000,
};

export function configFromEnv(
  env: Record<string, string | undefined> = import.meta.env as unknown as Record<string, string | undefined>,
): OpenAIConfig | null {
  const apiKey = env['VITE_OPENAI_API_KEY'];
  if (apiKey === undefined || apiKey === '') return null;
  return {
    ...DEFAULT_OPENAI_CONFIG,
    apiKey,
    ...(env['VITE_OPENAI_MODEL'] === undefined ? {} : { model: env['VITE_OPENAI_MODEL'] }),
  };
}

/**
 * One round trip, JSON in and JSON out.
 *
 * `strict: true` structured output is what stops the model wrapping its answer in prose or a
 * markdown fence -- the usual reason a parse fails in production but never in testing. Strict
 * mode requires every property to be listed in `required` and `additionalProperties: false`,
 * so the schemas below look more verbose than they need to be. They do not.
 */
async function call<T>(
  cfg: OpenAIConfig,
  system: string,
  user: string,
  schemaName: string,
  schema: unknown,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[openai] ${res.status} ${res.statusText}`, await res.text().catch(() => ''));
      return null;
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content;
    if (text === undefined || text === null) {
      console.warn('[openai] response carried no content');
      return null;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    // An abort is the timeout firing, expected under bad venue wifi and not a bug. Logged
    // quietly so it does not read as a failure during a demo.
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.info('[openai] timed out, using local fallback');
    } else {
      console.warn('[openai] call failed', err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Setup scan -- counting the counter
// ---------------------------------------------------------------------------------------------

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ingredient: { type: 'string' },
          count: { type: 'integer' },
          category: {
            type: 'string',
            enum: ['vegetable', 'fruit', 'herb', 'protein', 'dairy', 'grain', 'pantry', 'unknown'],
          },
          confidence: { type: 'number' },
        },
        required: ['ingredient', 'count', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['items', 'notes'],
  additionalProperties: false,
};

const SCAN_SYSTEM = `You count ingredients on a kitchen counter from a photograph, for a cooking app that will build a recipe list from your answer.

ACCURACY MATTERS MORE THAN COMPLETENESS. A miscount sends someone to start a dish they cannot
finish. Follow these rules exactly:

- Count individual units you can actually SEE. Four tomatoes visible means count 4. Do not
  estimate what might be behind something, and do not round to a tidy number.
- If items are piled, partly hidden, or you are unsure of the count, still give your best count
  but set "confidence" BELOW 0.7. The app asks the cook to confirm anything under 0.75, so a low
  score is not a failure — it is the correct answer when the photo is ambiguous. Over-confidence
  is the only unrecoverable mistake you can make here.
- Only list food. Ignore utensils, boards, bowls, packaging, hands and background.
- Use simple singular lowercase names: "tomato", "red onion", "cucumber". Not brands, not
  descriptions, not plurals.
- If you genuinely cannot identify something edible, use "unknown" as the category and give the
  plainest name you can, with low confidence.
- "notes" is one short sentence about anything that limited you — poor light, occlusion, a pile
  you could not resolve. Empty string if the photo was clear.`;

export interface ScannedItem {
  readonly ingredient: string;
  readonly count: number;
  readonly category: string;
  readonly confidence: number;
}

export interface CounterScan {
  readonly items: readonly ScannedItem[];
  /** What limited the scan, if anything. Shown to the cook alongside the confirm step. */
  readonly notes: string;
}

/** Strips any `data:` prefix and chunk-encodes, since spreading a photo blows the arg limit. */
async function toDataUrl(image: Blob): Promise<string> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = image.type === '' ? 'image/jpeg' : image.type;
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Counts and categorises the ingredients in one photograph of the counter.
 *
 * A single still rather than a live feed, deliberately. A one-shot scan can use a full-strength
 * vision model on a clean, well-framed frame, where a live loop would force a fast classifier
 * onto motion-blurred frames under whatever lighting the room has. It is both more accurate and
 * far cheaper, and it matches how the cook actually works: they set out ingredients once.
 *
 * `detail: 'high'` is the important flag. The default downsamples, and counting four tomatoes
 * apart from five is exactly the task that loses.
 */
export async function scanCounter(
  cfg: OpenAIConfig,
  image: Blob,
): Promise<CounterScan | null> {
  const url = await toDataUrl(image);
  const controller = new AbortController();
  // Scanning is a setup step behind a spinner, not a live loop, so it can afford real time.
  const timer = setTimeout(() => controller.abort(), Math.max(cfg.timeoutMs, 30_000));

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SCAN_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Count every ingredient you can see on this counter.' },
              { type: 'image_url', image_url: { url, detail: 'high' } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'counter_scan', strict: true, schema: SCAN_SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[openai:scan] ${res.status}`, await res.text().catch(() => ''));
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    return text === undefined || text === null ? null : (JSON.parse(text) as CounterScan);
  } catch (err) {
    console.warn('[openai:scan] failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Renders measured state as the plain text the model reasons over. */
function describe(
  recipe: Recipe,
  bowl: BowlState,
  deficits: readonly Deficit[],
  process: Process,
): string {
  const contents =
    bowl.contents.length === 0
      ? '  (empty)'
      : bowl.contents.map((t) => `  - ${t.count} x ${t.name}`).join('\n');

  const seasonings =
    bowl.seasonings.length === 0
      ? '  (none)'
      : bowl.seasonings.map((t) => `  - ${t.name}: ${t.count} pinches`).join('\n');

  const steps = process.steps
    .map((s) => {
      const mark =
        s.status === 'done' ? 'done'
        : s.status === 'awaiting-confirmation' ? 'unconfirmed'
        : s.status === 'unknown' ? 'not checkable'
        : 'outstanding';
      return `  - [${mark}] ${s.step.instruction}`;
    })
    .join('\n');

  const problems =
    deficits.length === 0
      ? '  (none — the bowl matches the recipe)'
      : deficits.map((d) => `  - ${d.severity}: ${d.instruction}`).join('\n');

  return `Recipe: ${recipe.name}
Progress: ${process.doneCount}/${process.totalCount} steps.

In the bowl:
${contents}

Seasoning:
${seasonings}

Dressing: ${bowl.dressingMl}ml
Tossed: ${Math.round(bowl.tossSeconds)}s
Tasted: ${bowl.tasteCount} times
Order added: ${bowl.order.length === 0 ? '(nothing yet)' : bowl.order.join(' -> ')}

Steps:
${steps}

Faults detected, most important first:
${problems}`;
}

// ---------------------------------------------------------------------------------------------
// Ask the chef -- the in-headset button
// ---------------------------------------------------------------------------------------------

export interface ChefAnswer {
  /** One short sentence, spoken to the cook. */
  readonly line: string;
  /** A sentence or two of why, shown on the panel. Empty when the bowl is fine. */
  readonly because: string;
  readonly tone: 'calm' | 'encouraging' | 'urgent';
}

const CHEF_SCHEMA = {
  type: 'object',
  properties: {
    line: { type: 'string' },
    because: { type: 'string' },
    tone: { type: 'string', enum: ['calm', 'encouraging', 'urgent'] },
  },
  required: ['line', 'because', 'tone'],
  additionalProperties: false,
};

const CHEF_SYSTEM = `You are a calm, expert chef standing at the shoulder of someone making a cold salad. They have just asked you what is wrong.

You are given FACTS about what they actually did — not observations, not guesses. Every number
is exact, because each came from a recorded action. Never contradict them, never invent a number
you were not given, and never claim to notice anything not listed.

"line" is ONE sentence under 15 words, spoken aloud, addressing the single most important
problem. No preamble, no lists. "because" is one or two sentences explaining why it matters to
the finished dish — teach, do not just instruct.

If nothing is wrong, say so warmly and briefly and leave "because" empty.`;

/**
 * Answers the cook's "what am I missing?" — the button in the headset.
 *
 * Falls back to the top fault's own instruction on any failure. That string is already a
 * complete sentence written for the cook, so offline is a blunter chef rather than a broken one.
 */
export async function askChef(
  cfg: OpenAIConfig,
  recipe: Recipe,
  bowl: BowlState,
  deficits: readonly Deficit[],
  process: Process,
): Promise<ChefAnswer | null> {
  return call<ChefAnswer>(
    cfg,
    CHEF_SYSTEM,
    describe(recipe, bowl, deficits, process),
    'chef_answer',
    CHEF_SCHEMA,
  );
}

// ---------------------------------------------------------------------------------------------
// The debrief
// ---------------------------------------------------------------------------------------------

export interface SessionReport {
  readonly headline: string;
  readonly whatWentWell: readonly string[];
  readonly whatToFix: readonly string[];
  /** The single highest-value thing to practise next. */
  readonly nextTime: string;
  /** 0-100. The model's judgement, shown beside the mechanical score, not instead of it. */
  readonly grade: number;
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    whatWentWell: { type: 'array', items: { type: 'string' } },
    whatToFix: { type: 'array', items: { type: 'string' } },
    nextTime: { type: 'string' },
    grade: { type: 'number' },
  },
  required: ['headline', 'whatWentWell', 'whatToFix', 'nextTime', 'grade'],
  additionalProperties: false,
};

const REPORT_SYSTEM = `You write a short debrief for someone who has just finished making a salad, from a measured timeline.

You get every fault detected, when it appeared, and when they fixed it. Reason about the
TIMELINE, not just the end state: something fixed in five seconds is a different story from
something that stood for four minutes, and something never fixed is different again.

Quote the measured numbers. Be warm but honest — never invent praise. Two to four bullets per
list. "grade" is 0-100 and should reflect severity and how long faults stood, not fault count.`;

export async function report(
  cfg: OpenAIConfig,
  recipe: Recipe,
  spans: readonly DeficitSpan[],
  durationMs: number,
): Promise<SessionReport | null> {
  const timeline =
    spans.length === 0
      ? '(no faults were ever detected)'
      : spans
          .map((s) => {
            const at = (s.firstSeenMs / 1000).toFixed(0);
            const held =
              s.clearedMs === null
                ? 'NEVER FIXED'
                : `fixed after ${((s.clearedMs - s.firstSeenMs) / 1000).toFixed(0)}s`;
            return `  - [${s.severity}] ${s.instruction} (appeared at ${at}s, ${held})`;
          })
          .join('\n');

  return call<SessionReport>(
    cfg,
    REPORT_SYSTEM,
    `Recipe: ${recipe.name}
Session length: ${(durationMs / 1000).toFixed(0)}s

Timeline:
${timeline}`,
    'session_report',
    REPORT_SCHEMA,
  );
}
