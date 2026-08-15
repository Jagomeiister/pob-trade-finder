# Launch kit

Ready-to-post announcements. Take 3–4 screenshots first (they carry the post):

1. A loaded build — gear cards with item art, mods ticked, per-slot set dropdowns
2. A price-check panel — listings with art, tiers, roll percentiles, 🔥 deal badge, socket colours
3. The character-compare strips (green/gold/red slots + "missing: …")
4. The build cost summary + gems tab

Post timing: league launch week is the highest-traffic window; otherwise weekends.

---

## Reddit — r/pathofexile (flair: Tool)

**Title:**
I built a free tool that turns any PoB code into pre-filled trade searches — live prices, instant listing alerts, and a "what am I missing vs the build" diff

**Body:**

Like most of you I follow build guides, and I got sick of hand-typing every mod
into the trade site for every slot. So I built **PoB Trade Finder** — a free,
open-source Windows app:

**Paste a PoB code (or pobb.in link) and every slot becomes a card:**
- One click opens the official trade site with the mods, min rolls, category,
  influence, sockets/links all pre-filled — or price-check in-app (item art,
  mod tiers, roll percentiles, base %ile, DPS)
- **Compare with your character** (public profile, no login): each slot shows
  matched / close / missing with the exact mods you lack — shop only the gaps
- **Gems too** — the whole skill setup, grouped like PoB, with per-gem searches
  (21/23, awakened, transfigured) and a "price all gems" total
- **Budget tools**: max price per slot, whole-build cost total in chaos/div,
  a solver that finds the cheapest *combination* of listings hitting your
  build-wide res/attribute targets, 🔥 deal flags on underpriced listings
- **Live search** with sound — instant WebSocket alerts if you add your
  POESESSID (same mechanism as the site), polling otherwise
- **Buying**: one-click whisper in game, /hideout travel, instant-buyout aware
  (fee shown), shopping basket with totals, bought-tracking
- Paste any in-game item (Ctrl+C) to price it

Quality-of-life: auto-updates, dark PoE theme, accessibility options
(colourblind socket letters, reduce motion, text scaling), and it respects
GGG's rate limits properly (reads the quota headers, shows cooldowns instead
of hammering).

**Download:** https://github.com/Jagomeiister/pob-trade-finder/releases/latest
**Source (MIT):** https://github.com/Jagomeiister/pob-trade-finder

PoE1 only for now (PoE2 is on the roadmap). Not affiliated with GGG — it uses
the public trade API and never automates anything against the site; every
whisper/purchase is one click by you.

Feedback and bug reports very welcome — the mod matcher is fuzzed against real
listings, but PoE has a long tail of weird mods; if one shows "no trade-stat
match", paste it in an issue.

---

## Official forums — Beyond league tools thread / Tool Development

Same body as Reddit; title:
**PoB Trade Finder — turn any Path of Building code into pre-filled trade searches (free, open source)**

---

## Checklist before posting

- [ ] Screenshots taken on a real, good-looking build (hide POESESSID field state)
- [ ] Latest release installs clean on a machine without Python
- [ ] README screenshots section updated with the same images
- [ ] Watch the thread for the first few hours — fast replies to bug reports
      convert sceptics; ship fixes with `python tools/build_release.py` +
      `gh release create` and installs pick them up automatically
