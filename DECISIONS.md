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

## 5. `PhysicsShape.density` is kg/m³ — pass it straight through

**This entry previously said the opposite.** It claimed the values were g/cm³ and directed a
`/1000` conversion at the boundary. That was wrong, and acting on it would have made every mass
in the game a thousand times too light. The correction is recorded here rather than deleted,
because the way the wrong conclusion was reached is worth keeping.

**What we believed, and why:** IWSDK's scaffold ships a material table listing wood `0.6` and
steel `7.8`. Those are recognisably g/cm³ figures — wood really is 0.6 g/cm³ — so the table read
as strong evidence about the unit, against a default of `1.0` that looked implausible as kg/m³.

**What is actually true:** measured directly against Havok, loaded headlessly in Node and calling
`HP_Shape_BuildMassProperties`:

```
box [1,1,1]             density 1.0    -> mass 1.0
box [1,1,1]             density 1050   -> mass 1050
box [0.1,0.1,0.1]       density 1.0    -> mass 0.001
cylinder r=0.021 h=1    density 1.0    -> mass 0.00138544   (= pi r^2 h)
```

`mass = density × volume`, and IWSDK passes shape dimensions through unscaled as metres
(`physics-system.js`, `createBoxShape` → `HP_Shape_CreateBox`). So scene units are metres and
density is numerically kg/m³. A steak of 2.5e-4 m³ at `1050` weighs 0.26 kg, which is right. The
vendor material table is simply wrong — game-feel numbers, not a unit statement — and the
compiled component carries no unit annotation at all.

**Decision:** pass `densityKgM3` through unconverted. Keep the startup assertion that the
engine's computed mass matches `densityKgM3 × volumeM3` within tolerance — it is what would have
caught this in either direction, and it is cheap.

**Method note:** Havok runs headlessly under Node via `HavokPhysics({ wasmBinary })`. Collider
choice, computed mass and centre of mass are therefore unit-testable without a headset or a
browser, the same way the knife simulation is. Unit questions about this engine should be
measured, not read.

## 5b. Fragment colliders are ConvexHull, not the spec's short cylinder

**Spec section:** §8.10's collider table offers `Cylinder` for slice fragments.

**Reality:** measured against a real slice mesh at 1050 kg/m³ — true volume 4.4133e-6 m³,
so 4.634 g:

| Collider | Mass | Error |
|---|---|---|
| ConvexHull | 4.639 g | +0.1% |
| Cylinder (r=19.9mm, h=3mm) | 3.919 g | −15% |
| TriMesh | 3.786 g | −18% |

`HP_Shape_BuildMassProperties` does not volume-integrate a TriMesh, which is consistent with
IWSDK documenting TriMesh for static bodies. The cylinder approximation is 15% light for a square
cut and worsens with cut angle, because a slanted slice is a wedge rather than a disc.

**Decision:** build fragment colliders as `ConvexHull` from the actual slice mesh. A slice is
convex enough for the hull to be faithful, and it is the only option that reproduces the mass we
computed analytically.

## 5c. Fragment motion is set by velocity, not force

**Reality:** IWSDK applies `PhysicsManipulation.force` as
`HP_Body_ApplyImpulse(body, object3D.position, force * delta)` — scaled by the frame delta and
applied at the object's origin rather than its centre of mass.

**Decision:** use `linearVelocity`, which maps to a direct `HP_Body_SetLinearVelocity`. A slice
should inherit the blade's velocity, which is a velocity statement; expressing it as a
frame-scaled impulse about the wrong point would make fragment behaviour depend on frame rate.

## 6. The cap ring is bisected, not iterated

**Spec section:** none. §7.2 says where the cut plane comes from, not how to intersect it with
the food. This is a correction to our own first implementation, recorded here because the
reasoning is worth keeping.

**Reality:** the intersection condition `ny·y + radial·r(y) = n·p` is implicit in `y`.
Rearranging to `y = (n·p − radial·r(y)) / ny` and iterating is the obvious move and was the
original implementation. That map has derivative `−radial·r'(y)/ny`, which passes 1 in magnitude
for any cut steeper than ≈26° whose face reaches into the cucumber's tip cap — an ordinary cut,
not a pathological one. Past 1 the root is *repelling*: the iteration settles into a stable
two-cycle and returns a finite, plausible axial position wrong by millimetres, at any iteration
count. It also satisfies a `|next − y| < tol` settling check, because a two-cycle is genuinely
settled by that measure.

**Decision:** bisect on `g(y) = ny·y + radial·r(y) − n·p` over `[lowerBound, toM]`. Bisection
needs no contraction, only a sign change, and its error after n passes is `(toM − low) / 2ⁿ` —
a bound from arithmetic rather than from measuring a fixture. Where there is no sign change the
face runs off an end, and the bracket endpoint is returned *before* solving rather than clamping
a solved value afterwards; clamping is what previously turned a diverged cycle value into a
plausible-looking one. Derivation and measured figures are in `PHYSICS.md`.

## 7. Safety distances are millimetres in the registry, metres in the API

**Reality:** `TUNABLE_DEFS` keys `DANGER_MM` and `WARN_MM` in millimetres (20, 45), while
`classifySafety` compares against `SafetyOptions.dangerM` / `warnM` in metres. Both are
internally consistent today — the tests pass `0.02` and `0.045` directly — and nothing currently
wires the registry into `SafetyOptions`.

**Risk:** whoever builds that bridge and forgets the `/1000` gets a danger radius of 20 metres,
which never stops being true, so the ring never fires and the warning never appears. It fails
silently and in the unsafe direction. Same species as entry 5.

**Decision:** left as-is for now, because inventing a conversion for a wire that does not exist
is speculative. Recorded here so the wiring milestone converts at the boundary and asserts the
result, exactly as entry 5 does for density.

## 8. A cap ring cannot represent a cut that exits an end face

**Reality:** `LatheSpec` stores the cut face as one axial position per angle θ. That is exact
while the plane crosses the solid's lateral surface everywhere around the ring. It is not
expressible when the plane runs off an end face instead: there the face is bounded by the end
cap rather than by the surface of revolution, and a single y per θ has nowhere to say so.
`solveCapY` currently returns the bracket endpoint for those angles, which is the right
*position* but carries no signal that the face is bounded differently there. Measured divergence
between `volumeOf` and an independent mesh volume in that regime: 10–20%.

This is reachable: a steep cut near the flat end of fresh stock hits it (15 of 64 segments at
30°, 29 of 64 at 70°), as does a steep cut onto a stub left by a shallower one. It is *not*
reachable near the cucumber's tip, where the profile closes the radius to zero and a root always
exists.

**Decision:** deferred, and flagged as a design decision rather than a bug. The options are to
reject such cuts with a new `RejectReason`, to enrich the ring so each entry records whether it
is surface-bounded or cap-bounded, or to accept the error and document its size. Choosing needs
gameplay context — how often a player cuts that steeply near an end — which the headset build
will supply and this milestone cannot. Recorded now so the choice is made deliberately rather
than discovered.

## 9. Grip form gates the safety level; distance alone does not

**Spec section:** §7.5 — "green claw, amber borderline, red plus haptic plus chef bark when
fingertips are exposed **and** the blade is close." Red is specified as a conjunction, and
nothing is said about a claw grip at close range or an exposed hand at long range.

**Reality:** `classifySafety` implements a stricter rule than the conjunction on both sides:

```ts
if (!claw && d <= opts.dangerM) return 'danger';
if (!claw || d <= opts.warnM) return 'warn';
return 'safe';
```

Two behaviours follow that the spec does not state. A claw grip can **never** reach `danger`,
at any distance — even with a fingertip resting on the edge. And a non-claw hand is **always**
at least `warn`, however far the blade is — a kilometre away still warns.

**Decision:** keep both, as a deliberate deviation.

The claw suppression is the point of the mechanic. A claw grip *is* the safe grip: the
fingertips are tucked behind the knuckles, the blade rides the knuckle rail, and closeness is
what the grip is *for*. Firing red at a correctly held hand every time the knife does its job
would train the player to ignore red, which is the one failure this indicator cannot survive.
Distance is only dangerous in combination with exposure, so exposure is the gate.

The always-warn side is the same argument run backwards. Bad form is worth flagging before the
blade arrives, not at the moment it is already too late to change grip. Amber on an exposed
hand at any distance is a coaching signal; amber that waits for proximity is a startle.

The cost is that `dangerM` is only ever consulted for a non-claw hand, so `warnM` alone
separates amber from green. That is intended, not an oversight, and it is now pinned by tests —
`classifySafety`'s two suppression branches previously survived mutation because the closest
claw fixture sat at 40mm against a 20mm danger radius, twice the distance needed to exercise
the rule at all.

## 10. The safety ring is debounced asymmetrically. The spec has no debouncing

**Spec section:** §7.5 describes the ring's colours and nothing about their behaviour over
time. `SafetyDebouncer` is entirely our invention.

**Reality:** hand tracking at 90Hz is noisy at exactly the joints this depends on. A fingertip
occluded behind the blade for two frames, or an extension ratio sitting on the 1.3 threshold,
flips the classification frame to frame while the actual hand has not moved.

**Decision:** escalate instantly, de-escalate only after the quieter level has held for
`framesToRelax` consecutive frames. The asymmetry is the whole design and neither half works
alone. A warning that waits four frames to appear arrives after the injury, so escalation
cannot be debounced. A warning that vanishes the instant a joint flickers is a strobing ring
nobody trusts and everybody learns to disregard, so de-escalation must be. Symmetric smoothing
would buy the steadiness at the cost of the latency, which is the wrong trade for the one
signal in the game with a physical consequence.

`framesToRelax` stays a constructor parameter rather than a constant, because the right value
is a function of the tracking rate and of how jittery the headset's hand model actually is —
which is a headset measurement, not a decision this milestone can make.

## 11. The IWSDK scaffold's Vite config is not copied verbatim

**Spec section:** none. This records what the `@iwsdk/create@0.5.3` scaffold ships versus what
we actually run, so the next person does not "restore" a line we removed on purpose.

**`rollupOptions.input: './index.html'` was removed.** Under Vite 7.3.6 it fails the dependency
scan outright: `failed to resolve rollupOptions.input value: "./index.html"`. Vite's default
entry resolution handles the same job. This one fails loudly, which is why it is the less
interesting of the two.

**`optimizeDeps.exclude: ['@babylonjs/havok']` is load-bearing and must stay.** Without it the
Havok `.wasm` request falls through to the SPA's HTML fallback, so `WebAssembly.instantiate`
receives `3c 21 64 6f` — the bytes of `<!do` — instead of the wasm magic number. The resulting
promise **never resolves and never rejects**: `World.create` hangs forever and the app is a
blank canvas with nothing in the console. It reads exactly like a rendering bug and is not one.

`src/xr/index.ts` therefore carries a `.catch` on `World.create`, so the next failure of this
class prints something. An un-awaited rejection here is invisible.

**A `vitest.config.ts` was added, and it is deliberately empty.** With a `vite.config.ts` at the
repo root, vitest adopts it and loads the IWSDK dev plugin — Playwright, emulator injection, the
lot — merely to run headless unit tests on `src/sim`. An empty `defineConfig({})` takes
precedence and keeps the simulation tests as fast and framework-free as the purity rule intends.

**`iwsdkDev()` rejects options that duplicate `iwsdk.config.json`.** Passing `workspace` aborts
startup with "iwsdk.config.json is the project authority". `https` is not duplicated there and is
accepted, which is what makes the plain-HTTP verification path below possible.

**Method note — verifying in a browser.** The dev server serves HTTPS with a self-signed
certificate, and Chrome's interstitial cannot be dismissed by the browser-automation tooling
(`Cannot attach to this target`). A throwaway config running `iwsdkDev({ https: false })` gets
round it: `localhost` is a secure context on plain HTTP, so WebXR and IWER both work. The
committed `vite.config.ts` keeps HTTPS, because the headset connects over LAN where `localhost`
does not apply. Two further gotchas: the browser window must be foregrounded, since a
backgrounded tab freezes `requestAnimationFrame` and `World.create` then hangs on asset preload;
and two dev servers against the same repo collide on `.iwsdk/runtime/session.json`.

## 12. The simulation is gone. The food is real

**Spec section:** all of §7.2, §7.4's "exact, not estimated", §8, §14's repo layout, and entries 1
through 11 of this file.

**Reality:** entries 1–11 describe a Quest 3S build — `src/sim/`, `src/xr/`, IWSDK, Havok,
analytic cut planes against a `LatheSpec` solid. **None of that code is in this repository.** It
exists, at `HTN26/Papas-Cookeria`, and this repo is a later pivot that carried the documents
across without the source. `src/core/metrics.ts` states it in its own header: *"That is gone: the
food is real now, so thickness is observed, not computed."*

Reading entries 1–11 against this tree is therefore misleading in a specific and expensive way.
They are not wrong; they are about a different program. They stay because the reasoning in them
is still good, and because entry 5 in particular is a worked example of a wrong conclusion being
corrected by measurement, which is worth more than the conclusion was.

**Decision:** the master spec and this log are **doctrine, not description**. Their rules still
govern — #9 timeout and fallback, #11 every magic number on a slider, #12 reliability over
sophistication, #14 cite every constant, #15 log every deviation. Their architecture does not.

**What that costs, and it is the honest half of the pitch.** §7.4 says virtual cuts are scored
from the analytic cut plane, which is *exact, not estimated*, and instructs us to say so to
judges. That sentence is no longer available. A measured thickness carries the error
characteristics of the method that produced it, and every number in this build now has to be
honest about which method that was — which is why `SliceMeasurement` records its `method`
alongside its value, why `angleDeviationDeg` is absent rather than zero when unmeasured, and why
there are two independent methods at all (entry 13).

Exactness was traded for reality. A judge can now put a ruler against the thing being measured,
which no amount of analytic precision against a virtual solid ever allowed.

**Void as written:** the whole of §8 (thermal simulation — a second discipline with no code
here), §7.5 hand safety, §7.2 fragments and haptics, §7.6 procedural meshes, §14's repo layout.
`TUNABLE_DEFS` has been emptied of the keys that configured them; they were pinned by tests and
cited in `PHYSICS.md`, so they read as live configuration while configuring nothing.

## 13. One camera, measuring two independent ways

**Spec section:** §7.3 establishes the stub method and explains why the slices cannot be measured
from above. It assumes that method is the only one.

**Reality:** the rig is a single DJI Osmo Pocket 3 over USB, mounted side-on at board level. From
that one viewpoint two genuinely different measurements are available in the same frame:

- **`stub-delta`** — the uncut remainder gets shorter by the thickness that came off. Axial.
- **`side-profile`** — a slice seen edge-on shows its thickness as the short side of its
  silhouette. Perpendicular.

They fail in unrelated ways. The first is defeated by occlusion and by the stub being nudged; the
second by a slice lying flat, leaning, or rolling out of frame. Entry 4 already established that
they are not the same quantity — they differ by `cos(angle)` on a slanted cut.

**Decision:** compute both, run `crossCheck`, and **report the disagreement rather than
suppressing the record**. Agreement is evidence; disagreement means one of them is wrong and we
do not yet know which, which is a better thing to show a judge than a single confident number.
Measured on a synthetic six-cut session: stub-delta mean 6.2mm against a side-profile median of
6.1mm, agreeing within 0.20mm.

A single camera that has lost track produces a confident wrong number with no way to notice. Two
methods from one camera is cheaper than two cameras and catches the same failure.

**The in-scene ruler follows from the same idea.** The cucumber's diameter is constant while its
length is not, and it is visible in the same blob at the same depth as the thing being measured.
Scaling by it every frame — rather than by a stored mm/px — makes the measurement self-correcting
when the tripod is knocked. A stored calibration cannot notice that; this cannot fail to.
`track.ts` then normalises the stub length by the diameter ratio before differencing it, because
a real cut removes length and leaves diameter alone, while a shove changes both in proportion.

## 14. The 3mm target scored every real cut as zero

**Spec section:** §7.4, verbatim: target 3mm, tolerance 0.5mm. Pinned literally by
`tunables.test.ts` against `PHYSICS.md`.

**Reality:** `accuracy = exp(-|mean - target| / tolerance)`. Measured against the shipped values:

| Mean thickness | accuracy |
|---|---|
| 3mm | 1.0 |
| 5mm | 0.018 |
| 6mm | 0.0025 |
| 8mm | 0.000045 |

A person cutting a cucumber with a blunt bench scraper produces 5–10mm rounds. Every score on
the board would have read zero all night — not because the measurement failed, but because the
target was set for a knife skill nobody at the event has. The spec's own demo beat (§16) expects
*"6.1mm average, ±3.2mm"*, so the spec does not itself believe a player will hit 3mm.

Two further defects shared the same root and were fixed with it. At 3mm a slice seen edge-on is
`42/3 = 14:1`, outside the cucumber profile's `elongation` ceiling of 12, so it classified as
nothing at all; and its silhouette is ~466px² at 720p, below the 900px² area floor, so it was
discarded before it ever became a contour. **The target thickness was quietly setting whether
slices were visible to the pipeline.**

**Decision:** target 6mm, tolerance 2mm, sigma 2mm. Keeps the accuracy term on a live gradient
(0.61 at 5mm, 1.0 at 6mm, 0.37 at 8mm) so both halves of the score respond, and leaves the
demo's improvement beat intact — that beat is carried by **sigma**, which is what actually
improves in ninety seconds. The slider still reaches 0.5mm for anyone who wants the hard version,
and each recipe now carries its own tolerance, because 4mm rounds and 12mm batons are different
skills and one global window would flatter one and punish the other.

`elongation` widened to `{ min: 1.6, max: 20 }` — the ceiling for edge-on slices, and the floor
because a stub falls below 2.6:1 once it is shorter than 109mm, about nine cuts in, at which
point tracking died mid-demo and looked like a vision failure. Area floor lowered to 300px².

## 15. 720p, not 1080p, and the reasoning went the other way first

**Reality:** the obvious argument is that linear resolution is measurement resolution — thickness
is read off a silhouette a handful of pixels tall, so pixel pitch sets the quantisation floor of
the headline number. That argues for the 1080p the Pocket 3 can deliver, and 1080p is what this
build used first.

It is the wrong trade. Measured in the browser, five blobs, after the buffer reuse below:

| Resolution | per frame | rate |
|---|---|---|
| 640×360 | 28ms | 35fps |
| 1280×720 | 118ms | 8fps |
| 1920×1080 | 259ms | 4fps |

Cut detection requires a stub reading to hold still for several consecutive frames before it will
commit, so the frame **rate** sets how long a person must hold the board steady: 0.6s at 720p
against 1.25s at 1080p, before the refractory window on top. And the precision 1080p buys is
precision the scoring cannot use — at 720p over a board-filling frame the scale is ~0.52mm/px, so
a 6mm slice is ~11px and half-pixel quantisation is ±0.26mm, an eighth of the 2mm tolerance.

**Decision:** resolution up to the point where it stops limiting the answer, then frame rate.
`REFRACTORY_FRAMES` dropped from 15 to 5 for the same reason: it is counted in frames, and at
8fps the original was ignoring nearly two seconds after every cut.

**Method note — the pipeline was allocation-bound, not pixel-bound.** `segment` was allocating
~20MB of WASM Mats per frame, most of it two full-frame bound Mats existing only because the JS
binding of `inRange` takes Mats where the C++ API takes Scalars, plus a full-frame masked mean
and a full-frame wipe *per blob*. Caching the buffers across frames and bounding the per-blob
work to its own bounding box made cost proportional to pixels (~125ms/megapixel, linear across
all three resolutions above) instead of to allocation. Correctness was checked by confirming the
measured hues of the synthetic scene are unchanged and that repeated runs on one frame are
byte-identical — a shared mask that failed to clear itself would bleed one blob into the next.

## 16. The chef listens locally first, and the model is the fallback

**Spec section:** §9.2, which specifies the chef as "a conversational agent over WebSocket with
tool access to live game state" on the ElevenLabs Agents Platform, and lists seven client tools.

**Reality:** the spec's own §9.3 contradicts the architecture in §9.2 for anything time-critical,
and it is right to. It requires a pre-generated bank played instantly on game events because "a
round trip after every slice would put the reaction a second behind the knife", with the live
agent reserved for open conversation. That reasoning does not stop at barks. Most of what a cook
asks — *is it done yet, what is the target, how am I doing* — is answerable from state already in
memory, and routing those through a socket buys nothing and costs a second.

**Decision:** invert the default. `src/core/voice/intent.ts` matches the utterance against a
deterministic table first; `tools.ts` answers from a `GameState` snapshot and returns an
optional `Effect` the caller applies. A model is consulted **only** when the local layer returns
`unknown`, behind a timeout, and is optional — the `Oracle` interface is declared and left
unimplemented rather than wired to a provider we have no key for (rule #13).

Every command in the table works with the network unplugged, which is rule #12, and the whole
decision layer is provable from a terminal, which is why it sits in `src/core` under the purity
rule. 67 tests cover it with no microphone in the loop.

**The tools are narrower than the spec's seven.** `get_board_state`, `get_pan_state` and
`get_safety_status` describe subsystems entry 12 already voided. What exists is what there is
state for: read the session, read the target, set the target, set the ticket, set intensity,
reset. `fetch_recipe` is local against `recipes.ts` rather than MongoDB vector search, for the
reason that file's own header gives.

**Two guards that are not in the spec and are not optional.**

A wake phrase is *required* by default. An always-listening chef in a hall with 1500 people in
it will act on a sentence somebody else said, and the failure is loud and in front of a judge.
`parseIntent` returns `null` — distinct from `unknown` — for anything unaddressed.

A spoken target outside 1–30mm is refused and said aloud rather than applied. A misheard "fifty"
silently rescores the entire session against a target nobody asked for, and nothing on screen
would say it had been misheard. This is the same species of failure as entry 7: it fails
quietly, and in the direction nobody questions.

## 17. Speech input is a provider, because Quest Browser has no Web Speech API

**Spec section:** none. §9 assumes ElevenLabs owns both directions of the conversation.

**Reality:** measured against the platforms, not assumed. **Quest Browser does not implement
`SpeechRecognition`.** Meta never shipped the Web Speech API there, so the one-line path that
works on desktop Chrome is simply absent on the headset — the same shape of finding as the
master spec's §3 gate, and worth knowing before anyone budgets hours against it.

Two further facts that matter more than they look:

`webkitSpeechRecognition` in Chrome is **not** local recognition. It streams audio to Google and
returns text, so the claim "the voice works offline" is true of the intent layer and false of
the transcription. Stating it the other way round would be the kind of thing a judge catches in
one question.

Chrome **ends a recognition session on its own** after a few seconds of silence, firing `onend`
with no error. Without an explicit restart the chef listens for about ten seconds after load and
is then deaf for the rest of the demo, silently, with nothing in the console.

**Decision:** `src/voice/stt.ts` puts speech behind a `SpeechProvider` interface mirroring the
`VisionProvider` shape already used for detection, with `typed` as the floor. Typed input is not
a debug affordance — it is the tier that works in Quest Browser, the tier that works when venue
wifi collapses, and the accessible route for anyone who would rather not shout "hey chef" across
a judging table. It feeds the identical intent path, so what the tests prove is what runs.

Selection is by feature detection, never by user-agent string: Quest Browser reports a
Chrome-shaped UA and lacks the constructor, so sniffing gets the answer exactly backwards.

## 18. Gate zero passes. Quest Browser reaches the passthrough cameras

**Spec section:** §3, which budgets fifteen minutes to test whether Quest Browser exposes
passthrough to `getUserMedia`, states it "has not been verified on your specific headset and OS
build", and specifies the Luxonis OAK-1 as the fallback if it fails.

**Reality:** measured on the device, 2026-09-19, via `public/quest-check.html` served over
`adb reverse` and opened at `http://localhost:8081`. Quest 3S, Horizon OS v207,
OculusBrowser 152 / Chromium 152.

```
PASS  secure context        http://localhost:8081
PASS  camera                "camera 2, facing back" 1280x960 @ 30fps
PASS  video inputs          camera 0 front | camera 2 back | camera 1 back
PASS  microphone            peak 99% -- audio really arriving
PASS  WebAssembly           OpenCV.js can run
PASS  webxr immersive-ar    supported
PASS  webxr immersive-vr    supported
PASS  idle frame rate       72.9 fps, empty page
FAIL  SpeechRecognition     constructor absent
FAIL  speechSynthesis       absent
```

The room was **visually confirmed** in the video preview, which is the part the API cannot tell
you: a camera track can start, report a plausible resolution, and still deliver black frames.
Entry 17's own warning about `WebCamTexture` doing exactly that is why this was checked by eye
rather than by status code.

**Decision:** the OAK-1 fallback is not needed and stays in the bag. More importantly, **a
headset build does not require Unity.** Camera, microphone, WebAssembly and WebXR are all
reachable from the browser, over a bridge that installs nothing on the device.

**What this voids:** the OpenCV-for-Unity purchase as a critical-path blocker, the Unity project
bring-up, the APK build and sideload loop, and the `yolov8n.onnx` export. `unity/` stays in the
tree because the C# is good and the OCR work may still want it, but it is no longer gating
anything.

**What it does NOT establish, and the distinction matters.** This was a 2D browser page. Whether
`getUserMedia` keeps delivering frames *inside* an active `immersive-ar` session is a separate
question and is still unverified. A 2D panel floating in passthrough is a usable demo and the
measurement is equally real there, but overlays anchored to real objects need the immersive
session. Test that before designing around it.

**Performance is now the open question and it is not answered by the 72.9 fps above**, which was
an empty page. `README.md` measures segmentation at roughly 125ms per megapixel in WASM on a
laptop — about 8fps at 720p. The XR2 Gen 2 is a mobile part already running a compositor. Until
the real pipeline is measured on-device, "the camera works on Quest" does not imply "the app
runs on Quest".

## 19. The chef has no browser voice on the headset

**Reality:** from the same run. `speechSynthesis` is **absent** in Quest Browser, not merely
unreliable. `SpeechRecognition` is absent too, as entry 17 predicted.

`src/audio/chef.ts` documents three tiers: a pre-generated ElevenLabs bank, the browser
synthesiser, then silence with the line still on screen. On the headset the middle tier does not
exist, so the chef is either ElevenLabs or subtitles, with nothing in between.

**Decision:** this promotes ElevenLabs from a sponsor-track integration to a load-bearing
dependency *on the headset only*, and it changes the failure mode the bank has to survive. The
laptop keeps all three tiers and degrades gracefully; the headset falls straight from tier 1 to
tier 3. The bank must therefore be generated and cached **before** a headset demo starts, and
the subtitle path has to be good enough to carry the demo on its own, because it is the only
thing behind it.

`AudioContext` passes, so anything we synthesise or fetch ourselves still plays. It is only the
platform's own text-to-speech that is missing. The synthesised chop sound in `src/audio/chop.ts`
is unaffected.

## 20. Camera and immersive-ar coexist. The browser can host a real MR app

**Open question from entry 18:** that entry confirmed the passthrough cameras are reachable from
a 2D page and explicitly refused to generalise, because an immersive session takes over the
compositor and a browser may suspend capture when a page stops being the foreground document.
If capture died on session entry, overlays anchored to real objects would be unreachable from
the browser and the plan would collapse back to a floating 2D panel.

**Reality:** measured on device via `public/xr-camera-test.html`, two independent runs.

```
before:  87/87   advancing, mean luminance 87.9, 0 black
during: 627/629  advancing, mean luminance 95.8, 0 black    <- inside immersive-ar
4410 XR frames over 62.1s = 71.0 fps, with capture running
```

Second run reproduced it: `772/774 advancing, 0 black`.

The measurement checks two independent things on a timer, because a status code distinguishes
neither: `video.currentTime` advancing proves new frames are *decoding*, and mean luminance
above zero proves they are not *black*. Entry 18 was caught out by exactly that gap in the other
direction, and `unity/README.md` documents black-frame delivery with "no exception, no log line"
as a real failure mode of this hardware.

**Decision:** build the headset experience as a WebXR `immersive-ar` session in Quest Browser.
Anchored overlays on real objects are available, the session sustains ~71fps against a 72Hz
target with capture live, and entering a session *is* the app — there is no packaging step
between here and a working MR demo.

**What this settles.** Combined with entry 18, no part of the headset plan requires Unity: not
the camera, not the microphone, not the immersive session, not anchoring. `unity/` is retained
for its OCR work and because the C# is good, but it gates nothing and blocks nobody.

**What is still unmeasured, and it is now the only gate.** The 71fps figure is capture plus a
trivial WebGL clear. It contains no OpenCV. `README.md` puts segmentation at roughly 125ms per
megapixel in WASM — about 8fps at 720p on a laptop — and the XR2 Gen 2 is a mobile part already
driving a stereo compositor. Nothing here licenses the assumption that the measurement pipeline
fits in the remaining budget. Measure it before designing around it.

## 21. Segmentation costs 87ms on the headset. That is fine for a panel and fatal for a session

**Open question from entry 20:** the 71fps measured inside an immersive session contained no
OpenCV. This is that number.

**Reality:** the built app, served over `adb reverse` and read out of the live page over the
DevTools bridge, on Quest 3S:

```
5 blobs · 0 produce · uncalibrated · cv 87.1ms · frame 129.5ms (8fps) · 1280x720
```

Segmentation costs **87.1ms per frame**, for a whole-frame rate of about **8fps**.

The surprise is that this is roughly what `README.md` measures on a laptop. The XR2 Gen 2 is
holding its own against a desktop CPU on this WASM workload, so no headset-specific penalty
needs accounting for. The cost is the pixel count, as the README already says.

**Decision, and it splits by presentation mode.**

*As a 2D panel, 8fps ships as-is.* Entry 13's whole argument is that a cucumber does not move
between frames, and §5.1 of the master spec designs the perception layer around ~1Hz detection.
8fps is eight times faster than the architecture asks for. Nothing needs optimising to demo
this today.

*In an `immersive-ar` session, 87ms of main-thread work is disqualifying.* A 72Hz session has a
13.9ms budget per frame. Blocking it for 87ms drops the session to ~8fps, and a headset running
at 8fps is not merely ugly, it is nauseating — the one failure mode that ends a judge's turn
early and is remembered afterwards.

**So the immersive path has a prerequisite that the panel path does not: move segmentation into
a Web Worker before entering a session.** `src/vision/segment.ts` is already the only file that
touches OpenCV and everything downstream takes plain numbers, so the seam exists. It is a real
piece of work, not a flag, and it must be budgeted before anyone commits to anchored overlays.

Recorded now because the panel demo is available immediately and the session demo is not, and
the difference is one measurement rather than an opinion.

---

## 22. There is a second build, in Unity, and this log did not say so

**Spec section:** rule #15 — "Log every deviation from this spec in `DECISIONS.md` with the
reason." This entry exists because that rule was breached.

**Reality:** entry 12 records one pivot, from the Quest/IWSDK simulation to the browser
measurement app. There was a **second**, and nothing recorded it: `unity/Assets/Scripts/Perception/`
is a Meta Quest 3/3S mixed-reality perception app in C# — Unity, OpenXR, MRUK, OpenCV for Unity,
YOLOv8n through the DNN module. Eighteen files, and by commit count the most active part of the
repository.

It was invisible. `README.md` listed "anything XR" under **Not built** — in the same commit that
added `unity/`. A newcomer read the README first and never opened the directory holding the
newest work. The correction is now in `README.md` and in this file's own preamble.

**Decision:** two live builds, one repository, sharing documents and a design but no code.

- `src/` — browser, TypeScript, one fixed camera, measures real slices in millimetres.
- `unity/` — Quest 3/3S, C#, passthrough cameras, identifies and places holograms.

They cannot share source: one is TypeScript and the other C#. What they share is
`src/core/perception/**`, which was written framework-free precisely so its algorithms — pose
ring, unprojection, hysteresis, OCR voting — could be **ported** rather than imported. That is
why those six modules are fully tested and have no consumer in the web app: they are a
specification with a test suite attached, staged for the headset.

**What that costs, honestly.** The web bundle carries `tesseract.js` and ~500 lines of
unreachable TypeScript. That is real waste, and the alternative — deleting the reference
implementation and rewriting it in C# from the spec — would have cost the tests, which are the
only reason the coordinate math is trustworthy at all.

**`unity/` is not a Unity project.** It holds `Assets/Scripts/Perception/` and nothing else: no
`ProjectSettings/`, no `Packages/manifest.json`, no `.meta` files, no scenes, and no
`StreamingAssets/` even though the model must live there. The scripts are dropped into a project
you create. Nothing in the tree says so, which is why it is said here.

**None of it has been compiled.** There is no Unity install, no Meta XR SDK and no OpenCV for
Unity on the machine it was written on, so roughly half of these files cannot resolve a single
external type as checked in. Brace and parenthesis balance has been verified mechanically and
two genuine compile errors were caught that way — a field and a method both named `Rejected`,
and a stale constructor signature — but "it balances" is not "it compiles". Expect API drift on
first build, most likely `PassthroughCameraUtils`, `EnvironmentRaycastHit.normalConfidence` and
the `OVRInput` button constants.

## 23. Four bugs an audit found in the Unity build, and what they have in common

**Reality:** the Unity code was reviewed file by file after it was written. Four defects, and
all four share a shape: **they work in the place you would test them and fail in the place they
run.**

**`Utils.getFilePath` returns empty on Android.** On a Quest, StreamingAssets is not a directory
— it is compressed inside the APK, and `Application.streamingAssetsPath` is a `jar:file://` URL
no file API can open. The manager logged "model not found", set `enabled = false`, and YOLO never
ran for the entire session. Everything else kept working, so it would have presented as *the
model is bad at finding food* rather than as *the model never loaded*. Now resolved through
`UnityWebRequest` into `persistentDataPath`, cached after the first run.

**`Shader.Find` at runtime.** Unity strips every shader no scene material references, so the
lookup that resolves in the Editor returns null in a build, and `new Material(null)` throws — in
`DetectionVisualizer`, whose entire purpose is to draw something when nothing else has been set
up. Now centralised in `UnlitMaterials`, which returns null and logs once instead of throwing,
and which callers treat as "draw nothing".

**The depth raycast never fell through to MRUK.** Both branches returned, so a low-confidence
depth normal silently became `Vector3.up` and the scene model was never consulted. The comment
three lines above said it fell through. **The comment described behaviour the code did not have**,
which is worse than no comment: it survives review because the reviewer reads the comment.

**Identification cropped the smallest matching box.** `bestScore = float.MaxValue` with a `<`
comparison selects the minimum, so with two detections of one label it systematically sent the
runtiest to be identified.

**Decision:** all four fixed. The pattern is worth keeping: every one of them is invisible on the
machine that writes the code and only appears on the device that runs it, which is an argument
for getting onto hardware early rather than for reviewing harder.

**Known and not fixed**, recorded so they are chosen rather than discovered: `MedianOf` leaks
four native Mats per call; the per-inference `float[8400*84]` is a 2.8MB allocation that should
be reused; `Utils.matToTexture2D` flips by default on most versions, so crops sent for
identification are probably upside down; and `_workerMat` is paired with its results only by the
capture rate being slower than inference — a runtime slider can close that gap.

---

## 24. The vision model is Qwen now, and it runs in two places

**Spec section:** §6 names Gemini 3 Flash for scene semantics and §10.4 specifies a four-provider
abstraction. Neither shipped. What shipped was one provider calling `gpt-4o-mini`, and this entry
replaces it.

**Reality:** identification went to OpenAI because it was the fastest thing to wire up at the
time. That left the offline story hollow. Spec rule #9 says every network call gets a timeout and
a fallback, and rule #12 says to pick what survives a live demo on bad wifi — and the fallback we
had was `LocalHintProvider`, which does not identify anything. It returns the COCO label the
detector already produced. Losing the network did not degrade identification; it removed it.

That is the failure mode the spec warns about, dressed up as a fallback.

**Decision:** Qwen2.5-VL, Apache-2.0 open weights, reached through the existing relay. The relay
now resolves its upstream from `VISION_UPSTREAM`:

- `openrouter` (default) — hosted 72B, free tier, needs a key and wifi, answers in 1–3s.
- `ollama` — the same family running on the laptop over loopback, no key, no internet. Budgeted
  at 5–15s for a 3B on an Intel iGPU. **Measured at 20–26s**, which is the one thing in this
  entry that changed after it was written.

**The point is that these are the same model, not two different ones.** A closed model gives you
a fallback that is a worse model with different failure modes you have not rehearsed. This gives
you the demo you practised, slower. The headset is not rebuilt to switch — both upstreams speak
chat-completions, so the Unity side posts to one URL forever and never learns which answered.

**What this cost, and it is not the model quality.** OpenAI's `response_format: json_schema` with
`strict: true` *guarantees* the reply is one object with exactly those keys. No Qwen endpoint
implements it — most ignore the field, some 400 on it, and that 400 reads as "the relay is
broken" when it means "this model lacks that feature".

So the request asks for `json_object`, which both upstreams honour, and the **keys come from the
prompt**, which now states the shape explicitly. json_object constrains the reply to *parse* as
JSON; it does not constrain what is in it. Those are different guarantees and the old code
depended on the stronger one.

And because neither is a guarantee, `ParseIdentification` trusts neither. It walks every `{` in
the content and returns the first balanced object yielding a label, tracking string literals so a
`}` inside a note does not close the object early. That absorbs a code fence, a leading "Here is
the identification:", a `<think>` block, and a stray brace in prose — all things Qwen does and a
strict schema never did.

Confidence is normalised on the way out. Asked for 0–1 and told so twice, Qwen still answers `85`
often enough to matter, and clamping that to 1.0 would read as **maximum confidence** — a silent
lie in the one direction nobody audits. Same reasoning as "absent is never zero".

**Verified end to end, against the real model.** `qwen2.5vl:3b` was pulled and driven through
the relay with the exact request shape `BuildRequest` produces — the system prompt extracted from
the `.cs` file rather than retyped, so the test cannot drift from the build:

| Input | Reply | Round trip |
|---|---|---|
| Cucumber, 293×512 JPEG q70 | `{"label": "cucumber", "confidence": 0.95}` | 23.7s |
| Wood worktop, 512×384 | `{"label": "none", "note": "worktop or cabinet"}` | 26.4s |
| Cucumber, hint `broccoli` | `{"label": "cucumber"}` — hint overridden | 19.9s |

The middle row is the one that matters. The false-positive filter is the reason the `none`
instruction is in the prompt at all, and it survived the model swap. The third shows a wrong hint
does not drag the answer with it.

Those three replies were then added **verbatim** to the parser harness, which now runs 23 cases:
fences, prose on both sides, braces and escaped quotes inside notes, a junk object before the
real one, a `<think>` block, the three failure shapes, and these three live replies. All pass.
The relay's own paths — startup refusals, health, allowlist rejection by name — were exercised
separately.

**The measurement invalidated a recommendation in this entry's first draft.** It said to set
`timeoutSeconds` to 25 for the local model. Two of the three calls above exceed that, so the
advice would have discarded answers that had already arrived and presented as "the offline path
does not work". It is now 45, and `Range(1, 30)` became `Range(1, 60)` because 30 left no
headroom over a measured 26s worst case. Estimating a latency budget and then not measuring it
is how that class of bug ships.

**What 25s an object actually costs.** Five objects on a table is two minutes of labels
trickling in. Nothing blocks, and the COCO label shows the whole time, so it degrades rather
than breaks. But the offline path is **not** equivalent to the hosted one and should not be
described to a judge as though it were: same model, same answers, an order of magnitude later.

**That is not a compile.** There is still no Unity on this machine, so everything touching
`UnityWebRequest`, `Texture2D` or `JsonUtility` is unverified, and `JsonUtility` in particular is
*stubbed* in that harness — it is System.Text.Json wearing its name. The algorithm is tested; its
one Unity dependency is not. Expect the first real build to find something here.

**Renamed** `OpenAiVisionProvider` to `VlmVisionProvider`, since the whole point is that it is no
longer tied to one vendor. Safe to do now precisely because `unity/` has no `.meta` files — there
are no GUID references to break. It will not be safe once the scripts are in a real project.

**The hosted path is verified too**, against a real key, with the same three images:

| Input | Reply | Round trip |
|---|---|---|
| Cucumber | `{"label": "cucumber", "confidence": 0.95}` | 2.1s |
| Wood worktop | `{"label": "none", "note": "…not a food item or ingredient"}` | 0.9s |
| Cucumber, hint `broccoli` | `cucumber`, note: *"the local detector's guess of 'broccoli' is incorrect"* | 1.8s |

`json_object` **is** honoured — one clean object each time, no fence, no preamble. The tolerant
parser was not exercised by these replies, which is the correct outcome: it is insurance, not
the mechanism. All six live replies (three local, three hosted) are now pinned as parser cases,
which brings that harness to 26.

**The allowlist was wrong, and this is the entry's second correction.** It shipped naming
`qwen/qwen2.5-vl-72b-instruct:free` and `qwen/qwen2.5-vl-32b-instruct:free`. **Neither model
exists.** Both were written from memory, and the first real request would have been rejected by
the relay's own allowlist — by name, at least, which is the one thing that worked as designed.
Querying `/api/v1/models` takes one call and was not done until after the fact.

Worse for the plan: of 447 models, exactly **one** free model accepts images and is a Qwen,
`qwen/qwen3.8-27b:free`, and it returned `429 temporarily rate-limited upstream` on every
attempt including an immediate retry. **The free tier is not a plan.** The default is now
`qwen/qwen3-vl-30b-a3b-instruct`, which is paid and so cheap that three identifications did not
move a $50 balance off `$0`.

That leaves the two upstreams in a different relationship than this entry first described.
Hosted is fast and effectively free but needs an account and a network. Local is free forever
and needs neither, but is 10-25x slower. Neither is strictly better, which is the argument for
having built the switch rather than picking one.

**Not done:** `VISION_MODELS` is the escape hatch for the next time an ID drifts, and it was
used to run these tests before the allowlist was edited — so it is exercised, but no test pins
it. If a model ID silently disappears again, nothing fails until someone tries it.
