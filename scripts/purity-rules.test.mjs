import { describe, expect, it } from 'vitest';
import { findForbiddenImports } from './purity-rules.mjs';

const names = (source) => findForbiddenImports(source).map((v) => v.name);

describe('findForbiddenImports catches every import form', () => {
  it('catches a plain named import', () => {
    expect(names(`import { Vector3 } from 'three';`)).toEqual(['three']);
  });

  it('catches a default import', () => {
    expect(names(`import THREE from 'three';`)).toEqual(['three']);
  });

  it('catches a namespace import', () => {
    expect(names(`import * as THREE from 'three';`)).toEqual(['three']);
  });

  it('catches a side-effect import with no bindings', () => {
    expect(names(`import 'three';`)).toEqual(['three']);
  });

  it('catches a type-only import', () => {
    expect(names(`import type { World } from '@iwsdk/core';`)).toEqual(['@iwsdk']);
  });

  it('catches a subpath import', () => {
    expect(names(`import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';`))
      .toEqual(['three']);
  });

  it('catches a re-export', () => {
    expect(names(`export * from '@babylonjs/havok';`)).toEqual(['@babylonjs']);
  });

  // The two gaps that the line-oriented first version silently admitted.
  it('catches a multi-line import, as Prettier would wrap it', () => {
    const source = [
      'import {',
      '  Vector3,',
      '  Quaternion,',
      "} from 'three';",
    ].join('\n');
    expect(names(source)).toEqual(['three']);
  });

  it('catches a dynamic import', () => {
    expect(names(`const THREE = await import('three');`)).toEqual(['three']);
  });

  it('catches require', () => {
    expect(names(`const R = require('@dimforge/rapier3d-compat');`)).toEqual(['@dimforge']);
  });
});

describe('findForbiddenImports avoids false positives', () => {
  it('ignores a line comment mentioning an import', () => {
    expect(names(`// we deliberately do not import { X } from 'three' here`)).toEqual([]);
  });

  it('ignores a block comment mentioning an import', () => {
    expect(names(`/*\n  import { X } from 'three';\n*/`)).toEqual([]);
  });

  it('does not match a package that merely starts with a forbidden name', () => {
    expect(names(`import { Brush } from 'three-bvh-csg';`)).toEqual([]);
    expect(names(`import { MeshBVH } from 'three-mesh-bvh';`)).toEqual([]);
  });

  it('does not match a relative path that resembles a forbidden name', () => {
    expect(names(`import { helper } from './three.js';`)).toEqual([]);
  });

  it('does not treat a URL in a string as a comment and lose the line', () => {
    const source = `const doc = 'https://example.com/docs';\nimport { X } from 'three';`;
    expect(names(source)).toEqual(['three']);
  });

  it('passes a clean pure-simulation file', () => {
    const source = [
      "import { dot, type Vec3 } from './vec3.js';",
      "import type { LatheSpec } from './lathe.js';",
      'export const f = (a: Vec3) => dot(a, a);',
    ].join('\n');
    expect(names(source)).toEqual([]);
  });
});

describe('findForbiddenImports reports location', () => {
  it('reports the line the specifier appears on', () => {
    const source = [
      "import { dot } from './vec3.js';",
      '',
      "import { Vector3 } from 'three';",
    ].join('\n');
    expect(findForbiddenImports(source)).toEqual([
      { specifier: 'three', name: 'three', line: 3 },
    ]);
  });

  it('reports the closing line of a multi-line import, where the specifier sits', () => {
    const source = ['import {', '  Vector3,', "} from 'three';"].join('\n');
    expect(findForbiddenImports(source)[0].line).toBe(3);
  });

  it('reports every violation in a file, not just the first', () => {
    const source = [
      "import { Vector3 } from 'three';",
      "import { World } from '@iwsdk/core';",
    ].join('\n');
    expect(names(source)).toEqual(['three', '@iwsdk']);
  });
});
