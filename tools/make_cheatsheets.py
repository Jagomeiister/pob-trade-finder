"""Generate data/cheatsheets.js (and server/public/cheatsheets.json): ready-made cheat sheets, built
only from the community Path of Exile Wiki (CC BY-NC-SA 3.0) so nothing on them is written from memory.

Leveling ("acts" / "labs"):
- passive skill point and respec point quests per act  (Cargo table quest_rewards: Book of
  Skill / Book of Regrets rewards; "act" = where the reward is handed out)
- Trials of Ascendancy per act and labyrinth          (page "Trial of Ascendancy")
- bandit choice rewards                               (page "Deal with the Bandits", current
  reward sections)
- labyrinth area levels                               (Cargo table areas: Aspirant's Trial)
- resistance penalties after Acts 5 and 10            (page "Resistance")

Mechanics ("mechanics"): one sheet per league mechanic / crafting system, from Cargo tables (exported
from the game data) where they exist and from page tables otherwise. Each sheet has a sanity guard
(minimum rows, required names) and stale-wiki checks against known 3.26-3.29 changes; a sheet that
fails is skipped with a warning and the rest still build.

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
WIKI_PAGE = "https://www.poewiki.net/wiki/"
UA = "PoBTradeFinder data build (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)"
SOURCE = "Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0"
LABS = {1: "Normal", 2: "Normal", 3: "Normal", 6: "Cruel", 7: "Cruel", 8: "Merciless", 9: "Merciless", 10: "Merciless"}
PATCH = "3.29"  # the game version the mechanic sheets are checked against (see the stale-wiki checks)
MIN_MECHANICS = 8
CELL_MAX = 140

try:
    sys.stdout.reconfigure(errors="backslashreplace")  # wiki text holds non-ASCII names; cp1252 console
except Exception:
    pass


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


# ---------------------------------------------------------------------------------------------------
# Mechanic sheets: wiki helpers
# ---------------------------------------------------------------------------------------------------

class Skip(Exception):
    """A mechanic failed its sanity guard or a stale-wiki check; it is left out of the output."""


WARNINGS = []


def warn(msg):
    WARNINGS.append(msg)
    print("WARNING: " + msg)


def cargo(tables, fields, where=None, join_on=None, order_by=None, group_by=None):
    """All rows of a Cargo query (pages with offset; the wiki caps a page at 500 rows). Output field
    names are the aliases in `fields`; keep them free of underscores (the API turns those into spaces)."""
    out, offset = [], 0
    while True:
        p = {"action": "cargoquery", "tables": tables, "fields": fields, "limit": "500", "offset": str(offset)}
        for k, v in (("where", where), ("join_on", join_on), ("order_by", order_by), ("group_by", group_by)):
            if v:
                p[k] = v
        rows = [r["title"] for r in api(p)["cargoquery"]]
        out += rows
        if len(rows) < 500:
            return out
        offset += 500


def pages(titles):
    """Wikitext of several pages in one request (redirects followed), keyed by the requested title."""
    d = api({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": "1",
             "formatversion": "2", "titles": "|".join(titles)})
    q = d["query"]
    alias = {r["from"]: r["to"] for r in q.get("normalized", []) + q.get("redirects", [])}
    got = {p["title"]: p["revisions"][0]["slots"]["main"]["content"] for p in q["pages"] if p.get("revisions")}
    out = {}
    for t in titles:
        k = t
        for _ in range(4):
            k = alias.get(k, k)
        if k in got:
            out[t] = got[k]
        else:
            try:
                out[t] = wikitext(t)  # a page the batch did not return (size limits): fetch it alone
            except Exception as e:
                warn("page %r not fetched: %s" % (t, e))
    return out


def _split_top(s, seps):
    """Split on any of `seps` outside [[...]] and {{...}}."""
    parts, buf, depth, i = [], [], 0, 0
    while i < len(s):
        two = s[i:i + 2]
        if two in ("[[", "{{"):
            depth += 1
            buf.append(two)
            i += 2
            continue
        if two in ("]]", "}}") and depth:
            depth -= 1
            buf.append(two)
            i += 2
            continue
        hit = next((sep for sep in seps if depth == 0 and s.startswith(sep, i)), None)
        if hit:
            parts.append("".join(buf))
            buf = []
            i += len(hit)
            continue
        buf.append(s[i])
        i += 1
    parts.append("".join(buf))
    return parts


_DROP_TPL = {"citation needed", "undocumented", "clear", "anchor", "ml", "main", "see also", "for", "reflist",
             "minimap icon", "toc", "-"}


def _tpl(m):
    parts = m.group(1).split("|")
    name = parts[0].strip().lower()
    pos = [a for a in parts[1:] if not re.match(r"\s*[\w ]+=", a)]
    if name in _DROP_TPL:
        return ""
    if name in ("il", "item link", "c"):
        return pos[-1] if pos else ""
    return pos[0] if pos else ""


def clean(s, limit=CELL_MAX):
    """Wiki markup / Cargo HTML -> one line of plain text."""
    if s is None:
        return ""
    s = html.unescape(str(s))
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<ref[^>/]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<sup[^>]*>.*?</sup>", "", s, flags=re.S)  # editor's notes and footnote marks
    s = re.sub(r"\[\[(?:File|Image|Category):[^\]]*\]\]", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", s)
    for _ in range(6):
        s2 = re.sub(r"\{\{([^{}]*)\}\}", _tpl, s)
        if s2 == s:
            break
        s = s2
    s = re.sub(r"''+", "", s)
    s = re.sub(r"<br\s*/?>", "; ", s, flags=re.I)
    s = re.sub(r"<[^>]*>", "", s)
    s = re.sub(r"\n\s*[*#:]+\s*", "; ", s)
    s = html.unescape(s).replace("�", "?").replace("<", "less than ")  # U+FFFD: broken bytes on the wiki
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*;\s*(;\s*)*", "; ", s)
    s = s.strip(" ;*:#")
    if limit and len(s) > limit:
        s = s[:limit - 1].rstrip(" ,;") + "…"
    return s


def section(text, title):
    """Text of the section headed `title` (up to the next heading of the same or a higher level)."""
    m = re.search(r"^(=+)\s*" + re.escape(title) + r"\s*\1\s*$", text, re.M)
    if not m:
        raise Skip("section %r not found" % title)
    lvl = len(m.group(1))
    nxt = re.compile(r"^={1,%d}[^=].*?=+\s*$" % lvl, re.M).search(text, m.end())
    return text[m.end(): nxt.start() if nxt else len(text)]


def wikitables(text):
    """Top-level {| ... |} tables in `text`, in order."""
    out, buf, depth = [], [], 0
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("{|"):
            depth += 1
        if depth:
            buf.append(line)
        if s.startswith("|}") and depth:
            depth -= 1
            if not depth:
                out.append("\n".join(buf))
                buf = []
    return out


def parse_table(t):
    """A wikitable -> {"header": [raw cells], "rows": [[raw cells]]}; rowspans are expanded and
    nested tables are kept inside the cell that holds them."""
    rows, cells, nested = [], None, 0
    for line in t.split("\n")[1:]:
        s = line.strip()
        if nested:
            nested += s.startswith("{|")
            nested -= s.startswith("|}")
            cells[-1][1] += "\n" + line
            continue
        if s.startswith("{|"):
            nested = 1
            if cells:
                cells[-1][1] += "\n" + line
            continue
        if s.startswith("|}"):
            break
        if s.startswith("|+"):
            continue
        if s.startswith("|-"):
            if cells:
                rows.append(cells)
            cells = []
            continue
        if s.startswith("!") or s.startswith("|"):
            cells = cells if cells is not None else []
            hdr = s.startswith("!")
            for p in _split_top(s[1:], ("!!", "||") if hdr else ("||",)):
                cells.append([hdr, p])
        elif cells:
            cells[-1][1] += "\n" + line
    if cells:
        rows.append(cells)
    grid, pending = [], {}
    for cells in rows:
        row, col, ci = [], 0, 0
        while ci < len(cells) or col in pending:
            if col in pending:
                left, txt, h = pending[col]
                row.append((h, txt))
                if left > 1:
                    pending[col] = (left - 1, txt, h)
                else:
                    del pending[col]
                col += 1
                continue
            h, raw = cells[ci]
            ci += 1
            parts = _split_top(raw, ("|",))
            attrs, txt = ("", raw)
            if len(parts) > 1 and "=" in parts[0] and "[[" not in parts[0] and "{{" not in parts[0]:
                attrs, txt = parts[0], "|".join(parts[1:])
            span = re.search(r'rowspan\s*=\s*"?(\d+)', attrs)
            row.append((h, txt))
            if span and int(span.group(1)) > 1:
                pending[col] = (int(span.group(1)) - 1, txt, h)
            col += 1
        if row:
            grid.append(row)
    header = [c[1] for c in grid[0]] if grid and all(c[0] for c in grid[0]) else []
    body = grid[1:] if header else grid
    return {"header": header, "rows": [[c[1] for c in r] for r in body]}


def bullets(text, fold=True):
    """First-level list items ('* ' / '# '). Sub-items ('**', '##') are folded into their parent
    ("parent: a, b") when `fold`, else dropped; '*:' continuation lines are always dropped."""
    out = []
    for line in text.split("\n"):
        m = re.match(r"^([*#:]+)\s*(.*)$", line)
        if not m or not m.group(2).strip() or ":" in m.group(1):
            continue
        if len(m.group(1)) == 1:
            out.append([m.group(2).strip(), []])
        elif out and fold:
            out[-1][1].append(m.group(2).strip())
    return [h if not subs else h.rstrip(":") + ": " + ", ".join(subs) for h, subs in out]


def sentences(text):
    t = clean(text, limit=0)
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z])", t) if s.strip()]


def table_section(title, columns, rows):
    return {"title": title, "columns": columns, "rows": rows}


def list_section(title, lines):
    return {"title": title, "lines": lines}


def need(cond, msg):
    if not cond:
        raise Skip(msg)


# ---------------------------------------------------------------------------------------------------
# Mechanic builders. Each takes the shared context `cx` (page wikitext, cached Cargo rows) and returns
# {"sections": [...], plus optional "source"/"url"/"match"}; it raises Skip when its guard fails.
# ---------------------------------------------------------------------------------------------------

ABYSS_JEWEL = re.compile(r"abyss(?:al)?\b[^.;]{0,30}jewel", re.I)
DIVISIONS = ["Transportation", "Fortification", "Research", "Intervention"]


def m_syndicate(cx):
    w = cx["pages"]["Immortal Syndicate"]
    tabs = wikitables(section(w, "Summarized rewards by member/division"))
    need(tabs, "summary table missing")
    t = parse_table(tabs[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr[1:] == DIVISIONS, "unexpected division columns %r" % hdr)
    rows = []
    for r in t["rows"]:
        cells = [clean(c) for c in r]
        if len(cells) != 5 or not cells[0]:
            continue
        if ABYSS_JEWEL.search(" ".join(cells[1:])):
            warn("syndicate: dropped the %s row: it still lists abyss jewels, removed from Syndicate rewards in 3.29 "
                 "(stale wiki)" % cells[0])
            continue
        rows.append(cells)
    vagan = next((r for r in rows if r[0].startswith("Vagan")), None)
    need(vagan, "Vagan row missing")
    need("Trarthan" in vagan[1] and "Enshrouded" in vagan[2],
         "Vagan's Transportation/Fortification rewards are not the 3.29 Trarthan scarabs / Enshrouded uniques "
         "(stale wiki): %r" % vagan[1:3])
    need(len(rows) >= 14 and any(r[0] == "Aisling" for r in rows), "only %d members" % len(rows))
    sections = [table_section("Safehouse rewards by member and division", ["Member"] + DIVISIONS, rows)]
    uniq = [clean(m.group(1) + ": " + m.group(2)) for m in
            re.finditer(r"^\* (%s): (.+)$" % "|".join(DIVISIONS), section(w, "Syndicate Safehouse"), re.M)]
    if len(uniq) == 4:
        sections.append(list_section("Leader-exclusive veiled unique (area level 78+), by division", uniq))
    return {"sections": sections, "source": "PoE Wiki: Immortal Syndicate (summarized rewards table)",
            "url": WIKI_PAGE + "Immortal_Syndicate"}


ALTAR_ID = re.compile(r"(Upside|Downside)(Boss|Monster|Player)(\w+)$")
TARGET = {"Boss": "Boss", "Monster": "Minions", "Player": "Player"}
DANGER = re.compile(r"Extra \w* ?Damage|Penetrates|Exposure|additional Projectiles|increased (?:Attack|Cast|Movement) "
                    r"Speed|ignore Enemy Physical Damage Reduction")


def m_eldritch(cx):
    w = cx["pages"]["Eldritch altar"]
    altars = dict((tag, name) for name, tag in
                  re.findall(r"==List of (.+?) Altar modifiers==.*?tag in \(\"(\w+)\"\)", w, re.S))
    need(len(altars) == 2, "altar sections not found: %r" % altars)
    tags = ",".join("'%s'" % t for t in altars)
    rows = cargo("mods,mod_spawn_weights", "mods.id=id,mods.stat_text_raw=text,mod_spawn_weights.tag=tag",
                 where="mods.domain=29 AND mods.game_mode IN (0,1) AND mod_spawn_weights.tag IN (%s) "
                       "AND mod_spawn_weights.value>0" % tags,
                 join_on="mods._pageID=mod_spawn_weights._pageID")
    short = {t: ("Exarch" if "Exarch" in n else "Eater" if "Eater" in n else n) for t, n in altars.items()}
    rewards, player_up, downs, dropped_qr = {}, [], [], set()
    split_qr = re.search(r"Split the existing Modifier that granted increased Quantity and Rarity", w)
    for r in rows:
        m = ALTAR_ID.search(r["id"] or "")
        text = clean(r["text"])
        if not m or not text:
            continue
        kind, target, key = m.groups()
        altar = short[r["tag"]]
        if kind == "Upside" and target in ("Boss", "Monster"):
            name = re.search(r"drops? (?:\([\d.-]+\) |\d+ )?(?:an )?additional (.+)$", text)
            e = rewards.setdefault(key, {"name": None, "cells": {}})
            if name and (target == "Boss" or not e["name"]):
                e["name"] = name.group(1)
            e["cells"].setdefault(altar, set()).add(TARGET[target])
        elif kind == "Upside":
            if split_qr and "Quantity" in text and "Rarity" in text:
                dropped_qr.add(r["id"])  # the page's own history says this modifier was split in two
            elif [altar, text] not in player_up:
                player_up.append([altar, text])
        else:
            row = [altar, TARGET[target], text]
            if (target == "Player" or DANGER.search(text)) and row not in downs:
                downs.append(row)
    if dropped_qr:
        warn("eldritch: dropped %s: the Eldritch altar page says this Quantity+Rarity modifier was split in two in "
             "3.26, but Cargo still gives it a spawn weight (stale data)" % ", ".join(sorted(dropped_qr)))
    cols = [short[t] for t in altars]

    def grid(pred):
        out = []
        for e in sorted(rewards.values(), key=lambda e: (e["name"] or "")):
            if e["name"] and pred(e["name"]):
                out.append([e["name"]] + [", ".join(sorted(e["cells"].get(c, []), reverse=True)) or "-" for c in cols])
        return out
    scarabs = grid(lambda n: "Scarab" in n)
    cards = grid(lambda n: "Divination" in n)
    other = grid(lambda n: "Scarab" not in n and "Divination" not in n)
    need(len(scarabs) + len(cards) + len(other) >= 30, "only %d boss/minion upsides" % len(rewards))
    need(any("Divine Orb" in r[0] for r in other) and scarabs, "required rewards missing")
    need(len(downs) >= 15, "only %d dangerous downsides" % len(downs))
    downs.sort(key=lambda r: (r[1] != "Player", r[0], r[1]))
    head = ["Reward"] + ["%s altar" % c for c in cols]
    return {"sections": [
        table_section("Upsides: currency and items (Boss = map boss drops 2-4 more, Minions = chance per kill)", head, other),
        table_section("Upsides: scarabs", head, scarabs),
        table_section("Upsides: divination cards", head, cards),
        table_section("Upsides for the whole map (Player)", ["Altar", "Upside"], sorted(player_up)),
        table_section("Dangerous downsides (all Player ones, plus Boss/Minion ones that add damage or speed)",
                      ["Altar", "Target", "Downside"], downs)],
        "source": "PoE Wiki: Cargo mods (domain 29) + mod_spawn_weights, Eldritch altar", "url": WIKI_PAGE + "Eldritch_altar"}


def m_blight(cx):
    oils = cargo("items", "items.name=name,items.drop_level=lvl,items.metadata_id=mid",
                 where="items.class_id='StackableCurrency' AND items.name LIKE '% Oil' AND items.drop_enabled=1")
    oils = [o for o in oils if o["name"].endswith(" Oil") and o["name"] not in ("Tainted Oil", "Reflective Oil")]
    oils.sort(key=lambda o: (int(o["lvl"] or 0), o["mid"] or ""))
    names = [clean(o["name"]) for o in oils]
    need(len(names) >= 12 and names[0] == "Clear Oil", "oil order looks wrong: %r" % names[:3])
    tier_rows = [[str(i + 1), n, o["lvl"] or ""] for i, (n, o) in enumerate(zip(names, oils))]
    anoint = cargo("blight_crafting_recipes,blight_crafting_recipes_items,items,mods",
                   "blight_crafting_recipes.id=id,items.name=oil,mods.stat_text_raw=effect",
                   where="blight_crafting_recipes.type='InfectedMap'",
                   join_on="blight_crafting_recipes.id=blight_crafting_recipes_items.recipe_id,"
                           "blight_crafting_recipes_items.item_id=items.metadata_id,"
                           "blight_crafting_recipes.modifier_id=mods.id")
    amap = [[clean(a["oil"]), clean(a["effect"])] for a in anoint if a.get("oil")]
    amap.sort(key=lambda r: names.index(r[0]) if r[0] in names else 99)
    need(len(amap) == 13 and all(r[0] in names for r in amap), "expected 13 blighted-map anoints, got %d" % len(amap))
    ring = cargo("blight_crafting_recipes", "COUNT(*)=n", where="blight_crafting_recipes.type='Ring'")
    nring = int(ring[0]["n"]) if ring and str(ring[0].get("n", "")).isdigit() else 0
    sections = [table_section("Oil tiers (low to high)", ["Tier", "Oil", "Drop level"], tier_rows),
                table_section("Blighted map anoints (one oil each)", ["Oil", "Map effect"], amap)]
    if nring:
        sections.append(list_section("Ring anoints", ["%d ring anoint recipes exist (Cargo blight_crafting_recipes, "
                                                      "type Ring); look them up in the anoint window" % nring]))
    return {"sections": sections, "source": "PoE Wiki: Cargo items, blight_crafting_recipes(_items)",
            "url": WIKI_PAGE + "Oil"}


def _biome(drop_text):
    t = clean(drop_text, limit=0)
    m = re.match(r"Found in (.+?) biomes? in the Azurite Mine", t)
    if m:
        return ", ".join(x.strip() for x in re.split(r",| and ", m.group(1)) if x.strip())
    m = re.match(r"Drops from completing an? (.+?) node in (.+?) biomes? in the Azurite Mine", t)
    if m:
        return "%s (%s node)" % (m.group(2), m.group(1))
    return t


def m_delve(cx):
    rows = cargo("fossils,items", "items.name=name,items.description=effect,items.drop_text=drop,items.drop_enabled=de",
                 join_on="fossils.base_item_id=items.metadata_id")
    out = sorted([[clean(r["name"]), clean(r["effect"]), clean(_biome(r["drop"]))]
                  for r in rows if r.get("name") and r.get("de") == "1"])
    need(len(out) >= 20 and any(r[0] == "Pristine Fossil" for r in out), "only %d fossils" % len(out))
    return {"sections": [table_section("Fossils: effect and where they drop", ["Fossil", "Effect", "Biome"], out)],
            "source": "PoE Wiki: Cargo fossils + items", "url": WIKI_PAGE + "Fossil"}


def m_bestiary(cx):
    rows = cargo("bestiary_recipes,bestiary_recipe_components,bestiary_components",
                 "bestiary_recipes.id=id,bestiary_recipes.header=header,bestiary_recipes.subheader=sub,"
                 "bestiary_recipes.notes=notes,bestiary_recipe_components.amount=amount,bestiary_components.monster=monster,"
                 "bestiary_components.family=family,bestiary_components.genus=genus,bestiary_components.beast_group=grp,"
                 "bestiary_components.rarity=rarity,bestiary_components.min_level=minlvl",
                 where="bestiary_recipes.game_mode IN (0,1)",  # 0 = all modes, 1 = core game, 2 = Ruthless
                 join_on="bestiary_recipes.id=bestiary_recipe_components.recipe_id,"
                         "bestiary_recipe_components.component_id=bestiary_components.id")
    rec = {}
    for r in rows:
        e = rec.setdefault(r["id"], {"header": clean(r["header"]), "sub": clean(r["sub"]), "notes": clean(r["notes"]),
                                     "beasts": []})
        what = clean(r["monster"]) or " ".join(x for x in (clean(r["grp"]), clean(r["genus"]), clean(r["family"])) if x)
        if not what:
            continue
        extra = ", ".join(x for x in (clean(r["rarity"]), ("level %s+" % r["minlvl"]) if r.get("minlvl") not in
                                      (None, "", "0") else "") if x)
        amount = int(r["amount"]) if str(r.get("amount") or "").isdigit() else 1
        e["beasts"].append(("%dx " % amount if amount > 1 else "") + what + (" (%s)" % extra if extra else ""))
    out = []
    for e in sorted(rec.values(), key=lambda e: (e["header"], e["sub"])):
        text = " ".join([e["header"], e["sub"], e["notes"]] + e["beasts"])
        if re.search(r"Bestiary Orb", text, re.I):
            warn("bestiary: dropped recipe %r: uses Bestiary Orbs, removed in 3.27 (stale wiki)" % e["sub"])
            continue
        recipe = e["sub"] + (" (%s)" % e["notes"] if e["notes"] else "")
        out.append([e["header"], clean(recipe), clean(" + ".join(e["beasts"]) or "?")])
    need(len(out) >= 60 and any(r[0] == "Create a Unique" for r in out), "only %d recipes" % len(out))
    return {"sections": [table_section("Recipes (core game)", ["Type", "Recipe", "Beasts"], out)],
            "source": "PoE Wiki: Cargo bestiary_recipes + components", "url": WIKI_PAGE + "Bestiary"}


def incursion_rooms(cx):
    if "rooms" not in cx:
        cx["rooms"] = cargo("incursion_rooms", "incursion_rooms.id=id,incursion_rooms.name=name,incursion_rooms.tier=tier,"
                                               "incursion_rooms.upgrade_room_id=up,incursion_rooms.architect_name=arch,"
                                               "incursion_rooms.description=descr,incursion_rooms.stat_text=stats")
    return cx["rooms"]


def m_incursion(cx):
    rooms = incursion_rooms(cx)
    archs = set(clean(a) for a in re.findall(r"^===\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*===\s*$",
                                             section(cx["pages"]["Incursion room"], "Architects"), re.M))
    need(len(archs) >= 20, "architect list not found on 'Incursion room'")
    byid = {r["id"]: r for r in rooms}
    legacy = [r["id"] for r in rooms if r.get("tier") in ("1", "2", "3") and clean(r["arch"]) not in archs]
    if legacy:
        warn("incursion: dropped %d rooms whose architect is not on the current 'Incursion room' page: %s"
             % (len(legacy), ", ".join(legacy)))
    chains, tier3 = [], []
    for r in rooms:
        if r.get("tier") != "1" or clean(r["arch"]) not in archs:
            continue
        chain, cur = [r], r
        while cur.get("up") and cur["up"] in byid and len(chain) < 3:
            cur = byid[cur["up"]]
            chain.append(cur)
        if [c.get("tier") for c in chain] != ["1", "2", "3"] or len(set(clean(c["arch"]) for c in chain)) != 1:
            warn("incursion: dropped incomplete upgrade chain starting at %s" % r["id"])
            continue
        chains.append([clean(r["arch"])] + [clean(c["name"]) for c in chain])
        t3 = chain[2]
        tier3.append([clean(t3["name"]), clean(t3["arch"]).split(",")[0], clean(t3["descr"] or t3["stats"] or "")])
    chains.sort()
    tier3.sort()
    names3 = [r[0] for r in tier3]
    need(len(chains) >= 20 and "Locus of Corruption" in names3 and "Doryani's Institute" in names3,
         "only %d upgrade chains" % len(chains))
    return {"sections": [table_section("Room upgrade chains (kill the other architect to upgrade)",
                                       ["Architect", "Tier 1", "Tier 2", "Tier 3"], chains),
                         table_section("Tier 3 rooms", ["Room", "Architect", "Effect"], tier3)],
            "source": "PoE Wiki: Cargo incursion_rooms, Incursion room", "url": WIKI_PAGE + "Incursion_room"}


HARVEST_COST = (("primal", "Primal"), ("vivid", "Vivid"), ("wild", "Wild"), ("sacred", "Sacred"), ("rancour", "Rancour"))
HARVEST_REMOVED = re.compile(r"Enchant a Flask|Flask.{0,40}Enchant|Synthesi[sz]|White", re.I)


def m_harvest(cx):
    rows = cargo("harvest_crafting_options",
                 "harvest_crafting_options.id=id,harvest_crafting_options.effect=effect,harvest_crafting_options.ordinal=ord,"
                 + ",".join("harvest_crafting_options.cost_%s=%s" % (k, k) for k, _ in HARVEST_COST),
                 where="harvest_crafting_options.game_mode IN (0,1)",  # 0 = all modes, 1 = core game, 2 = Ruthless
                 order_by="harvest_crafting_options.ordinal")
    groups = [("Reforge", []), ("Augment (add a mod, remove a random one)", []), ("Change resistance / damage type", []),
              ("Swap stacks and items", []), ("Enchant (quality grants a bonus instead)", []), ("Other", [])]
    for r in rows:
        effect = clean(r["effect"])
        if HARVEST_REMOVED.search(effect):
            warn("harvest: dropped %r: flask enchants (3.28), Synthesise and white sockets (3.29) were removed "
                 "(stale wiki)" % r["id"])
            continue
        cost = " + ".join("%s %s" % (r[k], label) for k, label in HARVEST_COST if (r.get(k) or "0") not in ("0", ""))
        i = r["id"] or ""
        g = (0 if i.startswith("Reforge") or i.startswith("BossInfluence") else 1 if i.startswith("Augment") else
             2 if i.startswith("Change") else 3 if i.startswith("Reroll") else 4 if i.endswith("Enchant") else 5)
        groups[g][1].append([effect, cost or "-"])
    n = sum(len(g[1]) for g in groups)
    need(n >= 40 and groups[0][1] and groups[1][1], "only %d crafts" % n)
    return {"sections": [table_section(t, ["Craft", "Lifeforce cost"], rs) for t, rs in groups if rs],
            "source": "PoE Wiki: Cargo harvest_crafting_options (core game)", "url": WIKI_PAGE + "Harvest_crafting"}


VENDORS = ["Gwennen", "Tujen", "Rog", "Dannig"]


def m_expedition(cx):
    P = cx["pages"]
    t = parse_table(wikitables(section(P["Expedition"], "Expedition factions"))[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr[:2] == ["Vendor", "Faction"] and "Vendor refresh" in hdr and "Expedition boss" in hdr,
         "unexpected faction table %r" % hdr)
    ir, ib = hdr.index("Vendor refresh"), hdr.index("Expedition boss")
    table = [[clean(r[0]), clean(r[1]), clean(r[ir]), clean(r[ib])] for r in t["rows"] if len(r) >= len(hdr)]
    need([r[0] for r in table] == VENDORS, "vendors %r" % [r[0] for r in table])
    trading = {}
    for b in bullets(section(P["Expedition"], "Trading")):
        b = clean(b)
        if b.split(" ")[0] in VENDORS:
            trading[b.split(" ")[0]] = b
    sections = [table_section("Vendors", ["Vendor", "Faction", "Refresh currency", "Expedition boss"], table)]
    for v in VENDORS:
        lines = [trading[v]] if v in trading else []
        if v == "Tujen":
            items = []
            for b in bullets(section(P["Tujen"], "Vendor")):
                b = clean(b)
                if re.search(r"cluster|abyss(?:al)? jewel|catalyst", b, re.I):
                    warn("expedition: dropped Tujen stock line %r: no longer sold since 3.28/3.29 (stale wiki)" % b)
                    continue
                items.append(b)
            need(len(items) >= 4, "Tujen stock list not found")
            lines += ["Sells: " + i for i in items]
        else:
            ex = section(P[v], "Expedition")
            para = next((p for p in ex.split("\n\n") if "As a vendor" in p), "")
            lines += sentences(para[para.index("As a vendor"):]) if para else []
        lines = [clean(x) for x in lines if clean(x)]
        need(lines, "%s: nothing found" % v)
        sections.append(list_section(v, lines))
    return {"sections": sections, "source": "PoE Wiki: Expedition, Gwennen, Tujen, Rog, Dannig",
            "url": WIKI_PAGE + "Expedition"}


def m_corruption(cx):
    mech = section(cx["pages"]["Vaal Orb"], "Mechanics")
    sections = []
    for m in re.finditer(r"^===\s*([^=]+?)\s*===\s*$", mech, re.M):
        title = m.group(1)
        if title.lower() == "vendor recipe":  # how to obtain Vaal Orbs, not what they do
            continue
        body = section(mech, title)
        body = re.split(r"^====", body, flags=re.M)[0]
        lines = [clean(b) for b in bullets(body, fold=False)]
        if not lines:
            first = next((p for p in body.split("\n\n") if p.strip() and not p.strip().startswith(("[[File", "{{"))), "")
            lines = sentences(first)[:2]
        lines = [clean(x) for x in lines if x]
        if lines:
            sections.append(list_section("Vaal Orb on " + title.lower(), lines))
    titles = [s["title"] for s in sections]
    need(len(sections) >= 5 and "Vaal Orb on equipment" in titles and "Vaal Orb on gems" in titles,
         "Vaal Orb outcome sections not found: %r" % titles)
    need(len(sections[titles.index("Vaal Orb on equipment")]["lines"]) >= 3, "equipment outcomes missing")
    temple = [[clean(r["name"]), r["tier"], clean(r["descr"])] for r in incursion_rooms(cx)
              if r.get("tier") in ("1", "2", "3") and re.search(r"corrupt", r.get("descr") or "", re.I)]
    if temple:
        sections.append(table_section("Temple of Atzoatl rooms that corrupt", ["Room", "Tier", "Effect"],
                                      sorted(temple, key=lambda r: (r[0][0], r[1]))))
    return {"sections": sections, "source": "PoE Wiki: Vaal Orb (Mechanics), Cargo incursion_rooms",
            "url": WIKI_PAGE + "Vaal_Orb"}


def m_sanctum(cx):
    t = parse_table(wikitables(section(cx["pages"]["The Forbidden Sanctum"], "Affliction"))[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr == ["Affliction Type", "Icon", "Affliction Name", "Description"], "unexpected table %r" % hdr)
    found = {"Major": {}, "Minor": {}}
    for r in t["rows"]:
        if len(r) < 4:
            continue
        kind = "Major" if clean(r[0]).startswith("Major") else "Minor" if clean(r[0]).startswith("Minor") else None
        name, desc = clean(r[2]), clean(r[3], limit=0)
        if kind and name:
            d = found[kind].setdefault(name, [])
            if desc not in d:
                d.append(desc)
    out = {k: [[n, clean(" / ".join(ds))] for n, ds in sorted(v.items())] for k, v in found.items()}
    need(len(out["Major"]) >= 8 and len(out["Minor"]) >= 15, "afflictions: %d major, %d minor"
         % (len(out["Major"]), len(out["Minor"])))
    return {"sections": [table_section("Major afflictions (run-threatening)", ["Affliction", "Effect"], out["Major"]),
                         table_section("Minor afflictions", ["Affliction", "Effect"], out["Minor"])],
            "source": "PoE Wiki: The Forbidden Sanctum (Affliction table)", "url": WIKI_PAGE + "The_Forbidden_Sanctum"}


VENDOR_SECTIONS = ["Sockets", "Quality Items", "Full Rare Sets", "Influenced full rare item sets", "X of a Kind",
                   "Straight Flush", "Downgrade", "Crafting Material", "Atlas of Worlds utility", "Create new item"]


def m_vendor(cx):
    w = cx["pages"]["Vendor recipe system"]
    sections, text = [], ""
    for title in VENDOR_SECTIONS:
        tabs = wikitables(section(w, title))
        if not tabs:
            warn("vendor: no table under %r" % title)
            continue
        t = parse_table(tabs[0])
        hdr = [clean(c) for c in t["header"]][:2]
        rows = []
        for r in t["rows"]:
            cells = [clean(c) for c in r[:2]]
            if len(cells) < 2 or not cells[0]:
                continue
            if "Cartographer's Chisel" in " ".join(cells):
                warn("vendor: dropped %r: Chisel recipes were removed in 3.28 (stale wiki)" % cells)
                continue
            rows.append(cells)
        if rows and len(hdr) == 2:
            sections.append(table_section(title, hdr, rows))
            text += " ".join(" ".join(r) for r in rows) + "\n"
    infl = next((s for s in sections if s["title"] == "Influenced full rare item sets"), None)
    need(infl and any(r[0].startswith("1x Exalted Orb") for r in infl["rows"]),
         "influenced full set does not give 1 Exalted Orb (stale wiki?)")
    need(len(sections) >= 7 and "Chromatic Orb" in text and "Chaos Orb" in text and "Regal Orb" in text,
         "only %d recipe tables" % len(sections))
    return {"sections": sections, "source": "PoE Wiki: Vendor recipe system", "url": WIKI_PAGE + "Vendor_recipe_system"}


def m_kingsmarch(cx):
    t = parse_table(wikitables(section(cx["pages"]["Kingsmarch"], "Table of rewards"))[0])
    hdr = [re.sub(r"^Reward \((.+)\)$", r"\1", clean(c)) for c in t["header"]]
    need(len(hdr) == 8 and hdr[:2] == ["Resource", "Shipment Value"], "unexpected table %r" % hdr)
    rows = []
    for r in t["rows"]:
        cells = [clean(c, limit=0) for c in r]
        if len(cells) != 8:
            continue
        cells = [c.split("; ")[0] if c.count("; ") >= 3 else c for c in cells]  # long runegraft lists -> category
        rows.append([clean(c.replace("; ", " / ") if i < 2 else c) for i, c in enumerate(cells)])
    need(len(rows) >= 8 and any(r[0] == "Wheat" for r in rows), "only %d resource rows" % len(rows))
    return {"sections": [table_section("Shipping: what each resource returns, by port", hdr, rows)],
            "source": "PoE Wiki: Kingsmarch (Shipping, table of rewards)", "url": WIKI_PAGE + "Kingsmarch"}


def m_pantheon(cx):
    rows = cargo("pantheon_souls,pantheon,areas",
                 "pantheon_souls.id=god,pantheon.is_major_god=major,pantheon_souls.name=soul,pantheon_souls.ordinal=ord,"
                 "pantheon_souls.item_id=item,pantheon_souls.stat_text=stats,areas.name=area,areas.id=areaid",
                 join_on="pantheon_souls.id=pantheon.id,pantheon_souls.target_area_id=areas.id",
                 order_by="pantheon_souls.id,pantheon_souls.ordinal")
    gods = {}
    for r in rows:
        if r.get("item"):  # the upgrade soul's item names its god: PantheonSoul<God>Upgrade<n>
            m = re.search(r"PantheonSoul(\w+?)Upgrade\d+$", r["item"])
            if not m or m.group(1).lower() != re.sub(r"^The", "", r["god"] or "").lower():
                warn("pantheon: dropped %r: its item %r does not belong to %r" % (r["soul"], r["item"], r["god"]))
                continue
        gods.setdefault(r["god"], {"major": r.get("major") == "1", "souls": []})["souls"].append(r)
    out = {True: [], False: []}
    areas = []
    for gid, g in gods.items():
        base = next((s for s in g["souls"] if s["ord"] == "1"), None)
        if not base:
            continue
        name = re.sub(r"^Soul of (the )?", lambda m: "The " if m.group(1) else "", clean(base["soul"]))
        for s in sorted(g["souls"], key=lambda s: int(s["ord"] or 0)):
            where = clean(s["area"]) if s.get("area") else "-"
            out[g["major"]].append([name, clean(s["soul"]), clean(s["stats"]), where])
            if s.get("areaid"):
                areas.append((s["areaid"], html.unescape(s["area"] or "")))
    nmajor = len([1 for g in gods.values() if g["major"]])
    need(nmajor >= 4 and len(gods) - nmajor >= 8, "gods: %d major, %d minor" % (nmajor, len(gods) - nmajor))
    need(all(len(g["souls"]) >= 4 for g in gods.values() if g["major"]), "a major god lacks its upgrade souls")
    cx["pantheon_areas"] = areas
    cols = ["God", "Soul (boss)", "Effect", "Map with the boss"]
    return {"sections": [table_section("Major gods", cols, out[True]), table_section("Minor gods", cols, out[False])],
            "source": "PoE Wiki: Cargo pantheon, pantheon_souls, areas", "url": WIKI_PAGE + "Pantheon"}


def m_essences(cx):
    rows = cargo("essences,items", "items.name=name,essences.level=lvl,essences.type=grp,essences.category=cat,"
                                   "essences.level_restriction=maxlvl,items.drop_enabled=de",
                 join_on="essences._pageID=items._pageID", order_by="essences.type,essences.level")
    rows = [r for r in rows if r.get("de") == "1" and r.get("lvl") and r.get("name")]
    cats, tiers = {}, {}
    for r in rows:
        name, lvl = clean(r["name"]), int(r["lvl"])
        cat = re.sub(r"^.*?(Essence of .+)$", r"\1", name)
        c = cats.setdefault(cat, {"grp": r["grp"], "lv": []})
        c["lv"].append((lvl, name))
        prefix = name.split(" Essence of ")[0] if " Essence of " in name else ""
        if prefix:
            tiers[lvl] = (prefix, r.get("maxlvl") or "")
    by_cat = []
    for cat, c in sorted(cats.items(), key=lambda kv: (int(kv[1]["grp"] or 0), kv[0])):
        lo, hi = min(c["lv"]), max(c["lv"])
        span = "only %s" % lo[1] if lo == hi else "%s ... %s" % (lo[1].split(" Essence")[0], hi[1].split(" Essence")[0])
        by_cat.append([c["grp"] or "", cat, clean(span)])
    tier_rows = [[str(lvl), p, ("item level %s or lower" % m) if m else "no limit"] for lvl, (p, m) in sorted(tiers.items())]
    need(len(by_cat) >= 20 and any(r[1] == "Essence of Hatred" for r in by_cat) and len(tier_rows) >= 7,
         "only %d essence types" % len(by_cat))
    return {"sections": [table_section("Tiers", ["Level", "Prefix", "Max item level for the result"], tier_rows),
                         table_section("Essences by group (tiers available)", ["Group", "Essence", "Tiers"], by_cat)],
            "source": "PoE Wiki: Cargo essences + items", "url": WIKI_PAGE + "Essence"}


def m_ultimatum(cx):
    t = parse_table(wikitables(section(cx["pages"]["Ultimatum"], "Modifiers"))[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr == ["Modifier", "Image", "Tier", "Effect"], "unexpected table %r" % hdr)
    mods = {}
    for r in t["rows"]:
        if len(r) < 4 or not clean(r[0]):
            continue
        e = mods.setdefault(clean(r[0]), [])
        e.append((clean(r[2]), clean(r[3])))
    out = []
    for name, tiers in sorted(mods.items()):
        ts = [x for x, _ in tiers if x]
        out.append([name, "%s-%s" % (ts[0], ts[-1]) if len(ts) > 1 else (ts[0] if ts else "-"), tiers[-1][1]])
    need(len(out) >= 20, "only %d modifiers" % len(out))
    return {"sections": [table_section("Modifiers (effect at the highest tier)", ["Modifier", "Tiers", "Effect"], out)],
            "source": "PoE Wiki: Ultimatum (Modifiers table)", "url": WIKI_PAGE + "Ultimatum"}


# id, title, group, builder, area-id prefixes / exact ids for "match" (None: none), exact area names to look up
MECHANICS = [
    ("syndicate", "Betrayal (Syndicate)", "League mechanics", m_syndicate, ["BetrayalSafeHouse", "BetrayalMastermindFight"], []),
    ("eldritch", "Eldritch altars", "Endgame", m_eldritch, None, []),
    ("blight", "Blight (oils and anoints)", "League mechanics", m_blight, None, []),
    ("corruption", "Corruption (Vaal Orb)", "Crafting", m_corruption, None, []),
    ("delve", "Delve (fossils)", "League mechanics", m_delve, ["Delve"], []),
    ("bestiary", "Bestiary recipes", "Crafting", m_bestiary, ["Menagerie_"], []),
    ("incursion", "Incursion (Temple of Atzoatl)", "League mechanics", m_incursion, ["Incursion_"], []),
    ("harvest", "Harvest crafting", "Crafting", m_harvest, ["HarvestLeague"], []),
    ("expedition", "Expedition vendors", "League mechanics", m_expedition, ["Expedition"], []),
    ("sanctum", "Sanctum afflictions", "League mechanics", m_sanctum, ["Sanctum"], []),
    ("vendor", "Vendor recipes", "Crafting", m_vendor, None, []),
    ("kingsmarch", "Kingsmarch shipping", "League mechanics", m_kingsmarch, [], ["Kingsmarch"]),
    ("pantheon", "Pantheon", "Endgame", m_pantheon, [], []),
    ("essences", "Essences", "Crafting", m_essences, None, []),
    ("ultimatum", "Ultimatum modifiers", "League mechanics", m_ultimatum,
     ["UltimatumArena", "UltimatumBossArena", "MapWorldsUltimatumBossArena"], []),
]
PAGES = ["Immortal Syndicate", "Eldritch altar", "Incursion room", "Expedition", "Gwennen", "Tujen", "Rog", "Dannig",
         "Vaal Orb", "The Forbidden Sanctum", "Vendor recipe system", "Kingsmarch", "Ultimatum"]


def build_matches(cx, built):
    """match.areaIds / areaNames from the Cargo areas table. A name is kept only if every area with that
    name belongs to the mechanic (legacy Atlas map versions aside), so "Cemetery" from an Expedition
    logbook area does not fire in the Cemetery map."""
    spec = {mid: (pre, names, False) for mid, _, _, _, pre, names in MECHANICS
            if mid in built and pre is not None and mid != "pantheon"}
    exact = sorted(set(a for a, _ in cx.get("pantheon_areas", [])))
    if "pantheon" in built:
        spec["pantheon"] = (exact, [], True)  # the soul bosses' own maps, not every id they prefix
    prefixes = sorted(set(p for pre, _, ex in spec.values() if not ex for p in pre))
    names = sorted(set(n for _, ns, _ in spec.values() for n in ns))
    conds = ["areas.id LIKE '%s%%'" % p for p in prefixes] + ["areas.name='%s'" % n for n in names]
    if exact:
        conds.append("areas.id IN (%s)" % ",".join("'%s'" % a for a in exact))
    found = cargo("areas", "areas.id=id,areas.name=name", where=" OR ".join(conds)) if conds else []
    cand = {}
    for mid, (pre, ns, ex) in spec.items():
        hits = [a for a in found if (a["id"] in pre if ex else any((a["id"] or "").startswith(p) for p in pre))
                or html.unescape(a["name"] or "") in ns]
        hits = [a for a in hits if "[DNT]" not in (a["name"] or "")]
        ids = [p for p in pre if any((a["id"] or "").startswith(p) for a in hits)]
        ids += sorted(set(a["id"] for a in hits if html.unescape(a["name"] or "") in ns))
        cand[mid] = (ids, sorted(set(html.unescape(a["name"]) for a in hits if a.get("name"))))
    alln = sorted(set(n for _, ns in cand.values() for n in ns))
    owners = {}
    for i in range(0, len(alln), 40):
        chunk = alln[i:i + 40]
        where = "areas.name IN (%s)" % ",".join("'%s'" % n.replace("'", "''") for n in chunk)
        for a in cargo("areas", "areas.id=id,areas.name=name,areas.is_legacy_map_area=legacy", where=where):
            if a.get("legacy") != "1":  # old Atlas versions of the same map do not make a name ambiguous
                owners.setdefault(html.unescape(a["name"] or ""), set()).add(a["id"])
    for mid, (ids, ns) in cand.items():
        keep = [n for n in ns if all(any(o.startswith(p) for p in ids) for o in owners.get(n, ()))]
        dropped = sorted(set(ns) - set(keep))
        if dropped:
            print("  %s: area names shared with other areas, not used as triggers: %s" % (mid, ", ".join(dropped)))
        built[mid]["match"] = {"areaIds": ids, "areaNames": keep}


def check_sheet(m):
    """Schema and cell checks; drops empty sections and raises Skip if nothing usable is left."""
    secs = []
    for s in m["sections"]:
        if "columns" in s:
            rows = [r for r in s["rows"] if len(r) == len(s["columns"]) and all(isinstance(c, str) for c in r)]
            if len(rows) != len(s["rows"]):
                warn("%s/%s: dropped %d malformed rows" % (m["id"], s["title"], len(s["rows"]) - len(rows)))
            s = dict(s, rows=rows)
            if rows:
                secs.append(s)
        elif s.get("lines"):
            secs.append(s)
    for s in secs:
        for c in [x for r in s.get("rows", []) for x in r] + s.get("lines", []) + s.get("columns", []):
            need(len(c) <= CELL_MAX and not re.search(r"\[\[|\{\{|<|&#", c), "bad cell %r" % c)
    need(secs, "no sections")
    m["sections"] = secs


def mechanics():
    cx = {"pages": pages(PAGES)}
    built = {}
    for mid, title, group, fn, _, _ in MECHANICS:
        try:
            r = fn(cx)
            m = {"id": mid, "title": title, "group": group, "source": r["source"], "url": r["url"], "patch": PATCH,
                 "match": {"areaIds": [], "areaNames": []}, "sections": r["sections"]}
            check_sheet(m)
            built[mid] = m
            print("  built %-11s %s" % (mid, ", ".join("%s: %d" % (s["title"][:28], len(s.get("rows") or s.get("lines")))
                                                      for s in m["sections"])))
        except Skip as e:
            warn("%s skipped: %s" % (mid, e))
        except Exception as e:  # a changed page layout must not take the other sheets down
            warn("%s skipped: %s: %s" % (mid, type(e).__name__, e))
    try:
        build_matches(cx, built)
    except Exception as e:
        warn("match triggers not built: %s: %s" % (type(e).__name__, e))
    return [built[mid] for mid, *_ in MECHANICS if mid in built]


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
    n_points = sum(1 for a in acts.values() for q in a["points"] if q["kind"] == "skill")
    n_trials = sum(len(a["trials"]) for a in acts.values())
    if n_points < 15 or n_trials < 9 or len(band) < 4:
        print("wiki data looks incomplete (points %d, trials %d, bandit rewards %d); not writing"
              % (n_points, n_trials, len(band)))
        return 1
    print("Building mechanic sheets:")
    mech = mechanics()
    if len(mech) < MIN_MECHANICS:
        print("only %d mechanic sheets built (need %d); not writing" % (len(mech), MIN_MECHANICS))
        return 1
    data = {"source": SOURCE, "fetchedAt": time.strftime("%Y-%m-%d"), "version": int(time.strftime("%Y%m%d%H%M")),
            "acts": acts, "labs": labs, "mechanics": mech}
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "cheatsheets.js"), "w", encoding="utf-8") as f:
        f.write("// generated by tools/make_cheatsheets.py from the Path of Exile Wiki (CC BY-NC-SA 3.0)\n")
        f.write("window.POE_CHEATSHEETS = " + payload + ";\n")
    with open(os.path.join(ROOT, "server", "public", "cheatsheets.json"), "w", encoding="utf-8") as f:
        f.write(payload)
    print("Wrote data/cheatsheets.js and server/public/cheatsheets.json (version %d): %d skill-point quests, "
          "%d respec quests, %d trials, labs %s, penalties -%d/-%d, %d mechanic sheets"
          % (data["version"], n_points, sum(1 for a in acts.values() for q in a["points"] if q["kind"] == "respec"),
             n_trials, labs, p5, p10, len(mech)))
    if WARNINGS:
        print("%d warnings:" % len(WARNINGS))
        for w in WARNINGS:
            print("  - " + w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
