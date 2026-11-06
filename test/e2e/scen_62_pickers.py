"""62 pickers — the pick-and-check helpers and the temple planner (js/app/43-pickers.js).

The tool data is a small TEST fixture (FIX below: made-up entries in the real shape), put into
POE_GUIDES.tools before the sheets open, so the checks don't depend on the research content:
- Eldritch altar picker in the app: rows, a marked deadly downside gives the red verdict, a build
  tag turns "deadly for ES" into "deadly for other builds" for a leech build, the filters, the
  Upsides tab, cites open their source through open_url
- Ultimatum / Sanctum / Expedition checkers render (Sanctum: major and minor groups)
- the temple planner: a row per architect from the Incursion sheet, a goal stars its rooms, the
  summary counts tier-3 rooms, the board is saved (pobtf-temple) and comes back after a reload
- the in-game sheet: a Tools tab with the altar picker, click-only (no text box), and no tab when
  the data is empty (a tool with no data is hidden)
"""
import json

TAG = "62 pickers"

SRC = [{"url": "https://www.poewiki.net/wiki/Eldritch_altar", "title": "Eldritch altar", "publisher": "PoE Wiki",
        "date": "2026-10-01", "patch": "3.29"},
       {"url": "https://maxroll.gg/poe/resources/eldritch-altars", "title": "Altars", "publisher": "Maxroll",
        "date": "2026-09-01", "patch": "3.29"}]
FIX = {
    "asOf": "3.29", "sources": SRC,
    "eldritch": {
        "downsides": [
            {"mod": "Test: Players cannot Regenerate Life", "rating": "deadly", "dangerousFor": ["life-regen"], "why": "Regen builds die.", "cite": [0]},
            {"mod": "Test: Players have -x% to all maximum Resistances", "rating": "deadly", "dangerousFor": ["all"], "why": "Everyone takes more.", "cite": [0, 1]},
            {"mod": "Test: Energy Shield cannot recharge", "rating": "deadly", "dangerousFor": ["es"], "why": "ES builds lose their defence.", "cite": [1]},
            {"mod": "Test: Monsters have +x% chance to Suppress", "rating": "safe", "dangerousFor": [], "why": "Barely matters.", "cite": [1]},
            {"mod": "Test: Cannot Leech", "rating": "caution", "dangerousFor": ["leech"], "why": "Leech builds lose sustain.", "cite": [0]},
        ],
        "upsides": [{"mod": "Test: drops additional Divine Orbs", "target": "boss", "value": "high", "note": "Click it.", "cite": [0]},
                    {"mod": "Test: drops additional Fossils", "target": "minions", "value": "low", "note": "Skip it.", "cite": [1]}],
        "rules": [{"text": "Test rule: read both options before clicking.", "cite": [1]}],
    },
    "ultimatum": {"mods": [{"name": "Test: Ruin", "rating": "deadly", "dangerousFor": ["all"], "why": "Stacks fail the run.", "cite": [0]},
                           {"name": "Test: Limited Arena", "rating": "caution", "dangerousFor": ["minion"], "why": "Small circle.", "cite": [0]}],
                  "winConditions": [{"name": "Test: Defeat waves", "rating": "safe", "note": "Easiest.", "cite": [0]}], "rules": []},
    "sanctum": {"afflictions": [{"name": "Test: Glass Shard", "major": True, "rating": "deadly", "dangerousFor": ["all"], "why": "One hit.", "cite": [0]},
                                {"name": "Test: Veiled Sight", "major": False, "rating": "safe", "dangerousFor": [], "why": "Minor.", "cite": [0]}],
                "boons": [], "rules": []},
    "expedition": {"remnants": [{"mod": "Test: Monsters reflect damage", "kind": "bad", "rating": "deadly", "dangerousFor": ["all"], "why": "Reflect kills.", "cite": [0]},
                                {"mod": "Test: increased quantity of Artifacts", "kind": "good", "rating": "high", "dangerousFor": [], "why": "More currency.", "cite": [0]}],
                   "rules": [{"text": "Test tip: chain explosions through the good remnants.", "cite": [0]}]},
    "incursion": {"rooms": [{"tier3Room": "Locus of Corruption", "architect": "Paquate", "chain": [], "value": "high", "goals": ["corrupt"], "why": "Double corrupts.", "cite": [0]}],
                  "goals": [{"name": "Test: double corrupt", "wantRooms": ["Locus of Corruption", "Apex of Ascension"], "tips": ["Test tip one."], "cite": [0]}],
                  "rules": [{"text": "Test temple rule.", "cite": [0]}]},
    "strategies": [],
}

APP = r"""
const H = window.__e2e;
const out = {};
window.POE_GUIDES.tools = FIX;
document.getElementById('open-sheets').click();
await H.sleep(80);
const pick = (id) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById(id).title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
// Eldritch: the altar picker is an open guide section, listed in the jump bar
pick('eldritch');
await H.sleep(80);
let tool = panel().querySelector('.mech-tool[data-tool="altarpick"]');
out.altar = !!tool;
const sec = tool && tool.closest('.guide-sec');
out.altarSec = !!sec && sec.open && sec.dataset.key === 'tool-altarpick';
out.jump = [...panel().querySelectorAll('.guide-jump-link')].some(b => b.dataset.key === 'tool-altarpick');
const rows = () => [...tool.querySelectorAll('.pick-row')];
out.rows = rows().length;
out.idle = tool.querySelector('.pick-verdict').classList.contains('is-idle');
// mark the max-res downside: run-ending for everyone
rows().find(r => /maximum Resistances/.test(r.textContent)).querySelector('.pick-toggle').click();
await H.sleep(20);
const v = () => tool.querySelector('.pick-verdict');
out.deadly = v().classList.contains('is-deadly') && /Don't click this altar/.test(v().textContent) && /maximum Resistances/.test(v().textContent);
out.pressed = rows().find(r => /maximum Resistances/.test(r.textContent)).querySelector('.pick-toggle').getAttribute('aria-pressed');
// unmark; mark the ES one; with a Leech build it is "deadly for other builds" -> caution
rows().find(r => /maximum Resistances/.test(r.textContent)).querySelector('.pick-toggle').click();
rows().find(r => /Energy Shield/.test(r.textContent)).querySelector('.pick-toggle').click();
await H.sleep(20);
out.esNoTags = v().classList.contains('is-deadly');
[...tool.querySelectorAll('.mech-tag')].find(b => b.textContent === 'Leech').click();
await H.sleep(20);
out.esLeech = v().classList.contains('is-caution');
out.otherLabel = /Deadly for other builds/.test(rows().find(r => /Energy Shield/.test(r.textContent)).textContent);
out.hitChip = /Hits your build/.test(rows().find(r => /Cannot Leech/.test(r.textContent)).textContent);
out.tagSaved = JSON.parse(localStorage.getItem('pobtf-mech-build') || '[]');
// filters: Run-ending (for a leech build: max res only), Hits my build (Cannot Leech + the 'all' one)
const seg = (label) => [...tool.querySelectorAll('.pick-bar .seg')].find(b => b.textContent === label).click();
seg('Run-ending'); await H.sleep(20);
out.fDeadly = rows().map(r => r.querySelector('.pick-name').textContent);
seg('Hits my build'); await H.sleep(20);
out.fMine = rows().map(r => r.querySelector('.pick-name').textContent);
seg('All'); await H.sleep(20);
// search (app only)
const q = tool.querySelector('input.mech-search');
q.value = 'leech'; q.dispatchEvent(new Event('input'));
await H.sleep(20);
out.search = rows().length;
q.value = ''; q.dispatchEvent(new Event('input'));
// a cite opens its source
const n0 = H.calls('open_url').length;
tool.querySelector('.pick-cite').click();
await H.sleep(20);
out.cite = (H.calls('open_url')[n0] || { args: [] }).args[0];
// Upsides tab: value-sorted
[...tool.querySelectorAll('.pick-tabs .seg')].find(b => b.textContent === 'Upsides').click();
await H.sleep(20);
out.up = [...tool.querySelectorAll('.pick-pane:not([hidden]) .pick-value b')].map(e => e.textContent);
out.tabSaved = JSON.parse(localStorage.getItem('pobtf-pick-tab') || '{}').altarpick;
// Ultimatum, Sanctum, Expedition
pick('ultimatum'); await H.sleep(80);
out.ulti = panel().querySelectorAll('.mech-tool[data-tool="ultipick"] .pick-row').length;
pick('sanctum'); await H.sleep(80);
out.sanct = [...panel().querySelectorAll('.mech-tool[data-tool="sanctpick"] .pick-group-title')].map(e => e.textContent);
pick('expedition'); await H.sleep(80);
const ex = panel().querySelector('.mech-tool[data-tool="exppick"]');
out.exp = [ex.querySelectorAll('.pick-row').length, [...ex.querySelectorAll('.pick-tabs .seg')].map(b => b.textContent)];
// Incursion: the temple planner
pick('incursion'); await H.sleep(80);
const t = panel().querySelector('.mech-tool[data-tool="temple"]');
out.templeRows = t.querySelectorAll('.temple-row').length;
const sel = t.querySelector('select');
sel.value = 'Test: double corrupt'; sel.dispatchEvent(new Event('change'));
await H.sleep(20);
out.wanted = [...t.querySelectorAll('.temple-row.is-wanted .temple-room')].map(e => e.textContent).sort();
out.sum0 = H.text('.temple-sum .badge', t);
out.tips = [...t.querySelectorAll('.temple-tips .sheet-li')].map(e => e.textContent);
const row = (room) => [...t.querySelectorAll('.temple-row')].find(r => r.querySelector('.temple-room').textContent === room);
[...row('Locus of Corruption').querySelectorAll('.temple-tier')][3].click();
await H.sleep(20);
out.sum1 = H.text('.temple-sum .badge', t);
out.left = H.text('.temple-left', t);
out.firstRow = t.querySelector('.temple-row .temple-room').textContent;
out.value = H.text('.mech-rating', row('Locus of Corruption'));
out.saved = JSON.parse(H.calls('storage_set').filter(c => c.args[0] === 'pobtf-temple').slice(-1)[0].args[1]);
return out;
"""

RELOAD = r"""
const H = window.__e2e;
window.POE_GUIDES.tools = FIX;
document.getElementById('open-sheets').click();
await H.sleep(80);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('incursion').title).click();
await H.sleep(80);
const t = document.querySelector('#view-sheets .mech-tool[data-tool="temple"]');
return { sum: H.text('.temple-sum .badge', t), goal: t.querySelector('select').value };
"""

OVERLAY = r"""
const H = window.__e2e;
const out = {};
window.POE_GUIDES.tools = FIX;
window.__sheetOpen('eldritch');
await H.sleep(80);
const p = document.querySelector('.sheet-panel');
const tabs = () => [...p.querySelectorAll('.guide-ov-tabs .seg')].map(b => b.textContent);
out.tabs = tabs();
[...p.querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Tools').click();
await H.sleep(40);
const tool = p.querySelector('.guide-ov-tools .mech-tool[data-tool="altarpick"]');
out.tool = !!tool && tool.getClientRects().length > 0;
out.typing = tool ? tool.querySelectorAll('input, textarea').length : -1;
// the build tags fold to one line in game; opening it re-fits the window, ticking names the tag
const fold = tool.querySelector('details.mech-build-fold');
out.foldClosed = !!fold && !fold.open && /My build: not set/.test(fold.querySelector('summary').textContent);
const f0 = H.calls('overlay_fit').length;
fold.querySelector('summary').click();
await H.sleep(40);
out.foldFit = fold.open && H.calls('overlay_fit').length > f0;
[...fold.querySelectorAll('.mech-tag')].find(b => b.textContent === 'Melee').click();
await H.sleep(20);
out.foldSum = fold.querySelector('summary').textContent;
[...fold.querySelectorAll('.mech-tag')].find(b => b.textContent === 'Melee').click();
fold.querySelector('summary').click();
await H.sleep(20);
const fits = H.calls('overlay_fit').length;
tool.querySelector('.pick-row .pick-toggle').click();
await H.sleep(40);
out.fit = H.calls('overlay_fit').length > fits;
out.whyMarkedOnly = tool.querySelectorAll('.pick-why').length === 1;
out.tabSaved = JSON.parse(localStorage.getItem('pobtf-guide-ov-tab') || '{}').eldritch;
// no data: the checker is hidden, so Sanctum has no Tools tab
window.POE_GUIDES.tools = null;
window.__sheetOpen('sanctum');
await H.sleep(80);
out.sanctTabs = [...document.querySelectorAll('.sheet-panel .guide-ov-tabs .seg')].map(b => b.textContent);
out.sanctTitle = H.text('.sheet-title');
return out;
"""

# the shipped research data (no fixture): every picker draws a row per rated entry, the goals read
# as words, and the scarab hub offers the research strategies
REAL = r"""
const H = window.__e2e;
const T = window.POE_GUIDES.tools;
const out = { has: !!T };
if (!T) return out;
document.getElementById('open-sheets').click();
await H.sleep(80);
const pick = (id) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById(id).title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
const rows = (tool) => panel().querySelectorAll('.mech-tool[data-tool="' + tool + '"] .pick-pane:not([hidden]) .pick-row').length;
pick('eldritch'); await H.sleep(80);
out.altar = [rows('altarpick'), T.eldritch.downsides.length];
pick('ultimatum'); await H.sleep(80);
out.ulti = [rows('ultipick'), T.ultimatum.mods.length];
pick('sanctum'); await H.sleep(80);
out.sanct = [rows('sanctpick'), T.sanctum.afflictions.length];
pick('expedition'); await H.sleep(80);
out.exp = [rows('exppick'), T.expedition.remnants.filter(r => r.kind === 'bad').length];
pick('incursion'); await H.sleep(80);
const t = panel().querySelector('.mech-tool[data-tool="temple"]');
out.goals = [...t.querySelectorAll('select option')].slice(1).map(o => o.textContent);
out.values = t.querySelectorAll('.temple-row .mech-rating').length;
out.rooms = T.incursion.rooms.length;
pick('scarabs'); await H.sleep(150);
const sel = panel().querySelector('.mech-tool[data-tool="scarabhub"] select.shub-strat-select');
out.strats = sel ? [...sel.options].filter(o => o.value).length : -1;
out.wantStrats = T.strategies.length;
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP, timeout=60, FIX=FIX)
    check(tag + " altar picker: an open guide section, in the jump bar", r["altar"] and r["altarSec"] and r["jump"], r)
    check(tag + " altar picker: a row per downside, idle verdict first", r["rows"] == 5 and r["idle"], r["rows"])
    check(tag + " marking a deadly-for-all downside: red verdict naming it, row pressed",
          r["deadly"] and r["pressed"] == "true", r)
    check(tag + " deadly-for-ES: run-ending with no tags, caution for a leech build ('deadly for other builds')",
          r["esNoTags"] and r["esLeech"] and r["otherLabel"], r)
    check(tag + " leech build: 'Hits your build' on Cannot Leech; the tags are saved", r["hitChip"] and r["tagSaved"] == ["leech"], r["tagSaved"])
    check(tag + " filter Run-ending: only max res for a leech build",
          r["fDeadly"] == ["Test: Players have -x% to all maximum Resistances"], r["fDeadly"])
    check(tag + " filter Hits my build: the 'all' one and Cannot Leech",
          sorted(r["fMine"]) == ["Test: Cannot Leech", "Test: Players have -x% to all maximum Resistances"], r["fMine"])
    check(tag + " search narrows the list", r["search"] == 1, r["search"])
    check(tag + " a cite opens its source through the bridge", r["cite"] in [x["url"] for x in SRC], r["cite"])
    check(tag + " Upsides tab: high value first; the tab is remembered",
          r["up"] == ["Test: drops additional Divine Orbs", "Test: drops additional Fossils"] and r["tabSaved"] == "up", r)
    check(tag + " Ultimatum checker rows", r["ulti"] == 2, r["ulti"])
    check(tag + " Sanctum: major and minor groups", r["sanct"] == ["Major afflictions", "Minor afflictions"], r["sanct"])
    check(tag + " Expedition: the bad remnant to check, Want and Tips tabs", r["exp"] == [1, ["Avoid", "Want", "Tips"]], r["exp"])
    check(tag + " temple: a row per architect (25)", r["templeRows"] == 25, r["templeRows"])
    check(tag + " a goal stars its rooms and shows its tips",
          r["wanted"] == ["Apex of Ascension", "Locus of Corruption"] and r["tips"] == ["Test tip one."], r)
    check(tag + " summary counts tier-3 rooms (0 of 2 -> 1 of 2), names what's left",
          r["sum0"] == "0 of 2 at tier 3" and r["sum1"] == "1 of 2 at tier 3" and "Apex of Ascension" in (r["left"] or ""), r)
    check(tag + " wanted rooms list first; the research value shows", r["firstRow"] in ("Locus of Corruption", "Apex of Ascension")
          and r["value"] == "High value", r)
    check(tag + " temple saved", r["saved"]["tier"].get("Paquate") == 3 and r["saved"]["goal"] == "Test: double corrupt", r["saved"])
    s.b.navigate(s.url, "typeof mechToolsFor === 'function' && document.readyState === 'complete'", timeout=30)
    r = s.run(RELOAD, timeout=40, FIX=FIX)
    check(tag + " temple comes back after a reload", r["sum"] == "1 of 2 at tier 3" and r["goal"] == "Test: double corrupt", r)
    s.fresh()
    r = s.run(REAL, timeout=60)
    check(tag + " shipped data: the guides payload carries the tools' research", r.get("has"), r)
    if r.get("has"):
        check(tag + " shipped data: a row per rated altar downside / Ultimatum mod / affliction / bad remnant",
              all(r[k][0] == r[k][1] and r[k][0] > 0 for k in ("altar", "ulti", "sanct", "exp")), r)
        check(tag + " shipped data: temple goals read as words, every researched room shows its value",
              r["goals"] and all(g[:1].isupper() and "-" not in g for g in r["goals"]) and r["values"] == r["rooms"], r)
        check(tag + " shipped data: the scarab hub offers the research strategies", r["strats"] == r["wantStrats"] > 0, r)
    s.fresh("?sheet=1")
    r = s.run(OVERLAY, timeout=40, FIX=FIX)
    check(tag + " in-game sheet: Quick card | Tools | Reference", r["tabs"] == ["Quick card", "Tools", "Reference"], r["tabs"])
    check(tag + " in-game: the altar picker shows, nothing to type", r["tool"] and r["typing"] == 0, r)
    check(tag + " in-game: the build tags fold to one line, open re-fits the window, the line names what's ticked",
          r["foldClosed"] and r["foldFit"] and r["foldSum"] == "My build: Melee", r)
    check(tag + " in-game: marking re-fits the window; the why shows for the marked row only; tab remembered",
          r["fit"] and r["whyMarkedOnly"] and r["tabSaved"] == "tools", r)
    check(tag + " in-game: no tool data -> no Tools tab (an empty tool stays hidden)",
          "Tools" not in r["sanctTabs"] and "Quick card" in r["sanctTabs"], r["sanctTabs"])
