# MISE — 24-Hour Demo Spine

**Deadline:** 24 hours from H+0. This replaces the full Plan 2, which does not fit.

**Goal:** a Quest 3S build where you pick up a knife, cut a cucumber, the mesh splits, the
pieces fall, and a panel reports the slice thickness in millimetres.

---

## What the judging criteria actually reward

| Criterion | Scored? | What it means here |
|---|---|---|
| WOW factor | ✅ | A cut that measures real millimetres and can be checked with a ruler |
| Technical ability | ✅ | The simulation core, `PHYSICS.md`, the two solver defects and how they were found |
| Originality | ✅ | Exact analytic cut geometry, not a mesh-slicing shader trick |
| Design | ✅ | *User-friendly and intuitive* — plain-language readout, not graphics |
| **Practicality / entrepreneurship** | ❌ | Do not build a business case |
| **Visual appeal** | ❌ | **Explicitly not scored.** No textures, no materials work, no lighting polish |

Visual appeal being a non-criterion is the single most useful fact in this document. Untextured
procedural geometry is acceptable. Every hour spent on looks is an hour spent on nothing.

---

## Process change, effective now

Plan 1 ran fresh implementer → spec review → quality review per task. That found five real
defects and was worth it for physics that is invisible when wrong. It costs roughly three times
the wall clock per task, and there is no longer room for it.

From here: **one implementer per task, then a smoke test that the thing runs.** Reviews only
where a wrong answer would be silent and load-bearing. The simulation core already had that
treatment; the XR layer fails loudly, so it does not need it.

Plan 1 is **frozen** when the running test-strengthening agent lands. No further polish of
`src/sim` unless the demo needs it.

---

## Build order — vertical slices, not layers

The first version of this plan built the knife, then fragments, then the panel: three layers,
each finished before anyone could try the thing. That is the wrong shape for work whose quality
is a matter of feel. You cannot review "does cutting feel good" from a commit.

So every version below is **playable end to end**. Each adds exactly one thing, and each is a
shippable demo on its own. If we run out of hours at any point, we ship the last one that works.

Iterate in the **browser emulator**, where a reload is seconds. Go to the headset to check feel,
not to debug.

### v0 — The shell. ✅ **done** (`e27ca2e`)

A procedural cucumber renders in the IWER browser emulator. `npm test` still green at 191, and
`check:purity` still passes, so the XR layer depends on the simulation and not the reverse.
Findings that cost time and would cost it again are in DECISIONS entry 11.

### v1 — Cut on a button press. No grab. No physics. *(target: 60–75 min after the shell)*

A knife mesh rigidly follows the controller. Press the trigger and it cuts at the blade's
current pose. The cucumber becomes two meshes, both sitting still. A panel prints the thickness.

This deliberately skips the two hardest things — the grab system and the collider lifecycle —
because neither is needed to answer the only question that matters at this stage: *is cutting a
cucumber and seeing a real millimetre number any fun?*

### v2 — Cut by moving the blade

Replace the button with the real thing: sample the blade pose each frame, feed `SweepSample`
into `resolveSweepPlanes` → `solveCut`, cut when a stroke actually passes through the food.
This is where the rejection taxonomy starts earning its keep — a stroke that is not a cut gets
refused, visibly.

### v3 — Slices fall

Give the slice a `ConvexHull` collider and a `Dynamic` body, inherit the blade's velocity.
This is where the collider-lifecycle trap lives, which is exactly why it is not in v1.

### v4 — Grab the knife

`OneHandGrabbable`. Until now the knife has been welded to the controller, which is fine and
possibly even better.

### Later, only if the clock allows

Hand tracking, safety ring, board calibration, ribbon.

---

## Original phase list, kept for reference

Each phase must leave something that runs. Stop a phase at its time box and move on.

### P1 — Mesh builder *(in flight)*
`src/sim/latheMesh.ts`, pure, framework-free. Validated against `volumeOf` through the
polygon-inscription factor. **No XR dependency, so it cannot be blocked.**

### P2 — Scaffold integration — 60 min
`npx @iwsdk/create` verified working with these flags (`--locomotion` is rejected with
`--target ar`):

```
npx @iwsdk/create@0.5.3 <dir> --yes --target ar --language ts \
  --physics --grabbing --scene-understanding --environment-raycast \
  --install --no-git --skip-reference-warmup
```

Scaffold into a temp directory and copy in selectively — it ships its own `CLAUDE.md` and
`AGENTS.md` that would collide with the master spec. Keep our `tsconfig`, our `check:purity`,
our test script. Add `@iwsdk/vite-plugin-dev/client` and `vite/client` to `types` for app files
only. `World.create` needs no scene JSON: `level` and `assets` are both optional.

**Exit test:** a cucumber mesh visible in the IWER emulator in a browser.

### P3 — Cut on demand — 90 min
Knife entity, grabbable. Blade pose from `world.player.gripSpaces` — **world space via
`getWorldPosition`/`getWorldQuaternion`**, the group is local to the XR rig. Feed `SweepSample`
per frame into `resolveSweepPlanes` → `solveCut`. On success, rebuild as two entities.

Collider lifecycle is the known trap: `PhysicsShape.dimensions` changes after body creation are
**silently ignored**. Rebuilding means `removeComponent(PhysicsShape)` + `removeComponent(PhysicsBody)`,
then re-adding.

**Exit test:** a cut in the emulator produces two meshes.

### P4 — Fragments — 45 min
Slice gets `PhysicsShape { shape: ConvexHull, density: densityKgM3 }` — kg/m³, passed straight
through, see DECISIONS 5 — plus `PhysicsBody { state: Dynamic }`, then `PhysicsManipulation
{ linearVelocity }` one frame later. Not `force`: IWSDK frame-scales it and applies it at the
object origin.

Despawn on a timer. `FRAGMENT_SLEEP_S` has no engine backing; drop it.

**Exit test:** slices fall and land on the board.

### P5 — The readout — 45 min
uikit panel via `UIKit.Container` wrapped in `UIKitDocument` — a bare `Container` is never
ticked. Sizes are **centimetres**. Show `formatScore()` verbatim: *"3.0mm average, ±0.2mm.
Target 3mm, ±0.5mm."* That string is the Design criterion in one line.

**Exit test:** the panel updates after each cut.

### P6 — Headset — 120 min, hard stop
Vite serves HTTPS with a self-signed cert; the headset connects over LAN. No adb, no USB.
Budget the full two hours: this is where the unknowns are.

### P7 — Submission — 60 min
README, the demo video, and the published bench page as the technical-depth exhibit.

---

## Cut list — not building these

- **Thermal simulation (§8) entirely.** A second discipline; no time. Also the physics API has
  no joints, no contact events and no fixed timestep, so parts of §8 need respeccing first.
- **Automatic board calibration.** Place the board at a fixed offset. `XRMesh.semanticLabel`
  detection is a stretch goal at best.
- **Blade path ribbon.** Pure visual. Non-criterion.
- **Hand safety ring.** Keep the logic — it is tested and it is a talking point — but the claw
  pose cannot be validated without a headset and the emulator cannot curl three fingers
  together. Do not spend headset time debugging it.
- **Textures, materials, lighting.** Non-criterion.

---

## Fallback

The published bench page already runs the real simulation in a browser with no headset. If P6
fails, that is the demo, and it still serves WOW, Technical ability and Originality. Keep it
deployed and current.

---

## Four-person split

The rule: people take what agents cannot. Device setup, recording, and judging how the
interaction *feels* are all human-only. Writing TypeScript is not the bottleneck.

### 1 — Headset beachhead. Start now, before any of our code is ready.

This is the single biggest unknown and it needs none of our work to retire. Prove the pipeline
end to end with the throwaway scaffold that already exists at
`…\scratchpad\plan2\mise-ar\` — it has `node_modules` installed and will `npx vite` today.

- Quest 3S into developer mode
- Serve over LAN, load the URL on the headset, **accept the self-signed certificate** — this is
  the step most likely to bite, and there is no adb or USB path
- Confirm `immersive-ar` actually starts and passthrough comes up

Report back: the LAN URL that worked, whether the cert was accepted, whether AR started. If any
of that fails, we need to know in hour one, not hour twenty.

### 2 — Critical path, with me. P2 → P3.

Scaffold integration is in flight. Next is the cut pipeline: grabbable knife, blade pose per
frame, into `resolveSweepPlanes` → `solveCut`, mesh splits in two.

Known trap: `world.player.gripSpaces` is **local to the XR rig**, so
`getWorldPosition`/`getWorldQuaternion` are mandatory. A raw `.position` read here is a silent
frame-of-reference bug that will look plausible.

### 3 — Fragments and readout. P4, P5. Starts when P2 lands.

- `ConvexHull` colliders — `Cylinder` is 15% light, `TriMesh` 18% (DECISIONS 5b)
- `density` is kg/m³, passed straight through, **no conversion** (DECISIONS 5)
- `linearVelocity`, never `force` — IWSDK frame-scales force and applies it at the wrong point
- uikit sizes are **centimetres**; a `Container` not wrapped in `UIKitDocument` never ticks
- Display `formatScore()` verbatim

### 4 — Submission. Start now, not at hour twenty.

The video is what usually gets rushed, and it is what judges actually watch.

- README: what is real, what is simulated, what is not built
- Demo script, then *rehearse it* — including the failure case
- Know how to present the bench page; it is the fallback demo and it stands on its own
- Submission form filled in early, not at the deadline

## Definition of done

- [ ] A cut in the headset splits a cucumber and reports its thickness in millimetres
- [ ] `npm run check:purity` still passes — the XR layer depends on the sim, never the reverse
- [ ] The bench page is deployed and matches the shipped simulation
- [ ] README states what is real, what is simulated, and what is not built
