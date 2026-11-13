# League day checklist

What to do when a new league (or a big patch) lands. Written for 3.30 "Covens of Umbra";
keep it current.

## Before launch (patch notes out)

1. **Save the patch notes** as text for the research (a mirror such as poedb.tw/us/Version_X
   is easier to fetch than the forum). Keep it out of the repo: it is GGG's text.
2. **Run the patch research** (`poe-330-update` workflow: extract per area, three verifiers per
   claim, a writer) and save the result as `tools/guides/update-research-<patch>.json`.
3. **Guides**: `python tools/make_update.py tools/guides/update-research-<patch>.json` writes
   `tools/guides/updates-<from>-to-<patch>.json`; look at its `skipped` list by hand; then
   `python tools/make_guides.py --checked <date>` and `python tools/make_syndicate.py`.
4. **Notices**: edit `tools/guides/notices.json` (banner text, start time in UTC, retired
   content). Everything in it must be in the official notes.
5. **Trees**: GGG publishes `atlastree-export` and `skilltree-export` tags before launch.
   Bump `TAG` in `tools/make_atlasview.py`; run `make_atlasview.py --fetch`,
   `make_jeweldata.py --fetch`, `make_treeview.py`, `make_timeless.py --update`.
6. Tests, then push `main` (the server serves the new guides) and release.

## At launch

The new league appears in GGG's league list; the app offers **Switch to <league>** itself.

1. `python tools/refresh_all.py` — every data table, then every test. It needs the new
   league to exist on the trade site, and RePoE to have the new game data (it follows the
   patch within hours: if a step fails on missing data, run it again later).
2. Check by hand:
   - `data/currencymap.json` has the league's new currency (3.30: the ten Threads, Frayed
     Thread). New items show under **Market → General → Other** and in `mech_prices`'
     `other` group until they get a group in `Api.MECH_GROUPS` (gui.py).
   - `data/leagues.js` lists the new league (PC only).
   - New base types and uniques price-check (`make_baseicons`, `make_uniquenames`).
   - Loot filter: new `Class` / `BaseType` names and any new conditions (the Item Filter
     Information post) in `js/filter.js` / `js/filter-edit.js`.
3. Bump the pinned commits when their upstreams update: `make_divweights.py` (div card
   weights), `make_dust.py` (dust values), PoB timeless data (`make_timeless.py --update`).
4. `python tools/make_cheatsheets.py` once the wiki has the patch (act routes, quest gems,
   mechanic tables). Check `m.patch` on each sheet.
5. Release.

## After launch

- Re-run the tool-data research (`mechtools-<patch>.json`) for mechanics the patch reworked.
- Remove notices as guides reach the new patch (`untilAsOf` hides them per guide).
- Watch the exchange feed for items the price boards don't group yet.
