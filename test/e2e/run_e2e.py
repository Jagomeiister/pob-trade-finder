"""End-to-end UI tests — run: python test/e2e/run_e2e.py

Loads the real front end (index.html + js/ + css/ + data/*.js) in headless Chrome, served
from 127.0.0.1, with the Python bridge (window.pywebview.api) replaced by an in-page stub
that returns canned data, then drives user flows and asserts on DOM state. Offline: Chrome
resolves no hostname but 127.0.0.1, so pathofexile.com / poecdn art simply fails to load.
Needs Chrome at the usual path and websocket-client (already a project dependency).

Scenarios (each on a fresh page load with empty localStorage):
  1 landing    — no JS errors, desktop mode detected, league list = PC leagues, no duplicates
  2 decode     — fixture PoB code loads: sidebar nav, gear slot list, slot click switches card
  3 price      — "Check price" on a gear card renders listings and the build-cost summary
  4 pasted     — in-game Ctrl+C ring text becomes a pasted card; price check suggests "List at"
  5 market     — market tile opens the Market view; movers, watchlist star toggle, converter
  6 settings   — drawer opens, light theme applies, Copy diagnostics includes the page section
  7 keyboard   — Escape closes the settings drawer and returns focus to its opener
  8 wide       — at 2560px a priced card is a two-column grid (.card-side right of .card-main);
                 at 1440px it stacks
  9 flips      — Market chaos/divine gaps: volume/gap filter, min-volume select, error result
  10 diff      — re-importing an edited build lists the changed helmet with its old price, prices
                 it on request; same code / different class show no diff
  11 track     — saved build re-pricing: no timer searches, daily reminder, click re-prices, price line,
                 one alert (toast + notify), Re-price now in the form runs again
  12 batch     — Check all prices becomes a stop button, a gap between searches, stopping works
  13 weighted  — weighted-total search (weight group, 90% target), own item scores 100%, value sort
  14 stash     — official login off by default; signed in: nav entry, Stash value page, one run per click
  15 zoom      — menus line up at every Text size; 'query too complex' explained with ways forward
  16 sessid    — POESESSID: one-time disclaimer, Cancel saves nothing, never asks again or on clear
  17 v21       — seller dots/age/You/×N, 5-min cache + Refresh, Listed within, quick price, upgrade check, tiers, wiki

Run a subset by number or name: python test/e2e/run_e2e.py 3 diff

Every scenario also fails on any uncaught page exception (sync or unhandled rejection).
Bridge listings come from test/fixture-fetch.json through gui.Api._listing_from, so the
shape always matches what the real bridge sends. Prints PASS/FAIL lines, exit code 0/1.
"""
import base64
import copy
import json
import os
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import gui  # noqa: E402  (Api._listing_from: raw trade result -> UI listing shape)
from cdp import Browser, CDPError, StaticServer  # noqa: E402

failures = 0
try:  # listing text and stars must never crash a cp1252 console
    sys.stdout.reconfigure(errors="backslashreplace")
except (AttributeError, ValueError):
    pass


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail and not cond else ""))
    return cond


# ---- canned bridge data ---------------------------------------------------------------
def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


# chaos value of each currency — the market feed's latest point and exchange_rates agree
RATES = {"chaos": 1, "divine": 200, "exalted": 12, "mirror": 80000, "annul": 50,
         "alch": 0.5, "fusing": 0.8, "chance": 0.2, "regal": 1.0}


def make_market():
    """Synthetic cx_overview: 29 six-hourly points (7 days) per item, ending at RATES."""
    hour = int(time.time() // 3600) * 3600
    spec = {  # code: (name, 7-days-ago chaos, typical chaos volume/h) — under 5000 is "thin"
        "divine": ("Divine Orb", 180, 400000), "exalted": ("Exalted Orb", 15, 60000),
        "mirror": ("Mirror of Kalandra", 70000, 1000), "annul": ("Orb of Annulment", 50, 20000),
        "alch": ("Orb of Alchemy", 0.45, 9000), "fusing": ("Orb of Fusing", 0.9, 12000),
        "chance": ("Orb of Chance", 0.2, 800), "regal": ("Regal Orb", 0.8, 7000),
    }
    items = {}
    for code, (name, start, vol) in spec.items():
        end = RATES[code]
        pts = []
        for k in range(29):
            t = hour - (28 - k) * 6 * 3600
            pts.append([t, float("%.4g" % (start + (end - start) * k / 28.0)), vol])
        items[code] = {"name": name, "cat": "Currency", "img": "", "s": pts}
    return {"hour": hour, "items": items}


def make_listings():
    """Ten listings from the raw fetch fixture, re-priced. In chaos: 1 2 3 4 5 200 4 9.6 6 7 —
    1c and 2c are under 60% of the median (5c), so the sell hint should say ~3c, 2 ignored."""
    raw = json.loads(read("test/fixture-fetch.json"))["result"]
    prices = [(1, "chaos"), (2, "chaos"), (3, "chaos"), (4, "chaos"), (5, "chaos"),
              (1, "divine"), (8, "alch"), (12, "fusing"), (6, "chaos"), (7, "chaos")]
    out = []
    for i, (amount, cur) in enumerate(prices):
        r = copy.deepcopy(raw[i % len(raw)])
        r["id"] = "%064x" % (0xE2E000 + i)
        r["listing"]["price"] = {"type": "~price", "amount": amount, "currency": cur}
        out.append(gui.Api._listing_from(r))
    return out


def make_flips():
    """cx_flips rows, already sorted by gap like the bridge sends them. With the default
    2K minimum only fusing, regal and exalted qualify (alch is too thin, annul's gap < 2%)."""
    def row(code, name, via_c, gap, volume):
        via_d = round(via_c * (1 + gap), 4)
        return {"code": code, "name": name, "cat": "Currency", "img": "", "viaChaos": via_c, "viaDiv": via_d,
                "divEach": round(via_d / RATES["divine"], 6), "gap": gap, "buyWith": "chaos",
                "volume": volume, "cRange": [via_c * 0.9, via_c * 1.1], "dRange": [via_d / 200 * 0.9, via_d / 200 * 1.1]}
    return [row("fusing", "Orb of Fusing", 0.8, 0.10, 50000), row("alch", "Orb of Alchemy", 0.5, 0.08, 1500),
            row("regal", "Regal Orb", 1.0, 0.06, 3000), row("exalted", "Exalted Orb", 12, 0.03, 8000),
            row("annul", "Orb of Annulment", 50, 0.015, 20000)]


def pob_xml(code):
    return zlib.decompress(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))).decode("utf-8")


def pob_code(xml):
    return base64.urlsafe_b64encode(zlib.compress(xml.encode("utf-8"), 9)).decode("ascii")


def build_variants(code):
    """(same build with one helmet mod changed, a different-class build) as PoB codes."""
    xml = pob_xml(code)
    old, new = "92% increased Energy Shield", "110% increased Energy Shield"
    if xml.count(old) != 1 or 'ascendClassName="Elementalist"' not in xml:
        raise RuntimeError("fixture-realbuild.txt changed: helmet mod / class anchors not found")
    edited = pob_code(xml.replace(old, new))
    other = pob_code(xml.replace('ascendClassName="Elementalist"', 'ascendClassName="Inquisitor"')
                     .replace('className="Witch"', 'className="Templar"'))
    return edited, other


def pc_leagues():
    seen, out = set(), []
    for lg in json.loads(read("data/leagues.json")).get("result", []):
        if lg.get("realm") == "pc" and lg["id"] not in seen:
            seen.add(lg["id"])
            out.append({"id": lg["id"], "text": lg.get("text", lg["id"]), "realm": "pc"})
    return out


RING = """Item Class: Rings
Rarity: Rare
Storm Loop
Two-Stone Ring
--------
Requirements:
Level: 56
--------
Item Level: 84
--------
+14% to Fire and Lightning Resistances (implicit)
--------
+65 to maximum Life
+40% to Cold Resistance
+35% to Chaos Resistance
+28 to Strength
"""

DIAG_TEXT = "PoB Trade Finder vE2E (stub)\nOS: e2e-stub"

# ---- the bridge stub, injected before any page script runs ----------------------------
STUB_JS = r"""
(function () {
  var D = __DATA__;
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  window.__calls = [];
  window.__clip = null;
  var store = {};
  var NO_ART = { ok: false, error: 'stub: no art offline' };
  var impl = {
    storage_get: function () { return { ok: true, data: Object.assign({}, store) }; },
    storage_set: function (k, v) { store[k] = String(v); return { ok: true }; },
    check_update: function () { return { ok: true, current: D.version, latest: 'v' + D.version, newer: false, url: null }; },
    rate_status: function () { return { ok: true, cooldownSeconds: 0 }; },
    league_check: function () { return { ok: true, leagues: D.leagues, new: [] }; },
    cx_overview: function () { return { ok: true, hour: D.market.hour, items: D.market.items }; },
    cx_history: function (league, codesJson, days) {
      var series = {}, names = {};
      JSON.parse(codesJson).forEach(function (c) {
        if (!D.market.items[c]) return;
        series[c] = D.market.items[c].s; names[c] = D.market.items[c].name;
      });
      return { ok: true, hour: D.market.hour, step: 6, series: series, names: names };
    },
    cx_flips: function () { return { ok: true, hour: D.market.hour, div: D.rates.divine, rows: D.flips }; },
    // background=true: saved-build tracking (yields to rate limits in the real bridge)
    trade_search: function (league, payloadJson, background) {
      return { ok: true, total: D.listings.length, searchId: 'e2eSearch1',
               ids: D.listings.map(function (l) { return l.id; }), pageSize: 10, listings: D.listings.slice(0, 10) };
    },
    trade_fetch: function (sid, idsJson) {
      var ids = JSON.parse(idsJson);
      return { ok: true, listings: D.listings.filter(function (l) { return ids.indexOf(l.id) !== -1; }) };
    },
    exchange_rates: function (league, curJson) {
      var r = { chaos: 1 };
      JSON.parse(curJson).forEach(function (c) { r[c] = c in D.rates ? D.rates[c] : 1; });
      return { ok: true, rates: r, source: {} };
    },
    notify: function () { return { ok: true }; },
    open_url: function () { return { ok: true }; },
    unique_icon: function () { return NO_ART; },
    gem_icon: function () { return NO_ART; },
    art_manifest: function () { return { ok: true, art: {} }; },
    cache_art: function () { return { ok: true, art: {} }; },
    diagnostics: function () { return { ok: true, text: D.diagText }; },
    // official login: GGG hasn't issued a client id, so the real bridge reports it switched off
    oauth_status: function () { return { ok: true, enabled: false, signedIn: false, username: null }; },
    stash_value: function () { return { ok: false, error: 'not signed in' }; },
    // quick price: the backend (poe.ninja proxy) has no data in tests unless a scenario overrides it
    quick_price: function () { return { ok: false, error: 'no quick price for this item' }; },
    bulk_exchange: function () { return { ok: true, total: 0, offers: [] }; },
    session_status: function () { return { ok: true, set: false }; },
    timeless_sockets: function () { return { ok: true, sockets: [] }; },
    hotkey_status: function () { return { ok: true, hotkey: 'ctrl+d', label: 'Ctrl+D', running: false, active: false, error: null }; },
    set_price_hotkey: function (spec) { return { ok: true, hotkey: spec, label: spec, running: false, active: false, error: null }; }
  };
  // every bridge method exists; unknown ones resolve to a soft failure and are recorded.
  // A scenario can swap one method's answer at runtime: window.__stubOverrides[name] = result.
  window.__stubOverrides = {};
  var api = new Proxy({}, {
    get: function (t, name) {
      if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
      return function () {
        var args = Array.prototype.slice.call(arguments);
        window.__calls.push({ name: name, args: clone(args), stub: !impl[name], t: Date.now() });
        var over = Object.prototype.hasOwnProperty.call(window.__stubOverrides, name);
        var fn = impl[name];
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(clone(over ? window.__stubOverrides[name]
                               : fn ? fn.apply(null, args) : { ok: false, error: 'stub' }));
          }, 0);
        });
      };
    },
    has: function () { return true; }
  });
  window.pywebview = { api: api };
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: function (t) { window.__clip = String(t); return Promise.resolve(); },
      readText: function () { return Promise.resolve(window.__clip || ''); } } });
  } catch (e) { /* leave the real one */ }

  // test helpers
  window.__e2e = {
    data: D,
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    waitFor: function (fn, ms, label) {
      ms = ms || 5000;
      var t0 = Date.now();
      return new Promise(function (resolve, reject) {
        (function tick() {
          var v = false;
          try { v = fn(); } catch (e) { v = false; }
          if (v) return resolve(v);
          if (Date.now() - t0 > ms) return reject(new Error('timed out after ' + ms + 'ms waiting for ' + (label || fn)));
          setTimeout(tick, 25);
        })();
      });
    },
    visible: function (el) { return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'); },
    calls: function (name) { return window.__calls.filter(function (c) { return c.name === name; }); },
    text: function (sel, root) { var el = (root || document).querySelector(sel); return el ? el.textContent.trim() : null; },
    button: function (root, label) {
      return Array.prototype.find.call(root.querySelectorAll('button'), function (b) { return b.textContent.trim() === label; }) || null;
    },
    // decode a build code (default: the fixture) through the paste box, like a user
    loadBuild: async function (code) {
      var label = document.getElementById('build-label');
      label.textContent = '';
      document.getElementById('pob-input').value = code || D.buildCode;
      document.getElementById('decode-btn').click();
      await this.waitFor(function () {
        return document.body.classList.contains('has-build') && label.textContent;
      }, 20000, 'the build to load');
      await this.sleep(50);
    },
    gearCards: function () {
      return Array.prototype.slice.call(document.querySelectorAll('#results > .tab-section[data-tab="gear"] .slot-detail > .card'));
    },
    gearCard: function (slot) {
      return this.gearCards().find(function (c) { return (c.querySelector('.slot-tag') || {}).textContent === slot; }) || null;
    },
    // Check price on one card and wait until its listings carry chaos equivalents
    // (that is when the cost summary, cost history and search history are written)
    priceCard: async function (card) {
      var btn = this.button(card, 'Check price');
      if (!btn) throw new Error('no Check price button on ' + (card.querySelector('.slot-tag') || {}).textContent);
      btn.click();
      await this.waitFor(function () { return card.querySelector('.listing .chaos-eq') && !btn.disabled; }, 10000, 'priced listings');
      await this.sleep(30);
    },
    marketReady: function () {
      var tile = document.getElementById('market-tile');
      return this.waitFor(function () {
        return !tile.classList.contains('hidden') && /c$/.test(tile.querySelector('.mt-value').textContent);
      }, 10000, 'market feed');
    },
    frame: function () { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); }); }
  };
})();
"""

READY_JS = ("document.body && document.body.classList.contains('gui') && "
            "document.getElementById('league').options.length > 0")


# ---- scenarios: JS returns facts, Python asserts ----------------------------------------
S1_LANDING = r"""
const H = window.__e2e;
await H.waitFor(() => H.calls('check_update').length && /· v/.test(H.text('.footer')), 5000, 'version in footer');
const sel = document.getElementById('league');
const opts = [...sel.options].map(o => o.value);
const all = window.POE_LEAGUES.result || [];
return {
  opts, selected: sel.value,
  pc: all.filter(l => l.realm === 'pc').map(l => l.id),
  bundled: all.length,
  gui: document.body.classList.contains('gui'),
  hasBuild: document.body.classList.contains('has-build'),
  landing: H.visible(document.getElementById('input-panel')),
  decodeBtn: H.visible(document.getElementById('decode-btn')),
  footer: H.text('.footer'),
  calls: [...new Set(window.__calls.map(c => c.name))],
};
"""

S2_DECODE = r"""
const H = window.__e2e;
await H.loadBuild();
const nav = [...document.querySelectorAll('#nav .nav-item')];
const gear = document.querySelector('#results > .tab-section[data-tab="gear"]');
const rows = gear ? [...gear.querySelectorAll('.slot-row')] : [];
const cardsEls = gear ? [...gear.querySelectorAll('.slot-detail > .card')] : [];
const before = {
  view: document.body.dataset.view, title: H.text('#view-title'),
  active: cardsEls.filter(c => c.classList.contains('is-active')).length,
  firstActive: !!(cardsEls[0] && cardsEls[0].classList.contains('is-active')),
  gearVisible: H.visible(gear), landingHidden: !H.visible(document.getElementById('input-panel')),
  sidebar: H.visible(document.getElementById('sidebar')),
  buildLabel: H.text('#build-label'), buildSub: H.text('#build-sub'),
};
let clicked = null;
if (rows.length > 1) {
  rows[1].click();
  await H.sleep(30);
  const now = [...gear.querySelectorAll('.slot-detail > .card')];
  clicked = {
    activeIdx: now.findIndex(c => c.classList.contains('is-active')),
    active: now.filter(c => c.classList.contains('is-active')).length,
    rowCurrent: [...gear.querySelectorAll('.slot-row')].findIndex(r => r.getAttribute('aria-current') === 'true'),
    activeVisible: H.visible(now[1]), firstVisible: H.visible(now[0]),
  };
}
const gemsBtn = nav.find(b => b.dataset.view === 'gems');
let gems = null;
if (gemsBtn) {
  gemsBtn.click();
  await H.sleep(30);
  gems = { view: document.body.dataset.view, title: H.text('#view-title'),
           visible: H.visible(document.querySelector('#results > .tab-section[data-tab="gems"]')),
           gearHidden: !H.visible(gear), current: gemsBtn.getAttribute('aria-current') };
}
return {
  navViews: nav.map(b => b.dataset.view), navLabels: nav.map(b => H.text('.nav-label', b)),
  gearCount: (nav.find(b => b.dataset.view === 'gear') || {}).textContent,
  rows: rows.length, cards: cardsEls.length, before, clicked, gems,
};
"""

S3_PRICE = r"""
const H = window.__e2e;
await H.loadBuild();
const gear = document.querySelector('#results > .tab-section[data-tab="gear"]');
const card = gear.querySelector('.slot-detail > .card.is-active');
const btn = H.button(card, 'Check price');
if (!btn) return { error: 'no Check price button on the active gear card' };
btn.click();
await H.waitFor(() => card.querySelectorAll('.listing').length, 10000, 'listings');
const summary = document.getElementById('cost-summary');
await H.waitFor(() => !summary.classList.contains('hidden') && summary.querySelector('.cost-total'), 10000, 'cost summary');
const search = H.calls('trade_search')[0];
let payload = null;
try { payload = JSON.parse(search.args[1]); } catch (e) { /* asserted below */ }
const activeRow = gear.querySelector('.slot-row[aria-current="true"]');
const out = {
  listings: card.querySelectorAll('.listing').length,
  head: H.text('.price-head', card),
  eq: card.querySelectorAll('.chaos-eq').length,
  deals: card.querySelectorAll('.badge.deal').length,
  searchLeague: search && search.args[0], league: document.getElementById('league').value,
  hasQuery: !!(payload && payload.query && payload.query.status),
  btnEnabled: !btn.disabled,
  total: H.text('.cost-total', summary),
  summaryRows: summary.querySelectorAll('tbody tr').length,
  rowStatus: activeRow ? H.text('.slot-status', activeRow) : null,
  buildCost: H.text('#build-cost'),
};
const planner = [...document.querySelectorAll('#nav .nav-item')].find(b => b.dataset.view === 'planner');
planner.click();
await H.sleep(30);
out.plannerView = document.body.dataset.view;
out.summaryVisible = H.visible(summary);
out.emptyHidden = !H.visible(document.getElementById('planner-empty'));
return out;
"""

S4_PASTED = r"""
const H = window.__e2e;
document.getElementById('pob-input').value = RING;
document.getElementById('decode-btn').click();
const card = await H.waitFor(() => document.querySelector('#results .card.pasted'), 5000, 'pasted card');
const out = {
  name: H.text('.item-name', card), slot: H.text('.slot-tag', card), base: H.text('.item-base', card),
  status: H.text('#status'), hasBuild: document.body.classList.contains('has-build'),
  visible: H.visible(card), section: !!card.closest('.tab-section[data-tab="pasted"]'),
};
const btn = H.button(card, 'Check price');
if (!btn) { out.error = 'no Check price button on the pasted card'; return out; }
btn.click();
const hint = await H.waitFor(() => card.querySelector('.sell-hint'), 10000, 'sell hint');
await H.waitFor(() => card.querySelector('.sell-price'), 3000, 'sell price');
out.listings = card.querySelectorAll('.listing').length;
out.hint = hint.textContent.trim();
out.price = H.text('.sell-price', card);
out.label = H.text('.sell-label', card);
out.searched = H.calls('trade_search').length;
return out;
"""

S5_MARKET = r"""
const H = window.__e2e;
await H.loadBuild();
const tile = document.getElementById('market-tile');
await H.waitFor(() => !tile.classList.contains('hidden') && /c$/.test(H.text('.mt-value', tile)), 10000, 'market tile price');
const out = { tileValue: H.text('.mt-value', tile), tileDelta: H.text('.mt-delta', tile),
              tileVisible: H.visible(tile), overviewCalls: H.calls('cx_overview').length };
tile.click();
await H.waitFor(() => document.querySelector('#market-page .mk-table tbody tr'), 5000, 'market table');
const page = document.getElementById('market-page');
const watchRows = () => page.querySelectorAll('.mk-watch-list .mk-watch-row').length;
const rowFor = name => [...page.querySelectorAll('.mk-table tbody tr')]
  .find(tr => (tr.querySelector('.mk-name') || {}).textContent === name);
Object.assign(out, {
  view: document.body.dataset.view, title: H.text('#view-title'), pageVisible: H.visible(page),
  emptyHidden: !H.visible(document.getElementById('market-empty')),
  rising: page.querySelectorAll('.mk-mover-col:first-child .mk-mover').length,
  falling: page.querySelectorAll('.mk-mover-col:last-child .mk-mover').length,
  tableRows: page.querySelectorAll('.mk-table tbody tr').length,
  watch0: watchRows(), chartTitle: H.text('.mk-title', page), chartSvg: !!page.querySelector('.mk-chart svg'),
  conv: H.text('.mk-conv-out', page),
});
// star an unwatched item, then un-star it
let star = rowFor('Orb of Alchemy').querySelector('.mk-star');
out.starBefore = star.textContent.trim();
star.click();
await H.sleep(30);
out.watch1 = watchRows();
out.starAfter = rowFor('Orb of Alchemy').querySelector('.mk-star').textContent.trim();
out.saved = JSON.parse(localStorage.getItem('pobtf-watch') || '[]');
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-watch' && c.args[1].indexOf('alch') !== -1);
rowFor('Orb of Alchemy').querySelector('.mk-star').click();
await H.sleep(30);
out.watch2 = watchRows();
// a mover selects its item in the chart
const mover = page.querySelector('.mk-mover');
if (mover) {
  const name = H.text('.mk-name', mover);
  mover.click();
  await H.waitFor(() => H.text('.mk-title', page) === name, 3000, 'chart to follow the mover');
  out.moverName = name; out.chartAfter = H.text('.mk-title', page);
}
// converter: 3 divine
const amt = page.querySelector('.mk-conv-row input');
amt.value = '3';
amt.dispatchEvent(new Event('input'));
out.conv3 = H.text('.mk-conv-out', page);
return out;
"""

S6_SETTINGS = r"""
const H = window.__e2e;
await H.loadBuild();
const panel = document.getElementById('settings-panel');
const backdrop = document.getElementById('settings-backdrop');
const bg = () => getComputedStyle(document.body).backgroundColor;
const out = { closedAtStart: panel.classList.contains('hidden'), bgDark: bg() };
document.getElementById('settings-btn-side').click();
await H.sleep(30);
Object.assign(out, { open: !panel.classList.contains('hidden') && H.visible(panel),
                     backdrop: !backdrop.classList.contains('hidden'), focus: document.activeElement.id });
await H.waitFor(() => H.text('#hotkey-status'), 3000, 'hotkey status');
out.hotkey = H.text('#hotkey-status');
const theme = document.getElementById('pref-theme');
theme.value = 'light';
theme.dispatchEvent(new Event('change'));
await H.sleep(30);
out.theme = document.documentElement.dataset.theme || null;
out.bgLight = bg();
out.prefs = JSON.parse(localStorage.getItem('pobtf-prefs') || '{}').theme;
out.prefsPersisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-prefs' && /"theme":"light"/.test(c.args[1]));
document.getElementById('copy-diagnostics').click();
await H.waitFor(() => window.__clip, 5000, 'diagnostics on the clipboard');
out.clip = window.__clip;
out.diagCalls = H.calls('diagnostics').length;
await H.waitFor(() => !document.getElementById('copy-diagnostics').disabled, 3000, 'button re-enabled');
out.toast = [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
theme.value = 'dark';
theme.dispatchEvent(new Event('change'));
await H.sleep(30);
out.themeBack = document.documentElement.dataset.theme || null;
out.bgBack = bg();
return out;
"""

S7_OPEN = r"""
const H = window.__e2e;
await H.loadBuild();
const opener = document.getElementById('settings-btn-side');
opener.focus();
opener.click();
await H.sleep(30);
return { open: !document.getElementById('settings-panel').classList.contains('hidden'),
         focus: document.activeElement.id, openerVisible: H.visible(opener) };
"""

S7_AFTER = r"""
const H = window.__e2e;
await H.sleep(50);
return { panelHidden: document.getElementById('settings-panel').classList.contains('hidden'),
         backdropHidden: document.getElementById('settings-backdrop').classList.contains('hidden'),
         focus: document.activeElement.id, hasBuild: document.body.classList.contains('has-build') };
"""


S8_WIDE = r"""
const H = window.__e2e;
await H.loadBuild();
const card = document.querySelector('#results > .tab-section[data-tab="gear"] .slot-detail > .card.is-active');
const main = card.querySelector(':scope > .card-main'), side = card.querySelector(':scope > .card-side');
const out = { width: innerWidth, hasMain: !!main, hasSide: !!side };
if (!main || !side) return out;
const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
out.preDisplay = getComputedStyle(card).display;
await H.priceCard(card);
await H.frame();
out.display = getComputedStyle(card).display;
out.cols = getComputedStyle(card).gridTemplateColumns;
out.main = box(main); out.side = box(side);
out.listingsInSide = side.querySelectorAll('.listing').length;
out.modsInMain = !!main.querySelector('.card-body');
return out;
"""

S8_NARROW = r"""
const H = window.__e2e;
await H.frame();
const card = document.querySelector('#results > .tab-section[data-tab="gear"] .slot-detail > .card.is-active');
const main = card.querySelector(':scope > .card-main'), side = card.querySelector(':scope > .card-side');
const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
return { width: innerWidth, display: getComputedStyle(card).display, main: box(main), side: box(side),
         listings: side.querySelectorAll('.listing').length };
"""

S9_FLIPS = r"""
const H = window.__e2e;
await H.loadBuild();
await H.marketReady();
document.getElementById('market-tile').click();
const page = document.getElementById('market-page');
const flips = () => page.querySelector('.mk-flips');
const cells = tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
const names = () => [...flips().querySelectorAll('tbody tr .mk-name')].map(e => e.textContent);
await H.waitFor(() => flips() && flips().querySelector('tbody tr .mk-name'), 5000, 'flip rows');
const call = H.calls('cx_flips')[0];
const out = { calls: H.calls('cx_flips').length, callLeague: call && call.args[0],
              league: document.getElementById('league').value,
              minDefault: flips().querySelector('select').value, def: names(),
              firstRow: cells(flips().querySelector('tbody tr')) };
const setMin = async v => {
  const sel = flips().querySelector('select');
  sel.value = String(v);
  sel.dispatchEvent(new Event('change'));
  await H.sleep(30);
  return names();
};
out.m1000 = await setMin(1000);
out.m5000 = await setMin(5000);
out.m10000 = await setMin(10000);
out.callsAfterFilter = H.calls('cx_flips').length;
// a failing feed: switch league so the market reloads, flips are re-read and fail
window.__stubOverrides.cx_flips = { ok: false, error: 'exchange feed down (e2e)' };
const lg = document.getElementById('league');
const other = [...lg.options].map(o => o.value).find(v => v !== lg.value);
lg.value = other;
lg.dispatchEvent(new Event('change'));
await H.waitFor(() => flips() && /❌/.test(flips().textContent), 8000, 'flips error message');
out.err = flips().textContent;
out.errRows = flips().querySelectorAll('tbody tr').length;
out.errLeague = H.calls('cx_flips').slice(-1)[0].args[0];
out.otherLeague = other;
return out;
"""

S10_DIFF = r"""
const H = window.__e2e;
const toasts = () => [...document.querySelectorAll('.toast')].map(t => t.textContent);
const cells = tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
const diffBox = () => document.getElementById('build-diff');
await H.loadBuild();
const out = { firstDiff: !!diffBox() };
const helm = H.gearCard('Helmet');
if (!helm) return { error: 'no Helmet card in the fixture build' };
const priced = [helm].concat(H.gearCards().filter(c => c !== helm).slice(0, 2));
for (const c of priced) await H.priceCard(c);
out.pricedSlots = priced.map(c => H.text('.slot-tag', c));
out.summaryRows = document.querySelectorAll('#cost-summary tbody tr').length;
out.lastBuild = !!localStorage.getItem('pobtf-lastbuild');

await H.loadBuild();                       // the same code again
out.sameDiff = !!diffBox();

await H.loadBuild(EDITED);                 // one helmet mod changed
const diff = await H.waitFor(diffBox, 3000, 'the build diff panel');
out.rows = [...diff.querySelectorAll('tbody tr')].map(cells);
out.head = diff.textContent.slice(0, 200);
out.diffFirst = document.getElementById('results').firstElementChild === diff;
out.toast = toasts().join(' | ');
out.buildCost = H.text('#build-cost');
const helmRow = [...document.querySelectorAll('#results > .tab-section[data-tab="gear"] .slot-row')]
  .find(r => H.text('.slot-label', r) === 'Helmet');
out.chip = helmRow ? H.text('.slot-status', helmRow) : null;
const btn = [...diff.querySelectorAll('button')].find(b => /^Price changed slots/.test(b.textContent.trim()));
out.btn = btn ? btn.textContent.trim() : null;
if (!btn) return out;
const before = H.calls('trade_search').length;
// the new helmet is dearer: one 5c listing, so the difference is +4c over the old 1c
const five = H.data.listings.find(l => l.amount === 5 && l.currency === 'chaos');
window.__stubOverrides.trade_search = { ok: true, total: 1, searchId: 'e2eSearch2', ids: [five.id], pageSize: 10,
                                        listings: [five] };
btn.click();
await H.waitFor(() => { const d = diffBox(); const r = d && d.querySelector('tbody tr'); return r && cells(r)[4] !== 'not checked'; },
                10000, 'the changed slot to be priced');
await H.sleep(30);
delete window.__stubOverrides.trade_search;
out.searches = H.calls('trade_search').length - before;
out.after = [...diffBox().querySelectorAll('tbody tr')].map(cells);
out.btnAfter = ([...diffBox().querySelectorAll('button')].find(b => /changed slots/.test(b.textContent)) || {}).textContent;
out.foot = H.text('.finder-sub', diffBox());

await H.loadBuild(OTHER);                  // a different class: not a new version
out.otherDiff = !!diffBox();
out.otherLabel = H.text('#build-label');
return out;
"""

S11_TRACK = r"""
const H = window.__e2e;
const lib = () => JSON.parse(localStorage.getItem('pobtf-builds') || '[]');
const toasts = re => [...document.querySelectorAll('.toast')].filter(t => re.test(t.textContent));
const bg = () => H.calls('trade_search').filter(c => c.args[2] === true);
await H.loadBuild();
await H.marketReady();
const priced = H.gearCards().slice(0, 3);
for (const c of priced) await H.priceCard(c);
const fgPayloads = H.calls('trade_search').filter(c => c.args[2] !== true).map(c => c.args[1]).sort();
document.getElementById('save-build').click();
await H.sleep(30);
const out = { saved: lib().length, savedCode: lib()[0] && lib()[0].code === document.getElementById('pob-input').value };
document.getElementById('new-build').click();
await H.sleep(30);
const item = () => document.querySelector('#saved-list .saved-item');
out.landing = H.visible(document.getElementById('input-panel'));
out.items = document.querySelectorAll('#saved-list .saved-item').length;
const openForm = async () => {
  const b = item().querySelector('button[aria-label^="Re-price and price reminders"]');
  b.click();
  await H.sleep(30);
  return item().querySelector('.track-form');
};
let form = await openForm();
out.formShown = !!form && !form.hidden;
out.formNote = H.text('.finder-sub', form);
form.querySelector('input[type="checkbox"]').checked = true;
form.querySelector('input[type="number"]').value = '100';
form.querySelector('select').value = 'c';
H.button(form, 'Save').click();
await H.sleep(6000); // the old code re-priced ~5 s after Save; nothing may run on its own now
out.pending = H.text('.saved-track', item());
out.bgAfterSave = bg().length;
// the hourly reminder: a toast with a button, still no searches
remindTrackedBuilds();
await H.sleep(50);
const rem = toasts(/Prices for/);
out.reminders = rem.map(t => t.textContent);
out.bgAfterReminder = bg().length;
remindTrackedBuilds(); // a second check within 24 h stays quiet
await H.sleep(50);
out.reminders2 = toasts(/Prices for/).length;
// the user clicks "Re-price now" on the reminder
H.button(rem[0], 'Re-price now').click();
await H.waitFor(() => bg().length >= priced.length && lib()[0].track && lib()[0].track.last, 15000, 'the re-price');
await H.sleep(100);
out.bg = bg().length;
out.bgLeague = bg().every(c => c.args[0] === document.getElementById('league').value);
out.bgSamePayloads = JSON.stringify(bg().map(c => c.args[1]).sort()) === JSON.stringify(fgPayloads);
out.track = lib()[0].track;
out.line = H.text('.saved-track', item());
out.alertNotify = H.calls('notify').filter(c => c.args[0] === 'Build price alert').length;
out.bell = toasts(/🔔/).map(t => t.textContent);
// "Re-price now" in the form: another user click, another round; the alert stays quiet
form = await openForm();
out.form2checked = form.querySelector('input[type="checkbox"]').checked;
H.button(form, 'Re-price now').click();
await H.waitFor(() => bg().length >= 2 * priced.length, 15000, 'the second re-price');
await H.sleep(100);
out.bg2 = bg().length;
out.alertNotify2 = H.calls('notify').filter(c => c.args[0] === 'Build price alert').length;
out.bell2 = toasts(/🔔/).length;
return out;
"""


def scenario_wide(s, tag):
    s.fresh()
    b = s.b
    try:
        b.send("Emulation.setDeviceMetricsOverride", {"width": 2560, "height": 1300, "deviceScaleFactor": 1,
                                                       "mobile": False})
        r = s.run(S8_WIDE)
        if not check(tag + " card has .card-main and .card-side", r["hasMain"] and r["hasSide"], r):
            return
        check(tag + " viewport is 2560 wide", r["width"] == 2560, r["width"])
        check(tag + " stacked before any listings", r["preDisplay"] == "block", r["preDisplay"])
        check(tag + " listings live in .card-side, mods in .card-main", r["listingsInSide"] == 10 and r["modsInMain"], r)
        check(tag + " priced card is a two-column grid",
              r["display"] == "grid" and len((r["cols"] or "").split()) == 2, (r["display"], r["cols"]))
        m, sd = r["main"], r["side"]
        check(tag + " .card-side sits right of .card-main",
              sd["l"] >= m["r"] - 1 and abs(sd["t"] - m["t"]) < 2 and m["w"] > 300 and sd["w"] > 300, (m, sd))
        b.send("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1,
                                                       "mobile": False})
        n = s.run(S8_NARROW)
        check(tag + " at 1440 the priced card stacks (block)", n["width"] == 1440 and n["display"] == "block",
              (n["width"], n["display"]))
        check(tag + " at 1440 .card-side is below .card-main",
              n["side"]["t"] >= n["main"]["b"] - 1 and n["listings"] == 10, (n["main"], n["side"]))
    finally:
        b.send("Emulation.clearDeviceMetricsOverride")


def scenario_flips(s, tag):
    s.fresh()
    r = s.run(S9_FLIPS)
    check(tag + " flips read once for the selected league", r["calls"] == 1 and r["callLeague"] == r["league"],
          (r["calls"], r["callLeague"], r["league"]))
    check(tag + " default minimum is 2K", r["minDefault"] == "2000", r["minDefault"])
    check(tag + " default: volume >= 2K and gap >= 2%, in bridge order",
          r["def"] == ["Orb of Fusing", "Regal Orb", "Exalted Orb"], r["def"])
    row = r["firstRow"]
    check(tag + " row shows gap, direction and volume",
          "+10.0%" in row and "chaos → divine" in row and any(c.endswith("c/h") for c in row), row)
    check(tag + " 1K minimum adds the thin row", r["m1000"] == ["Orb of Fusing", "Orb of Alchemy", "Regal Orb",
                                                                 "Exalted Orb"], r["m1000"])
    check(tag + " 5K minimum", r["m5000"] == ["Orb of Fusing", "Exalted Orb"], r["m5000"])
    check(tag + " 10K minimum", r["m10000"] == ["Orb of Fusing"], r["m10000"])
    check(tag + " re-filtering does not re-read the feed", r["callsAfterFilter"] == 1, r["callsAfterFilter"])
    check(tag + " error result shows the ❌ message",
          "❌ exchange feed down (e2e)" in r["err"] and r["errRows"] == 0, r["err"][:200])
    check(tag + " league switch re-reads flips for the new league", r["errLeague"] == r["otherLeague"],
          (r["errLeague"], r["otherLeague"]))


def scenario_diff(s, tag):
    s.fresh()
    r = s.run(S10_DIFF, timeout=60, EDITED=s.edited_code, OTHER=s.other_code)
    if not check(tag + " fixture has a Helmet card", not r.get("error"), r.get("error")):
        return
    check(tag + " first load shows no diff", not r["firstDiff"])
    check(tag + " three gear slots priced", r["summaryRows"] == 3 and "Helmet" in r["pricedSlots"], r["pricedSlots"])
    check(tag + " fingerprint stored", r["lastBuild"])
    check(tag + " same code again shows no diff", not r["sameDiff"])
    rows = r["rows"]
    check(tag + " edited build: one changed row", len(rows) == 1, rows)
    if rows:
        row = rows[0]
        check(tag + " row: Helmet / Changed", row[0] == "Helmet" and row[1] == "Changed", row)
        check(tag + " row lists + new and − old mod lines",
              "+ 110% increased Energy Shield" in row[2] and "− 92% increased Energy Shield" in row[2], row[2])
        check(tag + " row carries the old price", row[3] not in ("", "—"), row[3])
        check(tag + " not yet priced", row[4] == "not checked" and row[5] == "—", row[4:])
    check(tag + " diff panel sits above the gear", r["diffFirst"])
    check(tag + " header counts changed slots", " · 1 of " in r["head"], r["head"])
    check(tag + " toast announces the change", "1 slot changed since the last version" in r["toast"], r["toast"])
    check(tag + " slot row chip says Changed", r["chip"] == "Changed", r["chip"])
    check(tag + " unchanged slots keep their cost history", (r["buildCost"] or "").startswith("Last priced"),
          r["buildCost"])
    check(tag + " price button offers the 1 changed slot", r["btn"] == "Price changed slots (1)", r["btn"])
    after = (r.get("after") or [[]])[0]
    check(tag + " Price changed slots searched once", r.get("searches") == 1, r.get("searches"))
    check(tag + " Costs now and Difference filled", len(after) == 6 and after[3] == "1c" and after[4] == "5c"
          and after[5] == "+4c", after)
    check(tag + " button reports all priced", (r.get("btnAfter") or "").strip() == "All changed slots priced",
          r.get("btnAfter"))
    check(tag + " footer shows the net change", "Net change across the 1 slot with both prices: +4c" in
          (r.get("foot") or ""), r.get("foot"))
    check(tag + " different class shows no diff", not r["otherDiff"] and r["otherLabel"] == "Inquisitor",
          (r["otherDiff"], r["otherLabel"]))


def scenario_track(s, tag):
    s.fresh()
    r = s.run(S11_TRACK, timeout=90)
    check(tag + " build saved", r["saved"] == 1 and r["savedCode"], r)
    check(tag + " landing lists the saved build", r["landing"] and r["items"] == 1, r)
    check(tag + " re-price form opens", r["formShown"], r)
    check(tag + " form knows the 3 priced slots", "3 priced slots" in (r["formNote"] or ""), r["formNote"])
    check(tag + " card says the reminder is on", "reminder on" in (r["pending"] or ""), r["pending"])
    check(tag + " nothing searched on its own after Save", r["bgAfterSave"] == 0, r["bgAfterSave"])
    check(tag + " reminder toast offers Re-price now", len(r["reminders"]) == 1 and "Re-price now" in r["reminders"][0],
          r["reminders"])
    check(tag + " the reminder searches nothing", r["bgAfterReminder"] == 0, r["bgAfterReminder"])
    check(tag + " one reminder per day", r["reminders2"] == 1, r["reminders2"])
    check(tag + " click re-prices each priced slot once", r["bg"] == 3, r["bg"])
    check(tag + " re-price repeats the slot searches", r["bgSamePayloads"] and r["bgLeague"])
    t = r["track"] or {}
    last = t.get("last") or {}
    check(tag + " result stored", bool(t.get("lastRun")) and t.get("on") and last.get("n") == 3
          and abs((last.get("total") or 0) - 3) < 1e-6, t)
    check(tag + " alert settings stored", t.get("below") == 100 and t.get("unit") == "c" and t.get("fired") is True, t)
    check(tag + " saved card shows the price", "📈" in (r["line"] or "") and "not priced" not in r["line"], r["line"])
    check(tag + " alert toast once", len(r["bell"]) == 1 and "now costs" in r["bell"][0], r["bell"])
    check(tag + " alert notification once", r["alertNotify"] == 1, r["alertNotify"])
    check(tag + " form remembers the reminder", r["form2checked"])
    check(tag + " Re-price now in the form runs another round", r["bg2"] == 6, r["bg2"])
    check(tag + " no second alert while still under", r["alertNotify2"] == 1 and r["bell2"] == 1,
          (r["alertNotify2"], r["bell2"]))


# ---- runner -----------------------------------------------------------------------------
class Session:
    def __init__(self, browser, server):
        self.b = browser
        self.server = server
        self.url = server.origin + "/index.html"

    def fresh(self):
        """New page load, empty localStorage, no leftover events."""
        self.b.send("Storage.clearDataForOrigin", {"origin": self.server.origin, "storageTypes": "local_storage"})
        self.b.take_events()
        self.b.navigate(self.url, READY_JS, timeout=30)

    def run(self, body, timeout=40, **consts):
        decl = "".join("const %s = %s;\n" % (k, json.dumps(v)) for k, v in consts.items())
        return self.b.evaluate("(async () => {\n%s%s\n})()" % (decl, body), timeout=timeout)

    def page_errors(self):
        try:
            self.b.evaluate("1")
        except CDPError:
            pass
        time.sleep(0.15)
        errs, console = [], []
        for ev in self.b.take_events():
            p = ev.get("params", {})
            if ev.get("method") == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                desc = (d.get("exception") or {}).get("description") or d.get("text", "")
                errs.append("%s (%s:%s)" % (desc.split("\n")[0], (d.get("url") or "").split("/")[-1].split("?")[0],
                                            d.get("lineNumber")))
            elif ev.get("method") == "Runtime.consoleAPICalled" and p.get("type") == "error":
                console.append(" ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", [])))
        return errs, console

    def unstubbed(self):
        try:
            return self.b.evaluate("[...new Set(window.__calls.filter(c => c.stub).map(c => c.name))]") or []
        except CDPError:
            return []


def scenario_landing(s, tag):
    s.fresh()
    r = s.run(S1_LANDING)
    pc = r["pc"]
    check(tag + " desktop mode detected (body.gui)", r["gui"])
    check(tag + " landing shown, no build yet", r["landing"] and r["decodeBtn"] and not r["hasBuild"])
    check(tag + " league list = bundled PC leagues in order", r["opts"] == pc, r["opts"])
    check(tag + " league list has no duplicates", len(set(r["opts"])) == len(r["opts"]), r["opts"])
    check(tag + " console realms filtered out", r["bundled"] > len(r["opts"]) or r["bundled"] == len(pc),
          (r["bundled"], len(r["opts"])))
    check(tag + " default league is a challenge league",
          r["selected"] in pc and not any(w in r["selected"] for w in ("Standard", "Hardcore", "Ruthless")),
          r["selected"])
    check(tag + " bridge version shown in footer", "· vE2E" in (r["footer"] or ""), r["footer"])
    check(tag + " startup bridge calls made", all(c in r["calls"] for c in ("storage_get", "check_update", "art_manifest")),
          r["calls"])


def scenario_decode(s, tag):
    s.fresh()
    r = s.run(S2_DECODE)
    b = r["before"]
    check(tag + " build loaded: landing hidden, sidebar shown", b["landingHidden"] and b["sidebar"], b)
    check(tag + " build label filled", bool(b["buildLabel"]) and "items" in (b["buildSub"] or ""), b)
    for v in ("gear", "gems", "planner", "market"):
        check(tag + " nav has " + v, v in r["navViews"], r["navViews"])
    check(tag + " nav items have labels", all(r["navLabels"]), r["navLabels"])
    check(tag + " opens on the Gear view", b["view"] == "gear" and b["title"] == "Gear" and b["gearVisible"], b)
    check(tag + " gear slot list has items", r["rows"] >= 2 and r["rows"] == r["cards"], (r["rows"], r["cards"]))
    check(tag + " nav gear count matches slots", str(r["cards"]) in (r["gearCount"] or ""), r["gearCount"])
    check(tag + " first slot active on load", b["firstActive"] and b["active"] == 1, b)
    c = r["clicked"] or {}
    check(tag + " clicking slot 2 shows its card only",
          c.get("activeIdx") == 1 and c.get("active") == 1 and c.get("activeVisible") and not c.get("firstVisible"), c)
    check(tag + " clicked slot row is aria-current", c.get("rowCurrent") == 1, c)
    g = r["gems"] or {}
    check(tag + " Gems nav switches view", g.get("view") == "gems" and g.get("visible") and g.get("gearHidden")
          and g.get("current") == "page", g)


def scenario_price(s, tag):
    s.fresh()
    r = s.run(S3_PRICE)
    if not check(tag + " Check price button present", not r.get("error"), r.get("error")):
        return
    check(tag + " listings rendered", r["listings"] == 10, r["listings"])
    check(tag + " listing count header", (r["head"] or "").startswith("10 listed"), r["head"])
    check(tag + " search used the selected league", r["searchLeague"] == r["league"], (r["searchLeague"], r["league"]))
    check(tag + " search payload is a trade query", r["hasQuery"])
    check(tag + " chaos equivalents annotated", r["eq"] >= 2, r["eq"])
    check(tag + " cheap outliers flagged as deals", r["deals"] == 2, r["deals"])
    check(tag + " button re-enabled", r["btnEnabled"])
    check(tag + " cost summary total", "Total" in (r["total"] or "") and "1 slot(s) priced" in r["total"], r["total"])
    check(tag + " cost summary has one row", r["summaryRows"] == 1, r["summaryRows"])
    check(tag + " slot list shows the cheapest price", bool(r["rowStatus"]) and "1" in r["rowStatus"], r["rowStatus"])
    check(tag + " planner view shows the summary", r["plannerView"] == "planner" and r["summaryVisible"]
          and r["emptyHidden"], r)


def scenario_pasted(s, tag):
    s.fresh()
    r = s.run(S4_PASTED, RING=RING)
    check(tag + " pasted card rendered", r["section"] and r["visible"] and not r["hasBuild"], r)
    check(tag + " item parsed", r["name"] == "Storm Loop" and r["base"] == "Two-Stone Ring" and r["slot"] == "Ring 1",
          (r["name"], r["base"], r["slot"]))
    check(tag + " no decode error", not r["status"], r["status"])
    if not check(tag + " Check price button present", not r.get("error"), r.get("error")):
        return
    check(tag + " price check searched once", r["searched"] == 1, r["searched"])
    check(tag + " listings rendered", r["listings"] == 10, r["listings"])
    check(tag + " sell hint says List at", r["label"] == "List at" and "List at" in r["hint"], r["hint"])
    check(tag + " suggested price skips bait listings", "3" in (r["price"] or "") and "Ignored 2" in r["hint"],
          (r["price"], r["hint"]))


def scenario_market(s, tag):
    s.fresh()
    r = s.run(S5_MARKET)
    check(tag + " tile shows divine price", r["tileValue"] == "200c" and r["tileVisible"], (r["tileValue"], r["tileDelta"]))
    check(tag + " tile shows 7-day change", "7d" in (r["tileDelta"] or ""), r["tileDelta"])
    check(tag + " tile opens Market view", r["view"] == "market" and r["title"] == "Market" and r["pageVisible"]
          and r["emptyHidden"], r)
    check(tag + " movers: rising and falling", r["rising"] >= 1 and r["falling"] >= 1, (r["rising"], r["falling"]))
    check(tag + " table lists every item", r["tableRows"] == 8, r["tableRows"])
    check(tag + " chart shows Divine Orb", r["chartTitle"] == "Divine Orb" and r["chartSvg"], r["chartTitle"])
    check(tag + " default watchlist (4)", r["watch0"] == 4, r["watch0"])
    check(tag + " star adds to watchlist", r["starBefore"] == "☆" and r["starAfter"] == "★" and r["watch1"] == 5
          and "alch" in r["saved"], (r["starBefore"], r["starAfter"], r["watch1"], r["saved"]))
    check(tag + " watchlist persisted through the bridge", r["persisted"])
    check(tag + " unstar removes it", r["watch2"] == 4, r["watch2"])
    check(tag + " mover click selects it in the chart", r.get("moverName") and r.get("chartAfter") == r.get("moverName"),
          (r.get("moverName"), r.get("chartAfter")))
    check(tag + " converter starts with Worth", (r["conv"] or "").startswith("Worth") and "200" in r["conv"], r["conv"])
    check(tag + " converter follows the amount", (r["conv3"] or "").startswith("Worth") and "600" in r["conv3"], r["conv3"])


def scenario_settings(s, tag):
    s.fresh()
    r = s.run(S6_SETTINGS)
    check(tag + " drawer closed at start", r["closedAtStart"])
    check(tag + " drawer opens from the sidebar", r["open"] and r["backdrop"], r)
    check(tag + " focus moves into the drawer", r["focus"] == "settings-close", r["focus"])
    check(tag + " hotkey status from the bridge", "Ctrl+D" in (r["hotkey"] or ""), r["hotkey"])
    check(tag + " light theme applied", r["theme"] == "light" and r["bgLight"] != r["bgDark"],
          (r["theme"], r["bgDark"], r["bgLight"]))
    check(tag + " theme saved", r["prefs"] == "light" and r["prefsPersisted"], r["prefs"])
    check(tag + " diagnostics called the bridge", r["diagCalls"] == 1, r["diagCalls"])
    clip = r["clip"] or ""
    check(tag + " diagnostics text has bridge + page sections",
          clip.startswith("PoB Trade Finder vE2E") and "--- page ---" in clip and "--- recent errors" in clip, clip[:300])
    check(tag + " diagnostics describe the page", "Build: " in clip and "Market: " in clip and "theme light" in clip,
          clip[:400])
    check(tag + " copy confirmed with a toast", "Diagnostics copied" in (r["toast"] or ""), r["toast"])
    check(tag + " dark theme restored", r["themeBack"] is None and r["bgBack"] == r["bgDark"], (r["themeBack"], r["bgBack"]))


def scenario_keyboard(s, tag):
    s.fresh()
    s.b.send("Emulation.setFocusEmulationEnabled", {"enabled": True})
    r = s.run(S7_OPEN)
    check(tag + " drawer open, focus inside", r["open"] and r["focus"] == "settings-close", r)
    s.b.key("Escape", "Escape", 27)
    a = s.run(S7_AFTER)
    check(tag + " Escape closes the drawer", a["panelHidden"] and a["backdropHidden"], a)
    check(tag + " focus returns to the opener", a["focus"] == "settings-btn-side", a["focus"])
    check(tag + " build still loaded", a["hasBuild"])


S12_BATCH = r"""
const H = window.__e2e;
await H.loadBuild();
const btn = document.getElementById('check-all');
const n = H.gearCards().length;
const before = H.calls('trade_search').length;
const t0 = Date.now();
btn.click();
await H.waitFor(() => H.calls('trade_search').length >= before + 2, 15000, 'two searches');
const gap = (H.calls('trade_search')[before + 1].t || Date.now()) - (H.calls('trade_search')[before].t || t0);
const running = btn.textContent;
btn.click(); // stop
const stopping = btn.textContent;
await H.waitFor(() => btn.textContent === 'Check all prices', 15000, 'the batch to stop');
await H.sleep(4000); // nothing more may start
return { n: n, running: running, stopping: stopping, searched: H.calls('trade_search').length - before,
         gapMs: gap, idle: btn.textContent, disabled: btn.disabled };
"""


def scenario_batch(s, tag):
    s.fresh()
    r = s.run(S12_BATCH, timeout=60)
    check(tag + " button turns into a stop button", r["running"].startswith("■ Stop (") and r["running"].endswith(")"),
          r["running"])
    check(tag + " clicking it stops", r["stopping"] == "Stopping…", r["stopping"])
    check(tag + " stopped after the search in progress", 2 <= r["searched"] <= 3, r["searched"])
    check(tag + " gap between batch searches", r["gapMs"] >= 2500, r["gapMs"])
    check(tag + " button back to normal", r["idle"] == "Check all prices" and not r["disabled"], r)


S13_WEIGHTED = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
// first rare gear card with a Match select that offers the weighted mode
const card = H.gearCards().find(c => [...c.querySelectorAll('select')].some(s => [...s.options].some(o => o.value === 'w')) &&
  cards.find(s => s.card === c).item.mods.some(m => /maximum Life|Resistance/.test(m.line))); // stub listings: life + res
out.found = !!card;
if (!card) return out;
const st = cards.find(s => s.card === card);
const sel = [...card.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'w'));
const target = st.weightPct;
out.targetHiddenBefore = target.closest('.field').hidden;
sel.value = 'w';
sel.dispatchEvent(new Event('change'));
out.targetHiddenAfter = target.closest('.field').hidden;
const before = H.calls('trade_search').length;
await H.priceCard(card);
const call = H.calls('trade_search')[before];
const q = JSON.parse(call.args[1]).query;
const wg = (q.stats || []).find(g => g.type === 'weight');
out.weightGroup = wg ? { n: wg.filters.length, min: wg.value.min, weights: wg.filters.map(f => f.value.weight) } : null;
out.otherGroups = (q.stats || []).filter(g => g.type !== 'weight').map(g => ({ type: g.type, n: g.filters.length }));
// the build item itself scores 100% on its own weights
const mods = st.item.mods;
const own = { implicitMods: mods.filter(m => m.kind === 'implicit').map(m => m.line),
              explicitMods: mods.filter(m => m.kind !== 'implicit' && !m.crafted && !m.fractured).map(m => m.line),
              craftedMods: mods.filter(m => m.crafted).map(m => m.line),
              fracturedMods: mods.filter(m => m.fractured).map(m => m.line) };
const s = listingScore(own, st.priceState.weights, st.slot);
out.ownPct = s && s.pct;
out.weightsN = st.priceState.weights.length;
out.scores = [...card.querySelectorAll('.listing .listing-score')].map(e => e.textContent);
// best value first: ascending price per %
await H.sleep(200);
const vbtn = H.button(card, 'Best value first');
out.hasValueBtn = !!vbtn;
vbtn.click();
await H.sleep(300);
out.values = [...card.querySelectorAll('.card-side .listing')].map(e => parseFloat(e.dataset.value));
out.valueBtnOn = !!H.button(card, '✓ Best value first');
return out;
"""


def scenario_weighted(s, tag):
    s.fresh()
    r = s.run(S13_WEIGHTED, timeout=60)
    if not check(tag + " a rare card offers weighted mode", r.get("found"), r):
        return
    check(tag + " target only shows in weighted mode", r["targetHiddenBefore"] and not r["targetHiddenAfter"], r)
    wg = r.get("weightGroup")
    if not check(tag + " search has a weight group of 2+ stats", wg and wg["n"] >= 2, r.get("weightGroup")):
        return
    check(tag + " target = 90% of 100 per stat", wg["min"] == round(wg["n"] * 100 * 0.9), wg)
    check(tag + " every weight positive", all(w > 0 for w in wg["weights"]), wg["weights"])
    check(tag + " your own item scores 100%", r["ownPct"] is not None and abs(r["ownPct"] - 100) < 1.5, r["ownPct"])
    check(tag + " listings show a score", len(r["scores"]) == 10 and all("% of your item" in x for x in r["scores"]),
          r["scores"][:3])
    vals = [v for v in r["values"] if v is not None]  # unpriced / unscored listings come back as null
    check(tag + " best value first sorts by price per %", r["hasValueBtn"] and r["valueBtnOn"] and len(vals) >= 2
          and vals == sorted(vals), r["values"])


S14_STASH = r"""
const H = window.__e2e;
await H.loadBuild();
const navHas = () => [...document.querySelectorAll('#nav .nav-item')].some(b => b.dataset.view === 'stash');
const out = {};
// default: no client id from GGG -> switched off
out.offNote = H.text('#oauth-status');
out.offBtnDisabled = document.getElementById('oauth-btn').disabled;
out.offNav = navHas();
// once GGG issues a client id and the user signs in
window.__stubOverrides.oauth_status = { ok: true, enabled: true, signedIn: true, username: 'Exile#1234' };
window.__stubOverrides.stash_value = { ok: true, hour: 1793448000, total: 4300, divine: 200,
  tabs: [{ name: 'Cards', type: 'DivinationCardStash', total: 3000, items: 1, unvalued: 0 },
         { name: 'Currency', type: 'CurrencyStash', total: 1300, items: 2, unvalued: 0 },
         { name: 'Maps', type: 'MapStash', total: 0, items: 2, unvalued: 2 }],
  top: [{ name: 'The Doctor', qty: 2, each: 1500, total: 3000 }, { name: 'Chaos Orb', qty: 500, each: 1, total: 500 }],
  unvalued: 2 };
await refreshOAuth();
out.onNote = H.text('#oauth-status');
out.onBtn = document.getElementById('oauth-btn').textContent;
out.onNav = navHas();
[...document.querySelectorAll('#nav .nav-item')].find(b => b.dataset.view === 'stash').click();
await H.sleep(50);
out.view = document.body.dataset.view;
out.visible = H.visible(document.getElementById('view-stash'));
H.button(document.getElementById('stash-page'), 'Value my stash').click();
await H.waitFor(() => document.querySelector('#stash-page .stash-total'), 5000, 'the stash total');
out.calls = H.calls('stash_value').map(c => c.args[0]);
out.total = H.text('#stash-page .stash-total');
out.tabs = [...document.querySelectorAll('#stash-page table')].map(t => t.querySelectorAll('tbody tr').length);
out.history = JSON.parse(localStorage.getItem('pobtf-networth') || '[]').length;
return out;
"""


def scenario_stash(s, tag):
    s.fresh()
    r = s.run(S14_STASH, timeout=60)
    check(tag + " off until GGG issues a client id", "Not available yet" in (r["offNote"] or "") and r["offBtnDisabled"]
          and not r["offNav"], r)
    check(tag + " signed in: status + sign-out button", "Signed in as Exile#1234" in (r["onNote"] or "")
          and r["onBtn"] == "Sign out", r)
    check(tag + " Stash value appears in the nav only when signed in", r["onNav"])
    check(tag + " opens the Stash value page", r["view"] == "stash" and r["visible"], r)
    check(tag + " one click = one stash_value call for the league", len(r["calls"]) == 1, r["calls"])
    check(tag + " total shown", (r["total"] or "").startswith("4300"), r["total"])
    check(tag + " tab and item tables", r["tabs"] == [3, 2], r["tabs"])
    check(tag + " run saved for the chart", r["history"] == 1, r["history"])


S15_ZOOM_COMPLEX = r"""
const H = window.__e2e;
await H.loadBuild();
const out = { menus: [] };
// menus and popovers line up with their button at every Text size (body zoom)
for (const z of [1, 1.12, 1.25, 1.5]) {
  document.body.style.zoom = z;
  document.documentElement.style.setProperty('--zoom', z);
  for (const y of [0, 150]) {
    window.scrollTo(0, y);
    await H.sleep(30);
    const card = document.querySelector('.tab-section[data-tab="gear"] .card.is-active');
    const trig = card.querySelector('.menu-trigger');
    trig.click();
    await H.sleep(30);
    const m = document.querySelector('.menu').getBoundingClientRect(), t = trig.getBoundingClientRect();
    out.menus.push({ z: z, y: y, dRight: Math.round(m.right - t.right), dTop: Math.round(m.top - t.bottom),
                     inside: m.right <= document.documentElement.clientWidth + 1 });
    trig.click();
  }
}
document.body.style.zoom = 1;
document.documentElement.style.setProperty('--zoom', 1);
window.scrollTo(0, 0);
// "query too complex" (logged out, weighted search): plain words + ways forward
const card = H.gearCards().find(c => [...c.querySelectorAll('select')].some(s => [...s.options].some(o => o.value === 'w')));
const st = cards.find(s => s.card === card);
[...document.querySelectorAll('.tab-section[data-tab="gear"] .slot-row')].find(r => r.slotCard === card).click();
st.modeSel.value = 'w';
st.modeSel.dispatchEvent(new Event('change'));
window.__stubOverrides.trade_search = { ok: false, error: 'HTTP 400: {"error":{"code":2,"message":"Query is too complex. Please reduce the amount of filters used.\\nLogging in will increase this limit."}}' };
H.button(card, 'Check price').click();
await H.waitFor(() => card.querySelector('.complex-note'), 5000, 'the too-complex note');
out.note = H.text('.complex-note', card);
out.rawJson = /"code":2/.test(card.querySelector('.card-side').textContent);
out.buttons = [...card.querySelectorAll('.complex-acts button')].map(b => b.textContent);
delete window.__stubOverrides.trade_search;
const before = H.calls('trade_search').length;
H.button(card, 'Search "all but one" instead').click();
await H.waitFor(() => card.querySelectorAll('.card-side .listing').length, 5000, 'the fallback search');
out.mode = st.modeSel.value;
const q = JSON.parse(H.calls('trade_search')[before].args[1]).query;
out.fallbackHasWeight = (q.stats || []).some(g => g.type === 'weight');
return out;
"""


def scenario_zoom_complex(s, tag):
    s.fresh()
    r = s.run(S15_ZOOM_COMPLEX, timeout=60)
    bad = [m for m in r["menus"] if abs(m["dRight"]) > 1 or not (2 <= m["dTop"] <= 6) or not m["inside"]]
    check(tag + " ⋯ menu lines up with its button at 100/112/125/150% text, scrolled or not", not bad, bad or r["menus"])
    check(tag + " too-complex error explained in words", "too complex" in (r["note"] or "") and not r["rawJson"],
          r["note"])
    check(tag + " offers trade site, 'all but one' and POESESSID", r["buttons"] == [
        "Open on trade site ↗", 'Search "all but one" instead', "Add POESESSID…"], r["buttons"])
    check(tag + " 'all but one' re-searches without the weight group", r["mode"] == "1" and not r["fallbackHasWeight"], r)


S16_SESSID = r"""
const H = window.__e2e;
const out = {};
document.getElementById('settings-btn-side').click();
await H.sleep(50);
const inp = document.getElementById('sessid-input'), save = document.getElementById('sessid-save');
const dlg = () => document.querySelector('dialog.ui-dialog[open]');
const saves = () => H.calls('set_poesessid').length;
inp.value = 'abc123';
save.click();
await H.waitFor(dlg, 3000, 'the disclaimer');
out.title = H.text('.ui-dialog-title', dlg());
out.body = H.text('.ui-dialog-body', dlg());
H.button(dlg(), 'Cancel').click();
await H.sleep(50);
out.afterCancel = { saves: saves(), open: !!dlg(), ack: localStorage.getItem('pobtf-sessid-ack') };
save.click();
await H.waitFor(dlg, 3000, 'the disclaimer again');
H.button(dlg(), 'I understand, save it').click();
await H.waitFor(() => saves() === 1, 3000, 'the save');
out.afterConfirm = { saves: saves(), value: H.calls('set_poesessid')[0].args[0], ack: localStorage.getItem('pobtf-sessid-ack') };
await H.sleep(100);
inp.value = 'def456';
save.click();
await H.sleep(150);
out.second = { dialog: !!dlg(), saves: saves() };
inp.value = '';
save.click();
await H.sleep(150);
out.clear = { dialog: !!dlg(), saves: saves() };
return out;
"""


def scenario_sessid(s, tag):
    s.fresh()
    r = s.run(S16_SESSID, timeout=30)
    check(tag + " first save shows the disclaimer", r["title"] == "Using your POESESSID" and "own risk" in r["body"]
          and "never share it" in r["body"], r["body"])
    check(tag + " Cancel saves nothing", r["afterCancel"] == {"saves": 0, "open": False, "ack": None}, r["afterCancel"])
    check(tag + " confirming saves it once and remembers", r["afterConfirm"]["saves"] == 1 and
          r["afterConfirm"]["value"] == "abc123" and r["afterConfirm"]["ack"] == "1", r["afterConfirm"])
    check(tag + " never asks again", r["second"] == {"dialog": False, "saves": 2}, r["second"])
    check(tag + " clearing never asks", r["clear"] == {"dialog": False, "saves": 3}, r["clear"])


S17_V21 = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
// listings: seller online/away dot, listed age, "You" badge, same-seller merging
const card = H.gearCards()[2];
[...document.querySelectorAll('.tab-section[data-tab="gear"] .slot-row')].find(r => r.slotCard === card).click();
document.getElementById('acct-input').value = 'MeMyself#0001';
window.__stubOverrides.trade_search = (function () {
  const now = Date.now();
  const mk = (i, acct, amt, extra) => Object.assign({ id: 'v21_' + i, name: '', base: 'Two-Stone Ring', frameType: 2,
    amount: amt, currency: 'chaos', priceType: '~price', account: acct, whisper: '@x hi', explicitMods: ['+70 to maximum Life'],
    indexed: new Date(now - (i + 1) * 3600e3).toISOString(), online: true, afk: false }, extra || {});
  const ls = [mk(0, 'Seller#1', 10), mk(1, 'Seller#1', 10), mk(2, 'Seller#1', 10), mk(3, 'Away#2', 12, { afk: true }),
              mk(4, 'Gone#3', 15, { online: false }), mk(5, 'MeMyself#0001', 20)];
  return { ok: true, total: ls.length, searchId: 'v21', ids: ls.map(l => l.id), pageSize: 10, listings: ls };
})();
document.getElementById('listed-within').value = '3days';
document.getElementById('listed-within').dispatchEvent(new Event('change'));
const before = H.calls('trade_search').length;
H.button(card, 'Check price').click();
await H.waitFor(() => card.querySelectorAll('.card-side .listing').length, 5000, 'listings');
out.firstPayload = JSON.parse(H.calls('trade_search')[before].args[1]);
const rows = [...card.querySelectorAll('.card-side .listing')];
out.rowCount = rows.length;
out.accts = rows.map(r => (r.querySelector('.price-acct') || {}).textContent);
out.dots = rows.map(r => { const d = r.querySelector('.seller-dot'); return d ? d.className.replace('seller-dot ', '') : null; });
// cache: the same search within 5 minutes doesn't call the trade site again
const n1 = H.calls('trade_search').length;
H.button(card, 'Check price').click();
await H.sleep(300);
out.cacheCalls = H.calls('trade_search').length - n1;
out.cachedChip = H.text('.cached-chip', card);
H.button(card, '↻ Refresh').click();
await H.sleep(300);
out.refreshCalls = H.calls('trade_search').length - n1;
delete window.__stubOverrides.trade_search;
// pasted ring (advanced copy): tiers, low tiers off, quick price, upgrade vs the build's rings
window.__stubOverrides.quick_price = { ok: true, source: 'poe.ninja', chaos: 42, divine: 0.2, listings: 7 };
document.getElementById('pob-input').value = [
  'Item Class: Rings', 'Rarity: Rare', 'Doom Loop', 'Two-Stone Ring', '--------', 'Item Level: 84', '--------',
  '{ Implicit Modifier — Elemental, Fire, Cold, Resistance }', '+12(12-16)% to Fire and Cold Resistances (implicit)', '--------',
  '{ Prefix Modifier "Prime" (Tier: 1) — Life }', '+90(90-99) to maximum Life',
  '{ Suffix Modifier "of the Volcano" (Tier: 5) — Elemental, Fire, Resistance }', '+20(18-23)% to Fire Resistance'].join('\n');
document.getElementById('decode-btn').click();
await H.waitFor(() => document.querySelector('.card.pasted .quick-price'), 5000, 'quick price');
const p = document.querySelector('.card.pasted');
out.quick = H.text('.quick-price', p);
out.upgradeRows = [...p.querySelectorAll('.upgrade-row')].map(r => r.textContent);
const st = cards.find(s => s.card === p);
out.tiers = st.rows.map(r => ({ line: r.mod.line, tier: r.mod.tier || null, on: r.cb.checked, min: r.minInput.value }));
out.tierChips = [...p.querySelectorAll('.mod-text .badge')].map(b => b.textContent).filter(t => /^T\d/.test(t));
// wiki link goes through the allow-listed bridge
const before2 = H.calls('open_url').length;
p.querySelector('.menu-trigger').click();
await H.sleep(50);
[...document.querySelectorAll('.menu .menu-item')].find(b => /PoE Wiki/.test(b.textContent)).click();
await H.sleep(50);
out.wiki = (H.calls('open_url')[before2] || { args: [] }).args[0];
return out;
"""


def scenario_v21(s, tag):
    s.fresh()
    r = s.run(S17_V21, timeout=60)
    tf = ((r["firstPayload"].get("query") or {}).get("filters") or {}).get("trade_filters") or {}
    check(tag + " Listed within reaches the search", ((tf.get("filters") or {}).get("indexed") or {}).get("option") == "3days", tf)
    check(tag + " same seller + same price shown once with ×3", r["rowCount"] == 4 and "×3" in r["accts"][0], r["accts"])
    check(tag + " online / away / offline dots", r["dots"] == ["on", "away", "off", "on"], r["dots"])
    check(tag + " listed age shown", "h ago" in r["accts"][0], r["accts"][0])
    check(tag + " your own listing gets a You badge", "You" in r["accts"][3], r["accts"][3])
    check(tag + " same search within 5 min: no trade call, says how old", r["cacheCalls"] == 0 and
          "ago" in (r["cachedChip"] or ""), (r["cacheCalls"], r["cachedChip"]))
    check(tag + " Refresh searches again", r["refreshCalls"] == 1, r["refreshCalls"])
    check(tag + " quick price shown on a pasted item", "42" in (r["quick"] or "") and "poe.ninja" in r["quick"], r["quick"])
    check(tag + " upgrade check vs both build rings", len(r["upgradeRows"]) == 2 and all(
        ("Upgrade" in x or "Sidegrade" in x or "Downgrade" in x) for x in r["upgradeRows"]), r["upgradeRows"])
    t = {x["line"]: x for x in r["tiers"]}
    check(tag + " advanced copy: ranges stripped, tiers read", "+90 to maximum Life" in t and
          t["+90 to maximum Life"]["tier"] == 1 and t["+20% to Fire Resistance"]["tier"] == 5, r["tiers"])
    check(tag + " tier 1 on, tier 5 off by default", t["+90 to maximum Life"]["on"] and not t["+20% to Fire Resistance"]["on"],
          r["tiers"])
    check(tag + " pasted items use 90% of the roll", t["+90 to maximum Life"]["min"] == "81", t["+90 to maximum Life"])
    check(tag + " tier badges", r["tierChips"] == ["T1", "T5"], r["tierChips"])
    check(tag + " wiki link via the bridge", (r["wiki"] or "").startswith("https://www.poewiki.net/wiki/Two-Stone_Ring"),
          r["wiki"])


S18_V21B = r"""
const H = window.__e2e;
const out = {};
const league = document.getElementById('league').value;
RATES[league] = Object.assign(RATES[league] || {}, { divine: 200 });
document.getElementById('priced-in').value = 'divine';
document.getElementById('priced-in').dispatchEvent(new Event('change'));
out.chips = H.text('#context-chips') || [...document.querySelectorAll('.chip, .badge')].map(c => c.textContent).join('|');
// presets on a pasted rare
document.getElementById('pob-input').value = [
  'Item Class: Rings', 'Rarity: Rare', 'Doom Loop', 'Two-Stone Ring', '--------', 'Item Level: 84', '--------',
  '{ Prefix Modifier "Prime" (Tier: 1) — Life }', '+90(90-99) to maximum Life',
  '{ Suffix Modifier "of the Volcano" (Tier: 5) — Elemental, Fire, Resistance }', '+20(18-23)% to Fire Resistance'].join('\n');
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 1, divine: 0.005, code: 'chaos' };
document.getElementById('decode-btn').click();
await H.waitFor(() => document.querySelector('.card.pasted .quick-price'), 5000, 'quick price');
const p = document.querySelector('.card.pasted');
const st = cards.find(s => s.card === p);
const snap = () => ({ rows: st.rows.map(r => [r.cb.checked, r.minInput.value]), mode: st.modeSel.value,
  by: st.searchBySel && st.searchBySel.value, ilvl: st.ilvlInput.value });
out.similar = snap();
out.maxSet = (st.maxPriceInput.value = '400');
out.payloadSimilar = JSON.parse(JSON.stringify(buildTradePayload(st, true)));
const seg = p.querySelector('.segmented');
out.hasSeg = !!seg;
seg.querySelector('[data-value="exact"]').click();
out.exact = snap();
seg.querySelector('[data-value="base"]').click();
out.base = snap();
out.payloadBase = JSON.parse(JSON.stringify(buildTradePayload(st, true)));
seg.querySelector('[data-value="similar"]').click();
out.back = snap();
// live bulk-exchange offers: one request per press
window.__stubOverrides.bulk_exchange = { ok: true, total: 2, offers: [
  { seller: 'Bulk#1', online: true, afk: false, pay: 1, payCurrency: 'divine', get: 210, stock: 5000, chaosEach: 0.95 },
  { seller: 'Bulk#2', online: true, afk: true, pay: 10, payCurrency: 'chaos', get: 10, stock: 80, chaosEach: 1 }] };
const nb = H.calls('bulk_exchange').length;
H.button(p, 'Live offers').click();
await H.waitFor(() => p.querySelectorAll('.qp-offer').length, 5000, 'offers');
out.bulkCalls = H.calls('bulk_exchange').length - nb;
out.bulkArgs = H.calls('bulk_exchange')[nb].args;
out.offers = [...p.querySelectorAll('.qp-offer')].map(r => r.textContent);
await H.sleep(200);
out.bulkCallsLater = H.calls('bulk_exchange').length - nb;
const no = H.calls('open_url').length;
H.button(p, 'Open on trade site ↗').click();
await H.sleep(50);
out.exUrl = (H.calls('open_url')[no] || { args: [] }).args[0];
document.getElementById('priced-in').value = '';
document.getElementById('priced-in').dispatchEvent(new Event('change'));
return out;
"""


def scenario_v21b(s, tag):
    s.fresh()
    r = s.run(S18_V21B, timeout=60)
    sim, ex, base = r["similar"], r["exact"], r["base"]
    check(tag + " preset control on pasted rare", r["hasSeg"], r)
    check(tag + " Similar = defaults (T1 on at 90%, T5 off)", sim["rows"] == [[True, "81"], [False, "18"]], sim)
    check(tag + " Exact: all mods, full roll, all must match, exact base",
          ex["rows"] == [[True, "90"], [True, "20"]] and ex["mode"] == "0" and ex["by"] == "exact", ex)
    check(tag + " Base: no mods, exact base, item level", not any(c for c, _ in base["rows"]) and
          base["by"] == "exact" and base["ilvl"] == "84", base)
    q = (r["payloadBase"] or {}).get("query") or {}
    check(tag + " Base search has no stats, just the base", q.get("type") == "Two-Stone Ring" and
          not any(g.get("filters") for g in q.get("stats", [])), q)
    check(tag + " back to Similar restores the defaults", r["back"]["rows"] == sim["rows"] and
          r["back"]["mode"] == sim["mode"], r["back"])
    price = ((((r["payloadSimilar"] or {}).get("query") or {}).get("filters") or {}).get("trade_filters") or {}) \
        .get("filters", {}).get("price")
    check(tag + " Priced in divine: option set, chaos max converted", price == {"option": "divine", "max": 2}, price)
    check(tag + " Priced in shows as a context chip", "Priced in divine only" in (r["chips"] or ""), r["chips"])
    check(tag + " Live offers: one request per press", r["bulkCalls"] == 1 and r["bulkCallsLater"] == 1, r)
    check(tag + " offers listed with chaos each", len(r["offers"]) == 2 and "Bulk#1" in r["offers"][0] and
          "0.95c each" in r["offers"][0], r["offers"])
    check(tag + " exchange link opens via the bridge", (r["exUrl"] or "").startswith(
        "https://www.pathofexile.com/trade/exchange/") and "%22want%22%3A%5B%22chaos%22%5D" in r["exUrl"], r["exUrl"])


SCENARIOS = [
    ("1 landing", scenario_landing),
    ("2 decode", scenario_decode),
    ("3 price", scenario_price),
    ("4 pasted", scenario_pasted),
    ("5 market", scenario_market),
    ("6 settings", scenario_settings),
    ("7 keyboard", scenario_keyboard),
    ("8 wide", scenario_wide),
    ("9 flips", scenario_flips),
    ("10 diff", scenario_diff),
    ("11 track", scenario_track),
    ("12 batch", scenario_batch),
    ("13 weighted", scenario_weighted),
    ("14 stash", scenario_stash),
    ("15 zoom", scenario_zoom_complex),
    ("16 sessid", scenario_sessid),
    ("17 v21", scenario_v21),
    ("18 v21b", scenario_v21b),
]


def main():
    build_code = read("test/fixture-realbuild.txt").strip()
    edited_code, other_code = build_variants(build_code)
    data = {
        "flips": make_flips(),
        "version": "E2E",
        "leagues": pc_leagues(),
        "market": make_market(),
        "listings": make_listings(),
        "rates": RATES,
        "buildCode": build_code,
        "diagText": DIAG_TEXT,
    }
    stub = STUB_JS.replace("__DATA__", json.dumps(data))
    only = sys.argv[1:]  # optional: run scenarios whose tag contains any argument
    t0 = time.time()
    with StaticServer(ROOT) as server, Browser() as b:
        b.send("Page.enable")
        b.send("Runtime.enable")
        b.send("Network.enable")
        b.send("Network.setBlockedURLs", {"urls": ["*pathofexile.com*", "*poecdn.com*", "*pobb.in*",
                                                   "*pastebin.com*", "*github.com*", "https://*"]})
        b.send("Page.addScriptToEvaluateOnNewDocument", {"source": stub})
        s = Session(b, server)
        s.edited_code, s.other_code = edited_code, other_code
        for tag, fn in SCENARIOS:
            if only and not any(tag.split()[1] == o or tag.startswith(o + " ") for o in only):
                continue
            label = "[%s]" % tag
            try:
                fn(s, label)
            except Exception as e:  # a scenario that could not finish is one failure
                check(label + " scenario completed", False, "%s: %s" % (type(e).__name__, str(e).splitlines()[0] if str(e) else ""))
            errs, console = s.page_errors()
            check(label + " no uncaught page exceptions", not errs, "; ".join(errs[:5]))
            for c in console[:5]:
                print("     note %s console.error: %s" % (label, c[:200]))
            missing = s.unstubbed()
            if missing:
                print("     note %s unstubbed bridge calls: %s" % (label, ", ".join(missing)))
    print("\n(%.1fs)" % (time.time() - t0))
    print("ALL TESTS PASSED" if not failures else "%d FAILED" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
