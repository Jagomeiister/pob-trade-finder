"""Timeless jewel tests — run: python test/test_timeless.py
Downloads the pinned PoB lookup tables on first run (cached in data/timeless_cache)."""
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import timeless  # noqa: E402
from make_timeless import lua_parse, lua_tokens, lua_return_table  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    failures += not ok
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail) if detail else ""))


# Lua table parser (PoB's generated data format)
t = lua_return_table('-- c\nreturn { ["a"] = { [1] = "x", [2] = "y\\"z", }, ["b"] = 3, ["c"] = true, d = -1.5, }')
check("lua: nested arrays, escapes, bools, bare keys", t == {"a": ["x", 'y"z'], "b": 3, "c": True, "d": -1.5}, t)
check("lua: sparse int keys stay a dict", lua_parse(lua_tokens('{ [2] = 1 }'))[0] == {2: 1})

T = timeless.TimelessData(os.path.join(ROOT, "data"), "PoBTradeFinder-tests")
FAMILY = {"2": "karui", "3": "maraketh", "4": "templar", "5": "eternal", "6": "kalguur"}

for jt, prefix in FAMILY.items():
    data = T.lut(jt)
    check(T.d["jewels"][jt]["name"] + ": table is rows x seeds", len(data) == T.d["sizeNotable"] * T.seed_count(jt))
    foreign = []
    for b in set(data):
        b2 = T.d["localToGlobal"].get(jt, {}).get(str(b), b)
        key = ("n" + str(b2 - 337)) if b2 >= 337 else ("a" + str(b2))
        if not T.describe(key)["id"].startswith(prefix):
            foreign.append(key)
    check(T.d["jewels"][jt]["name"] + ": every outcome is a " + prefix + " passive", not foreign, foreign[:3])

# geometry: the Witch elemental-wheel socket covers that wheel's notables and keystones
names = {}
import json  # noqa: E402
with open(os.path.join(ROOT, "data", "tree.min.json"), encoding="utf-8") as f:
    tree = json.load(f)["nodes"]
inf = T.info(3, 61419, [])
nn = {tree[str(n["id"])]["name"] for n in inf["notables"]}
check("radius: socket 61419 holds Heart of Ice and Breath of Rime", {"Heart of Ice", "Breath of Rime"} <= nn, sorted(nn)[:6])
check("radius: socket 61419 reaches Bitter Frost keystone", any(tree[str(k)]["name"] == "Bitter Frost" for k in inf["keystones"]))
check("radius: ~10-30 notables in a Large radius", 10 <= len(inf["notables"]) <= 30, len(inf["notables"]))
try:
    T.in_radius(inf["notables"][0]["id"])  # a notable, not a socket
    check("radius: non-socket node rejected", False)
except ValueError:
    check("radius: non-socket node rejected", True)

# search: weighting one outcome ranks seeds by how many radius notables get it
alloc = [n["id"] for n in inf["notables"]]
target = inf["outcomes"][0]["key"]
res = T.search(3, 61419, alloc, {target: 1}, top=5)
best = res["results"][0]
hits = sum(1 for p in best["notables"] if p["key"] == target)
check("search: best seed's score = count of the weighted outcome", best["score"] == hits, (best["score"], hits))
check("search: results sorted by score", all(a["score"] >= b["score"] for a, b in zip(res["results"], res["results"][1:])))
check("search: seed within Brutal Restraint range", 500 <= best["seed"] <= 8000, best["seed"])
again = T.outcome(3, best["notables"][0]["node"], best["seed"] - 500)
check("search: reported outcome matches a direct lookup", again[0] + str(again[1]) == best["notables"][0]["key"])
only_alloc = T.search(3, 61419, alloc[:2], {target: 1}, top=3)
check("search: only allocated notables count unless asked", len(only_alloc["considered"]) == 2)

# minimum counts ("need Minion Damage x3 AND Aura Effect x2") and avoid weights
second = inf["outcomes"][1]["key"]
need = T.search(3, 61419, alloc, {target: 1, second: 0.5}, mins={target: 3, second: 2}, top=50)
check("mins: every result meets every minimum",
      need["results"] and all(x["counts"].get(target, 0) >= 3 and x["counts"].get(second, 0) >= 2 for x in need["results"]),
      need["matches"])
brute = 0
for s in range(T.seed_count(3)):
    c = {}
    for n in alloc:
        o = T.outcome(3, n, s)
        if o:
            c[o[0] + str(o[1])] = c.get(o[0] + str(o[1]), 0) + 1
    if c.get(target, 0) >= 3 and c.get(second, 0) >= 2:
        brute += 1
check("mins: match count equals a brute-force count", need["matches"] == brute, (need["matches"], brute))
avoid = T.search(3, 61419, alloc, {target: 1, second: -5}, top=10)
check("avoid: top seeds don't carry the avoided outcome", all(x["counts"].get(second, 0) == 0 for x in avoid["results"]))
check("mins: impossible requirement finds nothing", T.search(3, 61419, alloc, {}, mins={target: 99})["matches"] == 0)

# Elegant Hubris seeds are stored /20; real seeds are multiples of 20 in 2000..160000
eh = T.info(5, 61419, alloc)
key = eh["outcomes"][0]["key"]
r = T.search(5, 61419, alloc, {key: 1}, top=3)["results"]
check("hubris: seeds are multiples of 20 in range", all(x["seed"] % 20 == 0 and 2000 <= x["seed"] <= 160000 for x in r),
      [x["seed"] for x in r])

# Glorious Vanity: variable-length table
gv = T.lut("1")
d = T.d
gv_seeds = T.seed_count("1")
check("GV: table = sizes block + every row's bytes",
      len(gv) == d["gvRows"] * gv_seeds + sum(d["gvRowBytes"]), len(gv))
row0 = [gv[i] for i in range(0, gv_seeds)]
check("GV: row 0 seed lengths sum to its declared size", sum(row0) == d["gvRowBytes"][0])
lens = set(gv[r * gv_seeds + s] for r in range(0, d["sizeNotable"], 37) for s in range(0, gv_seeds, 53))
check("GV: notable entries are 3 (replace) or 6/8 (Might/Legacy) bytes", lens <= {3, 6, 8}, sorted(lens))
gv_inf = T.info(1, 61419, [])
check("GV: every outcome is a Vaal passive", all(o["id"].startswith("vaal_") for o in gv_inf["outcomes"]),
      [o["id"] for o in gv_inf["outcomes"] if not o["id"].startswith("vaal_")][:3])
names = {o["dn"] for o in gv_inf["outcomes"]}
check("GV: Might and Legacy of the Vaal both appear", {"Might of the Vaal", "Legacy of the Vaal"} <= names)
gv_alloc = [n["id"] for n in gv_inf["notables"]]
# Might/Legacy entries: bias rule decides which, additions carry rolls
found = None
for s in range(gv_seeds):
    got = T.outcomes_at(1, gv_alloc[0], s)
    if len(got) > 1:
        found = got
        break
check("GV: Might/Legacy entry lists its additions with rolls",
      found and found[0][0] in ("n76", "n77") and all(k.startswith("a") and v > 0 for k, v in found[1:]), found)
gv_need = T.search(1, 61419, gv_alloc[:3], {"n76": 1}, mins={"n76": 2}, top=20)
brute = sum(1 for s in range(gv_seeds)
            if sum(1 for n in gv_alloc[:3] if any(k == "n76" for k, _ in T.outcomes_at(1, n, s))) >= 2)
check("GV: Need x matches a brute-force count", gv_need["matches"] == brute, (gv_need["matches"], brute))
check("GV: results carry roll totals for additions",
      any(x["rollTotals"] for x in T.search(1, 61419, gv_alloc, {"n76": 1}, top=3)["results"]))

# downloads are pinned to PoB's repo and checksummed
for jt in FAMILY:
    info = T.d["jewels"][jt]["lut"]
    check(T.d["jewels"][jt]["name"] + ": pinned PoB URL + sha256",
          info["url"].startswith(timeless.LUT_URL_PREFIX) and T.d["source"]["commit"] in info["url"] and len(info["sha256"]) == 64)
gv_parts = T.d["jewels"]["1"]["lut"]["parts"]
check("Glorious Vanity: all 5 parts pinned + sha256",
      len(gv_parts) == 5 and all(p["url"].startswith(timeless.LUT_URL_PREFIX) and T.d["source"]["commit"] in p["url"]
                                 and len(p["sha256"]) == 64 for p in gv_parts))

print("\n%d FAILED" % failures if failures else "\nALL TESTS PASSED")
sys.exit(1 if failures else 0)
