"""60 scarabhub: the Scarab hub and the profit calculator (js/app/41-scarabhub.js), headless.
Loaded by run_e2e.py (_extra_scenarios). Prices come from the mech_prices stub: every currencymap
item at a fixed price, Ambush Scarab of Containment 30c, Horned Scarab of Bloodlines 50c,
Divine Orb 200c, no icons."""
import json
import urllib.parse

TAG = "60 scarabhub"

# open Cheat sheets -> Scarabs; both tools sit at the top of that sheet
OPEN = r"""
const H = window.__e2e;
// these steps test the atlas guide's strategies (the fallback): no tool-data strategies unless a
// script sets its own (S60_TOOLS)
if (!window.__e2eKeepTools) window.POE_GUIDES.tools = null;
document.getElementById('open-sheets').click();
await H.sleep(150);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('scarabs').title).click();
const hub = await H.waitFor(() => document.querySelector('#view-sheets .mech-tool[data-tool="scarabhub"]'), 5000, 'scarab hub');
const calc = await H.waitFor(() => document.querySelector('#view-sheets .mech-tool[data-tool="profitcalc"]'), 5000, 'profit calc');
await H.waitFor(() => hub.querySelector('.shub-scarab[data-name="Ambush Scarab of Containment"] .shub-price'), 8000, 'scarab prices');
await H.waitFor(() => MECH_PRICES.groups.fossils && MECH_PRICES.groups.currency, 8000, 'every price group');
await H.sleep(30);
const dlg = () => document.querySelector('dialog.ui-dialog[open]');
const names = () => [...hub.querySelectorAll('.shub-scarab')].map(b => b.dataset.name);
const row = n => hub.querySelector('.shub-row[data-name="' + n + '"]');
const count = n => row(n) && row(n).querySelector('input.shub-step-n').value;
const setupRows = () => [...hub.querySelectorAll('.shub-row[data-name]')].map(r => [r.dataset.name, r.querySelector('input.shub-step-n').value]);
const total = () => Number(hub.querySelector('.shub-total-amt').dataset.chaos);
const line = k => calc.querySelector('.pcalc-line[data-key="' + k + '"] .shub-amt').dataset.chaos;
const typeIn = (inp, v, ev) => { inp.value = v; inp.dispatchEvent(new Event(ev || 'input', { bubbles: true })); };
const pickStrategy = async (sel, name, answer) => {
  typeIn(sel, name, 'change');
  if (answer) {
    await H.waitFor(dlg, 2000, 'replace confirm');
    const t = H.text('.ui-dialog-title', dlg());
    H.button(dlg(), answer).click();
    await H.sleep(40);
    return t;
  }
  await H.sleep(40);
  return null;
};
"""

S60_HUB = OPEN + r"""
const out = {};
const all = names();
out.n = all.length;
out.top2 = all.slice(0, 2);
const ac = hub.querySelector('.shub-scarab[data-name="Ambush Scarab of Containment"]');
out.acPrice = H.text('.shub-price', ac);
out.acEffect = H.text('.shub-effect', ac);
out.acLimit = H.text('.shub-limit', ac);
out.acLabel = ac.getAttribute('aria-label');
out.acTag = ac.tagName;
// search and family
const search = hub.querySelector('.shub-controls input[type="search"]');
typeIn(search, 'containment');
out.search = names();
typeIn(search, 'strongboxes');
out.searchEffect = names().length;
typeIn(search, '');
const fam = hub.querySelector('select.shub-fam');
out.fams = [...fam.options].map(o => o.value);
typeIn(fam, 'Horned', 'change');
out.horned = names();
typeIn(fam, 'Titanic', 'change');
out.titanic = names();
typeIn(fam, '', 'change');
H.button(hub.querySelector('.shub-sort'), 'Name').click();
out.byName = names().slice(0, 3);
H.button(hub.querySelector('.shub-sort'), 'Price').click();
out.empty = H.text('.shub-rows .mech-empty', hub);

// adding scarabs
const pick = n => hub.querySelector('.shub-scarab[data-name="' + n + '"]').click();
pick('Ambush Scarab of Containment');
await H.sleep(20);
pick('Horned Scarab of Bloodlines');
await H.sleep(20);
out.total2 = [total(), H.text('.shub-total-amt', hub)];
out.inChip = H.text('.shub-scarab[data-name="Horned Scarab of Bloodlines"] .shub-in', hub);
// per-map limit: Containment allows 1
pick('Ambush Scarab of Containment');
await H.sleep(30);
out.acN = count('Ambush Scarab of Containment');
out.acInc = row('Ambush Scarab of Containment').querySelector('[aria-label="One more Ambush Scarab of Containment"]').disabled;
out.acMax = row('Ambush Scarab of Containment').querySelector('input.shub-step-n').max;
out.toast = [...document.querySelectorAll('#toasts .toast-msg')].map(e => e.textContent).pop();
// Ambush Scarab allows 3: one click + 3 steps up stays at 3; typing 9 stays at 3
pick('Ambush Scarab');
await H.sleep(20);
for (let i = 0; i < 3; i++) {
  const inc = row('Ambush Scarab').querySelector('[aria-label="One more Ambush Scarab"]');
  if (!inc.disabled) inc.click();
  await H.sleep(15);
}
out.amN = count('Ambush Scarab');
out.amIncOff = row('Ambush Scarab').querySelector('[aria-label="One more Ambush Scarab"]').disabled;
typeIn(row('Ambush Scarab').querySelector('input.shub-step-n'), '9', 'change');
await H.sleep(20);
out.amTyped = count('Ambush Scarab');
out.focusKept = document.activeElement && document.activeElement.dataset.fk;
const amC = mechChaos('Ambush Scarab');
out.expect3 = 80 + 3 * amC;
out.total3 = total();
// a typed cost and a picked item (Divine Orb, 200c) from the cost picker
const other = hub.querySelector('.shub-other');
typeIn(other.querySelector('.shub-typed-label'), 'Map');
typeIn(other.querySelector('.shub-typed-chaos'), '20');
H.button(other, 'Add amount').click();
await H.sleep(20);
out.total4 = total();
const q = other.querySelector('input[type="search"]');
typeIn(q, 'divine orb');
await H.sleep(20);
out.pickNames = [...other.querySelectorAll('.shub-pick')].map(b => b.dataset.name);
other.querySelector('.shub-pick[data-name="Divine Orb"]').click();
await H.sleep(20);
out.total5 = total();
out.divText = H.text('.shub-total-amt .shub-amt-d', hub);
// an item without a price: shown "no price", left out of the total, counted in a note
const keep = MECH_PRICES.byName['Horned Scarab of Bloodlines'].chaos;
MECH_PRICES.byName['Horned Scarab of Bloodlines'].chaos = null;
shubRefresh();
out.noPrice = [H.text('.shub-noprice', row('Horned Scarab of Bloodlines')), total(), H.text('.shub-missing', hub)];
MECH_PRICES.byName['Horned Scarab of Bloodlines'].chaos = keep;
shubRefresh();
// remove Divine Orb again
row('Divine Orb').querySelector('[aria-label="Remove Divine Orb"]').click();
await H.sleep(20);
out.total6 = total();

// presets: the setup isn't empty, so a confirm first; Cancel keeps it
const sel = hub.querySelector('select.shub-strat-select');
const calcSel = calc.querySelector('select.shub-strat-select');
out.options = [...sel.options].length;
const before = JSON.stringify(setupRows());
out.confirm = await pickStrategy(sel, 'Ethereal Allflame Scarab Farm', 'Cancel');
out.afterCancel = [sel.value, JSON.stringify(setupRows()) === before];
await pickStrategy(sel, 'Ethereal Allflame Scarab Farm', 'Replace');
out.preset = setupRows();
out.emberMax = row('Allflame Ember of the Ethereal') && row('Allflame Ember of the Ethereal').querySelector('input.shub-step-n').max;
out.typedKept = [...hub.querySelectorAll('.shub-row.is-typed')].map(r => r.dataset.label);
out.shared = calcSel.value;
out.leftEthereal = hub.querySelectorAll('.shub-left-item').length;
// a strategy with a line that matches no item: listed, not dropped
await pickStrategy(sel, 'Strongboxes + Deli + Beyond (pohx, SC only)', 'Replace');
out.preset2 = setupRows().map(r => r[0]);
out.left2 = [...hub.querySelectorAll('.shub-left-item')].map(li => li.textContent);
// optional lines: listed with an Add button
await pickStrategy(sel, 'Unstable Breach', 'Replace');
out.preset3 = setupRows();
out.left3 = [...hub.querySelectorAll('.shub-left-item')].map(li => [H.text('.shub-left-text', li), !!H.button(li, 'Add')]);
H.button(hub.querySelector('.shub-left'), 'Add').click();
await H.sleep(20);
out.addedOptional = count('Scarab of Monstrous Lineage');
await pickStrategy(sel, 'Ethereal Allflame Scarab Farm', 'Replace');
out.total7 = [total(), setupRows().length];
return out;
"""

S60_CALC = OPEN + r"""
const out = {};
// the setup the hub test left: preset + a typed 20c map
const sel = hub.querySelector('select.shub-strat-select');
const calcSel = calc.querySelector('select.shub-strat-select');
out.selValues = [sel.value, calcSel.value];
const setupT = total();
out.mphHint = H.text('.pcalc-mph-hint', calc);
typeIn(calc.querySelector('input.pcalc-mph'), '10');
out.cost0 = [Number(line('cost')), setupT, H.text('.pcalc-cost-hint', calc)];
const ret = calc.querySelector('.pcalc-ret');
typeIn(ret.querySelector('.shub-typed-label'), 'Drops');
typeIn(ret.querySelector('.shub-typed-chaos'), '500');
H.button(ret, 'Add amount').click();
await H.sleep(20);
const q = ret.querySelector('input[type="search"]');
typeIn(q, 'divine orb');
await H.sleep(20);
ret.querySelector('.shub-pick[data-name="Divine Orb"]').click();
await H.sleep(20);
typeIn(ret.querySelector('.shub-row[data-name="Divine Orb"] input.shub-step-n'), '2', 'change');
await H.sleep(20);
out.lines1 = ['return', 'cost', 'profit', 'profitHour', 'investHour'].map(k => Number(line(k)));
out.expect1 = [900, setupT, 900 - setupT, (900 - setupT) * 10, setupT * 10];
// the cost follows My setup live: add a 5c typed cost in the hub
const other = hub.querySelector('.shub-other');
typeIn(other.querySelector('.shub-typed-label'), 'Chisel');
typeIn(other.querySelector('.shub-typed-chaos'), '5');
H.button(other, 'Add amount').click();
await H.sleep(20);
out.live = [Number(line('cost')), setupT + 5];
// override the cost
typeIn(calc.querySelector('input.pcalc-cost'), '100');
await H.sleep(20);
out.lines2 = ['return', 'cost', 'profit', 'profitHour', 'investHour'].map(k => Number(line(k)));
out.hourText = H.text('.pcalc-line[data-key="profitHour"] .shub-amt', calc);
out.useSetup = H.visible(H.button(calc, 'Use My setup'));
// a loss says so in words
typeIn(calc.querySelector('input.pcalc-cost'), '1000');
await H.sleep(20);
out.loss = [H.text('.pcalc-line[data-key="profit"] .pcalc-label', calc), Number(line('profit'))];
typeIn(calc.querySelector('input.pcalc-cost'), '100');
await H.sleep(20);
// community estimates for the picked strategy
out.est = [...calc.querySelectorAll('.pcalc-est-text')].map(e => e.textContent);
out.estWho = [...calc.querySelectorAll('.pcalc-est-who')].map(e => e.textContent);
out.estLabels = [H.text('.pcalc-rough', calc), H.text('.pcalc-asof', calc)];
// the strategy select is shared: change it in the calc, the hub follows (and the confirm shows)
out.confirm = await pickStrategy(calcSel, 'Inscribed Ultimatum', 'Replace');
out.shared = [sel.value, calcSel.value, setupRows().map(r => r[0])];
out.est2 = [...calc.querySelectorAll('.pcalc-est-text')].map(e => e.textContent);
await pickStrategy(calcSel, '', null);
out.own = [sel.value, H.text('.pcalc-est .mech-empty', calc), setupRows().length];
await pickStrategy(calcSel, 'Ethereal Allflame Scarab Farm', 'Replace');
await H.sleep(30);
out.saved = [localStorage.getItem('pobtf-scarab-setup'), localStorage.getItem('pobtf-profit-calc')];
out.bridge = ['pobtf-scarab-setup', 'pobtf-profit-calc'].map(k => H.calls('storage_set').filter(c => c.args[0] === k).length);
out.final = { total: total(), lines: ['return', 'cost', 'profit', 'profitHour', 'investHour'].map(k => Number(line(k))),
  rows: setupRows(), typed: [...hub.querySelectorAll('.shub-row.is-typed')].map(r => r.dataset.label) };
return out;
"""

S60_RELOAD = r"""
const H = window.__e2e;
await H.waitFor(() => localStorage.getItem('pobtf-scarab-setup') && localStorage.getItem('pobtf-profit-calc'), 5000, 'saved setup');
""" + OPEN.replace("const H = window.__e2e;\n", "", 1) + r"""
return { total: total(), lines: ['return', 'cost', 'profit', 'profitHour', 'investHour'].map(k => Number(line(k))),
  rows: setupRows(), typed: [...hub.querySelectorAll('.shub-row.is-typed')].map(r => r.dataset.label),
  sel: hub.querySelector('select.shub-strat-select').value, calcSel: calc.querySelector('select.shub-strat-select').value,
  mph: calc.querySelector('input.pcalc-mph').value, cost: calc.querySelector('input.pcalc-cost').value,
  retRows: [...calc.querySelectorAll('.pcalc-rows .shub-row')].map(r => r.dataset.name || r.dataset.label) };
"""

# strategies from the tool data (mechToolData().strategies) win over the atlas guide; the atlas link opens
S60_TOOLS = r"""
const H = window.__e2e;
window.__e2eKeepTools = true;
window.POE_GUIDES.tools = { version: 1, asOf: '3.29', sources: [], strategies: [{ name: 'E2E strat', stage: ['late'],
  scarabs: [{ name: 'Ambush Scarab of Containment', count: 1 }, { name: 'Ambush Scarab', count: 5 }, { name: 'No Such Scarab', count: 1 }],
  maps: [], mapsPerHour: 12, costPerMapChaos: 300, mainDrops: [], atlasTreeUrl: 'https://poeplanner.com/atlas-tree/e2e',
  profit: [{ text: 'E2E claim: 9 div/h', who: 'Tester', date: '2026-11-01' }], cite: [] }] };
""" + OPEN.replace("const H = window.__e2e;\n", "", 1) + r"""
const out = {};
const sel = hub.querySelector('select.shub-strat-select');
out.options = [...sel.options].map(o => o.value);
await pickStrategy(sel, 'E2E strat', null);
out.rows = setupRows();
out.left = [...hub.querySelectorAll('.shub-left-item')].map(li => H.text('.shub-left-text', li));
out.info = H.text('.shub-strat-info .shub-note', hub);
out.mph = calc.querySelector('input.pcalc-mph').value;
out.est = [...calc.querySelectorAll('.pcalc-est-text')].map(e => e.textContent);
const link = H.button(hub, 'Open atlas tree');
out.link = !!link;
link.click();
await H.sleep(30);
out.opened = H.calls('open_url').map(c => c.args[0]);
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(S60_HUB, timeout=60)
    check(tag + " hub lists every scarab (sheet + price feed), as buttons, price sort first",
          r["n"] >= 115 and r["acTag"] == "BUTTON" and
          r["top2"] == ["Horned Scarab of Bloodlines", "Ambush Scarab of Containment"], (r["n"], r["top2"], r["acTag"]))
    check(tag + " a scarab shows its price, effect and per-map limit (and says it all to screen readers)",
          r["acPrice"] == "30c" and "Strongboxes" in (r["acEffect"] or "") and r["acLimit"] == "Max 1 per map" and
          "30c" in r["acLabel"] and "Up to 1 per map" in r["acLabel"], (r["acPrice"], r["acEffect"], r["acLimit"], r["acLabel"]))
    check(tag + " search by name, and by effect text",
          r["search"] == ["Ambush Scarab of Containment"] and r["searchEffect"] >= 3, (r["search"], r["searchEffect"]))
    check(tag + " family filter (Horned, Titanic, Other ...)",
          "Horned" in r["fams"] and "Ambush" in r["fams"] and "Other" in r["fams"] and len(r["horned"]) >= 7 and
          all(n.startswith("Horned Scarab") for n in r["horned"]) and
          all(n.startswith("Titanic Scarab") for n in r["titanic"]) and len(r["titanic"]) >= 3,
          (r["fams"], r["horned"], r["titanic"]))
    check(tag + " sort by name", r["byName"] == sorted(r["byName"]) and r["byName"][0].startswith("Abyss Scarab"), r["byName"])
    check(tag + " empty setup says how to start", "Pick scarabs" in (r["empty"] or ""), r["empty"])
    check(tag + " adding scarabs: 30c + 50c = 80c (0.4 div)", r["total2"][0] == 80 and "80c" in r["total2"][1] and
          "0.4 div" in r["total2"][1] and r["inChip"] == "In setup: 1", (r["total2"], r["inChip"]))
    check(tag + " per-map limit caps the stepper (Containment 1, Ambush Scarab 3) and says so",
          r["acN"] == "1" and r["acInc"] and r["acMax"] == "1" and "allows 1 per map" in (r["toast"] or "") and
          r["amN"] == "3" and r["amIncOff"] and r["amTyped"] == "3", (r["acN"], r["acInc"], r["toast"], r["amN"], r["amTyped"]))
    check(tag + " total: scarabs, typed map cost, picked Divine Orb",
          r["total3"] == r["expect3"] and r["total4"] == r["expect3"] + 20 and r["total5"] == r["expect3"] + 220 and
          r["total6"] == r["expect3"] + 20 and "Divine Orb" in r["pickNames"],
          (r["total3"], r["expect3"], r["total4"], r["total5"], r["total6"], r["pickNames"]))
    check(tag + " an item without a price: 'no price', left out of the total, counted in a note",
          r["noPrice"][0] == "no price" and r["noPrice"][1] == r["expect3"] + 220 - 50 and
          (r["noPrice"][2] or "").startswith("1 item has no price"), r["noPrice"])
    check(tag + " preset: confirm first, Cancel keeps the setup",
          r["options"] > 10 and r["confirm"] == "Replace My setup?" and r["afterCancel"] == ["", True],
          (r["options"], r["confirm"], r["afterCancel"]))
    check(tag + " preset fills the setup: '3x ... (up to 4 allowed)' -> 3, max 4; typed costs stay; calc follows",
          r["preset"] == [["Allflame Ember of the Ethereal", "3"], ["Horned Scarab of Bloodlines", "1"],
                          ["Betrayal Scarab of the Allflame", "1"]] and r["emberMax"] == "4" and
          r["typedKept"] == ["Map"] and r["shared"] == "Ethereal Allflame Scarab Farm" and r["leftEthereal"] == 0,
          (r["preset"], r["emberMax"], r["typedKept"], r["shared"]))
    check(tag + " preset: a line with no matching item is listed, not dropped",
          "Ambush Scarab of Containment" in r["preset2"] and "Ambush Scarab of Compartments" not in r["preset2"] and
          any("Ambush Scarab of Compartments" in t and "no matching item" in t for t in r["left2"]), (r["preset2"], r["left2"]))
    check(tag + " preset: optional lines (Budget:, High investment:) listed with Add",
          r["preset3"] == [["Scarab of Wisps", "1"], ["Breach Scarab of Instability", "2"]] and
          ["Budget: 2x Scarab of Monstrous Lineage", True] in r["left3"] and r["addedOptional"] == "2",
          (r["preset3"], r["left3"], r["addedOptional"]))

    r = s.run(S60_CALC, timeout=60)
    check(tag + " calc: strategy shared, cost per map = My setup total, maps-per-hour hint",
          r["selValues"] == ["Ethereal Allflame Scarab Farm"] * 2 and r["cost0"][0] == r["cost0"][1] and
          "From My setup" in (r["cost0"][2] or "") and "Your own pace" in (r["mphHint"] or ""), (r["selValues"], r["cost0"], r["mphHint"]))
    check(tag + " calc maths: return 500 + 2 x 200, profit per map/hour, investment per hour",
          r["lines1"] == r["expect1"], (r["lines1"], r["expect1"]))
    check(tag + " calc cost follows My setup live", r["live"][0] == r["live"][1], r["live"])
    check(tag + " calc cost override 100: profit 800/map, 8000/h = 40 div/h, investment 1000/h",
          r["lines2"] == [900, 100, 800, 8000, 1000] and "40 div" in (r["hourText"] or "") and r["useSetup"],
          (r["lines2"], r["hourText"], r["useSetup"]))
    check(tag + " a loss is worded, not only coloured", r["loss"] == ["Loss per map", -100], r["loss"])
    check(tag + " community estimates for the strategy, labelled rough and as of 3.29",
          len(r["est"]) == 2 and all(t.startswith("Ethereal Allflame") for t in r["est"]) and
          r["estWho"][0].startswith("AOEAH") and r["estLabels"] == ["rough, community claims", "as of 3.29"],
          (r["est"], r["estWho"], r["estLabels"]))
    check(tag + " picking in the calc updates the hub (confirm, setup refilled, estimates)",
          r["confirm"] == "Replace My setup?" and r["shared"][:2] == ["Inscribed Ultimatum"] * 2 and
          r["shared"][2] == ["Ultimatum Scarab of Bribing", "Domination Scarab"] and
          len(r["est2"]) == 1 and r["est2"][0].startswith("Inscribed Ultimatum"), (r["shared"], r["est2"]))
    check(tag + " 'My own' keeps the setup, no estimates", r["own"][0] == "" and "Pick a strategy" in (r["own"][1] or "") and
          r["own"][2] == 2, r["own"])
    check(tag + " saved through the bridge (pobtf-scarab-setup, pobtf-profit-calc)",
          all(r["saved"]) and all(n > 0 for n in r["bridge"]), r["bridge"])
    final = r["final"]
    store = {"pobtf-scarab-setup": r["saved"][0], "pobtf-profit-calc": r["saved"][1]}
    s.fresh("?e2eStore=" + urllib.parse.quote(json.dumps(store)))
    r = s.run(S60_RELOAD, timeout=60)
    check(tag + " reload: setup, strategy, maps per hour, override and returns come back",
          r["rows"] == final["rows"] and r["typed"] == final["typed"] and r["total"] == final["total"] and
          r["sel"] == r["calcSel"] == "Ethereal Allflame Scarab Farm" and r["mph"] == "10" and r["cost"] == "100" and
          r["retRows"] == ["Drops", "Divine Orb"], r)
    check(tag + " reload: same results", r["lines"] == final["lines"], (r["lines"], final["lines"]))

    s.fresh()
    r = s.run(S60_TOOLS, timeout=60)
    check(tag + " tool-data strategies replace the guide's; preset fills and caps (Ambush Scarab 5 -> 3)",
          r["options"] == ["", "E2E strat"] and r["rows"] == [["Ambush Scarab of Containment", "1"], ["Ambush Scarab", "3"]] and
          r["left"] == ["No Such Scarab"], (r["options"], r["rows"], r["left"]))
    check(tag + " tool data: maps per hour prefilled, figures labelled rough, estimates from the strategy",
          r["mph"] == "12" and "rough" in (r["info"] or "") and "300c" in (r["info"] or "") and
          r["est"] == ["E2E claim: 9 div/h"], (r["mph"], r["info"], r["est"]))
    check(tag + " atlas tree link opens through the bridge",
          r["link"] and r["opened"][-1:] == ["https://poeplanner.com/atlas-tree/e2e"], r["opened"])
