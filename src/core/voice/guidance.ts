/**
 * The answer a stuck cook gets, and the three channels it is delivered through.
 *
 * Master spec 9.2 wants a chef with tool access to live game state. Entry 16 in DECISIONS.md
 * already inverted the default for *commands*: match locally first, ask a model only for what
 * the table cannot answer. This file does the same thing for *guidance*, which is a harder
 * case, because "I don't know what to do next" genuinely has no table entry -- the answer
 * depends on the recipe, the step, what is on the counter and what the camera last saw.
 *
 * So the split here is not local-or-model, it is local-THEN-model:
 *
 *   `localGuidance` always produces a complete, honest answer from `steps.ts` and `deficit.ts`.
 *   It is never a placeholder. With no key, no relay and no network it is the whole feature.
 *
 *   A Qwen3 reply, when one arrives inside its timeout, REPLACES that answer wholesale. It is
 *   better phrasing and better prioritisation over the same facts, not a different source of
 *   truth, and it is never waited for.
 *
 * ONE ANSWER, THREE CHANNELS, AND WHY THEY ARE ONE OBJECT.
 *
 * The cook hears `speech`, sees `overlay` pinned over the real board, and reads `text` on the
 * panel. Three renderers, one `Guidance`. Assembling them separately is how you end up with a
 * chef saying "add the tomato" while the overlay still reads "slice thinner" from ten seconds
 * ago, and a cook who sees that stops trusting all three. `parseModelGuidance` therefore falls
 * back WHOLE rather than field-by-field: a half-model, half-local answer is exactly the drift
 * this shape exists to prevent.
 *
 * WHY THE OVERLAY IS SIX WORDS. It is pinned over the thing the cook is holding a knife above,
 * read through a lens, at arm's length, while they are busy. A paragraph floating in space is
 * not read; it is an obstruction. The spoken and written channels carry the reasoning, and the
 * overlay carries the imperative.
 *
 * Pure -- no DOM, no fetch, no clock. Everything here is provable from a terminal, which is the
 * only reason it can be trusted to be the tier that still works when nothing else does.
 */

import type { Intent } from './intent.js';
import { parseIntent } from './intent.js';
import { MIN_CONFIDENCE_TO_ACCUSE } from './nag.js';

export { MIN_CONFIDENCE_TO_ACCUSE };

// ---------------------------------------------------------------------------------------------
// What the chef can see
// ---------------------------------------------------------------------------------------------

/** One line of "there are three of these". Used for both the counter and the camera. */
export interface CountedItem {
  readonly name: string;
  readonly count: number;
}

/**
 * Everything the guidance layer reasons over, flattened into one serialisable snapshot.
 *
 * Flat and plain on purpose: this is the value that gets rendered into a prompt, written into a
 * test fixture, and logged when somebody asks why the chef said what it said. A graph of live
 * objects would do none of those three.
 */
export interface CookContext {
  readonly recipeName: string | null;
  readonly recipeDescription: string;
  /** 1-based position of the step the cook is on. Null when the recipe is complete. */
  readonly stepNumber: number | null;
  readonly stepCount: number;
  readonly stepInstruction: string | null;
  /** `cook-confirmed` steps cannot be checked by looking, and the answer must say so. */
  readonly stepVerifiable: 'vision' | 'cook-confirmed' | null;
  readonly nextStepInstruction: string | null;
  readonly doneCount: number;
  /** What the cook has available, from the counter scan. */
  readonly counter: readonly CountedItem[];
  /** What the camera actually saw in the last analysed frame. */
  readonly seen: readonly CountedItem[];
  readonly cameraLive: boolean;
  /** Deficit instructions, most important first. Verbatim from `deficit.ts`. */
  readonly faults: readonly string[];
  /** 0..1 evenness of the cuts so far, or null when too few were measured. */
  readonly evenness: number | null;
  readonly pieces: number;
  readonly secondsLeft: number | null;
  /**
   * Text read off a printed recipe card by OCR, when the cook has asked for one to be read.
   *
   * Null is the normal case and not a failure. See DECISIONS.md entry 26 for why this is a
   * deliberate, on-demand, cook-initiated read rather than something the loop does by itself.
   */
  readonly cardText: string | null;
  /** How much the observation above can be trusted, 0..1. See `observationConfidence`. */
  readonly confidence: number;
}

export const EMPTY_CONTEXT: CookContext = {
  recipeName: null,
  recipeDescription: '',
  stepNumber: null,
  stepCount: 0,
  stepInstruction: null,
  stepVerifiable: null,
  nextStepInstruction: null,
  doneCount: 0,
  counter: [],
  seen: [],
  cameraLive: false,
  faults: [],
  evenness: null,
  pieces: 0,
  secondsLeft: null,
  cardText: null,
  confidence: 0,
};

// ---------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------

export interface Guidance {
  /** One sentence, spoken aloud. Always present -- there is never dead air. */
  readonly speech: string;
  /** A short imperative, pinned over the real board. See the header for why it is short. */
  readonly overlay: string;
  /** A sentence or two of why, on the panel. This is the channel that survives a mute headset. */
  readonly text: string;
  readonly source: 'local' | 'model';
  /**
   * Whether the cook asked, or the chef spoke up.
   *
   * Carried so the renderer can style an unprompted correction differently from an answer the
   * cook requested. Being interrupted and being answered are different experiences and should
   * not look identical.
   */
  readonly prompted: boolean;
}

/** Words the overlay may carry. See the header. */
export const OVERLAY_MAX_WORDS = 6;

/** Characters the spoken line may carry before it stops being one sentence. */
export const SPEECH_MAX_CHARS = 200;
export const TEXT_MAX_CHARS = 400;

/**
 * Reduces any instruction to the imperative head of it.
 *
 * Deficit instructions are written as "Add 2 more tomato -- 1 on the board, recipe wants 3-4":
 * an order, then the evidence for it. The overlay wants the order. Splitting on the dash rather
 * than truncating at a word count keeps "Add 2 more tomato" instead of producing "Add 2 more
 * tomato -- 1 on the", which reads as the system having been cut off mid-thought.
 */
export function toOverlay(text: string): string {
  const head = (text.split(/\s--\s|\s–\s|[.;:]/)[0] ?? text).trim();
  const words = head.split(/\s+/).filter((word) => word !== '');
  return words.slice(0, OVERLAY_MAX_WORDS).join(' ').replace(/[,\s]+$/, '');
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const sentence = (text: string): string => clip(text.trim().replace(/\s+/g, ' '), SPEECH_MAX_CHARS);

function guidance(
  speech: string,
  text: string,
  prompted: boolean,
  overlay = toOverlay(speech),
): Guidance {
  return {
    speech: sentence(speech),
    overlay,
    text: clip(text.trim().replace(/\s+/g, ' '), TEXT_MAX_CHARS),
    source: 'local',
    prompted,
  };
}

// ---------------------------------------------------------------------------------------------
// Confidence -- the gate on ever saying somebody is wrong
// ---------------------------------------------------------------------------------------------

/** How old the last analysed frame may be before it stops being evidence about now. */
export const STALE_OBSERVATION_MS = 2500;

export interface Observation {
  readonly cameraLive: boolean;
  readonly pieceCount: number;
  /** Mean `identify` confidence across the pieces, 0..1. Not a probability. */
  readonly meanPieceConfidence: number;
  /** Age of the observation in milliseconds. */
  readonly ageMs: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * How much the current observation can be trusted, 0..1.
 *
 * THE ZERO-PIECE CASE IS THE WHOLE REASON THIS FUNCTION EXISTS, and it is not a rounding
 * detail. `diff` compares the board against the recipe, so a board with nothing on it produces
 * a `ingredient-missing` deficit for EVERY requirement at `blocking` severity. Fed straight to
 * an unprompted chef, a hand passing over the lens becomes the system announcing that the cook
 * has forgotten four ingredients that are sitting right in front of them.
 *
 * Being accused of a mistake you did not make does not cost one correction, it costs every
 * correction after it -- the cook learns the chef is unreliable and stops listening, which is
 * strictly worse than a chef that says nothing. So an empty board is treated as "the camera is
 * not looking at the board", never as "the board is empty", and the three hard zeros below are
 * silence rather than a low score for the same reason.
 */
export function observationConfidence(o: Observation): number {
  if (!o.cameraLive) return 0;
  if (o.pieceCount <= 0) return 0;
  if (o.ageMs > STALE_OBSERVATION_MS) return 0;

  const freshness = 1 - clamp01(o.ageMs / STALE_OBSERVATION_MS);
  // One lonely blob is a weaker claim about a whole board than six are. TUNED, not sourced.
  const body = clamp01(o.pieceCount / 3);
  return clamp01(o.meanPieceConfidence * (0.5 + 0.5 * freshness) * (0.4 + 0.6 * body));
}

// ---------------------------------------------------------------------------------------------
// The local answer
// ---------------------------------------------------------------------------------------------

const ordinalStep = (ctx: CookContext): string =>
  ctx.stepNumber === null ? '' : `Step ${ctx.stepNumber} of ${ctx.stepCount}. `;

/**
 * The answer with no model in it, and the reason this feature works on a dead network.
 *
 * A ladder rather than a score, because the order is an argument about what a stuck cook needs
 * to hear first and it should be readable as one:
 *
 *   1. If the camera is not live, say that. Everything below it is a claim about a board nobody
 *      can see, and guessing here is the failure `observationConfidence` exists to prevent.
 *   2. If something is measurably wrong and we are confident about it, that is the answer. A
 *      cook asking what to do next while the tomato is missing does not want step four.
 *   3. Otherwise, the current step. This is the common case and the honest one: they are not
 *      doing anything wrong, they have simply lost their place.
 *   4. With no recipe loaded -- the free cutting round -- coach the cutting itself.
 *   5. Nothing outstanding: say so, warmly, and stop talking.
 */
export function localGuidance(ctx: CookContext, prompted = true): Guidance {
  if (!ctx.cameraLive) {
    return guidance(
      'I cannot see the board. Point the camera at it and I will pick it up.',
      'The camera is not running, so anything I said about the board would be a guess. '
        + 'Everything else still works -- the recipe and the steps are here.',
      prompted,
      'Show me the board',
    );
  }

  const fault = ctx.faults[0];
  if (fault !== undefined && ctx.confidence >= MIN_CONFIDENCE_TO_ACCUSE) {
    const rest = ctx.faults.slice(1, 3);
    return guidance(
      fault,
      `${ordinalStep(ctx)}${fault}`
        + (rest.length === 0 ? '' : ` After that: ${rest.join('; ')}.`),
      prompted,
    );
  }

  if (ctx.stepInstruction !== null) {
    const unverifiable = ctx.stepVerifiable === 'cook-confirmed';
    return guidance(
      ctx.stepInstruction,
      `${ordinalStep(ctx)}${ctx.stepInstruction}.`
        + (unverifiable
          ? ' I cannot check this one by looking, so tell me when it is done.'
          : '')
        + (ctx.nextStepInstruction === null ? '' : ` Then: ${ctx.nextStepInstruction}.`),
      prompted,
    );
  }

  if (ctx.recipeName === null) {
    // The free round. There is no recipe to be behind on, so the only useful thing to say is
    // about the cutting itself, and `evenness` is the one number that is true without a
    // calibration step (DECISIONS.md entry 25).
    if (ctx.evenness !== null) {
      const pct = Math.round(ctx.evenness * 100);
      return guidance(
        pct >= 85
          ? 'These are matching well. Keep the same grip and the same pace.'
          : 'Your slices are drifting. Slow down and keep the knife at one angle.',
        `${pct}% even over ${ctx.pieces} pieces in shot. Evenness is the whole score here: `
          + 'same grip, same angle, same pace beats going fast.',
        prompted,
        pct >= 85 ? 'Keep that pace' : 'Slow down, same angle',
      );
    }
    return guidance(
      'Cut a few pieces and leave them where I can see them.',
      'Nothing is measured yet. Three pieces in shot is the minimum before there is any '
        + 'spread to score.',
      prompted,
      'Cut three, leave in shot',
    );
  }

  return guidance(
    'Nothing is wrong. That is the dish.',
    `All ${ctx.stepCount} steps are done and nothing on the board contradicts the recipe.`,
    prompted,
    'Done — plate it',
  );
}

/**
 * The line spoken the instant a trigger fires, while a model round trip is in flight.
 *
 * Only used when a model is actually configured. With no model the local answer IS the answer
 * and is spoken immediately, so inserting "let me look" would add a second of nothing before
 * a line that was ready before the cook finished asking.
 */
export const ACKNOWLEDGEMENT = 'Let me look.';

export interface OpeningMove {
  /** What to say out loud right now. */
  readonly spoken: string;
  /** What to put on the panel and over the board right now. Never empty. */
  readonly shown: Guidance;
  /** True when a model reply is expected to replace `shown`. */
  readonly awaitingModel: boolean;
}

/**
 * What happens in the first 100ms after the cook asks, which is the part they judge.
 *
 * With a model configured the chef acknowledges immediately and the local answer goes up on the
 * panel at the same moment, so the screen is never blank and the room is never silent while the
 * network is thinking. With no model the local answer is simply spoken. Either way something
 * useful is on screen before any socket has opened.
 */
export function openingMove(hasModel: boolean, ctx: CookContext, prompted = true): OpeningMove {
  const local = localGuidance(ctx, prompted);
  return hasModel
    ? { spoken: ACKNOWLEDGEMENT, shown: local, awaitingModel: true }
    : { spoken: local.speech, shown: local, awaitingModel: false };
}

// ---------------------------------------------------------------------------------------------
// The model half
// ---------------------------------------------------------------------------------------------

export const GUIDANCE_SYSTEM = `You are a calm, expert chef standing at the shoulder of someone cooking. They are wearing a headset that shows them what you say. You will be given FACTS about the recipe, the step they are on, what is on their counter and what the camera measured. Every number is exact. Never contradict them, never invent a number you were not given, and never claim to see anything not listed.

Answer with JSON only, no prose and no code fence, with exactly these keys:

"speech": ONE sentence under 20 words, spoken aloud. The single most useful next action. No preamble, no lists, no greeting.
"overlay": at most 6 words, an imperative, shown pinned over their real cutting board. Not a sentence — a label. "Add two more tomato". "Slice thinner, same angle".
"text": one or two sentences shown on a panel beside them, explaining WHY it matters to the finished dish. Teach, do not just instruct.

If the facts say confidence is low or the camera is not live, do not assert anything about the board — help them with the recipe step instead. If nothing is wrong, say so warmly and briefly.`;

const line = (label: string, value: string): string => `${label}: ${value}`;

const items = (list: readonly CountedItem[]): string =>
  list.length === 0 ? '(none)' : list.map((i) => `${i.count} x ${i.name}`).join(', ');

/**
 * The context as the plain text a model reasons over.
 *
 * Deliberately not JSON. A labelled block costs fewer tokens than the same facts wrapped in
 * braces and quotes, and every model reads it at least as well. It is also the thing to paste
 * into a bug report when the chef says something strange, which a minified object is not.
 */
export function describeContext(ctx: CookContext, question: string | null = null): string {
  const rows = [
    line('Recipe', ctx.recipeName ?? '(no recipe loaded — this is a free cutting round)'),
    ctx.recipeDescription === '' ? null : line('About it', ctx.recipeDescription),
    ctx.stepCount === 0
      ? null
      : line('Progress', `${ctx.doneCount} of ${ctx.stepCount} steps done`),
    ctx.stepInstruction === null
      ? null
      : line(
          `Current step (${ctx.stepNumber} of ${ctx.stepCount})`,
          `${ctx.stepInstruction}`
            + (ctx.stepVerifiable === 'cook-confirmed'
              ? ' [the camera CANNOT check this one — the cook must confirm it]'
              : ''),
        ),
    ctx.nextStepInstruction === null ? null : line('Step after that', ctx.nextStepInstruction),
    line('On the counter', items(ctx.counter)),
    line('Camera', ctx.cameraLive ? 'live' : 'NOT RUNNING — it can see nothing'),
    line('Camera last saw', items(ctx.seen)),
    line('Confidence in that observation', `${Math.round(ctx.confidence * 100)}% (0-100)`),
    ctx.evenness === null
      ? null
      : line('Cut evenness', `${Math.round(ctx.evenness * 100)}% over ${ctx.pieces} pieces`),
    ctx.secondsLeft === null ? null : line('Time left', `${ctx.secondsLeft}s`),
    ctx.cardText === null ? null : line('Text read off their printed recipe card', ctx.cardText),
    '',
    'Faults detected by the measurement engine, most important first:',
    ctx.faults.length === 0
      ? '  (none — nothing on the board contradicts the recipe)'
      : ctx.faults.map((f) => `  - ${f}`).join('\n'),
  ].filter((row): row is string => row !== null);

  const asked =
    question === null || question.trim() === ''
      ? 'They pressed the "unsure" button. They are stuck and do not know what to do next.'
      : `They said: "${question.trim()}"`;

  return `${rows.join('\n')}\n\n${asked}`;
}

/**
 * Removes everything a Qwen3 server may wrap the answer in.
 *
 * Qwen3 is a hybrid-reasoning family: depending on the server and whether thinking was disabled
 * in the request, the reasoning arrives inside the message content as a `<think>` block rather
 * than in a separate field. `JSON.parse` on that fails, and the failure looks exactly like the
 * model having ignored the format instruction. An unterminated block is handled too, because a
 * truncated response leaves the opening tag and no closing one.
 *
 * The fence strip is the same defence `src/ai/openai.ts` gets for free from strict structured
 * output. Qwen3 endpoints vary in whether they support `json_schema`, so it is done by hand
 * here instead.
 */
export function stripThinking(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Turns whatever the model returned into a `Guidance`, or gives back the local answer.
 *
 * WHOLE-OR-NOTHING, and this is the important line in the file. A reply missing `speech` is not
 * repaired by borrowing the local `speech` and keeping the model's `overlay`: that produces a
 * chef saying one thing while the board reads another, which is precisely the drift the single
 * answer object exists to prevent. `overlay` and `text` are derived from the model's own
 * `speech` when absent, so every field of the result still describes one piece of advice.
 */
export function parseModelGuidance(raw: string, fallback: Guidance): Guidance {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripThinking(raw));
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;

  const object = parsed as Record<string, unknown>;
  const speech = nonEmptyString(object['speech']);
  if (speech === null) return fallback;

  const overlay = nonEmptyString(object['overlay']);
  return {
    speech: sentence(speech),
    overlay: toOverlay(overlay ?? speech),
    text: clip((nonEmptyString(object['text']) ?? speech).replace(/\s+/g, ' '), TEXT_MAX_CHARS),
    source: 'model',
    prompted: fallback.prompted,
  };
}

// ---------------------------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------------------------

/**
 * True when this utterance is "hey chef, I don't know what to do next" or a variant of it.
 *
 * Goes through `parseIntent` rather than matching a second time, so the wake phrase, the
 * normalisation and the "not addressed to us" rule are all the ones already tested. A second
 * parser is a second set of phrasings to keep in sync, and they never stay in sync.
 */
export function isStuckUtterance(heard: string): boolean {
  return stuckIntent(heard) !== null;
}

/** The parsed intent when it was a request for guidance, else null. */
export function stuckIntent(heard: string): Intent | null {
  const intent = parseIntent(heard);
  return intent !== null && intent.kind === 'stuck' ? intent : null;
}
