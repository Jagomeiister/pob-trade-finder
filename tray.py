"""Notification-area (system tray) icon for PoB Trade Finder (Windows, ctypes only).

One TrayIcon owns a hidden window and its own message loop on a daemon
thread. Left click / double click / Enter / clicking the balloon call
on_click(); right click shows a popup menu. Callbacks run on short-lived
worker threads so a slow one never blocks the tray. Nothing here raises into
callers.

The window is a hidden top-level window rather than a message-only one:
message-only windows never see broadcasts, and the "TaskbarCreated" broadcast
is how the icon comes back after Explorer restarts.

Pure helpers (clip_text, menu_model, tray_event, split_xy, should_fire) have
no Win32 dependencies and are unit-tested in test/test_tray.py.
"""
import atexit
import ctypes
import itertools
import os
import sys
import threading
import time

TIP_MAX, INFO_MAX, INFO_TITLE_MAX = 127, 255, 63  # UTF-16 units, excluding the NUL

# -- pure helpers ---------------------------------------------------------------
WM_CONTEXTMENU, WM_LBUTTONUP, WM_LBUTTONDBLCLK, WM_RBUTTONUP = 0x007B, 0x0202, 0x0203, 0x0205
NIN_SELECT, NIN_KEYSELECT, NIN_BALLOONUSERCLICK = 0x0400, 0x0401, 0x0405
WM_TRAY = 0x8001  # WM_APP + 1: the icon's callback message

_CLICK_V4 = (WM_LBUTTONUP, WM_LBUTTONDBLCLK, NIN_KEYSELECT, NIN_BALLOONUSERCLICK)
_CLICK_CLASSIC = (WM_LBUTTONUP, WM_LBUTTONDBLCLK, NIN_BALLOONUSERCLICK)


def clip_text(text, limit=TIP_MAX):
    """str(text) cut to `limit` UTF-16 units without splitting a surrogate pair."""
    s = "" if text is None else str(text)
    s = s.replace("\x00", "")
    out, units = [], 0
    for ch in s:
        n = 2 if ord(ch) > 0xFFFF else 1
        if units + n > limit:
            break
        out.append(ch)
        units += n
    return "".join(out)


def menu_model(menu):
    """[(label, callback) | None, ...] -> list of dicts:
    {"sep": True} or {"id", "label", "callback", "enabled", "sep": False}.
    Labels may be callables (evaluated now); a None callback means a disabled
    item. Ids start at 1 (TrackPopupMenu returns 0 for "nothing picked").
    Leading, trailing and doubled separators are dropped."""
    out, next_id = [], 1
    for entry in menu or ():
        if entry is None:
            if out and not out[-1]["sep"]:
                out.append({"sep": True})
            continue
        try:
            label, cb = entry
        except (TypeError, ValueError):
            continue
        if callable(label):
            try:
                label = label()
            except Exception:
                label = None
        label = "" if label is None else str(label)
        out.append({"sep": False, "id": next_id, "label": label,
                    "callback": cb if callable(cb) else None, "enabled": callable(cb)})
        next_id += 1
    while out and out[-1]["sep"]:
        out.pop()
    return out


def tray_event(msg, lparam, version4=True, callback_msg=WM_TRAY):
    """Map a window message to "click", "menu" or None. With NOTIFYICON_VERSION_4
    the event is LOWORD(lparam) (HIWORD is the icon id); classic icons put the
    mouse message straight in lparam. Version 4 sends both WM_RBUTTONUP and
    WM_CONTEXTMENU for one right click, so only the latter opens the menu."""
    if msg != callback_msg:
        return None
    if version4:
        ev = int(lparam) & 0xFFFF
        if ev in _CLICK_V4:
            return "click"
        return "menu" if ev == WM_CONTEXTMENU else None
    ev = int(lparam) & 0xFFFFFFFF
    if ev in _CLICK_CLASSIC:
        return "click"
    return "menu" if ev == WM_RBUTTONUP else None


def split_xy(wparam):
    """Signed (x, y) screen point packed in a VERSION_4 callback's wParam."""
    v = int(wparam)
    x, y = v & 0xFFFF, (v >> 16) & 0xFFFF
    return (x - 0x10000 if x & 0x8000 else x), (y - 0x10000 if y & 0x8000 else y)


def should_fire(last, now, interval):
    """Click debounce: one double click delivers up to three click events
    (up, dblclk, up); only the first within `interval` seconds counts."""
    return last is None or now - last >= interval or now < last


# -- Win32 plumbing (lazily bound; private WinDLL instances so the argtypes set
#    here never leak into ctypes.windll, which pywebview also uses) ------------
NIM_ADD, NIM_MODIFY, NIM_DELETE, NIM_SETVERSION = 0, 1, 2, 4
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO, NIF_SHOWTIP = 0x01, 0x02, 0x04, 0x10, 0x80
NIIF_INFO, NIIF_RESPECT_QUIET_TIME = 0x01, 0x80
NOTIFYICON_VERSION_4 = 4
IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x10, 0x40
SM_CXSMICON, SM_CYSMICON = 49, 50
IDI_APPLICATION = 32512
MF_STRING, MF_GRAYED, MF_SEPARATOR = 0x0000, 0x0001, 0x0800
TPM_RIGHTBUTTON, TPM_NONOTIFY, TPM_RETURNCMD = 0x0002, 0x0080, 0x0100
WM_NULL, WM_DESTROY, WM_CLOSE = 0x0000, 0x0002, 0x0010
WM_APP_STOP = 0x8002
MSGFLT_ALLOW = 1
ICON_ID = 1
_w = None
_seq = itertools.count(1)


def _api():
    global _w
    if _w is not None:
        return _w
    if sys.platform != "win32":
        raise OSError("tray icon is Windows-only")
    from ctypes import wintypes as wt
    from types import SimpleNamespace
    u = ctypes.WinDLL("user32", use_last_error=True)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    sh = ctypes.WinDLL("shell32", use_last_error=True)
    lres = ctypes.c_ssize_t

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", wt.DWORD), ("Data2", wt.WORD), ("Data3", wt.WORD),
                    ("Data4", wt.BYTE * 8)]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("hWnd", wt.HWND), ("uID", wt.UINT),
                    ("uFlags", wt.UINT), ("uCallbackMessage", wt.UINT), ("hIcon", wt.HICON),
                    ("szTip", wt.WCHAR * 128), ("dwState", wt.DWORD), ("dwStateMask", wt.DWORD),
                    ("szInfo", wt.WCHAR * 256), ("uVersion", wt.UINT),  # union with uTimeout
                    ("szInfoTitle", wt.WCHAR * 64), ("dwInfoFlags", wt.DWORD),
                    ("guidItem", GUID), ("hBalloonIcon", wt.HICON)]

    WNDPROC = ctypes.WINFUNCTYPE(lres, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

    class WNDCLASSEXW(ctypes.Structure):
        _fields_ = [("cbSize", wt.UINT), ("style", wt.UINT), ("lpfnWndProc", WNDPROC),
                    ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON), ("hCursor", wt.HANDLE),
                    ("hbrBackground", wt.HBRUSH), ("lpszMenuName", wt.LPCWSTR),
                    ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON)]

    proto = [
        (u, "RegisterClassExW", [ctypes.POINTER(WNDCLASSEXW)], wt.ATOM),
        (u, "UnregisterClassW", [wt.LPCWSTR, wt.HINSTANCE], wt.BOOL),
        (u, "CreateWindowExW", [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE,
                                wt.LPVOID], wt.HWND),
        (u, "DestroyWindow", [wt.HWND], wt.BOOL),
        (u, "IsWindow", [wt.HWND], wt.BOOL),
        (u, "DefWindowProcW", [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM], lres),
        (u, "GetMessageW", [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT], wt.BOOL),
        (u, "TranslateMessage", [ctypes.POINTER(wt.MSG)], wt.BOOL),
        (u, "DispatchMessageW", [ctypes.POINTER(wt.MSG)], lres),
        (u, "PostMessageW", [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM], wt.BOOL),
        (u, "PostQuitMessage", [ctypes.c_int], None),
        (u, "RegisterWindowMessageW", [wt.LPCWSTR], wt.UINT),
        (u, "ChangeWindowMessageFilterEx", [wt.HWND, wt.UINT, wt.DWORD, ctypes.c_void_p], wt.BOOL),
        (u, "CreatePopupMenu", [], wt.HMENU),
        (u, "AppendMenuW", [wt.HMENU, wt.UINT, ctypes.c_size_t, wt.LPCWSTR], wt.BOOL),
        (u, "SetMenuDefaultItem", [wt.HMENU, wt.UINT, wt.UINT], wt.BOOL),
        (u, "TrackPopupMenu", [wt.HMENU, wt.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                               wt.HWND, ctypes.c_void_p], ctypes.c_int),
        (u, "DestroyMenu", [wt.HMENU], wt.BOOL),
        (u, "EndMenu", [], wt.BOOL),
        (u, "SetForegroundWindow", [wt.HWND], wt.BOOL),
        (u, "GetCursorPos", [ctypes.POINTER(wt.POINT)], wt.BOOL),
        (u, "GetSystemMetrics", [ctypes.c_int], ctypes.c_int),
        (u, "GetDoubleClickTime", [], wt.UINT),
        (u, "LoadImageW", [wt.HINSTANCE, wt.LPCWSTR, wt.UINT, ctypes.c_int, ctypes.c_int, wt.UINT],
         wt.HANDLE),
        (u, "LoadIconW", [wt.HINSTANCE, ctypes.c_void_p], wt.HICON),  # c_void_p: MAKEINTRESOURCE ids
        (u, "DestroyIcon", [wt.HICON], wt.BOOL),
        (k, "GetModuleHandleW", [wt.LPCWSTR], wt.HMODULE),
        (sh, "Shell_NotifyIconW", [wt.DWORD, ctypes.POINTER(NOTIFYICONDATAW)], wt.BOOL),
        (sh, "ExtractIconExW", [wt.LPCWSTR, ctypes.c_int, ctypes.POINTER(wt.HICON),
                                ctypes.POINTER(wt.HICON), wt.UINT], wt.UINT),
    ]
    for lib, name, args, res in proto:
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res
    _w = SimpleNamespace(u=u, k=k, sh=sh, wt=wt, NID=NOTIFYICONDATAW,
                         WNDCLASSEXW=WNDCLASSEXW, WNDPROC=WNDPROC)
    return _w


def load_icon(icon_path=None):
    """(HICON, owned) for the tray: the .ico at icon_path, else the exe's own
    small icon, else the stock application icon. owned=True means the caller
    must DestroyIcon it."""
    a = _api()
    u, wt = a.u, a.wt
    cx, cy = u.GetSystemMetrics(SM_CXSMICON) or 16, u.GetSystemMetrics(SM_CYSMICON) or 16
    if icon_path and os.path.isfile(icon_path):
        h = u.LoadImageW(None, os.path.abspath(icon_path), IMAGE_ICON, cx, cy,
                         LR_LOADFROMFILE | LR_DEFAULTSIZE)
        if h:
            return h, True
    try:
        small = wt.HICON()
        if a.sh.ExtractIconExW(sys.executable, 0, None, ctypes.byref(small), 1) and small.value:
            return small.value, True
    except Exception:
        pass
    return u.LoadIconW(None, ctypes.c_void_p(IDI_APPLICATION)), False


# -- the icon -------------------------------------------------------------------
class TrayIcon:
    """A tray icon with its own thread. menu: list of (label, callback) tuples,
    None for a separator; a label may be a callable (re-evaluated each time
    the menu opens) and a None callback shows a disabled item. The first item
    is drawn bold as the default action. All methods are safe from any thread."""

    def __init__(self, tooltip, icon_path=None, on_click=None, menu=None, log=None):
        self._tip = clip_text(tooltip, TIP_MAX)
        self._icon_path = icon_path
        self._on_click = on_click
        self._menu = list(menu or [])
        self._log_fn = log
        self._lock = threading.Lock()
        self._thread = None
        self._ready = threading.Event()
        self._ok = False
        self._hwnd = None
        self._added = False
        self._v4 = False
        self._hicon = None
        self._own_icon = False
        self._wndproc = None         # keep the callback alive
        self._cls = None
        self._taskbar_msg = 0
        self._in_menu = False
        self._abort = False
        self._last_click = None
        self._dbl = 0.5
        self._atexit = False

    # -- public -----------------------------------------------------------------
    @property
    def running(self):
        t = self._thread
        return bool(t and t.is_alive() and self._hwnd and self._added)

    def start(self):
        """Create the window and add the icon on a new daemon thread. True once
        the icon is in the tray (waits up to 3 s), False on failure."""
        try:
            with self._lock:
                if self._thread and self._thread.is_alive():
                    alive = True
                else:
                    alive = False
                    self._ready.clear()
                    self._ok = self._abort = False
                    self._thread = threading.Thread(target=self._run, name="tray-icon", daemon=True)
                    self._thread.start()
            if alive:
                self._ready.wait(3.0)
                return self.running
            if not self._ready.wait(3.0) or not self._ok:
                self.stop()
                return False
            if not self._atexit:
                atexit.register(self.stop)  # no ghost icon if the caller forgets
                self._atexit = True
            return True
        except Exception as e:
            self._log("tray start failed: %s" % e)
            return False

    def stop(self):
        """Remove the icon, destroy the window, end the loop. Idempotent."""
        try:
            with self._lock:
                self._abort = True
                t, hwnd = self._thread, self._hwnd
            if hwnd:
                try:
                    _api().u.PostMessageW(hwnd, WM_APP_STOP, 0, 0)
                except Exception:
                    pass
            if t and t is not threading.current_thread():
                t.join(2.0)
                if t.is_alive() and hwnd:
                    self._delete_icon(hwnd)  # loop is stuck: at least drop the icon
            if self._atexit:
                try:
                    atexit.unregister(self.stop)
                except Exception:
                    pass
                self._atexit = False
        except Exception as e:
            self._log("tray stop failed: %s" % e)

    def set_tooltip(self, text):
        """Change the hover text (cut to 127 characters). True if the shell took it."""
        try:
            self._tip = clip_text(text, TIP_MAX)
            return self._notify_call(NIM_MODIFY)
        except Exception:
            return False

    def notify(self, title, text):
        """Show a balloon / toast from the icon. True if the shell took it."""
        try:
            return self._notify_call(NIM_MODIFY, info=(clip_text(title, INFO_TITLE_MAX),
                                                       clip_text(text, INFO_MAX) or " "))
        except Exception:
            return False

    # -- internals --------------------------------------------------------------
    def _log(self, msg):
        if self._log_fn:
            try:
                self._log_fn(msg)
            except Exception:
                pass

    def _nid(self, hwnd, info=None):
        a = _api()
        nid = a.NID()
        nid.cbSize = ctypes.sizeof(a.NID)
        nid.hWnd = hwnd
        nid.uID = ICON_ID
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = self._hicon
        nid.szTip = self._tip
        if info is not None:
            nid.uFlags |= NIF_INFO
            nid.szInfoTitle, nid.szInfo = info
            nid.dwInfoFlags = NIIF_INFO | NIIF_RESPECT_QUIET_TIME
        return nid

    def _notify_call(self, op, info=None):
        hwnd = self._hwnd
        if not hwnd or not self._added:
            return False
        return bool(_api().sh.Shell_NotifyIconW(op, ctypes.byref(self._nid(hwnd, info))))

    def _delete_icon(self, hwnd):
        try:
            a = _api()
            nid = a.NID()
            nid.cbSize = ctypes.sizeof(a.NID)
            nid.hWnd, nid.uID = hwnd, ICON_ID
            return bool(a.sh.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid)))
        except Exception:
            return False
        finally:
            self._added = False

    def _add_icon(self, hwnd, tries=5):
        """NIM_ADD (+ NIM_SETVERSION). A busy Explorer can time out an add that
        actually landed, so a failed add is followed by a NIM_MODIFY probe."""
        a = _api()
        for i in range(tries):
            nid = self._nid(hwnd)
            if a.sh.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)) or \
                    a.sh.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(nid)):
                nid.uVersion = NOTIFYICON_VERSION_4
                self._v4 = bool(a.sh.Shell_NotifyIconW(NIM_SETVERSION, ctypes.byref(nid)))
                self._added = True
                return True
            if i + 1 < tries:
                time.sleep(0.2)
        self._log("tray: Shell_NotifyIcon(NIM_ADD) failed: %s" % ctypes.get_last_error())
        return False

    def _fire(self, cb, what):
        if not cb:
            return

        def work():
            try:
                cb()
            except Exception as e:
                self._log("tray %s callback failed: %s" % (what, e))

        threading.Thread(target=work, name="tray-callback", daemon=True).start()

    def _click(self):
        now = time.monotonic()
        if should_fire(self._last_click, now, self._dbl):
            self._last_click = now
            self._fire(self._on_click, "click")

    def _show_menu(self, hwnd, wparam):
        if self._in_menu:
            return
        a = _api()
        u, wt = a.u, a.wt
        items = menu_model(self._menu)
        if not items:
            return
        hmenu = u.CreatePopupMenu()
        if not hmenu:
            return
        self._in_menu = True
        cmd = 0
        try:
            first = None
            for it in items:
                if it["sep"]:
                    u.AppendMenuW(hmenu, MF_SEPARATOR, 0, None)
                    continue
                u.AppendMenuW(hmenu, MF_STRING | (0 if it["enabled"] else MF_GRAYED), it["id"], it["label"])
                if first is None:
                    first = it["id"]
            if first is not None:
                u.SetMenuDefaultItem(hmenu, first, 0)
            if self._v4 and wparam:
                x, y = split_xy(wparam)
            else:
                pt = wt.POINT()
                u.GetCursorPos(ctypes.byref(pt))
                x, y = pt.x, pt.y
            u.SetForegroundWindow(hwnd)  # without this the menu won't close on an outside click
            cmd = u.TrackPopupMenu(hmenu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
                                   x, y, 0, hwnd, None)
            u.PostMessageW(hwnd, WM_NULL, 0, 0)
        finally:
            u.DestroyMenu(hmenu)
            self._in_menu = False
        for it in items:
            if not it["sep"] and it["id"] == cmd:
                self._fire(it["callback"], "menu %r" % it["label"])
                break

    def _proc(self, hwnd, msg, wp, lp):
        u = _api().u
        try:
            if msg == WM_TRAY:
                ev = tray_event(msg, lp, self._v4)
                if ev == "click":
                    self._click()
                elif ev == "menu":
                    self._show_menu(hwnd, wp)
                return 0
            if self._taskbar_msg and msg == self._taskbar_msg:
                self._added = False
                if not self._abort:
                    self._add_icon(hwnd)
                return 0
            if msg in (WM_APP_STOP, WM_CLOSE):
                if self._in_menu:
                    u.EndMenu()  # leave TrackPopupMenu's modal loop first, then retry
                    u.PostMessageW(hwnd, WM_APP_STOP, 0, 0)
                    return 0
                if self._added:
                    self._delete_icon(hwnd)
                u.DestroyWindow(hwnd)
                return 0
            if msg == WM_DESTROY:
                if self._added:
                    self._delete_icon(hwnd)
                u.PostQuitMessage(0)
                return 0
        except Exception as e:
            self._log("tray window proc error: %s" % e)
        return u.DefWindowProcW(hwnd, msg, wp, lp)

    def _run(self):
        a = None
        hinst = None
        try:
            a = _api()
            u, wt = a.u, a.wt
            try:
                self._dbl = max(0.1, u.GetDoubleClickTime() / 1000.0)
            except Exception:
                pass
            self._hicon, self._own_icon = load_icon(self._icon_path)
            self._wndproc = a.WNDPROC(self._proc)
            hinst = a.k.GetModuleHandleW(None)
            self._cls = "PoBTFTray_%d_%d_%d" % (os.getpid(), id(self), next(_seq))
            wc = a.WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(a.WNDCLASSEXW)
            wc.lpfnWndProc = self._wndproc
            wc.hInstance = hinst
            wc.lpszClassName = self._cls
            if not u.RegisterClassExW(ctypes.byref(wc)):
                self._log("tray: RegisterClassExW failed: %s" % ctypes.get_last_error())
                return
            # hidden top-level (never shown): message-only windows miss the TaskbarCreated broadcast
            hwnd = u.CreateWindowExW(0, self._cls, "PoB Trade Finder tray", 0,
                                     0, 0, 0, 0, None, None, hinst, None)
            if not hwnd:
                self._log("tray: CreateWindowExW failed: %s" % ctypes.get_last_error())
                return
            self._hwnd = hwnd
            self._taskbar_msg = u.RegisterWindowMessageW("TaskbarCreated")
            if self._taskbar_msg:
                try:  # an elevated app would otherwise have Explorer's broadcast filtered out
                    u.ChangeWindowMessageFilterEx(hwnd, self._taskbar_msg, MSGFLT_ALLOW, None)
                except Exception:
                    pass
            if self._abort or not self._add_icon(hwnd) or self._abort:  # stop() may land mid-add
                u.DestroyWindow(hwnd)
                return
            self._ok = True
            self._ready.set()
            msg = wt.MSG()
            while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                u.TranslateMessage(ctypes.byref(msg))
                u.DispatchMessageW(ctypes.byref(msg))
        except Exception as e:
            self._log("tray thread failed: %s" % e)
        finally:
            try:
                if self._hwnd and self._added:
                    self._delete_icon(self._hwnd)
                if self._hwnd and a is not None and a.u.IsWindow(self._hwnd):
                    a.u.DestroyWindow(self._hwnd)
                if self._cls and a is not None:
                    a.u.UnregisterClassW(self._cls, hinst)
                if self._hicon and self._own_icon and a is not None:
                    a.u.DestroyIcon(self._hicon)
            except Exception:
                pass
            self._hwnd = None
            self._hicon = None
            self._added = False
            self._ready.set()
