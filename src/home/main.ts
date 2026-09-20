/**
 * Entry point for the cook flow at `homev2.html`.
 *
 * WHY THIS EXISTS AS A SEPARATE ENTRY. Three pages in this repository are the same app seen
 * from three places and they are deliberately not merged:
 *
 *   `index.html`  the laptop debug app -- the cooking loop, sliders, raw numbers.
 *   `app.html`    the front of house as the artboard draws it: seven fixed screens at their
 *                 true 1440x810 size, scaled by one transform, built to be read at arm's
 *                 length through a lens.
 *   `homev2.html`   THIS -- the same cook flow as a page anyone can open in a browser at any
 *                 window size, which is what was deployed and what the public link shows.
 *
 * The deployed version of this page is not in this repository (DECISIONS.md #27). Its
 * structure was read off the live HTML and its behaviour off the shipped bundle, and both were
 * rebuilt here against the same tested core the rest of the app uses -- `src/core/pantry.ts`
 * for the tally and the matching, `src/core/recipe.ts` for the dishes, `src/vision/segment.ts`
 * for the frames. Nothing in `src/menu/` or `app.html` is touched.
 */

import './theme.css';
import './screens.css';

import { createRouter } from './flow.js';
import { createCounter } from './screens/counter.js';
import { createDish } from './screens/dish.js';
import { createLibrary } from './screens/library.js';
import { createTitle } from './screens/title.js';

const mount = document.getElementById('app');
if (mount === null) throw new Error('#app is missing from the document');

const router = createRouter(mount);

// Registered in flow order, which is also paint order. The dish card is last because it is the
// only screen that can be reached from two places.
router.register('s-title', createTitle(router));
router.register('s-counter', createCounter(router));
router.register('s-library', createLibrary(router));
router.register('s-dish', createDish(router));

router.show('s-title');

/**
 * Last-resort reporting.
 *
 * A page opened on a headset has no console without plugging a cable in, so an uncaught error
 * would otherwise present as a screen that simply stopped responding. A banner naming the
 * error is the difference between a five-second diagnosis and a five-minute one.
 */
function reportFatal(message: string): void {
  const existing = document.getElementById('fatal');
  const banner = existing ?? document.createElement('div');
  banner.id = 'fatal';
  banner.textContent = `Something broke: ${message}`;
  if (existing === null) document.body.append(banner);
}

window.addEventListener('error', (event) => reportFatal(event.message));
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | undefined;
  reportFatal(reason?.message ?? String(event.reason));
});
