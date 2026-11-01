"""Div cards tool backend — run: python test/test_divcards.py

Api.div_cards: drop data from the backend (stubbed), prices from GGG's exchange feed
(stubbed), joined by card name; the last good copy on disk is used when offline."""
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
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail and not cond else ""))


class Feed:
    def __init__(self):
        self.asked = None

    def rates(self, league, ids):
        self.asked = (league, sorted(ids))
        return {"D1": 1500.0, "DV": 200.0}, 1793448000


DROPS = {"source": "Path of Exile Wiki", "fetchedAt": "2026-11-01T00:00:00Z",
         "areas": [{"id": "MapWorldsBurialChambers", "name": "Burial Chambers", "lvl": 75, "map": True}],
         "cards": [{"n": "The Doctor", "s": 8, "a": [0]}, {"n": "Rain of Chaos", "s": 8}, {"n": "Gone", "s": 1, "off": 1}]
         + [{"n": "Filler %d" % i, "s": 1} for i in range(120)]}

api = gui.Api.__new__(gui.Api)
api._currency_map = {"the-doctor": {"id": "D1", "name": "The Doctor", "cat": "Cards"},
                     "rain-of-chaos": {"id": "R1", "name": "Rain of Chaos", "cat": "Cards"},
                     "divine": {"id": "DV", "name": "Divine Orb", "cat": "Currency"}}
api._feed = Feed()

tmp = tempfile.mkdtemp()
gui.DATA_DIR = tmp
served = {"n": 0}


class Resp:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(req, timeout=0):
    served["n"] += 1
    served["url"] = req.full_url
    served["ua"] = req.headers.get("User-agent")
    return Resp(json.dumps(DROPS).encode())


gui.urllib.request.urlopen = fake_urlopen
r = api.div_cards("Standard")
by = {c["n"]: c for c in r.get("cards", [])}
check("ok, from the backend with our User-Agent", r["ok"] and served["url"] == gui.DIVCARDS_API and
      served["ua"] == gui.UA, (r, served))
check("price each from the exchange feed, joined by name", by["The Doctor"]["c"] == 1500.0 and
      by["The Doctor"]["code"] == "the-doctor", by["The Doctor"])
check("unpriced card has no price but keeps its code", "c" not in by["Rain of Chaos"] and
      by["Rain of Chaos"]["code"] == "rain-of-chaos", by["Rain of Chaos"])
check("card not on the exchange: no code", "code" not in by["Gone"], by["Gone"])
check("divine rate and feed hour", r["divine"] == 200.0 and r["priceHour"] == 1793448000, r)
check("feed asked for card ids + divine for that league", api._feed.asked == ("Standard", ["D1", "DV", "R1"]),
      api._feed.asked)
check("drops kept for 6 hours (second call: no download)", api.div_cards("Standard")["ok"] and served["n"] == 1,
      served["n"])
check("last good copy saved to disk", os.path.exists(os.path.join(tmp, "divcards_cache.json")))


def down(req, timeout=0):
    raise OSError("offline")


gui.urllib.request.urlopen = down
api._divcards_cache = None
r = api.div_cards("Standard")
check("offline: last good copy, marked stale", r["ok"] and r["stale"] and len(r["cards"]) == 123, (r["ok"], len(r.get("cards", []))))
os.remove(os.path.join(tmp, "divcards_cache.json"))
with open(os.path.join(tmp, "divcards.json"), "w", encoding="utf-8") as f:
    json.dump({"source": "shipped", "areas": [], "cards": [{"n": "The Doctor", "s": 8}]}, f)
api._divcards_cache = None
r = api.div_cards("Standard")
check("offline, never downloaded: the copy shipped with the app", r["ok"] and r["source"] == "shipped", r)
os.remove(os.path.join(tmp, "divcards.json"))
api._divcards_cache = None
r = api.div_cards("Standard")
check("offline with nothing at all: quiet error", r["ok"] is False and r["error"], r)


def tiny(req, timeout=0):
    return Resp(json.dumps({"cards": [{"n": "x"}]}).encode())


gui.urllib.request.urlopen = tiny
with open(os.path.join(tmp, "divcards.json"), "w", encoding="utf-8") as f:
    json.dump({"source": "shipped", "areas": [], "cards": [{"n": "The Doctor", "s": 8}]}, f)
api._divcards_cache = None
r = api.div_cards("Standard")
check("a truncated download isn't trusted", r["ok"] and r["source"] == "shipped", r.get("source"))

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
