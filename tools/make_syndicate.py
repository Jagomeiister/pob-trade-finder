"""Generate data/syndicate.js (window.POE_SYNDICATE): the data behind the Betrayal / Syndicate
planner (js/app/34-syndicate.js).

Built only from the verified research in tools/guides/guides-3.29.json, guide id "betrayal":
- planner.members  -> each member's reward per division + the "best" note
- planner.goals    -> targets (parsed to member + division), keep, remove, rules
- planner.actions  -> what each choice does
- howTo / dangers / strategies -> the rule sentences each suggestion cites (picked by their opening
  words, verbatim; the build fails if one is missing, so a research update can't silently drop a rule)
- profit           -> value hints ("~456c") for member + division pairs the price lines name

Nothing is written from memory: when the research changes, re-run this and the planner follows.

Run:  python tools/make_syndicate.py
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "guides", "guides-3.29.json")
OUT = os.path.join(ROOT, "data", "syndicate.js")
DIVS = ["transportation", "fortification", "research", "intervention"]
DIV_NAMES = {d: d.capitalize() for d in DIVS}
LETTER = {"T": "transportation", "F": "fortification", "R": "research", "I": "intervention"}

# rule sentences the planner cites: key -> (section, opening words). Verbatim from the research.
RULES = {
    "raid": ("howTo", "Fill a division's intelligence bar"),
    "execute": ("howTo", "Execute: +1 rank"),
    "recruit": ("howTo", "Executing an unassigned"),
    "interrogate": ("howTo", "Interrogate: imprisons"),
    "unbreaking": ("howTo", "The Unbreaking scarab"),
    "bargain": ("howTo", "Bargain: random outcome"),
    "betray": ("howTo", "Betray: two defeated"),
    "release": ("howTo", "Release: nothing changes"),
    "move": ("howTo", "Moving a member"),
    "remove": ("howTo", "When an encounter offers it"),
    "leader": ("howTo", "A Leader joins"),
    "fullHouse": ("howTo", "Transportation and Fortification never spawn"),
    "filler": ("dangers", "Never complete the five-member"),
    "check": ("dangers", "Check membership"),
    "lock": ("dangers", "Two-member houses can lock"),
    "rank3": ("dangers", "Do not interrogate a rank-3"),
    "bargainRisk": ("dangers", "A Bargain can send"),
    "stuckLeader": ("dangers", "Valuable members such as Aisling"),
    "between": ("strategy", "Run at least one map with a Syndicate encounter"),
}


def fail(msg):
    sys.exit("make_syndicate: " + msg)


def pick_rules(g):
    steps = [s for st in g.get("strategies", []) for s in st.get("steps", [])]
    pools = {"howTo": [h["text"] for h in g["howTo"]], "dangers": [d["text"] for d in g["dangers"]], "strategy": steps}
    out = {}
    for key, (sec, start) in RULES.items():
        hits = sorted(set(t for t in pools[sec] if t.startswith(start)))
        if len(hits) != 1:
            fail("rule %r: %d %s lines start with %r" % (key, len(hits), sec, start))
        out[key] = hits[0]
    return out


def split_names(text, names):
    """'Vorici or Gravicius' -> ['Vorici', 'Gravicius'] if every part is a member, else []"""
    parts = [p.strip() for p in re.split(r"\s+or\s+", text)]
    return parts if all(p in names for p in parts) else []


def divisions_in(text):
    return [d for d in DIVS if re.search(r"\b%s\b" % DIV_NAMES[d], text)]


def parse_goal(goal, names):
    g = {"id": re.sub(r"[^a-z0-9]", "", goal["goal"].split()[0].lower()), "name": goal["goal"],
         "targets": [], "targetText": [], "keep": [], "remove": [], "removeText": [],
         "rules": list(goal["rules"]), "rankRewards": {}, "runAsap": [], "fillerDivisions": [],
         "neverRaidFiller": False, "linkRivals": False}
    for t in goal["targets"]:
        m = re.match(r"^(?P<who>.+?) in (?P<div>%s)\b(?P<rest>.*)$" % "|".join(DIV_NAMES.values()), t)
        who = split_names(m.group("who"), names) if m else []
        if not who:
            g["targetText"].append(t)  # e.g. "Any high-level safehouse (area 78+) for Medallions"
            continue
        rest = m.group("rest")
        note = re.search(r"\(([^)]+)\)", rest)
        g["targets"].append({"members": who, "division": m.group("div").lower(),
                             "alt": "alternative" in rest, "leaderFree": "leader-free" in rest,
                             "note": note.group(1) if note else "", "text": t})
    for k in goal["keep"]:
        g["keep"] += split_names(k, names)
    for r in goal["remove"]:
        if r in names:
            g["remove"].append(r)
        else:
            g["removeText"].append(r)
            if "filler" in r.lower():
                g["fillerDivisions"] = divisions_in(r)
                size = re.search(r"\((\d+) and \1\)", r)  # "... Fortification and Research (5 and 5)"
                if size:
                    g["fillerSize"] = int(size.group(1))
    for r in goal["rules"]:
        rr = re.match(r"^Rank (\d) = (.+?)\.?$", r)
        if rr:
            g["rankRewards"][rr.group(1)] = rr.group(2)
        if "as soon as it fills" in r:
            g["runAsap"] = list(DIVS) if "every safehouse" in r else divisions_in(r)
        if re.search(r"never raid the filler", r, re.I):
            g["neverRaidFiller"] = True
        if "Rivals" in r:
            g["linkRivals"] = True
    if g["neverRaidFiller"] and not g["fillerDivisions"]:
        fail("goal %r never raids filler houses but names no filler divisions" % goal["goal"])
    return g


def value_hints(g, names):
    """{member: {division: '~456c Ultimatum Catalysing'}} from the poe.ninja price lines"""
    hints, date = {}, None
    item = re.compile(r"(?P<item>[A-Z][A-Za-z' ]+?) ~(?P<c>\d+)c(?: / [A-Za-z' ]+? ~\d+c)? \((?P<who>[^)]+)\)")
    for p in g.get("profit", []):
        text = p["text"]
        if text.startswith("Rough: Intervention outputs:"):
            fixed = "intervention"
        elif text.startswith("Rough: Transportation/Fortification scarabs:"):
            fixed = None
        else:
            continue
        date = p.get("date") or date
        for m in item.finditer(text.split(":", 2)[-1]):
            who = m.group("who").split()
            div = fixed
            if div is None:
                if len(who) < 2 or who[-1] not in LETTER:
                    continue
                div, who = LETTER[who[-1]], who[:-1]
            name = " ".join(who)
            if name not in names:
                fail("price line names an unknown member %r" % name)
            hints.setdefault(name, {})[div] = "~%sc %s" % (m.group("c"), m.group("item").strip())
    if not hints:
        fail("no value hints parsed from the profit lines")
    return hints, date


def main():
    with open(SRC, encoding="utf-8") as f:
        src = json.load(f)
    g = next((x for x in src["guides"] if x.get("id") == "betrayal"), None)
    if not g or "planner" not in g:
        fail("no betrayal guide with a planner in " + SRC)
    pl = g["planner"]
    members = []
    for m in pl["members"]:
        if any(not m.get(d) for d in DIVS):
            fail("member %r misses a division reward" % m.get("name"))
        best = m.get("best", "")
        members.append({
            "name": m["name"],
            "rewards": {d: m[d] for d in DIVS},
            "best": best,
            # the research's own word: "Usually filler." / "Filler for most boards."
            "filler": bool(re.match(r"^(Usually )?filler\b", best, re.I)),
            "ssf": "SSF pick" in best,
            # divisions the "best" note recommends (none for filler members)
            "good": [] if re.match(r"^(Usually )?filler\b", best, re.I) else divisions_in(best),
        })
    names = {m["name"] for m in members}
    if len(members) != 17:
        fail("expected 17 members, got %d" % len(members))
    goals = [parse_goal(x, names) for x in pl["goals"]]
    if len(goals) != 6 or len({x["id"] for x in goals}) != 6:
        fail("expected 6 goals with distinct ids: %r" % [x["id"] for x in goals])
    hints, price_date = value_hints(g, names)
    strategy = next((s for s in g.get("strategies", []) if "2-2-5-5" in s["name"]), None)
    data = {
        "source": "tools/guides/guides-3.29.json (betrayal planner, verified research)",
        "asOf": g.get("asOf"),
        "divisions": [[d, DIV_NAMES[d]] for d in DIVS],
        "members": members,
        "goals": goals,
        "actions": list(pl["actions"]),
        "rules": pick_rules(g),
        "values": hints,
        "priceDate": price_date,
        "priceSource": "poe.ninja (Allflame)",
        "strategy": {"name": strategy["name"], "investment": strategy["investment"],
                     "scarabs": strategy["scarabs"], "atlasPassives": strategy["atlasPassives"]} if strategy else None,
        "quickCard": list(g.get("quickCard", [])),
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_syndicate.py from tools/guides/guides-3.29.json (betrayal planner)\n")
        f.write("window.POE_SYNDICATE = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("wrote %s: %d members, %d goals, %d rules, value hints for %d members" %
          (os.path.relpath(OUT, ROOT), len(members), len(goals), len(data["rules"]), len(hints)))


if __name__ == "__main__":
    main()
