# PoB Trade Finder — User Guide

Turn any Path of Building build into ready-made trade searches: paste the build code,
tick the mods you care about, and buy the gear — with live prices, roll quality, and
in-game whisper/hideout actions, all without touching the trade website's filter UI.

---

## 1. Install & first run

1. Download the latest zip from [Releases](https://github.com/Jagomeiister/pob-trade-finder/releases)
2. Extract anywhere, run **`PoB Trade Finder.exe`**
3. The app checks for updates on launch. When a new version exists, a green banner says which
   one and what's new, with **What's new**, **Later** and **Update now** (one click, fully
   automatic; the app restarts itself)

> **Browser fallback:** opening `index.html` in a browser gives the same search-building
> UI, but the desktop-only features (live price checks, link fetching, in-game chat,
> data refresh, auto-update) need the exe.

## 2. Loading a build

The start screen has one big paste box.

- **Paste a PoB export code** (PoB → Import/Export Build → Generate → Copy) — it loads
  as soon as you paste (or press **Load build** / Ctrl+Enter)
- **Or paste a link** — pobb.in, pastebin, and poe.ninja/pob links are fetched for you
- **Saved builds** appear as cards under the paste box: click one to load it, 🗑 to
  delete it (it asks first). Save the current build with **☆ Save** in the sidebar
- **📈 Re-pricing a saved build** (on a saved build card): **Re-price now** re-runs your
  last search for each slot you priced, slowly, and the card shows the total and the
  change. Tick *Remind me when its prices are a day old* for a daily reminder (in the app,
  plus a Windows notification when it's in the background) with a **Re-price now**
  button. Optionally set *Alert at or under* a price: when a re-price comes in at or
  under it, you get a message. Nothing is searched on a timer, only when you click. Price
  the build once first (**Check all prices**) so it knows what to search for
- **Loading a newer version of a build** (same class, most items the same): a **Changed
  since the version you loaded…** list appears above the gear. For each changed slot it
  shows what changed (the item, or the mod lines added and removed), what it cost when you
  last priced the old version, and, after **Price changed slots**, what it costs now and
  the difference. Changed slots are marked in the slot list, and the unchanged slots keep
  their cost history
- **Gear sets:** guide builds usually contain several (Leveling / Budget / Endgame…) —
  pick which one to shop for with the **Gear set** dropdown in the sidebar; it defaults to
  whatever the build creator had active
- **Switch build** (sidebar) goes back to the start screen; **← Back to current build**
  returns without loading anything
- Your league, filters, and last build are remembered between launches

## 3. Finding your way around

Once a build loads, the window has three parts:

- **Sidebar (left)** — the build (name, gear set, ☆ Save, Switch build, ⚖ Compare with
  character…), then the pages: **Items** — Gear, Jewels & clusters, Flasks, Gems — and
  **Tools** — Upgrade planner, Timeless jewels, Jewel finder, Market. Numbers show how
  many slots each page has (and how many items are in your basket). At the bottom: the
  **Divine Orb** price tile and **⚙ Settings**. In a window narrower than about 1180px the
  sidebar shrinks to icons; **☰** opens the build card
- **Top bar** — the page name, small chips showing the search settings in use (league,
  trade type, min roll), **Search settings ▾**, **Open all searches ↗** and
  **Check all prices**
- **The page** — on Gear, Jewels and Flasks: a **slot list** on the left (each slot's art,
  name, and its price once checked, or a status such as *Bought*, *None listed*,
  *Equipped*, *Missing*) and the selected item on the right. Click a slot, or use ↑/↓.
  On very wide windows (ultrawide), item pages use the extra room and a priced item shows
  its listings beside its mods instead of below them

**Search settings ▾** (top bar) holds the settings every search shares:

| Setting | What it does |
|---|---|
| **League** | Which league to search. **Refresh trade data** (⚙ Settings) updates the list at league start |
| **Trade** | ⚡ *Instant buyout + in person* (default) / ⚡ *instant only* / 💬 *in person* / any — see §6 |
| **Sale** | Buyout/fixed price (default) / any / price with note / unpriced |
| **Listed within** | Any time (default) / 1 day … 1 month: skip old listings, which are often abandoned or price-fixed |
| **Priced in** | Any currency (default) / Chaos or divine / Chaos only / Divine only. Max price stays in chaos; for Divine only it's converted at the current rate |
| **Show prices in** | chaos or divine for the ≈ equivalents and totals |
| **Min roll** | Sets every mod's minimum to this % of the build's roll (default 80%) |
| **Pseudo totals** | Folds life/resist/attribute rolls into pseudo stats so hybrid-rolled items still match — finds strictly more items, recommended on |

**Open all searches** opens every slot's search in browser tabs; **Check all prices**
live-prices every slot one at a time, with a short gap between searches. Click it again
(**■ Stop**) to stop after the current one. It also stops by itself if GGG's rate-limit
cooldown starts. *Price changed slots*, *Price all gems* and *Value my gear* work the
same way.

**Market** (sidebar, or click the Divine Orb tile) covers every item traded on GGG's
currency exchange in your league, around 480 of them: currency, fossils, essences, oils,
scarabs, catalysts, divination cards and more.

- **Biggest movers**: the largest risers and fallers over 24 hours or 7 days. Thin markets
  (under 5,000c traded in a typical hour) are left out, because their price jumps on
  single trades.
- **Chart**: click any item to chart it, with price and date axes, and 1-day, 7-day
  (6-hourly) and 30-day (daily) views. Hover, or arrow-key through the points, for the
  exact price, time and traded volume. Below it: the change, low, high and typical
  volume.
- **Watchlist**: ☆ any item to keep it at the top right. Your list is remembered.
- **Price alerts**: press **🔔 Alert** above the chart and set any of *rises above*,
  *falls below* (in chaos or divines) or *moves more than X% in 24 hours*. Prices are
  checked each hour while the app is open. Each alert fires once when the price crosses
  the level and re-arms when it crosses back. You get an in-app message with a **View**
  button, plus a Windows notification when the app is in the background. Items with an
  alert are added to your watchlist and show 🔔 there.
- **Converter**: what any amount of any item is worth in chaos and divines.
- **Chaos ↔ divine price gaps**: items that traded against both chaos and divines last
  hour at noticeably different prices (the divine side converted at that hour's divine
  rate), with which way round was cheaper and how much traded. Only markets with at least
  the chosen volume are shown (2,000c an hour by default); hover a price for the hour's
  range. These are last hour's averages, not a promise: check the live exchange before
  trading, since gaps close, cheap items bought with divines trade in batches, and every
  trade costs gold.
- **Table**: every item, busiest first, with price (and divines when it's worth more than
  one), 24h and 7-day change, 7-day range, volume and a trend line. Search by name (fuzzy:
  "prismatic", "div", "scarab"), filter by category or your watchlist, hide thin markets,
  and click a column heading to sort.

Data is GGG's official hourly currency-exchange feed, so it doesn't use any trade-site
rate limit. The first visit downloads about 1 MB per sampled hour (about 28 for the
7-day view); after that, everything is cached on your PC. The same prices give chaos
equivalents for listings priced in any of these items.

## 4. The item card

The selected item shows its art, slot, name, base, item level and influences. The
buttons on the right:

- **Check price** (desktop) — listings right in the app (§5)
- **🔴 Go live** (desktop) — watch the search for new listings (§7)
- **Search on trade ↗** — open the search on pathofexile.com
- **⋯** — Copy search URL, ⚒ Craft vs buy (rares), ⏳ Find seeds for this socket (timeless
  jewels), ✔ Mark bought

The mods table has one row per mod:

- **Use** checkbox (or click the row) — include this mod in the search. Bench crafts start
  unticked (you'll re-craft them); everything else starts on
- **Min** — pre-filled from the build's actual roll × the min-roll %. Inputs are
  **clamped to what the mod can genuinely roll** (lowest tier min → highest tier max),
  so impossible searches can't happen. Pseudo totals are never clamped
- **Trade stat** — the trade-site stat the mod matched (under the mod text in a narrow
  window)
- **⇅** (shows when you hover a row) — sort results by this mod: once = highest roll
  first, again = lowest, again = off
- Colours follow the trade site: explicit/implicit blue, **crafted/enchant light blue**,
  **fractured dirty-gold**, implicits above a separator line. Crafted and fractured mods
  also carry a *crafted* / *fractured* label

**More filters** (fold-out under the mods) holds the per-item options. Its heading counts
how many you've changed from the defaults, e.g. *More filters · 2 changed*:

- **Search by** — how strictly to match the base: *this base* (default for weapons),
  *any base with the same defences* (e.g. any pure-ES helmet), *any weapon of that class*
  (e.g. any wand), or *any base* for the slot. Broader searches usually find cheaper items
- **Match** — *all mods* / *all but one* (default — upgrades usually miss one mod) / *all but two* /
  **weighted total (any mix)**: every ticked mod is worth 100 points at your item's roll,
  and a listing needs the **Target** share of the total (90% by default; 110% = an
  upgrade). More of one stat makes up for less of another, e.g. +20 life can cover a
  weaker resistance. Mods without a number (and "lower is better" ones) stay required.
  This is how Path of Building's own trade search weighs stats, without its DPS engine.
  In-app checks of weighted searches need a saved POESESSID (bigger query budget); the
  trade-site link works while you're logged in there
- **Require influence** — on by default when the build item is influenced (the mod pool needs it)
- **Flexible resistances (any split)** — on cards with 2+ resistance mods: match the
  *combined* total instead of each roll separately (a 75% total split 20/55 matches a
  build asking 35/40). Site links work while logged in there; in-app checks need a
  saved POESESSID (weight searches use the logged-in query budget)
- **Min ilvl** — type a minimum item level (the greyed number is the build item's ilvl)
- **Base %ile ≥ / Sockets ≥ / Links ≥** — caps are slot-aware
  (helm/gloves/boots max 4, shields 3, body 6); links default to the build item's 5/6-link
- **Require fractured mod(s)** — the fractured mod must actually be fractured (crafting-base shopping)
- **Min roll** — per-card override of the global percentage
- **Max price** — see §6c

**🕘 History** appears under the mods after your first price check: the last 8 searches
for that slot in this build (time, league, listing count, cheapest price); pick one to
reopen it on the trade site. Re-run the same search later and a **Cheapest** trend line
appears beside it (e.g. 20c → 12c over 3 checks) so you can see whether waiting is
paying off.

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
- **Seller and age**: a dot shows whether the seller is online (●), away (◐) or offline (○), next to
  how long ago the item was listed. Your own listings get a **You** badge (from the account in
  *Compare with character*), and the same seller listing the same thing at the same price shows
  once with **×N**
- **Re-checking the same search within 5 minutes** reuses its results without a trade-site
  call; the panel says how old they are, with **↻ Refresh** to search again
- **"% of your item"** under each price: how the listing compares with your build item
  on the stats you searched (each worth 100% at your item's roll), then **price per %**.
  **Best value first** (above the listings) re-sorts the page so the most stats per chaos
  come first

While a results panel is open, the app **re-checks it every 60s** and greys out anything
**sold / delisted** until you press Check price again.

Prices also appear next to each slot in the slot list ("2 of 9 priced").

### Upgrade planner

The **Upgrade planner** page (sidebar) collects the shopping side:

- **Build cost** — a table of the cheapest listing per priced slot, with a total in chaos
  and divines. Click a column heading to sort; click an item name to jump to its slot.
  Run **Check all prices** to fill it
- **Cost over time** — every pricing session is remembered per build (checks under an
  hour apart count as one session). Below the total: the change since your last check,
  plus a chart, always comparing the *same* slots, so pricing more slots never looks
  like a price change. The sidebar build card shows the cost and change too, and when
  you reload a saved build it shows what the build cost when you last priced it
- **Shopping basket** — everything you've pinned (§6c)
- **Value my gear** results (§6b)

**The solver** (under the build cost table): set build-wide targets — *Total ele res ≥*
and *Total life ≥* — and **Solve cheapest combo**. It scores every priced listing's
resistances and life, then finds the cheapest one-listing-per-slot combination that
meets the targets, letting slots trade off against each other (overshooting res on a
cheap ring so the expensive helm doesn't need any). ✔ COMBO = targets met; ⚠ BEST TRY
means they're unreachable with what's priced — check more pages or slots. One click
pins the whole combination to the basket.

## 6. Buying

Each listing shows its price (with *b/o* / *fixed* / *negotiable*), the seller, and one
main button for the way that listing is bought. Everything else is under **⋯**.

**⚡ Instant buyout listings** (fee shown, e.g. `⚡ instant · fee 4,368 gold`):
- **⌂ Go to hideout ↗** opens the search on the trade site — use its *Travel to Hideout*
  button there (travel needs your logged-in session; the gold fee applies; the seller
  can be offline)

**💬 In-person listings:**
- **⚡ Whisper** (desktop) — pastes and sends the buy whisper directly in the PoE client.
  In the browser version the main button is **Copy whisper** instead
- **⋯ → ⌂ /hideout <seller>** — works **after** the seller parties you
- **⋯ → Copy whisper** — for pasting manually
- **⋯ → ☆ Pin to basket** — see §6c

## 5b. Gems and pasted items

- Abyssal-socket jewels live under **Jewels & clusters**
- **Gems** — every skill gem in the build (active skill set, deduped with ×N counts),
  laid out like the gear pages: **link groups** on the left (gear piece, gem count, and
  their total once priced; your main skill's group is marked ★ and opens first), the
  selected group's gems on the right. Each gem has editable min level/quality, the
  cheapest price, **↗** to open its search, and **▾** for full listings, poe.ninja, live search and
  pinning. **Price this group** / **Price all gems** fill in the prices and totals
  ("Gems ≈ 3.2 div"); **Open searches ↗** opens a group's (or every) gem search.
  Gems unticked in PoB (swap-in options kept in a group, often more than the item can
  socket) are listed under the setup as *unticked*, with their own ↗ and ▾ but left out
  of the group's prices, totals and the character compare. The group shows "3 gems +
  2 unticked"
- **Paste an in-game item** — Ctrl+C any item in the client and paste it into the build
  box (Switch build → paste): it opens on a **Pasted item** page with all its mods
  matched, ready to price-check, sell-price, or compare against your character. The
  loaded build stays put

## 5c. In-game price check (hotkey)

Price an item without leaving the game:

1. Keep PoB Trade Finder running and play in **Windowed** or **Windowed Fullscreen** mode
   (an overlay can't draw over exclusive fullscreen)
2. Hover an item in Path of Exile and press **Ctrl+D**
3. A small always-on-top **Price check** overlay opens on the side of the screen away
   from your cursor, shows the item's card and prices it straight away. It has no title
   bar: drag its banner (⠿ Price check) to move it, and resize it from its edges. The next
   press places it beside the item again. The listings work like the main window's: sort,
   page, whisper, pin, live search
4. Selling it? The **List at ~X** line above the listings suggests a price. It matches
   the cheapest *real* competitor: listings under 60% of the typical price on the first
   page are bait or price fixers and are ignored. **Open full search ↗** opens the same
   search on the trade site. The suggestion also shows for items you paste (Ctrl+C) into
   the main window
5. **Is it an upgrade?** The card compares the item with your build's item for that slot (both
   rings for a ring) and, if you imported your character, with what you wear: **Upgrade /
   Sidegrade / Downgrade** with a %, and the stat differences (e.g. *+18 maximum Life · −20% Cold
   Resistance · missing Cast Speed*). Each of that item's stats counts 100% at its roll; it's a
   stat comparison, not a DPS calculation. The overlay uses the build you loaded last
6. **Quick price**: currency, fragments, scarabs, essences and cards are priced instantly from
   GGG's exchange feed (with your stack's value); uniques and gems from poe.ninja through the
   app's own server. It shows before the trade search finishes
   For exchange items, **Live offers** asks the trade site's bulk exchange who sells it right
   now (one request per press): seller, online/away, what they want, chaos each and stock, plus
   **Open on trade site ↗**. **poe.ninja ↗** opens the item's price history there
7. **Sensible filters for one item**: the game's Ctrl+C copy now includes mod tiers, shown as
   **T1, T2…**. Mods worse than tier 2 start unticked (they rarely set the price), crafted mods
   start off, and minimums are 90% of each roll, so you compare like with like. ⋯ also has
   **Open on PoE Wiki / PoEDB**, and **Open on poe.ninja** for uniques, gems, currency and
   divination cards (in the league you picked)
   **Preset** switches in one click: **Similar** (those defaults), **Exact** (every mod at its
   full roll, all must match, this exact base) or **Base** (no mods: the base, item level and
   influence alone). If you already checked the price it checks again
8. **Esc** or **✕** hides it and puts you back in the game

Details:

- The hotkey is only claimed while the Path of Exile window is focused, so Ctrl+D keeps
  working normally in your browser and every other program
- The app copies the item with Ctrl+C for you, then restores whatever text was on your
  clipboard before
- League, trade type and other filters come from the main window
- Pressing the hotkey again on the same item within a minute reopens the existing results
  instead of searching again, to save rate limit. Price checks from the overlay share the
  main window's rate limiter
- Change the key in **⚙ Settings → Hotkeys → Price-check hotkey**: Ctrl+D, Ctrl+Shift+D, Alt+D or Off.
  If another tool (for example Awakened PoE Trade) already uses that key, the settings
  panel says so. Pick another key, or turn one of the tools off
- PoE 1 items only. Currency stacks, maps and other non-gear items open a card but may
  not produce a useful search

## 5c2. 🤝 In game: overlay, hotkeys, trade helper, tray

Like Awakened PoE Trade and PoE Lurker, the app shows small see-through pieces over the game
while Path of Exile is focused. They never take focus from the game, they hide when you switch
to another program, and they stay stuck to the game window, even on another screen. The game
must run in **Windowed** or **Windowed Fullscreen** (true fullscreen hides every overlay).

**The pieces**, each dragged by its ⠿ grip to wherever you want it, on its own (📌 Lock in
Trade helper → Setup pins them):

- **PoB icon**: a green dot means it's running (hover it to see your hotkeys) and a number
  counts open trades. Click it to show or hide the trade cards. With your mouse over it you
  also get ⚙ Settings, ⌂ the app and $ Trade helper
- **Trade cards**: put them where you like, e.g. just above the XP bar. Placed in the lower
  half of the screen, new cards stack upwards. Setup → **Trade cards** switches between stacked
  (vertical) and side by side (horizontal)

**Hotkeys** (⚙ Settings → Hotkeys). Each one works only while the game is in front:

| Default | What it does |
|---|---|
| Ctrl+D | Price the item under your cursor |
| Shift+Space | Brings this whole app over the game as an overlay (no title bar): builds, gear, the Trade helper and settings without alt-tabbing. Resize it from its edges or with − / + on the banner, and drag the banner to move it; it remembers both. Press the key again, Esc, **Back to the game** or click in the game to put it away. Settings → In game can make it see-through or keep it open when you click the game |
| Alt+T | Show or hide the trade cards |
| Alt+C | Show or hide the cheat sheet (see 5i2) |

**Chat macros** (⚙ Settings → Hotkeys → Chat macros): one click on **▶**, or one press of
the macro's hotkey, sends one command to the game chat. It starts with /kingsmarch,
/menagerie, /delve and /exit (log out); change them, give each a hotkey (F2–F6, Alt+1–5,
Ctrl+Shift+1–3) or **+ Add a macro** of your own, up to 12. A macro must be one chat command
starting with /. A hotkey that's already used elsewhere is refused. Like the other hotkeys,
they only work while the game is focused. (For your hideout, use the game's own hideout key.)

**Tray**: closing the window keeps the app running in the tray (bottom right of the taskbar).
Click the icon to open it; right-click it for Open, Trade helper, Settings or **Quit**. You can
turn this off in Settings → In game.

### Trade helper (selling and buying)

**Switch it on** in **Trade helper → Setup**. The app then reads Path of Exile's chat log
(`Client.txt` in the game folder → `logs`) while it runs. If it can't find the file, start the
game or press **Choose Client.txt…**. Everything stays on your PC: sales, buyer notes, flags
and hidden buyers are never uploaded or shared.

**One button = one chat command.** The app never types in the game on its own. Nothing is sent
on a timer or because something appeared in the log. GGG's rules require that, and it's why
**Invite** and **Trade** are separate buttons.

An incoming trade card shows the item, price, league, stash tab and position, and the buyer's
note:

1. **Invite**, **Busy**, **Sold**, **Still interested?**, or ✕ to dismiss. **▣ Show in stash**
   outlines the item's cell over your open stash tab for 20 seconds: amber for a normal tab,
   blue for a quad tab (the whisper doesn't say which, so both show when it could be either)
2. When the buyer enters your area the card shows **In your hideout** and switches to
   **Trade**, **Kick**, **Thanks**
3. Then record what happened: **✓ Completed**, **✗ Not completed**, **⌛ Time wasted** or
   **Other**. If the game logged "Trade accepted", Completed is highlighted for you.
   Completed records the **Sold for** price above it. That starts at the listed price:
   - **−** / **+** change it in steps that suit it (1, 5 or 10 chaos; 0.1, 0.5 or 1 divine);
   - **in div** / **in c** converts it if you were paid in the other currency;
   - **Reset** goes back to the listed price.

   To add a note, **Edit** the row in **Trades**.
   If you invited someone and they didn't come within 5 minutes (change it in Setup),
   **Mark as no-show** appears

The cards are click-only, so your keyboard always stays with the game. ⋯ on a card shows
**Whois**, **Flag**, **Hide buyer** (no more popups or sounds from them; their whispers go to
the **Hidden** list) and **Ignore in game** (click twice: sends `/ignore` once).

Outgoing whispers (you buying) get a card too: **Visit hideout**, **Trade**, **Re-whisper**, and
⋯ for **Whois**, **Flag** and **Ignore in game**. The seller's record with you shows on the card
(e.g. *sold to you 3× · didn't answer 2×*). Record what happened the same way as a sale:
**✓ Bought** (at the **Paid** price above it, with − / + and **in div** / **in c**), **✗ Didn't
happen**, **⌛ No answer** or **Other**. If the game logged "Trade accepted" while you were
buying, Bought is highlighted for you.

**Today** (a line under the trade cards' header, Setup can turn it off): what you earned and
spent today, the net, and how many trades.

The **Trade helper** is a page of the app (sidebar → Tools, ⚙ Settings → In game, the $ on the
icon, or the tray menu), not another window. Over the game it opens with the app overlay.
**← Back** or Esc returns to where you were:

- **Trades**: **Sold**, **Bought** and **Flips**, filtered by league, period, outcome or text.
  - Tiles for **Earned** (sales), **Spent** (purchases), **Net profit** and the number of
    trades, and a chart of money in (up) and out (down) per day.
  - **Currency trades**: a bulk swap of one currency for another (e.g. 300 chaos for 1 div)
    is valued both ways at that hour's rate, and only the difference counts, so swapping at
    the going rate is about ±0.
  - **Flips**: when you buy an item and later sell the same item in the same league, the two
    are paired: what you paid, what you got, the profit and how long you held it. **Bought,
    not sold yet** lists what you're still holding.
  - A sale more than 20% under poe.ninja / the exchange price at the time is tagged
    **under market** (uniques, gems, currency and cards; rares can't be compared).
  - **Edit** a row (price, currency, outcome, note), ✕ deletes one (asks first), **Export
    CSV**, and **+ Add trade** for one done before the app or outside the trade helper.
- **People**: everyone you've traded with, buyers and sellers in one list, with filters for
  **Buyers**, **Sellers**, **⌛ Time wasters**, **⚑ Flagged** and **Blocked**.
  - Each shows what they bought from you and what they sold you, time wasted, no-shows,
    no answers, when you last traded, and your private note.
  - **Time waster**: automatic after 2 time wasted / no-show / no answer (Setup changes the
    number), or set it yourself to yes or no.
  - **Blocked** means popups hidden here, or ignored in game from this app. **Show popups**
    and **Unignore in game…** (sends `/unignore` once) undo them. The game's own ignore list
    can't be read, so only ignores sent from the app are listed.
  - **Same person as…** merges one player's characters: their history adds up and future
    whispers from either character count for that person (whispers don't show account names).
    **Clear history** forgets a person (the trades stay).
- **Reports**: today, 7 / 30 / 90 days, all time or your own dates, for one league or all:
  earned, spent, net, best day, time wasted, sales under market, **items you sold** (how many,
  total, average, low, high, last sold, best buyer), **top buyers** and **top sellers**, and
  the under-market list.
  - **Goal**: e.g. *Mageblood, 40 div*. It counts your net profit (earned − spent) from the
    moment you set it, with a progress bar.
- **Setup**:
  - on/off, the log file and the chat key read from your game settings
  - **Sound**: Off, Chime, Bell, Soft, Ping, Coins or **your own sound** (an mp3, wav, ogg
    or m4a up to 3 MB; one for a new trade and, optionally, one for the buyer arriving), a
    **volume slider** (0 = silent) and **▶ Test**
  - **Overlay**: show the icon always or only when there are trades, size, an **opacity**
    slider (solid while your mouse is over it), whether a new trade opens the cards,
    **📌 Lock position** and **Reset position**
  - the no-show time and your Busy / Sold / Still interested / Thanks messages (`{item}` and
    `{price}` are filled in)
  - **Your buttons**: add your own card buttons (a label and a message, e.g. "1 min" → "one
    minute, finishing a map"). Choose whether each shows before the buyer arrives, once
    they're here, always, or on your own buying cards. Each press whispers the message once
  - **Time waster** after how many bad outcomes, and the **Today** line on or off
  - **Your trade data**: **Export backup** saves sales, purchases, people, merged characters
    and your goal as one file; **Import backup…** adds what you don't have yet from such a
    file (a reinstall or a new PC) and never removes anything

If Path of Exile runs as administrator and the app doesn't, Windows blocks the buttons from
typing; Setup warns you. Run both the same way.

**Test mode** (Setup → Test mode) shows what trades look like over the game without a real
buyer. It makes up a buyer's whisper, a bulk whisper, the buyer arriving, "Trade accepted",
the buyer leaving, your own buying whisper, or entering a zone. **▶ Whole trade** plays a
complete trade over 12 seconds. These cards are marked **TEST**: their buttons send nothing
to the game, and closing them saves nothing to Trades or People. **Clear test cards** removes
them. It works with the trade helper on or off.

## 5d. ⏳ Timeless jewels

Finds the timeless jewel seed that does the most for the notables around one of
your sockets, then prices it. All six are supported: Glorious Vanity, Lethal Pride,
Brutal Restraint, Militant Faith, Elegant Hubris and Heroic Tragedy.

The page runs top to bottom in numbered steps: **1 Jewel and socket**, **2 What you
want**, **3 Best seeds**.

**It starts from your build.** If your build link has a timeless jewel socketed, the
page opens on that jewel, its socket (marked ★ and listed first), its **conqueror** and
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
page and paste them. A timeless jewel's card in the build also has **⋯ → ⏳ Find seeds
for this socket**, which opens this finder on that jewel's socket.

## 5e. 💎 Jewel finder (rare and abyss jewels)

Reads your passive tree and main skill to work out what your build scales: for
example spells, cold, area, crit, staff, and life vs energy shield. It then ranks every
mod that can roll on rare jewels by how much your build wants it. The page runs in
numbered steps: **1 Your build**, **2 Jewel and search type**, **3 Pick mods**,
**4 Find jewels**.

- **Jewel** picks the base: any of Crimson / Viridian / Cobalt, or a single one, or an
  abyss Eye jewel type.
- Each mod has an **Off / Want / Must** switch and a **value** slider. *Want* counts the
  mod toward the search; *Must* means every result has it. The best matches start on
  *Want*.
- **At least N of these** finds jewels with any N of your ticked mods at your minimum
  roll. This is the default, and it works without logging in.
- **Best for my build** scores every jewel by your values (a max roll is worth its
  value % × 100) and sorts by that score. The trade site only allows these weighted
  searches when logged in, so in-app checks need a saved POESESSID; the trade-site
  link works while you're logged in there.

## 5f. 👁 Watcher's Eye & co.

Tools → **Watcher's Eye & co.** Three jewels that the normal item cards can't price well:

- **Watcher's Eye**:
  - Your build's auras are pre-picked; click to add or remove any.
  - Tick the mods worth having, with an optional minimum roll. Only mods that can still roll
    today are listed; old legacy mods are left out.
  - **Match** any 1 / any 2 / any 3 / all of them. **Search on trade ↗** opens it for the
    selected league, and **Check price** shows listings here.
  - **Price each pair** runs one search per pair of ticked mods (up to 7 mods), and **Price
    each triple** one per three together (up to 5 mods). Both are paced for the trade site
    and list the cheapest of each. Click again to stop.
  - **Include legacy mods** adds mods that no longer roll but still exist on old jewels.
- **Forbidden Flame & Flesh**:
  - Pick your ascendancy (your build's is pre-selected) to see the notables a pair can give
    you, marked when you already have them.
  - **Price pair** prices the Flame (Crimson Jewel) and Flesh (Cobalt Jewel) for that notable
    and adds them up. **Price all I don't have** prices every notable you don't have.
- **Thread of Hope**: the five ring sizes, each with a trade link. **Price every size** prices
  all five.

## 5g. 🔤 Search text (stash and vendor search)

Tools → **Search text** builds the text you type into the game's search box (Ctrl+F), like
poe.re:

- **Maps**: mark mods **✗ avoid** or **✓ want**. Each mod is searched by the shortest piece of
  its text that no other map mod (or map name) has, so every roll matches. You can also add
  **Item quantity ≥** a number, and choose whether the wanted mods are *any* or *all*.
- **Flasks**: tick the mods you want (bleeding / freeze / shock / ignite / poison immunity,
  increased effect, reduced charges per use, instant recovery…). Each is searched by a piece of
  the mod's own text, so every tier matches, and each was checked against every flask mod so
  it finds only the one it names.
- **Vendor**: for levelling vendors: the chromatic recipe (R, G and B linked), 3 / 4 / 5 linked
  sockets, movement speed, + level of socketed gems, added spell damage, life.
- **Your own words**: one word or phrase per line, matching any, all or none of them.
- The box counts characters against the game's limit of 50.
- **Copy** the text, or **Paste into game**: one press, with your stash or a vendor open,
  does Ctrl+F and pastes. Nothing is sent and your clipboard is put back.
- **Save preset** keeps a search for next time.

## 5h. Learned filters

When you price a pasted or Ctrl+D item, the app notes which mods you switch on or off
yourself (not presets). After you've switched the same mod the same way twice, that becomes
its default and it shows **learned**. **Settings → In game → Forget learned filters** starts
over.

## 5i. Zone notes

With the trade helper on, entering an area that has a note shows a small card with it, next
to the trade cards. It starts with the Act 1–3 Trials of Ascendancy. Add your own (or edit
or delete them) in **Trade helper → Setup → Zone notes**. This only reads the chat log and
shows text; it never does anything in the game.

## 5i2. 📜 Cheat sheets

Tools → **Cheat sheets** (or ⚙ Settings → In game → Cheat sheets…) has a sheet for each act,
and **Alt+C** shows it over the game. Use ‹ › to change act; drag it by ⠿.

- **Ready-made**, for Acts 1–10: the quests that give a passive skill point or respec points,
  the Trials of Ascendancy (and which Labyrinth they open, with its area level), the bandit
  rewards in Act 2, and the resistance penalty after Acts 5 and 10. The data comes from the
  community Path of Exile Wiki (CC BY-NC-SA), credited on the sheet. Tick what you want shown.
- **Your sheets**: your own notes and pictures (a route, a guide screenshot, a crafting
  recipe) for one act or for every act. Pictures are copied into the app's `data\cheatsheets`
  folder; nothing leaves your PC.
- **Follow my act** (asks first) reads the game's log file to see which act you're in and turns
  the sheet to it. It also marks the trial you're standing in. **Open it when a new act
  starts** pops it up for you.
- **Route**: every zone of the act in order, with its level, waypoint, the quest steps and
  bosses there, and where the trials and skill-point quests are. With **Follow my act** on, the
  zone you're in is highlighted.
- **Gems**: each quest's gem rewards and what you can buy afterwards, for your build's class
  (or pick one), with your build's gems highlighted and listed first.
- **Mechanics**: ☰ on the sheet (or the Mechanics list on the Cheat sheets page) opens one of
  24 sheets: Betrayal, Blight (every amulet and ring anoint), Delve, Incursion, Expedition,
  Sanctum, Kingsmarch, Ultimatum, Eldritch altars, Pantheon, Vaal Orb outcomes, Bestiary,
  Harvest, vendor recipes, essences, Heist, Breach, Legion, Abyss, Delirium, Ritual, the
  Labyrinth, scarabs and Atlas map tiers. They come from the Path of Exile Wiki, checked
  against the current league's changes (rows the wiki hasn't caught up on are left out), and
  update from the app's server between releases. Long sheets get a filter box on the
  Cheat sheets page.
- **Anoint helper** (in the Blight sheet): every amulet, ring and blighted-map anoint with its
  oils and what they cost now (GGG's currency exchange). Search a notable by name or by what it
  does ("critical strike chance"), sort cheapest first, or click oils to see what they make; one
  oil picked lists every recipe that uses it. Click a row to pick its oils. Your build's current
  anoint is listed first and notables already in your tree are marked. Over the game it's
  click-only (no search box), so it never takes your keyboard.
- **Suggestions**: entering a mechanic's area (a Syndicate safehouse, the Azurite Mine, the
  Temple, a Sanctum floor, a map whose boss holds a Pantheon soul, …) shows a small pop-up at
  the top of the game for 20 seconds: **Open** shows that sheet, 🔕 stops suggestions for that
  mechanic, ✕ dismisses it. It never opens anything big on its own. Drag it by ⠿ to put it
  elsewhere. It needs **Follow my act** or the trade helper on (both read the game log), and can
  be turned off on the Cheat sheets page.
- Width, max height, size, opacity, 📌 Lock and Reset position are on the same page.
  **Pretend I entered it** tries an act change, and **Pretend I entered its area** a
  mechanic's suggestion, without playing.

## 5j. 🃏 Div cards

Tools → **Div cards** shows where each divination card drops and what it's worth.

- **By area**: every map (untick **Maps only** for other areas), with how many of its cards
  are worth at least your minimum, its best card (price each and full set), the sum of one
  of each, and **≈ per 1000 drops**: the card value you'd expect per 1,000 items dropped
  there. Areas are sorted by that value.
  - It comes from community drop weights (the Prohibited Library's stacked deck data, via
    maps-of-exile). They're estimates, not GGG numbers.
  - Monster density isn't counted, so use it to compare areas, not as a promise per map.
  - Cards without a known weight are left out; the value is marked **+N?** when an area has
    any.
  - **4 voidstones** (on by default) counts maps at area level 83, so cards that need a high
    level are included.
- Click an area for its card list. Each card shows **One per** (≈ how many item drops for
  one of it) and its share of the area's value.
- Prices of 1 divine or more show in divines, smaller ones in chaos.
- **By card**: the card's picture, price each, set size, full set value, where it drops (or
  "no longer drops") and ↗ to the bulk exchange. Hover a card (its picture or name) to see the
  whole card as in the game: name, picture with the stack size, the reward in its colours
  (unique, currency, gem, corrupted…) and the flavour text.
- Filter by card or area name, and set a minimum value.
- Prices come from GGG's currency exchange (last hour) for the selected league. Drop areas
  and the cards' reward and flavour text come from the community Path of Exile Wiki (CC BY-NC-SA): they ship with the app and update
  through the app's server between releases. They keep working offline.
- The page loads once per session. After a restart it shows your last result straight away
  ("Showing prices from …") and refreshes the prices in the background.

## 5j2. ✨ Dust explorer

Tools → **Dust explorer** finds the uniques worth buying to break down for Thaumaturgic Dust
(your Kingsmarch disenchanter). It works without a build.

- Each row shows:
  - the unique and its base;
  - its **dust**;
  - its **price** (the cheapest plain copy on poe.ninja: not corrupted, not 5/6-linked);
  - **dust per chaos**;
  - the **gold fee** for disenchanting it;
  - its **size** in inventory squares;
  - how often it's **listed**.
- It's sorted by dust per chaos; click any column to sort by it instead.
- Settings: **Item level** (65–84; dust grows from 65 to 84), **Quality** (+2% dust per 1%) and
  **Extra** (+50% per influence type or corruption implicit). A unique that always comes
  influenced, like Starforge, already counts its own influence.
- **Listed at least** hides thin markets, where poe.ninja's price is often off. **Price up to**
  caps the price.
- The **Ctrl+D price check** and a pasted unique show **Dust ≈ …** next to the quick price
  (with dust per chaos), worked out from that item's own item level, quality and influences.
- Dust values come from the MIT-licensed
  [poe-disenchant-tool](https://github.com/deronek/poe-disenchant-tool) dataset (item level 84
  data, credited to a community list and PoEDB). It's pinned in the app; see
  THIRD_PARTY_NOTICES.md.

## 5k. 🌳 Skill tree

Tools → **Skill tree** is a small Path of Building: the build's passive tree, so you can see
where your points go in game and where the jewels sit.

**Icons**: zoom in and every passive shows its real in-game icon (in colour when it's in your
build, grey otherwise); keystones first, then notables, then small passives as you zoom closer.

**Tree stages**: if your PoB build has several trees (e.g. "Level 30", "Level 70",
"Endgame"), a menu at the top left picks which one to show; the one active in PoB is marked
and opens first. A character comparison carries over when you switch, so you can check your
character against the stage you're at.

- **Move and zoom**: drag to move, mouse wheel or **−** / **+** to zoom, **Fit** for the
  whole tree. With the tree focused, the arrow keys move it and **0** fits it.
- The build's nodes and links are in your accent colour; everything else is dimmed.
  Keystones are hexagons, notables have a dark core, masteries and jewel sockets are rings.
  A socket holding a jewel has a dot in the jewel's rarity colour.
- **Hover** a node for its stats. Masteries show the effect the build picked (or the
  choices), sockets show the jewel and its mods.
- The **ascendancy** sits in the box at the bottom left (▾ hides it). If the build also
  takes a bloodline, pick it there.
- **Search** by name or stat ("life", "golem"): matches get a blue ring and the count shows
  next to the box. Enter jumps to the next match, allocated ones first.
- The side panel lists points used (cluster jewel passives included), ascendancy points,
  keystones, notables, jewel sockets with their jewels, and mastery effects. Click any entry
  to centre the tree on it.
- **Compare with my character** (desktop app): pick your account and character under
  **⚖ Compare with character…** first. The app then reads that character's passives (one
  request, public profile) and colours the tree: green = **still to take**, red = **to
  refund**. **Next points to take** lists them in an order you can follow: step 1 nodes
  touch what you already have (they also get a green ring on the tree), step 2 comes after
  those, and so on. Masteries with a different effect from the build are listed too.
  **Build only** switches the colours back. Cluster jewel passives are counted, not
  compared one by one.

## 6b. Compare with your character

Click **⚖ Compare with character…** in the sidebar, enter your account name
(**Name#1234**), load your characters, pick one, and **Compare gear** (public profiles, no
login). **☆ Save** keeps that character (yours or a friend's) at the top of the pop-up: next
time one click compares it, no typing; ✕ forgets it. With a POESESSID saved (§7b) your characters load automatically.

The compare lives in memory, so a restart (an update installs with one) clears it. With
**Compare again when the app starts** ticked (the default, in the same pop-up), the app runs
your last compare once at launch: the same requests as pressing Compare gear, never repeated
on its own. Untick it to compare only when you press the button.

Every card gains a strip:

> **You:** My Old Dome — 2/4 target mods · missing: +58 to maximum Life · +35% to Cold Resistance

The slot list labels each slot **Equipped** (matched, rolls included), **Close** or
**Missing**, and **Hide matched slots** hides what you already own so you only shop the gaps.
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


It checks every place an item can be: a ring counts in either ring slot, and a jewel counts
wherever it sits in your tree (the build's socket doesn't have to match). The same click reads
your tree jewels, and the Skill tree's *Compare with my character* reuses them.

**Gems** compare by setup, not by slot. Each PoB link group finds your best-matching link
group on any worn item, weapon swap included (gems in your bag don't count), and each of your
link groups fills only one PoB group:

> **You:** your Helmet · 4L (PoB has it in Body Armour) — 4/4 linked

- **Matched** means every gem is there, with enough links. Running the Awakened or Vaal
  version of a build gem counts as having it.
- **Close** means some gems are missing, or you have a near version (the plain gem where the
  build has the Awakened one, or a different transfigured version), or the group has fewer
  links than the build uses.
- Every gem in the table gets a tag: **linked** (in the matched link group), **not linked**
  (socketed in the same item but a separate link group), **in your Amulet** (you have it on
  another item), or **missing** (not in anything you wear). The strip sums it up, e.g.
  *2/4 linked · 1 socketed but not linked: Overloaded Intensity*.
- Under the strip, a **socket picture** shows your gear the way the game does: one box per
  item, and in it each link group as a chain of socket dots joined by a gold bar, with the
  gem in each socket. Separate link groups on one item are lettered (**Link A**, **Link B**),
  the gem tags use the same letters (*linked · Boots A*, *not linked · Boots B*), and the
  group matched to this setup is outlined and tagged *this setup*. The setup's gems are
  bright, other gems dimmed, empty sockets say *empty*.
- **Socket colours**, under the picture: since 3.29 any gem works in any socket, and a gem in a
  socket of its own colour gets +10% quality. The box counts how many of the setup's gems sit
  in their colour (e.g. *1 / 4 gems in their colour*). When some don't, it lists:
  - which colours the link group wants;
  - which colours this base rolls (non-white sockets follow its attribute requirements);
  - the crafting bench's *At Least 2/3/4 Non-White Sockets* (5/20/75 Chromatic Orbs, plus
    Vaal Orbs on a corrupted item);
  - what a Chromatic Orb does on this item (Tainted on a corrupted one);
  - the Omen of Trichromatism when the group wants all three colours.

  It gives no odds: GGG hasn't published the 3.29 socket colour chances.
- A link group only counts as the setup when at least two of its gems are linked together
  (one for a single-gem group), so a lone socket with one shared support doesn't.
- Gems below the build's level or quality are listed as *lower* but don't change the status.
- If you run one of PoB's unticked options in place of a ticked gem, the strip names it
  (*running unticked option: Spell Echo Support*) next to the ticked gem it replaced.

## 6c. Budget, deals, basket

- **Max price** (per card, chaos-equivalent) filters searches, price checks, *and* live
  alerts — no more 50-div listings while shopping on 2 div
- Listings priced well under the going rate get a **🔥 deal** badge (verify before you
  buy — sometimes it's a snipe, sometimes it's a scam listing)
- **⋯ → ☆ Pin to basket** on any listing adds it to the **shopping basket** on the Upgrade
  planner page — every pending purchase, running total, and one-click whispers. Clearing
  the basket or removing an item asks first
- **⋯ → ✔ Mark bought** on a card marks the slot as purchased: its mods dim, it shows
  *Bought* in the slot list, and it drops out of the build cost total

### ⚒ Craft vs buy (rare gear cards, under ⋯)

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

Paste your **POESESSID** cookie into **⚙ Settings → Account** and Save — live
searches then use the trade site's real **WebSocket**: new listings alert **the moment
they're listed** (🟢 INSTANT), not on a 30-second poll. To find the cookie: on
pathofexile.com while logged in, press F12 → Application → Cookies → `POESESSID`.
Save it once: it's kept on this machine (`data/session.json`) through restarts and updates,
and sent only to pathofexile.com. Settings → Account says **Saved on this PC** (the box itself
stays empty, it never shows the cookie back), and **Remove** deletes it. pathofexile.com ends a
session when you log out there (or after a while): then Settings says so, live searches fall
back to polling, and you save the new POESESSID from your browser.

## 7c. Settings & accessibility (⚙ Settings, bottom of the sidebar)

Settings opens as a panel on the right; Esc or a click outside closes it. It has tabs: **Look**,
**Alerts**, **Hotkeys**, **In game**, **Account**, **Updates** and **Help**, and it reopens on the
one you used last. **Find a setting** at the top searches every tab at once (a setting's name,
help text or choices), and Esc clears it.

- **Appearance** — **Theme**: Dark, Dim (a softer dark), Slate (blue-grey dark), Light, Parchment (warm, low-glare light), or Match Windows; **Accent**: gold, crimson,
  teal, violet or green. Every combination is checked for readable contrast. (Older colour
  schemes carry over: Blood → Dark + crimson, etc.) **Text size** (90–125%) and
  **density** (comfortable/compact)
- **Accessibility** — **High contrast** (brighter text and borders), **Reduce motion**
  (no flashes or animations), **Colourblind-friendly sockets** (letter labels R/G/B/W/A)
- **Alerts** — live-search **sound** and **volume**, Windows notifications in the background
- **Hotkeys** — the **price-check hotkey** (§5c), the app / trade cards / cheat sheet hotkeys,
  and your **chat macros**
- **In game** — the app over the game (see-through, a click in the game puts it away), close to
  the tray, **Forget learned filters**, and shortcuts to the Trade helper and Cheat sheets
- **Account** — your POESESSID (§7b) and the official login
- **Updates** — **Refresh trade data** and **Check for updates** (when there's a new
  version, an **Update now** button appears right there)
- **Help** — **Copy diagnostics** for a bug report, and About

Everything works from the keyboard: Tab moves between controls, arrows move through the
slot list, menus and Off / Want / Must switches, and Esc closes menus, pop-ups and panels.

All preferences persist across launches and updates.

### 7d. Official Path of Exile login and Stash value (coming)

**⚙ Settings → Account → Official Path of Exile login** signs in through GGG's own login
page in your browser (the app never sees your password). Once signed in, **Stash value**
appears in the sidebar under Tools: **Value my stash** values every tab in the selected
league (currency, fragments, scarabs, essences, divination cards and other exchange items
at the hourly exchange prices; gear, gems and maps are counted, not priced), lists the
most valuable items and charts each run over time.

It's built to GGG's developer rules but **switched off for now**: GGG isn't accepting new
apps for its official login, and it turns on in an update once they approve this one.

## 8. Rate limits

The app reads GGG's quota headers and paces itself — sustained use should never trip a
limit. If GGG does impose a cooldown, every button shows the remaining time
(*"GGG rate-limit cooldown — 3m 20s remaining"*) and background watchers pause and
resume automatically. The app never retries into a penalty (that's what extends bans).

## 9. League start / data refresh

The desktop app checks GGG's league list at launch and every 6 hours. When a new challenge
league goes live, a banner offers **Switch to <league>**. It re-downloads the league list and
stat database, switches every search and price to the new league, and reloads. **Not now**
hides it for that league; you can still switch from the League menu any time.

To refresh by hand, press **⚙ Settings → Updates → Refresh trade data**. From source:
`node tools/make-data-js.js --fetch`, plus `python tools/make_ranges.py --fetch` and
`python tools/make_baseicons.py --fetch` when patches add new mods/bases.

## 10. Troubleshooting

Reporting a bug: **⚙ Settings → Help → Copy diagnostics** copies the app version, Windows
version, data dates, recent errors and the last log lines. Paste that into the GitHub
issue. Your POESESSID, other tokens and your Windows user name are removed.

| Symptom | Fix |
|---|---|
| "no trade-stat match" on a real mod | The matcher handles plurals, sign flips, and known aliases — if one slips through, open an issue with the exact mod text |
| Unique shows base art | First lookup per unique takes a few seconds (rate-limited), then it's cached forever. A lookup that fails for good (unknown name, nothing ever listed) isn't retried for a week, so it doesn't cost trade calls on every launch. `data/debug.log` records failures |
| Link paste fails | Only pobb.in / pastebin / poe.ninja links are fetched (by design) — paste the raw code instead |
| Browser version missing features | Live prices/whisper/etc. need the desktop app; also hard-refresh (Ctrl+F5) after updates |
| Ctrl+D does nothing in game | Check ⚙ Settings → Hotkeys → Price-check hotkey for a "taken by another program" warning. The game must be the focused window and in windowed / windowed-fullscreen mode. The item must be under the cursor |
| Everything says "cooldown" | GGG rate limit — wait it out; the countdown is shown. Don't hammer the trade website meanwhile (same IP budget) |

PoE 1 only for now. Not affiliated with Grinding Gear Games.
