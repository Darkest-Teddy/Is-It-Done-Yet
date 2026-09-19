# MISE Simulation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the knife-work simulation core — cut-plane geometry, procedural lathe solid, metrics, scoring and hand safety — as pure TypeScript with a headless conformance harness, so the whole thing is provable from a terminal with no browser, no headset and no network.

**Architecture:** Everything in `src/sim/` is pure functions over plain `{x, y, z}` records and plain numbers. It imports no rendering framework, no physics engine, no XR SDK, and a `check:purity` script fails the build if that is ever violated. The rendering and XR layers (Plan 2) will consume this module; they never own game logic. This separation is what makes the conformance harness possible at all.

**Tech Stack:** TypeScript 5.9 (`strict: true`), Vitest 5, Node 24. No runtime dependencies whatsoever in this plan.

**Source spec:** `docs/superpowers/specs/2026-09-18-mise-knife-simulation-design.md`

---

## Scope

This plan delivers **Plan 1 of 2**. It ends with `npm run cuts` green and the geometry, metrics
and scoring proven. It produces no visuals.

Plan 2 (XR shell, meshes, Havok, audio, ribbon, HUD) is written after this plan is green and the
IWSDK project has been scaffolded, because its file paths and API calls depend on a generated
structure that does not yet exist on disk.

## File structure

| File | Responsibility |
|---|---|
| `src/sim/vec3.ts` | Vector math. `normalize` returns `null` rather than `NaN`. |
| `src/sim/tunables.ts` | Every magic number, one typed registry with bounds. |
| `src/sim/lathe.ts` | Profile function, parameter-space clipping, volume integral. |
| `src/sim/cutPlane.ts` | Blade sweep → best-fit plane, planarity residual, degeneracy rejection. |
| `src/sim/cutSolver.ts` | Plane × lathe → cap ring, stub, slice, angle, wedge. |
| `src/sim/metrics.ts` | Per-cut record: axial delta, perpendicular thickness, drift. |
| `src/sim/scoring.ts` | §7.4 aggregate score and its plain-millimetre rendering. |
| `src/sim/feedback.ts` | One descriptor consumed by both audio and haptics. |
| `src/sim/handSafety.ts` | §7.5 claw grip, fingertip proximity, debounced state. |
| `scripts/check-purity.mjs` | Fails if `src/sim/**` imports a framework. |
| `harness/runScript.ts` | `.cuts.json` replay driver. |
| `harness/conformance.test.ts` | The six system-level test groups. |

Unit tests are colocated (`src/sim/vec3.test.ts`). The harness holds only system-level
properties — conservation, fuzz, golden file — so `npm run cuts` and `npm test` mean different
things and both are useful.

---

## Task 1: Project foundation

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `scripts/check-purity.mjs`
- Create: `src/sim/.gitkeep`
- Create: `DECISIONS.md`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mise",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12.0 <23.0.0-0 || >=24.0.0"
  },
  "scripts": {
    "cuts": "vitest run harness",
    "test:sim": "vitest run src/sim",
    "check:purity": "node scripts/check-purity.mjs",
    "typecheck": "tsc --noEmit",
    "test": "npm run check:purity && npm run typecheck && vitest run"
  },
  "devDependencies": {
    "@types/node": "^26.6.1",
    "typescript": "~5.9.3",
    "vitest": "^5.0.1"
  }
}
```

TypeScript is pinned to 5.9 rather than the 7.0 native rewrite because IWSDK's own tooling is
built against 5.8.x, and Plan 2 has to coexist with it.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "harness", "scripts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
.vite/
*.local
```

- [ ] **Step 4: Create `scripts/check-purity.mjs`**

```js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'src/sim';

const FORBIDDEN = [
  { pattern: /['"]three(\/|['"])/, name: 'three' },
  { pattern: /['"]@iwsdk\//, name: '@iwsdk' },
  { pattern: /['"]@babylonjs\//, name: '@babylonjs' },
  { pattern: /['"]@dimforge\//, name: '@dimforge' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

let failed = false;

for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const isImport = /^\s*(import|export)\b.*\bfrom\b/.test(line) || /\brequire\(/.test(line);
    if (!isImport) return;
    for (const { pattern, name } of FORBIDDEN) {
      if (pattern.test(line)) {
        console.error(`${relative('.', file)}:${i + 1}  forbidden import of ${name}`);
        console.error(`    ${line.trim()}`);
        failed = true;
      }
    }
  });
}

if (failed) {
  console.error('');
  console.error('src/sim must stay framework-free so the headless harness can run it.');
  console.error('See docs/superpowers/specs/2026-09-18-mise-knife-simulation-design.md section 2.');
  process.exit(1);
}

console.log(`purity OK -- ${ROOT} imports no rendering or physics framework`);
```

- [ ] **Step 5: Create `src/sim/.gitkeep`**

An empty file. The purity script reads `src/sim` and must not crash on a missing directory.

- [ ] **Step 6: Create `DECISIONS.md`**

```markdown
# Decisions

Every deviation from `CLAUDE.md` (the master spec), with the reason. Required by master spec
rule #15.

## 1. Physics is Havok, not Rapier

**Spec section:** §8.10, which specifies Rapier "via IWSDK" and details
`world.integrationParameters`, `numSolverIterations` and `lengthUnit: 0.1`.

**Reality:** `@iwsdk/core@0.5.3` depends on `@babylonjs/havok`. A search of the published
package returns zero references to Rapier, and its `PhysicsSystem` docstring names Havok.

**Decision:** use IWSDK's built-in Havok. Adding Rapier alongside would mean a second WASM
blob, a second physics world, and hand-syncing transforms to reimplement what is already wired.
The collider table in §8.10 survives unchanged — Havok exposes `Cylinder`, `ConvexHull`,
`TriMesh`, `Capsules` and `Static | Dynamic | Kinematic`.

**Void as written:** `lengthUnit`, `numSolverIterations`, `integrationParameters`.

## 2. `angleScore` defined

**Spec section:** §7.4 uses `angleScore` in the weighted total but never defines it.

**Decision:** `angleScore = exp(-meanAngleDeviationDeg / angleToleranceDeg)`, matching the
exponential-falloff shape of the `accuracy` and `uniformity` terms beside it.

## 3. Hand joint indices corrected

**Spec section:** §7.5 comments the finger joint sets as `index (5,6,7,8)`, treating them as
MCP/PIP/DIP/TIP.

**Reality:** in the WebXR hand model those indices are `metacarpal, phalanx-proximal,
phalanx-intermediate, phalanx-distal`. Index 5 sits inside the palm and the fingertip — index
9 — is omitted entirely. `extensionRatio` computed from that set measures nothing useful while
appearing to work.

**Decision:** address joints by name, never by index. The spec's thresholds are correct and are
kept unchanged (extended ≈ 1.87, curled ≈ 0.88, so 1.3 discriminates cleanly).

## 4. Thickness is two numbers, not one

**Spec section:** §7.3 defines thickness as the drop in stub length between cuts.

**Reality:** that is an *axial* delta. The true thickness of the resulting disc is the
perpendicular distance between its faces, and the two differ by `cos(angle)`. A silhouette
contains no angle information, so the camera method can only ever report the axial number.

**Decision:** record both. Score the perpendicular one. The divergence between them is a demo
beat, because it demonstrates something the vision path cannot recover in principle.

## 5. `PhysicsShape.density` is g/cm³ despite its annotation

**Reality:** IWSDK annotates `density` as "kg/m³" with a default of `1.0`, but air is
1.2 kg/m³ and its own material table lists wood `0.6` and steel `7.8`. The values are g/cm³.

**Risk:** master spec §8.10 directs `massKg = profile.densityKgM3 × volumeM3` from a single
source of truth. Passing `1050` straight through would yield a 220-kilogram steak, silently.

**Decision:** convert once at the boundary (`densityKgM3 / 1000`) and assert at startup that the
engine's computed mass matches `densityKgM3 × volumeM3` within tolerance. If IWSDK later
corrects the annotation, the assertion fires instead of rescaling every mass by 1000×.
```

- [ ] **Step 7: Install and verify**

Run: `npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

Run: `npm run check:purity`
Expected: `purity OK -- src/sim imports no rendering or physics framework`

Run: `npm run typecheck`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore scripts/check-purity.mjs src/sim/.gitkeep DECISIONS.md
git commit -m "chore: project foundation with framework-purity guard"
```

---

## Task 2: Vector math

**Files:**
- Create: `src/sim/vec3.ts`
- Test: `src/sim/vec3.test.ts`

The design decision worth understanding: `normalize` returns `Vec3 | null`, not a `Vec3`
containing `NaN`. Master spec rule #5 warns that one `NaN` reaching a collider dimension
explodes the scene silently. Making the zero-length case a *type* the caller must destructure
means the compiler enforces the check rather than a code reviewer.

- [ ] **Step 1: Write the failing test**

Create `src/sim/vec3.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  add, allFinite, cross, distance, dot, len, normalize,
  pointSegmentDistance, scale, sub, v3,
} from './vec3.js';

describe('vec3 arithmetic', () => {
  it('adds, subtracts and scales componentwise', () => {
    expect(add(v3(1, 2, 3), v3(4, 5, 6))).toEqual(v3(5, 7, 9));
    expect(sub(v3(4, 5, 6), v3(1, 2, 3))).toEqual(v3(3, 3, 3));
    expect(scale(v3(1, -2, 3), 2)).toEqual(v3(2, -4, 6));
  });

  it('computes dot and cross products', () => {
    expect(dot(v3(1, 2, 3), v3(4, -5, 6))).toBe(12);
    expect(cross(v3(1, 0, 0), v3(0, 1, 0))).toEqual(v3(0, 0, 1));
    expect(cross(v3(0, 1, 0), v3(1, 0, 0))).toEqual(v3(0, 0, -1));
  });

  it('computes length and distance', () => {
    expect(len(v3(3, 4, 0))).toBe(5);
    expect(distance(v3(1, 0, 0), v3(4, 4, 0))).toBe(5);
  });
});

describe('normalize', () => {
  it('returns a unit vector', () => {
    const n = normalize(v3(0, 5, 0));
    expect(n).not.toBeNull();
    expect(n!).toEqual(v3(0, 1, 0));
  });

  it('returns null for a zero vector instead of producing NaN', () => {
    expect(normalize(v3(0, 0, 0))).toBeNull();
  });

  it('returns null for a vector too short to normalize stably', () => {
    expect(normalize(v3(1e-12, 0, 0))).toBeNull();
  });
});

describe('pointSegmentDistance', () => {
  it('measures perpendicular distance when the foot lies inside the segment', () => {
    const d = pointSegmentDistance(v3(0, 3, 0), v3(-5, 0, 0), v3(5, 0, 0));
    expect(d).toBeCloseTo(3, 12);
  });

  it('clamps to the near endpoint when the foot lies beyond it', () => {
    const d = pointSegmentDistance(v3(10, 0, 0), v3(-5, 0, 0), v3(5, 0, 0));
    expect(d).toBeCloseTo(5, 12);
  });

  it('handles a degenerate zero-length segment', () => {
    const d = pointSegmentDistance(v3(0, 4, 0), v3(0, 0, 0), v3(0, 0, 0));
    expect(d).toBeCloseTo(4, 12);
  });
});

describe('allFinite', () => {
  it('rejects NaN and Infinity', () => {
    expect(allFinite(v3(1, 2, 3))).toBe(true);
    expect(allFinite(v3(NaN, 0, 0))).toBe(false);
    expect(allFinite(v3(0, Infinity, 0))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/vec3.test.ts`
Expected: FAIL — `Failed to resolve import "./vec3.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/vec3.ts`:

```ts
/** An immutable point or direction. Plain data so the headless harness can construct it. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Below this length a direction is numerically meaningless; normalizing would amplify noise. */
const MIN_NORMALIZABLE_LENGTH = 1e-9;

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const len = (a: Vec3): number => Math.sqrt(dot(a, a));

export const distance = (a: Vec3, b: Vec3): number => len(sub(a, b));

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

export const midpoint = (a: Vec3, b: Vec3): Vec3 => scale(add(a, b), 0.5);

/**
 * Returns null rather than a NaN-filled vector when the input is too short to normalize.
 *
 * Master spec rule #5: a single NaN reaching a collider dimension explodes the scene silently.
 * Returning a nullable type makes the compiler force the caller to handle it.
 */
export function normalize(a: Vec3): Vec3 | null {
  const l = len(a);
  if (!(l > MIN_NORMALIZABLE_LENGTH)) return null;
  return scale(a, 1 / l);
}

/** Shortest distance from a point to the segment ab, clamped at both endpoints. */
export function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  if (lengthSquared === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / lengthSquared));
  return distance(p, add(a, scale(ab, t)));
}

export const allFinite = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/vec3.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/vec3.ts src/sim/vec3.test.ts
git commit -m "feat(sim): vector math with null-on-degenerate normalize"
```

---

## Task 3: Tunables registry

**Files:**
- Create: `src/sim/tunables.ts`
- Test: `src/sim/tunables.test.ts`

Master spec rule #11: every magic number gets a live slider. One registry, so the debug panel
and the headless harness read the same values and cannot drift apart.

- [ ] **Step 1: Write the failing test**

Create `src/sim/tunables.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { allTunables, resetTunables, setTunable, tunable, TUNABLE_DEFS } from './tunables.js';

describe('tunables', () => {
  beforeEach(() => resetTunables());

  it('returns the declared default before any override', () => {
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
    expect(tunable('CLAW_THRESHOLD')).toBe(1.3);
  });

  it('applies an override', () => {
    setTunable('TARGET_THICKNESS_MM', 5);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(5);
  });

  it('clamps an override to the declared bounds', () => {
    const def = TUNABLE_DEFS.TARGET_THICKNESS_MM;
    setTunable('TARGET_THICKNESS_MM', def.max + 100);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(def.max);
    setTunable('TARGET_THICKNESS_MM', def.min - 100);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(def.min);
  });

  it('ignores a non-finite override rather than poisoning the registry', () => {
    setTunable('TARGET_THICKNESS_MM', NaN);
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
  });

  it('resets every override', () => {
    setTunable('TARGET_THICKNESS_MM', 7);
    resetTunables();
    expect(tunable('TARGET_THICKNESS_MM')).toBe(3);
  });

  it('enumerates every tunable with its current value, for panel generation', () => {
    setTunable('DANGER_MM', 25);
    const found = allTunables().find((t) => t.key === 'DANGER_MM');
    expect(found).toMatchObject({ key: 'DANGER_MM', value: 25, unit: 'mm' });
  });

  it('declares every default inside its own bounds', () => {
    for (const t of allTunables()) {
      expect(t.value, `${t.key} default out of bounds`).toBeGreaterThanOrEqual(t.min);
      expect(t.value, `${t.key} default out of bounds`).toBeLessThanOrEqual(t.max);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/tunables.test.ts`
Expected: FAIL — `Failed to resolve import "./tunables.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/tunables.ts`:

```ts
export interface TunableDef {
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

/**
 * Every magic number in the simulation. Master spec rule #11.
 *
 * The debug panel is generated from this table and the headless harness reads the same
 * defaults, so tests exercise the real values rather than a parallel set that drifts.
 */
export const TUNABLE_DEFS = {
  // --- cut plane -------------------------------------------------------------
  MIN_SWEEP_M: {
    label: 'Minimum sweep', default: 0.004, min: 0.0005, max: 0.05, step: 0.0005, unit: 'm',
  },
  MIN_CROSS_SIN: {
    label: 'Minimum blade/sweep angle (sin)', default: 0.17, min: 0.01, max: 0.7, step: 0.01, unit: '',
  },
  MAX_PLANARITY_RESIDUAL_M: {
    label: 'Max planarity residual', default: 0.002, min: 0.0001, max: 0.02, step: 0.0001, unit: 'm',
  },
  MAX_SWEEP_SUBDIVISIONS: {
    label: 'Max sweep subdivisions', default: 8, min: 1, max: 32, step: 1, unit: '',
  },
  MIN_AXIS_DOT: {
    label: 'Min |normal . axis| before a cut counts as lengthwise',
    default: 0.26, min: 0.05, max: 0.95, step: 0.01, unit: '',
  },

  // --- cucumber --------------------------------------------------------------
  CUCUMBER_LENGTH_M: {
    label: 'Cucumber length', default: 0.18, min: 0.05, max: 0.4, step: 0.005, unit: 'm',
  },
  CUCUMBER_RADIUS_M: {
    label: 'Cucumber radius', default: 0.021, min: 0.005, max: 0.06, step: 0.001, unit: 'm',
  },
  LATHE_RADIAL_SEGMENTS: {
    label: 'Lathe radial segments', default: 32, min: 8, max: 96, step: 1, unit: '',
  },
  LATHE_PROFILE_SEGMENTS: {
    label: 'Lathe profile segments', default: 24, min: 4, max: 64, step: 1, unit: '',
  },

  // --- scoring ---------------------------------------------------------------
  TARGET_THICKNESS_MM: {
    label: 'Target thickness', default: 3, min: 0.5, max: 30, step: 0.1, unit: 'mm',
  },
  TOLERANCE_MM: {
    label: 'Thickness tolerance', default: 0.5, min: 0.1, max: 5, step: 0.1, unit: 'mm',
  },
  TARGET_SIGMA_MM: {
    label: 'Target sigma', default: 0.5, min: 0.1, max: 5, step: 0.1, unit: 'mm',
  },
  ANGLE_TOLERANCE_DEG: {
    label: 'Angle tolerance', default: 5, min: 0.5, max: 45, step: 0.5, unit: 'deg',
  },

  // --- fragments and ribbon --------------------------------------------------
  MAX_FRAGMENTS: {
    label: 'Max fragments', default: 40, min: 4, max: 120, step: 1, unit: '',
  },
  FRAGMENT_SLEEP_S: {
    label: 'Fragment sleep delay', default: 2, min: 0.2, max: 10, step: 0.1, unit: 's',
  },
  FRAGMENT_DESPAWN_S: {
    label: 'Fragment despawn delay', default: 8, min: 1, max: 60, step: 0.5, unit: 's',
  },
  RIBBON_LIFETIME_S: {
    label: 'Ribbon lifetime', default: 2, min: 0.2, max: 10, step: 0.1, unit: 's',
  },

  // --- hand safety -----------------------------------------------------------
  CLAW_THRESHOLD: {
    label: 'Claw extension threshold', default: 1.3, min: 1, max: 2, step: 0.01, unit: '',
  },
  DANGER_MM: {
    label: 'Danger distance', default: 20, min: 2, max: 100, step: 1, unit: 'mm',
  },
  WARN_MM: {
    label: 'Warning distance', default: 45, min: 5, max: 200, step: 1, unit: 'mm',
  },
  SAFETY_DEBOUNCE_FRAMES: {
    label: 'Safety de-escalation frames', default: 4, min: 1, max: 30, step: 1, unit: '',
  },

  // --- feedback --------------------------------------------------------------
  HAPTIC_SCALE: {
    label: 'Haptic intensity scale', default: 1, min: 0, max: 2, step: 0.05, unit: '',
  },
  AUDIO_BASE_HZ: {
    label: 'Chop base frequency', default: 320, min: 60, max: 1200, step: 10, unit: 'Hz',
  },
  AUDIO_PITCH_RANGE_HZ: {
    label: 'Chop pitch range across accuracy', default: 480, min: 0, max: 2000, step: 10, unit: 'Hz',
  },
  AUDIO_BURST_MS: {
    label: 'Chop burst duration', default: 90, min: 10, max: 500, step: 5, unit: 'ms',
  },
  AUDIO_BANDPASS_Q: {
    label: 'Chop bandpass Q', default: 6, min: 0.5, max: 30, step: 0.5, unit: '',
  },

  // --- blade geometry (consumed by BladeSystem in Plan 2) --------------------
  BLADE_LENGTH_M: {
    label: 'Blade heel-to-tip length', default: 0.15, min: 0.04, max: 0.4, step: 0.005, unit: 'm',
  },
  BLADE_HEEL_OFFSET_M: {
    label: 'Heel offset ahead of the controller grip',
    default: 0.03, min: -0.1, max: 0.3, step: 0.005, unit: 'm',
  },
} as const satisfies Record<string, TunableDef>;

export type TunableKey = keyof typeof TUNABLE_DEFS;

export interface TunableView extends TunableDef {
  readonly key: TunableKey;
  readonly value: number;
}

const overrides = new Map<TunableKey, number>();

export function tunable(key: TunableKey): number {
  const override = overrides.get(key);
  return override ?? TUNABLE_DEFS[key].default;
}

/** Clamps to the declared bounds. A non-finite value is ignored, never stored. */
export function setTunable(key: TunableKey, value: number): void {
  if (!Number.isFinite(value)) return;
  const def = TUNABLE_DEFS[key];
  overrides.set(key, Math.min(def.max, Math.max(def.min, value)));
}

export function resetTunables(): void {
  overrides.clear();
}

export function allTunables(): readonly TunableView[] {
  return (Object.keys(TUNABLE_DEFS) as TunableKey[]).map((key) => ({
    ...TUNABLE_DEFS[key],
    key,
    value: tunable(key),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/tunables.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/tunables.ts src/sim/tunables.test.ts
git commit -m "feat(sim): typed tunables registry with bounds"
```

---

## Task 4: Lathe solid

**Files:**
- Create: `src/sim/lathe.ts`
- Test: `src/sim/lathe.test.ts`

Two things here are load-bearing and easy to get wrong.

**Parameter-space clipping.** The naive reading of master spec §7.6 is to rebuild with a shorter
length after each cut. That re-normalizes `t`, so the taper and tip cap recompress and the
cucumber visibly morphs on every cut. The profile must always be evaluated in the *original*
parameter space and clipped.

**The volume integral.** In cylindrical coordinates the volume element integrates to
`∫∫ (r(y)² / 2) dy dθ`. Using `π ∫ r(y)² dy` over the axial span instead assumes flat end caps,
which is false for every angled cut and would fail the conservation test for reasons that look
like a geometry bug rather than a calculus one.

- [ ] **Step 1: Write the failing test**

Create `src/sim/lathe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  axialLengthM, CUCUMBER_PROFILE, CYLINDER_PROFILE, cylinder,
  type LatheSpec, radiusAt, volumeOf,
} from './lathe.js';

const R = 0.02;
const L = 0.1;

describe('radiusAt', () => {
  it('is constant for the cylinder profile', () => {
    const spec = cylinder({ originalLengthM: L, radiusM: R });
    expect(radiusAt(spec, 0)).toBeCloseTo(R, 12);
    expect(radiusAt(spec, L / 2)).toBeCloseTo(R, 12);
  });

  it('closes to zero at the cucumber tip', () => {
    const spec: LatheSpec = {
      originalLengthM: L, fromM: 0, toM: L, radiusM: R,
      profile: CUCUMBER_PROFILE, lowerCapRing: null, upperCapRing: null,
    };
    expect(radiusAt(spec, L)).toBeCloseTo(0, 9);
    expect(radiusAt(spec, L * 0.5)).toBeGreaterThan(R * 0.9);
  });

  it('keeps the same radius at a given absolute position after clipping', () => {
    const full: LatheSpec = {
      originalLengthM: L, fromM: 0, toM: L, radiusM: R,
      profile: CUCUMBER_PROFILE, lowerCapRing: null, upperCapRing: null,
    };
    const clipped: LatheSpec = { ...full, fromM: L * 0.4 };
    // The shape must not morph when the stub shortens.
    expect(radiusAt(clipped, L * 0.7)).toBeCloseTo(radiusAt(full, L * 0.7), 12);
  });
});

describe('volumeOf', () => {
  it('matches the closed form for a flat-capped cylinder', () => {
    const spec = cylinder({ originalLengthM: L, radiusM: R });
    expect(volumeOf(spec, 32, 24)).toBeCloseTo(Math.PI * R * R * L, 12);
  });

  it('matches the closed form for a clipped cylinder', () => {
    const spec = { ...cylinder({ originalLengthM: L, radiusM: R }), fromM: 0.03, toM: 0.08 };
    expect(volumeOf(spec, 32, 24)).toBeCloseTo(Math.PI * R * R * 0.05, 12);
  });

  it('equals pi r^2 * axial delta for two parallel slanted caps', () => {
    // Every radial column has identical axial extent when the caps are parallel,
    // regardless of how far the pair is tilted.
    const segments = 64;
    const tilt = 0.4;
    const lower: number[] = [];
    const upper: number[] = [];
    for (let j = 0; j < segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const offset = tilt * R * Math.cos(theta);
      lower.push(0.03 + offset);
      upper.push(0.08 + offset);
    }
    const spec: LatheSpec = {
      ...cylinder({ originalLengthM: L, radiusM: R }),
      fromM: 0.03, toM: 0.08, lowerCapRing: lower, upperCapRing: upper,
    };
    expect(volumeOf(spec, segments, 24)).toBeCloseTo(Math.PI * R * R * 0.05, 9);
  });

  it('is never negative or non-finite for a degenerate empty span', () => {
    const spec = { ...cylinder({ originalLengthM: L, radiusM: R }), fromM: 0.05, toM: 0.05 };
    const v = volumeOf(spec, 32, 24);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(0, 12);
  });
});

describe('axialLengthM', () => {
  it('measures flat caps directly', () => {
    const spec = { ...cylinder({ originalLengthM: L, radiusM: R }), fromM: 0.02, toM: 0.09 };
    expect(axialLengthM(spec)).toBeCloseTo(0.07, 12);
  });

  it('uses the ring mean for a slanted cap, which is the axis intersection', () => {
    const segments = 64;
    const ring: number[] = [];
    for (let j = 0; j < segments; j++) {
      ring.push(0.02 + 0.01 * Math.cos((j / segments) * Math.PI * 2));
    }
    const spec: LatheSpec = {
      ...cylinder({ originalLengthM: L, radiusM: R }),
      fromM: 0.02, toM: 0.09, lowerCapRing: ring,
    };
    expect(axialLengthM(spec)).toBeCloseTo(0.07, 9);
  });
});

describe('CUCUMBER_PROFILE', () => {
  it('stays within a plausible band along the body', () => {
    for (let t = 0; t <= 0.9; t += 0.1) {
      const m = CUCUMBER_PROFILE(t);
      expect(m).toBeGreaterThan(0.7);
      expect(m).toBeLessThanOrEqual(1.06);
    }
  });

  it('is exactly 1 everywhere for the cylinder profile', () => {
    expect(CYLINDER_PROFILE(0)).toBe(1);
    expect(CYLINDER_PROFILE(0.5)).toBe(1);
    expect(CYLINDER_PROFILE(1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/lathe.test.ts`
Expected: FAIL — `Failed to resolve import "./lathe.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/lathe.ts`:

```ts
/** Maps normalized position along the ORIGINAL length to a radius multiplier. */
export type ProfileFn = (t: number) => number;

/**
 * Master spec §7.6. A gentle taper, a slight middle swell, and a cap that closes the tip.
 * Evaluated over the original parameterization so a shortened stub keeps its true shape.
 */
export const CUCUMBER_PROFILE: ProfileFn = (t) => {
  const taper = 1 - 0.22 * t ** 3;
  const bulge = 1 + 0.05 * Math.sin(t * Math.PI);
  const cap = t > 0.93 ? Math.cos(((t - 0.93) / 0.07) * (Math.PI / 2)) : 1;
  return taper * bulge * cap;
};

/** A perfect cylinder. Used by tests that assert against closed-form volumes. */
export const CYLINDER_PROFILE: ProfileFn = () => 1;

export interface LatheSpec {
  /** Never changes as the stub shortens. The profile is always evaluated against this. */
  readonly originalLengthM: number;
  /** Lower clip bound in original axial coordinates. */
  readonly fromM: number;
  /** Upper clip bound in original axial coordinates. */
  readonly toM: number;
  readonly radiusM: number;
  readonly profile: ProfileFn;
  /** Per-radial-segment axial position of a slanted lower cap, or null when flat at fromM. */
  readonly lowerCapRing: readonly number[] | null;
  /** Per-radial-segment axial position of a slanted upper cap, or null when flat at toM. */
  readonly upperCapRing: readonly number[] | null;
}

export function cylinder(opts: { originalLengthM: number; radiusM: number }): LatheSpec {
  return {
    originalLengthM: opts.originalLengthM,
    fromM: 0,
    toM: opts.originalLengthM,
    radiusM: opts.radiusM,
    profile: CYLINDER_PROFILE,
    lowerCapRing: null,
    upperCapRing: null,
  };
}

export function cucumber(opts: { originalLengthM: number; radiusM: number }): LatheSpec {
  return { ...cylinder(opts), profile: CUCUMBER_PROFILE };
}

/** Radius at an absolute axial position, in original parameter space. */
export function radiusAt(spec: LatheSpec, yM: number): number {
  const t = spec.originalLengthM === 0 ? 0 : yM / spec.originalLengthM;
  return spec.radiusM * spec.profile(Math.min(1, Math.max(0, t)));
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The mean of a cap ring is its axis intersection, because the per-angle perturbation is
 * proportional to cos and sin and averages to zero over a full revolution.
 */
export const lowerBoundM = (spec: LatheSpec): number =>
  spec.lowerCapRing ? mean(spec.lowerCapRing) : spec.fromM;

export const upperBoundM = (spec: LatheSpec): number =>
  spec.upperCapRing ? mean(spec.upperCapRing) : spec.toM;

/** Axial extent measured at the axis. This is the quantity §7.3's stub method tracks. */
export const axialLengthM = (spec: LatheSpec): number =>
  Math.max(0, upperBoundM(spec) - lowerBoundM(spec));

/** Simpson's rule over r(y)^2. `steps` is forced even. */
function integrateRadiusSquared(
  spec: LatheSpec, yLo: number, yHi: number, steps: number,
): number {
  if (!(yHi > yLo)) return 0;
  const n = steps % 2 === 0 ? steps : steps + 1;
  const h = (yHi - yLo) / n;
  const f = (y: number) => radiusAt(spec, y) ** 2;
  let sum = f(yLo) + f(yHi);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 1 ? 4 : 2) * f(yLo + i * h);
  }
  return (sum * h) / 3;
}

/**
 * Volume in cylindrical coordinates: the element integrates to (r(y)^2 / 2) dy dtheta.
 *
 * NOT `pi * integral r(y)^2 dy` over the axial span -- that assumes flat end caps and is wrong
 * for every angled cut.
 */
export function volumeOf(
  spec: LatheSpec, radialSegments: number, profileSegments: number,
): number {
  const dTheta = (Math.PI * 2) / radialSegments;
  let total = 0;
  for (let j = 0; j < radialSegments; j++) {
    const lo = spec.lowerCapRing ? (spec.lowerCapRing[j] ?? spec.fromM) : spec.fromM;
    const hi = spec.upperCapRing ? (spec.upperCapRing[j] ?? spec.toM) : spec.toM;
    total += (dTheta / 2) * integrateRadiusSquared(spec, lo, hi, profileSegments);
  }
  return total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/lathe.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/lathe.ts src/sim/lathe.test.ts
git commit -m "feat(sim): lathe solid with parameter-space clipping and cylindrical volume"
```

---

## Task 5: Cut plane from blade sweep

**Files:**
- Create: `src/sim/cutPlane.ts`
- Test: `src/sim/cutPlane.test.ts`

Master spec §7.2 gives `normal = normalize(cross(bladeDirection, sweepDirection))`. Correct, but
it has three degenerate cases that each produce `NaN`, plus a fourth situation where the swept
surface genuinely is not a plane.

The normal is fitted with Newell's method across all four corners of the swept quad rather than
taken from the raw cross product, because Newell best-fits every corner and the residual it
leaves is the number that substantiates the "exact, not estimated" claim in §7.4.

### The minimum-sweep gate belongs to the stroke, not to a fragment of it

`fitSweepPlane` is an unopinionated fit. A second function, `resolveSweepPlanes`, owns the
subdivision policy — and specifically applies the `MIN_SWEEP_M` gate **once, to the whole
sweep, before subdividing.**

This is not a detail. That gate asks "did the blade move at all, or is it being held still?",
which is a property of the stroke. A sweep divided into 8 has parts one eighth as long: a
genuine 28mm cut becomes eight 3.5mm fragments, every one of which falls below the 4mm
threshold. Applying the gate per-part therefore rejects every subdivision of a real cut as
`'no-sweep'`, and the planarity check the subdivision existed to satisfy never runs at all.
The threshold is scaled by the subdivision count for the parts.

Any caller that hand-rolls fit → subdivide → refit re-introduces this bug. Go through
`resolveSweepPlanes`.

- [ ] **Step 1: Write the failing test**

Create `src/sim/cutPlane.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fitSweepPlane, subdivideSweep, type SweepSample } from './cutPlane.js';
import { allFinite, v3 } from './vec3.js';

/**
 * Blade lying along X at height y, swept straight down in Y.
 *
 * The swept quad therefore lies in the z = 0 plane and its normal points along Z. This is a
 * plane-fitting fixture only -- see Task 11 for the food-local orientation a real cut needs.
 */
function verticalChop(fromY: number, toY: number): SweepSample {
  return {
    previous: { heel: v3(-0.05, fromY, 0), tip: v3(0.05, fromY, 0) },
    current: { heel: v3(-0.05, toY, 0), tip: v3(0.05, toY, 0) },
  };
}

const OPTS = { minSweepM: 0.004, minCrossSin: 0.17, maxPlanarityResidualM: 0.002 };

describe('fitSweepPlane', () => {
  it('produces a plane normal perpendicular to both blade and sweep', () => {
    const fit = fitSweepPlane(verticalChop(0.1, 0.08), OPTS);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    // Blade along X, sweep along Y, so the quad lies in z = 0 and the normal is along Z.
    expect(Math.abs(fit.plane.normal.z)).toBeCloseTo(1, 9);
    expect(fit.plane.normal.x).toBeCloseTo(0, 9);
    expect(fit.plane.normal.y).toBeCloseTo(0, 9);
    expect(fit.planarityResidualM).toBeCloseTo(0, 12);
    expect(allFinite(fit.plane.normal)).toBe(true);
  });

  it('places the plane point at the centroid of the swept quad', () => {
    const fit = fitSweepPlane(verticalChop(0.1, 0.08), OPTS);
    if (!fit.ok) throw new Error('expected a fit');
    expect(fit.plane.point.y).toBeCloseTo(0.09, 12);
  });

  it('rejects a blade that barely moved', () => {
    const fit = fitSweepPlane(verticalChop(0.1, 0.0999), OPTS);
    expect(fit).toEqual({ ok: false, reason: 'no-sweep' });
  });

  it('rejects a draw stroke sliding along the blade axis', () => {
    const sweep: SweepSample = {
      previous: { heel: v3(-0.05, 0.1, 0), tip: v3(0.05, 0.1, 0) },
      current: { heel: v3(0.02, 0.1, 0), tip: v3(0.12, 0.1, 0) },
    };
    expect(fitSweepPlane(sweep, OPTS)).toEqual({ ok: false, reason: 'draw-stroke' });
  });

  it('rejects a sweep that rotated too far to be one plane', () => {
    const sweep: SweepSample = {
      previous: { heel: v3(-0.05, 0.1, 0), tip: v3(0.05, 0.1, 0) },
      current: { heel: v3(-0.05, 0.08, 0), tip: v3(0.05, 0.08, 0.04) },
    };
    const fit = fitSweepPlane(sweep, OPTS);
    expect(fit).toEqual({ ok: false, reason: 'non-planar' });
  });

  it('accepts that same rotated sweep once subdivided', () => {
    const sweep: SweepSample = {
      previous: { heel: v3(-0.05, 0.1, 0), tip: v3(0.05, 0.1, 0) },
      current: { heel: v3(-0.05, 0.08, 0), tip: v3(0.05, 0.08, 0.04) },
    };
    const parts = subdivideSweep(sweep, 8);
    expect(parts).toHaveLength(8);
    for (const part of parts) {
      expect(fitSweepPlane(part, OPTS).ok, 'each sub-sweep should fit a plane').toBe(true);
    }
  });

  it('rejects a zero-length blade rather than producing NaN', () => {
    const sweep: SweepSample = {
      previous: { heel: v3(0, 0.1, 0), tip: v3(0, 0.1, 0) },
      current: { heel: v3(0, 0.05, 0), tip: v3(0, 0.05, 0) },
    };
    const fit = fitSweepPlane(sweep, OPTS);
    expect(fit.ok).toBe(false);
  });

  it('never returns a non-finite normal for any accepted fit', () => {
    for (let i = 0; i < 500; i++) {
      const r = () => (Math.random() - 0.5) * 0.4;
      const sweep: SweepSample = {
        previous: { heel: v3(r(), r(), r()), tip: v3(r(), r(), r()) },
        current: { heel: v3(r(), r(), r()), tip: v3(r(), r(), r()) },
      };
      const fit = fitSweepPlane(sweep, OPTS);
      if (fit.ok) {
        expect(allFinite(fit.plane.normal)).toBe(true);
        expect(allFinite(fit.plane.point)).toBe(true);
        expect(Number.isFinite(fit.planarityResidualM)).toBe(true);
      }
    }
  });
});

describe('subdivideSweep', () => {
  it('produces contiguous sub-sweeps covering the original', () => {
    const parts = subdivideSweep(verticalChop(0.1, 0.06), 4);
    expect(parts[0]!.previous.heel.y).toBeCloseTo(0.1, 12);
    expect(parts[3]!.current.heel.y).toBeCloseTo(0.06, 12);
    expect(parts[1]!.previous.heel.y).toBeCloseTo(parts[0]!.current.heel.y, 12);
  });

  it('returns the original for a single step', () => {
    expect(subdivideSweep(verticalChop(0.1, 0.06), 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/cutPlane.test.ts`
Expected: FAIL — `Failed to resolve import "./cutPlane.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/cutPlane.ts`:

```ts
import {
  cross, dot, lerp, len, midpoint, normalize, scale, sub, v3, type Vec3,
} from './vec3.js';

export interface Plane {
  readonly normal: Vec3;
  readonly point: Vec3;
}

export interface BladeSegment {
  readonly heel: Vec3;
  readonly tip: Vec3;
}

export interface SweepSample {
  readonly previous: BladeSegment;
  readonly current: BladeSegment;
}

export type PlaneFitFailure = 'no-sweep' | 'draw-stroke' | 'non-planar';

export type PlaneFit =
  | { readonly ok: true; readonly plane: Plane; readonly planarityResidualM: number }
  | { readonly ok: false; readonly reason: PlaneFitFailure };

export interface PlaneFitOptions {
  readonly minSweepM: number;
  readonly minCrossSin: number;
  readonly maxPlanarityResidualM: number;
}

/** Newell's method: exact for a planar polygon, and a least-squares fit when it is not. */
function newellNormal(corners: readonly Vec3[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  return v3(nx, ny, nz);
}

/**
 * Fits the plane swept by the blade between two frames.
 *
 * Master spec §7.2 gives normal = cross(bladeDirection, sweepDirection). That is right, but it
 * yields NaN when the blade did not move, when the blade has no length, and when the sweep runs
 * along the blade's own axis. It also silently lies when the blade rotated mid-sweep, because
 * the swept surface is then a hyperbolic paraboloid rather than a plane.
 */
export function fitSweepPlane(sweep: SweepSample, opts: PlaneFitOptions): PlaneFit {
  const { previous, current } = sweep;

  const sweepVector = sub(midpoint(current.heel, current.tip), midpoint(previous.heel, previous.tip));
  if (len(sweepVector) < opts.minSweepM) return { ok: false, reason: 'no-sweep' };

  const bladeDirection = normalize(sub(current.tip, current.heel));
  const sweepDirection = normalize(sweepVector);
  if (bladeDirection === null || sweepDirection === null) {
    return { ok: false, reason: 'no-sweep' };
  }

  // |cross| of two unit vectors is the sine of the angle between them. Near zero means the
  // blade slid along its own length: a draw stroke, not a cut.
  const orientation = cross(bladeDirection, sweepDirection);
  if (len(orientation) < opts.minCrossSin) return { ok: false, reason: 'draw-stroke' };

  // Ordered around the quad, so Newell sees a simple polygon.
  const corners = [previous.heel, previous.tip, current.tip, current.heel];
  const fitted = normalize(newellNormal(corners));
  if (fitted === null) return { ok: false, reason: 'draw-stroke' };

  // Agree with the cross-product orientation so the normal's sign is stable across frames.
  const normal = dot(fitted, orientation) < 0 ? scale(fitted, -1) : fitted;

  const centroid = scale(
    corners.reduce((a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z), v3(0, 0, 0)),
    1 / corners.length,
  );

  let planarityResidualM = 0;
  for (const corner of corners) {
    planarityResidualM = Math.max(planarityResidualM, Math.abs(dot(normal, sub(corner, centroid))));
  }
  if (planarityResidualM > opts.maxPlanarityResidualM) {
    return { ok: false, reason: 'non-planar' };
  }

  return { ok: true, plane: { normal, point: centroid }, planarityResidualM };
}

/** Splits a sweep into contiguous sub-sweeps so a rotating sweep can be solved piecewise. */
export function subdivideSweep(sweep: SweepSample, steps: number): readonly SweepSample[] {
  const n = Math.max(1, Math.floor(steps));
  if (n === 1) return [sweep];

  const at = (t: number): BladeSegment => ({
    heel: lerp(sweep.previous.heel, sweep.current.heel, t),
    tip: lerp(sweep.previous.tip, sweep.current.tip, t),
  });

  const parts: SweepSample[] = [];
  for (let i = 0; i < n; i++) {
    parts.push({ previous: at(i / n), current: at((i + 1) / n) });
  }
  return parts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/cutPlane.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/cutPlane.ts src/sim/cutPlane.test.ts
git commit -m "feat(sim): sweep-to-plane fit with planarity residual and typed rejections"
```

---

## Task 6: Cut solver

**Files:**
- Create: `src/sim/cutSolver.ts`
- Test: `src/sim/cutSolver.test.ts`

`solveCut` works in **food-local space**: the food axis is `(0, 1, 0)` and the food origin is
`(0, 0, 0)`. The XR layer transforms the world-space plane into this space before calling.
Fixing the frame here keeps the solver testable with hand-written numbers.

The cap ring is the analytic fast path of §7.2 done exactly rather than approximated. For a
surface point at radial angle θ and axial position y, the plane equation `n · X = n · p` gives:

```
y(θ) = ( n·p − r(y) · (nx·cosθ + nz·sinθ) ) / ny
```

`r` depends on `y`, so this is implicit — but the dependence is weak, and three fixed-point
iterations converge far below the tolerance we care about. For a cylinder it is exact after one.

- [ ] **Step 1: Write the failing test**

Create `src/sim/cutSolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { solveCut, type CutOptions } from './cutSolver.js';
import { cucumber, cylinder, volumeOf } from './lathe.js';
import { v3 } from './vec3.js';

const R = 0.02;
const L = 0.1;
const OPTS: CutOptions = { minAxisDot: 0.26, radialSegments: 64, profileSegments: 24 };

describe('solveCut on a cylinder', () => {
  const stock = cylinder({ originalLengthM: L, radiusM: R });

  it('finds the axial position of a square cut', () => {
    const out = solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.05, 0) }, OPTS);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.cut.axialPositionM).toBeCloseTo(0.05, 12);
    expect(out.cut.angleDeviationDeg).toBeCloseTo(0, 9);
    expect(out.cut.wedgeMm).toBeCloseTo(0, 9);
  });

  it('gives the slice exactly pi r^2 h for a square cut', () => {
    const out = solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.05, 0) }, OPTS);
    if (!out.ok) throw new Error('expected a cut');
    expect(out.cut.sliceVolumeM3).toBeCloseTo(Math.PI * R * R * 0.05, 10);
  });

  it('reports wedge = 2 r tan(angle) for a 20 degree cut', () => {
    const rad = (20 * Math.PI) / 180;
    const normal = v3(Math.sin(rad), Math.cos(rad), 0);
    const out = solveCut(stock, { normal, point: v3(0, 0.05, 0) }, OPTS);
    if (!out.ok) throw new Error('expected a cut');
    expect(out.cut.angleDeviationDeg).toBeCloseTo(20, 9);
    expect(out.cut.wedgeMm).toBeCloseTo(2 * R * Math.tan(rad) * 1000, 6);
  });

  it('conserves volume: slice + stub equals the original', () => {
    const rad = (15 * Math.PI) / 180;
    const normal = v3(Math.sin(rad), Math.cos(rad), 0);
    const out = solveCut(stock, { normal, point: v3(0, 0.04, 0) }, OPTS);
    if (!out.ok) throw new Error('expected a cut');
    const stubVolume = volumeOf(out.cut.stub, OPTS.radialSegments, OPTS.profileSegments);
    const original = volumeOf(stock, OPTS.radialSegments, OPTS.profileSegments);
    expect(out.cut.sliceVolumeM3 + stubVolume).toBeCloseTo(original, 9);
  });

  it('rejects a plane nearly parallel to the food axis as a lengthwise fillet', () => {
    const out = solveCut(stock, { normal: v3(1, 0, 0), point: v3(0, 0.05, 0) }, OPTS);
    expect(out).toEqual({ ok: false, reason: 'lengthwise' });
  });

  it('rejects a plane that misses the solid entirely', () => {
    const out = solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.5, 0) }, OPTS);
    expect(out).toEqual({ ok: false, reason: 'miss' });
  });

  it('hands the stub back with the slanted cap so the next cut sees the real shape', () => {
    const rad = (20 * Math.PI) / 180;
    const normal = v3(Math.sin(rad), Math.cos(rad), 0);
    const out = solveCut(stock, { normal, point: v3(0, 0.05, 0) }, OPTS);
    if (!out.ok) throw new Error('expected a cut');
    expect(out.cut.stub.lowerCapRing).not.toBeNull();
    expect(out.cut.stub.lowerCapRing).toHaveLength(OPTS.radialSegments);
    expect(out.cut.stub.toM).toBeCloseTo(L, 12);
  });
});

describe('solveCut on a cucumber', () => {
  it('conserves volume through two successive cuts', () => {
    const stock = cucumber({ originalLengthM: 0.18, radiusM: 0.021 });
    const original = volumeOf(stock, OPTS.radialSegments, OPTS.profileSegments);

    const first = solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.02, 0) }, OPTS);
    if (!first.ok) throw new Error('expected a first cut');

    const rad = (10 * Math.PI) / 180;
    const second = solveCut(
      first.cut.stub,
      { normal: v3(Math.sin(rad), Math.cos(rad), 0), point: v3(0, 0.035, 0) },
      OPTS,
    );
    if (!second.ok) throw new Error('expected a second cut');

    const remaining = volumeOf(second.cut.stub, OPTS.radialSegments, OPTS.profileSegments);
    const total = first.cut.sliceVolumeM3 + second.cut.sliceVolumeM3 + remaining;
    expect(total).toBeCloseTo(original, 9);
  });

  it('never returns a non-finite number for any field', () => {
    const stock = cucumber({ originalLengthM: 0.18, radiusM: 0.021 });
    for (let i = 0; i < 300; i++) {
      const nx = (Math.random() - 0.5) * 2;
      const ny = (Math.random() - 0.5) * 2;
      const nz = (Math.random() - 0.5) * 2;
      const l = Math.hypot(nx, ny, nz) || 1;
      const out = solveCut(
        stock,
        { normal: v3(nx / l, ny / l, nz / l), point: v3(0, Math.random() * 0.18, 0) },
        OPTS,
      );
      if (!out.ok) continue;
      expect(Number.isFinite(out.cut.axialPositionM)).toBe(true);
      expect(Number.isFinite(out.cut.sliceVolumeM3)).toBe(true);
      expect(Number.isFinite(out.cut.wedgeMm)).toBe(true);
      expect(Number.isFinite(out.cut.angleDeviationDeg)).toBe(true);
      expect(out.cut.sliceVolumeM3).toBeGreaterThanOrEqual(0);
      for (const y of out.cut.capRing) expect(Number.isFinite(y)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/cutSolver.test.ts`
Expected: FAIL — `Failed to resolve import "./cutSolver.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/cutSolver.ts`:

```ts
import type { Plane } from './cutPlane.js';
import { type LatheSpec, lowerBoundM, radiusAt, volumeOf } from './lathe.js';
import { dot } from './vec3.js';

export type RejectReason =
  | 'no-sweep' | 'draw-stroke' | 'non-planar' | 'lengthwise' | 'miss';

export interface CutGeometry {
  /** Axial position where the plane crosses the food axis. */
  readonly axialPositionM: number;
  /** Axial position of the cut surface at each radial segment. */
  readonly capRing: readonly number[];
  /** What remains, carrying the slanted cap so the next cut sees the true shape. */
  readonly stub: LatheSpec;
  /** What came off. */
  readonly slice: LatheSpec;
  readonly sliceVolumeM3: number;
  /** 0 degrees is a square cut. */
  readonly angleDeviationDeg: number;
  /** Thickness spread across the cut face: 2 r tan(angle). */
  readonly wedgeMm: number;
}

export type CutOutcome =
  | { readonly ok: true; readonly cut: CutGeometry }
  | { readonly ok: false; readonly reason: RejectReason };

export interface CutOptions {
  readonly minAxisDot: number;
  readonly radialSegments: number;
  readonly profileSegments: number;
}

/** Weak implicit dependence of r on y; three passes converge well below any tolerance we use. */
const CAP_ITERATIONS = 3;

/**
 * Intersects a plane with a lathe solid.
 *
 * Operates in FOOD-LOCAL space: the axis is (0, 1, 0) and the origin is (0, 0, 0). The XR layer
 * transforms the world-space plane into this frame before calling.
 */
export function solveCut(spec: LatheSpec, plane: Plane, opts: CutOptions): CutOutcome {
  const { normal } = plane;

  // |normal . axis| is cos(angle from square). Near zero means the plane runs along the food:
  // a lengthwise fillet, for which "thickness" has no meaning.
  const axisDot = normal.y;
  if (Math.abs(axisDot) < opts.minAxisDot) return { ok: false, reason: 'lengthwise' };

  const nDotP = dot(normal, plane.point);
  const axialPositionM = nDotP / axisDot;

  const low = lowerBoundM(spec);
  if (!(axialPositionM > low) || !(axialPositionM < spec.toM)) {
    return { ok: false, reason: 'miss' };
  }

  // y(theta) = (n.p - r(y) * (nx cos + nz sin)) / ny
  const capRing: number[] = new Array<number>(opts.radialSegments);
  for (let j = 0; j < opts.radialSegments; j++) {
    const theta = (j / opts.radialSegments) * Math.PI * 2;
    const radial = normal.x * Math.cos(theta) + normal.z * Math.sin(theta);
    let y = axialPositionM;
    for (let k = 0; k < CAP_ITERATIONS; k++) {
      y = (nDotP - radiusAt(spec, y) * radial) / axisDot;
    }
    capRing[j] = y;
  }

  const slice: LatheSpec = {
    ...spec,
    toM: axialPositionM,
    upperCapRing: capRing,
  };
  const stub: LatheSpec = {
    ...spec,
    fromM: axialPositionM,
    lowerCapRing: capRing,
  };

  const sliceVolumeM3 = Math.max(0, volumeOf(slice, opts.radialSegments, opts.profileSegments));

  const angleDeviationDeg =
    (Math.acos(Math.min(1, Math.max(0, Math.abs(axisDot)))) * 180) / Math.PI;

  let minY = capRing[0]!;
  let maxY = capRing[0]!;
  for (const y of capRing) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return {
    ok: true,
    cut: {
      axialPositionM,
      capRing,
      stub,
      slice,
      sliceVolumeM3,
      angleDeviationDeg,
      wedgeMm: (maxY - minY) * 1000,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/cutSolver.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/cutSolver.ts src/sim/cutSolver.test.ts
git commit -m "feat(sim): analytic plane-lathe cut solver with exact slanted cap"
```

---

## Task 7: Cut metrics

**Files:**
- Create: `src/sim/metrics.ts`
- Test: `src/sim/metrics.test.ts`

Two definitions here matter, and both are corrections to the master spec recorded in
`DECISIONS.md` entries 3 and 4.

**Thickness is two numbers.** `axialDeltaMm` is what §7.3's camera method can measure.
`thicknessMm` is the perpendicular distance between the disc's faces, which is the true
thickness, and equals `axialDeltaMm × cos(angle)`.

**Position error is cumulative drift.** Measured against the ideal grid from the first cut, not
against the previous cut. Measured against the previous cut it would be an algebraic restatement
of `|thickness − target|` and carry no new information.

- [ ] **Step 1: Write the failing test**

Create `src/sim/metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { solveCut, type CutOptions } from './cutSolver.js';
import { cylinder, type LatheSpec } from './lathe.js';
import { emptySession, recordCut } from './metrics.js';
import { v3 } from './vec3.js';

const OPTS: CutOptions = { minAxisDot: 0.26, radialSegments: 64, profileSegments: 24 };
const TARGET_MM = 5;

function cutAt(spec: LatheSpec, y: number, angleDeg = 0) {
  const rad = (angleDeg * Math.PI) / 180;
  const out = solveCut(spec, { normal: v3(Math.sin(rad), Math.cos(rad), 0), point: v3(0, y, 0) }, OPTS);
  if (!out.ok) throw new Error(`expected a cut at ${y}`);
  return out.cut;
}

describe('recordCut', () => {
  it('reports axial delta equal to the stub length lost', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    const cut = cutAt(stock, 0.005);
    const { record } = recordCut(emptySession(), cut, stock, TARGET_MM);
    expect(record.axialDeltaMm).toBeCloseTo(5, 9);
  });

  it('reports perpendicular thickness shorter than axial delta for an angled cut', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    const cut = cutAt(stock, 0.005, 20);
    const { record } = recordCut(emptySession(), cut, stock, TARGET_MM);
    expect(record.axialDeltaMm).toBeCloseTo(5, 9);
    expect(record.thicknessMm).toBeCloseTo(5 * Math.cos((20 * Math.PI) / 180), 9);
    expect(record.thicknessMm).toBeLessThan(record.axialDeltaMm);
  });

  it('makes the two thicknesses identical for a square cut', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    const cut = cutAt(stock, 0.005);
    const { record } = recordCut(emptySession(), cut, stock, TARGET_MM);
    expect(record.thicknessMm).toBeCloseTo(record.axialDeltaMm, 9);
  });

  it('gives the first cut zero position error by definition', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    const cut = cutAt(stock, 0.008);
    const { record } = recordCut(emptySession(), cut, stock, TARGET_MM);
    expect(record.positionErrorMm).toBeCloseTo(0, 12);
  });

  it('accumulates drift even when every individual cut is near target', () => {
    // Six cuts of 5.4mm against a 5mm target: each is only 0.4mm off, but by the sixth
    // the blade is 2mm further down the cucumber than the ideal grid.
    let spec = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    let session = emptySession();
    let last = { axialDeltaMm: 0, positionErrorMm: 0 };

    for (let i = 1; i <= 6; i++) {
      const cut = cutAt(spec, i * 0.0054);
      const next = recordCut(session, cut, spec, TARGET_MM);
      session = next.session;
      last = next.record;
      spec = cut.stub;
    }

    expect(last.axialDeltaMm).toBeCloseTo(5.4, 6);
    expect(last.positionErrorMm).toBeCloseTo(2.0, 6);
  });

  it('keeps every record in the session in order', () => {
    let spec = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    let session = emptySession();
    for (let i = 1; i <= 3; i++) {
      const cut = cutAt(spec, i * 0.005);
      session = recordCut(session, cut, spec, TARGET_MM).session;
      spec = cut.stub;
    }
    expect(session.records).toHaveLength(3);
    expect(session.records[0]!.index).toBe(0);
    expect(session.records[2]!.index).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/metrics.test.ts`
Expected: FAIL — `Failed to resolve import "./metrics.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/metrics.ts`:

```ts
import type { CutGeometry } from './cutSolver.js';
import { axialLengthM, type LatheSpec } from './lathe.js';

export interface CutRecord {
  readonly index: number;
  readonly axialPositionM: number;
  /** The drop in stub length. What §7.3's camera method can measure. */
  readonly axialDeltaMm: number;
  /** Perpendicular distance between the disc's faces. The true thickness; this is scored. */
  readonly thicknessMm: number;
  readonly angleDeviationDeg: number;
  readonly wedgeMm: number;
  /** Cumulative drift from the ideal grid, not per-cut error. */
  readonly positionErrorMm: number;
  readonly sliceVolumeM3: number;
  readonly stubLengthM: number;
}

export interface Session {
  readonly records: readonly CutRecord[];
  readonly firstCutPositionM: number | null;
}

export const emptySession = (): Session => ({ records: [], firstCutPositionM: null });

/**
 * Appends one cut to the session.
 *
 * `before` is the lathe spec as it stood prior to this cut, which is what makes the axial delta
 * a genuine stub-length difference rather than a restatement of the plane position.
 */
export function recordCut(
  session: Session,
  cut: CutGeometry,
  before: LatheSpec,
  targetThicknessMm: number,
): { session: Session; record: CutRecord } {
  const index = session.records.length;
  const firstCutPositionM = session.firstCutPositionM ?? cut.axialPositionM;

  const axialDeltaMm = (axialLengthM(before) - axialLengthM(cut.stub)) * 1000;

  // thickness = axialDelta * cos(angle). The camera cannot recover this factor.
  const thicknessMm = axialDeltaMm * Math.cos((cut.angleDeviationDeg * Math.PI) / 180);

  const expectedAxialPositionM = firstCutPositionM + index * (targetThicknessMm / 1000);
  const positionErrorMm = Math.abs(cut.axialPositionM - expectedAxialPositionM) * 1000;

  const record: CutRecord = {
    index,
    axialPositionM: cut.axialPositionM,
    axialDeltaMm,
    thicknessMm,
    angleDeviationDeg: cut.angleDeviationDeg,
    wedgeMm: cut.wedgeMm,
    positionErrorMm,
    sliceVolumeM3: cut.sliceVolumeM3,
    stubLengthM: axialLengthM(cut.stub),
  };

  return {
    session: { records: [...session.records, record], firstCutPositionM },
    record,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/metrics.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/metrics.ts src/sim/metrics.test.ts
git commit -m "feat(sim): cut metrics with axial/perpendicular split and cumulative drift"
```

---

## Task 8: Scoring

**Files:**
- Create: `src/sim/scoring.ts`
- Test: `src/sim/scoring.test.ts`

Master spec §7.4 verbatim, with `angleScore` filled in per `DECISIONS.md` entry 2. Sigma is the
population standard deviation (divide by n), because these are all the cuts that happened, not a
sample drawn from a larger set.

The display format is fixed by §7.4 and matters: a judge parses `4.2mm average, ±1.8mm` in one
second. `Score: 72/100` tells them nothing.

- [ ] **Step 1: Write the failing test**

Create `src/sim/scoring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CutRecord } from './metrics.js';
import { formatScore, scoreSession, type ScoringOptions } from './scoring.js';

const OPTS: ScoringOptions = {
  targetThicknessMm: 3,
  toleranceMm: 0.5,
  targetSigmaMm: 0.5,
  angleToleranceDeg: 5,
};

function record(thicknessMm: number, angleDeviationDeg = 0): CutRecord {
  return {
    index: 0, axialPositionM: 0, axialDeltaMm: thicknessMm, thicknessMm,
    angleDeviationDeg, wedgeMm: 0, positionErrorMm: 0,
    sliceVolumeM3: 0, stubLengthM: 0,
  };
}

describe('scoreSession', () => {
  it('scores a perfect session at 1', () => {
    const s = scoreSession([record(3), record(3), record(3)], OPTS);
    expect(s.meanMm).toBeCloseTo(3, 12);
    expect(s.sigmaMm).toBeCloseTo(0, 12);
    expect(s.accuracy).toBeCloseTo(1, 12);
    expect(s.uniformity).toBeCloseTo(1, 12);
    expect(s.angleScore).toBeCloseTo(1, 12);
    expect(s.total).toBeCloseTo(1, 12);
  });

  it('uses the population standard deviation', () => {
    const s = scoreSession([record(2), record(4)], OPTS);
    expect(s.meanMm).toBeCloseTo(3, 12);
    expect(s.sigmaMm).toBeCloseTo(1, 12);
  });

  it('applies exponential falloff on mean error', () => {
    const s = scoreSession([record(3.5)], OPTS);
    expect(s.accuracy).toBeCloseTo(Math.exp(-0.5 / 0.5), 12);
  });

  it('penalises angle deviation', () => {
    const s = scoreSession([record(3, 10)], OPTS);
    expect(s.angleScore).toBeCloseTo(Math.exp(-10 / 5), 12);
  });

  it('weights the three terms 0.5 / 0.35 / 0.15', () => {
    const s = scoreSession([record(3.5, 10)], OPTS);
    const expected = 0.5 * s.accuracy + 0.35 * s.uniformity + 0.15 * s.angleScore;
    expect(s.total).toBeCloseTo(expected, 12);
  });

  it('returns a zeroed score for an empty session rather than NaN', () => {
    const s = scoreSession([], OPTS);
    expect(s.total).toBe(0);
    expect(Number.isFinite(s.meanMm)).toBe(true);
    expect(Number.isFinite(s.sigmaMm)).toBe(true);
  });
});

describe('formatScore', () => {
  it('renders plain millimetres, not a 0-100 score', () => {
    const s = scoreSession([record(4.0), record(4.4)], OPTS);
    expect(formatScore(s, OPTS)).toBe('4.2mm average, ±0.2mm. Target 3mm, ±0.5mm.');
  });

  it('says so when there is nothing to report', () => {
    expect(formatScore(scoreSession([], OPTS), OPTS)).toBe('No cuts yet.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/scoring.test.ts`
Expected: FAIL — `Failed to resolve import "./scoring.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/scoring.ts`:

```ts
import type { CutRecord } from './metrics.js';

export interface ScoringOptions {
  readonly targetThicknessMm: number;
  readonly toleranceMm: number;
  readonly targetSigmaMm: number;
  readonly angleToleranceDeg: number;
}

export interface Score {
  readonly meanMm: number;
  readonly sigmaMm: number;
  readonly meanAngleDeg: number;
  readonly accuracy: number;
  readonly uniformity: number;
  readonly angleScore: number;
  readonly total: number;
  readonly count: number;
}

const ZERO: Score = {
  meanMm: 0, sigmaMm: 0, meanAngleDeg: 0,
  accuracy: 0, uniformity: 0, angleScore: 0, total: 0, count: 0,
};

/**
 * Master spec §7.4. `angleScore` is not defined there; DECISIONS.md entry 2 fills it as an
 * exponential falloff to match the shape of the two terms beside it.
 *
 * Scores the PERPENDICULAR thickness, which is the true one. See DECISIONS.md entry 4.
 */
export function scoreSession(records: readonly CutRecord[], opts: ScoringOptions): Score {
  const n = records.length;
  if (n === 0) return ZERO;

  const meanMm = records.reduce((a, r) => a + r.thicknessMm, 0) / n;
  const variance = records.reduce((a, r) => a + (r.thicknessMm - meanMm) ** 2, 0) / n;
  const sigmaMm = Math.sqrt(variance);
  const meanAngleDeg = records.reduce((a, r) => a + r.angleDeviationDeg, 0) / n;

  const accuracy = Math.exp(-Math.abs(meanMm - opts.targetThicknessMm) / opts.toleranceMm);
  const uniformity = Math.exp(-sigmaMm / opts.targetSigmaMm);
  const angleScore = Math.exp(-meanAngleDeg / opts.angleToleranceDeg);

  return {
    meanMm, sigmaMm, meanAngleDeg, accuracy, uniformity, angleScore,
    total: 0.5 * accuracy + 0.35 * uniformity + 0.15 * angleScore,
    count: n,
  };
}

const trim = (x: number, places: number): string =>
  Number.parseFloat(x.toFixed(places)).toString();

/**
 * Master spec §7.4: "Display plain numbers. A judge parses that in one second.
 * 'Score: 72/100' tells them nothing."
 */
export function formatScore(score: Score, opts: ScoringOptions): string {
  if (score.count === 0) return 'No cuts yet.';
  return (
    `${score.meanMm.toFixed(1)}mm average, ±${score.sigmaMm.toFixed(1)}mm. ` +
    `Target ${trim(opts.targetThicknessMm, 1)}mm, ±${trim(opts.toleranceMm, 1)}mm.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/scoring.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/scoring.ts src/sim/scoring.test.ts
git commit -m "feat(sim): session scoring with plain-millimetre rendering"
```

---

## Task 9: Feedback descriptor

**Files:**
- Create: `src/sim/feedback.ts`
- Test: `src/sim/feedback.test.ts`

One descriptor drives both audio and haptics, so the two channels cannot be tuned apart. This is
what makes Blind Service reachable later: the mode is mostly a passthrough dimmer over feedback
that already carries the game.

- [ ] **Step 1: Write the failing test**

Create `src/sim/feedback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { feedbackForCut, feedbackForRejection, type FeedbackOptions } from './feedback.js';
import type { CutRecord } from './metrics.js';

const OPTS: FeedbackOptions = { targetThicknessMm: 3, toleranceMm: 0.5, maxRadiusM: 0.021 };

function record(thicknessMm: number): CutRecord {
  return {
    index: 0, axialPositionM: 0, axialDeltaMm: thicknessMm, thicknessMm,
    angleDeviationDeg: 0, wedgeMm: 0, positionErrorMm: 0,
    sliceVolumeM3: 0, stubLengthM: 0,
  };
}

describe('feedbackForCut', () => {
  it('reaches full intensity at the widest cross-section', () => {
    const f = feedbackForCut(record(3), 0.021, OPTS);
    expect(f.intensity).toBeCloseTo(1, 12);
    expect(f.kind).toBe('clean');
  });

  it('scales intensity with cross-sectional area, not radius', () => {
    // Half the radius is a quarter of the area.
    const f = feedbackForCut(record(3), 0.0105, OPTS);
    expect(f.intensity).toBeCloseTo(0.25, 12);
  });

  it('gives a perfect cut full accuracy', () => {
    expect(feedbackForCut(record(3), 0.021, OPTS).accuracy).toBeCloseTo(1, 12);
  });

  it('falls off exponentially as thickness misses target', () => {
    const f = feedbackForCut(record(3.5), 0.021, OPTS);
    expect(f.accuracy).toBeCloseTo(Math.exp(-1), 12);
  });

  it('clamps intensity to 0..1 for an oversized radius', () => {
    const f = feedbackForCut(record(3), 0.5, OPTS);
    expect(f.intensity).toBe(1);
  });
});

describe('feedbackForRejection', () => {
  it('marks a draw stroke as rejected with low intensity', () => {
    const f = feedbackForRejection('draw-stroke');
    expect(f.kind).toBe('rejected');
    expect(f.intensity).toBeGreaterThan(0);
    expect(f.intensity).toBeLessThan(0.5);
    expect(f.accuracy).toBe(0);
  });

  it('stays silent for a sweep that never touched the food', () => {
    expect(feedbackForRejection('miss').intensity).toBe(0);
    expect(feedbackForRejection('no-sweep').intensity).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/feedback.test.ts`
Expected: FAIL — `Failed to resolve import "./feedback.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/feedback.ts`:

```ts
import type { RejectReason } from './cutSolver.js';
import type { CutRecord } from './metrics.js';

export interface CutFeedback {
  /** 0..1, from cross-sectional area at the cut. Drives haptic strength and audio amplitude. */
  readonly intensity: number;
  /** 0..1, how close to target thickness. Drives audio pitch. */
  readonly accuracy: number;
  readonly kind: 'clean' | 'rejected';
}

export interface FeedbackOptions {
  readonly targetThicknessMm: number;
  readonly toleranceMm: number;
  /** Cross-section at this radius reads as full intensity. */
  readonly maxRadiusM: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * One descriptor, two channels. Master spec §7.2 scales haptics by cross-sectional area;
 * §12 maps chop pitch to accuracy. Deriving both from the same value means they cannot be
 * tuned apart.
 */
export function feedbackForCut(
  record: CutRecord, radiusAtCutM: number, opts: FeedbackOptions,
): CutFeedback {
  const areaRatio = opts.maxRadiusM > 0 ? (radiusAtCutM / opts.maxRadiusM) ** 2 : 0;
  const accuracy = Math.exp(
    -Math.abs(record.thicknessMm - opts.targetThicknessMm) / opts.toleranceMm,
  );
  return { intensity: clamp01(areaRatio), accuracy: clamp01(accuracy), kind: 'clean' };
}

/**
 * Rejections are audible too, so §4's typed reasons reach the player without a text box.
 * A draw stroke scrapes; a sweep that never touched anything stays silent.
 */
export function feedbackForRejection(reason: RejectReason): CutFeedback {
  const intensity = reason === 'draw-stroke' || reason === 'non-planar' ? 0.25 : 0;
  return { intensity, accuracy: 0, kind: 'rejected' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/feedback.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/feedback.ts src/sim/feedback.test.ts
git commit -m "feat(sim): unified feedback descriptor for audio and haptics"
```

---

## Task 10: Hand safety

**Files:**
- Create: `src/sim/handSafety.ts`
- Test: `src/sim/handSafety.test.ts`

Joints are addressed **by name**. Master spec §7.5 uses indices `(5,6,7,8)` and calls them
MCP/PIP/DIP/TIP, but in the WebXR hand model those are `metacarpal, phalanx-proximal,
phalanx-intermediate, phalanx-distal` — index 5 sits inside the palm and the fingertip (9) is
omitted. See `DECISIONS.md` entry 3.

```
extensionRatio = |tip − phalanx-proximal| / |phalanx-intermediate − phalanx-proximal|
```

Extended ≈ 1.87, curled ≈ 0.88, so the spec's threshold of 1.3 discriminates cleanly and is kept.

The debouncer **escalates instantly and de-escalates slowly.** A safety warning that waits four
frames to appear is a safety warning that arrives after the injury; one that vanishes the
instant a joint flickers is a strobing ring nobody trusts.

- [ ] **Step 1: Write the failing test**

Create `src/sim/handSafety.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  classifySafety, extensionRatio, isClaw, minFingertipDistanceM,
  SafetyDebouncer, type HandPose, type SafetyOptions,
} from './handSafety.js';
import { v3, type Vec3 } from './vec3.js';

const OPTS: SafetyOptions = { clawThreshold: 1.3, dangerM: 0.02, warnM: 0.045 };

/**
 * Builds one finger along +Z. `curl` 0 is straight, 1 folds the tip back toward the knuckle.
 * Proximal phalanx 40mm, remainder 35mm, matching adult index-finger proportions.
 */
function finger(name: string, curl: number, x: number): Array<[string, Vec3]> {
  const proximal = v3(x, 0, 0);
  const intermediate = v3(x, 0, 0.04);
  const reach = 0.035 * (1 - 2 * curl);
  const tip = v3(x, 0, 0.04 + reach);
  return [
    [`${name}-finger-phalanx-proximal`, proximal],
    [`${name}-finger-phalanx-intermediate`, intermediate],
    [`${name}-finger-tip`, tip],
  ];
}

function hand(curl: number): HandPose {
  return {
    joints: new Map([
      ...finger('index', curl, 0),
      ...finger('middle', curl, 0.02),
      ...finger('ring', curl, 0.04),
      ['thumb-tip', v3(-0.02, 0, 0.02)],
      // Fixed proximity probe, not part of the curl. Kept clear of the 0.045 warn boundary so
      // the classification tests do not hinge on a floating-point equality.
      ['pinky-finger-tip', v3(0.06, 0, 0.045)],
    ]),
  };
}

const FAR_BLADE = { heel: v3(-0.5, 0.5, 0), tip: v3(0.5, 0.5, 0) };
const NEAR_BLADE = { heel: v3(-0.5, 0, 0.085), tip: v3(0.5, 0, 0.085) };

describe('extensionRatio', () => {
  it('reads well above 1.3 for an extended finger', () => {
    const r = extensionRatio(hand(0), 'index');
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.075 / 0.04, 9);
    expect(r!).toBeGreaterThan(1.3);
  });

  it('reads well below 1.3 for a curled finger', () => {
    const r = extensionRatio(hand(1), 'index');
    expect(r!).toBeCloseTo(0.005 / 0.04, 9);
    expect(r!).toBeLessThan(1.3);
  });

  it('returns null when a joint is missing rather than guessing', () => {
    const pose: HandPose = { joints: new Map([['index-finger-tip', v3(0, 0, 0)]]) };
    expect(extensionRatio(pose, 'index')).toBeNull();
  });
});

describe('isClaw', () => {
  it('is true when every tracked finger is curled', () => {
    expect(isClaw(hand(1), OPTS.clawThreshold)).toBe(true);
  });

  it('is false when the fingers are extended', () => {
    expect(isClaw(hand(0), OPTS.clawThreshold)).toBe(false);
  });

  it('is false when the pose cannot be read at all, failing safe', () => {
    expect(isClaw({ joints: new Map() }, OPTS.clawThreshold)).toBe(false);
  });
});

describe('minFingertipDistanceM', () => {
  it('measures the closest of all five fingertips to the blade segment', () => {
    const d = minFingertipDistanceM(hand(0), NEAR_BLADE);
    expect(d).toBeCloseTo(0.01, 9);
  });

  it('returns Infinity when no fingertip is tracked', () => {
    expect(minFingertipDistanceM({ joints: new Map() }, NEAR_BLADE)).toBe(Infinity);
  });
});

describe('classifySafety', () => {
  it('is safe with a claw grip and the blade far away', () => {
    expect(classifySafety(hand(1), FAR_BLADE, OPTS)).toBe('safe');
  });

  it('warns on a claw grip with the blade close', () => {
    expect(classifySafety(hand(1), NEAR_BLADE, OPTS)).toBe('warn');
  });

  it('warns on exposed fingertips even when the blade is far', () => {
    expect(classifySafety(hand(0), FAR_BLADE, OPTS)).toBe('warn');
  });

  it('is dangerous with exposed fingertips and the blade close', () => {
    expect(classifySafety(hand(0), NEAR_BLADE, OPTS)).toBe('danger');
  });
});

describe('SafetyDebouncer', () => {
  it('escalates immediately', () => {
    const d = new SafetyDebouncer(4);
    expect(d.push('safe')).toBe('safe');
    expect(d.push('danger')).toBe('danger');
  });

  it('holds the higher level until the quieter one persists', () => {
    const d = new SafetyDebouncer(3);
    d.push('danger');
    expect(d.push('safe')).toBe('danger');
    expect(d.push('safe')).toBe('danger');
    expect(d.push('safe')).toBe('safe');
  });

  it('restarts the countdown if danger reappears', () => {
    const d = new SafetyDebouncer(3);
    d.push('danger');
    d.push('safe');
    d.push('danger');
    expect(d.push('safe')).toBe('danger');
    expect(d.push('safe')).toBe('danger');
    expect(d.push('safe')).toBe('safe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/handSafety.test.ts`
Expected: FAIL — `Failed to resolve import "./handSafety.js"`

- [ ] **Step 3: Write the implementation**

Create `src/sim/handSafety.ts`:

```ts
import { distance, pointSegmentDistance, type Vec3 } from './vec3.js';

/** Joint positions keyed by WebXR joint name. */
export interface HandPose {
  readonly joints: ReadonlyMap<string, Vec3>;
}

export interface BladeSegmentLike {
  readonly heel: Vec3;
  readonly tip: Vec3;
}

export type SafetyLevel = 'safe' | 'warn' | 'danger';

export interface SafetyOptions {
  readonly clawThreshold: number;
  readonly dangerM: number;
  readonly warnM: number;
}

/** Master spec §7.5 tracks index, middle and ring. The thumb tucks behind them. */
export const TRACKED_FINGERS = ['index', 'middle', 'ring'] as const;
export type TrackedFinger = (typeof TRACKED_FINGERS)[number];

export const FINGERTIP_JOINTS = [
  'thumb-tip',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

const SAFETY_ORDER: Record<SafetyLevel, number> = { safe: 0, warn: 1, danger: 2 };

/**
 * |tip - proximal| / |intermediate - proximal|. Curled is near 0.9, extended near 1.9.
 *
 * Addressed by NAME, not index. Master spec §7.5's indices (5,6,7,8) are the metacarpal and
 * three phalanges in the WebXR hand model -- the metacarpal is inside the palm and the
 * fingertip is missing entirely. See DECISIONS.md entry 3.
 */
export function extensionRatio(pose: HandPose, finger: TrackedFinger): number | null {
  const proximal = pose.joints.get(`${finger}-finger-phalanx-proximal`);
  const intermediate = pose.joints.get(`${finger}-finger-phalanx-intermediate`);
  const tip = pose.joints.get(`${finger}-finger-tip`);
  if (!proximal || !intermediate || !tip) return null;

  const reference = distance(intermediate, proximal);
  if (!(reference > 0)) return null;
  return distance(tip, proximal) / reference;
}

/** Fails safe: an unreadable pose is not a claw. */
export function isClaw(pose: HandPose, threshold: number): boolean {
  return TRACKED_FINGERS.every((finger) => {
    const ratio = extensionRatio(pose, finger);
    return ratio !== null && ratio < threshold;
  });
}

export function minFingertipDistanceM(pose: HandPose, blade: BladeSegmentLike): number {
  let closest = Infinity;
  for (const name of FINGERTIP_JOINTS) {
    const joint = pose.joints.get(name);
    if (!joint) continue;
    closest = Math.min(closest, pointSegmentDistance(joint, blade.heel, blade.tip));
  }
  return closest;
}

export function classifySafety(
  pose: HandPose, blade: BladeSegmentLike, opts: SafetyOptions,
): SafetyLevel {
  const claw = isClaw(pose, opts.clawThreshold);
  const d = minFingertipDistanceM(pose, blade);

  if (!claw && d <= opts.dangerM) return 'danger';
  if (!claw || d <= opts.warnM) return 'warn';
  return 'safe';
}

/**
 * Escalates instantly, de-escalates only after the quieter level persists.
 *
 * A warning that waits four frames to appear arrives after the injury. A warning that vanishes
 * the instant a joint flickers is a strobing ring nobody trusts. Asymmetry is the point.
 */
export class SafetyDebouncer {
  #level: SafetyLevel = 'safe';
  #quieterStreak = 0;

  constructor(private readonly framesToRelax: number) {}

  get level(): SafetyLevel {
    return this.#level;
  }

  push(observed: SafetyLevel): SafetyLevel {
    if (SAFETY_ORDER[observed] >= SAFETY_ORDER[this.#level]) {
      this.#level = observed;
      this.#quieterStreak = 0;
      return this.#level;
    }

    this.#quieterStreak += 1;
    if (this.#quieterStreak >= this.framesToRelax) {
      this.#level = observed;
      this.#quieterStreak = 0;
    }
    return this.#level;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/handSafety.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sim/handSafety.ts src/sim/handSafety.test.ts
git commit -m "feat(sim): hand safety with named joints and asymmetric debounce"
```

---

## Task 11: Replay driver and conformance harness

**Files:**
- Create: `harness/runScript.ts`
- Create: `harness/fixtures/square-3mm.cuts.json`
- Create: `harness/conformance.test.ts`

This is what `npm run cuts` runs. The `.cuts.json` format is a recorded sequence of blade poses;
it is also the format Ghost Duel will replay later, so it is not throwaway.

Six groups, per §10 of the spec: analytic conformance, volume conservation, monotonicity,
degeneracy, NaN fuzz, and a scoring golden file.

- [ ] **Step 1: Write the replay driver**

Create `harness/runScript.ts`:

```ts
import { resolveSweepPlanes, type SweepSample } from '../src/sim/cutPlane.js';
import { solveCut, type CutOptions, type RejectReason } from '../src/sim/cutSolver.js';
import { cucumber, cylinder, type LatheSpec, radiusAt } from '../src/sim/lathe.js';
import { emptySession, recordCut, type Session } from '../src/sim/metrics.js';
import { scoreSession, type Score, type ScoringOptions } from '../src/sim/scoring.js';
import { v3, type Vec3 } from '../src/sim/vec3.js';

type Triple = readonly [number, number, number];

export interface CutScript {
  readonly name: string;
  readonly stock: {
    readonly profile: 'cucumber' | 'cylinder';
    readonly originalLengthM: number;
    readonly radiusM: number;
  };
  readonly targetThicknessMm: number;
  readonly sweeps: ReadonlyArray<{
    readonly previous: readonly [Triple, Triple];
    readonly current: readonly [Triple, Triple];
  }>;
}

export interface ScriptResult {
  readonly session: Session;
  readonly score: Score;
  readonly rejections: readonly RejectReason[];
  readonly finalStub: LatheSpec;
  readonly radiiAtCut: readonly number[];
}

export const PLANE_OPTS = {
  minSweepM: 0.004,
  minCrossSin: 0.17,
  maxPlanarityResidualM: 0.002,
} as const;

export const CUT_OPTS: CutOptions = {
  minAxisDot: 0.26,
  radialSegments: 64,
  profileSegments: 24,
};

export const SCORING_OPTS: ScoringOptions = {
  targetThicknessMm: 3,
  toleranceMm: 0.5,
  targetSigmaMm: 0.5,
  angleToleranceDeg: 5,
};

const toVec = (t: Triple): Vec3 => v3(t[0], t[1], t[2]);

const toSweep = (s: CutScript['sweeps'][number]): SweepSample => ({
  previous: { heel: toVec(s.previous[0]), tip: toVec(s.previous[1]) },
  current: { heel: toVec(s.current[0]), tip: toVec(s.current[1]) },
});

/**
 * Drives recorded blade poses through the real solver -- the same code path the game runs.
 * A non-planar sweep is subdivided and each sub-sweep solved independently, exactly as the
 * live BladeSystem will do.
 */
export function runCutScript(
  script: CutScript,
  opts: { maxSubdivisions?: number } = {},
): ScriptResult {
  const maxSubdivisions = opts.maxSubdivisions ?? 8;

  let stub: LatheSpec =
    script.stock.profile === 'cucumber'
      ? cucumber({ originalLengthM: script.stock.originalLengthM, radiusM: script.stock.radiusM })
      : cylinder({ originalLengthM: script.stock.originalLengthM, radiusM: script.stock.radiusM });

  let session = emptySession();
  const rejections: RejectReason[] = [];
  const radiiAtCut: number[] = [];

  for (const raw of script.sweeps) {
    // resolveSweepPlanes owns the subdivision policy, including scaling the minimum-sweep
    // gate by the subdivision count. Hand-rolling fit -> subdivide -> refit here would
    // re-introduce the bug that policy exists to prevent: each part of a genuine sweep is
    // 1/n as long, so the full threshold rejects every one of them as 'no-sweep'.
    const resolved = resolveSweepPlanes(toSweep(raw), { ...PLANE_OPTS, maxSubdivisions });
    if (!resolved.ok) {
      rejections.push(resolved.reason);
      continue;
    }

    for (const plane of resolved.planes) {
      const outcome = solveCut(stub, plane, CUT_OPTS);
      if (!outcome.ok) {
        rejections.push(outcome.reason);
        continue;
      }
      radiiAtCut.push(radiusAt(stub, outcome.cut.axialPositionM));
      session = recordCut(session, outcome.cut, stub, script.targetThicknessMm).session;
      stub = outcome.cut.stub;
    }
  }

  return {
    session,
    score: scoreSession(session.records, {
      ...SCORING_OPTS,
      targetThicknessMm: script.targetThicknessMm,
    }),
    rejections,
    finalStub: stub,
    radiiAtCut,
  };
}

/**
 * A clean square cut at a given axial position, in FOOD-LOCAL space.
 *
 * The lathe axis is Y, so a crosswise cut needs a plane normal along Y — which means the blade
 * lies along X and sweeps along Z, at constant Y. Sweeping the blade *downward* in Y instead
 * produces a quad in the XY plane whose normal is along Z: a plane running parallel to the
 * cucumber's length, which `solveCut` correctly rejects as 'lengthwise'.
 *
 * The XR layer is what rotates a real downward chop into this frame.
 */
export function cutAt(axialM: number, sweepM = 0.03): CutScript['sweeps'][number] {
  return {
    previous: [[-0.06, axialM, -sweepM], [0.06, axialM, -sweepM]],
    current: [[-0.06, axialM, sweepM], [0.06, axialM, sweepM]],
  };
}
```

- [ ] **Step 2: Create the golden fixture**

Create `harness/fixtures/square-3mm.cuts.json`:

```json
{
  "name": "square-3mm",
  "stock": { "profile": "cylinder", "originalLengthM": 0.1, "radiusM": 0.02 },
  "targetThicknessMm": 3,
  "sweeps": [
    { "previous": [[-0.06, 0.003, -0.03], [0.06, 0.003, -0.03]], "current": [[-0.06, 0.003, 0.03], [0.06, 0.003, 0.03]] },
    { "previous": [[-0.06, 0.0065, -0.03], [0.06, 0.0065, -0.03]], "current": [[-0.06, 0.0065, 0.03], [0.06, 0.0065, 0.03]] },
    { "previous": [[-0.06, 0.0092, -0.03], [0.06, 0.0092, -0.03]], "current": [[-0.06, 0.0092, 0.03], [0.06, 0.0092, 0.03]] },
    { "previous": [[-0.06, 0.0125, -0.03], [0.06, 0.0125, -0.03]], "current": [[-0.06, 0.0125, 0.03], [0.06, 0.0125, 0.03]] }
  ]
}
```

Blade along X, sweeping along Z, at constant Y — so the plane normal lands on the lathe axis.
The cut positions are 3.0, 6.5, 9.2 and 12.5mm, giving slice thicknesses of 3.0, 3.5, 2.7 and
3.3mm: four cuts near a 3mm target, deliberately imperfect so the score is not a trivial 1.0.

Hand-derived expectations, which the test asserts:

```
mean     = (3.0 + 3.5 + 2.7 + 3.3) / 4 = 3.125 mm
variance = (0.125² + 0.375² + 0.425² + 0.175²) / 4 = 0.091875
sigma    = √0.091875 = 0.303109 mm      (population, divide by n)
```

- [ ] **Step 3: Write the conformance suite**

Create `harness/conformance.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fitSweepPlane } from '../src/sim/cutPlane.js';
import { solveCut } from '../src/sim/cutSolver.js';
import { cucumber, cylinder, volumeOf } from '../src/sim/lathe.js';
import { formatScore } from '../src/sim/scoring.js';
import { v3 } from '../src/sim/vec3.js';
import {
  CUT_OPTS, cutAt, PLANE_OPTS, runCutScript, type CutScript,
} from './runScript.js';

// Read from disk rather than importing, which exercises the same load path Ghost Duel will use
// and avoids depending on JSON import attributes.
const script = JSON.parse(
  readFileSync(new URL('./fixtures/square-3mm.cuts.json', import.meta.url), 'utf8'),
) as CutScript;

describe('1. analytic conformance', () => {
  it('matches the closed form for a square cut on a cylinder', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    const out = solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.03, 0) }, CUT_OPTS);
    if (!out.ok) throw new Error('expected a cut');
    expect(out.cut.axialPositionM).toBeCloseTo(0.03, 12);
    expect(out.cut.angleDeviationDeg).toBeCloseTo(0, 9);
    expect(out.cut.wedgeMm).toBeCloseTo(0, 9);
    expect(out.cut.sliceVolumeM3).toBeCloseTo(Math.PI * 0.02 ** 2 * 0.03, 10);
  });

  it('matches 2 r tan(angle) across a sweep of cut angles', () => {
    const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });
    for (const deg of [5, 10, 20, 35, 50]) {
      const rad = (deg * Math.PI) / 180;
      const out = solveCut(
        stock, { normal: v3(Math.sin(rad), Math.cos(rad), 0), point: v3(0, 0.05, 0) }, CUT_OPTS,
      );
      if (!out.ok) throw new Error(`expected a cut at ${deg} degrees`);
      expect(out.cut.angleDeviationDeg).toBeCloseTo(deg, 9);
      expect(out.cut.wedgeMm).toBeCloseTo(2 * 0.02 * Math.tan(rad) * 1000, 6);
    }
  });
});

describe('2. volume conservation', () => {
  it('conserves volume across a full cucumber script to better than 0.1%', () => {
    const stock = cucumber({ originalLengthM: 0.18, radiusM: 0.021 });
    const original = volumeOf(stock, CUT_OPTS.radialSegments, CUT_OPTS.profileSegments);

    const result = runCutScript({
      name: 'conservation',
      stock: { profile: 'cucumber', originalLengthM: 0.18, radiusM: 0.021 },
      targetThicknessMm: 4,
      sweeps: [0.004, 0.009, 0.013, 0.018, 0.022, 0.027].map((y) => cutAt(y)),
    });

    expect(result.session.records).toHaveLength(6);
    const sliced = result.session.records.reduce((a, r) => a + r.sliceVolumeM3, 0);
    const remaining = volumeOf(result.finalStub, CUT_OPTS.radialSegments, CUT_OPTS.profileSegments);
    expect(Math.abs(sliced + remaining - original) / original).toBeLessThan(0.001);
  });
});

describe('3. monotonicity', () => {
  it('shortens the stub strictly and never below zero', () => {
    const result = runCutScript({
      name: 'monotonic',
      stock: { profile: 'cucumber', originalLengthM: 0.18, radiusM: 0.021 },
      targetThicknessMm: 4,
      sweeps: [0.004, 0.009, 0.013, 0.018, 0.022].map((y) => cutAt(y)),
    });

    const lengths = result.session.records.map((r) => r.stubLengthM);
    expect(lengths.length).toBeGreaterThan(1);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]!).toBeLessThan(lengths[i - 1]!);
    }
    for (const l of lengths) expect(l).toBeGreaterThanOrEqual(0);
    for (const r of result.session.records) expect(r.thicknessMm).toBeGreaterThan(0);
  });
});

describe('4. degeneracy', () => {
  const stock = cylinder({ originalLengthM: 0.1, radiusM: 0.02 });

  it('rejects a stationary blade as no-sweep', () => {
    const fit = fitSweepPlane({
      previous: { heel: v3(-0.05, 0.05, 0), tip: v3(0.05, 0.05, 0) },
      current: { heel: v3(-0.05, 0.0499, 0), tip: v3(0.05, 0.0499, 0) },
    }, PLANE_OPTS);
    expect(fit).toEqual({ ok: false, reason: 'no-sweep' });
  });

  it('rejects a slide along the blade axis as draw-stroke', () => {
    const fit = fitSweepPlane({
      previous: { heel: v3(-0.05, 0.05, 0), tip: v3(0.05, 0.05, 0) },
      current: { heel: v3(0.03, 0.05, 0), tip: v3(0.13, 0.05, 0) },
    }, PLANE_OPTS);
    expect(fit).toEqual({ ok: false, reason: 'draw-stroke' });
  });

  it('rejects a plane along the food axis as lengthwise', () => {
    expect(solveCut(stock, { normal: v3(1, 0, 0), point: v3(0, 0.05, 0) }, CUT_OPTS))
      .toEqual({ ok: false, reason: 'lengthwise' });
  });

  it('rejects a plane past the end of the food as a miss', () => {
    expect(solveCut(stock, { normal: v3(0, 1, 0), point: v3(0, 0.4, 0) }, CUT_OPTS))
      .toEqual({ ok: false, reason: 'miss' });
  });

  it('records a rejection rather than a cut when a script sweep is degenerate', () => {
    const result = runCutScript({
      name: 'degenerate',
      stock: { profile: 'cylinder', originalLengthM: 0.1, radiusM: 0.02 },
      targetThicknessMm: 3,
      sweeps: [{
        previous: [[-0.05, 0.05, 0], [0.05, 0.05, 0]],
        current: [[-0.05, 0.04999, 0], [0.05, 0.04999, 0]],
      }],
    });
    expect(result.session.records).toHaveLength(0);
    expect(result.rejections).toEqual(['no-sweep']);
  });
});

describe('5. NaN fuzz', () => {
  it('never produces a non-finite metric across 10000 random blade poses', () => {
    const stock = cucumber({ originalLengthM: 0.18, radiusM: 0.021 });
    let accepted = 0;

    for (let i = 0; i < 10_000; i++) {
      const r = () => (Math.random() - 0.5) * 0.6;
      const fit = fitSweepPlane({
        previous: { heel: v3(r(), r(), r()), tip: v3(r(), r(), r()) },
        current: { heel: v3(r(), r(), r()), tip: v3(r(), r(), r()) },
      }, PLANE_OPTS);
      if (!fit.ok) continue;

      const out = solveCut(stock, fit.plane, CUT_OPTS);
      if (!out.ok) continue;
      accepted++;

      const { cut } = out;
      for (const [name, value] of Object.entries({
        axialPositionM: cut.axialPositionM,
        sliceVolumeM3: cut.sliceVolumeM3,
        angleDeviationDeg: cut.angleDeviationDeg,
        wedgeMm: cut.wedgeMm,
      })) {
        expect(Number.isFinite(value), `${name} was ${value}`).toBe(true);
      }
      expect(cut.sliceVolumeM3).toBeGreaterThanOrEqual(0);
      for (const y of cut.capRing) expect(Number.isFinite(y)).toBe(true);
    }

    // Guards against the fuzz silently rejecting everything and proving nothing.
    expect(accepted, 'fuzz accepted no cuts at all').toBeGreaterThan(100);
  });
});

describe('6. scoring golden file', () => {
  it('produces a stable score for the recorded script', () => {
    const result = runCutScript(script);
    expect(result.session.records).toHaveLength(4);

    const thicknesses = result.session.records.map((r) => Number(r.thicknessMm.toFixed(4)));
    expect(thicknesses).toEqual([3, 3.5, 2.7, 3.3]);

    expect(result.rejections).toEqual([]);
    expect(result.score.meanMm).toBeCloseTo(3.125, 6);
    expect(result.score.sigmaMm).toBeCloseTo(0.303109, 5);
    expect(result.score.angleScore).toBeCloseTo(1, 9);

    expect(
      formatScore(result.score, {
        targetThicknessMm: script.targetThicknessMm,
        toleranceMm: 0.5,
        targetSigmaMm: 0.5,
        angleToleranceDeg: 5,
      }),
    ).toBe('3.1mm average, ±0.3mm. Target 3mm, ±0.5mm.');
  });
});
```

- [ ] **Step 4: Run the harness**

Run: `npm run cuts`
Expected: PASS, 11 tests across 6 describe blocks.

The golden values in group 6 are derived by hand above, not copied from a run. **If they
disagree, the solver is wrong — do not edit the fixture to match the output.** The one thing
worth re-deriving before suspecting the solver is the `sigmaMm` figure, since it is a population
standard deviation (divide by n, not n−1) and that distinction is easy to lose.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test`
Expected: purity OK, no type errors, all tests pass across 9 files.

- [ ] **Step 6: Commit**

```bash
git add harness/
git commit -m "test(harness): six-group conformance suite over the real solver"
```

---

## Task 12: Document the physics

**Files:**
- Create: `PHYSICS.md`

Master spec rule #14: cite every constant, and mark anything unsourced explicitly. This milestone
is geometry rather than thermodynamics, so the document is mostly derivations — but establishing
the file and its discipline now means the §8 thermal constants land in a structure that already
exists.

- [ ] **Step 1: Write `PHYSICS.md`**

```markdown
# PHYSICS

Every constant and derivation in the simulation. Master spec rule #14: cite it, or mark it
`TUNED, not sourced` explicitly. Never invent a coefficient.

## Scope

This document currently covers Discipline A (knife work), which is geometry. The thermal
constants for Discipline B arrive with the §8 milestone and belong under a second heading here.

## Derivations

### Cut plane from a blade sweep

The blade occupies a segment from heel to tip. Between two frames it sweeps a ruled surface
whose four corners are the heel and tip at each frame. Master spec §7.2 takes the normal as
`normalize(cross(bladeDirection, sweepDirection))`.

We instead fit the normal across all four corners by Newell's method:

```
nx = Σ (y_i − y_j)(z_i + z_j)
ny = Σ (z_i − z_j)(x_i + x_j)
nz = Σ (x_i − x_j)(y_i + y_j)        j = (i+1) mod 4
```

Newell is exact for a planar polygon and degrades to a least-squares fit when the polygon is
not planar, which is what lets us measure the error rather than hide it. The sign is then
aligned with `cross(bladeDirection, sweepDirection)` so the normal is stable frame to frame.

**Planarity residual** is the maximum perpendicular distance from any corner to the fitted
plane. It is zero for a pure translation sweep and grows as the blade rotates mid-sweep, because
the swept surface is then a hyperbolic paraboloid rather than a plane. Above
`MAX_PLANARITY_RESIDUAL_M` the sweep is subdivided and each part solved independently.

This number is what substantiates §7.4's claim that cut planes are exact rather than estimated.

### Plane–lathe intersection

A lathe solid is the surface of revolution `(r(y)·cosθ, y, r(y)·sinθ)` about the y axis.
A plane is `n · X = n · p`. Substituting:

```
nx·r(y)·cosθ + ny·y + nz·r(y)·sinθ = n·p
```

Solving for y:

```
y(θ) = ( n·p − r(y)·(nx·cosθ + nz·sinθ) ) / ny
```

Implicit in `y` through `r(y)`. The dependence is weak — `r` varies slowly along a cucumber — so
three fixed-point iterations converge far below any tolerance of interest. For a cylinder `r` is
constant and the expression is exact after one.

**Axis intersection** is the θ-independent case, `y = (n·p) / ny`, requiring `|ny| > 0`. Below
`MIN_AXIS_DOT` the plane runs along the food's length; that is a lengthwise fillet, for which
"slice thickness" is undefined, and it is rejected rather than approximated.

**Wedge.** The radial term has amplitude `r·√(nx² + nz²)`, so:

```
max y − min y = 2·r·√(nx² + nz²) / |ny| = 2·r·tan(angle)
```

since `n` is a unit vector and `|ny| = cos(angle)`. Verified against the sampled cap ring for
angles from 5° to 50° in `harness/conformance.test.ts` group 1.

### Volume of a clipped lathe

In cylindrical coordinates the volume element is `ρ dρ dθ dy`. Integrating ρ from 0 to `r(y)`:

```
V = ∫₀^2π ∫_lo(θ)^hi(θ) ( r(y)² / 2 ) dy dθ
```

The inner integral is evaluated by Simpson's rule over the profile samples; the outer by uniform
summation over the radial segments, which is spectrally accurate for a periodic integrand.

**Why not `π ∫ r(y)² dy`.** That form assumes both end caps are flat discs perpendicular to the
axis, which is false for every angled cut. For two *parallel* caps the general form collapses to
exactly `π·r²·Δy` regardless of tilt, because every radial column then has identical axial
extent — this identity is asserted directly in `src/sim/lathe.test.ts`.

### Thickness

Two distinct quantities, and conflating them is a real error:

| Quantity | Definition | Who can measure it |
|---|---|---|
| Axial delta | Drop in stub length along the axis | Camera (§7.3) and blade pose |
| Perpendicular thickness | Face-to-face distance of the disc | Blade pose only |

They are related by `thickness = axialDelta · cos(angle)` and coincide when the cut is square.
A silhouette contains no angle information, which is why the camera path can never recover the
perpendicular figure. Scoring uses the perpendicular one.

### Hand extension ratio

```
extensionRatio = |tip − proximal| / |intermediate − proximal|
```

Using adult index-finger proportions — proximal phalanx ≈ 40mm, remaining two phalanges ≈ 35mm
combined (Buryanov & Kotiuk, *Proportions of Hand Segments*, Int. J. Morphol. 28(3), 2010) — a
fully extended finger gives `75/40 ≈ 1.87` and a fully curled one gives `≈ 0.88`. Master spec
§7.5's threshold of 1.3 sits between them with comfortable margin, and is used unchanged.

## Constants

| Constant | Value | Source |
|---|---|---|
| `CLAW_THRESHOLD` | 1.3 | Master spec §7.5; bracketed by the ratios derived above |
| `DANGER_MM` | 20 | Master spec §7.5 |
| `WARN_MM` | 45 | TUNED, not sourced — roughly twice the danger distance |
| `MIN_SWEEP_M` | 0.004 | TUNED, not sourced |
| `MIN_CROSS_SIN` | 0.17 | TUNED, not sourced — about 10° between blade and sweep |
| `MAX_PLANARITY_RESIDUAL_M` | 0.002 | TUNED, not sourced |
| `MIN_AXIS_DOT` | 0.26 | TUNED, not sourced — cos(75°), beyond which a cut is a fillet |
| `CUCUMBER_LENGTH_M` | 0.18 | Master spec §7.6 |
| `CUCUMBER_RADIUS_M` | 0.021 | Master spec §7.6 |
| Cucumber profile coefficients | taper 0.22, bulge 0.05, cap 0.93 | Master spec §7.6 verbatim |

## Validation

`npm run cuts` runs six groups: analytic conformance against closed-form cylinder geometry,
volume conservation to better than 0.1% across a full cutting session, stub monotonicity,
degenerate-input rejection, a 10,000-pose NaN fuzz, and a scoring golden file.

The thermal milestone adds the validation that matters most for the technical score —
reproducing a published pan-searing curve the model was not fitted to. See master spec §8.9.
```

- [ ] **Step 2: Verify the repo is clean and green**

Run: `npm test`
Expected: purity OK, no type errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add PHYSICS.md
git commit -m "docs: derivations and constant sourcing for the knife simulation"
```

---

## Task 13: Repository housekeeping

**Files:**
- Rename: `MISE_MASTER_SPEC.md` → `CLAUDE.md`
- Move: `judging-criteria.png` → `docs/judging-criteria.png`

Master spec line 4 instructs that the spec live at the repo root as `CLAUDE.md`, and Appendix B
expects the rubric image at `docs/judging-criteria.png`. Doing this makes the spec load
automatically into every future session, which matters more than it sounds.

- [ ] **Step 1: Move both files with git**

```bash
git mv MISE_MASTER_SPEC.md CLAUDE.md
git mv judging-criteria.png docs/judging-criteria.png
```

- [ ] **Step 2: Verify the image reference now resolves**

Run: `grep -n 'judging-criteria' CLAUDE.md`
Expected: a line referencing `docs/judging-criteria.png`, which now exists at that path relative
to the repo root.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: move master spec to CLAUDE.md and rubric image into docs"
```

---

## Definition of done

- [ ] `npm run check:purity` passes — `src/sim/**` imports no framework
- [ ] `npm run typecheck` passes under `strict: true`
- [ ] `npm run cuts` passes all six conformance groups
- [ ] `npm test` passes end to end
- [ ] `DECISIONS.md` records all five deviations from the master spec
- [ ] `PHYSICS.md` cites or explicitly marks every constant
- [ ] The master spec lives at `CLAUDE.md` and its rubric image resolves

## What this plan deliberately does not do

No rendering, no XR, no physics engine, no audio. Those are Plan 2, written once this is green
and `npx @iwsdk/create` has produced a real project on disk — writing steps against a generated
structure nobody has seen would mean inventing file paths, which is the failure mode this plan
format exists to prevent.

Two questions stay open for Plan 2 and are answered by running code, not by more analysis:

1. Does Havok exhibit the small-body jitter master spec §8.10 attributes to Rapier? IWSDK exposes
   no scale knob, which is weak evidence it does not. Fallback: simulate at 10× and scale the
   render transform.
2. Do IWER's emulated hands articulate, or is the pose canned? If canned, `handSafety` still
   passes every test in Task 10 — it simply cannot be tuned until a headset is present.
