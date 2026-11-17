"""Build-guide window tests — run: python test/test_guide_window.py

The guide window (gui.guide_open) shows a saved guide link in its own plain browser window. Checks:
the URL rules (https, exact allowed hosts, no look-alikes or user@host tricks), that the window is
made WITHOUT js_api, reused, made again after it was closed, Keep on top, remembered place, and the
pywebview handler wrappers (install_guide_hooks) against a stand-in EdgeChrome class.
Uses a fake webview module; no real windows are created."""
import json
import os
import re
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


# ---- URL rules --------------------------------------------------------------------------------
GOOD = [
    "https://mobalytics.gg/poe/profile/phazeplays/builds/3-28-phazeplays-bleed-slams-slayer-revamped-ground-slam-of-earthshaking",
    "https://maxroll.gg/poe/build-guides/lightning-arrow-deadeye-guide",
    "https://www.icy-veins.com/poe/righteous-fire-chieftain-build",
    "https://www.poe-vault.com/guides/some-guide",
    "https://poe.ninja/builds/settlers",
    "https://pobb.in/abc123",
    "https://www.pathofexile.com/forum/view-thread/3500000",
    "https://www.pathofexile.com/forum",     # where /forum/ redirects
    "  https://mobalytics.gg/x  ",           # trimmed
    "HTTPS://Mobalytics.GG/poe",             # case of scheme / host
    "https://mobalytics.gg:443/poe",         # the https port, said out loud
    "https://maxroll.gg/poe?x=1#top",
]
BAD = [
    ("http://mobalytics.gg/poe", "http refused"),
    ("ftp://mobalytics.gg/poe", "other scheme"),
    ("javascript:alert(1)", "javascript:"),
    ("file:///C:/Windows/System32/calc.exe", "file:"),
    ("https://mobalytics.gg.evil.com/poe", "look-alike suffix"),
    ("https://evilmobalytics.gg/poe", "look-alike prefix"),
    ("https://www.mobalytics.gg/poe", "subdomain not listed"),
    ("https://icy-veins.com/poe", "bare host when only www. is listed"),
    ("https://mobalytics.gg@evil.com/", "userinfo trick"),
    ("https://evil.com@mobalytics.gg/", "userinfo on an allowed host"),
    ("https://user:pw@mobalytics.gg/", "credentials"),
    ("https://mobalytics.gg\\@evil.com/", "backslash trick"),
    ("https://mobalytics.gg:8443/poe", "other port"),
    ("https://mobalytics.gg./poe", "trailing dot"),
    ("https://mobalytics%2Egg/poe", "encoded host"),
    ("https://mobalytics.gg/a b", "space inside"),
    ("https://mobalytics.gg/\nx", "newline inside"),
    ("https://www.youtube.com/watch?v=x", "video site"),
    ("https://www.pathofexile.com/trade/search/Standard", "pathofexile.com outside the forum"),
    ("https://www.pathofexile.com/forumx", "a path that only starts like the forum"),
    ("https://www.pathofexile.com/forum/../trade/search", "dot segments out of the forum"),
    ("https://www.pathofexile.com/forum/%2e%2e/trade", "encoded dot segments"),
    ("https://mobalytics.gg/" + "a" * 3000, "too long"),
    ("", "empty"),
    (None, "None"),
    (42, "number"),
    (["https://mobalytics.gg/"], "list"),
    ({"url": "https://mobalytics.gg/"}, "dict"),
]
for u in GOOD:
    out, err = gui.guide_url_check(u)
    check("allowed: %s" % u.strip()[:60], err is None and out == u.strip(), err)
for u, why in BAD:
    out, err = gui.guide_url_check(u)
    check("refused (%s)" % why, out is None and isinstance(err, str) and err, err)
_, msg = gui.guide_url_check("https://evil.com/")
check("the refusal names the allowed sites", "mobalytics.gg" in msg and "icy-veins.com" in msg and "https://" in msg, msg)

# the page's fallback list (browser mode) matches gui.GUIDE_HOSTS
js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "app", "46-guidewindow.js"),
          encoding="utf-8").read()
m = re.search(r"var GUIDE_HOSTS_FALLBACK = \[([^\]]*)\]", js)
js_hosts = re.findall(r"'([^']+)'", m.group(1)) if m else []
check("js fallback host list = gui.GUIDE_HOSTS", tuple(js_hosts) == gui.GUIDE_HOSTS, js_hosts)


# ---- the window -------------------------------------------------------------------------------
class FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self

    def fire(self, *a):
        return [h(*a) for h in self.handlers]


class FakeWindow:
    def __init__(self, fake, uid, title, url, kw):
        self.fake, self.uid, self.title, self.url, self.kw = fake, uid, title, url, kw
        self._js_api = kw.get("js_api")
        self.loads, self.titles = [], []
        self.native = None
        self.destroys = 0
        self.events = type("E", (), {})()
        for n in ("closed", "closing", "moved", "resized", "shown", "loaded"):
            setattr(self.events, n, FakeEvent())

    def load_url(self, url):
        self.loads.append(url)

    def set_title(self, t):
        self.titles.append(t)

    def destroy(self):  # like pywebview: closing, then gone from webview.windows, then closed
        self.destroys += 1
        self.events.closing.fire()
        self.fake.windows.remove(self)
        self.events.closed.fire()


class Screen:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.width, self.height = x, y, w, h


class FakeWebview:
    def __init__(self):
        self.windows = []
        self.made = []
        self.screens = [Screen(0, 0, 2560, 1440)]
        self.guilib = None

    def create_window(self, title, url=None, **kw):
        w = FakeWindow(self, "child_%d" % len(self.made), title, url, kw)
        self.windows.append(w)
        self.made.append(w)
        return w


class FakeMain:
    x, y, width = 100, 50, 1280


def make_api():
    api = gui.Api.__new__(gui.Api)  # skip disk/network setup
    api._storage = {}
    api.storage_set = lambda k, v: api._storage.__setitem__(k, str(v)) or {"ok": True}
    api._quitting = False
    api._destroyed = set()
    api._destroy_lock = threading.Lock()
    api._guide_win = None
    api._guide_lock = threading.Lock()
    api._guide_rect = {}
    api._guide_gone = set()
    api._main = FakeMain()
    api._guide_hooks_ready = lambda: True
    api.tops = []
    api._guide_set_top = lambda win, on: api.tops.append((win.uid, on)) or True
    api._guide_raise = lambda win: None
    return api


fake = FakeWebview()
real_webview = gui.webview
gui.webview = fake
opened = []
real_browser_open = gui.webbrowser.open
gui.webbrowser.open = lambda u, *a, **k: opened.append(u) or True
try:
    api = make_api()
    URL1 = GOOD[0]
    URL2 = "https://maxroll.gg/poe/build-guides/x"
    r = api.guide_open("https://mobalytics.gg.evil.com/x", "Evil")
    check("invalid URL: ok False with the reason, nothing opened", r["ok"] is False and r["error"] and not fake.made
          and not opened, r)
    r = api.guide_open("http://mobalytics.gg/x")
    check("http refused by guide_open", r["ok"] is False and not fake.made, r)
    r = api.guide_open(URL1, "Bleed Slams")
    w1 = fake.made[0] if fake.made else None
    check("first open makes one window", r["ok"] and r["reused"] is False and len(fake.made) == 1, r)
    check("the window shows the guide URL itself (not index.html)", w1 and w1.url == URL1, w1 and w1.url)
    check("made WITHOUT js_api", w1 and "js_api" not in w1.kw and w1._js_api is None, w1 and w1.kw)
    check("title is 'Guide: <title>'", w1 and w1.title == "Guide: Bleed Slams", w1 and w1.title)
    check("default size ~1000x900, beside the main window", w1 and (w1.kw["width"], w1.kw["height"]) == (1000, 900)
          and w1.kw.get("x") == 100 + 1280 + 8 and w1.kw.get("y") == 50, w1 and w1.kw)
    check("not on top by default; page keeps text selection and zoom", w1 and w1.kw["on_top"] is False
          and w1.kw["text_select"] and w1.kw["zoomable"], w1 and w1.kw)
    check("its uid is known as a guide window (for the hooks)", w1 and w1.uid in gui._GUIDE_UIDS)

    r = api.guide_open(URL2, "  Lightning   Arrow  ")
    check("second open reuses the same window", r["ok"] and r["reused"] and len(fake.made) == 1, r)
    check("…and navigates it, retitled", w1.loads == [URL2] and w1.titles == ["Guide: Lightning Arrow"], (w1.loads, w1.titles))

    r = api.guide_on_top(True)
    check("Keep on top: applied to the open window and remembered", r["ok"] and r["onTop"] and api.tops == [(w1.uid, True)]
          and json.loads(api._storage[gui.GUIDE_WIN_KEY])["top"] is True, (r, api.tops))

    # the user moves / resizes it, then closes it
    w1.events.moved.fire(300, 200)
    w1.events.resized.fire(900, 700)
    w1.events.moved.fire(-32000, -32000)  # minimised: Windows parks it off screen
    w1.destroy()
    saved = json.loads(api._storage[gui.GUIDE_WIN_KEY])
    check("closing remembers its place and size", (saved.get("x"), saved.get("y"), saved.get("w"), saved.get("h"))
          == (300, 200, 900, 700), saved)
    check("closed: no window held, uid forgotten", api._guide_win is None and w1.uid not in gui._GUIDE_UIDS)

    r = api.guide_open(URL1, "Bleed Slams")
    w2 = fake.made[-1]
    check("open after close makes a new window", r["ok"] and r["reused"] is False and len(fake.made) == 2 and w2 is not w1, r)
    check("…where it was, at its size, still on top", (w2.kw.get("x"), w2.kw.get("y"), w2.kw["width"], w2.kw["height"],
          w2.kw["on_top"]) == (300, 200, 900, 700, True), w2.kw)
    check("…and the closed one isn't touched again", w1.loads == [URL2])

    r = api.guide_on_top(False)
    check("Keep on top off", r["ok"] and r["onTop"] is False and api.tops[-1] == (w2.uid, False), api.tops)

    r = api.guide_close()
    check("guide_close closes it once", r["ok"] and w2.destroys == 1 and api._guide_win is None, w2.destroys)
    check("guide_close again is harmless", api.guide_close()["ok"] and w2.destroys == 1)
    r = api.guide_on_top(True)
    check("Keep on top with no window: remembered only", r["ok"] and r["open"] is False and api.tops[-1] == (w2.uid, False), r)

    # a saved spot on a monitor that's gone: back beside the main window
    api._storage[gui.GUIDE_WIN_KEY] = json.dumps({"x": 9000, "y": 9000, "w": 1000, "h": 900})
    api.guide_open(URL1, "x")
    w3 = fake.made[-1]
    check("off-screen saved spot is not reused", w3.kw.get("x") == 1388 and w3.kw.get("y") == 50, w3.kw)
    api.guide_close()

    # no room on the right: the left side
    api._main =type("M", (), {"x": 1500, "y": 0, "width": 1000})()
    api._storage[gui.GUIDE_WIN_KEY] = "{}"
    api.guide_open(URL1, "x")
    w4 = fake.made[-1]
    check("beside the main window on the left when the right has no room", w4.kw.get("x") == 1500 - 8 - 1000, w4.kw)
    api.guide_close()

    # empty title: the site's name
    api.guide_open("https://pobb.in/abc", "   ")
    check("no title given: the host", fake.made[-1].title == "Guide: pobb.in", fake.made[-1].title)
    api.guide_close()

    # no WebView2 / hooks unavailable: the system browser, no window
    n = len(fake.made)
    api._quitting = True
    r = api.guide_open(URL1, "x")
    check("app closing: no new guide window", r["ok"] is False and len(fake.made) == n, r)
    api._quitting = False
    api.guide_close()
    real_create = api._guide_create

    def create_then_quit(url, title):
        w = real_create(url, title)
        api._quitting = True  # the main window closed while this one was being made
        return w
    api._guide_create = create_then_quit
    r = api.guide_open(URL1, "x")
    made = fake.made[-1]
    check("app closed while the window was being made: closed again, not kept", r["ok"] is False and
          made.destroys == 1 and api._guide_win is None, (r, made.destroys))
    api._guide_create = real_create
    api._quitting = False
    n = len(fake.made)
    api._guide_hooks_ready = lambda: False
    r = api.guide_open(URL1, "x")
    check("hooks unavailable: the system browser instead, no window", r["ok"] and r.get("external") and opened == [URL1]
          and len(fake.made) == n, r)
    opened[:] = []
    check("guide_hosts gives the one list", api.guide_hosts() == {"ok": True, "hosts": list(gui.GUIDE_HOSTS),
                                                                    "paths": gui.GUIDE_PATHS})
finally:
    gui.webview = real_webview


# ---- install_guide_hooks against a stand-in EdgeChrome ----------------------------------------
class Args:
    def __init__(self, uri, user=True, success=True, redirected=False):
        self.Uri, self.IsUserInitiated, self.IsSuccess, self.IsRedirected = uri, user, success, redirected
        self.Cancel = False
        self.Handled = False


class FakeSettings:
    IsWebMessageEnabled = True
    AreDevToolsEnabled = True
    AreBrowserAcceleratorKeysEnabled = False
    AreDefaultContextMenusEnabled = False
    IsStatusBarEnabled = False


class FakeCore:
    def __init__(self):
        self.Settings = FakeSettings()
        self.PermissionRequested = FakeEvent()


class Sender:
    def __init__(self):
        self.CoreWebView2 = FakeCore()
        self.Source = "https://mobalytics.gg/x"


class FakeEdgeChrome:
    def __init__(self, window):
        self.pywebview_window = window
        self.calls = []
        self.ishtml = False
        self.url = None
        self.loaded_urls = []

    def on_webview_ready(self, sender, args):
        self.calls.append("ready")
        sender.CoreWebView2.Settings.IsWebMessageEnabled = True  # what pywebview sets

    def on_navigation_start(self, sender, args):
        self.calls.append("navstart")

    def on_navigation_completed(self, sender, args):
        self.calls.append("inject")  # pywebview: inject_pywebview

    def on_new_window_request(self, sender, args):
        self.calls.append("newwin")  # pywebview: webbrowser.open(any uri)

    def on_script_notify(self, sender, args):
        self.calls.append("bridge")  # pywebview: js_bridge_call

    def load_url(self, url):
        self.loaded_urls.append(url)


class W:
    def __init__(self, uid, title, js_api):
        self.uid, self.title, self._js_api = uid, title, js_api
        self.events = type("E", (), {})()
        self.events.loaded = type("L", (), {"set": lambda s: setattr(s, "was", True), "was": False})()


check("hooks install", gui.install_guide_hooks(FakeEdgeChrome) is True)
check("hooks install once", gui.install_guide_hooks(FakeEdgeChrome) is True and FakeEdgeChrome._pobtf_guide_hooks)
check("a class without the handlers is refused", gui.install_guide_hooks(type("X", (), {})) is False)

main = FakeEdgeChrome(W("master", "PoB Trade Finder", object()))
gui._GUIDE_UIDS.add("child_guide")
guide = FakeEdgeChrome(W("child_guide", "Guide: x", None))
early = FakeEdgeChrome(W("child_new", "Guide: y", None))       # not yet registered by uid
other = FakeEdgeChrome(W("child_other", "Guide: z", object()))  # has an api: not a guide window
s = Sender()

for v in (main, guide, early, other):
    v.on_script_notify(s, Args(""))
check("main window: bridge messages still reach pywebview", main.calls == ["bridge"], main.calls)
check("guide window: bridge messages dropped", guide.calls == [] and early.calls == [], (guide.calls, early.calls))
check("a window with an api is never treated as a guide", other.calls == ["bridge"], other.calls)

guide.calls[:] = []
guide.on_navigation_completed(s, Args(""))
check("guide window: nothing injected after a page loads, loaded still signalled",
      guide.calls == [] and guide.pywebview_window.events.loaded.was and guide.url == s.Source, guide.calls)
main.calls[:] = []
main.on_navigation_completed(s, Args(""))
check("main window: pywebview's injection unchanged", main.calls == ["inject"], main.calls)

a = Args("https://maxroll.gg/poe/x")
guide.on_navigation_start(s, a)
check("guide window: navigation on an allowed site goes ahead", a.Cancel is False)
opened[:] = []
a = Args("https://evil.com/x", user=True)
guide.on_navigation_start(s, a)
for t in threading.enumerate():
    if t is not threading.current_thread() and t.daemon:
        t.join(2)
check("guide window: a clicked off-site link is cancelled and goes to the system browser",
      a.Cancel is True and opened == ["https://evil.com/x"], opened)
opened[:] = []
a = Args("https://ads.example/redirect", user=False)
guide.on_navigation_start(s, a)
check("guide window: a script's off-site navigation is cancelled, not opened", a.Cancel is True and not opened, opened)
a = Args("https://anything.example/landing", user=True, redirected=True)
guide.on_navigation_start(s, a)
check("guide window: an allowed page redirecting off-site is cancelled, not opened (app loads count as "
      "user-initiated in WebView2)", a.Cancel is True and not opened, opened)
a = Args("file:///C:/Windows/System32/calc.exe", user=True)
guide.on_navigation_start(s, a)
check("guide window: file: navigation cancelled, never handed to the OS", a.Cancel is True and not opened, opened)
a = Args("https://evil.com/x")
main.on_navigation_start(s, a)
check("main window navigation untouched", a.Cancel is False)

a = Args("https://mobalytics.gg/other")
guide.calls[:] = []
guide.on_new_window_request(s, a)
check("guide window: new-window to an allowed page opens in the same window", a.Handled and
      guide.loaded_urls == ["https://mobalytics.gg/other"] and "newwin" not in guide.calls, guide.calls)
a = Args("https://maxroll.gg/r?to=https://anything.example", user=False)
guide.on_new_window_request(s, a)
check("guide window: a script's window.open does nothing, even to an allowed site", a.Handled and not opened and
      guide.loaded_urls == ["https://mobalytics.gg/other"], (opened, guide.loaded_urls))
a = Args("ms-settings:privacy", user=True)
guide.on_new_window_request(s, a)
check("guide window: new-window to another scheme is dropped", a.Handled and not opened and
      guide.loaded_urls == ["https://mobalytics.gg/other"], opened)
a = Args("https://evil.com/")
main.on_new_window_request(s, a)
check("main window: new-window handling unchanged", main.calls[-1] == "newwin")

s = Sender()
guide.on_webview_ready(s, Args("", success=True))
st = s.CoreWebView2.Settings
check("guide window: web messages switched off after pywebview's setup", st.IsWebMessageEnabled is False
      and st.AreDevToolsEnabled is False, vars(st))
check("guide window: find/back keys, context menu, status bar on", st.AreBrowserAcceleratorKeysEnabled and
      st.AreDefaultContextMenusEnabled and st.IsStatusBarEnabled)
check("guide window: permission requests answered (denied)", len(s.CoreWebView2.PermissionRequested.handlers) == 1)
s = Sender()
main.on_webview_ready(s, Args("", success=True))
check("main window settings untouched", s.CoreWebView2.Settings.IsWebMessageEnabled is True and
      not s.CoreWebView2.PermissionRequested.handlers)

gui.webbrowser.open = real_browser_open
print("\n%d FAILED" % failures if failures else "\nALL TESTS PASSED")
sys.exit(1 if failures else 0)
