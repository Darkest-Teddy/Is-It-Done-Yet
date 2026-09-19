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
  adjustCount,
  confirmAll,
  emptyPantry,
  iconFor,
  isReviewed,
  matchRecipe,
  pantryFromScan,
  rankRecipes,
  recommend,
  searchRecipes,
  unconfirmed,
  type Pantry,
  type RawScanItem,
  type RecipeMatch,
} from '../core/pantry.js';
import type { Recipe } from '../core/recipe.js';

/** Row slots declared in library.uikitml. Recipes beyond this are counted, not listed. */
export const MAX_ROWS = 6;
/** Ingredient chip slots declared in preview.uikitml, per section. */
const MAX_CHIPS = 6;
/** Editable rows declared in scan.uikitml. */
const MAX_SCAN_ROWS = 8;

/** UIKit's property types are zod-inferred and enormous; this is the slice we actually use. */
type El = { setProperties: (props: Record<string, unknown>) => void };

const show = (el: El, visible: boolean): void =>
  el.setProperties({ display: visible ? 'flex' : 'none' });

const setText = (el: El, text: string): void => el.setProperties({ text });

export interface ScanResult {
  readonly items: readonly RawScanItem[];
  /** What limited the scan, if anything. Shown beside the review rows. */
  readonly notes: string;
}

export interface PanelCallbacks {
  /** Fired when the cook commits to a dish from the preview screen. */
  readonly onStart: (recipe: Recipe) => void;
  /**
   * Captures and analyses the counter. Null on any failure.
   *
   * Injected rather than called directly so these panels know nothing about OpenAI, cameras or
   * the network -- which is also what lets the whole flow be driven from a fixture.
   */
  readonly onScan: () => Promise<ScanResult | null>;
}

export class RecipePanels {
  private pantry: Pantry;
  private recipes: readonly Recipe[];
  private query = '';
  /** Ranked matches currently listed, so a row click maps back to the right recipe. */
  private listed: readonly RecipeMatch[] = [];

  private constructor(
    readonly scan: UIKitMLAsset,
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
    const [scan, library, preview] = await Promise.all([
      loadUIKitMLAsset(`${import.meta.env.BASE_URL}ui/scan.uikitml`),
      loadUIKitMLAsset(`${import.meta.env.BASE_URL}ui/library.uikitml`),
      loadUIKitMLAsset(`${import.meta.env.BASE_URL}ui/preview.uikitml`),
    ]);

    const panels = new RecipePanels(scan, library, preview, callbacks, pantry, recipes);
    panels.wire();
    // Setup comes first: the recipe list is meaningless until we know what is on the counter.
    panels.showScan();
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

    this.el(this.scan, 'scan-run').setProperties({ onClick: () => void this.runScan() });

    // Skip exists because a scan can fail for reasons the cook cannot fix at the counter -- no
    // key, no camera, bad light. A dead end there would strand them in setup with no way into
    // the app at all.
    this.el(this.scan, 'scan-skip').setProperties({
      onClick: () => {
        this.pantry = emptyPantry();
        this.showLibrary();
      },
    });

    this.el(this.scan, 'scan-done').setProperties({
      onClick: () => {
        if (this.pantry.items.length === 0) return;
        this.pantry = confirmAll(this.pantry);
        this.showLibrary();
      },
    });

    for (let i = 0; i < MAX_SCAN_ROWS; i += 1) {
      const nudge = (delta: number) => () => {
        const item = this.scanned[i];
        if (item === undefined) return;
        this.pantry = adjustCount(this.pantry, item.ingredient, delta);
        this.renderScan();
      };
      this.el(this.scan, `scan-${i}-plus`).setProperties({ onClick: nudge(1) });
      this.el(this.scan, `scan-${i}-minus`).setProperties({ onClick: nudge(-1) });
    }
  }

  /** Rows currently listed, so a +/- press maps back to the right ingredient. */
  private scanned: readonly Pantry['items'][number][] = [];

  private setScanStatus(text: string, notes = ''): void {
    setText(this.el(this.scan, 'scan-status'), text);
    setText(this.el(this.scan, 'scan-notes'), notes);
  }

  showScan(): void {
    show(this.el(this.scan, 'scan-root'), true);
    show(this.el(this.library, 'library-root'), false);
    show(this.el(this.preview, 'preview-root'), false);
    this.renderScan();
  }

  private async runScan(): Promise<void> {
    this.setScanStatus('Looking at your counter…');
    const result = await this.callbacks.onScan();

    if (result === null) {
      // Say what failed and leave Skip available. Pretending a failed scan found nothing would
      // be indistinguishable from an empty counter, and the cook could not tell which.
      this.setScanStatus('Scan failed — check the camera and key, or press Skip.');
      return;
    }

    this.pantry = pantryFromScan(result.items, 0);
    const queue = unconfirmed(this.pantry).length;
    this.setScanStatus(
      this.pantry.items.length === 0
        ? 'Nothing recognised. Try again with more light, or press Skip.'
        : queue === 0
          ? `Found ${this.pantry.items.length} ingredients. Check them and continue.`
          : `Found ${this.pantry.items.length} ingredients — ${queue} I am unsure about. Please check the amber rows.`,
      result.notes,
    );
    this.renderScan();
  }

  private renderScan(): void {
    this.scanned = this.pantry.items;

    for (let i = 0; i < MAX_SCAN_ROWS; i += 1) {
      const item = this.scanned[i];
      const row = this.el(this.scan, `scan-${i}`);
      if (item === undefined) {
        show(row, false);
        continue;
      }
      show(row, true);

      setText(this.el(this.scan, `scan-${i}-icon`), iconFor(item.ingredient));
      setText(this.el(this.scan, `scan-${i}-name`), item.ingredient);
      setText(this.el(this.scan, `scan-${i}-count`), String(item.count));
      setText(
        this.el(this.scan, `scan-${i}-conf`),
        item.confirmed ? 'confirmed' : `${Math.round(item.confidence * 100)}% sure`,
      );
      // Amber rim marks a row as a question rather than a fact.
      row.setProperties({
        borderColor: item.confirmed || item.confidence >= 0.75 ? '#2b323d' : '#e0b86a',
      });
    }

    const ready = this.pantry.items.length > 0;
    const done = this.el(this.scan, 'scan-done');
    setText(done, ready
      ? isReviewed(this.pantry) ? 'Looks right — show recipes' : 'Accept all — show recipes'
      : 'Scan first');
    done.setProperties({
      backgroundColor: ready ? '#8ee06a' : '#3a3f47',
      color: ready ? '#12151a' : '#8a929c',
    });
  }

  /** Re-scan and re-render. Called after the setup scan, or when the cook edits the pantry. */
  setPantry(pantry: Pantry): void {
    this.pantry = pantry;
    this.renderLibrary();
  }

  showLibrary(): void {
    show(this.el(this.scan, 'scan-root'), false);
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

    show(this.el(this.scan, 'scan-root'), false);
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
