/**
 * Recomputes every contrast ratio in design/tokens.json and fails if one drifted.
 *
 * Run it after touching a colour. The numbers in `contrast.measured` are not decoration --
 * `contrast.largeTextOnly` is read by the Unity importer, which refuses to set a body-sized
 * label in a colour listed there.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(await readFile(resolve(here, '../../design/tokens.json'), 'utf8'));

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** The sRGB transfer function. The same curve the Unity importer has to apply. */
const linearise = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map(linearise);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const hex = (key) => tokens.color[key].hex;
const PAIRS = {
  'accent/text-on-dark': [hex('accent'), hex('text-on-dark')],
  'accent/text-on-accent': [hex('accent'), hex('text-on-accent')],
  'practice-accent/text-on-accent': [tokens.themes.PRACTICE.overrides.accent, tokens.themes.PRACTICE.overrides['text-on-accent']],
  'safe-accent/ink': [tokens.themes.SAFE.overrides.accent, hex('ink')],
  'surface/text-primary': [hex('surface'), hex('text-primary')],
  'surface/text-muted': [hex('surface'), hex('text-muted')],
  'surface/text-body': [hex('surface'), hex('text-body')],
  'rail/text-on-dark-muted': [hex('surface-rail'), hex('text-on-dark-muted')],
  'success/success-ink': [hex('success'), hex('success-ink')],
  'warning/warning-ink': [hex('warning'), hex('warning-ink')],
  'danger/danger-ink': [hex('danger'), hex('danger-ink')],
  'info/info-ink': [hex('info'), hex('info-ink')],
  'spice/spice-ink': [hex('spice'), hex('spice-ink')],
};

let drifted = 0;
for (const [name, [a, b]] of Object.entries(PAIRS)) {
  const actual = Math.round(contrast(a, b) * 100) / 100;
  const recorded = tokens.contrast.measured[name];
  const flag = recorded === undefined ? 'UNRECORDED' : Math.abs(actual - recorded) > 0.01 ? `DRIFT (recorded ${recorded})` : '';
  if (flag !== '') drifted += 1;
  console.log(`${name.padEnd(32)} ${String(actual).padStart(6)}  ${actual >= 4.5 ? 'AA' : actual >= 3 ? 'AA-large' : 'FAIL'}  ${flag}`);
}
if (drifted > 0) {
  console.error(`\n${drifted} pair(s) disagree with design/tokens.json`);
  process.exit(1);
}
console.log('\nall recorded ratios match');
