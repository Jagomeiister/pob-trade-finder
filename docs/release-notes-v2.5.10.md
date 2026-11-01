## v2.5.10: one copy at a time, cleaner updates

- **Only one PoB Trade Finder runs at a time.** Starting it again brings the running app
  forward, even from the tray, instead of opening a second copy. Two copies fought over the
  update, the hotkeys, the tray icon and the overlays.
- **Updates close the app properly**, the same way tray → Quit does. No tray icon is left
  behind that made the app look like it was still running.
- **The update waits until the old copy has really exited** before swapping the files
  (it used to wait a fixed 3 seconds, which could leave the update half done), and the new
  copy waits for the old one instead of seeing it as "already running".

Note: this update itself still runs the old update steps. If an update ever seems stuck,
tray icon → Quit on any extra copies and start the app again.
