/**
 * Turns the server's built-in recipes into the offline bundle the headset ships with.
 *
 * `RecipeBook` loads `Resources/bundled-recipes` FIRST and lets the server's list replace it
 * if one arrives. That order is the whole point: the shelf is never empty, not even for the
 * second before a request resolves, and never at all if it does not. The file simply did not
 * exist, so the shelf was empty on a cold start and stayed empty without a server.
 *
 * Output is the exact shape `RecipeListDto` parses -- an object with a named array, because
 * JsonUtility cannot parse a top-level array.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coverFor } from '../../server/src/cover.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SOURCE = resolve(repo, 'server/src/builtin-recipes.json');
const OUTPUT = resolve(repo, 'unity/Assets/IsItDoneYet/App/Resources/bundled-recipes.json');

/**
 * Derives the safety flags from a step's own words.
 *
 * A HEURISTIC, and labelled as one. The thirteen built-in recipes were written before the
 * schema carried `hot` and `knife`, so none of them declares either -- and without them the
 * headset's SAFE mode can never fire on a bundled recipe, which is the one feature that
 * exists because somebody is about to reach toward a hot pan.
 *
 * Deliberately over-inclusive. A false positive collapses the HUD to a calm pill on a step
 * that did not need it, which costs a moment of screen space. A false negative leaves the
 * full animated HUD up while somebody picks up a knife. Those are not symmetric.
 *
 * Anything authored from now on should set the flags explicitly; the schema accepts them.
 */
const KNIFE = /\b(slice|sliced|slicing|dice|diced|dicing|chop|chopped|chopping|cut|cutting|mince|minced|julienne|brunoise|chiffonade|carve|trim|halve|quarter|shred|core|de-?seed)\b/i;
const HOT = /\b(sear|fry|fried|frying|saut|boil|boiling|simmer|heat|heated|preheat|cook|cooking|bake|baking|roast|grill|toast|broil|steam|reduce|melt|melted|pan|skillet|stove|oven|burner|hob|flame|scald|blanch)\b/i;

function flags(step) {
  const text = `${step.text ?? ''} ${step.technique ?? ''}`;
  return { hot: HOT.test(text), knife: KNIFE.test(text) };
}

const recipes = JSON.parse(await readFile(SOURCE, 'utf8')).map((recipe) => ({
  id: '',
  slug: recipe.slug,
  title: recipe.title,
  description: recipe.description ?? '',
  servings: recipe.servings ?? 2,
  tags: recipe.tags ?? [],
  source: recipe.source ?? 'builtin',
  ingredients: (recipe.ingredients ?? []).map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    notes: i.notes ?? '',
  })),
  steps: (recipe.steps ?? []).map((s) => ({
    order: s.order,
    text: s.text,
    // JsonUtility has no nullable int, so an absent duration has to be 0 rather than missing.
    durationSec: s.durationSec ?? 0,
    technique: s.technique ?? '',
    stepId: s.stepId ?? '',
    verifiable: s.verifiable ?? '',
    ...flags(s),
  })),
  // Same derivation the server uses, so an offline card and an online one look identical.
  cover: coverFor(recipe),
}));

await writeFile(OUTPUT, `${JSON.stringify({ recipes, total: recipes.length }, null, 2)}\n`);

const hot = recipes.reduce((n, r) => n + r.steps.filter((s) => s.hot).length, 0);
const knife = recipes.reduce((n, r) => n + r.steps.filter((s) => s.knife).length, 0);
const steps = recipes.reduce((n, r) => n + r.steps.length, 0);
console.log(`${recipes.length} recipes, ${steps} steps -> ${hot} hot, ${knife} knife`);
console.log(OUTPUT);
