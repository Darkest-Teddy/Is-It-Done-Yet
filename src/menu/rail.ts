/**
 * The strip along the bottom of every screen.
 *
 * In the design document this was a legend: A opens the library, B asks the chef to pick, Y
 * goes back. It has to be more than a legend here, and the reason is worth stating because it
 * shaped the whole interaction model.
 *
 * A page running in a Quest Browser tab is a 2D window. It gets a pointer ray and a keyboard;
 * it does NOT get controller face buttons -- those only reach a page inside an immersive WebXR
 * session, and this app deliberately is not one (see `passthrough.ts` for why). So a row of A /
 * B / X / Y badges that does nothing when you press A on the controller is a lie printed along
 * the bottom of every screen.
 *
 * The fix is to make the legend the control. Each entry is a real button you can point the ray
 * at, and the letter on it is also its keyboard shortcut, so a Bluetooth keyboard or a laptop
 * driving the same build gets the shortcut the badge advertises. Everything reachable from the
 * rail is also reachable from a large target inside the screen, so the rail is a shortcut and
 * never the only way through.
 */

import { button, h } from './dom.js';

export interface RailAction {
  /** What is printed on the badge: 'A', 'B', 'X', 'Y', 'TRIG', 'GRIP', or the menu glyph. */
  readonly key: string;
  readonly label: string;
  readonly onPress: () => void;
  /** Yellow badge and yellow text. The artboard used it for the one primary action. */
  readonly accent?: boolean;
  /** Pushed to the right end of the rail. */
  readonly end?: boolean;
  readonly disabled?: boolean;
  /**
   * Keyboard key, lower case, when it is not just the first character of `key`. Given
   * explicitly for the ones that have no letter: trigger is Enter, grip is Shift.
   */
  readonly shortcut?: string;
}

export interface Rail {
  readonly node: HTMLElement;
  readonly destroy: () => void;
  /** Re-renders in place, for a rail whose actions change with panel state. */
  readonly update: (actions: readonly RailAction[]) => void;
}

const shortcutOf = (action: RailAction): string =>
  (action.shortcut ?? action.key.charAt(0)).toLowerCase();

/**
 * @param onEscape Where Escape and Backspace go. Every screen but the title has a Back, and a
 *   headset user who has lost the pointer needs a way out that does not require aiming.
 */
export function createRail(
  actions: readonly RailAction[],
  onEscape?: () => void,
): Rail {
  const node = h('nav', { class: 'rail', attrs: { 'aria-label': 'Controls' } });
  let current: readonly RailAction[] = [];

  function render(next: readonly RailAction[]): void {
    current = next;
    node.replaceChildren();

    for (const action of next) {
      const badge = h('span', {
        class: `rail__key${action.accent === true ? ' rail__key--sun' : ''}`
          + (action.key.length > 2 ? ' rail__key--wide' : ''),
        text: action.key,
        attrs: { 'aria-hidden': 'true' },
      });

      const entry = button(
        `rail__btn${action.accent === true ? ' rail__btn--accent' : ''}`
          + (action.end === true ? ' rail__end' : ''),
        () => {
          if (action.disabled !== true) action.onPress();
        },
        badge,
        h('span', { class: 'rail__text', text: action.label }),
      );

      if (action.disabled === true) entry.disabled = true;
      // The badge is decorative to a screen reader; the accessible name is the label plus the
      // shortcut, which is what someone actually needs to hear.
      entry.setAttribute('aria-keyshortcuts', shortcutOf(action));
      node.appendChild(entry);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    // A shortcut must never eat a character someone is typing into the search box or the name
    // field. Anything with a text caret owns the keyboard while it has focus.
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (event.key === 'Escape') target.blur();
      return;
    }

    if ((event.key === 'Escape' || event.key === 'Backspace') && onEscape !== undefined) {
      event.preventDefault();
      onEscape();
      return;
    }

    const pressed = event.key === 'Enter' ? 'enter'
      : event.key === 'Shift' ? 'shift'
      : event.key.toLowerCase();

    const match = current.find((action) => shortcutOf(action) === pressed);
    if (match === undefined || match.disabled === true) return;

    // Enter is also "activate the focused button". Letting both fire would double-trigger.
    if (pressed === 'enter' && document.activeElement instanceof HTMLButtonElement) return;

    event.preventDefault();
    match.onPress();
  }

  render(actions);
  window.addEventListener('keydown', onKeyDown);

  return {
    node,
    update: render,
    destroy: () => window.removeEventListener('keydown', onKeyDown),
  };
}
