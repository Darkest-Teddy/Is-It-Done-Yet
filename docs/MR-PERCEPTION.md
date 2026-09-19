# MR Perception — object detection and OCR on Quest 3 / 3S

How to see and read the real world from inside a mixed-reality app, what the pieces are, where
they go, and the specific things that will waste your day if nobody tells you about them.

Companion to `CLAUDE.md` §10 (Perception). Where this document and the master spec disagree, the
disagreement is recorded here and in `DECISIONS.md`.

**Contents**

1. [Gate Zero — can you even get a frame?](#1-gate-zero)
2. [The architecture, and why it is split this way](#2-architecture)
3. [The coordinate pipeline](#3-the-coordinate-pipeline)
4. [The OCR pipeline](#4-the-ocr-pipeline)
5. [File layout — what goes where](#5-file-layout)
6. [The XR adapter code](#6-the-xr-adapter-code)
7. [Implementation order](#7-implementation-order)
8. [Tuning](#8-tuning)
9. [Failure modes](#9-failure-modes)
10. [Verification](#10-verification)
11. [Honest limitations](#11-honest-limitations)

---

## 1. Gate Zero

**Nothing below matters until this passes. Budget 15 minutes. Do it first.**

WebXR has a `camera-access` feature descriptor. **Quest Browser does not implement it.** Every
tutorial that tells you to request it is describing an API you cannot have.

What does work is the ordinary **MediaDevices API**. On Horizon OS the passthrough cameras have
been exposed through Camera2 since v74, and `getUserMedia` reaches them. Different door, same
room. IWSDK's camera module is built on this, not on WebXR.

Put the headset on, open the app over LAN, and run:

```js
const devices = await navigator.mediaDevices.enumerateDevices();
console.log(devices.filter((d) => d.kind === 'videoinput').map((d) => d.label));

const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: 'environment', width: 1280, height: 960 },
});
const v = document.createElement('video');
v.srcObject = stream; v.autoplay = true; v.playsInline = true;
document.body.appendChild(v);
```

**PASS** — you see the room. Single-device architecture confirmed. Continue.

**FAIL** — you do not get a passthrough camera. Fall back to a **USB camera on a static stand**
pointed at the work surface. This is genuinely *easier*: a fixed camera means a fixed
homography instead of pose-synced unprojection, and §3 of this document mostly stops applying.
Nothing else in the design changes, because the app does not care where detections come from.

Two notes:

- The permission prompt appears **in-headset** and must be accepted. `CameraUtils.getDevices()`
  triggers it on first call. Do this during a menu or calibration step, never mid-demo.
- **Keep the guardian boundary enabled.** Disabling it in developer mode makes passthrough
  render as **black** in recordings and casts. Your demo video will be ruined and you will not
  find out until you play it back. Draw the guardian larger than the room instead.

### Quest 3 vs Quest 3S

Same software surface; both expose passthrough identically. The differences that matter:

| | Quest 3 | Quest 3S |
|---|---|---|
| Passthrough resolution | Higher | Lower |
| Depth sensor | **Yes** | No |
| Depth occlusion quality | Better, from real depth | Inferred only |
| Scene understanding | Both, via `planeDetection` / `meshDetection` | |

If you have a Quest 3, use it. The depth sensor improves occlusion of virtual labels by real
hands, which is the thing that most sells a label as being *on* an object rather than floating
in front of it.

---

## 2. Architecture

**The camera identifies, the headset places.** Two jobs with wildly different latency budgets.
Conflating them is what makes MR demos feel broken.

```
LAYER 1 — ON HEADSET, EVERY FRAME, 72-90Hz, ZERO NETWORK
  head pose ──────────► pose ring buffer (src/core/perception/poseRing.ts)
  plane detection ────► the table plane
  depth ──────────────► real hands occlude virtual labels
  render ─────────────► billboards at world-anchored positions
  Everything that must FEEL instant lives here.

        │ world-space plane + timestamped poses
        ▼
LAYER 2 — IDENTIFY AND READ, ~1Hz, OFF THE RENDER THREAD
  CameraUtils.captureFrame(entity) ──► HTMLCanvasElement, full resolution
      ├─► downscale to 640px ──► DETECTOR  ──► boxes + labels
      └─► crop at FULL RES    ──► OpenCV prep ──► Tesseract ──► strings
                                           │
  unproject (pose at capture time) ────────┤
  confirmation + hysteresis ───────────────┤
  text voting ─────────────────────────────┘
        │
        ▼
LAYER 3 — REACT, ~0.3Hz
  whatever the app does with a confirmed, read, world-placed object.
```

### Why the split works

A jar on a table does not move between frames. Your head does. So the head is tracked at 90Hz
locally, and the jar is identified at 1Hz by something slow. Once you split the world by *how
fast things move*, the latency problem dissolves — a two-second round trip still produces an
app that feels instantaneous, because nothing that had to feel instant was ever waiting on it.

### Non-negotiables

1. **Never block a render frame** on inference, OCR, or network. If you are about to `await`
   inside a system's `update()`, stop and restructure.
2. **The camera births entities, it does not hold them up.** Once identified and placed, an
   object is a normal world-anchored entity. Camera dies, wifi drops, a hand covers the table:
   everything stays exactly where it was.
3. **Every network call gets a timeout and a local fallback.** No exceptions.
4. **Confirmation and hysteresis before anything cosmetic.** Twenty lines, disproportionate
   payoff. Flicker is the single thing that makes a CV demo read as broken.

---

## 3. The coordinate pipeline

This is the part that is hard to debug on a headset, because every mistake looks like a
tracking problem. It is therefore the part that is written as pure functions and tested from a
terminal: `src/core/perception/unproject.ts`, 20 tests, no browser involved.

### The steps

```
detection box (normalised 0..1)
  └─► bottom-centre pixel
       └─► camera-space ray        pixelToCameraRay()
            └─► world-space ray    pixelToWorldRay()   ← needs the pose AT CAPTURE TIME
                 └─► table hit     intersectPlane()
                      └─► world position
```

`boxToWorld()` does all four.

### Why the bottom-centre pixel

Master spec §10.1 step 1, and the reason is worth internalising: the bottom edge of the box is
where the object **meets the table**, so it is the one point on the box that actually lies in
the plane you are intersecting. The centre of the box floats inside the object and projects to
a point *beyond* it by roughly half its height — for a jar, several centimetres of consistent
forward bias that no amount of smoothing removes.

### Intrinsics

```
fx = (widthPx / 2) / tan(fovX / 2)      fy = fx (square pixels)
cx = widthPx / 2                        cy = heightPx / 2
```

Image y increases **downward**, camera y increases **upward**, so the y term is negated exactly
once. Doing it twice, or not at all, mirrors every placement about the horizon.

`fovX` is a **calibrated** quantity, not a spec sheet number. Put it on a debug slider. So is
`CAM_OFFSET` — the passthrough camera is not at your eye, it is a few centimetres out and
forward, and ignoring that puts everything off by that much *in a direction that rotates with
your head*, which reads as drift rather than offset and sends people hunting a tracking bug.

### The pose ring buffer — the step everyone gets wrong

Master spec §10.1 step 4 calls this "the most commonly botched step" and it is right.

Your detection was captured at T. It comes back at T+800ms. By then your head has moved. Using
the **current** pose produces placements that are correct while you hold still and swim when you
turn — which looks exactly like bad tracking, so people go and tune the wrong thing for an hour.

So: record a pose every render frame, look it up by capture timestamp.

```ts
// every frame
poses.push({ t: performance.now(), position, orientation });

// when a detection comes back
const pose = poses.at(captureTimestamp);
if (pose === null) return;           // older than the buffer — DROP IT, do not clamp
const world = boxToWorld(intrinsics, pose, detection.box, tablePlane);
```

`PoseRing.at()` interpolates between the two samples that bracket the time, with **slerp** for
orientation including the shortest-arc sign fix. A quaternion and its negation are the same
rotation, so two samples a millisecond apart can arrive with opposite signs; interpolating
without flipping takes the long way round the sphere and the head appears to spin almost all the
way about and back inside one frame. It surfaces as an occasional wildly misplaced detection and
nothing else.

**`at()` returns null rather than clamping** when the time is outside the buffer. This is
deliberate: the oldest pose you still hold is not an approximation of the right answer, it is a
different answer. Dropping the detection loses one label. Clamping puts a label in the wrong
place and gives no sign that it guessed.

### Getting a better capture timestamp

`performance.now()` at the moment you call `captureFrame()` is **not** when the frame was taken.
`captureFrame` copies whatever the `<video>` currently shows, which is the most recently
*decoded* frame — a frame or two old, 10–30ms on Quest.

Use `HTMLVideoElement.requestVideoFrameCallback()`, which Quest Browser supports (it is
Chromium):

```ts
video.requestVideoFrameCallback((now, meta) => {
  // meta.presentationTime is on the same clock as performance.now()
  lastFrameTime = meta.presentationTime;
});
```

Then stamp captures with `lastFrameTime`. `PoseRing` interpolates to whatever instant you hand
it, so this costs nothing and removes a systematic error.

### Getting the head pose

In an XR session, read it off the XR camera rather than the scene camera, and always via the
world helpers — `player` is an `XROrigin` and things parented under it are in rig-local space,
not world space. A raw `.position` read here is a frame-of-reference bug that looks plausible.

```ts
const cam = this.renderer.xr.isPresenting
  ? this.renderer.xr.getCamera()
  : this.camera;
cam.getWorldPosition(tmpPos);
cam.getWorldQuaternion(tmpQuat);
```

### Getting the table plane

`iwsdk.config.json` must enable it:

```json
{ "world": { "xr": { "features": { "planeDetection": true, "anchors": true } },
             "features": { "sceneUnderstanding": true } } }
```

`SceneUnderstandingSystem` then creates entities carrying the `XRPlane` component. Pick the
largest roughly-horizontal one near table height, or let the user tap to confirm. Fall back to a
fixed plane at a measured height — a fixed plane that is right is better than a detected plane
that is wrong, and §12's rule about reliability applies.

---

## 4. The OCR pipeline

**Most of your OCR accuracy comes from image processing, not from the OCR engine.** Tesseract on
a raw passthrough frame reads close to nothing. Tesseract on a deskewed, upscaled,
contrast-normalised crop of a single label reads it reliably. The work is all in the middle.

```
full-res frame (HTMLCanvasElement, e.g. 1280x960)
  ├─► downscaleForDetection(640px) ─► DETECTOR ─► text-bearing boxes
  │                                                    │
  └────────────────────────────────────────────────────┤
                                                       ▼
                                          prepareCrop()  ← cuts from the FULL-RES frame
                                            1. crop + pad         (boxToRect)
                                            2. greyscale
                                            3. deskew             (estimateSkewDeg + warpAffine)
                                            4. CLAHE
                                            5. upscale to ~32px x-height  (upscaleFactor)
                                            6. (adaptive threshold — usually OFF)
                                                       │
                                                       ▼
                                          Tesseract, PSM.SINGLE_LINE
                                                       │
                                                       ▼
                                          castVote() across frames ─► verdict()
```

### Rule 1: crop from the full-resolution frame

The detector gets a 640px copy because a detector does not need more. **OCR needs every pixel
there is.** Cropping a 120×40 region out of the *downscaled* copy and upscaling it 4× is
upscaling something already thrown away. It produces a plausible-looking blurry crop and reads
as gibberish, and it is the single easiest way to lose the entire feature while believing it is
implemented.

`downscaleForDetection()` deliberately returns a **separate canvas** so the original survives.

### Rule 2: do not over-process

Tesseract runs its own Otsu binarisation internally and is good at it. Handing it an
already-binarised image usually makes things **worse**, because any threshold you apply is
applied with less information than Tesseract has.

Give it a clean, large, well-exposed **greyscale** image and stop. Binarise only when lighting
across the crop is genuinely uneven — a headset shadow falling across half a label — and then
use an **adaptive** threshold, never a global one. `binarize` is `false` by default for exactly
this reason.

### Rule 3: size is the dominant variable

Tesseract is trained on roughly 300dpi scans. Accuracy falls off a cliff below about **20px
x-height** and plateaus around **30–40px**. Passthrough text at arm's length is routinely 8–12px.

`upscaleFactor()` estimates x-height as half the crop height and scales to hit `targetTextPx`
(32 by default), capped at 4×. Beyond that the interpolation is inventing detail slowly.

Use `INTER_CUBIC` for the upscale. `INTER_LINEAR` is softer and Tesseract wants crisp stroke
edges more than it wants smooth gradients.

### Rule 4: tell it what it is looking at

`PSM` (page segmentation mode) matters more than any other Tesseract setting.

| PSM | Use for |
|---|---|
| `AUTO` (3, default) | A page of text. **Wrong for crops** — layout analysis frequently decides a 200×60 label contains no text at all |
| `SINGLE_LINE` (7) | One line of text. **The default here** |
| `SINGLE_WORD` (8) | One word |
| `SINGLE_BLOCK` (6) | A multi-line label |

And whitelist the alphabet when you know the target:

```ts
reader.read(crop, { charWhitelist: '0123456789.%gkGK', psm: PSM.SINGLE_LINE });
```

Reading a weight, a temperature, an expiry date? Whitelisting digits removes whole classes of
confusion at a stroke. It is the cheapest accuracy available and it is usually left on the table.

### Rule 5: vote across frames

Detection flickers in *confidence*. OCR flickers in *content*. The same label read six times
comes back as six slightly different strings, and picking any one is picking at random.

But a printed label **does not change**. Every read is a noisy sample of one fixed answer, so
accumulate evidence instead of trusting the latest frame.

`textVote.ts` buckets reads by a **folded** key that collapses exactly the glyph pairs OCR
actually confuses (`O/0/Q/D`, `I/1/l/T`, `S/5`, `B/8/R`, `Z/2`, `G/6`), then commits only when
one bucket has both enough absolute weight *and* a margin over the runner-up:

```
"MILK 2%" 0.8 ─┐
"MlLK 2%" 0.7 ─┼─► fold ─► "M11K2" ─► weight 2.6 ─► verdict "MILK 2%"
"M1LK 2%" 0.6 ─┤                                     (best-supported raw spelling)
"MILK Z%" 0.5 ─┘
```

Without folding, those four reads split the vote four ways and never reach a margin. With it
they reinforce each other. **The fold is only ever a grouping key** — what gets displayed is the
best-supported raw spelling, so nobody sees `M11K2`.

The margin rule mirrors `identify()` in `src/core/ingredients.ts`: two candidates that are close
together mean the reads genuinely do not separate them, and a label that flips between two
spellings frame to frame reads as the system being broken rather than as the system being
unsure. **`verdict()` returning null is a real answer** — render it as an ellipsis or a dimmed
placeholder, not as the current best guess.

### Choosing a detector

You need something to tell you *where* the text is. Options, in order of how much of your
remaining time they cost:

| Option | Latency | Offline | Notes |
|---|---|---|---|
| **Cloud VLM** (Gemini etc.) | 0.8–2s | No | Returns labels, boxes and often the text itself. Highest quality, simplest code. Needs a timeout and a fallback |
| **Tesseract alone, whole frame** | 1–3s | Yes | No detector at all. Works if there is one obvious label; poor with clutter |
| **OpenCV MSER / EAST** | 50–200ms | Yes | Classical text-region detection. `@techstark/opencv-js` has MSER. Decent, fiddly |
| **ONNX detector in a worker** | 100–300ms | Yes | Best offline quality, most setup |

**Recommendation with limited time: cloud VLM as primary, Tesseract-on-whole-frame as the
offline fallback.** Put both behind one `VisionProvider` interface so switching is a dropdown,
not a refactor — and demoing that switch with a live latency readout is itself a good beat.

---

## 5. File layout

The governing rule, already enforced in this repo by `npm run check:purity`:

> **`src/core/**` imports no framework and touches no DOM.** Plain functions over plain data.

That is what makes the coordinate pipeline and the voting logic testable from a terminal, which
matters enormously here — a sign error in unprojection is nearly impossible to diagnose while
wearing a headset, and trivial to catch in a unit test.

```
src/
├── core/perception/              PURE. No DOM, no WebXR, no WASM, no network.
│   ├── types.ts                  Vec3, Quat, Pose, Box, Detection, TextRegion, Plane
│   ├── unproject.ts              pixel → ray → plane. Quaternion helpers
│   ├── poseRing.ts               timestamped pose buffer, slerp lookup
│   ├── tracking.ts               §10.2 confirmation + hysteresis
│   ├── textVote.ts               OCR consensus
│   ├── crop.ts                   box → pixel rect, padding, upscale factor
│   └── *.test.ts                 60 tests, no browser
│
├── vision/                       Adapters that touch OpenCV and the DOM.
│   ├── segment.ts                (existing) saturation segmentation
│   ├── ocrPrep.ts                crop + deskew + CLAHE + upscale
│   ├── ocr.ts                    Tesseract worker wrapper
│   └── camera.ts                 (existing) getUserMedia, FrameGrabber
│
├── perception/providers/         Network adapters, one interface.
│   ├── VisionProvider.ts         interface + Detection/TextRegion contract
│   ├── GeminiProvider.ts         cloud VLM
│   ├── LocalProvider.ts          Tesseract-only, offline
│   └── NullProvider.ts           deterministic stub for tests and demos
│
└── xr/                           IWSDK. Only in the IWSDK project.
    ├── CameraRig.ts              spawn the CameraSource entity, permissions
    ├── PoseRecorder.ts           feed the ring every frame
    ├── PerceptionSystem.ts       the ~1Hz loop
    ├── TablePlane.ts             pick the table from XRPlane entities
    └── LabelBillboard.ts         render a confirmed, read object
```

**`src/core/perception/` is portable as-is.** It has no dependencies. Copy the directory into
the IWSDK project and it works there unchanged — that is the whole point of the purity rule.

---

## 6. The XR adapter code

These are the files that touch IWSDK. They are not in this repo because `@iwsdk/core` is not
installed here; drop them into the IWSDK project at the paths above.

API verified against `@iwsdk/core@0.5.3`:

```ts
CameraUtils.getDevices(refresh?: boolean): Promise<CameraDeviceInfo[]>   // triggers permission
CameraUtils.findByFacing(devices, facing): CameraDeviceInfo | null
CameraUtils.hasPermission(): Promise<boolean>
CameraUtils.captureFrame(entity: Entity): HTMLCanvasElement | null       // FULL resolution
CameraFacing = { Back: 'back', Front: 'front', Unknown: 'unknown' }
CameraState  = { Inactive, Starting, Active, Error }
CameraSource // component: deviceId, facing, width, height, frameRate, state,
             //            texture (VideoTexture), videoElement, stream
```

A system instance exposes `world`, `player` (XROrigin), `camera` (PerspectiveCamera), `scene`,
`renderer`, `input`, `xrManager`.

### `src/xr/CameraRig.ts`

```ts
import { CameraFacing, CameraSource, CameraState, CameraUtils, type Entity } from '@iwsdk/core';

/**
 * Creates the entity that owns the passthrough stream.
 *
 * getDevices() is what triggers the in-headset permission prompt, so call this during a menu
 * or calibration step. Doing it lazily on the first detection puts a modal dialog in front of
 * a judge mid-demo.
 */
export async function createCameraEntity(world: World): Promise<Entity | null> {
  const devices = await CameraUtils.getDevices();
  if (devices.length === 0) return null;

  // Back = the world-facing passthrough cameras. Falling back to the first device is fine on
  // a headset (there is no selfie camera) and wrong on a laptop, where it picks the webcam.
  const device = CameraUtils.findByFacing(devices, CameraFacing.Back) ?? devices[0];

  const entity = world.createTransformEntity();
  entity.addComponent(CameraSource, {
    deviceId: device.deviceId,
    facing: CameraFacing.Back,
    width: 1280,
    height: 960,
    frameRate: 30,
  });
  return entity;
}

export function cameraReady(entity: Entity): boolean {
  return entity.getValue(CameraSource, 'state') === CameraState.Active;
}
```

### `src/xr/PoseRecorder.ts`

```ts
import { createSystem, Quaternion, Vector3 } from '@iwsdk/core';
import { PoseRing } from '../core/perception/poseRing.js';

const pos = new Vector3();
const quat = new Quaternion();

/**
 * Records a head pose every frame. Runs early, does almost nothing, and is the reason
 * unprojection is correct.
 *
 * The XR camera, not the scene camera: during a session the pose lives on the ArrayCamera that
 * WebXRManager maintains. And getWorld* rather than .position, because anything parented under
 * the XROrigin is in rig-local space -- a raw read there is a frame-of-reference bug that looks
 * entirely plausible until you move the rig.
 */
export class PoseRecorder extends createSystem({}, {}) {
  readonly poses = new PoseRing(180);   // two seconds at 90Hz

  override update(): void {
    const cam = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera()
      : this.camera;
    cam.getWorldPosition(pos);
    cam.getWorldQuaternion(quat);
    this.poses.push({
      t: performance.now(),
      position: { x: pos.x, y: pos.y, z: pos.z },
      orientation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
    });
  }
}
```

### `src/xr/PerceptionSystem.ts`

```ts
import { CameraSource, CameraUtils, createSystem } from '@iwsdk/core';

import { boxToWorld } from '../core/perception/unproject.js';
import { castVote, emptyVote, verdict, type VoteState } from '../core/perception/textVote.js';
import { emptyTracker, ingest, liveTracks, type TrackerState } from '../core/perception/tracking.js';
import type { Intrinsics, Plane } from '../core/perception/types.js';
import { downscaleForDetection, prepareCrop } from '../vision/ocrPrep.js';
import { createOcrReader } from '../vision/ocr.js';

const CAPTURE_INTERVAL_MS = 1000;

/**
 * The ~1Hz loop. Everything expensive happens here and NOTHING is awaited.
 *
 * `update()` must return in microseconds. It decides whether to start a capture and returns;
 * the capture's continuation lands whenever it lands, on a later frame, and mutates state the
 * renderer reads. That is the whole discipline -- master spec rule #10 -- and it is why there
 * is an `inFlight` flag rather than an await.
 */
export class PerceptionSystem extends createSystem({}, {}) {
  private lastCapture = 0;
  private inFlight = false;
  private tracker: TrackerState = emptyTracker();
  private votes = new Map<string, VoteState>();
  private readonly ocr = createOcrReader();

  // Injected by the app: the camera entity, the pose ring, the table, the lens.
  cameraEntity!: Entity;
  poses!: PoseRing;
  table!: Plane;
  intrinsics!: Intrinsics;
  provider!: VisionProvider;

  override update(): void {
    const now = performance.now();
    if (this.inFlight || now - this.lastCapture < CAPTURE_INTERVAL_MS) return;
    this.lastCapture = now;
    void this.capture();          // deliberately not awaited
  }

  private async capture(): Promise<void> {
    this.inFlight = true;
    try {
      const frame = CameraUtils.captureFrame(this.cameraEntity);
      if (frame === null) return;

      // The timestamp the pose lookup will use. presentationTime from
      // requestVideoFrameCallback is better than now(); see section 3.
      const captureT = this.frameTime();

      const small = downscaleForDetection(frame, 640);
      const result = await Promise.race([
        this.provider.detect(small),
        timeout(2500),
      ]);
      if (result === null) return;

      const pose = this.poses.at(captureT);
      if (pose === null) return;   // older than the buffer; drop rather than guess

      // --- placement -------------------------------------------------------
      const sightings = [];
      for (const d of result.detections) {
        const world = boxToWorld(this.intrinsics, pose, d.box, this.table);
        if (world === null) continue;
        sightings.push({ label: d.label, position: world, confidence: d.confidence });
      }
      this.tracker = ingest(this.tracker, sightings);

      // --- reading ---------------------------------------------------------
      // Crops come from `frame`, the FULL-RES canvas, never from `small`.
      for (const region of result.textRegions) {
        const crop = prepareCrop(frame, region.box);
        if (crop === null) continue;
        const reads = await this.ocr.read(crop.canvas);
        const key = this.regionKey(region, pose);
        let state = this.votes.get(key) ?? emptyVote();
        for (const r of reads) state = castVote(state, r.text, r.confidence);
        this.votes.set(key, state);
      }
    } catch (error) {
      console.warn('[perception] capture failed:', error);
    } finally {
      this.inFlight = false;
    }
  }

  /** What the renderer draws: confirmed objects, with their agreed text if there is one. */
  labels() {
    return liveTracks(this.tracker).map((t) => ({
      ...t,
      text: verdict(this.votes.get(t.id) ?? emptyVote())?.text ?? null,
    }));
  }
}

const timeout = (ms: number) =>
  new Promise<null>((r) => setTimeout(() => r(null), ms));
```

**Note the key question left open:** `regionKey()` decides which votes belong to the same
physical label. The robust answer is to unproject each text region the same way as detections
and associate by world position (reuse `tracking.ts`); the quick answer is to associate a text
region to whichever tracked object's box contains it. Do the quick one first.

### `iwsdk.config.json`

```json
{
  "world": {
    "xr": {
      "mode": "ar",
      "offer": "always",
      "features": {
        "handTracking": true,
        "anchors": true,
        "planeDetection": true,
        "meshDetection": true,
        "hitTest": true
      }
    },
    "features": { "sceneUnderstanding": true, "environmentRaycast": true }
  }
}
```

---

## 7. Implementation order

Each step leaves something you can look at. Do not start the next until the current one runs.

| # | Step | Time | Done when |
|---|---|---|---|
| 0 | **Gate Zero** (§1) | 15m | You see the room in a `<video>` in-headset |
| 1 | `CameraRig` + show the feed on a quad | 30m | Passthrough frames render inside the app |
| 2 | `PoseRecorder` + ring buffer | 20m | `poses.at(t)` returns sane values in a debug readout |
| 3 | Table plane, or a fixed fallback | 30m | A debug quad sits on the real table |
| 4 | `NullProvider` returning one fake box | 20m | A marker appears at a fixed world spot and **stays put when you turn your head** |
| 5 | Real detector behind `VisionProvider` | 45m | Real objects get markers |
| 6 | `tracking.ts` wired in | 20m | Markers stop flickering |
| 7 | `ocrPrep` + `ocr` on the largest region | 45m | A label's text appears, badly |
| 8 | `textVote` wired in | 20m | The text stops rewriting itself |
| 9 | Calibrate `fovX` and `CAM_OFFSET` on sliders | 30m | Markers land where the objects are |

**Step 4 is the real gate.** A marker that stays put when you turn your head means the whole
coordinate pipeline is correct. If it swims, you have a pose-sync bug and nothing downstream
will work. Do not proceed past it.

---

## 8. Tuning

Every one of these goes on a live slider (master spec rule #11). Rebuilding to the headset to
change a threshold is how you lose a day.

| Knob | Default | Effect |
|---|---|---|
| `fovXDeg` | ~80 | Calibrate. Too small pulls placements toward centre |
| `CAM_OFFSET` | ~(0, 0, -0.05) | Calibrate. Wrong value reads as drift when you turn |
| `spawnConfirmFrames` | 3 | Higher = slower to appear, fewer false labels |
| `despawnMissFrames` | 5 | Higher = labels survive occlusion longer |
| `assocRadiusM` | 0.08 | Too small spawns duplicates; too large merges neighbours |
| `emaAlpha` | 0.3 | Lower = smoother, laggier |
| `targetTextPx` | 32 | **The most impactful OCR knob.** Below 20 accuracy collapses |
| `padFrac` | 0.12 | Too tight loses ascenders and first characters |
| `psm` | `SINGLE_LINE` | `SINGLE_BLOCK` for multi-line labels |
| `minWeight` / `minMargin` | 1.2 / 1.5 | Higher = slower to commit, less flip-flopping |
| `CAPTURE_INTERVAL_MS` | 1000 | Lower costs battery and heat for little gain |

---

## 9. Failure modes

Ranked by how much time they cost before you find them.

| Symptom | Cause | Fix |
|---|---|---|
| Labels swim when you turn your head | Used the **current** pose, not the capture pose | The whole of §3 |
| Placements mirrored about the horizon | Image-y negated twice or not at all | `pixelToCameraRay` |
| Everything offset, and the offset rotates | `CAM_OFFSET` wrong or added without rotating | `compose()`, not vector addition |
| Occasional wildly wrong placement | Quaternion sign flip in interpolation | Shortest-arc slerp |
| Labels blink | No hysteresis | `tracking.ts` |
| Text rewrites itself constantly | No voting | `textVote.ts` |
| OCR returns gibberish | Cropped from the **downscaled** frame | Crop from full res |
| OCR returns nothing at all | PSM `AUTO` on a small crop | `PSM.SINGLE_LINE` |
| OCR works on big text, fails on small | Below Tesseract's x-height floor | Raise `targetTextPx` |
| Multi-second stall on first read | Worker created lazily | Create it at startup |
| Frame rate collapses | Awaiting inference in `update()` | Fire-and-forget |
| Passthrough is black in recordings | Guardian disabled | Re-enable it |
| Nothing works, no errors | Backgrounded tab freezes rAF | Foreground the window |

---

## 10. Verification

**Without a headset** — `npm test`. 60 tests cover the coordinate pipeline, pose interpolation,
hysteresis and voting. This is where sign errors and off-by-ones get caught, and it is why the
purity rule exists.

**With a headset**, in order:

1. Put a marker at a **fixed world position** and turn your head. It must not move. This is the
   single most informative test in the project.
2. Put a marker at a detected object and walk around it. It must stay on the object.
3. Measure a known distance between two placed markers against a tape measure. Tunes `fovX`.
4. Hold a label at 20cm, 40cm, 60cm. Record where OCR stops working. That distance is your real
   working range — state it rather than discovering it in front of a judge.
5. **Turn off the wifi and run the whole thing.** Every cloud path must degrade, not hang.

---

## 11. Honest limitations

- **Passthrough is not a good camera.** Quest passthrough is optimised for latency and comfort,
  not for resolution or colour fidelity. Expect to read a jar label at 30cm, not fine print, and
  not an ingredients list. Design the demo around large text.
- **One camera gives you no depth for placement.** Everything is projected onto an assumed
  plane. An object not on that plane is placed wrong, by more the further off it is. The Quest
  3's depth sensor can improve this; the 3S cannot.
- **A few centimetres of error is normal and usually fine.** Master spec §10.1 says so
  explicitly: do not over-engineer this when the output is a glowing ring. It stops being fine
  the moment you print a number in millimetres.
- **Cloud detection means the demo depends on wifi** unless the offline path is genuinely
  exercised. Rehearse in airplane mode at least once.
- **Tesseract is a document OCR engine.** It is being used off-label on scene text, and the
  preprocessing in `ocrPrep.ts` is what closes most of that gap. Angled, curved, or low-contrast
  text will still fail. A cloud VLM is markedly better at scene text if the network allows it.

---

`CLAUDE.md` §10 — the master spec's perception section ·
`DECISIONS.md` — deviations and why ·
`src/core/perception/` — the pure, tested half
