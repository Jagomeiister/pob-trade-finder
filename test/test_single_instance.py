"""One copy at a time + the update swap — run: python test/test_single_instance.py

single_instance.SingleInstance: the first copy owns the lock, a second is refused, a copy
started by the updater waits for the old one to exit, and a second launch can ask the running
copy to show itself. Api._update_script: the swap waits for the old process to exit (no fixed
delay), moves the files, and relaunches with --after-update. Uses its own lock names and temp
folders, so a running PoB Trade Finder is never touched. Windows only (skips elsewhere)."""
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402
import single_instance  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


if sys.platform != "win32":
    print("SKIP (Windows only)")
    sys.exit(0)

tag = uuid.uuid4().hex[:8]
names = ("Local\\PoBTF.test.%s" % tag, "Local\\PoBTF.test.show.%s" % tag)

# -- the lock -------------------------------------------------------------------------
# a copy "running" in another thread (a mutex belongs to the thread that took it)
held, done = threading.Event(), threading.Event()


def other_copy(seconds):
    first = single_instance.SingleInstance(*names)
    held.set() if first.acquire() else None
    time.sleep(seconds)
    # then end like a copy that exits: its handle closes and the lock is abandoned
    # (a thread's handles outlive it, a process's don't)
    single_instance._kernel32().CloseHandle(first._mutex)
    done.set()


threading.Thread(target=other_copy, args=(1.5,), daemon=True).start()
held.wait(3)
second = single_instance.SingleInstance(*names)
check("first copy gets the lock", held.is_set())
check("a second copy is refused", second.acquire() is False)
t0 = time.time()
got = second.acquire(wait=10)
check("after an update, the new copy waits for the old one to exit", got and done.is_set() and time.time() - t0 < 6,
      round(time.time() - t0, 2))
second.release()
check("free again once released", single_instance.SingleInstance(*names).acquire())

# -- "show yourself" from a second launch ---------------------------------------------------
shown = threading.Event()
stop = threading.Event()
listener = single_instance.SingleInstance(*names)
listener.listen_for_show(shown.set, stop.is_set, poll=0.1)
time.sleep(0.2)
check("second launch asks the running copy to show", single_instance.SingleInstance(*names).ask_running_copy_to_show())
check("the running copy hears it", shown.wait(3))
stop.set()

# -- the update swap ------------------------------------------------------------------------
script = gui.Api._update_script("C:\\stage", "C:\\app", "C:\\app\\PoB Trade Finder.exe", 4242)
check("swap waits for the old process, not a fixed delay", 'tasklist.exe" /FI "PID eq 4242"' in script and ":wait" in script)
check("swap ends a copy that won't exit after ~30 s", 'taskkill.exe" /PID 4242 /F' in script and "geq 30" in script)
check("Windows tools by full path (not whatever 'find' is on PATH)",
      '"%SystemRoot%\\System32\\find.exe"' in script and " find " not in script and "\nping " not in script)
check("relaunch passes --after-update", '"C:\\app\\PoB Trade Finder.exe" --after-update' in script)
check("no relaunch when not frozen", "start " not in gui.Api._update_script("a", "b", None, 1))

# run it for real in temp folders against a dummy "old copy" that exits after ~3 s
root = tempfile.mkdtemp(prefix="pobtf-swap-")
try:
    staged, app = os.path.join(root, "_update"), os.path.join(root, "app")
    os.makedirs(staged)
    os.makedirs(app)
    with open(os.path.join(staged, "new.txt"), "w") as f:
        f.write("v2")
    old = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3)"], creationflags=0x08000000)
    bat = os.path.join(app, "_apply_update.bat")
    with open(bat, "w", encoding="ascii") as f:
        f.write(gui.Api._update_script(staged, app, None, old.pid))
    t0 = time.time()
    subprocess.run(["cmd", "/c", bat], cwd=app, creationflags=0x08000000, timeout=60,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    took = time.time() - t0
    check("swap ran only after the old copy exited", old.poll() is not None and took >= 2.5, round(took, 1))
    check("files moved into the app folder", os.path.exists(os.path.join(app, "new.txt")))
    check("script removed itself", not os.path.exists(bat))
finally:
    shutil.rmtree(root, ignore_errors=True)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
