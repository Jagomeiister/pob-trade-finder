"""In-game price-check hotkey for PoB Trade Finder (Windows, ctypes only).

While Path of Exile is the foreground window a background thread holds a
global hotkey (default Ctrl+D). Pressing it over a hovered item sends the game
a Ctrl+C, reads the item text off the clipboard, restores whatever text was
there before, and hands the item to a callback (gui.py shows the overlay).

The hotkey is registered ONLY while the game is focused, so the same keys keep
working normally in every other program.

Pure helpers (parse_hotkey, looks_like_item, overlay_position) have no Win32
dependencies and are unit-tested in test/test_price_hotkey.py.
"""
import ctypes
import sys
import threading
import time

GAME_TITLE = "Path of Exile"  # PoE 1 only — "Path of Exile 2" items can't be priced here

# -- pure helpers ---------------------------------------------------------------
MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x8, 0x4000
_MOD_NAMES = {"ctrl": MOD_CONTROL, "control": MOD_CONTROL, "alt": MOD_ALT,
              "shift": MOD_SHIFT, "win": MOD_WIN}
_MOD_ORDER = (("ctrl", MOD_CONTROL), ("shift", MOD_SHIFT), ("alt", MOD_ALT), ("win", MOD_WIN))
OFF = ("", "off", "none", "disabled")


def parse_hotkey(spec):
    """'ctrl+d' -> (MOD_CONTROL, 0x44); 'off' -> None. Raises ValueError for
    anything unusable. Letter/digit keys need a modifier (a bare 'd' would eat
    typing in game chat); F1-F24 may stand alone."""
    s = (spec or "").strip().lower().replace(" ", "")
    if s in OFF:
        return None
    parts = s.split("+")
    key, mods = parts[-1], 0
    for p in parts[:-1]:
        if p not in _MOD_NAMES:
            raise ValueError("unknown modifier %r in hotkey %r" % (p, spec))
        mods |= _MOD_NAMES[p]
    if len(key) == 1 and key.isalnum() and key.isascii():
        vk = ord(key.upper())
        if not mods:
            raise ValueError("hotkey %r needs Ctrl, Shift or Alt" % spec)
    elif key[:1] == "f" and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        vk = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError("unsupported key %r in hotkey %r" % (key, spec))
    return mods, vk


def hotkey_label(spec):
    """'ctrl+shift+d' -> 'Ctrl+Shift+D' (for status messages)."""
    parsed = parse_hotkey(spec)
    if not parsed:
        return "Off"
    mods, vk = parsed
    names = [n.capitalize() for n, bit in _MOD_ORDER if mods & bit]
    key = chr(vk) if vk < 0x70 else "F%d" % (vk - 0x70 + 1)
    return "+".join(names + [key])


def looks_like_item(text):
    """True when clipboard text is an in-game Ctrl+C item: it starts with an
    'Item Class:' (current clients) or 'Rarity:' (older) header and has the
    '--------' section separators."""
    if not text or len(text) > 20000:
        return False
    t = text.replace("\r\n", "\n").replace("\r", "\n").lstrip()
    first = t.split("\n", 1)[0]
    return first.startswith(("Item Class:", "Rarity:")) and "\n--------\n" in t


def overlay_position(cursor_x, game_rect, size, margin=16):
    """Top-left corner for the overlay: the half of the game window the cursor
    is NOT in (so the hovered item stays visible), clamped inside the game.
    game_rect = (left, top, right, bottom); size = (width, height)."""
    left, top, right, bottom = game_rect
    w, h = size
    if cursor_x < (left + right) / 2:
        x = right - w - margin
    else:
        x = left + margin
    x = max(left, min(x, right - w))
    y = top + margin
    if y + h > bottom:
        y = max(top, bottom - h)
    return int(x), int(y)


# -- Win32 plumbing (lazily bound; private WinDLL instances so the argtypes set
#    here never leak into ctypes.windll, which pywebview also uses) ------------
WM_HOTKEY, WM_QUIT, PM_REMOVE, QS_ALLINPUT = 0x0312, 0x0012, 0x0001, 0x04FF
VK_SHIFT, VK_CONTROL, VK_MENU, VK_C = 0x10, 0x11, 0x12, 0x43
KEYEVENTF_KEYUP = 0x0002
CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002
HWND_TOPMOST, SWP_NOSIZE, SWP_NOACTIVATE = -1, 0x0001, 0x0010
_w = None


def _win():
    global _w
    if _w is not None:
        return _w
    if sys.platform != "win32":
        raise OSError("price-check hotkey is Windows-only")
    from ctypes import wintypes as wt
    u = ctypes.WinDLL("user32", use_last_error=True)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    proto = [
        (u, "GetForegroundWindow", [], wt.HWND),
        (u, "GetWindowTextLengthW", [wt.HWND], ctypes.c_int),
        (u, "GetWindowTextW", [wt.HWND, wt.LPWSTR, ctypes.c_int], ctypes.c_int),
        (u, "RegisterHotKey", [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT], wt.BOOL),
        (u, "UnregisterHotKey", [wt.HWND, ctypes.c_int], wt.BOOL),
        (u, "PeekMessageW", [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT, wt.UINT], wt.BOOL),
        (u, "PostThreadMessageW", [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM], wt.BOOL),
        (u, "MsgWaitForMultipleObjects", [wt.DWORD, ctypes.c_void_p, wt.BOOL, wt.DWORD, wt.DWORD], wt.DWORD),
        (u, "GetAsyncKeyState", [ctypes.c_int], ctypes.c_short),
        (u, "MapVirtualKeyW", [wt.UINT, wt.UINT], wt.UINT),
        (u, "keybd_event", [wt.BYTE, wt.BYTE, wt.DWORD, ctypes.c_size_t], None),
        (u, "OpenClipboard", [wt.HWND], wt.BOOL),
        (u, "CloseClipboard", [], wt.BOOL),
        (u, "EmptyClipboard", [], wt.BOOL),
        (u, "GetClipboardData", [wt.UINT], wt.HANDLE),
        (u, "SetClipboardData", [wt.UINT, wt.HANDLE], wt.HANDLE),
        (u, "IsClipboardFormatAvailable", [wt.UINT], wt.BOOL),
        (u, "GetClipboardSequenceNumber", [], wt.DWORD),
        (u, "FindWindowW", [wt.LPCWSTR, wt.LPCWSTR], wt.HWND),
        (u, "GetWindowRect", [wt.HWND, ctypes.POINTER(wt.RECT)], wt.BOOL),
        (u, "GetCursorPos", [ctypes.POINTER(wt.POINT)], wt.BOOL),
        (u, "SetWindowPos", [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, wt.UINT], wt.BOOL),
        (u, "SetForegroundWindow", [wt.HWND], wt.BOOL),
        (u, "IsWindow", [wt.HWND], wt.BOOL),
        (k, "GetCurrentThreadId", [], wt.DWORD),
        (k, "GlobalAlloc", [wt.UINT, ctypes.c_size_t], wt.HGLOBAL),
        (k, "GlobalLock", [wt.HGLOBAL], ctypes.c_void_p),
        (k, "GlobalUnlock", [wt.HGLOBAL], wt.BOOL),
        (k, "GlobalFree", [wt.HGLOBAL], wt.HGLOBAL),
    ]
    for lib, name, args, res in proto:
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res
    _w = (u, k, wt)
    return _w


def window_title(hwnd):
    u, _, _ = _win()
    if not hwnd:
        return ""
    n = u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def foreground_game_window():
    """The foreground window handle if it is Path of Exile, else None."""
    u, _, _ = _win()
    hwnd = u.GetForegroundWindow()
    return hwnd if hwnd and window_title(hwnd) == GAME_TITLE else None


def _open_clipboard(tries=10):
    u, _, _ = _win()
    for _ in range(tries):  # the game (or a clipboard manager) may hold it briefly
        if u.OpenClipboard(None):
            return True
        time.sleep(0.02)
    return False


def get_clipboard_text():
    """Clipboard text, or None when it holds no text / can't be opened."""
    u, k, _ = _win()
    if not u.IsClipboardFormatAvailable(CF_UNICODETEXT):
        return None
    if not _open_clipboard():
        return None
    try:
        h = u.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return None
        p = k.GlobalLock(h)
        if not p:
            return None
        try:
            return ctypes.wstring_at(p)
        finally:
            k.GlobalUnlock(h)
    finally:
        u.CloseClipboard()


def set_clipboard_text(text):
    u, k, _ = _win()
    if not _open_clipboard():
        raise RuntimeError("could not open clipboard")
    try:
        u.EmptyClipboard()
        data = (text or "").encode("utf-16-le") + b"\x00\x00"
        h = k.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            raise RuntimeError("GlobalAlloc failed")
        p = k.GlobalLock(h)
        if not p:
            k.GlobalFree(h)
            raise RuntimeError("GlobalLock failed")
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(h)
        if not u.SetClipboardData(CF_UNICODETEXT, h):
            k.GlobalFree(h)  # ownership only passes to the system on success
            raise RuntimeError("SetClipboardData failed")
    finally:
        u.CloseClipboard()


def _key(vk, up=False):
    u, _, _ = _win()
    # scan code included: some games read scan codes rather than virtual keys
    u.keybd_event(vk, u.MapVirtualKeyW(vk, 0) & 0xFF, KEYEVENTF_KEYUP if up else 0, 0)


def send_copy():
    """A clean Ctrl+C to the foreground window. The user may still be holding
    the hotkey's modifiers: release them first, so Alt doesn't turn it into the
    'advanced' Ctrl+Alt+C copy and Ctrl gets a fresh down/up edge."""
    u, _, _ = _win()
    for vk in (VK_SHIFT, VK_MENU, VK_CONTROL):
        if u.GetAsyncKeyState(vk) & 0x8000:
            _key(vk, up=True)
    time.sleep(0.03)
    _key(VK_CONTROL)
    _key(VK_C)
    _key(VK_C, up=True)
    _key(VK_CONTROL, up=True)


def copy_item_text(timeout=0.6):
    """Ctrl+C the hovered item, return its text (None if nothing item-like was
    copied). The previous clipboard text is put back afterwards."""
    u, _, _ = _win()
    prev = get_clipboard_text()
    seq = u.GetClipboardSequenceNumber()
    send_copy()
    deadline = time.time() + timeout
    changed = False
    time.sleep(0.12)  # the client usually answers within ~100ms
    while True:
        if u.GetClipboardSequenceNumber() != seq:
            changed = True
            break
        if time.time() >= deadline:
            break
        time.sleep(0.02)
    if not changed:
        return None  # cursor wasn't over an item (or the game ignored the copy)
    time.sleep(0.03)  # let the game finish writing every clipboard format
    text = get_clipboard_text()
    if prev is not None:
        try:
            set_clipboard_text(prev)
        except Exception:
            pass
    return text.replace("\r\n", "\n") if looks_like_item(text) else None


def place_window(hwnd, x, y):
    u, _, _ = _win()
    u.SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)


def window_rect(hwnd):
    u, _, wt = _win()
    r = wt.RECT()
    if not hwnd or not u.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return r.left, r.top, r.right, r.bottom


def cursor_x():
    u, _, wt = _win()
    pt = wt.POINT()
    return pt.x if u.GetCursorPos(ctypes.byref(pt)) else 0


def find_window(title):
    u, _, _ = _win()
    return u.FindWindowW(None, title)


def focus_window(hwnd):
    u, _, _ = _win()
    return bool(hwnd and u.SetForegroundWindow(hwnd))


# -- the watcher thread ---------------------------------------------------------
class HotkeyWatcher:
    """Owns the global hotkey. RegisterHotKey binds to the calling thread's
    message queue, so registration, unregistration and the WM_HOTKEY pump all
    happen on this one thread. Every `poll` seconds it checks whether the game
    is the foreground window and (un)registers accordingly."""

    HOTKEY_ID = 0xB0B1

    def __init__(self, on_fire, spec="ctrl+d", poll=0.25, is_target=None, log=None):
        self._on_fire = on_fire          # called on a worker thread with the game hwnd
        self._is_target = is_target or foreground_game_window
        self._log = log or (lambda msg: None)
        self._poll = poll
        self._lock = threading.Lock()
        self._spec = "off"
        self._error = None
        self._registered = None          # spec currently held, or None
        self._busy = threading.Lock()    # one copy/price cycle at a time
        self._stop = threading.Event()
        self._thread = None
        self._tid = None
        self.set_spec(spec)

    def set_spec(self, spec):
        """Validate and switch the hotkey; the thread re-registers on its next tick."""
        parse_hotkey(spec)  # raises ValueError for junk
        with self._lock:
            self._spec = (spec or "off").strip().lower().replace(" ", "")
            self._error = None

    def status(self):
        with self._lock:
            spec, err = self._spec, self._error
        return {"hotkey": spec, "label": hotkey_label(spec),
                "running": bool(self._thread and self._thread.is_alive()),
                "active": self._registered is not None, "error": err}

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="price-hotkey", daemon=True)
        self._thread.start()

    def stop(self, timeout=2.0):
        self._stop.set()
        if self._tid:
            try:
                _win()[0].PostThreadMessageW(self._tid, WM_QUIT, 0, 0)  # wake the wait early
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout)

    def _unregister(self):
        if self._registered is not None:
            _win()[0].UnregisterHotKey(None, self.HOTKEY_ID)
            self._registered = None

    def _run(self):
        u, k, wt = _win()
        self._tid = k.GetCurrentThreadId()
        msg = wt.MSG()
        u.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)  # make sure this thread has a queue
        target = None
        try:
            while not self._stop.is_set():
                try:
                    target = self._is_target()
                except Exception:
                    target = None
                with self._lock:
                    want = self._spec if (target and self._spec not in OFF) else None
                if want != self._registered:
                    self._unregister()
                    if want:
                        mods, vk = parse_hotkey(want)
                        if u.RegisterHotKey(None, self.HOTKEY_ID, mods | MOD_NOREPEAT, vk):
                            self._registered = want
                            with self._lock:
                                self._error = None
                        else:
                            with self._lock:
                                if not self._error:
                                    self._error = ("%s is already taken by another program "
                                                   "(Awakened PoE Trade?) — pick another hotkey"
                                                   % hotkey_label(want))
                                    self._log("RegisterHotKey(%s) failed: %s"
                                              % (want, ctypes.get_last_error()))
                # sleep until a message arrives or the poll interval passes
                u.MsgWaitForMultipleObjects(0, None, False, int(self._poll * 1000), QS_ALLINPUT)
                while u.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                    if msg.message == WM_QUIT:
                        self._stop.set()
                    elif msg.message == WM_HOTKEY and msg.wParam == self.HOTKEY_ID:
                        self._dispatch(target)
        finally:
            self._unregister()
            self._tid = None

    def _dispatch(self, hwnd):
        if not self._busy.acquire(blocking=False):
            return  # a copy is already in flight — ignore key mashing

        def work():
            try:
                self._on_fire(hwnd)
            except Exception as e:
                self._log("price hotkey failed: %s" % e)
            finally:
                self._busy.release()

        threading.Thread(target=work, name="price-hotkey-fire", daemon=True).start()
