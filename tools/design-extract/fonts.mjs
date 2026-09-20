/**
 * Fetches the two fonts the reference uses, from Google's own repository, with their licences.
 *
 * Both are SIL Open Font License 1.1, which permits embedding in an application. The licence
 * text is downloaded beside each font rather than linked, because OFL 1.1 clause 2 requires the
 * notice to travel WITH the font files -- a URL in a README does not satisfy it.
 *
 * The bundle carries subsetted woff2 for Hanken Grotesk and no Ranchers file at all (the
 * reference loads Ranchers from Google's CDN). Neither is usable: TextMeshPro needs a TTF or
 * OTF to bake an SDF atlas, and a subset has holes. So the full upstream files are fetched.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../design/fonts');
const BASE = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

const FILES = [
  { url: `${BASE}/ranchers/Ranchers-Regular.ttf`, name: 'Ranchers-Regular.ttf' },
  { url: `${BASE}/ranchers/OFL.txt`, name: 'Ranchers-OFL.txt' },
  { url: `${BASE}/hankengrotesk/HankenGrotesk%5Bwght%5D.ttf`, name: 'HankenGrotesk[wght].ttf' },
  { url: `${BASE}/hankengrotesk/OFL.txt`, name: 'HankenGrotesk-OFL.txt' },
];

await mkdir(OUT, { recursive: true });
const manifest = [];

for (const file of FILES) {
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url} -> ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(resolve(OUT, file.name), bytes);
  manifest.push({
    file: file.name,
    source: file.url,
    bytes: bytes.length,
    // Recorded so a later reader can prove the committed file is the one that was fetched,
    // rather than something that drifted through a well-meaning "font update".
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  console.log(`${file.name.padEnd(28)} ${String(bytes.length).padStart(8)} bytes`);
}

await writeFile(resolve(OUT, 'SOURCES.json'), `${JSON.stringify({ fetchedAt: new Date().toISOString(), files: manifest }, null, 2)}\n`);
