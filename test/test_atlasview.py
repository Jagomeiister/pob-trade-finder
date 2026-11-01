"""Atlas tree view data and link import — run: python test/test_atlasview.py

data/atlasview.js (tools/make_atlasview.py): its shape, plus the import code in js/app/28-atlas.js
run under Node (vm, no browser): an official Atlas link built here from known node ids decodes back
to those ids, the app's own encoder writes the same link, and the other inputs (PoB code with a
link in its notes, node names / ids, wrong links) are read or refused with a clear error. When
the export cache (make_atlasview.CACHE) is present it also checks the shipped file is fresh."""
import base64
import json
import os
import subprocess
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import make_atlasview  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    failures += not ok
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail) if detail and not ok else ""))


# ---- data shape --------------------------------------------------------------------------
path = os.path.join(ROOT, "data", "atlasview.js")
src = open(path, encoding="utf-8").read()
check("atlasview.js assigns window.POE_ATLAS_VIEW", "window.POE_ATLAS_VIEW = {" in src)
AV = json.loads(src[src.index("{"):src.rindex("}") + 1])
size = os.path.getsize(path)
check("atlasview.js stays small (< 400 KB)", size < 400 * 1024, size)
check("Atlas tree, pinned export version", AV["tree"] == "Atlas" and AV["version"] == make_atlasview.TAG, (AV["tree"], AV["version"]))

nodes = {n[0]: n for n in AV["nodes"]}
check("about a thousand nodes, unique ids", 800 < len(nodes) < 1500 and len(nodes) == len(AV["nodes"]), len(nodes))
check("every record: id, x, y, kind, name, stats[, granted]",
      all(6 <= len(n) <= 7 and isinstance(n[0], int) and isinstance(n[4], str) and isinstance(n[5], str) for n in AV["nodes"]))
kinds = {}
for n in AV["nodes"]:
    kinds[n[3]] = kinds.get(n[3], 0) + 1
check("node kinds: small, notable, keystone, mastery, gateway, start", all(kinds.get(k) for k in range(6)) and
      set(kinds) == set(range(6)), kinds)
check("gateways come in pairs (linked, not drawn)", kinds[4] == len(AV["wormholes"]) and
      all(nodes[i][3] == 4 for i in AV["wormholes"]), (kinds[4], AV["wormholes"]))
check("one start, the root's neighbour", AV["starts"] and all(nodes[i][3] == 5 for i in AV["starts"]), AV["starts"])
b = AV["bounds"]
check("bounds hold every node", all(b[0] <= n[1] <= b[2] and b[1] <= n[2] <= b[3] for n in AV["nodes"]), b)
check("points available from the export", isinstance(AV["totalPoints"], int) and 100 < AV["totalPoints"] < 300, AV["totalPoints"])
granted = [n for n in AV["nodes"] if len(n) > 6]
check("nodes that grant points carry it", granted and all(n[6] > 0 and "Passive Skill Point" in n[5] for n in granted),
      [(n[4], n[6]) for n in granted])

edges = list(zip(AV["edges"][0::2], AV["edges"][1::2]))
arcs = [AV["arcs"][i:i + 5] for i in range(0, len(AV["arcs"]), 5)]
check("link counts sane", 200 < len(edges) < 2000 and 200 < len(arcs) < 2000, (len(edges), len(arcs)))
check("links join known nodes, none into masteries",
      all(a in nodes and c in nodes and nodes[a][3] != 3 and nodes[c][3] != 3 for a, c in edges) and
      all(a[0] in nodes and a[1] in nodes and a[4] in AV["orbitRadii"] for a in arcs))
# an arc's ends sit on its circle
off = [a for a in arcs if any(abs(((nodes[i][1] - a[2]) ** 2 + (nodes[i][2] - a[3]) ** 2) ** 0.5 - a[4]) > 2 for i in a[:2])]
check("arc ends lie on their orbit", not off, off[:3])

ic = AV["icons"]
check("icon sheets on GGG's CDN, one x/y pair per node", ic["active"].startswith("https://web.poecdn.com/") and
      ic["inactive"].startswith("https://web.poecdn.com/") and len(ic["at"]) == 2 * len(AV["nodes"]), len(ic["at"]))
check("icon sizes for small, notable, keystone", all(ic["size"][k] for k in range(3)), ic["size"])
with_icon = sum(1 for i in range(len(AV["nodes"])) if ic["at"][2 * i] >= 0)
check("most nodes have an icon", with_icon > 0.8 * (kinds[0] + kinds[1] + kinds[2]), with_icon)
check("league areas use the mastery sheet", ic.get("mastery") and len(ic["mastery"]["at"]) == kinds[3] and
      all(nodes[int(k)][3] == 3 for k in ic["mastery"]["at"]), len((ic.get("mastery") or {}).get("at", {})))

# the in-game backdrop: tile, painted Atlas, group circles, start art (make_treeview.background())
bg = AV.get("background") or {}
art = bg.get("art") or []
CDN = "https://web.poecdn.com/"
check("backdrop: tile, group sheet and painting on GGG's CDN (the art cache allowlist)",
      all(bg[k]["url"].startswith(CDN) for k in ("tile", "sheet", "painting")), [bg.get(k, {}).get("url") for k in ("tile", "sheet", "painting")])
check("backdrop: tile from the icons' zoom; circles from 0.3835 (the 0.5 sheet is over the art cache's 2 MB cap)",
      bg["tile"]["zoom"] == ic["zoom"] and bg["sheet"]["zoom"] == float(make_atlasview.GROUP_BG_ZOOM), (bg["tile"], bg["sheet"]))
bgg = [bg["groups"][i:i + 3] for i in range(0, len(bg["groups"]), 3)]
check("backdrop: a circle per group with art, each a known whole piece", 100 < len(bgg) < 400 and
      all(0 <= g[2] >> 1 < len(art) and not g[2] & 1 for g in bgg), len(bgg))
keys = {art[g[2] >> 1][0] for g in bgg}
check("backdrop: the league art pieces are there (Cleansing Fire, Tangle)",
      {"GroupBackgroundCleansingFire", "GroupBackgroundTangle", "PSGroupBackground1"} <= keys, keys)
far = [g for g in bgg if min((g[0] - n[1]) ** 2 + (g[1] - n[2]) ** 2 for n in AV["nodes"]) > 400 ** 2]
check("backdrop: every circle sits on a cluster", not far, far[:3])
check("backdrop: the start art on the start node", bg["starts"][0::2] == AV["starts"] and
      all(art[a][0] == make_atlasview.START_ART for a in bg["starts"][1::2]), bg["starts"])
pr = bg["painting"]["rect"]
check("backdrop: the painting spans the tree (every node inside it, give or take a node)",
      pr[0] < pr[2] and pr[1] < pr[3] and all(pr[0] - 400 <= n[1] <= pr[2] + 400 and pr[1] - 100 <= n[2] <= pr[3] + 100 for n in AV["nodes"]),
      pr)
check("backdrop: small (< 4 KB of the file)", len(json.dumps(bg, separators=(",", ":"))) < 4 * 1024,
      len(json.dumps(bg, separators=(",", ":"))))

# fresh: the shipped file is what the generator makes from the cached export
if os.path.exists(make_atlasview.CACHE):
    with open(make_atlasview.CACHE, encoding="utf-8") as f:
        export = json.load(f)
    rebuilt = make_atlasview.build(export)
    check("atlasview.js matches a rebuild from the cached export", json.loads(json.dumps(rebuilt)) == AV)
    check("backdrop: painting stretched over the export's min/max, from its largest sheet",
          pr == [export["min_x"], export["min_y"], export["max_x"], export["max_y"]] and
          bg["painting"]["url"] == export["sprites"]["atlasBackground"]["0.5"]["filename"], pr)
    gs = export["sprites"]["groupBackground"][make_atlasview.GROUP_BG_ZOOM]
    check("backdrop: pieces inside the export's group sheet",
          gs["filename"] == bg["sheet"]["url"] and all(a[1] + a[3] <= gs["w"] and a[2] + a[4] <= gs["h"] for a in art), gs["filename"])
    offs = [g for g in export["groups"].values() if (g.get("background") or {}).get("offsetY")]
    check("backdrop: art offsets applied (the odd-shaped league pieces)", offs and all(
        [round(g["x"] + g["background"].get("offsetX", 0)), round(g["y"] + g["background"]["offsetY"])] in [x[:2] for x in bgg]
        for g in offs), len(offs))
else:
    print("skip freshness check (no export cache; run tools/make_atlasview.py --fetch)")


# ---- links: built here from known ids, read by the app's JS ---------------------------
def encode(ids, version=6, cls=0, asc=0):
    ids = sorted(set(ids))
    body = bytes([0, 0, 0, version, cls, asc])
    if version >= 5:
        body += bytes([len(ids)])
    else:
        body += bytes([0])  # version 4: the fullscreen byte, then ids to the end
    for i in ids:
        body += bytes([i >> 8, i & 255])
    if version >= 5:
        body += bytes([0, 0])
    return base64.urlsafe_b64encode(body).decode()


def by_name(name, kind=None):
    hits = [n for n in AV["nodes"] if n[4] == name and (kind is None or n[3] == kind)]
    return hits[0][0] if len(hits) == 1 else None


notables = sorted(n[0] for n in AV["nodes"] if n[3] == 1)
keystones = sorted(n[0] for n in AV["nodes"] if n[3] == 2)
smalls = sorted(n[0] for n in AV["nodes"] if n[3] == 0)
# spread over the id range: low ids, ids >= 32768 (u16, not s16), and a few of each kind
known = sorted(set(notables[:4] + notables[-4:] + keystones[:2] + keystones[-1:] + smalls[:3] + smalls[-3:]))
check("test ids cover high (>= 32768) and low (< 256 * 64) ids", known[-1] >= 32768 and known[0] < 16384, known)
url = "https://www.pathofexile.com/fullscreen-atlas-skill-tree/" + encode(known)
url_plain = "https://www.pathofexile.com/atlas-skill-tree/3.29.0/" + encode(known) + "?accountName=x"
url_v4 = "https://www.pathofexile.com/fullscreen-atlas-skill-tree/" + encode(known, version=4)
uniq_notable = next(n for n in AV["nodes"] if n[3] == 1 and sum(1 for m in AV["nodes"] if m[4] == n[4]) == 1)
dup_name = next(n[4] for n in AV["nodes"] if n[3] == 0 and sum(1 for m in AV["nodes"] if m[4] == n[4] and m[3] in (0, 1, 2, 4)) > 1)
xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n<Build level="90" className="Witch"/>\n'
       '<Notes>Atlas: (%s)\nalt tree %s</Notes>\n</PathOfBuilding>' % (url, url_v4))
pob_code = base64.urlsafe_b64encode(zlib.compress(xml.encode("utf-8"))).decode()
pob_none = base64.urlsafe_b64encode(zlib.compress(
    b'<?xml version="1.0"?>\n<PathOfBuilding><Build className="Witch"/><Notes>no atlas here</Notes></PathOfBuilding>' * 3)).decode()

CASES = {
    "url": url, "plain": url_plain, "v4": url_v4, "bare": encode(known), "pob": pob_code, "pobNone": pob_none,
    "names": "%s\n%d, %d" % (uniq_notable[4], known[0], known[1]),
    "dup": dup_name + "\n" + uniq_notable[4],
    "unknown": "Not A Node\n" + uniq_notable[4],
    "passive": "https://www.pathofexile.com/fullscreen-passive-skill-tree/" + encode(known, cls=3, asc=1),
    "charCode": encode(known, cls=3, asc=1),
    "v7": "https://www.pathofexile.com/fullscreen-atlas-skill-tree/" + encode(known, version=7),
    "cut": url[:-12],
    "planner": "https://poeplanner.com/atlas-tree/AAAAAgAAAQ",
    "other": "https://example.com/some/page",
    "junk": "hello world",
    "empty": "   ",
}

NODE_JS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[1], CASES = JSON.parse(fs.readFileSync(0, 'utf8'));
const store = {};
const ctx = { console, atob, btoa, Uint8Array, JSON, Math, Date, Promise, setTimeout, clearTimeout,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  document: { addEventListener() {} }, PoB: require(path.join(ROOT, 'js/pob.js')) };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('function isGui() { return false; } function persist(k, v) { localStorage.setItem(k, v); }', ctx);
for (const f of ['data/atlasview.js', 'js/app/28-atlas.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
(async () => {
  const out = {};
  for (const k of Object.keys(CASES)) {
    try { const r = await ctx.atlasParseInput(CASES[k]); out[k] = { nodes: r.nodes, url: r.url, source: r.source, links: (r.links || []).length }; }
    catch (e) { out[k] = { error: String(e && e.message || e) }; }
  }
  out.encoded = ctx.atlasEncodeUrl(out.url.nodes || []);
  out.model = (() => { const m = ctx.atlasModel(out.url.nodes || []); return { points: m.points, total: m.total, missing: m.missing }; })();
  // saved strategies: the globals the build library calls
  ctx.ATLAS = { url: CASES.url, ids: out.url.nodes, notesEl: null, draftNotes: 'n' };
  vm.runInContext('renderAtlasSide = function () {};', ctx);
  const s = ctx.atlasSaveNew('Essence farm');
  out.list = ctx.atlasList();
  out.name = ctx.atlasName(s.id);
  out.nameMissing = ctx.atlasName('nope');
  out.stored = JSON.parse(store['pobtf-atlas']);
  process.stdout.write(JSON.stringify(out));
})();
"""

p = subprocess.run(["node", "-e", NODE_JS, os.path.abspath(ROOT)], input=json.dumps(CASES), capture_output=True,
                   text=True, encoding="utf-8", timeout=60)
check("node harness ran", p.returncode == 0 and p.stdout, p.stderr[-800:])
R = json.loads(p.stdout) if p.returncode == 0 and p.stdout else {}


def err(k):
    return (R.get(k) or {}).get("error") or ""


check("official link decodes to the ids it was built from", R.get("url", {}).get("nodes") == known, R.get("url"))
check("the app writes the same link (round trip)", R.get("encoded") == url, (R.get("encoded"), url))
check("non-fullscreen link with a version folder and a query", R.get("plain", {}).get("nodes") == known, R.get("plain"))
check("version 4 link", R.get("v4", {}).get("nodes") == known, R.get("v4"))
check("bare code", R.get("bare", {}).get("nodes") == known and R["bare"]["source"] == "code", R.get("bare"))
check("points = allocated nodes, out of the export's total", R.get("model", {}).get("points") == len(known) and
      R["model"]["total"] >= AV["totalPoints"] and not R["model"]["missing"], R.get("model"))
check("PoB code: both Atlas links in its notes found, the first one shown",
      R.get("pob", {}).get("nodes") == known and R["pob"]["source"] == "pob" and R["pob"]["links"] == 2, R.get("pob"))
check("PoB code without an Atlas link: says PoB has no Atlas tree", "no Atlas tree" in err("pobNone"), err("pobNone"))
check("node names and ids", R.get("names", {}).get("nodes") == sorted([uniq_notable[0], known[0], known[1]]) or
      sorted(R.get("names", {}).get("nodes") or []) == sorted([uniq_notable[0], known[0], known[1]]), R.get("names"))
check("names that several nodes share are refused, not guessed", "share these names" in err("dup") and dup_name in err("dup"), err("dup"))
check("unknown names are refused", "Not Atlas nodes: Not A Node" in err("unknown"), err("unknown"))
check("character passive tree link refused", "character passive tree" in err("passive"), err("passive"))
check("character tree code refused", "character passive tree" in err("charCode"), err("charCode"))
check("unknown link version refused", "version 7" in err("v7"), err("v7"))
check("cut-short link refused", "cut short" in err("cut") or "doesn't decode" in err("cut"), err("cut"))
check("poeplanner link: clear message", "poeplanner" in err("planner"), err("planner"))
check("other links: clear message", "isn't an Atlas tree" in err("other"), err("other"))
check("anything else: clear message", "isn't an Atlas tree" in err("junk"), err("junk"))
check("empty paste", "Paste an Atlas tree link" in err("empty"), err("empty"))
check("saved strategy listed with its points", R.get("list") and R["list"][0]["name"] == "Essence farm" and
      R["list"][0]["points"] == len(known), R.get("list"))
check("atlasName", R.get("name") == "Essence farm" and R.get("nameMissing") is None, (R.get("name"), R.get("nameMissing")))
st = (R.get("stored") or [{}])[0]
check("stored as { id, name, url, nodes, notes, updated } under pobtf-atlas",
      set(st) == {"id", "name", "url", "nodes", "notes", "updated"} and st["nodes"] == known and st["url"] == url, st)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
