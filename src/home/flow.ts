/**
 * The four screens, the state they share, and the moves between them.
 *
 * Deliberately not a framework. The deployed page is four `<section>`s with an `on` class
 * toggled between them, and that is the right shape for four screens: each one builds its DOM
 * once and then mutates it, which is less code than a render loop and less work for a
 * compositor that may be running over a live camera.
 *
 * What is added here is the seam the deployed page does not have. There, every screen reaches
 * into `document.getElementById` and the navigation is spread across nine listeners, so what
 * happens when the counter changes is not written down anywhere. Here the counter is the only
 * writer, the library and the dish card are readers, and `subscribe` is where they meet. That
 * is the difference between a flow you can follow and one you have to run to understand.
 */

import type { Pantry } from '../core/pantry.js';
import { emptyPantry } from '../core/pantry.js';
import type { RecipeMatch } from '../core/pantry.js';

export type ScreenId = 's-title' | 's-counter' | 's-library' | 's-dish';

export const SCREEN_IDS: readonly ScreenId[] = ['s-title', 's-counter', 's-library', 's-dish'];

export interface Screen {
  readonly node: HTMLElement;
  /** Called every time this screen becomes visible, including on a return to it. */
  readonly onShow?: () => void;
}

export interface Flow {
  /** What the camera and the cloud model between them believe is on the counter. */
  readonly pantry: Pantry;
  /** The dish the card is showing, or null before one has been chosen. */
  readonly selected: RecipeMatch | null;
  setPantry(pantry: Pantry): void;
  /** Notified whenever the counter changes. Returns its own unsubscribe. */
  subscribe(listener: (pantry: Pantry) => void): () => void;
  show(id: ScreenId): void;
  openDish(match: RecipeMatch): void;
}

export interface Router extends Flow {
  register(id: ScreenId, screen: Screen): void;
}

export function createRouter(mount: HTMLElement): Router {
  const screens = new Map<ScreenId, Screen>();
  const listeners = new Set<(pantry: Pantry) => void>();

  let pantry = emptyPantry();
  let selected: RecipeMatch | null = null;

  const router: Router = {
    get pantry() {
      return pantry;
    },

    get selected() {
      return selected;
    },

    setPantry(next) {
      pantry = next;
      for (const listener of listeners) listener(pantry);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(pantry);
      return () => listeners.delete(listener);
    },

    register(id, screen) {
      screens.set(id, screen);
      screen.node.id = id;
      screen.node.classList.add('screen');
      mount.append(screen.node);
    },

    show(id) {
      for (const [key, screen] of screens) screen.node.classList.toggle('is-on', key === id);
      // The deployed page scrolls to the top on every move and it is right to: a screen change
      // that leaves you halfway down the previous screen's scroll position reads as the page
      // having jumped rather than as having navigated.
      window.scrollTo(0, 0);
      screens.get(id)?.onShow?.();
    },

    openDish(match) {
      selected = match;
      router.show('s-dish');
    },
  };

  return router;
}
