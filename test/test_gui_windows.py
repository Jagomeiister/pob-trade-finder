"""Window shutdown tests — run: python test/test_gui_windows.py

Install & restart used to close the overlay twice (directly, then again from the main
window's closed handler). pywebview's WinForms backend raises KeyError('child_…') from a
.NET event on the second close, which Windows shows as an "Unhandled exception" dialog.
Uses stand-in window objects; no real windows are created."""
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


class FakeEvent:
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self

    def fire(self):
        return [h() for h in self.handlers]


class FakeWindow:
    """Mimics pywebview: destroy() of the main window fires its closed event, and a
    second destroy() of any window is the KeyError the real backend raises."""

    def __init__(self, uid):
        self.uid = uid
        self.destroys = 0
        self.events = type("E", (), {})()
        self.events.closed = FakeEvent()
        self.events.closing = FakeEvent()

    def destroy(self):
        self.destroys += 1
        if self.destroys > 1:
            raise KeyError(self.uid)
        self.events.closed.fire()


def make_api():
    api = gui.Api.__new__(gui.Api)  # skip disk/network setup
    api._overlay = None
    api._quitting = False
    api._destroyed = set()
    api._destroy_lock = threading.Lock()
    return api


# main window closed by the user: overlay closes once
api = make_api()
main, overlay = FakeWindow("master"), FakeWindow("child_e0228b72")
api._attach_windows(main, overlay)
main.destroy()
check("closing the main window closes the overlay once", overlay.destroys == 1, overlay.destroys)
check("closing the main window sets quitting", api._quitting)

# Install & restart path: every window, overlay first, then main (whose handler retries the overlay)
api = make_api()
main, overlay = FakeWindow("master"), FakeWindow("child_e0228b72")
api._attach_windows(main, overlay)
for w in sorted([main, overlay], key=lambda w: w is not api._overlay):
    api._destroy_once(w)
check("update shutdown closes the overlay exactly once", overlay.destroys == 1, overlay.destroys)
check("update shutdown closes the main window exactly once", main.destroys == 1, main.destroys)

# racing closes from two threads still close once
api = make_api()
w = FakeWindow("child_race")
ts = [threading.Thread(target=api._destroy_once, args=(w,)) for _ in range(8)]
for t in ts:
    t.start()
for t in ts:
    t.join()
check("concurrent closes of one window close it once", w.destroys == 1, w.destroys)


# Trade helper → Setup → Test mode: made-up events reach the overlays marked test, nothing else
class EvalWindow:
    def __init__(self):
        self.js = []

    def evaluate_js(self, js):
        self.js.append(js)


api = make_api()
cards, sheet = EvalWindow(), EvalWindow()
api._overlay_windows = {"cards": cards, "sheet": sheet}
api._sender = None
r = api.trade_test("whisper", "Mercenaries")
for t in threading.enumerate():
    if t.name == "trade-test":
        t.join(5)
check("test whisper reaches the cards overlay as a test event", r["ok"] and len(cards.js) == 1 and
      '"test": true' in cards.js[0] and "PoBTF_TestBuyer" in cards.js[0] and "Mercenaries" in cards.js[0], cards.js)
check("test whisper doesn't reach the cheat sheet", not sheet.js, sheet.js)
check("test mode never makes a chat sender", api._sender is None)
api.trade_test("act", None, 6)
for t in threading.enumerate():
    if t.name == "trade-test":
        t.join(5)
check("test act goes to the cheat sheet too", sheet.js and '"act": 6' in sheet.js[-1] and '"test": true' in sheet.js[-1], sheet.js)
cards.js[:] = []
check("clear asks the cards overlay to drop test cards", api.trade_test("clear")["ok"] and "clear_tests" in cards.js[0], cards.js)
check("unknown test refused", not api.trade_test("kick")["ok"])

print("\n%d FAILED" % failures if failures else "\nALL TESTS PASSED")
sys.exit(1 if failures else 0)
