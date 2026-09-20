/**
 * Screen 2 -- the counter, in the language of artboard 2A.
 *
 * This is the screen the whole page exists for, and the one the restyle changes most.
 *
 * The deployed page puts everything in one outlined cream rectangle: a heading, a stack of
 * grey rows, a red number, some chips, three buttons. The artboard breaks the same content
 * into four objects with four different jobs and colours them accordingly -- a cream tally
 * card with TINTED rows so the counter groups by eye, a red panel carrying the one number the
 * screen is about, a yellow slab for the action that moves you forward, and a quieter cream
 * slab for the one that goes sideways. That hierarchy is the design work; reproducing it is
 * most of what this file does differently.
 *
 * ONE DEPARTURE FROM THE ARTBOARD, and it is the point of the project. The document paints a
 * kitchen behind this panel -- a brown floor, a wooden rail, a worktop with four drawn
 * ingredients and their name tags at fixed coordinates. All of that is a stand-in for the real
 * counter. Here the ground is the camera and the labels are drawn only where the segmenter
 * actually found something, so the painted kitchen is gone and nothing else moves.
 *
 * ONE DEPARTURE FROM THE DEPLOYED PAGE. Its groups are eight flat rows in the same grey; here
 * each row takes the tint of the artboard group it belongs to -- carbs yellow, protein pink,
 * greens leaf, sauce sky, by way of `groupOf` in `src/menu/art.ts`. The eight categories and
 * their labels are unchanged, so the tally still says exactly what it said before.
 */

import type { Category, Pantry, RawScanItem } from '../../core/pantry.js';
import { pantryFromScan, rankRecipes, recommend } from '../../core/pantry.js';
import { RECIPES } from '../../core/recipe.js';
import { artFor, GROUP_TINT, groupOf } from '../../menu/art.js';
import { button, fill, h } from '../../menu/dom.js';
import { DEFAULT_CAMERA_OPTIONS, listCameras, open as openCamera } from '../../vision/camera.js';
import type { Flow, Screen } from '../flow.js';
import {
  AnalysisLoop,
  categoryOf,
  cloudConfigured,
  cloudScan,
  drawOverlay,
  loadSegmenter,
  StabilityWindow,
  type LocalPass,
} from '../scan.js';

/** The deployed page's group headings, verbatim, in its order. */
const GROUP_LABEL: Readonly<Record<Category, string>> = {
  vegetable: 'Vegetables',
  fruit: 'Fruit',
  herb: 'Herbs',
  protein: 'Protein',
  dairy: 'Dairy',
  grain: 'Carbs',
  pantry: 'Sauce & pantry',
  unknown: 'Unidentified',
};

const GROUP_ORDER: readonly Category[] = [
  'vegetable', 'fruit', 'herb', 'protein', 'dairy', 'grain', 'pantry', 'unknown',
];

/**
 * Categories whose row is shown even when empty.
 *
 * The deployed page's rule, kept. An empty tally that draws nothing at all looks broken; two
 * greyed rows say "this is where your ingredients will appear" without a line of instruction.
 */
const ALWAYS_SHOWN: readonly Category[] = ['vegetable', 'fruit'];

/** Below this an unconfirmed line is drawn as a question rather than a fact. */
const SURE_ABOVE = 0.75;

/** "Unidentified" has no group colour to borrow, so it stays the card's own deeper cream. */
const tintFor = (category: Category): string =>
  category === 'unknown' ? 'var(--cream-deep)' : GROUP_TINT[groupOf(category)];

export function createCounter(flow: Flow): Screen {
  // ---------------------------------------------------------------- camera panel

  const video = h('video', { attrs: { playsinline: '', muted: '' } });
  video.muted = true;

  const overlay = h('canvas');
  const idle = h('div', {
    class: 'stage__idle',
    text: 'Camera off. Press start, then put your ingredients in frame.',
  });
  const badge = h('span', { class: 'stage__badge', text: '● Camera off' });

  const stage = h('div', { class: 'card stage' }, badge, idle, video, overlay);
  video.style.display = 'none';
  overlay.style.display = 'none';

  const picker = h('select', { attrs: { 'aria-label': 'Camera' } });
  const perf = h('span', { class: 'pill', text: '—' });
  const startBtn = button('btn btn--hot', () => void startCamera(), 'Start camera');
  const err = h('div', { class: 'err' });

  const cameraCol = h(
    'div',
    { class: 'counter-col' },
    stage,
    h('div', { class: 'camrow' }, startBtn, picker, perf),
    err,
  );

  // ---------------------------------------------------------------- tally panel

  const sub = h('p', {
    class: 'note c-sub',
    text: 'Start the camera and put your ingredients in frame.',
  });

  /**
   * The scan's own line, and it is deliberately NOT `sub`.
   *
   * `renderPantry` below rewrites `sub` on every publish, and the analysis loop publishes four
   * times a second. Anything the deep scan or the recommender put there -- including the
   * reason it failed -- was gone in 250ms, so the button read as having done nothing at all.
   * The deployed page carries a comment recording the same bug and the same fix; this is that
   * fix, kept, because the live loop here behaves exactly the same way.
   */
  const scanline = h('p', { class: 'c-scanline' });
  scanline.hidden = true;

  const groups = h('div', { class: 'c-groups' });
  const chips = h('div', { class: 'c-chips' });

  const tallyCard = h(
    'div',
    { class: 'card' },
    h('span', { class: 'pill pill--sun pill--display', text: 'Step 1 of 3' }),
    h('h2', { class: 'c-title', text: 'On your counter' }),
    sub,
    scanline,
    groups,
    chips,
  );

  /** Put a line in front of the cook that the live loop cannot overwrite. */
  function say(tone: 'ok' | 'bad' | 'busy', text: string): void {
    scanline.textContent = text;
    scanline.className = `c-scanline is-${tone}`;
    scanline.hidden = false;
  }

  const totalN = h('span', { class: 'c-counted__n', text: '0' });
  const countedNote = h('p', { class: 'c-counted__note', text: 'Nothing counted yet.' });

  const countedCard = h(
    'div',
    { class: 'card card--red' },
    h('span', { class: 'c-counted__label', text: 'Counted' }),
    h(
      'div',
      { class: 'c-counted__row' },
      totalN,
      h(
        'span',
        { class: 'c-counted__unit' },
        h('span', { text: 'items' }),
        h('span', { text: 'counted' }),
      ),
    ),
    countedNote,
  );

  const scanBtn = button('btn btn--sun btn--big btn--wide', () => void deepScan(), 'Identify everything');

  const cookNote = h('span', { class: 'c-cook__note', text: 'Picks a dish you can finish with what is already out.' });
  const cookBtn = button(
    'press press--sun c-cook',
    () => cookForMe(),
    h('span', { class: 'c-cook__title' }, h('span', { style: { display: 'block' }, text: 'Cook something' }), h('span', { style: { display: 'block' }, text: 'for me' })),
    cookNote,
  );
  cookBtn.disabled = true;

  const browseBtn = button(
    'press',
    () => flow.show('s-library'),
    h('span', { class: 'c-browse__title', text: 'Browse instead' }),
    h('span', { class: 'c-browse__note', text: 'Open the recipe library and see every dish.' }),
  );

  const node = h(
    'section',
    {},
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'head__title', text: 'On your counter' }),
      h('span', { class: 'pill pill--sun pill--display', text: 'Step 1 of 3' }),
      h('span', { class: 'head__spacer' }),
      button('btn', () => flow.show('s-title'), '← Menu'),
    ),
    h(
      'div',
      { class: 'counter-grid' },
      cameraCol,
      h('div', { class: 'tally-col' }, tallyCard, countedCard, scanBtn, cookBtn, browseBtn),
    ),
  );

  // ---------------------------------------------------------------- state

  const stable = new StabilityWindow();
  let loop: AnalysisLoop | null = null;
  let stream: MediaStream | null = null;
  let cloudItems: readonly RawScanItem[] | null = null;
  let cloudNotes = '';
  let smoothedMs = 0;

  /**
   * Cloud lines win over local ones for the same ingredient.
   *
   * Not because the model is always right, but because it is the one the cook asked for: the
   * local pass runs unprompted and the cloud pass only runs when somebody presses a button, so
   * silently overruling the thing they just asked for would make the button look broken.
   */
  function merged(local: readonly RawScanItem[]): RawScanItem[] {
    const byName = new Map<string, RawScanItem>();
    for (const item of local) byName.set(item.ingredient, item);
    if (cloudItems !== null) for (const item of cloudItems) byName.set(item.ingredient, item);
    return [...byName.values()];
  }

  function publish(local: readonly RawScanItem[]): void {
    flow.setPantry(pantryFromScan(merged(local), Date.now()));
  }

  // ---------------------------------------------------------------- rendering

  function renderPantry(pantry: Pantry): void {
    const total = pantry.items.reduce((sum, item) => sum + item.count, 0);
    totalN.textContent = String(total);

    fill(groups);
    for (const category of GROUP_ORDER) {
      const items = pantry.items.filter((i) => i.category === category);
      if (items.length === 0 && !ALWAYS_SHOWN.includes(category)) continue;

      const names = items.map((i) => `${i.ingredient} ×${i.count}`).join(', ');
      const count = items.reduce((sum, i) => sum + i.count, 0);

      groups.append(
        h(
          'div',
          {
            class: items.length === 0 ? 'well c-group is-empty' : 'well c-group',
            style: { background: tintFor(category) },
          },
          h(
            'div',
            { class: 'c-group__body' },
            h('div', { class: 'c-group__name', text: GROUP_LABEL[category] }),
            h('div', { class: 'c-group__list', text: names === '' ? 'nothing in frame' : names }),
          ),
          h('div', { class: 'c-group__count', text: String(count) }),
        ),
      );
    }

    fill(chips);
    for (const item of pantry.items) {
      const fromCloud = cloudItems?.some((c) => c.ingredient === item.ingredient) ?? false;
      const tone = fromCloud ? ' is-cloud' : item.confidence >= SURE_ABOVE ? '' : ' is-unsure';

      chips.append(
        h(
          'span',
          { class: `c-chip${tone}` },
          h('img', {
            attrs: { src: artFor(item.ingredient, item.category), alt: '', decoding: 'async', loading: 'lazy' },
            style: { width: '1.4rem', height: '1.4rem', objectFit: 'contain' },
          }),
          h('span', { text: item.ingredient }),
          h('span', { class: 'c-chip__n', text: `×${item.count}` }),
        ),
      );
    }

    const ranked = rankRecipes(pantry, RECIPES);
    const ready = ranked.filter((m) => m.makeable).length;

    sub.textContent = total === 0
      ? 'Nothing in frame yet. Put your ingredients on a light surface.'
      : `Counted ${total} item${total === 1 ? '' : 's'}. ${ready} of ${ranked.length} recipes are ready.`;

    countedNote.textContent = total === 0
      ? 'Nothing counted yet.'
      : `Enough for ${ready} recipe${ready === 1 ? '' : 's'} in your library.`;

    cookBtn.disabled = ready === 0;
    cookNote.textContent = ready === 0
      ? 'Nothing here is makeable yet — add more to the counter.'
      : 'Picks a dish you can finish with what is already out.';
  }

  flow.subscribe(renderPantry);

  // ---------------------------------------------------------------- camera

  async function listInto(): Promise<void> {
    // Labels stay blank until permission has been granted once -- the browser withholds them so
    // a page cannot fingerprint the hardware before consent. So this is called again AFTER the
    // stream opens, or the picker shows a list of empty strings and looks broken.
    const devices = await listCameras();
    fill(picker, ...devices.map((d) => h('option', { attrs: { value: d.deviceId }, text: d.label })));
  }

  function onPass(pass: LocalPass): void {
    drawOverlay(overlay, pass);

    const named = pass.labels.filter((l): l is string => l !== null);
    stable.push(named);

    publish(
      stable.read().map((s) => ({
        ingredient: s.ingredient,
        count: s.count,
        category: categoryOf(s.ingredient),
        confidence: s.stability,
      })),
    );

    // Exponentially smoothed, because a raw per-pass number flickers by tens of milliseconds
    // and is unreadable. The blob count is not smoothed: that one is meant to jump.
    smoothedMs += (pass.elapsedMs - smoothedMs) * 0.2;
    perf.textContent = `${Math.round(smoothedMs)}ms · ${pass.blobs.length} blobs`;
  }

  async function startCamera(): Promise<void> {
    err.textContent = '';
    startBtn.disabled = true;

    try {
      stream?.getTracks().forEach((t) => t.stop());
      const deviceId = picker.value === '' ? undefined : picker.value;
      stream = await openCamera({ ...DEFAULT_CAMERA_OPTIONS, ...(deviceId === undefined ? {} : { deviceId }) });

      video.srcObject = stream;
      await video.play();

      video.style.display = 'block';
      overlay.style.display = 'block';
      idle.style.display = 'none';
      badge.textContent = '● Live';
      badge.classList.add('is-live');

      await listInto();

      // The WASM is a ~15MB download, so it is fetched when a camera screen is first used
      // rather than at page load. The stream is already up by then, so the wait is spent
      // looking at the counter instead of at a blank page.
      const ready = await loadSegmenter();
      if (!ready) {
        err.textContent = 'The segmenter could not load, so the live count is off. The camera still works.';
        return;
      }

      stable.clear();
      loop?.stop();
      loop = new AnalysisLoop(video, onPass);
      loop.start();
    } catch (error) {
      badge.textContent = '● Camera off';
      badge.classList.remove('is-live');
      err.textContent =
        `camera failed: ${String(error)}\n\n` +
        'Needs https (or localhost), permission granted, and no other app holding the camera.';
    } finally {
      startBtn.disabled = false;
    }
  }

  picker.addEventListener('change', () => void startCamera());

  // ---------------------------------------------------------------- the cloud pass

  async function deepScan(): Promise<void> {
    if (stream === null) {
      say('bad', 'Start the camera first.');
      return;
    }

    const label = scanBtn.textContent ?? 'Identify everything';
    scanBtn.disabled = true;
    scanBtn.textContent = 'Looking…';
    say('busy', 'Asking the vision model what is on your counter…');

    const result = await cloudScan(video);

    scanBtn.disabled = false;
    scanBtn.textContent = label;

    if (!result.ok) {
      say('bad', result.reason);
      return;
    }

    cloudItems = result.items;
    cloudNotes = result.notes;
    publish([]);

    const total = cloudItems.reduce((sum, item) => sum + item.count, 0);
    say(
      'ok',
      total === 0
        ? (cloudNotes === '' ? 'The model found no food on the counter.' : cloudNotes)
        : `Model named ${cloudItems.length} kind${cloudItems.length === 1 ? '' : 's'}, ` +
          `${total} item${total === 1 ? '' : 's'}.${cloudNotes === '' ? '' : ` ${cloudNotes}`}`,
    );
  }

  // The relay is probed once, at build time of this screen, so the button can say up front that
  // it is unavailable rather than failing under someone's finger. `api/vision` is not in this
  // repository, so on a local build this is the branch that runs.
  void cloudConfigured().then((configured) => {
    if (configured) return;
    scanBtn.disabled = true;
    scanBtn.textContent = 'Identify everything (no key set)';
  });

  // ---------------------------------------------------------------- forward

  function cookForMe(): void {
    const pick = recommend(flow.pantry, RECIPES);
    if (pick === null) {
      say('bad', 'Nothing here is makeable yet — add more to the counter.');
      return;
    }
    flow.openDish(pick);
  }

  return {
    node,
    onShow: () => void listInto().catch(() => {}),
  };
}
