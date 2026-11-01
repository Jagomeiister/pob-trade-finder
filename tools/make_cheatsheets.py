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
- full act route, acts[N].route                        (Cargo table areas: id = the Client.txt area id,
  area_level, has_waypoint, is_town_area, connection_ids, boss_monster_ids + Cargo monsters; quest
  infoboxes / walkthroughs of the pages listed on page "Quest")
  Order: the shortest connection path from the zone entered from the previous act to the zone that
  leads into the next act is the main route; at each main-route zone its side branches come first
  (depth first, lower area level first). A side area is kept only if it (or a zone behind it) holds a
  quest objective, quest boss, trial or skill-point quest. The wiki's act "Progression" tables are 2D
  layouts (Act 8 is a mesh), so they cannot give an order.
- quest gem rewards per act, acts[N].gems               (Cargo quest_rewards / vendor_rewards joined to
  items, skill and support gems only; the reward NPC from the quest infobox "completion" line)

Mechanics ("mechanics"): one sheet per league mechanic / crafting system, from Cargo tables (exported
from the game data) where they exist and from page tables otherwise. Each sheet has a sanity guard
(minimum rows, required names) and stale-wiki checks against known 3.26-3.29 changes; a sheet that
fails is skipped with a warning and the rest still build. A new section added to an older sheet is
"soft": if its data is missing it is left out with a warning and the sheet keeps its other sections.

Run on a normal PC (the wiki refuses datacenter addresses):  python tools/make_cheatsheets.py
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI = "https://www.poewiki.net/w/api.php"
WIKI_PAGE = "https://www.poewiki.net/wiki/"
UA = "PoBTradeFinder data build (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)"
SOURCE = "Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0"
LABS = {1: "Normal", 2: "Normal", 3: "Normal", 6: "Cruel", 7: "Cruel", 8: "Merciless", 9: "Merciless", 10: "Merciless"}
PATCH = "3.29"  # the game version the mechanic sheets are checked against (see the stale-wiki checks)
MIN_MECHANICS = 15
CELL_MAX = 140

try:
    sys.stdout.reconfigure(errors="backslashreplace")  # wiki text holds non-ASCII names; cp1252 console
except Exception:
    pass


CALLS = [0]  # wiki API requests made (kept well under ~80 per run)


def api(params):
    q = dict(format="json", **params)
    req = urllib.request.Request(WIKI + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
    for attempt in range(4):
        CALLS[0] += 1
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:  # 429: the wiki asks us to slow down; wait and retry
            if e.code != 429 or attempt == 3:
                raise
            wait = e.headers.get("Retry-After") or ""
            wait = int(wait) if wait.isdigit() else 20 * (attempt + 1)
            print("  wiki rate limit (429); waiting %d s" % min(wait, 120))
            time.sleep(min(wait, 120))
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


def pages(titles, chunk=12):
    """Wikitext of several pages, `chunk` per request (redirects followed), keyed by the requested title."""
    alias, got, missing = {}, {}, set()
    for i in range(0, len(titles), chunk):
        d = api({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main", "redirects": "1",
                 "formatversion": "2", "titles": "|".join(titles[i:i + chunk])})
        q = d["query"]
        alias.update({r["from"]: r["to"] for r in q.get("normalized", []) + q.get("redirects", [])})
        got.update({p["title"]: p["revisions"][0]["slots"]["main"]["content"] for p in q["pages"] if p.get("revisions")})
        missing.update(p["title"] for p in q["pages"] if p.get("missing"))
    out = {}
    for t in titles:
        k = t
        for _ in range(4):
            k = alias.get(k, k)
        if k in got:
            out[t] = got[k]
        elif k in missing:
            print("  page %r does not exist on the wiki" % t)
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
# Leveling: full act route (Cargo areas + quest pages) and quest gem rewards (Cargo quest/vendor rewards)
# ---------------------------------------------------------------------------------------------------

CLASSES = ["Marauder", "Duelist", "Ranger", "Shadow", "Witch", "Templar", "Scion"]
AREA_ACT = re.compile(r"^[12]_(\d+)_")  # campaign area ids: <part>_<act>_<zone>, e.g. 1_1_1, 2_6_town


def _act_of(aid):
    m = AREA_ACT.match(aid or "")
    return int(m.group(1)) if m else None


def _key(name):
    """A zone name or link target -> comparable key ("[[Fetid Pool]]" and "The Fetid Pool (Act 1)" match)."""
    s = html.unescape(name or "").strip().lower()
    s = re.sub(r"\s*\(act \d+\)$", "", s)
    return re.sub(r"^the ", "", s)


def _same(monster, boss):
    """A Cargo monster name is the quest's boss ("Shakari, Queen of the Sands" is "Shakari")."""
    m, b = _key(monster), _key(boss)
    return m == b or m.startswith(b + ",")


def quest_list(text):
    """{act: [quest page title]} from the "Quest" page's act sections (<section begin=actN />)."""
    out = {}
    for act in range(1, 11):
        m = re.search(r"<section begin=act%d\s*/>(.*?)<section end" % act, text, re.S)
        if m:
            out[act] = [q.strip() for q in re.findall(r"\{\{ql\|([^}|]+)(?:\|[^}]*)?\}\}", m.group(1))]
    return out


def quest_params(text):
    """Parameters of a quest page's {{Quest ...}} infobox (raw wikitext values)."""
    m = re.search(r"\{\{Quest\s*\n(.*?)\n\}\}", text or "", re.S)
    if not m:
        return {}
    out = {}
    for part in _split_top(m.group(1), ("|",)):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def campaign_areas():
    rows = cargo("areas", "areas.id=id,areas.name=name,areas.area_level=lvl,areas.has_waypoint=wp,"
                          "areas.is_town_area=town,areas.boss_monster_ids=boss,areas.connection_ids=conn,"
                          "areas.main_page=page,areas.removal_version=rem",
                 where="(areas.id LIKE '1%' OR areas.id LIKE '2%') AND areas.is_map_area=0 "
                       "AND areas.is_hideout_area=0 AND areas.is_labyrinth_area=0")
    return {r["id"]: r for r in rows if _act_of(r["id"]) and not r.get("rem")}


def monster_names(ids):
    """metadata id -> monster name (Cargo monsters), in chunks to keep the URL short."""
    ids, out = sorted(set(ids)), {}
    for i in range(0, len(ids), 60):
        where = "monsters.metadata_id IN (%s)" % ",".join("'%s'" % x.replace("'", "''") for x in ids[i:i + 60])
        for r in cargo("monsters", "monsters.metadata_id=mid,monsters.name=name", where=where):
            if r.get("name"):
                out[r["mid"]] = html.unescape(r["name"])
    return out


def _route_order(act, areas, adj):
    """Zones of `act` in progression order: the shortest connection path from the zone entered from the
    previous act to the zone that leads into the next one (the main route), and at each main-route zone
    the side branches first (depth first, lower area level first). Returns (order, main, parent)."""
    zones = {a for a in areas if _act_of(a) == act}
    lvl = lambda a: int(areas[a]["lvl"]) if str(areas[a].get("lvl") or "").isdigit() else 0
    entry = sorted([z for z in zones if any(_act_of(n) == act - 1 for n in adj.get(z, ()))], key=lambda z: (lvl(z), z))
    if act == 1:
        entry = sorted([z for z in zones if areas[z].get("town") != "1"], key=lambda z: (lvl(z), z))
    exits = sorted([z for z in zones if areas[z].get("town") != "1" and any(_act_of(n) == act + 1 for n in adj.get(z, ()))],
                   key=lambda z: (-lvl(z), z))
    need(entry and exits, "act %d: entry/exit zone not found in the connection graph" % act)
    start, goal = entry[0], exits[0]
    towns = {z for z in zones if areas[z].get("town") == "1"}
    for skip_town_exit in (True, False):  # a town <-> last-zone link is the way back, not the way there
        prev, queue = {start: None}, [start]
        while queue:  # breadth-first search inside the act
            cur = queue.pop(0)
            for n in sorted(adj.get(cur, ())):
                if skip_town_exit and {cur, n} & towns and goal in (cur, n):
                    continue
                if n in zones and n not in prev:
                    prev[n] = cur
                    queue.append(n)
        if goal in prev:
            break
    need(goal in prev, "act %d: no connection path from %s to %s" % (act, start, goal))
    main, cur = [], goal
    while cur:
        main.insert(0, cur)
        cur = prev[cur]
    mainset, order, parent, seen = set(main), [], {}, set()

    def walk(z):
        seen.add(z)
        order.append(z)
        for n in sorted((n for n in adj.get(z, ()) if n in zones and n not in seen and n not in mainset),
                        key=lambda n: (lvl(n), n)):
            if n not in seen:
                parent[n] = z
                walk(n)
    for z in main:
        walk(z)
    return order, main, parent, zones


def act_routes(cx, trials_by_act, points_by_act):
    """{act: [route entries]} (see the module doc); raises Skip/RuntimeError when the data looks wrong."""
    areas = campaign_areas()
    adj = {}
    for a, r in areas.items():
        for c in (r.get("conn") or "").split(","):
            c = c.strip()
            if c and c in areas:
                adj.setdefault(a, set()).add(c)
                adj.setdefault(c, set()).add(a)  # connections are listed one way only on some areas
    mon = monster_names([b.strip() for r in areas.values() if _act_of(r["id"]) <= 10
                         for b in (r.get("boss") or "").split(",") if b.strip()])
    qpages = cx["quest_pages"]
    routes, report = {}, {}
    for act in range(1, 11):
        order, main, parent, zones = _route_order(act, areas, adj)
        byname = {}
        for z in zones:
            for k in (_key(areas[z]["name"]), _key(areas[z].get("page"))):
                if k:
                    byname.setdefault(k, []).append(z)
        bosses = {z: [mon[b.strip()] for b in (areas[z].get("boss") or "").split(",") if b.strip() in mon] for z in zones}
        notes = {z: [] for z in zones}
        quest_zone, quest_used_boss, unplaced = {}, {}, []
        for q in cx["quests"].get(act, []):
            p = quest_params(qpages.get(q))
            if not p:
                continue
            name = clean(p.get("name") or q)
            want = [clean(re.sub(r"\s*\(monster\)$", "", p[k])) for k in ("boss", "boss1", "boss2", "boss3", "boss_link")
                    if p.get(k) and not p[k].strip().isdigit()]
            want += [clean(re.sub(r"\s*\(monster\)$", "", l)) for l in re.findall(r"\[\[([^\]|]+)", p.get("objective") or "")]
            want = list(dict.fromkeys(w for w in want if w))
            hit = []  # 1) the zone(s) of the act whose Cargo boss list holds the quest boss
            for b in want:
                for z in sorted(zones):
                    if any(_same(m, b) for m in bosses[z]) and z not in hit:
                        hit.append(z)
            want = [b for b in want if any(_same(m, b) for z in hit for m in bosses[z])]
            obj = clean(p.get("objective"), limit=0)
            named = sorted(set(z for k, zs in byname.items() for z in zs if areas[z].get("town") != "1"
                               and re.search(r"\b%s\b" % re.escape(k), _key(obj))))
            if len(named) <= 3:  # 2) plus the zones the objective names (linked or plain text)
                hit += [z for z in named if z not in hit]
            if not hit:  # 3) the first zone the quest page's walkthrough links to
                try:
                    walk = section(qpages.get(q) or "", "Walkthrough")
                except Skip:
                    walk = ""
                for l in re.findall(r"\[\[([^\]|]+)", walk):
                    zs = [z for z in byname.get(_key(l), []) if areas[z].get("town") != "1"]
                    if zs:
                        hit = zs[:1]
                        break
            if not hit:
                unplaced.append(q)
                continue
            quest_zone[q] = hit
            named = [b for b in want if b.split(",")[0].lower() in obj.lower()]
            for z in hit:
                zb = [b for b in want if any(_same(m, b) for m in bosses[z]) and b not in named]
                text = (obj or "Boss") + ("; boss " + ", ".join(dict.fromkeys(zb)) if zb else "")
                notes[z].append(clean("%s (%s)" % (text, name)))
                quest_used_boss.setdefault(z, set()).update(want + [b for b in bosses[z] if b in obj])
        for pq in points_by_act.get(act, []):
            zs = quest_zone.get(pq["quest"]) or next((v for k, v in quest_zone.items()
                                                       if clean(quest_params(qpages.get(k)).get("name") or k) == pq["quest"]), [])
            for z in zs[:1]:
                notes[z].append("%s reward: %s" % ("Book of Skill" if pq["kind"] == "skill" else "Book of Regrets", pq["quest"]))
        for t in trials_by_act.get(act, []):
            zs = byname.get(_key(t["area"]), [])
            if not zs:  # e.g. "The Prison": the one zone whose name ends with it ("The Lower Prison")
                zs = sorted(set(z for k, v in byname.items() if k.endswith(" " + _key(t["area"])) for z in v))
                zs = zs if len(zs) == 1 else []
            if zs:
                notes[zs[0]].append(clean("Trial of Ascendancy (%s Labyrinth): %s" % (t["lab"] or "?", t["trap"])))
            else:
                warn("route: act %d trial area %r not found among the act's zones" % (act, t["area"]))
        quest_zones = {z for z in zones if notes[z]}
        keep = set(main)
        for z in quest_zones:
            while z and z not in keep:
                keep.add(z)
                z = parent.get(z)
        for z in zones:  # other bosses of kept zones (not part of a quest note)
            if z in keep:
                extra = [b for b in dict.fromkeys(bosses[z])
                         if not any(_same(b, u) for u in quest_used_boss.get(z, set()))]
                if extra:
                    notes[z].append(clean("Boss: " + ", ".join(extra)))
        skipped = sorted(set(order) - keep, key=order.index)
        lost = sorted(z for z in quest_zones if z not in order)
        if lost:
            warn("route: act %d quest zones not reachable in the connection graph: %s" % (act, ", ".join(lost)))
        route = []
        for z in order:
            if z not in keep:
                continue
            r = areas[z]
            route.append({"area": clean(r["name"]), "id": z,
                          "level": int(r["lvl"]) if str(r.get("lvl") or "").isdigit() else 0,
                          "wp": r.get("wp") == "1", "town": r.get("town") == "1", "notes": notes[z]})
        lv = [e["level"] for e in route if not e["town"]]
        ups = sum(1 for a, b in zip(lv, lv[1:]) if b >= a)
        need(len(route) >= 6, "act %d: only %d route entries" % (act, len(route)))
        need(len(set(e["id"] for e in route)) == len(route), "act %d: duplicate area ids" % act)
        need(ups >= 0.7 * (len(lv) - 1), "act %d: levels not mostly non-decreasing: %r" % (act, lv))
        routes[act] = route
        report[act] = {"entries": len(route), "main": len(main), "skipped": [clean(areas[z]["name"]) for z in skipped],
                       "unplaced": unplaced}
    return routes, report


def quest_gems(cx):
    """{act: [{quest, npc, vendorNpc, reward: [{gem, classes}], vendor: [...]}]} from Cargo quest_rewards and
    vendor_rewards, skill and support gems only. Neither table has a game_mode field (no Ruthless rows)."""
    gem = "items.class_id IN ('Active Skill Gem','Support Skill Gem') AND items.is_in_game=1"
    qr = cargo("quest_rewards,items", "quest_rewards.quest=quest,quest_rewards.quest_id=qid,quest_rewards.act=act,"
                                      "quest_rewards.classes=classes,items.name=gem",
               where=gem, join_on="quest_rewards._pageName=items._pageName")
    vr = cargo("vendor_rewards,items", "vendor_rewards.quest=quest,vendor_rewards.quest_id=qid,vendor_rewards.act=act,"
                                       "vendor_rewards.classes=classes,vendor_rewards.npc=npc,items.name=gem",
               where=gem, join_on="vendor_rewards._pageName=items._pageName")
    npc_of = {}
    for title, text in cx["quest_pages"].items():
        p = quest_params(text)
        m = re.search(r"Talk to \[\[([^\]|]+)(?:\|([^\]]+))?\]\]", p.get("completion") or "")
        if m:
            npc_of[clean(p.get("name") or title)] = clean(m.group(2) or m.group(1))
    acts = {}
    for kind, rows in (("reward", qr), ("vendor", vr)):
        for r in rows:
            if not (r.get("act") or "").isdigit() or not r.get("gem"):
                continue
            listed = [x.strip() for x in (r.get("classes") or "").split(",") if x.strip()]
            # a row without a class list has no class restriction (Lilly Roth's Act 6 stock: every gem)
            cls = [c for c in CLASSES if c in listed] if listed else list(CLASSES)
            if not cls:
                continue
            quest = clean(r["quest"])
            qm = re.match(r"a(\d+)q(\d+)", r.get("qid") or "")
            q = acts.setdefault(int(r["act"]), {}).setdefault(quest, {"quest": quest, "npc": npc_of.get(quest, ""),
                                                                     "vendorNpc": "", "reward": {}, "vendor": {},
                                                                     "_ord": int(qm.group(2)) if qm else 99})
            q["_ord"] = min(q["_ord"], int(qm.group(2)) if qm else 99)
            if kind == "vendor":
                q["vendorNpc"] = clean(r.get("npc"))
            g = q[kind].setdefault(clean(r["gem"]), set())
            g.update(cls)
    out = {}
    for act, qs in acts.items():
        lst = []
        for q in sorted(qs.values(), key=lambda q: (q["_ord"], q["quest"])):
            e = {"quest": q["quest"], "npc": q["npc"] or q["vendorNpc"], "vendorNpc": q["vendorNpc"]}
            for kind in ("reward", "vendor"):
                e[kind] = [{"gem": g, "classes": [c for c in CLASSES if c in cl]} for g, cl in sorted(q[kind].items())]
            lst.append(e)
        out[act] = lst
    a1 = out.get(1, [])
    need(len([q for q in a1 if q["reward"] or q["vendor"]]) >= 5, "act 1: only %d quests with gems" % len(a1))
    got = set(c for q in a1 for g in q["reward"] for c in g["classes"])
    need(got == set(CLASSES), "act 1: classes without a gem reward: %r" % sorted(set(CLASSES) - got))
    return out


# ---------------------------------------------------------------------------------------------------
# Mechanic builders. Each takes the shared context `cx` (page wikitext, cached Cargo rows) and returns
# {"sections": [...], plus optional "source"/"url"/"match"}; it raises Skip when its guard fails.
# ---------------------------------------------------------------------------------------------------

ABYSS_JEWEL = re.compile(r"abyss(?:al)?\b[^.;]{0,30}jewel", re.I)
DIVISIONS = ["Transportation", "Fortification", "Research", "Intervention"]


def _soft(sections, sid, title, fn):
    """Run one NEW section builder; on any failure leave it out with a warning."""
    try:
        s = fn()
        if s:
            sections.append(s)
    except Exception as e:  # Skip from need() or a changed page layout
        warn("%s: new section %r left out: %s" % (sid, title, e))


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

    # NEW: every unique whose Cargo drop text names a Safehouse / Syndicate Hideout (leader uniques plus
    # member reward-room extras), with its base type
    def safehouse_uniques():
        got = cargo("items", "items.name=name,items.base_item=base,items.drop_text=src",
                    where="items.rarity='Unique' AND items.drop_enabled=1 AND "
                          "(items.drop_text LIKE '%Safehouse%' OR items.drop_text LIKE '%Syndicate Hideout%')")
        out = sorted([clean(r["name"]), clean(r["base"]), clean(r["src"])] for r in got if r.get("name"))
        need(len(out) >= 4 and sum(1 for r in out if any(d in r[2] for d in DIVISIONS)) >= 4,
             "only %d safehouse uniques in Cargo" % len(out))
        return table_section("Safehouse uniques (where they drop)", ["Unique", "Base", "Where it drops"], out)

    _soft(sections, "syndicate", "Safehouse uniques", safehouse_uniques)

    # NEW: the Mastermind's drop pool, from the Syndicate Mastermind page (Drops section)
    def mastermind():
        d = section(cx["pages"]["Syndicate Mastermind"], "Drops")
        d = re.sub(r"<!--.*?-->", "", d, flags=re.S)
        d = re.sub(r"\{\{il\|page=([^}|]+)\}\}", r"\1", d)  # {{il|page=X}} carries no positional name
        parts = re.split(r"^In addition, .*$", d, maxsplit=1, flags=re.M)
        pool = [clean(b) for b in bullets(parts[0])]
        extra = [clean(b) for b in bullets(parts[1])] if len(parts) > 1 else []
        lines = [x for x in pool if x] + ["Also: " + x for x in extra if x]
        need(len(pool) >= 4 and any("Cane of Kulemak" in x for x in pool), "Mastermind unique pool not found")
        return list_section("Mastermind (Catarina) drops: one guaranteed unique from the pool; rates are "
                            "crowdsourced", lines)

    _soft(sections, "syndicate", "Mastermind drops", mastermind)
    # Best division per member: the wiki does not state one per member (only the general 2/5/5/2 board
    # strategy), so no such section is built.
    return {"sections": sections, "source": "PoE Wiki: Immortal Syndicate (summarized rewards table), Syndicate "
                                            "Mastermind, Cargo items",
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
    sections = [table_section("Oil tiers (low to high)", ["Tier", "Oil", "Drop level"], tier_rows),
                table_section("Blighted map anoints (one oil each)", ["Oil", "Map effect"], amap)]

    # NEW: amulet and ring anoints, one joined query (recipe -> oils in ordinal order -> notable or ring mod).
    # The tables have no game-mode / removed field; recipes whose notable or mod is missing from Cargo are
    # dropped, and an oil that is not a current drop-enabled oil drops the recipe.
    def anoints():
        rows = cargo("blight_crafting_recipes,blight_crafting_recipes_items,items,passive_skills,mods",
                     "blight_crafting_recipes.id=id,blight_crafting_recipes.type=kind,"
                     "blight_crafting_recipes_items.ordinal=ord,items.name=oil,passive_skills.name=notable,"
                     "mods.stat_text_raw=effect",
                     where="blight_crafting_recipes.type IN ('UniqueOrAmulet','Ring')",
                     join_on="blight_crafting_recipes.id=blight_crafting_recipes_items.recipe_id,"
                             "blight_crafting_recipes_items.item_id=items.metadata_id,"
                             "blight_crafting_recipes.passive_id=passive_skills.id,"
                             "blight_crafting_recipes.modifier_id=mods.id",
                     order_by="blight_crafting_recipes.id,blight_crafting_recipes_items.ordinal")
        rec = {}
        for r in rows:
            e = rec.setdefault(r["id"], {"kind": r["kind"], "what": "", "oils": {}})
            what = clean(r["notable"] if r["kind"] == "UniqueOrAmulet" else r["effect"])
            if what:
                e["what"] = what
            if r.get("ord") and r.get("oil"):
                e["oils"][int(r["ord"])] = clean(r["oil"])  # a passive joined twice repeats the same rows
        out = {"UniqueOrAmulet": [], "Ring": []}
        bad = []
        for rid, e in rec.items():
            oils_ = [e["oils"][k] for k in sorted(e["oils"])]
            want = 3 if e["kind"] == "UniqueOrAmulet" else 2
            if not e["what"] or len(oils_) != want or any(o not in names for o in oils_):
                bad.append(rid)
                continue
            out[e["kind"]].append([e["what"], ", ".join(oils_)])
        if bad:
            warn("blight: dropped %d anoint recipes with a missing notable/mod or oil: %s"
                 % (len(bad), ", ".join(sorted(bad)[:20])))
        res = []
        am = sorted(out["UniqueOrAmulet"])
        if len(am) >= 400:
            res.append(table_section("Amulet anoints (oils in order)", ["Notable", "Oils"], am))
        else:
            warn("blight: new section 'Amulet anoints' left out: only %d recipes" % len(am))
        rg = sorted(out["Ring"])
        if len(rg) >= 60:
            res.append(table_section("Ring anoints (oils in order)", ["Effect", "Oils"], rg))
        else:
            warn("blight: new section 'Ring anoints' left out: only %d recipes" % len(rg))
        return res

    try:
        sections += anoints()
    except Exception as e:
        warn("blight: new anoint sections left out: %s" % e)
    return {"sections": sections, "source": "PoE Wiki: Cargo items, blight_crafting_recipes(_items), passive_skills, mods",
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
    sections = [table_section("Fossils: effect and where they drop", ["Fossil", "Effect", "Biome"], out)]
    w = cx["pages"].get("Delve", "")

    # NEW: biome spawn weight thresholds by depth (page "Delve", Biomes table)
    def biomes():
        t = parse_table(wikitables(section(w, "Biomes"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr[1:4] == ["Biome", "Delve chart background", "Fossils"], "unexpected biome table %r" % hdr)
        order, got = [], {}
        for r in t["rows"]:
            if len(r) != 6:
                continue
            name, fossils, depth, weight = clean(r[1]), clean(r[3]), clean(r[4]), clean(r[5])
            if not name or name == "Biome" or not re.match(r"^[≤≥]\d+$", depth) or not weight.isdigit():
                continue
            if name not in got:
                order.append(name)
                got[name] = [fossils, []]
            got[name][1].append("weight %s at depth %s" % (weight, depth))
        res = [[n, got[n][0] or "-", ", ".join(got[n][1])] for n in order if len(got[n][1]) == 2]
        need(len(res) >= 8 and any(r[0] == "Fungal Caverns" for r in res), "only %d biomes" % len(res))
        return table_section("Biomes: spawn weight by depth (between the two depths it scales non-linearly)",
                             ["Biome", "Fossils", "Spawn weight"], res)

    _soft(sections, "delve", "Biomes", biomes)

    # NEW: city-biome bosses and their minimum depth (page "Delve", Major Bosses table)
    def bosses():
        t = parse_table(wikitables(section(w, "Major Bosses"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Boss", "Biome", "Depth"], "unexpected boss table %r" % hdr)
        res = [[clean(c) for c in r[:3]] for r in t["rows"] if len(r) >= 3 and clean(r[0])]
        need(len(res) >= 3 and all(r[2].isdigit() for r in res), "boss table rows %r" % res)
        return table_section("City biome bosses (spawn only below this depth)", ["Boss", "City biome", "Min depth"],
                             res)

    _soft(sections, "delve", "City biome bosses", bosses)
    return {"sections": sections, "source": "PoE Wiki: Cargo fossils + items, Delve (Biomes, Major Bosses)",
            "url": WIKI_PAGE + "Fossil"}


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
    chains, tier3, full = [], [], []
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
        full.append(chain)
    chains.sort()
    tier3.sort()
    names3 = [r[0] for r in tier3]
    need(len(chains) >= 20 and "Locus of Corruption" in names3 and "Doryani's Institute" in names3,
         "only %d upgrade chains" % len(chains))
    sections = [table_section("Room upgrade chains (kill the other architect to upgrade)",
                              ["Architect", "Tier 1", "Tier 2", "Tier 3"], chains),
                table_section("Tier 3 rooms", ["Room", "Architect", "Effect"], tier3)]

    # NEW: tier 1 and 2 room effects (same Cargo rows, no extra call)
    def lower_tiers():
        res = []
        for chain in sorted(full, key=lambda c: clean(c[0]["arch"])):
            for c in chain[:2]:
                eff = clean(c["descr"] or "")
                if eff:
                    res.append([clean(c["name"]), c["tier"], clean(c["arch"]).split(",")[0], eff])
        need(len(res) >= 30, "only %d tier 1/2 rooms with an effect" % len(res))
        return table_section("Tier 1 and 2 rooms", ["Room", "Tier", "Architect", "Effect"], res)

    _soft(sections, "incursion", "Tier 1 and 2 rooms", lower_tiers)

    # NEW: Temple-wide modifiers each room tier adds in the present-day Temple (Cargo stat_text)
    def temple_mods():
        res = []
        for chain in sorted(full, key=lambda c: clean(c[0]["name"])):
            for c in chain:
                st = clean(c["stats"] or "")
                if st:
                    res.append([clean(c["name"]), c["tier"], st])
        need(len(res) >= 15, "only %d rooms with Temple modifiers" % len(res))
        return table_section("Temple-wide modifiers by room tier (present-day Temple)", ["Room", "Tier", "Modifiers"],
                             res)

    _soft(sections, "incursion", "Temple-wide modifiers", temple_mods)

    # NEW: the page's strategy for getting a wanted tier 3 room
    def strategy():
        s = section(cx["pages"]["Incursion room"], "Strategy")
        intro = sentences(s.split("\n#")[0])[:1]
        steps = [clean(b) for b in bullets(s)]
        need(len(steps) >= 2, "strategy steps not found")
        return list_section("Strategy for a wanted tier 3 room", [clean(x) for x in intro + steps if x])

    _soft(sections, "incursion", "Strategy", strategy)
    return {"sections": sections, "source": "PoE Wiki: Cargo incursion_rooms, Incursion room", "url": WIKI_PAGE + "Incursion_room"}


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
    L = P.get("Expedition Logbook", "")

    # NEW: logbook factions: which artifacts each faction's logbooks give and its boss (min area level)
    def factions():
        t = parse_table(wikitables(section(L, "Expedition factions"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Vendor", "Faction", "Currency", "Expedition Boss"], "unexpected logbook faction table %r" % hdr)
        # "||" after a multi-line bullet cell starts a new line, so the boss cell keeps one leading "|"
        res = [[clean(r[1]), clean(r[0]), clean(r[2]), clean(re.sub(r"^\s*\|", "", r[3]))] for r in t["rows"]
               if len(r) >= 4]
        need([r[1] for r in res] == VENDORS and all("(" in r[3] for r in res), "logbook factions %r" % res)
        return table_section("Logbook factions: artifacts and boss (minimum area level)",
                             ["Faction (logbook implicit)", "Vendor", "Artifacts and currency", "Boss"], res)

    _soft(sections, "expedition", "Logbook factions", factions)

    # NEW: logbook reward chest types
    def chests():
        t = parse_table(wikitables(section(L, "Rewards"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Image", "Type", "Typical drops"], "unexpected chest table %r" % hdr)
        res = []
        for r in t["rows"]:
            if len(r) < 3 or not clean(r[1]) or not clean(r[2]):
                continue
            if re.search(r"Breachstone", clean(r[2]), re.I):
                warn("expedition: dropped chest row %r: Breachstones no longer work in 3.29 (stale wiki)" % clean(r[1]))
                continue
            res.append([clean(r[1]), clean(r[2])])
        need(len(res) >= 12, "only %d chest types" % len(res))
        return table_section("Logbook reward chests", ["Chest", "Typical drops"], res)

    _soft(sections, "expedition", "Logbook reward chests", chests)

    # NEW: logbook areas and the underground areas they can contain
    def locations():
        t = parse_table(wikitables(section(L, "Locations"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Expedition areas", "Possible underground areas"], "unexpected locations table %r" % hdr)
        res = [[clean(r[0]), clean(r[1])] for r in t["rows"] if len(r) >= 2 and clean(r[0])]
        need(len(res) >= 10, "only %d areas" % len(res))
        return table_section("Logbook areas and their underground areas", ["Area", "Underground areas"], res)

    _soft(sections, "expedition", "Logbook areas", locations)
    return {"sections": sections, "source": "PoE Wiki: Expedition, Expedition Logbook, Gwennen, Tujen, Rog, Dannig",
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


def _relic_text(st):
    s = html.unescape(st or "")
    s = re.sub(r"<th[^>]*>.*?</th>", "", s, flags=re.S)  # "<3 variants>" header; the variants follow
    s = re.sub(r"<hr[^>]*>", " or ", s)
    lines = [clean(x, limit=0) for x in re.split(r"<br\s*/?>", s, flags=re.I)]
    lines = [x for x in lines if x and not x.startswith("This item is destroyed when applied")]
    return clean("; ".join(lines))


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
    sections = [table_section("Major afflictions (run-threatening)", ["Affliction", "Effect"], out["Major"]),
                table_section("Minor afflictions", ["Affliction", "Effect"], out["Minor"])]
    P = cx["pages"]["The Forbidden Sanctum"]

    # NEW: boons (same layout as the affliction table). A boon listed with many charge counts (e.g. "the next
    # 10 / 9 / ... Guards") keeps its first, full-charge line.
    def boons():
        t = parse_table(wikitables(section(P, "Boon"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Boon Type", "Image", "Boon Name", "Description"], "unexpected boon table %r" % hdr)
        got = {"Major": {}, "Minor": {}}
        for r in t["rows"]:
            if len(r) < 4:
                continue
            kind = "Major" if clean(r[0]).startswith("Major") else "Minor" if clean(r[0]).startswith("Minor") else None
            name, desc = clean(r[2]), clean(r[3], limit=0)
            if kind and name:
                d = got[kind].setdefault(name, [])
                if desc not in d:
                    d.append(desc)
        res = {k: [[n, clean(" / ".join(ds if len(ds) <= 2 else ds[:1]))] for n, ds in sorted(v.items())]
               for k, v in got.items()}
        need(len(res["Major"]) >= 8 and len(res["Minor"]) >= 15, "boons: %d major, %d minor"
             % (len(res["Major"]), len(res["Minor"])))
        return [table_section("Major boons", ["Boon", "Effect"], res["Major"]),
                table_section("Minor boons", ["Boon", "Effect"], res["Minor"])]

    try:
        sections += boons()
    except Exception as e:
        warn("sanctum: new boon sections left out: %s" % e)

    # NEW: floor bosses and minibosses (Enemies section tables)
    def floor_bosses():
        t = parse_table(wikitables(section(P, "Floor Bosses"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Icon", "Boss Name", "Boss Room", "Description"], "unexpected boss table %r" % hdr)
        res = [[clean(r[1]), clean(r[2]), clean(r[3])] for r in t["rows"] if len(r) >= 4 and clean(r[1])]
        need(len(res) >= 4 and any("Lycia" in r[0] for r in res), "only %d floor bosses" % len(res))
        return table_section("Floor bosses (room 8 of each floor)", ["Boss", "Boss room", "Notes"], res)

    _soft(sections, "sanctum", "Floor bosses", floor_bosses)

    def minibosses():
        t = parse_table(wikitables(section(P, "Minibosses"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr[:2] == ["Boss name", "Boss room name"] and len(hdr) == 3, "unexpected miniboss table %r" % hdr)
        res = [[clean(r[0]), clean(r[1]), clean(r[2])] for r in t["rows"] if len(r) >= 3 and clean(r[0])]
        need(len(res) >= 3, "only %d minibosses" % len(res))
        return table_section("Minibosses", ["Boss", "Boss room", "Based on / mechanics"], res)

    _soft(sections, "sanctum", "Minibosses", minibosses)

    # NEW: Accursed Pact outcomes
    def pacts():
        t = parse_table(wikitables(section(P, "Accursed Pact"))[0])
        hdr = [clean(c) for c in t["header"]]
        need(hdr == ["Icon", "Upside", "Downside"], "unexpected pact table %r" % hdr)
        res = [[clean(r[0]) or "-", clean(r[1]), clean(r[2])] for r in t["rows"] if len(r) >= 3 and clean(r[1])]
        need(len(res) >= 10, "only %d pacts" % len(res))
        return table_section("Accursed Pacts", ["Pact", "Upside", "Downside"], res)

    _soft(sections, "sanctum", "Accursed Pacts", pacts)

    # NEW: relics from Cargo items (class Relic): base types with their size, and the unique relics
    def relics():
        got = cargo("items", "items.name=name,items.rarity=rar,items.explicit_stat_text=st,items.size_x=sx,"
                             "items.size_y=sy", where="items.class_id='Relic' AND items.drop_enabled=1")
        bases = sorted([clean(r["name"]), "%sx%s" % (r["sx"], r["sy"])] for r in got
                       if r.get("rar") == "Normal" and r.get("name") and r.get("sx") and r.get("sy"))
        uniq = sorted([clean(r["name"]), _relic_text(r.get("st"))] for r in got
                      if r.get("rar") == "Unique" and r.get("name"))
        uniq = [u for u in uniq if u[1]]
        res = []
        if len(bases) >= 5:
            res.append(table_section("Relic base types (size in Relic Altar slots, width x height)",
                                     ["Relic", "Size"], bases))
        else:
            warn("sanctum: new section 'Relic base types' left out: only %d" % len(bases))
        if len(uniq) >= 5:
            res.append(table_section("Unique relics (dropped by Lycia, Herald of the Scourge)", ["Relic", "Effect"],
                                     uniq))
        else:
            warn("sanctum: new section 'Unique relics' left out: only %d" % len(uniq))
        return res

    try:
        sections += relics()
    except Exception as e:
        warn("sanctum: new relic sections left out: %s" % e)
    return {"sections": sections, "source": "PoE Wiki: The Forbidden Sanctum (Affliction, Boon, Enemies, Accursed "
                                            "Pact), Cargo items (relics)",
            "url": WIKI_PAGE + "The_Forbidden_Sanctum"}


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


# ---------------------------------------------------------------------------------------------------
# small helpers shared by these builders
# ---------------------------------------------------------------------------------------------------

def _unhover(s):
    """Cargo HTML: drop the pop-up item box of an item link and keep the link itself."""
    s = html.unescape(s or "")
    while True:
        i = s.find('<span class="hoverbox__display')
        if i < 0:
            return s
        depth, end = 0, None
        for m in re.finditer(r"<span\b|</span>", s[i:]):
            depth += 1 if m.group(0) == "<span" else -1
            if depth == 0:
                end = i + m.end()
                break
        if end is None:
            return s[:i]
        s = s[:i] + s[end:]


def _br_lines(s):
    """Cargo text with <br> separators -> lines; a line starting lower-case continues the previous one."""
    out = []
    for part in re.split(r"<br\s*/?>", html.unescape(s or ""), flags=re.I):
        t = clean(part, limit=0)
        if not t:
            continue
        if out and t[0].islower():
            out[-1] += " " + t
        else:
            out.append(t)
    return out


def _fit(s):
    """A sentence longer than a cell -> consecutive pieces cut at clause boundaries (text unchanged)."""
    s = re.sub(r"\s+([.,;:])", r"\1", clean(s, limit=0))  # a dropped icon template leaves "icon ."
    out = []
    while len(s) > CELL_MAX:
        cut = max(s.rfind(sep, 0, CELL_MAX - 2) for sep in (", ", "; ", " - ", " (", " and ", " but ", " which "))
        if cut < 40:
            cut = s.rfind(" ", 0, CELL_MAX - 2)
        out.append(s[:cut].rstrip(" ,;") + " …")
        s = "… " + s[cut:].lstrip(" ,;")
    return out + [s] if s.strip(" …") else out


def _sents(text):
    """Sentences of the prose paragraphs in `text`, each fitted to the cell limit."""
    return [x for p in _paras(text) for s in sentences(p) for x in _fit(s)]


def _lead(text):
    """A section's own text, without its sub-sections."""
    return re.split(r"^=+[^=\n].*=+\s*$", text, maxsplit=1, flags=re.M)[0]


def _blines(text):
    """First-level list items of `text`, each fitted to the cell limit."""
    return [x for b in bullets(text, fold=False) for x in _fit(b)]


def _paras(text):
    """Prose paragraphs of a section (no lists, tables, files, templates-only lines, headings)."""
    out, buf = [], []
    for l in text.split("\n") + [""]:
        skip = re.match(r"\s*(\*|#|\{\||\||!|\[\[File:|=|\{\{(?!il|c\||psl|stl))", l)
        if not l.strip() or skip:  # blank lines, lists, tables etc. end a paragraph
            if buf:
                out.append(" ".join(buf))
                buf = []
            continue
        if l.rstrip().endswith(":"):  # a sentence that introduces a list: the list is shown on its own
            cut = l.rfind(". ")
            l = l[:cut + 1] if cut > 0 else ""
        if l.strip():
            buf.append(l.strip())
    return out


VH_ROW = re.compile(r"\{\{Version history table row\|([\d.]+[a-z]?)\|(.*?)\n\}\}", re.S)


def _vh(text, prefix=PATCH):
    """Bullets of the page's version-history rows for `prefix` (3.29.x), newest first."""
    out = []
    for ver, body in VH_ROW.findall(text):
        if not (ver == prefix or ver.startswith(prefix + ".")):
            continue
        for b in bullets(body, fold=False):
            if "{{Ruthless}}" in b or re.match(r"\(Hotfix \d+\) Fixed|Fixed a bug", clean(b)):
                continue
            t = clean(b, limit=0)
            if t:
                out += _fit("%s: %s" % (ver, t))
    return out


def _has_vh(text, prefix=PATCH):
    return any(v == prefix or v.startswith(prefix + ".") for v, _ in VH_ROW.findall(text))


def _short(rogue):
    return rogue.split(",")[0].strip()


# ---------------------------------------------------------------------------------------------------
# Heist
# ---------------------------------------------------------------------------------------------------

# Rows of the reward-chest table that contradict the Heist / Grand Heist version history:
# (pattern in the row, phrase that must be in the version history, what it says)
HEIST_STALE = [
    (r"Trarthan", "Trarthan Gems are no longer possible rewards from Gem Chests", "3.29.0"),
    (r"Ultimatum", "Ultimatum Rewards from Demolition in Heist have been replaced by Map Rewards", "3.29.0"),
    (r"\bBreach\b", "Breach reward rooms can now spawn Gold reward rooms", "3.27.0"),
    (r"Harbinger", "Blueprints that had Harbinger Rewards now instead have Gold Rewards", "3.28.0"),
]


def m_heist(cx):
    P = cx["pages"]
    vh_text = P["Heist"] + "\n" + P["Grand Heist"]
    sk = cargo("heist_npc_skills,heist_npcs,heist_jobs",
               "heist_npcs.name=rogue,heist_npcs.job_id=main,heist_jobs.id=jid,heist_jobs.name=job,heist_npc_skills.level=lvl",
               join_on="heist_npc_skills.npc_id=heist_npcs.id,heist_npc_skills.job_id=heist_jobs.id")
    jobname, rogues = {}, {}
    for r in sk:
        if not (r.get("rogue") and r.get("job")):
            continue
        job = clean(r["job"])
        jobname[r["jid"]] = job
        lvl = int(r["lvl"]) if str(r.get("lvl") or "").isdigit() else 0
        rogues.setdefault(clean(r["rogue"]), []).append((-lvl, r.get("main") != r["jid"], job))
    for v in rogues.values():
        v.sort()
    # perks from the rogue tables (List of Rogues, transcluded on the Heist page)
    perks = {}
    for t in wikitables(P["List of Rogues"]):
        t = parse_table(t)
        hdr = [clean(c) for c in t["header"]]
        if "Name" not in hdr:
            continue
        ni = hdr.index("Name")
        pi = next((i for i, h in enumerate(hdr) if h.startswith("Heist perks") or h == "Functions"), None)
        if pi is None:
            continue
        for r in t["rows"]:
            if len(r) > max(ni, pi):
                perks[clean(r[ni])] = clean(r[pi])
    rogue_rows = [[name, ", ".join(j for _, _, j in v), perks.get(name, "-") or "-"]
                  for name, v in sorted(rogues.items(), key=lambda kv: (kv[1][0][0], kv[0]))]
    need(len(rogue_rows) >= 10 and any(r[0] == "Karst, the Lockpick" for r in rogue_rows)
         and len(set(jobname.values())) == 9, "only %d rogues / %d jobs" % (len(rogue_rows), len(set(jobname.values()))))

    # reward chests and the jobs that open them
    t = parse_table(wikitables(P["List of Heist Reward Chests"])[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr[1:4] == ["Type", "Typical drops", "Skill"], "unexpected reward chest table %r" % hdr)
    chests = []
    for r in t["rows"]:
        cells = [clean(c) for c in r[1:4]]
        if len(cells) < 3 or not cells[0]:
            continue
        stale = next((s for s in HEIST_STALE if re.search(s[0], " ".join(cells)) and s[1] in vh_text), None)
        if stale:
            warn("heist: dropped reward chest row %r: Heist version history %s says '%s' (stale wiki)"
                 % (cells[0], stale[2], stale[1]))
            continue
        chests.append(cells)
    need(len(chests) >= 10 and any(r[0] == "Currency" for r in chests), "only %d chest types" % len(chests))
    opens = {}
    for c in chests:
        for j in re.split(r",\s*", c[2]):
            opens.setdefault(j.strip().lower(), []).append(c[0])
    by_job = {}
    for name, v in rogues.items():
        for lvl, _, j in v:
            by_job.setdefault(j, []).append((lvl, name))
    job_rows = []
    for j in sorted(by_job):
        job_rows.append([j, ", ".join(_short(n) for _, n in sorted(by_job[j])), ", ".join(opens.get(j.lower(), [])) or "-"])
    need(all(r[2] != "-" for r in job_rows), "a job opens no chest type: %r" % [r[0] for r in job_rows if r[2] == "-"])

    # blueprint locations and the jobs their wings can ask for
    areas = cargo("heist_areas,items", "heist_areas.id=id,items.name=name,heist_areas.job_ids=jobs,heist_areas.reward_text=reward",
                  join_on="heist_areas.blueprint_id=items.metadata_id")
    bp = []
    for a in areas:
        name = clean(a.get("name"))
        if not name.startswith("Blueprint: "):
            continue
        jobs = [jobname.get(j.strip(), j.strip()) for j in (a.get("jobs") or "").split(",") if j.strip()]
        bp.append([name[len("Blueprint: "):], ", ".join(sorted(jobs))])
    bp.sort()
    need(len(bp) >= 8 and any(r[0] == "Bunker" for r in bp), "only %d blueprint locations" % len(bp))
    if any(a.get("reward") for a in areas) and "Rewards no longer differ based on type of [[Blueprint]] Area" in vh_text:
        warn("heist: left out Cargo heist_areas.reward_text (per-location blueprint reward): Grand Heist version "
             "history 3.23.0 says 'Grand Heist Rewards no longer differ based on type of Blueprint Area' (stale data)")
    wings = _sents(section(P["Grand Heist"], "Wings"))
    unlock = _blines(section(P["Heist"], "Rogues"))
    sections = [
        table_section("Rogues: jobs (best job first) and perks", ["Rogue", "Jobs", "Perks / functions"], rogue_rows),
        table_section("Jobs: who has them and which reward chests they open", ["Job", "Rogues (best first)", "Opens chests"],
                      job_rows),
        table_section("Reward chests", ["Chest", "Typical drops", "Jobs"], chests),
        table_section("Blueprint locations: jobs their wings can require", ["Location", "Jobs"], bp),
    ]
    if wings:
        sections.append(list_section("Grand Heist wings", wings))
    if unlock:
        sections.append(list_section("Rogue unlock order", unlock))
    ch = _vh(P["Heist"])
    if ch:
        sections.append(list_section("Changed in " + PATCH, ch))
    return {"sections": sections,
            "source": "PoE Wiki: Cargo heist_npcs/heist_jobs/heist_npc_skills/heist_areas, List of Rogues, "
                      "List of Heist Reward Chests, Grand Heist",
            "url": WIKI_PAGE + "Heist"}


# ---------------------------------------------------------------------------------------------------
# Breach (the Keepers-league version; Breachstones / splinters / blessings are gone)
# ---------------------------------------------------------------------------------------------------

def m_breach(cx):
    w = cx["pages"]["Breach"]
    need(_has_vh(w), "Breach page has no %s version history (stale wiki?)" % PATCH)
    rows = cargo("items", "items.name=name,items.class_id=cls,items.drop_enabled=de,items.removal_version=rem,"
                          "items.description=descr,items.help_text=help,items.drop_text=drop,items.implicit_stat_text=impl",
                 where="items.name LIKE '%Wombgift' OR items.name='Flesh of Xesht' OR items.name='Hivebrain Gland' "
                       "OR (items.class_id='StackableCurrency' AND items.name LIKE 'Foulborn %') "
                       "OR (items.class_id='Ring' AND items.rarity_id='normal' AND items.release_version='3.27.0') "
                       "OR (items.class_id='StackableCurrency' AND (items.name LIKE 'Splinter of %' "
                       "OR items.name LIKE 'Blessing of %')) OR items.class_id='Breachstone' "
                       "OR (items.class_id='MapFragment' AND items.name LIKE 'Breach Scarab%')")
    live, gone = [], []
    for r in rows:
        if r.get("de") == "1" and not r.get("rem"):
            live.append(r)
        else:
            gone.append("%s (%s)" % (clean(r["name"]), ("removed " + r["rem"]) if r.get("rem") else "drop disabled"))
    if gone:
        warn("breach: dropped %d Breach items Cargo marks removed / drop disabled: %s" % (len(gone), "; ".join(sorted(gone))))
    womb, cur, rings, scarabs = [], [], [], []
    for r in live:
        name, cls = clean(r["name"]), r.get("cls")
        drop = clean(_unhover(r.get("drop"))) or "-"
        effect = clean(r.get("descr")) or clean(r.get("help")) or "-"
        if name.endswith("Wombgift"):
            womb.append([name, effect, drop])
        elif cls == "Ring":
            rings.append([name, clean("; ".join(_br_lines(r.get("impl")))) or "-", drop])
        elif cls == "MapFragment" and name.startswith("Breach Scarab"):
            scarabs.append([name, effect])
        else:
            cur.append([name, effect, drop])
    for t in (womb, cur, rings, scarabs):
        t.sort()
    need(len(womb) >= 3 and any(r[0] == "Ancient Wombgift" for r in womb), "only %d wombgifts" % len(womb))
    need(len(rings) >= 5 and any(r[0] == "Flesh of Xesht" for r in cur), "breach rings / currency missing")
    ov = [p for p in _paras(_lead(section(w, "Overview"))) if "{{confirm" not in p]
    over = [x for p in ov for s in sentences(p) for x in _fit(s)]
    enc = []
    for sub in ("Unstable Breach", "Breach Hive", "Hive Fortress"):
        ps = _paras(section(w, sub))
        if ps:
            enc += [x for s in sentences(ps[0])[:3] for x in _fit("%s: %s" % (sub, s))]
    flames = _blines(section(w, "Breach Hive"))
    sections = [list_section("Overview", over), list_section("Encounter types", enc),
                list_section("Breach Hive: Ailith's purple flames", flames),
                table_section("Wombgifts", ["Wombgift", "Grows into", "Source"], womb),
                table_section("Breach currency and fragments", ["Item", "Effect", "Source"], cur),
                table_section("Breach rings", ["Ring", "Implicit", "Source"], rings),
                table_section("Breach scarabs", ["Scarab", "Effect"], scarabs)]
    ch = _vh(w)
    if ch:
        sections.append(list_section("Changed in " + PATCH, ch))
    return {"sections": sections, "source": "PoE Wiki: Breach, Cargo items (drop-enabled Breach items)",
            "url": WIKI_PAGE + "Breach"}


# ---------------------------------------------------------------------------------------------------
# Legion
# ---------------------------------------------------------------------------------------------------

def m_legion(cx):
    w = cx["pages"]["Legion"]
    need(_has_vh(w), "Legion page has no %s version history (stale wiki?)" % PATCH)
    rows = cargo("items", "items.name=name,items.class_id=cls,items.drop_enabled=de,items.removal_version=rem,"
                          "items.description=descr,items.help_text=help,items.drop_text=drop,items.explicit_stat_text=stats",
                 where="(items.class_id='MapFragment' AND items.name LIKE '%Timeless%Emblem') "
                       "OR (items.class_id='StackableCurrency' AND items.name LIKE 'Timeless % Splinter') "
                       "OR (items.base_item='Timeless Jewel' AND items.rarity_id='unique') "
                       "OR (items.class_id='MapFragment' AND items.name LIKE 'Legion Scarab%')")
    emblems, splinters, jewels, scarabs = {}, [], [], []
    for r in rows:
        name = clean(r["name"])
        if "Unrelenting" in name:
            warn("legion: dropped %r: Unrelenting Timeless Emblems were removed in 3.29 (Timeless Emblem page, "
                 "version history 3.29.0)" % name)
            continue
        if r.get("de") != "1" or r.get("rem"):
            continue
        if name.endswith("Emblem"):
            emblems[name] = _br_lines(r.get("descr"))
        elif name.endswith("Splinter"):
            splinters.append([name, clean(r.get("help")) or "-", clean(_unhover(r.get("drop"))) or "-"])
        elif name.startswith("Legion Scarab"):
            scarabs.append([name, clean("; ".join(_br_lines(r.get("descr")))) or "-"])
        else:
            st = html.unescape(html.unescape(r.get("stats") or ""))
            by = re.search(r"Conquered by the ([A-Z][\w ]+?)\s*(?:<|$)", st)
            who = re.search(r"<([^<>]*[A-Z][a-z]+[^<>]*)>", st)
            names = re.findall(r"[A-Z][a-z]+", who.group(1)) if who else []
            jewels.append([name, by.group(1) if by else "-", ", ".join(names) or "-",
                           clean(_unhover(r.get("drop"))) or "-"])
    common = set.intersection(*[set(v) for v in emblems.values()]) if emblems else set()
    first = next(iter(emblems.values()), [])
    emb_rows = [[n, clean("; ".join(l for l in v if l not in common)) or "-"] for n, v in sorted(emblems.items())]
    jewels.sort()
    splinters.sort()
    scarabs.sort()
    need(len(emb_rows) >= 5 and len(jewels) >= 5 and any(r[0] == "Glorious Vanity" for r in jewels),
         "%d emblems, %d timeless jewels" % (len(emb_rows), len(jewels)))
    t = parse_table(wikitables(section(w, "Legions"))[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr == ["Legion", "Formation", "Splinters/Emblems", "General"], "unexpected legion table %r" % hdr)
    legions = []
    for r in t["rows"]:
        if len(r) < 4:
            continue
        gen = re.findall(r"\|\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\]\]", r[3])  # the thumb caption of the portrait
        legions.append([clean(r[0]), clean(r[1]), clean(r[2].replace("<br />", " / ").replace("<br/>", " / ")),
                        clean(gen[-1]) if gen else clean(r[3])])
    need(len(legions) == 5 and any(r[0] == "Karui" for r in legions), "only %d legions" % len(legions))
    ov = section(w, "Overview")
    sources = _blines(ov)
    rules = [x for p in _paras(ov) for s in sentences(p)
             if re.search(r"timer|90%|Sergeant|general|Schism|stasis", s, re.I) for x in _fit(s)]
    sections = [table_section("Legions", ["Legion", "Formation", "Splinter / Emblem", "General"], legions),
                list_section("Encounter rules", rules),
                list_section("Monolith sources", sources),
                list_section("Emblems: effects every Emblem has", [l for l in first if l in common]),
                table_section("Emblems: extra effect per legion (use 2+ different ones for the Domain)",
                              ["Emblem", "Extra effect"], emb_rows),
                table_section("Splinters", ["Splinter", "Use", "Drops from"], splinters),
                table_section("Timeless jewels", ["Jewel", "Conquered by", "Conqueror variants", "Source"], jewels),
                table_section("Legion scarabs", ["Scarab", "Effect"], scarabs)]
    ch = _vh(w)
    if ch:
        sections.append(list_section("Changed in " + PATCH, ch))
    return {"sections": sections, "source": "PoE Wiki: Legion, Cargo items (emblems, splinters, timeless jewels, scarabs)",
            "url": WIKI_PAGE + "Legion"}


# ---------------------------------------------------------------------------------------------------
# Abyss (3.29 rework)
# ---------------------------------------------------------------------------------------------------

LICHES = ("Amanamu", "Ulaman", "Kurgal")


def m_abyss(cx):
    w, d = cx["pages"]["Abyss"], cx["pages"]["Abyssal Depths"]
    need(_has_vh(w), "Abyss page has no %s version history: pre-rework (stale wiki)" % PATCH)
    ov = section(w, "Overview")
    need(re.search(r"souls", ov) and re.search(r"pit", ov), "Abyss overview does not describe the 3.29 pits (stale wiki)")
    cut = ov.find("biased towards")
    need(cut > 0, "lich bias paragraph not found")
    chests, liches = [], []
    for b in bullets(ov[:cut], fold=False):
        b = clean(b)
        if ":" in b:
            name, loot = b.split(":", 1)
            chests.append([name.strip(), loot.strip()])
        else:
            warn("abyss: chest %r has no loot description on the wiki, left out" % b)
    for b in bullets(ov[cut:], fold=False):
        b = clean(b)
        if ":" in b and b.split(":")[0].strip() in LICHES:
            liches.append([x.strip() for x in b.split(":", 1)])
    need(len(chests) >= 6 and any(r[0] == "Abyssal Trove" for r in chests), "only %d chest types" % len(chests))
    need(len(liches) == 3, "lich bias list: %r" % liches)
    how = _sents(ov)
    need(_has_vh(d), "Abyssal Depths page has no %s version history (stale wiki?)" % PATCH)
    lay = section(d, "Layout")
    depths = _sents(lay)
    lchest = []
    for b in bullets(lay, fold=False):
        b = clean(b)
        if ":" in b:
            lchest.append([x.strip() for x in b.split(":", 1)])
    need(len(lchest) >= 3, "Lightless chests not found on Abyssal Depths")
    sc = cargo("items", "items.name=name,items.description=descr,items.drop_enabled=de,items.removal_version=rem",
               where="items.class_id='MapFragment' AND items.name LIKE 'Abyss Scarab%'")
    scarabs = sorted([clean(r["name"]), clean("; ".join(_br_lines(r.get("descr")))) or "-"]
                     for r in sc if r.get("de") == "1" and not r.get("rem"))
    sections = [list_section("How it works", how),
                table_section("Abyss chests", ["Chest", "Main loot"], chests),
                table_section("Lich alignment: chest loot bias", ["Lich", "Bias"], liches),
                list_section("Abyssal Depths", depths),
                table_section("Abyssal Depths: Lightless chests after the Lich", ["Chest", "Extra reward"], lchest),
                table_section("Abyss scarabs", ["Scarab", "Effect"], scarabs)]
    ch = _vh(w)
    if ch:
        sections.append(list_section("Changed in " + PATCH, ch))
    return {"sections": sections, "source": "PoE Wiki: Abyss, Abyssal Depths, Cargo items (Abyss scarabs)",
            "url": WIKI_PAGE + "Abyss"}


# ---------------------------------------------------------------------------------------------------
# Delirium
# ---------------------------------------------------------------------------------------------------

def m_delirium(cx):
    P = cx["pages"]
    w, sim = P["Delirium"], P["Simulacrum"]
    items = cargo("items", "items.name=name,items.class_id=cls,items.drop_enabled=de,items.removal_version=rem,"
                           "items.description=descr,items.help_text=help,items.metadata_id=mid",
                  where="items.metadata_id LIKE '%CurrencyAfflictionOrb%' OR items.name='Simulacrum Splinter' "
                        "OR (items.class_id='StackableCurrency' AND items.name LIKE 'Splinter of %') "
                        "OR (items.class_id='MapFragment' AND items.name LIKE 'Delirium Scarab%')")
    orbs, gone, scarabs, splinter_help, breach_gone = [], [], [], "", []
    for r in items:
        name, mid = clean(r["name"]), r.get("mid") or ""
        live = r.get("de") == "1" and not r.get("rem")
        if name.startswith("Splinter of "):
            if r.get("rem"):
                breach_gone.append("%s (removed %s)" % (name, r["rem"]))
            continue
        if "CurrencyAfflictionOrb" in mid:
            if "HardMode" in mid:
                continue  # Ruthless only
            if not live:
                gone.append("%s (%s)" % (name, ("removed " + r["rem"]) if r.get("rem") else "drop disabled"))
                continue
            m = re.search(r"with the (.+?) reward type", clean(r.get("descr")))
            orbs.append([name, m.group(1) if m else clean(r.get("descr"))])
        elif name == "Simulacrum Splinter" and live:
            splinter_help = clean(r.get("help"))
        elif name.startswith("Delirium Scarab") and live:
            scarabs.append([name, clean("; ".join(_br_lines(r.get("descr")))) or "-"])
    if gone:
        warn("delirium: left out %d Delirium Orbs Cargo marks removed / drop disabled: %s" % (len(gone), "; ".join(sorted(gone))))
    orbs.sort()
    scarabs.sort()
    need(len(orbs) >= 8 and any(r[0] == "Fine Delirium Orb" for r in orbs), "only %d current delirium orbs" % len(orbs))

    # reward types; a row is stale when the wiki elsewhere says its typical drops are gone
    stale = []
    if breach_gone:
        stale.append((r"Breach Splinter", "Breach splinters are removed per Cargo: %s" % ", ".join(sorted(breach_gone))))
    if "Incubators no longer be obtained" in P["Legion"]:
        stale.append((r"Incubator", "Legion page 3.29.0: 'Incubators no longer be obtained'"))
    if re.search(r"Abyss is now the exclusive source of \[\[Abyssal Jewel", P["Abyss"]):
        stale.append((r"Abyss jewel", "Abyss page 3.29.0: 'Abyss is now the exclusive source of Abyssal Jewels'"))
    t = parse_table(wikitables(section(w, "Rewards"))[0])
    hdr = [clean(c) for c in t["header"]]
    need(hdr == ["Icon", "Reward", "Typical drops"], "unexpected reward table %r" % hdr)
    rewards = []
    for r in t["rows"]:
        if len(r) < 3 or not clean(r[1]):
            continue
        cells = [clean(r[1]), clean(r[2])]
        hit = next((s for s in stale if re.search(s[0], cells[1], re.I)), None)
        if hit:
            warn("delirium: dropped reward type %r (%s): %s (stale wiki)" % (cells[0], cells[1], hit[1]))
            continue
        rewards.append(cells)
    need(len(rewards) >= 12 and any(r[0] == "Currency" for r in rewards), "only %d reward types" % len(rewards))
    other = section(w, "Other drops")
    other_lines = _sents(other)
    for intro, items_ in re.findall(r"^([^*\n][^\n]*?):\s*\n((?:\*[^\n]*\n?)+)", other, re.M):  # "X drops:" + list
        other_lines += _fit("%s: %s" % (intro, "; ".join(clean(b, limit=0) for b in bullets(items_, fold=False))))

    mech = section(sim, "Mechanics")
    sim_lines = ([splinter_help] if splinter_help else []) + \
        [x for p in _paras(mech) for s in sentences(p)
         if re.search(r"waves of enemies|can start spawning|only drop from waves|Altar of Lies|destroy all items", s)
         for x in _fit(s)]
    st = parse_table(wikitables(mech)[0])
    shdr = [clean(c.replace("# of", "Number of")).replace("; ", " ") for c in st["header"]]
    need(shdr and shdr[0] == "Wave", "unexpected Simulacrum scaling table %r" % shdr)
    srows = [[clean(c) or "-" for c in r] for r in st["rows"] if len(r) == len(shdr)]
    need(len(srows) >= 10 and len(sim_lines) >= 3, "Simulacrum details not found")
    sections = [table_section("Reward types (the reward bar decides what drops)", ["Reward", "Typical drops"], rewards),
                table_section("Delirium Orbs in the game now (add Delirium to a map, with that reward type)",
                              ["Orb", "Reward type"], orbs),
                list_section("Other drops", other_lines),
                list_section("Simulacrum", sim_lines),
                table_section("Simulacrum scaling per wave", shdr, srows),
                table_section("Delirium scarabs", ["Scarab", "Effect"], scarabs)]
    return {"sections": sections, "source": "PoE Wiki: Delirium, Simulacrum, Cargo items (delirium orbs, scarabs)",
            "url": WIKI_PAGE + "Delirium"}


# ---------------------------------------------------------------------------------------------------
# Shared helpers (agent B: ritual, labyrinth, scarabs, atlas)
# ---------------------------------------------------------------------------------------------------

BR = re.compile(r"<br\s*/?>", re.I)


def _hclean(c):
    """A header / short cell: line breaks become spaces, '(...)' on its own line joins the line above."""
    return clean(BR.sub(" ", c))


def _vh_rows(text):
    """The page's version history: [(version, [plain-text change lines])], newest first."""
    out = []
    for m in re.finditer(r"\{\{Version history table row\|([^|]+)\|(.*?)\n\}\}", text, re.S):
        out.append((m.group(1).strip(), [clean(b, limit=0) for b in bullets(m.group(2), fold=False)]))
    return out


def _lines(text, skip=None):
    """Every list item ('*', '**', '#', '#*'...) as its own line; an item longer than a cell is split
    into sentences."""
    out = []
    for line in text.split("\n"):
        m = re.match(r"^([*#]+)\s*(.*)$", line)
        if not m or not m.group(2).strip():
            continue
        full = clean(m.group(2), limit=0)
        if not full or (skip and skip.search(full)):
            continue
        parts = [full] if len(full) <= CELL_MAX else sentences(m.group(2))
        out += [clean(p) for p in parts if clean(p)]
    return out


def _chunks(text, sep=", "):
    """Split a long comma list into cell-sized pieces (no truncation)."""
    out, cur = [], ""
    for part in text.split(sep):
        nxt = (cur + sep + part) if cur else part
        if len(nxt) > CELL_MAX and cur:
            out.append(cur)
            cur = part
        else:
            cur = nxt
    if cur:
        out.append(cur)
    return [clean(c) for c in out]


def _bullet_rows(text):
    """Top-level list items with their sub-items: [[item, detail], ...] ('-' when there is none)."""
    items = []
    for line in text.split("\n"):
        m = re.match(r"^([*#]+)\s*(.*)$", line)
        if not m or not m.group(2).strip():
            continue
        if len(m.group(1)) == 1:
            items.append([m.group(2), []])
        elif items:
            items[-1][1].append(m.group(2))
    return items


def _effect(s):
    """A Cargo stat description: a line break inside a sentence (next line starts lower-case) is a space."""
    return clean(re.sub(r"<[bB][rR]\s*/?>\s*(?=[a-z])", " ", html.unescape(s or "")))


def _scarab_rows(cx):
    """Current scarabs (Cargo items + map_fragments), shared by the scarab and ritual sheets."""
    if "scarabs" not in cx:
        rows = cargo("items,map_fragments",
                     "items.name=name,items.description=effect,map_fragments.map_fragment_limit=lim,"
                     "items.removal_version=removed,items.is_in_game=ingame",
                     where="items.class_id='MapFragment' AND items.drop_enabled=1 AND items.name LIKE '%Scarab%'",
                     join_on="items._pageID=map_fragments._pageID", order_by="items.name")
        cx["scarabs"] = [r for r in rows if r.get("name") and r.get("ingame") == "1" and not r.get("removed")]
    return cx["scarabs"]


# ---------------------------------------------------------------------------------------------------
# Ritual
# ---------------------------------------------------------------------------------------------------

def m_ritual(cx):
    w = cx["pages"]["Ritual"]
    vh = _vh_rows(w)
    removed = set()  # reward types the page's own version history says left Ritual
    for _, lines in vh:
        for line in lines:
            m = re.match(r"^(.+?)s? (?:can no longer be found as|are no longer offered as) Ritual Rewards?", line)
            if m:
                removed.add(m.group(1).strip())
            m = re.search(r"source of (.+?)s? \(removed from Ritual\)", line)
            if m:
                removed.add(m.group(1).strip())
    need(removed, "version history removal lines not found (page layout changed?)")
    stale_re = re.compile("|".join(re.escape(t) for t in sorted(removed)), re.I)
    scarabs = {html.unescape(r["name"]) for r in _scarab_rows(cx)}

    def current(raw, where):
        text = clean(raw, limit=0)
        if "{{confirm" in raw:
            warn("ritual: dropped %s line %r: the wiki itself flags it as possibly removed (stale wiki)" % (where, text))
            return False
        if stale_re.search(text):
            warn("ritual: dropped %s line %r: the page's version history says it is no longer a Ritual reward "
                 "(stale wiki)" % (where, text))
            return False
        gone = [n for n in re.findall(r"\{\{il\|([^|}]*Scarab[^|}]*)", raw) if n not in scarabs]
        if gone:
            warn("ritual: dropped %s line %r: %s is not a current scarab in Cargo (stale wiki)" % (where, text, gone))
            return False
        return True

    t = parse_table(wikitables(section(w, "Mechanics"))[0])
    thdr = [_hclean(c) for c in t["header"]]
    need(len(thdr) == 5 and thdr[1].startswith("1 (100%)"), "unexpected tribute table %r" % thdr)
    thdr = ["Monster"] + thdr[1:]
    tribute = [[clean(BR.sub(" ", c)) for c in r] for r in t["rows"] if len(r) == 5]
    need(len(tribute) >= 5 and any(r[0] == "Rare" for r in tribute), "tribute table: %r" % tribute)

    rew = section(w, "Rewards")
    favours = []
    for line in rew.split("\n===")[0].split("\n"):
        m = re.match(r"^([*#]+)\s*(.*)$", line)
        if m and m.group(2).strip() and current(m.group(2), "favour"):
            favours += _lines(line)

    def reward_rows(title):
        rows = []
        text = re.sub(r"\{\{il\|page=([^|}]+)\}\}", r"[[\1]]", section(rew, title))
        for head, subs in _bullet_rows(text):
            if not current(head + " " + " ".join(subs), title):
                continue
            h = clean(head).rstrip(":")
            subs = [s for s in subs if current(s, title)]
            if not subs:
                rows.append([h, "-"])
            for s in subs:
                for piece in _chunks(clean(s, limit=0)):
                    rows.append([h, piece])
        return rows

    exclusive = reward_rows("Ritual-exclusive rewards")
    generic = reward_rows("Generic rewards")
    need(any(r[0] == "An Audience With The King" for r in exclusive) and len(exclusive) >= 8,
         "ritual-exclusive rewards: %r" % exclusive[:3])
    need(len(generic) >= 15, "only %d generic reward rows" % len(generic))

    defer_gone = [l for _, ls in vh for l in ls if re.search(r"defer\w*.{0,60}(?:removed|no longer)", l, re.I)]
    defer = []
    if defer_gone:
        warn("ritual: deferral section left out: version history says %r (stale wiki)" % defer_gone[0])
    else:
        defer = _lines(section(rew, "Deferring rewards"))
        need(len(defer) >= 6 and any("50 items" in d for d in defer), "deferral rules not found")

    t = parse_table(wikitables(section(w, "Ritual variations"))[0])
    hdr = [_hclean(c) for c in t["header"]]
    need(hdr == ["Category", "Type", "Image", "Affixes"], "unexpected altar table %r" % hdr)
    altars = []
    for r in t["rows"]:
        if len(r) != 4 or not clean(r[1]):
            continue
        fx = _lines(r[3])
        hidden = [re.sub(r"^Hidden:\s*", "", x) for x in fx if x.startswith("Hidden:")]
        altars.append([clean(r[0]), clean(r[1]), clean("; ".join(x for x in fx if not x.startswith("Hidden:"))) or "-",
                       clean("; ".join(hidden)) or "-"])
    need(len(altars) >= 15 and any(a[1].startswith("Bitter") for a in altars), "only %d altar types" % len(altars))

    rscar = [[clean(r["name"]), _effect(r["effect"]), r.get("lim") or "-"] for r in _scarab_rows(cx)
             if html.unescape(r["name"]).startswith("Ritual Scarab")]

    sections = [table_section("Tribute per monster (by times it was revived in a Ritual)", thdr, tribute),
                list_section("Favours (spending Tribute)", favours),
                table_section("Ritual-exclusive rewards", ["Reward", "Includes"], exclusive),
                table_section("Generic rewards", ["Reward", "Includes"], generic)]
    if defer:
        sections.append(list_section("Deferring rewards", defer))
    sections.append(table_section("Altar types", ["Category", "Type", "Effects", "Hidden effect"], altars))
    if rscar:
        sections.append(table_section("Ritual scarabs (Cargo)", ["Scarab", "Effect", "Max per map"], rscar))
    return {"sections": sections, "source": "PoE Wiki: Ritual (rewards, deferring, altar types), Cargo items (scarabs)",
            "url": WIKI_PAGE + "Ritual"}


# ---------------------------------------------------------------------------------------------------
# Labyrinth
# ---------------------------------------------------------------------------------------------------

ENCHANT = re.compile(r"enchant", re.I)
LAB = "The Lord's Labyrinth"


def _no_enchant(rows, what):
    """Labyrinth enchants are no longer a lab reward (3.23): drop any row that still offers one."""
    out = []
    for r in rows:
        text = " ".join(r) if isinstance(r, list) else r
        if ENCHANT.search(text):
            warn("labyrinth: dropped %s row %r: lab enchants are no longer a Labyrinth reward (stale wiki)" % (what, text))
            continue
        out.append(r)
    return out


def m_labyrinth(cx):
    P = cx["pages"]
    w = P[LAB]
    lab_vh = dict(_vh_rows(w))
    font_change = [l for l in lab_vh.get("3.23.0", []) if "Divine Font" in l and "gem crafting" in l]
    need(font_change, "3.23.0 Divine Font change not in the Labyrinth version history")

    # labyrinths and their trials
    t = parse_table(wikitables(section(w, "Variations"))[0])
    hdr = [_hclean(c) for c in t["header"]]
    need(hdr == ["Labyrinth", "Area level", "Minimum character level", "Trial locations", "Reward"],
         "unexpected labyrinth table %r" % hdr)
    labs, trials, seen = [], [], set()
    for r in t["rows"]:
        if len(r) != 5:
            continue
        name = clean(re.sub(r"<br\s*/?>\s*(?=\()", " ", r[0]))
        labs.append([name, clean(r[1]) or "-", clean(r[2]) or "-", clean(r[4])])
        for loc in BR.split(r[3]):
            loc = clean(loc)
            if loc and loc not in seen:
                seen.add(loc)
                trials.append([name, loc])
    labs = _no_enchant(labs, "labyrinth")
    need(len(labs) >= 4 and any(l[0] == "The Eternal Labyrinth" for l in labs), "labyrinths: %r" % labs)
    need(len(trials) >= 12, "only %d trial locations" % len(trials))

    rules = _no_enchant(_lines(section(w, "Basic rules for all Labyrinths")), "rule")
    need(any("2/3" in r for r in rules), "Izaro life thresholds not in the basic rules")

    # Izaro's trial mechanics
    iz = P["Izaro"]
    enc = section(iz, "First Two Encounters")
    intro = [s for p in re.split(r"^====", enc, flags=re.M)[0].split("\n\n") for s in sentences(p) if p.strip()]
    mech = []
    for m in re.finditer(r"^====\s*(.+?)\s*====\s*$", enc, re.M):
        body = section(enc, m.group(1))
        paras = [p for p in body.split("\n\n") if p.strip() and not p.strip().startswith((":", "*", "[[File"))]
        sents = [s for p in paras for s in sentences(p)]
        trinket = re.search(r"possesses (?:an? )?\{\{il\|([^}|]+)", body)
        key = next((s for s in sents if "additional Treasure Key" in s), "")
        if not sents:
            continue
        mech.append([clean(m.group(1)), clean(sents[0]), clean(trinket.group(1)) if trinket else "-", clean(key) or "-"])
    need(len(mech) >= 7 and sum(1 for r in mech if r[2] != "-") >= 7, "only %d Izaro mechanics" % len(mech))
    third = [clean(s) for s in sentences(section(iz, "Third Encounter").split("\n\n")[-1]) if s]

    skills = []
    for who, tab in zip(["Izaro", "Goddess of Justice"], wikitables(section(iz, "Abilities"))):
        for r in parse_table(tab)["rows"]:
            if len(r) != 2 or not clean(r[0]) or clean(r[0]) == "Skill":
                continue
            s = sentences(r[1])
            skills.append([clean(r[0]), who, clean(s[0]) if s else "-", clean(" ".join(s[1:])) or "-"])
    need(len(skills) >= 6 and any(s[0] == "Ground Slam" for s in skills), "only %d Izaro skills" % len(skills))

    # chambers (door pedestal signs) and traps
    t = parse_table(wikitables(section(w, "Chambers"))[0])
    need([clean(c) for c in t["header"]] == ["Name", "Sign", "Notes"], "unexpected chamber table %r" % t["header"])
    chambers = [[clean(r[0]), n] for r in t["rows"] if len(r) == 3 for n in _lines(r[2])]
    chambers = _no_enchant(chambers, "chamber")
    need(len(chambers) >= 15 and any(c[0] == "Golden Door" for c in chambers), "only %d chamber notes" % len(chambers))

    t = parse_table(wikitables(section(w, "Traps"))[0])
    need([clean(c) for c in t["header"]] == ["Image", "Name", "Description"], "unexpected trap table %r" % t["header"])
    traps = []
    for r in t["rows"]:
        if len(r) != 3 or not clean(r[1]):
            continue
        lead = r[2].split("\n*")[0]
        lines = ([clean(s) for s in sentences(lead)[:1]] if lead.strip() else []) + _lines(r[2], skip=re.compile("showcased"))
        traps += [[clean(r[1]), l] for l in lines if l]
    need(len(traps) >= 15 and any(x[0] == "Sentinel traps" for x in traps), "only %d trap notes" % len(traps))

    # Divine Font
    font_vh = _vh_rows(P["Divine Font"])
    awakened_gone = any("Awakened" in l and "removed" in l for _, ls in font_vh for l in ls)
    lst = re.sub(r"</?onlyinclude>", "", P["List of Divine Font crafting options"])
    t = parse_table(wikitables(lst)[0])
    fhdr = [_hclean(c) for c in t["header"]]
    need(len(fhdr) == 7 and fhdr[:4] == ["Option", "Normal", "Cruel", "Merciless"], "unexpected font table %r" % fhdr)
    font = []
    for r in t["rows"]:
        if len(r) != 7:
            continue
        cells = [clean(re.sub(r"\{\{yes\}\}", "Yes", re.sub(r"\{\{no\}\}", "No", c))) or "-" for c in r]
        if awakened_gone and "Awakened" in cells[0]:
            warn("labyrinth: dropped font option %r: the Divine Font history says it was removed in 3.28 (stale wiki)"
                 % cells[0])
            continue
        font.append(cells)
    font = _no_enchant(font, "Divine Font")
    need(len(font) >= 6 and any(f[0].startswith("Transform a Skill Gem to be a random Transfigured Gem") for f in font),
         "only %d Divine Font options" % len(font))

    notes = ["3.23.0: " + l for l in lab_vh.get("3.23.0", []) if not l.startswith("(Hotfix")]
    notes = [clean(n) for n in notes]
    return {"sections": [
        table_section("Labyrinths", ["Labyrinth", "Area level", "Min. character level", "Reward"], labs),
        table_section("Trials of Ascendancy (unlock each labyrinth)", ["Labyrinth", "Trial location"], trials),
        list_section("Basic rules", rules),
        table_section("Izaro: trial mechanics (first two encounters)",
                      ["Mechanic", "What it does", "Trinket", "Extra Treasure Key if"], mech),
        list_section("Izaro: how the mechanics carry over", [clean(s) for s in intro] + third),
        table_section("Izaro and the Goddess of Justice: skills", ["Skill", "Used by", "Effect", "Notes"], skills),
        table_section("Chambers (door pedestal signs)", ["Chamber", "Note"], chambers),
        table_section("Traps", ["Trap", "Note"], traps),
        table_section("Divine Font crafting options by labyrinth", fhdr, font),
        list_section("Labyrinth changes in 3.23 (version history)", notes)],
        "source": "PoE Wiki: The Lord's Labyrinth, Izaro, List of Divine Font crafting options, Divine Font",
        "url": WIKI_PAGE + "The_Lord%27s_Labyrinth"}


# ---------------------------------------------------------------------------------------------------
# Scarabs
# ---------------------------------------------------------------------------------------------------

def m_scarabs(cx):
    w = cx["pages"]["Scarab"]
    rarity = {}
    for line in wikitables(section(w, "Table of scarabs"))[0].split("\n"):
        m = re.match(r"^\|\s*\{\{il\|([^|}]+)\|large=true\}\}\s*(.*)$", line.strip())
        if m:
            rarity[html.unescape(m.group(1)).lower()] = clean(re.sub(r"</?(?:sup|small)>", "", m.group(2)))
    need(len(rarity) >= 80, "scarab table on the Scarab page has only %d entries" % len(rarity))
    gone_lines = [l for _, ls in _vh_rows(w) for l in ls if "can no longer drop" in l]
    rows = []
    for r in _scarab_rows(cx):
        name = clean(r["name"])
        whole = re.compile(re.escape(name) + r"(?! of\b)(?![\w'])")  # "Legion Scarab" must not hit "... of Officers"
        hit = next((l for l in gone_lines if whole.search(l)), None)
        if hit:
            warn("scarabs: dropped %s: the Scarab page history says %r, but Cargo still has it drop-enabled "
                 "(stale data)" % (name, hit))
            continue
        rows.append([name, _effect(r["effect"]) or "-", r.get("lim") or "-", rarity.get(html.unescape(r["name"]).lower()) or "-"])
    names = [r[0] for r in rows]
    need(len(rows) >= 80 and "Horned Scarab of Preservation" in names and not any("Harbinger" in n for n in names),
         "only %d scarabs" % len(rows))
    acq = section(w, "Acquisition")
    notes = [clean(s) for s in sentences(acq.split("\n===")[0]) if s]
    recipe = [clean(s) for s in sentences(section(acq, "Vendor recipe")) if s]
    sections = [table_section("Scarabs: effect, limit per map, drop rarity",
                              ["Scarab", "Effect", "Max per map", "Drop rarity"], rows)]
    if notes or recipe:
        sections.append(list_section("Acquisition", notes + recipe))
    return {"sections": sections, "source": "PoE Wiki: Cargo items + map_fragments (class MapFragment), Scarab",
            "url": WIKI_PAGE + "Scarab"}


# ---------------------------------------------------------------------------------------------------
# Atlas
# ---------------------------------------------------------------------------------------------------

TIER_PAGE = re.compile(r"^Map \(Tier (\d+)\)$")


def m_atlas(cx):
    series = cargo("map_series", "map_series.name=name,map_series.ordinal=ord")
    series = [s for s in series if (s.get("ord") or "").isdigit()]
    need(series, "map_series is empty")
    cur = html.unescape(max(series, key=lambda s: int(s["ord"]))["name"])
    rows = cargo("maps,areas", "maps.tier=tier,maps.area_level=lvl,maps._pageName=page,maps.area_id=aid,"
                               "areas.is_unique_map_area=uniq",
                 where="maps.series='%s'" % cur.replace("'", "''"), join_on="maps.area_id=areas.id")
    generic = {}
    special = []
    for r in rows:
        page = html.unescape(r.get("page") or "")
        m = TIER_PAGE.match(page)
        if m and r.get("lvl"):
            generic[int(m.group(1))] = (r.get("tier"), r["lvl"])
        elif not r.get("aid") and page:
            special.append([page, r.get("tier") or "-", r.get("lvl") or "-"])
    if sorted(generic) != list(range(1, 17)):
        warn("atlas skipped: the current map series %r has %d Cargo rows but generic map tiers %r, not 1-16 "
             "(incomplete Cargo data)" % (cur, len(rows), sorted(generic)))
        raise Skip("map series %r incomplete" % cur)
    lv = [int(generic[t][1]) for t in range(1, 17)]
    need(all(str(t) == generic[t][0] for t in generic) and lv == sorted(lv) and len(set(lv)) == 16,
         "map tier / area level rows look wrong: %r" % generic)

    w = cx["pages"]["Atlas of Worlds"]
    prog = section(w, "Progressing through the Atlas")
    bands = [(int(a), int(b), c) for a, b, c in
             re.findall(r"Tiers (\d+) through (\d+) are marked \W*(\w+)", clean(prog, limit=0))]
    need(len(bands) == 3, "tier colour bands not found: %r" % bands)
    band = lambda t: next((c for a, b, c in bands if a <= t <= b), "-")
    tiers = [[str(t), generic[t][1], band(t)] for t in range(1, 17)]
    special.sort(key=lambda s: (int(s[1]) if s[1].isdigit() else 99, s[0]))

    t = parse_table(wikitables(prog)[0])
    quads = [clean(c) for c in t["rows"][0]] if t["rows"] else []
    need(len(quads) == 4 and all(q.endswith("Quadrant") for q in quads), "quadrants: %r" % quads)
    qn = [q.replace(" Quadrant", "") for q in quads]
    regular, uniques, count = [], [], 0
    for r in t["rows"]:
        if len(r) < 12 or not clean(r[0]).isdigit():
            continue
        tier = clean(r[0])
        need(all(clean(r[3 * q]) == tier for q in range(4)), "tier columns disagree in row %r" % tier)
        maps = [[clean(x) for x in BR.split(r[3 * q + 1]) if clean(x)] for q in range(4)]
        uq = [[clean(x) for x in BR.split(r[3 * q + 2]) if clean(x)] for q in range(4)]
        count += sum(len(m) for m in maps)
        regular.append([tier] + [", ".join(m) or "-" for m in maps])
        if any(uq):
            uniques.append([tier] + [clean(", ".join(u)) or "-" for u in uq])
    total = re.search(r"comprised (\d+) different regular maps", clean(w, limit=0))
    need(total and count == int(total.group(1)) and len(regular) == 16,
         "atlas table has %d regular maps in %d tiers; page says %s" % (count, len(regular), total and total.group(1)))

    # every regular map must be a current (non-legacy) map area in Cargo
    names = sorted(set(n for r in regular for c in r[1:] for n in c.split(", ") if n != "-"))
    found = cargo("areas", "areas.name=name,areas.id=id,areas.is_legacy_map_area=legacy",
                  where="areas.is_map_area=1 AND areas.name IN (%s)" % ",".join("'%s'" % n.replace("'", "''") for n in names))
    have = {html.unescape(a["name"] or "") for a in found if a.get("legacy") != "1"}
    missing = [n for n in names if n not in have]
    need(len(missing) <= 3, "%d atlas maps are not current map areas in Cargo: %r" % (len(missing), missing[:10]))
    if missing:
        warn("atlas: %d map names on the Atlas table have no current map area in Cargo: %s" % (len(missing), missing))

    t = parse_table(wikitables(section(w, "Atlas Endgame"))[0])
    need(len(t["rows"]) >= 4 and [clean(c) for c in t["rows"][0]] == quads, "unexpected endgame table")
    voids = [clean(c) for c in t["rows"][1]]
    endmaps, pinnacles = [], []
    for q, cell in enumerate(t["rows"][2]):
        kind = None
        for part in BR.split(cell):
            k = re.match(r"^\s*'''(.+?):'''\s*$", part)
            if k:
                kind = clean(k.group(1))
            elif clean(part) and kind:
                endmaps.append([qn[q], kind, clean(part)])
    for q, cell in enumerate(t["rows"][3]):
        for part in BR.split(cell)[1:]:
            p = clean(part)
            if " in " in p:
                boss, arena = p.rsplit(" in ", 1)
                pinnacles.append([qn[q], voids[q], boss, arena])
    need(len(pinnacles) >= 8 and any(p[2] == "The Maven" for p in pinnacles), "only %d pinnacle bosses" % len(pinnacles))
    return {"sections": [
        table_section("Map item tiers (%s series; maps are no longer tied to one area)" % cur,
                      ["Tier", "Area level", "Colour"], tiers),
        table_section("Special map items (%s series)" % cur, ["Map item", "Tier", "Area level"], special),
        table_section("Regular maps by tier and quadrant", ["Tier"] + qn, regular),
        table_section("Unique maps and special areas by tier and quadrant", ["Tier"] + qn, uniques),
        table_section("Quadrant endgame maps", ["Quadrant", "Kind", "Map"], endmaps),
        table_section("Pinnacle bosses by quadrant", ["Quadrant", "Voidstone corner", "Boss", "Arena"], pinnacles)],
        "source": "PoE Wiki: Cargo maps, map_series, areas; Atlas of Worlds", "url": WIKI_PAGE + "Atlas_of_Worlds"}


# id, title, group, builder, area-id prefixes / exact ids for "match" (None: none), exact area names to look up
MECHANICS = [
    ("syndicate", "Betrayal (Syndicate)", "League mechanics", m_syndicate, ["BetrayalSafeHouse", "BetrayalMastermindFight"], []),
    ("eldritch", "Eldritch altars", "Endgame", m_eldritch, None, []),
    ("blight", "Blight (oils and anoints)", "League mechanics", m_blight, None, []),
    ("corruption", "Corruption (Vaal Orb)", "Crafting", m_corruption, None, []),
    ("delve", "Delve (fossils, biomes)", "League mechanics", m_delve, ["Delve"], []),
    ("bestiary", "Bestiary recipes", "Crafting", m_bestiary, ["Menagerie_"], []),
    ("incursion", "Incursion (Temple of Atzoatl)", "League mechanics", m_incursion, ["Incursion_"], []),
    ("harvest", "Harvest crafting", "Crafting", m_harvest, ["HarvestLeague"], []),
    ("expedition", "Expedition (vendors, logbooks)", "League mechanics", m_expedition, ["Expedition"], []),
    ("sanctum", "Sanctum (afflictions, boons, bosses)", "League mechanics", m_sanctum, ["Sanctum"], []),
    ("vendor", "Vendor recipes", "Crafting", m_vendor, None, []),
    ("kingsmarch", "Kingsmarch shipping", "League mechanics", m_kingsmarch, [], ["Kingsmarch"]),
    ("pantheon", "Pantheon", "Endgame", m_pantheon, [], []),
    ("essences", "Essences", "Crafting", m_essences, None, []),
    ("ultimatum", "Ultimatum modifiers", "League mechanics", m_ultimatum,
     ["UltimatumArena", "UltimatumBossArena", "MapWorldsUltimatumBossArena"], []),
    ("heist", "Heist (rogues, jobs, blueprints)", "League mechanics", m_heist, ["Heist"], []),
    ("breach", "Breach (hives, wombgifts)", "League mechanics", m_breach, ["ChayulaLeagueTower"], []),
    ("legion", "Legion (emblems, timeless jewels)", "League mechanics", m_legion, ["LegionLeague"], []),
    ("abyss", "Abyss", "League mechanics", m_abyss, ["AbyssLeagueBoss"], []),
    ("delirium", "Delirium (rewards, orbs, Simulacrum)", "League mechanics", m_delirium, ["AfflictionTown"], []),
    ("ritual", "Ritual (rewards and deferring)", "League mechanics", m_ritual, None, []),
    ("labyrinth", "Labyrinth (Izaro, trials, Divine Font)", "Endgame", m_labyrinth,
     ["1_Labyrinth", "2_Labyrinth", "3_Labyrinth", "EndGame_Labyrinth", "Labyrinth_Airlock"], []),
    ("scarabs", "Scarabs", "Endgame", m_scarabs, None, []),
    ("atlas", "Atlas of Worlds (map tiers, quadrants)", "Endgame", m_atlas, None, []),
]
PAGES = ["Immortal Syndicate", "Syndicate Mastermind", "Eldritch altar", "Incursion room", "Delve", "Expedition",
         "Expedition Logbook", "Gwennen", "Tujen", "Rog", "Dannig", "Vaal Orb", "The Forbidden Sanctum",
         "Vendor recipe system", "Kingsmarch", "Ultimatum",
         "Heist", "Grand Heist", "List of Rogues", "List of Heist Reward Chests", "Breach", "Legion", "Abyss",
         "Abyssal Depths", "Delirium", "Simulacrum",
         "Ritual", "The Lord's Labyrinth", "Izaro", "List of Divine Font crafting options", "Divine Font", "Scarab",
         "Atlas of Worlds"]


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
    print("Building act routes and quest gems:")
    try:
        qlist = quest_list(pages(["Quest"])["Quest"])
        cx = {"quests": qlist, "quest_pages": pages(sorted(set(q for qs in qlist.values() for q in qs)), chunk=50)}
        routes, report = act_routes(cx, tri, quests)
        gems = quest_gems(cx)
    except Exception as e:  # the leveling part is required: do not write a half-built file
        print("act route / quest gems failed (%s: %s); not writing" % (type(e).__name__, e))
        return 1
    for act in range(1, 11):
        acts[act]["route"] = routes[act]
        acts[act]["gems"] = gems.get(act, [])
        r = report[act]
        print("  act %-2d route %2d zones (main path %2d)%s%s; %d gem quests" % (
            act, r["entries"], r["main"], "; side areas left out: " + ", ".join(r["skipped"]) if r["skipped"] else "",
            "; quests without a zone: " + ", ".join(r["unplaced"]) if r["unplaced"] else "", len(acts[act]["gems"])))
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
    print("%d wiki API calls, server JSON %d bytes" % (CALLS[0], len(payload.encode("utf-8"))))
    if WARNINGS:
        print("%d warnings:" % len(WARNINGS))
        for w in WARNINGS:
            print("  - " + w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
