# Performance budget

Target: **72 Hz on a Quest 3S**, which is **13.9 ms per frame** for both eyes.

Not 90. The 3S is the weaker headset and the demo machine, and an app that holds 72 is better
than one that reaches 90 on a 3 and judders on a 3S in front of whoever is wearing it.

## The budgets

| Thing | Budget | Why that number |
|---|---|---|
| Frame time | ≤ 13.9 ms | 72 Hz. The **worst** frame matters more than the average: an app averaging 11 ms and spiking to 30 judders, and an average hides it. |
| Draw calls | ≤ 150 | XR2 Gen 2 with stereo. Every panel is one shared material and an instanced property block, so a dozen panels should be single digits. |
| Triangles | ≤ 300k | Nothing here is dense — panels are two triangles each. The budget exists so that adding a mesh is a decision. |
| Transparent overdraw | ≤ 2.5× screen | The real risk. Every panel is transparent, and a stack of them over passthrough is pure fill. |
| Per-frame allocation | **0 bytes** in steady state | A collection is a dropped frame you feel through your face. |
| Texture memory | ≤ 40 MB | Two 1024² SDF atlases (~8 MB) plus 25 icons at 256². |
| Coach round trip | ≤ 14 s, one at a time | A request in flight blocks the next. Past this the advice is about a pan that has moved on. |
| Frame upload | ≤ 60 KB | The model charges 2048 tokens per image whatever its size, so a bigger upload buys nothing. |

## What the build does to stay inside them

**No real-time shadows.** Disabled project-wide. The design's shadows are drawn analytically in
`RoundedPanel.shader` from a signed distance field — which is also the only way to get the two
hard offset copies the design actually uses, so this is not a compromise.

**No post-processing.** No bloom, no tonemapping, no full-screen anything. A full-screen pass in
stereo is a large fraction of the budget for an effect nothing here needs.

**No blur.** Frosted glass is a gradient plus value noise. A real blur is a grab-pass per panel.

**One material per shader, shared, with instanced properties.** Reading `renderer.material`
anywhere instantiates a copy — per panel, per scene load, never freed. Everything goes through
`MaterialPropertyBlock`. If you add a panel property, add it to the instancing buffer, not as a
plain uniform.

**Static SDF font atlases.** A dynamic atlas rasterises a glyph the first time it is asked for,
on the main thread, which lands exactly when a toast appears.

**Pooled everything.** Tweens (`TweenRunner`), audio voices (`SoundManager`), toasts
(`ToastStack`), step rows, leaderboard rows, checklist rows, replay markers. None of them are
created during a run.

**No per-frame strings.** `NumberRoll` builds into a reused `StringBuilder` and calls
`TMP_Text.SetText(StringBuilder)`. `value.ToString()` allocates once per frame per counter, and
`ToString("F1")` also depends on the device's locale — which turns 4.2 into 4,2 across most of
Europe.

**Asynchronous GPU readback.** `ReadPixels` stalls the render thread for tens of milliseconds.
`AsyncGPUReadback` costs a frame of latency that nothing in a 3-second loop can perceive.

**One vision request in flight, ever.** Frames are dropped rather than queued.

## How to measure

**In the headset, first.** Nothing below replaces looking at the number on the device.

- **Dev stats overlay** — `DebugMenu` → *Toggle stats*. Average and worst frame time against
  the budget, heap size, GC count, live tweens, frames sent vs dropped, upload size, room
  luminance, and whether the HUD anchors are still inside Meta's 41° comfort cone. Compiled out
  of release builds entirely (`#if UNITY_EDITOR || DEVELOPMENT_BUILD`) rather than hidden behind
  a flag, because an overlay that ships is one somebody enables in front of a judge.
- **OVR Metrics Tool** on the device for real GPU/CPU levels and stale-frame counts. The
  on-device numbers are the ones that count; the Editor's are a different machine.
- **Unity Profiler over USB** — `adb forward tcp:34999 localabstract:Unity-<bundleid>`, then
  attach. Use it for allocation spikes, not for absolute frame time.
- **Frame Debugger** for draw-call counts. If panels are not batching, the usual cause is a
  property set on a material instead of a property block.

## Where the risk actually is

Honestly, in order:

1. **Transparent overdraw.** Every panel is transparent and they overlap. If the frame time
   goes, this is why. Measure by looking at a wall with the HUD up versus looking away.
2. **The frame upload's readback and JPEG encode.** Async, but the encode is main-thread. Watch
   the worst frame time, not the average, on the seconds a frame goes out.
3. **TextMeshPro rebuilds.** Setting text on a label that has not changed still rebuilds its
   mesh. `Label.SetText` early-outs on an identical string for this reason.
4. **The gauge's per-frame `Refresh`.** It rebuilds its property block whenever the displayed
   value moves, which during a spring settle is every frame. Fine for the handful on screen;
   not fine if somebody puts twenty up.

## Not measured

Everything in this file is a budget and a method, **not a result.** No frame time from a Quest
3S appears here because none has been taken — this build has never run on a device. See the
"could not be verified" section of the PR.
