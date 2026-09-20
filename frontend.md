# frontend.md

Art direction and asset brief for MISE's public homepage, derived from an audit of `CLAUDE.md`
and checked against the code that actually exists.

Written to be executed by the `higgsfield-generate` skill. Every prompt in §7 is runnable as-is.

---

## 1. Audit method, and why it matters here

`CLAUDE.md` opens by disowning most of itself: "Everything from `# MISE — Master Build Spec`
onward is the original hackathon master spec... That spec is **doctrine, not description**."
It states its own §14 repo layout is **0% accurate**.

So nothing here is taken from the spec's prose. Every fact below was read out of a file:

| Claim | Verified against |
|---|---|
| Design tokens | `index.html` `:root` |
| Ingredient set, colours, shapes | `src/core/ingredients.ts` `PROFILES` |
| Stack, build, deps | `package.json` |
| Numeric display style | `index.html` `#score` and its comment |

Where the spec still governs, it is because §17 marks the rule as live. Those are quoted.

### One finding worth propagating

**The test count in every document is wrong.** `README.md` says 136, `CLAUDE.md` says 196, and
`CLAUDE.md`'s own trust table corrects the README to 196. A clean `npm test` on 2026-09-19
reports:

```
Test Files  17 passed (17)
     Tests  263 passed (263)
```

263 is the number used on the homepage. If any marketing copy quotes a test count, it comes
from a run, not from a document — all three documents currently disagree with the repository
and with each other.

---

## 2. What MISE is (one paragraph, use this voice)

A mixed reality cooking trainer that measures real knife cuts to the millimetre. The shipped
web build is narrower than the spec: a browser + webcam app that segments an ingredient on a
light board, tracks the uncut stub, and reports slice thickness cut by cut.

**Canonical pitch sentence** — from `CLAUDE.md` §1, use verbatim in the hero:

> It measures your real knife cuts to the millimetre.

**Naming constraint, non-negotiable.** `CLAUDE.md` forbids shipping the name "Papa's Cookeria",
because it sits too close to Flipline Studios' "Papa's ___eria" series for a public page. The
product is **MISE**, lowercase `mise` in UI chrome (matches the current `<title>`).

---

## 3. The governing tension — read before designing anything

The rubric in §2 / Appendix B scores **Design** but explicitly does **not** score **Visual
appeal**:

> "Separate from design, a project can look great, but this doesn't necessarily translate into
> a good user experience."

And §2 consequence 2: "Do not spend hours on photoreal food. Visual appeal is a non-criterion.
Those hours go into interaction clarity, which is scored under Design."

**Art-direction consequence:** the homepage earns points for *legibility and interaction*, not
for render quality. This is why §7 specifies **flat 2D vector food**, not rendered or photoreal
food. Flat is not the budget option here — it is the correct one, and it is also the only style
that survives rule #12 (below) on venue wifi.

---

## 4. Design tokens — copy exactly, do not invent

Lifted verbatim from `index.html`. The homepage must not introduce a second palette.

```css
--bg:     #0d0f12;   /* near-black page ground */
--panel:  #161a20;   /* raised surface */
--line:   #262c35;   /* hairline border */
--ink:    #e8ecf1;   /* primary text */
--dim:    #8b95a1;   /* secondary text, units, captions */
--accent: #8ee06a;   /* cucumber green — the single brand colour */
color-scheme: dark;
```

`--accent` is a cucumber green and that is not a coincidence — cucumber is the hero ingredient,
and the only profile tuned to survive a shrinking stub. Treat `#8ee06a` as *the* brand colour.
One accent, used sparingly, on a dark ground.

### Typography

Two faces, both system stacks — no webfont, no network request (see rule #12).

```css
/* prose, headings */  ui-sans-serif, system-ui, -apple-system, sans-serif
/* every number   */   ui-monospace, SFMono-Regular, Menlo, monospace
```

**All numerals carry `font-variant-numeric: tabular-nums`.** Non-negotiable: the numbers change
every frame and must not reflow.

---

## 5. The number style is the brand

`index.html` carries this comment above `#score`:

> Master spec 7.4: "Display plain numbers. A judge parses that in one second." So the sentence
> is the interface, at a size somebody reads from behind your shoulder.

Spec §7.4 gives the exact form:

> `"4.2mm average, ±1.8mm. Target 3mm, ±0.5mm."` — "A judge parses that in one second. 'Score:
> 72/100' tells them nothing."

**Never render a 0–100 score, a star rating, a letter grade, or a progress bar as the primary
readout.** A millimetre figure with its tolerance is the house style. Carry it onto the homepage.

---

## 6. The ingredient palette — six foods, colours taken from the detector

These are the **only** foods to draw. They are not a mood board: each is a tuned profile in
`src/core/ingredients.ts`, and its `hueCentreDeg` is the hue the running app looks for. Drawing
a food in a hue the detector does not recognise puts the marketing art and the product in
disagreement.

`elongation` is the detector's own major/minor axis ratio — use it as the drawing aspect ratio.

| Food | Hue | Swatch | Elongation (draw at) | Silhouette |
|---|---|---|---|---|
| **cucumber** | 95° | `#8ee06a` | 1.6 – 20 | long rounded cylinder, hero |
| **tomato** | 2° | `#e2483d` | 1.0 – 1.4 | round, slight shoulder dip |
| **orange** | 28° | `#e8892a` | 1.0 – 1.3 | round, dimpled pole |
| **carrot** | 24° | `#e07b28` | 3.0 – 12 | long taper to a point |
| **lemon** | 54° | `#e3c53f` | 1.1 – 1.8 | oval, nub at both ends |
| **red onion** | 300° | `#a05ba8` | 1.0 – 1.5 | round, papery vertical striation |

Cucumber is the hero and should outnumber the others roughly 2:1 in any falling composition —
it is the ingredient the app is tuned for end to end.

---

## 7. Asset manifest — runnable commands

**Model choice.** `higgsfield-generate` routes "logo, icon, vector-like illustration, brand
mark, controlled-palette graphic" to **Recraft V4.1** with `--model_type vector`. That is the
correct model here: flat 2D, controlled palette, clean edges, no photoreal drift. Do **not**
fall back to `gpt_image_2_5` — it returns rendered and lit food, which breaks §3.

**Recraft returns SVG, not PNG**, when `--model_type vector` is set. That is better than the
raster plan this section originally carried: the art scales to any lane width, and it can be
edited with a script instead of a raster editor.

**Put colour in the parameters, not the prompt.** `higgsfield model get recraft_v4_1` shows
three structured params that matter more than any prompt wording:

| Param | Use |
|---|---|
| `--background_color "#0d0f12"` | paints one flat full-canvas rect, trivially removable |
| `--colors @palette.json` | constrains the palette to a `#RRGGBB` array — this is what keeps the six on-brand |
| `--aspect_ratio` | `9:16` for cucumber and carrot, `3:4` for lemon, `1:1` for the round three |

Passing hex codes inside the prompt text instead is unreliable; the model treats them as prose.
`colors` is enforced. Note the model still adds a tint or two of its own — that is fine, it
stays within the family.

**Shared style suffix** — append to every prompt so the six assets read as one set:

> flat 2d vector illustration, single centred object, bold clean outline, limited flat colour
> palette, no gradient mesh, no photorealism, no text, no shadow, slight geometric
> stylisation, editorial kitchen icon style

```bash
# Cucumber — hero asset, generate first and judge the set against it
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a whole cucumber, deep grass green #8ee06a, long rounded cylinder lying horizontal, subtle lengthwise ridges, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"

# Tomato
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a ripe tomato, warm red #e2483d, round with a slight shoulder dip and a small green calyx, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"

# Orange
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a whole orange, saturated orange #e8892a, round with a dimpled pole, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"

# Carrot
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a carrot, burnt orange #e07b28, long tapering cone to a point with a cropped green top, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"

# Lemon
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a lemon, bright yellow #e3c53f, oval with a small nub at each end, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"

# Red onion
higgsfield generate create recraft_v4_1 --model_type vector --wait \
  --prompt "a red onion, magenta purple #a05ba8, round bulb with papery vertical striation and a dry top, flat 2d vector illustration, single centred object, bold clean outline, limited flat colour palette, no gradient mesh, no photorealism, no text, no shadow, pure #0d0f12 background, slight geometric stylisation, editorial kitchen icon style"
```

### Post-processing, required

Download each result to `public/food/<name>.svg`, then run the cleaner:

```bash
node scripts/clean-food-svg.mjs public/food/*.svg
```

It removes exactly two things and exits non-zero if it cannot find the background:

1. **The C2PA `<metadata>` manifest.** Provenance data no browser reads. On the cucumber it was
   17,700 of 35,583 bytes — half the file.
2. **The full-canvas background rect**, matched on *geometry* (the path tracing the viewBox),
   never on fill. The same `#0d0f12` is reused for small dark details on the food itself, so
   matching on colour would delete the shading. The cucumber keeps 9 such detail paths.

Measured result — **92KB for the set**, against a 240KB budget:

| Asset | Raw | Cleaned |
|---|---|---|
| lemon | 21.2KB | **3.8KB** |
| carrot | 22.2KB | **4.8KB** |
| tomato | 22.5KB | **5.1KB** |
| onion | 28.5KB | **11.1KB** |
| cucumber | 34.7KB | **17.4KB** |
| orange | 54.6KB | **37.2KB** — the pitted-peel prompt generates a lot of paths |

Then set `src` in the `FOODS` manifest in `public/home.html`:

```js
const FOODS = [ { name: 'cucumber', src: '/food/cucumber.svg', w: 58, h: 104, ... } ]
```

**`w:h` must match the `aspect_ratio` the asset was generated at.** The art is stretched to the
element box, so a 9:16 asset in a 30×104 box (0.29) is visibly squashed. Setting `src` back to
`null` falls through to the drawn placeholder, which is also the automatic fallback if the file
404s — the page never shows a broken image (rule #9).

---

## 8. Frontend rules inherited from §17

These are the spec rules that survive and bind the homepage:

- **#12 — "when ambiguous, pick what survives a live demo on bad wifi."** The most load-bearing
  rule for this page. No webfonts, no CDN, no framework, no video background. The page must
  render completely with the network cut after first byte.
- **#11 — every magic number on a live slider.** The falling animation's tunables (spawn rate,
  fall speed, sway, food count) live in one `TUNABLES` block at the top of the script, not as
  literals scattered through the loop.
- **#10 — never block the render loop.** Animation runs on `requestAnimationFrame` with CSS
  transforms only. No layout-triggering properties (`top`, `left`, `width`) inside the loop.
- **#9 — every network call gets a timeout and a fallback.** The homepage makes **zero** network
  calls. Food art is either a local PNG or an inline SVG fallback; a missing PNG degrades to the
  SVG rather than showing a broken image.
- **#3 — vertical slices.** Cucumber done properly beats six foods half-drawn.

### Accessibility (scored under Design, unlike visual appeal)

Spec §12 lists the accessibility set as a shipping item: "One-handed / seated / colorblind-safe
/ subtitled / multilingual." For this page that means:

- `prefers-reduced-motion: reduce` **stops the falling animation entirely** — static, arranged
  food instead. Not merely slowed.
- The interaction must be keyboard-reachable; falling items are focusable and Enter/Space acts.
- Never encode meaning in hue alone — the six foods differ in **silhouette** as well as colour,
  which is why §6 gives an elongation for each.
- Contrast: `--ink` on `--bg` is roughly 15:1, `--accent` on `--bg` roughly 11:1. Both clear
  AAA. Do not put `--dim` (about 5.4:1) on anything smaller than 12px.

---

## 9. Do not

- Do not use photoreal or 3D-rendered food. §3.
- Do not introduce a colour outside §4 plus the six food hues in §6.
- Do not show a 0–100 score, star rating, or letter grade. §5.
- Do not add a webfont, icon font, CSS framework, or animation library. Rule #12.
- Do not ship the name "Papa's Cookeria". §2.
- Do not modify `index.html` — that is the live detection tool. The homepage is a separate
  document at `public/home.html`.
