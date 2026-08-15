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

- **Same base type** — exact base filter (on by default for weapons)
- **Match** — *all mods* / *all but one* (default — upgrades usually miss one mod) / *all but two*
- **Require influence** — on by default when the build item is influenced (the mod pool needs it)
- **Flexible resistances (any split)** — on cards with 2+ resistance mods: match the
  *combined* total instead of each roll separately (a 75% total split 20/55 matches a
  build asking 35/40). Site links work while logged in there; in-app checks need a
  saved POESESSID (weight searches use the logged-in query budget)
- **Min item level / Base %ile ≥ / Sockets ≥ / Links ≥** — caps are slot-aware
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

## 6b. Compare with your character

Enter your account name (**Name#1234**) in the bar above the cards, load your characters,
pick one, and **Compare gear** (public profiles, no login). Every card gains a strip:

> **You:** My Old Dome — 2/4 target mods · missing: +58 to maximum Life · +35% to Cold Resistance

Cards get a coloured edge — green (matched, rolls included), gold (close), red (missing) —
and **Hide matched slots** collapses what you already own so you only shop the gaps.
Works with the per-slot gear-set dropdowns, so you can compare against any mix.

## 6c. Budget, deals, basket

- **Max price** (per card, chaos-equivalent) filters searches, price checks, *and* live
  alerts — no more 50-div listings while shopping on 2 div
- Listings priced well under the going rate get a **🔥 deal** badge (verify before you
  buy — sometimes it's a snipe, sometimes it's a scam listing)
- **☆ Pin** any listing into the **shopping basket** — a persistent panel with every
  pending purchase, running total, and one-click whispers
- **✔ Bought** marks a slot as purchased: the card dims and drops out of the build cost total

## 7. Live search

**🔴 Go live** on any card watches that search (~30s polls). New listings **play a
ding** and appear at the top with a red flash and timestamp. Maximum 2 live searches at
once. The query is frozen at go-live, so changing filters mid-watch can't corrupt it.
Press ⏹ to stop.

### 7b. Instant alerts (POESESSID)

Paste your **POESESSID** cookie into the field in the character bar and Save — live
searches then use the trade site's real **WebSocket**: new listings alert **the moment
they're listed** (🟢 INSTANT), not on a 30-second poll. To find the cookie: on
pathofexile.com while logged in, press F12 → Application → Cookies → `POESESSID`.
It's stored only on this machine (`data/session.json`), sent only to pathofexile.com,
and you can clear it by saving an empty field. If the session expires, live searches
say so and fall back to polling.

## 7c. Settings & accessibility (⚙, top right)

- **Theme** — six colour schemes: Classic (PoE gold), Obsidian, Midnight, Blood, Forest, Light
- **Text size** (90–125%) and **density** (comfortable/compact)
- **Sound alerts** on/off and **volume** for the live-search ding
- **Reduce motion** — disables flashes and animations
- **High contrast** — brighter text and borders
- **Colourblind-friendly sockets** — socket colours get letter labels (R/G/B/W/A)

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
| Everything says "cooldown" | GGG rate limit — wait it out; the countdown is shown. Don't hammer the trade website meanwhile (same IP budget) |

PoE 1 only for now. Not affiliated with Grinding Gear Games.
