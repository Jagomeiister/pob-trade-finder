"""Skill tree view data — run: python test/test_treeview.py

data/treeview.js (tools/make_treeview.py) against the timeless finder's geometry
(data/timeless.json, PoB's orbit maths in tools/make_timeless.py), plus structural checks on
the links, and the get_character_passives bridge with a stubbed profile response. When the
tree export cache (data/tree.min.json) is present it also checks the shipped file is fresh."""
import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import make_treeview  # noqa: E402
from make_timeless import geometry  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    failures += not ok
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail) if detail and not ok else ""))


path = os.path.join(ROOT, "data", "treeview.js")
src = open(path, encoding="utf-8").read()
check("treeview.js assigns window.POE_TREE_VIEW", "window.POE_TREE_VIEW = {" in src)
TV = json.loads(src[src.index("{"):src.rindex("}") + 1])
size = os.path.getsize(path)
check("treeview.js stays small (< 1.5 MB)", size < 1.5 * 1024 * 1024, size)

nodes = {n[0]: n for n in TV["nodes"]}
check("thousands of nodes", 2500 < len(nodes) < 4000, len(nodes))
kinds = {}
for n in TV["nodes"]:
    kinds[n[3]] = kinds.get(n[3], 0) + 1
check("every node kind present", all(kinds.get(k) for k in range(7)), kinds)
check("7 class starts", kinds.get(5) == 7, kinds.get(5))

# positions match the timeless finder's geometry (same PoB maths, independent output)
geo = json.load(open(os.path.join(ROOT, "data", "timeless.json"), encoding="utf-8"))["geometry"]
off = [nid for nid, (x, y, _) in geo.items() if int(nid) not in nodes or
       abs(nodes[int(nid)][1] - x) > 1 or abs(nodes[int(nid)][2] - y) > 1]
check("positions match make_timeless geometry (%d nodes)" % len(geo), len(geo) > 1500 and not off, off[:5])
# a known node: Witch class start sits at its group centre (orbit 0)
witch = next(c for c in TV["classes"] if c["name"] == "Witch")
check("Witch start is a class start node", nodes[witch["start"]][3] == 5 and nodes[witch["start"]][4] == "Witch")

# 16- and 40-slot orbits use PoB's angle tables, not even spacing
a16 = make_treeview.orbit_angles(16)
check("16-slot orbit: 45 degree slot at index 2", abs(math.degrees(a16[2]) - 45) < 1e-9, a16[:3])
a40 = make_treeview.orbit_angles(40)
check("40-slot orbit: 45 degree slot at index 5", abs(math.degrees(a40[5]) - 45) < 1e-9)

# links
edges = list(zip(TV["edges"][0::2], TV["edges"][1::2]))
arcs = [TV["arcs"][i:i + 5] for i in range(0, len(TV["arcs"]), 5)]
check("link counts sane", 1000 < len(edges) < 3000 and 1000 < len(arcs) < 3000, (len(edges), len(arcs)))
ends = [e for e in edges + [tuple(a[:2]) for a in arcs] if e[0] not in nodes or e[1] not in nodes]
check("every link joins two known nodes", not ends, ends[:3])
into_mastery = [e for e in edges + [tuple(a[:2]) for a in arcs] if nodes[e[0]][3] == 3 or nodes[e[1]][3] == 3]
check("no drawn links into masteries", not into_mastery, into_mastery[:3])


def asc(n):
    return n[6] if len(n) > 6 else -1


mixed = [e for e in edges + [tuple(a[:2]) for a in arcs] if asc(nodes[e[0]]) != asc(nodes[e[1]])]
check("no links between the main tree and an ascendancy", not mixed, mixed[:3])
bad_arc = [a for a in arcs if any(abs(math.hypot(nodes[a[k]][1] - a[2], nodes[a[k]][2] - a[3]) - a[4]) > 2 for k in (0, 1))]
check("arc ends lie on their orbit around the group centre", not bad_arc, bad_arc[:3])
pairs = [tuple(sorted(e)) for e in edges + [tuple(a[:2]) for a in arcs]]
check("no duplicate links", len(pairs) == len(set(pairs)))

# ascendancies, masteries, jewel slots
ids = {a["id"] for a in TV["ascendancies"]}
check("class ascendancies listed", all(x in ids for c in TV["classes"] for x in c["asc"]) and "Elementalist" in ids)
starts = {asc(n) for n in TV["nodes"] if n[3] == 6}
check("every ascendancy with nodes has a start node", {asc(n) for n in TV["nodes"] if asc(n) >= 0} <= starts)
missing_fx = [e for fx in TV["masteries"].values() for e in fx if str(e) not in TV["masteryEffects"]]
check("every mastery effect has its text", len(TV["masteries"]) > 200 and not missing_fx, missing_fx[:3])
check("mastery links point at masteries", all(nodes[m][3] == 3 for m in TV["masteryLinks"][0::2]))
check("jewel slots are socket nodes", TV["jewelSlots"] and all(nodes.get(s, [0, 0, 0, -1])[3] == 4 for s in TV["jewelSlots"]),
      [s for s in TV["jewelSlots"] if nodes.get(s, [0, 0, 0, -1])[3] != 4][:3])
b = TV["bounds"]
check("bounds cover the main tree only", b[0] < -7000 and b[2] > 7000 and
      all(b[0] <= n[1] <= b[2] and b[1] <= n[2] <= b[3] for n in TV["nodes"] if asc(n) < 0 and not (len(n) > 7 and n[7] & 1)), b)

# passive icons: sprite sheets the art cache may fetch, each icon node's x, y in them
ic = TV.get("icons") or {}
check("icons: active + inactive sheets on GGG's CDN (the art cache allowlist)",
      all(str(ic.get(k, "")).startswith("https://web.poecdn.com/image/passive-skill/") for k in ("active", "inactive")) and
      ic["active"] != ic["inactive"], {k: ic.get(k) for k in ("active", "inactive")})
check("icons: one size per kind (small, notable, keystone), growing",
      len(ic.get("size") or []) == 3 and all(s and s[0] > 10 and s[1] > 10 for s in ic["size"]) and
      ic["size"][0][0] < ic["size"][1][0] < ic["size"][2][0], ic.get("size"))
at = ic.get("at") or []
check("icons: x, y per node, aligned with nodes", len(at) == 2 * len(TV["nodes"]), (len(at), len(TV["nodes"])))
no_icon = [n[0] for i, n in enumerate(TV["nodes"]) if n[3] <= 2 and at[2 * i] < 0]
check("icons: every small node, notable and keystone has one", not no_icon, no_icon[:5])
odd = [n[0] for i, n in enumerate(TV["nodes"]) if n[3] > 2 and at[2 * i] != -1]
check("icons: masteries, sockets and starts have none (-1)", not odd, odd[:5])
check("icons: coords are non-negative integers", all(isinstance(v, int) and (v >= 0 or v == -1) for v in at))

# the shipped file matches a fresh build from the cached export (skipped without the cache)
tree_path = os.path.join(ROOT, "data", "tree.min.json")
if os.path.exists(tree_path):
    tree = json.load(open(tree_path, encoding="utf-8"))
    fresh = make_treeview.build(tree)
    check("treeview.js is up to date with data/tree.min.json", fresh == TV,
          "run python tools/make_treeview.py")
    zooms = tree["sprites"]["notableActive"]
    check("icons: from the largest zoom level", ic["zoom"] == max(float(z) for z in zooms), ic["zoom"])
    sheet = next(v for z, v in zooms.items() if float(z) == ic["zoom"])
    outside = []
    for i, n in enumerate(TV["nodes"]):
        if at[2 * i] >= 0:
            w, h = ic["size"][n[3]]
            if at[2 * i] + w > sheet["w"] or at[2 * i + 1] + h > sheet["h"]:
                outside.append(n[0])
    check("icons: every icon lies inside its %dx%d sheet" % (sheet["w"], sheet["h"]), not outside, outside[:5])
    g = geometry(tree)
    check("make_timeless geometry and make_treeview agree on every shared node",
          all(abs(nodes[int(k)][1] - v[0]) <= 1 and abs(nodes[int(k)][2] - v[1]) <= 1 for k, v in g.items()))
else:
    print("SKIP freshness check (no data/tree.min.json; run tools/make_jeweldata.py)")

# bridge: get_character_passives normalizes the profile response
import gui  # noqa: E402

api = gui.Api.__new__(gui.Api)
asked = []


def fake(path, params):
    asked.append((path, params))
    return {"hashes": [7918, 39841, "x"], "hashes_ex": [65552], "mastery_effects": {"62416": 50863},
            "items": [{"x": 3, "name": "Foo", "typeLine": "Crimson Jewel", "frameType": 2,
                       "explicitMods": [{"description": "+10 to maximum Life", "flags": {}}]}]}


api._char_get = fake
r = api.get_character_passives("Name#1234", "Char")
check("bridge: one profile call with account + character",
      asked == [("get-passive-skills", {"accountName": "Name#1234", "character": "Char", "realm": "pc"})], asked)
check("bridge: hashes / hashesEx / masteries / jewels", r.get("ok") and r["hashes"] == [7918, 39841] and
      r["hashesEx"] == [65552] and r["masteries"] == {"62416": 50863} and r["jewels"][0]["x"] == 3 and
      r["jewels"][0]["explicitMods"] == ["+10 to maximum Life"], r)


def boom(path, params):
    raise RuntimeError("profile is private")


api._char_get = boom
r = api.get_character_passives("Name#1234", "Char")
check("bridge: errors come back as {ok: false}", r == {"ok": False, "error": "profile is private"}, r)

print("\n" + ("%d FAILED" % failures if failures else "ALL TESTS PASSED"))
sys.exit(1 if failures else 0)
