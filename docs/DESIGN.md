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
- Concentric corners (TEL-225): a surface inside another has a smaller radius, one step (8 px) per level: sheet `--radius-sheet` 28 → cards/tiles in it `--radius-card` 20 → blocks inside a card `--radius-inner` 12. Buttons, chips, inputs and badges keep their own shape (pills stay pills).
- Never stack translucent on translucent. Text on materials: slightly heavier weight, full-contrast colour.
- Scroll edges: fade content under sticky headers with a mask, no 1 px divider lines.
- Modal = dim scrim; non-blocking panels (the sheet) = no scrim.
- `prefers-reduced-transparency: reduce` → solid surfaces, no blur. `prefers-contrast: more` → solid + defined border.
- Glass UI (TEL-83, on for everyone since 2026-10-29, `web/css/glass.css` + `web/js/glass.js`), aimed at Apple's Liquid Glass:
  **glass** = floating chrome over the map (☰, locate FAB, sheet / side panel, menu popover, setup and
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
  **Two modes × three states** (as Apple Maps): *search mode* = home, the sheet starts with the search; *location
  mode* = something is picked (a stop, line, vehicle or route), the sheet starts with its header and a ✕. Each card says
  which cells (mode × low/mid/up) it changes.
  **Stop header** (location mode, TEL-227, an Apple Maps place card): share on the left, ✕ on the right, both the
  card's one round button (`.g-circle`, see "Glass target" below; the ☆ is the same button). **Low** = that row alone,
  centred in the card (13 px above and below; the grabber, 48 × 3, 5 px from the card's top, close over the row): the name (17 px, one
  line; a long one shrinks down to 14 px, then "…") at the top and the line badges (85%, centred) right under it, the
  two as tall as the buttons: 72 px; with no badges the name is centred on the buttons. **Mid**: the name centred on the buttons, the line chips right under it (40 px,
  growing to fill the row, so they keep the same inset as everything else; more than fit: they scroll), then
  directions (wide, tinted blue glass with a shining outline while the sheet floats, solid up) and ☆. **Up**: the sheet
  reaches the top of the screen and the ☰ fades out; the name has its own row under the buttons, 24 px (less if its
  longest word would not fit), up to two lines, with the same gap to the chips as at mid. From mid towards up the name
  grows as a transform, done in the first half of the way, and halfway it moves to its own row at the same visual
  size, in a 0.18 s blur (back on the way down before the sheet measures low and mid). Dragging up from low, the badges
  slide down into their row, growing into the filter chips ("All" unfolds in front); they cross nothing. The stop's
  number is at the very bottom of the view. Header, chips, directions and cards share one inset (16 px from the card's
  edge). No ⋯ for now (it comes back with an island of the stop card once it has its own items). The sheet goes up
  from mid 25% quicker than before.
  **Glass target (LOCKED by Kostas, 2026-10-31; the target for now, every other surface is to follow it):** the sheet at
  mid 26% tint, at low 3%; its blur 3.6 px at low growing to 4.2 px from mid (saturate 190%). The card's round buttons
  (`.g-circle`): 38 px, 41% white (dark: 10.5%), a bright top edge and rim, a faint shadow (light 14%, dark 25%), blur
  3.4 px at low growing to 3.9 px from mid (saturate 180%). Elsewhere (not yet aligned to this target): the floating
  controls 7 px, menus and dialogs 9 px.
  **Mid fits the view** (TEL-224, TEL-227): on a stop it ends a third into the second arrival (the first whole, about
  30–35% of the next card says the list goes on, as in Apple Maps); on home, under its card; 35–60% of the screen, and
  it follows as the content loads.
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
  back, ✕ blurs out and ☰ blurs back in (reduced motion: the icon just swaps). Same logic elsewhere: every round button (☆, ⋯, ✕)
  presses into a whiter glass circle; a ⋯ menu grows out of ⋯ the same way (⋯ → ˄, not ✕, next
  to a close ✕; the stop's ⋯ left in TEL-227, the code stays for the island); the map buttons sit in one vertical glass capsule (split by a hairline: the buttons in it are
  flat segments that, held, pop out like ☰ into a whiter glass circle; TEL-226), and the map's attribution is no button
  at all but one small line of text, always there, just above the sheet (like Apple's "Legal" in apps on Apple Maps); the selected line chip is one glass
  lens that slides, stretching, to the next chip. Touch & hold never selects text or opens the iOS callout (form fields still do). Solid on purpose: toast (TEL-47
  contrast), search results (on the solid up sheet), stop menu, map marker labels. Reduced transparency / more contrast: solid and
  static; reduced motion: light only, no growing or moving. Made the default before the speed check (TEL-70, TEL-218) by Kostas's decision (closed beta): if it lags on cheap phones, that is where it gets fixed.

**Home** (TEL-232, Apple Maps search mode, follows §10): low = grabber 5 px from the top, the search 8 px under it and 10 px of room
  under it (70 px card; the side panel keeps its own padding); mid = Places (48 px round buttons: Σπίτι, Δουλειά, your own, "+"; a
  place not set yet is an empty ring and opens the Settings on it), then Recents, the 1st whole and the 2nd 20% in (mid is capped at
  60% of the screen, so the rows above stay compact); up = favourites with their next arrival (LIVE / ΠΡΟΓΡ., polled only while up,
  4 stops, the rest "Δες αφίξεις") and my routines. The active trip sits above Places while there is one. No saved-place chips float over the map any more: Places show only in the sheet, at mid and up.

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

## 10. The stop card style (LOCKED, TEL-227, Kostas 2026-10-31)

The stop card (location mode) is the reference for every other card and header: the next sessions follow it, and a
change to it needs Kostas's decision. Its layout is in §4 ("Stop header"), its glass in §4 ("Glass target"). What we
learned building it, as rules:

**Look**
- Apple Maps iOS 26 is the reference; compare against real screenshots, low / mid / up, before proposing.
- One inset for everything in the card: 16 px from the card's edge (header circles, chips, buttons, cards).
- One round button for the card (`.g-circle`): 38 px glass circle, 44 px tap area, 20 px icon in the text colour. Not a
  `.btn` size: reset `min-height` (`.btn`'s 44 px made it an oval) and padding.
- Titles are small and centred (17 px on the buttons' row at low and mid, 24 px on their own row at up); a long name
  shrinks to a floor, then "…": a card never changes height with its name.
- Low is one row, centred in the card, as tall as the buttons; buttons and actions appear from mid.
- Chips fill their row from mid (same inset as the rest); at low they are the small badges under the name.
- Glass is clear: a light tint and a light blur (§4 "Glass target"); light mode gets a little more shadow on buttons.

**Motion**
- Drag-linked change = a transform or opacity driven by `--l` / `--u` (from `--sheet-t`), never a font size or a
  layout property per frame (it stutters on iPhone). Grow text with `scale`, keep its line box fixed.
- Never change the sheet's measured layout (anything above `[data-peek-end]` / `[data-mid-end]`) as a function of
  `--l`: `sheet.js` measures low and mid from the layout and would aim at a moving target. Layout may change only
  while up or held (`sheet.js` does not measure then) and must be put back on `sheet:leave-full`, before it measures.
- A discrete layout jump (a title moving to its own row) hides in a short blur (0.18 s), as in Apple Maps.
- Things floating over the map move with the sheet on every frame, no CSS transition on `transform` (the capsule and
  the attribution line stay at the same distance above the sheet). Never fade a glass (backdrop-filter) layer: iOS draws
  it grey for a moment; the map capsule stays opaque and the sheet slides over it past mid (z-index).
- Between low and mid the map glides to the focus: the user's location in search mode, the stop (or pin) in location
  mode, where following the user stops (the next GPS fix would pull the map back).
- Up from mid is quicker than the other moves (spring response 0.3).
- The installed app keeps `apple-mobile-web-app-status-bar-style: default` (the map stops under the status bar). We
  tried `black-translucent` (map under the status bar, as in Apple Maps): iOS then left an empty strip, the status
  bar's height, at the bottom of the app, and neither `100vh` nor a measured gap filled it. Do not switch back without
  a fix proven on a real iPhone.

**Measuring in JS**
- Measure with transitions off (`style.transition = 'none'`): with reduced motion app.css gives every change a 0.01 ms
  transition and `getComputedStyle` returns the old value.
- Measure again when a font finishes loading (`document.fonts` `loadingdone`); `fonts.ready` can resolve too early.
- Measure transformed things from an untransformed ancestor (`getBoundingClientRect` includes transforms).
- Specificity: `.sheet-content h1` sets font and line height; a view's title needs a two-class selector.
- A scroller clips what overflows it, tap areas (`::after`) included.

**Process**
- Every visual change: low / mid / up × light / dark × EL / EN screenshots on a striped background (the map is blocked
  in the cloud), the numbered UI map for names (`npm run shots -- --annotate`), then Kostas on his iPhone.
