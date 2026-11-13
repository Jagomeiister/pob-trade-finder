"""67 recipes — the Bestiary recipe browser (js/app/45-beastrecipes.js): recipes from the sheet's
table, filtered by item kind, each beast with its price and the recipe's total; a beast shows every
recipe that uses it; in game it is click-only and capped."""
TAG = "67 recipes"

APP = r"""
const H = window.__e2e;
const out = {};
const T = mechanicById('bestiary').sections.find(s => /^Recipes/.test(s.title));
const beastOf = (row) => row[2].split(/\s+\+\s+/).filter(b => !/^Any /.test(b));
const multi = T.rows.find(r => beastOf(r).length >= 2);
const B = beastOf(multi);
// prices: the first beast of that recipe 100c, the second none; one other beast 7c
const other = T.rows.map(beastOf).flat().find(b => !B.includes(b));
window.__stubOverrides.beast_prices = { ok: true, divine: 200, items: [[B[0], 100, 5], [other, 7, 9]] };
document.getElementById('open-sheets').click();
await H.sleep(100);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('bestiary').title).click();
const tool = await H.waitFor(() => document.querySelector('#view-sheets .mech-tool[data-tool="beastrecipes"]'), 5000, 'recipe browser');
await H.waitFor(() => tool.querySelector('.br-beast-chip .mech-item-price'), 5000, 'beast prices');
const rows = () => [...tool.querySelectorAll('.br-row')];
out.total = T.rows.length;
out.allChip = H.text('.br-kind[data-kind="all"]', tool);
out.shown = rows().length;
out.more = H.text('.br-more', tool);
out.types = tool.querySelectorAll('.br-type').length;
// the multi-beast recipe: one price, total 100c, one unpriced
tool.querySelector('.br-more') && tool.querySelector('.br-more').click();
await H.sleep(30);
const mrow = rows().find(r => r.dataset.recipe === String(T.rows.indexOf(multi)));
out.multi = [H.text('.br-total', mrow), H.text('.br-missing', mrow), mrow.querySelectorAll('.br-beast-chip').length, B.length];
// kind filter: Flask
tool.querySelector('.br-kind[data-kind="flask"]').click();
await H.sleep(30);
out.flask = [rows().length, T.rows.filter(r => /\bflasks?\b/i.test(r[0] + ' ' + r[1])).length,
  tool.querySelector('.br-kind[data-kind="flask"]').getAttribute('aria-pressed')];
out.anyText = rows().some(r => /Any Creature/.test(r.textContent));
tool.querySelector('.br-kind[data-kind="all"]').click();
await H.sleep(30);
// click a beast: every recipe that uses it
tool.querySelector('.br-more') && tool.querySelector('.br-more').click();
await H.sleep(30);
rows().find(r => r.dataset.recipe === String(T.rows.indexOf(multi))).querySelector('.br-beast-chip').click();
await H.sleep(30);
const uses = T.rows.filter(r => beastOf(r).includes(B[0])).length;
out.beast = [rows().length, uses, H.text('.br-beast b', tool), rows().every(r => r.textContent.includes(B[0]))];
H.button(tool.querySelector('.br-beast'), 'Show all beasts').click();
await H.sleep(30);
// cheapest first: fully priced recipes lead
[...tool.querySelectorAll('.br-bar .seg')].find(b => b.textContent === 'Cheapest').click();
await H.sleep(30);
out.cheapFirst = [H.text('.br-total', rows()[0]), !rows()[0].querySelector('.br-missing')];
// search (app only)
const q = tool.querySelector('input.mech-search');
q.value = 'helmet'; q.dispatchEvent(new Event('input'));
await H.sleep(30);
out.search = [rows().length, T.rows.filter(r => /helmet/i.test(r.join(' '))).length];
return out;
"""

OVERLAY = r"""
const H = window.__e2e;
const out = {};
window.__sheetOpen('bestiary');
await H.sleep(120);
const p = document.querySelector('.sheet-panel');
[...p.querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Tools').click();
await H.sleep(60);
const tool = p.querySelector('.mech-tool[data-tool="beastrecipes"]');
out.has = !!tool;
out.inputs = tool.querySelectorAll('input, textarea').length;
out.rows = tool.querySelectorAll('.br-row').length;
const fits = H.calls('overlay_fit').length;
tool.querySelector('.br-kind[data-kind="map"]').click();
await H.sleep(60);
out.fit = H.calls('overlay_fit').length > fits;
out.mapRows = tool.querySelectorAll('.br-row').length;
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP, timeout=60)
    check(tag + " every recipe is counted; the list is capped with 'Show all', grouped by type",
          r["allChip"] == "All %d" % r["total"] and r["shown"] == 40 and (r["more"] or "").startswith("Show all") and r["types"] > 3, r)
    check(tag + " a recipe adds up its priced beasts and says how many have no price",
          r["multi"][0] == "100c" and r["multi"][1] == "+%d unpriced" % (r["multi"][3] - 1) and r["multi"][2] == r["multi"][3], r["multi"])
    check(tag + " kind filter: Flask shows exactly the flask recipes (with their 'Any Creature' text)",
          r["flask"][0] == r["flask"][1] > 0 and r["flask"][2] == "true" and r["anyText"], r["flask"])
    check(tag + " clicking a beast lists every recipe that uses it", r["beast"][0] == r["beast"][1] > 0 and r["beast"][3], r["beast"])
    check(tag + " Cheapest: fully priced recipes first", r["cheapFirst"] == ["7c", True], r["cheapFirst"])
    check(tag + " search narrows the list", r["search"][0] == r["search"][1] > 0, r["search"])
    s.fresh("?sheet=1")
    r = s.run(OVERLAY, timeout=40)
    check(tag + " in game: on the Tools tab, click-only, capped at 10, re-fits on a filter",
          r["has"] and r["inputs"] == 0 and r["rows"] == 10 and r["fit"] and 0 < r["mapRows"] <= 10, r)
