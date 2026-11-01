"""Cheat sheet data — run: python test/test_cheatsheets.py

Checks the generated data/cheatsheets.js (tools/make_cheatsheets.py) without touching the network:
the payload schema, the leveling part (acts 1-10, labs, the act routes and quest gem rewards), the
mechanic sheets (schema, unique ids, plain short cells, match triggers, the new sheets), that
server/public/cheatsheets.json is the same payload, and a few spot facts that came from the wiki."""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
failures = 0
try:
    sys.stdout.reconfigure(errors="backslashreplace")  # details hold non-ASCII names on a cp1252 console
except Exception:
    pass


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


def load_js(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"window\.POE_CHEATSHEETS\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    return json.loads(m.group(1)) if m else None


data = load_js(os.path.join(ROOT, "data", "cheatsheets.js"))
check("data/cheatsheets.js parses", isinstance(data, dict))
if not isinstance(data, dict):
    print("\n%d FAILED" % failures)
    sys.exit(1)

# -- top level ----------------------------------------------------------------------
check("top-level keys", {"source", "fetchedAt", "version", "acts", "labs", "mechanics"} <= set(data), sorted(data))
check("source credits the wiki", "poewiki" in data.get("source", "").lower() and "CC BY-NC-SA" in data.get("source", ""))
check("fetchedAt is a date", bool(re.match(r"^\d{4}-\d{2}-\d{2}$", str(data.get("fetchedAt")))), data.get("fetchedAt"))
v = data.get("version")
check("version is an int YYYYMMDDHHMM", isinstance(v, int) and not isinstance(v, bool) and len(str(v)) == 12
      and str(v)[:8] == data.get("fetchedAt", "").replace("-", ""), v)

# -- leveling part (must be untouched by the mechanics work) -------------------------
acts = data.get("acts", {})
check("acts 1-10 present", sorted(acts, key=int) == [str(i) for i in range(1, 11)], sorted(acts))
check("every act has points/trials/notes lists", all(
    isinstance(a.get("points"), list) and isinstance(a.get("trials"), list) and isinstance(a.get("notes"), list)
    for a in acts.values()))
n_skill = sum(1 for a in acts.values() for q in a["points"] if q.get("kind") == "skill")
n_trials = sum(len(a["trials"]) for a in acts.values())
check("skill-point quests and trials", n_skill >= 15 and n_trials >= 9, (n_skill, n_trials))
check("act 2 has the bandit note", any("Bandit" in n.get("title", "") for n in acts.get("2", {}).get("notes", [])))
check("labs have area levels", isinstance(data.get("labs"), dict) and data["labs"]
      and all(isinstance(x, int) for x in data["labs"].values()), data.get("labs"))

# -- act route ----------------------------------------------------------------------
BAD = re.compile(r"\[\[|\{\{|<|&#")
ROUTE_KEYS = {"area", "id", "level", "wp", "town", "notes"}
AREA_ID = re.compile(r"^[12]_\d+_\w+$")
bad_route, dup_ids, short_routes = [], [], []
for n, a in acts.items():
    route = a.get("route")
    if not isinstance(route, list) or len(route) < 6:
        short_routes.append((n, len(route) if isinstance(route, list) else route))
        continue
    for e in route:
        ok = (isinstance(e, dict) and set(e) == ROUTE_KEYS and isinstance(e["area"], str) and e["area"]
              and isinstance(e["id"], str) and AREA_ID.match(e["id"]) and int(e["id"].split("_")[1]) == int(n)
              and isinstance(e["level"], int) and not isinstance(e["level"], bool)
              and isinstance(e["wp"], bool) and isinstance(e["town"], bool) and isinstance(e["notes"], list)
              and all(isinstance(x, str) and x and len(x) <= 140 and not BAD.search(x) for x in e["notes"]))
        if not ok:
            bad_route.append((n, e))
    ids_ = [e.get("id") for e in route if isinstance(e, dict)]
    if len(ids_) != len(set(ids_)):
        dup_ids.append(n)
check("every act has a route of at least 6 zones", not short_routes, short_routes)
check("route entries have the documented shape (area, id, level, wp, town, notes)", not bad_route, bad_route[:3])
check("route area ids are unique per act", not dup_ids, dup_ids)
check("every act route has exactly one town", all(sum(1 for e in a.get("route", []) if e.get("town")) == 1
                                                  for a in acts.values()))
r1 = acts.get("1", {}).get("route", [])
check("act 1 route starts at The Twilight Strand (1_1_1) with the Hillock quest",
      bool(r1) and r1[0].get("id") == "1_1_1" and any("Hillock" in x for x in r1[0].get("notes", [])), r1[:1])
check("act routes carry trial notes", sum(1 for a in acts.values() for e in a.get("route", [])
                                          for x in e.get("notes", []) if x.startswith("Trial of Ascendancy")) >= 9)

# -- quest gems ---------------------------------------------------------------------
CLASSES = {"Marauder", "Duelist", "Ranger", "Shadow", "Witch", "Templar", "Scion"}
bad_gems = []
for n, a in acts.items():
    gl = a.get("gems")
    if not isinstance(gl, list):
        bad_gems.append((n, "gems not a list"))
        continue
    for q in gl:
        if not (isinstance(q, dict) and {"quest", "npc", "reward", "vendor"} <= set(q) and isinstance(q["quest"], str)
                and q["quest"] and isinstance(q["npc"], str)):
            bad_gems.append((n, q))
            continue
        for g in q["reward"] + q["vendor"]:
            if not (isinstance(g, dict) and set(g) == {"gem", "classes"} and isinstance(g["gem"], str) and g["gem"]
                    and isinstance(g["classes"], list) and g["classes"] and set(g["classes"]) <= CLASSES):
                bad_gems.append((n, q["quest"], g))
check("gem rewards have the documented shape (quest, npc, reward/vendor: gem + classes)", not bad_gems, bad_gems[:3])
g1 = acts.get("1", {}).get("gems", [])
check("act 1 has at least 5 quests with gems", len([q for q in g1 if q.get("reward") or q.get("vendor")]) >= 5, len(g1))
got1 = set(c for q in g1 for g in q.get("reward", []) for c in g.get("classes", []))
check("all 7 classes get a gem reward in act 1", got1 == CLASSES, sorted(CLASSES - got1))
eatg = next((q for q in g1 if q.get("quest") == "Enemy at the Gate"), None)
check("act 1: Enemy at the Gate is handed out by Tarkleigh", eatg and eatg.get("npc") == "Tarkleigh", eatg and eatg.get("npc"))

# -- mechanics schema ----------------------------------------------------------------
mech = data.get("mechanics", [])
check("mechanics is a list of at least 8 sheets", isinstance(mech, list) and len(mech) >= 8, len(mech))
ids = [m.get("id") for m in mech]
check("mechanic ids unique", len(ids) == len(set(ids)), ids)
check("mechanic ids are stable lowercase", all(isinstance(i, str) and re.match(r"^[a-z][a-z0-9_-]*$", i) for i in ids), ids)
GROUPS = {"League mechanics", "Crafting", "Endgame"}
KEYS = {"id", "title", "group", "source", "url", "patch", "match", "sections"}
BAD = re.compile(r"\[\[|\{\{|<|&#")
bad_cells, bad_shape = [], []
for m in mech:
    if set(m) != KEYS:
        bad_shape.append((m.get("id"), "keys", sorted(m)))
        continue
    if not (isinstance(m["title"], str) and m["title"] and m["group"] in GROUPS):
        bad_shape.append((m["id"], "title/group"))
    if not (m["source"].startswith("PoE Wiki: ") and m["url"].startswith("https://www.poewiki.net/wiki/")):
        bad_shape.append((m["id"], "source/url", m["source"], m["url"]))
    if not re.match(r"^\d+\.\d+$", m["patch"]):
        bad_shape.append((m["id"], "patch", m["patch"]))
    mt = m["match"]
    if not (isinstance(mt, dict) and set(mt) == {"areaIds", "areaNames"}
            and all(isinstance(x, list) and all(isinstance(s, str) and s for s in x) for x in mt.values())):
        bad_shape.append((m["id"], "match", mt))
    if not (isinstance(m["sections"], list) and m["sections"]):
        bad_shape.append((m["id"], "no sections"))
    for s in m["sections"]:
        if not isinstance(s.get("title"), str) or not s["title"]:
            bad_shape.append((m["id"], "section title"))
        if "columns" in s:
            if set(s) != {"title", "columns", "rows"} or not s["rows"] or not s["columns"]:
                bad_shape.append((m["id"], s.get("title"), "table keys/empty"))
                continue
            if any(len(r) != len(s["columns"]) for r in s["rows"]):
                bad_shape.append((m["id"], s["title"], "row width"))
            cells = list(s["columns"]) + [c for r in s["rows"] for c in r]
        elif "lines" in s:
            if set(s) != {"title", "lines"} or not s["lines"]:
                bad_shape.append((m["id"], s.get("title"), "list keys/empty"))
                continue
            cells = list(s["lines"])
        else:
            bad_shape.append((m["id"], s.get("title"), "neither table nor list"))
            continue
        for c in cells + [s["title"]]:
            if not isinstance(c, str) or len(c) > 140 or BAD.search(c) or "�" in c:
                bad_cells.append((m["id"], s["title"], c))
check("every sheet and section has the documented shape", not bad_shape, bad_shape[:5])
check("every cell is a short plain string (no [[, {{, <, &#)", not bad_cells, bad_cells[:5])

# -- server copy ---------------------------------------------------------------------
server_path = os.path.join(ROOT, "server", "public", "cheatsheets.json")
try:
    with open(server_path, encoding="utf-8") as f:
        server = json.load(f)
except (OSError, ValueError) as e:
    server = e
check("server/public/cheatsheets.json equals the JS payload", server == data,
      "" if server == data else (server if not isinstance(server, dict) else "differs"))

# -- spot facts from the wiki --------------------------------------------------------
by = {m["id"]: m for m in mech if isinstance(m, dict) and "id" in m}


def table(mid, title_part):
    for s in by.get(mid, {}).get("sections", []):
        if title_part in s["title"] and "rows" in s:
            return s
    return None


if "syndicate" in by:
    t = table("syndicate", "Safehouse rewards")
    check("syndicate: member x four divisions", t and t["columns"] == ["Member", "Transportation", "Fortification",
                                                                      "Research", "Intervention"], t and t["columns"])
    vagan = t and next((r for r in t["rows"] if r[0].startswith("Vagan")), None)
    check("syndicate: Vagan has the 3.29 rewards", vagan and "Trarthan" in vagan[1] and "Enshrouded" in vagan[2], vagan)
    check("syndicate: no abyss jewel rewards left", t and not any(re.search(r"abyss(al)?\b[^;]{0,30}jewel", " ".join(r), re.I)
                                                               for r in t["rows"]))
    check("syndicate: matches the safehouses", "BetrayalSafeHouse" in by["syndicate"]["match"]["areaIds"],
          by["syndicate"]["match"])
if "blight" in by:
    t = table("blight", "Oil tiers")
    check("blight: first oil is Clear Oil", t and t["rows"][0][1] == "Clear Oil", t and t["rows"][:2])
    check("blight: no Tainted/Reflective in the tier list", t and not any(r[1] in ("Tainted Oil", "Reflective Oil")
                                                                      for r in t["rows"]))
    a = table("blight", "Blighted map anoints")
    check("blight: 13 blighted-map anoints", a and len(a["rows"]) == 13, a and len(a["rows"]))
    am = table("blight", "Amulet anoints")
    check("blight: the full amulet anoint list (Notable, Oils; 400+ rows)", am and am["columns"] == ["Notable", "Oils"]
          and len(am["rows"]) >= 400 and all(len(r[1].split(", ")) == 3 for r in am["rows"]), am and len(am["rows"]))
    check("blight: ring anoints table", table("blight", "Ring anoints") is not None)
if "harvest" in by:
    text = " ".join(c for s in by["harvest"]["sections"] for r in s.get("rows", []) for c in r)
    check("harvest: no removed crafts (flask enchants, Synthesise, white socket)",
          not re.search(r"Enchant a Flask|Synthesi[sz]|White", text), "")
    check("harvest: has reforge crafts with lifeforce costs", "Reforge" in text and re.search(r"\d+ (Wild|Vivid|Primal)", text))
if "vendor" in by:
    t = table("vendor", "Influenced full rare item sets")
    check("vendor: identified influenced set gives 1 Exalted Orb", t and any(r[0].startswith("1x Exalted Orb") for r in t["rows"]))
    text = " ".join(c for s in by["vendor"]["sections"] for r in s.get("rows", []) for c in r)
    check("vendor: no Cartographer's Chisel recipe", "Cartographer's Chisel" not in text)
if "bestiary" in by:
    t = table("bestiary", "Recipes")
    check("bestiary: recipes present, no Bestiary Orbs", t and len(t["rows"]) >= 60
          and not any("Bestiary Orb" in " ".join(r) for r in t["rows"]), t and len(t["rows"]))
    check("bestiary: matches The Menagerie", "The Menagerie" in by["bestiary"]["match"]["areaNames"])
if "expedition" in by:
    tujen = next((s for s in by["expedition"]["sections"] if s["title"] == "Tujen"), None)
    check("expedition: Tujen sells no cluster/abyss jewels or catalysts", tujen and not any(
        re.search(r"cluster|abyss(al)? jewel|catalyst", l, re.I) for l in tujen["lines"]))
if "incursion" in by:
    t = table("incursion", "Tier 3")
    check("incursion: Locus of Corruption is a tier 3 room", t and any(r[0] == "Locus of Corruption" for r in t["rows"]))
if "pantheon" in by:
    maj = table("pantheon", "Major gods")
    check("pantheon: four major gods", maj and len(set(r[0] for r in maj["rows"])) == 4, maj and set(r[0] for r in maj["rows"]))
if "delve" in by:
    t = table("delve", "Fossils")
    check("delve: fossils carry a biome", t and all(r[2] for r in t["rows"]) and len(t["rows"]) >= 20)
check("no Kirac missions or lab enchant sheets", not any(re.search(r"kirac|enchant", m["id"]) for m in mech), ids)
NEW_IDS = ["heist", "breach", "legion", "abyss", "delirium", "ritual", "labyrinth", "scarabs", "atlas"]
check("at least 15 mechanic sheets", len(mech) >= 15, len(mech))
check("the new mechanic sheets are present", all(i in by for i in NEW_IDS), [i for i in NEW_IDS if i not in by])
if "breach" in by:
    text = " ".join(c for s in by["breach"]["sections"] for r in s.get("rows", []) for c in r)
    check("breach: no Breachstones (non-functional since 3.28/3.29)", "Breachstone" not in text)
if "legion" in by:
    text = " ".join(c for s in by["legion"]["sections"] for r in s.get("rows", []) for c in r)
    check("legion: no Unrelenting Emblems (removed in 3.29)", "Unrelenting" not in text)
if "labyrinth" in by:
    rows = [" ".join(r) for s in by["labyrinth"]["sections"] for r in s.get("rows", [])]
    check("labyrinth: enchants are not listed as lab rewards", not any(re.search(r"enchant", r, re.I) for r in rows))
    check("labyrinth: matches the labyrinth areas", "EndGame_Labyrinth" in by["labyrinth"]["match"]["areaIds"])
if "heist" in by:
    check("heist: matches the heist areas", "Heist" in by["heist"]["match"]["areaIds"])
if "legion" in by:
    check("legion: matches the Domain of Timeless Conflict",
          "Domain of Timeless Conflict" in by["legion"]["match"]["areaNames"], by["legion"]["match"])
if "delirium" in by:
    check("delirium: matches the Simulacrum arenas", "AfflictionTown" in by["delirium"]["match"]["areaIds"])

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
