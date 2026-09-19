# MISE — Knife Work Simulation (Desktop-First)

**Date:** 2026-09-18
**Scope:** Discipline A (§7) core, runnable and provable on a desktop with no headset.
**Derived from:** `MISE_MASTER_SPEC.md` §7, §12, §14, §17.

---

## 1. Goal

Build the knife-work simulation so it can be played in a desktop browser through an emulated
XR session, and so its geometry and scoring can be proven correct from a terminal with no
browser at all.

This is the T+8 gate from the master spec: *someone not on the team asks for another turn.*
Nothing here depends on a Quest, a passthrough camera, or a network connection.

### In scope

| Spec section | Feature |
|---|---|
| §7.1 | Board calibration (4-corner), debug HUD, live sliders for every tunable |
| §7.2 | Blade segment, swept quad, analytic cut plane, fragments, haptics |
| §7.4 | Exact cut metrics, plain-millimetre scoring |
| §7.5 | Claw-grip detection, fingertip-to-blade distance, safety ring |
| §7.6 | Procedural lathe cucumber, rebuilt from profile on every cut |
| §12 | Blade path ribbon |
| §12 | Cut audio — amplitude by cross-section, pitch by accuracy (see §9) |

### Out of scope, and why

- **§7.3 stub measurement** — requires the passthrough camera. Deferred to Phase 2.
- **§8 thermal simulation** — separate milestone.
- **Menus, mode select, onboarding** — explicitly deferred by the user.
- **§7.7 materials pass** — Phase 4 only, capped at 3h by the master spec, and visual appeal
  is a non-criterion.
- **Knuckle rail** — master spec lists it under "nice to have".

---

## 2. Governing decision: the simulation core is framework-free

`src/sim/**` may not import `three`, `@iwsdk/core`, or any physics engine. It is pure
functions over plain `{x, y, z}` records and plain numbers. Enforced by `npm run check:purity`,
a grep that fails the build on a forbidden import.

Three consequences, in order of importance:

1. **The cut solver is testable without a browser.** `npm run cuts` runs the identical code
   path the game runs. This is the entire reason the milestone is desktop-provable.
2. **There is exactly one cut-plane implementation in the repo.** The virtual path and the
   future camera path cannot drift, because there is nothing to drift from.
3. **IWSDK churn is contained.** `@iwsdk/core` is pre-1.0, has published 14 versions in 11
   months with no changelog, and its own JSDoc references a `world.addSystem` method that does
   not exist in the package. A breaking minor release should cost an adapter layer, not the game.

The default shape for a project like this is one large `main.ts` with the plane math inline in
the render loop. That shape cannot be tested, cannot be proven, and cannot survive a framework
bump. This design exists to avoid it.

---

## 3. Architecture

```
src/sim/          pure TypeScript, zero framework imports
  vec3.ts         minimal vector math over {x,y,z}
  cutPlane.ts     blade sweep -> plane, with degeneracy + planarity analysis
  lathe.ts        profile function, parameter-space clipping, volume integral
  cutSolver.ts    plane x lathe -> stub, slice, and all metrics
  metrics.ts      per-cut thickness / angle / position / wedge
  scoring.ts      §7.4 aggregate score
  handSafety.ts   §7.5 claw grip + fingertip proximity
  feedback.ts     CutFeedback descriptor shared by audio and haptics
  tunables.ts     every magic number, one typed registry

src/render/       three.js, no game logic
  cucumberMesh.ts lathe spec -> BufferGeometry, incl. slanted elliptical cap
  crossSection.ts procedural cut-face shader
  ribbon.ts       blade path ribbon
  materials.ts    baseline materials (full pass deferred to Phase 4)

src/audio/        WebAudio, synthesized, no assets
  cutAudio.ts     CutFeedback -> noise burst; pitch by accuracy

src/xr/           IWSDK adapter systems; thin, no math
  bootstrap.ts    World.create, IWER desktop path
  BladeSystem.ts  controller pose -> sim blade segment
  SlicingSystem.ts sim result -> mesh rebuild + physics bodies
  SafetySystem.ts hand joints -> sim -> ring colour + haptics
  CalibrationSystem.ts
  DebugSystem.ts  HUD + sliders generated from tunables.ts

src/physics/
  havok.ts        PhysicsShape / PhysicsBody declarations

harness/
  cuts.ts         npm run cuts
  fixtures/*.cuts.json

PHYSICS.md        constants, citations, validation
DECISIONS.md      every deviation from the master spec, with reasons
```

Data flows one way: `xr/` reads poses and calls `sim/`, `sim/` returns plain data, `xr/` and
`render/` act on it. `sim/` never calls back.

---

## 4. Cut-plane solver

The master spec (§7.2) gives:

```
cutPlaneNormal = normalize(cross(bladeDirection, sweepDirection))
```

Correct, but it has four degenerate cases. Each one produces `NaN`, and master spec rule #5
warns that a single `NaN` reaching a collider dimension explodes the scene silently.

| Case | Cause | Result if unhandled | Handling |
|---|---|---|---|
| No sweep | Blade held still | `0/0` normal | Reject below `MIN_SWEEP_M` |
| Draw stroke | Sweep parallel to blade's own length | `cross ≈ 0` | Reject; this is a slide, not a cut |
| Rotating sweep | Blade rotates mid-sweep | Swept surface is a hyperbolic paraboloid, not a plane | Measure residual, subdivide |
| Lengthwise | Plane nearly parallel to food axis | Thickness undefined | Reject as a fillet, with feedback |

### Planarity residual

When the blade rotates during a sweep, the four corners of the swept quad are not coplanar.
Fitting a plane anyway is silently wrong. So:

1. Best-fit plane normal through the four corners via Newell's method (cheap, robust, no SVD).
2. Plane point = corner centroid.
3. `planarityResidualM` = max perpendicular distance of any corner from that plane.

If the residual exceeds `MAX_PLANARITY_RESIDUAL_M`, the sweep is subdivided into sub-steps and
each is solved independently, rather than approximating a curved sweep as flat.

This residual is also the number that substantiates the §7.4 pitch line. "Exact, not estimated"
is a claim that should have a figure attached to it, and this is that figure.

### Rejections are values, not exceptions

```ts
type RejectReason =
  | 'no-sweep' | 'draw-stroke' | 'lengthwise' | 'non-planar' | 'miss';

type CutOutcome =
  | { ok: true;  cut: CutResult }
  | { ok: false; reason: RejectReason };
```

Typed rejections mean the HUD can explain *why* a cut did not register. "That was a draw
stroke, not a cut" is better feedback than silence, and it costs nothing.

---

## 5. Metrics

### Two thicknesses, not one

An earlier draft of this design claimed the virtual and camera paths share a single definition
of thickness. **That is false, and the way it is false is the interesting part.**

§7.3 measures the drop in stub length between cuts. That is an *axial* delta — the amount of
cucumber that went away. The *true* thickness of the resulting disc is the perpendicular
distance between its two faces, and for an angled cut those differ by `cos(angle)`:

```
axialDeltaMm   = (stubAxialLengthBefore − stubAxialLengthAfter) × 1000
thicknessMm    = axialDeltaMm × |n · a|          // perpendicular, the true thickness
```

They coincide exactly when the cut is square, and diverge as it tilts. A 5.0mm axial delta at
20° off square is a 4.7mm slice.

A silhouette contains no angle information, so **the camera can only ever report the axial
number.** The blade pose gives both. Report both, score on the perpendicular one, and show the
gap:

> "Camera reads 5.0mm — that's all a camera can physically see. Blade pose says 4.7mm, and
> tells you the 20° that explains the difference."

This is a stronger argument for §7.4's exact-cut-plane claim than a shared definition would
have been, because it demonstrates something the vision path cannot recover in principle.

### Angle and wedge

With food axis `a` and plane normal `n`:

```
angleDeviationDeg = acos(|n · a|)            // 0° is a square cut
wedgeMm           = 2 · r · tan(angleDeviation)
```

`wedgeMm` is the thickness *spread across the cut face*. It falls out of the same solve for one
line of arithmetic, and it is the number a cook actually feels:

> "4.0mm at the centre — but 2.1 to 6.0 across the face. You were 11° off square."

No physical kitchen tool reports this.

### Position — cumulative drift, not per-cut error

```
expectedAxialPosition = firstCutPosition + n × targetThicknessMm
positionErrorMm       = |axialPosition − expectedAxialPosition|
```

Defining this against the *previous* cut would make it an algebraic restatement of
`|thickness − target|`, carrying no information the thickness metric does not already carry.
Measured against the ideal grid instead, it captures accumulated drift — ten cuts of 3.2mm
against a 3mm target are each nearly perfect yet leave the blade 2mm further down the cucumber
than it should be. That is a real failure mode, and it is invisible in per-cut error.

### Per-cut record

```ts
interface CutResult {
  axialPositionM: number;
  axialDeltaMm: number;        // what §7.3's camera method can measure
  thicknessMm: number;         // perpendicular; the true thickness, scored
  angleDeviationDeg: number;
  wedgeMm: number;
  positionErrorMm: number;     // cumulative drift from the ideal grid
  planarityResidualM: number;
  sliceVolumeM3: number;
  stubLengthM: number;
}
```

---

## 6. Scoring (§7.4)

Verbatim from the master spec:

```ts
const mean       = sum(thicknesses) / n;
const sigma      = stdDev(thicknesses);
const accuracy   = Math.exp(-Math.abs(mean - targetMm) / toleranceMm);
const uniformity = Math.exp(-sigma / targetSigmaMm);
const score      = 0.5 * accuracy + 0.35 * uniformity + 0.15 * angleScore;
```

**Spec gap:** `angleScore` is used but never defined. Filling it as
`exp(-meanAngleDeviationDeg / angleToleranceDeg)`, for consistency with the other two terms.
Logged in `DECISIONS.md` per rule #15.

Display is plain numbers, never a 0–100 score:

```
4.2mm average, ±1.8mm.  Target 3mm, ±0.5mm.
```

---

## 7. Procedural cucumber (§7.6)

### The parameter-space bug

The naive reading of §7.6 is to call `cucumberProfile(shorterLength)` after each cut. That
re-normalizes `t` over the new length, so the taper and the tip cap recompress — **the cucumber
visibly changes shape on every cut.**

Instead the profile is always evaluated in the *original* parameter space and clipped:

```ts
cucumberProfile({ originalLengthM, fromM: y0, radiusM, segments })
// t runs from y0 / originalLengthM to 1
```

The tip stays a tip. The stub simply gets shorter, which is what actually happens to a cucumber.

### The slanted cap

An angled cut does not leave a flat disc; it leaves an ellipse. For each of the 32 radial
angles, the axial position where the plane meets the surface is closed-form:

```
y(θ) = ( n·p − r · (nₓ·cosθ + n_z·sinθ) ) / n_y
```

Exact for the cylindrical section; one Newton step handles the taper. This is the "analytic
fast path" of §7.2 done properly rather than approximated, and it independently confirms the
wedge formula, since `max(y) − min(y) = 2·r·tan(angle)`.

### Volume

**Not** `∫ π·r(y)² dy` over the axial span. That expression describes a region bounded by two
flat discs, and an angled cut is bounded by two oblique planes — using it would make the
conservation test in §10 below fail for reasons that look mysterious.

The region between two planes is integrated over the disc instead, as the axial extent of each
radial column:

```
V = ∫₀^2π ∫₀^r(·)  ( y_upper(θ) − y_lower(θ) )  ρ dρ dθ
```

For two *parallel* planes this collapses to exactly `π·r²·axialDelta`, because every column has
identical axial extent regardless of how the pair is tilted — which is a useful closed-form
check to assert against. The general case (the cut angle changed between cuts, so the faces are
not parallel) needs the full integral, evaluated by Simpson over the existing radial and profile
samples.

---

## 8. Hand safety (§7.5)

### A correction to the master spec

§7.5 comments the joint sets as `index (5,6,7,8)`, treating them as MCP/PIP/DIP/TIP. In the
WebXR hand model those indices are `metacarpal, phalanx-proximal, phalanx-intermediate,
phalanx-distal` — index 5 is buried in the palm and the fingertip (index 9) is omitted entirely.
`extensionRatio` computed from that set measures nothing useful while appearing to work.

Joints are therefore addressed **by name**, never by index:

```ts
extensionRatio(finger) =
  |tip − phalanx-proximal| / |phalanx-intermediate − phalanx-proximal|
```

The master spec's thresholds are correct and are kept: extended ≈ 1.87, curled ≈ 0.88, so
`CLAW_THRESHOLD = 1.3` discriminates cleanly.

### State and hysteresis

Raw per-frame classification strobes the ring, for the same reason raw detections strobe in
master spec §10.2. Debounced over `SAFETY_DEBOUNCE_FRAMES`.

| State | Condition | Response |
|---|---|---|
| `SAFE` | Claw held | Green ring |
| `WARN` | Borderline extension, or blade within `WARN_MM` | Amber ring |
| `DANGER` | Fingertips exposed **and** blade within `DANGER_MM` | Red ring, haptic, chef bark |

Fingertip-to-blade is point-to-segment distance against the heel→tip segment — pure math, lives
in `sim/`. All five fingertips including the thumb.

**Guiding hand** = the handedness opposite the controller the blade is bound to. Simple,
and it cannot be confused by hands crossing.

---

## 9. Feedback: audio now, haptics behind the same interface

The T+8 gate is *someone not on the team asks for another turn*. Geometry and metrics do not
produce that response on their own — feedback does. §7.2's haptics require a physical
controller, which a desktop does not have, so without audio this milestone ships in silence and
cannot pass its own gate on the machine it was built to run on.

`sim/` emits one feedback descriptor per cut and both channels consume it:

```ts
interface CutFeedback {
  intensity: number;   // 0–1, from cross-sectional area at the cut (drives §7.2 haptics)
  accuracy: number;    // 0–1, |thickness − target| against tolerance
  kind: 'clean' | 'rejected';
}
```

- **Amplitude** ← `intensity`. This is the same scalar §7.2 scales haptics by, so the two
  channels are guaranteed to agree rather than being tuned twice.
- **Pitch** ← `accuracy`. Master spec §12 lists "chop sound pitch maps to accuracy" under
  should-ship. A
  clean 3mm cut rings; a ragged 6mm one thuds. You learn the target by ear before you read a
  number.
- **Rejections are audible too.** A draw stroke scrapes rather than chops, so §4's typed
  `RejectReason` reaches the player without a text box.

Synthesized in WebAudio — a short noise burst through a bandpass envelope — not sampled. No
assets, no network, no load time, and every parameter is a tunable slider. ElevenLabs' Sound
Effects API (master spec §9.4) replaces the synthesis in Phase 3 behind this same interface.

**This is also down payment on Blind Service.** Master spec §11 calls it the highest-scoring
original idea
available, and it is a mode in which audio and haptics are the *only* feedback. Building the
audio channel first means Blind Service later is close to a passthrough dimmer over feedback
that already carries the whole game. Skipping it now would mean building it then anyway, under
worse time pressure, against a cut loop that had never needed it.

---

## 10. `npm run cuts` — proving it without a browser

A `.cuts.json` replay format drives recorded blade poses through the real solver. (This format
is also what Ghost Duel will replay later, so it is not throwaway.)

| # | Test | Assertion |
|---|---|---|
| 1 | Analytic conformance | Known cylinder, known plane → `y_cut`, angle, wedge match closed form to 1e-9 |
| 2 | Volume conservation | Σ slice volumes + stub volume = original, drift < 0.1% |
| 3 | Monotonicity | Stub length strictly decreases, never negative |
| 4 | Degeneracy | All four cases in §4 reject cleanly with the correct `RejectReason`, zero `NaN` |
| 5 | NaN fuzz | 10k random blade poses; nothing non-finite ever reaches a metric or a collider dimension |
| 6 | Scoring golden file | Fixed cut sequence → fixed score, byte-identical |

Test 5 directly discharges master spec rule #5. Test 2 catches geometry-rebuild bugs that are
invisible on screen.

---

## 11. Physics: Havok, not Rapier

**The master spec is wrong on this point.** §8.10 specifies Rapier "via IWSDK", but
`@iwsdk/core@0.5.3` depends on `@babylonjs/havok` and contains zero references to Rapier. Its
`PhysicsSystem` docstring names Havok explicitly.

Void as written: `world.integrationParameters`, `numSolverIterations`, and `lengthUnit: 0.1`
are Rapier-only APIs.

**Decision: use IWSDK's Havok. Do not add Rapier.** This milestone needs fragments and a
kinematic blade, which Havok serves declaratively. Adding Rapier means a second WASM blob, a
second world, and hand-syncing transforms to reimplement what is already wired.

The collider table from §8.10 survives intact — Havok exposes `Cylinder`, `ConvexHull`,
`TriMesh`, `Capsules` and `Static | Dynamic | Kinematic`:

| Object | Shape | State |
|---|---|---|
| Cucumber stub | Cylinder | Static |
| Slice | Cylinder | Dynamic |
| Blade | Capsules | **Kinematic** |
| Board | Box | Static |

The rules that still bind: never a trimesh on a dynamic body; never a dynamic blade; never
reparent a physics object under a rotated node. Fragments capped at 40, sleep at 2s, despawn
at 8s.

Material properties live on `PhysicsShape` as `density`, `friction`, `restitution`, so §8.10's
material table maps directly. Gravity is `physicsSystem.config.gravity.value`, defaulting to
Earth. `PhysicsBody.centerOfMass` accepts an override, which is what §8.11's curl mechanic will
need later.

### The density unit hazard

`PhysicsShape.density` is annotated **"Mass density (kg/m³)"** with a default of `1.0`. That
annotation is wrong. Air is 1.2 kg/m³, so a 1.0 kg/m³ default would make every object in the
engine lighter than air, and IWSDK's own tuning table lists wood `0.6`, steel `7.8`, concrete
`2.4` — g/cm³, relative to water.

This collides with master spec §8.10's one-source-of-truth rule,
`massKg = profile.densityKgM3 × volumeM3`. Passing `STEAK.densityKgM3 = 1050` directly would
produce a **220-kilogram steak**, silently, and every §8.11 coupling downstream of mass would be
garbage.

Converted once at the boundary (`density: densityKgM3 / 1000`) — and then **asserted**: at
startup, read the engine's computed mass back and check it against `densityKgM3 × volumeM3`
within tolerance. If IWSDK later corrects the annotation to match the label, the assertion fires
immediately instead of quietly rescaling every mass in the game by 1000×. A documentation
ambiguity is thereby converted into a test.

### System priority

`PhysicsSystem` runs at priority `-2`. Any system reading post-step transforms must register
above it; `SlicingSystem` and `SafetySystem` both do.

**Open risk:** §8.10 claims small bodies jitter at decimetre scale. That was a Rapier-specific
defect that `lengthUnit` existed to fix. IWSDK's tuning guide exposes gravity and per-shape
materials but no scale knob and no timestep configuration at all — weak evidence that Havok does
not need one, since a scale workaround is the first thing such a guide would document. Verified
empirically regardless.

**Later risk:** §8.11's sticking mechanic is written as `createImpulseJoint`. IWSDK's public
surface exposes no joint API. Not blocking this milestone, and a positional lock implements
sticking equally well.

---

## 12. Tunables registry (rule #11)

One typed registry, `{ min, max, default, unit }` per entry. The DOM debug panel is *generated*
from it, the future spatial panel will be generated from it, and `npm run cuts` reads the same
defaults — so the tests exercise real values rather than a parallel set that drifts.

Covers: minimum sweep distance, planarity residual ceiling, lengthwise-rejection threshold
(`MIN_AXIS_DOT`), cucumber dimensions, lathe radial and profile segment counts, target
thickness and tolerances, angle tolerance, fragment cap and lifetimes, ribbon lifetime, blade
heel/tip offsets, claw threshold, danger and warn distances, safety debounce, haptic scale,
and the audio envelope (base frequency, pitch range across accuracy, burst duration, bandpass Q).

---

## 13. IWSDK integration notes

Verified against the published `@iwsdk/core@0.5.3` type definitions, not documentation.

- Bootstrap is `await World.create(container, options)`; `world.scene / .camera / .renderer`
  expose the three.js objects.
- Systems are `class X extends createSystem(queries, schema)`, registered with
  **`world.registerSystem`**. IWSDK's own JSDoc shows `world.addSystem`, which does not exist.
- `update(delta, time)` receives **seconds**.
- **`entity.dispose()`, never `entity.destroy()`** — `destroy()` leaks GPU resources. The
  cucumber's geometry is rebuilt on every cut, so this would quietly consume VRAM until the
  demo failed.
- **`setValue` throws on vector fields.** Vec2/3/4 require `getVectorView()`. Every blade pose
  write is affected.
- `src/assets.ts` is evaluated twice in two JS realms; it must be side-effect free.
- Desktop emulation is IWER via `@iwsdk/vite-plugin-dev`, auto-activating when no real WebXR
  device is present. It emulates controllers **and** hand tracking. WASD + mouse move the head.
- Dev server is `npx iwsdk dev up`, not raw `vite`.
- Node engines allow 20 / 22 / 24 and exclude 21 / 23. Local Node is 24.13.0.
- The real `AGENTS.md` is at `packages/cli/guidance/AGENTS.md`, not the repo root.

---

## 14. Desktop interaction

One cut-plane code path, two input feels, auto-detected:

- **Hold and move** → sweep. Per-frame swept quad, exactly as §7.2 describes.
- **Click without moving** → press. Matches the real prop, a bench scraper pressed straight
  down through a cucumber in one motion.

Both produce the same `SweepSample` input to `cutPlane()`. The distinction is drawn entirely in
`BladeSystem`; `sim/` never knows which happened.

### Calibration bypass

§7.1's four-corner calibration exists to locate a *real* cutting board. On a desktop there is no
real board, so requiring the tap ritual on every page reload would cost minutes a day and teach
nothing. The board pose therefore falls back to a fixed synthetic transform whenever the session
is emulated, with calibration still reachable from the debug panel so the real code path stays
exercised rather than bit-rotting until the headset arrives.

### Ribbon colour

Master spec §12 describes the ribbon as "coloured by deviation", but deviation is measured
against the phantom cut line, which is a Phase 2 feature. Until it exists the ribbon colours by
blade speed along its length, and recolours retroactively by the resulting cut's accuracy once
the cut resolves. Same geometry, same 2s fade; only the colour source changes when the phantom
line lands.

---

## 15. Commands

| Command | Does |
|---|---|
| `npm run dev` | IWSDK dev server with IWER; play in a desktop browser |
| `npm run cuts` | Headless solver conformance suite |
| `npm run check:purity` | Fail if `src/sim/**` imports a framework |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | All three of the above |

---

## 16. Repository setup

Scaffolded non-interactively — the CLI takes `-y` plus an explicit `--x` / `--no-x` pair per
feature, so no prompt is ever reached:

```
npx @iwsdk/create@0.5.3 . -y --target ar --language ts \
    --physics --no-locomotion --no-grabbing \
    --scene-understanding --no-git --no-install --force
```

`--no-locomotion` is deliberate: IWSDK's `AGENTS.md` warns that locomotion without a
`LocomotionEnvironment` silently drops the player through the floor, and a game played standing
at a counter has no use for teleport movement. `--no-git` because the repository already exists;
`--force` because it is not empty.

This also installs first-party `.claude/skills/` and `.claude/rules/` into the project —
`iwsdk-physics`, `ecs-api`, depth-occlusion and debug guidance — which is a substantive reason
to use the scaffolder rather than hand-rolling the config.

Hand tracking has no CLI flag; it is set directly in `iwsdk.config.json` as
`world.xr.features.handTracking: true`, which §8 requires.

- `MISE_MASTER_SPEC.md` → `CLAUDE.md` (master spec line 4 instructs this; it also means the
  spec auto-loads into every future session).
- `judging-criteria.png` → `docs/judging-criteria.png` (Appendix B expects it there).
- TypeScript `strict: true`.
- `DECISIONS.md` seeded with entry #1, the Rapier → Havok swap.

---

## 17. Definition of done

1. `npm run cuts` passes all six test groups.
2. `npm run dev` opens in a desktop browser, enters an emulated XR session, and a cucumber can
   be sliced with a mouse.
3. Each cut prints real millimetres: average, sigma, target, tolerance — plus the axial vs
   perpendicular pair whenever the cut is off square.
4. **Every cut is audible, and a listener can tell a good cut from a bad one with the screen
   off.** This is the gate condition for §9; if it fails, Blind Service is not reachable later.
5. The blade path ribbon appears and fades.
6. The safety ring changes colour with grip and blade proximity.
7. Fragments fall, sleep, and despawn without the frame time degrading.
8. Every tunable is adjustable live, without a rebuild.
9. `DECISIONS.md` records the Rapier → Havok swap, the `angleScore` definition, the corrected
   §7.5 joint indices, and the axial-vs-perpendicular thickness split.
10. `PHYSICS.md` is seeded with the constants this milestone actually uses — cucumber density,
    friction and restitution pairs, and the geometric derivations in §7 — each cited or marked
    `// TUNED, not sourced` per rule #14. The thermal constants arrive with the §8 milestone.

## 18. Open questions

- Does Havok exhibit the small-body jitter that §8.10 attributes to Rapier? Empirical.
- Does IWER's emulated hand pose carry enough joint fidelity for `extensionRatio` to
  discriminate, or does it output a canned pose? If canned, §7.5 still passes its unit tests
  but cannot be tuned until a headset is available.
**Resolved:** the scaffolder *is* fully non-interactive — see §16 for the exact command.

**Resolved:** `PhysicsShape.density` is g/cm³ despite being annotated kg/m³ — see §11. Handled
by a boundary conversion plus a startup assertion rather than by trusting either the label or
the table.
