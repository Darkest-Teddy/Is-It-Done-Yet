/**
 * The recipe library and the level-preview screen.
 *
 * Both are UIKitML documents in `public/ui/`, driven through the DOM-like handles IWSDK exposes
 * (`requireElementById`, `setProperties`). Markup carries the layout; this file carries only the
 * data binding, which keeps the visual work editable without touching TypeScript.
 *
 * Rows and ingredient chips are PRE-DECLARED in the markup and shown or hidden here rather than
 * constructed at runtime. Building UIKit components by hand is more code and fails silently in
 * a headset, where there is no console to read. The cost is a fixed ceiling on visible rows,
 * which `MAX_ROWS` states out loud rather than truncating quietly.
 */

import { loadUIKitMLAsset, type UIKitMLAsset } from '@iwsdk/core';

import {
  iconFor,
  matchRecipe,
  rankRecipes,
  recommend,
  searchRecipes,
  type Pantry,
  type RecipeMatch,
} from '../core/pantry.js';
import type { Recipe } from '../core/recipe.js';

/** Row slots declared in library.uikitml. Recipes beyond this are counted, not listed. */
export const MAX_ROWS = 6;
/** Ingredient chip slots declared in preview.uikitml, per section. */
const MAX_CHIPS = 6;

/** UIKit's property types are zod-inferred and enormous; this is the slice we actually use. */
type El = { setProperties: (props: Record<string, unknown>) => void };

const show = (el: El, visible: boolean): void =>
  el.setProperties({ display: visible ? 'flex' : 'none' });

const setText = (el: El, text: string): void => el.setProperties({ text });

export interface PanelCallbacks {
  /** Fired when the cook commits to a dish from the preview screen. */
  readonly onStart: (recipe: Recipe) => void;
}

export class RecipePanels {
  private pantry: Pantry;
  private recipes: readonly Recipe[];
  private query = '';
  /** Ranked matches currently listed, so a row click maps back to the right recipe. */
  private listed: readonly RecipeMatch[] = [];

  private constructor(
    readonly library: UIKitMLAsset,
    readonly preview: UIKitMLAsset,
    private readonly callbacks: PanelCallbacks,
    pantry: Pantry,
    recipes: readonly Recipe[],
  ) {
    this.pantry = pantry;
    this.recipes = recipes;
  }

  static async load(
    pantry: Pantry,
    recipes: readonly Recipe[],
    callbacks: PanelCallbacks,
  ): Promise<RecipePanels> {
    const [library, preview] = await Promise.all([
      loadUIKitMLAsset(`${import.meta.env.BASE_URL}ui/library.uikitml`),
      loadUIKitMLAsset(`${import.meta.env.BASE_URL}ui/preview.uikitml`),
    ]);

    const panels = new RecipePanels(library, preview, callbacks, pantry, recipes);
    panels.wire();
    panels.showLibrary();
    return panels;
  }

  private el(asset: UIKitMLAsset, id: string): El {
    // `requireElementById` throws on a missing id, which is what we want: a renamed id should
    // fail loudly at startup rather than render a panel with silently empty rows.
    return asset.document.requireElementById(id) as unknown as El;
  }

  private wire(): void {
    this.el(this.library, 'library-search').setProperties({
      // Fires per keystroke from the headset keyboard, so the list filters as the cook types.
      onValueChange: (value: string) => {
        this.query = value;
        this.renderLibrary();
      },
    });

    this.el(this.library, 'library-recommend').setProperties({
      onClick: () => {
        const pick = recommend(this.pantry, this.recipes);
        // Null means nothing on the counter is actually makeable. Saying so is the honest
        // answer; suggesting a dish they cannot finish costs them the time to find out.
        if (pick === null) {
          setText(this.el(this.library, 'library-count'), 'Nothing here is makeable yet — scan more ingredients');
          return;
        }
        this.showPreview(pick);
      },
    });

    for (let i = 0; i < MAX_ROWS; i += 1) {
      this.el(this.library, `row-${i}`).setProperties({
        onClick: () => {
          const match = this.listed[i];
          if (match !== undefined) this.showPreview(match);
        },
      });
    }

    this.el(this.preview, 'preview-back').setProperties({
      onClick: () => this.showLibrary(),
    });
  }

  /** Re-scan and re-render. Called after the setup scan, or when the cook edits the pantry. */
  setPantry(pantry: Pantry): void {
    this.pantry = pantry;
    this.renderLibrary();
  }

  showLibrary(): void {
    show(this.el(this.library, 'library-root'), true);
    show(this.el(this.preview, 'preview-root'), false);
    this.renderLibrary();
  }

  private renderLibrary(): void {
    const filtered = searchRecipes(this.recipes, this.query);
    const ranked = rankRecipes(this.pantry, filtered);
    this.listed = ranked.slice(0, MAX_ROWS);

    const makeable = ranked.filter((m) => m.makeable).length;
    const hidden = ranked.length - this.listed.length;
    setText(
      this.el(this.library, 'library-count'),
      ranked.length === 0
        ? 'no matches'
        : `${makeable} of ${ranked.length} ready to cook${hidden > 0 ? ` · ${hidden} more not shown` : ''}`,
    );

    show(this.el(this.library, 'library-empty'), ranked.length === 0);

    for (let i = 0; i < MAX_ROWS; i += 1) {
      const match = this.listed[i];
      const row = this.el(this.library, `row-${i}`);
      if (match === undefined) {
        show(row, false);
        continue;
      }
      show(row, true);

      const { recipe } = match;
      setText(this.el(this.library, `row-${i}-icon`), recipe.icon);
      setText(this.el(this.library, `row-${i}-name`), recipe.name);
      setText(
        this.el(this.library, `row-${i}-meta`),
        `${recipe.difficulty} · ${recipe.averageMinutes} min`,
      );

      const status = match.makeable
        ? 'Ready to cook'
        : `Missing ${match.missing.length}: ${match.missing.map((m) => m.icon).join(' ')}`;
      setText(this.el(this.library, `row-${i}-status`), status);
      this.el(this.library, `row-${i}-status`).setProperties({
        color: match.makeable ? '#8ee06a' : '#e0b86a',
      });
    }
  }

  showPreview(match: RecipeMatch): void {
    const fresh = matchRecipe(this.pantry, match.recipe);
    const { recipe } = fresh;

    show(this.el(this.library, 'library-root'), false);
    show(this.el(this.preview, 'preview-root'), true);

    setText(this.el(this.preview, 'preview-icon'), recipe.icon);
    setText(this.el(this.preview, 'preview-name'), recipe.name);
    setText(this.el(this.preview, 'preview-description'), recipe.description);
    setText(this.el(this.preview, 'preview-time'), `${recipe.averageMinutes} min`);

    const difficulty = this.el(this.preview, 'preview-difficulty');
    setText(difficulty, recipe.difficulty);
    difficulty.setProperties({
      backgroundColor:
        recipe.difficulty === 'easy' ? '#8ee06a'
        : recipe.difficulty === 'medium' ? '#e0b86a'
        : '#e06a6a',
    });

    setText(
      this.el(this.preview, 'preview-match'),
      fresh.makeable ? 'all ingredients ready' : `${fresh.missing.length} missing`,
    );

    this.fillChips('have', fresh.matched.map((m) => `${m.icon}|${m.have} ${m.ingredient}`));
    this.fillChips('miss', fresh.missing.map((m) => `${m.icon}|need ${m.needed} ${m.ingredient}`));
    show(this.el(this.preview, 'preview-missing-title'), fresh.missing.length > 0);

    // A dish you cannot finish should not be startable. The button stays visible but inert and
    // restyled, so the reason is obvious rather than the control simply vanishing.
    const start = this.el(this.preview, 'preview-start');
    setText(start, fresh.makeable ? 'Start cooking' : 'Missing ingredients');
    start.setProperties({
      backgroundColor: fresh.makeable ? '#8ee06a' : '#3a3f47',
      color: fresh.makeable ? '#12151a' : '#8a929c',
      onClick: () => {
        if (fresh.makeable) this.callbacks.onStart(recipe);
      },
    });
  }

  /** Fills one chip section. `entries` are "icon|text" pairs; extras beyond the slots are dropped. */
  private fillChips(prefix: string, entries: readonly string[]): void {
    for (let i = 0; i < MAX_CHIPS; i += 1) {
      const entry = entries[i];
      const chip = this.el(this.preview, `${prefix}-${i}`);
      if (entry === undefined) {
        show(chip, false);
        continue;
      }
      show(chip, true);
      const [icon = '', text = ''] = entry.split('|');
      setText(this.el(this.preview, `${prefix}-${i}-icon`), icon);
      setText(this.el(this.preview, `${prefix}-${i}-text`), text);
    }
  }
}
