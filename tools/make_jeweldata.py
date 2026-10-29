"""Bundle the data the jewel finder needs.

Produces data/jeweldata.js (lazy-loaded on first use):

  window.POE_JEWELS = {
    bases: ["Crimson Jewel", ... 7 names],          bit i in a mod's mask = base i can roll it
    mods:  [[trade stat tail, trade text, best max roll, base mask, affix 0/1, [tags]], ...]
    tree:  { node id: [flags, name, "stat\nstat"] }  flags: 1 notable, 2 keystone, 4 socket
    masteries: { effect id: "stat\nstat" }
    gems:  { gem name: [tags] }
  }

Sources: RePoE (repoe-fork.github.io) mods / stat_translations / base_items / gems
(cached in data/ by the other tools) and GGG's passive tree export
(github.com/grindinggear/skilltree-export). Roll values are in the app's averaged
trade value space ("Adds 10 to 20" -> 15), matching the cards.

Run: python tools/make_jeweldata.py [--fetch]
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
sys.path.insert(0, HERE)
from make_ranges import apply_handler  # noqa: E402

UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"
TREE_URL = "https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json"
BASES = ["Crimson Jewel", "Viridian Jewel", "Cobalt Jewel",
         "Murderous Eye Jewel", "Searching Eye Jewel", "Hypnotic Eye Jewel", "Ghastly Eye Jewel"]


def fetch_json(url, path, fetch):
    if fetch or not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=180) as r:
            open(path, "wb").write(r.read())
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def spawn_weight(spawn, tags):
    for w in spawn:
        if w["tag"] in tags:
            return w["weight"]
    return 0


def main():
    fetch = "--fetch" in sys.argv
    mods = fetch_json("https://repoe-fork.github.io/mods.min.json", os.path.join(DATA, "mods.min.json"), False)
    trans = fetch_json("https://repoe-fork.github.io/stat_translations.min.json",
                       os.path.join(DATA, "stat_translations.min.json"), False)
    bases = fetch_json("https://repoe-fork.github.io/base_items.min.json",
                       os.path.join(DATA, "base_items.min.json"), False)
    gems = fetch_json("https://repoe-fork.github.io/gems.min.json", os.path.join(DATA, "gems.min.json"), fetch)
    tree = fetch_json(TREE_URL, os.path.join(DATA, "tree.min.json"), fetch)

    base_tags = []
    for name in BASES:
        b = next((v for v in bases.values() if v.get("name") == name), None)
        if not b:
            sys.exit("base missing from RePoE: " + name)
        base_tags.append(set(b.get("tags") or []))

    by_stat = {}
    for e in trans:
        if e.get("trade_stats") and e.get("ids"):
            for sid in e["ids"]:
                by_stat.setdefault(sid, []).append(e)

    def trade_lines(mod):
        ranges = {s["id"]: (s["min"], s["max"]) for s in mod.get("stats", [])
                  if s.get("min") is not None and s.get("max") is not None}
        out, seen = [], set()
        for sid in ranges:
            for e in by_stat.get(sid, []):
                if id(e) in seen or not all(i in ranges for i in e["ids"]):
                    continue
                seen.add(id(e))
                ts = next((t for t in e["trade_stats"] if t.get("type") == "explicit"), e["trade_stats"][0])
                handlers = e["English"][0].get("index_handlers") or []
                his, ok = [], True
                for i, sid2 in enumerate(e["ids"]):
                    lo, hi = float(ranges[sid2][0]), float(ranges[sid2][1])
                    for h in (handlers[i] if i < len(handlers) else []):
                        lo, hi = apply_handler(h, lo), apply_handler(h, hi)
                        if lo is None or hi is None:
                            ok = False
                            break
                    if not ok:
                        break
                    his.append(max(lo, hi))
                if ok and his:
                    out.append((ts["id"].split(".", 1)[1], ts.get("text", ""), sum(his) / len(his)))
        return out

    agg = {}  # (tail, abyss?) -> entry
    for m in mods.values():
        if m.get("domain") not in ("misc", "abyss_jewel") or m.get("generation_type") not in ("prefix", "suffix"):
            continue
        # the domain decides the base family: abyss bases also carry "default",
        # but misc-domain (regular jewel) mods never roll on them, and vice versa
        allowed = range(3, 7) if m["domain"] == "abyss_jewel" else range(0, 3)
        mask = 0
        for i in allowed:
            if spawn_weight(m.get("spawn_weights", []), base_tags[i]) > 0:
                mask |= 1 << i
        if not mask:
            continue
        for tail, text, best in trade_lines(m):
            key = (tail, m["domain"])
            cur = agg.get(key)
            if cur is None:
                agg[key] = cur = {"tail": tail, "text": text, "max": best, "mask": 0,
                                  "affix": 0 if m["generation_type"] == "prefix" else 1,
                                  "tags": set()}
            cur["max"] = max(cur["max"], best)
            cur["mask"] |= mask
            cur["tags"].update(m.get("implicit_tags") or [])
    out_mods = [[e["tail"], e["text"], round(e["max"], 3), e["mask"], e["affix"], sorted(e["tags"])]
                for e in sorted(agg.values(), key=lambda e: (e["mask"] >= 8, e["text"]))]

    out_tree, out_mast = {}, {}
    for nid, n in tree.get("nodes", {}).items():
        flags = (1 if n.get("isNotable") else 0) | (2 if n.get("isKeystone") else 0) | (4 if n.get("isJewelSocket") else 0)
        stats = n.get("stats") or []
        if stats or flags & 4:
            out_tree[nid] = [flags, n.get("name", ""), "\n".join(stats)]
        for eff in n.get("masteryEffects") or []:
            out_mast[str(eff.get("effect"))] = "\n".join(eff.get("stats") or [])

    out_gems = {}
    for g in gems.values():
        name = g.get("display_name") or (g.get("base_item") or {}).get("display_name")
        if name and g.get("tags"):
            out_gems[name] = g["tags"]

    payload = {"bases": BASES, "mods": out_mods, "tree": out_tree, "masteries": out_mast, "gems": out_gems,
               "treeVersion": tree.get("tree", "")}
    dest = os.path.join(DATA, "jeweldata.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_JEWELS = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")
    print("wrote %s - %d jewel mod lines (%d abyss), %d tree nodes, %d mastery effects, %d gems, %d KB" % (
        dest, len(out_mods), sum(1 for m in out_mods if m[3] >= 8), len(out_tree), len(out_mast), len(out_gems),
        os.path.getsize(dest) // 1024))


if __name__ == "__main__":
    main()
