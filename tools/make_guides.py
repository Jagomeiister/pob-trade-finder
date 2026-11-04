"""Generate data/guides.js (bundled with the app) and server/public/guides.json (served by the app's
backend, so installed apps pick up guide fixes between releases): one strategy guide per mechanic
cheat sheet, drawn by js/app/33-guides.js inside the sheet.

Input: tools/guides/guides-<patch>.json, the result of a verified research run
({asOf, guides: [...], verifiedCounts, criticGaps}). Every line in it cites written sources
(guide.readMore, by index). This script only checks and reshapes it; it writes nothing of its own:
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

  python tools/make_guides.py [tools/guides/guides-3.29.json] [--checked YYYY-MM-DD]
"""
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
    with open(path, encoding="utf-8") as f:
        research = json.load(f)
    if not checked:  # the day the research run was saved
        checked = datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    need(re.match(r"^\d{4}-\d{2}-\d{2}$", checked or ""), "--checked must be YYYY-MM-DD")
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
    prev = previous()
    stamp = int(time.strftime("%Y%m%d%H%M"))
    if prev and {k: v for k, v in prev.items() if k != "version"} == data and isinstance(prev.get("version"), int):
        stamp = prev["version"]  # same content: same version (no churn on re-runs)
    elif prev and isinstance(prev.get("version"), int) and stamp <= prev["version"]:
        stamp = prev["version"] + 1
    data = dict({"version": stamp}, **data)
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_guides.py from %s: strategy guides for the mechanic cheat sheets\n"
                % os.path.relpath(path, ROOT).replace("\\", "/"))
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
