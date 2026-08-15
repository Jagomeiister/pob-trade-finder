"""Bundle transfigured-gem type discriminators (GGG /api/trade/data/items).

Transfigured gems ("Frostblink of Wintry Blast") are not standalone item types
on the trade API — searching them as a plain type string returns HTTP 400
"Unknown item base type". They are a base type plus a discriminator:
  {"type": {"option": "Frostblink", "discriminator": "alt_x"}}

Produces data/gemtypes.js:
  window.POE_GEM_TYPES = { "Frostblink of Wintry Blast": {"t": "Frostblink", "d": "alt_x"}, ... }

Run: python tools/make_gemtypes.py
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
    gems = {}
    for section in d.get("result", []):
        if section.get("id") != "gem":
            continue
        for e in section.get("entries", []):
            text, base, disc = e.get("text"), e.get("type"), e.get("disc")
            if text and base and disc:
                gems[text] = {"t": base, "d": disc}
    dest = os.path.join(DATA, "gemtypes.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_GEM_TYPES = ")
        json.dump(gems, f, separators=(",", ":"))
        f.write(";\n")
    print("wrote", dest, "-", len(gems), "discriminated gems")
    probe = gems.get("Frostblink of Wintry Blast")
    print("  probe:", probe == {"t": "Frostblink", "d": "alt_x"})


if __name__ == "__main__":
    main()
