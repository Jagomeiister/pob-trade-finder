"""Harvest unique-item roll ranges from Path of Building Community's data.

Produces data/uniqueranges.js:
  window.POE_UNIQUE_RANGES = { "The Red Nightmare": { "<normalized mod>": [lo, hi] } }
Keys are matcher-normalized mod texts (digits -> #), values avg-space bounds,
merged (widest) across variants. Lets the app show and enforce roll ranges on
uniques imported with concrete values.

Run: python tools/make_uniqueranges.py
"""
import json
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"
API = "https://api.github.com/repos/PathOfBuildingCommunity/PathOfBuilding/contents/src/Data/Uniques"

RANGE = re.compile(r"\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)")
META = ("Source:", "League:", "Requires ", "Implicits:", "Variant:", "Selected Variant",
        "Has Alt Variant", "Alt Variant", "Upgrade:", "Limited to:", "Radius:",
        "Sockets:", "Item Level:", "LevelReq:", "Talisman Tier", "Grants Skill:",
        "Integrated:", "Cluster Jewel", "Prophecy:")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def normalize(text):
    return re.sub(r"\s+", " ", re.sub(r"\d+(\.\d+)?", "#", text.lower())).strip()


def main():
    listing = json.loads(fetch(API))
    out = {}
    items = 0
    for f in listing:
        if not f["name"].endswith(".lua"):
            continue
        src = fetch(f["download_url"])
        for block in re.findall(r"\[\[(.*?)\]\]", src, re.S):
            lines = [l.strip() for l in block.strip().split("\n") if l.strip()]
            if len(lines) < 2:
                continue
            name = lines[0]
            items += 1
            mods = out.setdefault(name, {})
            for line in lines[1:]:
                line = re.sub(r"^\{[^}]*\}", "", line).strip()
                while line.startswith("{"):
                    m2 = re.match(r"^\{[^}]*\}", line)
                    if not m2:
                        break
                    line = line[m2.end():].strip()
                if not line or any(line.startswith(p) for p in META):
                    continue
                pairs = RANGE.findall(line)
                if not pairs:
                    continue
                lows = [float(a) for a, b in pairs]
                highs = [float(b) for a, b in pairs]
                lo = sum(lows) / len(lows)
                hi = sum(highs) / len(highs)
                if lo > hi:
                    lo, hi = hi, lo
                # normalize the template: (a-b) -> # first, then stray digits
                key = normalize(RANGE.sub("#", line))
                prev = mods.get(key)
                if prev:  # merge across variants: widest window
                    mods[key] = [min(prev[0], lo), max(prev[1], hi)]
                else:
                    mods[key] = [round(lo, 2), round(hi, 2)]
    out = {k: v for k, v in out.items() if v}
    dest = os.path.join(DATA, "uniqueranges.js")
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write("window.POE_UNIQUE_RANGES = ")
        json.dump(out, fh, separators=(",", ":"))
        fh.write(";\n")
    size = os.path.getsize(dest)
    print("wrote", dest, "- %d uniques with ranges (of %d items), %.0f KB" % (len(out), items, size / 1024))
    probe = out.get("Shavronne's Wrappings", {})
    print("  Shavronne's:", list(probe.items())[:2])


if __name__ == "__main__":
    main()
