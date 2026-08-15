"""Map trade stat ids to their eldritch implicit source (Searing Exarch /
Eater of Worlds) so the UI can tint each implicit precisely.

Produces data/eldritch.js: window.POE_ELDRITCH = { "stat_123": "exarch"|"eater"|"both" }
(keys are bare stat tails — matched against both search-card entry ids and
listing mod hashes).

Run: python tools/make_eldritch.py [--fetch]   (uses the RePoE downloads)
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
SCRATCH_CANDIDATES = [
    DATA,
    os.environ.get("REPOE_DIR", ""),
    r"C:\Users\jorda\AppData\Local\Temp\claude\E--Claude-POE-Build-gear-search\2115e1c4-1bb0-46e7-9a68-59fb93640456\scratchpad",
]
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"


def load(name, fetch):
    for base in SCRATCH_CANDIDATES:
        if base and os.path.exists(os.path.join(base, name)):
            with open(os.path.join(base, name), "r", encoding="utf-8") as f:
                return json.load(f)
    url = "https://repoe-fork.github.io/" + name
    print("fetching", url)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    path = os.path.join(DATA, name)
    with open(path, "wb") as f:
        f.write(data)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    fetch = "--fetch" in sys.argv
    mods = load("mods.min.json", fetch)
    trans = load("stat_translations.min.json", fetch)

    # internal stat id -> eldritch source(s)
    sources = {}
    for mod in mods.values():
        gt = mod.get("generation_type")
        src = {"searing_exarch_implicit": "exarch", "eater_of_worlds_implicit": "eater"}.get(gt)
        if not src:
            continue
        for st in mod.get("stats", []):
            sid = st.get("id")
            if sid:
                sources.setdefault(sid, set()).add(src)

    # translate to trade stat tails
    out = {}
    for entry in trans:
        hit = set()
        for sid in entry.get("ids", []):
            hit |= sources.get(sid, set())
        if not hit:
            continue
        for ts in entry.get("trade_stats", []):
            tid = ts.get("id", "")
            if not tid or tid.startswith("pseudo."):
                continue
            tail = tid.split(".").pop().split("|")[0]
            prev = out.get(tail)
            label = "both" if len(hit) > 1 else next(iter(hit))
            if prev and prev != label:
                out[tail] = "both"
            else:
                out[tail] = label

    dest = os.path.join(DATA, "eldritch.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_ELDRITCH = ")
        json.dump(dict(sorted(out.items())), f, separators=(",", ":"))
        f.write(";\n")
    from collections import Counter
    print("wrote", dest, "-", len(out), "stats:", Counter(out.values()))


if __name__ == "__main__":
    main()
