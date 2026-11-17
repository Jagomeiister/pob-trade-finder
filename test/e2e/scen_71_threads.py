"""71 threads: the Threads planner (js/app/47-threads.js) on the Threads and Shaped Regions sheet,
headless. Loaded by run_e2e.py (_extra_scenarios). Prices come from the mech_prices stub: every
currencymap item (the 11 Threads included) at a fixed price per name."""

TAG = "71 threads"

S71 = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(80);
const btn = [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === 'Threads and Shaped Regions');
out.listed = !!btn;
btn.click();
const tool = await H.waitFor(() => document.querySelector('#view-sheets .mech-tool[data-tool="threads"]'), 5000, 'planner');
await H.waitFor(() => tool.querySelector('.thr-row[data-type="Breach"] .thr-price') &&
  /c|div/.test(H.text('.thr-row[data-type="Breach"] .thr-price', tool)), 8000, 'thread prices');
const row = t => tool.querySelector('.thr-row[data-type="' + t + '"]');
const inc = t => row(t).querySelector('[aria-label="One more ' + t + ' Thread"]');
const setN = async (t, n) => { const i = row(t).querySelector('input.shub-step-n'); i.value = String(n); i.dispatchEvent(new Event('change')); await H.sleep(20); };
const cost = () => Number(tool.querySelector('.thr-cost').dataset.chaos);
const price = t => MECH_PRICES.byName[t + ' Thread'].chaos;
out.types = [...tool.querySelectorAll('.thr-row[data-type]')].map(r => r.dataset.type);
out.frayed = !!tool.querySelector('.thr-frayed') && /random Thread/.test(H.text('.thr-frayed', tool));
out.overlayTool = mechToolsFor('threads', true).some(t => t.id === 'threads');
// 3 Breach + 4 Legion
await setN('Breach', 3);
await setN('Legion', 4);
out.total = H.text('.thr-total', tool);
out.cost = [cost(), Math.round((3 * price('Breach') + 4 * price('Legion')) * 100) / 100];
// the cap: one more fits (8), then nothing more on any Thread
inc('Breach').click(); await H.sleep(20);
out.capped = [H.text('.thr-total', tool), inc('Breach').disabled, inc('Abyss').disabled];
await setN('Abyss', 5); // no room: stays 0
out.abyssAfterCap = row('Abyss').querySelector('input.shub-step-n').value;
// four types: the unofficial 3-type note
await setN('Breach', 2); await setN('Legion', 2); await setN('Abyss', 1); await setN('Ritual', 1);
out.warn = H.text('.thr-warn', tool);
// maps per hour
const mi = tool.querySelector('input[aria-label="Maps per hour"]'); mi.value = '10'; mi.dispatchEvent(new Event('change')); await H.sleep(20);
out.hour = [Number(tool.querySelector('.thr-cost-hour').dataset.chaos), Math.round(cost() * 10 * 100) / 100];
// free Threads from a Ritual Shaped Region
const fs = tool.querySelector('select[aria-label="Shaped Region type of this map"]'); fs.value = 'Ritual'; fs.dispatchEvent(new Event('change')); await H.sleep(20);
const fn = tool.querySelector('input[aria-label="Free Ritual Threads from the Shaped Region"]'); fn.value = '2'; fn.dispatchEvent(new Event('change')); await H.sleep(20);
out.freeChip = H.text('.thr-row[data-type="Ritual"] .thr-freechip', tool);
out.costWithFree = [cost(), Math.round((2 * price('Breach') + 2 * price('Legion') + price('Abyss') + price('Ritual')) * 100) / 100];
// saved
out.saved = JSON.parse(localStorage.getItem('pobtf-thread-setup') || 'null');
// Unwavering Vision: one type kept, the others locked, +2 shown
tool.querySelector('.thr-uv input').click(); await H.sleep(30);
out.uv = [[...tool.querySelectorAll('.thr-row.is-on')].map(r => r.dataset.type), inc('Legion').disabled,
  H.text('.thr-sum', tool)];
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(S71, timeout=60)
    check(tag + " the planner sits on the Threads sheet (and in the in-game Tools tab): ten Threads + Frayed Thread",
          r["listed"] and r["types"] == ["Abyss", "Bestiary", "Betrayal", "Blight", "Breach", "Expedition", "Incursion",
                                         "Legion", "Ritual", "Ultimatum"] and r["frayed"] and r["overlayTool"], r)
    check(tag + " cost per map from live prices", r["total"] == "7 / 8 Threads" and abs(r["cost"][0] - r["cost"][1]) < 0.01,
          (r["total"], r["cost"]))
    check(tag + " the cap of 8: no more of any Thread once full", r["capped"] == ["8 / 8 Threads", True, True] and
          r["abyssAfterCap"] == "0", (r["capped"], r["abyssAfterCap"]))
    check(tag + " four types: says the 3-type limit is unofficial", "unofficial" in (r["warn"] or "") and "3" in r["warn"], r["warn"])
    check(tag + " cost per hour = maps per hour x cost per map", abs(r["hour"][0] - r["hour"][1]) < 0.05, r["hour"])
    check(tag + " free Shaped Region Threads shown, and not charged", r["freeChip"] == "+2 free" and
          abs(r["costWithFree"][0] - r["costWithFree"][1]) < 0.01, (r["freeChip"], r["costWithFree"]))
    sv = r["saved"] or {}
    check(tag + " the setup is saved", sv.get("counts") == {"Abyss": 1, "Breach": 2, "Legion": 2, "Ritual": 1} and
          sv.get("freeType") == "Ritual" and sv.get("free") == 2 and sv.get("maps") == 10, sv)
    on, legion_locked, summary = r["uv"]
    check(tag + " Unwavering Vision keeps one Thread type, locks the others, adds 2", on == ["Abyss"] and legion_locked and
          "+2 from Unwavering Vision" in summary, r["uv"])
