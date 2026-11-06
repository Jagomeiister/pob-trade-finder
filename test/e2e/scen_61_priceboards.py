"""Scenario 61: mechanic price boards (js/app/42-priceboards.js).

Every board renders on its sheet in the app; fossils grouped by Delve biome with the best-biome
line right for the stub prices; the essence group x tier grid; lifeforce per 1,000 with Sacred
marked; beasts from a stubbed beast_prices; sorting; the in-game sheet's Tools tab; and a board
without the bridge (plain browser) still shows names. The mech_prices stub (run_e2e.mech_data)
prices every currencymap item 1-12c, Sacred lifeforce 40c, Primal 0.5c, divine 200c, no icons.
"""

TAG = "61 priceboards"

APP_JS = r"""
const H = window.__e2e;
const out = {};
const D = H.data.mech;
const priceOf = n => { const it = Object.values(D).find(x => x.name === n); return it ? it.chaos : null; };
const sheet = id => window.POE_CHEATSHEETS.mechanics.find(m => m.id === id);
const table = (id, re) => sheet(id).sections.find(s => re.test(s.title));
const tileNames = root => [...root.querySelectorAll('.pb-tile')].map(t => t.dataset.name);

// ---- no bridge (plain browser): names, no prices, the "in the app" footer -----------------
const saved = window.pywebview;
window.pywebview = undefined;
const host = document.createElement('div');
document.body.appendChild(host);
host.appendChild(mechMount(MECH_TOOLS.find(t => t.id === 'pb-delve'), { overlay: false, sheet: 'delve', onChange: null }));
out.plainTiles = host.querySelectorAll('.pb-tile').length;
out.plainPriced = [...host.querySelectorAll('.pb-tile')].filter(t => !t.classList.contains('no-price')).length;
out.plainFoot = H.text('.pb-foot', host);
out.plainMissing = H.visible(host.querySelector('.pb-missing'));
host.remove();
window.pywebview = saved;

window.__stubOverrides.beast_prices = { ok: true, divine: 200, items: [['Black Mórrigan', 300, 12], ['Vivid Vulture', 60, 20],
  ['Craicic Chimeral', 12, 5], ['Wild Bristle Matron', 30, 15]] };

document.getElementById('open-sheets').click();
await H.sleep(80);
const open = async (id, board) => {
  const title = (mechanicById(id) || {}).title;
  const picks = [...document.querySelectorAll('#view-sheets .sheet-pick')];
  const b = picks.find(x => x.textContent === title) || picks.find(x => x.textContent.indexOf(title.split(' (')[0]) === 0);
  b.click();
  const el = await H.waitFor(() => document.querySelector('#view-sheets .pb[data-board="' + board + '"]'), 4000, board + ' board');
  await H.waitFor(() => !/Loading/.test(H.text('.pb-foot', el) || ''), 4000, board + ' prices');
  await H.sleep(20);
  return el;
};

// ---- every board on its sheet --------------------------------------------------------------
out.boards = {};
for (const [id, board] of [['delve', 'delve'], ['essences', 'essences'], ['harvest', 'harvest'], ['blight', 'blight'],
    ['delirium', 'delirium'], ['breach', 'breach'], ['legion', 'legion'], ['expedition', 'expedition'],
    ['ultimatum', 'catalysts'], ['vendor', 'catalysts'], ['bestiary', 'bestiary']]) {
  const el = await open(id, board);
  out.boards[id + '/' + board] = { visible: H.visible(el), items: el.querySelectorAll('.pb-tile, .pb-grid td, .pb-lf tbody tr').length,
    foot: H.text('.pb-foot', el), sort: !!el.querySelector('.pb-sort') };
}

// ---- Delve: fossils by biome, best biome --------------------------------------------------
let el = await open('delve', 'delve');
const ft = table('delve', /^Fossils/), bt = table('delve', /^Biomes/);
const want = {}, wide = {};
const add = (f, b, node) => { (want[b] = want[b] || new Set()).add(f); if (!node) (wide[b] = wide[b] || new Set()).add(f); };
ft.rows.forEach(r => r[2].split(/,\s*(?![^(]*\))/).forEach(p => { const m = /^(.*?)\s*\((.+)\)$/.exec(p.trim()); add(r[0], m ? m[1] : p.trim(), !!m); }));
bt.rows.forEach(r => r[1] !== '-' && r[1].split(/,\s*/).forEach(f => add(f.trim(), r[0], false)));
let best = null;
Object.keys(wide).forEach(b => {
  const ps = [...wide[b]].map(priceOf).filter(p => p != null);
  if (!ps.length) return;
  const avg = ps.reduce((a, c) => a + c, 0) / ps.length;
  if (!best || avg > best.avg) best = { b, avg };
});
out.wantBest = 'Best biome now: ' + best.b + ' (avg ' + mechPriceText(best.avg) + ')';
out.bestLine = H.text('.pb-best-line', el);
out.bestRule = H.text('.pb-rule', el);
out.bestMark = [...el.querySelectorAll('.pb-group.is-best .pb-group-name')].map(n => n.textContent);
out.biomeOk = Object.keys(want).every(b => {
  const g = [...el.querySelectorAll('.pb-group')].find(x => x.dataset.group === b);
  return g && JSON.stringify(tileNames(g).sort()) === JSON.stringify([...want[b]].sort());
});
out.biomes = [...el.querySelectorAll('.pb-group')].map(g => g.dataset.group);
out.resonators = tileNames([...el.querySelectorAll('.pb-group')].find(g => g.dataset.group === 'Resonators') || document.createElement('div'));
out.nodeNote = [...el.querySelectorAll('.pb-tile')].filter(t => t.dataset.name === 'Bloodstained Fossil').map(t => H.text('.pb-note', t));
out.delveMissing = H.text('.pb-missing', el);
out.delveMissingWant = [...new Set(Object.values(want).flatMap(s => [...s]))].filter(n => priceOf(n) == null).length;
// sort by name inside a biome
const mag = () => [...el.querySelectorAll('.pb-group')].find(g => g.dataset.group === 'Magma Fissure');
const priceSorted = [...mag().querySelectorAll('.pb-tile')].map(t => priceOf(t.dataset.name));
H.button(el, 'Name').click();
await H.sleep(30);
el = document.querySelector('#view-sheets .pb[data-board="delve"]');
out.delvePriceSorted = priceSorted.every((p, i) => !i || priceSorted[i - 1] >= p);
const nameSorted = tileNames(mag());
out.delveNameSorted = JSON.stringify(nameSorted) === JSON.stringify(nameSorted.slice().sort((a, b) => a.localeCompare(b)));

// ---- Essences: the grid ---------------------------------------------------------------------
el = await open('essences', 'essences');
const tiers = table('essences', /^Tiers/).rows.map(r => r[1]);
const groups = table('essences', /^Essences by group/).rows;
const ranged = groups.filter(r => / \.\.\. /.test(r[2]));
const head = () => [...el.querySelectorAll('.pb-grid thead th')].slice(1).map(t => t.textContent);
const cellsOk = () => [...el.querySelectorAll('.pb-grid tbody tr')].every(tr => {
  const base = tr.dataset.essence, row = ranged.find(r => r[1] === base);
  const [a, b] = row[2].split(' ... ').map(t => tiers.indexOf(t));
  return [...tr.querySelectorAll('td')].every(td => {
    const i = tiers.indexOf(td.dataset.tier);
    if (i < a || i > b) return td.textContent === 'n/a';
    return td.textContent === mechPriceText(priceOf(td.dataset.tier + ' ' + base));
  });
});
out.essHeadTop = head();
out.essRows = el.querySelectorAll('.pb-grid tbody tr').length;
out.essWantRows = ranged.length;
out.essTopOk = cellsOk();
out.essFirstRowBest = (() => {
  const tr = el.querySelector('.pb-grid tbody tr');
  const ps = [...el.querySelectorAll('.pb-grid tbody tr')].map(r => Math.max(...[...r.querySelectorAll('td')].filter(td => td.textContent !== 'n/a')
    .map(td => priceOf(td.dataset.tier + ' ' + r.dataset.essence))));
  return ps.every((p, i) => !i || ps[i - 1] >= p);
})();
H.button(el, 'All ' + tiers.length).click();
await H.sleep(30);
out.essHeadAll = head();
out.essAllOk = cellsOk();
out.essAvail = [...el.querySelectorAll('.pb-grid td')].filter(td => td.textContent !== 'n/a').length;
out.essAvailWant = ranged.reduce((n, r) => { const [a, b] = r[2].split(' ... ').map(t => tiers.indexOf(t)); return n + b - a + 1; }, 0);
out.essSpecial = tileNames([...el.querySelectorAll('.pb-group')].find(g => g.dataset.group === 'Special (one tier)') || document.createElement('div')).sort();
out.essSpecialWant = groups.filter(r => !/ \.\.\. /.test(r[2])).map(r => r[1]).sort();

// ---- Harvest: lifeforce ---------------------------------------------------------------------
el = await open('harvest', 'harvest');
const lfRow = n => [...el.querySelectorAll('.pb-lf tbody tr')].find(tr => tr.dataset.name === n);
const cells = tr => tr ? [...tr.querySelectorAll('td')].map(td => td.textContent.trim()) : null;
out.lfHead = [...el.querySelectorAll('.pb-lf thead th')].map(t => t.textContent);
out.sacred = cells(lfRow('Sacred Crystallised Lifeforce'));
out.primal = cells(lfRow('Primal Crystallised Lifeforce'));
out.lfMarks = [...el.querySelectorAll('.pb-lf .pb-mark')].map(c => c.closest('tr').dataset.name);
out.lfSummary = H.text('.pb-summary', el);
out.lfRows = el.querySelectorAll('.pb-lf tbody tr').length;

// ---- Blight: tier order, price and name sort -----------------------------------------------
el = await open('blight', 'blight');
const tierOrder = table('blight', /^Oil tiers/).rows.map(r => r[1]);
const oilNames = () => tileNames([...el.querySelectorAll('.pb-group')][0]);
out.oilTier = JSON.stringify(oilNames()) === JSON.stringify(tierOrder);
out.oilNote = H.text('.pb-tile .pb-note', el);
H.button(el, 'Price').click();
await H.sleep(30);
const op = oilNames().map(priceOf);
out.oilPrice = op.every((p, i) => !i || op[i - 1] >= p) && op.length === tierOrder.length;
out.oilPriceText = H.text('.pb-tile .pb-price', el) === mechPriceText(op[0]);
H.button(el, 'Name').click();
await H.sleep(30);
const on = oilNames();
out.oilName = JSON.stringify(on) === JSON.stringify(on.slice().sort((a, b) => a.localeCompare(b)));

// ---- Delirium / Breach / Legion / Expedition / Catalysts ----------------------------------
el = await open('delirium', 'delirium');
out.delOrbs = tileNames([...el.querySelectorAll('.pb-group')][0]).length;
out.delOrbsWant = table('delirium', /^Delirium Orbs/).rows.length;
out.simNote = [...el.querySelectorAll('.pb-tile')].filter(t => t.dataset.name === 'Simulacrum Splinter').map(t => H.text('.pb-note', t))[0];
out.simWant = '300 make 1 Simulacrum · 300× = ' + mechPriceText(priceOf('Simulacrum Splinter') * 300) +
  ' (one costs ' + mechPriceText(priceOf('Simulacrum')) + ')';
el = await open('breach', 'breach');
out.breach = tileNames(el);
el = await open('legion', 'legion');
out.legion = tileNames(el);
out.vaalNote = [...el.querySelectorAll('.pb-tile')].filter(t => t.dataset.name === 'Timeless Vaal Splinter').map(t => H.text('.pb-note', t))[0];
el = await open('expedition', 'expedition');
out.exped = tileNames(el);
out.expedNote = H.text('.pb-tile .pb-note', el);
el = await open('ultimatum', 'catalysts');
out.catalysts = tileNames(el).length;
out.catSummary = H.text('.pb-summary', el);
// not on Expedition any more (3.29 removed catalyst chests there)
await open('expedition', 'expedition');
out.catOnExp = !!document.querySelector('#view-sheets .pb[data-board="catalysts"]');
el = await open('vendor', 'catalysts');
out.catVendor = H.text('.pb-summary', el);

// ---- Bestiary: stubbed beast prices --------------------------------------------------------
el = await open('bestiary', 'bestiary');
const beastTiles = () => [...el.querySelectorAll('.pb-tile')];
out.beastFirst = beastTiles().slice(0, 4).map(t => [t.dataset.name, H.text('.pb-price', t), !!t.querySelector('.pb-tag')]);
out.beastCalls = H.calls('beast_prices').length;
out.beastMissing = H.text('.pb-missing', el);
H.button(el, 'Recipe beasts').click();
await H.sleep(30);
out.recipeOnly = beastTiles().every(t => t.querySelector('.pb-tag')) && !beastTiles().some(t => t.dataset.name === 'Craicic Chimeral');
H.button(el, 'All beasts').click();
const q = el.querySelector('.mech-search');
q.value = 'vivid vulture'; q.dispatchEvent(new Event('input'));
await H.sleep(30);
out.beastSearch = beastTiles().map(t => t.dataset.name);
return out;
"""

OVERLAY_JS = r"""
const H = window.__e2e;
const out = {};
window.__sheetOpen('essences');
await H.waitFor(() => [...document.querySelectorAll('.sheet-panel button')].some(b => b.textContent.trim() === 'Tools'), 4000, 'Tools tab');
out.tabs = [...document.querySelectorAll('.sheet-panel .guide-ov-tabs .seg')].map(b => b.textContent);
[...document.querySelectorAll('.sheet-panel button')].find(b => b.textContent.trim() === 'Tools').click();
const el = await H.waitFor(() => document.querySelector('.sheet-panel .pb[data-board="essences"]'), 4000, 'board');
await H.waitFor(() => el.querySelector('.pb-grid td') && !/Loading/.test(H.text('.pb-foot', el) || ''), 4000, 'prices');
out.visible = H.visible(el) && el.classList.contains('is-overlay');
out.head = [...el.querySelectorAll('.pb-grid thead th')].slice(1).map(t => t.textContent);
out.priced = [...el.querySelectorAll('.pb-grid td')].filter(td => /c$|div$/.test(td.textContent)).length;
out.inputs = el.querySelectorAll('input, select, textarea').length;
const fits = H.calls('overlay_fit').length;
H.button(el, 'All 7').click();
await H.sleep(40);
out.headAll = el.querySelectorAll('.pb-grid thead th').length - 1;
out.refit = H.calls('overlay_fit').length > fits;
out.width = Math.round(document.querySelector('.sheet-panel').getBoundingClientRect().width);
// bestiary on its Tools tab: click-only (no search box), capped list
window.__stubOverrides.beast_prices = { ok: true, divine: 200, items: Array.from({ length: 20 }, (_, i) => ['Beast ' + i, 100 - i, 3]) };
window.__sheetOpen('bestiary');
await H.waitFor(() => [...document.querySelectorAll('.sheet-panel button')].some(b => b.textContent.trim() === 'Tools'), 4000, 'Tools tab');
[...document.querySelectorAll('.sheet-panel button')].find(b => b.textContent.trim() === 'Tools').click();
const be = await H.waitFor(() => document.querySelector('.sheet-panel .pb[data-board="bestiary"] .pb-tile'), 4000, 'beasts');
const board = be.closest('.pb');
out.beastTiles = board.querySelectorAll('.pb-tile').length;
out.beastInputs = board.querySelectorAll('input, select, textarea').length;
const more = board.querySelector('.pb-more');
out.moreText = more ? more.textContent : null;
if (more) { more.click(); await H.sleep(30); }
out.beastAll = board.querySelectorAll('.pb-tile').length;
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP_JS, timeout=90)
    check(tag + " no bridge: names show, no prices, 'Prices show in the app.'", r["plainTiles"] > 20 and
          r["plainPriced"] == 0 and r["plainFoot"] == "Prices show in the app." and not r["plainMissing"],
          (r["plainTiles"], r["plainPriced"], r["plainFoot"]))
    bad = {k: v for k, v in r["boards"].items() if not (v["visible"] and v["items"] > 0 and v["sort"] and
                                                         (v["foot"] or "").startswith(("Prices: GGG", "Beast prices")))}
    check(tag + " every board renders on its sheet (11 placements) with sort + price-age footer",
          len(r["boards"]) == 11 and not bad, bad or r["boards"])
    check(tag + " Delve: fossils grouped by the sheet's biomes (+ Resonators)", r["biomeOk"] and
          "Resonators" in r["biomes"] and len(r["resonators"]) == 4, (r["biomes"], r["resonators"]))
    check(tag + " Delve: best-biome line right for the stub prices, rule shown, group marked",
          r["bestLine"] == r["wantBest"] and "average price" in (r["bestRule"] or "") and
          r["bestMark"] == [r["wantBest"].split(": ")[1].split(" (")[0]], (r["bestLine"], r["wantBest"], r["bestMark"]))
    check(tag + " Delve: node-only fossils say so", r["nodeNote"] and all("node" in (n or "") for n in r["nodeNote"]), r["nodeNote"])
    check(tag + " Delve: 'N items have no price this hour' line", r["delveMissingWant"] > 0 and
          (r["delveMissing"] or "").endswith("no price this hour.") and (r["delveMissing"] or "").startswith(str(r["delveMissingWant"])),
          (r["delveMissing"], r["delveMissingWant"]))
    check(tag + " Delve: price sort (default), then name sort inside a biome", r["delvePriceSorted"] and r["delveNameSorted"], r)
    check(tag + " Essences: top 3 tiers by default, one row per ranged essence, every cell its price or n/a",
          r["essHeadTop"] == ["Screaming", "Shrieking", "Deafening"] and r["essRows"] == r["essWantRows"] == 20 and
          r["essTopOk"] and r["essFirstRowBest"], (r["essHeadTop"], r["essRows"], r["essTopOk"]))
    check(tag + " Essences: 'All 7' shows every tier; available cells match the sheet's ranges",
          len(r["essHeadAll"]) == 7 and r["essAllOk"] and r["essAvail"] == r["essAvailWant"] == 100,
          (r["essHeadAll"], r["essAvail"], r["essAvailWant"]))
    check(tag + " Essences: the one-tier specials as tiles", r["essSpecial"] == r["essSpecialWant"] and len(r["essSpecial"]) == 4,
          r["essSpecial"])
    check(tag + " Harvest: each / per 100 / per 1,000, Sacred marked most valuable",
          r["lfRows"] == 4 and r["lfHead"][:4] == ["Lifeforce", "Each", "Per 100", "Per 1,000"] and
          r["sacred"][1:4] == ["40c", "20 div", "200 div"] and r["primal"][1:4] == ["0.5c", "50c", "2.5 div"] and
          r["lfMarks"] == ["Sacred Crystallised Lifeforce"] and "Most valuable" in r["sacred"][0] and
          (r["lfSummary"] or "").startswith("Most valuable now: Sacred"), (r["sacred"], r["primal"], r["lfMarks"], r["lfSummary"]))
    check(tag + " Blight: oils low to high tier by default; price and name sort", r["oilTier"] and r["oilPrice"] and
          r["oilPriceText"] and r["oilName"] and (r["oilNote"] or "").startswith("Tier 1"), r)
    check(tag + " Delirium: the sheet's orbs + Simulacrum splinter maths", r["delOrbs"] == r["delOrbsWant"] and
          r["simNote"] == r["simWant"], (r["delOrbs"], r["simNote"], r["simWant"]))
    check(tag + " Breach: sheet items + blessings", "Hivebrain Gland" in r["breach"] and "Flesh of Xesht" in r["breach"] and
          "Blessing of Xoph" in r["breach"] and not any("Simulacrum" in n or "Timeless" in n for n in r["breach"]), r["breach"])
    check(tag + " Legion: 5 splinters + 5 emblems, 100-splinter note", len(r["legion"]) == 10 and
          all(n.startswith("Timeless ") for n in r["legion"]) and (r["vaalNote"] or "").startswith("100 make 1 Vaal Emblem"),
          (r["legion"], r["vaalNote"]))
    check(tag + " Expedition: the 4 vendor currencies, vendor named", sorted(r["exped"]) ==
          ["Astragali", "Burial Medallion", "Exotic Coinage", "Scrap Metal"] and
          "’s currency" in (r["expedNote"] or ""), (r["exped"], r["expedNote"]))
    check(tag + " Catalysts on Ultimatum (the 3.29 source, quoted from the verified tool data) + Vendor, not Expedition",
          r["catalysts"] == 13 and "Catalyst" in (r["catSummary"] or "") and "Ultimatum" in (r["catSummary"] or "")
          and not r["catOnExp"] and (r["catVendor"] or "").startswith("On this sheet:"),
          (r["catalysts"], r["catSummary"], r["catOnExp"], r["catVendor"]))
    check(tag + " Bestiary: stubbed beast prices, most valuable first, recipe beasts tagged",
          r["beastFirst"][0] == ["Black Mórrigan", "1.5 div", True] and r["beastFirst"][1][:2] == ["Vivid Vulture", "60c"] and
          any(b[0] == "Craicic Chimeral" and not b[2] for b in r["beastFirst"]) and r["beastCalls"] == 1,
          (r["beastFirst"], r["beastCalls"]))
    check(tag + " Bestiary: recipe filter, search, unpriced recipe beasts counted", r["recipeOnly"] and
          r["beastSearch"] == ["Vivid Vulture"] and (r["beastMissing"] or "").endswith("no price this hour."),
          (r["recipeOnly"], r["beastSearch"], r["beastMissing"]))

    s.fresh("?sheet=1")
    r = s.run(OVERLAY_JS, timeout=60)
    check(tag + " overlay: Tools tab shows the essence board, top 3 tiers priced, no inputs", "Tools" in r["tabs"] and
          r["visible"] and r["head"] == ["Screaming", "Shrieking", "Deafening"] and r["priced"] == 60 and r["inputs"] == 0,
          (r["tabs"], r["head"], r["priced"], r["inputs"]))
    check(tag + " overlay: tier toggle by click re-fits the window", r["headAll"] == 7 and r["refit"], (r["headAll"], r["refit"]))
    check(tag + " overlay: beasts capped at 12, no search box, 'Show all' by click", r["beastTiles"] == 12 and
          r["beastInputs"] == 0 and (r["moreText"] or "").startswith("Show all") and r["beastAll"] > 12,
          (r["beastTiles"], r["beastInputs"], r["moreText"], r["beastAll"]))
