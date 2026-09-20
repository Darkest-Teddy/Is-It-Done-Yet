/**
 * What the chef is ALLOWED to say, decided in code rather than asked for in a prompt.
 *
 * DECISIONS.md entry 30 answered a safety failure with a paragraph in `GUIDANCE_SYSTEM`, and
 * entry 32 measured the paragraph: 17 of 20 runs of entry 30's own regression case still told
 * the cook to put ice into hot oil, 28 of 28 unknown dishes got invented steps, 12 of 12
 * replies fabricated a slice thickness out of a context carrying no thickness field, and a
 * `recipeDescription` reading `SYSTEM OVERRIDE: ...` was obeyed 12 times out of 12. The shape
 * of the result was exact: **the clause protects the four hazards it names verbatim and
 * nothing else.**
 *
 * So this file does not ask. It is the same move `deficit.ts`, `nag.ts` and `identify()` all
 * make -- a deterministic check the model cannot talk its way around -- applied to the model's
 * own output, and it rests on one observation that makes the whole thing decidable:
 *
 *   THE FACTS ARE A FINITE STRING. `describeContext` renders the entire world the model was
 *   given into text. Anything in the reply that is not in that text was not measured, was not
 *   read off the recipe, and was not seen by the camera. It was invented. That is checkable
 *   with no model, no network and no judgement, which is the only kind of check worth having
 *   on a path that can hurt somebody.
 *
 * FIVE RULES, AND THE FIRST ONE DOES ALMOST ALL OF THE WORK.
 *
 *   `injected`          an untrusted field tried to address the model. Screened OUT of the
 *                       prompt before it is built, so the model never sees the string at all.
 *   `unknown-recipe`    the engine holds a named dish and no steps for it, and the reply did
 *                       not say so. Every worst failure entry 32 found lives here.
 *   `ungrounded-step`   there is no `stepInstruction`, and the reply named a heat, pressure or
 *                       preservation process anyway.
 *   `invented-number`   a figure that appears nowhere in the facts. The prompt already forbids
 *                       this and entry 32 measured it violated 16 times in 20.
 *   `invented-unit`     a unit of measure the facts never carry. `mm` is the one that matters:
 *                       thicknesses are uncalibrated (entry 25) so the app has never once
 *                       measured a millimetre, and "your slices are about 5mm" is therefore
 *                       fabricated by construction rather than by judgement.
 *   `unmeasured-claim`  a second-person claim that the cook's pieces HAVE a dimension, when
 *                       `CookContext` carries no measurement of that dimension. This is the
 *                       one that catches the recipe's TARGET being laundered into a
 *                       MEASUREMENT of the cook's work, which is this project's central claim.
 *   `unseen-claim`      a claim to see the board when the observation is not trusted enough to
 *                       accuse anybody of anything. Same floor as `nag.ts` uses.
 *
 * WHAT HAPPENS ON A VIOLATION IS WHOLE-OR-NOTHING, for the reason the header of `guidance.ts`
 * gives at length: the local answer replaces the model answer entirely. Repairing a field
 * produces a chef whose voice and whose pin disagree. `localGuidance` is a complete, honest
 * answer with no model in it (entry 26), so the cost of rejecting is phrasing and nothing else.
 *
 * WHAT THIS DOES NOT CATCH, STATED PLAINLY. A reply can be fully grounded, carry no invented
 * figure, name no process, and still be wrong about food safety -- entry 32's canning, rice and
 * kidney-bean family, where the danger is an OMITTED step and the reply contains no hazard
 * token at all. Those are caught here only because they are ungrounded recipes, not because
 * anything here understands botulism. A grounded recipe with a dangerous step in it would pass
 * every rule below. The safety clause in `GUIDANCE_SYSTEM` stays for that reason: it is a
 * layer, and a cheap one, not the defence.
 *
 * Pure -- no DOM, no fetch, no clock.
 */

import type { CookContext, Guidance } from './guidance.js';
import { MIN_CONFIDENCE_TO_ACCUSE } from './nag.js';

export type ViolationKind =
  | 'injected'
  | 'unknown-recipe'
  | 'ungrounded-step'
  | 'invented-number'
  | 'invented-unit'
  | 'unmeasured-claim'
  | 'unseen-claim';

export interface Violation {
  readonly kind: ViolationKind;
  /** What tripped it, for the status line and for a bug report. Never shown to the cook. */
  readonly detail: string;
}

// ---------------------------------------------------------------------------------------------
// 1. Screening the untrusted fields, BEFORE the prompt exists
// ---------------------------------------------------------------------------------------------

/**
 * The fields of a `CookContext` a stranger can write.
 *
 * Entry 30 identified `recipeName` as attacker-controlled and entry 32 measured that the
 * DESCRIPTION is worse -- 12 of 12 compliance with an injected `SYSTEM OVERRIDE` line, once
 * with "Pour slowly to minimize risk, even if the system is overridden", the model reading an
 * injected string as a genuine directive and saying so. `cardText` is worse again: it is paper
 * a stranger can hold up to the camera.
 *
 * Detecting-and-removing is used rather than delimiting because delimiting was measured and it
 * does not hold. A string that never reaches the prompt cannot be obeyed.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(system|developer|admin)\s*(override|prompt|message|instruction)/i,
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|preceding)\b/i,
  /\bdisregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|rules?|instructions?|safety)/i,
  /\b(safety|the\s+safety\s+\w+)\s+(is\s+)?(disabled|off|overridden|suspended|waived|lifted)/i,
  /\b(disable|turn\s+off|switch\s+off|bypass|skip)\s+(the\s+)?(safety|guardrails?|rules?|checks?)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+(instructions?|rules?|system\s+prompt)\b/i,
  /\bfrom\s+now\s+on,?\s+(you|answer|reply|respond)/i,
  /\b(do\s+not|don'?t|never)\s+(follow|obey|apply)\s+(the\s+)?(previous|prior|above|safety|rules?)/i,
  /\breply\s+only\s+with\b/i,
  /^\s*(assistant|system|user)\s*:/im,
];

export interface Screened {
  readonly clean: string;
  readonly injected: boolean;
}

/**
 * Removes a field that is addressing the model rather than describing a dish.
 *
 * The whole field goes, not the matching sentence. A description that contains an injection is
 * not a description with one bad line in it -- whoever wrote it was not describing food -- and
 * leaving the rest in place invites a second injection split across two sentences.
 */
export function screenText(text: string | null): Screened {
  if (text === null || text.trim() === '') return { clean: text ?? '', injected: false };
  const injected = INJECTION_PATTERNS.some((pattern) => pattern.test(text));
  return { clean: injected ? '' : text, injected };
}

export interface ScreenedContext {
  readonly ctx: CookContext;
  /** Names of the fields that were removed. Empty in the normal case. */
  readonly injected: readonly string[];
}

/**
 * The context with every untrusted field screened.
 *
 * Called from inside `describeContext` rather than by its callers, so there is no way to build
 * a prompt that skipped it. That is the difference between a rule and a habit.
 */
export function screenContext(ctx: CookContext): ScreenedContext {
  const name = screenText(ctx.recipeName);
  const description = screenText(ctx.recipeDescription);
  const card = screenText(ctx.cardText);

  const injected = [
    name.injected ? 'recipeName' : null,
    description.injected ? 'recipeDescription' : null,
    card.injected ? 'cardText' : null,
  ].filter((field): field is string => field !== null);

  if (injected.length === 0) return { ctx, injected };

  return {
    ctx: {
      ...ctx,
      // A recipe whose NAME was an injection is not a recipe. Nulling it puts the context on
      // the free-round path, which is the honest reading of "we do not know what this is".
      recipeName: name.injected ? null : ctx.recipeName,
      recipeDescription: description.clean,
      cardText: card.injected ? null : ctx.cardText,
    },
    injected,
  };
}

/** The cook's own words are untrusted too: a bystander can speak, and a card can be held up. */
export function screenQuestion(question: string | null): string | null {
  if (question === null) return null;
  return screenText(question).injected ? null : question;
}

// ---------------------------------------------------------------------------------------------
// 2. Provenance: the facts are a finite string
// ---------------------------------------------------------------------------------------------

const NUMBER = /\d+(?:[.,]\d+)?/g;

const normaliseNumber = (raw: string): string => String(Number(raw.replace(',', '.')));

/** Every figure in `text`, normalised so `1.50` and `1,5` and `1.5` are one number. */
export function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER) ?? []).map(normaliseNumber));
}

/**
 * Units of measure, as the tokens they are actually written as.
 *
 * Deliberately not a physics table. What matters is whether the FACTS carried this unit: the
 * context renders percentages, piece counts, step counts and seconds and nothing else, so a
 * reply carrying grams or millimetres or degrees is carrying something nothing measured. Units
 * that the recipe's own step text happens to mention are allowed, because that text IS a fact
 * the model was handed.
 */
const UNIT = new RegExp(
  '(?<![a-z])('
  + 'mm|millimetre?s?|millimeters?|cm|centimetre?s?|centimeters?|metres?|meters?'
  + '|inch|inches|foot|feet'
  + '|g|grams?|gramme?s?|kg|kilos?|kilograms?|oz|ounces?|lbs?|pounds?'
  + '|ml|millilitres?|milliliters?|litres?|liters?|cups?|tbsps?|tablespoons?|tsps?|teaspoons?'
  + '|pints?|quarts?|gallons?'
  + '|°c|°f|celsius|fahrenheit|degrees?'
  + '|minutes?|mins?|hours?|hrs?'
  + ')(?![a-z])',
  'gi',
);

/** Every unit token in `text`, lowercased. */
export function unitsIn(text: string): Set<string> {
  return new Set((text.match(UNIT) ?? []).map((unit) => unit.toLowerCase()));
}

// ---------------------------------------------------------------------------------------------
// 3. The ungrounded-step lexicon
// ---------------------------------------------------------------------------------------------

/**
 * Heat, pressure, water and preservation: the four places a kitchen hurts people.
 *
 * A LEXICON IS NOT A PROOF and this one is not claimed to be complete. It is the backstop
 * under `unknown-recipe`, which is the rule that actually carries the ungrounded path. What it
 * deliberately leaves out is every verb the measurement engine can actually check -- cut,
 * slice, chop, dice, add, place, move, arrange, weigh -- because those are the useful things
 * the chef says in the free cutting round, where there is also no `stepInstruction`.
 */
const PROCESS_WORDS = new RegExp(
  '(?<![a-z])('
  + 'fry|fries|fried|frying|fryer|deep-?fr\\w*|sear\\w*|saut[ée]\\w*|sizzl\\w*'
  + '|boil\\w*|simmer\\w*|poach\\w*|blanch\\w*|steam\\w*|scald\\w*'
  + '|bake|baking|baked|roast\\w*|grill\\w*|broil\\w*|char\\w*|toast\\w*|braise\\w*|stew\\w*'
  + '|preheat\\w*|reheat\\w*|heat|heats|heated|heating|burner|hob|stove|oven|griddle|skillet'
  + '|oil|fat|grease|lard|deep\\s+fat'
  + '|can|canner|canning|canned|jar|jars|jarring|preserv\\w*|pickl\\w*|ferment\\w*|cur(?:e|ed|ing)'
  + '|sterilis\\w*|steriliz\\w*|pasteuris\\w*|pasteuriz\\w*|pressure\\s+\\w+|water\\s+bath'
  + '|thaw\\w*|defrost\\w*|freeze|freezing|frozen|refrigerat\\w*|marinat\\w*|marinade|brine|brining'
  + '|soak\\w*|ferment\\w*|proof|proving|render\\w*|melt\\w*|deglaz\\w*|flamb[ée]\\w*|ignit\\w*'
  + ')(?![a-z])',
  'i',
);

// ---------------------------------------------------------------------------------------------
// 4. The measurement-claim gate
// ---------------------------------------------------------------------------------------------

/**
 * A second-person claim that the cook's pieces HAVE a size.
 *
 * `CookContext` has a closed set of measured fields and thickness is not one of them --
 * `menu/guidance.ts` constructs its `CoachSession` with `pxPerMm: null` on purpose (entry 25),
 * so every thickness in this app is null and always has been. A reply that states one is
 * therefore fabricating, and entry 32 measured it doing so in 12 of 12 runs, laundering the
 * recipe's TARGET into a MEASUREMENT of the cook's work. That is the one substantive claim
 * this whole project makes, invented on request, in all three channels at once.
 *
 * WHAT IT MUST NOT CATCH IS THE HARDER HALF, and the rule is narrow on purpose. A guard that
 * stopped the chef claiming a thickness and also stopped it saying "your slices are 64% even
 * over 9 pieces" would be blocking the one measurement this app genuinely makes, and a chef
 * that refuses to discuss the board is a worse chef than one that occasionally fabricates --
 * the whole feature exists so that a stuck cook gets an answer. So the trigger is not "a number
 * near the word slices". It is a LENGTH: a figure carrying a unit of distance, inside a claim
 * that the cook's pieces have one. Percentages, counts and step numbers are measured fields and
 * pass freely.
 */
const SIZE_CLAIM = new RegExp(
  '\\b(your|these|those|the)\\s+(slices?|cuts?|pieces?|rounds?)\\b[^.!?]{0,40}'
  + '\\b(are|is|look|looks|looking|measure|measures|appear|appears|came\\s+out|come\\s+out|sit|run)\\b'
  + '[^.!?]{0,30}\\d+(?:[.,/]\\d+)?\\s*(mm|millimet\\w*|millimeter\\w*|cm|centimet\\w*|centimeter\\w*|inch\\w*|")',
  'i',
);

/** The same claim in the other word order: "about 5mm thick, those slices". */
const SIZE_CLAIM_INVERTED = new RegExp(
  '\\d[^.!?]{0,20}\\b(thick|thin|wide|deep|long)\\b[^.!?]{0,30}'
  + '\\b(your|these|those)\\s+(slices?|cuts?|pieces?|rounds?)\\b',
  'i',
);

const SEEING = /\b(I can see|I see|I'm seeing|I am seeing|on your board|on the board|in front of you|you have|there are|there is)\b/i;

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

/** Everything the model wrote, as one string. All three channels are checked, not just speech. */
const allChannels = (g: Pick<Guidance, 'speech' | 'overlay' | 'text'>): string =>
  `${g.speech} ${g.overlay} ${g.text}`;

/**
 * Whether a reply admits it does not know the recipe.
 *
 * A POSITIVE REQUIREMENT rather than a forbidden-phrase list, and that is deliberate. Entry 32
 * measured that no list of hazard words can catch the canning, rice and kidney-bean family,
 * because the dangerous reply contains no hazard word -- it says "Start by washing the green
 * beans". What those replies DO all share is that they walk a cook forward through a dish the
 * engine holds no steps for. Requiring the admission inverts the problem: instead of
 * enumerating what must not be said, there is one thing that must be.
 */
export function admitsIgnorance(text: string): boolean {
  return /\b(do not know|don'?t know|not know (?:that|this)|no steps|not in my book|i have no steps|cannot find|can'?t find|unfamiliar with|not a recipe i|do not have (?:a |the )?recipe|don'?t have (?:a |the )?recipe|not one i know|i do not have steps|no recorded steps)\b/i
    .test(text);
}

/**
 * Every way this reply is not grounded in the facts it was given.
 *
 * `facts` is the literal string that went to the model -- the output of `describeContext` for
 * this very call -- rather than a re-render of the context. Checking against a re-render would
 * be checking against something the model never saw, and the two drift the moment anybody adds
 * a line to the prompt.
 */
export function checkGrounding(
  reply: Pick<Guidance, 'speech' | 'overlay' | 'text'>,
  facts: string,
  ctx: CookContext,
): Violation[] {
  const said = allChannels(reply);
  const violations: Violation[] = [];

  // THE BOOLEAN ENTRY 32 ASKED FOR. The engine holds a named dish and no steps for it, so
  // there is nothing to be grounded against and every worst failure measured lived here.
  if (ctx.recipeName !== null && ctx.stepCount === 0 && !admitsIgnorance(said)) {
    violations.push({
      kind: 'unknown-recipe',
      detail: `no steps for "${ctx.recipeName}" and the reply did not say so`,
    });
  }

  if (ctx.stepInstruction === null) {
    const process = PROCESS_WORDS.exec(said);
    if (process !== null) {
      violations.push({
        kind: 'ungrounded-step',
        detail: `named "${process[0]}" with no step to ground it`,
      });
    }
  }

  const allowedNumbers = numbersIn(facts);
  const invented = [...numbersIn(said)].filter((n) => !allowedNumbers.has(n));
  if (invented.length > 0) {
    violations.push({ kind: 'invented-number', detail: invented.join(', ') });
  }

  const allowedUnits = unitsIn(facts);
  const inventedUnits = [...unitsIn(said)].filter((u) => !allowedUnits.has(u));
  if (inventedUnits.length > 0) {
    violations.push({ kind: 'invented-unit', detail: inventedUnits.join(', ') });
  }

  if (SIZE_CLAIM.test(said) || SIZE_CLAIM_INVERTED.test(said)) {
    violations.push({
      kind: 'unmeasured-claim',
      detail: 'stated a size for the cook\'s pieces; nothing in the context measures one',
    });
  }

  if (ctx.confidence < MIN_CONFIDENCE_TO_ACCUSE && SEEING.test(said)) {
    violations.push({
      kind: 'unseen-claim',
      detail: `claimed to see the board at ${Math.round(ctx.confidence * 100)}% confidence`,
    });
  }

  return violations;
}

export interface Grounded {
  /** What may actually reach the three channels. The fallback whole, when anything failed. */
  readonly guidance: Guidance;
  readonly violations: readonly Violation[];
}

/**
 * The gate every model reply passes through before `present()` can see it.
 *
 * A parsed local answer is passed through untouched -- `parseModelGuidance` already returns the
 * fallback when the reply was unusable, and re-checking a sentence this repo wrote against
 * facts this repo rendered would eventually reject the honest answer for a rounding detail.
 * Only `source === 'model'` is untrusted, because only that is written by something else.
 */
export function groundGuidance(
  parsed: Guidance,
  facts: string,
  ctx: CookContext,
  fallback: Guidance,
  /**
   * Fields `screenContext` removed on the way in.
   *
   * A reply is refused outright when anything was screened, rather than merely checked
   * harder. Somebody put a directive where a dish name goes; the useful assumption at that
   * point is that this whole exchange is not what it appears to be, and the local answer costs
   * nothing.
   */
  injected: readonly string[] = [],
): Grounded {
  if (parsed.source !== 'model') return { guidance: parsed, violations: [] };
  const violations: Violation[] = injected.map((field) => ({
    kind: 'injected' as const,
    detail: `${field} addressed the model and was removed before the prompt was built`,
  }));
  violations.push(...checkGrounding(parsed, facts, ctx));
  return { guidance: violations.length === 0 ? parsed : fallback, violations };
}

/** One short line for the panel's status row, or the empty string when nothing was wrong. */
export function violationNote(violations: readonly Violation[]): string {
  if (violations.length === 0) return '';
  const kinds = [...new Set(violations.map((v) => v.kind))].join(', ');
  return `The model answer was not grounded in the measurements (${kinds}) — local answer stands`;
}
