/**
 * The recipe book, the global board, and the one function that submits a cutting score.
 *
 * Plain DOM against the markup already in index.html, in the same style as the rest of the
 * debug app: the HTML declares the structure and the stylesheet, this file only binds. That is
 * what lets both panels work unchanged in Quest Browser, which runs this page as an ordinary
 * 2D web page, and in the desktop preview.
 *
 * EVERY string that came from a stranger is written with `textContent`. Never `innerHTML`, not
 * once, not for a name that "has already been sanitised" -- the server's filter and this rule
 * are two independent defences and the board is the one surface in this project where a
 * stranger's text is shown to a room.
 *
 * Nothing here can leave the UI in a stuck state when the network is gone: `src/net/api.ts`
 * returns failures rather than throwing, and each panel has something local to fall back to --
 * the bundled recipes, and the booth board in localStorage.
 */

import {
  configured, createRecipe, fetchLeaderboard, fetchRecipes, submitScore,
  type BoardEntry,
} from '../net/api.js';
import type { Recipe } from '../core/recipe.js';
import { RECIPES as BUILTIN } from '../core/recipe.js';
import { UNITS, type DocIngredient, type Unit } from '../core/recipeDoc.js';

const NAME_STORE = 'mise.playerName';
/** Mirrors the server's cap, so a name is trimmed before it is rejected rather than after. */
const NAME_MAX = 20;

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

const show = (el: HTMLElement, visible: boolean): void => { el.hidden = !visible; };

const text = (tag: string, className: string, content: string): HTMLElement => {
  const el = document.createElement(tag);
  if (className !== '') el.className = className;
  el.textContent = content;
  return el;
};

function rememberedName(): string {
  try { return localStorage.getItem(NAME_STORE) ?? ''; } catch { return ''; }
}

function rememberName(name: string): void {
  try { localStorage.setItem(NAME_STORE, name); } catch { /* private browsing; not worth a message */ }
}

// ---- Recipe book ---------------------------------------------------------------------------

export interface RecipeBookOptions {
  /** Hands the chosen recipe to whatever is running the cook. */
  readonly onChoose: (recipe: Recipe) => void;
}

/**
 * Searchable list plus a short create form.
 *
 * The bundled `RECIPES` are the list until the API answers, not a placeholder shown while it
 * loads -- so with no network, a dead API or an unset `VITE_API_URL` the recipe book is simply
 * the offline recipe book, immediately, with a line saying so.
 */
export function mountRecipeBook(options: RecipeBookOptions): { open: () => void } {
  const panel = byId('recipe-panel');
  const list = byId<HTMLUListElement>('recipe-list');
  const search = byId<HTMLInputElement>('recipe-search');
  const note = byId('recipe-note');
  const form = byId<HTMLFormElement>('recipe-form');
  const formToggle = byId<HTMLButtonElement>('recipe-form-toggle');
  const ingredientRows = byId('recipe-ingredients');
  const formNote = byId('recipe-form-note');

  let recipes: readonly Recipe[] = BUILTIN;
  let source: 'api' | 'bundled' = 'bundled';

  function render(query: string): void {
    const needle = query.trim().toLowerCase();
    const shown = needle === ''
      ? recipes
      : recipes.filter((r) => `${r.name} ${r.tags.join(' ')} ${r.requires.map((q) => q.ingredient).join(' ')}`
        .toLowerCase().includes(needle));

    list.replaceChildren();
    if (shown.length === 0) {
      list.append(text('li', 'empty', 'Nothing matches that.'));
      return;
    }

    for (const recipe of shown) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.append(
        text('span', 'icon', recipe.icon),
        text('span', 'name', recipe.name),
        text('span', 'meta', `${recipe.difficulty} · ${recipe.steps.length} steps · ${recipe.averageMinutes} min`),
      );
      button.addEventListener('click', () => {
        options.onChoose(recipe);
        show(panel, false);
      });
      item.append(button);
      list.append(item);
    }
  }

  function setNote(): void {
    note.textContent = source === 'api'
      ? `${recipes.length} recipes from the server.`
      : configured
        ? `${recipes.length} bundled recipes — the server did not answer.`
        : `${recipes.length} bundled recipes — no VITE_API_URL set.`;
  }

  async function refresh(query?: string): Promise<void> {
    const result = await fetchRecipes(query);
    if (result.ok && result.value.length > 0) {
      recipes = result.value;
      source = 'api';
    } else if (!result.ok) {
      // Keep whatever is already listed. Replacing a working list with an error is the wrong
      // trade when the bundled recipes are perfectly usable.
      recipes = source === 'api' ? recipes : BUILTIN;
    }
    setNote();
    render(search.value);
  }

  search.addEventListener('input', () => { render(search.value); });
  byId('recipe-close').addEventListener('click', () => { show(panel, false); });

  // ---- create form ----

  function addIngredientRow(): void {
    const row = document.createElement('div');
    row.className = 'ing-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'ingredient';
    name.className = 'ing-name';
    name.required = true;

    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = '0';
    quantity.step = '0.25';
    // Prefilled, like every field in this form. Headset text entry is slow enough that a
    // sensible default a cook can leave alone is worth more than a blank they must fill.
    quantity.value = '1';
    quantity.className = 'ing-qty';

    const unit = document.createElement('select');
    unit.className = 'ing-unit';
    for (const u of UNITS) {
      const option = document.createElement('option');
      option.value = u;
      option.textContent = u;
      unit.append(option);
    }
    unit.value = 'piece';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ing-remove';
    remove.textContent = '×';
    remove.title = 'remove';
    remove.addEventListener('click', () => { row.remove(); });

    row.append(name, quantity, unit, remove);
    ingredientRows.append(row);
  }

  formToggle.addEventListener('click', () => {
    const opening = form.hidden;
    show(form, opening);
    formToggle.textContent = opening ? 'Cancel' : 'New recipe';
    if (opening && ingredientRows.children.length === 0) {
      addIngredientRow();
      addIngredientRow();
    }
  });

  byId('recipe-add-ingredient').addEventListener('click', addIngredientRow);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const title = byId<HTMLInputElement>('recipe-title').value.trim();
      // One step per line. A step list is the one part of a recipe with real length, and a
      // textarea is far less painful on a headset keyboard than a row of inputs.
      const steps = byId<HTMLTextAreaElement>('recipe-steps').value
        .split('\n').map((s) => s.trim()).filter((s) => s !== '');

      const ingredients: DocIngredient[] = [];
      for (const row of Array.from(ingredientRows.children)) {
        const name = (row.querySelector('.ing-name') as HTMLInputElement).value.trim();
        if (name === '') continue;
        const quantity = Number((row.querySelector('.ing-qty') as HTMLInputElement).value);
        ingredients.push({
          name,
          quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
          unit: (row.querySelector('.ing-unit') as HTMLSelectElement).value as Unit,
        });
      }

      if (title === '' || ingredients.length === 0 || steps.length === 0) {
        formNote.textContent = 'Needs a title, at least one ingredient and at least one step.';
        return;
      }
      if (!configured) {
        formNote.textContent = 'No VITE_API_URL set, so there is nowhere to save this.';
        return;
      }

      formNote.textContent = 'Saving…';
      const result = await createRecipe({
        // No slug: the server derives one from the title, and a client-chosen slug is how you
        // get two people at a booth racing for the same one.
        title,
        servings: Number(byId<HTMLInputElement>('recipe-servings').value) || 2,
        tags: ['user'],
        ingredients,
        steps: steps.map((s, i) => ({ order: i, text: s })),
      });

      if (!result.ok) {
        formNote.textContent = `Could not save: ${result.error}`;
        return;
      }

      formNote.textContent = `Saved "${result.value.name}".`;
      form.reset();
      ingredientRows.replaceChildren();
      show(form, false);
      formToggle.textContent = 'New recipe';
      await refresh(search.value);
    })();
  });

  setNote();
  render('');

  return {
    open(): void {
      show(panel, true);
      search.focus();
      void refresh(search.value);
    },
  };
}

// ---- Leaderboard ---------------------------------------------------------------------------

/** The rank this session most recently earned, so the row can be picked out of the list. */
let lastSubmitted: { name: string; rank: number } | null = null;

function renderBoard(listEl: HTMLOListElement, entries: readonly BoardEntry[]): void {
  listEl.replaceChildren();
  if (entries.length === 0) {
    listEl.append(text('li', 'empty', 'No scores yet. Be first.'));
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('li');
    if (lastSubmitted !== null && entry.rank === lastSubmitted.rank && entry.name === lastSubmitted.name) {
      row.className = 'mine';
    }
    row.append(
      text('span', 'rank', `${entry.rank}`),
      // textContent, always. See the file docstring.
      text('span', 'who', entry.name),
      text('span', 'pts', entry.score.toFixed(1)),
    );
    listEl.append(row);
  }
}

export function mountLeaderboard(): { open: () => void; refresh: () => Promise<void> } {
  const panel = byId('board-panel');
  const listEl = byId<HTMLOListElement>('board-list');
  const note = byId('board-note');

  async function refresh(): Promise<void> {
    if (!configured) {
      note.textContent = 'No VITE_API_URL set — this booth’s board is the one under the canvas.';
      renderBoard(listEl, []);
      return;
    }
    note.textContent = 'Loading…';
    const result = await fetchLeaderboard(20);
    if (!result.ok) {
      note.textContent = `Server unreachable (${result.error}). The booth board below the canvas still works.`;
      renderBoard(listEl, []);
      return;
    }
    note.textContent = `Top ${result.value.entries.length} of ${result.value.total}.`;
    renderBoard(listEl, result.value.entries);
  }

  byId('board-close').addEventListener('click', () => { show(panel, false); });
  byId('board-refresh').addEventListener('click', () => { void refresh(); });

  return {
    open(): void {
      show(panel, true);
      void refresh();
    },
    refresh,
  };
}

// ---- Submitting a run ----------------------------------------------------------------------

export interface RunResult {
  /** 0..1, straight from `scoreSession`. Converted to the board's 0..100 here, once. */
  readonly total: number;
  readonly meanMm: number;
  readonly sigmaMm: number;
  readonly cuts: number;
  readonly recipeId: string;
}

/**
 * The single entry point a finished cutting run calls.
 *
 * One function on purpose: whatever ends a run -- this debug app, the XR build, a future
 * Service mode -- submits the same way, and the name, the 0..1-to-0..100 conversion and the
 * metrics bag are decided here rather than three times.
 */
export async function submitCuttingScore(
  run: RunResult,
  name: string,
): Promise<{ ok: true; rank: number; total: number } | { ok: false; error: string }> {
  const trimmed = name.trim().slice(0, NAME_MAX);
  if (trimmed === '') return { ok: false, error: 'enter a name first' };
  if (!configured) return { ok: false, error: 'no VITE_API_URL set — saved to the booth board only' };

  rememberName(trimmed);

  const result = await submitScore({
    name: trimmed,
    score: Math.round(Math.min(1, Math.max(0, run.total)) * 1000) / 10,
    metrics: {
      meanMm: Number(run.meanMm.toFixed(2)),
      sigmaMm: Number(run.sigmaMm.toFixed(2)),
      cuts: run.cuts,
    },
    recipeSlug: `cut-${run.recipeId}`,
  });

  if (!result.ok) return { ok: false, error: result.error };
  lastSubmitted = { name: trimmed, rank: result.value.rank };
  return { ok: true, rank: result.value.rank, total: result.value.total };
}

/**
 * Wires the end-of-run block: the score, a prefilled name, a Submit button, then the rank.
 *
 * `currentRun` is a getter rather than a value because the score keeps changing while somebody
 * is still cutting, and a run that was captured when the panel mounted would submit a stale
 * number.
 */
export function mountRunSubmit(currentRun: () => RunResult | null, onSubmitted: () => void): {
  update: () => void;
} {
  const block = byId('run-submit');
  const summary = byId('run-summary');
  const nameInput = byId<HTMLInputElement>('run-name');
  const button = byId<HTMLButtonElement>('run-send');
  const note = byId('run-note');

  nameInput.value = rememberedName();
  nameInput.maxLength = NAME_MAX;

  button.addEventListener('click', () => {
    void (async () => {
      const run = currentRun();
      if (run === null) { note.textContent = 'Nothing to submit yet.'; return; }

      button.disabled = true;
      note.textContent = 'Sending…';
      const result = await submitCuttingScore(run, nameInput.value);
      button.disabled = false;

      if (!result.ok) { note.textContent = result.error; return; }
      note.textContent = `Rank ${result.rank} of ${result.total}.`;
      onSubmitted();
    })();
  });

  return {
    update(): void {
      const run = currentRun();
      show(block, run !== null);
      if (run === null) return;
      summary.textContent = `${(run.total * 100).toFixed(1)} points · ${run.meanMm.toFixed(1)}mm average, ±${run.sigmaMm.toFixed(1)}mm over ${run.cuts} cuts`;
    },
  };
}
