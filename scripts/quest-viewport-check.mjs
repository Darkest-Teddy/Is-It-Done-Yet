/**
 * Opens every screen of the play path at a spread of Quest-Browser-shaped viewports and reports
 * what does not fit.
 *
 * THIS IS A PROXY AND NOT A HEADSET, and the distinction is not a disclaimer, it is the list of
 * things this cannot answer. It is desktop Chromium at a Quest-sized window: no lens, so it says
 * nothing about legibility; no controller ray, so it says nothing about whether a target is
 * comfortable to hit; a fake camera, so the counter's detections are whatever a test pattern
 * segments into; and a `devicePixelRatio` that is set rather than measured. What it does answer
 * is geometric and worth answering, because the geometry was wrong: whether `src/menu/stage.ts`
 * lands its scale-to-fit, whether the scaled board sits where it should, whether anything
 * overflows the window, and whether every visible control has a box inside it.
 *
 * Screens are opened by hash deep link rather than by clicking through, for two reasons. The
 * title screen's rail is `.sr`-hidden, so "click the last enabled button" lands on a control a
 * person cannot see; and `main.ts` reads the hash once at boot, which makes each screen a clean
 * cold start rather than a state the previous screen left behind.
 *
 * Run against a built bundle, not the dev server:
 *
 *   npm run build:deploy && npm start        # :8080, / -> app.html
 *   node scripts/quest-viewport-check.mjs http://localhost:8080
 *
 * `playwright` is already installed -- `uikitml`, under `@iwsdk/core`, depends on it, so it is
 * in the lockfile and `npm ci` brings it back. The browser binaries are separate: if this
 * fails to launch, run `npx playwright install chromium` once. It is not added to
 * `devDependencies` because nothing in `npm test` needs it and this is a check you run by hand.
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:8080';

/**
 * Quest Browser's window is resizable, so there is no single viewport to test. These span what
 * it can be dragged to, with the two artboard sizes as the 1:1 controls.
 */
const VIEWPORTS = [
  { name: 'narrow      1024x640 ', width: 1024, height: 640 },
  { name: '16:9        1280x720 ', width: 1280, height: 720 },
  { name: 'artboard 2x 1440x810 ', width: 1440, height: 810 },
  { name: 'artboard 1x 1600x900 ', width: 1600, height: 900 },
  { name: 'maximised   1920x1080', width: 1920, height: 1080 },
  { name: 'widescreen  2560x900 ', width: 2560, height: 900 },
  { name: 'tall        800x1000 ', width: 800, height: 1000 },
];

/** `loading` is excluded: `main.ts` rewrites that deep link to `title` on purpose. */
const SCREENS = ['title', 'counter', 'pick', 'library', 'dish', 'cutting'];

/** Measured inside the page: geometry, overflow, and every control a person can actually see. */
const PROBE = () => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    // `.sr` hides a control from sight while keeping it keyboard-reachable. Its box is real but
    // it is not a pointer target, so counting it as off-screen would be a false alarm.
    for (let node = el; node !== null; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.clipPath === 'inset(50%)' || (node.offsetWidth <= 1 && node.offsetHeight <= 1)) {
        return false;
      }
    }
    return true;
  };

  const stage = document.querySelector('.stage__board');
  const rect = stage?.getBoundingClientRect() ?? null;
  const controls = [...document.querySelectorAll('button, input, [role="button"]')]
    .filter(visible)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? el.value ?? '').trim().replace(/\s+/g, ' ').slice(0, 34),
        disabled: el.disabled === true,
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      };
    });

  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    hasStage: stage !== null,
    board: rect === null ? null : {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    },
    controls,
    fatal: document.querySelector('#fatal')?.textContent?.trim().slice(0, 120) ?? '',
    booting: document.querySelector('#boot:not(.gone)') !== null,
  };
};

const problems = [];
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

for (const vp of VIEWPORTS) {
  console.log(`\n=== ${vp.name} ===`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    permissions: ['camera'],
  });
  context.on('page', (p) => {
    p.on('pageerror', (e) => problems.push(`[${vp.name.trim()}] pageerror: ${String(e).slice(0, 160)}`));
    p.on('response', (r) => {
      if (r.status() >= 400) problems.push(`[${vp.name.trim()}] HTTP ${r.status()} ${r.url().slice(0, 120)}`);
    });
    p.on('requestfailed', (r) => problems.push(
      `[${vp.name.trim()}] failed ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ''}`,
    ));
  });
  const page = await context.newPage();

  for (const screen of SCREENS) {
    // The query string is not decoration. A `goto` that differs only in the fragment is not a
    // navigation -- the document is not reloaded and `main.ts`, which reads the hash exactly
    // once at boot, never runs again. Every screen would silently report the previous one.
    await page.goto(`${BASE}/?screen=${screen}#${screen}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1400);
    const m = await page.evaluate(PROBE);

    const flags = [];
    if (m.booting) flags.push('STILL-BOOTING');
    if (m.fatal !== '') flags.push(`FATAL:${m.fatal}`);
    if (!m.hasStage) flags.push('NO-STAGE');
    if (m.scrollW > m.vw) flags.push(`OVERFLOW-X ${m.scrollW}>${m.vw}`);
    if (m.scrollH > m.vh) flags.push(`OVERFLOW-Y ${m.scrollH}>${m.vh}`);
    if (m.board !== null) {
      // The scaled board must be centred and must not leave the window.
      if (m.board.x < 0 || m.board.y < 0) flags.push(`BOARD-NEG ${m.board.x},${m.board.y}`);
      if (m.board.x + m.board.w > m.vw + 1) flags.push(`BOARD-RIGHT ${m.board.x + m.board.w}>${m.vw}`);
      if (m.board.y + m.board.h > m.vh + 1) flags.push(`BOARD-BOTTOM ${m.board.y + m.board.h}>${m.vh}`);
      const slackX = Math.abs(m.board.x - (m.vw - m.board.w) / 2);
      const slackY = Math.abs(m.board.y - (m.vh - m.board.h) / 2);
      if (slackX > 1 || slackY > 1) flags.push(`OFF-CENTRE ${slackX.toFixed(0)},${slackY.toFixed(0)}`);
    }
    const off = m.controls.filter((c) => c.x < 0 || c.y < 0 || c.x + c.w > m.vw || c.y + c.h > m.vh);
    const tiny = m.controls.filter((c) => c.w > 0 && (c.w < 20 || c.h < 20));

    const board = m.board === null ? 'no stage' : `${m.board.w}x${m.board.h}@${m.board.x},${m.board.y}`;
    console.log(`  ${screen.padEnd(9)} board ${board.padEnd(20)}`
      + ` controls ${String(m.controls.length).padStart(2)}`
      + ` (${m.controls.filter((c) => c.disabled).length} off, ${off.length} outside, ${tiny.length} tiny)`
      + (flags.length === 0 ? '' : `  ${flags.join(' ')}`));
    for (const c of off) {
      console.log(`      OUTSIDE  "${c.text}" ${c.w}x${c.h} @${c.x},${c.y}`);
      problems.push(`[${vp.name.trim()}/${screen}] control outside the window: "${c.text}"`);
    }
    for (const c of tiny) console.log(`      TINY     "${c.text}" ${c.w}x${c.h}`);
    for (const f of flags) problems.push(`[${vp.name.trim()}/${screen}] ${f}`);
    for (const c of m.controls.filter((x) => x.disabled)) {
      console.log(`      disabled "${c.text}"`);
    }
  }

  await context.close();
}

await browser.close();

console.log(`\n=== problems (${problems.length}) ===`);
for (const p of [...new Set(problems)]) console.log(`  ${p}`);
