# PoB Trade Finder — Developer Guide

## Architecture

One web app, two hosts:

```
index.html + js/*  ──────────────►  any browser        (search building only)
        │
        └── pywebview (WebView2) ►  gui.py desktop app (adds the Python bridge)
```

- **`js/pob.js`** — decodes PoB export codes (base64url → zlib inflate → XML) and parses
  items. Regex-based XML extraction so the identical file runs in Node (tests) and the
  browser. Handles `<ModRange>` roll positions, `{crafted}/{fractured}/{range:x}` tags,
  implicit blocks, gear sets, tree/abyssal jewels, influences, and a no-`Implicits:`
  fallback.
- **`js/matcher.js`** — maps mod text lines to trade stat IDs using the bundled
  `/api/trade/data/stats` payload. Two indexes: **normalized** (digits → `#`) and
  **exact** (digits kept — fixed-text stats and value-in-id enchants like
  `enchant.stat_X|15`). Match order per mod kind (implicit/crafted/fractured/explicit),
  then fallbacks: `(Local)` twin on weapon/armour slots → plural drift ("3 Charges" vs
  "# Charge") → sign drift (`-#` vs `+#` templates) → phrase aliases ("Chance to Block" →
  "… Attack Damage") → increased↔reduced flip with value negation.
- **`js/app/*.js`** — UI + query construction + all async features: one program split by
  feature into 16 ordered files (`01-state.js` … `16-overlay.js`). They are plain scripts
  (no modules, no build step) loaded in order by `index.html` and share their top-level
  names, so a function in one file can call any other. Top-level code that *runs* at load
  (rather than declaring) may only use names from the same or an earlier file; everything
  else runs from `DOMContentLoaded` or later. New files go in the `index.html` script list
  and `tools/build_release.py` `SHIP` (test_contrast.js checks both). Key invariants:
  - `buildTradePayload(state)` is the single source of query JSON; every consumer
    (trade links, price checks, live search, sold watcher) goes through it
  - Long-lived pollers **freeze `payloadStr` + league at start** and hold a session
    object; post-await code checks identity (`state.live === session`) so stop/restart
    can't revive dead timer chains, and UI changes can't shift a watched result window
  - `checkPrice` uses a generation counter (`priceSeq`) so rapid re-searches can't race
- **`gui.py`** — pywebview window + `Api` bridge class.

### Bridge API (`window.pywebview.api.*`)

| Method | Purpose |
|---|---|
| `fetch_pob_link(url)` | Fetch a PoB code from pobb.in/pastebin/poe.ninja (host-allowlisted) |
| `guides_data()` | Mechanic guides from the app's server (`server/public/guides.json`), cached to `data/guides_cache.json`; the page keeps whichever of it and the shipped `data/guides.js` has the newer `version` |
| `open_url(url)` | Opens allow-listed sites, or an http(s) URL that exactly matches a source listed in the guide data (Read more links, the tools' sources and strategy atlas links) |
| `mech_prices(league, groupsJson)` | Mechanic tools: icon + chaos price for whole item groups (`Api.MECH_GROUPS`: scarabs, fossils, essences, lifeforce, oils, catalysts, delirium, fragments, expedition, foulborn, embers, currency) from the hourly exchange feed only; icons not yet in the art cache are fetched in a background thread |
| `trade_search(league, payloadJson, background=False)` | POST search; returns first 10 listings + up to 100 ids. `background` (saved-build daily re-pricing) paces at `BG_INTERVAL` and is refused during any cooldown |
| `trade_fetch(searchId, idsJson)` | One further page (≤10 ids, ids validated) |
| `exchange_rates(league, currenciesJson)` | Median chaos rate per currency from GGG bulk exchange, 30-min cache |
| `unique_icon(name, base)` | Unique art via one Standard-league lookup, cached forever in `data/unique_icons.json` |
| `poe_chat(text)` | Paste one chat line into the PoE client (ctypes clipboard + Enter/Ctrl-V/Enter) |
| `set_price_hotkey(spec)` / `hotkey_status()` | In-game price-check hotkey: `ctrl+d` / `ctrl+shift+d` / `alt+d` / `off`; status carries `active` + a conflict `error` |
| `overlay_hide()` | Hide the price-check overlay and refocus the game |
| `open_url(url)` | System browser (pathofexile.com only) |
| `refresh_data()` | Re-download stats + leagues, regenerate `data/*.js` |
| `league_check()` | Live PC trade leagues vs the bundled list (one background call) → new-league banner |
| `cx_overview(league)` / `cx_history(…)` | Market page: every exchange item, 7 days 6-hourly / one item's 1- or 30-day series (currency feed, no trade quota) |
| `cx_flips(league)` | Latest hour's chaos-market vs divine-market price per item (`CurrencyFeed.pairs`, `<hour>.pairs.json`) |
| `oauth_status()` / `oauth_login()` / `oauth_logout()` | Official login (`oauth.py`): GGG's public-client OAuth, PKCE S256, redirect `http://127.0.0.1:8080/callback`, tokens in `data/oauth.json`. Off while `OAUTH_CLIENT_ID` in `gui.py` is empty (GGG isn't accepting new applications) |
| `stash_value(league)` | Official API (`account:stashes`, `OAuth {clientId}/…` User-Agent): every tab's exchange items valued at the currency feed's prices; other items counted |
| `quick_price(league, itemJson)` | Pasted/Ctrl+D items without a trade call: exchange items by name from the currency feed (+ stack value); uniques/gems from `PRICES_API` (the app's backend, `server/`, proxying poe.ninja), cached 30 min |
| `bulk_exchange(league, code)` | One bulk-exchange request (user-pressed **Live offers**): online offers for that trade code in chaos/divine, cheapest chaos-each first, top 20 |
| `diagnostics()` | Bug-report text: version, OS, data dates, log tails; POESESSID, 32-hex tokens and the Windows user name redacted |
| `check_update()` / `apply_update(url)` | GitHub Releases auto-update (see below) |

## In-game price check (hotkey + overlay)

- **`price_hotkey.py`** (ctypes only) owns everything native. `HotkeyWatcher` is one
  thread that every 250ms checks whether the foreground window's title is exactly
  `Path of Exile`, then `RegisterHotKey`s / `UnregisterHotKey`s, so the key is never taken
  from other apps. `RegisterHotKey(NULL, …)` binds to the *calling thread's* queue, so
  registration and the `WM_HOTKEY` pump (`MsgWaitForMultipleObjects` + `PeekMessage`)
  must stay on that one thread. Changing the hotkey only sets the spec, and the thread
  re-registers on its next tick. A failed registration means another program owns the
  key (usually Awakened PoE Trade). That shows up as `hotkey_status().error`
- On press, `copy_item_text()` saves the clipboard text and records
  `GetClipboardSequenceNumber`. It sends key-ups for any held Shift/Alt/Ctrl, then a
  fresh Ctrl+C. Without the key-ups, Alt+D would turn into Ctrl+Alt+C, the "advanced"
  copy format that `PoB.parseGameItem` doesn't parse. It then polls the sequence number
  for up to 600ms, reads the text, and puts the old text back. Text that doesn't start
  with `Item Class:`/`Rarity:` is ignored
- The Win32 prototypes use private `ctypes.WinDLL` instances with explicit
  `argtypes`/`restype`. Don't set prototypes on `ctypes.windll.*`: pywebview shares those,
  and the default `c_int` return truncates 64-bit handles. `Api._set_clipboard` (used by
  `poe_chat`) delegates here
- **Overlay window:** `main()` creates a second pywebview window, hidden and `on_top`, on
  `index.html?overlay=1` with the **same `Api` instance**, so the GGG rate limiter stays
  global. Both URLs are local paths, so pywebview serves them from its built-in server and
  the query string survives. `_show_overlay` calls
  `window.__overlayItem(<json.dumps(text)>)` through `evaluate_js`. JSON-encoding keeps the
  item text a string literal. It then moves the window to the half of the game window
  away from the cursor (`overlay_position`), shows it and focuses it. Focusing works
  because the process that receives a hotkey gets foreground rights
- The overlay's close box only hides it: its `closing` handler returns `False` unless
  `Api._quitting` is set. Closing the main window sets `_quitting` and destroys the
  overlay. Without that, the hidden window would keep `webview.start()` running.
  `apply_update` sets `_quitting` too
- Overlay mode is `js/app/16-overlay.js`. `markGui()`
  hands off to `overlayReady()`, so no update checks, market loads or session polling run
  in the overlay. `__overlayItem` re-hydrates settings from bridge storage, so league
  changes made in the main window apply, and then reuses `renderPastedItem` +
  `checkPrice`. The same item within 60s with results showing does not search again.
  `__overlayHidden` stops the 60s sold watcher while the overlay is hidden
- Tests: `python test/test_price_hotkey.py` covers the pure helpers and the watcher's
  register/unregister/dispatch. It uses a fake focus probe and Ctrl+Alt+Shift+F24 and
  never touches the clipboard or sends keys. The real keypress → game → clipboard path
  can only be tested by hand in the game

## Trade helper (trade_helper.py + js/app/19-trades.js)

A third window, `index.html?trades=1` (`TRADES_TITLE`, on top, created hidden), shares the
Api. `trade_enable(on, path)` starts `trade_helper.LogTail` on Client.txt (found from the
game process's exe folder, else common install folders, else the user's pick). It starts at
the end of the file and tails it by byte offset. Each parsed event (whisper with a parsed
`trade`, joined/left, trade accepted/cancelled, AFK/DND, zone) goes to
`window.__tradeEvent(ev)`. An incoming trade whisper also shows the window with
`SW_SHOWNOACTIVATE` (display only).

GGG rules, enforced by the shape of the code. Keep them:

- Game input happens only in `trade_send(action, name, text)`: one call → `command_for` → one
  `ChatSender.send` (focus game, chat key from production_Config.ini, Ctrl+A, paste, Enter,
  clipboard restored; serialized). The only callers are button handlers in 19-trades.js.
  Log events never send anything.
- No cycling: Invite and Trade are separate buttons. Nothing auto-thanks, auto-kicks or
  auto-ignores.
- The trade ledger lives in storage.json and is never shared: `pobtf-sales` (sold),
  `pobtf-purchases` (bought), `pobtf-buyers` (people, buyers and sellers: counts, flag,
  hidden, `ignored` = when /ignore was sent from the app, `waster` override),
  `pobtf-buyer-aliases`, `pobtf-trade-goal`, `pobtf-trade-prefs`. Pages and maths:
  js/app/25-trade-ledger.js (bulk currency swaps count by `goodsChaos` vs `chaos`, filled in
  once by `ledgerEnrich` via `quick_price`, whose exchange answers carry `cat`).
- `trade_highlight` only draws a click-through outline (`StashHighlight`); it never moves
  the cursor.

| Bridge | |
|---|---|
| `trade_enable(on, path)` | start/stop the log tail → status (`watching`, `logPath`, `chatKeyName`, `elevationMismatch`, `error`) |
| `trade_send(action, name, text)` | one chat command (`invite`, `trade`, `kick`, `hideout`, `whois`, `ignore`, `whisper`) |
| `trade_highlight(left, top, tab)` | outline that stash cell over the game for 20 s |
| `trades_show()` / `trades_hide()` | the trades window |
| `trade_pick_log()` / `save_text_file(name, text)` | file dialogs (Client.txt pick, CSV export) |

## In-game overlays, hotkeys, tray (gui.py)

- `OVERLAYS` = separate frameless, `focus=False` (WS_EX_NOACTIVATE) windows. They are *not*
  pywebview `transparent=True`: on Windows that leaves the form's grey background, and it
  `Show()`+`Activate()`s the window on navigation. A colour key (LWA_COLORKEY) doesn't work
  on WebView2 content either (tested). Instead each page reports its drawn shapes
  (`overlayShapes`) and `overlay_shape` clips the window with `SetWindowRgn`. Outside the
  shapes the window doesn't exist (see-through, clicks reach the game). The windows are:
  `icon` (`?ovicon=1`) and `cards` (`?cards=1`, which also owns the Client.txt reader).
- `_follow_game` (0.3 s) shows each one only while the game or one of our windows is in
  front. It checks the real visibility every tick, because pywebview shows transparent
  windows by itself on load.
- Placement is relative to the game's client rect and redone whenever that rect changes, so
  overlays follow the game across screens.
- Drag: the ⠿ grip uses pointer events and calls `overlay_drag(name, start|move|end, dx, dy)`.
  Python moves the window and saves the spot (`pobtf-ov-<name>-pos`, with `bottom` for the ones
  that grow upwards from the lower half). pywebview's `.pywebview-drag-region` isn't used: it
  leaves a white patch on transparent windows.
- Pages size their own window with `overlay_fit(name, w, h)` and report
  `overlay_visible(name, on, count)`. The icon ↔ cards messages go through Python
  (`overlay_toggle_cards`, `__ovCount`).
- Hotkeys: `HOTKEY_DEFAULTS` price / app / trades, one `HotkeyWatcher` each, held only while
  the game, one of our overlays, or the app-over-game window is in front. `set_hotkey`,
  `hotkeys_status`.
- App hotkey: `_set_app_overlay` makes the main window `on_top` and focused with a banner
  (`__appOverlay`). `_overlay_frame` removes the caption (it keeps the sizing edges) and places the window
  at `pobtf-overgame-rect`, stored as fractions of the game's client rect (default centred,
  78%×86%). It's layered only if `overGameOpacity` < 100. Banner drag goes through
  `app_overlay_move`, − / + through `app_overlay_size`, and the rect is remembered on exit.
  `_follow_game` puts the app away when the game becomes the foreground window
  (`closeOnGameClick`). Esc or the hotkey returns to the game.
- The Trade helper is the main window's `#view-trades` (`mountTradeHelper(…, embedded)`).
  `trades_show` and the tray open it there; there's no separate window.
- Tray (`tray.py`, ctypes Shell_NotifyIcon): the main window's ✕ hides to the tray
  (`closeToTray` pref). Menu: Open, Trade helper, Settings, Quit (`_quit` sets `_quitting`
  and destroys the main window).

## v2.3 tools

- `js/app/20-unique-jewels.js` (view `uniques`):
  - Data comes from `data/watcherseye.js` (`tools/make_watcherseye.py`). That reads Path of
    Building's `WatchersEye.lua` plus `watchersEyeLegacyMods`, drops legacy mods and checks
    every stat id against `data/stats.json`.
  - `data/forbidden.js` (`tools/make_forbidden.py`) holds the per-node stat ids
    (`explicit.stat_2460506030|<node>` Flame, `explicit.stat_1190333629|<node>` Flesh), the
    ascendancy from the tree, and Thread of Hope's `explicit.stat_3642528642|1..5`.
  - Batches go through `runBatch` (paced, Stop).
- `js/app/21-search-text.js` (view `search`):
  - `data/mapmods.js` (`tools/make_mapmods.py`) has the shortest unique token per map mod.
    The generator drops quantity/pack-size lines, avoids map names, and allows matches only
    with mods that share the same line.
  - `atLeastRegex(n)` builds the quantity part.
  - Paste goes through `game_search_paste` → `ChatSender.paste_search` (Ctrl+F, Ctrl+A,
    paste, no Enter).
- Learned filters (08-cards):
  - `pobtf-filter-habits` maps a stat id to `{on, off}`, counting only hand clicks
    (`rowState.userSet`) that differ from the default. They are recorded in `checkPrice` for
    pasted items.
  - A score of ±2 sets the default, shown with a "learned" chip.
- Zone notes (19-trades): a `zone` event looks up `pobtf-zone-notes` (starters:
  Act 1–3 trials). The note shows in the cards overlay; display only.
- `js/app/23-tree.js` (view `tree`, the Skill tree):
  - Layout: `data/treeview.js` (`tools/make_treeview.py`, from the cached `data/tree.min.json`).
    Node positions use the same PoB orbit maths as `make_timeless.geometry()`. Links between
    two nodes on the same group + orbit are stored as arcs (`[a, b, cx, cy, r]`) and drawn
    the short way round the group centre. Masteries get no drawn links; `masteryLinks` lets
    the walk below reach them. Proxy nodes and groups are dropped. Cluster-jewel sockets
    (flag 1) are drawn only when the build allocates them.
  - Ascendancy groups sit far outside the main tree in GGG's export, so each ascendancy is
    drawn on its own in an inset canvas, fitted to that ascendancy's bounds. The build's
    ascendancy is shown first, then any other one it allocates in (bloodlines).
  - Rendering is one 2D canvas per view (devicePixelRatio-scaled). Colours are read from
    the CSS tokens at every draw, and a MutationObserver on `<html>` redraws on theme or
    accent changes. Labels never go below 12px, and colliding labels are skipped by priority.
  - Compare: `get_character_passives(account, character)` →
    `character-window/get-passive-skills` → `{hashes, hashesEx, masteries, jewels}`.
    Character jewels map to sockets through `jewelSlots[x]`. `treeCompare` does a BFS from
    everything the character has, plus the build's class and ascendancy starts, through
    build-only nodes. Masteries are dead ends. Distance is the "step" in **Next points to
    take**. Mastery effect ids are validated against the tree (the API's encoding has
    changed over time).
  - Tests: `python test/test_treeview.py` (positions vs `timeless.json` geometry, link
    sanity, freshness against the cache, the bridge) and e2e scenario `27 tree`.

## Rate limiting (do not weaken this)

All GGG calls go through `Api._http`:

- ≥2.5s spacing between calls (single lock shared by every feature)
- **Quota headers** (`X-Rate-Limit-{rule}` / `-State`) are parsed after every response:
  >60% of any window → paced to the sustainable rate; one-from-cap → wait the window;
  server `restricted` → honored exactly
- **429 → global lockout** for `Retry-After` seconds; no retries (retrying during a
  penalty is what earns 20-minute bans)
- Lockouts >30s **fail fast** with a countdown message instead of sleeping threads

Background load: sold watcher is one shared 60s timer round-robining over open panels
(1 call/tick regardless of panel count); live search polls per-watch at 30s, capped at 2.

## Data pipelines (all bundled, regenerable)

| File | Source | Regenerate |
|---|---|---|
| `data/stats.js`, `data/leagues.js` | GGG `/api/trade/data/{stats,leagues}` | `node tools/make-data-js.js --fetch` or the in-app button |
| `data/ranges.js` | RePoE `mods.min.json` + `stat_translations.min.json` (translations carry `trade_stats` ids directly) → min/max roll per trade stat, avg-space, pseudo excluded | `python tools/make_ranges.py --fetch` |
| `data/baseicons.js` | RePoE `base_items.min.json` `visual_identity.dds_file` → `web.poecdn.com/image/<path>.png` | `python tools/make_baseicons.py --fetch` |
| `data/unique_icons.json` | Runtime cache (gitignored) | automatic |

RePoE lives at `https://repoe-fork.github.io/<file>` (root path — not `/RePoE/data/`).

## Hard-won API facts

- The trade site accepts full query JSON via `?q=` on `/trade/search/{league}` — that's
  how all links work; nothing is automated against the site itself
- `query.status.option`: `available` (instant buyout + in person), `securable`
  (instant only), `online`, `onlineleague`, `any`. Instant listings carry `listing.fee`
  (gold) and **no whisper**
- Server-side stat sorting: `sort: {"stat.<statId>": "asc"|"desc"}` — works for stats
  **not** in the filters, and for pseudo stats
- Fetch API mod entries are rich objects: `description`, `hash`, `mods[0].tier`
  (`P2`/`S2` = prefix/suffix tier), `mods[0].magnitudes` (tier roll range) —
  this powers tier badges, roll percentiles, and open-affix estimates
- `item.extended`: `base_defence_percentile`, `dps/pdps/edps`
- Filter keys worth knowing: `armour_filters.base_defence_percentile`,
  `misc_filters.{shaper_item,…,searing_item,tangled_item,ilvl}`,
  `trade_filters.sale_type` (`priced`/`priced_with_info`/`unpriced`/`any`),
  `socket_filters.{sockets,links}`
- Currency rates: POST `/api/trade/exchange/{league}` `{want:[cur], have:["chaos"]}`,
  median of `offers[0]` ratios (poe.ninja's old API is gone)
- pathofexile.com **HTML** is Cloudflare-gated; the **API** endpoints are not. Never
  drive a browser at the site (bot challenge) — and never call the API while the
  user's IP is mid-ban
- Transfigured gems are **not** standalone item types — `type: "Frostblink of
  Wintry Blast"` gets HTTP 400 "Unknown item base type". They are a base type +
  discriminator: `type: {option: "Frostblink", discriminator: "alt_x"}`. The map
  comes from `/api/trade/data/items` (gems section entries with `disc`) —
  bundled as `data/gemtypes.js` by `tools/make_gemtypes.py`
- `character-window/get-items` mod arrays arrive either as plain strings (old)
  or as `{description, flags:{crafted,fractured}}` objects with crafted/fractured
  merged into `explicitMods` (new). The bridge re-normalizes to the old string
  contract in `Api._char_mods` — without it the gear diff sees zero equipped mods
  on rares and reports everything "missing"
- Since 3.29 the trade **fetch** API does the same: no `craftedMods` /
  `fracturedMods` arrays; those mods sit in `explicitMods` tagged
  `domain: "crafted"|"fractured"` + `flags`. `Api._split_listing_mods` re-splits
  them (rich objects kept intact) so colours, tiers and affix counts work
- Rate limiting: `_read_quota` re-reads every rule from each response (policy
  changes need no state). 429 → global hold from `Retry-After`; 5 pathofexile.com
  4xx responses inside 60s → 60s global hold (GGG restricts clients that burst errors)
- League day: `python tools/refresh_all.py` regenerates every data table and runs
  the tests. Stats with `option` dropdowns are now only Temple rooms and eldritch
  tier pseudos — gear stats (cluster jewels included) are numeric or value-in-id
- Currency rates and price history come from GGG's public hourly feed
  (`currency_feed.py`): `GET https://web.poecdn.com/api/currency-exchange/<unix hour>`,
  no auth, not the trade API. Each hour is an immutable ~0.9 MB snapshot of every
  exchange market in every league; the current hour 404s until published (latest
  is usually now − 1h). A market `{A: a, B: b}` reads "a of A traded for b of B".
  `distill()` reduces a snapshot to `{league: {metadata id: [chaos value, chaos
  volume]}}` using a volume-weighted price across BOTH the chaos and divine markets
  (cheap orbs trade in bulk vs divines — either market alone jitters); no-trade
  hours fall back to the ratio-range midpoint. Distilled hours are cached forever
  in `data/cx_cache/<hour>.v<FORMAT>.json` — bump `FORMAT` when `distill()` changes.
  `data/currencymap.json` (tools/make_currencymap.py) maps trade codes ("divine")
  to metadata ids by item name. `exchange_rates()` is feed-first and only falls
  back to the trade exchange API for codes the feed lacks
- Craft vs buy: `tools/make_craftdata.py` → lazy-loaded `data/craftdata.js` (mods with
  spawn-weight lists, groups, required level, and their stats translated to trade-stat
  tails in the app's averaged value space; essences Screaming+; bench recipes; base
  tags + influence tag prefix; fossils + resonators). Spawn weight = the FIRST tag in the mod's list that the
  item carries. Influence tags are `<class>_<shaper|elder|crusader|eyrie|basilisk|adjudicator>`
  (eyrie = Redeemer, basilisk = Hunter, adjudicator = Warlord); 2H weapons use
  `2h_axe` etc. `js/craft.js` samples 4/5/6 affixes at 8:3:1, ≤3 prefixes/suffixes, one
  mod per group, drawing over tier *families* for speed (~1.5M trials/s). It's validated
  against exact enumeration in `test/test_craft.js` — keep those passing when touching it
- Fossils: RePoE `fossils.min.json` is a dict keyed by metadata id (also ~420
  `RandomFossilOutcome*` rows = Tangled outcomes; ignored). Each fossil has
  `positive_mod_weights` / `negative_mod_weights` (`[{tag, weight}]`), `added_mods`,
  `forced_mods`, `corrupted_essence_chance`, `mirrors`, `rolls_lucky`, … Weights are
  percentages (1000 = ×10, Prismatic 600 = ×6, Aetheric/Serrated "fewer" 15 = ×0.15,
  0 = blocked) and match the mod's **`implicit_tags`** (`IncreasedLife*` → `life`,
  armour/ES/evasion mods → `defences`, fire res → `elemental`,`fire`,`resistance`) —
  not spawn-weight tags. Source: poewiki "Fossil" (+ Talk page, read via
  `poewiki.net/w/api.php?action=parse&page=Fossil&prop=wikitext&format=json`; the HTML is
  bot-gated). `make_craftdata.py` bundles a per-mod tag bitmask (`mods[i][6]`), the 18
  pure weight-changing fossils (+ Faceted's added gem-level suffixes, flag 8) and the
  resonator codes. `Craft.fossilMultiplier`: a fossil touches a mod once (a matching
  fewer/no entry wins over its "more"); fewer/no multiply across fossils; "more" stacks
  **additively** by default (CraftOfExile/poeDB default — the community disputes it;
  `'multiplicative'` is supported). `Craft.fossilCombos(P)` rebuilds the family pool per
  combo (~0.2 ms each): every fossil that changes the pool, then 2/3-combos of the best 7
  by `roughOdds` (analytic, ranking only). The UI prices only the top 3 combos per size
  (bounds trade-API fallbacks for fossils the feed lacks) and simulates the best one per
  size by rough odds per chaos
- Chaotic resonators: the currency feed trades the **stackable** rows
  (`Metadata/Items/Delve/DelveStackableSocketableCurrencyReroll1..4`), not the
  `DelveSocketableCurrencyReroll*` rows with the same names — `make_currencymap.py`
  prefers stackable item classes for duplicate names
- Not researched into code: alt-regal (no reliable source for the Orb of Alteration
  1-vs-2 affix split) and a Craft of Exile export (its share link is an undocumented
  querystring of CoE-internal ids — `b`, `bi`, `m`, `e`, `f`, `i`, `lv`, `req`=JSON, `l`
  fossil stacking mode, …; the only public import is pasting Ctrl+Alt+C item text)
- Timeless jewels (`timeless.py`, data `data/timeless.json` from `tools/make_timeless.py`):
  Path of Building's lookup tables (MIT, see THIRD_PARTY_NOTICES.md), pinned to one PoB
  commit with sha256 per table; the ~2 MB zlib tables download on first use into
  `data/timeless_cache/` (URL allowlisted to PoB's repo, checksum enforced). Layout:
  `byte = lut[row * seedCount + seedOffset]` (rows = notables in `nodeIndex`, 454 of them),
  map through `localToGlobal[type]`, then ≥337 → replaced by `nodes[byte-337]`, else
  gains `additions[byte]`. Elegant Hubris stores seed/20. Small passives and keystones
  don't depend on the seed. Radius: Large = 1800 on 3.16+ trees; node positions use
  PoB's orbit maths (16- and 40-node orbits have fixed angle tables). Sockets inside
  cluster jewels are excluded (they can't hold timeless jewels). Glorious Vanity uses a
  separate 22 MB variable-length table — not implemented
- Trade query budget (measured anonymously): count groups up to 20 filters pass, 40 fail;
  ANY weight group fails even with 2 filters ("Query is too complex … Logging in will
  increase this limit"). With POESESSID, 40-filter timeless checks and weight groups work
- Jewel finder (`js/jewels.js`, `data/jeweldata.js` from `tools/make_jeweldata.py`):
  regular jewel mods are RePoE domain `misc`, abyss mods `abyss_jewel` — the domain decides
  the base family (abyss bases also carry `default`). Scoring = effect weight × weakest
  qualifier; main-skill qualifiers count in full; a minion gem only contributes "minion"
- Thin markets: low-value orbs often see under 5k chaos traded per hour, so hourly
  samples swing ±30%. The market panel flags those rows "thin" rather than hiding it

## Auto-update

`check_update()` compares `VERSION` (gui.py) against the latest GitHub release tag
(semver tuple compare). `apply_update(url)`:

1. URL must start with `https://github.com/{OWNER}/{REPO}/releases/`
2. Zip downloaded to `_update/`, extracted with a path-traversal guard
3. `_apply_update.bat` (CREATE_NO_WINDOW): wait 2s → `robocopy /E /MOVE` over the app
   dir → relaunch exe → self-delete
4. App destroys its windows and exits; user files (caches, settings) survive because
   the zip only contains app files

The web app loads its scripts with `?v=Date.now()` cache-busting — WebView2 caches
file:// scripts between launches, which used to make updates invisible. Keep it.

## Build & release

```
# bump VERSION in gui.py, write docs/release-notes-v{V}.md, then:
python tools/build_release.py     # PyInstaller onefile (--collect-all webview) + staged zip
gh release create v{V} "dist/PoBTradeFinder-v{V}.zip" --title "v{V}" --notes-file docs/release-notes-v{V}.md
```

`build_release.py` refuses to build without `docs/release-notes-v{V}.md` and runs
`tools/make_patchnotes.py` first, which turns every `docs/release-notes-v*.md` into
`data/patchnotes.js` (Settings → Patch notes, drawn by `js/app/30-patchnotes.js`). The notes
become plain data, never HTML: write them in the usual subset (`## vX.Y.Z: title`, `- ` lists
nested by two spaces, `**Bold line**` subheadings, inline `**bold**`, `*italic*`, `` `code` ``
and `[text](https://…)`). Commit the regenerated `data/patchnotes.js` with the release.

The zip layout must stay `exe + index.html + js/ + data/` — the updater and the frozen
`APP_DIR` (`dirname(sys.executable)`) both assume it.

## Tests

`node test/test.js` — 60+ assertions: decode round-trip, parsing (gear sets, ModRange,
influences, cluster/abyss jewels, defensive fallbacks), and matching against the real
stat DB (local preference, pseudo folding, exact-index enchants, plural/sign/alias
fallbacks). UI and bridge behaviour are exercised via stubbed `window.pywebview` in a
browser; `gui.py` quota/updater logic has offline unit checks (see git history for
examples). `python test/test_price_hotkey.py` and `python test/test_currency_feed.py`
cover the Python side. Run tests before every release.

`python test/e2e/run_e2e.py [filter…]` — end-to-end UI tests (about 20 s): headless
Chrome driven over the DevTools protocol (`test/e2e/cdp.py`, no extra dependencies)
against the real front end, served from 127.0.0.1 with the bridge stubbed
(`window.pywebview.api` Proxy injected before page scripts; listings come from
`test/fixture-fetch.json`, the build from `test/fixture-realbuild.txt`). All other network
is blocked. 11 scenarios: landing, decode, price check, pasted item + sell hint, market,
settings + diagnostics, keyboard, wide layout, flips, re-import diff, saved-build
tracking. A scenario fails on any uncaught page exception. Filter by number or name:
`run_e2e.py 3 diff`. `tools/refresh_all.py` runs it with the rest.

`node test/test_contrast.js` guards the design tokens: every text colour in
`css/tokens.css` must reach WCAG AA (4.5:1) on `--bg`/`--s1`/`--s2` and as a tinted chip,
in every theme × accent × high-contrast combination. It also fails if a colour literal
appears outside `tokens.css`, if any rule sets `outline: none`, or if a font size drops
below 12px (mark a deliberate exception with `/* allow-small */`).

## Backend (server/)

`server/` is a Vercel project (Node.js functions, no secrets): `GET /api/prices?league=<id>`
proxies poe.ninja's PoE1 item overviews, as poe.ninja asks of desktop apps
(https://poe.ninja/docs/api): one fetch per category per 30 min (Vercel Runtime Cache + CDN
headers), identifying User-Agent, shrunk to the fields the app reads. Only known leagues and the
single `league` parameter are accepted, so nobody can bypass the cache to fan requests out.
`GET /api/health` for liveness. Vercel project settings: Root Directory `server`, Framework
Other. Tests: `cd server && npm install && npm test`. It must never proxy trade searches: GGG's
limits are per IP, so those stay on each user's PC.

Div card drop data: the wiki refuses Vercel's datacenter addresses (HTTP 403), so the backend
never asks it. `tools/make_divcards.py` (run on a normal PC, part of `refresh_all.py`) reads the
wiki's Cargo tables (`items` + `stackables`, then `areas` in chunks; area ids are validated) and
writes `data/divcards.json` (shipped) and `server/public/divcards.json`. The second one is served
statically at `/divcards.json`, so installed apps get newer drop data on the next push.
`Api.div_cards(league)` tries the server copy first, then the last download
(`data/divcards_cache.json`), then the shipped file. A download with fewer than 100 cards isn't
trusted. Prices are joined by card name from GGG's exchange feed (`currencymap.json`, cat
"Cards"). Credit: Path of Exile Wiki, CC BY-NC-SA 3.0. Tests: `test/test_divcards.py`.

A dust (disenchant) tool isn't built: no reachable source has per-unique dust values. The
wiki only gives the rules (each 1% quality = +2%; each corruption implicit or influence =
+50%).

## Styling

CSS lives in `css/` (loaded cache-busted from `index.html`): `tokens.css` (all colours,
type scale, radii; themes are `data-theme` / `data-accent` / `data-contrast` attributes on
`<html>`), `base.css`, `components.css`, `layout.css`. Add new colours as tokens, never
inline. Legacy variable names (`--panel`, `--gold`, `--dim`…) alias the new tokens until
the v2.0 redesign finishes migrating components — see `docs/UI-PLAN.md`.


## Mechanic guides (Cheat sheets)

- `tools/guides/guides-<patch>.json` is the raw research: 21 guides, each claim checked by three
  verifiers against its source and the patch notes (the `poe-mechanic-guides` workflow). Keep it
  as the record; never hand-edit it.
- `tools/guides/corrections-<patch>.json` fixes what a later review found (removed maps, outdated
  advice…). Each entry has a reason and, for new facts, a source. A `match` that no longer hits
  exactly one place stops the build.
- `tools/make_guides.py` applies the corrections and writes `data/guides.js` +
  `server/public/guides.json`; `tools/make_syndicate.py` builds the Syndicate planner data
  (`data/syndicate.js`) from the same input. Run both, then `test/test_guides.py`.
- Each league: re-run the research workflow (or add corrections from the patch notes), bump the
  file names to the new patch, regenerate, push to main: the server serves the new guides without
  an app release.

### Mechanic tools (js/app/40-43)

- `40-mechtools.js` is the core: `mechTool({id, title, sheets, overlay, available, mount})`
  registers a tool; `mechToolsFor(sheet, overlay)` is what the sheets call — a guide sheet draws
  each tool as an open section (33-guides.js), a sheet without a guide puts them at the top
  (24-cheatsheets.js `mechanicContent`), and the in-game sheet shows `overlay: true` tools on a
  **Tools** tab (click-only: no text inputs there). `available()` false hides a tool with no data.
  Prices: `mechPrices(groups, cb)` → `mech_prices` bridge, one load per league per 20 min.
- 41 scarab hub + profit calculator, 42 price boards, 43 pickers + temple planner. Each has its own
  CSS file (`css/mech-*.css`) and e2e scenario file (`test/e2e/scen_6x_*.py`, picked up by
  `run_e2e.py`'s `_extra_scenarios`).
- The pickers' ratings, the temple's room values/goals and the strategy setups are research:
  `tools/guides/mechtools-<patch>.json` (the `poe-tool-data` workflow: 2 researchers, 3 verifiers
  per claim, a writer per topic; keep it as the record). `make_guides.py` folds it into the guides
  payload as `tools` (sources merged, cites re-pointed, unknown ratings dropped with a warning,
  build tags mapped through `TAG_ALIASES`, kept in step with `MECH_BUILD_TAGS` in 40-mechtools.js),
  so it ships and server-updates with the guides. The tools read it through `mechToolData()`.
  Fixes found later go in `tools/guides/mechtools-corrections-<patch>.json` (add / replace / delete,
  each with a reason and https sources; a stale one stops the build), never into the research file.
- The in-game sheet only redraws when something it shows changed (the 10-s status loop compares the
  hotkey labels); tools keep their view (filters, sort, "Show all") in module-level maps keyed by
  tool id so a real redraw keeps it too.
