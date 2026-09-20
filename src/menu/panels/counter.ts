/**
 * Screen 2A -- the counter tally, over the real counter.
 *
 * The artboard painted a kitchen behind this panel: a brown worktop, a wooden rail, four
 * ingredients sitting on it at fixed coordinates with little name tags floating above them.
 * All of that was standing in for the one thing the app is for. Here the ground is the
 * headset's passthrough camera, and the tags are drawn only where the scan actually found
 * something -- so if the tomato tag is over the tomato, that is a real result, and if there are
 * no tags, that is a real result too.
 *
 * WHY THE CORRECTION STEP IS NOT A NICETY. No vision model counts a cluttered counter
 * perfectly, and this one is a hue-and-shape segmenter that knows six ingredients. A recipe
 * list built on a miscount sends somebody off to start a dish they cannot finish. A tally the
 * cook has corrected is accurate by construction rather than on average, so "fix by hand" is
 * a first-class control sitting next to the tally, not buried in a settings screen, and a
 * counter that the scan could not read at all is still a counter you can cook from.
 */

import { byCategory, confirmAll, addItem, adjustCount, pantryFromScan, removeItem, unconfirmed,
  type Category, type Pantry, type PantryItem } from '../../core/pantry.js';
import { artFor, designRem, GROUP_ICON, GROUP_INK, GROUP_LABEL, GROUP_ORDER, GROUP_TINT, groupOf,
  heroSize, heroUrl, tintFor, type CounterGroup } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { ADDABLE, categoryFor, pretty, REQUIRED_BY_A_RECIPE } from '../catalogue.js';
import { art, button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';
import { mountPassthrough } from '../passthroughView.js';
import { analyseFrame, FrameReader, isVisionLoaded, loadVision, type Detection } from '../vision.js';

/** How many scan passes are averaged before the tally is offered. */
const SCAN_PASSES = 5;
/** Gap between passes. Long enough that a hand moving through one frame does not skew all five. */
const SCAN_GAP_MS = 180;

export function counterPanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const pass = mountPassthrough({ scrim: true });
  let detections: readonly Detection[] = [];
  let scanning = false;
  let editing = false;
  let status = ctx.state.scanned
    ? 'Tally from your last scan. Recount when the counter changes.'
    : 'Point at your counter and press Scan. Anything it misses, add by hand.';

  const reader = new FrameReader(480);

  // ---------------------------------------------------------------- structure

  const statusLine = h('p', { class: 'note' });
  const groupList = h('div', { class: 'counter__groups' });
  const totalNumber = h('div', { class: 'display d-hero', text: '0' });
  const totalNote = h('div', { class: 'note counter__total-note' });
  const editor = h('div', { class: 'counter__editor' });

  const scanButton = button('btn btn--sun', () => void runScan(), 'Scan the counter');
  const fixButton = button('btn', () => {
    editing = !editing;
    paint();
  }, 'Fix by hand');

  const cookCard = button(
    'press press--sun counter__cook',
    () => {
      commit();
      ctx.go('pick');
    },
    h('span', { class: 'display d-md', text: 'Cook something' }),
    h('span', { class: 'display d-md', text: 'for me' }),
    h('p', {
      class: 'note counter__cook-note',
      text: 'Picks the dish you can get furthest through with what is already out.',
    }),
  );

  const browseCard = button(
    'press counter__browse',
    () => {
      commit();
      ctx.go('library');
    },
    h('span', { class: 'display d-md', text: 'Browse instead' }),
    h('p', {
      class: 'note',
      text: 'Open the recipe library and search the whole book.',
    }),
  );

  const tally = h(
    'div',
    { class: 'card counter__tally' },
    h('h1', { class: 'display d-lg', text: 'On your counter' }),
    statusLine,
    groupList,
    h('hr', { class: 'divider' }),
    h(
      'div',
      { class: 'counter__fix' },
      h('span', { class: 'label', text: 'Miscounted?', style: { color: 'var(--brown)' } }),
      fixButton,
      button('btn', () => void runScan(), 'Recount'),
    ),
    editor,
  );

  const totals = h(
    'div',
    { class: 'card card--red counter__total' },
    h('div', { class: 'label', text: 'Counted', style: { color: '#ffd9c9' } }),
    h(
      'div',
      { class: 'row counter__total-row' },
      totalNumber,
      h('div', { class: 'display d-md counter__total-unit', text: 'items' }),
    ),
    totalNote,
  );

  const body = h(
    'div',
    { class: 'screen__body counter__body' },
    tally,
    h('div', { class: 'counter__rail' }, totals, cookCard, browseCard, scanButton),
  );

  const rail = createRail(
    [
      { key: 'A', label: 'Open library', onPress: () => { commit(); ctx.go('library'); } },
      { key: 'B', label: 'Cook something for me', accent: true, onPress: () => { commit(); ctx.go('pick'); } },
      { key: 'X', label: 'Recount', onPress: () => void runScan() },
      { key: '☰', label: 'Title', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
  );

  const node = h(
    'section',
    { class: 'screen counter' },
    pass.node,
    h(
      'header',
      { class: 'screen__head counter__head' },
      h('span', { class: 'display d-md counter__wordmark', text: 'Is It Done Yet?' }),
      h('span', { class: 'pill pill--sun pill--display', text: 'Step 1 of 3' }),
      h('span', { class: 'pill counter__camera-state', text: 'camera', attrs: { id: 'counter-camstate' } }),
    ),
    body,
    rail.node,
  );

  // ---------------------------------------------------------------- rendering

  function groupsOf(pantry: Pantry): readonly { group: CounterGroup; items: readonly PantryItem[] }[] {
    const buckets = new Map<CounterGroup, PantryItem[]>();
    for (const group of GROUP_ORDER) buckets.set(group, []);
    for (const { items } of byCategory(pantry)) {
      for (const item of items) buckets.get(groupOf(item.category))?.push(item);
    }
    return GROUP_ORDER.map((group) => ({ group, items: buckets.get(group) ?? [] }));
  }

  function groupRow(group: CounterGroup, items: readonly PantryItem[]): HTMLElement {
    const count = items.reduce((sum, item) => sum + item.count, 0);
    const names = items.map((item) => pretty(item.ingredient)).join(', ');

    return h(
      'div',
      {
        class: `counter__group${items.length === 0 ? ' is-empty' : ''}`,
        style: { background: GROUP_TINT[group] },
      },
      art(heroUrl(GROUP_ICON[group]), heroSize(GROUP_ICON[group], designRem(42))),
      h(
        'div',
        { class: 'stack grow' },
        h('span', { class: 'display d-sm', text: GROUP_LABEL[group] }),
        h('span', {
          class: 'counter__group-names truncate',
          text: items.length === 0 ? 'nothing here yet' : names,
          style: { color: GROUP_INK[group] },
        }),
      ),
      h('span', { class: 'display d-md tabular', text: String(count) }),
    );
  }

  function editorRow(item: PantryItem): HTMLElement {
    const unsure = !item.confirmed && item.confidence < 0.75;
    return h(
      'div',
      {
        class: `counter__edit-row${unsure ? ' is-unsure' : ''}`,
        style: { background: GROUP_TINT[groupOf(item.category)] },
      },
      art(artFor(item.ingredient, item.category), 2),
      h(
        'div',
        { class: 'stack grow' },
        h('span', { class: 'counter__edit-name truncate', text: pretty(item.ingredient) }),
        h('span', {
          class: 'counter__edit-conf',
          text: item.confirmed ? 'checked by you' : `${Math.round(item.confidence * 100)}% sure`,
        }),
      ),
      button('counter__step', () => nudge(item.ingredient, -1), '−'),
      h('span', { class: 'counter__edit-count display d-sm tabular', text: String(item.count) }),
      button('counter__step', () => nudge(item.ingredient, 1), '+'),
      button('counter__step counter__step--drop', () => {
        ctx.setState({ pantry: removeItem(ctx.state.pantry, item.ingredient) });
        paint();
      }, '×'),
    );
  }

  function paintEditor(): void {
    if (!editing) {
      fill(editor);
      editor.classList.remove('is-open');
      return;
    }
    editor.classList.add('is-open');

    const present = new Set(ctx.state.pantry.items.map((item) => item.ingredient));
    const offer = ADDABLE.filter((name) => !present.has(name)).slice(0, 24);

    fill(
      editor,
      h('hr', { class: 'divider' }),
      h('span', { class: 'label', text: 'Counted lines', style: { color: 'var(--brown)' } }),
      ctx.state.pantry.items.length === 0
        ? h('p', { class: 'note', text: 'Nothing on the tally yet. Add what is in front of you.' })
        : h('div', { class: 'counter__edit-list' }, ...ctx.state.pantry.items.map(editorRow)),
      h('span', { class: 'label', text: 'Add something', style: { color: 'var(--brown)' } }),
      h(
        'div',
        { class: 'counter__add' },
        ...offer.map((name) =>
          button(
            `counter__add-chip${REQUIRED_BY_A_RECIPE.has(name) ? ' is-wanted' : ''}`,
            () => {
              ctx.setState({
                pantry: addItem(ctx.state.pantry, name, 1, categoryFor(name)),
                scanned: true,
              });
              paint();
            },
            art(artFor(name, categoryFor(name)), 1.7, pretty(name), true),
            h('span', { class: 'truncate', text: pretty(name) }),
          ),
        ),
      ),
    );
  }

  function paint(): void {
    const { pantry } = ctx.state;
    const total = pantry.items.reduce((sum, item) => sum + item.count, 0);
    const queue = unconfirmed(pantry).length;

    statusLine.textContent = scanning
      ? 'Reading the counter…'
      : queue > 0
        ? `${status} ${queue} ${queue === 1 ? 'line is' : 'lines are'} a guess — check the pale rows.`
        : status;

    fill(groupList, ...groupsOf(pantry).map(({ group, items }) => groupRow(group, items)));

    totalNumber.textContent = String(total);
    totalNote.textContent = total === 0
      ? 'Nothing counted yet.'
      : `Enough for ${makeableCount()} of ${ctx.state.recipes.length} dishes in the book.`;

    fixButton.textContent = editing ? 'Done fixing' : 'Fix by hand';
    fixButton.setAttribute('aria-pressed', String(editing));

    const ready = total > 0;
    cookCard.disabled = !ready;
    cookCard.classList.toggle('is-blocked', !ready);
    browseCard.disabled = false;

    scanButton.disabled = scanning || pass.status() !== 'live';
    scanButton.textContent = scanning
      ? 'Scanning…'
      : pass.status() === 'live'
        ? ctx.state.scanned ? 'Scan again' : 'Scan the counter'
        : 'Camera unavailable';

    paintEditor();
    paintTags();
  }

  function makeableCount(): number {
    let made = 0;
    for (const recipe of ctx.state.recipes) {
      const ok = recipe.requires.every((need) =>
        ctx.state.pantry.items.some((item) => item.ingredient === need.ingredient.toLowerCase()));
      if (ok) made += 1;
    }
    return made;
  }

  /** Detection tags, pinned to where the scan saw each thing. */
  function paintTags(): void {
    pass.setOverlay(
      detections.map((detection) => {
        const category: Category = categoryFor(detection.ingredient);
        return {
          x: detection.x,
          y: detection.y,
          node: h('span', {
            class: `tag tag--${tintFor(category)}`,
            text: pretty(detection.ingredient),
          }),
        };
      }),
    );
  }

  // ---------------------------------------------------------------- scanning

  async function runScan(): Promise<void> {
    if (scanning) return;

    const video = pass.video();
    if (video === null || pass.status() !== 'live') {
      status = 'The camera is not open, so nothing can be counted. Add what is out by hand.';
      editing = true;
      paint();
      return;
    }

    if (!isVisionLoaded()) {
      status = 'Loading the vision engine…';
      paint();
    }
    const ready = await loadVision();
    if (!ready) {
      status = 'The vision engine could not load, so the scan is off. Add by hand instead.';
      editing = true;
      paint();
      return;
    }

    scanning = true;
    paint();

    // Several passes, and the count for an ingredient is the MEDIAN across them rather than the
    // maximum. A single frame catches a hand crossing the board, a shadow splitting one tomato
    // into two blobs, or a highlight losing one entirely; the median throws all three away,
    // where a max would bake every one of them into the tally as a real ingredient.
    const passes: Detection[][] = [];
    for (let i = 0; i < SCAN_PASSES; i += 1) {
      const analysis = analyseFrame(video, reader);
      if (analysis !== null) passes.push([...analysis.detections]);
      if (i < SCAN_PASSES - 1) await new Promise((resolve) => setTimeout(resolve, SCAN_GAP_MS));
    }

    scanning = false;

    if (passes.length === 0) {
      status = 'The camera gave no usable frame. Try again, or add by hand.';
      paint();
      return;
    }

    detections = passes[passes.length - 1] ?? [];

    const names = new Set(passes.flat().map((d) => d.ingredient));
    const raw = [...names].map((ingredient) => {
      const perPass = passes.map((p) => p.filter((d) => d.ingredient === ingredient).length);
      const confidences = passes.flat()
        .filter((d) => d.ingredient === ingredient)
        .map((d) => d.confidence);
      return {
        ingredient,
        count: median(perPass),
        category: categoryFor(ingredient),
        confidence: confidences.reduce((sum, c) => sum + c, 0) / Math.max(1, confidences.length),
      };
    }).filter((item) => item.count >= 1);

    // The scan proposes; it never overwrites. Lines the cook has already checked survive a
    // recount, because a person correcting the tally is more reliable than the segmenter that
    // needed correcting -- and losing your corrections to a stray re-scan is infuriating.
    const scanned = pantryFromScan(raw, Date.now());
    let merged = scanned;
    for (const item of ctx.state.pantry.items) {
      if (!item.confirmed) continue;
      merged = merged.items.some((existing) => existing.ingredient === item.ingredient)
        ? merged
        : addItem(merged, item.ingredient, item.count, item.category);
    }

    ctx.setState({ pantry: merged, scanned: true });

    status = raw.length === 0
      ? `Nothing recognised. The camera knows six ingredients by sight${
        detections.length === 0 ? '' : ` and saw ${detections.length} shapes it could not name`
      } — add the rest by hand.`
      : `Counted ${merged.items.reduce((sum, item) => sum + item.count, 0)} items in ${
        new Set(merged.items.map((item) => groupOf(item.category))).size} groups.`;

    if (raw.length === 0) editing = true;
    paint();
  }

  /** Commits the tally on the way out: leaving the screen is the cook saying it looks right. */
  function commit(): void {
    if (ctx.state.pantry.items.length > 0) {
      ctx.setState({ pantry: confirmAll(ctx.state.pantry) });
    }
  }

  function nudge(ingredient: string, delta: number): void {
    ctx.setState({ pantry: adjustCount(ctx.state.pantry, ingredient, delta) });
    paint();
  }

  function onCameraChange(): void {
    const el = node.querySelector('#counter-camstate');
    if (el instanceof HTMLElement) {
      el.textContent = pass.status() === 'live' ? 'Passthrough live' : `Camera ${pass.status()}`;
      el.classList.toggle('pill--leaf', pass.status() === 'live');
    }
    paint();
  }

  const stopWatching = pass.onStatusChange(onCameraChange);

  // Called once as well as on change: the camera is often ALREADY live when this screen mounts,
  // in which case no change event arrives and the pill keeps its placeholder text.
  onCameraChange();

  return {
    node,
    destroy: () => {
      stopWatching();
      pass.destroy();
      rail.destroy();
    },
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid] ?? 0
    : Math.round((((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2));
}
