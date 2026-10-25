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
- Glass prototype (TEL-83, `?glass` only, `web/css/glass.css` + `web/js/glass.js`), aimed at Apple's Liquid Glass:
  **glass** = floating chrome over the map (search bar, chips, locate FAB, sheet / side panel, menu popover, setup and
  welcome dialogs): very see-through (22% card colour, 28% big; dark 30/36%), *light* blur (10/14px) so the map stays
  clear, bright top edge + rim, a static top sheen (no ambient shine: light comes only from touch), and on Chromium a lens bend at the edges (SVG displacement in `backdrop-filter`; Safari: blur only). **Touch & hold** (Apple-style, everything pressable): the control grows a little
  (~10 px, ≤ 8%, instead of §1's .97 shrink), leans a few px towards the finger, turns more opaque and lifts with a
  light at the finger, then springs back with a small wobble. Legibility comes
  from heavier text and a soft halo in the surface colour, not from frosting. **Tinted** = surfaces inside the sheet
  (45% card colour, no blur of their own; `.material` there drops it). **Exception to "never stack":** the sticky
  headers in the sheet (stop line chips, planner head) have no band at rest; once the list scrolls under them a blur
  layer fades in behind them, feathered at the bottom (no edge, no line), like iOS bars. The line chips are small glass
  pills. **Menu:** morphs out of the ☰ button: pressed, ☰ is a whiter glass circle;
  as the menu opens, its glass starts clear over that circle and its blur grows with it, so the ☰ lines blur out through
  it and a ✕ blurs in where they were (the open menu's close button); the circle swells around the button, then opens into the panel (items fade in late); closing runs the same path
  back, ✕ blurs out and ☰ blurs back in (reduced motion: the icon just swaps). Same logic elsewhere: every round button (☆, ⋯, ✕,
  the map's i) presses into a whiter glass circle; the stop's ⋯ menu grows out of ⋯ the same way (⋯ → ˄, not ✕, next
  to the stop's close ✕) and the map's i grows into the attribution pill and back; the selected line chip is one glass
  lens that slides, stretching, to the next chip. Touch & hold never selects text or opens the iOS callout (form fields still do). Solid on purpose: toast (TEL-47
  contrast), full-screen search panel, stop menu, map marker labels. Reduced transparency / more contrast: solid and
  static; reduced motion: light only, no growing or moving. Not the default until the speed check (TEL-70) and a real-phone test.

### Liquid Glass learnings (TEL-83, from Kostas's phone reviews)
- Glass is **clear, not frosted**: low tint (≈20–30%) and light blur (10–14px); legibility from heavier text and a soft
  halo, not from more blur. Frosted, high-blur glass read as "not true glass".
- **No ambient light**: a shine that moves by itself (on scroll/drag) is annoying. Light comes only from touch.
- **Touch & hold is the signature**: every pressable thing grows a little (~10px, ≤8%), leans to the finger, turns more
  opaque with light at the finger, and springs back with a small wobble. Round buttons press into a *whiter* circle.
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
