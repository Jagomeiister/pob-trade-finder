# Launch Playbook

Everything needed to take PoB Trade Finder public. The posts below are ready to paste —
fill in the screenshot links and go.

## 1. Screenshots to take first (3, from your real build)

1. **The money shot** — a gear card with price-check results open: item art, socket
   colours, tier badges, roll percentiles, ≈chaos prices, deal badge if you have one
2. **Character comparison** — the char bar loaded with "You: … 2/4 target mods ·
   missing: …" strips visible on two or three cards
3. **Build cost summary + gems tab** — the total panel, and the gems tab with icons

Drop them in an imgur album or the repo (`assets/`), link them in the posts.

## 2. Reddit — r/pathofexile (the launch that matters)

Check the subreddit's current tool-post rules before posting (some periods require the
weekly tool thread). Flair: **Tool**.

**Title options (pick one):**
- I built a tool that turns any PoB build into one-click trade searches — with live prices, character comparison, and instant listing alerts
- PoB Trade Finder — paste a build code, shop every slot without touching the trade site's filter UI

**Body (paste, add links):**

> Like everyone, I copy builds in PoB and then spend an evening hand-typing mods into
> the trade site. So I built **PoB Trade Finder** — a free, open-source Windows app:
>
> Paste a PoB code (or pobb.in link) and every gear slot, jewel, cluster, flask, and
> **gem** becomes a pre-filled trade search — the exact mods the build creator used,
> with min-rolls set relative to their rolls and clamped to what mods can actually roll.
>
> The parts I actually use every day:
>
> * **Live price checks in-app** — listings with item art, socket colours, mod tiers
>   (P2/S2), roll percentiles, base percentile, quality/catalysts — click any mod to
>   sort all results by it
> * **Import your character** (public profile, no login) — every slot shows *matched /
>   close / missing* vs the build, so you only shop your gaps
> * **Whole-build cost summary** in chaos/divine, per-slot max-price caps, a shopping
>   basket, and bought-tracking that counts your remaining cost down
> * **Live search with sound** — and with your POESESSID it uses the trade site's real
>   WebSocket for instant alerts
> * **In-game buying**: one-click whisper into your PoE chat, /hideout travel, instant
>   buyout supported (fee shown)
> * Ctrl+C any item in game and paste it in to price it
>
> Boring-but-important: it's **MIT open source**, reads GGG's public trade API with
> quota-aware rate limiting (it parses the rate-limit headers and paces itself — no
> louder than using the website), one action per click for anything in-game, no account
> required (POESESSID is optional, stored only on your machine), and it self-updates
> from GitHub releases.
>
> Download: [github.com/Jagomeiister/pob-trade-finder/releases](https://github.com/Jagomeiister/pob-trade-finder/releases)
> Source: [github.com/Jagomeiister/pob-trade-finder](https://github.com/Jagomeiister/pob-trade-finder)
>
> PoE1 only right now — PoE2 support is on the list. Feedback and bug reports very welcome.

## 3. Official forums

Post the same body (BBCode the links) in **Beyond → Community Tools**
(pathofexile.com/forum/view-forum/tools). A forum thread is what most tool lists link to
and what GGG staff occasionally bless with a sticky.

## 4. Tool directories (submit once the thread exists)

- poe-vault.com/guides/path-of-exile-tools — contact form
- poetools.net — submission link in footer
- Awakened PoE Trade's "related tools" wiki + r/pathofexile wiki tools page (modmail)

## 5. First-week checklist

- [ ] Watch GitHub issues — first-day bug reports decide the tool's reputation; the
      auto-updater means fixes reach everyone in hours
- [ ] Answer every comment in the first 24h (sort by new)
- [ ] Pin a "known issues / roadmap" issue on the repo
- [ ] Best timing: 1–2 weeks before a league launch (peak build-planning traffic),
      or the weekend after launch (peak gearing traffic)

## FAQ ammunition (questions you'll get)

- **"Is this against ToS?"** It uses the public trade API and website links; in-game it
  performs exactly one action per user click (same policy Awakened PoE Trade follows).
  It parses GGG's rate-limit headers and throttles itself below the limits.
- **"Why does it want my POESESSID?"** It doesn't — that's optional, only for instant
  WebSocket alerts (the same live search the website has). Stored locally, sent only to
  pathofexile.com. The code is open — check `gui.py`.
- **"Virus warning on the exe?"** Unsigned PyInstaller exes sometimes trip SmartScreen.
  The build script is in the repo — anyone can build from source or run `python gui.py`.
