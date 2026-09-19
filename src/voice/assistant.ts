/**
 * The chef's ears. Wires speech → intent → tools → the voice that already exists.
 *
 * This file is deliberately thin. Everything it decides is decided in `src/core/voice`, which
 * is pure and tested; everything it says goes out through `src/audio/chef.ts`, which already
 * owns the three-tier voice fallback. What is left here is sequencing and the two things that
 * genuinely need a clock: deduplicating what the recogniser reports, and giving up on a model
 * that is taking too long.
 *
 * ORDER OF PREFERENCE, and it is the whole design:
 *
 *   1. Local intent match  -- instant, works offline, provable from a terminal.
 *   2. Model escalation    -- only for `unknown`, behind a timeout, optional.
 *   3. A canned admission  -- when the model is absent, slow, or broken.
 *
 * Master spec rule #9 (every network call gets a timeout and a fallback) and rule #12 (pick
 * what survives a live demo on bad wifi). A judge asking "how am I doing" gets an answer
 * before they finish the sentence, with the router unplugged.
 */

import type { Bark } from '../core/barks.js';
import { parseIntent } from '../core/voice/intent.js';
import type { Effect, GameState, Reply } from '../core/voice/tools.js';
import { respond } from '../core/voice/tools.js';
import type { Heard, SpeechProvider } from './stt.js';

/**
 * An optional model, asked only when the local layer could not answer.
 *
 * Left as an interface rather than a concrete client because the key, the endpoint and the
 * sponsor track are all decisions this file should not make. Rule #13: do not fabricate an
 * integration. Wire a real one here when there is a key to wire.
 */
export interface Oracle {
  readonly name: string;
  /** `context` is a plain-text state summary. Must reject or resolve; never hang. */
  ask(question: string, context: string): Promise<string>;
}

export interface AssistantOptions {
  readonly provider: SpeechProvider;
  /** Reads live state at the moment of answering, never a snapshot taken at construction. */
  readonly state: () => GameState;
  /** Applies a state change the chef asked for. The caller owns all mutation. */
  readonly apply: (effect: Effect) => void;
  /** Speaks a line. The existing chef, so all three voice tiers come along for free. */
  readonly speak: (bark: Bark) => void;
  /** Shown on screen: the transcript, the intent, the tier. Optional but worth wiring. */
  readonly onTranscript?: (heard: Heard) => void;
  readonly onReply?: (reply: Reply) => void;
  readonly onError?: (message: string) => void;
  readonly oracle?: Oracle;
  /** Per-question ceiling on the model. A slow answer is abandoned, never waited for. */
  readonly oracleTimeoutMs?: number;
}

export interface Assistant {
  start(): void;
  stop(): void;
  /** Feeds one utterance directly, bypassing the microphone. The typed path and the tests. */
  hear(text: string): void;
  readonly listening: () => boolean;
  /** What the chef last said, so "say that again" has something to repeat. */
  readonly lastLine: () => string | null;
}

/** Rejects on timeout rather than hanging, so a stalled model cannot pin the chef forever. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

/** A plain-text state summary, for a model that cannot see the board. */
function describe(state: GameState): string {
  const { score, recipe } = state;
  return [
    `Ticket: ${recipe.name}, ${recipe.sliceCount} slices at ${recipe.targetThicknessMm}mm`,
    `+/-${recipe.toleranceMm}mm. ${recipe.note}`,
    score.count === 0
      ? 'No slices cut yet.'
      : `${score.count} slices cut, ${score.meanMm.toFixed(1)}mm average, ` +
        `sigma ${score.sigmaMm.toFixed(1)}mm.`,
  ].join(' ');
}

export function createAssistant(options: AssistantOptions): Assistant {
  const { provider, state, apply, speak, oracleTimeoutMs = 3000 } = options;
  let lastLine: string | null = null;

  const say = (line: string): void => {
    lastLine = line;
    // The bark kind is cosmetic here -- the pre-generated bank is keyed on the line text, and
    // a conversational answer was never in it, so this always reaches the browser voice tier.
    speak({ kind: 'improving', line });
  };

  const escalate = (question: string): void => {
    const oracle = options.oracle;
    if (oracle === undefined) {
      say('That one is beyond me. Ask me about your slices.');
      return;
    }
    // Fire and forget on purpose: nothing may await a network call on the path that answers a
    // human. The acknowledgement has already been spoken by `respond`.
    void withTimeout(oracle.ask(question, describe(state())), oracleTimeoutMs)
      .then((answer) => {
        const trimmed = answer.trim();
        if (trimmed !== '') say(trimmed);
      })
      .catch(() => {
        options.onError?.(`${oracle.name} did not answer in time`);
        say('I did not catch that. Ask me about your slices.');
      });
  };

  const handle = (text: string): void => {
    const intent = parseIntent(text);
    // Not addressed to the chef. Silence is correct: a room with 1500 people in it is full of
    // sentences that are not for us.
    if (intent === null) return;

    const reply = respond(intent, { ...state(), lastLine });
    options.onReply?.(reply);
    say(reply.line);

    if (reply.effect !== null) {
      if (reply.effect.kind === 'stop') provider.stop();
      apply(reply.effect);
    }
    if (reply.escalate && intent.kind === 'unknown') escalate(intent.text);
  };

  return {
    listening: () => provider.listening(),
    lastLine: () => lastLine,
    start: () => provider.start(),
    stop: () => provider.stop(),
    hear: handle,
  };
}

/**
 * Builds the `onHeard` callback an assistant should be driven by.
 *
 * TWO GUARDS, both learned the hard way with a continuous recogniser.
 *
 * Interim results are ignored. Chrome emits a running guess on nearly every syllable, and
 * acting on them means the chef answers "how" before hearing "how am I doing", then answers
 * again, then again.
 *
 * Identical finals inside a short window are dropped. The same settled transcript is commonly
 * delivered twice when a session ends and restarts across an utterance, which without this
 * sets the target, announces it, and sets it again.
 */
export function heardHandler(
  assistant: Assistant,
  onTranscript?: (heard: Heard) => void,
  repeatWindowMs = 1500,
): (heard: Heard) => void {
  let lastText = '';
  let lastAt = 0;

  return (heard: Heard) => {
    onTranscript?.(heard);
    if (!heard.final) return;

    const text = heard.text.trim();
    if (text === '') return;

    const now = Date.now();
    if (text === lastText && now - lastAt < repeatWindowMs) return;
    lastText = text;
    lastAt = now;

    assistant.hear(text);
  };
}
