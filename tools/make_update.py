"""Turn a verified patch-update research run into a guide update file.

  python tools/make_update.py tools/guides/update-research-3.30.json

Input: the result of the `poe-330-update` research workflow (kept as the record, never edited):
{asOf, topics: [{id, kind, data, kept}]}. Its "guides" topics list, per guide, the verified changes
of the new patch and the guide lines that the patch made wrong (each with the exact existing text and
a quote from the patch notes).

Output: tools/guides/updates-<from>-to-<to>.json, in the corrections format tools/make_guides.py
applies on top of corrections-<from>.json:
- each guide gets the patch notes as a readMore source and a "changes" entry per verified change
- each fix becomes a replace / delete at the exact place its text sits in the guide
- a guide whose update is complete (impact none / minor) has its asOf moved to the new patch
Fixes whose text is not found exactly once are NOT applied; they are listed under "skipped" for a
person to look at. Nothing is invented here: text comes from the research, places from the guide.
"""
import copy
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import make_guides  # noqa: E402

NOTES_URL = "https://www.pathofexile.com/forum/view-thread/4013680"
NOTES_SOURCE = {"url": NOTES_URL, "title": "Content Update 3.30.0 — Path of Exile: Covens of Umbra",
                "publisher": "Grinding Gear Games (official patch notes)", "date": "2026-11-11", "patch": "3.30"}
OFFICIAL = ("https://www.pathofexile.com/", "https://pathofexile.com/")
SHEET_TO_RESEARCH = {v: k for k, v in make_guides.ID_MAP.items()}  # syndicate -> betrayal
COMPLETE = ("none", "minor")  # impacts after which the guide counts as up to date

try:
    sys.stdout.reconfigure(errors="backslashreplace")
except Exception:
    pass


def norm_ws(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def find_text(node, needle, path=""):
    """Every place (path, container, key) whose string contains needle."""
    hits = []
    if isinstance(node, str):
        return hits
    items = node.items() if isinstance(node, dict) else enumerate(node) if isinstance(node, list) else []
    for k, v in items:
        here = ("%s[%d]" % (path, k)) if isinstance(node, list) else (path + "." + k if path else k)
        if isinstance(v, str):
            if needle in v:
                hits.append((here, node, k))
        else:
            hits.extend(find_text(v, needle, here))
    return hits


def source_url(src):
    src = str(src or "").strip()
    if src in ("notes", "", "patch notes"):
        return NOTES_URL
    return src if make_guides.SOURCE_RE.match(src) else NOTES_URL


def build(research_path, run):
    research, _cpath, _n = make_guides.corrected_research(research_path)  # 3.29 + its corrections
    guides = {g["id"]: g for g in research["guides"]}
    to_patch = str(run.get("asOf") or "").strip()
    out, skipped, summary = [], [], {}
    for topic in run.get("topics") or []:
        if topic.get("kind") != "guides" or not isinstance(topic.get("data"), dict):
            continue
        for gu in topic["data"].get("guides") or []:
            sid = gu.get("guide")
            rid = SHEET_TO_RESEARCH.get(sid, sid)
            g = guides.get(rid)
            if not g:
                skipped.append({"guide": sid, "why": "no such guide"})
                continue
            n_fix = n_chg = 0
            urls = {r.get("url") for r in g.get("readMore", [])}
            wanted = [NOTES_SOURCE]
            for c in gu.get("changes") or []:
                u = source_url(c.get("source"))
                if u != NOTES_URL and u.startswith(OFFICIAL) and u not in [w["url"] for w in wanted]:
                    wanted.append({"url": u, "title": "Path of Exile: Covens of Umbra (official post)",
                                   "publisher": "Grinding Gear Games (official forum)", "date": "2026-11", "patch": "3.30"})
            for w in wanted:
                if w["url"] not in urls:
                    out.append({"id": "%s-330-src-%d" % (rid, len(out)), "guide": rid, "path": "readMore", "action": "add",
                                "value": w, "reason": "Source for the %s changes." % to_patch, "source": w["url"]})
            ok_urls = urls | {w["url"] for w in wanted}
            seen = set()
            for c in gu.get("changes") or []:
                text = norm_ws(c.get("text"))
                if not text or text in seen:
                    continue
                seen.add(text)
                u = source_url(c.get("source"))
                if u not in ok_urls:
                    u = NOTES_URL  # an unofficial source: cite the notes only when the quote is from them
                    if str(c.get("source") or "") not in ("notes", ""):
                        skipped.append({"guide": sid, "why": "change cites an unofficial source", "text": text, "source": c.get("source")})
                        continue
                out.append({"id": "%s-330-chg-%d" % (rid, n_chg), "guide": rid, "path": "changes", "action": "add",
                            "value": {"patch": to_patch + ".0", "text": text, "cite": [u]},
                            "reason": "%s patch notes." % to_patch, "quote": norm_ws(c.get("quote")), "source": u})
                n_chg += 1
            deletes = []
            for f in gu.get("fixes") or []:
                match = str(f.get("match") or "")
                hits = find_text(g, match) if match.strip() else []
                if len(hits) != 1:
                    skipped.append({"guide": sid, "why": "text found %d times" % len(hits), "match": match,
                                    "value": f.get("value"), "reason": f.get("reason")})
                    continue
                path, container, key = hits[0]
                action = f.get("action")
                value = f.get("value")
                entry = {"guide": rid, "reason": norm_ws(f.get("reason")) or "%s patch notes." % to_patch,
                         "quote": norm_ws(f.get("quote")), "source": NOTES_URL, "match": match}
                if action == "replace" and isinstance(value, str) and value.strip():
                    entry.update({"id": "%s-330-fix-%d" % (rid, n_fix), "path": path, "action": "replace", "value": value})
                    out.append(entry)
                elif action == "delete" or (action == "replace" and not str(value or "").strip()):
                    # delete the list element that holds the text (a line, a step, a table row)
                    row = re.sub(r"(rows\[\d+\])\[\d+\]$", r"\1", path)  # a table cell: its whole row
                    m = re.match(r"^(.*)\[(\d+)\](?:\.[A-Za-z_]+)?$", row)
                    if not m:
                        skipped.append({"guide": sid, "why": "delete target is not a list element", "match": match})
                        continue
                    entry.update({"id": "%s-330-fix-%d" % (rid, n_fix), "path": m.group(1), "action": "delete",
                                  "_index": int(m.group(2))})
                    deletes.append(entry)
                else:
                    skipped.append({"guide": sid, "why": "unknown action %r" % action, "match": match})
                    continue
                n_fix += 1
            # deletes last, and from the end of each list, so earlier ones don't shift later ones
            deletes.sort(key=lambda e: (e["path"], -e["_index"]))
            for e in deletes:
                e.pop("_index")
                out.append(e)
            if gu.get("impact") in COMPLETE and str(g.get("asOf") or "") != to_patch:
                out.append({"id": "%s-330-asof" % rid, "guide": rid, "path": "asOf", "action": "replace",
                            "match": str(g.get("asOf")), "value": to_patch,
                            "reason": "Checked against the %s patch notes: %s." % (to_patch, gu.get("impact")), "source": NOTES_URL})
            summary[sid] = {"impact": gu.get("impact"), "changes": n_chg, "fixes": n_fix, "summary": norm_ws(gu.get("summary"))}
    return out, skipped, summary, to_patch


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    with open(argv[0], encoding="utf-8") as f:
        run = json.load(f)
    research_path = make_guides.default_input()
    from_patch = re.sub(r"^guides-|[.]json$", "", os.path.basename(research_path))
    # build against the research WITHOUT an earlier copy of this update applied
    target = os.path.join(os.path.dirname(research_path), "updates-%s-to-%s.json" % (from_patch, str(run.get("asOf"))))
    hidden = target + ".building"
    if os.path.exists(target):
        os.replace(target, hidden)
    try:
        out, skipped, summary, to_patch = build(research_path, run)
        # prove every entry applies, in order, before writing
        research, _c, _n = make_guides.corrected_research(research_path)
        _counts, problems = make_guides.apply_corrections(research, copy.deepcopy(out))
    finally:
        if os.path.exists(hidden):
            os.replace(hidden, target)
    if problems:
        print("%d entries do not apply:" % len(problems))
        for p in problems[:30]:
            print("  - " + p)
        return 1
    doc = {"research": os.path.basename(research_path),
           "about": "What %s changed, from the verified run in %s (tools/make_update.py). Applied by make_guides.py on top of "
                    "the corrections. Do not edit by hand: fix the research record or add a correction." % (to_patch, os.path.basename(argv[0])),
           "to": to_patch, "guides": summary, "corrections": out, "skipped": skipped}
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print("Wrote %s: %d entries for %d guides, %d skipped" % (os.path.relpath(target, ROOT), len(out), len(summary), len(skipped)))
    for sid, s in summary.items():
        print("  %-12s %-8s %2d changes, %2d fixes" % (sid, s["impact"], s["changes"], s["fixes"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
