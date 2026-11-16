"""69 stage — one Stage switch for a PoB build (03-shell.js, PoB.buildStages in js/pob.js): a build
with 3 gear sets, 3 skill sets and 3 trees named alike gets a 3-stage control in the top bar of every
build view; switching changes the gear cards, the Gems view and the tree together (and the in-game
sheet's gems); the pick is remembered for that build; a one-stage build shows no control; the
per-slot gear set dropdown still works."""
import base64
import os
import re
import zlib

TAG = "69 stage"
HERE = os.path.dirname(os.path.abspath(__file__))

STAGES = ["Leveling", "Budget", "Endgame"]
# per stage: (helmet, body armour, ring) names, main skill, its support
GEAR = [("Dusk Crown", "Grim Shell", "Woe Loop"), ("Storm Crown", "Rune Shell", "Pain Loop"),
        ("Doom Crown", "Hate Shell", "Viper Loop")]
GEMS = [("Freezing Pulse", "Added Cold Damage"), ("Frostbolt", "Controlled Destruction"), ("Ice Nova", "Elemental Focus")]


def _fixture_tree():
    code = open(os.path.join(HERE, "..", "fixture-realbuild.txt"), encoding="utf-8").read().strip()
    xml = zlib.decompress(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))).decode("utf-8")
    spec = re.search(r"<Spec\b[^>]*>", xml).group(0)
    nodes = re.search(r'nodes="([^"]*)"', spec).group(1).split(",")
    version = re.search(r'treeVersion="([^"]*)"', spec).group(1)
    return nodes, version


def _item(i, name, base, life):
    return ('<Item id="%d">Rarity: RARE\n%s\n%s\nItem Level: 80\nImplicits: 0\n+%d to maximum Life\n'
            '+%d%% to Fire Resistance</Item>' % (i, name, base, life, life // 3))


def stage_code():
    nodes, version = _fixture_tree()
    items, sets, skills, specs = [], [], [], []
    iid = 1
    items.append(_item(99, "Kraken Grip", "Wool Gloves", 40))  # the same gloves in every set
    for s, title in enumerate(STAGES):
        ids = []
        for name, base in zip(GEAR[s], ("Iron Hat", "Simple Robe", "Iron Ring")):
            items.append(_item(iid, name, base, 30 + 20 * s))
            ids.append(iid)
            iid += 1
        sets.append('<ItemSet id="%d" title="%s"><Slot name="Helmet" itemId="%d"/><Slot name="Body Armour" itemId="%d"/>'
                    '<Slot name="Ring 1" itemId="%d"/><Slot name="Gloves" itemId="99"/></ItemSet>' % (s + 1, title, ids[0], ids[1], ids[2]))
        main, sup = GEMS[s]
        skills.append('<SkillSet id="%d" title="%s"><Skill enabled="true" slot="Body Armour" label="">'
                      '<Gem nameSpec="%s" gemId="Metadata/Items/Gems/X%d" level="20" quality="0" enabled="true"/>'
                      '<Gem nameSpec="%s" gemId="Metadata/Items/Gems/Y%d" level="20" quality="0" enabled="true"/>'
                      '</Skill></SkillSet>' % (s + 1, title, main, s, sup, s))
        # a different-sized tree per stage (Leveling uses the stage name in another case: matched anyway)
        n = nodes[: [30, 70, len(nodes)][s]]
        specs.append('<Spec title="%s" treeVersion="%s" classId="3" ascendClassId="2" nodes="%s"/>'
                     % (title.upper() if s == 0 else title, version, ",".join(n)))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<PathOfBuilding>\n'
           '<Build level="90" className="Witch" ascendClassName="Elementalist" mainSocketGroup="1" targetVersion="3_0"></Build>\n'
           '<Skills activeSkillSet="3">%s</Skills>\n<Tree activeSpec="3">%s</Tree>\n'
           '<Items activeItemSet="3">%s%s</Items>\n</PathOfBuilding>') % ("".join(skills), "".join(specs), "\n".join(items), "".join(sets))
    return base64.urlsafe_b64encode(zlib.compress(xml.encode("utf-8"), 9)).decode("ascii"), len(nodes)


APP = r"""
const H = window.__e2e;
const out = {};
const slot = () => document.getElementById('stage-slot');
const segs = () => slot() ? [...slot().querySelectorAll('.seg')] : [];
const checked = () => (segs().find(b => b.getAttribute('aria-checked') === 'true') || {}).textContent || null;
const gear = () => H.gearCards().map(c => H.text('.slot-tag', c) + '=' + H.text('.item-name', c)).sort();
const gemsText = () => (document.querySelector('#results > .tab-section[data-tab="gems"]') || {}).textContent || '';
const gemsHas = () => ['Freezing Pulse', 'Frostbolt', 'Ice Nova'].filter(n => gemsText().includes(n));
const treeSel = () => { const s = document.querySelector('#results select.tv-stage-select'); return s && s.value; };
const treeNodes = () => TREEVIEW && TREEVIEW.b.tree.nodes.length;
const sheetGems = () => (JSON.parse(localStorage.getItem('pobtf-sheet-build') || '{}').gems || []);
const mem = () => JSON.parse(localStorage.getItem('pobtf-stage') || '{}');
const snap = () => ({ checked: checked(), gear: gear(), gems: gemsHas(), tree: treeSel(), nodes: treeNodes(),
  main: (build.mainSkill || [])[0], sheet: sheetGems().filter(n => ['Freezing Pulse', 'Frostbolt', 'Ice Nova'].includes(n)) });

await H.loadBuild(CODE);
out.first = Object.assign(snap(), { visible: H.visible(slot()), labels: segs().map(b => b.textContent),
  role: slot() && slot().querySelector('[role="radiogroup"]').getAttribute('aria-label'),
  sub: H.text('#build-sub'), gearPicker: document.querySelectorAll('#set-picker-slot select').length,
  inTopbar: !!(slot() && slot().closest('#topbar')) });
out.views = {};
for (const v of ['gems', 'tree', 'planner', 'flasks', 'market', 'sheets', 'gear']) { setView(v); out.views[v] = H.visible(slot()); }

// switch to Leveling: gear, gems, tree, sheet gems together
segs()[0].click();
await H.sleep(150);
out.lev = Object.assign(snap(), { mem: mem() });
// keyboard: arrow right moves to Budget and keeps focus on the control
segs()[0].focus();
segs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
await H.sleep(150);
out.kb = Object.assign(snap(), { focusInSlot: slot().contains(document.activeElement), focused: document.activeElement.textContent });
setView('tree');
await H.sleep(50);
out.treeView = { sel: treeSel(), stage: checked(), visible: H.visible(slot()) };
setView('gear');

// the per-slot dropdown still mixes sets: the Endgame helmet in the Budget stage
const helm = H.gearCard('Helmet');
const mini = helm.querySelector('select.set-mini');
out.perSlot = { opts: mini ? [...mini.options].map(o => o.textContent) : null, value: mini && mini.value,
  gloves: !!H.gearCard('Gloves').querySelector('select.set-mini') };
if (mini) { mini.value = '2'; mini.dispatchEvent(new Event('change')); await H.sleep(80); }
out.perSlot.after = H.text('.item-name', H.gearCard('Helmet'));
out.perSlot.ring = H.text('.item-name', H.gearCard('Ring 1'));
out.perSlot.stage = checked();

// a one-stage build: no control, the old wording
await H.loadBuild();
out.single = { hidden: !H.visible(slot()), segs: segs().length, sub: H.text('#build-sub'),
  stages: stageList(build).length };
// the staged build again: Budget comes back
await H.loadBuild(CODE);
out.restored = snap();
// back to PoB's own stage: nothing left to remember
segs()[2].click();
await H.sleep(150);
out.back = Object.assign(snap(), { mem: Object.keys(mem()).length });
return out;
"""


def run(s, tag, check):
    code, all_nodes = stage_code()
    s.fresh()
    r = s.run(APP, timeout=90, CODE=code)
    f = r["first"]
    check(tag + " the Stage control shows 3 stages in the top bar, PoB's active one picked and marked",
          f["visible"] and f["inTopbar"] and f["role"] == "Stage" and
          f["labels"] == ["Leveling", "Budget", "Endgame (active in PoB)"] and f["checked"] == "Endgame (active in PoB)", f)
    check(tag + " build card says '3 stages'; the old whole-build gear set select is gone",
          (f["sub"] or "").endswith("· 3 stages") and f["gearPicker"] == 0, (f["sub"], f["gearPicker"]))
    check(tag + " loads on PoB's active stage: Endgame gear, gems and tree",
          "Helmet=Doom Crown" in f["gear"] and f["gems"] == ["Ice Nova"] and f["tree"] == "2" and f["nodes"] == all_nodes, f)
    v = r["views"]
    check(tag + " shown on every build view, not on the tools without a build",
          v["gems"] and v["tree"] and v["planner"] and v["flasks"] and v["gear"] and not v["market"] and not v["sheets"], v)
    lv = r["lev"]
    check(tag + " Leveling: gear cards switch to the Leveling set",
          lv["checked"] == "Leveling" and lv["gear"] == sorted(["Helmet=Dusk Crown", "Body Armour=Grim Shell", "Ring 1=Woe Loop",
                                                               "Gloves=Kraken Grip"]), lv)
    check(tag + " Leveling: the Gems view and main skill switch to the Leveling skill set",
          lv["gems"] == ["Freezing Pulse"] and lv["main"] == "Freezing Pulse", lv)
    check(tag + " Leveling: the tree switches to its spec (name matched across case), its own select follows",
          lv["tree"] == "0" and lv["nodes"] == 30, (lv["tree"], lv["nodes"]))
    check(tag + " Leveling: the in-game sheet's gems follow", lv["sheet"] == ["Freezing Pulse"], lv["sheet"])
    check(tag + " the pick is remembered for this build", any(e.get("t") == "Leveling" and e.get("i") == 0 for e in lv["mem"].values()),
          lv["mem"])
    kb = r["kb"]
    check(tag + " keyboard: ArrowRight picks Budget and focus stays on the control",
          kb["checked"] == "Budget" and kb["focusInSlot"] and kb["focused"] == "Budget" and kb["gems"] == ["Frostbolt"] and
          kb["nodes"] == 70 and "Helmet=Storm Crown" in kb["gear"], kb)
    tv = r["treeView"]
    check(tag + " Skill tree view: its stage select shows the Budget tree, the Stage control is there",
          tv["sel"] == "1" and tv["stage"] == "Budget" and tv["visible"], tv)
    ps = r["perSlot"]
    check(tag + " per-slot dropdown still mixes sets (Endgame helmet in the Budget stage, gloves shared: none)",
          ps["opts"] == STAGES and ps["value"] == "1" and not ps["gloves"] and ps["after"] == "Doom Crown" and
          ps["ring"] == "Pain Loop" and ps["stage"] == "Budget", ps)
    sg = r["single"]
    check(tag + " a one-stage build shows no control", sg["hidden"] and sg["segs"] == 0 and sg["stages"] == 1 and
          "stage" not in (sg["sub"] or ""), sg)
    rs = r["restored"]
    check(tag + " loading the build again restores Budget: gear, gems, tree together",
          rs["checked"] == "Budget" and "Helmet=Storm Crown" in rs["gear"] and rs["gems"] == ["Frostbolt"] and rs["tree"] == "1" and
          rs["sheet"] == ["Frostbolt"], rs)
    bk = r["back"]
    check(tag + " back to PoB's stage: Endgame again, and nothing stored for the build",
          bk["checked"] == "Endgame (active in PoB)" and bk["gems"] == ["Ice Nova"] and bk["mem"] == 0, bk)
