import type { CutFeedback } from './feedback.js';
import type { CutRecord } from './metrics.js';
import type { Score } from './scoring.js';

/**
 * What the chef says, chosen from state. Pure, so the choice is testable without a speaker.
 *
 * Master spec 9.3 wants a bank of pre-generated lines played instantly on game events, with a
 * live agent reserved for open conversation. The reason is latency: a round trip after every
 * slice puts the reaction a second behind the knife, and a reaction that arrives late reads as
 * the game being broken rather than as the chef being thoughtful. Selection therefore has to be
 * local and instant, whatever eventually speaks the line.
 *
 * Separating the choice from the speaking is also what lets the same decision drive text, a
 * cached ElevenLabs buffer, or the browser's own synthesiser, without three copies of the
 * rules about when the chef is pleased.
 */

export type BarkKind =
  | 'first'
  | 'perfect'
  | 'close'
  | 'thick'
  | 'thin'
  | 'uneven'
  | 'uncertain'
  | 'improving';

/**
 * Master spec 9.5: Gentle Nonna at 0, Full Service at 1.
 *
 * Listed as the funniest control in the game and as an accessibility feature, and it is both.
 * A theatrical chef shouting at somebody who is already nervous is not a good first experience,
 * and a judge who wants to be shouted at should be able to ask for it.
 */
export interface BarkOptions {
  readonly intensity: number;
  readonly targetThicknessMm: number;
}

export interface Bark {
  readonly kind: BarkKind;
  readonly line: string;
}

/** Index 0 is Gentle Nonna, index 1 is Full Service. */
type Pair = readonly [gentle: readonly string[], full: readonly string[]];

const LINES: Record<BarkKind, Pair> = {
  first: [
    ['There we go. Nice and steady.', 'Good. Now do that again.'],
    ['Right, that is one. Only the rest to go.', 'One down. Do not get comfortable.'],
  ],
  perfect: [
    ['Beautiful. That is exactly it.', 'Perfect. Do not change a thing.'],
    ['Yes! That is the one!', 'Finally! That is what I have been asking for!'],
  ],
  close: [
    ['Close. Very close.', 'Nearly. Keep the pressure even.'],
    ['Almost. Stop almost-ing.', 'Close is not the same as right.'],
  ],
  thick: [
    ['A little thinner next time.', 'That one was generous. Ease off.'],
    ['That is a doorstop, not a slice.', 'Thinner! We are not building a wall.'],
  ],
  thin: [
    ['A touch thicker, love.', 'That one nearly vanished. Give it some body.'],
    ['I can see through that one.', 'Thicker! That is a rumour, not a slice.'],
  ],
  uneven: [
    ['Try to keep them matching.', 'Good thickness, but they are wandering.'],
    ['Every one of these is a different slice!', 'Pick a thickness! Any thickness!'],
  ],
  uncertain: [
    ['I did not quite see that one.', 'Move your hand clear so I can see.'],
    ['I cannot see through your hand.', 'Out of the way, I am trying to watch!'],
  ],
  improving: [
    ['There. You are getting the feel of it.', 'Much steadier. Keep going.'],
    ['Now we are cooking.', 'See? You could do it all along.'],
  ],
};

/**
 * Chooses the kind first, then a line within it.
 *
 * Order matters and is not arbitrary. Uncertainty outranks everything, because commenting on
 * the thickness of a slice the camera could not actually see is how the chef ends up
 * confidently wrong in front of a judge. After that, consistency outranks accuracy once there
 * is enough of a session to judge it: master spec 16 builds the demo around sigma coming down,
 * so spread is what the chef should be pushing on.
 */
export function pickBark(
  record: CutRecord,
  score: Score,
  feedback: CutFeedback,
  opts: BarkOptions,
  random: () => number = Math.random,
): Bark {
  const kind = chooseKind(record, score, feedback, opts);
  const pair = LINES[kind];
  // Anything at or above the midpoint gets Full Service. A slider with a dead zone in the
  // middle would feel broken; a hard switch at the middle is legible.
  const set = pair[opts.intensity >= 0.5 ? 1 : 0];
  const index = Math.min(set.length - 1, Math.max(0, Math.floor(random() * set.length)));
  return { kind, line: set[index]! };
}

function chooseKind(
  record: CutRecord, score: Score, feedback: CutFeedback, opts: BarkOptions,
): BarkKind {
  if (feedback.kind === 'uncertain') return 'uncertain';
  if (score.count === 1) return 'first';
  if (feedback.accuracy > 0.85) return 'perfect';

  // Only worth saying once there are enough slices for a spread to mean anything. Two slices
  // always have a sigma, and it is always noise.
  if (score.count >= 3 && score.uniformity < 0.5) return 'uneven';

  const off = record.thicknessMm - opts.targetThicknessMm;
  if (feedback.accuracy > 0.6) return 'close';
  return off > 0 ? 'thick' : 'thin';
}

/** Every line in the bank, for pre-generating audio at load. Master spec 9.3. */
export function allLines(): readonly string[] {
  return Object.values(LINES).flatMap(([gentle, full]) => [...gentle, ...full]);
}
