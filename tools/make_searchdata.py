"""Generate data/searchdata.js: in-game search-box tokens for the regex builder (js/app/31-regex.js).

Path of Exile's stash / vendor search box is a case-insensitive regex (max 250 chars) matched
against an item's text. For each entry in a list (scarabs, tattoos, runegrafts, gems, heist jobs
and targets, Gwennen bases) the token is the shortest lower-case piece of the entry's NAME that
appears in no other entry's FULL text (name + description / tag / stat lines) of its pool, and
not in the text every item there shows (`common`). So "a|b|c" finds exactly those items.

When every piece of the name sits inside another entry's text ("Abyss Scarab" in "Abyss Scarab
of Crystals") the token is the whole name anchored to its line: "^abyss scarab$".

Sources (RePoE fork, https://repoe-fork.github.io/): base_items, gems, mods (cached in data/,
gitignored), gem_tags, item_classes, pob-data TattooPassives (tattoo / runegraft stat text) and
pob-data Uniques (which bases carry a unique) cached in the system temp folder.

Output:
  window.POE_SEARCH_DATA = {
    v: RePoE version,
    scarabs:    [{n: name, t: token, d: description, g: family}],
    tattoos:    [{n, t, d?}],  runegrafts: [{n, t, d?}],
    gems:       [{n, t, c: r|g|b|w, s?: 1 support, a?: 1 awakened, x?: 1 transfigured}],
    heist:      {jobs: [{n, t}], targets: [{n, t}]},
    gwennen:    [{n: base, t, c: item class, u?: 1 a unique uses this base}],
  }
Run:  python tools/make_searchdata.py [--fetch]
"""
import json
import os
import re
import sys
import tempfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
TMP = os.path.join(tempfile.gettempdir(), "pobtf-repoe")
sys.path.insert(0, HERE)
import searchtoken as st  # noqa: E402

SRC = "https://repoe-fork.github.io/"
UA = "PoBTradeFinder data build (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)"
IN_DATA = {"base_items.min.json", "gems.min.json", "mods.min.json"}  # gitignored in data/
MAX_TOKEN = 30
MARKUP = re.compile(r"\[(?:[^|\]]*\|)?([^\]]*)\]")  # [ContainsAbyss|Abyss] -> Abyss

SCARAB_TIERS = {"common_scarab", "uncommon_scarab", "rare_scarab", "mythic_scarab", "extreme_scarab"}
HEIST_JOBS = ["Lockpicking", "Brute Force", "Perception", "Demolition", "Counter-Thaumaturgy",
              "Trap Disarmament", "Agility", "Deception", "Engineering"]
GWENNEN_CLASSES = {
    "Amulet", "Ring", "Belt", "Body Armour", "Boots", "Gloves", "Helmet", "Shield", "Quiver",
    "Bow", "Claw", "Dagger", "Rune Dagger", "One Hand Axe", "One Hand Mace", "One Hand Sword",
    "Thrusting One Hand Sword", "Two Hand Axe", "Two Hand Mace", "Two Hand Sword", "Sceptre",
    "Staff", "Warstaff", "Wand", "LifeFlask", "ManaFlask", "HybridFlask", "UtilityFlask",
    "Jewel", "AbyssJewel", "Tincture",
}
POB_UNIQUE_FILES = ["amulet", "axe", "belt", "body", "boots", "bow", "claw", "dagger", "flask", "gloves",
                    "helmet", "jewel", "mace", "quiver", "ring", "shield", "staff", "sword", "tincture", "wand"]

# text every item in that window/stash shows: a token must not hit it (it would select all)
COMMON_SCARAB = ("Item Class: Map Fragments\nRarity: Normal\nStack Size:\nLimit:\n"
                 "Can be used in a personal Map Device to add modifiers to a Map.")
COMMON_TATTOO = ("Item Class: Stackable Currency\nRarity: Currency\nStack Size:\n"
                 "Right click this item then left click an allocated Passive Skill. Maximum 50 Tattoos.\n"
                 "Right click this item then left click\nan allocated Passive Mastery Skill.\n"
                 "Only one Runegraft of any given\ntype can be in use at a time.\n"
                 "Right click this item then left click an allocated Passive Mastery Skill. "
                 "Only one Runegraft of any given type can be in use at a time.")
COMMON_GEM = ("Item Class: Skill Gems\nItem Class: Support Gems\nRarity: Gem\nLevel: (Max)\nCost: Mana Life\n"
              "Reservation:\nReservation Override:\nMana Multiplier:\nCooldown Time:\nCast Time:\n"
              "Attack Speed:\nAttack Damage:\nCritical Strike Chance:\nEffectiveness of Added Damage:\n"
              "Quality:\nExperience:\nRequirements:\nRequires Level\nStr:\nDex:\nInt:\nSouls Per Use:\n"
              "Can Store Use\nSoul Gain Prevention:\nCorrupted\nMirrored\nUnmodifiable\n"
              "Additional Effects From Quality:\n"
              "Place into an item socket of the right colour to gain this skill. Right click to remove from a socket.\n"
              "This is a Support Gem. It does not grant a bonus to your character, but to skills in sockets "
              "connected to it. Place into an item socket connected to a socket containing the Active Skill Gem "
              "you wish to augment. Right click to remove from a socket.")
COMMON_HEIST = ("Item Class: Contracts\nItem Class: Blueprints\nRarity: Normal\nRarity: Magic\nRarity: Rare\n"
                "Rarity: Unique\nItem Level:\nUnidentified\nCorrupted\nContract:\nBlueprint:\nHeist Target:\n"
                "Client:\nArea Level:\nRequires (Level)\nWings Revealed:\nEscape Routes Revealed:\n"
                "Reward Rooms Revealed:\nModerate Value\nHigh Value\nPrecious\nPriceless")
COMMON_GWENNEN = ("Rarity: Unique\nUnidentified\nRequirements:\nLevel:\nStr:\nDex:\nInt:\nItem Level:\nQuality:\n"
                  "Sockets:\nArmour:\nEvasion Rating:\nEnergy Shield:\nWard:\nChance to Block:\nPhysical Damage:\n"
                  "Elemental Damage:\nCritical Strike Chance:\nAttacks per Second:\nWeapon Range:\nRadius:\n"
                  "Limited to:\nLasts Seconds\nConsumes of Charges on use\nCurrently has Charges\n"
                  "Recovers Life over Seconds\nRecovers Mana over Seconds\n"
                  "Right click to drink. Can only hold charges while in belt. Refills as you kill monsters.\n"
                  "Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.\n"
                  "Inflicts Mana Burn on you when used\n"
                  "Right click to activate. Only one Tincture in each slot can be active at a time.\n"
                  "Can only be equipped if you are wielding a Bow.\n"
                  "One Handed Axe\nTwo Handed Axe\nOne Handed Mace\nTwo Handed Mace\nOne Handed Sword\n"
                  "Two Handed Sword\nBow\nClaw\nDagger\nRune Dagger\nSceptre\nStaff\nWarstaff\nWand")


# ---- sources -----------------------------------------------------------------------------------
def fetch(name):
    req = urllib.request.Request(SRC + name, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def cache_path(name):
    return os.path.join(DATA if name in IN_DATA else TMP, name.replace("/", "_"))


def load(name, refresh=False, allow_fetch=True):
    """RePoE file `name` as JSON, from its cache or downloaded (and cached)."""
    path = cache_path(name)
    if refresh or not os.path.exists(path):
        if not allow_fetch:
            raise FileNotFoundError(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = fetch(name)
        with open(path, "wb") as f:
            f.write(data)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def repoe_version():
    try:
        return fetch("version.txt").decode("utf-8").strip()
    except Exception:
        return ""


# ---- text helpers ------------------------------------------------------------------------------
def clean_lines(text):
    """Description text -> its lines: markup stripped, blank lines dropped."""
    text = MARKUP.sub(r"\1", (text or "").replace("\r\n", "\n").replace("\r", "\n"))
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def full_text(name, lines):
    """What an item shows: its name line, its other lines, and those lines unwrapped (the game
    wraps long lines; a match may run across the wrap)."""
    return "\n".join([name] + list(lines)) + ("\n" + " ".join(lines) if len(lines) > 1 else "")


def anchored(name):
    return "^" + st.escape(name.lower()) + "$"


def unique_tokens(names, texts, extra=(), common="", max_len=MAX_TOKEN):
    """For each names[i], the shortest piece of the name (searchtoken.candidates: no digits, no
    regex metacharacters, no edge spaces) found in no other entry's full text (texts[j], j != i),
    in no `extra` text (pool members that get no token) and not in `common`. Ties: a piece
    without spaces, then alphabetical. None when no piece qualifies."""
    low = [t.lower() for t in texts]
    ext = [t.lower() for t in extra]
    common = common.lower()
    out = []
    for i, name in enumerate(names):
        best = []
        for c in st.candidates(name, max_len):
            if best and len(c) > len(best[0]):
                break
            if c in common or any(c in o for o in ext) or any(c in o for j, o in enumerate(low) if j != i):
                continue
            best.append(c)
        best.sort(key=lambda c: (" " in c, c))
        out.append(best[0] if best else None)
    return out


def tokenise(entries, extra=(), common=""):
    """entries: [{"n": name, "_text": full text}] -> sets e["t"]; returns the fallback count."""
    toks = unique_tokens([e["n"] for e in entries], [e["_text"] for e in entries], extra, common)
    fb = 0
    for e, t in zip(entries, toks):
        if not t:
            t, fb = anchored(e["n"]), fb + 1
        e["t"] = t
    return fb


def dedupe(entries):
    seen, out = set(), []
    for e in entries:
        if e["n"].lower() not in seen:
            seen.add(e["n"].lower())
            out.append(e)
    return out


# ---- pools -------------------------------------------------------------------------------------
def released(b):
    return b.get("release_state") == "released" and not (b.get("name") or "").startswith("[")


def scarab_pool(bases):
    """Current scarabs (with a scarab rarity tag) + every other released map fragment as extra
    pool text (the scarab tab also holds them; legacy Rusted/Polished/Gilded/Winged scarabs
    still sit in old stashes)."""
    entries, extra = [], []
    for b in bases.values():
        if b.get("item_class") != "MapFragment" or not released(b):
            continue
        p = b.get("properties") or {}
        lines = clean_lines(p.get("description"))
        tags = set(b.get("tags") or [])
        if "scarab" in tags and tags & SCARAB_TIERS:
            name = b["name"]
            fam = name.split(" Scarab")[0].strip() if not name.startswith("Scarab") else "Misc"
            entries.append({"n": name, "d": "\n".join(lines), "g": fam or "Misc", "_text": full_text(name, lines)})
        else:
            extra.append(full_text(b["name"], lines + clean_lines(p.get("directions"))))
    entries = dedupe(sorted(entries, key=lambda e: (e["g"], e["n"])))
    return entries, extra, COMMON_SCARAB


def tattoo_pools(bases, passives):
    nodes = (passives or {}).get("nodes") or {}
    tat, rune = [], []
    for b in bases.values():
        name = b.get("name") or ""
        if b.get("item_class") != "StackableCurrency" or not released(b):
            continue
        if "Tattoo" not in name and "Runegraft" not in name:
            continue
        node = nodes.get(name)
        lines = [MARKUP.sub(r"\1", ln).strip() for ln in (node or {}).get("sd") or [] if ln.strip()]
        e = {"n": name, "_text": full_text(name, lines)}
        if lines:
            e["d"] = "\n".join(lines)
        (rune if "Runegraft" in name else tat).append(e)
    tat = dedupe(sorted(tat, key=lambda e: e["n"]))
    rune = dedupe(sorted(rune, key=lambda e: e["n"]))
    return tat, rune, COMMON_TATTOO


def gem_pool(gems, gem_tags):
    entries = []
    for key, g in gems.items():
        bi = g.get("base_item") or {}
        name = (g.get("display_name") or "").strip()
        if bi.get("release_state") != "released" or "Royale" in key or not name or name.startswith("[") \
                or "Unknown" in name or g.get("color") not in ("r", "g", "b", "w"):
            continue
        tagline = ", ".join(gem_tags.get(t) for t in g.get("tags") or [] if gem_tags.get(t))
        lines = [tagline] if tagline else []
        sk = g.get("active_skill") or {}
        lines += clean_lines(sk.get("description"))
        sec = g.get("secondary_granted_effect")
        if sec and sec in gems:  # a Vaal gem also shows its plain skill
            lines += clean_lines(((gems[sec].get("active_skill") or {}).get("description")))
        lines += clean_lines((g.get("support_gem") or {}).get("support_text"))
        stc = g.get("static") or {}
        lines += [ln for v in (stc.get("stat_text") or {}).values() for ln in clean_lines(v)]
        lines += [ln for q in stc.get("quality_stats") or [] for ln in clean_lines(q.get("stat"))]
        pl = g.get("per_level") or {}
        if pl:
            lines += [ln for v in (pl[min(pl, key=lambda k: int(k) if str(k).isdigit() else 99)]
                                   .get("stat_text") or {}).values() for ln in clean_lines(v)]
        e = {"n": name, "c": g["color"], "_text": full_text(name, lines)}
        if g.get("is_support"):
            e["s"] = 1
        if name.startswith("Awakened "):
            e["a"] = 1
        if re.search(r"Alt[XYZ]$", key) or (bi.get("display_name") and bi["display_name"] != name):
            e["x"] = 1
        entries.append(e)
    entries = dedupe(sorted(entries, key=lambda e: e["n"]))
    return entries, COMMON_GEM


def heist_pools(bases, mods):
    places = [b["name"] for b in bases.values() if b.get("item_class") in ("HeistContract", "HeistBlueprint")
              and released(b)]
    contract_mods = []
    for m in mods.values():
        if m.get("domain") == "heist_area":
            contract_mods += clean_lines(m.get("text")) + ([m["name"]] if m.get("name") else [])
    common = COMMON_HEIST + "\n" + "\n".join(places) + "\n" + "\n".join(sorted(set(contract_mods)))
    jobs = [{"n": j, "_text": "Requires " + j + " (Level)"} for j in HEIST_JOBS]
    targets = dedupe(sorted(({"n": b["name"], "_text": b["name"]} for b in bases.values()
                             if b.get("item_class") == "HeistObjective" and released(b)), key=lambda e: e["n"]))
    return jobs, targets, common


def unique_bases(names, refresh=False, allow_fetch=True):
    """Base names some unique uses (pob-data Uniques: line 2 of each entry is the base; variant
    bases are listed before the Implicits line)."""
    used = set()
    for f in POB_UNIQUE_FILES:
        for item in load("pob-data/poe1/Uniques/%s.json" % f, refresh, allow_fetch):
            for ln in item.split("\n")[1:]:
                if ln.startswith("Implicits:"):
                    break
                ln = re.sub(r"^\{[^}]*\}", "", ln).strip()
                if ln in names:
                    used.add(ln)
    return used


def gwennen_pool(bases, mods, classes, uniques=None):
    entries = []
    for b in bases.values():
        cls = b.get("item_class")
        if cls not in GWENNEN_CLASSES or b.get("release_state") not in ("released", "unique_only") \
                or (b.get("name") or "").startswith("["):
            continue
        lines = [ln for mid in b.get("implicits") or [] for ln in clean_lines((mods.get(mid) or {}).get("text"))]
        disp = ((classes or {}).get(cls) or {}).get("name") or cls
        e = {"n": b["name"], "c": disp, "_text": full_text(b["name"], lines)}
        if uniques is not None and b["name"] in uniques:
            e["u"] = 1
        entries.append(e)
    entries = dedupe(sorted(entries, key=lambda e: (e["c"], e["n"])))
    common = COMMON_GWENNEN + "\n" + "\n".join("Item Class: " + ((classes or {}).get(c) or {}).get("name", c)
                                               for c in sorted(GWENNEN_CLASSES))
    return entries, common


def build_pools(refresh=False, allow_fetch=True):
    """Every list with its entries' full texts, extra pool texts and common text."""
    bases = load("base_items.min.json", refresh, allow_fetch)
    gems = load("gems.min.json", refresh, allow_fetch)
    mods = load("mods.min.json", refresh, allow_fetch)
    gem_tags = load("gem_tags.min.json", refresh, allow_fetch)
    classes = load("item_classes.min.json", refresh, allow_fetch)
    try:
        passives = load("pob-data/poe1/TattooPassives.json", refresh, allow_fetch)
    except Exception as ex:
        print("  (no tattoo stat text: %s)" % ex)
        passives = {}
    scarabs, scarab_extra, scarab_common = scarab_pool(bases)
    tat, rune, tat_common = tattoo_pools(bases, passives)
    gem_entries, gem_common = gem_pool(gems, gem_tags)
    jobs, targets, heist_common = heist_pools(bases, mods)
    gw_names = {b["name"] for b in bases.values() if b.get("item_class") in GWENNEN_CLASSES}
    try:
        used = unique_bases(gw_names, refresh, allow_fetch)
    except Exception as ex:
        print("  (no unique base list, u flag left out: %s)" % ex)
        used = None
    gw, gw_common = gwennen_pool(bases, mods, classes, used)
    return {
        # list: (entries, extra pool texts, common)
        "scarabs": (scarabs, scarab_extra, scarab_common),
        # tattoos and runegrafts share one stash section: each is the other's extra pool
        "tattoos": (tat, [e["_text"] for e in rune], tat_common),
        "runegrafts": (rune, [e["_text"] for e in tat], tat_common),
        "gems": (gem_entries, [], gem_common),
        # a contract shows both its job and its target
        "heist.jobs": (jobs, [e["_text"] for e in targets], heist_common),
        "heist.targets": (targets, [e["_text"] for e in jobs], heist_common),
        "gwennen": (gw, [], gw_common),
    }


# ---- main --------------------------------------------------------------------------------------
MIN_COUNT = {"scarabs": 80, "tattoos": 60, "runegrafts": 20, "gems": 500, "heist.jobs": 9,
             "heist.targets": 20, "gwennen": 500}
KEEP = {"scarabs": ("n", "t", "d", "g"), "tattoos": ("n", "t", "d"), "runegrafts": ("n", "t", "d"),
        "gems": ("n", "t", "c", "s", "a", "x"), "heist.jobs": ("n", "t"), "heist.targets": ("n", "t"),
        "gwennen": ("n", "t", "c", "u")}


def main():
    refresh = "--fetch" in sys.argv
    pools = build_pools(refresh)
    out = {"v": repoe_version(), "heist": {}}
    bad = 0
    print("make_searchdata: RePoE %s" % (out["v"] or "?"))
    for key, (entries, extra, common) in pools.items():
        fb = tokenise(entries, extra, common)
        rows = [{k: e[k] for k in KEEP[key] if k in e and e[k] not in ("", None)} for e in entries]
        long_ = [e["t"] for e in entries if len(e["t"]) > 40]
        print("  %-14s %4d entries, %3d use the ^name$ fallback%s" % (
            key, len(rows), fb, (", %d tokens > 40 chars" % len(long_)) if long_ else ""))
        for e in [e for e in entries if e["t"].startswith("^")][:6]:
            print("      fallback:", e["t"])
        if len(rows) < MIN_COUNT[key]:
            print("  !! %s looks incomplete (%d < %d)" % (key, len(rows), MIN_COUNT[key]))
            bad += 1
        if key.startswith("heist."):
            out["heist"][key.split(".")[1]] = rows
        else:
            out[key] = rows
    if bad:
        print("not writing data/searchdata.js")
        return 1
    order = ["v", "scarabs", "tattoos", "runegrafts", "gems", "heist", "gwennen"]
    out = {k: out[k] for k in order}
    dest = os.path.join(DATA, "searchdata.js")
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write("// generated by tools/make_searchdata.py from RePoE (%s); t = shortest unique search text\n"
                % (out["v"] or "unknown version"))
        f.write("window.POE_SEARCH_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("wrote data/searchdata.js (%d bytes)" % os.path.getsize(dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
