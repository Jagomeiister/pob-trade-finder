"""Search text presets — run: python test/test_search_presets.py

The Flasks tab's tokens (js/app/21-search-text.js SEARCH_PRESET_TABS) are checked against the
text of every current flask prefix / suffix (RePoE data/mods.min.json + stat translations, each
English wording: "increased" and "reduced"): a token must find its own mod and nothing else.
Vendor tokens are checked against sample item text (sockets line, mods)."""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


src = os.path.join(ROOT, "js", "app", "21-search-text.js")
# the app files share top-level names; load this one as a script so its vars are global
out = subprocess.run(["node", "-e", "const vm=require('vm'),fs=require('fs');"
                      "global.window={};vm.runInThisContext(fs.readFileSync(%s,'utf8'));"
                      "console.log(JSON.stringify(SEARCH_PRESET_TABS));" % json.dumps(src)],
                     capture_output=True, text=True, check=True).stdout
TABS = json.loads(out)


def tokens(kind):
    return {p["label"]: p["token"] for g in TABS[kind] for p in g["items"]}


# every current flask affix, as the lines the game shows (all wordings of each stat)
mods = json.load(open(os.path.join(ROOT, "data", "mods.min.json"), encoding="utf-8"))
trans = json.load(open(os.path.join(ROOT, "data", "stat_translations.min.json"), encoding="utf-8"))
by_id = {}
for t in trans:
    for i in t.get("ids", []):
        by_id.setdefault(i, t)


def wording(stat):
    """The line the game shows for this stat at its strongest roll: the English variant whose
    condition fits the value (a mod rolling -20% shows "reduced", never "increased")."""
    t = by_id.get(stat["id"])
    if not t:
        return None
    v = stat["max"] if abs(stat.get("max", 0)) >= abs(stat.get("min", 0)) else stat["min"]
    k = t["ids"].index(stat["id"])
    for e in t.get("English", []):
        c = (e.get("condition") or [{}])[k] if k < len(e.get("condition") or []) else {}
        if ("min" in c and v < c["min"]) or ("max" in c and v > c["max"]):
            continue
        return re.sub(r"\{\d+\}", "12", e["string"])
    return None


flask_lines = set()
for m in mods.values():
    if m.get("domain") != "flask" or m.get("generation_type") not in ("prefix", "suffix"):
        continue
    if not any(w.get("weight", 0) > 0 for w in m.get("spawn_weights", [])):
        continue
    for s in m.get("stats", []):
        line = wording(s)
        if line:
            flask_lines.add(line)
check("flask mod text loaded", len(flask_lines) > 50, len(flask_lines))

# what each flask token may match: the mod it names, nothing else
WANT = {
    "Bleeding immunity": r"Immunity to Bleeding",
    "Freeze and chill immunity": r"Immunity to (Freeze|Chill)",
    "Shock immunity": r"Immunity to Shock",
    "Ignite immunity": r"Immunity to Ignite",
    "Poison immunity": r"Immunity to Poison",
    "Maim and hinder immunity": r"Immunity to (Hinder|Maim)",
    "Removes curses": r"^Removes Curses",
    "Movement speed during effect": r"Movement Speed during Effect",
    "Armour during effect": r"Armour during Effect",
    "Evasion during effect": r"Evasion Rating during Effect",
    "Resistances during effect": r"Resistances during Effect",
    "Critical strike chance during effect": r"Critical Strike Chance during Effect",
    "Increased effect": r"increased effect(\.|$)",       # incl. the "-1% to this value when used" kind
    "Reduced charges per use": r"reduced Charges per use",
    "Increased duration": r"increased Duration(\.|$)",
    "More maximum charges": r"to Maximum Charges",
    "Charge recovery": r"Charge Recovery",
    "Charge on critical strike": r"Flask Charge when you deal a Critical Strike",
    "Charge when hit": r"Charges? when you are Hit",
    "Instant recovery": r"^Instant Recovery|applied Instantly",
}
flask = tokens("flasks")
check("every flask preset has an expectation", set(flask) == set(WANT), set(flask) ^ set(WANT))
for label, tok in flask.items():
    hits = [line for line in flask_lines if re.search(tok, line, re.I)]
    bad = [line for line in hits if not re.search(WANT.get(label, "^$"), line)]
    check("flask: %s (%s)" % (label, tok), hits and not bad, {"hits": len(hits), "wrong": bad[:3]})

# vendor: sockets read "Sockets: R-G-B G"; the token is matched against the whole item text
# (re.M: the game's ^ and $ work per line)
vendor = tokens("vendor")
ITEM = "Item Class: Boots\nRarity: Magic\nSockets: %s\nItem Level: 20\n%s"
cases = [
    ("Movement speed (any)", ITEM % ("R", "10% increased Movement Speed"), True),
    ("Movement speed (any)", ITEM % ("R", "3% reduced Movement Speed"), False),
    ("Movement speed 15% or more", ITEM % ("R", "15% increased Movement Speed"), True),
    ("Movement speed 15% or more", ITEM % ("R", "25(25-25)% increased Movement Speed"), True),
    ("Movement speed 15% or more", ITEM % ("R", "10% increased Movement Speed"), False),
    ("+ level of socketed gems (any)", ITEM % ("R", "+1 to Level of Socketed Fire Gems"), True),
    ("+ level of socketed fire / cold / lightning gems", ITEM % ("R", "+1 to Level of Socketed Cold Gems"), True),
    ("+ level of socketed fire / cold / lightning gems", ITEM % ("R", "+1 to Level of Socketed Melee Gems"), False),
    ("+ level of all spell skill gems", ITEM % ("R", "+1 to Level of all Fire Spell Skill Gems"), True),
    ("Adds damage to spells", ITEM % ("R", "Adds 3 to 7 Cold Damage to Spells"), True),
    ("Adds damage to attacks (physical / elemental / chaos)", ITEM % ("R", "Adds 3(2-4) to 7(6-8) Fire Damage"), True),
    ("Adds damage to attacks (physical / elemental / chaos)", ITEM % ("R", "Adds 1 to 2 Cold Damage to Attacks"), True),
    ("Adds damage to attacks (physical / elemental / chaos)", ITEM % ("R", "12% increased Spell Damage"), False),
    ("Adds damage to attacks (physical / elemental / chaos)", ITEM % ("R", "Adds 3 to 7 Cold Damage to Spells"), False),
    ("Life", ITEM % ("R", "+25 to maximum Life"), True),
    ("Energy shield", ITEM % ("R", "+25 to maximum Energy Shield"), True),
    ("Energy shield", "Item Class: Helmets\nEnergy Shield: 30\nSockets: B", False),
]
check("every vendor case names a pick", all(c[0] in vendor for c in cases), [c[0] for c in cases if c[0] not in vendor])
for label, text, want in cases:
    tok = vendor.get(label, "^$")
    got = bool(re.search(tok, text, re.I | re.M))
    check("vendor: %s %s" % (label, "finds" if want else "skips"), got == want, text.split("\n")[2:])

# sockets: the link / colour patterns the Vendor tab builds (js vendorSocketTerms)
sock = json.loads(subprocess.run(["node", "-e", "const vm=require('vm'),fs=require('fs');"
                                  "global.window={};vm.runInThisContext(fs.readFileSync(%s,'utf8'));"
                                  "const L={};VENDOR_LINKS.forEach(l=>L[l[0]]=l[2]);"
                                  "console.log(JSON.stringify({links:L,"
                                  "rgb:vendorSocketTerms({combos:[['r','g','b']]})[0],"
                                  "rrx:vendorSocketTerms({combos:[['r','r','x']]})[0],"
                                  "rr:vendorSocketTerms({combos:[['r','r','-']]})[0],"
                                  "blue2:vendorSocketTerms({counts:{b:2}})[0]}));" % json.dumps(src)],
                                 capture_output=True, text=True, check=True).stdout)
SOCK = [
    (sock["rgb"], "G-R-B", True), (sock["rgb"], "R-G G-B", False), (sock["rgb"], "B-B-R-G", True),
    (sock["rrx"], "R-G-R", True), (sock["rrx"], "R-G R", False), (sock["rr"], "G-R-R", True), (sock["rr"], "R-G-R", False),
    (sock["links"]["3"], "R-G-B", True), (sock["links"]["3"], "R-G B", False),
    (sock["links"]["4"], "R-G-B-B", True), (sock["links"]["4"], "R-G-B B", False),
    (sock["links"]["5"], "R-G-B-B-G", True), (sock["links"]["6"], "R-G-B-B-G-G", True),
    (sock["links"]["6"], "R-G-B-B-G G", False), (sock["links"]["6s"], "R-G B-B G-G", True),
    (sock["links"]["6s"], "R-G B-B G", False),
    (sock["blue2"], "R-B-G-B", True), (sock["blue2"], "R-B G-B", False),
]
for tok, sockets, want in SOCK:
    text = "Item Class: Boots\nRarity: Magic\nSockets: %s\nItem Level: 20\nAdds 1-2 to 3-4 Fire-Cold Damage" % sockets
    check("sockets %s %s %s" % (tok, "finds" if want else "skips", sockets), bool(re.search(tok, text, re.I | re.M)) == want)

# every token fits the 250-character box on its own
for kind in TABS:
    for label, tok in tokens(kind).items():
        check("fits the box: %s" % label, len('"%s"' % tok) <= 250, len(tok))

print("ALL TESTS PASSED" if not failures else "%d FAILED" % failures)
sys.exit(1 if failures else 0)
