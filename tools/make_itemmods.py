"""Generate data/itemmods.js: the rollable prefix/suffix mods of every equipment base group, with
a short in-game search token per mod, for the Items tab of the search-text builder
(js/app/31-regex.js).

Source: RePoE (https://repoe-fork.github.io) mods.min.json + base_items.min.json, cached in data/
(both gitignored) and downloaded when missing. Run:
    python tools/make_itemmods.py [--mods PATH] [--bases PATH] [--version X] [--offline]

Which mods: prefix/suffix mods of the gear / flask / jewel / abyss-jewel / tincture domains that
can roll on a plain released base. Spawn rule (as the game and RePoE): walk the mod's
spawn_weights in order; the FIRST tag the base carries decides, weight > 0 = can roll. Essence-
only mods are dropped; fossil/delve-only, influence (shaper/elder/conqueror), veiled, bench-
crafted, implicit and unique mods drop out on their own (no plain base carries their tags, or
they live in other domains / generation types).

Groups: the released bases of one item class that roll exactly the same mod set form a group,
named from the base tags that tell the class's groups apart ("Body Armour (Armour/Evasion)",
"Wand (minion)"), or from the base when it is alone ("Unset Ring", "Boots (Avian Slippers)").

Search: the game's search box is a case-insensitive regex over the item's ADVANCED text, where a
rolled number reads "73(70-79)" and every mod has a header line like
'{ Prefix Modifier "Healthy" (Tier: 8) — Life }'; ^ and $ anchor per line. A token is the
shortest lower-case regex piece (no digits) that matches one of the mod's lines and no other
mod line of any group holding this mod, no implicit line of those bases, and none of the text
every such item shows (property lines, base and affix names, header words). Matching an
IDENTICAL line of another mod is allowed when nothing exclusive exists ("+# to maximum Life"
alone and inside a hybrid are the same stat). Token forms, best first: a plain piece (it may
start with "\\)", the end of a rolled range: "\\) life per"), a line end ("d armour$"), a line
start ("^adds"); last resort a two-part "^start.*piece", which gets a `q` (below).

Output (window.POE_ITEM_MODS):
  v       RePoE version string
  groups  [{n: name, c: item class (singular display), b: [base names by drop level], m: [mod index]}]
  mods    [{t, k, r, x, o?, d?, q?}]   one entry per (text, prefix/suffix, tier set): the same
          text gets separate entries when different groups roll different tiers of it (life on a
          ring vs. a body armour), so every entry's tiers all roll on every group listing it.
    t  mod text, numbers/ranges as "#", markup stripped, hybrid lines joined with " / "
    k  "p" prefix | "s" suffix
    r  search regex token (above)
    x  [[ilvl, affix name, [min,max] of the KEY number, [min,max] of the other numbers in text
       order...], ...] best first (key number high to low, then item level). The key number is
       the first number on the line r targets (a fixed number is [n,n]).
    o  1 when r stands BEFORE the key number on its line ("^adds" in "Adds # to # ..."): the
       value search is  r.*N\\(  instead of  N\\(.*r
    d  1 when the key number shows decimals
    q  only for two-part tokens, where neither composition works: the value search with "#"
       standing for the number regex (N, then "\\("), e.g. "^#.*d maximum life".
"""
import argparse
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import searchtoken  # noqa: E402

REPOE = "https://repoe-fork.github.io/"
OUT = os.path.join(ROOT, "data", "itemmods.js")
DOMAINS = {"item", "flask", "misc", "abyss_jewel", "tincture"}
MIN_TOKEN = 3
MAX_TOKEN = 30
RANGED = "1(1-2)"   # how a rolled number reads in the advanced text
FIXED = "1"

# item class id -> (display name, plural on the "Item Class:" line); list order = picker order
CLASSES = [
    ("Body Armour", "Body Armour", "Body Armours"), ("Helmet", "Helmet", "Helmets"),
    ("Gloves", "Gloves", "Gloves"), ("Boots", "Boots", "Boots"), ("Shield", "Shield", "Shields"),
    ("Quiver", "Quiver", "Quivers"), ("Amulet", "Amulet", "Amulets"), ("Ring", "Ring", "Rings"),
    ("Belt", "Belt", "Belts"),
    ("One Hand Sword", "One Hand Sword", "One Hand Swords"),
    ("Thrusting One Hand Sword", "Thrusting One Hand Sword", "Thrusting One Hand Swords"),
    ("One Hand Axe", "One Hand Axe", "One Hand Axes"), ("One Hand Mace", "One Hand Mace", "One Hand Maces"),
    ("Sceptre", "Sceptre", "Sceptres"), ("Claw", "Claw", "Claws"), ("Dagger", "Dagger", "Daggers"),
    ("Rune Dagger", "Rune Dagger", "Rune Daggers"), ("Wand", "Wand", "Wands"), ("Bow", "Bow", "Bows"),
    ("Staff", "Staff", "Staves"), ("Warstaff", "Warstaff", "Warstaves"),
    ("Two Hand Sword", "Two Hand Sword", "Two Hand Swords"), ("Two Hand Axe", "Two Hand Axe", "Two Hand Axes"),
    ("Two Hand Mace", "Two Hand Mace", "Two Hand Maces"),
    ("LifeFlask", "Life Flask", "Life Flasks"), ("ManaFlask", "Mana Flask", "Mana Flasks"),
    ("HybridFlask", "Hybrid Flask", "Hybrid Flasks"), ("UtilityFlask", "Utility Flask", "Utility Flasks"),
    ("Tincture", "Tincture", "Tinctures"),
    ("Jewel", "Jewel", "Jewels"), ("AbyssJewel", "Abyss Jewel", "Abyss Jewels"),
]
CLASS_INFO = {cid: (i, disp, plural) for i, (cid, disp, plural) in enumerate(CLASSES)}

# base tags that tell the groups of one class apart -> label part (in this order)
TAG_LABEL = {
    "str_armour": "Armour", "dex_armour": "Evasion", "int_armour": "Energy Shield",
    "str_dex_armour": "Armour/Evasion", "str_int_armour": "Armour/Energy Shield",
    "dex_int_armour": "Evasion/Energy Shield", "str_dex_int_armour": "Armour/Evasion/Energy Shield",
    "ward_armour": "Ward",
    "weapon_can_roll_minion_modifiers": "minion", "ring_can_roll_minion_modifiers": "minion",
    "focus_can_roll_minion_modifiers": "minion",
    "abyss_jewel_melee": "melee", "abyss_jewel_ranged": "ranged", "abyss_jewel_caster": "caster",
    "abyss_jewel_summoner": "minion",
}

# text an item shows besides its mods (property lines, headers, flags); "#" = a number. A token
# must match none of it.
COMMON_LINES = """item class: rings
rarity: normal
rarity: magic
rarity: rare
rarity: unique
requirements:
requires level #
level: #
str: #
dex: #
int: #
sockets: r-g-b
item level: #
quality: +#% (augmented)
armour: #
evasion rating: #
energy shield: #
ward: #
chance to block: #%
physical damage: #-#
elemental damage: #-#
chaos damage: #-#
critical strike chance: #%
attacks per second: #
weapon range: #
recovers # life over # seconds
recovers # mana over # seconds
consumes # of # charges on use
currently has # charges
lasts # seconds
right click to drink. can only hold charges while in belt. refills as you kill monsters.
right click to activate. inflicts mana burn every # seconds
place into an allocated jewel socket on the passive skill tree. right click to remove from the socket.
place into an abyssal socket on an item or into an allocated jewel socket on the passive skill tree. right click to remove from the socket.
limited to: #
radius: small
radius: medium
radius: large
corrupted
mirrored
unidentified
split
fractured item
synthesised item
searing exarch item
eater of worlds item
shaper item
elder item
crusader item
hunter item
redeemer item
warlord item
{ prefix modifier "name" (tier: #) — life, defences }
{ suffix modifier "name" (tier: #) — elemental, fire, resistance }
{ implicit modifier }
{ master crafted prefix modifier "name" (rank: #) }
note: unmodifiable"""

# words of mod tags shown in the advanced "{ ... — Tag, Tag }" header line
HEADER_TAG_WORDS = """life mana defences elemental fire cold lightning chaos physical damage resistance
attack caster speed critical attribute minion aura curse gem ailment bleeding poison
ignite freeze shock flask influence jewel resource unveiled"""


def load_json(path, name, download):
    if not os.path.exists(path):
        if not download:
            sys.exit("missing %s (run without --offline to download)" % path)
        url = REPOE + name
        print("downloading", url)
        tmp = path + ".part"
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def repoe_version(download):
    if not download:
        return "unknown"
    try:
        with urllib.request.urlopen(REPOE + "version.txt", timeout=20) as r:
            return r.read().decode("utf-8").strip()
    except Exception as e:  # network
        print("warning: could not read the RePoE version:", e)
        return "unknown"


NUM = re.compile(r"\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)|(?<![\d.])(-?\d+(?:\.\d+)?)")
MARKUP = re.compile(r"\[(?:[^|\]]*\|)?([^\]]*)\]")


def num(s):
    return float(s) if "." in s else int(s)


def parse_text(text):
    """mod text -> (template lines, [[min,max] per number], [line index per number])."""
    lines, ranges, where = [], [], []
    for line in (text or "").split("\n"):
        line = MARKUP.sub(r"\1", line.strip())
        if not line:
            continue

        def rep(m, li=len(lines)):
            if m.group(3) is not None:
                ranges.append([num(m.group(3)), num(m.group(3))])
            else:
                ranges.append(sorted([num(m.group(1)), num(m.group(2))]))  # "(39-36)% reduced" too
            where.append(li)
            return "#"
        lines.append(NUM.sub(rep, line))
    return lines, ranges, where


def sample(line, ranged=None):
    """A template line as advanced item text (lower case): '#' -> '1(1-2)' (a rolled range) or
    '1' (a fixed number) per position; ranged=None = every number rolled."""
    out, k = [], 0
    for ch in line.lower():
        if ch == "#":
            out.append(RANGED if ranged is None or ranged[k] else FIXED)
            k += 1
        else:
            out.append(ch)
    return "".join(out)


def can_roll(mod, tags):
    for w in mod.get("spawn_weights", []):
        if w["tag"] in tags:
            return w["weight"] > 0
    return False


def group_name(cls_disp, gtags, class_tags, bases, siblings):
    """Readable name of one group; siblings = [(group tags, base count)] of its class."""
    if len(siblings) == 1:
        return cls_disp
    order = list(TAG_LABEL)
    label = ", ".join(TAG_LABEL[t] for t in sorted((t for t in gtags - class_tags if t in TAG_LABEL), key=order.index))
    if label:
        return "%s (%s)" % (cls_disp, label)
    if len(bases) == 1:
        last = cls_disp.split()[-1]
        return bases[0] if bases[0].endswith(last) else "%s (%s)" % (cls_disp, bases[0])
    plain = [s for s in siblings if s[1] > 1 and not any(t in TAG_LABEL for t in s[0] - class_tags)]
    if len(plain) == 1:
        return cls_disp  # the ordinary bases of a class whose other groups are labelled / single
    return "%s (%s)" % (cls_disp, "/".join(bases[:3]) + ("/..." if len(bases) > 3 else ""))


# ---- tokens ---------------------------------------------------------------------------------

def plain_pieces(s):
    """Plain-text candidates of a sample line, shortest first: no digits, no regex
    metacharacters except a leading ')' (the end of a rolled range), no space at either end."""
    seen = set()
    for n in range(MIN_TOKEN, min(MAX_TOKEN, len(s)) + 1):
        for i in range(0, len(s) - n + 1):
            t = s[i:i + n]
            if t in seen or t[0] == " " or t[-1] == " " or re.search(r"\d", t):
                continue
            if " " in t and len(t) < MIN_TOKEN + 1:
                continue  # "u t": two word ends, too easily part of a rare item's name
            body = t[1:] if t[0] == ")" else t
            if searchtoken.META & set(body) or (t[0] == ")" and len(body) < 2):
                continue
            seen.add(t)
            yield t


def esc(t):
    return searchtoken.escape(t)


class Pool:
    """Neighbour lines of one mod: (sample text, template line) plus the common text."""

    def __init__(self, nb, common):
        self.nb = nb                      # [(sample, template lower)]
        self.text = "\n".join(s for s, _ in nb)
        self.common = common              # [sample]
        self.common_text = "\n".join(common)

    def check(self, rx, own_tpl, literal=None):
        """None = invalid, False = exclusive, True = shared (only identical lines)."""
        if literal is not None:
            if literal in self.common_text:
                return None
            if literal not in self.text:
                return False
            hits = [tpl for s, tpl in self.nb if literal in s]
        else:
            r = re.compile(rx)
            if any(r.search(c) for c in self.common):
                return None
            hits = [tpl for s, tpl in self.nb if r.search(s)]
        if any(h != own_tpl for h in hits):
            return None
        return bool(hits)


def pick_token(own, pool):
    """own = [(template lower, sample)] lines of the mod. Returns (token, line index, pos of the
    token's text in the sample, needs_q, head text) or None. Ranking: simple before two-part,
    exclusive before shared, then shortest / no space / alphabetical."""
    best = {}
    # a hybrid's token goes on a line whose first number rolls a range when it can (the value
    # search needs "N(" there); lq = 0 for such a line
    lq = [0 if re.match(r"[^\d]*\d+\(", s) else 1 for _, s in own]

    def consider(slot, tok, li, pos, extra=None):
        c = (lq[li], len(tok), " " in tok, tok, li, pos, extra)
        if slot not in best or c < best[slot]:
            best[slot] = c

    for li, (tpl, s) in enumerate(own):
        for t in plain_pieces(s):
            b = best.get((0, False))
            if b and b[0] <= lq[li] and len(t) > b[1]:
                break
            rx = "\\)" + esc(t[1:]) if t[0] == ")" else esc(t)
            ok = pool.check(None, tpl, literal=t)
            if ok is not None:
                consider((0, ok), rx, li, s.find(t))
        # a line end after the last number / a line start before the first one
        m = re.search(r"\d(?!.*\d)", s)
        tail = s[m.end():] if m else s
        for i in range(len(tail)):
            t = tail[i:]
            body = t[1:] if t[0] == ")" else t
            if len(t) < MIN_TOKEN - 1 or t[0] == " " or searchtoken.META & set(body):
                continue
            rx = ("\\)" + esc(body) if t[0] == ")" else esc(t)) + "$"
            ok = pool.check(rx, tpl)
            if ok is not None:
                consider((0, ok), rx, li, len(s) - len(t))
        m = re.search(r"\d", s)
        head = s[:m.start()] if m else s
        for j in range(MIN_TOKEN - 1, len(head) + 1):
            t = head[:j]
            if t[-1] == " ":
                continue
            rx = "^" + esc(t)
            ok = pool.check(rx, tpl)
            if ok is not None:
                consider((0, ok), rx, li, 0)
    if (0, False) in best or (0, True) in best:
        c = best.get((0, False)) or best[(0, True)]
        return c[3], c[4], c[5], False, None
    # two-part: line start (text before the first number, or a digit) .* a plain piece after it
    for li, (tpl, s) in enumerate(own):
        m = re.search(r"\d", s)
        if not m:
            continue
        head = s[:m.start()]
        start = "^" + (esc(head) if head.strip() else "\\d")
        rest = s[m.start():]
        for t in plain_pieces(rest):
            b = best.get((1, False))
            if b and b[0] <= lq[li] and len(t) > b[1]:
                break
            piece = "\\)" + esc(t[1:]) if t[0] == ")" else esc(t)
            for rx in (start + ".*" + piece, start + ".*" + piece + "$"):
                if rx.endswith("$") and not s.endswith(t):
                    continue
                ok = pool.check(rx, tpl)
                if ok is not None:
                    consider((1, ok), rx, li, s.find(t), (head, piece + ("$" if rx.endswith("$") else "")))
    for slot in ((1, False), (1, True)):
        if slot in best:
            c = best[slot]
            return c[3], c[4], c[5], True, c[6]
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mods", default=os.path.join(ROOT, "data", "mods.min.json"))
    ap.add_argument("--bases", default=os.path.join(ROOT, "data", "base_items.min.json"))
    ap.add_argument("--version", help="RePoE version to record (default: read version.txt)")
    ap.add_argument("--offline", action="store_true", help="never download")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)

    mods = load_json(a.mods, "mods.min.json", not a.offline)
    bases = load_json(a.bases, "base_items.min.json", not a.offline)
    version = a.version or repoe_version(not a.offline)

    cand = {k: m for k, m in mods.items()
            if m.get("domain") in DOMAINS and m.get("generation_type") in ("prefix", "suffix")
            and not m.get("is_essence_only") and (m.get("text") or "").strip()}

    # families: one per (template, prefix/suffix)
    fam_of, tier_of, fams = {}, {}, {}
    for mid, m in cand.items():
        lines, ranges, where = parse_text(m["text"])
        if not lines:
            continue
        key = (" / ".join(lines), m["generation_type"][0])
        f = fams.setdefault(key, {"lines": lines, "where": where, "ranged": None})
        rng = [r[0] != r[1] for r in ranges]
        f["ranged"] = rng if f["ranged"] is None else [x and y for x, y in zip(f["ranged"], rng)]
        fam_of[mid] = key
        tier_of[mid] = (m.get("required_level", 0), m.get("name", ""), tuple(tuple(r) for r in ranges))

    # groups: released bases of one class rolling the same mod ids
    by_set = {}
    for b in bases.values():
        cid = b.get("item_class")
        if cid not in CLASS_INFO or b.get("release_state") != "released" or b.get("domain") not in DOMAINS:
            continue
        tags = set(b.get("tags", []))
        ids = frozenset(mid for mid, m in cand.items()
                        if mid in fam_of and m["domain"] == b["domain"] and can_roll(m, tags))
        if not ids:
            continue  # cluster jewels, Ethereal weapons ...: nothing rolls naturally
        g = by_set.setdefault((cid, ids), {"cid": cid, "ids": ids, "bases": [], "tags": None, "impl": set()})
        g["bases"].append(b)
        g["tags"] = tags if g["tags"] is None else g["tags"] & tags
        for imp in b.get("implicits", []):
            for line in parse_text((mods.get(imp) or {}).get("text"))[0]:
                g["impl"].add(line.lower())
    groups = list(by_set.values())
    by_class = {}
    for g in groups:
        names = []
        for b in sorted(g["bases"], key=lambda b: (b.get("drop_level", 0), b["name"])):
            if b["name"] not in names:
                names.append(b["name"])
        g["names"] = names
        by_class.setdefault(g["cid"], []).append(g)
    for cid, gl in by_class.items():
        class_tags = set.intersection(*[g["tags"] for g in gl])
        sib = [(x["tags"], len(x["names"])) for x in gl]
        for g in gl:
            g["n"] = group_name(CLASS_INFO[cid][1], g["tags"], class_tags, g["names"], sib)
    groups.sort(key=lambda g: (CLASS_INFO[g["cid"]][0], g["n"] != CLASS_INFO[g["cid"]][1], g["n"]))
    if len({g["n"] for g in groups}) != len(groups):
        sys.exit("duplicate group names: %s" % sorted(g["n"] for g in groups))

    # per group: family -> the tiers it rolls there
    fam_groups = {}
    for g in groups:
        g["fams"] = {}
        for mid in g["ids"]:
            g["fams"].setdefault(fam_of[mid], set()).add(tier_of[mid])
        for k in g["fams"]:
            fam_groups.setdefault(k, []).append(g)

    # common text: property lines, base / affix / class names, header tag words
    common = [sample(ln.strip(), [False] * 9) for ln in COMMON_LINES.split("\n") if ln.strip()]
    words = set(HEADER_TAG_WORDS.split())
    for g in groups:
        words.update(n.lower() for n in g["names"])
        words.add("item class: " + CLASS_INFO[g["cid"]][2].lower())
    for mid in fam_of:
        if cand[mid].get("name"):
            words.add(cand[mid]["name"].lower())
    common += sorted(words)

    # a token per family, valid in every group holding it
    tokens, shared_n, missing = {}, [], []
    for k in sorted(fam_groups, key=lambda k: (k[1], k[0].lower())):
        f = fams[k]
        own_tpls = [ln.lower() for ln in f["lines"]]
        pos = 0
        own = []
        for li, tpl in enumerate(own_tpls):
            cnt = tpl.count("#")
            own.append((tpl, sample(tpl, f["ranged"][pos:pos + cnt])))
            pos += cnt
        nb = {}
        for g in fam_groups[k]:
            for ok in g["fams"]:
                if ok != k:
                    for ln in fams[ok]["lines"]:
                        nb[ln.lower()] = 1
            for ln in g["impl"]:
                nb[ln] = 1
        pool = Pool([(sample(t), t) for t in sorted(nb)], common)
        res = pick_token(own, pool)
        if res is None:
            missing.append(k[0])
            tokens[k] = None
            continue
        tok, li, tpos, needs_q, extra = res
        shared = pool.check(tok, own[li][0]) is True
        if shared:
            shared_n.append(k[0])
        s = own[li][1]
        m = re.search(r"\d", s)
        info = {"r": tok}
        key_i = f["where"].index(li) if li in f["where"] else -1
        info["key"] = key_i
        if m and not needs_q and tpos < m.start():
            info["o"] = 1
        if needs_q:
            head, piece = extra
            info["q"] = "^" + esc(head) + "#.*" + piece
        tokens[k] = info

    # entries: one per (family, tier set)
    entries, eindex = [], {}
    for g in groups:
        g["m"] = []
        for k, tiers in g["fams"].items():
            if tokens.get(k) is None:
                continue
            ek = (k, frozenset(tiers))
            if ek not in eindex:
                eindex[ek] = None
                entries.append(ek)
    entries.sort(key=lambda e: (e[0][1], e[0][0].lower(), -len(e[1]), sorted(e[1])))
    for i, e in enumerate(entries):
        eindex[e] = i
    out_mods = []
    for (k, tiers) in entries:
        info = tokens[k]
        key_i = max(info["key"], 0)

        def ranges(t):
            rs = [list(r) for r in t[2]]
            return [rs[key_i]] + rs[:key_i] + rs[key_i + 1:] if rs else []
        tl = sorted(tiers, key=lambda t: (tuple(-x for x in (ranges(t)[0][::-1] if t[2] else ())), -t[0], t[1]))
        e = {"t": k[0], "k": k[1], "r": info["r"]}
        for fld in ("o", "q"):
            if fld in info:
                e[fld] = info[fld]
        if info["key"] >= 0 and any(isinstance(v, float) for t in tl for v in t[2][key_i]):
            e["d"] = 1
        e["x"] = [[t[0], t[1]] + ranges(t) for t in tl]
        out_mods.append(e)
    out_groups = []
    for g in groups:
        m = sorted(eindex[(k, frozenset(t))] for k, t in g["fams"].items() if tokens.get(k) is not None)
        out_groups.append({"n": g["n"], "c": CLASS_INFO[g["cid"]][1], "b": g["names"], "m": m})

    data = {"v": version, "groups": out_groups, "mods": out_mods}
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(a.out, "w", encoding="utf-8", newline="\n") as fo:
        fo.write("// generated by tools/make_itemmods.py from RePoE %s (mods.min.json + base_items.min.json); "
                 "schema in the tool's docstring\n" % version)
        fo.write("window.POE_ITEM_MODS = " + body + ";\n")
    size = os.path.getsize(a.out)
    nq = sum(1 for e in out_mods if "q" in e)
    print("Wrote %s: %d groups, %d mods from %d distinct texts (%d bytes)" %
          (os.path.relpath(a.out, ROOT), len(out_groups), len(out_mods), len(tokens), size))
    print("  %d texts share their token with an identical line of another mod" % len(shared_n))
    print("  %d texts need a two-part token (entries with q: %d)" % (sum(1 for t in tokens.values() if t and "q" in t), nq))
    print("  %d texts without any token (left out)" % len(missing))
    for t in missing:
        print("    no token:", t)
    bad = len(out_groups) < 15 or len(out_mods) < 300 or len(missing) > 5 or size > 400000
    if bad:
        print("SUSPICIOUS output: check the counts above")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
