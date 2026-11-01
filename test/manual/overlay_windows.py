"""MANUAL test — real windows on your desktop: it opens the app, a fake "Path of Exile" window,
takes focus and presses Alt+T. Only run it when you're not using the PC (never while playing).

    python test/manual/overlay_windows.py            (asks before starting)

Real windows: gui.main() from source + a fake "Path of Exile" window. Checks: icon + cards
overlays follow the game's focus and never take it; cards appear on a trade, near the bottom,
growing upwards; Alt+T (real key press) toggles them; the app hotkey brings the main window
over the game and back; closing the main window keeps the app in the tray; tray Quit exits."""
import ctypes
import json
import os
import subprocess
import sys
import threading
import time

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(here))
sys.path.insert(0, repo)
os.chdir(repo)
import gui  # noqa: E402
import price_hotkey  # noqa: E402

u = ctypes.windll.user32
log, box, fails = [], {}, []
orig = gui.Api._attach_windows


def attach(self, m, o):
    box["api"] = self
    return orig(self, m, o)


gui.Api._attach_windows = attach


def check(name, cond, detail=""):
    log.append(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -- %s" % (detail,)))
    if not cond:
        fails.append(name)


def focus(h):
    k = ctypes.windll.kernel32
    fg = u.GetForegroundWindow()
    a, b = u.GetWindowThreadProcessId(fg, None), k.GetCurrentThreadId()
    u.AttachThreadInput(b, a, True)
    u.BringWindowToTop(h)
    u.SetForegroundWindow(h)
    u.AttachThreadInput(b, a, False)


def fgt():
    return price_hotkey.window_title(u.GetForegroundWindow())


def vis(name):
    h = u.FindWindowW(None, gui.OVERLAYS[name]["title"])
    return bool(h and u.IsWindowVisible(h)), price_hotkey.window_rect(h)


def shot(name, rect):
    x, y, w, h = rect
    p = os.path.join(here, name)
    ps = ("Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap %d,%d; "
          "$g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(%d,%d,0,0,$b.Size); $b.Save('%s')" % (w, h, x, y, p))
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False)


def safe_to_run():
    """Refuse if the real game is running; ask before taking over the desktop."""
    if u.FindWindowW(None, "Path of Exile"):
        print("Path of Exile is running: this test would type into it. Close the game first.")
        return False
    return input("This takes focus and presses keys for ~30 s. Type yes to go on: ").strip().lower() == "yes"


def keys_ok(game):
    """Synthetic keys only ever go to the fake game window."""
    return u.GetForegroundWindow() == game


def driver():
    game = subprocess.Popen([sys.executable, os.path.join(here, "fake_poe.py"), os.devnull])
    try:
        time.sleep(9)
        api = box["api"]
        api._storage["pobtf-trade-prefs"] = json.dumps({"enabled": False, "icon": True})
        for k in ("pobtf-ov-icon-pos", "pobtf-ov-cards-pos"):
            api._storage.pop(k, None)
        g = u.FindWindowW(None, "Path of Exile")
        focus(g)
        time.sleep(1.5)
        gr = gui.trade_helper.game_client_rect(g)
        iv, ir = vis("icon")
        cv, _ = vis("cards")
        check("game focused: icon shown on the game, cards hidden, game keeps focus",
              iv and not cv and fgt() == "Path of Exile" and gr[0] <= ir[0] <= gr[0] + gr[2], (iv, cv, fgt(), ir, gr))
        ev = {"type": "whisper", "dir": "in", "guild": None, "name": "BuyerOne", "time": "", "text": "hi",
              "trade": {"kind": "item", "item": "Doom Loop Two-Stone Ring", "price": 2, "currency": "divine",
                        "league": "Standard", "tab": "~price 2 div", "left": 5, "top": 3, "note": "", "count": None}}
        api._on_trade_event(ev)
        time.sleep(1.8)
        cv, cr = vis("cards")
        check("trade arrived: cards shown in the lower part of the game (above the XP bar)",
              cv and cr and cr[3] <= gr[1] + gr[3] and cr[3] > gr[1] + gr[3] * 0.6 and fgt() == "Path of Exile",
              (cv, cr, gr, fgt()))
        if cr:
            shot("ov2_cards.png", (cr[0] - 10, cr[1] - 10, cr[2] - cr[0] + 20, cr[3] - cr[1] + 20))
        if ir:
            shot("ov2_icon.png", (ir[0] - 10, ir[1] - 6, ir[2] - ir[0] + 20, ir[3] - ir[1] + 12))
        # Alt+T, pressed for real while the (fake) game is focused
        if not keys_ok(g):
            raise RuntimeError("the fake game isn't in front: not sending keys")
        for vk, up in ((0x12, 0), (0x54, 0), (0x54, 2), (0x12, 2)):
            u.keybd_event(vk, 0, up, 0)
            time.sleep(0.03)
        time.sleep(1.5)
        check("Alt+T hides the trade cards", not vis("cards")[0], vis("cards"))
        if not keys_ok(g):
            raise RuntimeError("the fake game isn't in front: not sending keys")
        for vk, up in ((0x12, 0), (0x54, 0), (0x54, 2), (0x12, 2)):
            u.keybd_event(vk, 0, up, 0)
            time.sleep(0.03)
        time.sleep(1.5)
        check("Alt+T again shows them", vis("cards")[0], vis("cards"))
        # app hotkey: main window over the game, then back
        api._on_app_hotkey(g)
        time.sleep(1.5)
        main = u.FindWindowW(None, gui.MAIN_TITLE)
        ex = u.GetWindowLongW(main, -20)
        check("app hotkey: main window over the game, topmost, focused",
              u.IsWindowVisible(main) and ex & 0x8 and fgt() == gui.MAIN_TITLE, (fgt(), hex(ex)))
        check("overlays stay up while the app is over the game", vis("icon")[0], vis("icon"))
        api.app_overlay(False)
        time.sleep(1.5)
        ex = u.GetWindowLongW(main, -20)
        check("back to the game: not topmost, game focused", not ex & 0x8 and fgt() == "Path of Exile", (fgt(), hex(ex)))
        # close to tray, then quit from the tray
        check("tray icon running", bool(api._tray and api._tray.running), api._tray)
        u.PostMessageW(main, 0x0010, 0, 0)  # WM_CLOSE = the window's ✕
        time.sleep(1.5)
        check("✕ on the main window: hidden to the tray, app still running",
              not u.IsWindowVisible(main) and u.IsWindow(main) and api._tray.running and not api._quitting,
              (u.IsWindowVisible(main), u.IsWindow(main)))
        api._show_main()
        time.sleep(1.0)
        check("tray Open brings it back", bool(u.IsWindowVisible(main)), u.IsWindowVisible(main))
        box["quit_at"] = time.time()
        api._quit()
        time.sleep(4)
        log.append("FAIL tray Quit did not end the app")
        fails.append("quit")
    except Exception as e:
        log.append("FAIL driver error %r" % e)
        fails.append("driver")
    finally:
        game.kill()
        print("\n".join(log))  # reaching here means the app didn't quit from the tray
        os._exit(1)


if not safe_to_run():
    sys.exit(2)
threading.Thread(target=driver, daemon=True).start()
gui.main()
ok = "quit_at" in box and time.time() - box["quit_at"] < 4
log.append(("PASS " if ok else "FAIL ") + "tray Quit ends the app (webview.start returned)")
print("\n".join(log))
os._exit(0 if ok and not fails else 1)
