# Design and motion rules (Apple-style, adapted for patra-bus)

Source of inspiration: the "apple-design" skill by Emil Kowalski (ui-skills.com), itself based on Apple's WWDC talks
("Designing Fluid Interfaces", "The Details of UI Typography"). Summarised here in our own words, only what applies to this app.
Vanilla JS, no animation library: springs are implemented in a small local helper.

## 1. Response
- Visual feedback on `pointerdown`, never only on click/release. Pressed state: `transform: scale(.97)` within ~100 ms.
- No artificial delays on the input path (debounce only network calls, never visual feedback).
- Drags (bottom sheet) follow the finger 1:1 for the whole gesture, keeping the grab offset; use `setPointerCapture`.

## 2. Motion = springs, interruptible
- Anything the user can touch (sheet, cards that move, popovers) animates with a spring, not a fixed-duration CSS transition.
- Springs start from the **current on-screen value** and keep the current velocity when re-targeted, so a moving sheet can be
  grabbed and reversed at any moment without a jump.
- Two parameters: damping ratio and response (s). Defaults: UI moves `damping 1.0, response 0.35` (no overshoot);
  after a flick (gesture with momentum) `damping 0.8, response 0.3`.
- Release velocity is handed to the spring (no visible seam between drag and animation).
- Snap target from **projected** momentum: `end = pos + (v/1000) * d / (1 - d)`, `d ≈ 0.998`, then nearest snap point.
- Past the first/last snap point: rubber-band resistance `f(x) = x·D·c / (D + c·|x|)`, `c = 0.55`, never a hard stop.
- Animate only `transform` and `opacity`; `requestAnimationFrame`; `will-change` only while moving.
- The spring (`js/motion.js`, `createSpringLoop`) drives any single scalar, not only an x/y position: a popover's
  open/close progress (0..1, painted as opacity + scale) uses the same spring and the same interruptibility —
  a re-tap while it is still closing reverses from exactly where it is.

## 3. Spatial consistency
- Enter and leave along the same path (a sheet that rises sinks back; a popover grows from its trigger and shrinks back to it).
- Popovers/menus: `transform-origin` at the trigger.
- Route changes inside the sheet: content cross-fades in place; detail views slide in from the right and go back to the right.

## 4. Materials and depth
- Floating chrome (search bar, bottom sheet, locate button, toasts) = translucent material:
  `background: color-mix(in srgb, var(--card) 72%, transparent); backdrop-filter: blur(20px) saturate(180%)`,
  a faint bright top edge, soft shadow; bigger surfaces = stronger blur + deeper shadow than small chips.
- Never stack translucent on translucent. Text on materials: slightly heavier weight, full-contrast colour.
- Scroll edges: fade content under sticky headers with a mask, no 1 px divider lines.
- Modal = dim scrim; non-blocking panels (the sheet) = no scrim.
- `prefers-reduced-transparency: reduce` → solid surfaces, no blur. `prefers-contrast: more` → solid + defined border.
- Glass UI (TEL-83, on for everyone since 2026-10-29, `web/css/glass.css` + `web/js/glass.js`), aimed at Apple's Liquid Glass:
  **glass** = floating chrome over the map (☰, chips, locate FAB, sheet / side panel, menu popover, setup and
  welcome dialogs): very see-through (22% card colour, 28% big; dark 30/36%), *light* blur (10/14px) so the map stays
  clear, bright top edge + rim, a static top sheen (no shine that moves: not ambient, not under the finger), and on Chromium a lens bend at the edges (SVG displacement in `backdrop-filter`; Safari: blur only). **Touch & hold** (Apple-style, everything pressable): the control grows a little
  (~10 px, ≤ 8%, instead of §1's .97 shrink; **round buttons ~16 px, and pop out above their neighbours**), leans a few px
  towards the finger and turns more opaque, then springs back with a small wobble. **Full-width list rows** (stops, lines,
  place suggestions) neither grow nor turn grey: a soft glass highlight fades in behind them and out again. The locate
  button fills with the app's blue while held and sends out a ring on a tap. **Sheet** (TEL-222, Apple Maps iOS 26): three states.
  Low = a tight floating card (grabber + the view's first row), almost clear; mid (default) = the same card, larger,
  more opaque; up = whole screen, edge to edge and to the bottom, solid (light grey with white cards; dark grey in dark
  mode), no glass. Moves: low→mid a hint of bounce, mid→low a little more, mid↔up no bounce (it darkens and fills).
  The grabber is tight; held, it widens inside a small glass capsule and ticks at each state.
  **Search** (TEL-223): ☰ stands alone at the top left, a round glass button; the search is home's first row in the
  sheet (a grey capsule, no glass of its own, no microphone), so low on home = grabber + search. Tapping it takes the
  sheet up and shows the results there, in place of the view, on the solid up colour (0.5 px hairlines between rows);
  closing it (the ✕ next to the field, Escape, a tap outside) puts the sheet back where it was. At up on home the sheet
  reaches the top and the ☰ slides down into the search row, left of the field (TEL-223 B); an empty field shows recent
  searches and the nearby stops. Other views put their own header in
  the search's place, with a ✕ back home.
  **Low on a stop** (TEL-224): the name (at most two lines), and the lines arriving as flat coloured pills (the badges
  alone); dragging up, the pills grow into the filter chips with the sheet ("All" unfolds in front), and back.
  **Mid fits the view** (TEL-224): on a stop it ends 20% into the second arrival (the first whole, a glimpse of the
  next says the list goes on); on home, under its card; 35–60% of the screen, and it follows as the content loads.
  Mid is where most releases land (a slow flick moves one state; only a fast one, ≥ 1200 px/s, skips mid: up ↔ low), and the map
  stays still while the sheet moves; once the sheet is let go between low and mid, the map glides its focus (the stop,
  or your location on home) to the centre of the part left above the sheet, as in Apple Maps. Legibility comes
  from heavier text and a soft halo in the surface colour, not from frosting. **Tinted** = surfaces inside the sheet
  (45% card colour, no blur of their own; `.material` there drops it). **Exception to "never stack":** the sticky
  headers in the sheet (stop line chips, planner head) have no band at rest; once the list scrolls under them a blur
  layer fades in behind them, feathered at the bottom (no edge, no line), like iOS bars. The line chips are small glass
  pills. **Menu:** morphs out of the ☰ button: pressed, ☰ is a whiter glass circle;
  as the menu opens, its glass starts clear over that circle and its blur grows with it, so the ☰ lines blur out through
  it and a ✕ blurs in where they were (the open menu's close button); the circle swells around the button, then opens into the panel (items fade in late); closing runs the same path
  back, ✕ blurs out and ☰ blurs back in (reduced motion: the icon just swaps). Same logic elsewhere: every round button (☆, ⋯, ✕,
  the map's i) presses into a whiter glass circle; the stop's ⋯ menu grows out of ⋯ the same way (⋯ → ˄, not ✕, next
  to the stop's close ✕) and the map's i grows into the attribution pill and back (it shares one vertical glass capsule with locate, split by a
  hairline: the buttons in it are flat segments that tint when held, locate still fills blue; TEL-226); the selected line chip is one glass
  lens that slides, stretching, to the next chip. Touch & hold never selects text or opens the iOS callout (form fields still do). Solid on purpose: toast (TEL-47
  contrast), search results (on the solid up sheet), stop menu, map marker labels. Reduced transparency / more contrast: solid and
  static; reduced motion: light only, no growing or moving. Made the default before the speed check (TEL-70, TEL-218) by Kostas's decision (closed beta): if it lags on cheap phones, that is where it gets fixed.

### Liquid Glass learnings (TEL-83, from Kostas's phone reviews)
- Glass is **clear, not frosted**: low tint (≈20–30%) and light blur (10–14px); legibility from heavier text and a soft
  halo, not from more blur. Frosted, high-blur glass read as "not true glass".
- **No shine at all**: a shine that moves by itself (on scroll/drag) is annoying, and a light that follows the finger
  looked unauthentic too (review 2). Feedback is shape and opacity, never a gradient.
- **Touch & hold is the signature**: every pressable thing grows a little (~10px, ≤8%), leans to the finger, turns more
  opaque, and springs back with a small wobble. Round buttons press into a *whiter* circle, grow the most (~16px) and sit
  above their neighbours: the sheet leaves ~18px above its first row so the scroller never cuts them.
- **Full-width rows are not buttons you grow**: growing makes them overflow sideways, and the iOS `:hover` after a tap
  left the whole row grey. A rounded highlight inside the row fades in and out instead.
- **A tap needs an answer you can see**: the locate button fills blue while held and rings out on the tap.
- **A sheet like Apple Maps**: three states (five felt like too many in-between stops); a floating card that turns solid
  and edge to edge at the top; a grabber with minimal room around it that reacts (capsule, wider pill, tick).
- **Morph from what you touched**: a popover grows out of its button (circle → swells → panel) and goes back the same way;
  the button's icon blurs into its "close" meaning (☰ → ✕; ⋯ → ˄ where an ✕ would duplicate a nearby ✕).
- Never let a closing popover flash: keep it on screen until its shape has shrunk back, then hide it.
- **No bands**: sticky headers sit on the sheet; blur appears only when content scrolls under them, feathered, no line.
- Selection is **one lens that moves** (filter chips), stretching over both chips on the way.
- Web-app limits: no SVG refraction in Safari (blur only); long-press selects text unless `user-select`/`touch-callout`
  are off; screenshots without the real map cannot show glass — judge on the phone (#103).

## 5. Typography
- System font stack (`system-ui`), which already has optical sizing.
- Size-specific tracking: big numbers/headlines `letter-spacing: -0.02em`, tight leading (1.05–1.15);
  body near 0 and leading ~1.45; tiny labels slightly positive tracking.
- Hierarchy from weight + size + leading together; emphasis by weight, not by new sizes.
- Spacing in `rem` so the user's text size scales the layout.
- Countdowns use `font-variant-numeric: tabular-nums` so digits don't jitter.

## 6. Feedback (multimodal, sparingly)
- Haptics (`navigator.vibrate`) only for meaningful moments: sheet snaps to a new detent, reminder set, "leave now", alight alert.
  Same frame as the visual change. Never on every tap.
- Four kinds of feedback: status, completion, warning, error — short, inline.

## 7. Reduced motion
- `prefers-reduced-motion: reduce` → springs become short opacity cross-fades (≤ 200 ms), no overshoot, no sliding/parallax.
  Feedback stays, motion doesn't.
- Theme changes ease (no abrupt brightness jumps).

## 8. Principles we check every screen against
Purpose (every element earns its place), simplicity over minimalism (common path first, advanced one level deeper),
familiarity (same thing looks and behaves the same everywhere), wayfinding (where am I, how do I get back),
craft (deliberate spacing/timing values from tokens, nothing random).

## 9. UI review: the numbered UI map (TEL-198)
Every element has one **permanent ID**: a letter for the **area** of the app (not the screen) and a number. The same
element keeps its ID on every screen and in every session, so feedback from one review still means the same thing in
the next one. Registry: `scripts/ui-map.mjs`.

| Letter | Area | Letter | Area |
|---|---|---|---|
| N | Search bar (top) | E | Home |
| M | Map (locate, attribution, markers) | F | Favourites / stop lists |
| P | Sheet and every view's header (☆ ⋯ ✕ ←) | L | Lines |
| O | Menus and popovers (☰, ⋯, i) | R | Route planner |
| S | Stop and arrivals (chips, LIVE / ΠΡΟΓΡ. tiles) | V | Vehicle |
| G | Settings and guide | D | Dialogs and forms (setup, welcome, report) |

- Run `npm run shots -- --annotate` (iPhone 15 · el · light by default; add `--map` etc. as for any sweep).
  It boxes every element with its ID on its own set of screens (menus open, vehicle, search…) into `shots/ui-map/`,
  plus `LEGEND.md`: the whole registry with the screens each ID appears on.
- Feedback is one line per element: `ID — τώρα: … / θέλω: …` (one of many alike: `S2 (606)`), with a phone screenshot
  where it helps. Everything else: «τα υπόλοιπα ΟΚ».
- Per element check three things: **at rest** (legible, distinct), **touch & hold**, **tap** (does what you expect,
  open/close motion).
- **Never renumber or reuse an ID.** A new element takes the next free number of its area; a removed one stays in the
  registry with `gone: true`. A red `?` box (listed at the end of `LEGEND.md`) is something pressable that is not in
  the registry: add it in the same PR. An ID whose selector stops matching shows "—" in the legend: fix its selector.
