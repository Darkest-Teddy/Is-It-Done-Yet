/**
 * Detects imports that would break the framework-purity rule for `src/core`.
 *
 * Kept separate from the CLI in check-purity.mjs so the detection itself can be tested.
 * An untested guard is worse than no guard: it reports "purity OK" with total confidence
 * while a forbidden dependency sits in the tree. The first version of this file did exactly
 * that -- it matched on statement *shape* (`import` and `from` on one line), so a
 * Prettier-wrapped import or a dynamic `import()` sailed straight past it.
 *
 * This version matches the module specifier itself, which every import form shares.
 */

/** Package families that must never appear in the pure core layer. */
export const FORBIDDEN = [
  { name: 'three', matches: (s) => s === 'three' || s.startsWith('three/') },
  { name: '@iwsdk', matches: (s) => s.startsWith('@iwsdk/') },
  { name: '@babylonjs', matches: (s) => s.startsWith('@babylonjs/') },
  { name: '@dimforge', matches: (s) => s.startsWith('@dimforge/') },
];

/**
 * Captures the specifier in every import form:
 *   import x from 'spec'     } from 'spec'      (including multi-line)
 *   import 'spec'            import('spec')     (dynamic)
 *   require('spec')          export * from 'spec'
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Blanks out comment bodies while preserving newlines, so line numbers stay accurate. */
function blankComments(source) {
  const blankNonNewlines = (text) => text.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blankNonNewlines)
    // The leading guard keeps `https://` and `//` inside strings from reading as a comment.
    .replace(/(^|[^:"'`\\])(\/\/[^\n]*)/g, (_all, prefix, comment) => prefix + blankNonNewlines(comment));
}

/**
 * @param {string} source TypeScript source text.
 * @returns {Array<{ specifier: string, name: string, line: number }>} one entry per violation.
 */
export function findForbiddenImports(source) {
  const scannable = blankComments(source);
  const violations = [];

  for (const match of scannable.matchAll(SPECIFIER)) {
    const specifier = match[1];
    const forbidden = FORBIDDEN.find((f) => f.matches(specifier));
    if (!forbidden) continue;

    violations.push({
      specifier,
      name: forbidden.name,
      line: scannable.slice(0, match.index).split('\n').length,
    });
  }

  return violations;
}
