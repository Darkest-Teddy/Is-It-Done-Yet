/**
 * App state and the screen router.
 *
 * Seven screens, one mount point, a back stack. Deliberately not a framework: the whole app is
 * a handful of panels that each build their own DOM once and then mutate it, which is both less
 * code than a render loop and less work for a mobile GPU already running a compositor over a
 * live camera.
 *
 * Panels never navigate by reaching for each other. They call `ctx.go`, which is what keeps the
 * flow in one readable place -- and what makes the back stack correct, since a screen that
 * knows only "go to the dish card" cannot also get the history wrong.
 */

import { emptyPantry, type Pantry } from '../core/pantry.js';
import { RECIPES, type Recipe } from '../core/recipe.js';
import { loadBoard, saveBoard, seedBoard, type RoundEntry } from './board.js';

export type Route = 'title' | 'loading' | 'counter' | 'pick' | 'library' | 'dish' | 'cutting';

export interface RouteParams {
  /** Where the loading screen goes when it finishes. */
  readonly next?: Route;
  readonly recipeId?: string;
  /** Cutting round with no clock and no board entry. Reached from the dish card. */
  readonly practice?: boolean;
}

export interface RoundResult {
  readonly evenness: number;
  readonly pieces: number;
  readonly seconds: number;
  readonly total: number;
  /**
   * How many piece widths the round actually measured.
   *
   * Carried separately because zero measurements and a genuinely terrible cut both produce a
   * total of 0, and they are not the same thing: one is a score, the other is the absence of
   * one. Only a round with measurements behind it may go on the board.
   */
  readonly measurements: number;
}

export interface AppState {
  readonly pantry: Pantry;
  readonly recipes: readonly Recipe[];
  /** Library search box. */
  readonly query: string;
  /** Library filter chip id, or null for "everything". */
  readonly filter: string | null;
  /** Which recommendation the chef's pick screen is showing, so "pick another" advances. */
  readonly pickIndex: number;
  readonly selectedRecipeId: string | null;
  readonly board: readonly RoundEntry[];
  readonly lastRound: RoundResult | null;
  readonly playerName: string;
  /** Best total this device has ever posted. Drives the rank badge on the title screen. */
  readonly best: number;
  /** False until the scan has been run once, so the counter panel can say so. */
  readonly scanned: boolean;
}

export interface Panel {
  readonly node: HTMLElement;
  /** Released on navigation away: camera holds, loops, timers, listeners. */
  readonly destroy?: () => void;
  /** Called when the panel is shown again without being rebuilt. */
  readonly refresh?: () => void;
}

export interface AppContext {
  readonly state: AppState;
  setState(patch: Partial<AppState>): void;
  subscribe(listener: (state: AppState) => void): () => void;
  go(route: Route, params?: RouteParams): void;
  back(): void;
  /** The recipe the dish card and the cutting round are working on, or null. */
  selectedRecipe(): Recipe | null;
}

export type PanelFactory = (ctx: AppContext, params: RouteParams) => Panel;

const NAME_KEY = 'idy.player.v1';
const BEST_KEY = 'idy.best.v1';

function readString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number): number {
  const raw = Number.parseFloat(readString(key, ''));
  return Number.isFinite(raw) ? raw : fallback;
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota or private browsing. Nothing here is worth failing a screen over.
  }
}

export function createApp(mount: HTMLElement, panels: Readonly<Record<Route, PanelFactory>>): AppContext {
  const stored = loadBoard();
  const board = stored.length > 0 ? stored : seedBoard(Date.now());
  if (stored.length === 0) saveBoard(board);

  let state: AppState = {
    pantry: emptyPantry(),
    recipes: RECIPES,
    query: '',
    filter: null,
    pickIndex: 0,
    selectedRecipeId: null,
    board,
    lastRound: null,
    playerName: readString(NAME_KEY, 'You'),
    best: readNumber(BEST_KEY, 0),
    scanned: false,
  };

  const listeners = new Set<(state: AppState) => void>();
  const history: { route: Route; params: RouteParams }[] = [];
  let live: Panel | null = null;

  const ctx: AppContext = {
    get state() {
      return state;
    },

    setState(patch) {
      state = { ...state, ...patch };
      if (patch.board !== undefined) saveBoard(state.board);
      if (patch.playerName !== undefined) write(NAME_KEY, state.playerName);
      if (patch.best !== undefined) write(BEST_KEY, String(state.best));
      for (const listener of listeners) listener(state);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    go(route, params = {}) {
      // The loading screen is a step, not a place. Leaving it on the stack would make Back
      // from the counter replay the boot sequence, which reads as a crash.
      if (history[history.length - 1]?.route === 'loading') history.pop();

      const previous = history[history.length - 1];
      // Re-entering the screen you are already on replaces the entry instead of stacking it,
      // which a double-tapped ray produces more often than you would think.
      if (previous !== undefined && previous.route === route) {
        history[history.length - 1] = { route, params };
      } else {
        history.push({ route, params });
      }
      show(route, params);
    },

    back() {
      if (history.length > 1) history.pop();
      const target = history[history.length - 1] ?? { route: 'title' as Route, params: {} };
      show(target.route, target.params);
    },

    selectedRecipe() {
      const id = state.selectedRecipeId;
      if (id === null) return null;
      return state.recipes.find((recipe) => recipe.id === id) ?? null;
    },
  };

  function show(route: Route, params: RouteParams): void {
    live?.destroy?.();
    mount.replaceChildren();

    const factory = panels[route];
    live = factory(ctx, params);
    mount.appendChild(live.node);

    // Move focus to the screen so the keyboard fallback has somewhere to send keys, and so a
    // screen reader announces the new screen rather than staying on a button that is gone.
    live.node.setAttribute('tabindex', '-1');
    live.node.focus({ preventScroll: true });
  }

  return ctx;
}
