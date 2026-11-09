# UI protocol (v0.1, TEL-245)

Every change a user can see follows this file. It turns the locked stop card style (`docs/DESIGN.md` §10, TEL-227) into
numbered rules, so the same look and motion hold on every card, header and sheet. `docs/DESIGN.md` keeps the reasons
and the exact values (§4 "Stop header", §4 "Glass target"); this file says what MUST be true.

- **v0.x** while block B0.5 brings the views to it, one PR at a time. **v1** when every view we keep passes it with no
  exceptions.
- **Check** says how a rule is checked: **auto** = a test will check it (TEL-269, with a list of exceptions per view that
  gets shorter in every PR of the block), **eye** = screenshots and Kostas on his iPhone.
- The kit (`web/css/ui-kit.css`, TEL-268) holds the shared classes, plain and glass: `.g-circle` (U3), `.g-pill`,
  `.card-head` + `.card-title` (U4, U19) and `.sheet-inset` (U2). A view's own CSS only places them.

## Rules

### Look

| # | Rule | Check |
|---|---|---|
| U1 | Apple Maps iOS 26 is the reference. Compare against real screenshots, low / mid / up, before proposing a change. | eye |
| U2 | One inset in a card: 16 px from the card's edge, for header circles, chips, buttons and inner cards. | auto |
| U3 | A round button in a card is `.g-circle`: 38 px glass circle, 44 px tap area, 20 px icon in the text colour. Never a `.btn` size: `min-height` and `padding` are reset. | auto |
| U4 | Titles are small and centred: 17 px on the buttons' row at low and mid, 24 px on their own row at up. A long name shrinks to a floor, then "…". A card never changes height with its name. | auto |
| U5 | Low is one row, centred in the card, as tall as the buttons. Buttons and actions appear from mid. | auto |
| U6 | Chips fill their row from mid, with the same inset (U2). At low they are the small badges under the name. | eye |
| U7 | Glass is clear: a light tint and a light blur (DESIGN §4 "Glass target"). Light mode gets a little more shadow on buttons. | eye |

### Motion

| # | Rule | Check |
|---|---|---|
| U8 | A drag-linked change is a `transform` or `opacity` driven by `--l` / `--u` (from `--sheet-t`). Never a font size or a layout property per frame. Text grows with `scale`, its line box stays fixed. | auto |
| U9 | The sheet's measured layout (anything above `[data-peek-end]` / `[data-mid-end]`) never changes as a function of `--l`. Layout may change only while up or held, and is put back on `sheet:leave-full`. | auto |
| U10 | A discrete layout jump (a title moving to its own row) hides in a short blur (0.18 s). | eye |
| U11 | Things over the map move with the sheet on every frame: no CSS transition on their `transform`. | auto |
| U12 | A glass (`backdrop-filter`) layer never fades: the map capsule stays opaque and the sheet slides over it past mid. | auto |
| U13 | Between low and mid the map glides to the focus (the user in search mode, the stop or pin in location mode), and following the user stops. | eye |
| U14 | Up from mid is quicker than the other moves (spring response 0.3). | auto |
| U15 | The installed app keeps `apple-mobile-web-app-status-bar-style: default`. No `black-translucent` without a fix proven on a real iPhone. | auto |

### Measuring in JS

| # | Rule | Check |
|---|---|---|
| U16 | Measure with transitions off (`style.transition = 'none'`), or reduced motion returns the old value. | eye |
| U17 | Measure again when a font finishes loading (`document.fonts` `loadingdone`), not only on `fonts.ready`. | eye |
| U18 | Measure transformed things from an untransformed ancestor (`getBoundingClientRect` includes transforms). | eye |
| U19 | A view's title uses a two-class selector (`.sheet-content h1` sets font and line height). | auto |
| U20 | Nothing that must be tapped is clipped by a scroller, tap areas (`::after`) included. | auto |

### Process

| # | Rule | Check |
|---|---|---|
| U21 | Every visual change: `npm run shots` for low / mid / up × light / dark × EL / EN, on a striped background (the map is blocked in the cloud). | eye |
| U22 | Elements are named with the numbered UI map (`npm run shots -- --annotate`, DESIGN §9). | eye |
| U23 | Then Kostas on his iPhone. What only a phone shows becomes a `device-test` issue (CLAUDE.md rule 9). | eye |

## Checklist for a PR that changes the UI

- [ ] Every rule U1–U23 holds for what this PR touches, or the PR lists the exception and why.
- [ ] No new size, inset or colour where a kit class or token exists.
- [ ] Shots attached (U21), elements named from the UI map (U22).
- [ ] Device checks for Kostas written as a `device-test` issue (U23).

## Bypass (only Kostas)

Kostas may try something that breaks the protocol:
- He writes **"UI bypass"**. The work goes on a branch `kostas/ui-exp-*`, its PR gets the label `ui-experiment`, and it is
  **never merged as it is**. What it proves comes back as a rule change (below) or as a normal PR.
- Claude never bypasses by itself. When Claude proposes a change that breaks a rule, it names the rule (e.g. "breaks U4")
  and reminds Kostas of the bypass.

## Changing the rules

- A session that finds a new rule writes it as a finding. It goes in **only with Kostas's approval**, as a new version
  (v0.2, v0.3…), with a line in the history below.
- A rule is never removed or weakened to make a PR pass.

## History

- **v0.1** (2026-11-02, TEL-245): rules U1–U23 from DESIGN §10.
