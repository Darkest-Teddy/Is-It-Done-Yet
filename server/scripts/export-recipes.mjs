/**
 * Regenerates `src/builtin-recipes.json` from the app's own recipe table.
 *
 * The point is that there is exactly one place a built-in recipe is written down:
 * `src/core/recipe.ts`, which the coach already reads. A hand-maintained copy on the server
 * would drift within a day, and the drift would show up as a recipe whose steps no longer tick
 * themselves off -- a bug that looks like the vision pipeline failing.
 *
 * The generated file IS committed, because the Docker image has only `server/` in its build
 * context and `npm run seed` has to work there. Re-run this whenever `src/core/recipe.ts`
 * changes; `npm test` in this package fails if the two have diverged.
 *
 * Reads a .ts file directly: Node strips the types (all of them are erasable in that file), so
 * this needs no build step and no duplicate parser.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toRecipeDoc, toTicketDoc } from '../src/recipe-map.js';

const here = dirname(fileURLToPath(import.meta.url));
const dishes = resolve(here, '../../src/core/recipe.ts');
const tickets = resolve(here, '../../src/core/recipes.ts');
const target = resolve(here, '../src/builtin-recipes.json');

const { RECIPES: DISHES } = await import(dishes);
const { RECIPES: TICKETS } = await import(tickets);

const docs = [
  ...DISHES.map((recipe) => toRecipeDoc(recipe, 'captaincook4d')),
  ...TICKETS.map(toTicketDoc),
];

writeFileSync(target, `${JSON.stringify(docs, null, 2)}\n`);
console.log(`wrote ${docs.length} recipes to ${target}`);
