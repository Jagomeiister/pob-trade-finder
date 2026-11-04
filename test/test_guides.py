"""Mechanic guide data — run: python test/test_guides.py

Checks the generated data/guides.js (tools/make_guides.py) without touching the network: the payload
schema, stage tags, cite indexes in range, that every guide maps to a cheat sheet (or brings its own
sheet entry), that the internal research fields are gone, that the icon names point at GGG art paths,
that server/public/guides.json is the same payload, and the bridge's validation and Read-more URL
allowance in gui.py."""
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
check("top-level keys", set(data) == {"version", "asOf", "checked", "guides", "sheets", "icons"}, sorted(data))
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

print("\n" + ("ALL TESTS PASSED" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
