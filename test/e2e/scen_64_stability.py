"""64 stability — fixes from the 10 Nov app review:
- a price load that brings no prices (feed unreachable) is retried: the tools show a Retry link,
  and a retry fills the prices in without reopening the sheet
- changing the league saves the setting, tells the in-game windows, and redraws the open sheet
  with the new league's prices
"""
TAG = "64 stability"

RETRY = r"""
const H = window.__e2e;
const out = {};
window.__stubOverrides.mech_prices = { ok: true, hour: null, divine: null, items: {} };   // offline answer
document.getElementById('open-sheets').click();
await H.sleep(120);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('scarabs').title).click();
const hub = await H.waitFor(() => document.querySelector('#view-sheets .mech-tool[data-tool="scarabhub"]'), 5000, 'hub');
await H.waitFor(() => MECH_PRICES.failed, 5000, 'failed load noticed');
await H.sleep(60);
out.failed = MECH_PRICES.failed;
out.retryLink = !!hub.querySelector('.mech-retry');
out.pricesBefore = hub.querySelectorAll('.shub-scarab .shub-price').length;
out.timer = !!mechRetry.timer;
out.calls0 = H.calls('mech_prices').length;
delete window.__stubOverrides.mech_prices;                                               // back online
hub.querySelector('.mech-retry').click();
await H.waitFor(() => hub.querySelector('.shub-scarab[data-name="Ambush Scarab of Containment"] .shub-price'), 6000, 'prices after retry');
out.calls1 = H.calls('mech_prices').length;
out.failedAfter = MECH_PRICES.failed;
out.retryGone = !document.querySelector('#view-sheets .mech-tool[data-tool="scarabhub"] .mech-retry');
out.timerAfter = !!mechRetry.timer;
return out;
"""

LEAGUE = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(120);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('scarabs').title).click();
await H.waitFor(() => document.querySelector('#view-sheets .shub-scarab .shub-price'), 6000, 'prices');
const sel = document.getElementById('league');
const other = [...sel.options].map(o => o.value).find(v => v !== sel.value);
out.other = other;
const n0 = H.calls('trade_prefs_changed').length, m0 = H.calls('mech_prices').length;
sel.value = other;
sel.dispatchEvent(new Event('change', { bubbles: true }));
await H.waitFor(() => H.calls('trade_prefs_changed').length > n0, 4000, 'overlays told');
await H.waitFor(() => H.calls('mech_prices').length > m0, 4000, 'prices asked again');
const all = window.__calls.map(c => c.name);
const saved = H.calls('storage_set').filter(c => c.args[0] === 'pobtf-settings').slice(-1)[0];
out.savedLeague = JSON.parse(saved.args[1]).league;
out.order = all.lastIndexOf('trade_prefs_changed') > window.__calls.indexOf(saved);
out.askedLeague = H.calls('mech_prices').slice(-1)[0].args[0];
out.priceLeague = MECH_PRICES.league;
out.stillSheets = document.body.dataset.view === 'sheets' && !!document.querySelector('#view-sheets .mech-tool[data-tool="scarabhub"]');
return out;
"""


def run(s, tag, check):
    s.fresh()
    r = s.run(RETRY, timeout=60)
    check(tag + " a load with no prices: marked failed, a Retry link shows, a retry is scheduled",
          r["failed"] and r["retryLink"] and r["timer"] and r["pricesBefore"] == 0, r)
    check(tag + " Retry asks again and fills the prices in; the link and the timer go",
          r["calls1"] > r["calls0"] and not r["failedAfter"] and r["retryGone"] and not r["timerAfter"], r)
    s.fresh()
    r = s.run(LEAGUE, timeout=60)
    check(tag + " league change: saved, then the in-game windows are told", r["savedLeague"] == r["other"] and r["order"], r)
    check(tag + " league change: the open sheet's prices are asked again for the new league",
          r["askedLeague"] == r["other"] and r["priceLeague"] == r["other"] and r["stillSheets"], r)
