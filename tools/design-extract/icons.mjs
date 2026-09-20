/**
 * Pulls the iconography out of the bundle and puts it somewhere Unity can import it.
 *
 * Two kinds, and they need opposite treatment:
 *
 *  - The eleven ingredient icons are PNGs in the bundle's manifest, at 160px. Unity wants a
 *    power-of-two source it can mip down from, so they are upscaled to 256 with Lanczos. This
 *    is an upscale of a rasterised original and there is no vector behind it -- see
 *    design/DEVIATIONS.md. They are also written out at their native 160px so a later
 *    regeneration can start from the real pixels rather than from the upscale.
 *
 *  - The SVGs are inline in the template: the six stacked burger layers on the loading screen
 *    and the knife used as a difficulty pip. These are true vectors, so both the source SVG
 *    and a 256px raster are committed.
 *
 * No SVG runtime ships in the build. Unity gets PNGs; the SVGs are provenance.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SOURCE = resolve(repo, 'design/design-reference.html');
const PNG_DIR = resolve(repo, 'design/icons/png');
const NATIVE_DIR = resolve(repo, 'design/icons/native');
const SVG_DIR = resolve(repo, 'design/icons/svg');

/**
 * uuid -> name. Six carry an id in the bundle's ext_resources; five do not, and those were
 * identified by looking at the decoded pixels. Recorded here because a uuid tells a reader
 * nothing and the mapping is otherwise unrecoverable without rendering them again.
 */
const NAMES = {
  'b130c870-60f4-41f3-96c9-d48a683bae69': 'patty',
  'a156d2df-7bfa-47ee-a685-7edc3c1a12f5': 'onion',
  'e66f31d7-06f8-418e-967f-93e1efba1b76': 'egg',
  '7f6501c9-d82f-4ac8-a1e2-0135defe2352': 'lettuce',
  'f6566c6f-c922-482a-8381-d7f71d33006b': 'mushroom',
  'd806e086-f15c-45e2-8c43-c45736e2c683': 'chili',
  '2902219d-14de-47da-8eac-00669ceb2a33': 'bun',
  '29260903-14e4-4882-aff6-157d2c9d3e61': 'cheese',
  '1ac244c7-b4b0-4ffa-abab-dca466a2bcb0': 'sauce',
  '98319357-8f96-4bc5-8968-3aee426fb2a9': 'tomato',
  '57871935-b12b-4205-a6ec-ec9492b12104': 'carrot',
};

/** The loading screen stacks these bottom-up. Named in that order. */
const SVG_NAMES = ['bun-bottom', 'patty-layer', 'cheese-layer', 'tomato-layer', 'lettuce-layer', 'bun-top'];

const html = await readFile(SOURCE, 'utf8');

function section(type) {
  const open = `<script type="__bundler/${type}">`;
  const start = html.indexOf(open);
  if (start === -1) throw new Error(`no ${type} section -- is this still a bundled page?`);
  const end = html.indexOf(`</scr${'ipt'}>`, start);
  return html.slice(start + open.length, end).trim();
}

await mkdir(PNG_DIR, { recursive: true });
await mkdir(NATIVE_DIR, { recursive: true });
await mkdir(SVG_DIR, { recursive: true });

const manifest = JSON.parse(section('manifest'));
const index = { png: [], svg: [] };

for (const [uuid, entry] of Object.entries(manifest)) {
  if (entry.mime !== 'image/png') continue;
  const name = NAMES[uuid];
  if (name === undefined) {
    console.warn(`unnamed png asset ${uuid} -- skipped`);
    continue;
  }
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.compressed) bytes = zlib.gunzipSync(bytes);

  await writeFile(resolve(NATIVE_DIR, `${name}.png`), bytes);
  await sharp(bytes)
    .resize(256, 256, { kernel: 'lanczos3', fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(PNG_DIR, `${name}.png`));

  const meta = await sharp(bytes).metadata();
  index.png.push({ name, uuid, nativeSize: `${meta.width}x${meta.height}`, exported: '256x256' });
  console.log(`png  ${name.padEnd(14)} ${meta.width}x${meta.height} -> 256x256`);
}

/**
 * The template is a JSON-encoded string; decoding it first means the SVG markup is real markup
 * rather than escaped text, and `/` has become a slash.
 */
const template = JSON.parse(section('template'));
const svgs = template.match(/<svg[\s\S]*?<\/svg>/g) ?? [];

/**
 * Marks written for this build rather than extracted from the reference.
 *
 * The four coach status glyphs exist because NEITHER licensed font contains a check or a
 * cross -- verified by the font tool, which reported them missing from both Ranchers and
 * Hanken Grotesk. The reference gets away with `✓` because a browser silently falls back to a
 * system face; TextMeshPro does not, and a missing glyph there is a blank box.
 *
 * Drawn in the design's own language: the one outline colour, the same round joins, the same
 * heavy stroke. Original work, so there is nothing to licence.
 */
const AUTHORED = ['status-ok', 'status-warn', 'status-bad', 'status-unsure', 'camera-active'];

let layer = 0;
for (let i = 0; i < svgs.length; i++) {
  /**
   * `sc-camel-view-box` is the design tool's own attribute, carrying what should be `viewBox`.
   * Without renaming it the SVG has no coordinate system, and every rasteriser renders an
   * empty box of the right size -- which looks like a transparent PNG rather than an error.
   */
  const markup = svgs[i].replace(/sc-camel-view-box=/g, 'viewBox=');
  const isLayer = /style="width:100%/.test(svgs[i]);
  const name = isLayer && layer < SVG_NAMES.length ? SVG_NAMES[layer++] : `mark-${String(i).padStart(2, '0')}`;

  await writeFile(resolve(SVG_DIR, `${name}.svg`), `${markup}\n`);
  await sharp(Buffer.from(markup))
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(PNG_DIR, `${name}.png`));
  index.svg.push({ name, source: `design/icons/svg/${name}.svg` });
  console.log(`svg  ${name}`);
}

for (const name of AUTHORED) {
  const markup = await readFile(resolve(SVG_DIR, `${name}.svg`), 'utf8');
  await sharp(Buffer.from(markup))
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(resolve(PNG_DIR, `${name}.png`));
  index.svg.push({ name, source: `design/icons/svg/${name}.svg`, authored: true });
  console.log(`svg  ${name} (authored for this build)`);
}

await writeFile(resolve(repo, 'design/icons/index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`\n${index.png.length} raster icons, ${index.svg.length} vector marks`);
