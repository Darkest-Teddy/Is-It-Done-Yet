/**
 * The chef's client tools: read live game state, and ask for it to be changed.
 *
 * Master spec 9.2 is explicit that this is what separates the integration from the half of the
 * event using a voice API as a text-to-speech call -- "the chef can *see* your board and
 * *change* the game. That is a voice agent, not a TTS call."
 *
 * Kept pure, which is the only reason it is provable. `respond` takes a state snapshot and
 * returns a line plus an optional `Effect`; it never mutates anything itself. The caller owns
 * application, so the same function serves the browser, a headset build, and a test with no
 * speaker attached. It also means a wrong answer is reproducible from a fixture rather than
 * only in front of a judge.
 *
 * SPEAKABLE, NOT PRINTABLE. `formatScore` in scoring.ts renders the screen sentence and stays
 * the authority on the numbers. It is not reused verbatim here because synthesisers read "±"
 * and "mm" inconsistently -- some say "plus-minus", some say nothing at all and silently drop
 * the tolerance, which turns "6mm, ±2mm" into "6mm" and changes what was said. Spoken lines
 * spell the words out.
 */

import type { Recipe } from '../recipes.js';
import { progressOf, RECIPES } from '../recipes.js';
import type { Score } from '../scoring.js';
import type { Intent } from './intent.js';

/** Everything the tools can see. A snapshot, so nothing here can go stale mid-answer. */
export interface GameState {
  readonly score: Score;
  readonly recipe: Recipe;
  /** Gentle Nonna at 0, Full Service at 1. */
  readonly intensity: number;
  /** For "say that again". Null before the chef has said anything. */
  readonly lastLine: string | null;
}

/** A change the chef is asking the caller to make. Applied by the caller, never here. */
export type Effect =
  | { readonly kind: 'setTarget'; readonly mm: number }
  | { readonly kind: 'setRecipe'; readonly id: string }
  | { readonly kind: 'setIntensity'; readonly intensity: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'stop' };

export interface Reply {
  /** What the chef says. Always present, even when escalating, so there is never dead air. */
  readonly line: string;
  readonly effect: Effect | null;
  /**
   * True when the local layer could not answer and a model should be asked.
   *
   * `line` is an acknowledgement in that case, not the answer -- something to say while the
   * round trip happens, so the player is not left wondering whether they were heard.
   */
  readonly escalate: boolean;
}

/** Bounds on a spoken target. A misheard "fifty" must not set a 50mm target silently. */
export const MIN_TARGET_MM = 1;
export const MAX_TARGET_MM = 30;

const reply = (line: string, effect: Effect | null = null, escalate = false): Reply =>
  ({ line, effect, escalate });

/** Speakable number: "4.5" reads better as "four point five" than as a numeral in some engines. */
const say = (mm: number): string => `${Number.parseFloat(mm.toFixed(1))}`;

/**
 * The plain-millimetre sentence, spoken.
 *
 * Master spec 7.4 insists on plain numbers over a score out of 100 because a judge parses them
 * in one second. That holds doubly when the number is heard rather than read -- there is no
 * scrolling back.
 */
export function speakableScore(score: Score, recipe: Recipe): string {
  if (score.count === 0) {
    return `Nothing cut yet. I am looking for ${say(recipe.targetThicknessMm)} millimetres.`;
  }
  return (
    `${say(score.meanMm)} millimetres average, plus or minus ${say(score.sigmaMm)}. ` +
    `Target is ${say(recipe.targetThicknessMm)}, plus or minus ${say(recipe.toleranceMm)}.`
  );
}

/**
 * Answers "is it done yet" -- the question the project is named after.
 *
 * Completion outranks quality here. Asked whether it is done, a cook wants to know whether to
 * stop cutting; how well it went is the follow-up, and it is appended rather than substituted.
 */
function doneness(state: GameState): string {
  const progress = progressOf(state.recipe, state.score.count);
  if (progress.complete) {
    return `Yes. ${progress.done} slices, that is the ticket. ` +
      speakableScore(state.score, state.recipe);
  }
  const left = progress.required - progress.done;
  return `Not yet. ${left} more ${left === 1 ? 'slice' : 'slices'} for the ${state.recipe.name}. ` +
    speakableScore(state.score, state.recipe);
}

/**
 * Picks a ticket that is not the current one.
 *
 * Takes `random` rather than calling `Math.random` so the choice is testable, matching
 * `pickBark`. Suggesting the ticket already in progress is the one answer that is useless, and
 * with ten recipes it would happen a tenth of the time.
 */
function suggest(state: GameState, random: () => number): Reply {
  const others = RECIPES.filter((r) => r.id !== state.recipe.id);
  if (others.length === 0) return reply(`We only have the one ticket: ${state.recipe.name}.`);

  const index = Math.min(others.length - 1, Math.max(0, Math.floor(random() * others.length)));
  const pick = others[index]!;
  return reply(
    `${pick.name}. ${pick.note} ${say(pick.targetThicknessMm)} millimetres, ` +
    `${pick.sliceCount} of them.`,
    { kind: 'setRecipe', id: pick.id },
  );
}

/**
 * Turns an intent into what the chef says and what the game should do about it.
 *
 * `random` is injected for the same reason `pickBark` injects it: a suggestion that cannot be
 * pinned in a test is a suggestion nobody can prove is sane.
 */
export function respond(
  intent: Intent,
  state: GameState,
  random: () => number = Math.random,
): Reply {
  switch (intent.kind) {
    case 'progress':
      return reply(doneness(state));

    case 'target':
      return reply(
        `${say(state.recipe.targetThicknessMm)} millimetres, ` +
        `plus or minus ${say(state.recipe.toleranceMm)}. ${state.recipe.note}`,
      );

    case 'setTarget': {
      // A misheard number is the most damaging thing on this path, because it changes what the
      // player is scored against and nothing on screen says it was a mishearing. Refusing out
      // of range and saying so is recoverable; accepting 50mm silently is not.
      if (intent.mm < MIN_TARGET_MM || intent.mm > MAX_TARGET_MM) {
        return reply(
          `${say(intent.mm)} millimetres is not a slice. ` +
          `Give me something between ${MIN_TARGET_MM} and ${MAX_TARGET_MM}.`,
        );
      }
      return reply(
        `${say(intent.mm)} millimetres it is.`,
        { kind: 'setTarget', mm: intent.mm },
      );
    }

    case 'setRecipe': {
      const found = RECIPES.find((r) => r.id === intent.id);
      if (found === undefined) return reply('I do not have that ticket.');
      return reply(
        `${found.name}. ${found.note} ${say(found.targetThicknessMm)} millimetres, ` +
        `${found.sliceCount} of them.`,
        { kind: 'setRecipe', id: found.id },
      );
    }

    case 'setIntensity':
      return reply(
        intent.intensity >= 0.5
          ? 'Right. No more Mister Nice Chef.'
          : 'Alright, love. Gently does it.',
        { kind: 'setIntensity', intensity: intent.intensity },
      );

    case 'suggest':
      return suggest(state, random);

    case 'stuck':
      // The real answer lives in `guidance.ts`, which can see the recipe step and the board.
      // This layer knows only the ticket, so it says the most useful true thing it has and
      // escalates -- a caller with a model wired in gets the better answer a moment later,
      // and a caller without one has still been told where they are.
      return reply(
        `${doneness(state)} ${state.recipe.note}`,
        null,
        true,
      );

    case 'repeat':
      return reply(state.lastLine ?? 'I have not said anything yet.');

    case 'reset':
      return reply('Clean board. Start again.', { kind: 'reset' });

    case 'stop':
      return reply('Quiet it is.', { kind: 'stop' });

    case 'unknown':
      // The only branch worth a round trip. The line is an acknowledgement so the player knows
      // they were heard while it happens -- silence here reads as the mic being broken.
      return reply('Let me think about that one.', null, true);
  }
}
