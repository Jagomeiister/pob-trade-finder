"""Bundle timeless-jewel data (Lethal Pride, Brutal Restraint, Militant Faith,
Elegant Hubris, Heroic Tragedy) for the timeless jewel finder.

Source: Path of Building Community (MIT, (c) David Gowor and contributors),
src/Data/TimelessJewelData — the per-jewel lookup tables (LUTs), the alternate
("legion") passive definitions and the node index mapping. Pinned to one PoB
commit; the LUTs themselves are NOT shipped — the app downloads them on first
use from that exact commit and checks their sha256 against this file.

Produces data/timeless.json:
  {
    "source": {"repo", "commit"},
    "jewels": {type: {name, seedMin, seedMax, seedStep, conquerors, small, lut: {file, sha256, size, url}}},
    "additions": [{id, dn, sd}],      LUT byte < 337 -> additions[byte]
    "nodes": [{id, dn, sd, ks}],      LUT byte >= 337 -> nodes[byte - 337]
    "nodeIndex": {node id: LUT row}, "sizeNotable": n,
    "localToGlobal": {type: {local id: global id}},
    "geometry": {node id: [x, y, kind]}   kind 0 small, 1 notable, 2 keystone, 3 socket
  }

Run: python tools/make_timeless.py            (uses the pinned commit)
     python tools/make_timeless.py --update   (re-pin to PoB master)
"""
import hashlib
import json
import math
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"
REPO = "PathOfBuildingCommunity/PathOfBuilding"
PINNED_COMMIT = "b32759ab0f31a1c8499a0d420cb0f0633d4fe478"
ADDITIONS = 337  # PoB data.timelessJewelAdditions
TIMELESS_RADIUS = 1800  # "Large" on 3.16+ trees

# PoB jewel type ids; Glorious Vanity (1) uses a different, 22 MB variable-length LUT
JEWELS = {
    2: {"name": "Lethal Pride", "file": "LethalPride", "seedMin": 10000, "seedMax": 18000, "step": 1,
        "conquerors": ["kaom", "rakiata", "akoya", "kiloava"], "small": "+4 to Strength (+2 on attribute passives)"},
    3: {"name": "Brutal Restraint", "file": "BrutalRestraint", "seedMin": 500, "seedMax": 8000, "step": 1,
        "conquerors": ["asenath", "nasima", "balbala", "deshret"], "small": "+4 to Dexterity (+2 on attribute passives)"},
    4: {"name": "Militant Faith", "file": "MilitantFaith", "seedMin": 2000, "seedMax": 10000, "step": 1,
        "conquerors": ["avarius", "maxarius", "dominus", "venarius"], "small": "+5 to Devotion (attribute passives become Devotion)"},
    5: {"name": "Elegant Hubris", "file": "ElegantHubris", "seedMin": 100, "seedMax": 8000, "step": 20,
        "conquerors": ["cadiro", "victario", "caspiro", "chitus"], "small": "small passives grant nothing"},
    6: {"name": "Heroic Tragedy", "file": "HeroicTragedy", "seedMin": 100, "seedMax": 8000, "step": 1,
        "conquerors": ["vorana", "uhtred", "medved"], "small": "2% increased Ward (1% on attribute passives)"},
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


# ---- minimal Lua table-constructor parser (PoB's generated data files) --------
TOKEN = re.compile(r'\s+|--[^\n]*|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_]\w*|[{}\[\]=,;]')


def lua_tokens(text):
    pos = 0
    out = []
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            raise ValueError("unexpected character at %d: %r" % (pos, text[pos:pos + 20]))
        tok = m.group(0)
        pos = m.end()
        if tok.isspace() or tok.startswith("--"):
            continue
        out.append(tok)
    return out


def lua_parse(tokens, i=0):
    tok = tokens[i]
    if tok == "{":
        i += 1
        arr, obj, n = [], {}, 0
        while tokens[i] != "}":
            if tokens[i] == "[":
                key, i = lua_parse(tokens, i + 1)
                assert tokens[i] == "]" and tokens[i + 1] == "=", tokens[i:i + 3]
                val, i = lua_parse(tokens, i + 2)
                obj[key] = val
            elif re.match(r"[A-Za-z_]", tokens[i]) and tokens[i + 1] == "=":
                key = tokens[i]
                val, i = lua_parse(tokens, i + 2)
                obj[key] = val
            else:
                val, i = lua_parse(tokens, i)
                n += 1
                obj[n] = val
            if tokens[i] in (",", ";"):
                i += 1
        # 1..n integer keys -> list
        if obj and all(isinstance(k, int) for k in obj) and sorted(obj) == list(range(1, len(obj) + 1)):
            return [obj[k] for k in range(1, len(obj) + 1)], i + 1
        return obj, i + 1
    if tok.startswith('"'):
        return json.loads(tok), i + 1
    if tok in ("true", "false"):
        return tok == "true", i + 1
    if tok == "nil":
        return None, i + 1
    if re.match(r"-?\d", tok):
        return (float(tok) if any(c in tok for c in ".eE") else int(tok)), i + 1
    raise ValueError("unexpected token %r" % tok)


def lua_return_table(text):
    tokens = lua_tokens(text)
    i = tokens.index("return") + 1
    val, _ = lua_parse(tokens, i)
    return val


def parse_node_index(text):
    index, l2g = {}, {}
    size_notable = int(re.search(r'nodeIDList\["sizeNotable"\]\s*=\s*(\d+)', text).group(1))
    for m in re.finditer(r"nodeIDList\[(\d+)\]\s*=\s*\{\s*index\s*=\s*(\d+)", text):
        index[m.group(1)] = int(m.group(2))
    for m in re.finditer(r'nodeIDList\["localIdToGlobalId"\]\[(\d+)\]\[(\d+)\]\s*=\s*(\d+)', text):
        l2g.setdefault(m.group(1), {})[m.group(2)] = int(m.group(3))
    return index, size_notable, l2g


def geometry(tree):
    """node id -> [x, y, kind] using PoB's PassiveTree position maths."""
    c = tree["constants"]
    per_orbit, radii = c["skillsPerOrbit"], c["orbitRadii"]

    def angles(n):
        if n == 16:
            deg = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330]
        elif n == 40:
            deg = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170,
                   180, 190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350]
        else:
            deg = [360 * i / n for i in range(n)]
        return [math.radians(d) for d in deg]

    orbit_angles = [angles(n) for n in per_orbit]
    out = {}
    for nid, n in tree["nodes"].items():
        if n.get("ascendancyName") or n.get("isMastery") or n.get("classStartIndex") is not None:
            continue
        # sockets inside cluster jewels (they have a parent socket) can't hold timeless jewels
        if n.get("isJewelSocket") and (n.get("expansionJewel") or {}).get("parent"):
            continue
        g = tree["groups"].get(str(n.get("group")))
        if not g or n.get("orbit") is None:
            continue
        o, oi = n["orbit"], n.get("orbitIndex", 0)
        a = orbit_angles[o][oi]
        x = g["x"] + math.sin(a) * radii[o]
        y = g["y"] - math.cos(a) * radii[o]
        kind = 3 if n.get("isJewelSocket") else 2 if n.get("isKeystone") else 1 if n.get("isNotable") else 0
        if kind == 0 and not n.get("stats"):
            continue
        out[nid] = [round(x, 1), round(y, 1), kind]
    return out


def main():
    commit = PINNED_COMMIT
    if "--update" in sys.argv:
        api = json.loads(get("https://api.github.com/repos/%s/commits/master" % REPO))
        commit = api["sha"]
        print("re-pinned to PoB master", commit, "- update PINNED_COMMIT in this file")
    raw = "https://raw.githubusercontent.com/%s/%s/src/Data/TimelessJewelData/" % (REPO, commit)

    legion = lua_return_table(get(raw + "LegionPassives.lua").decode("utf-8"))
    index, size_notable, l2g = parse_node_index(get(raw + "NodeIndexMapping.lua").decode("utf-8"))
    with open(os.path.join(DATA, "tree.min.json"), "r", encoding="utf-8") as f:
        tree = json.load(f)  # cached by tools/make_jeweldata.py

    jewels = {}
    for t, j in JEWELS.items():
        blob = get(raw + j["file"] + ".zip")
        jewels[str(t)] = {
            "name": j["name"], "seedMin": j["seedMin"], "seedMax": j["seedMax"], "seedStep": j["step"],
            "conquerors": j["conquerors"], "small": j["small"],
            "lut": {"file": j["file"] + ".zip", "sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob),
                    "url": raw + j["file"] + ".zip"},
        }
        print("  %-16s %7d KB  sha256 %s" % (j["name"], len(blob) // 1024, jewels[str(t)]["lut"]["sha256"][:16]))

    def slim(e):
        return {"id": e.get("id", ""), "dn": e.get("dn", ""), "sd": e.get("sd") or [], "ks": bool(e.get("ks"))}

    out = {
        "source": {"repo": REPO, "commit": commit,
                   "license": "MIT — Path of Building Community, (c) David Gowor and contributors"},
        "radius": TIMELESS_RADIUS, "additionsCount": ADDITIONS,
        "jewels": jewels,
        "additions": [slim(e) for e in legion["additions"]],
        "nodes": [slim(e) for e in legion["nodes"]],
        "nodeIndex": index, "sizeNotable": size_notable, "localToGlobal": l2g,
        "geometry": geometry(tree), "treeVersion": tree.get("tree", ""),
    }
    assert len(out["additions"]) == ADDITIONS, "PoB changed the additions count: %d" % len(out["additions"])
    dest = os.path.join(DATA, "timeless.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote %s - %d additions, %d legion nodes, %d indexed notables (LUT rows %d), %d tree nodes, %d KB" % (
        dest, len(out["additions"]), len(out["nodes"]), len(index), size_notable, len(out["geometry"]),
        os.path.getsize(dest) // 1024))


if __name__ == "__main__":
    main()
