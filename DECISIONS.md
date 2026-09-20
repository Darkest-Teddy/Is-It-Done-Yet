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

## 22. The menu design document is a canvas export, so it was ported rather than converted

`# Is It Done Yet Menu.zip` holds seven finished screens — 1A title, 1B loading, 2A counter
tally, 2B chef's pick, 2C recipe library, 2D dish card, 2E competitive cutting — plus two asset
sets and a webfont pairing. They are now a real app at `app.html` (`src/menu/`), reachable in
Quest Browser over `adb reverse` alongside `index.html`, `lab.html` and `xr.html`.

**Nothing in the document runs in a browser, and that is not a criticism of it.** It is a
`.dc.html` canvas export. Interaction lives in `style-hover` / `style-active` attributes, lists
are `<sc-for list="{{ recipes }}">`, values are `{{ bindings }}`, and buttons are
`<div style="cursor:pointer">`. Every screen is a fixed 1440x810 or 1600x900 box with every
element absolutely positioned inside it. Opened in Chrome it renders as a picture and does
nothing. So the visual language was kept and the mechanics were rebuilt.

**Four things changed structurally.**

*Fluid, not fixed.* One rem is sized off the viewport (`clamp(15px, 1.15vw, 21px)`) and every
screen is a grid that reflows. A Quest Browser window is resizable and arrives at a size nobody
chose; scaling a 1440-wide artboard down to fit would put the design's 11px labels at eight real
pixels. Type is also bigger than the artboard throughout, matching the sizing `quest-check.html`
and `lab.html` already settled on for reading at arm's length through a lens.

*The page never scrolls.* Driving a scrollbar with a controller ray is miserable. Each screen
fits its window; the three lists that genuinely can overflow scroll inside their own box.

*Every control is a real `<button>`.* Focusable, announced, and at least 3rem tall so a ray that
jitters with your head can land on it.

*The controller rail is the control, not a legend.* The artboard drew A / B / X / Y badges along
the bottom of every 2x screen. A page in a Quest Browser tab is a 2D window: it receives a
pointer ray and a keyboard, and does **not** receive controller face buttons — those reach a
page only inside an immersive WebXR session, which this deliberately is not (entry 18). Printing
a legend for buttons the page cannot receive would be a lie on every screen, so each badge is
now a button you can point at, and its letter is also its keyboard shortcut. Everything on the
rail is also reachable from a large target inside the screen.

**2A and 2E sit on the passthrough camera.** Both artboards painted a kitchen — brown worktop,
wooden rail, ingredients at fixed coordinates with name tags floating above them. That was
standing in for the entire point of the project. The ground is now `getUserMedia` (entry 18's
route, not WebXR `camera-access`), the video is a plain DOM element under the panels so the
compositor drives it at the camera's own rate regardless of what the analysis loop is doing, and
tags are drawn only where the scan actually found something. Overlay markers are positioned
through the video's `object-fit: cover` box rather than by naive percentage, or they slide off
their ingredient the moment the window is not the camera's aspect ratio — which on a resizable
window is nearly always. The other five screens keep the artboard's dark ground, which also
keeps the camera closed while somebody is only browsing.

**Every animation is gone.** The document carried 23 `@keyframes`: ingredients raining down the
title screen, tags bobbing over the counter, a knife chopping on a loop, and a burger dropping
into place on a 2.8s cycle behind the loading bar. All decorative, all looping, none carrying
information. What replaced the loading animation is the useful half of it: there are six layers
in that burger and six things that must happen before a camera screen works (fonts, recipes,
art, OpenCV, camera, ready), so a layer goes from ghost to solid when its step finishes and the
stack *is* the progress bar. A slow step is now identifiable by which layer is still hollow.
What is left anywhere else is a 90ms press response, which is latency feedback rather than
decoration.

**Four numbers on the artboard were not real, and are not invented here.**

| Artboard | Why it could not ship | What it says now |
|---|---|---|
| "LIVE · 412" beside competitive mode | No matchmaking service exists | Runs actually on the board |
| "POPULAR THIS WEEK" on the chef's pick | No popularity data exists | How much of the dish your counter covers |
| "+180 XP" on the dish card | No XP system exists | Removed; difficulty chevrons stay |
| "Knuckle guard: SAFE" in the cutting round | Needs 26 hand joints from an immersive session | Pieces in shot |

That last one is the important one. A green safety light wired to nothing is worse than no
light: somebody trusts it. "437 ingredients" on the title screen, by contrast, stayed — it is
the literal count of files in `menu/ingredients/`.

**The competitive round scores evenness, not millimetres.** Each blob's oriented rect gives a
short side and the short side of a slice is its thickness, but millimetres need
pixels-per-millimetre and therefore a calibration step — and ninety seconds with a judge wearing
the headset is the worst possible place for one. The coefficient of variation cancels the
unknown scale out entirely, so "94% even" is a true statement about the cutting where a
millimetre figure off an uncalibrated camera would not be. A round that measured fewer than
three pieces posts nothing at all, because zero evenness and zero measurements both produce a
total of 0 and only one of them is a score.

**Assets.** The zip ships 12 hand-drawn hero icons and 437 categorised ingredient icons that
arrived unnamed (`carb (1).png` … `Protein (117).png`). Both are in `public/menu/`, renamed to
URL-safe `carb-001.png` form. `src/menu/art.ts` resolves an ingredient to a hero icon first,
then to one of ~70 library icons identified by eye, then to a *stable* hash-pick within the
right category — stable so the same ingredient is the same picture on the counter, in the
library and on the dish card, because a picture that changes between panels reads as a different
ingredient. A fallback icon is a category and never an identification, so the name travels with
it in the `alt` text and the tooltip. Ranchers and Hanken Grotesk are self-hosted (latin
subsets, 59KB total); a webfont arriving late over venue wifi reflows every screen at once.

**Two bugs found while building this, both worth keeping written down.**

*The service worker ate every edit in dev.* `public/sw.js` is cache-first for everything but
navigations, which is correct for a built bundle because Vite fingerprints asset filenames — and
completely wrong under `vite dev`, where module URLs are stable. The page silently stopped
picking up changes and kept serving a version from an earlier session. `app.html` now registers
it only under `import.meta.env.PROD`, and actively unregisters any stale worker in dev.
`index.html` and `xr.html` still register unconditionally and have the same trap.

*The loading screen hung on the camera prompt.* `getUserMedia` does not resolve until a person
answers the permission dialog, so awaiting it plainly means a loading screen stuck at 80% behind
a prompt the wearer may not have noticed. It is raced against a 4s timeout now; the camera keeps
opening in the background and the two camera screens report its real state themselves.

**What this is not.** It is the front of house — the flow from title through to a round starting.
The cooking loop itself (`src/main.ts`, `src/app/session.ts`) is untouched, and so are the
`public/ui/*.uikitml` panels and `menu.html`, which are the in-session spatial layout and its
preview. Two visual languages coexist in the repo on purpose: this one is the menu the wearer
navigates, that one is the coaching panel that floats beside the board while they cook.

## 23. The chef answers in three channels at once, and interrupts in only one voice

**Spec section:** §9.2, which wants an agent with tool access to live game state, and §9.5's
intensity slider. Entry 16 already inverted §9.2's default for *commands*. This is the same
argument applied to *guidance*, which is the harder case, plus the half nobody asked the chef
for: speaking up unprompted.

**Reality:** "I don't know what to do next" has no table entry. It is not a command with a
correct parse — the answer depends on which recipe, which step, what is on the counter and what
the camera last saw, and no amount of regex produces it. So this is the first place in the repo
where a model is genuinely load-bearing rather than decorative, and it is also the first place
where the chef can speak without being spoken to. Those two facts pull in opposite directions,
and most of this entry is about keeping them apart.

**Decision: one answer object, three renderers.** `Guidance { speech, overlay, text }` is
produced once and `present()` in `src/menu/guidance.ts` is the only function that writes to any
channel. Assembling them separately is how you get a chef saying "add the tomato" while the pin
over the board still reads "slice thinner" from ten seconds ago, and a cook who sees that stops
trusting all three. `parseModelGuidance` therefore falls back **whole**, never field by field: a
reply missing `speech` is discarded entirely rather than half-repaired from the local answer.

The AR channel is capped at **six words** and pinned just above the board guide, in artboard
coordinates inside the scaled 1440x810 board rather than in window coordinates — the same trap
the camera fault card fell into and had to be moved out of. It is read at arm's length through a
lens by somebody holding a knife; a paragraph floating in space is not a message, it is an
obstruction. The spoken and written channels carry the reasoning.

**Decision: local first, model second, and the local answer is never a placeholder.**
`localGuidance` is a five-rung ladder over `steps.ts` and `deficit.ts` and it is a complete
answer — with no key, no relay and no network it *is* the feature, and it still speaks, still
pins an imperative over the real board, and still writes the reasoning on the panel. When a model
is configured the chef acknowledges instantly ("Let me look.") while the local answer goes up on
the panel at the same moment, so the screen is never blank and the room is never silent during
the round trip. When the reply lands it replaces all three channels at once. When it does not,
the local answer was already the thing on screen and nothing has to be undone. Rules #9 and #10:
timeout, fallback, and nothing awaited on the path that answers a human.

**Decision: the asked path may use the model. The unprompted path may not.** This asymmetry is
deliberate and it is the most important line in the entry. When the cook asks, a wrong answer
costs them a few seconds and they are already looking at the panel. When the chef interrupts, it
is spending attention it was not offered, and a model handed a scene description will invent a
mistake to be helpful about. So an interruption is only ever a `Deficit`'s own instruction —
derived from a measurement, already a complete sentence written for the cook, already tested. A
false accusation does not cost one correction, it costs every correction after it, because the
cook learns the chef is unreliable and stops listening. At that point a silent chef would have
scored better.

**The comparison engine is the one that was already here.** `deficit.ts` decides what is wrong,
`kitchen.ts` adds the faults no camera could see, `timeline.ts` decides what has persisted, and
`CoachSession` already held both — its header has described it as "the loop that turns frames
into coaching" since it was written. Nothing about detection was rebuilt. What was missing was
the judgement about whether a true observation is worth saying out loud, and that is
`core/voice/nag.ts`: pure, with no clock of its own, and therefore provable from a list of
timestamps rather than only from a headset. Four rules, and every one of them is a refusal —
persisted rather than seen, one thing at a time, never the same correction while the cook is
visibly acting on it, and silence below a confidence floor. `CoachSession.interruption()` records
a returned interruption as spoken on purpose: the alternative is a caller that has to remember
to, and the one time somebody forgets, the chef repeats itself every frame in front of a judge.

**`observationConfidence` exists for exactly one failure mode.** `diff` compares the board
against the recipe, so a board with nothing on it reports *every* requirement missing at blocking
severity. Unguarded, a hand passing over the lens becomes the chef announcing that the cook has
forgotten four ingredients that are sitting in front of them. Zero pieces, no camera, or a stale
frame all return a hard zero — treated as "the camera is not looking at the board", never as "the
board is empty". The threshold is one constant shared by the interruption gate and the answer
ladder, so the chef cannot refuse to interrupt about a fault it is simultaneously happy to read
aloud.

**The intensity slider changes how often the chef speaks, not just how rudely.** §9.5 calls it
an accessibility feature and the funniest control in the game; making it govern interruption
frequency is what makes the first half of that true. Three settings on the card, and **Silent**
is a real off switch. An assistant that cannot be switched off is one people switch off by
taking the headset away.

**Two triggers, and the second one does not exist on the headset.** The Unsure button sits on
the cutting screen's action row and on the controller rail as X with an `x` shortcut — a real
focusable button, for the reason `rail.ts` gives at length: a Quest Browser tab never receives
controller face buttons, so a printed legend would be a lie along the bottom of every screen. The
wake phrase goes through `parseIntent`, which gained a `stuck` intent, kept deliberately apart
from `suggest` because "I am mid-dish and lost" and "give me a different dish" are opposite
questions and answering the first with the second is the worst reply available. Entry 17 already
measured that Quest Browser ships no `SpeechRecognition`, so on the headset `bestProvider` hands
back the typed tier and the card grows a text box feeding the identical path. Entry 19 measured
that it ships no `speechSynthesis` either — which is why the text channel is not decoration. On
the headset, without a cached ElevenLabs bank, the written and pinned channels *are* the chef.

**Qwen3, behind a relay, with no provider hardcoded.** Qwen3 is served by DashScope's
OpenAI-compatible endpoint, by OpenRouter, and by anything running vLLM or Ollama; they differ in
the base URL and the model id and in nothing else a client cares about, so both are configuration
and the request body is plain chat-completions. `server/guidance.mjs` holds the key and is
mounted at `/api/guidance` by both the Vite dev server and the static server, so the relay path
is identical in dev and in production. `.env.example` has warned since the OpenAI work that a
`VITE_` key is inlined into the client bundle and readable by anyone who opens the page, and this
repo publishes a built app — so the browser-key path still exists, for a laptop at a booth, and
is documented as the lesser of the two rather than offered as an equal.

**What is unverified, stated plainly.** Nothing in this repo has called a live Qwen3 endpoint.
The transport was exercised end to end against a local OpenAI-shaped stub — request body,
`<think>`-wrapped and fenced replies, a 502 from a broken upstream, and a timeout — but the live
model call remains unproven. The default model id `qwen3-32b` is a plausible DashScope-style id
and is commented as unverified in all three places it appears; ids differ per provider for the
same weights, so DashScope lists bare ids, OpenRouter namespaces them (`qwen/...`) and Ollama
uses a tag (`qwen3:8b`). `enable_thinking: false` is sent because DashScope and recent vLLM
builds read it and the others ignore an unknown field, but that has not been confirmed against a
live server — `stripThinking` is the defence that does not depend on it being honoured, because
Qwen3 is a hybrid-reasoning family and some servers deliver the reasoning inside the message
content as a `<think>` block, where `JSON.parse` fails in a way that looks exactly like the model
having ignored the format instruction.

**OCR is on demand, and the honesty is the point.** The brief asked for OCR feeding the
comparison loop. Entry 21 measured segmentation at 87ms per frame on the headset and Tesseract is
heavier than that by a wide margin; the analysis loop also runs at 420px on the long edge, which
is far below what any OCR engine needs for body text. Running it continuously would cost the
frame budget and return junk, and no throughput figure is claimed here because none has been
measured. So "Read a card" is a button: it takes the video at **full** resolution rather than the
analysis canvas, votes across three reads with `core/perception/textVote.ts`, and reports nothing
the reads did not agree on — a null verdict renders as "nothing legible", never as a best guess,
because a card reading "4 tomatoes" becoming "4 tomatuea" is worse than no read at all. What it
is expected to manage is large print on a card **held up to the camera**. Reading a recipe card
lying flat on the counter at arm's length is **UNVERIFIED on a headset** and should not be
promised to anyone until somebody has tried it. Accepted text joins the context the model reasons
over; the deterministic engine does not depend on it at any point, which is what lets the
autonomous half work without it.

**What this is not.** The autonomous watch runs only while a round is running and only when a
recipe is selected — the free round has no recipe to be behind on, so it gets guidance on demand
and nothing unprompted. Thicknesses stay uncalibrated, exactly as entry 22 left them, so no
millimetre deficit is ever raised on this screen: counts, proportions, evenness and the
cook-confirmed steps are what the chef speaks about. `src/main.ts` and the `public/ui/*.uikitml`
panels are untouched. `CoachSession` gained `ingestPieces` and `interruption` and lost nothing,
so the laptop debug app still drives it exactly as it did.

## 24. The deployed cook flow has no source in this repository, so it was rebuilt rather than restyled

There is a live page at `https://is-it-done-yet.vercel.app/`. It is the cook flow — title,
counter tally, recipe library, dish card — built to the same brief as the menu document, and it
is markedly plainer than that document intends: flat fills, plain outlined rectangles, no depth
anywhere, and both webfonts pulled from Google Fonts at runtime. The obvious task is to restyle
it in place. That turned out to be impossible, and establishing *why* is the first half of this
entry.

**Nothing on any branch contains that page.** Its title-screen copy ("Count my counter") appears
in no commit reachable from any ref. The two files its own HTML comment points at —
`src/ui/scan.ts` and an `api/vision` route — exist in no tree in the repository's history;
walking `git ls-tree` over every commit on every branch returns nothing for either. The
conclusion is not that the source was deleted, it is that it was never pushed: the page was
deployed from somebody's local working tree and that tree is the only copy. So there is no file
to edit, and "restyle the deployed page" reduces to "write the deployed page".

**What exists now is `homev2.html` and `src/home/`, a reconstruction.** The flow, the structure and
the copy were read off the live HTML and the shipped bundle — both are still fetchable, and the
bundle still carries its strings — and rebuilt against the tested core the rest of the app
already uses: `src/core/pantry.ts` for the tally and the matching, `src/core/recipe.ts` for the
dishes, `src/vision/segment.ts` for the frames. It is a third entry point beside the two that
were already there, and the three are deliberately not merged: `index.html` is the laptop debug
app, `app.html` is the artboard at its true 1440x810 scaled by one transform for reading through
a lens, and `homev2.html` is the same cook flow as a page that reflows into whatever window it is
opened in. `src/menu/` and `app.html` are untouched.

**The restyle is the three things the deployed page does not do.**

*Shading.* Nothing is a flat fill. Every raised surface carries `--gloss` — an inset white line
along its top edge and an inset warm shade at its bottom — so a panel reads as a lit object
rather than as a coloured rectangle. It is two inset shadows and it does more than any amount of
texture would.

*Depth.* `--lift` is a stack, not a blur: a coloured step in the object's own material, a hard
offset in the outline colour, then one soft drop underneath. That stacked hard offset is the
artboard's entire depth language, and it is the single largest visual difference from the
deployed page, whose cards sit flat on the ground behind a 3px outline and nothing else. Hover
lifts *away* from the light and the offsets grow to match; a press sinks the object and collapses
them. The dish card is the deepest object in the flow, on the widest offsets in the document,
because it is the screen the flow ends on.

*Typography.* Ranchers for display and Hanken Grotesk for text, both self-hosted from
`public/menu/fonts/` and preloaded rather than fetched from Google Fonts. The deployed page pays
a preconnect, a stylesheet round trip and a font fetch before anything is readable, and then
reflows every screen at once when the faces land — and since the whole design is set in those two
faces, that reflow is the entire page moving. The files were already in the repository. The
display face is also used at genuinely display sizes: the dish name is roughly four times the
size the deployed page sets it, and the wordmark carries the document's six-layer cream outline.

**One piece of copy was deliberately not reproduced, and it is the one the brief cares about.**
The deployed dish card's only action says "Start cooking". Pressing it writes "step tracking is
not wired up yet" into the note beside it. That is honest on the second press and a promise the
app cannot keep on the first, which is exactly the wrong way round — the label is what a visitor
reads and commits to, and the note is what they read after being let down. There is no guided
cook in this flow to start: the cutting round lives on `app.html` and has no notion of which dish
was picked, so wiring the button to it would swap one false claim for another. The button now
says **"Show the steps"**, and shows them. `recipe.steps` is real data, and every step already
carries `verifiable`, so each line says whether the counter camera can confirm it ("camera can
check this") or whether only the cook can ("you confirm this one"). That tag is the honest,
per-step version of the claim the old label was making across a whole recipe. The button is also
never disabled: readiness is what the ingredient count and the note above it report, and greying
out the only action on the screen because a tomato is missing would withhold the half of a recipe
that does not depend on the counter at all.

Everything else is the deployed page's copy word for word, including the two-detector
explanation, the group headings, "Cook something for me", "Browse instead" and "Identify
everything". Where a number is shown it is computed: the title screen's "3 dishes" is
`RECIPES.length`, its rank is `progressFor(0)` rather than a flattering literal, and the
library's "0 of 3 ready" is counted. The artboard's own "5 runs" flag has no data behind it and
so is not drawn; entry 22 settled that rule and this follows it.

**The deployed page fixed a bug in a comment, and the rebuild had reintroduced it.** Its HTML
carries a note saying the scan's status line must not be the tally's subtitle, because the live
loop rewrites that four times a second, so anything the scan put there — including the reason it
failed — was gone in 250ms and the button read as having done nothing at all. The reconstruction
wrote the deep scan's result, its failure reason and the recommender's "nothing is makeable yet"
straight back into that subtitle. `src/home/screens/counter.ts` now has its own `c-scanline`,
outlined and tinted by outcome, which the render path never touches. Worth recording because the
bug had already been solved once, in a comment, by someone whose code is gone.

**`src/home/` does not have the hidden-tab fit bug, and that was checked rather than assumed.**
`src/menu/stage.ts` used to retry its scale-to-fit on `requestAnimationFrame`, which does not run
in a background tab, so a board built while hidden stayed unscaled and overflowing and read as a
cropped design; it retries on a short timeout now. `src/home/` has no scale-to-fit at all — it is
a reflowing page, not an artboard — and its only two `requestAnimationFrame` calls are the camera
analysis loop in `src/home/scan.ts`, which is a genuine per-frame loop and *should* stop when the
tab is hidden, because there is no point segmenting frames nobody is looking at. Nothing to fix,
which is itself the finding.

**What is not verified.** `src/home/` has no unit tests. The suite has no DOM environment — all
501 tests run in plain Node — and adding jsdom to cover four screen builders was more risk to the
existing suite than the coverage is worth this close to the deadline. The screens were checked by
hand in a browser instead, at 1536, 820 and 420 CSS pixels, walking title → counter → library →
dish with the method open and testing for horizontal overflow at each width; there is none. The
camera path is unexercised beyond its closed state: the live count, the overlay and the stability
window have never run in this page against a real stream, only in `src/menu/`, from which they
were carried over unchanged. `api/vision` does not exist in this repository either, so "Identify
everything" probes for the relay at startup and disables itself as "(no key set)" — the branch
that runs locally is the one reporting the relay's absence, and the branch that actually calls it
has therefore never been exercised here.

## 25. The chef's bank can only say what was written in advance, so the headset never heard the model

**Spec section:** §9.2 and §9.3. §9.3 asks for a bank of lines pre-generated at load and played
instantly on game events, with a live agent reserved for open conversation. That is the right
design and it is what `src/audio/chef.ts` implemented. Entry 23 then built the open-conversation
half — the in-cooking chef, three channels, Qwen3 phrasing the answer. The two halves were
correct separately and did not meet.

**Reality:** the bank is a `Map` keyed by **exact line text**. It is filled by iterating
`allLines()` from `core/barks.ts`, and playback is `bank.get(bark.line)`. It can therefore speak
exactly the sentences somebody typed into that file and no others. Every line the guidance panel
produces is novel — Qwen3 writes its own, and even the model-free `localGuidance` assembles
sentences out of deficit text at runtime. Not one of them was ever in the Map.

On a laptop that miss is invisible, because `speechSynthesis` catches it, which is why this
survived being built and tested. Entry 19 measured the headset: `speechSynthesis` is **absent**
in Quest Browser, not unreliable, so the chef there "is either ElevenLabs or subtitles, with
nothing in between". A line that was never pre-generated is not in ElevenLabs either. The result
was that **every model-generated answer was silent on the only device this is built for**, and
the panel that was supposed to prove the chef could think was proving it in writing only.

Entry 19 called this out as far as the bank goes — it said the bank must be generated before a
headset demo starts and that the subtitle path has to carry the demo alone. What it did not
anticipate is that a whole feature would later produce text the bank structurally cannot hold.

**Decision: a fourth tier — synthesise novel text on demand — above the browser voice and below
the bank.** The two ElevenLabs tiers do two different jobs and both are kept. The bank exists so
a reaction to a cut arrives *with* the cut; a round trip per slice puts the chef a second behind
the knife, which is §9.3's own argument and still correct. The on-demand tier is for an answer
to a question, where the cook has already asked and is already looking at the panel.

**Whole clips, not streaming.** `chef.ts` already decodes an `arrayBuffer` into an `AudioBuffer`
and plays it through a source node; that path is the one known to work on the headset, and it is
reused rather than re-invented. Streaming would mean Media Source Extensions and hand-rolled
chunk handling on a browser that is already awkward, and it would buy almost nothing, because
the latency is solved elsewhere: `openingMove` speaks an acknowledgement the instant the button
is pressed and `present()` replaces all three channels when the real answer lands. The one thing
added for latency is `prime()`, which fetches that fixed acknowledgement at mount — a cover that
arrives four seconds late covers nothing.

**Through the relay, never a browser key.** `server/speech.mjs` is a sibling of `guidance.mjs`
and follows it exactly: zero dependencies, mounted at `/api/speech` by both `vite.config.ts` and
`static.mjs` so dev and production run the same handler, the upstream body never forwarded, the
key never leaving the server. It refuses to let the caller name the voice, which is the one
place it is *stricter* than the guidance relay — that relay lets a caller pick a model because
switching between a local Ollama and a hosted endpoint mid-demo is a legitimate thing to want,
and there is no equivalent reason to synthesise into a voice the caller chose. `.env.example`
has warned since the OpenAI work that a `VITE_` key is readable by anyone who opens the page,
and this repo publishes a built app.

**The browser-side bank generation keeps its browser-side key and was deliberately left alone.**
It runs once, at load, on a booth laptop we own, and routing it through the relay would trade a
known-working instant-bark path for a migration nobody asked for at this point in the schedule.

**This tier is load-bearing, so its failure mode got more design than the feature.** If it hangs,
the headset is silent and text is all that is left, so: a four-second ceiling per line, shorter
than the bank's, because the acknowledgement only covers so much; one failure is tolerated and
the second retires the tier for the life of the page; and a 404 or a 503 retires it immediately,
because those mean the deployment has no voice rather than that the network is having a bad
second. That is a deliberate change of posture from the bank, which gives up after a *single*
failure — the bank is a load-time batch of thirty requests where the first failure predicts the
rest, and this is one request per answer across a whole session, where one timeout is weather.
Clips are cached by normalised text, so the same answer is never paid for twice, and two callers
wanting one line at once make one request.

All of that lives in `src/core/voice/speech.ts`, pure and tested, rather than in a counter buried
in a closure, because a rule about when to stop trying the network is exactly the kind of thing
that should be arguable in a test.

**With nothing configured, nothing changed, and that was checked rather than assumed.** The relay
is opt-in on `VITE_SPEECH_RELAY`, matching `configFromEnv` in `src/ai/qwen.ts`. In a browser with
it unset, pressing Unsure makes **zero** network requests and the browser voice speaks, exactly as
before. With the relay set but no key on the server, the first ask makes one POST, takes a 503,
speaks through the browser voice, and every ask after it makes no request at all.

**What is verified, and what is not.** The relay transport is proven end to end in a real browser
against a local stub standing in for ElevenLabs: `POST /api/speech`, a genuine `decodeAudioData`,
playback through an `AudioBufferSourceNode`, `speechSynthesis` untouched, and a second identical
ask served from the cache with no second request. The relay handler itself is tested against a
stub upstream for the things that are ours — the key never reaching the client, the upstream body
never being forwarded, the voice and model not being caller-selectable, every failure arriving as
a status the browser knows how to read.

**NO LIVE ELEVENLABS CALL HAS BEEN MADE FROM THIS REPOSITORY**, by this work or any before it.
The request shape in `server/speech.mjs` is the same one `src/audio/chef.ts` has always used for
the bank, and that is the whole of the evidence for it. The `eleven_turbo_v2_5` id is carried
over unchanged for the same reason and for one more: if the two tiers ever use different ids,
the pre-written barks and the on-demand answers become two renderings of one voice, and the seam
is audible. `ELEVENLABS_OUTPUT_FORMAT` is likewise unverified and is left unset by default so the
API picks the format the bank is known to decode. None of this is exercised until somebody sets
a real key and a real voice id and presses Unsure once.
