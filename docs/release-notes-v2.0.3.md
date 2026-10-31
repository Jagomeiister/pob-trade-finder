## v2.0.3: list-price suggestion, build cost history, diagnostics

**Selling: "List at ~X"**
- Items you price with **Ctrl+D** in game, or paste into the main window, now show a
  suggested list price above the listings. It matches the cheapest *real* competitor:
  listings under 60% of the typical price are bait or price fixers and are ignored.
- **Open full search ↗** opens the same search on the trade site.
- No extra trade-site calls: it reads the listings already fetched.

**Build cost over time**
- Every pricing session is remembered per build. The Upgrade planner shows the change
  since your last check with a chart, and the sidebar build card shows the cost and the
  change (▼ green when it got cheaper, ▲ red when it got dearer).
- Sessions are compared on the same slots, so pricing more slots never looks like a
  price change.
- Reloading a saved build shows what it cost when you last priced it.

**Reporting a problem**
- **⚙ Settings → Copy diagnostics** copies the app version, Windows version, data dates,
  recent errors and log lines for a bug report. Your POESESSID, other tokens and your
  Windows user name are removed.
- `data/debug.log` now records failed trade-site requests and is capped at 256 KB.
