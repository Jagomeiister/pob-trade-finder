"""Distil RePoE mod data into per-trade-stat roll ranges.

Produces data/ranges.js: window.POE_RANGES = { "explicit.stat_X": [min, max] }
where min/max span every tier of every rollable mod that carries the stat
(prefix/suffix/corrupted, item + jewel + flask + bench-craft domains).
Values are in "average" space to match the app's min inputs (multi-magnitude
stats like "Adds # to #" use the mean of their magnitudes).

Inputs are fetched from https://repoe-fork.github.io/ (mods.min.json,
stat_translations.min.json). Run: python tools/make_ranges.py [--fetch]
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"

DOMAINS = {"item", "abyss_jewel", "flask", "misc", "affliction_jewel", "crafted", "unveiled", "veiled"}
GEN_TYPES = {"prefix", "suffix", "corrupted"}

# index handlers we know how to apply to a raw stat value
def apply_handler(name, v):
    if name == "negate":
        return -v
    if name in ("divide_by_one_hundred", "divide_by_one_hundred_2dp",
                "divide_by_one_hundred_2dp_if_required"):
        return v / 100.0
    if name in ("per_minute_to_per_second", "per_minute_to_per_second_2dp",
                "per_minute_to_per_second_2dp_if_required",
                "per_minute_to_per_second_0dp"):
        return v / 60.0
    if name == "divide_by_ten_0dp" or name == "divide_by_ten_1dp" or name == "divide_by_ten_1dp_if_required":
        return v / 10.0
    if name == "divide_by_two_0dp":
        return v / 2.0
    if name == "divide_by_six":
        return v / 6.0
    if name == "divide_by_twelve":
        return v / 12.0
    if name == "divide_by_fifteen_0dp":
        return v / 15.0
    if name == "divide_by_twenty_then_double_0dp":
        return v / 10.0
    if name == "divide_by_one_thousand":
        return v / 1000.0
    if name == "milliseconds_to_seconds" or name.startswith("milliseconds_to_seconds"):
        return v / 1000.0
    if name in ("30%_of_value", ):
        return v * 0.3
    if name in ("60%_of_value", ):
        return v * 0.6
    if name == "multiply_by_four":
        return v * 4.0
    if name == "times_twenty":
        return v * 20.0
    if name == "times_one_point_five":
        return v * 1.5
    if name in ("canonical_stat", "mod_value_to_item_class", "display_indexable_support",
                "relic_mod_value_to_item_class", "passive_hash", "affliction_reward_type"):
        return None  # not numeric-mappable
    if name == "":
        return v
    return None  # unknown handler -> skip this stat


def load(name, fetch):
    path = os.path.join(SCRATCH, name)
    alt = os.path.join(os.environ.get("REPOE_DIR", ""), name) if os.environ.get("REPOE_DIR") else None
    if alt and os.path.exists(alt):
        path = alt
    if fetch or not os.path.exists(path):
        url = "https://repoe-fork.github.io/" + name
        print("fetching", url)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        with open(path, "wb") as f:
            f.write(data)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    fetch = "--fetch" in sys.argv
    mods = load("mods.min.json", fetch)
    trans = load("stat_translations.min.json", fetch)

    # 1) per internal stat id: min/max across all rollable tiers
    stat_range = {}
    for mod in mods.values():
        if mod.get("domain") not in DOMAINS:
            continue
        if mod.get("generation_type") not in GEN_TYPES:
            continue
        for st in mod.get("stats", []):
            sid, lo, hi = st.get("id"), st.get("min"), st.get("max")
            if sid is None or lo is None or hi is None:
                continue
            cur = stat_range.get(sid)
            if cur is None:
                stat_range[sid] = [lo, hi]
            else:
                cur[0] = min(cur[0], lo)
                cur[1] = max(cur[1], hi)

    # 2) map to trade stat ids via translations
    out = {}
    for entry in trans:
        ids = entry.get("ids", [])
        trade_stats = entry.get("trade_stats", [])
        english = entry.get("English", [])
        if not ids or not trade_stats or not english:
            continue
        handlers = english[0].get("index_handlers", [[]])
        per_slot = []
        ok = True
        for i, sid in enumerate(ids):
            rng = stat_range.get(sid)
            if rng is None:
                ok = False
                break
            lo, hi = float(rng[0]), float(rng[1])
            hs = handlers[i] if i < len(handlers) else []
            for h in hs:
                lo2 = apply_handler(h, lo)
                hi2 = apply_handler(h, hi)
                if lo2 is None or hi2 is None:
                    ok = False
                    break
                lo, hi = lo2, hi2
            if not ok:
                break
            per_slot.append(sorted((lo, hi)))
        if not ok or not per_slot:
            continue
        # avg-space bounds to match the app's averaged min inputs
        lo_avg = sum(r[0] for r in per_slot) / len(per_slot)
        hi_avg = sum(r[1] for r in per_slot) / len(per_slot)
        if lo_avg == hi_avg:
            continue  # fixed stat — nothing to clamp
        for ts in trade_stats:
            tid = ts.get("id", "")
            if not tid or tid.startswith("pseudo."):
                continue  # pseudo totals sum several mods — never clamp
            cur = out.get(tid)
            if cur is None:
                out[tid] = [lo_avg, hi_avg]
            else:
                cur[0] = min(cur[0], lo_avg)
                cur[1] = max(cur[1], hi_avg)

    def r2(v):
        return round(v, 2)

    out = {k: [r2(v[0]), r2(v[1])] for k, v in sorted(out.items())}
    dest = os.path.join(SCRATCH, "ranges.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write("window.POE_RANGES = ")
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")
    print("wrote", dest, "-", len(out), "trade stats with ranges")
    for probe in ("explicit.stat_3299347043", "explicit.stat_3372524247", "explicit.stat_2974417149"):
        print(" ", probe, out.get(probe))


if __name__ == "__main__":
    main()
