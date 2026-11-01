# PoB Trade Finder: to-do list

The running list of everything agreed on, so nothing is lost between sessions. Update it when
something is done, added or dropped. Newest decisions at the top of each section.

Status: **v2.1.0 released**. Everything below "Done, waiting for your in-game test" is pushed
to `main` but **not released**. GitHub release v2.2.0 is held until the in-game tests pass.

## 1. Waiting for your in-game test (then release v2.2.0)

Play in **Windowed** or **Windowed Fullscreen**; true fullscreen hides every overlay.

- [ ] PoB icon overlay: no white box around it, before or after dragging (window now clipped
      to its content).
- [ ] Drag the icon and the trade cards to different spots; move the game window, including
      to another screen: both follow and keep their spots.
- [ ] Alt+T hides / shows the trade cards, more than once.
- [ ] Shift+Space:
  - [ ] the app comes up over the game with no title bar, smaller than the game;
  - [ ] it resizes from its edges and with − / +, and moves by dragging the banner;
  - [ ] it stays where you left it next time;
  - [ ] Esc, Shift+Space, **Back to the game**, or a click in the game puts it away and
        the game gets focus.
- [ ] The overlays never take focus from the game (watch for the game losing keyboard
      input when they appear).
- [ ] Trade helper is a page in the app: sidebar → Tools → Trade helper, the $ on the icon,
      the tray menu; ← Back / Esc return.
- [ ] A real trade:
  - [ ] the buyer's whisper makes a card;
  - [ ] Invite → buyer joins → card shows "In your hideout";
  - [ ] Trade, Thanks and Kick each send exactly one command;
  - [ ] ✓ Completed lands in Sales, and Sales → Edit fixes the price.
- [ ] ▣ Show in stash outlines the right cell on a normal and on a quad tab.
- [ ] Your own card buttons (Trade helper → Setup → Your buttons) send their message once.
- [ ] Side-by-side card layout (Setup → Trade cards).
- [ ] Sound picker, volume slider (0 = silent) and ▶ Test.
- [ ] Close the app window: it goes to the tray. Right-click the tray icon → Quit ends it.
- [ ] Search text → **Paste into game** with the stash open fills the search box.
- [ ] The old report "closing the price-check pop-up closed the whole app" doesn't happen.
      If it does, send `data\debug.log`, which now logs every window close.

After these pass: bump the version if needed, write release notes (v2.2 trade helper +
v2.3 tools), build, smoke test, `gh release create`.

## 2. Done, pushed, unreleased (for the release notes)

- v2.2 trade helper:
  - Client.txt reader, trade cards (incoming and outgoing), one command per click.
  - Outcomes, Sales (chaos + divine, totals, chart, CSV, Edit) and Buyers (reputation,
    flag, hide, ignore once).
  - Zone notes.
- In-game overlays:
  - Separate PoB icon and trade-card windows, dragged and locked separately, following the
    game window across screens.
  - Cards grow upwards in the lower half; stacked or side by side.
  - Opacity and size settings; "only when there are trades".
- Hotkeys: Ctrl+D price check; Shift+Space app over the game (resizable, remembered, click
  outside to close); Alt+T show / hide the trade cards.
- Tray icon (close to tray; Open / Trade helper / Settings / Quit).
- Sounds: 5 styles + volume slider + test.
- Custom card buttons.
- v2.3:
  - Watcher's Eye & co.: Watcher's Eye current mod pool, pair pricing; Forbidden Flame /
    Flesh pairs; Thread of Hope.
  - Search text builder: map mods avoid / want, quantity, own words, presets, Paste into game.
  - Learned filters; Div cards (by area / by card, drop data via the server's static
    divcards.json).
- Fixes:
  - Startup removes the "downloaded from the internet" mark (Python.Runtime.dll crash).
  - Close / exit logging.
  - Zod override on the server (Dependabot).

## 3. To do (agreed, not started)

- [ ] **Socket recolour calculator** (chromatic / Vorici). The formula is verified from
      Siveran's calculator:
  - one requirement: on-colour = 0.9·(10+r)/(r+20), off-colour = 0.05 + 0.9·5/(r+20);
  - two requirements: 0.9·r/total, the other colour 0.1;
  - three requirements: proportional.

  Blocked on one decision: which bench colour crafts are live. Allflame has white sockets
  and "2/3/4 non-white" crafts; Standard has the per-colour crafts. Ask which league
  matters, or support both with a toggle.
- [ ] **Overlay for the price-check pop-up (Ctrl+D)**: it's still a normal window. Consider
      the same borderless, clipped style as the other overlays.
- [ ] **Release v2.2.0** (section 1 first), then release the v2.3 tools as v2.3.0 or fold
      them into the same release.
- [ ] Tell users about Windowed / Windowed Fullscreen in the release notes, since overlays
      don't show in true fullscreen.

## 4. Parked / decided against (and why)

- **Travel to the seller's hideout using POESESSID** (instant buyout): needs an
  unpublished pathofexile.com endpoint called with your session cookie to move your
  account. GGG hasn't sanctioned it, and the site's code is behind Cloudflare. Instant
  buyout still opens the trade site's own button; in-person trades use ⚡ Whisper / Visit
  hideout in game. Revisit only if you explicitly accept the account risk.
- **Dust (disenchant) explorer**: no reachable source has per-unique dust values. The
  wiki only gives the rules (+2% per 1% quality, +50% per corruption implicit or
  influence); poedb doesn't list them.
- **True expected value per map for div cards**: drop rates aren't public. The Div cards
  tool ranks areas by the cards that *can* drop there and says so.
- **Server reading the wiki**: poewiki.net refuses Vercel (HTTP 403). Drop data is made on
  a PC (`tools/make_divcards.py`) and served as a static file.
- **GGG OAuth / official login**: built but off. GGG isn't accepting new applications
  (re-checked 2026-11-01).
- Earlier user decisions: no stash-aware shopping or server-side whispers; no shared
  reputation lists; no automatic /ignore, thank or kick; the server never proxies trade
  searches.

## 5. Rules this project keeps (GGG + safety)

- One button / hotkey press = one game action. Nothing is sent on a timer or from a log
  event. Invite and Trade are separate buttons (no cycling).
- Log reading only after the user switches the trade helper on. Everything stays local.
- Never navigate the in-app browser to pathofexile.com (it crashed Claude Code); use curl.
- Never run tests that take focus or press keys on the user's desktop without asking
  first (it hit the user's game twice). Headless tests by default.
- Commits end with the Claude co-author line; releases only with the user's go-ahead.
