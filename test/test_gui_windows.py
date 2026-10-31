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

print("\n%d FAILED" % failures if failures else "\nALL TESTS PASSED")
sys.exit(1 if failures else 0)
