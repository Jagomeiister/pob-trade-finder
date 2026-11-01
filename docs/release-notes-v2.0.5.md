## v2.0.5: weighted upgrade search, value per chaos, playing by GGG's rules

**Weighted upgrade search**
- New **Match → weighted total (any mix)** under More filters: every ticked mod is worth
  100 points at your item's roll, and a listing needs the **Target** share of the total
  (90% by default; 110% = an upgrade). More of one stat can make up for less of another,
  like Path of Building's own trade search. In-app checks of these heavier searches may
  need a saved POESESSID; the trade-site link works while you're logged in there.

**Value per chaos**
- Each listing shows **"% of your item"** (how it compares on the stats you searched) and
  the **price per %**. **Best value first** re-sorts the page so the most stats per chaos
  come first.

**Playing by GGG's rules**
- Saved-build tracking no longer searches on its own. When a build's prices are a day
  old you get a reminder with **Re-price now**; nothing is searched without your click.
- **Check all prices** (and Price changed slots, gem pricing, Value my gear) go one search
  at a time with a short gap, and the same button now **stops** them. A rate-limit
  cooldown ends the batch.
- The app identifies itself to GGG's servers with its name, version and a contact link.
- The Market's feed checks follow GGG's documented polling rules.
- Clearer notices: "This product isn't affiliated with or endorsed by Grinding Gear Games
  in any way." (footer, README, new Settings → About), and a note on what the optional
  POESESSID does. Your POESESSID is now only ever sent to the trade site itself.

**Coming: official login and Stash value**
- GGG's official Path of Exile login and a **Stash value** page (every tab valued at the
  exchange prices, charted over time) are built in but switched off: GGG isn't accepting
  new apps for its official login yet. They turn on in an update once it approves this one.
