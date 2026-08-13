# PoB Trade Finder

Paste a Path of Building export code → get pre-filled official trade-site searches for
every gear slot. No more manually typing mods into pathofexile.com/trade.

## Install (Windows)

Grab the latest zip from [Releases](https://github.com/Jagomeiister/pob-trade-finder/releases),
extract anywhere, run **`PoB Trade Finder.exe`**. The app checks for updates on launch and
installs them itself (one click, restarts automatically).

Running from source instead: `pip install pywebview`, then `python gui.py`.

## Releasing a new version (maintainers)

1. Bump `VERSION` in `gui.py`
2. `python tools/build_release.py` → builds the exe and `dist/PoBTradeFinder-v{V}.zip`
3. `gh release create v{V} "dist/PoBTradeFinder-v{V}.zip" --title "v{V}" --notes "..."`

Every installed copy picks the release up on next launch.

## How to use

1. **Run `PoB Trade Finder.bat`** — opens the desktop app (native window, needs
   `pip install pywebview` once). In the app, pasting a pobb.in / pastebin / poe.ninja
   link works directly — the Python backend fetches it for you.
   *Alternative:* double-click `index.html` for the browser version — identical UI,
   fully offline, but share links may be blocked by CORS there (paste the raw code instead).
2. In PoB: **Import/Export Build → Generate → Copy** the export code.
3. Paste it into the tool, hit **Decode build**.
4. If the build has multiple gear sets (Leveling / Budget / Endgame…), pick which one to
   shop for with the **Gear set** dropdown — it defaults to whichever set the creator had active.
5. Every equipped item appears as a card with its mods matched to official trade stats:
   - Tick/untick the mods you care about (crafted mods start unticked — you'll re-craft those).
   - **Min roll** slider sets minimums as a % of your current rolls (default 80%).
   - **Pseudo totals** folds life/res/attribute rolls into pseudo stats so hybrid rolls still match.
   - **Match mode** "all but one" (default) finds items missing any single mod — where upgrades usually hide.
   - Weapons default to **same base type**; armour/jewellery use the slot category.
   - 5/6-link items get an optional links filter. Uniques are searched by name.
6. **Check price** (desktop app) runs the search through GGG's trade API and shows the
   cheapest 8 listings as full item cards — item art, every mod with its tier (P2/S2),
   searched mods highlighted ◆, quality/defence values, links + corruption badges,
   price and seller. **Check all prices** does every slot in one go (rate-limit
   throttled, ~3s per slot). Per listing: **⚡ Whisper in game** pastes the buy whisper
   straight into the PoE client's chat, **⌂ Hideout** sends `/hideout <seller>` to travel
   to them, **Copy whisper** for manual pasting. A **Sale** filter picks buyout/fixed-price
   only (default), any, or unpriced listings. (Instant buyout is a PoE2-only trade feature.)
7. **Refresh trade data** (desktop app) re-downloads stats + leagues at league start.
8. Influenced items get a "Require influence" filter (on by default — the mod pool needs it),
   cluster jewels search by exact passive count + notables + small-passive grants, abyss
   jewels in abyssal sockets are included, and your league/settings/last build are remembered.
   Per card: **Sockets ≥ / Links ≥** selects (links default to the build item's 5/6-link),
   a **Min roll %** override, and **Require fractured mod(s)** for crafting-base hunting.
   **Uniques** list their mods too — tick one to require a minimum roll (Shav's ES%, etc.).
   Listings paginate 10 at a time (Prev/Next fetches more, up to the first 100).
   PoB's ModRange roll data is used, so ranged mods reflect the build's actual rolls.
9. **Search on trade site ↗** opens pathofexile.com/trade with everything pre-filled
   (uses the site's `?q=` query parameter — nothing is automated against GGG, it's just a link).

### Listings & buying

- Click **any mod on a listing** to sort all results by it (highest → lowest → clear);
  the ⇅ buttons on your search mods do the same. Sorting is server-side across every listing.
- Every mod shows its **tier (P2/S2), tier roll range and where the roll landed** — `[115–129] 71%`,
  green for high rolls, red for low.
- **Open prefix/suffix** badges estimate free affix slots for crafting; crafted mods are
  master-craft blue, Eater/Exarch items get badges + tinted implicits.
- **⚡ Instant buyout** listings show the gold fee and a **⌂ Go to hideout** button (opens the
  search on the trade site — travel + purchase happen there with your logged-in session).
  In-person listings get **⚡ Whisper in game** / **⌂ Hideout** (after party invite) / **Copy whisper**.
- **🔴 Go live** watches a search (~20s polls) and dings + flashes new listings in. Max 2 at once.
- Open result panels are **re-checked every 30s** — sold/delisted items grey out until you re-check.
- **Min-roll inputs are clamped to what the mod can actually roll** (lowest tier min → highest
  tier max, distilled from RePoE). Regenerate with `python tools/make_ranges.py --fetch`.

## Updating data (new league / new mods)

```
node tools/make-data-js.js --fetch
```

Re-downloads `stats.json` + `leagues.json` from GGG's public trade API and regenerates
the bundled `data/*.js` files.

## Tests

```
node test/test.js
```

Round-trips a synthetic build through deflate/base64 encoding, parses it, and matches
every mod against the real stat database (30 assertions).

## Files

- `index.html` — the app (open this)
- `js/pob.js` — PoB code decode (base64url + zlib) and XML/item parsing
- `js/matcher.js` — mod-line → trade stat ID matching (local-mod preference,
  increased/reduced flip, pseudo mapping, crafted/fractured/enchant sections)
- `js/app.js` — UI + trade query construction
- `data/` — bundled GGG trade data (stats + leagues)

## Notes

- PoE 1 only for now. PoE 2 would need `/api/trade2/data/stats` + the `trade2` URL — the
  architecture supports it if you want it added.
- Link fetching (pobb.in/pastebin) is attempted but browsers often block it (CORS) —
  pasting the raw code always works.
- FYI: PoB Community also has a built-in "Trade for these items" feature (Items tab) that
  does weighted searches using your build's actual DPS/EHP weights. This tool is the
  no-crash, shareable-URL alternative with per-mod control.
