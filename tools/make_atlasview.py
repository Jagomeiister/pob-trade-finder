"""Generate data/atlasview.js: a compact, precomputed Atlas passive tree layout for the Atlas tree
view (js/app/28-atlas.js). Source: GGG's official Atlas tree export,
github.com/grindinggear/atlastree-export, pinned to a release tag (TAG). The repo carries no
licence file; like the passive tree export (tools/make_jeweldata.py) it is GGG's own data,
published for tool makers, credited in THIRD_PARTY_NOTICES.md ("Game data").

Positions use the same orbit maths as tools/make_treeview.py (16- and 40-slot orbits use fixed
angle tables, the rest are even).

Output: window.POE_ATLAS_VIEW = {
  tree, version, orbitRadii, totalPoints,
  bounds: [minX, minY, maxX, maxY]
  nodes: [[id, x, y, kind, name, stats, granted], ...]
      kind    0 small, 1 notable, 2 keystone, 3 mastery (the round league icon at a cluster's
              centre: drawn, never allocated), 4 wormhole (gateway), 5 start
      stats   the node's stat lines joined with "\n" (long lists trimmed)
      granted extra atlas passive points the node grants (only when non-zero)
  edges: [a, b, ...]           node id pairs drawn as straight lines
  arcs:  [a, b, cx, cy, r, ...] same group + orbit: an arc around the group centre
  wormholes: [a, b, ...]        gateway pairs: linked (a path can go through) but not drawn
  starts: [node ids]            where every path starts (the root's neighbours)
  icons: {zoom, active, inactive, size: [[w, h] per kind 0..4], at: [x, y, ...] aligned with
          nodes, -1, -1 = no icon; mastery: {sheet, size, at: {node id: [x, y]}}}
}
Run: python tools/make_atlasview.py [--fetch]
"""
import json
import os
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
sys.path.insert(0, HERE)
from make_treeview import orbit_angles, position  # noqa: E402  (same orbit maths)

TAG = "3.29.1"  # bump for a new league (the repo tags each patch)
URL = "https://raw.githubusercontent.com/grindinggear/atlastree-export/%s/data.json" % TAG
CACHE = os.path.join(tempfile.gettempdir(), "pobtf-atlastree-%s.json" % TAG)  # 1.4 MB, kept out of the repo
UA = "Mozilla/5.0 PoB-Trade-Finder/1.0"
MAX_STATS = 600

SMALL, NOTABLE, KEYSTONE, MASTERY, WORMHOLE, START = range(6)
ICON_SHEETS = {SMALL: "normal", NOTABLE: "notable", KEYSTONE: "keystone", WORMHOLE: "wormhole"}


def load(fetch=False):
    if fetch or not os.path.exists(CACHE):
        req = urllib.request.Request(URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        json.loads(body)  # only cache what parses
        with open(CACHE, "wb") as f:
            f.write(body)
    with open(CACHE, "r", encoding="utf-8") as f:
        return json.load(f)


def kind_of(n):
    if n.get("isMastery"):
        return MASTERY
    if n.get("isWormhole"):
        return WORMHOLE
    if n.get("isKeystone"):
        return KEYSTONE
    if n.get("isNotable"):
        return NOTABLE
    return SMALL


def stat_text(n):
    s = "\n".join(x.replace("\n", " ") for x in (n.get("stats") or []))
    return s if len(s) <= MAX_STATS else s[:MAX_STATS - 1].rstrip() + "…"


def icons(tree, out_nodes):
    """Icons from the largest sprite-sheet zoom level. Small, notable, keystone and wormhole icons
    share one sheet per zoom (Active in colour, Inactive greyed, same layout), so a node needs only
    its x, y. Masteries have their own sheet (one look, allocated or not)."""
    sprites = tree.get("sprites") or {}
    sheets = sprites.get("notableActive") or {}
    if not sheets:
        return None
    zoom = max(sheets, key=float)
    active, inactive = sprites["normalActive"][zoom], sprites["normalInactive"][zoom]
    for k in ICON_SHEETS.values():
        for s, ref in (("Active", active), ("Inactive", inactive)):
            if sprites[k + s][zoom]["filename"] != ref["filename"]:
                raise SystemExit("atlas icon sprites are no longer one sheet per zoom level: update icons()")
    size, at = [None] * 5, []
    m_sheet = (sprites.get("mastery") or {}).get(zoom)
    m_at, m_size = {}, None
    for rec in out_nodes:
        n, kind = tree["nodes"][str(rec[0])], rec[3]
        if kind == MASTERY and m_sheet and n.get("icon") in m_sheet["coords"]:
            c = m_sheet["coords"][n["icon"]]
            if m_size and m_size != [c["w"], c["h"]]:
                raise SystemExit("mastery icons differ in size: update icons()")
            m_size = [c["w"], c["h"]]
            m_at[str(rec[0])] = [c["x"], c["y"]]
        sheet = ICON_SHEETS.get(kind)
        c = sheet and n.get("icon") and sprites[sheet + "Active"][zoom]["coords"].get(n["icon"])
        if not c:
            at.extend([-1, -1])
            continue
        if sprites[sheet + "Inactive"][zoom]["coords"].get(n["icon"]) != c:
            raise SystemExit("active and inactive atlas sheets differ for %s: update icons()" % n["icon"])
        if size[kind] and size[kind] != [c["w"], c["h"]]:
            raise SystemExit("%s icons differ in size: update icons()" % sheet)
        size[kind] = [c["w"], c["h"]]
        at.extend([c["x"], c["y"]])
    out = {"zoom": float(zoom), "active": active["filename"], "inactive": inactive["filename"], "size": size, "at": at}
    if m_at:
        out["mastery"] = {"sheet": m_sheet["filename"], "size": m_size, "at": m_at}
    return out


def build(tree):
    angles = [orbit_angles(k) for k in tree["constants"]["skillsPerOrbit"]]
    radii = tree["constants"]["orbitRadii"]
    groups, nodes = tree["groups"], tree["nodes"]
    root = nodes.get("root") or {}
    starts = sorted(int(x) for x in root.get("out", []) if x in nodes)

    keep, out_nodes = {}, []
    for nid, n in nodes.items():
        if not nid.isdigit():
            continue  # "root": no position, only links to the start
        pos = position(tree, n, angles)
        if pos is None:
            continue
        kind = START if int(nid) in starts else kind_of(n)
        rec = [int(nid), round(pos[0]), round(pos[1]), kind, n.get("name", ""), stat_text(n)]
        if n.get("grantedPassivePoints"):
            rec.append(int(n["grantedPassivePoints"]))
        keep[nid] = n
        out_nodes.append(rec)
    out_nodes.sort(key=lambda r: r[0])

    edges, arcs, worm, seen = [], [], [], set()
    for nid, n in keep.items():
        for other in (n.get("out") or []) + (n.get("in") or []):
            if other not in keep:
                continue
            key = (min(int(nid), int(other)), max(int(nid), int(other)))
            if key in seen:
                continue
            seen.add(key)
            m = keep[other]
            if n.get("isMastery") or m.get("isMastery"):
                continue  # masteries are decoration: no lines into them
            if n.get("isWormhole") and m.get("isWormhole"):
                worm.extend(key)  # a gateway pair spans the whole atlas: linked, not drawn
                continue
            if n.get("group") == m.get("group") and n.get("orbit") == m.get("orbit") and n.get("orbit"):
                g = groups[str(n["group"])]
                arcs.extend([key[0], key[1], round(g["x"]), round(g["y"]), radii[n["orbit"]]])
            else:
                edges.extend(key)

    bounds = [min(r[1] for r in out_nodes), min(r[2] for r in out_nodes),
              max(r[1] for r in out_nodes), max(r[2] for r in out_nodes)]
    return {
        "tree": tree.get("tree", ""), "version": TAG, "orbitRadii": radii,
        "totalPoints": (tree.get("points") or {}).get("totalPoints"),
        "icons": icons(tree, out_nodes), "bounds": bounds, "nodes": out_nodes,
        "edges": edges, "arcs": arcs, "wormholes": worm, "starts": starts,
    }


def main():
    tree = load("--fetch" in sys.argv)
    if tree.get("tree") != "Atlas":
        raise SystemExit("not the Atlas tree export: %r" % tree.get("tree"))
    out = build(tree)
    dest = os.path.join(DATA, "atlasview.js")
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_atlasview.py from GGG's Atlas tree export "
                "(github.com/grindinggear/atlastree-export, tag %s)\n" % TAG)
        f.write("window.POE_ATLAS_VIEW = ")
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    kinds = {}
    for r in out["nodes"]:
        kinds[r[3]] = kinds.get(r[3], 0) + 1
    print("wrote %s - %d nodes %s, %d lines, %d arcs, %d gateway pairs, %d KB" % (
        dest, len(out["nodes"]), kinds, len(out["edges"]) // 2, len(out["arcs"]) // 5,
        len(out["wormholes"]) // 2, os.path.getsize(dest) // 1024))


if __name__ == "__main__":
    main()
