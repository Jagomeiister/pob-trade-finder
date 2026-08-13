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
| `open_url(url)` | System browser (pathofexile.com only) |
| `refresh_data()` | Re-download stats + leagues, regenerate `data/*.js` |
| `check_update()` / `apply_update(url)` | GitHub Releases auto-update (see below) |

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
examples). Run tests before every release.
