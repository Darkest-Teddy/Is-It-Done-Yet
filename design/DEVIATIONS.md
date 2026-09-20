# Deviations from the design reference

Every place the Unity build does not match `design/design-reference.html`, and why. The rule
throughout: keep the design's **intent** — chunky, outlined, weighty, cheerful — and change only
what a flat 1440×810 web mock cannot know about a headset.

---

## 1. Colour space: every hex is converted, not assigned

**Reference:** sRGB hex values in CSS.
**Build:** the Unity project renders in **Linear** colour space (`m_ActiveColorSpace: 1`).

A hex assigned straight to a `Color` in a Linear project is interpreted as already-linear and
renders visibly washed out — mid-tones lift, and this palette is almost entirely mid-tones, so
the whole design goes pale. The token importer runs every value through the sRGB transfer
function on the way in. This is a fidelity *fix*, not a compromise, but it is the single most
likely thing to be undone by somebody "simplifying" the importer.

## 2. Screens become a spatial layout, not seven panels

**Reference:** seven 1440×810 rectangles, each a complete screen.
**Build:** one world-space HUD plus grabbable panels.

A headset has no screen edge to lay out against. Porting the mock literally would produce a
1440×810 billboard floating in front of the cook, which is the thing Meta's own guidance exists
to prevent and which reads as a tablet taped to your face rather than as mixed reality.

Kept: every component, its colours, its shadow stack, its copy, its proportions.
Changed: where each component lives, which is now `LayoutConfig` in angular terms.

**Screens outside this build's scope, ignored per the brief** — none. All seven map onto
something in scope:

| Reference screen | Where it went |
|---|---|
| 1A Title screen | Onboarding / mode select |
| 1B Loading (gravity stack) | Onboarding loading state |
| 2A Counter tally | Ingredient checklist |
| 2B Chef's pick | Recipe book, "cook something for me" |
| 2C Recipe library | Recipe book carousel |
| 2D Dish card | Recipe detail + step rail source |
| 2E Competitive cutting | Live HUD + scoring + leaderboard |

The *content* of 2E's timed round is a timed challenge, which the brief excludes. The screen's
**components** — timer ring, stat tiles, leaderboard panel, bottom rail — are all in scope and
are built; the 90-second competitive mode behind them is not.

## 3. Text is sized in angular units, with a floor

**Reference:** pixel sizes from 10px to 132px.
**Build:** every size converted to **dmm** (1 dmm = 1 mm at 1 m) and floored at Meta's
documented **24 dmm** minimum for body text.

The reference's 10px and 11px micro-labels are below that floor and are raised to it. This makes
the label rows slightly taller than the mock and is not negotiable: a label nobody can read is
not a smaller label, it is a missing one. Ray targets are floored at 64×64 dmm with 16 dmm
padding, from the same guidance.

Sources: [Meta, Key considerations](https://developers.meta.com/horizon/design/mr-design-guideline/) ·
[Meta, Layouts](https://developers.meta.com/horizon/design/styles_layouts/).

## 4. Frosted glass is faked

**Reference:** opaque panels with inset highlights. No blur anywhere, actually — but the
translucency a spatial panel wants over passthrough would normally be a blur.

**Build:** a translucent gradient plus subtle noise in the panel shader, never a real blur.

A blur is a full-screen grab-pass per panel. On an XR2 Gen 2 rendering stereo at 72 Hz with a
dozen panels up, that is the frame budget gone. The gradient-plus-noise reads as glass at arm's
length and costs one texture fetch.

## 5. Shadows are baked into the panel shader, not real shadows

**Reference:** a five-part CSS `box-shadow` — two hard offset copies, one blur, two insets.

**Build:** the same five parts, evaluated analytically in the rounded-rectangle shader from a
signed distance field. Real-time shadows are off project-wide.

The hard offset copies are the load-bearing part of this design's character and they are *not*
what a real shadow looks like. Rendering them properly would have been wrong as well as slow.

## 6. Panel opacity adapts to the room

**Reference:** fixed opacity.
**Build:** opacity and text outline strength track the average luminance of the frame already
captured for the coach, smoothed.

A cream panel at 94% over a dark counter is perfect and over a sunlit white worktop is
invisible. This costs nothing — the frame is already in memory — and only runs once camera
consent has been granted. Nothing extra is captured, stored or sent.

## 7. Hover states become poke and proximity states

**Reference:** `style-hover` attributes, a translate-and-deepen-shadow lift.

**Build:** the same lift, driven by fingertip proximity and by poke depth. A headset has no
cursor, so "hover" is a distance.

The reference's hover offset is `translate(-3px,-4px)` with a deeper shadow. Preserved as a
1.5 mm lift toward the cook plus the deeper shadow, which reads the same and stays legible from
off-axis where a purely 2D offset would not.

## 8. Icons are upscaled rasters

**Reference:** 160×160 PNGs in the bundle.
**Build:** the same PNGs at 256×256 via Lanczos, for a power-of-two Unity can mip.

There is no vector behind these — they are raster originals in the design document itself. The
upscale is soft at close range. The native 160px files are committed in `design/icons/native/`
so a regeneration can start from real pixels rather than from the upscale. The inline SVG marks
*are* vectors and both the SVG and its raster are committed.

## 9. Two outline colours, kept

The headset screens outline in `#46101A`; the title and loading screens use `#3B2A1B`. This
looks like an inconsistency in the reference and is kept anyway: the warmer brown belongs to the
paper-ground screens and the colder one to the dark screens, and collapsing them to one makes
the title screen look grey.

## 10. Red panels carry display-sized text only

Measured: `#F5230E` against `#FFF3E4` is **3.74:1** — below WCAG AA for body text. The reference
only ever puts display-sized type on red, so this is a constraint made explicit rather than a
change. The importer refuses to set a body-sized label in any colour listed under
`contrast.largeTextOnly` in `design/tokens.json`. Same for the butter and pink chips (3.97 and
3.93).

## 11. PRACTICE theme introduces one colour that is not in the reference

`#2F6DA8`. The reference has one cool pair — a pale blue fill with dark blue ink — and neither
half can serve as an accent that carries light text. Derived as the saturated midpoint, then
measured: 4.95:1 against `#FFF3E4`, which is better than the reference's own red. Practice mode
also always shows a **PRACTICE** badge, because a mode that changes what a score means must
never be signalled by hue alone.

## 12. SAFE theme is derived, and deliberately dull

The reference defines no safe mode. Derived by documented rule (see `themes.SAFE.derivationRules`
in `design/tokens.json`): gold replaces red as the accent, type scales ×1.25, looping animation
stops and motion scales to 0.35, panels go fully opaque.

`danger` is left alone. Suppressing the one colour that means *stop* in order to calm the
palette would have been the wrong kind of calm.

---

## Visual comparison against the reference

Filled in from the Design Gallery contact sheet — see `design/previews/`. Anything not yet
compared says so rather than claiming a match.

### 13. What the gallery capture actually showed

Compared `design/previews/gallery-normal.png` against `design/reference/*.png`.

**Matches the reference:**

- The panel treatment. Cream fill, ink border, the two hard offset shadow copies plus the blur,
  the bright top lip and darkened foot. Side by side with 2A's "ON YOUR COUNTER" panel this is
  the same object.
- The chip system. All seven tones, each with the reference's own fill/ink pairing — the mint,
  butter, pink, blue and peach are pixel-matched to the CSS values.
- Corner radii and border weights scaling with the element, which is most of what makes this
  design look like itself.
- Ranchers for display, Hanken Grotesk for body, with the reference's uppercase transform and
  wide tracking on labels.
- The button states. Hover and pressed take the gold fill the reference's `style-hover` uses.

**Differs, on purpose:**

- **The timer is a ring, not a bar.** 2E draws a horizontal progress bar. A ring reads at a
  glance from any angle in a headset and a thin horizontal bar does not.
- **Every label is larger than its reference size**, because of the 24 dmm floor (§3). Most
  visible on the chips, whose 11px labels come up roughly 40% larger relative to the pill.
- **The gauges show an uncertainty band**, which the reference has no equivalent for. It exists
  because nothing here measures temperature.
- **The status marks are drawn, not typeset** (§8).

**Differs, and is not yet as good as the reference:**

- **The display type is slightly soft at large sizes.** 90pt SDF sampling holds up at chip and
  body size and is visibly softer than the reference at `screenTitle` and above. Fixable by
  sampling the display face at a higher point size into its own atlas; not done.
- **The panel's inner glow is subtler than the CSS inset highlight** at small sizes, because the
  glow width is a fixed 8 reference px rather than scaling with the panel.
- **No paper texture.** 1A has a 135° hairline stripe over its ground. Not reproduced — it
  belongs to a screen that has no background in XR.

**Not compared:** anything involving passthrough, real lighting, or a headset. These captures
are an orthographic render against a flat dark ground. They say the design system is faithful;
they say nothing about legibility over a real kitchen, which is the thing that actually matters
and which has not been tested.
