## v2.3.0: trade helper, in-game overlays, Watcher's Eye & co., search text, div cards

**In game** (play in Windowed or Windowed Fullscreen; true fullscreen hides overlays)
- **PoB icon over the game**: a green dot means it's running, plus a count of open trades.
  Click it for your trade cards. Drag it anywhere; it sticks to the game window.
- **Hotkeys** (Settings → In game): **Ctrl+D** prices an item, **Shift+Space** brings the
  whole app over the game, **Alt+T** shows or hides the trade cards.
- The app over the game resizes from its edges or with − / +. Drag its banner to move it.
  Esc, the hotkey or a click in the game puts it away.
- **Tray icon**: closing the window keeps the app running. Right-click the tray icon to quit.

**🤝 Trade helper** (Tools → Trade helper; switch it on in Setup)
- A card for every trade whisper. **Invite · Busy · Sold · Still interested?**, then
  **Trade · Kick · Thanks** once the buyer is in your hideout. Record the outcome with
  ✓ Completed, ✗ Not completed, ⌛ Time wasted or no-show.
- **Each button sends exactly one chat command** when you press it. Nothing is ever sent on
  its own.
- **▣ Show in stash** outlines the item's cell.
- **Your own buttons** (a label and a message) and a stacked or side-by-side card layout.
- **Sales**: chaos and divine prices, totals, a chart, best sellers, edit and CSV export.
  **Buyers**: reputation, notes, flag, hide, and ignore in game once.
- Sounds with a volume slider, overlay opacity and size, and zone notes.
- Everything stays on your PC; the app only reads the game's chat log.

**New tools**
- **👁 Watcher's Eye & co.**:
  - Watcher's Eye with your build's auras pre-picked, current mods only and pair pricing.
  - Forbidden Flame & Flesh pairs for your ascendancy.
  - Thread of Hope ring sizes.
- **🔤 Search text** (like poe.re): map mods to avoid or want, item quantity, or your own
  words, with presets. **Paste into game** fills the stash search box in one press.
- **🃏 Div cards**: which areas drop the valuable cards, and where each card drops.
- **Learned filters**: pasted and Ctrl+D items remember the mods you always switch on or off.

**Fixes**
- The app no longer fails to start when unzipped from a browser download (the
  "Python.Runtime" error).
- Every window close and exit is written to `data\debug.log` to help track down problems.
