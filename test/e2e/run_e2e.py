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
    trade_enable: function (on) { return on ? { ok: true, watching: true, logPath: 'C:/PoE/logs/Client.txt', logName: 'Client.txt',
      chatKeyName: 'Enter', elevationMismatch: false } : { ok: true, watching: false }; },
    trade_send: function () { return { ok: true }; },
    trade_highlight: function () { return { ok: true }; },
    trades_show: function () { return { ok: true }; },
    trades_hide: function () { return { ok: true }; },
    save_text_file: function () { return { ok: true, path: 'C:/x/sales.csv' }; },
    session_status: function () { return { ok: true, set: false }; },
    timeless_sockets: function () { return { ok: true, sockets: [] }; },
    hotkey_status: function () { return { ok: true, hotkey: 'ctrl+d', label: 'Ctrl+D', running: false, active: false, error: null }; },
    overlay_fit: function () { return { ok: true }; },
    get_character_passives: function () { return { ok: true, hashes: [], hashesEx: [], masteries: {}, jewels: [] }; },
    overlay_status: function () { return { ok: true, hotkey: 'Ctrl+D', hotkeys: { price: 'Ctrl+D', app: 'Shift+Space', trades: 'Alt+T' }, logWatching: true }; },
    trade_status: function () { return { ok: true, watching: true, logName: 'Client.txt' }; },
    trade_prefs_changed: function () { return { ok: true }; },
    open_main: function () { return { ok: true }; },
    app_overlay_size: function () { return { ok: true }; },
    app_overlay_move: function () { return { ok: true }; },
    overlay_shape: function () { return { ok: true }; },
    overlay_drag: function () { return { ok: true }; },
    game_search_paste: function () { return { ok: true }; },
    overlay_toggle_cards: function () { return { ok: true }; },
    set_hotkey: function (n, spec) { return { ok: true, hotkeys: {} }; },
    hotkeys_status: function () { return { ok: true, hotkeys: {} }; },
    app_overlay: function () { return { ok: true }; },
    quit_app: function () { return { ok: true }; },
    overlay_visible: function () { return { ok: true }; },
    overlay_reset_pos: function () { return { ok: true }; },
    trade_test: function () { return { ok: true }; },
    overlay_toggle_sheet: function () { return { ok: true }; },
    pick_sheet_image: function () { return { ok: true, file: 'data/cheatsheets/e2e.png', name: 'route.png' }; },
    delete_sheet_image: function () { return { ok: true }; },
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
  // 7-day chip (second .pct in the row) carries the chaos/divine amount too
  amtDivine: H.text('.pct', [...rowFor('Divine Orb').querySelectorAll('td')].filter(td => td.querySelector('.pct'))[1]),
  amtMirror: H.text('.pct', [...rowFor('Mirror of Kalandra').querySelectorAll('td')].filter(td => td.querySelector('.pct'))[1]),
  moverAmt: !!page.querySelector('.mk-mover .pct-amt'),
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

    def fresh(self, query=""):
        """New page load, empty localStorage, no leftover events. query: e.g. "?trades=1"."""
        self.b.send("Storage.clearDataForOrigin", {"origin": self.server.origin, "storageTypes": "local_storage"})
        self.b.take_events()
        self.b.navigate(self.url + query, READY_JS, timeout=30)

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
    check(tag + " change shows chaos amount under a divine", "+20c" in (r["amtDivine"] or ""), r["amtDivine"])
    check(tag + " change shows divines once worth one", "+50 div" in (r["amtMirror"] or ""), r["amtMirror"])
    check(tag + " movers show the amount", r["moverAmt"])
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


S19_CARDS = r"""
const H = window.__e2e;
const out = {};
const sends = () => H.calls('trade_send').map(c => c.args);
const card = name => [...document.querySelectorAll('.trade-card')].find(c => c.querySelector('.tc-name').textContent === name);
out.layout = { cards: document.body.classList.contains('trade-cards'),
  bg: getComputedStyle(document.body).backgroundColor,
  resultsHidden: getComputedStyle(document.getElementById('results')).display === 'none',
  noIcon: !document.querySelector('.ov-icon'), empty: !document.querySelector('.ov-cards') };
out.firstVisible = (H.calls('overlay_visible')[0] || { args: [] }).args;
out.fitCalls = H.calls('overlay_fit').length;
window.__ovToggle(); // the icon click / hotkey, relayed by gui.py
await H.sleep(30);
out.offNote = H.text('.ov-note');
out.grip = !!document.querySelector('.ov-head .ov-grip') && !document.querySelector('.pywebview-drag-region');
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ enabled: true, ack: true, sound: false }));
await window.__tradePrefsChanged();
window.__ovToggle(); // hide again: a new trade must open it
await H.sleep(20);
out.hiddenAgain = !document.querySelector('.ov-cards');
const T = { kind: 'item', item: 'Doom Loop Two-Stone Ring', price: 2, currency: 'divine', league: 'Standard',
  tab: '~price 2 div', left: 5, top: 3, note: 'offer 1.5?' };
window.__tradeEvent({ type: 'whisper', dir: 'in', guild: '<ART>™', name: 'BuyerOne', text: 'Hi, I would like to buy…', trade: T });
await H.sleep(30);
let c = card('BuyerOne');
out.opened = !!c && H.text('.ov-head-title') === 'Trades (1)';
out.visibleCall = H.calls('overlay_visible').slice(-1)[0].args;
out.newCard = { actions: [...c.querySelectorAll('.tc-actions > .btn')].map(b => b.textContent), item: H.text('.tc-item', c),
  where: H.text('.tc-where', c), note: H.text('.tc-note', c), inputs: c.querySelectorAll('input, select').length };
out.sendsAfterWhisper = sends().length;
H.button(c, 'Invite').click();
await H.sleep(30);
H.button(card('BuyerOne'), 'Busy').click();
await H.sleep(30);
out.sends1 = sends();
H.button(card('BuyerOne'), '▣ Show in stash').click();
await H.sleep(30);
out.highlight = H.calls('trade_highlight')[0].args;
// ⋯ opens an inline row (no pop-up menu); Ignore needs two clicks
card('BuyerOne').querySelector('.tc-actions .btn-icon').click();
await H.sleep(20);
out.moreRow = [...card('BuyerOne').querySelectorAll('.tc-more .btn')].map(b => b.textContent);
const n0 = sends().length;
H.button(card('BuyerOne'), 'Ignore in game').click();
await H.sleep(20);
out.ignoreArmedSends = sends().length - n0;
H.button(card('BuyerOne'), 'Click again: /ignore BuyerOne').click();
await H.sleep(30);
out.ignoreSent = sends().slice(n0);
window.__tradeEvent({ type: 'joined', name: 'BuyerOne' });
await H.sleep(20);
c = card('BuyerOne');
out.joined = { here: !!c.querySelector('.tc-here'), actions: [...c.querySelectorAll('.tc-actions > .btn')].map(b => b.textContent),
  outcomes: [...c.querySelectorAll('.tc-outcomes .btn')].map(b => b.textContent) };
window.__tradeEvent({ type: 'trade_accepted' });
await H.sleep(20);
c = card('BuyerOne');
out.suggested = c.querySelector('.tc-outcomes .btn.suggested') ? c.querySelector('.tc-outcomes .btn.suggested').textContent : null;
out.sendsAfterEvents = sends().length;
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 200, divine: 1 };
c.querySelector('.tc-outcomes .btn.suggested').click();
await H.waitFor(() => !card('BuyerOne'), 3000, 'card closed');
out.sales = JSON.parse(localStorage.getItem('pobtf-sales'));
out.buyers = JSON.parse(localStorage.getItem('pobtf-buyers'));
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'BuyerOne', text: 'hi', trade: Object.assign({}, T, { item: 'Other Ring' }) });
await H.sleep(20);
out.badge = H.text('.buyer-badge', card('BuyerOne'));
H.button(card('BuyerOne'), 'Invite').click();
await H.sleep(30);
tradeCards.find(x => x.name === 'BuyerOne').invitedAt = Date.now() - 6 * 60000;
renderTrades();
H.button(card('BuyerOne'), '⌛ Mark as no-show').click();
await H.sleep(30);
out.noShow = JSON.parse(localStorage.getItem('pobtf-buyers')).buyerone.noShow;
window.__tradeEvent({ type: 'whisper', dir: 'out', name: 'SellerTwo', text: 'Hi, I would like to buy your X listed for 5 chaos in Standard',
  trade: { kind: 'item', item: 'X', price: 5, currency: 'chaos', league: 'Standard' } });
await H.sleep(20);
c = card('SellerTwo');
out.outActions = [...c.querySelectorAll('.tc-actions > .btn')].map(b => b.textContent);
const n1 = sends().length;
H.button(c, 'Re-whisper').click();
await H.sleep(30);
out.rewhisper = sends().slice(n1);
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'Spammer', text: 'hi', trade: Object.assign({}, T, { item: 'Junk' }) });
await H.sleep(20);
await hideBuyer(tradeCards.find(x => x.name === 'Spammer'));
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'Spammer', text: 'hi', trade: Object.assign({}, T, { item: 'Junk 2' }) });
await H.sleep(20);
out.hidden = { visible: !!card('Spammer'), summary: H.text('.disclosure summary') };
out.fit = H.calls('overlay_fit').slice(-1)[0].args;
out.noDialogs = !document.querySelector('dialog');
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ enabled: true, ack: true, sound: 'off', cardLayout: 'row',
  customButtons: [{ label: '1 min', text: 'one minute for {item}', when: 'new' }, { label: 'gg', text: 'gg', when: 'here' }] }));
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'Custom', text: 'hi', trade: Object.assign({}, T, { item: 'Belt' }) });
await H.sleep(20);
const cc = card('Custom');
out.customActions = [...cc.querySelectorAll('.tc-actions > .btn')].map(b => b.textContent);
const n9 = sends().length;
H.button(cc, '1 min').click();
await H.sleep(30);
out.customSend = sends().slice(n9);
out.rowLayout = !!document.querySelector('.ov-cards.is-row');
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ enabled: true, ack: true, sound: 'off', opacity: 50, locked: true }));
window.__ovToggle(); if (!document.querySelector('.ov-head')) window.__ovToggle();
renderTrades();
out.opacity = getComputedStyle(document.getElementById('trades-root')).getPropertyValue('--ov-opacity').trim();
out.gripWhenLocked = !!document.querySelector('.ov-grip');
localStorage.removeItem('pobtf-zone-notes');
window.__tradeEvent({ type: 'zone', area: 'The Lower Prison' });
await H.sleep(20);
out.zone = H.text('.ov-zone');
window.__tradeEvent({ type: 'zone', area: 'The Twilight Strand' });
await H.sleep(20);
out.zoneGone = !document.querySelector('.ov-zone');
return out;
"""

S19_HELPER = r"""
const H = window.__e2e;
const out = {};
const clickDialog = async label => { await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'dialog');
  H.button(document.querySelector('dialog[open]'), label).click(); await H.sleep(30); };
out.tabs = [...document.querySelectorAll('.trades-tab')].map(b => b.textContent);
out.firstTab = H.text('.trades-tab[aria-selected="true"]');
out.enableAtStart = H.calls('trade_enable').length;
H.button(document.querySelector('.trades-tabs'), 'Setup').click();
await H.sleep(30);
out.iconToggle = [...document.querySelectorAll('.trade-setup .toggle')].some(t => /PoB icon over the game/.test(t.textContent));
out.zoneRows = document.querySelectorAll('.zone-row').length;
document.querySelector('input[aria-label="New zone note area"]').value = 'The Ledge';
document.querySelector('input[aria-label="New zone note text"]').value = 'Run fast';
H.button(document.querySelector('.zone-notes'), 'Add').click();
await H.sleep(20);
out.zoneSaved = JSON.parse(localStorage.getItem('pobtf-zone-notes'))['The Ledge'];
out.soundOpts = [...document.querySelectorAll('.trade-setup select[aria-label=Sound] option')].map(o => o.textContent);
out.sliders = [...document.querySelectorAll('.trade-setup input[type=range]')].map(r => r.getAttribute('aria-label'));
const vol = document.querySelector('.trade-setup input[aria-label=Volume]');
vol.value = '0'; vol.dispatchEvent(new Event('change'));
const op = document.querySelector('.trade-setup input[aria-label=Opacity]');
op.value = '60'; op.dispatchEvent(new Event('change'));
out.lock = [...document.querySelectorAll('.trade-setup .toggle')].some(t => /Lock position/.test(t.textContent));
await H.sleep(30);
out.prefsAfter = JSON.parse(localStorage.getItem('pobtf-trade-prefs'));
document.getElementById('trade-enabled').click();
await H.sleep(30);
out.enableBeforeConfirm = H.calls('trade_enable').length;
await clickDialog('Switch on');
await H.waitFor(() => H.calls('trade_enable').some(c => c.args[0] === true), 3000, 'enable');
await H.waitFor(() => H.calls('trade_prefs_changed').length, 3000, 'overlay told');
out.status = H.text('#trades-status');
// sales recorded by the overlay; edit one here
const now = Date.now();
localStorage.setItem('pobtf-sales', JSON.stringify([
  { id: 'a', time: now - 3600e3, outcome: 'completed', league: 'Standard', item: 'Doom Loop', price: 2, currency: 'divine', chaos: 400, div: 2, buyer: 'BuyerOne' },
  { id: 'b', time: now, outcome: 'completed', league: 'Standard', item: '=HYPERLINK("x")', price: 10, currency: 'chaos', chaos: 10, div: 0.05, buyer: 'Z' }]));
localStorage.setItem('pobtf-buyers', JSON.stringify({ buyerone: { name: 'BuyerOne', names: ['BuyerOne'], completed: 1, spent: 400,
  wasted: 0, noShow: 0, notCompleted: 0, other: 0, flag: false, hidden: false, note: '' } }));
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 200, divine: 1 };
H.button(document.querySelector('.trades-tabs'), 'Sales').click();
await H.sleep(30);
out.tiles = [...document.querySelectorAll('.sales-tile')].map(t => t.textContent);
out.chart = !!document.querySelector('.sales-chart rect');
const row = [...document.querySelectorAll('.data-table tbody tr')].find(r => r.textContent.includes('Doom Loop') && H.button(r, 'Edit'));
H.button(row, 'Edit').click();
await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'edit dialog');
const dlg = document.querySelector('dialog[open]');
dlg.querySelector('input[type=number]').value = '1.5';
dlg.querySelector('input[aria-label=Note]').value = 'haggled';
await clickDialog('Save');
await H.sleep(50);
out.edited = JSON.parse(localStorage.getItem('pobtf-sales')).find(s => s.id === 'a');
H.button(document, 'Export CSV').click();
await H.sleep(50);
out.csv = H.calls('save_text_file')[0].args[1];
H.button(document.querySelector('.trades-tabs'), 'Buyers').click();
await H.sleep(30);
out.buyerRows = document.querySelectorAll('.buyer-row').length;
const n1 = H.calls('trade_send').length;
H.button(document.querySelector('.buyer-row'), 'Ignore in game…').click();
await clickDialog('Send /ignore');
await H.sleep(30);
out.ignore = H.calls('trade_send').slice(n1).map(c => c.args);
return out;
"""


def scenario_trades(s, tag):
    s.fresh("?cards=1")
    r = s.run(S19_CARDS, timeout=60)
    L = r["layout"]
    check(tag + " cards overlay: see-through, its own window (no icon), hidden until needed", L["cards"] and
          L["resultsHidden"] and L["noIcon"] and L["empty"] and L["bg"] in ("rgba(0, 0, 0, 0)", "transparent") and
          r["firstVisible"][:2] == ["cards", False], (L, r["firstVisible"]))
    check(tag + " cards overlay sizes its window to the content", r["fit"][0] == "cards" and
          0 < r["fit"][1] <= 400, r["fit"])
    check(tag + " icon/hotkey toggle shows the cards, with their own drag grip", r["grip"] and r["hiddenAgain"], r)
    check(tag + " helper off: says where to switch it on", "Setup" in (r["offNote"] or ""), r["offNote"])
    check(tag + " new trade opens the cards and reports the count for the icon", r["opened"] and
          r["visibleCall"] == ["cards", True, 1], (r["opened"], r["visibleCall"]))
    check(tag + " incoming card: Invite · Busy · Sold · Still interested?",
          r["newCard"]["actions"][:4] == ["Invite", "Busy", "Sold", "Still interested?"], r["newCard"])
    check(tag + " card shows item, price, tab position and note", "2 div" in r["newCard"]["item"] and
          "left 5, top 3" in r["newCard"]["where"] and "offer 1.5?" in r["newCard"]["note"], r["newCard"])
    check(tag + " overlay cards have no text inputs (never take the keyboard)", r["newCard"]["inputs"] == 0, r["newCard"])
    check(tag + " a whisper sends nothing by itself", r["sendsAfterWhisper"] == 0, r["sendsAfterWhisper"])
    check(tag + " one press = one command", r["sends1"] == [["invite", "BuyerOne", None],
          ["whisper", "BuyerOne", "I'm busy right now, I'll invite you shortly"]], r["sends1"])
    check(tag + " stash highlight gets the position", r["highlight"][:2] == [5, 3], r["highlight"])
    check(tag + " ⋯ shows an inline row (Whois, Flag, Hide, Ignore)", r["moreRow"] == ["Whois", "⚑ Flag", "Hide buyer",
          "Ignore in game"], r["moreRow"])
    check(tag + " Ignore needs a second click, then sends /ignore once", r["ignoreArmedSends"] == 0 and
          r["ignoreSent"] == [["ignore", "BuyerOne", None]], (r["ignoreArmedSends"], r["ignoreSent"]))
    check(tag + " buyer joined: badge, Trade · Kick · Thanks, outcomes", r["joined"]["here"] and
          r["joined"]["actions"][:3] == ["Trade", "Kick", "Thanks"] and
          r["joined"]["outcomes"][0].startswith("✓ Completed") and "⌛ Time wasted" in r["joined"]["outcomes"], r["joined"])
    check(tag + " Trade accepted highlights Completed (listed price), sends nothing",
          (r["suggested"] or "").startswith("✓ Completed · 2 div") and r["sendsAfterEvents"] == 3, r)
    sale = (r["sales"] or [{}])[0]
    check(tag + " sale recorded at the listed price", sale.get("outcome") == "completed" and sale.get("price") == 2 and
          sale.get("currency") == "divine" and sale.get("chaos") == 400 and sale.get("buyer") == "BuyerOne", sale)
    b = (r["buyers"] or {}).get("buyerone") or {}
    check(tag + " buyer reputation counts the sale", b.get("completed") == 1 and b.get("spent") == 400, b)
    check(tag + " repeat buyer gets a badge", "1 bought" in (r["badge"] or ""), r["badge"])
    check(tag + " no-show after the set minutes", r["noShow"] == 1, r["noShow"])
    check(tag + " outgoing card: Visit hideout · Trade · Re-whisper",
          r["outActions"] == ["Visit hideout", "Trade", "Re-whisper"], r["outActions"])
    check(tag + " re-whisper sends the original text once", len(r["rewhisper"]) == 1 and r["rewhisper"][0][0] == "whisper"
          and r["rewhisper"][0][2].startswith("Hi, I would like"), r["rewhisper"])
    check(tag + " hidden buyer: no card, listed under Hidden", not r["hidden"]["visible"] and
          "Hidden (2)" in (r["hidden"]["summary"] or ""), r["hidden"])
    check(tag + " overlay never opens a dialog", r["noDialogs"], r["noDialogs"])
    check(tag + " your own buttons on the card, one whisper per press", "1 min" in r["customActions"] and
          "gg" not in r["customActions"] and r["customSend"] == [["whisper", "Custom", "one minute for Belt"]],
          (r["customActions"], r["customSend"]))
    check(tag + " side-by-side card layout", r["rowLayout"], r["rowLayout"])
    check(tag + " zone note shows on entering an area with a note, not elsewhere",
          "The Lower Prison" in (r["zone"] or "") and "Trial of Ascendancy" in r["zone"] and r["zoneGone"], r["zone"])
    check(tag + " overlay opacity setting applied, Lock hides the drag grip", r["opacity"] == "0.5" and
          not r["gripWhenLocked"], (r["opacity"], r["gripWhenLocked"]))

    s.fresh("?trades=1")
    r = s.run(S19_HELPER, timeout=60)
    check(tag + " helper window: Sales · Buyers · Setup, opens on Sales", r["tabs"] == ["Sales", "Buyers", "Setup"] and
          r["firstTab"] == "Sales", r["tabs"])
    check(tag + " helper window doesn't restart the log reader on open", r["enableAtStart"] == 0, r["enableAtStart"])
    check(tag + " Setup has the overlay icon option", r["iconToggle"], r["iconToggle"])
    check(tag + " zone notes: starters listed, new note saved", r["zoneRows"] >= 7 and r["zoneSaved"] == "Run fast",
          (r["zoneRows"], r["zoneSaved"]))
    check(tag + " Sound: Off + styles, volume and opacity sliders, lock", r["soundOpts"][0] == "Off" and
          len(r["soundOpts"]) >= 4 and r["sliders"] == ["Volume", "Opacity"] and r["lock"], (r["soundOpts"], r["sliders"]))
    pa = r["prefsAfter"] or {}
    check(tag + " sliders save (volume 0 = silent, opacity 60%)", pa.get("volume") == 0 and pa.get("opacity") == 60, pa)
    check(tag + " switching on asks first, then reads the log and tells the overlay",
          r["enableBeforeConfirm"] == 0 and "Reading" in (r["status"] or ""), r)
    check(tag + " sales totals + chart", any("Sales2" in t.replace(" ", "") for t in r["tiles"]) and r["chart"], r["tiles"])
    e = r["edited"] or {}
    check(tag + " Edit sale: new price re-valued, note kept", e.get("price") == 1.5 and e.get("chaos") == 300 and
          e.get("note") == "haggled", e)
    check(tag + " CSV export: header + formula-safe cells", (r["csv"] or "").startswith("time,outcome,league,item") and
          "'=HYPERLINK" in r["csv"], (r["csv"] or "")[:200])
    check(tag + " Buyers page lists them", r["buyerRows"] >= 1, r["buyerRows"])
    check(tag + " Ignore in game (helper window): one /ignore after confirming",
          r["ignore"] == [["ignore", "BuyerOne", None]], r["ignore"])



S19_ICON = r"""
const H = window.__e2e;
const out = {};
await H.waitFor(() => document.querySelector('.ov-icon.is-running'), 3000, 'status');
out.icon = { running: true, title: document.querySelector('.ov-icon').title, grip: !!document.querySelector('.ov-grip'),
  buttons: document.querySelectorAll('.ov-bar .btn').length, cards: !!document.querySelector('.trade-card') };
window.__ovCount(2, true);
await H.sleep(20);
out.count = H.text('.ov-count');
document.querySelector('.ov-icon').click();
await H.sleep(30);
out.toggles = H.calls('overlay_toggle_cards').length;
document.getElementById('trades-root').dispatchEvent(new Event('mouseenter'));
await H.sleep(20);
out.hoverButtons = [...document.querySelectorAll('.ov-bar .btn')].map(b => b.getAttribute('aria-label'));
document.getElementById('trades-root').dispatchEvent(new Event('mouseleave'));
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ iconMode: 'trades' }));
window.__ovCount(0, false);
await H.sleep(30);
out.lastVisible = H.calls('overlay_visible').slice(-1)[0].args;
out.fit = H.calls('overlay_fit').slice(-1)[0].args;
localStorage.setItem('pobtf-trade-prefs', '{}');
window.__ovCount(1, true);
await H.sleep(20);
const g = document.querySelector('.ov-grip');
g.setPointerCapture = () => {};
g.dispatchEvent(new PointerEvent('pointerdown', { screenX: 100, screenY: 100, pointerId: 1, bubbles: true }));
g.dispatchEvent(new PointerEvent('pointermove', { screenX: 140, screenY: 90, pointerId: 1, bubbles: true }));
await H.sleep(30);
g.dispatchEvent(new PointerEvent('pointerup', { screenX: 150, screenY: 80, pointerId: 1, bubbles: true }));
await H.sleep(30);
out.drag = H.calls('overlay_drag').map(c => c.args);
const sh = H.calls('overlay_shape').slice(-1)[0];
out.shape = sh ? sh.args : null;
const ib = document.querySelector('.ov-icon').getBoundingClientRect();
out.iconBox = [Math.floor(ib.left), Math.floor(ib.top), Math.ceil(ib.width)];
return out;
"""


def scenario_overlay_icon(s, tag):
    s.fresh("?ovicon=1")
    r = s.run(S19_ICON, timeout=30)
    i = r["icon"]
    check(tag + " icon overlay: PoB button + grip, no cards, status in the tooltip", i["grip"] and not i["cards"] and
          i["buttons"] == 0 and "Shift+Space" in i["title"] and "Alt+T" in i["title"], i)
    check(tag + " icon shows the open-trade count", r["count"] == "2", r["count"])
    check(tag + " icon click toggles the cards (through gui.py)", r["toggles"] == 1, r["toggles"])
    check(tag + " extra buttons only on hover (settings, app, trade helper)", len(r["hoverButtons"]) == 3, r["hoverButtons"])
    check(tag + " 'only when there are trades' hides the icon with none", r["lastVisible"][:2] == ["icon", False],
          r["lastVisible"])
    check(tag + " icon window sized to the button", r["fit"][0] == "icon" and 0 < r["fit"][1] < 200, r["fit"])
    sh = r["shape"] or [None, []]
    icon = [x for x in (sh[1] or []) if x[2] == r["iconBox"][2] and x[4] * 2 == x[2]]
    check(tag + " window clipped to what's drawn: round icon + grip, nothing else", sh[0] == "icon" and
          len(icon) == 1 and len(sh[1]) == 2, (sh, r["iconBox"]))
    check(tag + " dragging the grip moves the window through gui.py", r["drag"][:1] == [["icon", "start", 0, 0]] and
          ["icon", "move", 40, -10] in r["drag"] and r["drag"][-1] == ["icon", "end", 50, -20], r["drag"])


S21_UNIQUES = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
BATCH_GAP_MS = 5;
setView('uniques');
await H.sleep(30);
const sec = document.querySelector('.tab-section[data-tab="uniques"]');
out.nav = [...document.querySelectorAll('#nav .nav-item')].some(b => b.dataset.view === 'uniques');
out.visible = sec.getBoundingClientRect().height > 100;
out.auras = [...sec.querySelectorAll('.uj-aura')].map(b => [b.textContent, b.classList.contains('is-on')]);
out.buildAuras = buildAuras(build);
out.modsBefore = sec.querySelectorAll('.uj-mod').length;
const lt = [...sec.querySelectorAll('.toggle')].find(t => /legacy/.test(t.textContent));
out.legacyHasToggle = !!lt;
// make sure Anger + Determination are picked, then tick two mods
['Anger', 'Determination'].forEach(a => { const c = [...sec.querySelectorAll('.uj-aura')].find(b => b.textContent === a);
  if (!c.classList.contains('is-on')) c.click(); });
await H.sleep(20);
['Clarity'].forEach(a => { const c = [...sec.querySelectorAll('.uj-aura')].find(b => b.textContent === a);
  if (!c.classList.contains('is-on')) c.click(); });
await H.sleep(10);
const clarityCurrent = sec.querySelectorAll('.uj-mod').length;
lt.querySelector('input').click();
await H.sleep(10);
out.legacyAdded = sec.querySelectorAll('.uj-mod').length - clarityCurrent;
out.legacyChips = [...sec.querySelectorAll('.uj-mod .badge')].filter(b => b.textContent === 'legacy').length;
lt.querySelector('input').click();
await H.sleep(10);
const modRow = t => [...sec.querySelectorAll('.uj-mod')].find(r => r.textContent.includes(t));
const extra = modRow('Gain #% of Physical Damage as Extra Fire Damage');
extra.querySelector('input[type=checkbox]').click();
extra.querySelector('input[type=number]').value = '20';
modRow('Prevent +#% of Reflected Physical Damage').querySelector('input[type=checkbox]').click();
await H.sleep(20);
const n0 = H.calls('open_url').length;
H.button(sec, 'Search on trade ↗').click();
await H.sleep(20);
out.url = (H.calls('open_url')[n0] || { args: [''] }).args[0];
window.__stubOverrides.trade_search = { ok: true, total: 3, listings: [
  { id: 'w1', amount: 5, currency: 'divine', account: 'A#1', whisper: '@a hi', online: true,
    explicitMods: ['Gain 22% of Physical Damage as Extra Fire Damage while affected by Anger', '+1% to all maximum Resistances'] }] };
window.__stubOverrides.exchange_rates = { ok: true, rates: { divine: 200 } };
const before = H.calls('trade_search').length;
H.button(sec, 'Check price').click();
await H.waitFor(() => sec.querySelector('.uj-listing'), 3000, 'listing');
out.listing = H.text('.uj-listing', sec);
out.summary = H.text('.uj-out .finder-sub', sec);
// a third mod, then price each pair: 3 searches, each an AND of exactly two
modRow('additional Physical Damage Reduction').querySelector('input[type=checkbox]').click();
await H.sleep(20);
const b2 = H.calls('trade_search').length;
H.button(sec, 'Price each pair').click();
await H.waitFor(() => H.calls('trade_search').length - b2 >= 3 && H.button(sec, 'Price each pair'), 8000, 'pairs');
await H.sleep(50);
out.pairPayloads = H.calls('trade_search').slice(b2).map(c => JSON.parse(c.args[1]).query.stats[0]);
out.pairRows = sec.querySelectorAll('.uj-pair').length;
const b3t = H.calls('trade_search').length;
H.button(sec, 'Price each triple').click();
await H.waitFor(() => H.calls('trade_search').length - b3t >= 1 && H.button(sec, 'Price each triple'), 8000, 'triples');
await H.sleep(50);
out.triplePayloads = H.calls('trade_search').slice(b3t).map(c => JSON.parse(c.args[1]).query.stats[0]);
// Forbidden: your ascendancy's notables, a pair = Flame + Flesh with the same node
sec.querySelector('.segmented [data-value="forbidden"]').click();
await H.sleep(20);
out.asc = sec.querySelector('select[aria-label=Ascendancy]').value;
out.notables = sec.querySelectorAll('.uj-fb').length;
const b3 = H.calls('trade_search').length;
H.button(sec.querySelector('.uj-fb'), 'Price pair').click();
await H.waitFor(() => H.calls('trade_search').length - b3 >= 2, 8000, 'forbidden');
await H.sleep(50);
out.fb = H.calls('trade_search').slice(b3).map(c => { const q = JSON.parse(c.args[1]).query; return [q.name, q.type, q.stats[0].filters[0].id]; });
out.fbPrice = H.text('.uj-fb .uj-price', sec);
// Thread of Hope: five sizes, each its own stat id
sec.querySelector('.segmented [data-value="thread"]').click();
await H.sleep(20);
out.rings = [...sec.querySelectorAll('.uj-pair-mods')].map(e => e.textContent);
const n1 = H.calls('open_url').length;
H.button(sec.querySelectorAll('.uj-pair')[4], 'Search on trade ↗').click();
await H.sleep(20);
out.threadUrl = decodeURIComponent((H.calls('open_url')[n1] || { args: [''] }).args[0]);
delete window.__stubOverrides.trade_search;
return out;
"""


def scenario_uniques(s, tag):
    s.fresh()
    r = s.run(S21_UNIQUES, timeout=60)
    check(tag + " legacy Watcher's Eye mods only on request, marked legacy", r["legacyHasToggle"] and
          r["legacyAdded"] > 0 and r["legacyChips"] == r["legacyAdded"], (r["legacyAdded"], r["legacyChips"]))
    check(tag + " Watcher's Eye & co. in the sidebar and visible", r["nav"] and r["visible"], (r["nav"], r["visible"]))
    check(tag + " all 17 auras offered, build's auras pre-picked", len(r["auras"]) == 17 and
          all(on == (name in r["buildAuras"]) for name, on in r["auras"]), (r["buildAuras"], r["auras"]))
    u = __import__("urllib.parse").parse.unquote(r["url"] or "")
    check(tag + " trade link: league in the URL, Watcher's Eye, correct current stat ids", "/trade/search/" in u and
          "Watcher's Eye" in u and "explicit.stat_4245204226" in u and "explicit.stat_2255585376" in u and
          '"min":20' in u and '"type":"count"' not in u, u[:300])
    check(tag + " in-app price check lists the jewel (aura mods only)", "5 divine" in (r["listing"] or "") and
          "Extra Fire" in r["listing"] and "maximum Resistances" not in r["listing"], r["listing"])
    check(tag + " cheapest shown in chaos", "1000" in (r["summary"] or "") or "5 div" in (r["summary"] or ""), r["summary"])
    pp = r["pairPayloads"]
    check(tag + " price each pair: 3 searches, each AND of two mods", len(pp) == 3 and
          all(g["type"] == "and" and len(g["filters"]) == 2 for g in pp) and r["pairRows"] == 3, (pp, r["pairRows"]))
    tp = r["triplePayloads"]
    check(tag + " price each triple: 3 ticked = 1 search, AND of all three", len(tp) == 1 and tp[0]["type"] == "and" and
          len(tp[0]["filters"]) == 3, tp)
    check(tag + " Forbidden: build's ascendancy and its notables", r["asc"] == "Elementalist" and r["notables"] >= 5,
          (r["asc"], r["notables"]))
    fb = r["fb"]
    check(tag + " Forbidden pair = Flame (Crimson) + Flesh (Cobalt), same node", len(fb) == 2 and
          fb[0][:2] == ["Forbidden Flame", "Crimson Jewel"] and fb[1][:2] == ["Forbidden Flesh", "Cobalt Jewel"] and
          fb[0][2].startswith("explicit.stat_2460506030|") and fb[1][2].startswith("explicit.stat_1190333629|") and
          fb[0][2].split("|")[1] == fb[1][2].split("|")[1], fb)
    check(tag + " pair price shown", "the pair" in (r["fbPrice"] or ""), r["fbPrice"])
    check(tag + " Thread of Hope: 5 ring sizes, Massive = |5", r["rings"] == ["Small Ring", "Medium Ring", "Large Ring",
          "Very Large Ring", "Massive Ring"] and "explicit.stat_3642528642|5" in r["threadUrl"], (r["rings"], r["threadUrl"][:200]))


S22_SEARCH = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
setView('search');
await H.sleep(30);
const sec = document.querySelector('.tab-section[data-tab="search"]');
out.visible = sec.getBoundingClientRect().height > 100;
out.mods = sec.querySelectorAll('.st-mod').length;
const f = sec.querySelector('input[aria-label="Filter map mods"]');
const row = t => [...sec.querySelectorAll('.st-mod')].find(r => r.querySelector('.st-mod-text').textContent === t);
const regen = 'Players cannot Regenerate Life, Mana or Energy Shield';
row(regen).querySelector('button[title="Avoid"]').click();
await H.sleep(10);
row('Players are Cursed with Vulnerability').querySelector('button[title="Avoid"]').click();
await H.sleep(10);
row('Monster Damage Penetrates #% Elemental Resistances').querySelector('button[title="Want"]').click();
await H.sleep(10);
const q = sec.querySelector('input[aria-label="Minimum item quantity"]');
q.value = '60'; q.dispatchEvent(new Event('input'));
await H.sleep(10);
out.tokens = { regen: row(regen).querySelector('.st-token').textContent,
  vuln: row('Players are Cursed with Vulnerability').querySelector('.st-token').textContent,
  pen: row('Monster Damage Penetrates #% Elemental Resistances').querySelector('.st-token').textContent };
out.text = sec.querySelector('.st-text').value;
out.count = H.text('.st-result .badge', sec);
f.value = 'cursed'; f.dispatchEvent(new Event('input'));
await H.sleep(10);
out.filtered = sec.querySelectorAll('.st-mod').length;
H.button(sec, 'Copy').click();
await H.sleep(30);
out.clip = window.__clip;
H.button(sec, 'Paste into game').click();
await H.sleep(30);
out.paste = (H.calls('game_search_paste')[0] || { args: [] }).args[0];
sec.querySelector('input[aria-label="Preset name"]').value = 'my maps';
H.button(sec, 'Save preset').click();
await H.sleep(20);
H.button(sec, 'Clear').click();
await H.sleep(20);
out.cleared = sec.querySelector('.st-text').value;
H.button(sec.querySelector('.st-presets'), 'my maps').click();
await H.sleep(20);
out.loaded = sec.querySelector('.st-text').value;
sec.querySelector('.segmented [data-value="custom"]').click();
await H.sleep(20);
const ta = sec.querySelector('.st-words');
ta.value = 'movement speed\nr-g-b'; ta.dispatchEvent(new Event('input'));
await H.sleep(10);
out.anyWords = sec.querySelector('.st-text').value;
const mode = [...sec.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'exclude'));
mode.value = 'exclude'; mode.dispatchEvent(new Event('change'));
await H.sleep(10);
out.noneWords = sec.querySelector('.st-text').value;
out.long = buildSearchText({ avoid: Array.from({ length: 20 }, (_, i) => 'abc' + i), want: [], quant: 0 }).length;
return out;
"""


def scenario_search(s, tag):
    s.fresh()
    r = s.run(S22_SEARCH, timeout=60)
    check(tag + " Search text view visible with the map mods", r["visible"] and r["mods"] > 60, (r["visible"], r["mods"]))
    t = r["tokens"]
    want = '"!%s|%s" "%s" "m q.*(\d{3}|[6-9]\d)%%"' % (t["regen"], t["vuln"], t["pen"])
    check(tag + " avoid + want + quantity build one search string", r["text"] == want, (r["text"], want))
    check(tag + " length shown against the 50 limit", r["count"] == "%d / 50" % len(want), r["count"])
    check(tag + " filter narrows the list", 0 < r["filtered"] < 15, r["filtered"])
    check(tag + " Copy puts it on the clipboard", r["clip"] == want, r["clip"])
    check(tag + " Paste into game sends that text (one press)", r["paste"] == want, r["paste"])
    check(tag + " presets save and load", r["cleared"] == "" and r["loaded"] == want, (r["cleared"], r["loaded"]))
    check(tag + " own words: any / none", r["anyWords"] == '"movement speed|r-g-b"' and
          r["noneWords"] == '"!movement speed|r-g-b"', (r["anyWords"], r["noneWords"]))


S23_HABITS = r"""
const H = window.__e2e;
const out = { rounds: [] };
const ITEM = ['Item Class: Rings', 'Rarity: Rare', 'Doom Loop', 'Two-Stone Ring', '--------', 'Item Level: 84', '--------',
  '{ Prefix Modifier "Prime" (Tier: 1) — Life }', '+90(90-99) to maximum Life',
  '{ Suffix Modifier "of the Volcano" (Tier: 1) — Elemental, Fire, Resistance }', '+44(42-45)% to Fire Resistance'].join('\n');
window.__stubOverrides.trade_search = { ok: true, total: 0, searchId: 'h', ids: [], pageSize: 10, listings: [] };
async function paste() {
  document.getElementById('pob-input').value = ITEM;
  document.getElementById('decode-btn').click();
  await H.waitFor(() => document.querySelector('.card.pasted'), 5000, 'pasted');
  await H.sleep(30);
  return cards.find(s => s.card === document.querySelector('.card.pasted'));
}
for (let i = 0; i < 3; i++) {
  const st = await paste();
  const life = st.rows.find(r => /maximum Life/.test(r.mod.line));
  out.rounds.push({ on: life.cb.checked, learned: !!life.cb.closest('.mod-row, label, div').parentElement.querySelector('.badge.tone-info') ||
    [...st.card.querySelectorAll('.badge')].some(b => b.textContent === 'learned') });
  if (life.cb.checked) life.cb.click(); // the user turns life off by hand
  // a preset change must not count
  H.button(st.card, 'Check price').click();
  await H.sleep(80);
}
out.habits = JSON.parse(localStorage.getItem('pobtf-filter-habits'));
forgetFilterHabits();
const st4 = await paste();
out.afterForget = st4.rows.find(r => /maximum Life/.test(r.mod.line)).cb.checked;
// presets don't teach: Exact turns everything on without a click
localStorage.setItem('pobtf-filter-habits', '{}');
const st5 = await paste();
st5.card.querySelector('.segmented [data-value="exact"]').click();
await H.sleep(20);
H.button(st5.card, 'Check price').click();
await H.sleep(80);
out.afterPreset = localStorage.getItem('pobtf-filter-habits');
delete window.__stubOverrides.trade_search;
return out;
"""


def scenario_habits(s, tag):
    s.fresh()
    r = s.run(S23_HABITS, timeout=60)
    rd = r["rounds"]
    check(tag + " first two pastes: life on (normal default)", rd[0]["on"] and rd[1]["on"] and
          not rd[0]["learned"] and not rd[1]["learned"], rd)
    check(tag + " after turning it off twice: starts off, marked learned", not rd[2]["on"] and rd[2]["learned"], rd)
    h = r["habits"] or {}
    check(tag + " habit stored per trade stat", any(v.get("off", 0) >= 2 for v in h.values()), h)
    check(tag + " Forget learned filters: back to the default", r["afterForget"] is True, r["afterForget"])
    check(tag + " presets don't count as habits", r["afterPreset"] in ("{}", None), r["afterPreset"])


S24_DIVCARDS = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
window.__stubOverrides.div_cards = { ok: true, source: 'Path of Exile Wiki', divine: 200, priceHour: 1, areas: [
    { id: 'MapWorldsBurialChambers', name: 'Burial Chambers', lvl: 75, map: true },
    { id: 'MapWorldsColdRiver_', name: 'Cold River', lvl: 78, map: true },
    { id: 'Act3Docks', name: 'The Docks', lvl: 33, map: false }],
  cards: [
    { n: 'The Doctor', s: 8, a: [0], c: 1500, code: 'the-doctor' },
    { n: 'A Chilling Wind', s: 4, a: [1, 0], c: 6, code: 'a-chilling-wind' },
    { n: 'Rain of Chaos', s: 8, a: [0, 1, 2], c: 0.5, code: 'rain-of-chaos' },
    { n: 'Act Card', s: 3, a: [2], c: 40, code: 'act-card' },
    { n: 'Gone', s: 1, off: 1, c: 900 },
    { n: 'Unpriced', s: 5, a: [1] }] };
setView('divcards');
const sec = document.querySelector('.tab-section[data-tab="divcards"]');
await H.waitFor(() => sec.querySelector('.data-table tbody tr'), 4000, 'table');
out.visible = sec.getBoundingClientRect().height > 100;
out.calls = H.calls('div_cards').map(c => c.args[0]);
const rows = () => [...sec.querySelectorAll('.data-table tbody tr')].map(r => [...r.children].map(td => td.textContent.trim()));
out.byMap = rows();
sec.querySelector('.dc-controls input[type=checkbox]').click(); // include non-map areas
await H.sleep(20);
out.withActs = rows().map(r => r[0]);
H.button(sec, 'Burial Chambers ▸').click();
await H.sleep(20);
out.openTitle = H.text('.dc-list h3', sec);
out.openCards = [...sec.querySelectorAll('.dc-list tbody tr')].map(r => r.children[0].textContent);
sec.querySelector('.segmented [data-value="cards"]').click();
await H.sleep(20);
out.byCard = rows().map(r => [r[0], r[1], r[3], r[4]]);
const n0 = H.calls('open_url').length;
H.button(sec.querySelector('.data-table'), '↗').click();
await H.sleep(20);
out.url = decodeURIComponent((H.calls('open_url')[n0] || { args: [''] }).args[0]);
const f = sec.querySelector('input[aria-label="Filter cards or areas"]');
f.value = 'cold'; f.dispatchEvent(new Event('input'));
await H.sleep(20);
out.filtered = rows().map(r => r[0]);
delete window.__stubOverrides.div_cards;
return out;
"""


def scenario_divcards(s, tag):
    s.fresh()
    r = s.run(S24_DIVCARDS, timeout=60)
    check(tag + " Div cards view visible, loads once for the league", r["visible"] and len(r["calls"]) == 1, r["calls"])
    bm = r["byMap"]
    check(tag + " by area: maps only, ranked by best card, cards >= 5c counted", len(bm) == 2 and
          bm[0][0].startswith("Burial Chambers") and "The Doctor · 7.5 div" in bm[0][3] and bm[0][2] == "2 / 3" and
          bm[1][0].startswith("Cold River") and bm[1][2] == "1 / 2", bm)
    check(tag + " full set value = price x stack, in divines when 1+ div", bm[0][4] == "60 div (8)" and
          "6c" in bm[1][3], (bm[0][4], bm[1][3]))
    check(tag + " 'Maps only' off adds other areas", any(x.startswith("The Docks") for x in r["withActs"]), r["withActs"])
    check(tag + " opening an area lists its cards, best first", "Burial Chambers" in (r["openTitle"] or "") and
          r["openCards"] == ["The Doctor", "A Chilling Wind"], r["openCards"])
    bc = r["byCard"]
    check(tag + " by card: priced >= 5c, no longer dropping marked, best first",
          [x[0] for x in bc] == ["The Doctor", "Gone", "Act Card", "A Chilling Wind"] and
          bc[1][3] == "no longer drops" and "Burial Chambers" in bc[0][3], bc)
    check(tag + " card link opens the bulk exchange", "/trade/exchange/" in r["url"] and '"want":["the-doctor"]' in r["url"],
          r["url"][:160])
    check(tag + " filter by area name", r["filtered"] == ["A Chilling Wind"], r["filtered"])



S25_EMBED = r"""
const H = window.__e2e;
const out = {};
document.getElementById('settings-btn').click();
await H.sleep(30);
document.getElementById('open-trades').click();
await H.sleep(50);
const v = document.getElementById('view-trades');
out.view = document.body.dataset.view;
out.visible = v.getBoundingClientRect().height > 100 && getComputedStyle(document.getElementById('input-panel')).display === 'none';
out.tabs = [...v.querySelectorAll('.trades-tab')].map(b => b.textContent);
out.settingsClosed = document.getElementById('settings-panel').classList.contains('hidden');
out.status = H.calls('trade_status').length;
H.button(v, '← Back').click();
await H.sleep(30);
out.backTo = document.body.dataset.view;
out.landing = getComputedStyle(document.getElementById('input-panel')).display !== 'none';
await H.loadBuild();
setView('gems');
openTradesWindow();
await H.sleep(30);
out.inNav = [...document.querySelectorAll('#nav .nav-item')].some(b => b.dataset.view === 'trades');
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await H.sleep(30);
out.escBack = document.body.dataset.view;
out.extraWindows = typeof TRADES !== 'undefined' && TRADES;
return out;
"""


def scenario_trade_embed(s, tag):
    s.fresh()
    r = s.run(S25_EMBED, timeout=60)
    check(tag + " Trade helper opens as a view of the main window (no build needed)", r["view"] == "trades" and
          r["visible"] and r["tabs"] == ["Sales", "Buyers", "Setup"] and r["settingsClosed"], r)
    check(tag + " reads the log reader's state on open", r["status"] >= 1, r["status"])
    check(tag + " Back returns to the landing without a build", r["backTo"] == "" and r["landing"], r)
    check(tag + " with a build: in the sidebar, Esc returns to where you were", r["inNav"] and r["escBack"] == "gems", r)



S26_OVERGAME = r"""
const H = window.__e2e;
const out = {};
window.__appOverlay(true);
await H.sleep(20);
const bar = document.getElementById('over-game-bar');
out.bar = !!bar && document.body.classList.contains('over-game');
out.text = H.text('.over-game-grip');
H.button(bar, '+').click();
H.button(bar, '−').click();
await H.sleep(20);
out.size = H.calls('app_overlay_size').map(c => c.args[0]);
const g = bar.querySelector('.over-game-grip');
g.setPointerCapture = () => {};
g.dispatchEvent(new PointerEvent('pointerdown', { screenX: 10, screenY: 10, pointerId: 2, button: 0, bubbles: true }));
g.dispatchEvent(new PointerEvent('pointermove', { screenX: 60, screenY: 30, pointerId: 2, bubbles: true }));
await H.sleep(20);
g.dispatchEvent(new PointerEvent('pointerup', { screenX: 70, screenY: 40, pointerId: 2, bubbles: true }));
await H.sleep(20);
out.move = H.calls('app_overlay_move').map(c => c.args);
const cog = document.getElementById('pref-close-on-game');
out.cogDefault = cog.checked;
cog.click();
out.cogSaved = JSON.parse(localStorage.getItem('pobtf-prefs')).closeOnGameClick;
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await H.sleep(20);
out.esc = H.calls('app_overlay').map(c => c.args[0]);
window.__appOverlay(false);
out.barGone = !document.getElementById('over-game-bar');
return out;
"""


def scenario_overgame(s, tag):
    s.fresh()
    r = s.run(S26_OVERGAME, timeout=30)
    check(tag + " banner over the game says how to go back (incl. a click in the game)", r["bar"] and
          "click in the game" in (r["text"] or ""), r["text"])
    check(tag + " − / + resize through gui.py", r["size"] == [1, -1], r["size"])
    check(tag + " drag the banner to move", r["move"][:1] == [["start", 0, 0]] and r["move"][-1] == ["end", 60, 30], r["move"])
    check(tag + " 'click in the game puts it away' on by default and saved", r["cogDefault"] and r["cogSaved"] is False, r)
    check(tag + " Esc goes back, banner removed", r["esc"] == [False] and r["barGone"], r)


S27_TREE = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
out.inNav = !!document.querySelector('#nav .nav-item[data-view="tree"]');
document.querySelector('#nav .nav-item[data-view="tree"]').click();
await H.sleep(50);
const sec = document.querySelector('.tab-section[data-tab="tree"]');
const T = TREEVIEW;
out.view = document.body.dataset.view;
out.visible = H.visible(sec) && sec.getBoundingClientRect().height > 300;
out.nodes = build.tree.nodes.slice();
out.cls = build.className;
out.asc = build.ascendClass;
out.points = T.M.points;
out.ascPoints = T.M.ascPts[T.M.ascIdx];
out.pointsText = H.text('.tv-points', sec);
out.ascText = H.text('.tv-asc-points', sec);
out.insetName = T.I.D.ascendancies[T.insetAsc].name;
// canvases drawn: many distinct colours in a pixel sample
function colours(cv) {
  const c = cv.el, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, seen = new Set();
  for (let y = 0; y < c.height; y += 5) for (let x = 0; x < c.width; x += 5) {
    const i = (y * c.width + x) * 4; seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
  }
  return seen.size;
}
out.mainSize = [T.main.el.width, T.main.el.height];
out.mainColours = colours(T.main);
out.insetColours = T.inset ? colours(T.inset) : 0;
out.keystones = [...sec.querySelectorAll('.tv-keystones .tv-item-name')].map(e => e.textContent);
out.sockets = [...sec.querySelectorAll('.tv-sockets .tv-item-name')].map(e => e.textContent);
out.masteryRows = sec.querySelectorAll('.tv-masteries .tv-item').length;
// hover the Red Nightmare's socket: the tooltip names the jewel
const cv = T.main, sn = T.I.byId[26196];
cv.cx = sn.x; cv.cy = sn.y; cv.s = 0.3; treeDraw(cv);
const r = cv.el.getBoundingClientRect();
cv.el.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + cv.w / 2, clientY: r.top + cv.h / 2, pointerId: 1, bubbles: true }));
await H.sleep(20);
out.tip = T.tip.hidden ? '' : T.tip.textContent;
cv.el.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, bubbles: true }));
// wheel zooms in, Fit shows everything again
const s0 = cv.s;
cv.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: r.left + 50, clientY: r.top + 50, bubbles: true, cancelable: true }));
out.wheelZoomed = cv.s > s0;
H.button(sec.querySelector('.tv-zoom'), 'Fit').click();
out.fitScale = cv.s;
// search: highlights matches, count shown; Enter centres the first (allocated first)
const q = sec.querySelector('.tv-search');
q.value = 'golem'; q.dispatchEvent(new Event('input'));
await H.sleep(20);
out.hitCount = T.hitCount;
out.hitIds = T.hitList.slice();
out.countText = H.text('.tv-count', sec);
q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
out.centred = [cv.cx, cv.cy, T.I.byId[T.hitList[0]].x, T.I.byId[T.hitList[0]].y];
out.hitsAfterDraw = colours(T.main);
q.value = ''; q.dispatchEvent(new Event('input'));
out.clearedHits = T.hits === null && H.text('.tv-count', sec) === '';
// compare with a character: 4 build nodes missing (two chains of two), 2 extra, one other mastery effect
document.getElementById('acct-input').value = 'E2E#1234';
charName_ = 'TreeChar';
setView('tree'); // coming back to the view picks up the character chosen meanwhile
const drop = [36452, 46842, 13232, 9567];
const mm = build.tree.masteries[0];
const otherEffect = POE_TREE_VIEW.masteries[mm[0]].find(e => e !== mm[1]);
const masteries = {};
build.tree.masteries.forEach(m => { masteries[m[0]] = m[0] === mm[0] ? otherEffect : m[1]; });
window.__stubOverrides.get_character_passives = { ok: true,
  hashes: build.tree.nodes.filter(id => id < 65536 && drop.indexOf(id) < 0 && id !== 54447).concat([49534, 32075]),
  hashesEx: build.tree.nodes.filter(id => id >= 65536).slice(0, 5), masteries: masteries,
  jewels: [{ x: POE_TREE_VIEW.jewelSlots.indexOf(26196), name: 'My Jewel', base: 'Crimson Jewel', frameType: 2 }] };
out.btnLabel = H.text('.tv-compare-btn', sec);
sec.querySelector('.tv-compare-btn').click();
await H.waitFor(() => sec.querySelector('.tv-take-count'), 4000, 'comparison');
out.calls = H.calls('get_character_passives').map(c => c.args);
out.take = T.cmp.take;
out.refund = T.cmp.refund;
out.both = T.cmp.both;
out.chips = [H.text('.tv-take-count', sec), H.text('.tv-refund-count', sec), H.text('.tv-both-count', sec)];
out.steps = [...sec.querySelectorAll('.tv-take-list .tv-step')].map(e => e.textContent);
out.nowCount = sec.querySelectorAll('.tv-take-list .tv-step.now').length;
out.refundRows = [...sec.querySelectorAll('.tv-refund-list .tv-item-name')].map(e => e.textContent);
out.masteryChanges = T.cmp.masteryChanges.map(m => [m.node, m.from, m.to]);
out.expectChange = [mm[0], otherEffect, mm[1]];
out.charJewel = (T.cmp.jewels[26196] || {}).name;
out.clusterNote = /build 11, you 5/.test(sec.querySelector('.tv-compare').textContent);
out.legend = H.text('.tv-legend', sec);
out.statusTake = treeStatus(36452);
out.statusRefund = treeStatus(49534);
sec.querySelector('.tv-compare .segmented [data-value="build"]').click();
await H.sleep(20);
out.modeAfter = T.mode;
out.statusBuildMode = [treeStatus(36452), treeStatus(49534)];
delete window.__stubOverrides.get_character_passives;
return out;
"""


def scenario_tree(s, tag):
    s.fresh()
    r = s.run(S27_TREE, timeout=60)
    src = read("data/treeview.js")
    tv = json.loads(src[src.index("{"):src.rindex("}") + 1])
    kinds = {n[0]: (n[3], n[6] if len(n) > 6 else -1) for n in tv["nodes"]}
    asc_idx = next(i for i, a in enumerate(tv["ascendancies"]) if a["id"] == r["asc"])
    exp_points = sum(1 for i in r["nodes"] if i >= 65536 or (i in kinds and kinds[i][1] < 0 and kinds[i][0] != 5))
    exp_asc = sum(1 for i in r["nodes"] if i in kinds and kinds[i][1] == asc_idx and kinds[i][0] != 6)
    check(tag + " Skill tree in the Tools nav, view visible", r["inNav"] and r["view"] == "tree" and r["visible"], r["view"])
    check(tag + " passive points = build nodes minus class start and ascendancy", r["points"] == exp_points and
          r["pointsText"] == str(exp_points) and exp_points == 120, (r["points"], r["pointsText"], exp_points))
    check(tag + " ascendancy points (Elementalist, start node free)", r["ascPoints"] == exp_asc == 8 and r["ascText"] == "8" and
          r["insetName"] == "Elementalist", (r["ascPoints"], exp_asc, r["insetName"]))
    check(tag + " tree canvas drawn at device size (many colours)", r["mainSize"][0] > 300 and r["mainColours"] > 20,
          (r["mainSize"], r["mainColours"]))
    check(tag + " ascendancy inset drawn", r["insetColours"] > 5, r["insetColours"])
    check(tag + " side panel: keystones, sockets with jewels, masteries", sorted(r["keystones"]) == ["Bitter Frost", "Zealot's Oath"] and
          "Foulborn The Red Nightmare" in r["sockets"] and r["masteryRows"] == 12, (r["keystones"], r["sockets"], r["masteryRows"]))
    check(tag + " hover a socket: tooltip names the jewel", "Jewel socket" in r["tip"] and "Red Nightmare" in r["tip"], r["tip"][:120])
    check(tag + " wheel zooms, Fit zooms back out", r["wheelZoomed"] and r["fitScale"] < 0.1, r["fitScale"])
    exp_hits = [n[0] for n in tv["nodes"] if "golem" in (n[4] + "\n" + n[5]).lower() and
                (len(n) < 7 or n[6] < 0 or n[6] in (asc_idx,)) and not (len(n) > 7 and n[7] & 1)]
    check(tag + " search highlights every matching node, count shown", r["hitCount"] > 0 and
          sorted(r["hitIds"]) == sorted(set(r["hitIds"])) and set(exp_hits) <= set(r["hitIds"]) and
          r["countText"].startswith("%d match" % r["hitCount"]) and "allocated" in r["countText"],
          (r["hitCount"], len(exp_hits), r["countText"]))
    check(tag + " search: allocated matches first, Enter centres it", r["hitIds"][0] in r["nodes"] and
          r["centred"][0] == r["centred"][2] and r["centred"][1] == r["centred"][3], r["centred"])
    check(tag + " clearing the search removes the highlights", r["clearedHits"])
    check(tag + " compare: one bridge call with account + character", r["calls"] == [["E2E#1234", "TreeChar"]] and
          r["btnLabel"] == "Compare with TreeChar", (r["calls"], r["btnLabel"]))
    tk = r["take"]
    check(tag + " still to take: 4, refund: 2, in common: rest", len(tk) == 4 and sorted(r["refund"]) == [32075, 49534] and
          r["chips"] == ["4 still to take", "2 to refund", "%d in common" % r["both"]] and r["both"] == exp_points - 11 + exp_asc - 4,
          (tk, r["refund"], r["chips"], r["both"]))
    check(tag + " take order: reachable now first (step 1), then the notables behind them (step 2)",
          {t["id"] for t in tk[:2]} == {36452, 13232} and [t["step"] for t in tk] == [1, 1, 2, 2] and
          {t["id"] for t in tk[2:]} == {46842, 9567} and r["steps"] == ["1", "1", "2", "2"] and r["nowCount"] == 2, tk)
    check(tag + " refund list names the extra nodes", len(r["refundRows"]) == 2 and
          "Curse Cast Speed" in r["refundRows"], r["refundRows"])
    check(tag + " mastery with another effect listed as a change", r["masteryChanges"] == [r["expectChange"]], r["masteryChanges"])
    check(tag + " character jewels mapped to sockets; cluster passives counted", r["charJewel"] == "My Jewel" and r["clusterNote"],
          (r["charJewel"], r["clusterNote"]))
    check(tag + " compare colours + legend, 'Build only' switches back", r["statusTake"] == "take" and r["statusRefund"] == "refund" and
          "Still to take" in r["legend"] and r["modeAfter"] == "build" and r["statusBuildMode"] == ["alloc", None],
          (r["statusTake"], r["statusRefund"], r["legend"], r["statusBuildMode"]))


S28_STAGES = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
const full = build.tree;
const early = { title: 'Level 30', version: full.version, nodes: full.nodes.slice(0, 40), masteries: [], sockets: [] };
const staged = Object.assign({}, build, { treeSpecs: [early, full], treeActive: 1, tree: full });
const sec = document.querySelector('.tab-section[data-tab="tree"]');
sec.textContent = '';
sec.appendChild(makeTreeView(staged));
setView('tree');
await H.sleep(100);
const sel = () => sec.querySelector('select.tv-stage-select');
const pts = () => (sec.querySelector('.tv-side').textContent.match(/(\d+)\s*passive points/) || [])[1];
out.options = sel() ? [...sel().options].map(o => o.textContent) : null;
out.value = sel() && sel().value;
out.ptsFull = pts();
window.__stubOverrides.get_character_passives = { ok: true, hashes: full.nodes.filter(n => n < 65536).slice(0, 60), masteries: {} };
document.getElementById('acct-input').value = 'Me#1';
charName_ = 'MyChar';
setView('tree');
await H.sleep(50);
const btn = [...sec.querySelectorAll('button')].find(b => /Compare with/.test(b.textContent));
if (btn) btn.click();
await H.waitFor(() => /Compared with/.test(sec.textContent), 4000, 'compare');
out.callsBefore = H.calls('get_character_passives').length;
sel().value = '0';
sel().dispatchEvent(new Event('change'));
await H.sleep(150);
out.ptsEarly = pts();
out.valueAfter = sel() && sel().value;
out.callsAfter = H.calls('get_character_passives').length;
out.stillCompared = /Compared with/.test(sec.textContent);
delete window.__stubOverrides.get_character_passives;
return out;
"""


def scenario_stages(s, tag):
    s.fresh()
    r = s.run(S28_STAGES, timeout=60)
    o = r["options"] or []
    check(tag + " tree stages listed with titles, active one marked", len(o) == 2 and o[0].startswith("Level 30") and
          "(active in PoB)" in o[1] and r["value"] == "1", o)
    check(tag + " switching stage shows that tree", r["ptsEarly"] and r["ptsFull"] and
          int(r["ptsEarly"]) < int(r["ptsFull"]) and r["valueAfter"] == "0", (r["ptsEarly"], r["ptsFull"]))
    check(tag + " character compare kept across stages without asking the site again",
          r["stillCompared"] and r["callsAfter"] == r["callsBefore"] == 1, r)


S29_CHARDIFF = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
const ringState = cards.find(s => s.slot === 'Ring 1');
const jewelStates = cards.filter(s => /jewel/i.test(s.slot) && s.card);
out.haveRing = !!ringState; out.jewelCards = jewelStates.length;
const asChar = (it) => ({ name: it.rarity === 'UNIQUE' ? it.name : 'Some Name', base: it.base, frameType: 2, icon: '',
  ilvl: 84, corrupted: false, implicitMods: [], explicitMods: it.mods.filter(m => m.kind !== 'implicit').map(m => m.line),
  craftedMods: [], fracturedMods: [], enchantMods: [] });
const ringItem = ringState.item;
window.__stubOverrides.get_character_items = { ok: true, items: [Object.assign(asChar(ringItem), { inventoryId: 'Ring2', x: 0 })] };
const j0 = jewelStates[0].item;
window.__stubOverrides.get_character_passives = { ok: true, hashes: [], hashesEx: [], masteries: {},
  jewels: [Object.assign(asChar(j0), { x: 17 })] };
document.getElementById('acct-input').value = 'Me#1';
const sel = document.getElementById('char-select');
const o = document.createElement('option'); o.value = 'MyChar'; o.textContent = 'MyChar'; sel.appendChild(o); sel.value = 'MyChar';
document.getElementById('char-compare').click();
await H.waitFor(() => /comparing against/.test(H.text('#char-status') || ''), 4000, 'compare');
out.calls = [H.calls('get_character_items').length, H.calls('get_character_passives').length];
const diffText = st => (st.card.querySelector('.char-diff') || {}).textContent || '';
out.ring = { cls: ['diff-matched', 'diff-close', 'diff-missing'].filter(c => ringState.card.classList.contains(c))[0], text: diffText(ringState) };
out.jewel0 = { cls: ['diff-matched', 'diff-close', 'diff-missing'].filter(c => jewelStates[0].card.classList.contains(c))[0], text: diffText(jewelStates[0]) };
out.others = jewelStates.slice(1).map(s => diffText(s));
out.reuse = typeof charPassives_ !== 'undefined' && charPassives_ && charPassives_.name;
delete window.__stubOverrides.get_character_items;
delete window.__stubOverrides.get_character_passives;
return out;
"""


def scenario_chardiff(s, tag):
    s.fresh()
    r = s.run(S29_CHARDIFF, timeout=60)
    check(tag + " one Compare click reads gear and tree jewels", r["calls"] == [1, 1], r["calls"])
    check(tag + " ring worn in the other slot still counts", r["haveRing"] and r["ring"]["cls"] in ("diff-matched", "diff-close")
          and "your Ring 2" in r["ring"]["text"], r["ring"])
    check(tag + " jewel matched in any tree socket", r["jewelCards"] >= 1 and r["jewel0"]["cls"] in ("diff-matched", "diff-close")
          and "in your tree" in r["jewel0"]["text"], r["jewel0"])
    check(tag + " one tree jewel can't fill two cards", all("in your tree" not in t or "Some Name" not in t
          for t in r["others"]) or len(r["others"]) == 0, r["others"])
    check(tag + " Skill tree compare reuses the passives already read", r["reuse"] == "MyChar", r["reuse"])


S30_TESTCARDS = r"""
const H = window.__e2e;
const out = {};
const card = name => [...document.querySelectorAll('.trade-card')].find(c => c.querySelector('.tc-name').textContent === name);
// helper OFF: real whispers are ignored (the reader may run only for the cheat sheet), test ones show
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ enabled: false, ack: true, sound: 'off' }));
await window.__tradePrefsChanged();
out.realIgnored = window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'RealBuyer', text: 'Hi, I would like to buy your x in Standard',
  trade: { kind: 'item', item: 'x', price: 1, currency: 'chaos', league: 'Standard' } }) === false;
const T = { kind: 'item', item: 'Tabula Rasa Simple Robe', price: 10, currency: 'chaos', league: 'Standard', tab: 'Test sale', left: 3, top: 5, note: '' };
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'PoBTF_TestBuyer', text: 'Hi', trade: T, test: true });
await H.sleep(30);
let c = card('PoBTF_TestBuyer');
out.shown = !!c && !card('RealBuyer');
out.tag = c && H.text('.tc-test', c);
H.button(c, 'Invite').click();
await H.sleep(30);
out.sendsAfterInvite = H.calls('trade_send').length;
out.invitedMarked = !!card('PoBTF_TestBuyer');
window.__tradeEvent({ type: 'joined', name: 'PoBTF_TestBuyer', test: true });
window.__tradeEvent({ type: 'trade_accepted', test: true });
await H.sleep(30);
c = card('PoBTF_TestBuyer');
const done = [...c.querySelectorAll('.btn')].find(b => b.textContent.startsWith('✓ Completed'));
out.hasCompleted = !!done;
const setsBefore = H.calls('storage_set').filter(x => x.args[0] === 'pobtf-buyers').length;
if (done) done.click();
await H.sleep(60);
out.closed = !card('PoBTF_TestBuyer');
out.sales = JSON.parse(localStorage.getItem('pobtf-sales') || '[]').length;
out.buyerWrites = H.calls('storage_set').filter(x => x.args[0] === 'pobtf-buyers').length - setsBefore;
// Clear test cards
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'PoBTF_TestBuyer', text: 'Hi', trade: T, test: true });
window.__tradeEvent({ type: 'whisper', dir: 'out', name: 'PoBTF_TestSeller', text: 'Hi', trade: T, test: true });
await H.sleep(30);
out.beforeClear = document.querySelectorAll('.trade-card').length;
window.__tradeEvent({ type: 'clear_tests', test: true });
await H.sleep(30);
out.afterClear = document.querySelectorAll('.trade-card').length;
return out;
"""

S30_SETUP = r"""
const H = window.__e2e;
const out = {};
H.button(document, 'Setup').click();
await H.sleep(40);
const row = document.querySelector('.trade-test-row');
out.buttons = row ? [...row.querySelectorAll('.btn')].map(b => b.textContent) : [];
H.button(row, '▶ Whole trade').click();
await H.sleep(30);
H.button(row, 'Clear test cards').click();
await H.sleep(30);
out.calls = H.calls('trade_test').map(c => c.args[0]);
out.sends = H.calls('trade_send').length;
return out;
"""

S30_SHEET = r"""
const H = window.__e2e;
const out = {};
out.page = document.body.classList.contains('sheet-ov') && !!document.getElementById('sheet-root');
out.hiddenFirst = (H.calls('overlay_visible')[0] || { args: [] }).args.slice(0, 2);
window.__sheetToggle();
await H.sleep(30);
out.title = H.text('.sheet-title');
// a real area line is ignored until "follow my act" is on; test-mode ones always count
out.realIgnored = window.__sheetEvent({ type: 'area', act: 6, id: '2_6_town', level: 45 }) === false;
window.__sheetEvent({ type: 'area', act: 6, id: '2_6_town', level: 45, test: true });
window.__sheetEvent({ type: 'zone', area: 'The Prison', test: true });
await H.sleep(30);
out.titleAfter = H.text('.sheet-title');
out.here = H.text('.sheet-li.is-here');
out.text = H.text('.sheet-content');
out.shapes = (H.calls('overlay_shape').slice(-1)[0] || { args: [] }).args;
return out;
"""

S30_VIEW = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(40);
out.view = document.body.dataset.view;
out.act1 = H.text('#view-sheets .sheet-content');
H.button(document, '+ New sheet').click();
await H.sleep(30);
const ed = document.querySelector('.sheet-editor');
ed.querySelector('.sheet-title-input').value = 'My route';
ed.querySelector('select').value = '2';
ed.querySelector('.sheet-textarea').value = 'Kill Hillock';
H.button(ed, '🖼 Add picture…').click();
await H.sleep(40);
H.button(document.querySelector('.sheet-editor'), 'Save').click();
await H.sleep(40);
out.saved = JSON.parse(localStorage.getItem('pobtf-sheets') || '[]');
out.preview = H.text('#view-sheets .sheet-content');
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-sheets');
out.followConsent = null;
return out;
"""


def scenario_testmode(s, tag):
    s.fresh("?cards=1")
    r = s.run(S30_TESTCARDS, timeout=60)
    check(tag + " helper off: real whispers ignored, test ones shown", r["realIgnored"] and r["shown"], r)
    check(tag + " test card is marked TEST", (r["tag"] or "").lower() == "test", r["tag"])
    check(tag + " test card buttons send nothing to the game", r["sendsAfterInvite"] == 0 and r["invitedMarked"], r)
    check(tag + " closing a test trade saves no sale and no buyer", r["hasCompleted"] and r["closed"] and
          r["sales"] == 0 and r["buyerWrites"] == 0, r)
    check(tag + " Clear test cards removes them", r["beforeClear"] == 2 and r["afterClear"] == 0, r)
    s.fresh("?trades=1")
    r = s.run(S30_SETUP, timeout=60)
    check(tag + " Setup → Test mode buttons", r["buttons"][:3] == ["▶ Whole trade", "Buyer whispers", "Bulk whisper"]
          and "Clear test cards" in r["buttons"], r["buttons"])
    check(tag + " test buttons ask gui.py for made-up events, nothing sent", r["calls"] == ["full", "clear"] and
          r["sends"] == 0, r)


def scenario_sheets(s, tag):
    s.fresh("?sheet=1")
    r = s.run(S30_SHEET, timeout=60)
    check(tag + " sheet overlay page, hidden until its hotkey", r["page"] and r["hiddenFirst"] == ["sheet", False], r)
    check(tag + " hotkey shows Act 1", (r["title"] or "").startswith("Act 1"), r["title"])
    check(tag + " area lines only count with follow on (test ones always)", r["realIgnored"] and
          (r["titleAfter"] or "").startswith("Act 6"), r)
    check(tag + " Act 6: quests, respec, trial you're in", "The Cloven One" in (r["text"] or "") and
          "Fallen from Grace" in r["text"] and "The Prison" in (r["here"] or ""), r["here"])
    check(tag + " window clipped to the sheet", len(r["shapes"]) == 2 and r["shapes"][0] == "sheet" and
          len(r["shapes"][1]) == 1, r["shapes"])
    s.fresh()
    r = s.run(S30_VIEW, timeout=60)
    check(tag + " Settings → Cheat sheets opens the view with Act 1", r["view"] == "sheets" and
          "The Dweller of the Deep" in (r["act1"] or "") and "A Dirty Job" in r["act1"], r["act1"])
    sv = (r["saved"] or [{}])[0]
    check(tag + " your sheet saved (title, act, text, picture) and shared with the overlay", sv.get("title") == "My route"
          and sv.get("act") == 2 and sv.get("text") == "Kill Hillock" and sv.get("images") == ["data/cheatsheets/e2e.png"]
          and r["persisted"], sv)
    check(tag + " preview turns to the sheet's act and shows it", "Kill Hillock" in (r["preview"] or "") and
          "Through Sacred Ground" in r["preview"], r["preview"])


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
    ("19 trades", scenario_trades),
    ("20 ovicon", scenario_overlay_icon),
    ("21 uniques", scenario_uniques),
    ("22 search", scenario_search),
    ("23 habits", scenario_habits),
    ("24 divcards", scenario_divcards),
    ("25 tradeview", scenario_trade_embed),
    ("26 overgame", scenario_overgame),
    ("27 tree", scenario_tree),
    ("28 stages", scenario_stages),
    ("29 chardiff", scenario_chardiff),
    ("30 testmode", scenario_testmode),
    ("31 sheets", scenario_sheets),
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
