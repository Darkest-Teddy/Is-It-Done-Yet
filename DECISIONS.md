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
