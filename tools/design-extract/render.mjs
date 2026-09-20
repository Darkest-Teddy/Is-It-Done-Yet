/**
 * Renders design/design-reference.html and captures what a Unity implementation has to match.
 *
 * The reference is a self-extracting bundle: a loader script decodes base64 assets out of
 * inline <script type="__bundler/*"> tags, rebuilds the document, and mounts a React component
 * over it. So nothing useful exists until the page has run -- reading the file cannot produce a
 * screenshot, and parsing its CSS cannot produce a computed style. A browser is the only thing
 * that can tell us what this design actually looks like.
 *
 * The page's own JavaScript is executed. That is the one place this tool trusts the reference,
 * and it is bounded: a `file://` page with no network, in a throwaway browser profile, whose
 * only output is pixels and a style dump.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SOURCE = resolve(repo, 'design/design-reference.html');
const REFERENCE_DIR = resolve(repo, 'design/reference');
const EXTRACT_DIR = resolve(repo, 'design/extracted');

/** Every property a Unity component could need to reproduce. Anything else is noise. */
const PROPERTIES = [
  'background-color', 'background-image', 'border-top-width', 'border-top-color',
  'border-top-style', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'box-shadow', 'color', 'font-family', 'font-size',
  'font-weight', 'letter-spacing', 'line-height', 'text-transform', 'text-shadow',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap',
  'width', 'height', 'opacity', 'transform', 'animation-name', 'animation-duration',
  'animation-timing-function',
];

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  await mkdir(REFERENCE_DIR, { recursive: true });
  await mkdir(EXTRACT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const captured = [];

  for (const scale of [1, 2]) {
    const context = await browser.newContext({
      deviceScaleFactor: scale,
      viewport: { width: 1700, height: 1000 },
      // The reference animates on loops forever. Freezing motion makes two runs of this tool
      // produce identical bytes, which is what makes a visual diff meaningful.
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') console.warn(`[page] ${msg.text()}`); });

    await page.goto(pathToFileURL(SOURCE).href, { waitUntil: 'load' });
    // The loader replaces the whole document, so waiting for a screen is the only reliable
    // signal that unpacking finished. `networkidle` fires immediately on a file:// page.
    await page.waitForSelector('[data-screen-label]', { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({
      content: '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}',
    });
    await page.waitForTimeout(400);

    const screens = await page.$$('[data-screen-label]');
    for (const screen of screens) {
      const label = await screen.getAttribute('data-screen-label');
      const name = `${slug(label)}@${scale}x.png`;
      await screen.screenshot({ path: resolve(REFERENCE_DIR, name) });
      if (scale === 1) captured.push({ label, file: name });
    }

    if (scale === 1) {
      const styles = await page.evaluate((props) => {
        /**
         * One sample per distinct visual component, keyed by a signature rather than by a
         * selector -- the reference is inline-styled with no class names, so there is nothing
         * to select. Two elements with the same fill, border, radius and shadow ARE the same
         * component as far as a Unity prefab is concerned.
         */
        const seen = new Map();
        for (const el of document.querySelectorAll('[data-screen-label] *')) {
          const cs = getComputedStyle(el);
          const signature = [
            cs.backgroundColor, cs.borderTopWidth, cs.borderTopColor,
            cs.borderTopLeftRadius, cs.boxShadow, cs.fontSize, cs.fontWeight, cs.color,
          ].join('|');
          if (seen.has(signature)) {
            seen.get(signature).count += 1;
            continue;
          }
          const record = { count: 1, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 40), style: {} };
          for (const prop of props) record.style[prop] = cs.getPropertyValue(prop);
          seen.set(signature, record);
        }
        return [...seen.values()].sort((a, b) => b.count - a.count);
      }, PROPERTIES);

      await writeFile(
        resolve(EXTRACT_DIR, 'computed-styles.json'),
        `${JSON.stringify({ source: 'design/design-reference.html', capturedAt: new Date().toISOString(), components: styles }, null, 2)}\n`,
      );
      console.log(`computed styles: ${styles.length} distinct components`);
    }

    await context.close();
  }

  await browser.close();
  console.log(`screens: ${captured.map((c) => c.label).join(', ')}`);
  await writeFile(resolve(REFERENCE_DIR, 'index.json'), `${JSON.stringify(captured, null, 2)}\n`);
}

await main();
