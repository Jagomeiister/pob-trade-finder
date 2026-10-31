"""Map trade-site currency codes ("divine", "exalted", ...) to game metadata ids.

The trade site prices listings in short codes; GGG's public currency-exchange
feed (web.poecdn.com/api/currency-exchange) keys markets by metadata id
("Metadata/Items/Currency/CurrencyModValues"). This joins the two by item name:
/api/trade/data/static (code, name, image) x RePoE base_items (metadata id, name).

Produces data/currencymap.json (read by the Python bridge):
  { "divine": {"id": "Metadata/...", "name": "Divine Orb", "img": "/gen/image/...", "cat": "Currency"} }

Run: python tools/make_currencymap.py   (needs data/base_items.min.json — make_baseicons.py)
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"


def main():
    req = urllib.request.Request("https://www.pathofexile.com/api/trade/data/static",
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        static = json.loads(r.read().decode("utf-8"))
    with open(os.path.join(DATA, "base_items.min.json"), "r", encoding="utf-8") as f:
        bases = json.load(f)

    by_name = {}
    for meta, b in bases.items():
        if b.get("name"):
            by_name.setdefault(b["name"], []).append(meta)

    out = {}
    for group in static.get("result", []):
        for e in group.get("entries", []):
            code, name = e.get("id"), e.get("text")
            metas = by_name.get(name or "")
            if not code or not metas:
                continue
            # duplicate names (legacy/alt rows): prefer stackable rows (what the currency
            # exchange trades — e.g. DelveStackableSocketableCurrencyReroll1 for chaotic
            # resonators, not the old DelveSocketableCurrency rows), then the Currency
            # path, then shortest
            metas.sort(key=lambda m: ("Stackable" not in (bases[m].get("item_class") or ""),
                                      "/Currency/" not in m, len(m)))
            out[code] = {"id": metas[0], "name": name, "img": e.get("image", ""),
                         "cat": group.get("label") or group.get("id") or ""}

    with open(os.path.join(DATA, "currencymap.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote data/currencymap.json -", len(out), "codes")
    for probe in ("chaos", "divine", "exalted", "mirror"):
        print(" ", probe, "->", (out.get(probe) or {}).get("id"))


if __name__ == "__main__":
    main()
