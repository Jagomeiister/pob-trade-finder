"""Generate data/cheatsheets.js: ready-made leveling cheat sheets, built only from the community
Path of Exile Wiki (CC BY-NC-SA 3.0) so nothing on them is written from memory:

- passive skill point and respec point quests per act  (Cargo table quest_rewards: Book of
  Skill / Book of Regrets rewards; "act" = where the reward is handed out)
- Trials of Ascendancy per act and labyrinth          (page "Trial of Ascendancy")
- bandit choice rewards                               (page "Deal with the Bandits", current
  reward sections)
- labyrinth area levels                               (Cargo table areas: Aspirant's Trial)
- resistance penalties after Acts 5 and 10            (page "Resistance")

Run on a normal PC (the wiki refuses datacenter addresses):  python tools/make_cheatsheets.py
"""
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI = "https://www.poewiki.net/w/api.php"
UA = "PoBTradeFinder data build (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)"
SOURCE = "Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0"
LABS = {1: "Normal", 2: "Normal", 3: "Normal", 6: "Cruel", 7: "Cruel", 8: "Merciless", 9: "Merciless", 10: "Merciless"}


def api(params):
    q = dict(format="json", **params)
    req = urllib.request.Request(WIKI + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8"))
    if d.get("error"):
        raise RuntimeError("wiki: %s" % d["error"].get("info"))
    time.sleep(0.5)  # be gentle with a community wiki
    return d


def wikitext(page):
    return api({"action": "parse", "page": page, "prop": "wikitext"})["parse"]["wikitext"]["*"]


def plain(s):
    s = re.sub(r"\{\{c\|mod\|([^}]*)\}\}", r"\1", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"''+", "", s)
    return html.unescape(re.sub(r"\s+", " ", s)).strip(" *")


def point_quests():
    rows = api({"action": "cargoquery", "tables": "quest_rewards",
                "fields": "quest_rewards._pageName=page,quest_rewards.quest=quest,quest_rewards.act=act",
                "where": "quest_rewards._pageName LIKE 'Book of Skill%' OR quest_rewards._pageName LIKE 'Book of Regrets%'",
                "limit": "200"})["cargoquery"]
    out, seen = {}, set()
    for r in rows:
        t = r["title"]
        kind = "skill" if t["page"].startswith("Book of Skill") else "respec"
        act, quest = int(t["act"]), html.unescape(t["quest"])
        if (act, quest, kind) in seen:
            continue
        seen.add((act, quest, kind))
        out.setdefault(act, []).append({"quest": quest, "kind": kind})
    return out


def trials():
    w = wikitext("Trial of Ascendancy")
    out = {}
    for line in w.splitlines():
        m = re.match(r"\* \[\[([^|\]]+)(?:\|([^\]]+))?\]\],?(?: \[\[Act (\d+)\]\],?)? contains (.+)$", line)
        if not m:
            continue
        name = re.sub(r" \(Act \d+\)$", "", m.group(2) or m.group(1))
        in_name = re.search(r"\(Act (\d+)\)", m.group(2) or m.group(1))
        if not m.group(3) and not in_name:
            continue  # the endgame "Trial of ..." rooms, which have no act
        act = int(m.group(3) or in_name.group(1))
        out.setdefault(act, []).append({"area": name, "trap": plain(m.group(4)), "lab": LABS.get(act, "")})
    return out


def bandits():
    w = wikitext("Deal with the Bandits")
    out = {}
    for m in re.finditer(r'<section begin="?reward_([a-z]+)"?\s*/>(.*?)<section end', w, re.S):
        out[m.group(1)] = plain(m.group(2))
    return out


def lab_levels():
    rows = api({"action": "cargoquery", "tables": "areas", "fields": "areas.id=id,areas.area_level=lvl",
                "where": "areas.id LIKE '%_Labyrinth_boss_1'", "limit": "20"})["cargoquery"]
    names = {"1": "Normal", "2": "Cruel", "3": "Merciless", "EndGame": "Eternal"}
    out = {}
    for r in rows:
        key = r["title"]["id"].split("_Labyrinth")[0]
        if key in names and (r["title"].get("lvl") or "").isdigit():
            out[names[key]] = int(r["title"]["lvl"])
    return out


def penalties():
    w = wikitext("Resistance")
    m = re.search(r"-(\d+)%/-(\d+)% penalty from completing \[\[Act\]\] 5/10", w)
    if not m:
        raise RuntimeError("resistance penalty sentence not found on the wiki page")
    return int(m.group(1)), int(m.group(2))


def main():
    quests, tri, band, labs = point_quests(), trials(), bandits(), lab_levels()
    p5, p10 = penalties()
    acts = {}
    for act in range(1, 11):
        a = {"points": quests.get(act, []), "trials": tri.get(act, []), "notes": []}
        if act == 2 and band:
            a["notes"].append({"title": "Bandits (Deal with the Bandits)", "lines": [
                "Kill all three: %s" % band.get("all", "?"),
                "Help Alira: %s" % band.get("alira", "?"),
                "Help Kraityn: %s" % band.get("kraityn", "?"),
                "Help Oak: %s" % band.get("oak", "?")]})
        if act == 5:
            a["notes"].append({"title": "After Act 5", "lines": ["-%d%% to all resistances from now on" % p5]})
        if act == 10:
            a["notes"].append({"title": "After Act 10", "lines": ["-%d%% to all resistances in total" % p10]})
        acts[act] = a
    data = {"source": SOURCE, "fetchedAt": time.strftime("%Y-%m-%d"), "acts": acts, "labs": labs}
    n_points = sum(1 for a in acts.values() for q in a["points"] if q["kind"] == "skill")
    n_trials = sum(len(a["trials"]) for a in acts.values())
    if n_points < 15 or n_trials < 9 or len(band) < 4:
        print("wiki data looks incomplete (points %d, trials %d, bandit rewards %d); not writing"
              % (n_points, n_trials, len(band)))
        return 1
    with open(os.path.join(ROOT, "data", "cheatsheets.js"), "w", encoding="utf-8") as f:
        f.write("// generated by tools/make_cheatsheets.py from the Path of Exile Wiki (CC BY-NC-SA 3.0)\n")
        f.write("window.POE_CHEATSHEETS = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("Wrote data/cheatsheets.js: %d skill-point quests, %d respec quests, %d trials, labs %s, penalties -%d/-%d"
          % (n_points, sum(1 for a in acts.values() for q in a["points"] if q["kind"] == "respec"), n_trials, labs, p5, p10))
    return 0


if __name__ == "__main__":
    sys.exit(main())
