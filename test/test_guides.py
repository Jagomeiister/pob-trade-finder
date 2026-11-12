"""Mechanic guide data — run: python test/test_guides.py

Checks the generated data/guides.js (tools/make_guides.py) without touching the network: the payload
schema, stage tags, cite indexes in range, that every guide maps to a cheat sheet (or brings its own
sheet entry), that the internal research fields are gone, that the icon names point at GGG art paths,
that server/public/guides.json is the same payload, and the bridge's validation and Read-more URL
allowance in gui.py.

Also the content corrections (tools/guides/corrections-<patch>.json): they apply cleanly to the
untouched research, none is stale (re-applying one to the corrected text fails), and their text is in
the shipped data; and content checks for the error kinds the 3.29 review found: maps that are not on
the 3.29 Atlas, Kirac missions / map-device crafts, Logbook splitting, Chimeral, chisel advice, lab
enchants, working Breachstones, Catalysts outside Ultimatum, the Ritual Tribute reserve, Horned
Scarab of Awakening, the Atlas S-tier table, Ultimatum profit, same-day price snapshots; and that
data/syndicate.js is from the same research, corrections and patch."""
import copy
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, ROOT)
failures = 0
try:
    sys.stdout.reconfigure(errors="backslashreplace")
except Exception:
    pass

STAGES = {"league-start", "mid", "late", "ssf", "all"}
WANT = {"syndicate", "blight", "delve", "incursion", "expedition", "heist", "sanctum", "ultimatum", "ritual", "harvest",
        "breach", "legion", "abyss", "delirium", "bestiary", "eldritch", "essences", "kingsmarch", "vendor",
        "mercenaries", "atlas"}


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


def load_js(path, var):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"window\.%s\s*=\s*(\{.*\})\s*;\s*$" % var, text, re.S)
    return (json.loads(m.group(1)) if m else None), (m.group(1) if m else None)


data, raw = load_js(os.path.join(ROOT, "data", "guides.js"), "POE_GUIDES")
check("data/guides.js parses", isinstance(data, dict))
if not isinstance(data, dict):
    print("\n%d FAILED" % failures)
    sys.exit(1)
sheets, _ = load_js(os.path.join(ROOT, "data", "cheatsheets.js"), "POE_CHEATSHEETS")
sheet_ids = {m["id"] for m in sheets["mechanics"]}

# -- top level ----------------------------------------------------------------------
check("top-level keys", set(data) - {"tools", "notices", "retired"} == {"version", "asOf", "checked", "guides", "sheets", "icons"}, sorted(data))
v = data.get("version")
check("version is an int YYYYMMDDHHMM", isinstance(v, int) and not isinstance(v, bool) and len(str(v)) == 12, v)
check("asOf is a patch", bool(re.match(r"^\d+\.\d+$", data.get("asOf", ""))), data.get("asOf"))
check("checked is a date", bool(re.match(r"^\d{4}-\d{2}-\d{2}$", data.get("checked", ""))), data.get("checked"))
guides = data["guides"]
check("all 21 guides, keyed by cheat sheet id", set(guides) == WANT, sorted(set(guides) ^ WANT))
check("betrayal is the syndicate sheet", "syndicate" in guides and "betrayal" not in guides)

# -- every guide maps to a sheet ---------------------------------------------------------
extra = {s.get("id"): s for s in data["sheets"]}
check("guide-only sheets have id, title, group", all(isinstance(s.get("title"), str) and s.get("group") for s in extra.values()),
      data["sheets"])
check("mercenaries brings its own sheet entry", "mercenaries" in extra and "mercenaries" not in sheet_ids, sorted(extra))
check("every other guide has a wiki sheet", all(g in sheet_ids or g in extra for g in guides),
      [g for g in guides if g not in sheet_ids and g not in extra])
check("no extra sheet duplicates a wiki sheet", not (set(extra) & sheet_ids), set(extra) & sheet_ids)

# -- schema -------------------------------------------------------------------------
problems = []


def bad(gid, msg):
    problems.append("%s: %s" % (gid, msg))


def text(x):
    return isinstance(x, str) and x.strip() == x and x != ""


def cites(gid, where, c, n):
    if "cite" in c and not (isinstance(c["cite"], list) and c["cite"] and
                            all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < n for i in c["cite"])):
        bad(gid, "%s: cite %r out of range (%d sources)" % (where, c.get("cite"), n))


ALLOWED = {"title", "asOf", "summary", "howTo", "strategies", "dangers", "sell", "profit", "changes", "tables",
           "quickCard", "readMore"}
for gid, g in guides.items():
    if set(g) - ALLOWED:
        bad(gid, "unexpected keys %s" % sorted(set(g) - ALLOWED))
    if "gaps" in g or "planner" in g or "id" in g:
        bad(gid, "internal fields left in")
    if not (text(g.get("title")) and text(g.get("summary"))):
        bad(gid, "title / summary")
    src = g.get("readMore", [])
    n = len(src)
    if not n:
        bad(gid, "no sources")
    for i, r in enumerate(src):
        if not (text(r.get("title")) and re.match(r"^https?://[^\s/]+\.[^\s]+$", r.get("url", ""))):
            bad(gid, "readMore[%d] url/title" % i)
        if set(r) - {"url", "title", "publisher", "date", "patch"}:
            bad(gid, "readMore[%d] keys %s" % (i, sorted(r)))
    for key in ("howTo", "dangers", "sell"):
        for i, it in enumerate(g.get(key, [])):
            if not text(it.get("text")) or not it.get("stage") or set(it["stage"]) - STAGES:
                bad(gid, "%s[%d] text/stage %r" % (key, i, it.get("stage")))
            cites(gid, "%s[%d]" % (key, i), it, n)
    for i, s in enumerate(g.get("strategies", [])):
        if not text(s.get("name")) or not s.get("steps") or not s.get("stage") or set(s["stage"]) - STAGES:
            bad(gid, "strategies[%d] name/steps/stage" % i)
        for k in ("steps", "atlasPassives", "scarabs"):
            if k in s and not (s[k] and all(text(x) for x in s[k])):
                bad(gid, "strategies[%d].%s empty or untrimmed" % (i, k))
        cites(gid, "strategies[%d]" % i, s, n)
    for i, p in enumerate(g.get("profit", [])):
        if not text(p.get("text")):
            bad(gid, "profit[%d] text" % i)
        cites(gid, "profit[%d]" % i, p, n)
    for i, c in enumerate(g.get("changes", [])):
        if not (text(c.get("text")) and text(c.get("patch"))):
            bad(gid, "changes[%d]" % i)
        cites(gid, "changes[%d]" % i, c, n)
    for i, t in enumerate(g.get("tables", [])):
        cols = t.get("columns") or []
        if not (text(t.get("title")) and cols and t.get("rows") and all(len(r) == len(cols) for r in t["rows"])):
            bad(gid, "tables[%d] shape" % i)
        cites(gid, "tables[%d]" % i, t, n)
    q = g.get("quickCard", [])
    if not (1 <= len(q) <= 6 and all(text(x) for x in q)):
        bad(gid, "quickCard %d lines" % len(q))
    # no empty fields left behind (the generator drops them)
    for k, val in g.items():
        if val in ("", [], {}, None):
            bad(gid, "empty field %s" % k)
check("guide schema, stage tags and cite ranges", not problems, "; ".join(problems[:6]))
check("every guide has how-to, strategies, dangers, quick card and sources",
      all(g.get("howTo") and g.get("strategies") and g.get("dangers") and g.get("quickCard") and g.get("readMore")
          for g in guides.values()), [k for k, g in guides.items() if not g.get("strategies")])


def pkey(p):
    m = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", p)
    return tuple(int(x or 0) for x in m.groups()) if m else (-1, 0, 0)


check("changes newest patch first", all([pkey(c["patch"]) for c in g.get("changes", [])] ==
                                        sorted([pkey(c["patch"]) for c in g.get("changes", [])], reverse=True)
                                        for g in guides.values()))

# -- icons --------------------------------------------------------------------------
icons = data["icons"]
check("icons: name -> GGG art path", icons and all(isinstance(k, str) and isinstance(p, str) and p.startswith("/gen/image/")
                                                   and p.endswith(".png") for k, p in icons.items()), len(icons))
with open(os.path.join(ROOT, "data", "currencymap.json"), encoding="utf-8") as f:
    cm = {v["name"]: v.get("img") for v in json.load(f).values()}
check("icon names come from data/currencymap.json", all(cm.get(k) == p for k, p in icons.items()),
      [k for k, p in icons.items() if cm.get(k) != p][:5])
check("scarabs used by strategies get icons", all(k in icons for k in ("Betrayal Scarab of Reinforcements",
                                                                         "Harvest Scarab of Doubling")))
all_text = json.dumps(guides, ensure_ascii=False)
check("every icon name appears in some guide", all(k in all_text for k in icons), [k for k in icons if k not in all_text][:5])

# -- server copy ----------------------------------------------------------------------
with open(os.path.join(ROOT, "server", "public", "guides.json"), encoding="utf-8") as f:
    server_raw = f.read()
check("server/public/guides.json is the same payload", server_raw == raw)
size = len(raw.encode("utf-8"))
check("payload size reasonable (< 800 KB)", size < 800 * 1024, "%.0f KB" % (size / 1024.0))

# -- corrections layer ------------------------------------------------------------------------
sys.path.insert(0, os.path.join(ROOT, "tools"))
import make_guides  # noqa: E402

research_path = make_guides.default_input()
with open(research_path, encoding="utf-8") as f:
    research_raw = json.load(f)
corrections, corr_path = make_guides.load_corrections(research_path)
check("corrections file exists for the research", corr_path and os.path.basename(corr_path) ==
      os.path.basename(research_path).replace("guides-", "corrections-"), corr_path)
with open(os.path.join(ROOT, "data", "guides.js"), encoding="utf-8") as f:
    header = f.readline()
check("guides.js header names the research and corrections",
      os.path.basename(research_path) in header and os.path.basename(corr_path or "?") in header, header.strip())
fixed = copy.deepcopy(research_raw)
counts, cproblems = make_guides.apply_corrections(fixed, corrections)
check("every correction applies cleanly to the untouched research", not cproblems and sum(counts.values()) == len(corrections),
      "; ".join(cproblems[:4]))
check("every correction has an id, a guide, a reason and https sources",
      all(c.get("id") and c.get("guide") and (c.get("reason") or "").strip() and
          all(str(s).startswith("https://") for s in (c["source"] if isinstance(c.get("source"), list) else [c.get("source")]))
          for c in corrections if c.get("action") != "delete" or c.get("source")),
      [c.get("id") for c in corrections if not (c.get("reason") or "").strip()])
check("replace and add corrections carry a source URL",
      all(c.get("source") for c in corrections if c.get("action") in ("replace", "add")),
      [c.get("id") for c in corrections if c.get("action") in ("replace", "add") and not c.get("source")])

# no stale corrections: the text each replace / delete expected is gone after it ran, so applying it a
# second time fails (adds of a source or a cite fail as duplicates); adds of lines are skipped
stale = []
for c in corrections:
    if c["action"] == "add" and not c["path"].endswith(("readMore", "cite")):
        continue
    if c["action"] == "replace" and c["match"] in json.dumps(c["value"], ensure_ascii=False):
        continue
    again = copy.deepcopy(fixed)
    _, p = make_guides.apply_corrections(again, [c])
    if not p:
        stale.append(c["id"])
check("no stale corrections (each one's old text is gone once applied)", not stale, stale)
check("the research record itself still holds the original text (fixes live in the corrections file)",
      all(c["match"] in json.dumps(next(g for g in research_raw["guides"] if g["id"] == c["guide"]), ensure_ascii=False)
          for c in corrections if c["action"] in ("replace", "delete")))


def shipped_text(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, dict):
        return [v[k] for k in ("text", "name") if isinstance(v.get(k), str)]
    if isinstance(v, list):
        return [x for x in v if isinstance(x, str)]
    return []


missing = [c["id"] for c in corrections if c["action"] in ("replace", "add") and not c["path"].endswith(("readMore", "cite"))
           and not all(t in raw for t in (json.dumps(x, ensure_ascii=False)[1:-1] for x in shipped_text(c["value"])) if t)]
check("corrected text is in the shipped data", not missing, missing)

# -- content checks (3.29) ------------------------------------------------------------------------


def prose(g, with_changes=False):
    """(where, text) for every line a player reads, the readMore titles excluded."""
    yield "summary", g.get("summary", "")
    for key in ("howTo", "dangers", "sell"):
        for i, it in enumerate(g.get(key, [])):
            yield "%s[%d]" % (key, i), it["text"]
    for i, s in enumerate(g.get("strategies", [])):
        for k in ("name", "investment"):
            if s.get(k):
                yield "strategies[%d].%s" % (i, k), s[k]
        for k in ("steps", "atlasPassives", "scarabs"):
            for j, x in enumerate(s.get(k, [])):
                yield "strategies[%d].%s[%d]" % (i, k, j), x
    for i, p in enumerate(g.get("profit", [])):
        yield "profit[%d]" % i, p["text"]
    for i, t in enumerate(g.get("tables", [])):
        for j, r in enumerate(t["rows"]):
            yield "tables[%d].rows[%d]" % (i, j), " | ".join(r)
    for i, q in enumerate(g.get("quickCard", [])):
        yield "quickCard[%d]" % i, q
    if with_changes:
        for i, c in enumerate(g.get("changes", [])):
            yield "changes[%d]" % i, c["text"]


def lines_matching(pattern, with_changes=False, flags=0):
    rx = re.compile(pattern, flags)
    return [(gid, w, t) for gid, g in guides.items() for w, t in prose(g, with_changes) if rx.search(t)]


# Not on the 3.29 Atlas: the 28 maps the 3.29.0 notes remove, plus earlier removals that did not come
# back (3.28.0 notes; PoE Wiki atlas_nodes for the 3.29 series). Checked 2026-11-04.
REMOVED_MAPS = ["Acid Caverns", "Arena", "Ashen Wood", "Bog", "Canyon", "Carcass", "Castle Ruins", "Courtyard", "Coves",
                "Crimson Temple", "Crimson Township", "Cursed Crypt", "Defiled Cathedral", "Dig", "Dry Sea", "Dungeon",
                "Lava Chamber", "Lighthouse", "Maze", "Moon Temple", "Mud Geyser", "Necropolis", "Pen", "Racecourse",
                "Sepulchre", "Underground Sea", "Wasteland", "Wharf",
                "Waste Pool", "Thicket", "Academy", "Bone Crypt", "Precinct", "Shore", "Spider Forest", "Glacier", "Villa",
                "Underground River"]
MAP_RX = re.compile(r"(?<!Grand )(?<!Sanctum )\b(%s)\b(?! of the Minotaur)" % "|".join(re.escape(m) for m in REMOVED_MAPS))
MAP_OK = re.compile(r"3\.28 only|left the Atlas|off the Atlas|removed|no longer on the Atlas")
bad_maps = []
for gid, g in guides.items():
    for w, t in prose(g):
        hits = [m for m in MAP_RX.findall(t) if not (gid == "sanctum" and m == "Necropolis")]  # a Sanctum floor
        if hits and not MAP_OK.search(t):
            bad_maps.append("%s.%s: %s" % (gid, w, ", ".join(hits)))
check("no maps that are off the 3.29 Atlas (unless marked 3.28 only / removed)", not bad_maps, bad_maps[:6])
check("the 3.29 map list is used where guides named removed maps",
      "Dunes, Strand" in json.dumps(guides["syndicate"]["howTo"]) and "City Square, Mesa and Toxic Sewer" in raw)

kirac = [(gid, w) for gid, w, t in lines_matching(r"Kirac")
         if not re.search(r"removed|gone|no longer|Invitation|Outdated|[Oo]lder guides|[Oo]ld guides", t)]
check("no Kirac mission or map-device craft advice", not kirac, kirac[:6])
check("no Kirac craft costs or optional Kirac steps",
      not lines_matching(r"Kirac's \w+ (map-device )?craft (costs|adds)|Optional(ly)? (add )?Kirac", True))
check("no 'Kirac mod not changed in 3.28' history", not lines_matching(r"Kirac.*Not changed in 3\.28", True))
check("Heist and Ultimatum record the 3.28 Map Device craft removal",
      all(any(c["patch"].startswith("3.28") and "Map Device crafting" in c["text"] for c in guides[x]["changes"])
          for x in ("heist", "ultimatum")))
check("no Logbook splitting", not [x for x in lines_matching(r"split.{0,60}(Logbook|Plagued Arachnid)|Logbooks?.{0,60}split")
                                   if not re.search(r"no longer|gone|removed|replaced", x[2])],
      lines_matching(r"split.{0,60}(Logbook|Plagued Arachnid)|Logbooks?.{0,60}split"))
check("Chimeral only as the old name of Craicic Croaker",
      not [x for x in lines_matching(r"Chimeral", True) if not re.search(r"Croaker", x[2])],
      lines_matching(r"Chimeral", True))
check("no chisel-to-quality advice (Cartographer's Chisels are gone since 3.28)",
      not [x for x in lines_matching(r"chisel to \d+%", flags=re.I) if not re.search(r"no longer|gone|out of date", x[2])])
check("no lab enchants as rewards", not lines_matching(r"\b(lab|Labyrinth|helmet) enchant", True, re.I))
check("Breachstones only as vendor fodder",
      not [x for x in lines_matching(r"Breachstone") if not re.search(r"no longer|[Vv]endor|Hivebrain|out of date", x[2])],
      lines_matching(r"Breachstone"))
check("Catalysts only from Ultimatum",
      not [x for x in lines_matching(r"\bCatalysts?\b") if x[0] != "ultimatum" and
           not re.search(r"Ultimatum|no longer|gone|removed|older guides", x[2])],
      [x for x in lines_matching(r"\bCatalysts?\b") if x[0] != "ultimatum"][:4])
ritual_text = json.dumps(guides["ritual"], ensure_ascii=False)
check("Ritual: the Tribute reserve covers the 15% deferral cost (about 3,000, not 2,000)",
      not re.search(r"[Kk]eep (at least )?2,000", ritual_text) and
      any("Keep ~3,000 spare to defer." in q for q in guides["ritual"]["quickCard"]))
check("Horned Scarab of Awakening is reworked, not removed",
      not lines_matching(r"Horned Scarab of Awakening was removed", True) and
      any("Horned Scarab of Awakening was reworked" in c["text"] for c in guides["atlas"]["changes"]))
stier = next(t for t in guides["atlas"]["tables"] if "S tier" in t["title"])
check("Atlas S-tier table: Fruiting Astrolabe Harvest, not the B-tier Cornucopia",
      [r[0] for r in stier["rows"] if "Harvest" in r[0]] == ["Harvest (Fruiting Astrolabe)"], [r[0] for r in stier["rows"]])
check("Atlas and Ultimatum agree on Maxroll's Ultimatum profit rating (Excellent)",
      [r[3] for r in stier["rows"] if r[0] == "Inscribed Ultimatum"] == ["Excellent"] and
      any("'Excellent'" in p["text"] for p in guides["ultimatum"]["profit"]))
check("Ultimatum profit carries the 3.29 ExpCarry test, not 'no tracked div/hour'",
      not lines_matching(r"No independently tracked") and
      any(p.get("who") == "ExpCarry" and "5.3 div/h" in p["text"] for p in guides["ultimatum"]["profit"]))
# same-day price snapshot (4 Nov 2026): Out of Games read the Divine at 422c, poe.ninja at 412c. A line
# that uses 422c must say so and give the poe.ninja value; likewise for Sacred lifeforce (PoEDB 88c, poe.ninja 137c)
div422 = lines_matching(r"422c")
check("every 422c Divine rate names its source and poe.ninja's 412c",
      div422 and all("Out of Games" in t and "412c" in t for _, _, t in div422), div422)
sacred = lines_matching(r"Sacred( Crystallised Lifeforce| lifeforce)? (is|reads as) about")
check("Sacred lifeforce prices show both same-day sources", sacred and all("88c" in t and "137c" in t for _, _, t in sacred), sacred)

# -- syndicate data comes from the same research ----------------------------------------------------
syn, _ = load_js(os.path.join(ROOT, "data", "syndicate.js"), "POE_SYNDICATE")
check("data/syndicate.js parses", isinstance(syn, dict))
check("data/syndicate.js has the guides' asOf", isinstance(syn, dict) and syn.get("asOf") == data["asOf"],
      (syn or {}).get("asOf"))
check("data/syndicate.js is built from the same research and corrections",
      isinstance(syn, dict) and os.path.basename(research_path) in syn.get("source", "") and
      os.path.basename(corr_path or "?") in syn.get("source", ""), (syn or {}).get("source"))
check("make_guides' syndicate check passes", make_guides.check_syndicate(data["asOf"], research_path, corr_path) is None,
      make_guides.check_syndicate(data["asOf"], research_path, corr_path))

# -- bridge (gui.py): validation + Read more links ----------------------------------------
import gui  # noqa: E402

check("bridge accepts the shipped payload", gui.Api._guides_ok(data))
check("bridge refuses a payload without guides", not gui.Api._guides_ok({"version": 1, "guides": {}}))
check("bridge refuses a non-int version", not gui.Api._guides_ok(dict(data, version="1")))
broken = json.loads(raw)
broken["guides"]["blight"]["readMore"][0]["url"] = "javascript:alert(1)"
check("bridge refuses a non-http source", not gui.Api._guides_ok(broken))
api = gui.Api.__new__(gui.Api)
opened = []
gui.webbrowser.open = lambda u: opened.append(u)
src0 = guides["syndicate"]["readMore"][0]["url"]
check("open_url opens a guide's source", api.open_url(src0).get("ok") and opened == [src0], opened)
check("open_url still refuses other pages", not api.open_url("https://example.com/not-a-source").get("ok")
      and not api.open_url(src0 + "x").get("ok") and len(opened) == 1, opened)

# -- the mechanic tools' data (make_guides.build_tools -> payload "tools", js/app/40-43) ------------
import tempfile  # noqa: E402

TOOL_RESEARCH = {"asOf": "3.29", "tools": [
    {"id": "eldritch", "verified": 4, "sources": [
        {"url": "https://www.poewiki.net/wiki/Eldritch_altar", "title": "Eldritch altar", "publisher": "PoE Wiki", "date": "2026", "patch": "3.29"},
        {"url": "https://maxroll.gg/poe/x", "title": "X", "publisher": "Maxroll", "date": "2026", "patch": "3.29"}],
     "data": {"downsides": [
         {"mod": "A", "rating": "Deadly", "dangerousFor": ["es", "reflect"], "why": "w", "cite": [1]},
         {"mod": "B", "rating": "terrible", "dangerousFor": [], "why": "w", "cite": [0]}],
         "upsides": [{"mod": "C", "target": "boss", "value": "high", "note": "n", "cite": [0, 1]}],
         "rules": [{"text": "R", "cite": [0]}]}},
    {"id": "ultimatum", "verified": 1, "sources": [
        {"url": "https://maxroll.gg/poe/x", "title": "X", "publisher": "Maxroll", "date": "2026", "patch": "3.29"}],
     "data": {"mods": [{"name": "Ruin", "rating": "deadly", "dangerousFor": ["all"], "why": "w", "cite": [0]}],
              "winConditions": [], "rules": []}},
    {"id": "strategies", "verified": 1, "sources": [
        {"url": "https://www.poe-vault.com/s", "title": "S", "publisher": "PoE Vault", "date": "2026", "patch": "3.29"}],
     "data": {"strategies": [{"name": "Alch & Go", "stage": ["mid", "weird"], "scarabs": [{"name": "Horned Scarab of Bloodlines", "count": 0}],
                              "maps": [], "mapsPerHour": 12, "costPerMapChaos": -3, "mainDrops": [],
                              "atlasTreeUrl": "javascript:alert(1)", "profit": [], "cite": [0]}]}},
    {"id": "sanctum", "verified": 0, "data": None, "sources": []},
]}
with tempfile.TemporaryDirectory() as td:
    tp = os.path.join(td, "mechtools-3.29.json")
    with open(tp, "w", encoding="utf-8") as f:
        json.dump(TOOL_RESEARCH, f)
    check("tools file found next to the guides research",
          make_guides.tools_input(os.path.join(td, "guides-3.29.json")) == tp)
    del make_guides.TOOL_WARNINGS[:]
    T = make_guides.build_tools(tp)
src_urls = [s["url"] for s in T["sources"]]
check("tools: sources merged and deduped by URL", src_urls == ["https://www.poewiki.net/wiki/Eldritch_altar", "https://maxroll.gg/poe/x",
                                                                "https://www.poe-vault.com/s"], src_urls)
dn = T["eldritch"]["downsides"]
check("tools: an unknown rating is dropped, not guessed; ratings lower-cased",
      [d["mod"] for d in dn] == ["A"] and dn[0]["rating"] == "deadly", dn)
check("tools: unknown build tags left out", dn[0]["dangerousFor"] == ["es"], dn[0]["dangerousFor"])
check("tools: cites re-pointed at the merged list", dn[0]["cite"] == [1] and T["ultimatum"]["mods"][0]["cite"] == [1]
      and T["strategies"][0]["cite"] == [2], (dn[0]["cite"], T["ultimatum"]["mods"][0]["cite"]))
st = T["strategies"][0]
check("tools: strategy stage tags checked, bad atlas URL / cost dropped, scarab count >= 1",
      st["stage"] == ["mid"] and st["atlasTreeUrl"] == "" and st["costPerMapChaos"] is None and st["mapsPerHour"] == 12
      and st["scarabs"] == [{"name": "Horned Scarab of Bloodlines", "count": 1}], st)
check("tools: a topic with no data is left out (the page shows nothing for it)", "sanctum" not in T, sorted(T))
check("tools: warnings name what was dropped", any("terrible" in w for w in make_guides.TOOL_WARNINGS)
      and any("reflect" in w for w in make_guides.TOOL_WARNINGS), make_guides.TOOL_WARNINGS)
with_tools = dict(data, tools=T)
check("bridge accepts a payload with tools", gui.Api._guides_ok(with_tools))
bad_tools = copy.deepcopy(with_tools)
bad_tools["tools"]["sources"][0]["url"] = "file:///C:/x"
check("bridge refuses a tool source that isn't a web page", not gui.Api._guides_ok(bad_tools))
bad_tools = copy.deepcopy(with_tools)
bad_tools["tools"]["strategies"][0]["atlasTreeUrl"] = "http://example.com/tree"
check("bridge refuses a non-https atlas tree link", not gui.Api._guides_ok(bad_tools))
good_atlas = copy.deepcopy(with_tools)
good_atlas["tools"]["strategies"][0]["atlasTreeUrl"] = "https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAA"
api2 = gui.Api.__new__(gui.Api)
api2._guides_cache = (0, good_atlas)
urls = api2._guide_urls()
check("open_url may open the tools' sources and atlas links", "https://www.poe-vault.com/s" in urls and
      "https://www.pathofexile.com/fullscreen-atlas-skill-tree/AAAA" in urls)
if "tools" in data:
    check("shipped tools data passes the bridge", gui.Api._tools_ok(data["tools"]))

# tools corrections (tools/guides/mechtools-corrections-<patch>.json) and strategy stages
STRAT = {"name": "Old Farm", "stage": ["endgame", "pre-3.29-data", "low-investment", "weird"], "scarabs": [], "maps": [],
         "mapsPerHour": None, "costPerMapChaos": None, "mainDrops": [], "atlasTreeUrl": "", "profit": [], "cite": [0]}
del make_guides.TOOL_WARNINGS[:]
st = make_guides.tool_entry("strategies", "strategies", copy.deepcopy(STRAT), "t")
check("tools: endgame -> late; pre-3.29 data flags the strategy and says so in its name; investment words dropped quietly",
      st["stage"] == ["late"] and st.get("outdated") and st["name"] == "Old Farm (pre-3.29 data)"
      and any("'weird'" in w for w in make_guides.TOOL_WARNINGS) and not any("investment" in w for w in make_guides.TOOL_WARNINGS),
      (st, make_guides.TOOL_WARNINGS))
R = copy.deepcopy(TOOL_RESEARCH)
fix_add = {"id": "a", "topic": "eldritch", "key": "downsides", "action": "add", "reason": "r",
           "sources": ["https://maxroll.gg/poe/x"], "value": {"mod": "Z", "rating": "deadly", "dangerousFor": [], "why": "w", "cite": [0]}}
fix_rep = {"id": "b", "topic": "eldritch", "key": "rules", "action": "replace", "match": "R", "value": "R2", "reason": "r",
           "sources": ["https://maxroll.gg/poe/x"]}
make_guides.apply_tool_corrections(R, [fix_add, fix_rep])
eld = [t for t in R["tools"] if t["id"] == "eldritch"][0]["data"]
check("tools corrections: add appends an entry, replace edits the matched text",
      eld["downsides"][-1]["mod"] == "Z" and eld["rules"][0]["text"] == "R2", (eld["downsides"][-1], eld["rules"]))
stale = []
for bad_fix in (dict(fix_add), dict(fix_rep, match="no such text"), dict(fix_add, sources=["http://x"]), dict(fix_rep, key="nope")):
    try:
        make_guides.apply_tool_corrections(copy.deepcopy(R), [bad_fix])
        stale.append(bad_fix["id"])
    except make_guides.Bad:
        pass
check("tools corrections: a stale add / a match that misses / a non-https source / an unknown key stop the build", not stale, stale)
corr_file, _ = make_guides.tools_corrections(os.path.join(ROOT, "tools", "guides", "mechtools-3.29.json"))
check("tools corrections file: every fix has a reason and https sources", corr_file and all(
    c.get("reason") and c.get("sources") and all(u.startswith("https://") for u in c["sources"]) for c in corr_file), corr_file)
if "tools" in data:
    sanct = {a["name"] for a in data["tools"]["sanctum"]["afflictions"]}
    check("shipped tools: Liquid Cowardice is in the Sanctum checker (review fix)", "Liquid Cowardice" in sanct)
    check("shipped tools: the temple room count rule names the fixed Entrance and 11 shaped rooms",
          any("11 rooms the 12 incursions shape" in r["text"] for r in data["tools"]["incursion"]["rules"]))

print("\n" + ("ALL TESTS PASSED" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
