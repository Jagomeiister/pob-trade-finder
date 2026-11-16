"""Keep the old wording of trade stats GGG reworded, so items written before a patch still match.

Each league GGG rewords some stat texts (3.30: "#% increased Rarity of Items found" became
"+#% to Item Rarity", "nearby Allies" became "Allies within 5 metres" ...). The stat id stays
the same, but builds saved in Path of Building before the patch keep the old text on their
items, and those lines would no longer match a trade stat.

This compares the previous data/stats.json (git HEAD, i.e. before make-data-js.js --fetch
replaced it) with the new one. For every stat whose id still exists but whose text changed,
it records old text -> [stat ids] (one per section: explicit, implicit, crafted ...) in
data/statslegacy.json. The file accumulates across leagues; an id is dropped only when it is gone. It then adds
`window.POE_STATS_LEGACY = {...};` to data/stats.js, which js/matcher.js's buildStatIndex reads
as a fallback after every current text.

Run after make-data-js.js --fetch (tools/refresh_all.py does):  python tools/make_statslegacy.py
Optional: --base <file or git rev> (default HEAD) for the previous stats.json.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
LEGACY = os.path.join(DATA, "statslegacy.json")
STATS_JS = os.path.join(DATA, "stats.js")
MARK = "window.POE_STATS_LEGACY = "


def stat_texts(stats):
    out = {}
    for sec in stats.get("result", []):
        for e in sec.get("entries", []):
            if e.get("text"):
                out[e["id"]] = e["text"]
    return out


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
    base = "HEAD"
    if "--base" in argv:
        base = argv[argv.index("--base") + 1]
    with open(os.path.join(DATA, "stats.json"), encoding="utf-8") as f:
        new = stat_texts(json.load(f))
    try:
        with open(LEGACY, encoding="utf-8") as f:
            legacy = json.load(f)
    except (OSError, ValueError):
        legacy = {}
    # (section, text) pairs in use now: an old text another section still uses (a pseudo stat
    # keeps "#% increased Rarity of Items found") is still needed for this section
    current = {(sid.split(".")[0], t) for sid, t in new.items()}
    # drop ids that are gone, and old texts that are a current text of that section again
    legacy = {t: [i for i in ids if i in new and (i.split(".")[0], t) not in current] for t, ids in legacy.items()}
    old_stats = load_base(base)
    added = 0
    if old_stats is None:
        print("make_statslegacy: no previous stats.json at %s; keeping %d entries" % (base, len(legacy)))
    else:
        for sid, text in stat_texts(old_stats).items():
            if sid in new and new[sid] != text and (sid.split(".")[0], text) not in current:
                ids = legacy.setdefault(text, [])
                if sid not in ids:
                    ids.append(sid)
                    added += 1
    legacy = {t: sorted(ids) for t, ids in sorted(legacy.items()) if ids}
    with open(LEGACY, "w", encoding="utf-8") as f:
        json.dump(legacy, f, ensure_ascii=False, indent=0)
        f.write("\n")
    with open(STATS_JS, encoding="utf-8") as f:
        js = [ln for ln in f.read().splitlines() if not ln.startswith(MARK)]
    js.append(MARK + json.dumps(legacy, ensure_ascii=False, separators=(",", ":")) + ";")
    with open(STATS_JS, "w", encoding="utf-8") as f:
        f.write("\n".join(js) + "\n")
    print("Wrote data/statslegacy.json: %d old stat texts (%d new)" % (len(legacy), added))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
