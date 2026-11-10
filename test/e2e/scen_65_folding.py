"""65 folding — long cheat sheets fold into dropdowns (24-cheatsheets.js: sheetFold):
- every wiki table of a mechanic sheet is a <details>, the first open and the rest closed, with
  the title and a row-count chip in its <summary>; the mechanic tools fold too (open)
- what you open or close is saved (pobtf-sheet-open: { sheetId: { title: bool } }) and survives a
  redraw and a restart; the sheet over the game keeps its own state (sheetId + ':ov')
- the row filter opens folds with matches without touching the saved state, hides the others, and
  puts everything back when cleared; a title match shows every row of that section
- over the game a toggle re-fits the window, and the sheet stays click-only
- the act sheet's parts fold (a long Gems list starts closed), saved under "act"
"""
import json
import urllib.parse

TAG = "65 folding"

APP = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(80);
const pick = (id) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById(id).title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
const wiki = () => [...panel().querySelectorAll('.sheet-fold:not(.mech-tool-sec)')];
const title = (f) => f.querySelector(':scope > summary .sheet-sec-title').textContent;
const rowsOf = (f) => [...f.querySelectorAll('.sheet-table tbody tr, .sheet-list .sheet-li')];
// (a closed <details> keeps its content's boxes: checkVisibility knows it isn't drawn)
const seen = (el) => !!el && H.visible(el) && el.checkVisibility({ contentVisibilityAuto: true });
const shownRows = (f) => rowsOf(f).filter(r => r.style.display !== 'none').length;
const saves = () => H.calls('storage_set').filter(c => c.args[0] === 'pobtf-sheet-open');
const lastSave = () => { const s = saves(); return s.length ? JSON.parse(s[s.length - 1].args[1]) : null; };
const shape = (id) => {
  const fs = wiki();
  return { id, n: fs.length, open: fs.map(f => f.open), details: fs.every(f => f.tagName === 'DETAILS'),
    summaries: fs.every(f => f.firstElementChild.tagName === 'SUMMARY' && !!title(f)),
    chips: fs.every(f => { const c = f.querySelector(':scope > summary .sheet-fold-count');
      return c && +c.textContent === rowsOf(f).length && /\d+ (row|line)s?$/.test(c.getAttribute('aria-label') || ''); }),
    inRef: fs.every(f => !!f.closest('.guide-ref')),
    tools: [...panel().querySelectorAll('.sheet-fold.mech-tool-sec')].map(f => f.open),
    firstRowSeen: seen(rowsOf(fs[0])[0]), secondRowHidden: fs.length > 1 && !seen(rowsOf(fs[1])[0]) };
};
// ---- default state: guide sheets (Reference data) and sheets without a guide
out.shapes = [];
for (const id of ['incursion', 'sanctum', 'corruption', 'labyrinth', 'scarabs']) {
  pick(id); await H.sleep(120);
  const s = shape(id);
  s.guide = !!panel().querySelector('.guide');
  s.refHead = !!panel().querySelector('.guide-ref-title');
  out.shapes.push(s);
}
out.savedBeforeAnyClick = saves().length;
// the arrow is a second cue next to the chip
pick('sanctum'); await H.sleep(120);
let fs = wiki();
out.arrowOpen = getComputedStyle(fs[0].querySelector('summary'), '::before').content;
out.arrowClosed = getComputedStyle(fs[1].querySelector('summary'), '::before').content;
out.summaryFocusable = (() => { const s = fs[1].querySelector('summary'); s.focus(); return document.activeElement === s; })();
// ---- opening one is saved, and survives a redraw
const t1 = title(fs[1]), t0 = title(fs[0]);
fs[1].querySelector('summary').click();
await H.sleep(60);
out.openedSaved = lastSave();
out.openedKey = [t1];
fs[0].querySelector('summary').click();
await H.sleep(60);
out.closedSaved = lastSave();
out.closedKey = [t0];
renderSheetsView();
await H.sleep(120);
fs = wiki();
out.afterRedraw = fs.map(f => f.open);
// another sheet is untouched
pick('incursion'); await H.sleep(120);
out.otherSheet = wiki().map(f => f.open);
// ---- the row filter
pick('sanctum'); await H.sleep(120);
fs = wiki();
const filt = document.querySelector('#view-sheets .sheet-filter');
out.hasFilter = !!filt;
const type = async (v) => { filt.value = v; filt.dispatchEvent(new Event('input', { bubbles: true })); await H.sleep(60); };
// a word from a row of a closed fold (its first cell), not in that fold's title
const closed = fs.filter(f => !f.open);
let target = null, word = null;
for (const f of closed) {
  for (const r of rowsOf(f)) {
    const w = (r.textContent.toLowerCase().match(/[a-z]{6,}/g) || []).find(x => title(f).toLowerCase().indexOf(x) === -1);
    if (w) { target = f; word = w; break; }
  }
  if (target) break;
}
out.word = word;
const nSaves = saves().length;
const before = fs.map(f => f.open);
await type(word);
const hits = (f) => rowsOf(f).some(r => r.textContent.toLowerCase().indexOf(word) !== -1) || title(f).toLowerCase().indexOf(word) !== -1;
out.filterOpened = target.open && seen(rowsOf(target).find(r => r.style.display !== 'none'));
out.filterAllHitsOpen = fs.filter(hits).every(f => f.open && f.style.display !== 'none');
out.filterMissesHidden = fs.filter(f => !hits(f)).every(f => f.style.display === 'none');
out.filterMisses = fs.filter(f => !hits(f)).length;
await type('');
out.filterRestored = JSON.stringify(fs.map(f => f.open)) === JSON.stringify(before) && fs.every(f => f.style.display !== 'none');
out.before = before;
out.filterSaves = saves().length - nSaves;
// ---- a title match shows every row of that section
const tsec = fs.find(f => { const t = title(f).toLowerCase(); return rowsOf(f).length > 1 && rowsOf(f).some(r => r.textContent.toLowerCase().indexOf(t) === -1); });
out.titleSec = tsec ? title(tsec) : null;
await type(title(tsec).toLowerCase());
out.titleRows = { shown: shownRows(tsec), all: rowsOf(tsec).length, open: tsec.open, seen: seen(rowsOf(tsec)[0]) };
await type('');
out.titleSaves = saves().length - nSaves;
// ---- the jump bar's Reference data link still lands on the filter box
panel().querySelector('.guide-jump-link.is-ref').click();
await H.sleep(60);
out.jumpFocus = document.activeElement === filt;
// ---- the act sheet
const q = sheetPrefs(); q.gemClass = 'Witch'; saveSheetPrefs(q);
sheetViewMech = null; sheetViewAct = 3; renderSheetsView();
await H.sleep(120);
const act = () => [...document.querySelectorAll('#view-sheets .sheet-panel.is-preview .sheet-fold')];
const actShape = () => act().map(f => ({ t: title(f), open: f.open, n: +((f.querySelector('.sheet-fold-count') || {}).textContent || -1),
  gems: f.querySelectorAll('.sheet-gem').length }));
out.act3 = actShape();
// (every act's real list is long: cut act 4's to one quest to see a short one)
const realGems = sheetData().acts[4].gems;
sheetData().acts[4].gems = realGems.slice(0, 1);
sheetViewAct = 4; renderSheetsView(); await H.sleep(120);
out.act4 = actShape();
sheetData().acts[4].gems = realGems;
act().find(f => title(f) === 'Route').querySelector('summary').click();
await H.sleep(60);
out.actSaved = lastSave();
sheetViewAct = 2; renderSheetsView(); await H.sleep(120);
out.act2 = actShape();
out.store = saves().slice(-1)[0].args[1];
return out;
"""

RELOAD = r"""
const H = window.__e2e;
const out = {};
await H.waitFor(() => H.calls('storage_get').length > 0, 5000, 'settings read back');
await H.sleep(150);
document.getElementById('open-sheets').click();
await H.sleep(80);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('sanctum').title).click();
await H.sleep(120);
out.sanctum = [...document.querySelectorAll('#view-sheets .sheet-panel.is-mech .sheet-fold:not(.mech-tool-sec)')].map(f => f.open);
sheetViewMech = null; sheetViewAct = 4; renderSheetsView(); await H.sleep(120);
out.route = [...document.querySelectorAll('#view-sheets .sheet-panel.is-preview .sheet-fold')]
  .filter(f => f.querySelector('.sheet-sec-title').textContent === 'Route').map(f => f.open);
// a broken saved value is ignored (the defaults come back), not an error
localStorage.setItem('pobtf-sheet-open', '{nope');
sheetViewMech = 'sanctum'; renderSheetsView(); await H.sleep(120);
out.broken = [...document.querySelectorAll('#view-sheets .sheet-panel.is-mech .sheet-fold:not(.mech-tool-sec)')].map(f => f.open);
return out;
"""

OVERLAY = r"""
const H = window.__e2e;
const out = {};
await H.waitFor(() => H.calls('storage_get').length > 0, 5000, 'settings read back');
await H.sleep(150);
const p = () => document.querySelector('.sheet-panel');
const folds = () => [...p().querySelectorAll('.guide-ov-ref .sheet-fold, .sheet-content:not(.guide-ov) .sheet-fold:not(.mech-tool-sec)')];
const title = (f) => f.querySelector(':scope > summary .sheet-sec-title').textContent;
const saves = () => H.calls('storage_set').filter(c => c.args[0] === 'pobtf-sheet-open');
window.__sheetOpen('sanctum');
await H.sleep(120);
[...p().querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Reference').click();
await H.sleep(80);
let fs = folds();
out.n = fs.length;
out.open = fs.map(f => f.open);            // the app's saved state (second open, first closed) must not apply here
const fits = H.calls('overlay_fit').length;
const t2 = title(fs[2]);
fs[2].querySelector('summary').click();
await H.sleep(120);
out.fitOnOpen = H.calls('overlay_fit').length - fits;
out.saved = JSON.parse(saves().slice(-1)[0].args[1]);
out.key = t2;
const h1 = p().querySelector('.sheet-body').scrollHeight;
const fits2 = H.calls('overlay_fit').length;
fs[2].querySelector('summary').click();
await H.sleep(120);
out.fitOnClose = H.calls('overlay_fit').length - fits2;
out.shrunk = p().querySelector('.sheet-body').scrollHeight < h1;
fs[2].querySelector('summary').click();
await H.sleep(120);
sheetRender();
await H.sleep(150);
fs = folds();
out.afterRedraw = fs.map(f => f.open);
out.typing = p().querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable]').length;
// a sheet without a guide
window.__sheetOpen('labyrinth');
await H.sleep(150);
fs = folds();
out.lab = { n: fs.length, open: fs.map(f => f.open), guide: !!p().querySelector('.guide-ov'),
  typing: p().querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable]').length };
// the act sheet over the game
window.__sheetOpen(1);
await H.sleep(150);
const act = [...p().querySelectorAll('.sheet-fold')];
out.act = act.map(f => ({ t: title(f), open: f.open }));
const fits3 = H.calls('overlay_fit').length;
act[0].querySelector('summary').click();
await H.sleep(120);
out.actFit = H.calls('overlay_fit').length - fits3;
out.actSaved = JSON.parse(saves().slice(-1)[0].args[1]);
out.actKey = title(act[0]);
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP, timeout=90)
    by = {x["id"]: x for x in r["shapes"]}
    for sid in ("incursion", "sanctum"):
        x = by[sid]
        check(tag + " %s: each Reference data table is a fold, the first open and the rest closed" % sid,
              x["guide"] and x["refHead"] and x["inRef"] and x["n"] >= 4 and x["details"] and x["summaries"]
              and x["open"] == [True] + [False] * (x["n"] - 1) and x["firstRowSeen"] and x["secondRowHidden"], x)
    for sid in ("corruption", "labyrinth"):
        x = by[sid]
        check(tag + " %s (no guide): the first fold open, the rest closed" % sid,
              not x["guide"] and x["n"] >= 8 and x["details"] and x["open"] == [True] + [False] * (x["n"] - 1)
              and x["firstRowSeen"] and x["secondRowHidden"], x)
    check(tag + " each fold's summary has its title and a row-count chip (with a spoken label)",
          all(x["summaries"] and x["chips"] for x in r["shapes"]), r["shapes"])
    x = by["scarabs"]
    check(tag + " scarabs: the mechanic tools fold too, open by default", len(x["tools"]) >= 2 and all(x["tools"]), x)
    check(tag + " drawing the sheets saves nothing", r["savedBeforeAnyClick"] == 0, r["savedBeforeAnyClick"])
    check(tag + " the arrow tells open from closed (not only the chip); the summary takes focus",
          r["arrowOpen"] != r["arrowClosed"] and "▾" in r["arrowOpen"] and "▸" in r["arrowClosed"] and r["summaryFocusable"],
          [r["arrowOpen"], r["arrowClosed"], r["summaryFocusable"]])
    k1, k0 = r["openedKey"][0], r["closedKey"][0]
    check(tag + " opening a fold is saved under pobtf-sheet-open { sanctum: { title: true } }",
          (r["openedSaved"] or {}).get("sanctum") == {k1: True}, r["openedSaved"])
    check(tag + " closing the first one is saved too",
          (r["closedSaved"] or {}).get("sanctum") == {k1: True, k0: False}, r["closedSaved"])
    check(tag + " a redraw keeps what you opened and closed",
          r["afterRedraw"][:2] == [False, True] and not any(r["afterRedraw"][2:]), r["afterRedraw"])
    check(tag + " another sheet keeps its defaults", r["otherSheet"] == [True] + [False] * (len(r["otherSheet"]) - 1), r["otherSheet"])
    check(tag + " filter: a closed fold with a match opens and shows the row",
          r["hasFilter"] and r["word"] and r["filterOpened"] and r["filterAllHitsOpen"], r)
    check(tag + " filter: folds without a match are hidden", r["filterMisses"] >= 1 and r["filterMissesHidden"], r)
    check(tag + " filter: clearing it puts every fold back as it was, and nothing was saved",
          r["filterRestored"] and r["filterSaves"] == 0 and r["titleSaves"] == 0, [r["before"], r["filterSaves"], r["titleSaves"]])
    check(tag + " filter: a title match shows all of that section's rows",
          r["titleSec"] and r["titleRows"]["shown"] == r["titleRows"]["all"] and r["titleRows"]["open"] and r["titleRows"]["seen"],
          [r["titleSec"], r["titleRows"]])
    check(tag + " the jump bar's Reference data link still focuses the filter box", r["jumpFocus"])
    a3 = {x["t"].split(" · ")[0]: x for x in r["act3"]}
    a4 = {x["t"].split(" · ")[0]: x for x in r["act4"]}
    check(tag + " act sheet: Quests, Trials and Route fold, open by default",
          all(k in a3 and a3[k]["open"] for k in ("Quests", "Trials of Ascendancy", "Route")), r["act3"])
    check(tag + " act sheet: a long Gems list (> 40) starts closed, a short one open",
          a3["Gems"]["gems"] > 40 and a3["Gems"]["n"] == a3["Gems"]["gems"] and not a3["Gems"]["open"]
          and 0 < a4["Gems"]["gems"] <= 40 and a4["Gems"]["open"], [a3.get("Gems"), a4.get("Gems")])
    a2 = {x["t"].split(" · ")[0]: x for x in r["act2"]}
    check(tag + " act sheet: closing Route is saved under 'act' and holds on another act",
          (r["actSaved"] or {}).get("act") == {"Route": False} and not a2["Route"]["open"] and a2["Quests"]["open"]
          and "sanctum" in r["actSaved"], r["actSaved"])

    # a restart: the bridge's storage hands the saved map back
    seed = "e2eStore=" + urllib.parse.quote(json.dumps({"pobtf-sheet-open": r["store"]}))
    s.fresh("?" + seed)
    r2 = s.run(RELOAD, timeout=60)
    check(tag + " a restart keeps the folds (sanctum: first closed, second open; act: Route closed)",
          r2["sanctum"][:2] == [False, True] and not any(r2["sanctum"][2:]) and r2["route"] == [False], r2)
    check(tag + " a broken saved value falls back to the defaults",
          r2["broken"] == [True] + [False] * (len(r2["broken"]) - 1), r2["broken"])

    # over the game: its own state, re-fit on toggle, click-only
    s.fresh("?sheet=1&" + seed)
    r3 = s.run(OVERLAY, timeout=60)
    n = r3["n"]
    check(tag + " in game: the app's saved folds don't apply (first open, rest closed)",
          n >= 4 and r3["open"] == [True] + [False] * (n - 1), r3["open"])
    saved = r3["saved"]
    check(tag + " in game: a toggle is saved under 'sanctum:ov', the app's state untouched",
          saved.get("sanctum:ov") == {r3["key"]: True} and saved.get("sanctum") == json.loads(r["store"]).get("sanctum"), saved)
    check(tag + " in game: opening and closing a fold re-fits the window",
          r3["fitOnOpen"] >= 1 and r3["fitOnClose"] >= 1 and r3["shrunk"], [r3["fitOnOpen"], r3["fitOnClose"], r3["shrunk"]])
    check(tag + " in game: a redraw keeps the fold you opened",
          r3["afterRedraw"][0] and r3["afterRedraw"][2] and not r3["afterRedraw"][1], r3["afterRedraw"])
    check(tag + " in game: still click-only (no text inputs)", r3["typing"] == 0 and r3["lab"]["typing"] == 0, [r3["typing"], r3["lab"]])
    lab = r3["lab"]
    check(tag + " in game: a sheet without a guide folds the same way",
          not lab["guide"] and lab["n"] >= 8 and lab["open"] == [True] + [False] * (lab["n"] - 1), lab)
    check(tag + " in game: the act sheet folds, re-fits, and saves under 'act:ov'",
          len(r3["act"]) >= 2 and all(x["open"] for x in r3["act"] if not x["t"].startswith("Gems")) and r3["actFit"] >= 1
          and r3["actSaved"].get("act:ov") == {r3["actKey"]: False} and r3["actSaved"].get("act") == {"Route": False}, r3)
