"""Generate data/guides.js (bundled with the app) and server/public/guides.json (served by the app's
backend, so installed apps pick up guide fixes between releases): one strategy guide per mechanic
cheat sheet, drawn by js/app/33-guides.js inside the sheet.

Input: tools/guides/guides-<patch>.json, the result of a verified research run
({asOf, guides: [...], verifiedCounts, criticGaps}). Every line in it cites written sources
(guide.readMore, by index). The research file is the record and is never edited by hand: content
errors found after the run are fixed in tools/guides/corrections-<patch>.json, which this script
(and tools/make_syndicate.py) applies before anything else. Each correction names a guide, a path,
an action (replace / delete / add), the exact text it expects to find, a reason, and a source URL
when it changes or adds a fact; one that no longer matches stops the build (see apply_corrections).
Apart from the corrections, this script only checks and reshapes the research; it writes nothing of
its own:
- guide ids become cheat sheet ids (betrayal -> syndicate); a guide with no sheet yet gets a sheet
  entry in "sheets" (the page adds it to the sheet list, with no wiki tables)
- the internal "gaps" lists are dropped, and so are empty fields and the Betrayal "planner" (the
  Syndicate planner has its own data, tools/make_syndicate.py)
- the schema is checked: stage tags, cite indexes in range, table row widths, https sources
- "changes" are sorted newest patch first
- "icons": currency / scarab names from data/currencymap.json that the text mentions, with their
  GGG art path (the page shows them through the art cache)
The version is a YYYYMMDDHHMM stamp; it only moves when the content changes, and the page keeps
whichever copy (shipped or server) has the higher one.

data/syndicate.js (tools/make_syndicate.py) is built from the same research + corrections; this
script refuses to write when that file is for another patch (asOf) or another research file.

  python tools/make_guides.py [tools/guides/guides-3.29.json] [--checked YYYY-MM-DD]
"""
import copy
import datetime
import glob
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JS = os.path.join(ROOT, "data", "guides.js")
OUT_JSON = os.path.join(ROOT, "server", "public", "guides.json")
SHEETS_JS = os.path.join(ROOT, "data", "cheatsheets.js")
SYNDICATE_JS = os.path.join(ROOT, "data", "syndicate.js")
CURRENCYMAP = os.path.join(ROOT, "data", "currencymap.json")

STAGES = ("league-start", "mid", "late", "ssf", "all")
ID_MAP = {"betrayal": "syndicate"}  # research id -> cheat sheet id
# guides whose mechanic has no wiki sheet yet: a sheet entry of their own (no area triggers: the
# mechanic has no area of its own to recognise in Client.txt)
EXTRA_SHEETS = {
    "mercenaries": {"title": "Mercenaries of Trarthus", "group": "League mechanics"},
}
SECTIONS = ("howTo", "strategies", "dangers", "sell", "profit", "changes", "tables")
QUICK_MAX = 6
# currency map categories whose names are safe to spot in prose (card / map names are ordinary words)
ICON_SKIP_CATS = {"Cards", "Maps", "Shaper, Conqueror & Elder Maps", "Legacy Items"}
ICON_MIN_LEN = 6
MIN_GUIDES = 15
SIZE_WARN = 700 * 1024

try:
    sys.stdout.reconfigure(errors="backslashreplace")  # names with accents on a cp1252 console
except Exception:
    pass


class Bad(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Bad(msg)


def is_text(s):
    return isinstance(s, str) and s.strip() != ""


def load_sheet_ids():
    with open(SHEETS_JS, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"window\.POE_CHEATSHEETS\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    need(m, "data/cheatsheets.js does not parse")
    return {x["id"]: x for x in json.loads(m.group(1)).get("mechanics", [])}


DROPPED = []      # out-of-range cites removed (a research slip); a handful is tolerated, more fails the build
MAX_DROPPED = 5


def check_cites(where, cites, n):
    """Cites must be source indexes. One that points past the list is dropped with a warning (the
    line keeps its other sources); a line left with no source at all is an error."""
    need(isinstance(cites, list), "%s: cite is not a list" % where)
    need(all(isinstance(c, int) and not isinstance(c, bool) for c in cites), "%s: cite holds a non-integer" % where)
    bad = [c for c in cites if not 0 <= c < n]
    if bad:
        DROPPED.append("%s: cite %s out of range (%d sources), dropped" % (where, bad, n))
        cites[:] = [c for c in cites if 0 <= c < n]
        need(cites, "%s: no valid cite left" % where)


def check_stage(where, stage):
    need(isinstance(stage, list) and stage, "%s: no stage tags" % where)
    bad = [s for s in stage if s not in STAGES]
    need(not bad, "%s: unknown stage tags %s" % (where, bad))


def patch_key(p):
    m = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", p or "")
    return tuple(int(x or 0) for x in m.groups()) if m else (-1, 0, 0)


# -- corrections ----------------------------------------------------------------------------------
# tools/guides/corrections-<patch>.json: {"research": "guides-<patch>.json", "corrections": [...]}.
# Each correction:
#   id      unique name (shown in errors)
#   guide   research guide id ("betrayal", not the sheet id "syndicate")
#   path    where in that guide: keys and [index] / [text] steps, e.g. "howTo", "summary",
#           "strategies[Cache farming].steps", "tables[S tier].rows". [text] picks the one list
#           element whose text / name / title / goal / url (or, for a table row, its cells) contains it
#   action  replace: path is a string -> `match` (found exactly once) becomes `value`;
#                    path is a list   -> the one element containing `match` is changed: a string
#                    `value` replaces `match` inside it, any other `value` replaces the whole element
#           delete:  path is a list -> the one element containing `match` is removed
#           add:     path is a list -> `value` is appended (or inserted after the one element
#                    containing `match`, when given). A source added to readMore must be new.
#   value   new text / element. A "cite" list in it may name sources by URL (they must be in the
#           guide's readMore; add them first), and an add to a "cite" list may be a URL too.
#   reason  why (required)
#   source  https URL or list of URLs backing the change (required for replace and add)
# A correction whose path or match no longer fits (0 or 2+ hits) is an error, so a research update
# can't silently leave a stale fix behind.
ACTIONS = ("replace", "delete", "add")
SOURCE_RE = re.compile(r"^https://[^\s/]+\.[^\s/]+\S*$")
PATH_TOKEN = re.compile(r"\.?([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\]")
LABEL_KEYS = ("text", "name", "title", "goal", "url")


def corrections_path(research_path):
    """tools/guides/guides-3.29.json -> tools/guides/corrections-3.29.json"""
    folder, base = os.path.split(research_path)
    return os.path.join(folder, re.sub(r"^guides-", "corrections-", base))


def load_corrections(research_path):
    """(corrections list, file path) for a research file; ([], None) when it has no corrections file."""
    path = corrections_path(research_path)
    if not os.path.exists(path):
        return [], None
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    need(isinstance(doc, dict) and isinstance(doc.get("corrections"), list), "%s: no corrections list" % path)
    need(doc.get("research") == os.path.basename(research_path),
         "%s is for %r, not %s" % (os.path.basename(path), doc.get("research"), os.path.basename(research_path)))
    return doc["corrections"], path


def label(x):
    """The text a list element is picked by."""
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        return next((x[k] for k in LABEL_KEYS if isinstance(x.get(k), str)), "")
    if isinstance(x, list):
        return " | ".join(c for c in x if isinstance(c, str))
    return ""


def pick(items, needle, where):
    hits = [i for i, x in enumerate(items) if needle in label(x)]
    need(len(hits) == 1, "%s: %d elements contain %r (need exactly 1)" % (where, len(hits), needle))
    return hits[0]


def walk_path(guide, path, where):
    """(parent, key) of the value a correction path addresses."""
    tokens, pos = [], 0
    while pos < len(path):
        m = PATH_TOKEN.match(path, pos)
        need(m and m.end() > pos, "%s: bad path %r" % (where, path))
        tokens.append(m.group(1) if m.group(1) is not None else ("[]", m.group(2)))
        pos = m.end()
    need(tokens, "%s: empty path" % where)
    parent, key, cur = None, None, guide
    for t in tokens:
        if isinstance(t, tuple):
            need(isinstance(cur, list), "%s: %r: not a list before [%s]" % (where, path, t[1]))
            if re.match(r"^\d+$", t[1]):
                key = int(t[1])
                need(key < len(cur), "%s: %r: index %d out of range" % (where, path, key))
            else:
                key = pick(cur, t[1], "%s %r" % (where, path))
        else:
            need(isinstance(cur, dict) and t in cur, "%s: %r: no %r" % (where, path, t))
            key = t
        parent, cur = cur, cur[key]
    return parent, key


def cite_index(guide, c, where):
    """A cite given as a readMore URL -> its index."""
    if isinstance(c, int) and not isinstance(c, bool):
        return c
    urls = [r.get("url") for r in guide.get("readMore", [])]
    need(isinstance(c, str) and urls.count(c) == 1, "%s: cite %r is not a readMore source (add it first)" % (where, c))
    return urls.index(c)


def with_cites(value, guide, where):
    if isinstance(value, dict) and isinstance(value.get("cite"), list):
        return dict(value, cite=[cite_index(guide, c, where) for c in value["cite"]])
    return value


def replace_once(text, match, value, where):
    need(text.count(match) == 1, "%s: %r appears %d times (need exactly 1)" % (where, match, text.count(match)))
    need(isinstance(value, str), "%s: replacing text needs a text value" % where)
    return text.replace(match, value)


def apply_one(guide, c, where):
    action, match, value = c.get("action"), c.get("match"), c.get("value")
    need(action in ACTIONS, "%s: action must be one of %s" % (where, ", ".join(ACTIONS)))
    need(is_text(c.get("reason")), "%s: no reason" % where)
    src = c.get("source")
    srcs = src if isinstance(src, list) else ([src] if src is not None else [])
    need(all(isinstance(s, str) and SOURCE_RE.match(s) for s in srcs), "%s: source must be https URL(s)" % where)
    need(srcs or action == "delete", "%s: a %s needs a source URL" % (where, action))
    need(is_text(c.get("path")), "%s: no path" % where)
    need(action == "add" or is_text(match), "%s: no match" % where)
    need(action == "delete" or value is not None, "%s: no value" % where)
    parent, key = walk_path(guide, c["path"], where)
    target = parent[key]
    if action == "replace" and isinstance(target, str):
        parent[key] = replace_once(target, match, value, where)
        return
    need(isinstance(target, list), "%s: %r is not a list" % (where, c["path"]))
    if action == "add":
        if key == "cite":
            idx = cite_index(guide, value, where)
            need(idx not in target, "%s: already cites %r" % (where, value))
            target.append(idx)
            return
        if key == "readMore":
            need(isinstance(value, dict) and value.get("url") not in [r.get("url") for r in target],
                 "%s: readMore already lists %r" % (where, value.get("url") if isinstance(value, dict) else value))
        value = with_cites(copy.deepcopy(value), guide, where)
        if is_text(match):
            target.insert(pick(target, match, where) + 1, value)
        else:
            target.append(value)
        return
    i = pick(target, match, where)
    if action == "delete":
        del target[i]
        return
    el = target[i]
    if not isinstance(value, str):  # the whole element
        need(type(value) is type(el), "%s: value is a %s, the element a %s" % (where, type(value).__name__, type(el).__name__))
        target[i] = with_cites(copy.deepcopy(value), guide, where)
    elif isinstance(el, str):
        target[i] = replace_once(el, match, value, where)
    elif isinstance(el, dict):
        k = next(k for k in LABEL_KEYS if isinstance(el.get(k), str))
        el[k] = replace_once(el[k], match, value, where)
    else:  # a table row: the one cell holding the text
        cells = [j for j, x in enumerate(el) if isinstance(x, str) and match in x]
        need(len(cells) == 1, "%s: %d cells contain %r" % (where, len(cells), match))
        el[cells[0]] = replace_once(el[cells[0]], match, value, where)


def apply_corrections(research, corrections):
    """Apply the corrections to the research (in place, in file order). Returns ({guide id: count},
    [problems]); any problem means the corrections no longer fit the research."""
    guides = {g.get("id"): g for g in research.get("guides", [])}
    counts, problems, ids = {}, [], set()
    for n, c in enumerate(corrections):
        where = "correction %d (%s)" % (n, c.get("id") if isinstance(c, dict) else "?")
        try:
            need(isinstance(c, dict) and is_text(c.get("id")), "%s: no id" % where)
            need(c["id"] not in ids, "%s: duplicate id" % where)
            ids.add(c["id"])
            need(c.get("guide") in guides, "%s: no guide %r" % (where, c.get("guide")))
            apply_one(guides[c["guide"]], c, where)
            counts[c["guide"]] = counts.get(c["guide"], 0) + 1
        except Bad as e:
            problems.append(str(e))
    return counts, problems


def corrected_research(path):
    """(research with its corrections applied, corrections file or None, {guide: count}).
    Raises Bad when a correction does not apply."""
    with open(path, encoding="utf-8") as f:
        research = json.load(f)
    corrections, cpath = load_corrections(path)
    counts, problems = apply_corrections(research, corrections)
    if problems:
        raise Bad("%d correction(s) in %s no longer apply:\n    %s"
                  % (len(problems), os.path.basename(cpath), "\n    ".join(problems)))
    # patch updates (tools/make_update.py): what a later patch changed, applied on top, in name order
    del UPDATES_APPLIED[:]
    for upath in update_paths(path):
        with open(upath, encoding="utf-8") as f:
            doc = json.load(f)
        need(doc.get("research") == os.path.basename(path), "%s is for %r" % (os.path.basename(upath), doc.get("research")))
        ucounts, problems = apply_corrections(research, doc.get("corrections") or [])
        if problems:
            raise Bad("%d update(s) in %s no longer apply:\n    %s"
                      % (len(problems), os.path.basename(upath), "\n    ".join(problems)))
        UPDATES_APPLIED.append((os.path.basename(upath), sum(ucounts.values())))
    return research, cpath, counts


UPDATES_APPLIED = []


def update_paths(research_path):
    """tools/guides/guides-3.29.json -> [tools/guides/updates-3.29-to-3.30.json, ...]"""
    folder, base = os.path.split(research_path)
    patch = re.sub(r"^guides-|[.]json$", "", base)
    return sorted(glob.glob(os.path.join(folder, "updates-%s-to-*.json" % patch)))


def check_syndicate(asof, research_path, cpath):
    """data/syndicate.js must come from the same research file, corrections and patch."""
    try:
        with open(SYNDICATE_JS, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return "data/syndicate.js is missing: run python tools/make_syndicate.py"
    m = re.search(r"window\.POE_SYNDICATE\s*=\s*(\{.*\})\s*;\s*$", text, re.S)
    if not m:
        return "data/syndicate.js does not parse"
    syn = json.loads(m.group(1))
    source = syn.get("source") or ""
    if str(syn.get("asOf")) != asof:
        return "data/syndicate.js is as of %r but the research is as of %r: run python tools/make_syndicate.py" % (
            syn.get("asOf"), asof)
    for name in [os.path.basename(research_path)] + ([os.path.basename(cpath)] if cpath else []):
        if name not in source:
            return "data/syndicate.js was not built from %s (source %r): run python tools/make_syndicate.py" % (name, source)
    return None


def clean_line(item, keys):
    """Keep only the known keys, drop empty values, de-duplicate cites (order kept)."""
    out = {}
    for k in keys:
        v = item.get(k)
        if k == "cite" and isinstance(v, list):
            seen = []
            for c in v:
                if c not in seen:
                    seen.append(c)
            v = seen
        if isinstance(v, str):
            v = v.strip()
        if isinstance(v, list) and all(isinstance(x, str) for x in v):
            v = [x.strip() for x in v if x.strip()]
        if v in (None, "", [], {}):
            continue
        out[k] = v
    return out


def build_guide(g):
    gid = g.get("id")
    need(is_text(gid), "guide without an id")
    need(is_text(g.get("title")) and is_text(g.get("summary")), "%s: title / summary missing" % gid)
    src = g.get("readMore")
    need(isinstance(src, list) and src, "%s: no readMore sources" % gid)
    n = len(src)
    sources = []
    for i, r in enumerate(src):
        w = "%s.readMore[%d]" % (gid, i)
        need(isinstance(r, dict) and is_text(r.get("url")) and is_text(r.get("title")), "%s: url / title missing" % w)
        need(re.match(r"^https?://[^\s/]+\.[^\s/]+", r["url"]) and " " not in r["url"], "%s: bad url %r" % (w, r["url"]))
        sources.append(clean_line(r, ("url", "title", "publisher", "date", "patch")))

    out = {"title": g["title"].strip(), "asOf": str(g.get("asOf") or "").strip(), "summary": g["summary"].strip()}
    for key in ("howTo", "dangers", "sell"):
        lines = []
        for i, it in enumerate(g.get(key) or []):
            w = "%s.%s[%d]" % (gid, key, i)
            need(isinstance(it, dict) and is_text(it.get("text")), "%s: no text" % w)
            check_stage(w, it.get("stage"))
            check_cites(w, it.get("cite", []), n)
            lines.append(clean_line(it, ("text", "stage", "cite")))
        out[key] = lines
    strategies = []
    for i, s in enumerate(g.get("strategies") or []):
        w = "%s.strategies[%d]" % (gid, i)
        need(isinstance(s, dict) and is_text(s.get("name")), "%s: no name" % w)
        check_stage(w, s.get("stage"))
        check_cites(w, s.get("cite", []), n)
        for k in ("steps", "atlasPassives", "scarabs"):
            need(isinstance(s.get(k, []), list) and all(isinstance(x, str) for x in s.get(k, [])), "%s.%s: not a list of text" % (w, k))
        need(s.get("steps"), "%s: no steps" % w)
        strategies.append(clean_line(s, ("name", "investment", "stage", "steps", "atlasPassives", "scarabs", "cite")))
    out["strategies"] = strategies
    profit = []
    for i, p in enumerate(g.get("profit") or []):
        w = "%s.profit[%d]" % (gid, i)
        need(isinstance(p, dict) and is_text(p.get("text")), "%s: no text" % w)
        check_cites(w, p.get("cite", []), n)
        profit.append(clean_line(p, ("text", "who", "date", "cite")))
    out["profit"] = profit
    changes = []
    for i, c in enumerate(g.get("changes") or []):
        w = "%s.changes[%d]" % (gid, i)
        need(isinstance(c, dict) and is_text(c.get("text")) and is_text(c.get("patch")), "%s: text / patch missing" % w)
        check_cites(w, c.get("cite", []), n)
        changes.append(clean_line(c, ("patch", "text", "cite")))
    out["changes"] = sorted(changes, key=lambda c: patch_key(c["patch"]), reverse=True)  # stable: same patch keeps order
    tables = []
    for i, t in enumerate(g.get("tables") or []):
        w = "%s.tables[%d]" % (gid, i)
        cols = t.get("columns")
        need(is_text(t.get("title")) and isinstance(cols, list) and cols and all(is_text(c) for c in cols), "%s: title / columns" % w)
        rows = t.get("rows")
        need(isinstance(rows, list) and rows, "%s: no rows" % w)
        for j, r in enumerate(rows):
            need(isinstance(r, list) and len(r) == len(cols) and all(isinstance(x, str) for x in r),
                 "%s.rows[%d]: %d cells for %d columns" % (w, j, len(r) if isinstance(r, list) else -1, len(cols)))
        check_cites(w, t.get("cite", []), n)
        tables.append({"title": t["title"].strip(), "columns": cols, "rows": rows, "cite": t.get("cite") or []})
        if not tables[-1]["cite"]:
            del tables[-1]["cite"]
    out["tables"] = tables
    quick = g.get("quickCard") or []
    need(isinstance(quick, list) and quick and len(quick) <= QUICK_MAX and all(is_text(q) for q in quick),
         "%s: quickCard must be 1-%d lines" % (gid, QUICK_MAX))
    out["quickCard"] = [q.strip() for q in quick]
    # "planner" (Betrayal) is left out: tools/make_syndicate.py builds the Syndicate planner's own data
    # from the same research file (data/syndicate.js)
    out["readMore"] = sources
    return {k: v for k, v in out.items() if v not in (None, "", [], {})}


def all_text(guide):
    """Every prose line of a guide (where currency names are looked for)."""
    for key in ("howTo", "dangers", "sell"):
        for it in guide.get(key, []):
            yield it["text"]
    for s in guide.get("strategies", []):
        yield s.get("investment", "")
        for k in ("steps", "scarabs"):
            for x in s.get(k, []):
                yield x
    for p in guide.get("profit", []):
        yield p["text"]
    yield guide.get("summary", "")


def icon_names():
    with open(CURRENCYMAP, encoding="utf-8") as f:
        cm = json.load(f)
    names = {}
    for v in cm.values():
        name, img = (v.get("name") or "").strip(), v.get("img") or ""
        if (len(name) >= ICON_MIN_LEN and img.startswith("/") and v.get("cat") not in ICON_SKIP_CATS
                and name not in names):
            names[name] = img
    return names


def find_icons(guides, names):
    """name -> art path for each currency / scarab name some guide line mentions (whole words,
    plural 's' allowed), longest name first so "Gilded Ambush Scarab" wins over "Ambush Scarab"."""
    order = sorted(names, key=len, reverse=True)
    pat = re.compile(r"(?<![A-Za-z'])(" + "|".join(re.escape(n) for n in order) + r")(?=s?(?![A-Za-z]))")
    used = {}
    for g in guides.values():
        for line in all_text(g):
            for m in pat.finditer(line or ""):
                used[m.group(1)] = names[m.group(1)]
    return dict(sorted(used.items()))


# ---- the mechanic tools' data (js/app/40-43): tools/guides/mechtools-<patch>.json ------------------
# The verified research run for the interactive tools (pickers, room planner, strategy setups):
# {asOf, tools: [{id, verified, data, sources}]}, each topic citing its own source list. Here the
# topics' sources merge into one list (deduped by URL), every cite is re-pointed at it, and the
# ratings / build tags / stage tags are checked; an entry with an unknown rating is dropped with a
# warning (never guessed). It ships inside the guides payload as "tools".
TOOL_TOPICS = {
    "eldritch": {"downsides": "mod", "upsides": "mod", "rules": "text"},
    "ultimatum": {"mods": "name", "winConditions": "name", "rules": "text"},
    "sanctum": {"afflictions": "name", "boons": "name", "rules": "text"},
    "expedition": {"remnants": "mod", "rules": "text"},
    "incursion": {"rooms": "tier3Room", "goals": "name", "rules": "text"},
    "strategies": {"strategies": "name"},
}
DANGER_RATINGS = ("safe", "caution", "deadly")
VALUE_RATINGS = ("high", "medium", "low")
BUILD_TAGS = ("life-regen", "leech", "es", "minion", "dot", "attack", "melee", "spell", "crit", "low-max-res", "flask",
              "curse", "mana", "low-ehp", "low-life", "low-mobility", "low-dps", "armour", "evasion",
              "phys", "fire", "cold", "lightning", "chaos", "all")
# the research's own words for the same build traits -> the tools' tags (one may stand for several);
# situational notes ("early floors", "hardcore") aren't build types and stay in the "why" text only
TAG_ALIASES = {
    "all-builds": ["all"], "minions": ["minion"], "energy-shield": ["es"], "ci": ["es"], "mom": ["mana"],
    "face-tank": ["melee", "low-ehp"], "glass-cannon": ["low-ehp"], "low-life-pool": ["low-ehp"],
    "no-crit-damage-reduction": ["low-ehp"], "drops-low-between-hits": ["low-life"], "physical": ["phys"],
    "poison": ["chaos"], "ignite": ["fire"], "freeze": ["cold"], "shock": ["lightning"],
    "elemental": ["fire", "cold", "lightning"], "cast-on-crit": ["crit"], "slow-dot": ["dot"],
}
TOOL_WARNINGS = []
TOOL_STATS = {}
# the research's stage words for strategies -> the guides' stages; "pre-3.29-data" marks advice from
# before this patch (the strategy is flagged outdated, its name says so)
STAGE_ALIASES = {"endgame": "late", "late-league": "late"}
STAGE_NOTES = {"low-investment", "high-investment"}  # investment levels, not stages: dropped quietly


def tools_corrections(tools_path):
    """tools/guides/mechtools-corrections-<patch>.json next to the tools research: [corrections]."""
    p = re.sub(r"mechtools-([^\\/]+)\.json$", r"mechtools-corrections-\1.json", tools_path)
    if p == tools_path or not os.path.exists(p):
        return [], None
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("corrections") or [], p


def apply_tool_corrections(research, corrections):
    """Apply add / replace / delete fixes to the tools research (in memory). A replace or delete whose
    match doesn't hit exactly one entry stops the build (a stale correction)."""
    topics = {t.get("id"): t for t in research.get("tools") or []}
    for c in corrections:
        where = "tools correction %s" % c.get("id")
        need(c.get("action") in ("add", "replace", "delete") and is_text(c.get("reason")), "%s: action and reason" % where)
        need(all(SOURCE_RE.match(u) for u in c.get("sources") or []) and (c["action"] == "delete" or c.get("sources")),
             "%s: https sources" % where)
        t = topics.get(c.get("topic"))
        need(t and isinstance(t.get("data"), dict) and c.get("key") in TOOL_TOPICS.get(c["topic"], {}), "%s: topic/key" % where)
        items = t["data"].setdefault(c["key"], [])
        label_key = TOOL_TOPICS[c["topic"]][c["key"]]
        if c["action"] == "add":
            v = c.get("value")
            need(isinstance(v, dict) and is_text(v.get(label_key)), "%s: value" % where)
            need(not any((e or {}).get(label_key) == v[label_key] for e in items), "%s: already there (stale)" % where)
            items.append(copy.deepcopy(v))
            continue
        hits = [i for i, e in enumerate(items) if c.get("match") and c["match"] in str((e or {}).get(label_key) or "")]
        need(len(hits) == 1, "%s: match hits %d entries (stale?)" % (where, len(hits)))
        if c["action"] == "delete":
            items.pop(hits[0])
        else:
            e = items[hits[0]]
            e[label_key] = e[label_key].replace(c["match"], c["value"])
    return research


def tools_input(guides_path):
    """tools/guides/mechtools-<patch>.json next to the guides research, or None."""
    patch = re.sub(r"^guides-|\.json$", "", os.path.basename(guides_path))
    p = os.path.join(os.path.dirname(guides_path), "mechtools-%s.json" % patch)
    return p if os.path.exists(p) else None


def tool_entry(topic, key, e, where):
    """One entry, checked; None (with a warning) when its rating isn't one the tools know."""
    need(isinstance(e, dict), "%s: not an object" % where)
    if topic == "strategies":
        need(is_text(e.get("name")), "%s: no name" % where)
        raw = [str(s).strip().lower() for s in e.get("stage") or []]
        if "pre-3.29-data" in raw:
            e["outdated"] = True
            if not re.search(r"pre-3\.29|old guide", e["name"], re.I):
                e["name"] += " (pre-3.29 data)"
        stages = []
        for s in raw:
            s = STAGE_ALIASES.get(s, s)
            if s in STAGES and s not in stages:
                stages.append(s)
            elif s not in STAGES and s not in STAGE_NOTES and s != "pre-3.29-data":
                TOOL_WARNINGS.append("%s: unknown stage %r left out" % (where, s))
        e["stage"] = stages or ["all"]
        e["scarabs"] = [{"name": s["name"].strip(), "count": max(1, int(s.get("count") or 1))}
                        for s in e.get("scarabs") or [] if isinstance(s, dict) and is_text(s.get("name"))]
        url = str(e.get("atlasTreeUrl") or "").strip()
        e["atlasTreeUrl"] = url if SOURCE_RE.match(url) else ""
        for k in ("mapsPerHour", "costPerMapChaos"):
            v = e.get(k)
            e[k] = v if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None
        e["profit"] = [p for p in e.get("profit") or [] if isinstance(p, dict) and is_text(p.get("text"))]
        return e
    if "rating" in e or key in ("downsides", "mods", "afflictions", "remnants"):
        r = str(e.get("rating") or "").strip().lower()
        good = topic == "expedition" and e.get("kind") == "good"
        allowed = VALUE_RATINGS if good else DANGER_RATINGS
        if key in ("winConditions",):
            allowed = DANGER_RATINGS + VALUE_RATINGS
        if r not in allowed:
            TOOL_WARNINGS.append("%s: rating %r is not one of %s, dropped" % (where, r, "/".join(allowed)))
            return None
        e["rating"] = r
    if "value" in e:
        v = str(e.get("value") or "").strip().lower()
        if v not in VALUE_RATINGS:
            TOOL_WARNINGS.append("%s: value %r is not one of %s, dropped" % (where, v, "/".join(VALUE_RATINGS)))
            return None
        e["value"] = v
    if "dangerousFor" in e:
        tags = []
        for t in (str(t).strip().lower() for t in e.get("dangerousFor") or []):
            for x in TAG_ALIASES.get(t, [t]):
                if x not in tags:
                    tags.append(x)
        unknown = [t for t in tags if t not in BUILD_TAGS]
        if unknown:
            TOOL_WARNINGS.append("%s: unknown build tags %s left out" % (where, unknown))
        e["dangerousFor"] = [t for t in tags if t in BUILD_TAGS]
    return e


def build_tools(path):
    """The tools' payload from the research file at path: {asOf, sources, <topic>: {...}, strategies}."""
    with open(path, encoding="utf-8") as f:
        research = json.load(f)
    corrections, cpath = tools_corrections(path)
    apply_tool_corrections(research, corrections)
    sources, index = [], {}
    out = {"asOf": str(research.get("asOf") or "").strip()}
    TOOL_STATS["corrections"] = (len(corrections), os.path.basename(cpath) if cpath else None)
    for t in research.get("tools") or []:
        topic = t.get("id")
        if topic not in TOOL_TOPICS or not isinstance(t.get("data"), dict):
            continue
        local = []  # this topic's source i -> the merged list's index
        for s in t.get("sources") or []:
            url = str((s or {}).get("url") or "").strip()
            need(SOURCE_RE.match(url) or url.startswith("http://"), "%s: source %r is not a web page" % (topic, url))
            if url not in index:
                index[url] = len(sources)
                sources.append({k: str(s.get(k) or "").strip() for k in ("url", "title", "publisher", "date", "patch")})
            local.append(index[url])
        shaped = {}
        for key, label_key in TOOL_TOPICS[topic].items():
            kept = []
            for i, e in enumerate(t["data"].get(key) or []):
                where = "tools.%s.%s[%d] %s" % (topic, key, i, str((e or {}).get(label_key) or "")[:40])
                need(is_text((e or {}).get(label_key)), "%s: no %s" % (where, label_key))
                cites = list(e.get("cite") or [])
                check_cites(where, cites, len(local))
                e = tool_entry(topic, key, copy.deepcopy(e), where)
                if e is None:
                    continue
                e["cite"] = sorted({local[c] for c in cites})
                kept.append(e)
            shaped[key] = kept
        if topic == "strategies":
            out["strategies"] = shaped["strategies"]
        else:
            out[topic] = shaped
    out["sources"] = sources
    return out


# ---- notices and retired content: tools/guides/notices.json --------------------------------------
NOTICE_TONES = ("info", "warn")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def load_notices(guides_path, sheet_ids):
    """({notices: [...], retired: {...}}) from notices.json next to the research; {} when absent."""
    p = os.path.join(os.path.dirname(guides_path), "notices.json")
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        raw = json.load(f)
    notices, seen = [], set()
    for i, n in enumerate(raw.get("notices") or []):
        where = "notices[%d]" % i
        need(is_text(n.get("id")) and n["id"] not in seen, "%s: id missing or repeated" % where)
        seen.add(n["id"])
        need(is_text(n.get("text")) and ISO_RE.match(str(n.get("from") or "")), "%s: text and from (UTC, ...Z)" % where)
        sheets = n.get("sheets")
        need(sheets == "all" or (isinstance(sheets, list) and sheets and all(x in sheet_ids for x in sheets)),
             "%s: sheets must be \"all\" or known sheet ids" % where)
        need(n.get("tone", "info") in NOTICE_TONES, "%s: tone" % where)
        out = {"id": n["id"], "from": n["from"], "sheets": sheets, "tone": n.get("tone", "info"), "text": n["text"].strip()}
        if n.get("untilAsOf"):
            need(re.match(r"^\d+\.\d+$", str(n["untilAsOf"])), "%s: untilAsOf is a patch" % where)
            out["untilAsOf"] = str(n["untilAsOf"])
        notices.append(out)
    retired = {}
    for k, r in (raw.get("retired") or {}).items():
        need(is_text(r.get("text")) and ISO_RE.match(str(r.get("from") or "")) and re.match(r"^\d+\.\d+$", str(r.get("patch") or "")),
             "retired.%s: text, from and patch" % k)
        retired[k] = {"patch": str(r["patch"]), "from": r["from"], "text": r["text"].strip()}
    return {"notices": notices, "retired": retired}


def default_input():
    files = sorted(glob.glob(os.path.join(ROOT, "tools", "guides", "guides-*.json")), key=lambda p: patch_key(
        re.sub(r"^guides-|\.json$", "", os.path.basename(p))))
    need(files, "no tools/guides/guides-*.json")
    return files[-1]


def previous():
    try:
        with open(OUT_JSON, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    checked = None
    if "--checked" in argv:
        i = argv.index("--checked")
        checked = argv[i + 1] if i + 1 < len(argv) else None
        args = [a for a in args if a != checked]
    path = args[0] if args else default_input()
    research, cpath, fixed = corrected_research(path)  # the record stays untouched on disk
    if not checked:  # the day the research run was saved
        checked = datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    need(re.match(r"^\d{4}-\d{2}-\d{2}$", checked or ""), "--checked must be YYYY-MM-DD")
    syndicate = check_syndicate(str(research.get("asOf") or "").strip(), path, cpath)
    need(not syndicate, syndicate)
    sheets = load_sheet_ids()
    guides, extra, problems = {}, {}, []
    for g in research.get("guides", []):
        try:
            gid = g.get("id")
            sid = ID_MAP.get(gid, gid)
            need(sid in sheets or sid in EXTRA_SHEETS, "%s: no cheat sheet %r (add it to EXTRA_SHEETS or ID_MAP)" % (gid, sid))
            need(sid not in guides, "%s: two guides for sheet %s" % (gid, sid))
            guides[sid] = build_guide(g)
            if sid in EXTRA_SHEETS and sid not in sheets:
                extra[sid] = dict(EXTRA_SHEETS[sid], id=sid)
        except Bad as e:
            problems.append(str(e))
    for p in problems:
        print("  - " + p)
    for d in DROPPED:
        print("  warning: " + d)
    if len(DROPPED) > MAX_DROPPED:
        problems.append("%d out-of-range cites (more than %d): the research file looks broken" % (len(DROPPED), MAX_DROPPED))
    if problems or len(guides) < MIN_GUIDES:
        print("%d problems, %d guides (need %d): not writing" % (len(problems), len(guides), MIN_GUIDES))
        return 1
    order = [ID_MAP.get(g["id"], g["id"]) for g in research["guides"]]
    data = {"asOf": str(research.get("asOf") or "").strip(), "checked": checked,
            "guides": {sid: guides[sid] for sid in order},
            "sheets": [extra[s] for s in order if s in extra],
            "icons": find_icons(guides, icon_names())}
    try:
        extra_keys = load_notices(path, set(sheets) | set(guides))
    except Bad as e:
        print("  notices: %s: not writing" % e)
        return 1
    data.update({k: v for k, v in extra_keys.items() if v})
    if UPDATES_APPLIED:  # the patch the newest update file brings the guides to ("Changed in 3.30")
        data["currentPatch"] = re.sub(r"^updates-.*-to-|[.]json$", "", UPDATES_APPLIED[-1][0])
    tpath = tools_input(path)
    if tpath:
        n0 = len(DROPPED)
        try:
            data["tools"] = build_tools(tpath)
            need(data["tools"]["asOf"] == data["asOf"], "tools research is for %s, guides for %s"
                 % (data["tools"]["asOf"], data["asOf"]))
        except Bad as e:
            print("  tools: %s: not writing" % e)
            return 1
        for d in DROPPED[n0:]:
            print("  warning: " + d)
        if len(DROPPED) > MAX_DROPPED:  # the guides' and the tools' slips together
            print("%d out-of-range cites (more than %d): a research file looks broken: not writing" % (len(DROPPED), MAX_DROPPED))
            return 1
        for w in TOOL_WARNINGS:
            print("  warning: " + w)
        nc, cname = TOOL_STATS.get("corrections") or (0, None)
        if cname:
            print("  %d tools corrections from %s" % (nc, cname))
        t = data["tools"]
        print("  tools from %s: %d sources; %s" % (os.path.basename(tpath), len(t["sources"]), ", ".join(
            "%s %d" % (k, sum(len(v) for v in t[k].values()) if isinstance(t[k], dict) else len(t[k]))
            for k in TOOL_TOPICS if k in t)))
    prev = previous()
    stamp = int(time.strftime("%Y%m%d%H%M"))
    if prev and {k: v for k, v in prev.items() if k != "version"} == data and isinstance(prev.get("version"), int):
        stamp = prev["version"]  # same content: same version (no churn on re-runs)
    elif prev and isinstance(prev.get("version"), int) and stamp <= prev["version"]:
        stamp = prev["version"] + 1
    data = dict({"version": stamp}, **data)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_guides.py from %s%s: strategy guides for the mechanic cheat sheets\n"
                % (os.path.relpath(path, ROOT).replace("\\", "/"),
                   " + " + os.path.basename(cpath) if cpath else ""))
        f.write("// (community research summary; every line cites the written sources in its guide's readMore)\n")
        f.write("window.POE_GUIDES = " + payload + ";\n")
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        f.write(payload)

    size = len(payload.encode("utf-8"))
    per = sorted(((len(json.dumps(g, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), sid)
                  for sid, g in guides.items()), reverse=True)
    counts = {k: sum(len(g.get(k, [])) for g in guides.values()) for k in SECTIONS + ("readMore",)}
    print("Wrote data/guides.js and server/public/guides.json (version %d, as of %s, checked %s)"
          % (stamp, data["asOf"], checked))
    print("  %d guides (%s), %d extra sheet(s): %s" % (len(guides), ", ".join(order), len(extra),
                                                       ", ".join(extra) or "none"))
    for name, n in UPDATES_APPLIED:
        print("  %d patch updates from %s" % (n, name))
    print("  %d corrections from %s (%s)" % (sum(fixed.values()), os.path.basename(cpath) if cpath else "no corrections file",
                                            ", ".join("%s %d" % kv for kv in sorted(fixed.items())) or "none"))
    print("  " + ", ".join("%s %d" % (k, v) for k, v in counts.items()) + ", icons %d" % len(data["icons"]))
    print("  size %.1f KB (largest: %s)" % (size / 1024.0, ", ".join("%s %.0f KB" % (s, b / 1024.0) for b, s in per[:4])))
    if size > SIZE_WARN:
        print("  warning: over %d KB; every window loads this file" % (SIZE_WARN // 1024))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Bad as e:
        print("error: %s" % e)
        sys.exit(1)
