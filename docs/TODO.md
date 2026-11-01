# PoB Trade Finder: to-do list

The running list of everything agreed on, so nothing is lost between sessions. Update it when
something is done, added or dropped. Newest decisions at the top of each section.

Status: **v2.5.16 released 2026-11-01** (Settings in tabs with Find; saved POESESSID shown as saved). Before: **v2.5.15** (loot filter tools: price re-tier, build items, rules, find an item, checkpoints). Before: **v2.5.14** (the whole div card on hover: name, picture, stack, reward, flavour). Before: **v2.5.13** (div card value per 1000 drops per area, from community drop weights). Before: **v2.5.12** (anoint helper in the Blight sheet: search, oil icons, prices). Before: **v2.5.11 released 2026-11-01** (compare again at launch; in-game settings no longer reset after a restart). Before: **v2.5.10** (one copy at a time; updates exit fully and wait for the old copy). Before: **v2.5.9** (deeper cheat sheets: act routes, quest gems, 24 mechanics; div card art; tree icons; saved characters; update banner). Before: **v2.5.8 released 2026-11-01** (trade ledger: purchases, profit, flips, People, Reports, goal, backup). Before: **v2.5.7** (dust explorer + dust on the price check). Before: **v2.5.6** (Sold for: set the price you got on the trade card). Before: **v2.5.5** (poe.ninja links, chat macros, flask / vendor search text, borderless Ctrl+D price check, Shift+Space window fix). Before: **v2.5.4** (socket colour helper in the gem compare). Before: **v2.5.3** (mechanic cheat sheets + "open the sheet?" suggestions, updated from the server). Before: **v2.5.2 released 2026-11-01** (Compare gear checks gem setups on any worn item: linked / not linked tags, socket picture, unticked PoB gems). Before: **v2.5.1** (cleaner in-game overlays: always dark, status in words, bigger text; new gold line icons). Before: **v2.5.0** (cheat sheets, trade helper test mode, light-blue crafted mods). Before: **v2.4.2** (app-over-game fixes, compare checks every slot). Before: **v2.4.1** (tree stages). Before: **v2.4.0** (skill tree, custom sounds, quad outline, WE triples / legacy,
buyer merge, div card divines). Before that: **v2.3.0 released 2026-11-01** (published at the user's request: it includes the v2.2 trade
helper + overlays and the v2.3 tools). Section 1 is still the in-game checklist: fix anything that
fails in a patch release.

## 1. In-game checklist (v2.3.0 is out; fix failures in a patch)

Play in **Windowed** or **Windowed Fullscreen**; true fullscreen hides every overlay.

- [x] PoB icon overlay: no white box around it, before or after dragging (confirmed 2026-11-01) (window now clipped
      to its content).
- [ ] Drag the icon and the trade cards to different spots; move the game window, including
      to another screen: both follow and keep their spots.
- [x] Alt+T hides / shows the trade cards, more than once. (confirmed)
- [ ] Shift+Space (v2.4.2 reworked after "switches size" + "click outside only works after a resize":
      frame changes now go through WinForms on its UI thread, click-outside uses a foreground
      event hook; debug.log logs each foreground change while over the game):
  - [ ] the app comes up over the game with no title bar, smaller than the game;
  - [ ] it resizes from its edges and with − / +, and moves by dragging the banner;
  - [ ] it stays where you left it next time;
  - [ ] Esc, Shift+Space, **Back to the game**, or a click in the game puts it away and
        the game gets focus.
- [ ] The overlays never take focus from the game (watch for the game losing keyboard
      input when they appear).
- [ ] Trade helper is a page in the app: sidebar → Tools → Trade helper, the $ on the icon,
      the tray menu; ← Back / Esc return.
- [ ] A real trade (waiting for a second person):
  - [ ] the buyer's whisper makes a card;
  - [ ] Invite → buyer joins → card shows "In your hideout";
  - [ ] Trade, Thanks and Kick each send exactly one command;
  - [ ] ✓ Completed lands in Sales, and Sales → Edit fixes the price.
- [ ] ▣ Show in stash outlines the right cell on a normal and on a quad tab.
- [ ] Your own card buttons (Trade helper → Setup → Your buttons) send their message once.
- [ ] Side-by-side card layout (Setup → Trade cards).
- [ ] Sound picker, volume slider (0 = silent) and ▶ Test.
- [x] Close the app window: it goes to the tray. Right-click the tray icon → Quit ends it. (Quit confirmed)
- [ ] Search text → **Paste into game** with the stash open fills the search box.
- [ ] The old report "closing the price-check pop-up closed the whole app" doesn't happen.
      If it does, send `data\debug.log`, which now logs every window close.
- [ ] v2.5.1 overlays: dark over the game even with the light theme; cards say Waiting /
      Invited / In your hideout / Trade accepted; long names cut short; text readable at a glance.
- [ ] v2.5.1 icons: the sidebar's gold icons, and the PoB icon's hover buttons (Trade helper,
      Cheat sheet, App, Settings) open the right things.
- [ ] v2.5.4 socket colours: Compare gear → Gems shows the Socket colours box under a matched
      setup, and its advice fits the item (base colours, bench craft, corrupted).
- [ ] Sold for (card price): − / + change the price, "in div" / "in c" converts, ✓ Completed
      records that price in Sales.



## 2. Shipped in v2.3.0

- v2.2 trade helper:
  - Client.txt reader, trade cards (incoming and outgoing), one command per click.
  - Outcomes, Sales (chaos + divine, totals, chart, CSV, Edit) and Buyers (reputation,
    flag, hide, ignore once).
  - Zone notes.
- In-game overlays:
  - Separate PoB icon and trade-card windows, dragged and locked separately, following the
    game window across screens.
  - Cards grow upwards in the lower half; stacked or side by side.
  - Opacity and size settings; "only when there are trades".
- Hotkeys: Ctrl+D price check; Shift+Space app over the game (resizable, remembered, click
  outside to close); Alt+T show / hide the trade cards.
- Tray icon (close to tray; Open / Trade helper / Settings / Quit).
- Sounds: 5 styles + volume slider + test.
- Custom card buttons.
- v2.3:
  - Watcher's Eye & co.: Watcher's Eye current mod pool, pair pricing; Forbidden Flame /
    Flesh pairs; Thread of Hope.
  - Search text builder: map mods avoid / want, quantity, own words, presets, Paste into game.
  - Learned filters; Div cards (by area / by card, drop data via the server's static
    divcards.json).
- Fixes:
  - Startup removes the "downloaded from the internet" mark (Python.Runtime.dll crash).
  - Close / exit logging.
  - Zod override on the server (Dependabot).

## 3a. Gaps found in the 2026-11-01 review (agreed earlier, built only partly)

- [x] **Stash outline on quad tabs** (done: both cells shown, amber normal / blue quad): the original spec said to draw *both* the normal-tab and
      the quad-tab cell when the position is 12 or under (a quad tab can't be told from the
      whisper). Right now it outlines the normal cell only, unless left/top > 12.
- [x] **Track buyers by account name** (done differently: Buyers → *Same person as…* merges
      characters; the `/whois` idea is parked: no whois reply in your log to confirm its format) (spec: account name, else character name). Only
      character names are used, so one buyer on two characters counts as two. Idea: read the
      `/whois` reply from Client.txt (display only) to link a character to its account.
- [x] **Watcher's Eye: price 3-mod combinations** (done: Price each triple, up to 5 mods) too (spec said 2- and 3-mod). Only pairs
      exist; triples would need a cap (e.g. 5 ticked mods = 10 searches).
- [x] **Watcher's Eye mod count** (resolved: 80 current is right; the extra ones are legacy mods,
      now available with *Include legacy mods*): research said 87 current mods; Path of Building's data gives
      80 after dropping legacy ones. Check which 7 differ (maybe Sublime Vision lines or new
      ones PoB hasn't added).
- [x] **Zone cheat sheets**: covered by the act sheets (v2.5.0) and mechanic sheets (v2.5.3);
      per-zone layout tips stay in 3b until there's a source we may use. Was: shipped as zone notes you write yourself, plus the 6 Act 1–3
      trials. The original idea was ready-made cheat sheets per zone (layout tips, quests,
      skill points). Needs a trustworthy data source before adding any.
- [x] **Completed with the price edited on the card** (built 2026-11-01): a "Sold for" row on the
      card once the buyer is in your hideout. − / + in steps sized to the price (1 / 5 / 10c,
      0.1 / 0.5 / 1 div), "in div" / "in c" converts at the current rate, Reset goes back to
      the listed price; ✓ Completed records it. Click-only: overlay cards never take typing.
- [ ] **Overlays on screens with different scaling** (e.g. 100% and 150%): the app is
      "system DPI aware", so positions may be off on the second screen. Check when moving
      the game between such screens.
- [x] **README** (updated): doesn't mention anything from v2.1–v2.3 (trade helper, overlays, hotkeys,
      tray, Watcher's Eye & co., search text, div cards, quick price / upgrade check).
- [x] **GitHub roadmap issue #1** (updated 2026-11-01) is stale: it lists Shipped only up to v1.12 and still has
      Glorious Vanity as "planned" (supported now). Needs your OK to edit (it's public).
- [x] **Real-window tests in the repo** (`test/manual/overlay_windows.py`: refuses if the game is
      running, asks first, only sends keys to the fake game): the overlay / tray / focus tests run so far live only
      in a scratch folder. Add them as an opt-in manual script (never run while you're in
      the game).
- [x] **Search text**: one map mod (done: regex `s have \d+% increased ar`) ("Monsters have #% increased Area of Effect") has no
      unique plain-text token. It could use a small regex.

## 3. To do (agreed, not started)

- [x] **Trade ledger** (released in v2.5.8): buying cards record Bought / Didn't happen /
      No answer / Other (Trade accepted pre-selects Bought); Trades (Sold / Bought / Flips,
      earned / spent / net, currency swaps valued both ways, under-market tag, + Add trade, CSV);
      People (buyers + sellers, time wasters after N, Blocked = hidden or ignored-from-the-app,
      Show popups / Unignore); Reports (range / league, item stats, top buyers / sellers, goal);
      Setup → backup / restore; Today line on the trade cards; seller badge.
  - [ ] In game: buy something, check Trade accepted highlights Bought and the purchase lands
        in Trades → Bought; Unignore in game sends /unignore.
- [x] **🌳 Skill tree view (mini Path of Building)**, shipped in v2.4.0. Still to confirm in game:
      the character compare against a real profile (the `mastery_effects` format in
      `get-passive-skills` wasn't checked live). It shows: the build's tree
      (pan / zoom / search), jewel sockets with their jewels, mastery picks, and "points still
      to take" vs your imported character (`get-passive-skills`), in a BFS order.
- [x] Character compare checks every place an item can be: jewels in any tree socket (read
      with the gear in one click), rings in either ring slot (v2.4.2)
- [x] Skill tree stages (PoB's several specs, e.g. Level 30 / 70 / Endgame): stage menu, compare carries over (v2.4.1, released)
- [x] Div cards: 1+ divine shows as divines, under that as chaos (done 2026-11-01)
- [x] Custom trade sounds: your own mp3/wav/ogg/m4a for new trade / buyer arrived (done)

- [x] **Socket colour helper** (2026-11-01, replaces the recolour calculator). 3.29.0 reworked
      socket colours for every league:
  - sockets are white by default, and each has a small chance to roll red / green / blue,
    weighted by the item's attribute requirements and raised by item level;
  - any gem fits any socket, and a matching colour only adds +10% gem quality;
  - a Chromatic Orb forces one socket non-white, with more from higher item quality;
  - the bench has "At Least 2/3/4 Non-White Sockets" (5/20/75 chromatics), and the per-colour
    crafts and the Vorici method are gone.

  GGG hasn't published the chances (a datamine tracker confirmed this on 3.29.3.3), so Siveran's
  odds formula no longer applies. The gem compare shows facts and options instead (USER-GUIDE).
  If real numbers come out, add odds to `socketColourHelp` in js/app/10-character.js.
- [x] **Overlay for the price-check pop-up (Ctrl+D)** (done 2026-11-01: no title bar, drag the banner, edges resize): it's still a normal window. Consider
      the same borderless, clipped style as the other overlays.
- [x] **Gem setups: compare with your character** (released in v2.5.2; socket colours added in v2.5.4). The Gems view gets the
      same "you have / missing" marks as the gear compare. It reads the socketed gems from the
      imported character (`get-items`, `socketedItems`), already fetched by the gear compare.
  - Match each PoB skill group by its gems, **not by slot**. Players put links in other items
    than the PoB lists (e.g. the 6-link in the helmet, auras in the boots), so search every
    item and report where each group actually is ("in your Helmet").
  - Per gem: present / missing, level and quality vs the PoB, and awakened / transfigured /
    Vaal variants counted as the same gem (with a note).
  - Per group: are the gems linked together? Socket groups come from `sockets[].group`.
    Report "5 of 6 linked" when one is in another link group.
  - Disabled groups in the PoB (e.g. swap sets) only shown as info; the weapon swap counts as
    its own place.

## 3b. Cheat sheets + what Scalpel has that we don't (compared 2026-11-01)

Source: Scalpel's README and repo (github.com/scalpelpoe/scalpel, AGPL-3.0). We can learn how
it works, but we can't copy its code or data files into this MIT project. Use original
sources, or ask the author.

- [x] **Cheat sheets** (released in v2.5.0). Tools → Cheat sheets, plus an
      overlay with its own hotkey (Alt+C):
  - Ready-made per act 1–10, all from the PoE Wiki via `tools/make_cheatsheets.py` (CC BY-NC-SA,
    credited on the sheet): skill point and respec quests, trials and which labyrinth they
    open, bandit rewards, resistance penalties after Acts 5 and 10.
  - Your own sheets: text + pictures, for one act or every act.
  - "Follow my act" (asks first): reads Client.txt's `Generating level N area "2_6_town"` lines
    and turns the sheet to that act; marks the trial you're standing in.
  - Mechanic sheets (v2.5.3): 15 from the wiki (Betrayal, Blight, Delve, Incursion, Expedition,
    Sanctum, Kingsmarch, Ultimatum, Eldritch, Pantheon, Corruption, Bestiary, Harvest, vendor
    recipes, essences), served from the app's server so they update between releases, plus a
    small "Open the X cheat sheet?" pop-up on entering a mechanic's area (own movable overlay).
    Re-run `tools/make_cheatsheets.py` after the 3.30 patch notes (13 Nov) and redeploy.
  - v2.5.9: full act routes (zones in order from the wiki's area connections, the one you're in
    marked), quest gems per class with your build's gems marked, deeper sheets (all anoints,
    Sanctum boons/pacts/relics, Expedition factions, Incursion rooms, Delve depths, Heist) and 9 new
    mechanics (Heist, Breach, Legion, Abyss, Delirium, Ritual, Labyrinth, scarabs, Atlas): 24 in all.
  - Still to do: layout tips per zone (needs a source we may use).
  - [ ] In game: the suggestion pop-up appears in a mechanic's area, Open shows the sheet,
        it can be dragged and goes away by itself.
  - [ ] In game: Alt+C shows / hides it; it follows the game window; drag, lock, opacity,
        size and width work; "Follow my act" turns it when you change act.
- [x] **Trade helper test mode** (released in v2.5.0): Setup → Test mode makes up
      whispers / arrivals / trade accepted / leaving / your own buy / a zone, through the real
      log parser, as TEST cards in the overlay. Their buttons send nothing and nothing is saved.
      "Whole trade" plays one out over 12 s; "Clear test cards" removes them.
  - [ ] In game: try every test button and look at the cards over the game.
- [x] Crafted / enchanted mods are bright light blue (and semi-bold), clearly apart from normal
      mods (asked 2026-11-01).
- [x] **Dust explorer** (built 2026-11-01): Tools → Dust explorer + "Dust ≈" on the price check.
      Per-unique values from deronek/poe-disenchant-tool (MIT, pinned; `tools/make_dust.py`),
      which also gives built-in influences (Starforge, Astrolabe) through its q0/q20 columns.
      Formula is additive: × (ilvl − 64) / 20 × (1 + 0.02·q + 0.5·influences). Bump the
      pinned commit after 3.30 for new uniques. Notes from before:
  - Scalpel's dust formula: dust = base × 125 × (20 − (84 − ilvl)), with ilvl clamped to
    65–84, × (1 + (2 × quality + 50 × influences) / 100).
  - The formula is a fact we can use. The per-unique base value table
    (`src/shared/data/economy/dust-values.json`) is AGPL and can't be copied; find where the
    values originally come from (the game data), or ask Scalpel's author.
  - Then: rank uniques by dust per chaos (poe.ninja prices through the server), and show dust
    on the Ctrl+D price check.
- [x] **Div card value per area** (built 2026-11-01). wraeclast.cards has no licence (all rights
      reserved) and its drop-rate API needs private keys, so it isn't used. Weights come from
      deathbeam/maps-of-exile (MIT, pinned; `tools/make_divweights.py`). It builds them from
      the Prohibited Library's stacked deck spreadsheets, as wraeclast.cards and Scalpel credit
      too. Div cards → By area has "≈ per 1000 drops" (weight / (pool + area's card weights) ×
      price), a 4-voidstones toggle (level 83), and odds per card. Not a per-map EV: monster
      density isn't counted. Bump the pinned commit each league.
- [x] **Chat macros** (done 2026-11-01: Settings → In game, ▶ or a hotkey; no /hideout, the game has its own key): buttons or hotkeys for /hideout, /kingsmarch, /menagerie, /delve,
      /exit and your own commands. One press = one command, like the trade buttons.
- [x] **View on poe.ninja** (done 2026-11-01: card ⋯ menu, gem panels, Market chart, Ctrl+D quick price): we have PoE Wiki / PoEDB links on items; add poe.ninja (uniques,
      gems, currency).
- [x] **More search text presets** (done 2026-11-01: Flasks and Vendor tabs, tokens checked by test/test_search_presets.py): Scalpel / poe.re do flask and vendor regex too. Add a
      Flasks tab (useful affixes, e.g. "of the Armadillo") and vendor presets (movement speed
      boots, chromatic r-g-b, links).
- [x] **Socket recolour calculator**: became the socket colour helper (section 3; 3.29 changed the system).
- [x] **Loot filter tools** (built 2026-11-01): Tools → Loot filter + a line on the price check.
  - js/filter.js parses and matches; filter_files.py handles files and checkpoints; the page
    is js/app/29-lootfilter.js.
  - Price re-tier (economy audit), build items, your rules, find an item, checkpoints.
  - All edits go in one managed section at the top of the file, so they survive filter
    updates. That's our answer to Scalpel's FilterBlade sync: online filters on GGG's site
    would need the OAuth login GGG hasn't granted.
  - No reloads, no game input.
  - [ ] In game: save, re-select the filter (Options → UI), and check a re-tiered item and a
        hidden base drop as expected; Ctrl+D shows the block line.
- [ ] Maybe later / probably not:
  - Art mode: drawing on top of the game, for content creators.
  - Plugins.
  - "Scrollable stash tabs": sends input to the game, so check GGG's rules first.
  - Path of Exile 2 support: still "not planned" on the roadmap.

## 4. Parked / decided against (and why)

- **Travel to the seller's hideout using POESESSID** (instant buyout): needs an
  unpublished pathofexile.com endpoint called with your session cookie to move your
  account. GGG hasn't sanctioned it, and the site's code is behind Cloudflare. Instant
  buyout still opens the trade site's own button; in-person trades use ⚡ Whisper / Visit
  hideout in game. Revisit only if you explicitly accept the account risk.
- ~~Dust (disenchant) explorer~~: un-parked 2026-11-01, see 3b (Scalpel shows the formula and a
  per-unique table exist).
- ~~True expected value per map for div cards~~: un-parked 2026-11-01, see 3b (wraeclast.cards has
  drop weights).
- **Server reading the wiki**: poewiki.net refuses Vercel (HTTP 403). Drop data is made on
  a PC (`tools/make_divcards.py`) and served as a static file.
- **GGG OAuth / official login**: built but off. GGG isn't accepting new applications
  (re-checked 2026-11-01).
- Earlier user decisions: no stash-aware shopping or server-side whispers; no shared
  reputation lists; no automatic /ignore, thank or kick; the server never proxies trade
  searches.

## 5. Rules this project keeps (GGG + safety)

- One button / hotkey press = one game action. Nothing is sent on a timer or from a log
  event. Invite and Trade are separate buttons (no cycling).
- Log reading only after the user switches the trade helper on. Everything stays local.
- Never navigate the in-app browser to pathofexile.com (it crashed Claude Code); use curl.
- Never run tests that take focus or press keys on the user's desktop without asking
  first (it hit the user's game twice). Headless tests by default.
- Commits end with the Claude co-author line; releases only with the user's go-ahead.
