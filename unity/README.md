# Quest 3 / 3S MR Perception — Unity + OpenXR + OpenCV for Unity

Food detection (YOLOv8n via OpenCV DNN) and document/screen detection (Canny + contours),
raycast onto real geometry via the Depth API and MRUK, on a Snapdragon XR2 Gen 2.

```
Assets/Scripts/Perception/
├── DetectionTypes.cs           structs, and the pose-carrying frame
├── CameraPermissions.cs        HEADSET_CAMERA at runtime -- without it, black frames
├── PassthroughCameraFeed.cs    WebCamTexture → GPU downscale → AsyncGPUReadback → Mat
├── YoloFoodDetector.cs         ONNX inference, YOLOv8 output parsing, NMS
├── DocumentContourDetector.cs  Canny → dilate → contours → 4-point quads
├── DetectionRaycaster.cs       2D pixel → world ray → Depth/MRUK hit → placement
├── DocumentRectifier.cs        4 corners -> flat page, the OCR input
├── DetectionVisualizer.cs      runtime wireframe box, so no prefab authoring needed
├── IVisionProvider.cs          identify-what-it-is seam, + offline fallback
├── OpenAiVisionProvider.cs     GPT vision, via a key-holding relay
├── PerceptionTunables.cs       every threshold, one registry, persisted
├── PerceptionDebugUI.cs        in-headset tuning panel + live edge view
└── MRPerceptionManager.cs      threading, tracking, prefab lifecycle
```

---

## Setup

### 1. Packages

| Package | Why |
|---|---|
| **Meta XR Core SDK** v74+ | Passthrough Camera API. Nothing here works below v74 |
| **Meta MR Utility Kit (MRUK)** | Scene model raycasting and semantic labels |
| **OpenCV for Unity** (asset store) | DNN + imgproc |
| **Unity 2022.3 LTS or 6** with OpenXR | |

Copy `PassthroughCameraSamples` out of the Meta XR Core SDK samples into your project — that is
where `WebCamTextureManager`, `PassthroughCameraUtils` and `PassthroughCameraEye` live.

### 2. Android manifest

The passthrough camera needs a Horizon-specific permission that is **not** covered by the normal
Android camera permission:

```xml
<uses-permission android:name="horizonos.permission.HEADSET_CAMERA" />
<uses-feature android:name="com.oculus.feature.PASSTHROUGH" android:required="true" />
```

Request it at runtime before enabling the feed. Without it `WebCamTexture` starts and delivers
black frames — no exception, no log line.

### 3. Player settings

- **IL2CPP**, ARM64 only
- **Graphics API: Vulkan** (OpenGLES3 works; Vulkan handles the async readback better)
- **Multiview** stereo rendering
- Scene understanding enabled in the OVR Manager, with **Scene Support** and **Passthrough
  Support** set to Required

### 4. The model

```bash
pip install ultralytics
yolo export model=yolov8n.pt format=onnx opset=12 imgsz=320
```

`opset=12` matters — OpenCV's ONNX importer chokes on some newer opset operators with an error
that points at the wrong layer. Put `yolov8n.onnx` in `Assets/StreamingAssets/`.

### 5. Scene wiring

```
[Perception]
├── PassthroughCameraFeed        ← WebCamTextureManager, eye, 320x240, 5 Hz
├── DetectionRaycaster           ← EnvironmentRaycastManager reference
└── MRPerceptionManager          ← feed, raycaster, both prefabs, model path
```

---

## The four things that actually matter

### 1. Never read back the full frame synchronously

`Utils.webCamTextureToMat()` is one line and costs **8–20ms on the render thread** at 1280×960,
because underneath it is `GetPixels32()` — a blocking GPU→CPU stall. The budget at 72Hz is
13.9ms total.

`PassthroughCameraFeed` instead blits to a 320×240 RenderTexture (GPU-side, nearly free) and
uses `AsyncGPUReadback`. Render-thread cost drops to well under a millisecond. The price is
1–3 frames of latency, which is handled by point 2.

### 2. Carry the camera pose with the pixels

Between the shutter and a usable detection you spend a readback (1–3 frames) plus inference
(40–90ms). At 72Hz with a head turning at a modest 60°/s that is **6–10° of rotation**, which at
one metre is **10–17cm of placement error**.

Unproject using the pose from *capture time*, never the live pose. `CapturedFrame` exists to
make the mistake unavailable. The symptom if you get it wrong is holograms that sit still while
you hold still and swim when you turn — which reads as broken tracking, so people spend an hour
tuning the wrong subsystem.

### 3. YOLOv8's output is transposed and has no objectness

```
YOLOv5:  [1, 25200, 85]   rows are detections; 85 = 4 box + 1 objectness + 80 classes
YOLOv8:  [1, 84, 8400]    TRANSPOSED; 84 = 4 box + 80 classes, NO objectness
```

Nearly every OpenCV-DNN tutorial online is written for v5. Applying v5 parsing to a v8 model
does not throw — it yields a few garbage boxes at low confidence, which reads as "the model is
bad" and sends people off to retrain something that was fine.

Also: pull the whole tensor out with **one** `Mat.get(0, 0, float[])`. Reading it element by
element is ~700k marshalled interop calls per frame and costs more than the inference.

### 4. Inference goes on a background thread

One thread, not a pool: an OpenCV `Net` is not re-entrant, and two concurrent inferences on a
4-big-core mobile chip finish at the same time as each other, twice as late, having also evicted
the render thread from cache.

**Copy the Mat before handing it across.** The feed reuses its buffer every capture, so passing
the original means it is overwritten mid-read — a race that produces occasional torn detections
and is essentially impossible to reproduce on demand.

Raycasting stays on the main thread because MRUK and the Depth API are Unity APIs. That is fine;
it is a handful of rays.

---

## Depth API vs MRUK

They answer different questions and the code uses both:

| | `EnvironmentRaycastManager` | `MRUK` |
|---|---|---|
| Casts against | Live depth map | Scanned scene model |
| Hits arbitrary objects | **Yes** — a bowl, a banana | No — only scanned furniture |
| Stability | Noisier, esp. small/shiny objects | Rock solid |
| Semantic label | No | **Yes** (`TABLE`, `WALL_FACE`…) |
| Hardware | Quest 3 / 3S | Any, after room setup |

Depth first for the object, MRUK as fallback and for a clean surface normal. Depth alone gives
you a position with an unreliable normal on small objects; MRUK alone cannot see the food.

---

## Performance budget

At 72Hz you have **13.9ms** per frame. Target roughly:

| Stage | Cost | Thread |
|---|---|---|
| Blit + readback request | <0.5ms | Render |
| Readback callback + Mat copy | ~2ms | Main |
| YOLOv8n @ 320 | 40–90ms | **Worker** |
| Contours @ 320×240 | 3–6ms | Worker |
| Raycast + placement | <1ms | Main |

Detection therefore runs at **3–5Hz**, and tracking + smoothing carry the hologram between
detections. That is not a compromise — a bowl on a table does not move, so identifying it at 5Hz
and rendering it at 72Hz is the correct split.

Other levers, roughly in order of value:

- Drop `processWidth` to 256 before dropping the model's `imgsz`
- `OVRManager.fixedFoveatedRenderingLevel = HighTop` — GPU headroom for free in MR
- Turn the camera feed **off** when not detecting; it costs 10–15% CPU just being on
- Enable Application SpaceWarp if you dip below target
- Reuse every Mat (this code does). A GC pause during a head turn is very noticeable

---

## Known limitations

- **COCO-80 has ten foods**: banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza,
  donut, cake. No onion, pepper, garlic, cucumber, or anything raw and unprepared. If you need
  those you must fine-tune — there is no configuration that makes the stock weights find them.
- **Quest 3S has no depth sensor.** `EnvironmentRaycastManager` still functions but is inferred
  rather than measured, so placement on small objects is noticeably worse. MRUK fallback matters
  more there.
- **Passthrough is a low-fidelity camera.** It is optimised for latency and comfort, not
  resolution or colour. Detection works well at 0.3–1.5m and degrades fast beyond that.
- **Document detection is geometric, not semantic.** It will happily find a laptop lid, a
  picture frame, or a rectangular tabletop. Filter by size and by MRUK label if that matters.
- **API surface is version-sensitive.** `PassthroughCameraUtils.GetCameraPoseInWorld`,
  `GetCameraIntrinsics`, and `EnvironmentRaycastHit.normalConfidence` have all moved between
  Meta SDK versions. If a name does not resolve, check the `PassthroughCameraSamples` source in
  your installed SDK — it is the authority, not any document including this one.

---

## Bring-up order

Do these in order. Each one is checkable on its own, and skipping ahead means debugging three
things at once.

1. Passthrough camera permission granted, `WebCamTexture` playing, non-black
2. Feed blitting and reading back — draw the Mat to a debug RawImage
3. **Place a cube at a fixed world position and turn your head. It must not move.** This is the
   single most informative test here; if it swims, the pose path is wrong and nothing downstream
   will work
4. `NullProvider`-style fake detection at a fixed pixel → cube lands on the real table
5. Contour detector on a sheet of paper (easier than YOLO, no model to load)
6. YOLO on a banana
7. Tracking and smoothing
8. Tune thresholds on-device with a debug UI, not by rebuilding

---

## OCR: reading the documents you detect

Detecting a page and not reading it is half a feature, so here is the path and an honest account
of the engine choice.

### The pipeline is already built

`DocumentContourDetector` gives you four ordered corners. `DocumentRectifier` warps them into a
head-on rectangle. That warp is the part that matters, and it is done:

```
4 corners → getPerspectiveTransform → warpPerspective → upright page → OCR
```

**Why the warp beats any amount of preprocessing.** A page on a desk seen from a headset is a
trapezoid. Every OCR engine ever built assumes text runs along horizontal lines of constant
height — in a trapezoid, character height varies continuously across the image and the baseline
is not straight. Tesseract's line finder either refuses the whole thing or segments it into
nonsense. A perspective warp *removes* the problem rather than mitigating it.

Subscribe and you get the flattened page:

```csharp
perceptionManager.DocumentRectified += flat =>
{
    using (flat)
    using (Mat ready = DocumentRectifier.PrepareForOcr(flat))
    {
        // hand `ready` to whichever engine you picked below
    }
};
```

You own that Mat. Dispose it — it is a fresh allocation per document, not a shared buffer.

### Picking an engine

There is no good first-party on-device OCR in Unity, so this is a real decision rather than a
default. In rough order of how fast you will have something working:

| Option | Accuracy on scene text | Offline | Setup |
|---|---|---|---|
| **Cloud vision API** (Google Vision, Azure Read, Gemini) | Best by a wide margin | No | An hour. POST a PNG, parse JSON |
| **Unity Sentis** + an ONNX OCR model | Good | **Yes** | A day. Model conversion is the work |
| **Native Tesseract plugin** | Fair | Yes | Half a day, and `tessdata` bundling on Android is genuinely unpleasant |
| **OpenCV `text` module** | Fair | Yes | Often **not available** — the contrib `text` module with Tesseract linked is usually absent from OpenCV for Unity's Android build. Check before planning around it |

**Recommendation: cloud first.** Scene text — angled, uneven lighting, glossy paper — is exactly
where classical OCR is weakest and where a modern vision model is strongest, and you get it
working in an hour. Wrap it the way the rest of this codebase wraps network calls: a timeout, and
a local fallback that degrades rather than hangs.

Move to Sentis only if offline is a hard requirement. If it is, budget a day and start with
PaddleOCR's recognition model — it converts to ONNX cleanly and is small enough for mobile.

### Whatever you choose, vote across frames

A printed label does not change, so every read is a noisy sample of one fixed answer. Reading
once and trusting it is picking at random among six slightly different strings.

The consensus logic for this is already written and tested on the web side of this repo, in
`src/core/perception/textVote.ts` — bucket reads by a key that folds the glyph pairs OCR actually
confuses (`O/0`, `I/1/l`, `S/5`, `B/8`, `Z/2`), accumulate confidence, and commit only when one
reading has both enough absolute support and a clear margin over the runner-up. It is about 60
lines and ports to C# directly.

Without it, the label visibly rewrites itself every second, which reads to a user as the system
being broken rather than as the system being unsure.


---

## On-device tuning

Drop `PerceptionDebugUI` on any GameObject, point its three fields at the feed, the manager and
the permissions component. That is the entire setup — no Canvas, no EventSystem, no prefab, no
font asset.

### Controls

| Input | Does |
|---|---|
| Right thumbstick up/down | Select a parameter |
| Right thumbstick left/right | Adjust it. Hold to repeat; full deflection moves 5 steps at a time |
| **A** | Cycle the debug image: off → camera → edges |
| **B** | Reset the selected parameter |
| **Grip + B** | Reset everything |
| **X** (left hand) | Summon the panel in front of you, or hide it |
| Arrow keys | The same, in the Editor |

Values persist to `PlayerPrefs` and survive a restart. Only overrides are written, so changing a
default in code still reaches a device that never touched that particular knob.

### Why it is built this way

**No Canvas, no EventSystem, no OVRRaycaster.** The conventional answer is a world-space uGUI
Canvas with an XR raycaster and an input module. That needs scene authoring, a font asset, a
correctly configured EventSystem, and a pointer setup that differs between OVR, XRI and the new
Input System — and when any one of those is wrong the panel renders perfectly and simply does
not respond. That is a miserable thing to debug while you are *also* debugging the vision stack.
`TextMesh` and a `Quad` need none of it and cannot fail that way.

**Thumbstick, not ray-pointing.** Aiming a laser at a small slider in a headset is slow, and you
cannot do it while looking at the thing you are tuning. The whole job is to nudge a Canny
threshold *while watching the edge map change*, so the control has to be eyes-free.

**World-locked, not head-following.** A panel that chases your gaze is impossible to look away
from, and the point is to look at the table. Summoning is an explicit act.

**The debug image is the actual feature.** Sliders are guesswork without it. Seeing the live edge
map turns "detection is not working" into "the edges are broken up, dilate more" in about four
seconds.

### What is tunable

Sixteen parameters in five groups, all live: capture rate; YOLO confidence and NMS; Canny
multipliers, area bounds, corner simplification and edge dilation; confirm/forget frames,
association radius and smoothing; raycast min/max distance and surface offset.

Everything reads from `PerceptionTunables` on **every** use rather than caching into a local at
construction. A cached copy makes the slider look broken, which is worse than having no slider,
because you then go and debug the wrong thing.

Canny thresholds are **multipliers on the image median**, not absolute values — absolutes tuned
under one lighting condition give you a solid white edge map or an empty one in the next room.

### The three to touch first

1. **YOLO confidence.** Trained on web photos, run on low-contrast passthrough, YOLO is
   systematically less confident here than its defaults assume. 0.4 finds things 0.5 drops.
2. **Canny low/high multipliers**, with the edge view on. You want page borders continuous and
   the desk texture mostly gone.
3. **Edge dilate**, if borders still come out broken. This is the step that decides whether a
   page is one closed contour or three disconnected arcs.


---

## Identifying food with GPT

COCO-80 knows ten foods, all prepared dishes, and no raw ingredients at all — no onion, no
pepper, no cucumber, no cheese of any kind. Fixing that by training means a labelled *detection*
dataset and a GPU. An open-vocabulary model needs neither.

So the split is:

```
YOLO + contours   →  WHERE something is   →  local, 5Hz, milliseconds
GPT vision        →  WHAT it is           →  cloud, once per object, ~1s
```

### Once per object, not once per frame

This is the whole reason a one-second round trip is affordable. A jar on a table does not become
a different jar. The local detector holds the track at 5 Hz, and `RequestIdentification` fills in
the name a second later, after which it sticks.

Five objects in a session is **five calls**. Calling per frame at 5 Hz for an hour would be
eighteen thousand — the difference between a fraction of a cent and a real bill, and between
"the app feels laggy" and no perceptible latency at all.

Until the answer arrives the object shows the local label, so nothing is ever blank.

### Setup

**1. Run the relay** (repo root, needs nothing installed):

```bash
OPENAI_API_KEY=sk-... node server/vision-relay.mjs
```

**2. Point the provider at it.** Add `OpenAiVisionProvider` to the scene, set `relayUrl` to
`http://<your-laptop-lan-ip>:8787/vision`, and drag it into `MRPerceptionManager`'s
**Vision Provider Behaviour** field.

Leave that field empty and it falls back to `LocalHintProvider` — COCO labels, fully offline.
That is the configuration to rehearse the demo in.

### The key does not go in the build

`directApiKey` exists for desk testing and logs a warning every time it is used. Do not ship it.

An APK is a zip file. A key compiled into one is extracted in minutes, and it is your key, your
billing, your rate limit. No obfuscation changes this — the request has to carry the key in
plaintext eventually, so anyone with the build and a proxy has it. The only real fix is that the
device never holds the key.

The relay is ~120 lines, dependency-free, and caps body size and allowed models so it is not an
open proxy. On a hackathon LAN the exposure is the room you are standing in; put it behind a
tunnel with real auth for anything public.

### Settings that matter

| Setting | Default | Why |
|---|---|---|
| `model` | `gpt-4o-mini` | Fast, cheap, easily good enough to name a vegetable |
| `lowDetail` | on | Flat token cost, 512px. For an object filling the crop, plenty — and several times cheaper and faster than `high` |
| `maxEdgePx` | 512 | Uploading larger just to have it downsized server-side wastes the upload, which is the slowest part of the round trip on venue wifi |
| `jpegQuality` | 70 | Visually fine here, a third the size of 95 |
| `timeoutSeconds` | 8 | A timeout is the expected outcome on saturated wifi, not an error. The local label survives |

Structured output (`json_schema`) is on, so the reply is parseable JSON rather than prose that
happens to contain a name. Without it the model sometimes answers "This appears to be a
cucumber!" and every parser downstream has to cope with sentences.

### On cheese specifically

Set expectations. Telling cheddar from gouda visually is hard for *people* without packaging
context, and GPT will usually give you "hard cheese" or "yellow cheese" rather than a variety —
which is the correct answer, and the prompt explicitly asks for it rather than a confident wrong
guess.

If cheese *identity* is load-bearing for the demo, read the label with the OCR path instead of
recognising the cheese.

### Prize-track note

`CLAUDE.md` §13 says to skip the OpenAI track unless somebody genuinely uses Codex, because it
requires documenting how Codex helped you build and judges check. Using the API for vision is a
technical choice and is fine — just do not claim the track without the Codex work. It does mean
dropping the Gemini track if GPT replaces Gemini entirely.
