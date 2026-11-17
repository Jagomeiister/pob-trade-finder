"""Keep the old wording of trade stats GGG reworded, so items written before a patch still match.

Each league GGG rewords some stat texts (3.30: "#% increased Rarity of Items found" became
"+#% to Item Rarity", "nearby Allies" became "Allies within 5 metres" ...). The stat id stays
the same, but builds saved in Path of Building before the patch keep the old text on their
items, and those lines would no longer match a trade stat.

This compares the previous stats with the new data/stats.json. The previous ones are
data/stats.prev.json, which make-data-js.js --fetch saves before it replaces stats.json; without
that file, git HEAD's data/stats.json. For every stat whose id still exists but whose text changed,
it records old text -> [stat ids] (one per section: explicit, implicit, crafted ...) in
data/statslegacy.json. The file accumulates across leagues; an id is dropped only when it is gone.
It then rewrites data/stats.js with `window.POE_STATS_LEGACY = {...};` after the stats, which
js/matcher.js's buildStatIndex reads as a fallback after every current text. The merge is
gui.stats_legacy_merge, the same code the app's own "Refresh trade data" runs.

Run after make-data-js.js --fetch (tools/refresh_all.py does):  python tools/make_statslegacy.py
Optional: --base <file or git rev> for the previous stats.json.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from gui import read_stats_legacy, stats_js_text, stats_legacy_merge  # noqa: E402

DATA = os.path.join(ROOT, "data")
LEGACY = os.path.join(DATA, "statslegacy.json")
STATS_JS = os.path.join(DATA, "stats.js")
PREV = os.path.join(DATA, "stats.prev.json")


def load_base(base):
    if os.path.isfile(base):
        with open(base, encoding="utf-8") as f:
            return json.load(f)
    try:
        raw = subprocess.check_output(["git", "show", base + ":data/stats.json"], cwd=ROOT,
                                      stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, OSError):
        return None
    return json.loads(raw.decode("utf-8"))


def main(argv):
    base = PREV if os.path.isfile(PREV) else "HEAD"
    if "--base" in argv:
        base = argv[argv.index("--base") + 1]
    with open(os.path.join(DATA, "stats.json"), encoding="utf-8") as f:
        stats = json.load(f)
    try:
        with open(LEGACY, encoding="utf-8") as f:
            legacy = json.load(f)
    except (OSError, ValueError):
        legacy = read_stats_legacy(STATS_JS)  # no table file yet: what stats.js carries
    old_stats = load_base(base)
    if old_stats is None:
        print("make_statslegacy: no previous stats.json at %s; keeping %d entries" % (base, len(legacy)))
    legacy, added = stats_legacy_merge(old_stats, stats, legacy)
    with open(LEGACY, "w", encoding="utf-8") as f:
        json.dump(legacy, f, ensure_ascii=False, indent=0)
        f.write("\n")
    with open(STATS_JS, "w", encoding="utf-8") as f:
        f.write(stats_js_text(stats, legacy))
    print("Wrote data/statslegacy.json: %d old stat texts (%d new, base %s)"
          % (len(legacy), added, os.path.relpath(base, ROOT) if os.path.isfile(base) else base))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
