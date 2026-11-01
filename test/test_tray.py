"""Tray icon — run: python test/test_tray.py

Pure helpers (tooltip clipping, menu model, callback-message dispatch for
classic and NOTIFYICON_VERSION_4 layouts, wParam point unpacking, click
debounce), callback threading with exception logging, and on Windows one live
icon: start, tooltip, simulated Explorer restart, stop, and a check that the
shell no longer knows the icon. Nothing is clicked and no menu is opened."""
import ctypes
import os
import sys
import threading
import time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
_threads_before = {t.ident for t in threading.enumerate()}
import tray  # noqa: E402

failures = 0
try:
    sys.stdout.reconfigure(errors="backslashreplace")
except Exception:
    pass


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


check("import: no Win32 bound, no threads started", tray._w is None and
      {t.ident for t in threading.enumerate()} == _threads_before)

# -- clip_text ------------------------------------------------------------------
check("clip: short text unchanged", tray.clip_text("PoB Trade Finder") == "PoB Trade Finder")
check("clip: None -> ''", tray.clip_text(None) == "")
check("clip: non-str coerced", tray.clip_text(12.5) == "12.5")
check("clip: tooltip cut to 127", len(tray.clip_text("x" * 300)) == 127)
check("clip: exact 127 kept", tray.clip_text("y" * 127) == "y" * 127)
check("clip: NULs dropped", tray.clip_text("a\x00b") == "ab")
s = tray.clip_text("a" * 126 + "\U0001F600" + "b")
check("clip: surrogate pair not split", s == "a" * 126, len(s))
s = tray.clip_text("a" * 125 + "\U0001F600" + "b")
check("clip: pair that fits is kept", s == "a" * 125 + "\U0001F600", len(s))
check("clip: custom limits", len(tray.clip_text("z" * 999, tray.INFO_MAX)) == 255
      and len(tray.clip_text("z" * 999, tray.INFO_TITLE_MAX)) == 63)

# -- menu_model -----------------------------------------------------------------
def cb_open():
    pass


def cb_quit():
    pass


calls = []


def dyn_label():
    calls.append(1)
    return "Price hotkey: %s" % ("on" if len(calls) % 2 else "off")


m = tray.menu_model([("Open", cb_open), None, (dyn_label, cb_open), ("Status: idle", None),
                     None, None, ("Quit", cb_quit)])
check("menu: separators collapsed", [it["sep"] for it in m] == [False, True, False, False, True, False],
      [it.get("label") for it in m])
items = [it for it in m if not it["sep"]]
check("menu: ids 1.. in order", [it["id"] for it in items] == [1, 2, 3, 4])
check("menu: labels", [it["label"] for it in items] == ["Open", "Price hotkey: on", "Status: idle", "Quit"])
check("menu: callbacks mapped", items[0]["callback"] is cb_open and items[3]["callback"] is cb_quit)
check("menu: None callback -> disabled", items[2]["enabled"] is False and items[2]["callback"] is None
      and all(it["enabled"] for i, it in enumerate(items) if i != 2))
m2 = tray.menu_model([("Open", cb_open), (dyn_label, cb_open)])
check("menu: callable label re-evaluated each build", m2[1]["label"] == "Price hotkey: off" and len(calls) == 2)


def bad_label():
    raise RuntimeError("boom")


m = tray.menu_model([None, None, (bad_label, cb_open), ("Open", "not callable"), None])
check("menu: leading/trailing separators dropped", not m[0]["sep"] and not m[-1]["sep"], m)
check("menu: raising label -> '' (no exception)", m[0]["label"] == "" and m[0]["enabled"])
check("menu: non-callable callback -> disabled", m[1]["enabled"] is False and m[1]["callback"] is None)
check("menu: empty / None", tray.menu_model(None) == [] and tray.menu_model([None, None]) == [])
check("menu: junk entries skipped", [it["label"] for it in tray.menu_model([("a",), 5, ("Ok", cb_open)])]
      == ["Ok"])
check("menu: label coerced to str", tray.menu_model([(3, cb_open)])[0]["label"] == "3")

# -- tray_event -----------------------------------------------------------------
W = tray.WM_TRAY


def v4(ev, icon_id=1):
    return (icon_id << 16) | ev


check("event: other window message ignored", tray.tray_event(0x0200, tray.WM_LBUTTONUP) is None
      and tray.tray_event(0x0010, v4(tray.WM_CONTEXTMENU)) is None)
check("event v4: left button up -> click", tray.tray_event(W, v4(tray.WM_LBUTTONUP)) == "click")
check("event v4: double click -> click", tray.tray_event(W, v4(tray.WM_LBUTTONDBLCLK)) == "click")
check("event v4: Enter (NIN_KEYSELECT) -> click", tray.tray_event(W, v4(tray.NIN_KEYSELECT)) == "click")
check("event v4: balloon clicked -> click", tray.tray_event(W, v4(tray.NIN_BALLOONUSERCLICK)) == "click")
check("event v4: NIN_SELECT ignored (LBUTTONUP already counted)", tray.tray_event(W, v4(tray.NIN_SELECT)) is None)
check("event v4: WM_CONTEXTMENU -> menu", tray.tray_event(W, v4(tray.WM_CONTEXTMENU)) == "menu")
check("event v4: WM_RBUTTONUP ignored (CONTEXTMENU follows)", tray.tray_event(W, v4(tray.WM_RBUTTONUP)) is None)
check("event v4: mouse move ignored", tray.tray_event(W, v4(0x0200)) is None)
check("event v4: icon id in HIWORD doesn't matter", tray.tray_event(W, v4(tray.WM_CONTEXTMENU, 7)) == "menu")
check("event classic: left button up -> click", tray.tray_event(W, tray.WM_LBUTTONUP, version4=False) == "click")
check("event classic: double click -> click", tray.tray_event(W, tray.WM_LBUTTONDBLCLK, version4=False) == "click")
check("event classic: right button up -> menu", tray.tray_event(W, tray.WM_RBUTTONUP, version4=False) == "menu")
check("event classic: mouse move / button down ignored",
      tray.tray_event(W, 0x0200, version4=False) is None and tray.tray_event(W, 0x0201, version4=False) is None)
check("event classic: v4-packed lparam not mistaken for a click",
      tray.tray_event(W, v4(tray.WM_LBUTTONUP), version4=False) is None)
check("event: custom callback message", tray.tray_event(0x8123, v4(tray.WM_LBUTTONUP), callback_msg=0x8123) == "click")

# -- split_xy / should_fire -----------------------------------------------------
check("xy: positive", tray.split_xy((900 << 16) | 1800) == (1800, 900))
check("xy: negative x (monitor left of primary)", tray.split_xy((40 << 16) | (0x10000 - 1280)) == (-1280, 40))
check("xy: negative y", tray.split_xy(((0x10000 - 5) << 16) | 10) == (10, -5))
check("debounce: first click fires", tray.should_fire(None, 10.0, 0.5))
check("debounce: within interval suppressed", not tray.should_fire(10.0, 10.3, 0.5))
check("debounce: after interval fires", tray.should_fire(10.0, 10.5, 0.5))
check("debounce: clock went backwards fires", tray.should_fire(10.0, 5.0, 0.5))

# -- callback threading (no Win32) ----------------------------------------------
logs = []
seen = {}
done = threading.Event()


def slow_ok():
    seen["thread"] = threading.current_thread()
    seen["daemon"] = threading.current_thread().daemon
    done.set()


def raises():
    try:
        raise ValueError("kaput")
    finally:
        done.set()


t = tray.TrayIcon("x", log=logs.append)
t._fire(slow_ok, "click")
done.wait(2.0)
check("callback: runs on a separate daemon thread", seen.get("thread") not in (None, threading.current_thread())
      and seen.get("daemon") is True, seen)
done.clear()
t._fire(raises, "menu 'Quit'")
done.wait(2.0)
for _ in range(50):
    if logs:
        break
    time.sleep(0.02)
check("callback: exception caught and logged", logs and "kaput" in logs[0] and "menu 'Quit'" in logs[0], logs)
t2 = tray.TrayIcon("x", log=lambda m: (_ for _ in ()).throw(RuntimeError("bad logger")))
t2._log("hello")
check("callback: a raising logger is swallowed", True)
t._fire(None, "click")
check("callback: None callback is a no-op", True)

clicks = []
t3 = tray.TrayIcon("x", on_click=lambda: clicks.append(1))
t3._dbl = 0.5
t3._click()
t3._click()  # same double click
time.sleep(0.3)
check("click: double click collapses to one on_click", len(clicks) == 1, clicks)

t4 = tray.TrayIcon("y" * 500)
check("init: tooltip clipped", len(t4._tip) == 127)
check("not started: running False, set_tooltip/notify False, stop safe",
      t4.running is False and t4.set_tooltip("a") is False and t4.notify("a", "b") is False
      and t4.stop() is None and t4.stop() is None)
check("not started: still nothing bound or spawned by the helpers above",
      tray._w is None and not any(th.name == "tray-icon" for th in threading.enumerate()))

# -- live (Windows only) --------------------------------------------------------
if sys.platform == "win32":
    a = tray._api()
    want = 976 if ctypes.sizeof(ctypes.c_void_p) == 8 else 956
    check("NOTIFYICONDATAW size matches the SDK", ctypes.sizeof(a.NID) == want, ctypes.sizeof(a.NID))

    clicked = []
    icon = os.path.abspath(os.path.join(ROOT, "icon.ico"))
    live_logs = []
    ti = tray.TrayIcon("PoB Trade Finder (test)", icon_path=icon, on_click=lambda: clicked.append(1),
                       menu=[("Open", lambda: None), None, ("Quit", lambda: None)], log=live_logs.append)
    hwnd = None
    try:
        ok = ti.start()
        hwnd = ti._hwnd
        check("live: start() True", ok is True, live_logs)
        check("live: running", ti.running)
        check("live: icon.ico loaded (owned handle)", bool(ti._hicon) and ti._own_icon)
        check("live: own daemon thread", ti._thread is not threading.current_thread() and ti._thread.daemon)
        check("live: second start() is a no-op that reports running", ti.start() is True and ti._hwnd == hwnd)
        check("live: set_tooltip", ti.set_tooltip("PoB Trade Finder — %s" % ("x" * 300)) is True
              and len(ti._tip) == 127)
        # simulated callback message from the shell: a classic/V4 left click
        ti._proc(hwnd, tray.WM_TRAY, 0, (1 << 16) | tray.WM_LBUTTONUP if ti._v4 else tray.WM_LBUTTONUP)
        for _ in range(50):
            if clicked:
                break
            time.sleep(0.02)
        check("live: callback message -> on_click on a worker thread", clicked == [1], ti._v4)
        # simulated Explorer restart: the TaskbarCreated broadcast re-adds the icon
        check("live: TaskbarCreated registered", ti._taskbar_msg >= 0xC000, ti._taskbar_msg)
        a.u.PostMessageW(hwnd, ti._taskbar_msg, 0, 0)
        time.sleep(0.5)
        check("live: still running after TaskbarCreated", ti.running and ti.set_tooltip("after restart") is True)
    finally:
        ti.stop()
    check("live: stop() -> not running", ti.running is False)
    check("live: tray thread ended", not ti._thread.is_alive())
    check("live: window destroyed", hwnd is not None and not a.u.IsWindow(hwnd))
    nid = a.NID()
    nid.cbSize = ctypes.sizeof(a.NID)
    nid.hWnd, nid.uID = hwnd, tray.ICON_ID
    check("live: second NIM_DELETE fails (icon gone)",
          not a.sh.Shell_NotifyIconW(tray.NIM_DELETE, ctypes.byref(nid)))
    ti.stop()
    check("live: stop() twice is safe", ti.running is False)
    check("live: set_tooltip after stop -> False", ti.set_tooltip("x") is False)

    # restart the same instance (fresh window class), then stop from another thread
    ti2_hwnd = None
    try:
        check("live: restart after stop", ti.start() is True and ti.running)
        ti2_hwnd = ti._hwnd
        stopper = threading.Thread(target=ti.stop)
        stopper.start()
        stopper.join(5.0)
        check("live: stop() from another thread", not ti.running and not stopper.is_alive())
    finally:
        ti.stop()
    if ti2_hwnd:
        nid.hWnd = ti2_hwnd
        check("live: restarted icon removed too", not a.sh.Shell_NotifyIconW(tray.NIM_DELETE, ctypes.byref(nid)))
    check("live: no errors logged", not live_logs, live_logs)

    tm = tray.TrayIcon("missing icon", icon_path=os.path.join(ROOT, "no-such-icon.ico"))
    try:
        check("live: missing .ico falls back to the exe/stock icon", tm.start() is True and bool(tm._hicon))
    finally:
        tm.stop()
    check("live: fallback icon removed", tm.running is False)
else:
    print("SKIP live tray test (not Windows)")

print()
print("ALL TESTS PASSED" if not failures else "%d FAILED" % failures)
sys.exit(1 if failures else 0)
