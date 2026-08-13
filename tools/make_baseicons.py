"""Map item base names -> official CDN art URLs, from RePoE base_items.

Produces data/baseicons.js: window.POE_BASE_ICONS = { "Hubris Circlet": "Art/..png", ... }
Used to show item art on the search cards (PoB builds carry no icons).
Run: python tools/make_baseicons.py [--fetch]
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"

SKIP_CLASSES = {
    "Active Skill Gem", "Support Skill Gem", "Currency", "StackableCurrency",
    "Divination Card", "Map Fragment", "Incubator", "Piece", "Sentinel",
    "Memory Line", "Corpse", "Gold", "Relic", "Sanctum Research",
}


def main():
    fetch = "--fetch" in sys.argv
    path = os.path.join(DATA, "base_items.min.json")
    if fetch or not os.path.exists(path):
        url = "https://repoe-fork.github.io/base_items.min.json"
        print("fetching", url)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            open(path, "wb").write(r.read())
    with open(path, "r", encoding="utf-8") as f:
        bases = json.load(f)

    out = {}
    for b in bases.values():
        name = b.get("name")
        cls = b.get("item_class", "")
        vis = b.get("visual_identity") or {}
        dds = vis.get("dds_file", "")
        if not name or not dds or cls in SKIP_CLASSES:
            continue
        if b.get("release_state") not in ("released", "legacy"):
            continue
        png = dds.replace(".dds", ".png")
        # keep the shortest path per name (some bases have alt art rows)
        if name not in out or len(png) < len(out[name]):
            out[name] = png

    dest = os.path.join(DATA, "baseicons.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_BASE_ICONS = ")
        json.dump(dict(sorted(out.items())), f, separators=(",", ":"))
        f.write(";\n")
    print("wrote", dest, "-", len(out), "bases")
    for probe in ("Hubris Circlet", "Imbued Wand", "Large Cluster Jewel", "Stygian Vise"):
        print(" ", probe, "->", out.get(probe))


if __name__ == "__main__":
    main()
