"""Reworded trade stats: the old-text table (window.POE_STATS_LEGACY in data/stats.js) survives the
app's own "Refresh trade data" (gui.Api.refresh_data) and gains that refresh's rewordings; the merge
(gui.stats_legacy_merge) keeps, drops and adds the right entries. Offline: the trade API is stubbed.
Run: python test/test_statslegacy.py"""
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=None):
    global failures
    print(("PASS " if cond else "FAIL ") + name + ("" if cond or detail is None else " -- %r" % (detail,)))
    if not cond:
        failures += 1


def stats(*entries):
    secs = {}
    for sid, text in entries:
        secs.setdefault(sid.split(".")[0], []).append({"id": sid, "text": text})
    return {"result": [{"id": k, "entries": v} for k, v in secs.items()]}


# -- the merge -----------------------------------------------------------------------------
old = stats(("explicit.stat_1", "Nearby Enemies are Blinded"), ("crafted.stat_1", "Nearby Enemies are Blinded"),
            ("explicit.stat_2", "#% increased Rarity of Items found"), ("pseudo.p_rar", "#% increased Rarity of Items found"),
            ("explicit.stat_3", "+# to Strength"))
new = stats(("explicit.stat_1", "Enemies within 3.5 metres are Blinded"), ("crafted.stat_1", "Enemies within 3.5 metres are Blinded"),
            ("explicit.stat_2", "+#% to Item Rarity"), ("pseudo.p_rar", "#% increased Rarity of Items found"),
            ("explicit.stat_3", "+# to Strength"))
had = {"Old text of a removed stat": ["explicit.stat_gone"], "An older rewording": ["explicit.stat_3"],
       "+# to Strength": ["explicit.stat_3"]}
leg, added = gui.stats_legacy_merge(old, new, had)
check("reworded text kept for every section that used it",
      leg.get("Nearby Enemies are Blinded") == ["crafted.stat_1", "explicit.stat_1"], leg)
check("a text another section still uses (pseudo) is kept for the reworded section",
      leg.get("#% increased Rarity of Items found") == ["explicit.stat_2"], leg)
check("unchanged stats add nothing; earlier rewordings stay; gone ids and current texts drop",
      "An older rewording" in leg and "Old text of a removed stat" not in leg and "+# to Strength" not in leg, leg)
check("count of new entries", added == 3, added)
check("no previous stats: keeps the table, adds nothing", gui.stats_legacy_merge(None, new, leg) == (leg, 0))

# -- Refresh trade data keeps the table and adds this refresh's rewordings ---------------------
tmp = tempfile.mkdtemp()
saved_dir = gui.DATA_DIR
try:
    gui.DATA_DIR = tmp
    with open(os.path.join(tmp, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(old, f)
    with open(os.path.join(tmp, "stats.js"), "w", encoding="utf-8") as f:
        f.write(gui.stats_js_text(old, {"An older rewording": ["explicit.stat_3"]}))
    api = gui.Api.__new__(gui.Api)
    answers = {gui.TRADE_BASE + "/data/stats": new,
               gui.TRADE_BASE + "/data/leagues": {"result": [{"id": "Covens", "realm": "pc", "text": "Covens"}]}}
    api._http = lambda url, *a, **k: answers[url]
    r = gui.Api.refresh_data(api)
    check("refresh_data ok", r.get("ok"), r)
    got = gui.read_stats_legacy(os.path.join(tmp, "stats.js"))
    check("the table survives the refresh", got.get("An older rewording") == ["explicit.stat_3"], got)
    check("and gains the refresh's rewordings", got.get("Nearby Enemies are Blinded") == ["crafted.stat_1", "explicit.stat_1"], got)
    with open(os.path.join(tmp, "stats.js"), encoding="utf-8") as f:
        first = f.readline()
    check("stats.js still starts with the stats", first.startswith("window.POE_STATS = {") and
          json.loads(first[len("window.POE_STATS = "):].strip().rstrip(";")) == new)
finally:
    gui.DATA_DIR = saved_dir
    shutil.rmtree(tmp, ignore_errors=True)

# -- the shipped stats.js carries the table --------------------------------------------------
shipped = gui.read_stats_legacy(os.path.join(ROOT, "data", "stats.js"))
check("data/stats.js carries the old-text table", len(shipped) >= 200 and
      shipped.get("#% increased Rarity of Items found"), len(shipped))

print("\n" + ("ALL TESTS PASSED" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
