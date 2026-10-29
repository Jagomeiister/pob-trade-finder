"""Unit tests for price_hotkey — run: python test/test_price_hotkey.py

Pure helpers everywhere; on Windows also the watcher thread's register /
unregister / WM_HOTKEY dispatch, using a fake "is the game focused" probe and
an obscure hotkey (Ctrl+Alt+Shift+F24) so no real keystroke is ever captured.
Never touches the clipboard or sends keys."""
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import price_hotkey as ph  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (("  (%s)" % detail) if detail and not cond else ""))


def raises(fn, *a):
    try:
        fn(*a)
    except ValueError:
        return True
    return False


# -- parse_hotkey / hotkey_label -------------------------------------------------
check("ctrl+d", ph.parse_hotkey("ctrl+d") == (ph.MOD_CONTROL, 0x44))
check("Ctrl + Shift + D (case/spaces)", ph.parse_hotkey("Ctrl + Shift + D") == (ph.MOD_CONTROL | ph.MOD_SHIFT, 0x44))
check("alt+d", ph.parse_hotkey("alt+d") == (ph.MOD_ALT, 0x44))
check("off -> None", ph.parse_hotkey("off") is None and ph.parse_hotkey("") is None and ph.parse_hotkey(None) is None)
check("bare F-key allowed", ph.parse_hotkey("f2") == (0, 0x71))
check("ctrl+alt+shift+f24", ph.parse_hotkey("ctrl+alt+shift+f24") == (ph.MOD_CONTROL | ph.MOD_ALT | ph.MOD_SHIFT, 0x87))
check("bare letter rejected", raises(ph.parse_hotkey, "d"))
check("unknown modifier rejected", raises(ph.parse_hotkey, "hyper+d"))
check("unknown key rejected", raises(ph.parse_hotkey, "ctrl+enter"))
check("f25 rejected", raises(ph.parse_hotkey, "ctrl+f25"))
check("label ctrl+shift+d", ph.hotkey_label("ctrl+shift+d") == "Ctrl+Shift+D")
check("label alt+d", ph.hotkey_label("alt+d") == "Alt+D")
check("label off", ph.hotkey_label("off") == "Off")

# -- looks_like_item --------------------------------------------------------------
RARE = ("Item Class: Rings\r\nRarity: Rare\r\nGale Coil\r\nRuby Ring\r\n--------\r\n"
        "Requirements:\r\nLevel: 44\r\n--------\r\nItem Level: 84\r\n--------\r\n"
        "+29% to Fire Resistance (implicit)\r\n--------\r\n+68 to maximum Life\r\n")
OLD = "Rarity: Unique\nStarkonja's Head\nSilken Hood\n--------\nEvasion Rating: 300\n"
check("rare item (CRLF)", ph.looks_like_item(RARE))
check("old 'Rarity:' header", ph.looks_like_item(OLD))
check("leading whitespace ok", ph.looks_like_item("\n  " + RARE))
check("plain text rejected", not ph.looks_like_item("hello world"))
check("None rejected", not ph.looks_like_item(None))
check("header without separators rejected", not ph.looks_like_item("Item Class: Rings\nRarity: Rare\nfoo"))
check("header not first rejected", not ph.looks_like_item("chat: Item Class: x\n--------\n"))
check("PoB export code rejected", not ph.looks_like_item("eNrtfWtz2zgS6Ofkr0B5q-" * 20))
check("oversized rejected", not ph.looks_like_item("Item Class: X\n--------\n" + "x" * 30000))

# -- overlay_position -------------------------------------------------------------
GAME = (0, 0, 1920, 1080)
check("cursor left -> overlay right", ph.overlay_position(300, GAME, (560, 700)) == (1920 - 560 - 16, 16))
check("cursor right -> overlay left", ph.overlay_position(1500, GAME, (560, 700)) == (16, 16))
check("short game window clamps y", ph.overlay_position(1500, (100, 100, 900, 600), (560, 700))[1] == 100)
check("narrow game window clamps x", ph.overlay_position(10, (0, 0, 500, 900), (560, 700))[0] == 0)
check("offset monitor", ph.overlay_position(-1000, (-1920, 0, 0, 1080), (560, 700)) == (-560 - 16, 16))

# -- watcher thread (Windows only) -------------------------------------------------
if sys.platform == "win32":
    focused = {"on": False}
    fired = []
    done = threading.Event()

    def on_fire(hwnd):
        fired.append(hwnd)
        done.set()

    w = ph.HotkeyWatcher(on_fire, "ctrl+alt+shift+f24", poll=0.05,
                         is_target=lambda: 4242 if focused["on"] else None)
    w.start()
    time.sleep(0.2)
    check("not registered while game unfocused", not w.status()["active"])
    focused["on"] = True
    time.sleep(0.25)
    check("registered while game focused", w.status()["active"], w.status())
    u = ph._win()[0]
    u.PostThreadMessageW(w._tid, ph.WM_HOTKEY, ph.HotkeyWatcher.HOTKEY_ID, 0)
    check("WM_HOTKEY dispatches callback with game hwnd", done.wait(2) and fired == [4242], fired)
    w.set_spec("off")
    time.sleep(0.25)
    check("'off' unregisters", not w.status()["active"])
    w.set_spec("ctrl+alt+shift+f24")
    time.sleep(0.25)
    check("re-enabled registers again", w.status()["active"])
    focused["on"] = False
    time.sleep(0.25)
    check("focus lost unregisters", not w.status()["active"])
    w.stop()
    check("stop joins the thread", not w.status()["running"])
    check("bad spec raises", raises(w.set_spec, "q"))

print("\n%s" % ("ALL PASS" if not failures else "%d FAILURE(S)" % failures))
sys.exit(1 if failures else 0)
