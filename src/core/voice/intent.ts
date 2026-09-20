/**
 * What the cook asked for, decided locally.
 *
 * Master spec 9.2 wants an agent with tool access to live game state. This is the half of it
 * that does not need a network: a deterministic phrase → intent matcher covering the commands
 * a cook actually says, with `unknown` reserved for everything else so it can escalate to a
 * model.
 *
 * WHY THIS IS NOT JUST AN LLM CALL. Three reasons, in order of how much they matter.
 *
 * Latency. "How am I doing?" is answerable from state already in memory. Routing it through a
 * round trip puts a second between the question and the answer, and master spec 9.3 already
 * establishes that a late reaction reads as the system being broken rather than as the chef
 * being thoughtful.
 *
 * Reliability. Rule #12: pick whatever survives a live demo on bad wifi. Venue wifi at a
 * 1500-person event is saturated. Every command below works with the network unplugged.
 *
 * Testability. An intent table is provable from a terminal against a list of phrases. A model
 * is not, and the one thing worse than a chef that cannot hear you is a chef that confidently
 * mishears you and changes the recipe.
 *
 * That last point is why `unknown` exists as a first-class outcome rather than a nearest-match
 * guess. Doing the wrong thing loudly is worse than admitting the miss, because the player has
 * to notice the error before they can undo it, and on a ticket clock they will not.
 */

import { RECIPES } from '../recipes.js';

export type Intent =
  /** "how am I doing", "is it done yet" -- read the session back. */
  | { readonly kind: 'progress' }
  /** "how thick should I cut" -- read the current target back. */
  | { readonly kind: 'target' }
  /** "make it five millimetres" -- mutate the target. */
  | { readonly kind: 'setTarget'; readonly mm: number }
  /** "what should I make" -- the open question the model is actually useful for. */
  | { readonly kind: 'suggest' }
  /**
   * "I don't know what to do next" -- the cook is stuck *inside* a dish, not shopping for one.
   *
   * Kept apart from `suggest` because they are opposite questions with opposite answers.
   * `suggest` means "give me a different ticket"; `stuck` means "I am on this one and I have
   * lost my place", and answering it with a new recipe is the worst possible reply. See
   * `guidance.ts`, which is what actually answers it.
   */
  | { readonly kind: 'stuck' }
  /** "give me the tzatziki" -- switch tickets. */
  | { readonly kind: 'setRecipe'; readonly id: string }
  /** Gentle Nonna at 0, Full Service at 1. Master spec 9.5. */
  | { readonly kind: 'setIntensity'; readonly intensity: number }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'reset' }
  /** "quiet" -- must never fail to match, so it is tried first. */
  | { readonly kind: 'stop' }
  /** Carries the cleaned text, because this is what gets handed to the model. */
  | { readonly kind: 'unknown'; readonly text: string };

/**
 * Phrases that address the chef, stripped before matching.
 *
 * Listed longest-first so "hey chef" wins over a bare "chef" and does not leave a dangling
 * word behind for the matcher to trip on.
 */
const WAKE = [
  'hey chef', 'ok chef', 'okay chef', 'hey ai', 'ok ai', 'okay ai',
  'hey mise', 'hey cook', 'chef', 'ai',
] as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  // Speech engines transcribe "a half" and "a quarter" readily, and a cook says them.
  half: 0.5, quarter: 0.25,
};

/**
 * Lowercase, depunctuate, collapse whitespace.
 *
 * Apostrophes are removed rather than kept because engines disagree about them -- "what's"
 * comes back as "what's", "whats" or "what is" depending on the engine and the sample rate,
 * and a table that has to spell all three is a table nobody maintains.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9. ]+/g, ' ')
    // A trailing full stop is punctuation; one between digits is a decimal point.
    .replace(/\.(?!\d)/g, ' ')
    // Split a number from a unit stuck to it. Engines transcribe "five millimetres" as "5mm"
    // about as often as "5 mm", and the two must tokenise identically or the number parser
    // sees one opaque word and reports no number at all.
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strips a leading wake phrase. Returns the text unchanged when there is none. */
export function stripWake(normalized: string): string {
  for (const wake of WAKE) {
    if (normalized === wake) return '';
    if (normalized.startsWith(`${wake} `)) return normalized.slice(wake.length + 1);
  }
  return normalized;
}

/** True when the utterance was addressed to the chef at all. */
export function hasWake(normalized: string): boolean {
  return WAKE.some((w) => normalized === w || normalized.startsWith(`${w} `));
}

/**
 * First number in the text, digits or words, or null.
 *
 * Handles "four point five" because that is how an engine transcribes 4.5 about half the time,
 * and a target thickness is exactly the kind of quantity people say with a decimal.
 */
export function firstNumber(text: string): number | null {
  const words = text.split(' ');

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const digits = /^\d+(?:\.\d+)?$/.test(word) ? Number(word) : null;
    const spelled = Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)
      ? NUMBER_WORDS[word]!
      : null;
    const whole = digits ?? spelled;
    if (whole === null) continue;

    // "four point five" -- only meaningful when a digit-like word follows "point".
    if (words[i + 1] === 'point') {
      const tail = words[i + 2];
      if (tail !== undefined) {
        const frac = /^\d+$/.test(tail)
          ? Number(tail)
          : Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tail)
            ? NUMBER_WORDS[tail]!
            : null;
        if (frac !== null) return Number(`${whole}.${frac}`);
      }
    }
    return whole;
  }
  return null;
}

/** A rule is a test over the wake-stripped text and a builder for the intent it implies. */
interface Rule {
  readonly test: RegExp;
  readonly build: (text: string) => Intent | null;
}

/**
 * Ordered. First match wins, and the order is load-bearing rather than incidental.
 *
 * `stop` is first because a player asking for quiet must always get it, including mid-sentence
 * and including when the rest of the phrase looks like something else.
 *
 * Mutations are tried before the questions that share their vocabulary. "How thick should I
 * cut" and "make it five" both talk about thickness; the discriminator is that a mutation
 * carries a number and a question does not, so the number-bearing rule has to be consulted
 * first or every "set" would be answered as a "read".
 */
const RULES: readonly Rule[] = [
  {
    test: /\b(quiet|shut up|stop talking|be silent|silence|mute|shush)\b/,
    build: () => ({ kind: 'stop' }),
  },
  {
    test: /\b(start over|start again|reset|new session|clear (the )?(session|board)|wipe)\b/,
    build: () => ({ kind: 'reset' }),
  },
  {
    // Any phrasing that both names a thickness and asks for it to change.
    test: /\b(make (it|them)|set (the )?target|target|aim for|cut (them |it )?at|go for|change (it|the target) to)\b/,
    build: (text) => {
      const mm = firstNumber(text);
      return mm === null ? null : { kind: 'setTarget', mm };
    },
  },
  {
    // A bare "five millimetres" is unambiguous enough to act on once the chef was addressed.
    test: /\b\d+(\.\d+)?\s*(mm|millimet(er|re)s?)\b|\b[a-z]+\s+(mm|millimet(er|re)s?)\b/,
    build: (text) => {
      const mm = firstNumber(text);
      return mm === null ? null : { kind: 'setTarget', mm };
    },
  },
  {
    test: /\b(gentle|gentler|go easy|easy on me|calm down|be nice|nonna|kinder|softer|quieter)\b/,
    build: () => ({ kind: 'setIntensity', intensity: 0 }),
  },
  {
    test: /\b(full service|shout at me|dont hold back|give me hell|harder on me|angry|full chef)\b/,
    build: () => ({ kind: 'setIntensity', intensity: 1 }),
  },
  {
    // Prospective: asking what the target IS, not what the slices WERE.
    test: /\b(how thick (should|do|am)|what.?s? the target|what am i aiming|what thickness|how thin (should|do))\b/,
    build: () => ({ kind: 'target' }),
  },
  {
    test: /\b(is it done|am i done|are we done|how am i doing|hows it going|how is it going|how are (my|the) (slices|cuts)|whats my score|my score|read me|how did i do|how thick (were|was|are|did))\b/,
    build: () => ({ kind: 'progress' }),
  },
  {
    /**
     * Being stuck, in every phrasing people actually use for it.
     *
     * BEFORE `suggest` deliberately. The two overlap in vocabulary and diverge completely in
     * what a correct answer looks like, and the discriminator is that being stuck is about the
     * dish in front of you. "What do I do" is a cook mid-recipe; "what should I cook" is a cook
     * with an empty board. The `suggest` phrasings below are left exactly as they were, so
     * nothing that used to pick a new ticket has quietly stopped doing so.
     */
    test: /\b(i ?(dont|do not) know what|dont know what|no idea what|what do i do|what am i (meant|supposed) to do|what(s| is) my next step|what(s| is) the next step|next step|(im|i am) stuck|(im|i am) lost|(im|i am) confused|help|walk me through|talk me through|guide me|unsure|what(s| is) wrong|am i doing (this|it) right)\b/,
    build: () => ({ kind: 'stuck' }),
  },
  {
    test: /\b(what should i (make|cook|do)|what can i (make|cook)|cook this up|cook it up|what do you suggest|suggest something|give me (a|another) (recipe|ticket|dish)|whats next|what next|surprise me)\b/,
    build: () => ({ kind: 'suggest' }),
  },
  {
    test: /\b(say that again|say again|repeat|what did you say|come again|pardon)\b/,
    build: () => ({ kind: 'repeat' }),
  },
];

/**
 * Matches a spoken recipe name.
 *
 * Checked against the recipe table rather than a hand-written list so adding a ticket to
 * `recipes.ts` makes it sayable with no second edit -- two lists that must agree is a bug
 * waiting for the one time somebody updates only one of them.
 */
function matchRecipe(text: string): Intent | null {
  for (const recipe of RECIPES) {
    const name = normalize(recipe.name);
    if (text.includes(name) || text.includes(normalize(recipe.id))) {
      return { kind: 'setRecipe', id: recipe.id };
    }
  }
  return null;
}

export interface ParseOptions {
  /**
   * When true, an utterance without a wake phrase is ignored entirely.
   *
   * On by default. An always-listening chef in a room with 1500 people and a judge talking to
   * their friend will act on somebody else's sentence, and the failure is loud and on camera.
   */
  readonly requireWake?: boolean;
}

/**
 * Turns one heard utterance into an intent.
 *
 * Returns null when the utterance was not addressed to the chef and a wake phrase was
 * required -- distinct from `unknown`, which means "you spoke to me and I did not understand",
 * and which is the only case worth spending a model round trip on.
 */
export function parseIntent(heard: string, opts: ParseOptions = {}): Intent | null {
  const { requireWake = true } = opts;
  const normalized = normalize(heard);
  if (normalized === '') return null;
  if (requireWake && !hasWake(normalized)) return null;

  const text = stripWake(normalized);
  // Addressed with nothing after it. Treat as an offer to help rather than a failure: the
  // player has already committed to talking and a "yes?" is a better answer than silence.
  if (text === '') return { kind: 'suggest' };

  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    const intent = rule.build(text);
    // A rule can match its phrasing and still fail to build -- "make it thinner" is a setTarget
    // shape with no number in it. Falling through lets a later rule or the model have it,
    // rather than inventing a thickness nobody said.
    if (intent !== null) return intent;
  }

  return matchRecipe(text) ?? { kind: 'unknown', text };
}
