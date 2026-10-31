"""Copy-diagnostics tests — run: python test/test_diagnostics.py

Api.diagnostics output goes into public bug reports, so it must never contain the
POESESSID, other 32-hex tokens or the Windows user name. Uses a temp data dir."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


SESSION = "0123456789abcdef0123456789abcdef"
OTHER = "fedcba9876543210fedcba9876543210"
tmp = tempfile.mkdtemp()
gui.DATA_DIR = tmp
with open(os.path.join(tmp, "debug.log"), "w", encoding="utf-8") as f:
    f.write("10-31 12:00:00 cookie POESESSID=%s\n" % SESSION)
    f.write("10-31 12:00:01 token %s\n" % OTHER)
    f.write("10-31 12:00:02 open C:\\Users\\SomePlayer\\AppData\\Local\\x\n")
    f.write("10-31 12:00:03 HTTP 429 POST /api/trade/search/Allflame\n")

api = gui.Api.__new__(gui.Api)  # no __init__: diagnostics only needs these
api._poesessid = SESSION
api._blocked_until = 0.0
api.hotkey_status = lambda: {"ok": True, "hotkey": "ctrl+d"}
r = api.diagnostics()
text = r.get("text", "")
check("ok", r.get("ok"), r)
check("version line", text.startswith("PoB Trade Finder v" + gui.VERSION), text[:60])
check("session cookie redacted", SESSION not in text)
check("other 32-hex tokens redacted", OTHER not in text)
check("Windows user name redacted", "SomePlayer" not in text and "Users\\<user>" in text)
check("says a session is saved, not what it is", "POESESSID saved: yes" in text)
check("log tail included", "HTTP 429 POST /api/trade/search/Allflame" in text)

# log cap: an oversized debug.log is cut to its newest half on the next write
path = os.path.join(tmp, "debug.log")
with open(path, "w", encoding="utf-8") as f:
    for i in range(20000):
        f.write("line %06d %s\n" % (i, "x" * 20))
gui._debug_log("newest")
size = os.path.getsize(path)
with open(path, encoding="utf-8") as f:
    lines = f.read().splitlines()
check("log capped near half the limit", size <= gui.DEBUG_LOG_MAX // 2 + 200, size)
check("cut on a line boundary", lines[0].startswith("line "), lines[0][:30])
check("newest entry kept", lines[-1].endswith("newest"))

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
