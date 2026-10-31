# PoB Trade Finder — User Guide

Turn any Path of Building build into ready-made trade searches: paste the build code,
tick the mods you care about, and buy the gear — with live prices, roll quality, and
in-game whisper/hideout actions, all without touching the trade website's filter UI.

---

## 1. Install & first run

1. Download the latest zip from [Releases](https://github.com/Jagomeiister/pob-trade-finder/releases)
2. Extract anywhere, run **`PoB Trade Finder.exe`**
3. The app checks for updates on launch — when a new version exists, a green banner
   offers **Install & restart** (one click, fully automatic)

> **Browser fallback:** opening `index.html` in a browser gives the same search-building
> UI, but the desktop-only features (live price checks, link fetching, in-game chat,
> data refresh, auto-update) need the exe.

## 2. Loading a build

- **Paste a PoB export code** (PoB → Import/Export Build → Generate → Copy) — decoding
  happens automatically on paste
- **Or paste a link** — pobb.in, pastebin, and poe.ninja/pob links are fetched for you
- **Gear sets:** guide builds usually contain several (Leveling / Budget / Endgame…) —
  pick which one to shop for with the **Gear set** dropdown; it defaults to whatever
  the build creator had active
- **☆ Save build** keeps the current build in a library (the **Saved builds…** dropdown)
  for one-click reload later; 🗑 removes the selected entry
- Your league, filters, and last build are remembered between launches

## 3. Global controls (top bar)

| Control | What it does |
|---|---|
| **League** | Which league to search. **Refresh trade data** updates the list at league start |
| **Trade** | ⚡ *Instant buyout + in person* (default) / ⚡ *instant only* / 💬 *in person* / any — see §7 |
| **Sale** | Buyout/fixed price (default) / any / price with note / unpriced |
| **Pseudo totals** | Folds life/resist/attribute rolls into pseudo stats so hybrid-rolled items still match — finds strictly more items, recommended on |
| **Min roll** | Sets every mod's minimum to this % of the build's roll (default 80%) |
| **Open all searches** | Opens every slot's search in browser tabs |
| **Check all prices** | Live-prices every slot in sequence (rate-limit safe) |
| **Divine Orb tile** | Current divine price in chaos, its 7-day change and trend line (hover or arrow-key through the points). Click it for a table of 14 common currencies with the same 7-day history. Data is GGG's official hourly currency-exchange feed, so it doesn't use any trade-site rate limit. Rows marked *thin* trade so little per hour that their trend is mostly noise |

## 4. Item cards

Every equipped item — gear, jewels (tree, cluster, abyssal-socket), flasks — gets a card
showing its art and mods. Per mod:

- **Checkbox** (or click the row) — include this mod in the search. Bench crafts start
  unticked (you'll re-craft them); everything else starts on
- **Min value** — pre-filled from the build's actual roll × the min-roll %. Inputs are
  **clamped to what the mod can genuinely roll** (lowest tier min → highest tier max),
  so impossible searches can't happen. Pseudo totals are never clamped
- **⇅** — sort results by this mod: once = highest roll first, again = lowest, again = off
- Colours follow the trade site: explicit/implicit blue, **crafted/enchant light blue**,
  **fractured dirty-gold**, implicits above a separator line

Per-card options:

- **Search by** — how strictly to match the base: *this base* (default for weapons),
  *any base with the same defences* (e.g. any pure-ES helmet), *any weapon of that class*
  (e.g. any wand), or *any base* for the slot. Broader searches usually find cheaper items
- **Match** — *all mods* / *all but one* (default — upgrades usually miss one mod) / *all but two*
- **Require influence** — on by default when the build item is influenced (the mod pool needs it)
- **Flexible resistances (any split)** — on cards with 2+ resistance mods: match the
  *combined* total instead of each roll separately (a 75% total split 20/55 matches a
  build asking 35/40). Site links work while logged in there; in-app checks need a
  saved POESESSID (weight searches use the logged-in query budget)
- **🕘 History** — appears after your first price check: the last 8 searches for that slot
  in this build (time, league, listing count, cheapest price); pick one to reopen it on the
  trade site. Re-run the same search later and the card shows a **Cheapest** trend line
  (e.g. 20c → 12c over 3 checks) so you can see whether waiting is paying off
- **Min ilvl** — type a minimum item level (the greyed number is the build item's ilvl)
- **Base %ile ≥ / Sockets ≥ / Links ≥** — caps are slot-aware
  (helm/gloves/boots max 4, shields 3, body 6); links default to the build item's 5/6-link
- **Require fractured mod(s)** — the fractured mod must actually be fractured (crafting-base shopping)
- **Min roll** — per-card override of the global percentage

**Uniques** are searched by name. Their mods are listed unticked — tick one to demand a
minimum roll (only mods that actually roll are editable). Sockets/links/base-percentile
filters still apply.

## 5. Price checking

**Check price** shows the cheapest listings as full item cards:

- Item art, name, **5L/6L · corrupted · exarch/eater/synthesised · ilvl** badges
- **open: 1P 2S** — estimated free prefix/suffix slots (green = crafting room)
- Weapon **DPS / pDPS / eDPS**, armour defences and **Base Percentile** (green ≥85, red ≤15)
- Every mod with its **tier** (P2 = prefix tier 2, S1 = suffix tier 1) and its
  **roll range + percentile** — `+125 to maximum Life [115–129] 71%`, green high, red low
- **◆** marks the mods your search filtered on
- Price with **b/o / fixed / negotiable** tag and **≈ chaos equivalent** (live exchange rates)
- **Click any mod line to re-sort all results by it** (server-side — ranks every listing,
  not just the visible page); the active sort shows as a chip with ✕ to clear
- **10 listings per page**, Prev/Next above *and* below (up to the first 100)

While a results panel is open, the app **re-checks it every 60s** and greys out anything
**sold / delisted** until you press Check price again.

The **Build cost panel** (appears above the results) totals the cheapest listing per
priced slot in chaos, with a divine conversion — run **Check all prices** to fill it.

**The solver** (bottom of the cost panel): set build-wide targets — *Total ele res ≥*
and *Total life ≥* — and **Solve cheapest combo**. It scores every priced listing's
resistances and life, then finds the cheapest one-listing-per-slot combination that
meets the targets, letting slots trade off against each other (overshooting res on a
cheap ring so the expensive helm doesn't need any). ✔ COMBO = targets met; ⚠ BEST TRY
means they're unreachable with what's priced — check more pages or slots. One click
pins the whole combination to the basket.

## 6. Buying

**⚡ Instant buyout listings** (fee shown, e.g. `⚡ instant · fee 4,368 gold`):
- **⌂ Go to hideout** opens the search on the trade site — use its *Travel to Hideout*
  button there (travel needs your logged-in session; the gold fee applies; the seller
  can be offline)

**💬 In-person listings:**
- **⚡ Whisper in game** — pastes and sends the buy whisper directly in the PoE client
- **⌂ Hideout** — sends `/hideout <seller>` — works **after** the seller parties you
- **Copy whisper** — for pasting manually

## 5b. Tabs, gems, and pasted items

- **Tabs** above the cards — All / Gear / Jewels & Clusters / Flasks / Gems — with counts;
  abyssal-socket jewels live under Jewels
- **Gems tab** — every skill gem in the build (active skill set, deduped with ×N counts).
  Each row has editable min level/quality, a search link, and a price; **Price all gems**
  totals the whole setup ("Gems ≈ 3.2 div")
- **Paste an in-game item** — Ctrl+C any item in the client, paste into the build box:
  it becomes a purple-edged card at the top with all its mods matched, ready to
  price-check, sell-price, or compare against your character. The loaded build stays put

## 5c. In-game price check (hotkey)

Price an item without leaving the game:

1. Keep PoB Trade Finder running and play in **Windowed** or **Windowed Fullscreen** mode
   (an overlay can't draw over exclusive fullscreen)
2. Hover an item in Path of Exile and press **Ctrl+D**
3. A small always-on-top **Price check** window opens on the side of the screen away
   from your cursor, shows the item's card and prices it straight away. The listings
   work like the main window's: sort, page, whisper, pin, live search
4. **Esc** or **✕** hides it and puts you back in the game

Details:

- The hotkey is only claimed while the Path of Exile window is focused, so Ctrl+D keeps
  working normally in your browser and every other program
- The app copies the item with Ctrl+C for you, then restores whatever text was on your
  clipboard before
- League, trade type and other filters come from the main window
- Pressing the hotkey again on the same item within a minute reopens the existing results
  instead of searching again, to save rate limit. Price checks from the overlay share the
  main window's rate limiter
- Change the key in **⚙ Settings → Price-check hotkey**: Ctrl+D, Ctrl+Shift+D, Alt+D or Off.
  If another tool (for example Awakened PoE Trade) already uses that key, the settings
  panel says so. Pick another key, or turn one of the tools off
- PoE 1 items only. Currency stacks, maps and other non-gear items open a card but may
  not produce a useful search

## 5d. ⏳ Timeless jewels

Finds the timeless jewel seed that does the most for the notables around one of
your sockets, then prices it. All six are supported: Glorious Vanity, Lethal Pride,
Brutal Restraint, Militant Faith, Elegant Hubris and Heroic Tragedy.

**It starts from your build.** If your build link has a timeless jewel socketed, the
tab opens on that jewel, its socket (marked ★ and listed first), its **conqueror** and
its seed. A line at the top shows what your current seed does to each notable, e.g.
*Mystic Bulwark → Add Flask Charges*. Builds whose author filled in Path of Building's
own *Find Timeless Jewel* search are imported too: their outcome weights are ticked for
you ("✔ Imported … from this build's Path of Building timeless search").

1. **Jewel**, **Conqueror** and **Socket**. The conqueror only changes the keystone
   (listed next to each one, e.g. *Balbala — The Traitor*); the seed decides the
   notables. The summary shows the notables, small passives and keystones in radius,
   and what small passives always get.
2. The outcome table lists **every possible outcome across all seeds**, not what your
   current jewel does, with how often each comes up. Nothing is ticked unless it was
   imported. Type in the **search box** (fuzzy: "flask", "crit multi", "minon dmg"), tick
   what you want, or press **✨ Suggest for my build** to tick what your tree and main
   skill scale. **Clear** unticks everything.
   - **Need ×** sets a hard minimum: *Minion Damage ×2* plus *Aura Effect ×1* keeps only
     seeds that give at least two of your notables Minion Damage **and** at least one
     Aura Effect.
   - Drag a value slider **left of zero to avoid** an outcome, for example a replacement
     that would wipe a notable you rely on.
3. **Find best seeds** checks every seed and ranks them by the total value of what they
   do to your notables. Each result leads with totals such as *Minion Damage ×3 (60%)*;
   open *per notable* to see exactly what each notable becomes.
4. **Price** a seed, or **Price the top seeds**. With a conqueror chosen it searches that
   conqueror only (20 seeds per search, 30 with a saved POESESSID); with *any* it
   searches all four (5 seeds, or 10 with a POESESSID).

**Glorious Vanity** works a little differently. A notable either becomes a specific
Vaal notable, shown with its rolls (e.g. *Ritual of Flesh [8/27]*), or becomes **Might /
Legacy of the Vaal**, a bundle of stacked additions with their rolls (e.g. *Might of the
Vaal: Fire Damage 11, Spell Damage 10*). You can tick and require (Need ×) individual
additions, and result totals add up the rolls. Its small passives also change, but only
notables are counted here. The first use downloads its ~22 MB table.

Tick **Also count unallocated notables** to see seeds that would make pathing to an
untaken notable worthwhile.

The outcome data comes from Path of Building's timeless jewel tables. The first use of
each jewel downloads them (about 2 MB; Glorious Vanity ~22 MB) from PoB's repository
and checks them against a stored checksum. Checked against PoB itself: Brutal Restraint
2582 gives Mystic Bulwark *10% increased Flask Charges gained*, exactly as PoB shows.

Already know your seeds? Expand **Price seeds you already have** at the bottom of the
tab and paste them. A timeless jewel's card in the build also has **⏳ Find seeds for
this socket**, which opens this finder on that jewel's socket.

## 5e. 💎 Jewel finder (rare and abyss jewels)

Reads your passive tree and main skill to work out what your build scales: for
example spells, cold, area, crit, staff, and life vs energy shield. It then ranks every
mod that can roll on rare jewels by how much your build wants it.

- **Jewel** picks the base: any of Crimson / Viridian / Cobalt, or a single one, or an
  abyss Eye jewel type.
- Each mod has **Use** and **Must** checkboxes and a **value** slider. The best matches
  are pre-ticked.
- **At least N of these** finds jewels with any N of your ticked mods at your minimum
  roll. This is the default, and it works without logging in.
- **Best for my build** scores every jewel by your values (a max roll is worth its
  value % × 100) and sorts by that score. The trade site only allows these weighted
  searches when logged in, so in-app checks need a saved POESESSID; the trade-site
  link works while you're logged in there.

## 6b. Compare with your character

Enter your account name (**Name#1234**) in the bar above the cards, load your characters,
pick one, and **Compare gear** (public profiles, no login). Every card gains a strip:

> **You:** My Old Dome — 2/4 target mods · missing: +58 to maximum Life · +35% to Cold Resistance

Cards get a coloured edge — green (matched, rolls included), gold (close), red (missing) —
and **Hide matched slots** collapses what you already own so you only shop the gaps.
Works with the per-slot gear-set dropdowns, so you can compare against any mix.

**⬆ Upgrades only** (on each rare card's strip) raises every ticked mod's minimum to
what you're wearing. Searches, price checks and live alerts then only show items at
least as good as yours on every stat you care about, and the card re-checks prices
straight away.

**💰 Value my gear** prices everything the character wears, one search per item:
- **Uniques** search by name. The cheapest copy is a floor, because roll quality matters.
- **Rares** search for similar items: same base, any N−1 of their mods at 85% or more of
  your rolls.

Each result links to its listings, and the total is an estimate. Rares are hard to price
automatically, so treat it as a guide.

## 6c. Budget, deals, basket

- **Max price** (per card, chaos-equivalent) filters searches, price checks, *and* live
  alerts — no more 50-div listings while shopping on 2 div
- Listings priced well under the going rate get a **🔥 deal** badge (verify before you
  buy — sometimes it's a snipe, sometimes it's a scam listing)
- **☆ Pin** any listing into the **shopping basket** — a persistent panel with every
  pending purchase, running total, and one-click whispers
- **✔ Bought** marks a slot as purchased: the card dims and drops out of the build cost total

### ⚒ Craft vs buy (rare gear cards)

Estimates what it would cost to roll the ticked explicit mods yourself, then compares that
with the cheapest listing from **Check price**.

- It simulates hundreds of thousands of rerolls using the game's mod weights, tiers, mod
  groups and the 3 prefix / 3 suffix limit. The methods it compares are **chaos spam**,
  **essence spam** (Screaming and up; each essence that forces one of your mods) and
  **fossil spam**. When an affix is still free, a **bench craft** can supply one missing mod.
- **Fossils**: it tries every fossil that changes the odds on your base, then pairs and
  triples of the most promising ones, and shows the best **1-, 2- and 3-fossil** combo for
  the money. Cost per try is the chaotic resonator (Primitive / Potent / Powerful) plus the
  fossils. A fossil's "more" tag is ×10 (Prismatic ×6), "fewer" ×0.15 and "no" blocks the
  mod — that's why Pristine helps a life roll on armour, and also why it can never give you
  an armour or energy shield % mod. When two fossils boost the same mod the boosts are
  **added** (two ×10 fossils = ×20), the convention CraftOfExile and poeDB use; some
  crafters believe they multiply, so treat stacked-fossil odds as approximate. A combo
  whose fossil has no price yet is still simulated but ranked after priced ones.
- **Base ilvl** controls which tiers can roll (86 by default). **Base price** adds the cost
  of the blank base; **Price base** looks it up with one trade search.
- The table shows the odds per try, the cost per try, the **average** total, and an
  **unlucky** total: what you'd have spent by the time 90% of crafters would have finished.
  ★ marks the cheapest route. The headline says whether buying or crafting wins, and by
  how much.
- It honours the card's minimum rolls and **Match** mode, so "all but one" means any
  N−1 of your mods count as a success.
- Prices come from GGG's hourly currency exchange.
- **It's an estimate.** Not modelled: fossils that don't just reweight mods (Glyphic,
  Tangled, Sanctified, Hollow, Fractured, Bloodstained, Gilded), Opulent's "no tagless
  modifiers", 4-fossil Prime resonators, harvest, alt-regal, recombinators, metamods and
  fractured bases — so a skilled crafter can often beat the number shown. Mods that
  can't roll on the base (for example influence mods on a non-influenced base) are listed
  and left out.

## 7. Live search

**🔴 Go live** on any card watches that search (~30s polls). New listings **play a
ding** and appear at the top with a red flash and timestamp. Maximum 2 live searches at
once. The query is frozen at go-live, so changing filters mid-watch can't corrupt it.
Press ⏹ to stop.

**Price alerts:** set the card's **Max price**, then **Go live**. Any new listing under that
price dings, and if the app is in the background you also get a **Windows notification**
naming the item and price (turn this off in ⚙ settings).

**📋 Copy** on the build cost summary and the shopping basket copies them as plain text.
The basket copy includes each seller's whisper and trade link, ready for Discord or a
friend.

### 7b. Instant alerts (POESESSID)

Paste your **POESESSID** cookie into the field in the character bar and Save — live
searches then use the trade site's real **WebSocket**: new listings alert **the moment
they're listed** (🟢 INSTANT), not on a 30-second poll. To find the cookie: on
pathofexile.com while logged in, press F12 → Application → Cookies → `POESESSID`.
It's stored only on this machine (`data/session.json`), sent only to pathofexile.com,
and you can clear it by saving an empty field. If the session expires, live searches
say so and fall back to polling.

## 7c. Settings & accessibility (⚙, top right)

- **Theme** — Dark, Light, or Match Windows; **Accent** — gold, crimson, teal, violet or green. Every combination is checked for readable contrast. (Older colour schemes carry over: Blood → Dark + crimson, etc.)
- **Text size** (90–125%) and **density** (comfortable/compact)
- **Sound alerts** on/off and **volume** for the live-search ding
- **Reduce motion** — disables flashes and animations
- **High contrast** — brighter text and borders
- **Colourblind-friendly sockets** — socket colours get letter labels (R/G/B/W/A)
- **Price-check hotkey** — the in-game price-check key (§5c): Ctrl+D, Ctrl+Shift+D, Alt+D or Off

All preferences persist across launches and updates.

## 8. Rate limits

The app reads GGG's quota headers and paces itself — sustained use should never trip a
limit. If GGG does impose a cooldown, every button shows the remaining time
(*"GGG rate-limit cooldown — 3m 20s remaining"*) and background watchers pause and
resume automatically. The app never retries into a penalty (that's what extends bans).

## 9. League start / data refresh

Press **Refresh trade data** (desktop) after a new league launches — it re-downloads the
league list and stat database and reloads. From source:
`node tools/make-data-js.js --fetch`, plus `python tools/make_ranges.py --fetch` and
`python tools/make_baseicons.py --fetch` when patches add new mods/bases.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "no trade-stat match" on a real mod | The matcher handles plurals, sign flips, and known aliases — if one slips through, open an issue with the exact mod text |
| Unique shows base art | First lookup per unique takes a few seconds (rate-limited), then it's cached forever. `data/debug.log` records failures |
| Link paste fails | Only pobb.in / pastebin / poe.ninja links are fetched (by design) — paste the raw code instead |
| Browser version missing features | Live prices/whisper/etc. need the desktop app; also hard-refresh (Ctrl+F5) after updates |
| Ctrl+D does nothing in game | Check ⚙ Settings → Price-check hotkey for a "taken by another program" warning. The game must be the focused window and in windowed / windowed-fullscreen mode. The item must be under the cursor |
| Everything says "cooldown" | GGG rate limit — wait it out; the countdown is shown. Don't hammer the trade website meanwhile (same IP budget) |

PoE 1 only for now. Not affiliated with Grinding Gear Games.
