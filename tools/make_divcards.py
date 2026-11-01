"""Generate the div card drop data: data/divcards.json (bundled with the app) and
server/public/divcards.json (served by the app's backend, so installed apps pick up newer drop
data between releases).

Source: the community Path of Exile Wiki's Cargo tables (items + stackables, then areas),
content CC BY-NC-SA 3.0. Run on a normal PC: the wiki refuses datacenter addresses, so the
backend serves this file instead of asking the wiki itself.
  python tools/make_divcards.py

Card art ("i"): GGG's CDN serves it at https://web.poecdn.com/image/divination-card/<i>.png.
No public source lists those names any more: the wiki's card_art field is the wiki's own
file, and poe.ninja moved cards to its exchange overview, which has no artFilename. So the
name is guessed, then checked here, at build time (never by the app): first from the card's
metadata id (…/DivinationCardAChillingWind -> AChillingWind), else from the wiki's card_art
file name ("File:A Chilling Wind card art.png" -> AChillingWind). One HEAD request per
candidate, 0.2 s apart; a card whose candidates all 404 gets no "i" and the app shows no image.
Results are kept in tools/divcard_art_checked.json, so reruns only check new names (misses
are checked again after ART_RECHECK_DAYS).
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
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI = "https://www.poewiki.net/w/api.php"
UA = "PoBTradeFinder data build (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)"
PAGE, AREA_CHUNK = 500, 40
SOURCE = "Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0"
ART_CDN = "https://web.poecdn.com/image/divination-card/%s.png"
ART_CHECKED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "divcard_art_checked.json")
ART_PACE, ART_RECHECK_DAYS = 0.2, 30


class _RewardParser(HTMLParser):
    """The wiki's reward markup -> lines of [text, colour]: <span class="tc -unique">…</span>
    sets the colour (unique, currency, divination, gem, magic, rare, normal, corrupted, …),
    <br> starts a new line; everything else is plain text."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines, self.stack = [[]], []

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.lines.append([])
            return
        if tag == "span":
            cls = dict(attrs).get("class") or ""
            m = re.search(r"(?:^|\s)-([a-z]+)", cls) if re.search(r"(?:^|\s)tc(?:\s|$)", cls) else None
            self.stack.append(m.group(1) if m else None)

    def handle_startendtag(self, tag, attrs):
        if tag == "br":
            self.lines.append([])

    def handle_endtag(self, tag):
        if tag == "span" and self.stack:
            self.stack.pop()

    def handle_data(self, data):
        colour = next((c for c in reversed(self.stack) if c), "default")
        line = self.lines[-1]
        if line and line[-1][1] == colour:
            line[-1][0] += data
        else:
            line.append([data, colour])


def wiki_text(s):
    """Wiki markup -> HTML a parser can read: no file links, [[Page|Shown]] -> Shown, and the
    hover pop-up copies (hoverbox__display) dropped so an item isn't named twice."""
    s = html.unescape(s or "")
    s = re.sub(r'<span class="hoverbox__display[^"]*">.*?</span>', "", s, flags=re.S)
    s = re.sub(r"\[\[File:[^\]]*\]\]", "", s)
    s = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    return s


def parse_reward(desc):
    """Reward lines for the card picture: [[[text, colour], ...], ...], blank lines dropped."""
    p = _RewardParser()
    p.feed(wiki_text(desc))
    p.close()
    out = []
    for line in p.lines:
        segs = [[re.sub(r"\s+", " ", t), c] for t, c in line if t.strip()]
        if segs:
            segs[0][0] = segs[0][0].lstrip()
            segs[-1][0] = segs[-1][0].rstrip()
            out.append(segs)
    return out


def parse_flavour(text):
    """Flavour text as plain lines joined by newlines ("" when the card has none)."""
    s = re.sub(r"<br\s*/?>", "\n", wiki_text(text), flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return "\n".join(line.strip() for line in s.split("\n") if line.strip())


def cargo(params):
    q = dict(action="cargoquery", format="json", **params)
    req = urllib.request.Request(WIKI + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8"))
    if d.get("error"):
        raise RuntimeError("wiki: %s" % d["error"].get("info"))
    time.sleep(0.5)  # be gentle with a community wiki
    # Cargo returns text HTML-escaped ("Assassin&#039;s Favour"): unescape, or names miss the
    # exchange's ("Assassin's Favour") and cards go unpriced
    return [{k: html.unescape(v) if isinstance(v, str) else v for k, v in x["title"].items()}
            for x in d.get("cargoquery", [])]


def art_exists(name):
    """HEAD the CDN art: True on an image, False on 404, None when the answer is unclear."""
    req = urllib.request.Request(ART_CDN % name, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return (r.headers.get("Content-Type") or "").startswith("image/")
    except urllib.error.HTTPError as e:
        return False if e.code in (403, 404) else None
    except Exception:
        return None
    finally:
        time.sleep(ART_PACE)


def art_candidates(row):
    """GGG art name guesses for a card, best first, without duplicates."""
    out = []
    m = re.fullmatch(r"Metadata/Items/DivinationCards/DivinationCard(\w+)", row.get("mid") or "")
    if m:
        out.append(m.group(1))
    f = re.fullmatch(r"(?:File:)?(.+?) card art\.png", row.get("art") or "", re.I)
    if f:
        name = re.sub(r"[^A-Za-z0-9]", "", f.group(1))
        if name and name not in out:
            out.append(name)
    return out


def check_art(rows):
    """{card name: GGG art name} for the cards whose art the CDN serves, plus counts."""
    try:
        with open(ART_CHECKED, "r", encoding="utf-8") as f:
            checked = json.load(f)  # art name -> true (served) | "YYYY-MM-DD" (404 on that day)
    except (OSError, ValueError):
        checked = {}
    today = time.strftime("%Y-%m-%d", time.gmtime())
    stale = time.strftime("%Y-%m-%d", time.gmtime(time.time() - ART_RECHECK_DAYS * 86400))
    found, counts, requests = {}, {"first": 0, "second": 0, "none": 0}, 0
    for r in rows:
        for n, cand in enumerate(art_candidates(r)):
            known = checked.get(cand)
            if known is True:
                ok = True
            elif isinstance(known, str) and known > stale:
                ok = False
            else:
                ok = art_exists(cand)
                requests += 1
                if ok is not None:
                    checked[cand] = True if ok else today
            if ok:
                found[r["name"]] = cand
                counts["first" if n == 0 else "second"] += 1
                break
        else:
            counts["none"] += 1
    tmp = ART_CHECKED + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(checked.items())), f, indent=0, separators=(",", ":"))
    os.replace(tmp, ART_CHECKED)
    counts["requests"] = requests
    return found, counts


def build():
    rows = []
    for offset in range(0, 5000, PAGE):
        page = cargo({"tables": "items,stackables,divination_cards",
                      "join_on": "items._pageID=stackables._pageID,items._pageID=divination_cards._pageID",
                      "fields": "items.name=name,items.drop_areas=areas,items.drop_enabled=enabled,"
                                "items.metadata_id=mid,divination_cards.card_art=art,stackables.stack_size=stack,"
                                "items.description=desc,items.flavour_text=flav",
                      "where": 'items.class_id="DivinationCard"', "order_by": "items.name",
                      "limit": str(PAGE), "offset": str(offset)})
        rows += page
        if len(page) < PAGE:
            break
    ids = sorted({a.strip() for r in rows for a in (r.get("areas") or "").split(",") if a.strip()})
    ids = [i for i in ids if re.fullmatch(r"[\w-]+", i)]
    areas = {}
    for i in range(0, len(ids), AREA_CHUNK):
        chunk = ids[i:i + AREA_CHUNK]
        for a in cargo({"tables": "areas", "fields": "areas.id=id,areas.name=name,areas.area_level=lvl,areas.is_map_area=map",
                        "where": "areas.id IN (%s)" % ",".join('"%s"' % x for x in chunk), "limit": str(PAGE)}):
            areas.setdefault(a["id"], {"name": a["name"], "lvl": int(a["lvl"]) if (a.get("lvl") or "").isdigit() else None,
                                       "map": a.get("map") == "1"})
    area_ids = sorted(areas)
    index = {a: i for i, a in enumerate(area_ids)}
    arts, art_counts = check_art(rows)
    cards = []
    for r in rows:
        o = {"n": r["name"], "s": int(r["stack"]) if (r.get("stack") or "").isdigit() else 1}
        a = [index[x.strip()] for x in (r.get("areas") or "").split(",") if x.strip() in index]
        if a:
            o["a"] = a
        if r.get("enabled") != "1":
            o["off"] = 1
        if r["name"] in arts:
            o["i"] = arts[r["name"]]
        reward, flavour = parse_reward(r.get("desc")), parse_flavour(r.get("flav"))
        if reward:
            o["r"] = reward   # what the full set gives, coloured like the card: [[[text, colour], ...], ...]
        if flavour:
            o["f"] = flavour  # flavour text, "\n" between lines
        cards.append(o)
    print("Card art: %(first)d matched on the first guess, %(second)d on the second, %(none)d not at all "
          "(%(requests)d CDN checks this run)" % art_counts)
    return {"source": SOURCE, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "areas": [dict(id=i, **areas[i]) for i in area_ids], "cards": cards}


def main():
    data = build()
    if len(data["cards"]) < 100:
        print("wiki returned only %d cards; not writing" % len(data["cards"]))
        return 1
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    for path in (os.path.join(ROOT, "data", "divcards.json"), os.path.join(ROOT, "server", "public", "divcards.json")):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
    print("Wrote data/divcards.json + server/public/divcards.json: %d cards (%d with drop areas, %d with art), "
          "%d areas (%d maps)"
          % (len(data["cards"]), sum(1 for c in data["cards"] if "a" in c), sum(1 for c in data["cards"] if "i" in c),
             len(data["areas"]),
             sum(1 for a in data["areas"] if a["map"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
