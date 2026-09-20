/**
 * The three things a picture of a countertop is asked for, and the shapes the answers must
 * arrive in.
 *
 * Everything an LLM returns is validated before it leaves this file. Not because the model is
 * adversarial, but because it is a *probabilistic* source of a *typed* value: `status` has four
 * legal strings and a model that writes "OK!" once every few hundred calls will otherwise reach
 * a switch statement in C# that has no case for it.
 *
 * Failure is never an exception the route has to catch and turn into a 500. It is an
 * `offline: true` answer with an empty observation list, which the headset already knows how to
 * render -- the scoring engine is deterministic and local, so a quiet coach costs commentary
 * and nothing else.
 */

import { coachAnalysisSchema, ingredientCheckSchema, scannedRecipeSchema } from './schemas.js';

/**
 * Pulls the JSON object out of a completion.
 *
 * `response_format: json_object` is requested and usually honoured, but a fallback provider may
 * not support it, and a model in a bad mood fences its output in ```json. Slicing from the
 * first brace to the last is uglier than a parse and survives both.
 */
export function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to the brace scan */ }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** What every coach route answers with when the model could not be reached or understood. */
export const OFFLINE_ANALYSIS = Object.freeze({
  observations: [],
  coachLine: null,
  unsure: true,
  offline: true,
});

const SAFETY_RULE = [
  'Never tell the cook to lean into a hot pan, touch hot oil, or keep the headset on while',
  'they are cutting with a sharp knife. If the safest answer is "step back and look", say that.',
].join(' ');

/**
 * The analyse prompt.
 *
 * Three things it insists on, each of which was a failure mode first:
 *  - every observation names ONE rubric item, because a sentence covering three items cannot be
 *    scored against any of them;
 *  - `unknown` is a first-class status, because a model with nothing to go on will otherwise
 *    guess `ok` and the deterministic scorer will bank the guess;
 *  - heat is explicitly an estimate. There is no thermometer in this system. Any wording that
 *    implies a measurement is a lie the UI then has to walk back.
 */
function analyzeMessages({ stepText, rubricItems, recipeTitle, imageDataUri, hot, knife }) {
  const items = rubricItems.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const flags = [hot ? 'This step involves heat.' : null, knife ? 'This step involves a knife.' : null]
    .filter((s) => s !== null)
    .join(' ');

  return [
    {
      role: 'system',
      content: [
        'You are a calm kitchen coach looking through a headset camera at a real countertop.',
        'You answer ONLY with a JSON object. No prose, no markdown fence.',
        '',
        'Schema:',
        '{"observations":[{"item":string,"status":"ok"|"warn"|"bad"|"unknown","evidence":string,"confidence":number}],"coachLine":string|null,"unsure":boolean}',
        '',
        'Rules:',
        '- One observation per rubric item, in the order given. Never merge two items into one.',
        '- "item" must repeat the rubric item text verbatim.',
        '- "evidence" is what you can actually SEE, in at most 15 words. Not advice.',
        '- "confidence" is 0..1. Below 0.4 means you are guessing; use "unknown" instead.',
        '- Use "unknown" whenever the pan, board or food is out of frame, blurred or occluded.',
        '- Set "unsure": true if more than half the items are "unknown".',
        '- "coachLine" is at most 12 words spoken to the cook, or null if you have nothing useful.',
        '- You cannot measure temperature. Heat is an ESTIMATE from colour, smoke and bubbling.',
        `  Never state a temperature in degrees. ${SAFETY_RULE}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Recipe: ${recipeTitle}\nCurrent step: ${stepText}\n${flags}\n\nRubric items:\n${items}` },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ],
    },
  ];
}

export async function analyze(llm, input) {
  let result;
  try {
    result = await llm.chat({ messages: analyzeMessages(input), maxTokens: 700 });
  } catch (error) {
    console.warn(`[coach] analyze unavailable: ${error.message}`);
    return { ...OFFLINE_ANALYSIS, reason: 'upstream_unavailable' };
  }

  const raw = extractJson(result.text);
  if (raw === null) {
    console.warn('[coach] analyze returned unparseable content');
    return { ...OFFLINE_ANALYSIS, reason: 'unparseable' };
  }

  const parsed = coachAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[coach] analyze failed validation: ${parsed.error.issues[0]?.message}`);
    return { ...OFFLINE_ANALYSIS, reason: 'invalid_shape' };
  }

  /**
   * An observation naming an item that was not asked about is dropped, not renamed.
   *
   * The scorer looks rubric items up by their exact text. A hallucinated item would score
   * against nothing, and a *renamed* one would score against the wrong rule -- which is worse,
   * because it is invisible.
   */
  const asked = new Set(input.rubricItems);
  const observations = parsed.data.observations.filter((o) => asked.has(o.item));
  const dropped = parsed.data.observations.length - observations.length;
  if (dropped > 0) console.warn(`[coach] dropped ${dropped} observation(s) naming an unrequested item`);

  const unknowns = observations.filter((o) => o.status === 'unknown').length;

  return {
    observations,
    coachLine: parsed.data.coachLine ?? null,
    // Trust the model's own flag, but raise it ourselves when the numbers say so. A model that
    // answers "unknown" five times out of six and then claims certainty is not certain.
    unsure: parsed.data.unsure || observations.length === 0 || unknowns * 2 > observations.length,
    offline: false,
    model: result.model,
  };
}

/**
 * Reading a recipe card held up to the camera.
 *
 * Bounded hard -- 40 ingredients, 60 steps -- because this is the one endpoint whose output
 * becomes a stored document. An unbounded parse of a photograph is an unbounded write.
 */
function scanMessages({ imageDataUri, units }) {
  return [
    {
      role: 'system',
      content: [
        'You transcribe a photographed recipe card into JSON. Answer ONLY with a JSON object.',
        '',
        'Schema:',
        '{"title":string,"description":string|null,"servings":number,"tags":string[],',
        ' "ingredients":[{"name":string,"quantity":number,"unit":string,"notes":string|null}],',
        ' "steps":[{"order":number,"text":string,"durationSec":number|null,"technique":string|null,"hot":boolean,"knife":boolean}],',
        ' "confidence":number,"unreadable":string[]}',
        '',
        'Rules:',
        `- "unit" must be exactly one of: ${units.join(', ')}. Convert anything else, or use "piece".`,
        '- "quantity" is a number. "a pinch" is 1 with unit "pinch". Never write a range.',
        '- "order" starts at 0 and increases by 1.',
        '- "hot" is true if the step uses a burner, oven, or hot oil. "knife" is true if it cuts.',
        '- List anything you could not read in "unreadable" rather than inventing it.',
        '- At most 40 ingredients and 60 steps. Stop rather than exceed either.',
        '- "confidence" is 0..1 for the transcription as a whole.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe this recipe card.' },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ],
    },
  ];
}

export async function scanRecipe(llm, input) {
  let result;
  try {
    result = await llm.chat({ messages: scanMessages(input), maxTokens: 2000 });
  } catch (error) {
    console.warn(`[coach] scan unavailable: ${error.message}`);
    return { ok: false, offline: true, reason: 'upstream_unavailable' };
  }

  const raw = extractJson(result.text);
  if (raw === null) return { ok: false, offline: true, reason: 'unparseable' };

  const parsed = scannedRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      offline: false,
      reason: 'invalid_shape',
      issues: parsed.error.issues.slice(0, 6).map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }

  // Never saved here. The headset shows this in an editable form and POSTs /api/recipes if the
  // cook confirms it -- a transcription of a photograph is a draft, not a record.
  return { ok: true, offline: false, draft: parsed.data, model: result.model };
}

function ingredientMessages({ imageDataUri, wanted }) {
  const list = wanted.map((w, i) => `${i + 1}. ${w}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        'You look at a countertop photo and say which of a shopping list you can SEE.',
        'Answer ONLY with a JSON object.',
        '',
        'Schema: {"found":[{"name":string,"present":boolean,"confidence":number,"evidence":string}],"unsure":boolean}',
        '',
        'Rules:',
        '- "name" must repeat the requested item verbatim. One entry per requested item.',
        '- "present" false means you looked and it is not there. If you cannot tell, set',
        '  "present": false AND "confidence" below 0.4 -- the app renders that as "not sure".',
        '- "evidence" is at most 10 words describing what you saw.',
        '- Never claim to see something because the recipe calls for it.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Which of these are on the counter?\n${list}` },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ],
    },
  ];
}

export async function checkIngredients(llm, input) {
  let result;
  try {
    result = await llm.chat({ messages: ingredientMessages(input), maxTokens: 900 });
  } catch (error) {
    console.warn(`[coach] ingredient check unavailable: ${error.message}`);
    return { found: [], unsure: true, offline: true, reason: 'upstream_unavailable' };
  }

  const raw = extractJson(result.text);
  if (raw === null) return { found: [], unsure: true, offline: true, reason: 'unparseable' };

  const parsed = ingredientCheckSchema.safeParse(raw);
  if (!parsed.success) return { found: [], unsure: true, offline: true, reason: 'invalid_shape' };

  const asked = new Set(input.wanted);
  const found = parsed.data.found.filter((f) => asked.has(f.name));

  return { found, unsure: parsed.data.unsure || found.length === 0, offline: false, model: result.model };
}
