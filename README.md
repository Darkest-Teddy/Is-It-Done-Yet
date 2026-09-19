# Is It Done Yet

A cooking trainer that watches you cut a real cucumber with a real knife through a real camera,
and tells you how thick your slices actually were — in millimetres you can check with a ruler.

```
6.2mm average, ±0.5mm. Target 6mm, ±2mm.
```

No headset. One camera. Everything runs in the browser, locally, with no network.

---

## What is real, what is measured, what is not built

Being precise about this is the point of the project, so it goes first.

### Real

The cucumber, the board, the knife, the hand, and the camera. Nothing on screen is a simulation
of the food. Every number comes from pixels that a lens actually saw.

### Measured, and how

Slice thickness, two independent ways from one camera, both reported:

| Method | What it reads | Fails when |
|---|---|---|
| `stub-delta` | The uncut remainder gets shorter by the thickness that came off | The stub is occluded or nudged |
| `side-profile` | A slice seen edge-on shows its thickness as the short side of its silhouette | A slice lies flat, leans, or rolls away |

They are not the same quantity — `stub-delta` is axial, `side-profile` is perpendicular, and on a
slanted cut they differ by `cos(angle)`. So a disagreement is **reported, never suppressed**.
Agreement is evidence; disagreement means one of them is wrong and the app does not yet know
which. That is a more useful thing to show than a single confident number.

**The ruler is in the picture.** Scale comes from the cucumber's own diameter — constant while
its length is not, and visible in the same blob at the same depth as the thing being measured —
recomputed every frame. Type the diameter in once; everything else is a ratio against it. A
stored calibration cannot notice the tripod being knocked. This one cannot fail to.

### Not measured

**Cut angle.** One fixed camera cannot resolve slant reliably, so `angleDeviationDeg` is left
*absent* rather than defaulted to zero, and `scoreSession` renormalises the two surviving weights
instead. Defaulting it would score every slice the camera could not judge as a flawless square
cut — inflating the score in the one direction nobody would question.

### Not built

Thermal simulation, hand-safety tracking, blade tracking, anything XR. `CLAUDE.md` in this repo
is the master spec for a Quest 3S build whose code is **not here**; `DECISIONS.md` entries 1–11
describe it, and entry 12 explains what happened. Read both as doctrine, not description.

---

## Running it

```bash
npm ci
npm test       # purity + typecheck + 136 tests
npm run dev    # http://localhost:8081
```

### The rig

1. **DJI Osmo Pocket 3 over USB-C, in Webcam Mode.** It enumerates as a standard UVC device and
   appears in the camera dropdown. Any webcam works; `src/vision/camera.ts` is source-agnostic.
2. **Side-on, at board level, perpendicular to the cucumber's long axis.** Not overhead. A
   camera above a slice sees its *diameter*, never its height, so side-on is the only placement
   where the number the whole thing rests on is directly observed.
3. **Lock exposure and white balance on the device.** Highest-value two minutes here.
   Segmentation thresholds on saturation and classification matches on hue; auto-WB drifts both,
   so the app works in rehearsal and misclassifies under hall lights with no error anywhere.
4. **Light board, dark sleeves.** Produce separates from a light board on *saturation*, which is
   why a white board works however bright the room is. A bare forearm sits near hue 25, clears
   the saturation floor, and is long and convex — everything the stub test looks for. The hue
   gate exists to stop the app confidently measuring somebody's arm.
5. **Record one clean cut** to the SD card first. Drop the clip on the page and it plays through
   the identical pipeline, so tuning needs a file rather than a fresh cucumber every attempt.

### Tuning

Every threshold is a slider, grouped by what it affects, and overrides persist across reloads.
The first one to touch on arrival is **saturation floor**. Rebuilding to retune a number is how
you lose a day.

---

## How it works

```
camera ─► segment ─► hue gate ─► track ─► metrics ─► scoring ─► readout
         (OpenCV)                (pure)   (pure)     (pure)      chef · ticket · board
```

`src/core/**` imports no framework and touches no DOM. `npm run check:purity` fails the build if
that is ever violated. That constraint is what lets the cut-detection logic be tested against
synthetic frame sequences rather than against a cucumber — `src/core/track.test.ts` covers
occlusion recovery, depth drift, slice pose and the budget invariant with no camera in the loop.

| Module | Job |
|---|---|
| `src/vision/segment.ts` | The only file that touches OpenCV. Saturation threshold → contours → features |
| `src/core/ingredients.ts` | Classical HSV + shape classifier. No model, no network |
| `src/core/track.ts` | Stub tracking and cut detection. The module the demo rests on |
| `src/core/metrics.ts` | Slice records and the two-method cross-check |
| `src/core/scoring.ts` | §7.4 weights, and the plain-millimetre sentence |
| `src/core/barks.ts` | What the chef says, chosen from state. Pure, so it is testable |
| `src/core/recipes.ts` | Ten tickets, each with its own tolerance |
| `src/core/leaderboard.ts` | Ranking rules. Storage is the caller's problem |

### Cut detection

A cut is recorded only when a stub reading has held still for several consecutive frames, the
diameter says the stub shrank rather than moved, the change is plausible, and the books still
balance. Detection is **slow to confirm and cheap to miss**: a false cut is written into the
session permanently and corrupts both the mean and the sigma, while a missed cut merely fails to
render.

The gate that matters most is that **an increase is never a cut**. A hand resting still across
one end of the stub produces a perfectly *settled* short reading, which settling alone would
happily call a slice. Treating a later increase as a bad baseline rather than as a cut is what
makes occlusion a no-op.

---

## The chef

Three tiers, in this order:

1. A pre-generated ElevenLabs bank, decoded at load and played instantly.
2. The browser's own `speechSynthesis`.
3. Silence, with the line still on screen.

Tier 1 is only active with `VITE_ELEVENLABS_KEY` and `VITE_ELEVENLABS_VOICE` in the environment;
with no key the chef speaks through the browser and the game is unchanged. Venue wifi is
saturated, so the voice has to degrade rather than hang. Lines are chosen locally and instantly
either way — a round trip after every slice would put the reaction a second behind the knife.

The **intensity** slider runs Gentle Nonna to Full Service. It is an accessibility control and
the funniest one in the build.

The chop sound is synthesised rather than sampled: nothing to fetch, nothing to miss from a
build, and pitch is continuous, so the difference between a 5mm and a 6mm slice is audible.

---

## Honest limitations

- **Camera elevation is a bias, not noise.** A flat disc viewed from φ above the cutting plane
  has apparent height `t·cos φ + D·sin φ`, so at Ø42mm that is ~0.73mm per degree. Two degrees of
  tilt reads a 6mm slice as 7.5mm, consistently, with a beautiful-looking sigma. Get the lens on
  the cutting plane, and check it against something of known thickness left in frame.
- **The cucumber tapers**, so the in-scene scale drifts a few percent along its length. A slow
  bias of known sign, preferred to the silent step change a knocked tripod puts into a stored one.
- **~8fps at 720p.** Segmentation is pixel-bound at roughly 125ms per megapixel in WASM. See
  `DECISIONS.md` entry 15 for why the rate matters more here than the resolution.
- **`segment.ts` has no automated tests.** Its WASM will not initialise under Node, so it is
  verified in the browser instead — determinism across repeated runs and measured hues against
  the synthetic scene. This is the weakest link in the test story and it is worth saying so.

---

`CLAUDE.md` — master spec (a different build; see `DECISIONS.md` 12) ·
`DECISIONS.md` — every deviation, with the reasoning ·
`PHYSICS.md` — constants and derivations (covers the simulation that is no longer here)
