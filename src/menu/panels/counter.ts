/**
 * Screen 2A -- the counter tally, over the real counter.
 *
 * Built at the artboard's 1440x810 and scaled to fit (`stage.ts`), so the tally card really is
 * at left 48 / top 96 / width 430, the rail really is 62px tall, and the counted number really
 * is 78px Ranchers. Values come from the folder's `Is It Done Yet - Menu.dc.html`.
 *
 * THE ONE DEPARTURE IS THE POINT OF THE PROJECT. The document paints a kitchen behind this
 * panel -- a floor, a rail, a worktop, and four ingredients with name tags at fixed coordinates.
 * That is a stand-in for the thing the app is about. Here the ground is the headset's
 * passthrough camera, the three painted divs are gone, and the tags appear only where the scan
 * actually found something. If the tomato tag is over the tomato, that is a real result; if
 * there are no tags, that is a real result too.
 *
 * The camera fills the whole window rather than the board's rectangle, because the room does
 * not stop at the edge of a 1440x810 artboard.
 *
 * WHY THE CORRECTION STEP IS NOT A NICETY. The artboard draws a finished tally. A real scan is
 * a hue-and-shape segmenter that knows six ingredients, and a recipe list built on a miscount
 * sends somebody off to start a dish they cannot finish. A tally the cook has corrected is
 * accurate by construction rather than on average, so "Fix by hand" -- which the artboard does
 * draw -- opens a real editor, and a counter the scan could not read at all is still a counter
 * you can cook from.
 */

import { addItem, adjustCount, byCategory, confirmAll, pantryFromScan, removeItem, unconfirmed,
  type Category, type Pantry, type PantryItem } from '../../core/pantry.js';
import { artFor, GROUP_ICON, GROUP_INK, GROUP_LABEL, GROUP_ORDER, GROUP_TINT, groupOf, heroSize,
  heroUrl, tintFor, type CounterGroup } from '../art.js';
import type { AppContext, Panel, RouteParams } from '../app.js';
import { ADDABLE, categoryFor, pretty, REQUIRED_BY_A_RECIPE } from '../catalogue.js';
import { button, fill, h } from '../dom.js';
import { createRail } from '../rail.js';
import { createStage } from '../stage.js';
import { mountPassthrough } from '../passthroughView.js';
import { analyseFrame, FrameReader, isVisionLoaded, loadVision, type Detection } from '../vision.js';

/** Passes averaged before the tally is offered. */
const SCAN_PASSES = 5;
/** Gap between passes, so one hand crossing the board cannot skew all five. */
const SCAN_GAP_MS = 180;

/** Artboard icon widths for the four tally rows: 42, with ketchup optically smaller at 34. */
const ROW_ICON = 42;

const img = (src: string, width: number): HTMLImageElement =>
  h('img', {
    attrs: { src, alt: '', draggable: 'false', decoding: 'async' },
    style: { width: `${width}px` },
  });

export function counterPanel(ctx: AppContext, _params: RouteParams): Panel {
  void _params;

  const pass = mountPassthrough({ scrim: true, fault: false });
  const stage = createStage({ width: 1440, height: 810 });
  const reader = new FrameReader(480);

  let detections: readonly Detection[] = [];
  let scanning = false;
  let editing = false;
  let status = ctx.state.scanned
    ? 'Tally from your last scan. Recount when the counter changes.'
    : 'Point at your counter and press Scan. Anything it misses, add by hand.';

  // ---------------------------------------------------------------- pieces

  const subLine = h('div', { class: 'c-sub' });
  const groupList = h('div', { class: 'c-groups' });
  const editor = h('div', { class: 'c-editor' });
  const countedN = h('div', { class: 'c-counted__n', text: '0' });
  const countedNote = h('div', { class: 'c-counted__note' });
  const camPill = h('div', { class: 'c-cam', text: 'Camera' });

  const fixButton = button('c-pill', () => {
    editing = !editing;
    paint();
  }, 'Fix by hand');

  const scanButton = button('c-scan', () => void runScan(), 'Scan the counter');

  const cookCard = button(
    'b2-card c-cook',
    () => {
      commit();
      ctx.go('pick');
    },
    h('div', { class: 'c-cook__title' }, h('span', { text: 'Cook something' }), h('br'), h('span', { text: 'for me' })),
    h('div', {
      class: 'c-cook__note',
      text: 'Picks a dish you can finish with what is already out.',
    }),
    h(
      'div',
      { class: 'c-cook__hint' },
      h('span', { class: 'c-cook__key', text: 'B' }),
      h('span', { class: 'c-cook__keylabel', text: 'Right controller' }),
    ),
  );

  const browseCard = button(
    'b2-card c-browse',
    () => {
      commit();
      ctx.go('library');
    },
    h('div', { class: 'c-browse__title', text: 'Browse instead' }),
    h('div', {
      class: 'c-browse__note',
      text: 'Open the recipe library and search the whole book.',
    }),
  );

  const tally = h(
    'div',
    { class: 'b2-card c-tally' },
    h('div', { class: 'c-title', text: 'On your counter' }),
    subLine,
    groupList,
    h(
      'div',
      { class: 'c-fix' },
      h('span', { class: 'c-fix__label', text: 'Miscounted?' }),
      fixButton,
      button('c-pill', () => void runScan(), 'Recount'),
    ),
    editor,
  );

  const rail = createRail(
    [
      { key: 'A', label: 'Open library', onPress: () => { commit(); ctx.go('library'); } },
      { key: 'B', label: 'Cook something for me', accent: true, onPress: () => { commit(); ctx.go('pick'); } },
      { key: 'X', label: 'Recount', onPress: () => void runScan() },
      { key: '☰', label: 'Menu', end: true, shortcut: 'm', onPress: () => ctx.go('title') },
    ],
    () => ctx.back(),
    'board',
  );

  stage.board.classList.add('b2', 'b2--live');
  stage.board.append(
    h(
      'div',
      { class: 'b2-head' },
      h('div', { class: 'b2-word', text: 'Is It Done Yet?' }),
      h('div', { class: 'b2-step', text: 'Step 1 of 3' }),
    ),
    camPill,
    tally,
    h(
      'div',
      { class: 'c-rail' },
      h(
        'div',
        { class: 'b2-card c-counted' },
        h('div', { class: 'c-counted__label', text: 'Counted' }),
        h('div', { class: 'c-counted__row' }, countedN, h('div', { class: 'c-counted__unit', text: 'items' })),
        countedNote,
      ),
      cookCard,
      browseCard,
      scanButton,
    ),
    rail.node,
  );

  const node = h('section', { class: 'screen screen--board counter' }, pass.node, stage.node);

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
    const icon = GROUP_ICON[group];

    return h(
      'div',
      {
        class: `c-group${items.length === 0 ? ' is-empty' : ''}`,
        style: { background: GROUP_TINT[group] },
      },
      img(heroUrl(icon), heroSize(icon, ROW_ICON)),
      h(
        'div',
        { class: 'c-group__body' },
        h('div', { class: 'c-group__name', text: GROUP_LABEL[group] }),
        h('div', {
          class: 'c-group__list',
          text: items.length === 0 ? 'nothing here yet' : items.map((i) => pretty(i.ingredient)).join(', '),
          style: { color: GROUP_INK[group] },
        }),
      ),
      h('div', { class: 'c-group__count', text: String(count) }),
    );
  }

  function editorRow(item: PantryItem): HTMLElement {
    const unsure = !item.confirmed && item.confidence < 0.75;
    return h(
      'div',
      { class: `c-row${unsure ? ' is-unsure' : ''}`, style: { background: GROUP_TINT[groupOf(item.category)] } },
      img(artFor(item.ingredient, item.category), 26),
      h(
        'div',
        { class: 'c-row__name' },
        h('div', { text: pretty(item.ingredient) }),
        h('div', {
          class: 'c-row__conf',
          text: item.confirmed ? 'checked by you' : `${Math.round(item.confidence * 100)}% sure`,
        }),
      ),
      button('c-step', () => nudge(item.ingredient, -1), '−'),
      h('div', { class: 'c-row__count', text: String(item.count) }),
      button('c-step', () => nudge(item.ingredient, 1), '+'),
      button('c-step c-step--drop', () => {
        ctx.setState({ pantry: removeItem(ctx.state.pantry, item.ingredient) });
        paint();
      }, '×'),
    );
  }

  function paintEditor(): void {
    editor.classList.toggle('is-open', editing);
    if (!editing) {
      fill(editor);
      return;
    }

    const present = new Set(ctx.state.pantry.items.map((i) => i.ingredient));
    const offer = ADDABLE.filter((name) => !present.has(name)).slice(0, 18);

    fill(
      editor,
      h('div', { class: 'c-editor__label', text: 'Counted lines' }),
      ctx.state.pantry.items.length === 0
        ? h('div', { class: 'c-sub', text: 'Nothing on the tally yet. Add what is in front of you.' })
        : h('div', { class: 'c-groups' }, ...ctx.state.pantry.items.map(editorRow)),
      h('div', { class: 'c-editor__label', text: 'Add something' }),
      h(
        'div',
        { class: 'c-add' },
        ...offer.map((name) =>
          button(
            `c-add__chip${REQUIRED_BY_A_RECIPE.has(name) ? ' is-wanted' : ''}`,
            () => {
              ctx.setState({
                pantry: addItem(ctx.state.pantry, name, 1, categoryFor(name)),
                scanned: true,
              });
              paint();
            },
            img(artFor(name, categoryFor(name)), 22),
            h('span', { text: pretty(name) }),
          ),
        ),
      ),
    );
  }

  function paintTags(): void {
    pass.setOverlay(
      detections.map((detection) => {
        const category: Category = categoryFor(detection.ingredient);
        return {
          x: detection.x,
          y: detection.y,
          node: h('span', {
            class: `tag tag--${tintFor(category)}`,
            text: `${pretty(detection.ingredient)}`,
          }),
        };
      }),
    );
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

  function paint(): void {
    const { pantry } = ctx.state;
    const total = pantry.items.reduce((sum, item) => sum + item.count, 0);
    const queue = unconfirmed(pantry).length;
    const groups = groupsOf(pantry).filter((g) => g.items.length > 0).length;

    subLine.textContent = scanning
      ? 'Reading the counter…'
      : queue > 0
        ? `${status} ${queue} ${queue === 1 ? 'line is' : 'lines are'} a guess.`
        : total > 0
          ? `Counted ${total} items in ${groups} groups. Move something and the tally updates.`
          : status;

    fill(groupList, ...groupsOf(pantry).map(({ group, items }) => groupRow(group, items)));

    countedN.textContent = String(total);
    countedNote.textContent = total === 0
      ? 'Nothing counted yet.'
      : `Enough for ${makeableCount()} of ${ctx.state.recipes.length} recipes in your library.`;

    fixButton.textContent = editing ? 'Done fixing' : 'Fix by hand';
    fixButton.setAttribute('aria-pressed', String(editing));

    cookCard.disabled = total === 0;

    const live = pass.status() === 'live';
    scanButton.disabled = scanning || !live;
    scanButton.textContent = scanning
      ? 'Scanning…'
      : live
        ? ctx.state.scanned ? 'Scan again' : 'Scan the counter'
        : 'Camera unavailable';

    camPill.textContent = live ? 'Passthrough live' : `Camera ${pass.status()}`;
    camPill.classList.toggle('is-live', live);

    paintEditor();
    paintTags();
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
    if (!(await loadVision())) {
      status = 'The vision engine could not load, so the scan is off. Add by hand instead.';
      editing = true;
      paint();
      return;
    }

    scanning = true;
    paint();

    // Several passes, and an ingredient's count is the MEDIAN across them rather than the max.
    // One frame catches a hand crossing the board, a shadow splitting one tomato into two blobs,
    // or a highlight losing one entirely; the median throws all three away, where a max would
    // bake every one of them into the tally as a real ingredient.
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
      const confidences = passes.flat().filter((d) => d.ingredient === ingredient).map((d) => d.confidence);
      return {
        ingredient,
        count: median(perPass),
        category: categoryFor(ingredient),
        confidence: confidences.reduce((sum, c) => sum + c, 0) / Math.max(1, confidences.length),
      };
    }).filter((item) => item.count >= 1);

    // The scan proposes; it never overwrites. Lines the cook has already checked survive a
    // recount -- a person correcting the tally is more reliable than the segmenter that needed
    // correcting, and losing those corrections to a stray re-scan is infuriating.
    let merged = pantryFromScan(raw, Date.now());
    for (const item of ctx.state.pantry.items) {
      if (!item.confirmed) continue;
      if (!merged.items.some((existing) => existing.ingredient === item.ingredient)) {
        merged = addItem(merged, item.ingredient, item.count, item.category);
      }
    }

    ctx.setState({ pantry: merged, scanned: true });

    status = raw.length === 0
      ? 'Nothing recognised. The camera knows six ingredients by sight — add the rest by hand.'
      : 'Counted from the camera. Check the pale rows.';

    if (raw.length === 0) editing = true;
    paint();
  }

  /** Leaving the screen is the cook saying the tally looks right. */
  function commit(): void {
    if (ctx.state.pantry.items.length > 0) {
      ctx.setState({ pantry: confirmAll(ctx.state.pantry) });
    }
  }

  function nudge(ingredient: string, delta: number): void {
    ctx.setState({ pantry: adjustCount(ctx.state.pantry, ingredient, delta) });
    paint();
  }

  const stopWatching = pass.onStatusChange(paint);
  paint();

  return {
    node,
    destroy: () => {
      stopWatching();
      pass.destroy();
      stage.destroy();
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
    : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}
