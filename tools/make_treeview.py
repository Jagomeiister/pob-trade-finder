"""Generate data/treeview.js: a compact, precomputed passive-tree layout for the Skill tree
view (js/app/23-tree.js). Reads GGG's tree export cached at data/tree.min.json (written by
tools/make_jeweldata.py) and uses Path of Building's node position maths (the same as
tools/make_timeless.py geometry(): 16- and 40-node orbits use fixed angle tables).

Output: window.POE_TREE_VIEW = {
  tree, orbitRadii,
  bounds: [minX, minY, maxX, maxY]          main tree only (no ascendancies)
  nodes: [[id, x, y, kind, name, stats, asc, flags], ...]
      kind  0 small, 1 notable, 2 keystone, 3 mastery, 4 jewel socket, 5 class start,
            6 ascendancy start
      stats the node's stat lines joined with "\n" (long lists trimmed)
      asc   index into ascendancies (-1 or missing = main tree)
      flags 1 = jewel socket inside a cluster jewel (drawn only when allocated),
            2 = attribute choice node
  edges: [a, b, a, b, ...]                  node id pairs drawn as straight lines
  arcs:  [a, b, cx, cy, r, ...]             same group + orbit: an arc around the group centre
  ascendancies: [{name, id, bloodline}]     id = the tree's ascendancy id (PoB's ascendClass)
  classes: [{name, start, asc: [ascendancy ids]}]
  masteryEffects: {effect id: "stat text"}
  masteries: {mastery node id: [effect ids]}
  masteryLinks: [mastery, node, ...]       the notables next to each mastery (not drawn)
  jewelSlots: [socket node ids]            character-window jewels give x = an index here
}
Run: python tools/make_treeview.py
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MAX_STATS = 600  # characters of stat text kept per node (keystones run long)

SMALL, NOTABLE, KEYSTONE, MASTERY, SOCKET, CLASS_START, ASC_START = range(7)


def orbit_angles(n):
    """PoB's PassiveTree orbit angles (radians) for an orbit with n slots."""
    if n == 16:
        deg = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330]
    elif n == 40:
        deg = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170,
               180, 190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350]
    else:
        deg = [360.0 * i / n for i in range(n)]
    return [math.radians(d) for d in deg]


def position(tree, n, angles):
    """(x, y) of a node, or None when it has no placement."""
    g = tree["groups"].get(str(n.get("group")))
    if not g or n.get("orbit") is None:
        return None
    radii = tree["constants"]["orbitRadii"]
    o, oi = n["orbit"], n.get("orbitIndex", 0)
    a = angles[o][oi]
    return g["x"] + math.sin(a) * radii[o], g["y"] - math.cos(a) * radii[o]


def kind_of(n):
    if n.get("classStartIndex") is not None:
        return CLASS_START
    if n.get("isAscendancyStart"):
        return ASC_START
    if n.get("isMastery"):
        return MASTERY
    if n.get("isJewelSocket"):
        return SOCKET
    if n.get("isKeystone"):
        return KEYSTONE
    if n.get("isNotable"):
        return NOTABLE
    return SMALL


def stat_text(n):
    s = "\n".join(x.replace("\n", " ") for x in (n.get("stats") or []))
    return s if len(s) <= MAX_STATS else s[:MAX_STATS - 1].rstrip() + "…"


def build(tree):
    angles = [orbit_angles(k) for k in tree["constants"]["skillsPerOrbit"]]
    groups = tree["groups"]
    nodes = tree["nodes"]

    # ascendancies: the classes' own, then the bloodlines (alternate ascendancies)
    asc_list, asc_index = [], {}
    for c in tree["classes"]:
        for a in c.get("ascendancies", []):
            asc_index[a["id"]] = len(asc_list)
            asc_list.append({"name": a.get("name", a["id"]), "id": a["id"], "bloodline": False})
    for a in tree.get("alternate_ascendancies", []):
        if a["id"] not in asc_index:
            asc_index[a["id"]] = len(asc_list)
            asc_list.append({"name": a.get("name", a["id"]), "id": a["id"], "bloodline": True})

    keep, out_nodes = {}, []
    for nid, n in nodes.items():
        if not nid.isdigit() or n.get("isProxy"):
            continue
        g = groups.get(str(n.get("group")))
        sub_socket = bool(n.get("isJewelSocket") and (n.get("expansionJewel") or {}).get("parent"))
        if g and g.get("isProxy") and not sub_socket:
            continue
        pos = position(tree, n, angles)
        if pos is None:
            continue
        asc = n.get("ascendancyName")
        if asc and asc not in asc_index:  # an ascendancy the class list doesn't name
            asc_index[asc] = len(asc_list)
            asc_list.append({"name": asc, "id": asc, "bloodline": bool(n.get("isBloodline"))})
        kind = kind_of(n)
        flags = (1 if sub_socket else 0) | (2 if n.get("isMultipleChoiceOption") else 0)
        name = n.get("name", "")
        if kind == CLASS_START:
            name = tree["classes"][n["classStartIndex"]]["name"]
        rec = [int(nid), round(pos[0]), round(pos[1]), kind, name, stat_text(n)]
        if asc or flags:
            rec.append(asc_index[asc] if asc else -1)
        if flags:
            rec.append(flags)
        keep[nid] = (n, pos)
        out_nodes.append(rec)
    out_nodes.sort(key=lambda r: r[0])

    edges, arcs, seen = [], [], set()
    for nid, (n, _) in keep.items():
        for other in (n.get("out") or []) + (n.get("in") or []):
            if other not in keep:
                continue
            key = (min(int(nid), int(other)), max(int(nid), int(other)))
            if key in seen:
                continue
            seen.add(key)
            m = keep[other][0]
            if n.get("isMastery") or m.get("isMastery"):
                continue  # PoB draws no lines into masteries
            if n.get("ascendancyName") != m.get("ascendancyName"):
                continue  # class start <-> ascendancy start, main tree <-> ascendancy
            if n.get("classStartIndex") is not None and m.get("classStartIndex") is not None:
                continue
            if n.get("group") == m.get("group") and n.get("orbit") == m.get("orbit") and n.get("orbit"):
                g = groups[str(n["group"])]
                arcs.extend([key[0], key[1], round(g["x"]), round(g["y"]),
                             tree["constants"]["orbitRadii"][n["orbit"]]])
            else:
                edges.extend(key)

    main = [r for r in out_nodes if (len(r) < 7 or r[6] < 0) and not (len(r) > 7 and r[7] & 1)]
    bounds = [min(r[1] for r in main), min(r[2] for r in main), max(r[1] for r in main), max(r[2] for r in main)]

    classes = []
    for i, c in enumerate(tree["classes"]):
        start = next((int(k) for k, (n, _) in keep.items() if n.get("classStartIndex") == i), None)
        classes.append({"name": c["name"], "start": start, "asc": [a["id"] for a in c.get("ascendancies", [])]})

    # masteries: their effects (text by effect id, ids by mastery node) and the notables that
    # unlock them (not drawn; the "points still to take" walk steps through them)
    effects, masteries, mastery_links = {}, {}, []
    for nid, (n, _) in sorted(keep.items(), key=lambda kv: int(kv[0])):
        if not n.get("isMastery"):
            continue
        ids = []
        for e in n.get("masteryEffects") or []:
            effects[str(e["effect"])] = "\n".join(s.replace("\n", " ") for s in e.get("stats") or [])
            ids.append(e["effect"])
        masteries[nid] = ids
        for other in sorted(set((n.get("in") or []) + (n.get("out") or [])), key=int):
            if other in keep and not keep[other][0].get("isMastery"):
                mastery_links.extend([int(nid), int(other)])

    return {
        "tree": tree.get("tree", ""), "orbitRadii": tree["constants"]["orbitRadii"],
        "bounds": bounds, "nodes": out_nodes, "edges": edges, "arcs": arcs,
        "ascendancies": asc_list, "classes": classes, "masteryEffects": effects,
        "masteries": masteries, "masteryLinks": mastery_links,
        # character-window jewels carry x = an index into this list of socket node ids
        "jewelSlots": tree.get("jewelSlots", []),
    }


def main():
    with open(os.path.join(DATA, "tree.min.json"), "r", encoding="utf-8") as f:
        tree = json.load(f)  # cached by tools/make_jeweldata.py
    out = build(tree)
    dest = os.path.join(DATA, "treeview.js")
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_treeview.py from the passive tree export (data/tree.min.json)\n")
        f.write("window.POE_TREE_VIEW = ")
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";\n")
    print("wrote %s - %d nodes, %d lines, %d arcs, %d ascendancies, %d mastery effects, %d KB" % (
        dest, len(out["nodes"]), len(out["edges"]) // 2, len(out["arcs"]) // 5, len(out["ascendancies"]),
        len(out["masteryEffects"]), os.path.getsize(dest) // 1024))


if __name__ == "__main__":
    main()
