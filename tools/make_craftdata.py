"""Bundle the mod-rolling data the craft-vs-buy simulator needs (from RePoE).

Produces data/craftdata.js (lazy-loaded by the app on first use):

  window.POE_CRAFT = {
    spawn:  [ [[tag, weight], ...], ... ]   shared spawn-weight lists (first matching tag wins)
    groups: [ "IncreasedLife", ... ]        mod group names (one mod per group per item)
    mods:   [ [affix 0=prefix 1=suffix, [group idx], required level, spawn idx,
               [[trade stat tail, [[lo, hi], ...]], ...], flags], ... ]
             flags: 1 = rolls randomly (chaos/alch pool), 2 = essence-only, 4 = bench craft
    essences: [ [name, trade code, level, {item class: mod idx}], ... ]
    bench:  { mod idx: [[{trade code: amount}, [item classes]], ...] }  (one per bench recipe)
    bases:  { base name: [item class, [tags], influence tag prefix or ""] }
  }

Trade stat values are in the app's "average" space (Adds 10 to 20 -> 15), so the
simulator compares a rolled mod straight against a card's minimum.

Run: python tools/make_craftdata.py   (uses data/*.min.json cached by make_ranges /
make_baseicons; fetches essences + crafting bench options from RePoE)
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
REPOE = "https://repoe-fork.github.io/"

GEAR_CLASSES = {
    "Helmet", "Body Armour", "Gloves", "Boots", "Shield", "Quiver", "Belt", "Amulet", "Ring",
    "Bow", "Claw", "Dagger", "Rune Dagger", "One Hand Axe", "One Hand Mace", "One Hand Sword",
    "Thrusting One Hand Sword", "Sceptre", "Staff", "Warstaff", "Two Hand Axe", "Two Hand Mace",
    "Two Hand Sword", "Wand",
}
INFLUENCE_PREFIXES = {"2h_axe", "2h_mace", "2h_sword", "amulet", "axe", "belt", "body_armour",
                      "boots", "bow", "claw", "dagger", "gloves", "helmet", "mace", "quiver", "ring",
                      "rune_dagger", "sceptre", "shield", "staff", "sword", "wand", "warstaff"}


def load(name, fetch=False):
    path = os.path.join(DATA, name)
    if fetch or not os.path.exists(path):
        req = urllib.request.Request(REPOE + name, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            open(path, "wb").write(r.read())
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def influence_prefix(tags):
    two_hand = "two_hand_weapon" in tags
    for t in tags:
        if two_hand and t in ("axe", "mace", "sword"):
            return "2h_" + t
        if t in INFLUENCE_PREFIXES:
            return t
    return ""


def main():
    fetch = "--fetch" in sys.argv
    mods = load("mods.min.json")
    trans = load("stat_translations.min.json")
    bases = load("base_items.min.json")
    essences = load("essences.min.json", fetch)
    bench = load("crafting_bench_options.min.json", fetch)
    with open(os.path.join(DATA, "currencymap.json"), "r", encoding="utf-8") as f:
        code_of = {v["id"]: k for k, v in json.load(f).items()}

    # stat id -> translation entries carrying a trade stat
    by_stat = {}
    for e in trans:
        if not e.get("trade_stats") or not e.get("ids"):
            continue
        for sid in e["ids"]:
            by_stat.setdefault(sid, []).append(e)

    def trade_values(mod):
        """[[tail, [[lo, hi] per slot]], ...] in the trade site's value space."""
        ranges = {s["id"]: (s["min"], s["max"]) for s in mod.get("stats", [])
                  if s.get("min") is not None and s.get("max") is not None}
        out, seen = [], set()
        for sid in ranges:
            for e in by_stat.get(sid, []):
                key = id(e)
                if key in seen or not all(i in ranges for i in e["ids"]):
                    continue
                seen.add(key)
                ts = next((t for t in e["trade_stats"] if t.get("type") == "explicit"), e["trade_stats"][0])
                tail = ts["id"].split(".", 1)[1]
                handlers = e["English"][0].get("index_handlers") or []
                slots, ok = [], True
                for i, sid2 in enumerate(e["ids"]):
                    lo, hi = float(ranges[sid2][0]), float(ranges[sid2][1])
                    for h in (handlers[i] if i < len(handlers) else []):
                        lo, hi = apply_handler(h, lo), apply_handler(h, hi)
                        if lo is None or hi is None:
                            ok = False
                            break
                    if not ok:
                        break
                    slots.append(sorted((round(lo, 4), round(hi, 4))))
                if ok and slots:
                    out.append([tail, slots])
        return out

    spawn_lists, spawn_idx = [], {}
    group_names, group_idx = [], {}
    out_mods, mod_idx = [], {}

    def add_mod(mod_id, m, flags):
        if mod_id in mod_idx:
            out_mods[mod_idx[mod_id]][5] |= flags
            return mod_idx[mod_id]
        stats = trade_values(m)
        if not stats:
            return None
        sw = [[w["tag"], w["weight"]] for w in m.get("spawn_weights", [])]
        key = json.dumps(sw)
        if key not in spawn_idx:
            spawn_idx[key] = len(spawn_lists)
            spawn_lists.append(sw)
        gis = []
        for g in m.get("groups") or [m.get("type", mod_id)]:
            if g not in group_idx:
                group_idx[g] = len(group_names)
                group_names.append(g)
            gis.append(group_idx[g])
        mod_idx[mod_id] = len(out_mods)
        out_mods.append([0 if m["generation_type"] == "prefix" else 1, gis,
                         m.get("required_level", 1), spawn_idx[key], stats, flags])
        return mod_idx[mod_id]

    for mod_id, m in mods.items():
        if m.get("domain") != "item" or m.get("generation_type") not in ("prefix", "suffix"):
            continue
        if m.get("is_essence_only"):
            continue
        if not any(w["weight"] > 0 for w in m.get("spawn_weights", [])):
            continue
        add_mod(mod_id, m, 1)

    out_ess = []
    for meta, e in essences.items():
        code = code_of.get(meta)
        if not code or e.get("level", 0) < 5:  # Screaming+ reforge rares — lower ones don't
            continue
        per_class = {}
        for cls, mid in (e.get("mods") or {}).items():
            if cls in GEAR_CLASSES and mid in mods:
                i = add_mod(mid, mods[mid], 2)
                if i is not None:
                    per_class[cls] = i
        if per_class:
            out_ess.append([e.get("name", meta), code, e.get("level", 0), per_class])

    out_bench = {}
    for b in bench:
        mid = (b.get("actions") or {}).get("add_explicit_mod")
        if not mid or mid not in mods:
            continue
        classes = [c for c in b.get("item_classes", []) if c in GEAR_CLASSES]
        cost = {}
        for meta, amount in (b.get("cost") or {}).items():
            code = code_of.get(meta)
            if not code:
                cost = None
                break
            cost[code] = amount
        if not classes or cost is None:
            continue
        i = add_mod(mid, mods[mid], 4)
        if i is not None:
            out_bench.setdefault(i, []).append([cost, classes])

    out_bases = {}
    for b in bases.values():
        name, cls = b.get("name"), b.get("item_class")
        if not name or cls not in GEAR_CLASSES or b.get("release_state") not in ("released", "legacy"):
            continue
        tags = b.get("tags") or []
        out_bases[name] = [cls, tags, influence_prefix(tags)]

    payload = {"spawn": spawn_lists, "groups": group_names, "mods": out_mods,
               "essences": out_ess, "bench": out_bench, "bases": out_bases}
    dest = os.path.join(DATA, "craftdata.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_CRAFT = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")
    print("wrote %s - %d mods (%d random, %d essence, %d bench), %d essences, %d bases, %d KB" % (
        dest, len(out_mods), sum(1 for m in out_mods if m[5] & 1), sum(1 for m in out_mods if m[5] & 2),
        sum(1 for m in out_mods if m[5] & 4), len(out_ess), len(out_bases), os.path.getsize(dest) // 1024))


if __name__ == "__main__":
    main()
