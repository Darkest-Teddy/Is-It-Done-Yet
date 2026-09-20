/**
 * Puts the built-in recipes into a database, idempotently.
 *
 * Upsert by slug rather than insert, so running it twice is not an error and re-running after
 * editing `src/core/recipe.ts` updates the rows in place. That matters more than it sounds: the
 * alternative is a wipe-and-reload, which would take user-submitted recipes with it.
 *
 * `createdAt` is set only on insert (`$setOnInsert`), so a reseed does not rewrite history.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedRecipeSchema } from './schemas.js';

const here = dirname(fileURLToPath(import.meta.url));

export function builtinRecipes() {
  const raw = JSON.parse(readFileSync(resolve(here, 'builtin-recipes.json'), 'utf8'));
  // Validated against the same schema the API uses. A generator bug should fail here, loudly,
  // rather than put a document into the collection that no endpoint can serve.
  return raw.map((doc, i) => {
    const parsed = seedRecipeSchema.safeParse(doc);
    if (!parsed.success) {
      throw new Error(`builtin recipe ${i} (${doc.slug ?? '?'}) is invalid: ${JSON.stringify(parsed.error.issues)}`);
    }
    return parsed.data;
  });
}

export async function seed(db, recipes = builtinRecipes()) {
  const collection = db.collection('recipes');
  let inserted = 0;
  let updated = 0;

  for (const recipe of recipes) {
    const { slug, ...rest } = recipe;
    const result = await collection.updateOne(
      { slug },
      { $set: rest, $setOnInsert: { slug, createdAt: new Date() } },
      { upsert: true },
    );
    if (result.upsertedCount > 0) inserted += 1;
    else updated += 1;
  }

  return { inserted, updated, total: recipes.length };
}
