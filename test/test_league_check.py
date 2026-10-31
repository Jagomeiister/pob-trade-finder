"""New-league detection tests — run: python test/test_league_check.py

Api.league_check compares the live trade-league list with the bundled data/leagues.json
so the app can offer the new league on launch day. Uses a stubbed _http and a temp
data dir; no network."""
import json
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


def league(lid, realm="pc"):
    return {"id": lid, "realm": realm, "text": lid}


BUNDLED = {"result": [league("Allflame"), league("Hardcore Allflame"), league("Standard"),
                      league("Allflame", "xbox"), league("Hardcore")]}
LIVE = {"result": [league("Keepers"), league("Keepers", "sony"), league("Hardcore Keepers"),
                   league("Keepers"), league("Standard"), league("Hardcore")]}

tmp = tempfile.mkdtemp()
with open(os.path.join(tmp, "leagues.json"), "w", encoding="utf-8") as f:
    json.dump(BUNDLED, f)
gui.DATA_DIR = tmp

api = gui.Api.__new__(gui.Api)  # no __init__: nothing here needs the session or caches
calls = []


def fake_http(url, payload=None, background=False):
    calls.append((url, background))
    return LIVE


api._http = fake_http
r = api.league_check()
check("ok", r.get("ok"), r)
check("PC only, deduplicated, order kept", [l["id"] for l in r["leagues"]] ==
      ["Keepers", "Hardcore Keepers", "Standard", "Hardcore"], r["leagues"])
check("new = live leagues missing from bundled data", r["new"] == ["Keepers", "Hardcore Keepers"], r["new"])
check("one background call to the leagues endpoint",
      calls == [(gui.TRADE_BASE + "/data/leagues", True)], calls)

LIVE = BUNDLED
check("nothing new when the bundle is current", api.league_check()["new"] == [])


def cooldown(url, payload=None, background=False):
    raise RuntimeError("cooldown — background fetch skipped")


api._http = cooldown
r = api.league_check()
check("cooldown is a soft failure", r.get("ok") is False and "cooldown" in r.get("error", ""), r)

api._http = lambda *a, **k: {"error": {"code": 3}}
check("unexpected response is a soft failure", api.league_check().get("ok") is False)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
