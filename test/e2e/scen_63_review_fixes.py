"""63 toolfixes — regressions for what the mechanic tools review found (2026-11-06):
- the in-game sheet no longer rebuilds every 10 s when nothing changed (it reset the tools' filters),
  and a real redraw keeps each checker's filter and each board's view (Run-ending, All 7 tiers)
- a "safe" mod that hits what your build uses reads as caution (row, filter and verdict agree)
- the Scarabs sheet's row filter leaves the scarab hub and profit calculator alone
- an icon that fails to load shows the item's name, never a blank tile
- prices: a league change while a load is in flight never marks the new league as loaded with the
  old league's (or no) prices
"""
TAG = "63 toolfixes"

OVERLAY = r"""
const H = window.__e2e;
const out = {};
window.__sheetOpen('eldritch');
await H.sleep(80);
const p = () => document.querySelector('.sheet-panel');
[...p().querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Tools').click();
await H.sleep(40);
const tool = () => p().querySelector('.mech-tool[data-tool="altarpick"]');
[...tool().querySelectorAll('.pick-bar .seg')].find(b => b.textContent === 'Run-ending').click();
await H.sleep(30);
const rows = () => tool().querySelectorAll('.pick-row').length;
out.filtered = rows();
const before = tool();
// the 10-s status loop with nothing new: no rebuild at all
await refreshSheetStatus();
await refreshSheetStatus();
await H.sleep(30);
out.sameNode = tool() === before;
// a real redraw (e.g. a guide update): the filter comes back as it was
sheetRender();
await H.sleep(60);
out.redrawn = tool() !== before;
out.afterRedraw = rows();
out.segOn = (tool().querySelector('.pick-bar .seg[aria-checked="true"]') || {}).textContent;
// a changed hotkey label does redraw (the tooltip needs it)
overlayState = Object.assign({}, overlayState, { hotkeys: { sheet: 'Alt+X' } });
const n0 = tool();
window.__stubOverrides.overlay_status = { ok: true, hotkeys: { sheet: 'Alt+X' } };
await refreshSheetStatus();
await H.sleep(30);
out.hotkeyRedraw = tool() !== n0;
// essences: All 7 survives a redraw
window.__sheetOpen('essences');
await H.sleep(120);
[...p().querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Tools').click();
await H.sleep(40);
const board = () => p().querySelector('.pb[data-board="essences"]');
await H.waitFor(() => board() && board().querySelector('.pb-tier-pick'), 4000, 'essence board');
[...board().querySelectorAll('.pb-tier-pick .seg')].find(b => /^All/.test(b.textContent)).click();
await H.sleep(30);
const heads = () => board().querySelectorAll('thead th').length;
out.allHeads = heads();
sheetRender();
await H.sleep(120);
await H.waitFor(() => board() && board().querySelector('thead'), 4000, 'essence board again');
out.allHeadsAfter = heads();
return out;
"""

APP = r"""
const H = window.__e2e;
const out = {};
const T = window.POE_GUIDES.tools;
document.getElementById('open-sheets').click();
await H.sleep(80);
const pick = (id) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById(id).title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
// safe + hits your build -> caution (a shipped safe affliction that lists build tags)
const safeHit = T.sanctum.afflictions.find(a => a.rating === 'safe' && a.dangerousFor.length && !a.dangerousFor.includes('all'));
out.safeHit = safeHit ? safeHit.name : null;
pick('sanctum'); await H.sleep(80);
const st = panel().querySelector('.mech-tool[data-tool="sanctpick"]');
const tagName = { melee: 'Melee', 'low-ehp': 'Low EHP / glass', 'low-dps': 'Slow kill speed', minion: 'Minions', dot: 'Damage over time' };
const want = tagName[safeHit.dangerousFor[0]] || mechTagName(safeHit.dangerousFor[0]);
[...st.querySelectorAll('.mech-tag')].find(b => b.textContent === want).click();
await H.sleep(30);
const row = [...st.querySelectorAll('.pick-row')].find(r => r.querySelector('.pick-name').textContent === safeHit.name);
out.chips = [...row.querySelectorAll('.badge')].map(b => b.textContent);
row.querySelector('.pick-toggle').click();
await H.sleep(20);
out.verdict = st.querySelector('.pick-verdict').className;
// the Scarabs sheet's row filter leaves the tools alone
pick('scarabs'); await H.sleep(150);
const f = document.querySelector('#view-sheets .sheet-filter');
f.value = 'ambush'; f.dispatchEvent(new Event('input', { bubbles: true }));
await H.sleep(60);
const vis = (sel) => { const e = panel().querySelector(sel); return !!e && e.getClientRects().length > 0; };
out.hubShown = vis('.mech-tool[data-tool="scarabhub"]') && vis('.mech-tool[data-tool="profitcalc"]');
out.tableFiltered = [...panel().querySelectorAll('.sheet-table tbody tr')].filter(r => r.style.display !== 'none').length;
f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true }));
// a broken icon shows the name
MECH_PRICES.byName['E2E Broken'] = { name: 'E2E Broken', img: 'http://127.0.0.1:1/nope.png', chaos: 3 };
const ic = mechIcon('E2E Broken', { iconOnly: true });
document.body.appendChild(ic);
out.iconOnlyFirst = ic.classList.contains('icon-only');
ic.querySelector('img').dispatchEvent(new Event('error')); // what the browser fires when it can't load
await H.sleep(10);
out.iconName = !ic.classList.contains('icon-only') && ic.querySelector('.mech-item-name').getClientRects().length > 0;
ic.remove();
return out;
"""

RACE = r"""
const H = window.__e2e;
const out = {};
const real = window.pywebview.api;
const pending = [];
window.pywebview = { api: new Proxy({}, { get: (t, n) => n === 'mech_prices'
  ? (league, g) => new Promise(res => pending.push({ league, res }))
  : real[n] }) };
const sel = document.getElementById('league');
const leagues = [...sel.options].map(o => o.value);
sel.value = leagues[0];
MECH_PRICES.league = null;                       // fresh state
mechPrices(['scarabs']);                          // league A, in flight
sel.value = leagues[1];                           // switch league while it is out
let got = null;
mechPrices(['scarabs'], P => { got = { league: P.league, n: Object.keys(P.items).length, hour: P.hour }; });
out.calls = pending.map(p => p.league);
// A answers first: must be dropped, nothing marked loaded for B
pending[0].res({ ok: true, hour: 111, divine: 200, items: { a: { name: 'Old League Scarab', group: 'scarabs', chaos: 9 } } });
await H.sleep(30);
out.afterA = { marked: !!MECH_PRICES.groups.scarabs, got: got, old: !!MECH_PRICES.byName['Old League Scarab'], hour: MECH_PRICES.hour };
// B answers
const b = pending.find(p => p.league === leagues[1]);
b.res({ ok: true, hour: 222, divine: 210, items: { b: { name: 'New League Scarab', group: 'scarabs', chaos: 4 } } });
await H.sleep(30);
out.afterB = { marked: !!MECH_PRICES.groups.scarabs, got: got, hasNew: !!MECH_PRICES.byName['New League Scarab'], hour: MECH_PRICES.hour };
window.pywebview = { api: real };
out.leagues = leagues.slice(0, 2);
return out;
"""


def run(s, tag, check):
    s.fresh("?sheet=1")
    r = s.run(OVERLAY, timeout=60)
    check(tag + " in game: the 10-s status loop doesn't rebuild the sheet when nothing changed", r["sameNode"], r)
    check(tag + " in game: a real redraw keeps the checker on Run-ending",
          r["redrawn"] and r["afterRedraw"] == r["filtered"] and r["segOn"] == "Run-ending", r)
    check(tag + " in game: a changed hotkey label still redraws", r["hotkeyRedraw"], r)
    check(tag + " in game: the essence board keeps All 7 tiers across a redraw",
          r["allHeads"] > 4 and r["allHeadsAfter"] == r["allHeads"], r)
    s.fresh()
    r = s.run(APP, timeout=60)
    check(tag + " a safe mod that hits your build reads as caution (row and verdict)",
          r["safeHit"] and "Caution" in r["chips"] and "Hits your build" in r["chips"] and "Safe" not in r["chips"]
          and "is-caution" in r["verdict"], r)
    check(tag + " the Scarabs row filter leaves the scarab hub and profit calculator shown",
          r["hubShown"] and r["tableFiltered"] >= 1, r)
    check(tag + " a broken icon shows the item's name", r["iconOnlyFirst"] and r["iconName"], r)
    s.fresh()
    r = s.run(RACE, timeout=40)
    check(tag + " prices: a league switch mid-load asks again for the new league",
          r["calls"] == r["leagues"], r)
    check(tag + " prices: the old league's answer is dropped (nothing marked, no callback, no old items)",
          not r["afterA"]["marked"] and r["afterA"]["got"] is None and not r["afterA"]["old"] and r["afterA"]["hour"] is None, r["afterA"])
    check(tag + " prices: the new league's answer fills it and calls back once",
          r["afterB"]["marked"] and r["afterB"]["hasNew"] and r["afterB"]["hour"] == 222 and
          (r["afterB"]["got"] or {}).get("league") == r["leagues"][1], r["afterB"])
