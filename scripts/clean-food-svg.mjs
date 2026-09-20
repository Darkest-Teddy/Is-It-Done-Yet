/**
 * Post-process a Higgsfield Recraft vector export into a page-ready food asset.
 *
 * Recraft honours `background_color` by painting an opaque full-canvas rect as the first
 * path, which is what makes the generated colours predictable -- but on the page the lanes
 * have their own ground, so that rect has to come off or every food reads as a dark box.
 *
 * Two things are removed, and nothing else is touched:
 *   1. The C2PA <metadata> manifest. It is provenance data the browser never reads, and on
 *      the sample that motivated this script it was 17700 of 35583 bytes -- half the file.
 *   2. The first path whose geometry is exactly the viewBox rectangle.
 *
 * The rect is matched on geometry, never on fill, because the same fill is reused for small
 * dark details on the food itself. Matching on colour would delete the artwork's shading.
 *
 * Usage: node scripts/clean-food-svg.mjs <file.svg> [...]
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Numbers in a path `d`, in order. Tolerates ints, decimals and negatives. */
function nums(d) {
  return (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

/**
 * True when `d` traces the full canvas. A background rect is four corners of (0,0,w,h) in
 * some order, so comparing the sorted coordinate set is orientation-independent and does not
 * care whether the generator emitted the path clockwise or not.
 */
function isCanvasRect(d, w, h) {
  const n = nums(d);
  if (n.length < 8 || n.length > 12) return false;
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, w * 0.005);
  const spans = (v, max) => near(Math.min(...v), 0) && near(Math.max(...v), max);
  return spans(xs, w) && spans(ys, h);
}

let failed = false;

for (const file of process.argv.slice(2)) {
  let svg;
  try {
    svg = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`${file}: cannot read -- ${err.code}`);
    failed = true;
    continue;
  }

  const before = svg.length;

  const box = svg.match(/viewBox="([\d.\s-]+)"/);
  if (!box) {
    console.error(`${file}: no viewBox, refusing to guess at the background`);
    failed = true;
    continue;
  }
  const [, , w, h] = box[1].trim().split(/\s+/).map(Number);

  svg = svg.replace(/<metadata>[\s\S]*?<\/metadata>/g, '');

  // Only the FIRST canvas-sized path is background. A later one would be deliberate.
  let dropped = 0;
  svg = svg.replace(/<path\b[^>]*?\/?>/g, (tag) => {
    if (dropped) return tag;
    const d = tag.match(/\sd="([^"]*)"/);
    if (d && isCanvasRect(d[1], w, h)) {
      dropped = 1;
      return '';
    }
    return tag;
  });

  writeFileSync(file, svg);

  const kb = (n) => (n / 1024).toFixed(1) + 'KB';
  console.log(
    `${file.split(/[\\/]/).pop().padEnd(16)} ${kb(before)} -> ${kb(svg.length)}` +
      `  background ${dropped ? 'removed' : 'NOT FOUND'}`
  );
  if (!dropped) failed = true;
}

process.exit(failed ? 1 : 0);
