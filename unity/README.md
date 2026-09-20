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
├── FoodPlausibility.cs         real-world size gating, food/container/ignore roles
├── LabelMatch.cs               COCO vs open-vocabulary reconciliation
├── Recipe.cs                   steps, ingredients, triggers
├── RecipeRunner.cs             the state machine. Pure C#, unit-testable
├── RecipeRailUI.cs             left rail + you-need checklist
├── VlmVisionProvider.cs        Qwen-VL, via a relay that picks the upstream
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

## Identifying food with Qwen-VL

COCO-80 knows ten foods, all prepared dishes, and no raw ingredients at all — no onion, no
pepper, no cucumber, no cheese of any kind. Fixing that by training means a labelled *detection*
dataset and a GPU. An open-vocabulary model needs neither.

So the split is:

```
YOLO + contours   →  WHERE something is   →  local, 5Hz, milliseconds
Qwen-VL           →  WHAT it is           →  once per object, 1-3s hosted / 20-26s local
```

### Why an open-weights model

Because it makes the fallback real. Qwen-VL runs hosted *and* on the laptop on the table, so when
the venue network turns hostile the demo does not change shape — the relay flips an env var and
the same model answers, slower. A closed model gives you a fallback that is really just a worse
model. Master spec rule 12: pick what survives a live demo on bad wifi.

Both upstreams speak the OpenAI chat-completions dialect, which is the only reason one relay and
one C# class can serve both. The headset never learns which is answering.

### Once per object, not once per frame

This is the whole reason a multi-second round trip is affordable at all. A jar on a table does not become
a different jar. The local detector holds the track at 5 Hz, and `RequestIdentification` fills in
the name a second or two later, after which it sticks.

Five objects in a session is **five calls**. Calling per frame at 5 Hz for an hour would be
eighteen thousand — which on a free tier is the difference between working and being rate
limited, and on the local model between usable and unusable.

Until the answer arrives the object shows the local label, so nothing is ever blank.

### Setup

**1. Run the relay** (repo root, needs nothing installed). Pick an upstream:

```bash
cp .env.example .env        # then put your free OpenRouter key in it
npm run relay               # hosted Qwen

# local Qwen. No key, no internet, no .env. One 3.2GB download, once.
ollama pull qwen2.5vl:3b
npm run relay:local
```

Both scripts work identically in PowerShell, bash and cmd, which the raw `node` invocations did
not — `VAR=val node ...` is a parse error in cmd.exe. `.env` is read by **Node itself** through
`--env-file-if-exists`, so there is no `dotenv` dependency and no key on a command line where
it would land in shell history. `.env` is gitignored (`.gitignore:6`); `.env.example` documents
every variable and holds no secrets.

`relay:local` passes `--upstream=ollama`, which overrides both `.env` and the shell — so a
`.env` configured for hosted does not have to be edited to rehearse the offline path.

`curl http://localhost:8787/health` reports which upstream is live and which models it will
forward. That is the question you actually have at 3am after flipping the env var.

**2. Point the provider at it.** Add `VlmVisionProvider` to the scene, set `relayUrl` to
`http://<your-laptop-lan-ip>:8787/vision`, and drag it into `MRPerceptionManager`'s
**Vision Provider Behaviour** field. Set `model` to match the upstream — the relay rejects
anything off its allowlist **by name**, so a mismatch says so rather than failing vaguely.

Leave that field empty and it falls back to `LocalHintProvider` — COCO labels, fully offline,
no relay at all. That is the configuration to rehearse the demo in.

### Choosing an upstream

| | Hosted (OpenRouter) | Local (Ollama) |
|---|---|---|
| Model | `qwen/qwen3-vl-30b-a3b-instruct` | `qwen2.5vl:3b` |
| Latency | **0.9–2.1s measured** | **20–26s measured** on an Intel iGPU, warm |
| Accuracy | Better, noticeably so on cheese and herbs | Good enough to name a vegetable |
| Needs wifi | Yes | No |
| Needs a key | Yes (free OpenRouter account) | No |
| `timeoutSeconds` | 12 | **45** |

**Both upstreams are verified end to end** with the exact request shape `BuildRequest`
produces. Hosted, `qwen/qwen3-vl-30b-a3b-instruct`:

| Input | Reply | Round trip |
|---|---|---|
| Cucumber, 293×512 JPEG q70 | `{"label": "cucumber", "confidence": 0.95}` | 2.1s |
| Wood worktop, 512×384 | `{"label": "none", "note": "…not a food item or ingredient"}` | 0.9s |
| Cucumber, hint `broccoli` | `{"label": "cucumber"}`, note: *"the local detector's guess of 'broccoli' is incorrect"* | 1.8s |

`json_object` is honoured — every reply came back as one clean object, no fence, no preamble.
The tolerant parser was not needed here, which is the point: it exists for when it is.

**These numbers are measured, not estimated.** Running the real request shape against
`qwen2.5vl:3b` through the relay on this laptop (Intel Core Ultra 7 155H, Arc iGPU, 16GB, model
already warm):

| Input | Reply | Round trip |
|---|---|---|
| Cucumber, 293×512 JPEG q70 | `{"label": "cucumber", "confidence": 0.95, ...}` | 23.7s |
| Wood worktop, 512×384 | `{"label": "none", "note": "worktop or cabinet"}` | 26.4s |
| Cucumber, hint `broccoli` | `{"label": "cucumber", ...}` — hint overridden | 19.9s |

Two things worth noting. The false-positive filter **works** — bare worktop came back `none`,
which is the whole reason that instruction is in the prompt. And a deliberately wrong hint did
not drag the answer with it, which is the behaviour §"Identifying food" assumes.

The cost is time. At ~25s an object, five objects on the table is two minutes of labels
trickling in. Nothing blocks and the COCO label shows throughout, so it degrades rather than
breaks — but the offline path is **not** equivalent to the hosted one. Same model, same answers,
an order of magnitude later. Rehearse it before you rely on it.

Default to hosted, rehearse local.

**Check model IDs before trusting them.** The first version of the allowlist named
`qwen/qwen2.5-vl-72b-instruct:free` and `...-32b-instruct:free`. **Neither exists.** Both were
written from memory and would have failed on first contact. The catalogue is one call away:

```bash
curl -s https://openrouter.ai/api/v1/models | grep -o '"id":"qwen/[^"]*"'
```

When an ID goes stale, `VISION_MODELS` extends the allowlist without a code change:

```bash
VISION_MODELS=qwen/qwen3-vl-8b-instruct node server/vision-relay.mjs
```

**On "free".** `qwen/qwen3.8-27b:free` is the only genuinely free model that accepts images, and
it returned `429 temporarily rate-limited upstream` on every attempt the day this was written,
including an immediate retry. Treat it as a bonus, not a plan. `qwen/qwen3-vl-30b-a3b-instruct`
is the tested default and costs a fraction of a cent per call — three test identifications did
not move a $50 balance off `$0`.

### The key does not go in the build

`directApiKey` exists for desk testing and logs a warning every time it is used with a remote
endpoint. Do not ship it.

An APK is a zip file. A key compiled into one is extracted in minutes, and it is your key, your
billing, your rate limit. No obfuscation changes this — the request has to carry the key in
plaintext eventually, so anyone with the build and a proxy has it. The only real fix is that the
device never holds the key.

The local upstream sidesteps this entirely: there is no key, so `directEndpoint` pointed at
`http://127.0.0.1:11434/v1/chat/completions` leaks nothing. That is the one case where direct
mode is not a liability.

The relay is ~160 lines, dependency-free, and caps body size and allowed models so it is not an
open proxy. On a hackathon LAN the exposure is the room you are standing in; put it behind a
tunnel with real auth for anything public.

### Settings that matter

| Setting | Default | Why |
|---|---|---|
| `model` | `qwen/qwen3-vl-30b-a3b-instruct` | Must match the relay's upstream. Local is `qwen2.5vl:3b` |
| `responseFormat` | `JsonObject` | Portable across both upstreams. See below |
| `lowDetail` | on | Flat token cost, 512px. For an object filling the crop, plenty. Ignored by local runtimes |
| `maxEdgePx` | 512 | Uploading larger just to have it downsized server-side wastes the upload, the slowest part of the round trip on venue wifi |
| `jpegQuality` | 70 | Visually fine here, a third the size of 95 |
| `timeoutSeconds` | 12 | A timeout is the expected outcome on saturated wifi, not an error. The local label survives. **Raise to 45 for the local model** — measured worst case is 26s |

### Structured output is a request, not a guarantee

This is the one real incompatibility in the swap, and it is worth understanding before it costs
you an evening.

OpenAI's `response_format: json_schema` with `strict: true` **guarantees** the reply is exactly
one object with exactly those keys. Qwen endpoints do not implement it — most ignore the field,
some 400 on it, and a 400 here reads as "the relay is broken" when it really means "this model
does not have that feature".

So `responseFormat` defaults to `JsonObject`, which OpenRouter and Ollama both honour. That
constrains the reply to *parse* as JSON; it does **not** constrain the keys. The keys come from
the system prompt, which states the shape explicitly.

And because neither is a guarantee, `ParseIdentification` does not trust either one. It walks
every `{` in the reply and returns the first balanced object that yields a label, tracking string
literals so a `}` inside a note does not end the object early. That handles a code fence, a
leading "Here is the identification:", a `<think>` block, and a stray brace in prose — all
things Qwen does and `gpt-4o-mini` under a strict schema never did.

`JsonSchema` mode is still there if you point this at a model that honours it.

Confidence is normalised on the way out: asked for 0–1 and told so twice, Qwen still answers
`85` often enough that treating it as "clamps to 1.0, maximum confidence" would be a silent lie
in the one direction nobody checks.

### On cheese specifically

Set expectations. Telling cheddar from gouda visually is hard for *people* without packaging
context, and Qwen will usually give you "hard cheese" or "yellow cheese" rather than a variety —
which is the correct answer, and the prompt explicitly asks for it rather than a confident wrong
guess. The 3B local model is noticeably worse here than the hosted 72B.

If cheese *identity* is load-bearing for the demo, read the label with the OCR path instead of
recognising the cheese.

### Prize-track note

Nothing here touches the OpenAI track any more, which `CLAUDE.md` §13 says to skip anyway unless
somebody genuinely uses Codex. Qwen2.5-VL is Apache-2.0 open weights, so there is no vendor claim
to make and none to defend.

If a sponsor track wants an open-model or on-device story, this is it: the same weights run in
the cloud and on the laptop, and the relay switches between them without rebuilding the headset.

---

## False positives, and the bowl-contents path

Two related problems with one shared answer.

### You cannot fix this with training data

A COCO detector on a kitchen counter produces a steady trickle of nonsense: wood grain called
broccoli, a cabinet handle called a knife, a reflection called a bowl. The instinct is to get
better training data — but that needs a labelled **detection** dataset (Food-101 is
classification, so it cannot help), a GPU, and hours you do not have.

Raising the confidence threshold does not work either. A false positive at 0.55 and a real
carrot at 0.55 are indistinguishable *to the model*. You trade noise for misses.

The fix is to ask questions the model cannot.

### Filter 1: real-world size

`FoodPlausibility` rejects detections that cannot be what the model says they are. A "banana"
90cm long is a worktop. A "carrot" 2cm long is a scratch in the wood.

**This only works because there is depth.** A 2D pipeline has no idea whether a box is a carrot
at 30cm or a carrot-coloured cabinet at 3m — identical pixels. The depth raycast gives distance,
distance plus the box gives metres, and metres are decisive. It is nearly free, because
`EstimateSize` was already computing the number.

Ranges are TUNED, not sourced, and deliberately generous: the job is to reject the absurd, not
to adjudicate a large carrot.

### Filter 2: let the model that can see everything veto

The crop already goes to Qwen. The prompt now says: if this is worktop, a cabinet, a hand, an
appliance or wood grain, answer `none`.

That is an open-vocabulary false-positive filter for free. The local detector says broccoli, Qwen
looks and says worktop, the track is retired immediately — not aged out over `forgetFrames`,
because the detector will keep re-finding the same wood grain every capture and it would simply
respawn.

A veto is distinct from a timeout: a timeout means try again, a veto means stop.

### Filter 3: utensils are context, never subjects

`fork`, `knife` and `spoon` are `Role.Ignore`. They are useful for knowing a cutting step is
happening; they are not things to put a hologram on.

### The bowl-contents path

COCO has `bowl` (45), `cup` (41), `bottle` (39), `wine glass` (40). These are `Role.Container`,
and a container is interesting for **what is in it**.

This is the whole route to everything COCO cannot see. Shredded cheese, chopped onion, flour,
spices — none has a shape a detector can localise, and all of them sit in something that does.
So the container gets found locally, and Qwen is asked about its contents rather than about the
bowl. The label reads `shredded cheddar (in bowl)`.

Without the `VisionSubject.Contents` distinction the model very reasonably answers "a bowl",
which is the one thing already known.

### Everything that gets dropped says so

`LastRejection` and `RejectedCount` are on the debug panel — `rejected: carrot at 0.78m` is
diagnosable in one glance. A detection that silently fails to appear is not, and the reflex is
to start lowering the confidence threshold, which makes everything worse.

### A note on the reference UX

The Vision Pro cooking concept this is modelled on **does not box the food**. It boxes the hob
("you need" + checklist), the hob again ("put the pan on"), and the pan ("add salt"). The peppers
on the board get no box at all — identity comes from the recipe step, not from detection, and a
left-hand rail tracks state (`ingredients → cutting → pouring → salting → cracking → waiting →
done`).

That is worth copying, because boxing a pan and a hob is easy and stable while boxing every
pepper slice is neither. A recipe state machine that knows it is on the "cutting" step does not
need a detector to tell it there is a pepper — it needs one to tell it *when the pepper has been
cut*, which is a much easier question.


---

## The recipe rail

The piece that makes this look like the reference concept — and, more usefully, the piece that
makes the detector's job easy.

```
Recipe.cs        steps, ingredients, triggers, and a built-in Shakshuka
RecipeRunner.cs  the state machine. Pure C#, no UnityEngine, unit-testable
RecipeRailUI.cs  the left rail and the "you need" checklist
```

### It inverts what perception is for

Without a recipe, perception answers **"what is on this counter"** — an open question, against a
model that knows ten foods, on a wooden surface that generates false positives all day.

With a recipe, it answers **"has the pan arrived yet"** — closed, expected, easy. A step knows
what it is waiting for, so anything that is not that simply does not matter. The false-positive
problem does not get solved so much as become irrelevant.

### Most steps are timers, and that is fine

The reference says so out loud: its instruction reads **"add salt (2 sec)"**. That is a timer,
not a detector.

Detection earns its place on the steps where something *appears* or *leaves* — a pan arriving on
the hob, the last ingredient reaching the counter. Those are easy, robust and visible. Building
six fragile gesture detectors for steps a countdown covers better is how you lose a night.

| Trigger | Use for |
|---|---|
| `Manual` | Anything hard to see. The safe default |
| `Appears` / `Disappears` | A pan on the hob, a board cleared |
| `CountAtLeast` | Cut something into pieces and count them |
| `Seconds` | Salting, pouring, waiting — most of a recipe |

### Every step is manually skippable

`ManualOverride` defaults true and should stay true. Master spec rule #12: pick what survives a
live demo. If the pan is not detected — bad light, wrong angle, somebody's arm in the way — the
demo must not be stranded on step four in front of a judge.

Right index trigger advances, left goes back. An automatic trigger that works is a nice touch; a
manual override that always works is the difference between a demo and an apology.

### The anchored instruction reuses the box that already exists

The current step names an `AnchorLabel`, and whichever tracked object carries that label shows
the instruction **instead of** its own name. The box around the pan says "add salt" while that
step is live, then goes back to saying "pan".

No new rendering, no second anchoring system. This is exactly what the reference does: it boxes
the hob, then the hob again, then the pan — all large, stable, trivially detected objects. It
never boxes the food.

### Lazy follow, not rigid lock

The rail wants to be ambient, which argues for head-locking it. But rigidly head-locked UI in a
headset is genuinely nauseating — it never moves relative to your eye, so the vestibular system
gets no parallax and concludes something is wrong.

So there is a dead zone. The panel stays world-fixed while you look around normally, and only
catches up once you have turned far enough that it would otherwise leave view. You can look at
the board without it chasing you, and it is still there when you look back.

`followDeadZoneDeg` defaults to 22. Below about 12 it feels glued to your face; above about 35
it is gone when you look back for it.

### Checklist polarity

Bright means **still needed**, dim means found — the same polarity as the reference, where the
two un-struck lines are the two things not yet on the counter. It reads as a shopping list,
because that is what it is.

Ingredients vision will never see (cumin, paprika) are marked `Optional` and strike through on
progress rather than on detection. More honest than a checklist stuck forever on "1 teaspoon
cumin", and it avoids having to explain why.


---

## Recipe labels and COCO's vocabulary

COCO-80's **entire** kitchen vocabulary:

```
bottle, wine glass, cup, fork, knife, spoon, bowl
banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza, donut, cake
diningtable, microwave, oven, toaster, sink, refrigerator
```

Everything else a kitchen contains — pepper, egg, garlic, onion, cheese, pan, hob — is invisible
to it and needs the vision provider. There is no threshold that changes this.

### Two recipes, and the default is the offline one

`Recipe.FruitSalad()` is built entirely from real COCO classes — banana, apple, orange, bowl,
knife — so it runs with **no network at all**. It is the default, per rule #12, and it is the one
to rehearse with. Master spec 5.2.3 wants the full demo runnable offline; a recipe whose every
step waits on a cloud round trip cannot satisfy that.

`Recipe.Shakshuka()` matches the reference video but **needs the vision provider**. Pepper, egg
and garlic have no COCO class and never will. `WorksOffline` is false, and those ingredients
carry `NeedsVisionProvider` so the rail can explain a stalled checklist rather than leaving
somebody to work it out.

Switch between them on the manager's **Recipe** dropdown.

### Every label is now a list

One real object has several names. A frying pan seen from above is routinely "bowl" to COCO and
"frying pan" to Qwen, and the step should anchor to it either way:

```csharp
AnchorLabels = new[] { "frying pan", "pan", "skillet", "bowl" },
```

Where a COCO class is a plausible stand-in it is listed as a fallback — a tall tin often reads as
"bottle", an induction top often trips "oven". Those are not corrections to the model, they are
alternative names for the same pixels.

### Matching is not string equality

COCO says `bottle`, Qwen says `bottle of olive oil`. The recipe says `pepper`, Qwen says
`red bell pepper`. All the same object; `==` matches none of them, and the checklist sits there
never ticking while the thing is plainly on the counter.

`LabelMatch` applies two rules:

- **Contiguous subsequence** — "olive oil" inside "bottle of olive oil"
- **Shared head noun** — English compound nouns put the head last: "red bell **pepper**",
  "frying **pan**", "shredded cheddar in a **bowl**"

Articles and prepositions are dropped first, so "in a bowl" has head noun `bowl`, not `a`.

Deliberately **not** edit-distance fuzzy matching. "pan" and "pen" are one character apart and
are not the same thing, and a recipe that advances on the wrong object is worse than one that
waits.

### A track carries both names, as one entry

`Observe` takes `IReadOnlyList<string[]>` — one array per tracked object, holding the detector's
class and the provider's name together.

That shape matters. Flattening them into a list of strings would make `CountAtLeast` score one
banana as two the moment Qwen called it "sliced banana", and the cutting step would fire on a
single uncut piece of fruit. **One track is one object**, however many names it has.
