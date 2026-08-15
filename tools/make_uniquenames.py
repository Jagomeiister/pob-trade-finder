"""Bundle the trade site's unique-name list (GGG /api/trade/data/items).

Produces data/uniquenames.js: window.POE_UNIQUE_NAMES = { "The Red Nightmare": 1, ... }
Used to resolve prefixed/renamed unique names ("Foulborn The Red Nightmare")
to the exact name the trade API requires.

Run: python tools/make_uniquenames.py
"""
import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"


def main():
    req = urllib.request.Request("https://www.pathofexile.com/api/trade/data/items",
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8"))
    names = {}
    for section in d.get("result", []):
        for e in section.get("entries", []):
            n = e.get("name")
            if n:
                names[n] = 1
    dest = os.path.join(DATA, "uniquenames.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_UNIQUE_NAMES = ")
        json.dump(names, f, separators=(",", ":"))
        f.write(";\n")
    print("wrote", dest, "-", len(names), "unique names")
    print("  probe:", "The Red Nightmare" in names)


if __name__ == "__main__":
    main()
