"""Trade helper backend for PoB Trade Finder (Windows, stdlib + ctypes only).

Reads the game's Client.txt (whispers, joins, trade results), builds chat
commands, sends ONE chat command per explicit user call, and draws a stash-cell
highlight. Compliance by design (GGG third-party policy):

- nothing here sends to the game on its own: ChatSender.send is the only path,
  and one call = exactly one chat command. LogTail only reports events; it has
  no way to reach ChatSender.
- game files are only ever READ (Client.txt, production_Config.ini).
- the mouse cursor is never moved.

Importing this module has no side effects (no threads, windows or Win32 calls).
"""
import configparser
import ctypes
import os
import re
import sys
import threading
import time

import price_hotkey
from price_hotkey import GAME_TITLE

# -- Client.txt location --------------------------------------------------------
GAME_EXES = ("pathofexile.exe", "pathofexile_x64.exe", "pathofexilesteam.exe",
             "pathofexile_x64steam.exe", "pathofexile_kg.exe", "pathofexile_x64_kg.exe",
             "pathofexileegs.exe", "pathofexile_x64egs.exe")
COMMON_DIRS = (r"C:\Program Files (x86)\Steam\steamapps\common\Path of Exile",
               r"C:\Program Files\Steam\steamapps\common\Path of Exile",
               r"C:\Program Files (x86)\Grinding Gear Games\Path of Exile",
               r"C:\Program Files\Grinding Gear Games\Path of Exile",
               r"C:\Program Files\Epic Games\pathofexile")
LOG_NAMES = ("Client.txt", "KakaoClient.txt")


def _log_in(folder, kakao=False):
    names = LOG_NAMES[::-1] if kakao else LOG_NAMES
    for n in names:
        p = os.path.join(folder, "logs", n)
        if os.path.isfile(p):
            return p
    return None


def find_client_log(game_hwnd=None, extra_dirs=(), exe_path_of=None, common_dirs=None):
    """Path of the running game's Client.txt (KakaoClient.txt for the Kakao
    client), else the first one found in extra_dirs / common install dirs.
    exe_path_of(hwnd) -> exe path is injectable for tests."""
    exe_path_of = exe_path_of or process_exe_path
    try:
        hwnd = game_hwnd or price_hotkey.find_window(GAME_TITLE)
        exe = exe_path_of(hwnd) if hwnd else None
    except Exception:
        exe = None
    if exe and os.path.basename(exe).lower() in GAME_EXES:
        found = _log_in(os.path.dirname(exe), "_kg" in os.path.basename(exe).lower())
        if found:
            return found
    for d in list(extra_dirs or ()) + list(COMMON_DIRS if common_dirs is None else common_dirs):
        if d:
            found = _log_in(d)
            if found:
                return found
    return None


# -- Client.txt parsing ---------------------------------------------------------
_PREFIX = re.compile(r"^(\d{4}/\d\d/\d\d \d\d:\d\d:\d\d) [^\[]*\[[^\]]*\] ?(.*)$")
_WHISPER = re.compile(r"^@(From|To) (?:<(\S+?)> )?([^\s:]+): (.*)$")
_JOINED = re.compile(r"^: ([^\s:]+) has joined the area\.$")
_LEFT = re.compile(r"^: ([^\s:]+) has left the area\.$")
_MODE = re.compile(r"^: (AFK|DND) mode is now (ON|OFF)\b")
_ZONE = re.compile(r"^: You have entered (.+?)\.$")
# [DEBUG Client] Generating level 13 area "1_1_town" with seed 1 — campaign ids carry the act
# as their second number ("2_6_1" = Act 6); "2_11_..." is the epilogue / endgame
_AREA_GEN = re.compile(r'^Generating level (\d+) area "([^"]+)"')
_ACT_ID = re.compile(r"^\d+_(\d+)_")

_ITEM = "Hi, I would like to buy your "
_BULK = "Hi, I'd like to buy your "
_STASH = re.compile(r'^(?P<head>.*?) \(stash tab "(?P<tab>.*?)"; position: left (?P<left>\d+), '
                    r'top (?P<top>\d+)\)(?P<note>.*)$')
_PRICED = re.compile(r"^(?P<item>.+) listed for (?P<price>\d[\d.,]*) (?P<cur>.+?) in (?P<league>.+)$")
_UNPRICED = re.compile(r"^(?P<item>.+) in (?P<league>.+)$")
_BULK_RE = re.compile(r"^(?P<count>\d[\d.,]*) (?P<item>.+?) for my (?P<price>\d[\d.,]*) (?P<cur>.+?) "
                      r"in (?P<league>.+?)(?:\.(?P<note>.*))?$")

CURRENCY_CODES = {
    "chaos": "chaos", "chaos orb": "chaos", "chaos orbs": "chaos", "c": "chaos",
    "divine": "divine", "divine orb": "divine", "divine orbs": "divine", "div": "divine",
    "exalted": "exalted", "exalted orb": "exalted", "exalted orbs": "exalted", "exa": "exalted",
    "mirror": "mirror", "mirror of kalandra": "mirror",
    "alch": "alch", "orb of alchemy": "alch", "fusing": "fusing", "orb of fusing": "fusing",
    "chrome": "chrome", "chromatic orb": "chrome", "alt": "alt", "orb of alteration": "alt",
    "vaal": "vaal", "vaal orb": "vaal", "regal": "regal", "regal orb": "regal",
    "gcp": "gcp", "gemcutter's prism": "gcp", "scour": "scour", "orb of scouring": "scour",
    "annul": "annul", "orb of annulment": "annul", "jewellers": "jewellers",
    "jeweller's orb": "jewellers", "chance": "chance", "orb of chance": "chance",
}


def normalize_currency(text):
    """'Chaos Orb' -> 'chaos'; unknown names come back lowercased."""
    t = " ".join((text or "").split()).lower()
    return CURRENCY_CODES.get(t, t) or None


def _num(s):
    try:
        return float(s.replace(",", ""))
    except (AttributeError, ValueError):
        return None


def parse_trade(text):
    """Trade-site whisper text -> trade dict, or None for anything else."""
    text = (text or "").strip()
    if text.startswith(_ITEM):
        body = text[len(_ITEM):]
        tab = left = top = None
        note = ""
        m = _STASH.match(body)
        if m:
            body, tab, note = m.group("head"), m.group("tab"), m.group("note").strip()
            left, top = int(m.group("left")), int(m.group("top"))
        else:
            body = body.rstrip(" .")
        m = _PRICED.match(body)
        if m:
            item, price, cur, league = (m.group("item"), _num(m.group("price")),
                                        normalize_currency(m.group("cur")), m.group("league"))
        else:
            m = _UNPRICED.match(body)
            if not m:
                return None
            item, price, cur, league = m.group("item"), None, None, m.group("league")
        return {"kind": "item", "item": item.strip(), "price": price, "currency": cur,
                "league": league.strip(), "tab": tab, "left": left, "top": top,
                "count": None, "note": note}
    if text.startswith(_BULK):
        m = _BULK_RE.match(text[len(_BULK):])
        if not m:
            return None
        return {"kind": "bulk", "item": m.group("item").strip(), "price": _num(m.group("price")),
                "currency": normalize_currency(m.group("cur")), "league": m.group("league").strip(),
                "tab": None, "left": None, "top": None, "count": _num(m.group("count")),
                "note": (m.group("note") or "").strip()}
    return None


def parse_line(line):
    """One raw Client.txt line -> event dict (always with 'type' and 'time'),
    or None. Never raises."""
    try:
        m = _PREFIX.match((line or "").rstrip("\r\n"))
        if not m:
            return None
        t, msg = m.group(1), m.group(2)
        w = _WHISPER.match(msg)
        if w:
            return {"type": "whisper", "time": t, "dir": "in" if w.group(1) == "From" else "out",
                    "guild": w.group(2), "name": w.group(3), "text": w.group(4),
                    "trade": parse_trade(w.group(4))}
        if msg == ": Trade accepted.":
            return {"type": "trade_accepted", "time": t}
        if msg == ": Trade cancelled.":
            return {"type": "trade_cancelled", "time": t}
        m = _JOINED.match(msg)
        if m:
            return {"type": "joined", "time": t, "name": m.group(1)}
        m = _LEFT.match(msg)
        if m:
            return {"type": "left", "time": t, "name": m.group(1)}
        m = _MODE.match(msg)
        if m:
            return {"type": m.group(1).lower(), "time": t, "on": m.group(2) == "ON"}
        m = _ZONE.match(msg)
        if m:
            return {"type": "zone", "time": t, "area": m.group(1)}
        m = _AREA_GEN.match(msg)
        if m:
            a = _ACT_ID.match(m.group(2))
            act = int(a.group(1)) if a else None
            return {"type": "area", "time": t, "level": int(m.group(1)), "id": m.group(2),
                    "act": act if act and 1 <= act <= 10 else None}
    except Exception:
        pass
    return None


# -- test mode: made-up log lines -------------------------------------------------
# Trade helper → Setup → Test mode shows what trades look like in game without a real
# buyer. The lines go through parse_line like the real log, and every event gets
# "test": True so the overlay never sends a command for it.
TEST_BUYER = "PoBTF_TestBuyer"
TEST_SELLER = "PoBTF_TestSeller"
TEST_SCENARIOS = ("whisper", "bulk", "joined", "accepted", "left", "buying", "zone", "act")


def test_lines(kind, league="Standard", act=1):
    """kind (TEST_SCENARIOS) -> raw Client.txt lines, stamped now. 'whisper' and 'buying'
    point at stash tab cells, so the outline can be tried too."""
    stamp = time.strftime("%Y/%m/%d %H:%M:%S") + " 1 abc [INFO Client 1] "
    if kind == "whisper":
        msg = ['@From %s: Hi, I would like to buy your Tabula Rasa Simple Robe listed for 10 chaos in %s '
               '(stash tab "Test sale"; position: left 3, top 5)' % (TEST_BUYER, league)]
    elif kind == "bulk":
        msg = ["@From %s: Hi, I'd like to buy your 20 Chaos Orb for my 1 Divine Orb in %s." % (TEST_BUYER, league)]
    elif kind == "joined":
        msg = [": %s has joined the area." % TEST_BUYER]
    elif kind == "accepted":
        msg = [": Trade accepted."]
    elif kind == "left":
        msg = [": %s has left the area." % TEST_BUYER]
    elif kind == "buying":
        msg = ['@To %s: Hi, I would like to buy your Goldrim Leather Cap listed for 1 chaos in %s '
               '(stash tab "Shop"; position: left 1, top 1)' % (TEST_SELLER, league)]
    elif kind == "zone":
        msg = [": You have entered The Lower Prison."]
    elif kind == "act":
        a = max(1, min(10, int(act or 1)))
        area = "1_%d_town" % a if a <= 5 else "2_%d_town" % a
        msg = ['Generating level %d area "%s" with seed 1' % (a * 7, area)]
    else:
        raise ValueError("unknown test")
    return [stamp.replace("[INFO", "[DEBUG") + m if kind == "act" else stamp + m for m in msg]


# -- log tailing ----------------------------------------------------------------
class LogTail:
    """Follows a growing log from its current end (history is never replayed)
    and calls on_event(event) for each parsed line. Read-only; the only output
    is the callback."""

    MAX_READ = 4 << 20       # bytes per poll; a huge jump is caught up over a few polls
    MAX_PARTIAL = 64 << 10   # a "line" this long without a newline is dropped

    def __init__(self, path, on_event, poll=0.5, on_error=None):
        self.path = path
        self._on_event = on_event
        self._on_error = on_error
        self._poll = poll
        self._offset = None      # None until the file is first seen -> start at its end
        self._buf = b""
        self._last_error = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    @property
    def running(self):
        return bool(self._thread and self._thread.is_alive())

    def start(self):
        if self.running:
            return
        self._stop.clear()
        with self._lock:
            self._offset, self._buf = None, b""
            self._prime()
        self._thread = threading.Thread(target=self._run, name="client-log-tail", daemon=True)
        self._thread.start()

    def stop(self, timeout=2.0):
        self._stop.set()
        t = self._thread
        if t and t is not threading.current_thread():
            t.join(timeout)

    def _run(self):
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception as e:  # never let the thread die
                self._error("log tail: %s" % e)
            self._stop.wait(self._poll)

    def _error(self, msg):
        if msg != self._last_error:
            self._last_error = msg
            if self._on_error:
                try:
                    self._on_error(msg)
                except Exception:
                    pass

    def _prime(self):
        try:
            self._offset = os.path.getsize(self.path)
            return True
        except OSError as e:
            self._error("can't read %s: %s" % (self.path, e.strerror or e))
            return False

    def poll_once(self):
        """Read whatever was appended since the last call; returns the events
        delivered (also handed to on_event)."""
        with self._lock:
            if self._offset is None:
                self._prime()
                return []
            try:
                size = os.path.getsize(self.path)
                if size < self._offset:  # truncated / replaced
                    self._offset, self._buf = 0, b""
                if size == self._offset:
                    self._last_error = None
                    return []
                with open(self.path, "rb") as f:
                    f.seek(self._offset)
                    data = f.read(min(size - self._offset, self.MAX_READ))
            except OSError as e:
                self._error("can't read %s: %s" % (self.path, e.strerror or e))
                return []
            self._last_error = None
            self._offset += len(data)
            parts = (self._buf + data).split(b"\n")
            self._buf = parts.pop()
            if len(self._buf) > self.MAX_PARTIAL:
                self._buf = b""
            events = []
            for raw in parts:
                ev = parse_line(raw.decode("utf-8", errors="replace").replace("\r", ""))
                if ev:
                    events.append(ev)
        for ev in events:  # outside the lock: a slow callback can't block stop/start
            try:
                self._on_event(ev)
            except Exception as e:
                self._error("event handler failed: %s" % e)
        return events


# -- production_Config.ini ------------------------------------------------------
DEFAULT_CHAT_VK = 0x0D  # Enter
CONFIG_REL = os.path.join("My Games", "Path of Exile", "production_Config.ini")


def _documents_dir():
    """The real Documents folder (follows OneDrive / folder redirection)."""
    if sys.platform != "win32":
        return None
    try:
        from ctypes import wintypes as wt

        class GUID(ctypes.Structure):
            _fields_ = [("a", wt.DWORD), ("b", wt.WORD), ("c", wt.WORD), ("d", ctypes.c_ubyte * 8)]

        fid = GUID(0xFDD39AD0, 0x238F, 0x46AF, (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
        sh = ctypes.WinDLL("shell32")
        ole = ctypes.WinDLL("ole32")
        sh.SHGetKnownFolderPath.argtypes = [ctypes.POINTER(GUID), wt.DWORD, wt.HANDLE,
                                            ctypes.POINTER(ctypes.c_wchar_p)]
        sh.SHGetKnownFolderPath.restype = ctypes.c_long
        ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        p = ctypes.c_wchar_p()
        if sh.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(p)) != 0:
            return None
        try:
            return p.value
        finally:
            ole.CoTaskMemFree(ctypes.cast(p, ctypes.c_void_p))
    except Exception:
        return None


def config_candidates():
    out = []
    for base in (_documents_dir(),
                 os.path.join(os.environ.get("USERPROFILE", ""), "Documents"),
                 os.path.join(os.environ.get("OneDrive", ""), "Documents") if os.environ.get("OneDrive") else None):
        if base:
            p = os.path.join(base, CONFIG_REL)
            if p not in out:
                out.append(p)
    return out


def _decode(raw):
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _chat_value(text):
    cp = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        cp.read_string(text)
        for sec in cp.sections():
            if sec.strip().upper() == "ACTION_KEYS" and cp.has_option(sec, "chat"):
                return cp.get(sec, "chat")
        return None
    except configparser.Error:
        pass
    section = None  # malformed file: plain line scan
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            section = s[1:-1].strip().upper()
        elif section == "ACTION_KEYS" and "=" in s:
            k, v = s.split("=", 1)
            if k.strip().lower() == "chat":
                return v
    return None


def read_chat_key(config_path=None):
    """Virtual-key code of the in-game 'chat' binding (default 13 = Enter).
    Read only — the game config is never written."""
    for path in ([config_path] if config_path else config_candidates()):
        try:
            with open(path, "rb") as f:
                value = _chat_value(_decode(f.read()))
        except OSError:
            continue
        m = re.search(r"\d+", value or "")
        if m and 0 < int(m.group()) < 256:
            return int(m.group())
        if config_path is None and value is None:
            continue
        break
    return DEFAULT_CHAT_VK


# -- extra Win32 (own WinDLL instances, like price_hotkey) -----------------------
PROCESS_QUERY_LIMITED_INFORMATION, TOKEN_QUERY, TOKEN_ELEVATION_CLASS = 0x1000, 0x0008, 20
ERROR_ACCESS_DENIED = 5
_a = None


def _api():
    global _a
    if _a is not None:
        return _a
    if sys.platform != "win32":
        raise OSError("trade helper is Windows-only")
    from ctypes import wintypes as wt
    u = ctypes.WinDLL("user32", use_last_error=True)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    g = ctypes.WinDLL("gdi32", use_last_error=True)
    lres = ctypes.c_ssize_t
    proto = [
        (u, "GetWindowThreadProcessId", [wt.HWND, ctypes.POINTER(wt.DWORD)], wt.DWORD),
        (u, "IsIconic", [wt.HWND], wt.BOOL),
        (u, "ShowWindow", [wt.HWND, ctypes.c_int], wt.BOOL),
        (u, "GetForegroundWindow", [], wt.HWND),
        (u, "GetClientRect", [wt.HWND, ctypes.POINTER(wt.RECT)], wt.BOOL),
        (u, "ClientToScreen", [wt.HWND, ctypes.POINTER(wt.POINT)], wt.BOOL),
        (u, "RegisterClassExW", [ctypes.c_void_p], wt.ATOM),
        (u, "CreateWindowExW", [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE,
                                wt.LPVOID], wt.HWND),
        (u, "DestroyWindow", [wt.HWND], wt.BOOL),
        (u, "DefWindowProcW", [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM], lres),
        (u, "GetMessageW", [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT], wt.BOOL),
        (u, "TranslateMessage", [ctypes.POINTER(wt.MSG)], wt.BOOL),
        (u, "DispatchMessageW", [ctypes.POINTER(wt.MSG)], lres),
        (u, "PostMessageW", [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM], wt.BOOL),
        (u, "PostQuitMessage", [ctypes.c_int], None),
        (u, "SetLayeredWindowAttributes", [wt.HWND, wt.COLORREF, wt.BYTE, wt.DWORD], wt.BOOL),
        (u, "SetWindowPos", [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int, wt.UINT], wt.BOOL),
        (u, "InvalidateRect", [wt.HWND, ctypes.c_void_p, wt.BOOL], wt.BOOL),
        (u, "BeginPaint", [wt.HWND, ctypes.c_void_p], wt.HDC),
        (u, "EndPaint", [wt.HWND, ctypes.c_void_p], wt.BOOL),
        (u, "FillRect", [wt.HDC, ctypes.POINTER(wt.RECT), wt.HBRUSH], ctypes.c_int),
        (u, "SetTimer", [wt.HWND, ctypes.c_size_t, wt.UINT, ctypes.c_void_p], ctypes.c_size_t),
        (u, "KillTimer", [wt.HWND, ctypes.c_size_t], wt.BOOL),
        (g, "CreateSolidBrush", [wt.COLORREF], wt.HBRUSH),
        (g, "DeleteObject", [wt.HGDIOBJ], wt.BOOL),
        (k, "GetModuleHandleW", [wt.LPCWSTR], wt.HMODULE),
        (k, "OpenProcess", [wt.DWORD, wt.BOOL, wt.DWORD], wt.HANDLE),
        (k, "CloseHandle", [wt.HANDLE], wt.BOOL),
        (k, "GetCurrentProcess", [], wt.HANDLE),
        (k, "QueryFullProcessImageNameW", [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)], wt.BOOL),
        (adv, "OpenProcessToken", [wt.HANDLE, wt.DWORD, ctypes.POINTER(wt.HANDLE)], wt.BOOL),
        (adv, "GetTokenInformation", [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD,
                                      ctypes.POINTER(wt.DWORD)], wt.BOOL),
    ]
    for lib, name, args, res in proto:
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res
    _a = (u, k, adv, g, wt)
    return _a


def window_pid(hwnd):
    u, _, _, _, wt = _api()
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value or None


def process_exe_path(hwnd):
    """Full exe path of the process owning hwnd, or None."""
    try:
        _, k, _, _, wt = _api()
        pid = window_pid(hwnd) if hwnd else None
        if not pid:
            return None
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            buf = ctypes.create_unicode_buffer(1024)
            n = wt.DWORD(len(buf))
            return buf.value if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) else None
        finally:
            k.CloseHandle(h)
    except Exception:
        return None


def _token_elevated(proc):
    _, k, adv, _, wt = _api()
    tok = wt.HANDLE()
    if not adv.OpenProcessToken(proc, TOKEN_QUERY, ctypes.byref(tok)):
        return "denied" if ctypes.get_last_error() == ERROR_ACCESS_DENIED else None
    try:
        val, n = wt.DWORD(), wt.DWORD()
        if not adv.GetTokenInformation(tok, TOKEN_ELEVATION_CLASS, ctypes.byref(val),
                                       ctypes.sizeof(val), ctypes.byref(n)):
            return None
        return bool(val.value)
    finally:
        k.CloseHandle(tok)


def is_elevated(pid=None):
    """True/False whether a process (default: this one) runs elevated; None
    when it can't be told. A non-elevated caller is usually denied the process
    or token of an elevated one — that denial is read as True."""
    try:
        _, k, _, _, _ = _api()
        if pid is None:
            r = _token_elevated(k.GetCurrentProcess())
            return r if isinstance(r, bool) else None
        h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            if ctypes.get_last_error() == ERROR_ACCESS_DENIED and is_elevated() is False:
                return True
            return None
        try:
            r = _token_elevated(h)
        finally:
            k.CloseHandle(h)
        if r == "denied":
            return True if is_elevated() is False else None
        return r
    except Exception:
        return None


def elevation_mismatch(game_hwnd):
    """True when the game runs elevated and this process doesn't: Windows (UIPI)
    then silently drops the keys we send it."""
    try:
        pid = window_pid(game_hwnd) if game_hwnd else None
        return bool(pid) and is_elevated(pid) is True and is_elevated() is False
    except Exception:
        return False


def game_client_rect(hwnd):
    """Client area of a window in screen coords as (x, y, w, h), or None."""
    try:
        u, _, _, _, wt = _api()
        r, pt = wt.RECT(), wt.POINT(0, 0)
        if not hwnd or not u.GetClientRect(hwnd, ctypes.byref(r)) or not u.ClientToScreen(hwnd, ctypes.byref(pt)):
            return None
        return pt.x, pt.y, r.right - r.left, r.bottom - r.top
    except Exception:
        return None


# -- chat commands --------------------------------------------------------------
ACTIONS = {"invite": "/invite %s", "kick": "/kick %s", "trade": "/tradewith %s",
           "hideout": "/hideout %s", "whois": "/whois %s", "ignore": "/ignore %s"}
_NAME = re.compile(r"\w{1,40}")
MAX_WHISPER = 300


def command_for(action, name, text=None):
    """Chat command string for one action on one character. Raises ValueError
    for an unknown action, an invalid character name or bad whisper text."""
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ValueError("invalid character name %r" % (name,))
    if action == "whisper":
        msg = re.sub(r"[\x00-\x1f\x7f]+", " ", text or "").strip()
        if not msg:
            raise ValueError("whisper text is empty")
        if len(msg) > MAX_WHISPER:
            raise ValueError("whisper text is longer than %d characters" % MAX_WHISPER)
        return "@%s %s" % (name, msg)
    if action not in ACTIONS:
        raise ValueError("unknown action %r" % (action,))
    return ACTIONS[action] % name


# -- sending one chat command ---------------------------------------------------
VK_RETURN, VK_CONTROL, VK_A, VK_V, VK_F = 0x0D, 0x11, 0x41, 0x56, 0x46
MAX_COMMAND = 512
MAX_SEARCH = 250  # the stash search box takes 50; the builder warns, the game truncates
STEP_DELAY = 0.04       # between key steps
FOCUS_WAIT = 0.4        # how long to wait for the game to come to the front
RESTORE_DELAY = 0.25    # let the game read the clipboard before it is put back
ELEVATION_ERROR = ("Path of Exile is running as administrator, so Windows blocks keys sent "
                   "from this app. Run PoB Trade Finder as administrator too (or neither).")


class _Win32:
    """Default system hooks for ChatSender (tests pass a fake with the same methods)."""

    def foreground(self):
        return _api()[0].GetForegroundWindow()

    def focus(self, hwnd):
        u = _api()[0]
        if u.IsIconic(hwnd):
            u.ShowWindow(hwnd, 9)  # SW_RESTORE
        return price_hotkey.focus_window(hwnd)

    def key(self, vk, up=False):
        price_hotkey._key(vk, up)

    def get_clipboard(self):
        return price_hotkey.get_clipboard_text()

    def set_clipboard(self, text):
        price_hotkey.set_clipboard_text(text)

    def elevation_mismatch(self, hwnd):
        return elevation_mismatch(hwnd)


class ChatSender:
    """Sends exactly one chat command per send() call: focus the game, open
    chat, select-all, paste the command, Enter; the clipboard text is put back
    afterwards. Calls are serialized. There is no queue, timer or retry — it
    never sends anything it wasn't just asked to."""

    def __init__(self, find_game=None, chat_vk=None, sleep=time.sleep, win=None):
        self._find_game = find_game or (lambda: price_hotkey.find_window(GAME_TITLE))
        self._chat_vk = chat_vk
        self._sleep = sleep
        self._win = win or _Win32()
        self._lock = threading.Lock()

    def _tap(self, vk, ctrl=False):
        w = self._win
        if ctrl:
            w.key(VK_CONTROL)
        w.key(vk)
        w.key(vk, up=True)
        if ctrl:
            w.key(VK_CONTROL, up=True)

    def send(self, command):
        if not isinstance(command, str) or not command.strip():
            return {"ok": False, "error": "Nothing to send"}
        if "\n" in command or "\r" in command:
            return {"ok": False, "error": "A chat command can't contain line breaks"}
        if len(command) > MAX_COMMAND:
            return {"ok": False, "error": "Chat command is too long"}
        with self._lock:
            try:
                return self._send(command)
            except Exception as e:
                return {"ok": False, "error": "Couldn't send to Path of Exile: %s" % e}

    def paste_search(self, text):
        """Search text builder: one press fills the open stash / vendor search box —
        focus the game, Ctrl+F, Ctrl+A, paste (no Enter: the game searches as you type);
        the clipboard text is put back afterwards."""
        if not isinstance(text, str) or not text.strip():
            return {"ok": False, "error": "Nothing to paste"}
        if "\n" in text or "\r" in text or len(text) > MAX_SEARCH:
            return {"ok": False, "error": "Search text must be one line of at most %d characters" % MAX_SEARCH}
        with self._lock:
            try:
                return self._send(text, search=True)
            except Exception as e:
                return {"ok": False, "error": "Couldn't paste into Path of Exile: %s" % e}

    def _send(self, command, search=False):
        w, sleep = self._win, self._sleep
        hwnd = self._find_game()
        if not hwnd:
            return {"ok": False, "error": "Path of Exile isn't running"}
        if w.elevation_mismatch(hwnd):
            return {"ok": False, "error": ELEVATION_ERROR}
        vk = VK_F if search else (self._chat_vk or read_chat_key())
        prev = w.get_clipboard()
        touched = False
        try:
            w.focus(hwnd)
            waited = 0.0
            while w.foreground() != hwnd:
                if waited >= FOCUS_WAIT:
                    return {"ok": False, "error": "Couldn't bring Path of Exile to the front"}
                sleep(0.05)
                waited += 0.05
            sleep(STEP_DELAY)
            self._tap(vk, ctrl=search)       # open chat / Ctrl+F: the search box
            sleep(STEP_DELAY)
            self._tap(VK_A, ctrl=True)       # select any draft text
            sleep(STEP_DELAY)
            touched = True
            w.set_clipboard(command)
            sleep(STEP_DELAY)
            self._tap(VK_V, ctrl=True)       # paste
            sleep(STEP_DELAY)
            if not search:
                self._tap(VK_RETURN)         # send
            sleep(RESTORE_DELAY)
            return {"ok": True, "error": None}
        finally:
            if touched and prev is not None:
                try:
                    w.set_clipboard(prev)
                except Exception:
                    pass


# -- stash highlight ------------------------------------------------------------
STASH_X, STASH_Y, STASH_CELL = 16 / 1080, 127 / 1080, 53 / 1080


def stash_cell_rect(game_rect, left, top, quad=None):
    """Screen rect (x, y, w, h) of a stash cell. game_rect = game client area
    (x, y, w, h); left/top are the whisper's 1-based coordinates. quad=None
    picks a quad tab when either coordinate is beyond 12."""
    gx, gy, _, gh = game_rect
    left, top = int(left), int(top)
    if quad is None:
        quad = left > 12 or top > 12
    n = 24 if quad else 12
    if not (1 <= left <= n and 1 <= top <= n):
        raise ValueError("stash position %d,%d is outside a %dx%d tab" % (left, top, n, n))
    cell = STASH_CELL * gh / (2 if quad else 1)
    ox, oy = STASH_X * gh, STASH_Y * gh
    x0, x1 = round(ox + (left - 1) * cell), round(ox + left * cell)
    y0, y1 = round(oy + (top - 1) * cell), round(oy + top * cell)
    return int(gx + x0), int(gy + y0), int(x1 - x0), int(y1 - y0)


WS_POPUP = 0x80000000
WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOPMOST = 0x80000, 0x20, 0x8
WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80, 0x08000000
LWA_COLORKEY, SW_HIDE, SW_SHOWNOACTIVATE = 0x1, 0, 4
WM_DESTROY, WM_CLOSE, WM_PAINT, WM_TIMER, WM_ERASEBKGND = 0x0002, 0x0010, 0x000F, 0x0113, 0x0014
WM_APP_SHOW, WM_APP_HIDE = 0x8001, 0x8002
SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x0010, 0x0040
_KEY_COLOR = 0x00010001  # near-black magenta: fully transparent interior
_HIDE_TIMER = 1


class StashHighlight:
    """Click-through, topmost, non-activating outline drawn over a screen rect
    (display only — it never touches the game). One window on its own thread,
    created on the first show(); safe to call from any thread, never raises."""

    BORDER = 3

    def __init__(self):
        self._lock = threading.Lock()
        self._pending = None     # (x, y, w, h, color, ms)
        self._color = None
        self._hwnd = None
        self._thread = None
        self._ready = threading.Event()
        self._wndproc = None     # keep the callback alive

    def show(self, rect, seconds=20, color=0x00C0FF):
        """Outline rect = (x, y, w, h) in screen pixels for `seconds`.
        color is a Win32 COLORREF (0x00BBGGRR; the default is amber)."""
        try:
            x, y, w, h = (int(v) for v in rect)
            b = self.BORDER
            color = int(color) & 0xFFFFFF
            if color == _KEY_COLOR:
                color ^= 0x000100
            with self._lock:
                self._pending = (x - b, y - b, max(1, w) + 2 * b, max(1, h) + 2 * b,
                                 color, max(1, int(float(seconds) * 1000)))
            hwnd = self._ensure()
            return bool(hwnd and _api()[0].PostMessageW(hwnd, WM_APP_SHOW, 0, 0))
        except Exception:
            return False

    def hide(self):
        try:
            hwnd = self._hwnd
            return bool(hwnd and _api()[0].PostMessageW(hwnd, WM_APP_HIDE, 0, 0))
        except Exception:
            return False

    def close(self):
        """Destroy the window and end its thread."""
        try:
            hwnd = self._hwnd
            if hwnd:
                _api()[0].PostMessageW(hwnd, WM_CLOSE, 0, 0)
            if self._thread and self._thread is not threading.current_thread():
                self._thread.join(2.0)
            return True
        except Exception:
            return False

    def _ensure(self):
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._hwnd = None
                self._ready.clear()
                self._thread = threading.Thread(target=self._run, name="stash-highlight", daemon=True)
                self._thread.start()
        self._ready.wait(2.0)
        return self._hwnd

    def _run(self):
        try:
            self._loop()
        except Exception:
            pass
        finally:
            self._hwnd = None
            self._ready.set()

    def _loop(self):
        u, k, _, g, wt = _api()
        WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

        class WNDCLASSEXW(ctypes.Structure):
            _fields_ = [("cbSize", wt.UINT), ("style", wt.UINT), ("lpfnWndProc", WNDPROC),
                        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                        ("hInstance", wt.HINSTANCE), ("hIcon", wt.HICON), ("hCursor", wt.HANDLE),
                        ("hbrBackground", wt.HBRUSH), ("lpszMenuName", wt.LPCWSTR),
                        ("lpszClassName", wt.LPCWSTR), ("hIconSm", wt.HICON)]

        class PAINTSTRUCT(ctypes.Structure):
            _fields_ = [("hdc", wt.HDC), ("fErase", wt.BOOL), ("rcPaint", wt.RECT),
                        ("fRestore", wt.BOOL), ("fIncUpdate", wt.BOOL), ("rgbReserved", ctypes.c_byte * 32)]

        size = [0, 0]

        def paint(hwnd):
            ps = PAINTSTRUCT()
            hdc = u.BeginPaint(hwnd, ctypes.byref(ps))
            if not hdc:
                return
            try:
                w, h, b = size[0], size[1], self.BORDER
                key = g.CreateSolidBrush(_KEY_COLOR)
                pen = g.CreateSolidBrush(self._color if self._color is not None else 0x00C0FF)
                u.FillRect(hdc, ctypes.byref(wt.RECT(0, 0, w, h)), key)
                for r in ((0, 0, w, b), (0, h - b, w, h), (0, 0, b, h), (w - b, 0, w, h)):
                    u.FillRect(hdc, ctypes.byref(wt.RECT(*r)), pen)
                g.DeleteObject(key)
                g.DeleteObject(pen)
            finally:
                u.EndPaint(hwnd, ctypes.byref(ps))

        def proc(hwnd, msg, wp, lp):
            try:
                if msg == WM_APP_SHOW:
                    with self._lock:
                        p, self._pending = self._pending, None
                    if p:
                        x, y, w, h, color, ms = p
                        self._color, size[0], size[1] = color, w, h
                        u.SetWindowPos(hwnd, wt.HWND(-1), x, y, w, h, SWP_NOACTIVATE)
                        u.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
                        u.InvalidateRect(hwnd, None, True)
                        u.SetTimer(hwnd, _HIDE_TIMER, ms, None)
                    return 0
                if msg == WM_APP_HIDE or (msg == WM_TIMER and wp == _HIDE_TIMER):
                    u.KillTimer(hwnd, _HIDE_TIMER)
                    u.ShowWindow(hwnd, SW_HIDE)
                    return 0
                if msg == WM_ERASEBKGND:
                    return 1
                if msg == WM_PAINT:
                    paint(hwnd)
                    return 0
                if msg == WM_CLOSE:
                    u.DestroyWindow(hwnd)
                    return 0
                if msg == WM_DESTROY:
                    u.PostQuitMessage(0)
                    return 0
            except Exception:
                pass
            return u.DefWindowProcW(hwnd, msg, wp, lp)

        self._wndproc = WNDPROC(proc)
        hinst = k.GetModuleHandleW(None)
        cls = "PoBTFStashHighlight_%d" % id(self)
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinst
        wc.lpszClassName = cls
        u.RegisterClassExW(ctypes.byref(wc))  # an existing class (restart) is fine
        ex = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        hwnd = u.CreateWindowExW(ex, cls, "PoB Trade Finder highlight", WS_POPUP,
                                 0, 0, 1, 1, None, None, hinst, None)
        if not hwnd:
            return
        u.SetLayeredWindowAttributes(hwnd, _KEY_COLOR, 255, LWA_COLORKEY)
        self._hwnd = hwnd
        self._ready.set()
        msg = wt.MSG()
        while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            u.TranslateMessage(ctypes.byref(msg))
            u.DispatchMessageW(ctypes.byref(msg))
