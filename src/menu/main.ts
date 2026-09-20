/**
 * Entry point for the front-of-house app -- the seven screens from the menu design, running in
 * the Quest Browser.
 *
 * This is a plain page, not a WebXR session, and that is a deliberate architectural choice
 * rather than a shortcut. Quest Browser does not implement WebXR's `camera-access` feature
 * descriptor, so an immersive session cannot see the room; MediaDevices can, which is what
 * gate zero established on this headset. A 2D tab is also what makes the whole thing testable
 * on a laptop with a webcam, which is where most of it gets built.
 *
 * The cost is that controller face buttons never reach the page. `rail.ts` explains how that
 * is handled instead of pretended away.
 */

import './theme.css';
import './panels.css';
import './title.css';
import './loading.css';
import './counter.css';

import { createApp, type PanelFactory, type Route } from './app.js';
import { passthrough } from './passthrough.js';
import { counterPanel } from './panels/counter.js';
import { cuttingPanel } from './panels/cutting.js';
import { dishPanel } from './panels/dish.js';
import { libraryPanel } from './panels/library.js';
import { loadingPanel } from './panels/loading.js';
import { pickPanel } from './panels/pick.js';
import { titlePanel } from './panels/title.js';

const PANELS: Readonly<Record<Route, PanelFactory>> = {
  title: titlePanel,
  loading: loadingPanel,
  counter: counterPanel,
  pick: pickPanel,
  library: libraryPanel,
  dish: dishPanel,
  cutting: cuttingPanel,
};

const mount = document.getElementById('app');
if (mount === null) throw new Error('#app is missing from the document');

const app = createApp(mount, PANELS);

/**
 * Deep links, and the reason they are worth the twenty lines.
 *
 * Reloading the headset browser onto `#cutting` while tuning that one screen saves walking the
 * whole flow every time, and it is how the screens get demoed individually. Anything
 * unrecognised falls to the title screen rather than erroring.
 */
const ROUTES: readonly Route[] = ['title', 'loading', 'counter', 'pick', 'library', 'dish', 'cutting'];

const routeFromHash = (): Route => {
  const wanted = window.location.hash.replace(/^#/, '');
  return ROUTES.find((route) => route === wanted) ?? 'title';
};

// The loading screen is a step, not a destination: opening the app on `#loading` would land on
// a screen whose only job is to move somewhere else.
const start = routeFromHash();
app.go(start === 'loading' ? 'title' : start);

/**
 * Last-resort reporting.
 *
 * There is no console on a headset without plugging a cable in, so an uncaught error would
 * otherwise show up as a screen that simply stopped responding. A visible banner naming the
 * error is the difference between a five-second diagnosis and a five-minute one.
 */
function reportFatal(message: string): void {
  const existing = document.getElementById('fatal');
  const banner = existing ?? document.createElement('div');
  banner.id = 'fatal';
  banner.textContent = `Something broke: ${message}`;
  if (existing === null) document.body.appendChild(banner);
}

/**
 * Dev-only handles, for driving a screen from the console without walking the flow to it.
 *
 * Stripped from production by the `import.meta.env.DEV` guard, which Vite resolves at build
 * time, so the branch and everything in it is gone from the shipped bundle. Worth having
 * because the two camera screens are awkward to reach repeatedly, and because faking a stream
 * is the only way to check their layout on a machine with no camera.
 */
if (import.meta.env.DEV) {
  (window as unknown as { idy: unknown }).idy = { app, passthrough };
}

window.addEventListener('error', (event) => reportFatal(event.message));
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | undefined;
  reportFatal(reason?.message ?? String(event.reason));
});
