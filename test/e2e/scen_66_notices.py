"""66 notices — banners and retired content from the guides payload (33-guides.js):
- before a notice's start time nothing shows; after it, the banner is on guide sheets, on sheets
  without a guide and on the in-game quick card
- "Got it" hides it everywhere and is remembered
- a notice with untilAsOf is hidden on a guide that has reached that patch
- retired scarabs: the scarab hub shows the message instead of the list, and strategy cards
  label their scarab line
"""
TAG = "66 notices"

AFTER = "Date.UTC(2026, 10, 20)"

APP = r"""
const H = window.__e2e;
const out = {};
const G = window.POE_GUIDES;
out.payload = [(G.notices || []).length, Object.keys(G.retired || {})];
document.getElementById('open-sheets').click();
await H.sleep(100);
const pick = (id) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById(id).title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
pick('blight'); await H.sleep(80);
out.before = panel().querySelectorAll('.guide-notice').length;
out.hubBefore = (pick('scarabs'), await H.sleep(150), !!panel().querySelector('.shub') && !panel().querySelector('.shub-retired'));
window.__guideNow = AFTER;
pick('blight'); await H.sleep(80);
out.afterGuide = [...panel().querySelectorAll('.guide-notice')].map(n => n.dataset.notice);
out.text = H.text('.guide-notice-text', panel());
out.afterAsOf = !!panel().querySelector('.guide-asof + .guide-notices');
// untilAsOf: a guide already at 3.30 doesn't show it
const real = G.guides.blight.asOf;
G.guides.blight.asOf = '3.30';
pick('delve'); await H.sleep(60); pick('blight'); await H.sleep(80);
out.hiddenAt330 = panel().querySelectorAll('.guide-notice').length;
G.guides.blight.asOf = real;
// a sheet without a guide (Scarabs): the notice, and the hub says scarabs are gone
pick('scarabs'); await H.sleep(150);
out.noGuide = panel().querySelectorAll('.guide-notices .guide-notice').length;
out.retired = H.text('.shub-retired .guide-notice-text', panel());
out.hubList = panel().querySelectorAll('.shub-scarab').length;
// strategy cards label the scarab line
pick('atlas'); await H.sleep(120);
const k = [...panel().querySelectorAll('.guide-strat .guide-k')].map(e => e.textContent);
out.scarabLabel = k.filter(t => /^Scarabs/.test(t))[0];
// Got it: gone here and on other sheets, saved
panel().querySelector('.guide-notice .btn').click();
await H.sleep(40);
out.goneHere = panel().querySelectorAll('.guide-notices .guide-notice').length;
pick('blight'); await H.sleep(80);
out.goneThere = panel().querySelectorAll('.guide-notices .guide-notice').length;
out.saved = JSON.parse(H.calls('storage_set').filter(c => c.args[0] === 'pobtf-notice-seen').slice(-1)[0].args[1]);
return out;
"""

OVERLAY = r"""
const H = window.__e2e;
const out = {};
window.__guideNow = AFTER;
window.__sheetOpen('blight');
await H.sleep(100);
const p = () => document.querySelector('.sheet-panel');
out.ov = p().querySelectorAll('.guide-ov-pane[data-tab="quick"] .guide-notice').length;
const fits = H.calls('overlay_fit').length;
p().querySelector('.guide-notice .btn').click();
await H.sleep(60);
out.gone = p().querySelectorAll('.guide-notice').length;
out.refit = H.calls('overlay_fit').length > fits;
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(APP.replace("AFTER", AFTER), timeout=60)
    check(tag + " the payload carries the 3.30 notice and the retired-scarabs flag", r["payload"][0] >= 1 and "scarabs" in r["payload"][1], r["payload"])
    check(tag + " before the start time: no banner, the scarab hub works", r["before"] == 0 and r["hubBefore"], r)
    check(tag + " after it: the banner shows on a guide, right under the as-of note",
          r["afterGuide"] == ["330-launch"] and "3.30" in (r["text"] or "") and r["afterAsOf"], r)
    check(tag + " a guide already at 3.30 doesn't show it (untilAsOf)", r["hiddenAt330"] == 0, r["hiddenAt330"])
    check(tag + " a sheet without a guide shows it too", r["noGuide"] == 1, r["noGuide"])
    check(tag + " retired scarabs: the hub shows the message, no scarab list",
          "removed" in (r["retired"] or "") and r["hubList"] == 0, (r["retired"], r["hubList"]))
    check(tag + " strategy cards label their scarab line as removed", r["scarabLabel"] == "Scarabs (removed in 3.30)", r["scarabLabel"])
    check(tag + " Got it hides the notice on every sheet and is saved",
          r["goneHere"] == 0 and r["goneThere"] == 0 and r["saved"] == ["330-launch"], r)
    s.fresh("?sheet=1")
    r = s.run(OVERLAY.replace("AFTER", AFTER), timeout=40)
    check(tag + " in game: the notice is on the quick card; Got it removes it and re-fits the window",
          r["ov"] == 1 and r["gone"] == 0 and r["refit"], r)
