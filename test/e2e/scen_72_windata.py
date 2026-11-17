"""72 windata: each in-game window loads only the data its code reads (index.html), and still
starts without errors. Loaded by run_e2e.py (_extra_scenarios); the runner's own check after each
scenario reports uncaught page exceptions, and this one checks each window's page as it goes."""

TAG = "72 windata"

PROBE = r"""
await new Promise(r => setTimeout(r, 400));
return { stats: !!window.POE_STATS, guides: !!window.POE_GUIDES, sheets: !!window.POE_CHEATSHEETS,
  tree: !!window.POE_TREE_VIEW, leagues: !!window.POE_LEAGUES, syndicate: !!window.POE_SYNDICATE,
  baseicons: !!window.POE_BASE_ICONS, atlas: !!window.POE_ATLAS_VIEW,
  scripts: [...document.scripts].filter(s => /\/data\//.test(s.src)).length,
  leagueOpts: document.querySelectorAll('#league option').length };
"""


def run(s, tag, check):
    want = {
        "": dict(stats=True, guides=True, sheets=True, tree=True, atlas=True),
        "?overlay=1": dict(stats=True, guides=False, sheets=False, tree=False, atlas=False, baseicons=True),
        "?ovicon=1": dict(stats=False, guides=False, sheets=False, tree=False, baseicons=False),
        "?cards=1": dict(stats=False, guides=False, sheets=False, tree=False, baseicons=False),
        "?sheethint=1": dict(stats=False, guides=False, sheets=True, tree=False, syndicate=False),
        "?sheet=1": dict(stats=False, guides=True, sheets=True, tree=True, syndicate=True, atlas=False),
    }
    for q, w in want.items():
        s.fresh(q)
        r = s.run(PROBE, timeout=30)
        got = {k: r[k] for k in w}
        errs = s.page_errors()
        name = q or "main window"
        check("%s %s: loads %s" % (tag, name, ", ".join(k for k, v in w.items() if v) or "no item data") +
              ("; skips " + ", ".join(k for k, v in w.items() if not v) if not all(w.values()) else ""),
              got == w and r["leagues"] and r["leagueOpts"] > 0, (got, r["leagueOpts"]))
        check("%s %s: starts without errors" % (tag, name), not errs[0], errs[0][:3])
