# Is It Done Yet — 10-Hour, 4-Person Split

**Date:** 2026-09-19 · **Budget:** 8–10 hours · **Team:** 2 software, 2 hardware
**Supersedes for scheduling purposes:** `2026-09-18-mise-24h-demo-spine.md`

`CLAUDE.md` is a 36-hour spec for a WebXR/IWSDK Quest build whose code is not in this
repository. Per `DECISIONS.md` entry 12 it is **doctrine, not description**. Its rules still
govern. Its architecture and its schedule do not. This document is the schedule.

---

## 1. Where the code actually is

Verified by running it, 2026-09-19.

| Branch | Tests | State |
|---|---|---|
| `main` (`46e66a8`) | 75 green | **Stale.** Three commits behind. Missing the entire headset app, OCR, chef audio, tracking, recipes, leaderboard. |
| `origin/OCR-OPCV` (`491b83c`) | **196 green** | The real work. `main` is a strict ancestor, so the merge is fast-forward. |

`typecheck` and `check:purity` pass on both.

**Nobody writes a line against `main` as it stands.** Merging is the first action of the
session and it is a fast-forward.

### What `OCR-OPCV` contains

Two tracks that were built in parallel and have very different readiness.

**Track A — the laptop measurement app. This is a working demo today.**
One camera, side-on at board level, watching a real cucumber on a light board.

```
camera ─► segment ─► hue gate ─► track ─► metrics ─► scoring ─► readout
         (OpenCV)                (pure)   (pure)     (pure)      chef · ticket · board
```

Thickness is measured **two independent ways from one frame** — `stub-delta` (axial, the
uncut remainder gets shorter) and `side-profile` (perpendicular, a slice seen edge-on). They
fail for unrelated reasons, `crossCheck` compares them, and a disagreement is *reported rather
than suppressed*. Scale comes from the cucumber's own diameter recomputed every frame, so a
knocked tripod self-corrects where a stored mm/px calibration would silently lie.

Also present and tested: chef barks with a three-tier voice fallback (ElevenLabs → browser
`speechSynthesis` → silent subtitles), synthesised chop audio with pitch continuous in
thickness, ten recipe tickets with per-ticket tolerances, leaderboard ranking, and a persisted
slider for every threshold.

**Track B — the Unity Quest MR app. Source only. There is no Unity project.**
~2,100 lines of good C# under `unity/Assets/Scripts/Perception/`: passthrough camera feed with
`AsyncGPUReadback`, pose-carrying frames, YOLOv8n via OpenCV DNN, Canny/contour document
detection, perspective rectification for OCR, Depth+MRUK raycasting, and an in-headset
thumbstick tuning panel.

What is **not** there: `ProjectSettings/`, `Packages/manifest.json`, any scene, any `.meta`
file, `StreamingAssets/yolov8n.onnx`. It has never been opened in Unity.

---

## 2. The two findings that shape the schedule

### Gate zero is obsolete, and that is good news

`CLAUDE.md` §3 budgets 15 minutes to test whether Quest Browser exposes passthrough to
`getUserMedia`, and calls the answer unverified. Track B does not use that door. It uses Unity
with `horizonos.permission.HEADSET_CAMERA` and Meta's `WebCamTextureManager` — the supported,
documented Passthrough Camera API, v74+. **Do not run gate zero. It tests a path we are not
taking.**

### The Quest cannot do knife work, and that settles "both, knife first"

`unity/README.md` states it plainly: COCO-80 contains ten foods — banana, apple, sandwich,
orange, broccoli, carrot, hot dog, pizza, donut, cake. **No cucumber.** There is no confidence
threshold that makes stock YOLOv8n weights find one; it would need fine-tuning we have no hours
for.

So the split is not a preference, it is a capability boundary:

| Discipline | Platform | Why |
|---|---|---|
| **Knife work** (hero beat) | **Laptop** | Already built, already measures real millimetres, already green |
| **Doneness / recipe card** | **Quest** | COCO-80 *does* have banana, apple, carrot, broccoli; OCR path is built |

That is exactly "both, knife first" — it just resolves onto two machines instead of one.

---

## 3. The blocker to resolve in the first 30 minutes

**`OpenCV for Unity` is a paid Asset Store package (~US$100).** Every file in
`unity/Assets/Scripts/Perception/` that matters — `PassthroughCameraFeed`, `YoloFoodDetector`,
`DocumentContourDetector`, `DocumentRectifier` — is built on its `Mat` and `dnn` types. Without
it, Track B does not compile at all.

Resolve it before anyone starts Unity setup, in this order:

1. Ask the HTN hardware/sponsor desk whether a license is available to hackers.
2. Check whether anyone on the team already owns it.
3. Buy it.
4. If none of the above: **Track B is cut.** Say so at H+0:30, not at H+6.

Deciding this late is the single most expensive mistake available today.

---

## 4. Assignments

`S1`/`S2` are the two software people, `H1`/`H2` the two hardware people. Track B work is
config, SDK installation, Android build settings and device bring-up — much closer to hardware
and tooling than to architecture, and the C# is already written. It is the right fit.

### H+0 to H+0:30 — everyone, before anything else

| Who | Task |
|---|---|
| Any one person | `git merge --ff-only origin/OCR-OPCV` on `main`, push. Then all four: `npm ci && npm test` → expect **196 green** |
| H2 | Devpost entry created, **all sponsor tracks selected**. This has a hard clock and is unrecoverable if missed |
| H1 | Resolve the OpenCV for Unity license question (§3). Report go/no-go to the team |

### Track A — S1 and S2, laptop. This is the demo that ships.

The app exists. The work is not building it, it is making it **survive a stranger under venue
lighting**. That is a different and less glamorous job, and it is where the points are.

**S1 — measurement truth.** Own the claim the whole pitch rests on: *a judge can put a ruler
against it.*

- Stand the rig up per `README.md` §"The rig": camera **side-on at board level**, light board,
  locked exposure and white balance. Lens elevation is a *bias, not noise* — at Ø42mm it is
  ~0.73mm per degree of tilt, so two degrees reads a 6mm slice as 7.5mm with a beautiful sigma.
  Get the lens on the cutting plane and leave something of known thickness in frame.
- Retune the saturation floor and hue windows **under actual hall lighting**.
  `src/core/ingredients.ts` says outright that its windows came from supermarket produce in
  mixed daylight and will shift under fluorescents.
- Cut a real cucumber. Confirm `stub-delta` and `side-profile` agree, and check both against a
  ruler. If they disagree, that is the bug, and it outranks every other task on this page.
- Record one clean cut to a file first, so tuning costs a replay rather than a fresh cucumber.
- Harden the failure paths: hand occluding the stub, a slice rolling out of frame, the tripod
  getting knocked.

**S2 — the 90-second improvement beat.** The highest-scoring thing that can happen in the
judging room is a judge measurably improving at a real skill in ninety seconds.

- Make the before/after readout unmissable: `6.1mm avg ±3.2mm` → they cut again → `±1.4mm`.
  Plain millimetres, never a score out of 100.
- Wire chef barks and chop audio to fire on the cut event with no perceptible delay. The
  modules are built and tested; this is integration, and instant reaction is the whole point.
- Session report with before/after, and the leaderboard on a second screen so a crowd forms.
- Set the intensity slider somewhere safe by default and make sure Gentle Nonna is reachable
  without a rebuild.

### Track B — H1 and H2, Quest. Bonus, gated, never on the critical path.

Follow `unity/README.md` §"Bring-up order" **exactly and in order**. Each step is checkable
alone; skipping ahead means debugging three subsystems at once.

**H1 — project and build.** Unity 6 or 2022.3 LTS → Meta XR Core SDK v74+ → MR Utility Kit →
OpenCV for Unity → copy `PassthroughCameraSamples` out of the Meta SDK samples → IL2CPP, ARM64,
Vulkan, Multiview → `horizonos.permission.HEADSET_CAMERA` and the passthrough feature in the
manifest → build an empty APK to the device.
**Checkpoint: a blank MR app runs on the headset.** Nothing else starts until this is true.

**H2 — device and model.** Developer mode, adb, sideload path proven. Export the model with
`yolo export model=yolov8n.pt format=onnx opset=12 imgsz=320` — `opset=12` is not optional,
OpenCV's importer fails on newer operators and points at the wrong layer. Drop it in
`Assets/StreamingAssets/`. Keep both headsets charged and tethered.

Then together, wire the scene per `unity/README.md` §5 and run bring-up steps 1–8.

**Hard gate at H+5.** Bring-up step 3 is *place a cube at a fixed world position and turn your
head; it must not move.* If it swims at H+5, the pose path is wrong and nothing downstream will
work. **Stop.** Track B becomes one slide and thirty seconds of narration, and both people move
to demo production. Do not spend hour six debugging it.

### H+6 onward — H2 rolls onto submission regardless of Track B

Demo video, README, Devpost write-up, and rehearsing the two-minute demo **out loud**. `P4 is
the role teams skip and it is why teams miss submission.`

---

## 5. The demo, two minutes

Rehearse it until it is muscle memory, and run it once end to end with wifi off.

| Time | Beat |
|---|---|
| 0:00–0:15 | Hand them the knife. No explanation. They cut a real cucumber |
| 0:15–0:45 | Their number appears: `6.1mm average, ±3.2mm`. The chef reacts. They laugh |
| 0:45–1:15 | They cut again. `±1.4mm, down from ±3.2`. **This is the beat everything else serves** |
| 1:15–1:35 | The honesty beat: two independent methods, agreeing to 0.2mm — and a ruler in frame |
| 1:35–1:50 | Quest station, *if it landed*: doneness on real food through passthrough |
| 1:50+ | Technical story: the pure core, 196 tests with no camera in the loop, the two methods and why disagreement is reported rather than hidden |

The technical story goes **last**. This audience is engineers; give them the architecture once
they already want it.

---

## 6. Risk register

| Risk | Severity | Mitigation | Owner |
|---|---|---|---|
| Work lost or duplicated against stale `main` | **Critical** | Fast-forward merge at H+0 | Any |
| OpenCV for Unity unlicensed | **Critical for B** | Decide by H+0:30, cut Track B if no | H1 |
| Venue lighting shifts hue windows | High | Retune on site with the live sliders; lock exposure and WB | S1 |
| Camera elevation biases every reading | High | Lens on the cutting plane; known-thickness reference in frame | S1 |
| Sponsor track deadline missed | **Unrecoverable** | H+0, before any code | H2 |
| Quest pose path swims | Medium | H+5 gate, then abandon | H1/H2 |
| Venue wifi saturated | Medium | Already handled — chef degrades to `speechSynthesis`, everything else is local | — |

---

## 7. Rules that still bind

From `CLAUDE.md` §17, unchanged by the pivot:

- #9 every network call gets a timeout and a fallback
- #11 every magic number gets a live slider — rebuilding to retune is how you lose a day
- #12 when ambiguous, pick what is more reliable in a live demo on bad wifi
- #14 cite every constant, or mark it `// TUNED, not sourced`
- #15 log every deviation in `DECISIONS.md`

And the one that decides the schedule: **vertical slices, never horizontal.** Track A is
shippable at every hour of the day. Track B is shippable only at the end, which is exactly why
it is nobody's critical path.
