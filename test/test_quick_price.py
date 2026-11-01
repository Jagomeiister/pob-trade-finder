"""Quick price (no trade-site call) — run: python test/test_quick_price.py

Api.quick_price: exchange items from GGG's feed by name (with stack value); uniques and
gems matched against the backend's poe.ninja snapshot. Stubbed feed + backend; no network."""
import json
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
    def rates(self, league, ids):
        return {"C": 1.0, "D": 200.0, "S": 0.5}, 1793448000


NINJA = {"types": {
    "UniqueAccessory": {"lines": [{"n": "Headhunter", "b": "Leather Belt", "c": 4500, "d": 22.5, "lc": 470}]},
    "UniqueArmour": {"lines": [{"n": "Tabula Rasa", "c": 10, "lc": 300},
                               {"n": "Shavronne's Wrappings", "c": 50, "lc": 40},
                               {"n": "Shavronne's Wrappings", "c": 900, "l": 6, "lc": 5}]},
    "SkillGem": {"lines": [{"n": "Vaal Grace", "gl": 21, "gq": 20, "cr": 1, "c": 120},
                           {"n": "Vaal Grace", "gl": 21, "gq": 23, "cr": 1, "c": 300},
                           {"n": "Vaal Grace", "gl": 20, "gq": 20, "c": 5},
                           {"n": "Enlighten Support", "gl": 3, "c": 2000}]},
}}

api = gui.Api.__new__(gui.Api)
api._currency_map = {"chaos": {"id": "C", "name": "Chaos Orb"}, "divine": {"id": "D", "name": "Divine Orb"},
                     "scour": {"id": "S", "name": "Orb of Scouring", "cat": "Currency"}}
api._feed = Feed()
api._ninja_prices = lambda league: NINJA


def qp(**item):
    return api.quick_price("L", json.dumps(item))


r = qp(name="Orb of Scouring", rarity="CURRENCY", stackSize=40)
check("currency from the exchange feed", r["ok"] and r["source"] == "GGG currency exchange" and r["chaos"] == 0.5, r)
check("stack value", r["stack"] == 40 and r["stackChaos"] == 20, r)
check("divine equivalent", abs(qp(name="Chaos Orb", rarity="CURRENCY")["divine"] - 0.005) < 1e-9)
r = qp(name="Headhunter", base="Leather Belt", rarity="UNIQUE")
check("unique from poe.ninja", r["ok"] and r["source"] == "poe.ninja" and r["chaos"] == 4500 and r["listings"] == 470, r)
check("6-link unique priced as 6-link", qp(name="Shavronne's Wrappings", rarity="UNIQUE", links=6)["chaos"] == 900)
check("unlinked unique not priced as 6-link", qp(name="Shavronne's Wrappings", rarity="UNIQUE", links=4)["chaos"] == 50)
check("gem: level + corruption + best quality not above yours",
      qp(name="Vaal Grace", rarity="GEM", gemLevel=21, quality=22, corrupted=True)["chaos"] == 120)
check("gem: 23% quality gets the 23% price",
      qp(name="Vaal Grace", rarity="GEM", gemLevel=21, quality=23, corrupted=True)["chaos"] == 300)
check("gem: uncorrupted 20/20", qp(name="Vaal Grace", rarity="GEM", gemLevel=20, quality=20)["chaos"] == 5)
check("gem: no line for that level -> no price", not qp(name="Vaal Grace", rarity="GEM", gemLevel=19, quality=0)["ok"])
check("rare items are not quick-priced", not qp(name="Doom Loop", base="Two-Stone Ring", rarity="RARE")["ok"])


def broken(league):
    raise RuntimeError("HTTP Error 404: Not Found")


api._ninja_prices = broken
r = qp(name="Headhunter", rarity="UNIQUE")
check("backend down: quiet failure", r["ok"] is False and "404" in r["error"], r)
check("backend down: exchange items still priced", qp(name="Chaos Orb", rarity="CURRENCY")["ok"])
check("exchange answer carries the trade code", qp(name="Orb of Scouring", rarity="CURRENCY")["code"] == "scour")
check("exchange answer carries its category (trade ledger: currency swaps)",
      qp(name="Orb of Scouring", rarity="CURRENCY").get("cat") == "Currency")

# live bulk exchange: one request, cheapest chaos-each first, divine offers converted
sent = []


def fake_http(url, payload, *a, **k):
    sent.append((url, payload))
    return {"total": 3, "result": {
        "a": {"listing": {"account": {"name": "Pricey#1", "online": {}},
                          "offers": [{"exchange": {"currency": "chaos", "amount": 12}, "item": {"amount": 20, "stock": 99}}]}},
        "b": {"listing": {"account": {"name": "Div#2", "online": {"status": "afk"}},
                          "offers": [{"exchange": {"currency": "divine", "amount": 1}, "item": {"amount": 500, "stock": 900}}]}},
        "c": {"listing": {"account": {"name": "Broken#3"}, "offers": [{"exchange": {}, "item": {}}]}}}}


api._http = fake_http
api._divine_rate = lambda league: 200.0
r = api.bulk_exchange("Some League", "scour")
check("bulk exchange: one request to the exchange endpoint", len(sent) == 1 and sent[0][0].endswith("/exchange/Some%20League")
      and sent[0][1]["query"]["want"] == ["scour"] and sent[0][1]["query"]["have"] == ["chaos", "divine"], sent)
check("bulk exchange: cheapest first, divine converted", [o["seller"] for o in r["offers"]] == ["Div#2", "Pricey#1"]
      and abs(r["offers"][0]["chaosEach"] - 0.4) < 1e-9 and r["offers"][1]["chaosEach"] == 0.6, r)
check("bulk exchange: afk + stock carried", r["offers"][0]["afk"] and r["offers"][0]["stock"] == 900, r["offers"][0])
check("bulk exchange: refuses non-exchange items", not api.bulk_exchange("L", "nonsense")["ok"] and len(sent) == 1)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
