"""Character gem links — run: python test/test_char_links.py

Api._char_links turns a get-items item's sockets + socketedItems into link groups for the
gem-setup compare: links per group, gems with level/quality, abyss jewels and bag items skipped."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


def gem(name, socket, level="20", quality="+20%", frame=4):
    props = [{"name": "Level", "values": [[level, 0]], "displayMode": 0}]
    if quality is not None:
        props.append({"name": "Quality", "values": [[quality, 1]], "displayMode": 0})
    return {"typeLine": name, "socket": socket, "frameType": frame, "properties": props}


helm = {
    "inventoryId": "Helm",
    # a 4-link and a separate 2-link
    "sockets": [{"group": 0, "sColour": "R"}, {"group": 0, "sColour": "G"}, {"group": 0, "sColour": "B"},
                {"group": 0, "sColour": "B"}, {"group": 1, "sColour": "W"}, {"group": 1, "sColour": "A"}],
    "socketedItems": [
        gem("Kinetic Blast of Clustering", 0, "21 (Max)", "+23%"),
        gem("Greater Multiple Projectiles Support", 1),
        gem("Awakened Added Cold Damage Support", 3, "5", None),
        gem("Clarity", 4, "1", "+0%"),
        {"typeLine": "Hypnotic Eye Jewel", "socket": 5, "frameType": 2, "abyssJewel": True},
    ],
}
g = gui.Api._char_links(helm)
check("two groups in socket order", len(g) == 2 and [x["links"] for x in g] == [4, 2], g)
check("gems in their group", [x["name"] for x in g[0]["gems"]] ==
      ["Kinetic Blast of Clustering", "Greater Multiple Projectiles Support", "Awakened Added Cold Damage Support"], g[0])
check("level/quality parsed from '21 (Max)' / '+23%'", g[0]["gems"][0]["level"] == 21 and g[0]["gems"][0]["quality"] == 23,
      g[0]["gems"][0])
check("missing quality is 0", g[0]["gems"][2]["quality"] == 0 and g[0]["gems"][2]["level"] == 5, g[0]["gems"][2])
check("abyss jewel isn't a gem", [x["name"] for x in g[1]["gems"]] == ["Clarity"], g[1])
check("sockets keep colour and gem, empty ones too", g[0]["sockets"] == [
    {"c": "R", "gem": "Kinetic Blast of Clustering"}, {"c": "G", "gem": "Greater Multiple Projectiles Support"},
    {"c": "B", "gem": ""}, {"c": "B", "gem": "Awakened Added Cold Damage Support"}], g[0]["sockets"])
check("abyss socket shows as empty", g[1]["sockets"] == [{"c": "W", "gem": "Clarity"}, {"c": "A", "gem": ""}], g[1]["sockets"])

check("bag items have no setups", gui.Api._char_links(dict(helm, inventoryId="MainInventory")) == [])
check("weapon swap counts", len(gui.Api._char_links(dict(helm, inventoryId="Weapon2"))) == 2)
check("no sockets, no groups", gui.Api._char_links({"inventoryId": "Amulet"}) == [])
check("empty link group kept for the socket picture", gui.Api._char_links({"inventoryId": "Boots", "sockets": [{"group": 0}],
      "socketedItems": []}) == [{"links": 1, "gems": [], "sockets": [{"c": "W", "gem": ""}]}])

print("ALL TESTS PASSED" if not failures else "%d FAILED" % failures)
sys.exit(1 if failures else 0)
