"""Generate the div card drop data: data/divcards.json (bundled with the app) and
server/public/divcards.json (served by the app's backend, so installed apps pick up newer drop
data between releases).

Source: the community Path of Exile Wiki's Cargo tables (items + stackables, then areas),
content CC BY-NC-SA 3.0. Run on a normal PC: the wiki refuses datacenter addresses, so the
backend serves this file instead of asking the wiki itself.
  python tools/make_divcards.py
"""
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
PAGE, AREA_CHUNK = 500, 40
SOURCE = "Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0"


def cargo(params):
    q = dict(action="cargoquery", format="json", **params)
    req = urllib.request.Request(WIKI + "?" + urllib.parse.urlencode(q), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8"))
    if d.get("error"):
        raise RuntimeError("wiki: %s" % d["error"].get("info"))
    time.sleep(0.5)  # be gentle with a community wiki
    return [x["title"] for x in d.get("cargoquery", [])]


def build():
    rows = []
    for offset in range(0, 5000, PAGE):
        page = cargo({"tables": "items,stackables", "join_on": "items._pageID=stackables._pageID",
                      "fields": "items.name=name,items.drop_areas=areas,items.drop_enabled=enabled,"
                                "stackables.stack_size=stack",
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
    cards = []
    for r in rows:
        o = {"n": r["name"], "s": int(r["stack"]) if (r.get("stack") or "").isdigit() else 1}
        a = [index[x.strip()] for x in (r.get("areas") or "").split(",") if x.strip() in index]
        if a:
            o["a"] = a
        if r.get("enabled") != "1":
            o["off"] = 1
        cards.append(o)
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
    print("Wrote data/divcards.json + server/public/divcards.json: %d cards (%d with drop areas), %d areas (%d maps)"
          % (len(data["cards"]), sum(1 for c in data["cards"] if "a" in c), len(data["areas"]),
             sum(1 for a in data["areas"] if a["map"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
