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
  icons: {zoom, active, inactive, size, at} passive icon sprite sheets (GGG CDN URLs) and each
                                           node's x, y in them (see icons())
  masteryArt: the mastery icons and the pattern behind a chosen one (see mastery_art()): {
      zoom, size: [w, h], inactive, connected, active   the three icon sheets (locked / connected /
                                                        effect chosen), one zoom, one icon size
      effect: {url, zoom, size: [w, h]}                 the pattern sheet (a smaller zoom: see below)
      art:   [[ix, iy, ax, ay, ex, ey], ...]            distinct art: x, y in the inactive + connected
                                                        sheets (same layout), the active sheet, the
                                                        pattern sheet
      nodes: [mastery node id, art index, ...]
  }
  background: the in-game backdrop (see background()): {
      tile:   {url, zoom, rect: [x, y, w, h]}  the dark tile, repeated; one tile = w / zoom tree units
      sheet:  {url, zoom}                      the group-background sheet
      art:    [[key, x, y, w, h], ...]         the pieces of that sheet in use
      groups: [x, y, a, ...]                   a group's circle centred at x, y: art index a >> 1,
                                               a & 1 = half image (the top half, mirrored below)
      starts: [node id, a, ...]                class start art (the build's class), centred on the node
      startInactive: a                         the other classes' start art
  }
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


ICON_SHEETS = {SMALL: "normal", NOTABLE: "notable", KEYSTONE: "keystone"}


def icons(tree, out_nodes):
    """The passive icons of small nodes, notables and keystones (ascendancy ones too), from the
    largest sprite-sheet zoom level. GGG's sheets hold every icon once; the Active (coloured) and
    Inactive (greyed) sheets share one layout, so each node needs only its x, y in the sheet and
    the size comes from its kind. Returns {zoom, active, inactive, size: [[w, h] per kind 0..2],
    at: [x, y, ...] aligned with nodes, -1, -1 = no icon}."""
    sprites = tree.get("sprites") or {}
    sheets = sprites.get("notableActive") or {}
    if not sheets:
        return None
    zoom = max(sheets, key=float)
    active, inactive = sprites["normalActive"][zoom], sprites["normalInactive"][zoom]
    if any(sprites[k + s][zoom]["filename"] != (active if s == "Active" else inactive)["filename"]
           for k in ICON_SHEETS.values() for s in ("Active", "Inactive")):
        raise SystemExit("passive icon sprites are no longer one sheet per zoom level: update icons()")
    size, at = [None] * 3, []
    for rec in out_nodes:
        n, kind = tree["nodes"][str(rec[0])], rec[3]
        sheet = ICON_SHEETS.get(kind)
        c = sheet and n.get("icon") and sprites[sheet + "Active"][zoom]["coords"].get(n["icon"])
        if not c:
            at.extend([-1, -1])
            continue
        if sprites[sheet + "Inactive"][zoom]["coords"].get(n["icon"]) != c:
            raise SystemExit("active and inactive icon sheets differ for %s: update icons()" % n["icon"])
        size[kind] = size[kind] or [c["w"], c["h"]]
        at.extend([c["x"], c["y"]])
    return {"zoom": float(zoom), "active": active["filename"], "inactive": inactive["filename"],
            "size": size, "at": at}


BG_ZOOM = "0.5"  # the icons' zoom level (the largest sheets)
CDN = "https://web.poecdn.com/"  # the only host the art cache (art_cache.py) fetches from

# Mastery sheets: the art cache refuses files over art_cache.MAX_BYTES (2 MB). Measured on the CDN:
# the icon sheets at 0.5 are 0.49 MB (inactive), 0.54 MB (connected) and 1.2 MB (active, selected);
# the pattern sheet is 1.6 MB at 0.2109, 3.0 MB at 0.2972 and 7.6 MB at 0.5, so it comes from
# 0.2109 and is drawn at w / zoom tree units like every other sprite (the same size in the tree).
MASTERY_ZOOM = "0.5"
MASTERY_EFFECT_ZOOM = "0.2109"
MASTERY_SHEETS = (("inactive", "masteryInactive"), ("connected", "masteryConnected"),
                  ("active", "masteryActiveSelected"))


def mastery_art(tree, out_nodes):
    """The mastery icons as the game draws them: masteryInactive (no notable of the group taken),
    masteryConnected (a notable taken, no effect chosen), masteryActiveSelected (effect chosen) plus
    the masteryActiveEffect pattern behind that group. The inactive and connected sheets are keyed
    by a node's inactiveIcon and share one layout; the active sheet by its activeIcon; the pattern
    sheet by its activeEffectImage. Masteries share art (about 60 kinds for 300+ masteries), so the
    coords are listed once and each mastery points at its entry."""
    sprites = tree.get("sprites") or {}

    def sheet(kind, zoom):
        s = (sprites.get(kind) or {}).get(zoom)
        if not s or not s.get("filename", "").startswith(CDN):
            raise SystemExit("no %s sprite sheet at zoom %s on %s: update mastery_art()" % (kind, zoom, CDN))
        return s

    sheets = {name: sheet(kind, MASTERY_ZOOM) for name, kind in MASTERY_SHEETS}
    effect = sheet("masteryActiveEffect", MASTERY_EFFECT_ZOOM)
    if sheets["inactive"]["coords"] != sheets["connected"]["coords"]:
        raise SystemExit("mastery inactive and connected sheets no longer share a layout: update mastery_art()")
    size, esize, art, index, flat = None, None, [], {}, []

    def one_size(c, have, what):
        if have and have != [c["w"], c["h"]]:
            raise SystemExit("%s sprites differ in size: update mastery_art()" % what)
        return [c["w"], c["h"]]

    for rec in out_nodes:
        if rec[3] != MASTERY:
            continue
        n = tree["nodes"][str(rec[0])]
        ci = sheets["inactive"]["coords"].get(n.get("inactiveIcon"))
        ca = sheets["active"]["coords"].get(n.get("activeIcon"))
        ce = effect["coords"].get(n.get("activeEffectImage"))
        if not (ci and ca and ce):
            continue  # drawn as a plain ring
        size = one_size(ci, size, "mastery icon")
        size = one_size(ca, size, "mastery icon")
        esize = one_size(ce, esize, "mastery pattern")
        key = (ci["x"], ci["y"], ca["x"], ca["y"], ce["x"], ce["y"])
        if key not in index:
            index[key] = len(art)
            art.append(list(key))
        flat.extend([rec[0], index[key]])
    if not art:
        return None
    out = {"zoom": float(MASTERY_ZOOM), "size": size}
    out.update({name: s["filename"] for name, s in sheets.items()})
    out.update({"effect": {"url": effect["filename"], "zoom": float(MASTERY_EFFECT_ZOOM), "size": esize},
                "art": art, "nodes": flat})
    return out


def bg_sheet(tree, kind, zoom):
    sheet = ((tree.get("sprites") or {}).get(kind) or {}).get(zoom)
    if not sheet or not sheet.get("filename", "").startswith(CDN):
        raise SystemExit("no %s sprite sheet at zoom %s on %s: update background()" % (kind, zoom, CDN))
    return sheet


def background(tree, groups, starts, zoom=BG_ZOOM, group_zoom=None, inactive=None):
    """The in-game backdrop, as GGG's tree and PoB draw it: the repeated dark tile, then each
    group's circle (a half image is its top half, mirrored for the bottom), then the class start
    art. A sprite at zoom z is w / z tree units wide (PoB: PassiveTreeView DrawAsset).
    groups: [(x, y, art key, half)], starts: [(node id, art key)]. Shared with make_atlasview.py."""
    tile = bg_sheet(tree, "background", zoom)
    tc = tile["coords"].get("Background2") or next(iter(tile["coords"].values()))
    gz = group_zoom or zoom
    sheet = bg_sheet(tree, "groupBackground", gz)
    coords = dict(sheet["coords"])
    st = ((tree.get("sprites") or {}).get("startNode") or {}).get(gz)
    if st:
        if st["filename"] != sheet["filename"]:
            raise SystemExit("start art is no longer on the group background sheet: update background()")
        coords.update(st["coords"])
    art, index = [], {}

    def idx(key):
        if key not in coords:
            raise SystemExit("background art %r is not on %s" % (key, sheet["filename"]))
        if key not in index:
            c = coords[key]
            index[key] = len(art)
            art.append([key, c["x"], c["y"], c["w"], c["h"]])
        return index[key]

    flat, st_flat = [], []
    for x, y, key, half in groups:
        flat.extend([round(x), round(y), idx(key) * 2 + (1 if half else 0)])
    for nid, key in starts:
        st_flat.extend([int(nid), idx(key)])
    out = {"tile": {"url": tile["filename"], "zoom": float(zoom), "rect": [tc["x"], tc["y"], tc["w"], tc["h"]]},
           "sheet": {"url": sheet["filename"], "zoom": float(gz)}, "art": art, "groups": flat, "starts": st_flat}
    if inactive:
        out["startInactive"] = idx(inactive)
    return out


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

    # the backdrop: circles behind the main tree's groups (proxies are cluster jewel stand-ins,
    # ascendancy groups sit in their own inset), the start art on the class starts
    main_groups = {str(n.get("group")) for n, _ in keep.values() if not n.get("ascendancyName")}
    bg_groups = [(g["x"], g["y"], g["background"]["image"], bool(g["background"].get("isHalfImage")))
                 for gid, g in sorted(groups.items(), key=lambda kv: int(kv[0]))
                 if g.get("background") and not g.get("isProxy") and gid in main_groups]
    bg_starts = [(c["start"], "center" + c["name"].lower()) for c in classes if c["start"] is not None]

    return {
        "tree": tree.get("tree", ""), "orbitRadii": tree["constants"]["orbitRadii"],
        "icons": icons(tree, out_nodes),
        "masteryArt": mastery_art(tree, out_nodes),
        "background": background(tree, bg_groups, bg_starts, inactive="PSStartNodeBackgroundInactive"),
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
