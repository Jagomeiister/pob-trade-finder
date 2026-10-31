"""Chaos <-> divine gap rows — run: python test/test_flips.py

Api.cx_flips turns the latest hour's pair digest into rows for the Market page. Stubbed
feed and currency map; no network."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


class Feed:
    def pairs(self, league):
        return ({"div": 200.0, "items": {
            "ex": {"c": [2.0, 4000, 1.9, 2.1], "d": [0.0125, 3000, 0.012, 0.013]},   # 2c vs 2.5c
            "ann": {"c": [15.0, 5000, 14, 16], "d": [0.06, 6000, 0.06, 0.06]},       # 15c vs 12c
            "chaos_only": {"c": [5.0, 9000, 5, 5]},
            "unmapped": {"c": [1.0, 100, 1, 1], "d": [0.01, 100, 0.01, 0.01]},
        }}, 1793448000)


api = gui.Api.__new__(gui.Api)
api._feed = Feed()
api._currency_map = {"exalted": {"id": "ex", "name": "Exalted Orb", "cat": "Currency", "img": "/e.png"},
                     "exa": {"id": "ex", "name": "Exalted Orb", "cat": "Currency", "img": "/e.png"},
                     "annul": {"id": "ann", "name": "Orb of Annulment", "cat": "Currency", "img": ""},
                     "x": {"id": "chaos_only", "name": "X", "cat": "", "img": ""}}
r = api.cx_flips("L")
rows = {x["code"]: x for x in r["rows"]}
check("ok", r.get("ok"), r)
check("only items in both markets", sorted(rows) == ["annul", "exa"], sorted(rows))
check("duplicate map rows: shortest code", "exa" in rows and "exalted" not in rows)
ex, an = rows["exa"], rows["annul"]
check("divine side converted at the hour's divine rate", abs(ex["viaDiv"] - 2.5) < 1e-9, ex)
check("gap measured from the cheaper market", abs(ex["gap"] - 0.25) < 1e-9 and abs(an["gap"] - 0.25) < 1e-9)
check("buy where it's cheaper", ex["buyWith"] == "chaos" and an["buyWith"] == "divine")
check("volume = the thinner market", ex["volume"] == 3000 and an["volume"] == 5000)
check("ranges passed through", ex["cRange"] == [1.9, 2.1] and ex["dRange"] == [0.012, 0.013])

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
