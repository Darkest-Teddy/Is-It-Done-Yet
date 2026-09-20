# The design system

`design/design-reference.html` is the source of truth. Everything in this folder is derived
from it by `tools/design-extract/`, and everything in `unity/Assets/IsItDoneYet/Design/` is
generated from `tokens.json`. Nothing is hand-copied, because two hand-maintained copies of a
palette diverge inside a day — usually the day of the demo, usually in the one colour nobody
looks at until it is on a wall.

## What is in here

| Path | What | Made by |
|---|---|---|
| `design-reference.html` | The reference. A self-extracting bundle: base64 assets in inline script tags, a loader that rebuilds the document, a React component mounted over it. | — |
| `tokens.json` | **The source of truth for the build.** Colours, shadows, type, motion, XR floors, three themes, measured contrast. | hand-written from the extraction |
| `reference/` | Every screen at 1x and 2x, plus `index.json` | `render.mjs` |
| `extracted/` | Computed styles for 154 distinct components, and the decoded template | `render.mjs` |
| `previews/` | The Design Gallery rendered per theme, plus a contact sheet | `DesignGalleryBuilder` |
| `icons/png/` | 256px rasters Unity imports | `icons.mjs` |
| `icons/native/` | The bundle's original 160px pixels, so a regeneration starts from the real thing | `icons.mjs` |
| `icons/svg/` | Vector marks — the reference's, plus five drawn for this build | `icons.mjs` |
| `fonts/` | The two TTFs with their OFL texts and a SHA-256 each | `fonts.mjs` |
| `CREDITS.md` | Every asset's licence | hand-written |
| `DEVIATIONS.md` | Every place the build does not match the reference, and why | hand-written |
| `PERFORMANCE.md` | The budgets and how to measure them | hand-written |

## Regenerating

```bash
cd tools/design-extract && npm install && npx playwright install chromium
node render.mjs      # screenshots + computed styles
node icons.mjs       # icon rasters
node fonts.mjs       # fonts, with licences and hashes
node contrast.mjs    # fails if a recorded contrast ratio drifted

# then, in Unity (batchmode is fine; quit the Editor first)
tools/unity/compile.sh -executeMethod IsItDoneYet.Design.Editor.FontAssetBuilder.BuildAllBatch
tools/unity/compile.sh -executeMethod IsItDoneYet.Design.Editor.DesignGalleryBuilder.CaptureBatch
```

`node_modules` and the Chromium download are gitignored. Nothing in `tools/` ships.

---

## HTML component → Unity implementation

Every distinct component in the reference, and what it became. Paths are under
`unity/Assets/IsItDoneYet/`.

| Reference | Where it appears | Unity | Notes |
|---|---|---|---|
| Cream panel, 5px ink border, 26px radius, five-part `box-shadow` | Every screen | `Design/Components/GlassPanel.cs` + `Shaders/RoundedPanel.shader` | The whole shadow stack is evaluated analytically from an SDF. See DEVIATIONS §5. |
| Stadium chip (`border-radius:999px`, 3px border, uppercase label) | "25 MIN", "LEVEL 2", "9 OF 9 ON THE COUNTER" | `Design/Components/Chip.cs` | `ChipTone` resolves fill **and** ink together, so a mint chip can never get mint text. |
| Dashed-border pill | "HOW TO PLAY", optional ingredients | `GlassPanel.Dashed` | A per-instance float, not a shader keyword — one material is shared. |
| Primary CTA (red panel, display type, hold-to-start hint) | "START COOKING", "COOK SOMETHING FOR ME" | `Design/Components/PillButton.cs` | Hover is a lift toward the cook; press is a depress. See DEVIATIONS §7. |
| Recipe card (art well, title, chip row) | 2C library grid | `Design/Components/Card.cs` | Cover art is procedural from the server's three hex values. No images. |
| Ingredient row (tinted, icon, name, count) | 2A tally, 2D ingredient list | `App/Features/ChecklistPanel.cs` | Missing goes amber, never red. |
| Leaderboard row + "This week" header | 2E | `App/Features/LeaderboardPanel.cs` | Hangs on a real wall via MRUK. |
| Top-3 podium | implied by 2E | `LeaderboardPanel.RenderPodium` | Bar heights are ranked, not proportional. |
| Timer card with a progress bar | 2E "TIME LEFT" | `Design/Components/ArcGauge.cs` + `Shaders/ArcGauge.shader` | A ring, not a bar — see DEVIATIONS §2. |
| Stat tile (label + display value) | 2D difficulty/time/knife, 2E even-cuts/pace | `GlassPanel` + two `Label`s | |
| Difficulty knife pips | 2D | `icons/svg/mark-00.svg` | |
| Big score number | 2A "12 ITEMS", 2E scores | `Design/Components/NumberRoll.cs` | Rolls, punches on gain, allocates nothing. |
| Search field with a hit count | 2C | *not built* | Search is server-side; the headset has no text search UI in scope. |
| Filter chip row | 2C | `Chip` | |
| Bottom control rail (A/B/X/Y, GRIP, TRIG) | every headset screen | `App/Hud/HudRoot.cs` | Becomes the curved side menu — a headset has no screen edge. |
| Dashed section divider | 2A, 2C, 2E footers | `Design/Components/Divider.cs` | `ShadowLevel = "flat"`; a rule with a drop shadow reads as a seam. |
| Floating ingredient tags over the counter | 2A | `App/Hud/ToastStack.cs` | Same idea, retargeted at coach messages. |
| Title lockup with a thick text-shadow outline | 1A | `Design/Components/Label.cs` outline | The outline is what survives passthrough. |
| "AR" corner badge | 1A | `Design/Components/Badge.cs` | Carries the PRACTICE word. |
| Rank pill (avatar + rank + title) | 1A | `Chip` + `IconQuad` | |
| Gravity-stacked burger loader | 1B | `icons/svg/{bun,patty,cheese,tomato,lettuce}-*.svg` + `Easing.Squash` | The `cubic-bezier(.3,1.5,.5,1)` overshoot is a token. |
| Loading progress bar | 1B | `ArcGauge` (sweep < 360°) | |
| Checkerboard footer | 1B | *not built* | Decoration on a screen that has no edge in XR. |
| `idy-bob` / `idy-tag` float loops | 1A, 2A | `Design/Motion/TweenRunner.cs` | Stopped entirely by SAFE's `loopingAnimation: false`. |
| `idy-press` button hint | 2A, 2D | `PillButton` travel | |
| `idy-chop` / `idy-slice` | 2E | *not built* | Belongs to the timed cutting mode, which is out of scope. |
| `idy-scan` sweep | implied | `App/Features/ScanCardPanel.cs` | Bounded well under the 3 Hz flash limit. |
| `idy-pop` card entrance | 2B | `TweenRunner` + `pop` duration + `overshoot` easing | |

### Components in the system that the reference does not have

Built because a headset needs them, in the reference's language:

| Unity | Why |
|---|---|
| `Toast` with a confidence pip bar | A model's sentence rendered with full typographic confidence invites exactly as much trust as a thermometer. Four pips out of five says what a hedge word cannot. |
| `ArcGauge` uncertainty band | Nothing here measures temperature. A crisp needle would be a lie told fluently. |
| `StepRail` | The reference shows one step at a time; a cook mid-recipe needs to see where they are. |
| `IconQuad` status marks | Neither licensed font has a check or a cross. See DEVIATIONS §8. |
| `CameraIndicator` | A headset camera points at somebody's home. |
| `AdaptiveLegibility` | A cream panel is perfect over a dark counter and invisible over a sunlit worktop. |

---

## The Design Gallery

`IsItDoneYet/Design/Build Design Gallery` builds it; `IsItDoneYet/Capture Design Previews`
renders it to `design/previews/`. Both are Editor-only and the scene lives under an `Editor/`
folder, so it cannot reach a player build.

It is built **from code**. A hand-assembled gallery drifts, and a gallery that has quietly
stopped showing every state is worse than none, because people trust it. It found three real
rendering bugs the first time it ran — see the commit, and DEVIATIONS §13.
