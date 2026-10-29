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
- **`js/app.js`** — UI + query construction + all async features. Key invariants:
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
| `trade_search(league, payloadJson)` | POST search; returns first 10 listings + up to 100 ids |
| `trade_fetch(searchId, idsJson)` | One further page (≤10 ids, ids validated) |
| `exchange_rates(league, currenciesJson)` | Median chaos rate per currency from GGG bulk exchange, 30-min cache |
| `unique_icon(name, base)` | Unique art via one Standard-league lookup, cached forever in `data/unique_icons.json` |
| `poe_chat(text)` | Paste one chat line into the PoE client (ctypes clipboard + Enter/Ctrl-V/Enter) |
| `set_price_hotkey(spec)` / `hotkey_status()` | In-game price-check hotkey: `ctrl+d` / `ctrl+shift+d` / `alt+d` / `off`; status carries `active` + a conflict `error` |
| `overlay_hide()` | Hide the price-check overlay and refocus the game |
| `open_url(url)` | System browser (pathofexile.com only) |
| `refresh_data()` | Re-download stats + leagues, regenerate `data/*.js` |
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
- `js/app.js` overlay mode is the delimited block at the end of the file. `markGui()`
  hands off to `overlayReady()`, so no update checks, market loads or session polling run
  in the overlay. `__overlayItem` re-hydrates settings from bridge storage, so league
  changes made in the main window apply, and then reuses `renderPastedItem` +
  `checkPrice`. The same item within 60s with results showing does not search again.
  `__overlayHidden` stops the 60s sold watcher while the overlay is hidden
- Tests: `python test/test_price_hotkey.py` covers the pure helpers and the watcher's
  register/unregister/dispatch. It uses a fake focus probe and Ctrl+Alt+Shift+F24 and
  never touches the clipboard or sends keys. The real keypress → game → clipboard path
  can only be tested by hand in the game

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
# bump VERSION in gui.py, then:
python tools/build_release.py     # PyInstaller onefile (--collect-all webview) + staged zip
gh release create v{V} "dist/PoBTradeFinder-v{V}.zip" --title "v{V}" --notes "..."
```

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
