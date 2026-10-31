"""Unique/gem art lookup failure memory — run: python test/test_icon_cache.py

A definite "no" (unknown item name, nothing listed) is remembered for a week so the
same failing lookup doesn't spend trade calls on every launch; rate limits and network
errors are not remembered. Stubbed _http, temp data dir; no network."""
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


tmp = tempfile.mkdtemp()
gui.DATA_DIR = tmp
api = gui.Api.__new__(gui.Api)
api._unique_icons, api._icon_meta = {}, {}
api._unique_icons_path = os.path.join(tmp, "unique_icons.json")
api._icon_meta_path = os.path.join(tmp, "icon_meta.json")
calls = []


def http_400(url, payload=None, background=False):
    calls.append(url)
    raise RuntimeError('HTTP 400: {"error":{"code":2,"message":"Unknown item name"}}')


api._http = http_400
r1 = api.unique_icon("Not A Real Unique", "Two-Stone Ring")
r2 = api.unique_icon("Not A Real Unique", "Two-Stone Ring")
check("first lookup fails", not r1["ok"])
check("second lookup skipped (no trade call)", len(calls) == 1 and "failed recently" in r2["error"], (calls, r2))

api._icon_meta["fail::Not A Real Unique"] = int(time.time()) - 8 * 86400
api.unique_icon("Not A Real Unique", "Two-Stone Ring")
check("retried after a week", len(calls) == 2, calls)


def cooldown(url, payload=None, background=False):
    calls.append(url)
    raise RuntimeError("GGG rate limit hit — cooling down 60s, then try again")


calls.clear()
api._http = cooldown
api.unique_icon("Headhunter", "Leather Belt")
api.unique_icon("Headhunter", "Leather Belt")
check("rate limits are not remembered", len(calls) == 2 and "fail::Headhunter" not in api._icon_meta, calls)


def found(url, payload=None, background=False):
    calls.append(url)
    if "/search/" in url:
        return {"id": "q1", "result": ["abc"]}
    return {"result": [{"item": {"icon": "https://web.poecdn.com/gen/image/x.png"}}]}


calls.clear()
api._http = lambda url, payload=None, background=False: {"id": "q", "result": []}
r = api.gem_icon("Unlisted Gem")
check("gem with no listings remembered", not r["ok"] and "fail::gem::Unlisted Gem" in api._icon_meta, r)
api._icon_meta["fail::gem::Unlisted Gem"] = 0
api._http = found
r = api.gem_icon("Unlisted Gem")
check("a later success clears the failure", r["ok"] and "fail::gem::Unlisted Gem" not in api._icon_meta, r)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
