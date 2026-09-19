import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findForbiddenImports } from './purity-rules.mjs';

const ROOT = 'src/core';

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

let failed = false;

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  for (const violation of findForbiddenImports(source)) {
    console.error(`${relative('.', file)}:${violation.line}  forbidden import of ${violation.name}`);
    console.error(`    ${(lines[violation.line - 1] ?? '').trim()}`);
    failed = true;
  }
}

if (failed) {
  console.error('');
  console.error('src/core must stay adapter-free so it can be tested without a camera or a browser.');
  console.error('Vision SDKs and DOM work belong in src/vision and src/ui, which depend on core -- never the reverse.');
  process.exit(1);
}

console.log(`purity OK -- ${ROOT} imports no rendering or physics framework`);
