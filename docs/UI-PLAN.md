# UI redesign plan (v2.0.0, ships before 3.30 / 13 Nov 2026)

## Status (31 Oct 2026)

All seven steps are on branch `redesign-v2`: tokens and contrast guard (step 1),
`js/ui.js` components (2), the app shell (3), the item card and listings (4), the tool
pages and settings drawer (5), accessibility and responsive (6), and the docs refresh
with the 2.0.0 build (7). It has not been merged or released yet.

Changes from the plan below:

- **Go live** stays a visible card button rather than going into ⋯, because it shows its
  running state (⏹ Stop live).
- **Trade stat** sits under the mod text unless the card is at least 760px wide (a
  container query). A fixed column squeezed the mod text at common window widths.
- **Gems** keeps its existing layout. The slot-list version (§5.2) is deferred until after
  league start.
- The desktop window now opens at **1280×900** (it was 1060 wide). Between 1001 and 1180px
  the sidebar becomes a 64px icon rail, and **☰** opens the build card as a flyout.
- **POESESSID** moved from the compare pop-up to Settings → Account.

Decisions (user, 31 Oct 2026):
- **Primary use:** all tools are equally important, so each one gets its own page.
- **Cards:** advanced filters move behind a "More filters" disclosure.
- **Layout:** left sidebar.
- **Visual scope:** full redesign in a modern dark look with PoE accents.
- **Themes:** Dark and Light, plus an accent picker.
- **"All" view:** replaced by a slot list with a detail pane.
- **Timing:** everything ships before league day.

Mockup: [docs/mockups/redesign.html](mockups/redesign.html). Open it via the dev server (`/docs/mockups/redesign.html`); it was rendered in both themes at 1280×800.

## 1. What's wrong today (audit, 31 Oct)

**Layout and information architecture**
- Five stacked bars (header, build, character, controls, tabs) take about 45% of the first screen. The sticky controls bar covers a quarter of the screen at 760px wide.
- The "All" view stacks 24 cards and is about 10,000px tall.
- Each rare card carries 35–40 controls: 3 per mod row, 14–18 options, and 6 buttons across 3 rows.
- At narrow widths, card buttons wrap onto two lines.
- Timeless and Jewel finder are the last two tabs and are easy to miss.
- Cost summary, solver and basket are scattered above the controls bar.

**Contrast** (full table in the audit; the worst cases)
- `--dim` fails 4.5:1 on `--panel2` in every theme, and on `--panel` in the default theme.
- Light theme failures:
  - `.copy-btn` text, the most-used button: 2.47.
  - Prices: 1.88.
  - Fractured mods: 2.79.
  - Badges: 1.2–2.7.
  - Error text: 2.22.
  - Several surfaces stay dark: the gem panel, live box, update banner and icon wells.
- `.trade-btn` and `#decode-btn` ignore the theme. The purple decode button is foreign to the palette.
- High-contrast mode flattens every dark theme to classic, and still fails in light.

**Consistency**
- 16 font sizes, 36 rules below 12px.
- 10 button styles, with 6+ size variants of `.copy-btn`.
- 11 radius values, 4 input styles.
- Three copies each of the table, list-row and panel CSS; 8 copies of the section heading.

**Accessibility**
- `outline:none` on textarea, select and `.min-input` hides keyboard focus.
- Unlabelled controls: mod checkboxes, min inputs, account/sessid inputs, saved builds, and the 🗑 button.
- Clickable divs and spans can't be reached by keyboard.
- Tabs have no `role=tab` and no `aria-selected`.
- Several states are shown by colour alone: crafted/fractured mod source, diff borders, roll hi/lo, timeless hit/miss, and sockets when colourblind mode is off.

**Bugs found during the review**
- The Timeless page still says "Glorious Vanity isn't supported yet". It has been supported since v1.14.0.
- The basket Whisper button lacks `.whisper-btn`, so it is sized differently from listing whispers.
- The staff weapon icon is missing in the sample build.

## 2. Target layout

```
┌ sidebar 232 ───┬ slot list 280 ───┬ detail (fluid, max 980) ───────────────┐
│ logo           │ Gear      412c   │ context chips: league · trade · min roll│
│ build card     │ [Check all]      │                 [Edit settings][Open all]│
│  save / switch │ ▸ Weapon   85c   │ ┌ item header: icon, name, base, chips ┐│
│ Gear        9  │ ▸ Helmet    2c ◀ │ │  [Check price] [Search ↗] [⋯]        ││
│ Jewels      7  │ ▸ Body   Owned   │ │ mods table: ☑ mod · min · trade stat ││
│ Flasks      5  │ ▸ Ring2 No match │ │ ▸ More filters (2 changed)           ││
│ Gems       12  │ …                │ │ status: 143 listed · cheapest 2c     ││
│ TOOLS          │                  │ │ listings: item · mods · price/Whisper││
│ Upgrade planner│                  │ └──────────────────────────────────────┘│
│ Timeless       │                  │                                         │
│ Jewel finder   │                  │                                         │
│ Market         │                  │                                         │
│ 1 div = 333c   │                  │                                         │
│ ⚙ Settings     │                  │                                         │
└────────────────┴──────────────────┴─────────────────────────────────────────┘
```

- **Sidebar:**
  - Brand, the build card (name, class/main skill, item count, league, Save, Switch build ▾), and navigation.
  - Navigation groups: Items (Gear, Jewels & clusters, Flasks, Gems) and Tools (Upgrade planner, Timeless jewels, Jewel finder, Market).
  - Footer: the divine rate and ⚙ Settings.
  - Below 1100px it collapses to a 56px icon rail with tooltips.
- **Slot list (master)** for Gear, Jewels and Flasks:
  - Each row shows the icon, slot, name in rarity colour, and status (price, or a soft pill: Owned, Upgrade, No match, Checking…).
  - Up/Down moves the selection and Enter checks the price.
  - The total and "Check all prices" sit at the top.
  - Below 900px the list becomes a dropdown above the detail pane.
- **Detail:** one item at a time, with nothing to scroll past.
- **Top bar context chips:** league, trade mode, sale type and min roll, read-only. "Edit search settings" opens a popover holding today's controls bar (league, trade, sale, pseudo, currency, min roll).
- **Character compare:** moves into the build card ("Compare with character…" opens a small dialog). Diff results show as slot-list pills and on the card, not as coloured borders.
- **Landing (no build loaded):**
  - The main area becomes a centred empty state: a large paste box with an accent "Load build" button.
  - Saved builds appear as clickable cards, with a three-step "How it works" strip.
  - The sidebar is hidden until a build loads.

## 3. Design tokens (one source: `css/tokens.css`)

All pairs below are verified ≥ 4.5:1 against `bg`, `s1` and `s2` in both themes (`test/test_contrast.js`, §6).

| token | dark | light | role |
|---|---|---|---|
| `--bg` | #0f0e0c | #f5f2ec | page |
| `--s1` | #171512 | #ffffff | panels, sidebar |
| `--s2` | #201d19 | #efeae1 | inputs, raised |
| `--s3` | #2a2620 | #e6dfd3 | hover, neutral chip |
| `--border` / `--border-strong` | #332e26 / #4a4236 | #ddd5c8 / #c4b9a6 | dividers / controls |
| `--text` / `--text-2` / `--text-3` | #ece6da / #b9af9d / #9a907d | #1d1a15 / #4a4338 / #635a4b | primary / secondary / muted |
| `--accent` (+ `--on-accent`) | #d9ad4f (#1a1408) | #7e5a0c (#ffffff) | primary buttons, selection |
| `--unique` `--rare` `--magic` | #e0894a #f0e070 #9a9aff | #a04f12 #7a6200 #4646b0 | rarity |
| `--crafted` `--fractured` | #b8b8ff #c4b37e | #4b4bb8 #7a6630 | mod source |
| `--success` `--warn` `--danger` `--info` | #6cc07a #e0b050 #ec7b7b #7fb2ec | #28702f #8a5d00 #b3261e #1f5fa8 | status |
| `--gem` `--divine` | #3cc4b8 #8fdcec | #0b6e66 #1d6f80 | gem names, divine prices |

- **Accent picker:** a choice of gold (the default), crimson, teal, violet or green. Each option ships a dark and a light value pre-checked for AA, so the picker cannot produce a failing pair.
- **Old themes:**
  - Obsidian, midnight, blood and forest are removed; on first load they map to Dark with the nearest accent.
  - Classic maps to Dark + gold.
  - High contrast stays as a toggle that raises `--text-2`/`--text-3` to `--text` and borders to `--border-strong`.
- **Status pills** (standing rule): soft background (`--*-soft`, 10–14% alpha) with the full-strength text colour. A pill always carries a word (Owned, No match, Deal, Crafted), never colour alone.
- **Type:**
  - Scale: 12 / 13 / 14 (body) / 16 / 20px.
  - Nothing goes below 12px, and 12px is used only for chips and uppercase labels.
  - Font: Segoe UI Variable, falling back to the system font. `tabular-nums` on every price and number.
  - A Text size setting (S/M/L) scales the root size.
- **Spacing:** 4px base (4, 8, 12, 16, 20, 24, 32).
- **Radius:** 4 (chips/inputs inner), 6 (controls), 10 (panels), 999 (pills).
- **Focus:** a 2px accent ring with a bg-coloured gap, on every focusable element. Remove every `outline:none`.

## 4. Component set (`css/components.css` + small JS factories in `js/ui.js`)

| component | replaces |
|---|---|
| `Button` (primary / secondary / ghost / danger × md 32px / sm 26px, `white-space:nowrap`) | `#decode-btn`, `.trade-btn`, `.copy-btn` (+6 variants), `#new-build`, `.whisper-btn`, `.hideout-btn`, `.gem-expand`, `.sort-btn`, `#overlay-close` |
| `IconButton` (with required `aria-label`) | 🗑, ⚙, ⇅, ⋯ |
| `Field` (label + control) / `Select` / `Input` | 4 input styles, `makeMiniSelect`, `makeModeSelect`, `makeSearchBySelect`, 8 raw selects |
| `Chip` (neutral / rarity / influence / semantic) | `.badge`, `.ptype`, `.gem-slot`, `.infl-tag`, `.tier`, `.finder-chip`, `.sort-chip`, `#rate-chip` |
| `Panel` + `SectionHeader` | 7 panel shells, 8 heading copies |
| `DataTable` (sticky header, `.num` column, sortable, row hover) | `.market-panel`, `.finder-table`, `.craft-table` tables |
| `ListRow` | `.cost-row`, `.basket-row`, `.mod-row` |
| `Tabs` (`role=tablist`, arrow-key nav) | `.tab-btn` (used inside tool pages only) |
| `Disclosure` ("More filters (n changed)") | the always-open options rows |
| `Menu` (⋯ overflow) | Copy URL, Go live, Craft vs buy, Find seeds, Bought, History |
| `Popover` | the search-settings controls bar |
| `Dialog` (danger variant confirms deletes) | `confirm()` on delete build / clear basket |
| `Toast` | `#status` text and silent failures |
| `EmptyState` | blank sections, "No listings" text |

## 5. Screen-by-screen

1. **Item card (detail pane)**
   - **Header:** icon (56px), slot label, name (20px, rarity), base · ilvl · influence chips. On the right: **Check price** (primary), **Search on trade ↗**, and ⋯ (Go live, Craft vs buy, Find seeds, Copy URL, Mark bought, History).
   - **Mods table:**
     - Columns: Use checkbox (wrapped in `<label>` with the mod text), Mod (with Crafted/Fractured/Eater/Exarch chips that carry text), Min (72px), and Trade stat (muted, 12px; ellipsis with a tooltip).
     - ⇅ "sort by this mod" moves into the row's hover action.
     - Unchecked rows dim to `--text-3`.
   - **More filters:**
     - Contents: Search by, Match, Min ilvl, Influence, Fractured, Flexible resistances, Base %ile, Sockets, Links, Min roll, Max price.
     - Layout: a 4-column grid of `Field`s.
     - It is closed by default and opens automatically when anything differs from the global default; the summary shows "n changed".
   - **Results:**
     - A status line: "143 listed · cheapest 2c · checked 1 min ago", plus History ▾ and a sparkline.
     - Each listing row has three columns: icon / name + chips + mods (wrapping) / price (16px bold) + seller + a single primary action.
     - The primary action matches the trade mode: Whisper in person, or Hideout for instant buyout.
     - Copy whisper and Pin go in the row's ⋯ menu.
     - "Load more" sits at the bottom.
   - **Live search and Craft vs buy:** both open as panels under the results, using the same Panel and DataTable components.
2. **Gems:** a slot list of gem groups (socket group, links, main-skill star); the detail pane shows each gem's price row in a DataTable. Gem teal comes from `--gem`.
3. **Upgrade planner** (new home for cost summary, solver and basket):
   - Top: the budget and solver inputs (ele res ≥, life ≥), then "Solve cheapest combo".
   - Middle: a DataTable of slot · current · best upgrade · price · Δ.
   - Bottom: the basket with its total and Whisper all.
4. **Timeless jewels**, as a 4-step page with numbered steps that are always visible (no wizard pages):
   - ① Socket: list of the build's sockets, own-jewel sockets first, showing the notables in radius.
   - ② Jewel + conqueror: imported from the build, with no default ticks.
   - ③ Wants: fuzzy search adds chips; each chip has weight and "Need ×N" steppers.
   - ④ Results: a DataTable of seed · conqueror · score · matched notables · price.
   - Remove the stale GV line.
5. **Jewel finder:**
   - Replace the unlabelled Use/Must checkbox pair with a per-row segmented control (Off · Want · Must) that has a visible header.
   - The jewel type, Find mode, N, min roll and max price go in one Field row above the table.
   - The fuzzy search stays sticky above the table.
   - Results use the listing rows from §5.1.
6. **Market:** a full page with the currency DataTable (rate, 7-day sparkline, change) and the Divine Orb history chart; the tile in the sidebar footer links to it.
7. **Settings:** a right-hand drawer with these sections:
   - Appearance: theme (Dark / Light / System), accent, text size, high contrast, colourblind sockets.
   - Trade defaults.
   - Account: POESESSID, with an explanation.
   - Hotkey.
   - Notifications.
   - Data: refresh trade data, art cache size and clear.
8. **Landing/onboarding:** the empty state described in §2. Errors (bad code, network) appear as a Toast plus an inline message under the paste box, never as silent failures.

## 6. Accessibility and quality gates

- **Focus:** `:focus-visible` ring on everything, and no `outline:none` anywhere (a grep test enforces this).
- **Labels:** every input and select has a `<label>` or `aria-label`; icon buttons require `aria-label` (`IconButton` enforces it).
- **Keyboard:**
  - Clickable rows are `<button>`, or `role=option` inside a `listbox` with key handling.
  - Arrow-key navigation works in the slot list, Tabs and Menu.
- **No colour-only state:** source chips carry text, and diff state shows as a pill with a word. Sockets always show their letter (12px) when colourblind mode is on, and that includes DV.
- **`test/test_contrast.js`:** parses `css/tokens.css` for both themes and every accent option, and asserts AA for each text token on `bg`/`s1`/`s2` and for `on-accent`/`accent`. It runs in the normal test pass.
- **Screenshot checklist before release:**
  - Every page, in Dark and Light.
  - At 1280, 1000 (icon rail) and 760 (slot dropdown).
  - With the high-contrast toggle on.

## 7. Implementation order (target: freeze 10 Nov, release v2.0.0 by 12 Nov)

| step | days | work | files |
|---|---|---|---|
| 0 | — | Tag the current build `v1.14.0` as the fallback. If v2 slips, ship 1.14 + `refresh_all.py` on league day. | — |
| 1 | 1 | Move inline CSS out of `index.html` into `css/tokens.css`, `css/base.css`, `css/components.css` and `css/layout.css`. Add the token themes, the theme migration, and `test_contrast.js`. Add the CSS files to the `build_release.py` SHIP list. | index.html, css/*, tools/build_release.py, test/ |
| 2 | 1.5 | Component factories in `js/ui.js` (Button, IconButton, Field, Chip, Panel, DataTable, Disclosure, Menu, Popover, Dialog, Toast, EmptyState). Swap existing call sites without changing layout. | js/ui.js, js/app.js |
| 3 | 2 | App shell: sidebar, view router (`state.view`), slot list + detail, top context bar, search-settings popover, landing empty state. Replace `renderBuild`'s tab-bar/sections. | js/app.js (renderBuild ~l.540-613), index.html |
| 4 | 2 | Item card rebuild: header actions + ⋯ menu, labelled mods table, More filters disclosure with "n changed", listing rows, status line. | js/app.js (makeCard ~l.2476-2718, listings) |
| 5 | 2 | Tool pages: Upgrade planner (cost summary, solver and basket moved in), Timeless steps, Jewel finder Off/Want/Must, Market page, Gems view, Settings drawer. | js/app.js |
| 6 | 1 | Accessibility pass, keyboard nav, toasts for failures, responsive breakpoints (1100 rail, 900 slot dropdown). | css/layout.css, js/ui.js |
| 7 | 1 | Full screenshot sweep (§6), fix-ups, update `docs/USER-GUIDE.md` screenshots and text, README images, release build + smoke test of the onedir exe. | docs/, tools/build_release.py |

Rules while implementing:
- Behaviour, payloads and bridge calls stay identical; this is a view-layer change.
- Existing tests (`test/test.js`, `test_craft.js`, `test_jewels.js`, Python suites) must stay green after every step.
- Commit per step.

## 8. Risks

- **Size of `app.js`:** it is 5,200 lines and builds the DOM imperatively. Step 2 (factories) comes first so that steps 3–5 are swaps, not rewrites.
- **League-week timing:** if step 5 isn't done by 9 Nov, ship v2.0.0 with the old Timeless and Jewel finder bodies inside the new shell. They work as-is and only get restyled.
- **Saved user state:** old theme names in storage are mapped (§3), and per-card option state is unaffected. Saved builds load unchanged.
