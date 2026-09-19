# PHYSICS

Every constant and derivation in the simulation. Master spec rule #14: cite it, or mark it
`TUNED, not sourced` explicitly. Never invent a coefficient.

## Scope

This document currently covers Discipline A (knife work), which is geometry. The thermal
constants for Discipline B arrive with the §8 milestone and belong under a second heading here.

## Derivations

### Cut plane from a blade sweep

The blade occupies a segment from heel to tip. Between two frames it sweeps a ruled surface
whose four corners are the heel and tip at each frame. Master spec §7.2 takes the normal as
`normalize(cross(bladeDirection, sweepDirection))`.

We instead fit the normal across all four corners by Newell's method:

```
nx = Σ (y_i − y_j)(z_i + z_j)
ny = Σ (z_i − z_j)(x_i + x_j)
nz = Σ (x_i − x_j)(y_i + y_j)        j = (i+1) mod 4
```

Newell is exact for a planar polygon and degrades to a least-squares fit when the polygon is
not planar, which is what lets us measure the error rather than hide it. The sign is then
aligned with `cross(bladeDirection, sweepDirection)`, so the normal's direction is a function of
master spec §7.2's definition rather than of Newell's winding order.

That is a narrower claim than "stable frame to frame", which is what this section used to say,
and the difference was worth measuring. For a blade that is rigidly translated or rotated — the
physically realistic sweep — the alignment is a **no-op**: the corner list
`[prev.heel, prev.tip, curr.tip, curr.heel]` traverses `+blade, +sweep, −blade, −sweep`, so
Newell's right-hand normal already *is* `cross(blade, sweep)`. Measured: 0 disagreements in
95,127 accepted fits over translations plus rotations up to ±0.3 rad. It only bites when the
swept quad is not simple — a tracker re-labelling the blade's heel and tip between frames folds
the quad into a bowtie, and Newell then returns the signed difference of the two lobes, which
can point either way. Across arbitrary four-point poses the two disagree for about 12% of
accepted fits.

The sign does not reach the thickness metrics: flipping the normal maps `θ → θ + π` in
`radial(θ)`, which rotates the cap ring onto itself by half a turn and leaves the axis crossing,
the min-to-max spread and the volume unchanged. It matters to consumers that care about
orientation — cut-face mesh winding, ribbon direction — which is why it is pinned rather than
dropped.

**Planarity residual** is the maximum perpendicular distance from any corner to the fitted
plane. It is zero for a pure translation sweep and grows as the blade rotates mid-sweep, because
the swept surface is then a hyperbolic paraboloid rather than a plane. Above
`MAX_PLANARITY_RESIDUAL_M` the sweep is subdivided and each part solved independently.

**The subdivision scales the minimum-sweep gate by `1/n`.** When a sweep is subdivided into `n`
parts, each part is refitted with `minSweepM / n` rather than with `minSweepM`. This has a
seven-line code comment and a dedicated regression test and belonged here too, because it is a
policy decision rather than an implementation detail.

The minimum-sweep gate asks *did the blade move at all* — a property of the whole stroke, not of
an arbitrary fragment of it. Holding the full threshold against each part rejects every
subdivision of a genuine cut as `no-sweep`, so the planarity check that the subdivision exists
to satisfy never runs, and a rotating sweep is refused instead of being solved piecewise.
Measured on the regression fixture: a 20 mm sweep split 8 ways gives parts of ~3.5 mm, each
individually below the 4 mm gate, while the stroke as a whole is five times over it. Dividing
the threshold by the same `n` the stroke was divided by keeps the gate measuring the stroke.

Read the number with its factor of four. The distance is taken to the plane through the
**centroid**, and for a skew quad the four signed distances to that plane are `±d/4`
alternating, where `d` — the quantity a reader is more likely to picture — is the distance of
one corner from the plane of the other three. Measured ratios are 3.999, 3.997 and 3.990 at
0.5°, 1° and 2° of blade roll. So `MAX_PLANARITY_RESIDUAL_M = 0.002` admits a sweep whose corner
sits 8 mm out of the plane of the other three. The code matches the definition above; the
constant is calibrated against the residual, not against `d`.

This number is what substantiates §7.4's claim that cut planes are exact rather than estimated.

### Plane–lathe intersection

A lathe solid is the surface of revolution `(r(y)·cosθ, y, r(y)·sinθ)` about the y axis.
A plane is `n · X = n · p`. Substituting, and writing `radial(θ) = nx·cosθ + nz·sinθ`:

```
ny·y + radial(θ)·r(y) = n·p
```

This is implicit in `y`, because `r` depends on `y`.

**Why not fixed-point iteration.** Rearranging to `y = φ(y)` where
`φ(y) = (n·p − radial·r(y)) / ny` and iterating is the obvious approach, and is what this
solver originally did. It is unsound. The map has derivative

```
φ'(y) = −radial(θ)·r'(y) / ny
```

and Picard iteration converges only where `|φ'| < 1`, that is `|radial·r'(y)| < |ny|`. Since
`|radial| ≤ sin(α)` and `|ny| = cos(α)` for a cut at angle α from square, the condition is

```
|r'(y)| < cot(α)
```

For the cucumber profile the steepest slope is inside the tip cap, where the cosine closure
contributes `dP/dt = −(π/2)/(1 − 0.93) ≈ −22.4` at full closure; scaled by `R/L`, this gives
`|r'| ≈ 2.04` at the tip. So every cut steeper than `atan(1/2.04) ≈ 26°` whose face reaches
into the cap region has a **repelling** root, and no iteration count can reach it — the
iteration settles into a stable two-cycle and returns a finite, plausible value wrong by
millimetres. Measured example: a 40° cut at t = 0.9 produces a ring point at t = 0.961 where
`r'(y) = −1.4245`, `radial = −0.643`, `ny = 0.766`, so `φ' = −1.196`; the resulting two-cycle
straddles the true root by −2.3mm and +6.6mm, and satisfies a `|next − y| < tol` settling check
while doing so.

Note that the diverging point is not the cut position. The cut sits at t = 0.9, in the body;
the ring point that diverges sits at t = 0.961, inside the cap, because an oblique cut face
reaches forward along the axis. Judging the solver by where the cut is placed would have missed
this entirely.

**What the solver does instead.** Bisection on `g(y) = ny·y + radial·r(y) − n·p` over the
bracket `[solidLower(spec), solidUpper(spec)]`. Bisection assumes no contraction; given a sign
change across the bracket it halves the interval every pass unconditionally, so after n passes
the error is `(high − low) / 2ⁿ`. For a 0.18 m food item, 38 passes reach 1e-12 m; the solver
allows 64. That bound comes from arithmetic rather than from measuring a fixture, which is the
whole point of the change.

**The bracket must span the solid's material, not its axis crossing.** `lowerBound`/`upperBound`
report where a cap meets the *axis*; `solidLower`/`solidUpper` report where the *material* ends.
Those agree only for a flat cap. After an angled cut the stub's lower cap is a slanted ellipse
spanning `axis ± r·tan(α)`, so roughly half the ring legitimately sits below the axis crossing.
Bracketing from the axis therefore excluded real material: for those θ the root lay beneath the
bracket, `g` had no sign change inside it, and the no-sign-change rule below returned a bracket
endpoint — a point comfortably inside the solid, reported as the cut face running off an end.
Measured on a 0.021 m cylinder, a 20° cut 3 mm past a previous 20° cut clamped 23 of 64 ring
entries, reported a 10.64 mm wedge against a true 15.29 mm, and overstated the slice volume by
37%; by the third such cut the ring had collapsed onto the flat square-cut answer. Volume
conservation could not see any of it, because the slice and the stub are handed the same ring
and the error cancels in the sum — which is why the cylinder ring, wedge and slice volume are
now asserted against their closed forms directly.

Where `g` has no sign change across the bracket, the plane meets that radial line outside the
solid's axial span: the cut face runs off an end and stops there, and the solver returns the
bracket endpoint with the smaller residual. Deciding this *before* solving rather than clamping
a solved value afterwards matters — clamping is what previously laundered a diverged two-cycle
value into a plausible-looking one.

Where `g` changes sign more than once, the plane genuinely crosses that radial line more than
once and a cap ring — one y per θ — cannot represent it. Bisection returns one of the
crossings. That is a limit of the data structure, not of the solver.

**Axis intersection** is the θ-independent case, `y = (n·p) / ny`, requiring `|ny| > 0`. Below
`MIN_AXIS_DOT` the plane runs along the food's length; that is a lengthwise fillet, for which
"slice thickness" is undefined, and it is rejected rather than approximated.

**Wedge.** For a constant-radius solid the radial term has amplitude `r·√(nx² + nz²)`, so:

```
max y − min y = 2·r·√(nx² + nz²) / |ny| = 2·r·tan(angle)
```

since `n` is a unit vector and `|ny| = cos(angle)`. This closed form holds exactly only for a
cylinder; for a tapered profile `r` varies around the ring, so the solver reports the actual
min-to-max spread of the computed cap ring rather than this formula. The formula is what the
cylinder case is verified against, for angles from 5° to 50°, in `harness/conformance.test.ts`.

**`wedgeMm` is an AXIAL spread, not a face-to-face thickness variation.** The two differ, and
the name invites the wrong reading — `wedgeMm` sits in `CutGeometry` beside a perpendicular
`thicknessMm` and an axial `axialDeltaMm`, so which frame it lives in is not guessable.

| Quantity | Value for a cylinder | What it is |
|---|---|---|
| `wedgeMm` | `2·r·tan α` | Spread of the cap ring **along the axis**: max y − min y |
| Face-to-face variation | `2·r·sin α` | How much thicker the slice is at one edge than the other, measured **perpendicular to the faces** |

They are related by the same `cos α` that relates `axialDelta` to `thickness`, and the gap is
not negligible: at α = 40° the perpendicular figure is 23% smaller than the axial one
(`sin 40° / tan 40° = cos 40° = 0.766`). The definition in this document — "max y − min y" — is
the correct one and matches the code; the docstring on `CutGeometry.wedgeMm` reads
"thickness spread across the cut face: 2 r tan(angle)", which states the right formula under a
description that sounds perpendicular. Read `wedgeMm` as axial.

### Volume of a clipped lathe

In cylindrical coordinates the volume element is `ρ dρ dθ dy`. Integrating ρ from 0 to `r(y)`:

```
V = ∫₀^2π ∫_lo(θ)^hi(θ) ( r(y)² / 2 ) dy dθ
```

The inner integral is evaluated by Simpson's rule over the profile samples; the outer by uniform
summation over the radial segments, which is spectrally accurate for a periodic integrand.

**Splitting at profile breakpoints.** Simpson's rule assumes a smooth integrand and loses most
of its accuracy across a derivative discontinuity — and, critically, the size of that error
depends on where the kink falls relative to the grid. The cucumber's tip cap kinks at t = 0.93.
Without splitting there, integrating a whole solid disagrees with integrating its two pieces and
summing them, by ~1e-3 relative — which is exactly the volume conservation the cut solver relies
on. `ProfileFn` therefore declares its breakpoints and the quadrature splits at any that fall
inside the span, keeping every Simpson pass on smooth ground. Relative error drops to ~1e-7,
ordinary truncation error on a smooth interval.

**Why not `π ∫ r(y)² dy`.** That form assumes both end caps are flat discs perpendicular to the
axis, which is false for every angled cut. For two *parallel* caps the general form collapses to
exactly `π·r²·Δy` regardless of tilt, because every radial column then has identical axial
extent — this identity is asserted directly in `src/sim/lathe.test.ts`.

**`sliceVolumeM3` is clamped: `Math.max(0, volumeOf(slice, …))`.** A negative volume is therefore
rounded to zero and reported as a successful cut rather than surfaced as a fault. This is a
deliberate floor against quadrature noise on a near-empty span, but it is worth stating plainly,
because it is the one place in this module where a wrong answer is silently made plausible
instead of being refused — everywhere else, a condition the solver cannot represent throws or
returns a typed rejection.

It also makes `expect(sliceVolumeM3).toBeGreaterThanOrEqual(0)` unfalsifiable: the only value
the clamp admits that is not `≥ 0` is `NaN`. The fuzz asserts strictly positive, and no larger
than the whole stock, instead.

### Thickness

Two distinct quantities, and conflating them is a real error:

| Quantity | Definition | Who can measure it |
|---|---|---|
| Axial delta | Drop in stub length along the axis | Camera (§7.3) and blade pose |
| Perpendicular thickness | Face-to-face distance of the disc | Blade pose only |

They are related by `thickness = axialDelta · cos(angle)` and coincide when the cut is square.
A silhouette contains no angle information, which is why the camera path can never recover the
perpendicular figure. Scoring uses the perpendicular one.

### Hand extension ratio

```
extensionRatio = |tip − proximal| / |intermediate − proximal|
```

Using adult index-finger proportions — proximal phalanx ≈ 40mm, remaining two phalanges ≈ 38mm
combined (Buryanov & Kotiuk, *Proportions of Hand Segments*, Int. J. Morphol. 28(3), 2010) — a
fully extended finger gives `78/40 ≈ 1.95` and a fully curled one gives `≈ 0.88`. Master spec
§7.5's threshold of 1.3 sits between them with comfortable margin, and is used unchanged.

This document previously gave the combined figure as ≈ 35mm and the extended ratio as 1.87. The
published middle and distal phalanx lengths for the index finger sum to ≈ 38mm, not 35mm. **The
conclusion is unaffected** — the correction moves the extended ratio *away* from the threshold,
from 1.87 to 1.95, so the margin around 1.3 widens rather than narrows, and the curled figure is
derived from the folded geometry rather than from this sum and does not move at all.

## Constants

| Constant | Value | Source |
|---|---|---|
| `CLAW_THRESHOLD` | 1.3 | Master spec §7.5; bracketed by the ratios derived above |
| `DANGER_MM` | 20 | Master spec §7.5 |
| `WARN_MM` | 45 | TUNED, not sourced — roughly twice the danger distance |
| `MIN_SWEEP_M` | 0.004 | TUNED, not sourced |
| `MIN_CROSS_SIN` | 0.17 | TUNED, not sourced — about 10° between blade and sweep |
| `MAX_PLANARITY_RESIDUAL_M` | 0.002 | TUNED, not sourced — a centroid-plane residual, one quarter of the corner-out-of-plane distance; see above |
| `MIN_AXIS_DOT` | 0.26 | TUNED, not sourced — cos(75°), beyond which a cut is a fillet |
| `CAP_BRACKET_TOLERANCE_M` | 1e-12 | Derived — bisection halts below this bracket width |
| `MAX_CAP_BISECTIONS` | 64 | Derived — 38 halvings suffice for a 0.18 m bracket; the rest is headroom |
| `MIN_NORMALIZABLE_LENGTH` | 1e-9 | TUNED, not sourced — below this a direction is noise |
| `CUCUMBER_LENGTH_M` | 0.18 | Master spec §7.6 |
| `CUCUMBER_RADIUS_M` | 0.021 | Master spec §7.6 |
| Cucumber profile coefficients | taper 0.22, bulge 0.05, cap 0.93 | Master spec §7.6 verbatim |
| `CUCUMBER_CAP_START_T` | 0.93 | Master spec §7.6 verbatim — the same 0.93 as the cap coefficient above, named in `lathe.ts` because it is used three times: taper cutoff, cosine denominator `1 − 0.93`, and the declared quadrature breakpoint |
| `MAX_SWEEP_SUBDIVISIONS` | 8 | TUNED, not sourced — the parts of a genuine cut stay well clear of `minSweepM / n` at this depth, and a sweep needing more than 8 is a stroke the blade rotated through, not a cut |
| `LATHE_RADIAL_SEGMENTS` | 64 | **Deliberately not** master spec §7.6's 32 — see below |
| `LATHE_PROFILE_SEGMENTS` | 24 | Master spec §7.6 — `cucumberProfile(lengthM, radiusM, segments = 24)` |
| `SAFETY_DEBOUNCE_FRAMES` | 4 | TUNED, not sourced — de-escalation only. Escalation is immediate; a warning that waits four frames to appear arrives after the injury |
| Scoring weights | 0.5 accuracy, 0.35 uniformity, 0.15 angle | Master spec §7.4 verbatim |
| Rejection feedback intensity | 0.25 | TUNED, not sourced — a quarter-strength buzz for `draw-stroke` and `non-planar`, enough to read as "that did not count" without reading as a successful cut |

**`LATHE_RADIAL_SEGMENTS` = 64 against master spec §7.6's 32.** §7.6's "32 radial segments. More
is draw-call budget you need elsewhere" is a statement about `THREE.LatheGeometry` — a GPU cost,
for the *visual* mesh. The same spec raises that mesh to 48 segments in its materials pass, so 32
is not a correctness figure and the spec does not treat it as fixed. This constant feeds the
*simulation*, where the count sets the cap-ring resolution and the outer quadrature, costs
microseconds in a headless module, and pays no draw calls at all. One name was doing two jobs.

Accuracy is the weaker half of the argument, and the measurements say so. Volume is indifferent:
32, 64 and 512 radial segments agree to 2e-13 relative, because the θ sum is spectrally accurate
for a periodic integrand. The wedge improves, but only because a coarser ring may miss the
extremes — for a normal lying in a coordinate plane the extremes land on sample points at any
even count and 32 and 64 agree exactly; rotating the normal out of that plane gives a relative
wedge error of 1.57e-3 at 32 against 8.85e-4 at 64, which is 0.038mm against 0.021mm on a
0.021 m cylinder at 30°. Both are far inside the 0.5mm scoring tolerance, and running the whole
conformance suite at 32 breaks no figure in it.

What decides it is that 64 is the number every measurement in this document, the harness and the
test suite are already stated at — "clamped 23 of 64 ring entries", the wedge figures, the fuzz
residual counts. Choosing 32 would mean restating measured evidence to match a budget this
module does not pay. When a renderer exists, mesh tessellation should get its own key; the two
are coupled only because `volumeOf` requires a cap ring to be indexed at the segment count it
was built at.

## Validation

Six conformance groups: analytic conformance against closed-form cylinder geometry, quadrature
additivity to better than 0.1% across a full cutting session, stub monotonicity,
degenerate-input rejection, a 10,000-pose fuzz with a seeded PRNG so failures reproduce, and a
scoring golden file.

### Volume conservation is not geometric validation

This section used to present group 2 as evidence that the cut solver gets the geometry right. It
is not, and cannot be made into one.

`solveCut` hands the **same** `capRing` array to `slice.upperCapRing` and to
`stub.lowerCapRing`, and `volumeOf` integrates radial column `j` from one to the other. Every
ring value therefore appears exactly once as an upper limit of integration and once as a lower
limit, and the sum telescopes:

```
Σⱼ ∫[ringⱼ → toM] + Σⱼ ∫[fromM → ringⱼ]  =  Σⱼ ∫[fromM → toM]
```

The right-hand side does not mention the ring. The identity holds for **any** ring values inside
the bracket — correct, collapsed, or arbitrary. Two mutations confirm it: defeating the solver so
that every cut is treated as square leaves every conservation check green, and so does forcing
every slice volume to zero. Group 3 (monotonicity) inherits the same blindness for a different
reason — stub length is measured at the axis, and the axis crossing is `n·p / ny`, computed
directly from the plane and never from the ring.

These checks are still worth running, under an accurate name. What they constrain is that the
quadrature is **additive across a split** — that Simpson's rule, split at the cucumber's tip-cap
breakpoint, gives the same answer for a whole solid as for its pieces summed. That was genuinely
broken before the breakpoint split went in, by ~1e-3 relative, which is exactly the 0.1% the
bound watches.

### What does constrain the solver

Absolute volumes, measured against something the solver did not produce.

- **Cylinder, closed form.** `π·r²·Δ` is exact for two parallel caps at any tilt, so the ring,
  the wedge and the slice volume are each asserted against their closed forms directly, cut
  after cut. This is what caught the cap-ring bracket defect that conservation could not see.
- **Cucumber, computed reference.** There is no closed form, so the reference is integrated:
  the same plane–lathe geometry at 512 radial × 256 profile against the shipped 64 × 24, by an
  independent routine with its own bisection, its own Simpson pass and its own θ sum.
  Deliberately *not* the shipped solver at a finer grid — a solver that treats every cut as
  square would produce a square reference too, and the two would agree to machine precision
  while both were wrong.

  The bound is derived from the two resolutions rather than chosen. Simpson is fourth order, so
  24 → 256 profile steps shrinks the reference's own truncation error by `(256/24)⁴ ≈ 1.3e4`,
  putting it four orders below the quantity being bounded; doubling the reference again to
  1024 × 512 moves it by at most 6.7e-12 relative, confirming it is effectively exact here. The
  shipped grid differs from it by at most **9.2e-8** relative across the fixtures, worst at 15°
  and t = 0.8. The asserted bound is **3e-7** — a little over 3× the measured worst case, and
  still 600× tighter than the smallest deviation a collapsed ring produces (1.9e-4 relative at
  20°, 3.5e-3 at 35°).
- **Cap-ring self-consistency, on every fuzz pose.** Each ring entry must satisfy the equation it
  was solved from. Entries sitting exactly on a bracket end came from the no-sign-change branch,
  are legitimately cap-bounded, and are counted rather than checked — 13,356 of 355,712, or
  3.8%. The bound is arithmetic, not calibrated: bisection returns a midpoint within 5e-13 m of a
  sign change, the restated form divides the residual of `g` by `ny`, and
  `5e-13 · (1 + max|r'|) / MIN_AXIS_DOT = 5e-13 · 3.04 / 0.26 ≈ 6e-12`. Measured worst case
  across 342,356 entries is 2.7e-12; the assertion is 1e-11.
- **The no-sign-change branch, deterministically.** Singled out above as correctness-critical,
  it used to execute only inside the fuzz, which asserted finiteness. It is reachable near the
  square end of the stock, where the profile does not close: 15 of 64 segments fire for a 30°
  cut at t = 0.05, 29 of 64 at 70°, and 25 of 64 for a 40° cut 3 mm past a 10° one. It does not
  fire near the tip — the profile closes the radius to zero, so `g` is positive at the top of the
  bracket for any radial direction and a root always exists. A cylinder fixture pins the
  branch's actual rule, *return the endpoint with the smaller residual*, by making the correct
  answer the **high** end; the low-end fixtures alone cannot distinguish that rule from "always
  return the low end".

The thermal milestone adds the validation that matters most for the technical score —
reproducing a published pan-searing curve the model was not fitted to. See master spec §8.9.
