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
import urllib.parse
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
  // a scenario can pre-fill the bridge's storage (what the app saved last time): ?e2eStore=<json>
  try { var seed = new URLSearchParams(location.search).get('e2eStore'); if (seed) store = JSON.parse(seed); } catch (e) { /* none */ }
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
    unique_prices: function () { return { ok: true, divine: D.rates.divine, items: [] }; },  // dust explorer
    beast_prices: function () { return { ok: true, divine: D.rates.divine, items: [] }; },   // search text: beasts
    // loot filter: no filter files unless a scenario provides some
    filter_list: function () { return { ok: true, dir: 'C:\\Users\\me\\Documents\\My Games\\Path of Exile', exists: true, filters: [] }; },
    filter_read: function () { return { ok: false, error: 'stub: no filter' }; },
    filter_write: function () { return { ok: true, mtime: 1, checkpoint: null }; },
    filter_checkpoints: function () { return { ok: true, checkpoints: [] }; },
    filter_restore: function () { return { ok: false, error: 'stub' }; },
    filter_checkpoint: function () { return { ok: true, id: null, created: false }; },
    filter_reload: function () { return { ok: true }; },
    filter_switch: function () { return { ok: true }; },
    filter_online_status: function () { return { ok: true, imported: false }; },
    filter_online_list: function () { return { ok: true, filters: [] }; },
    filter_online_read: function () { return { ok: false, error: 'stub: no online filter' }; },
    filter_online_mark: function () { return { ok: true }; },
    filter_online_import: function () { return { ok: false, error: 'stub' }; },
    filter_asset: function () { return { ok: false, error: 'stub: offline' }; },
    filter_sound_list: function () { return { ok: true, files: [] }; },
    div_cards: function () { return { ok: true, cards: [], areas: [] }; },
    filter_sound_file: function () { return { ok: false, error: 'stub' }; },
    filter_open_folder: function () { return { ok: true }; },
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
    price_overlay_move: function () { return { ok: true }; },
    chat_macro: function () { return { ok: true }; },
    set_macros: function (j) { return { ok: true, macros: JSON.parse(j), errors: [] }; },
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
    cheatsheets_data: function () { return { ok: false, error: 'offline (e2e)' }; },
    guides_data: function () { return { ok: false, error: 'offline (e2e)' }; },
    overlay_sheet_open: function () { return { ok: true }; },
    anoint_oils: function () {  // every oil 2c, Golden 40c; divine 200c
      var o = {};
      ['Clear', 'Sepia', 'Amber', 'Verdant', 'Teal', 'Azure', 'Indigo', 'Violet', 'Crimson', 'Black', 'Opalescent',
       'Silver', 'Golden', 'Prismatic', 'Tainted', 'Reflective'].forEach(function (n) {
        o[n + ' Oil'] = { img: null, chaos: n === 'Golden' ? 40 : 2 };
      });
      return { ok: true, oils: o, divine: 200, hour: 1 };
    },
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
// ☆ Save asks for a name (prefilled): confirm it
const saveDlg = document.querySelector('dialog[open]');
if (saveDlg) H.button(saveDlg, 'Save').click();
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
  where: H.text('.tc-where', c), note: H.text('.tc-note', c), inputs: c.querySelectorAll('input, select').length,
  dir: H.text('.tc-dir', c), status: H.text('.tc-status', c), theme: document.documentElement.dataset.theme || 'dark' };
out.sendsAfterWhisper = sends().length;
H.button(c, 'Invite').click();
await H.sleep(30);
out.invitedStatus = H.text('.tc-status', card('BuyerOne'));
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
out.joined = { here: H.text('.tc-status', c) === 'In your hideout' && c.dataset.status === 'success',
  actions: [...c.querySelectorAll('.tc-actions > .btn')].map(b => b.textContent),
  outcomes: [...c.querySelectorAll('.tc-outcomes .tc-other .btn')].map(b => b.textContent),
  headLines: Math.round(c.querySelector('.tc-head').getBoundingClientRect().height / 20) };
window.__tradeEvent({ type: 'trade_accepted' });
await H.sleep(20);
out.acceptedStatus = H.text('.tc-status', card('BuyerOne'));
c = card('BuyerOne');
out.suggested = c.querySelector('.tc-outcomes .btn.suggested') ? c.querySelector('.tc-outcomes .btn.suggested').textContent : null;
out.sendsAfterEvents = sends().length;
// "Sold for": − / + in price-sized steps, chaos ⇄ div at the current rate, Reset; no typing
const soldStep = async (label) => { card('BuyerOne').querySelector('.tc-sold [aria-label="' + label + '"]').click(); await H.sleep(20); };
const soldNow = () => [H.text('.tc-sold-price', card('BuyerOne')), (H.text('.tc-outcomes .btn.suggested', card('BuyerOne')) || '')];
await soldStep('Raise the price you got'); out.soldUp = soldNow();
await soldStep('Lower the price you got'); await soldStep('Lower the price you got'); out.soldDown = soldNow();
out.soldListed = H.text('.tc-sold-listed', card('BuyerOne'));
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 200, divine: 1 };
tradeRates = {};
H.button(card('BuyerOne'), 'Reset').click(); await H.sleep(20);
H.button(card('BuyerOne'), 'in c').click(); await H.waitFor(() => /c$/.test(H.text('.tc-sold-price', card('BuyerOne')) || ''), 2000, 'swap');
out.soldChaos = soldNow();
H.button(card('BuyerOne'), 'Reset').click(); await H.sleep(20);
out.soldReset = [soldNow()[0], !card('BuyerOne').querySelector('.tc-sold-listed'), card('BuyerOne').querySelectorAll('input').length];
out.sendsAfterSold = sends().length;
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
H.button(document.querySelector('.trades-tabs'), 'Trades').click();
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
H.button(document.querySelector('.trades-tabs'), 'People').click();
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
    check(tag + " card status in words: Waiting → Invited → In your hideout → Trade accepted",
          [r["newCard"]["status"], r["invitedStatus"], r["acceptedStatus"]] == ["Waiting", "Invited", "Trade accepted"] and
          r["newCard"]["dir"] == "Selling to", (r["newCard"], r["invitedStatus"], r["acceptedStatus"]))
    check(tag + " card header stays on one line", r["joined"]["headLines"] <= 2, r["joined"])
    check(tag + " in-game cards stay dark", r["newCard"]["theme"] == "dark", r["newCard"]["theme"])
    check(tag + " buyer joined: badge, Trade · Kick · Thanks, outcomes", r["joined"]["here"] and
          r["joined"]["actions"][:3] == ["Trade", "Kick", "Thanks"] and
          r["joined"]["outcomes"][0].startswith("✓ Completed") and "⌛ Time wasted" in r["joined"]["outcomes"], r["joined"])
    check(tag + " Sold for: + / − step 0.5 div and Completed follows", r["soldUp"] == ["2.5 div", "✓ Completed · 2.5 div"]
          and r["soldDown"] == ["1.5 div", "✓ Completed · 1.5 div"] and r["soldListed"] == "listed 2 div",
          (r["soldUp"], r["soldDown"], r["soldListed"]))
    check(tag + " Sold for: in c converts at the rate (2 div × 200c)", r["soldChaos"] == ["400 c", "✓ Completed · 400 c"], r["soldChaos"])
    check(tag + " Sold for: Reset goes back to the listed price; no inputs, nothing sent",
          r["soldReset"] == ["2 div", True, 0] and r["sendsAfterSold"] == r["sendsAfterEvents"], (r["soldReset"], r["sendsAfterSold"]))
    check(tag + " Trade accepted highlights Completed (listed price), sends nothing",
          (r["suggested"] or "").startswith("✓ Completed · 2 div") and r["sendsAfterEvents"] == 3, r)
    sale = (r["sales"] or [{}])[0]
    check(tag + " sale recorded at the listed price", sale.get("outcome") == "completed" and sale.get("price") == 2 and
          sale.get("currency") == "divine" and sale.get("chaos") == 400 and sale.get("buyer") == "BuyerOne", sale)
    b = (r["buyers"] or {}).get("buyerone") or {}
    check(tag + " buyer reputation counts the sale", b.get("completed") == 1 and b.get("spent") == 400, b)
    check(tag + " repeat buyer gets a badge", "1 bought" in (r["badge"] or ""), r["badge"])
    check(tag + " no-show after the set minutes", r["noShow"] == 1, r["noShow"])
    check(tag + " outgoing card: Visit hideout · Trade · Re-whisper · ⋯",
          r["outActions"] == ["Visit hideout", "Trade", "Re-whisper", "⋯"], r["outActions"])
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
    check(tag + " helper window: Trades · People · Reports · Setup, opens on Trades",
          r["tabs"] == ["Trades", "People", "Reports", "Setup"] and r["firstTab"] == "Trades", r["tabs"])
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
    check(tag + " totals + chart", any(t.replace(" ", "").startswith("Earned410") for t in r["tiles"]) and
          any(t.replace(" ", "").startswith("Trades2") for t in r["tiles"]) and r["chart"], r["tiles"])
    e = r["edited"] or {}
    check(tag + " Edit sale: new price re-valued, note kept", e.get("price") == 1.5 and e.get("chaos") == 300 and
          e.get("note") == "haggled", e)
    check(tag + " CSV export: header + formula-safe cells", (r["csv"] or "").startswith("time,side,outcome,league,item") and
          "'=HYPERLINK" in r["csv"], (r["csv"] or "")[:200])
    check(tag + " People page lists them", r["buyerRows"] >= 1, r["buyerRows"])
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
    check(tag + " extra buttons only on hover (trade helper, cheat sheet, app, settings)", len(r["hoverButtons"]) == 4 and
          "cheat sheet" in (r["hoverButtons"][1] or ""), r["hoverButtons"])
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
    want = '"!%s|%s" "%s" "m q.*([6-9]\d|\d{3})%%"' % (t["regen"], t["vuln"], t["pen"])
    check(tag + " avoid + want + quantity build one search string", r["text"] == want, (r["text"], want))
    check(tag + " length shown against the 250 limit", r["count"] == "%d / 250" % len(want), r["count"])
    check(tag + " filter narrows the list", 0 < r["filtered"] < 15, r["filtered"])
    check(tag + " Copy puts it on the clipboard", r["clip"] == want, r["clip"])
    check(tag + " Paste into game sends that text (one press)", r["paste"] == want, r["paste"])
    check(tag + " presets save and load", r["cleared"] == "" and r["loaded"] == want, (r["cleared"], r["loaded"]))
    check(tag + " own words: any / none", r["anyWords"] == '"movement speed|r-g-b"' and
          r["noneWords"] == '"!movement speed|r-g-b"', (r["anyWords"], r["noneWords"]))


S46_REGEX = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
const D = await ensureSearchData();
const SC = D.scarabs.slice(0, 3);
// prices: three scarabs (cx feed), three beasts, three uniques on two bases
const cx = { divine: { name: 'Divine Orb', cat: 'Currency', img: '', s: [[1, 200, 100]] } };
SC.forEach((s, i) => { cx['sc' + i] = { name: s.n, cat: 'Fragments, Scarabs & Mapping', img: '', s: [[1, [40, 15, 2][i], 50]] }; });
window.__stubOverrides.cx_overview = { ok: true, hour: 1, items: cx };
window.__stubOverrides.beast_prices = { ok: true, divine: 200, items: [['Vivid Vulture', 60, 20], ['Wild Bristle Matron', 30, 15],
  ['Fenumal Plagued Arachnid', 2, 30]] };
const belt = D.gwennen.find(b => b.n === 'Leather Belt'), heavy = D.gwennen.find(b => b.n === 'Heavy Belt');
window.__stubOverrides.unique_prices = { ok: true, divine: 200, items: [['Headhunter', 'Leather Belt', 8000, 40, 'UniqueAccessory'],
  ['Mageblood', 'Heavy Belt', 30000, 50, 'UniqueAccessory'], ['Goldrim', 'Leather Cap', 1, 100, 'UniqueArmour']] };
setView('search');
await H.sleep(30);
const sec = document.querySelector('.tab-section[data-tab="search"]');
const text = () => sec.querySelector('.st-text').value;
const tab = async id => { sec.querySelector('.st-tabs [data-value="' + id + '"]').click(); await H.sleep(40); };
const num = (label, v) => { const i = sec.querySelector('input[aria-label="' + label + '"]'); i.value = v; i.dispatchEvent(new Event('input')); };
out.tabs = [...sec.querySelectorAll('.st-tabs [data-value]')].map(b => b.textContent);
// vendor: 4 linked + R-G-B in any order + boots
await tab('vendor');
[...sec.querySelectorAll('label.toggle')].find(l => l.textContent === '4 linked').querySelector('input').click();
H.button(sec, 'Chromatic recipe (R-G-B)').click(); await H.sleep(10);
[...sec.querySelectorAll('label.toggle')].find(l => l.textContent === 'Boots').querySelector('input').click();
await H.sleep(10);
out.vendor = text();
// scarabs: price from 10 -> the two dearer ones
await tab('scarabs');
await H.waitFor(() => /Prices for/.test(H.text('.st-status', sec)), 4000, 'scarab prices');
num('Lowest price in chaos', '10'); await H.sleep(10);
H.button(sec, 'Pick the dearest in range').click(); await H.sleep(20);
out.scarabs = text();
out.scarabToks = SC.map(s => s.t || ('^' + s.n.toLowerCase() + '$'));
out.scarabChips = [...sec.querySelectorAll('.st-mod .badge')].map(b => b.textContent);
// beasts: tokens made here, unique among the priced beasts
await tab('beasts');
await H.waitFor(() => sec.querySelectorAll('.st-mod').length === 3, 4000, 'beasts');
num('Lowest price in chaos', '20'); await H.sleep(10);
H.button(sec, 'Pick the dearest in range').click(); await H.sleep(20);
out.beasts = text();
// Gwennen: bases priced by their dearest unique
await tab('gwennen');
await H.waitFor(() => sec.querySelectorAll('.st-mod').length >= 2, 4000, 'gwennen');
out.gwennenRows = [...sec.querySelectorAll('.st-mod .st-mod-text')].map(e => e.textContent);
num('Lowest price in chaos', '1000'); await H.sleep(10);
H.button(sec, 'Pick the dearest in range').click(); await H.sleep(20);
out.gwennen = text();
out.beltToks = [belt && belt.t, heavy && heavy.t];
// gems: the build's gems + level 20
await tab('gems');
await H.waitFor(() => sec.querySelectorAll('.st-mod').length > 50, 4000, 'gems');
H.button(sec, "Add my build's gems").click(); await H.sleep(20);
num('Minimum gem level', '20'); await H.sleep(10);
out.gems = text();
// heist: Gianna preset
await tab('heist');
await H.waitFor(() => H.button(sec, 'Gianna (Deception, Perception, Counter-Thaumaturgy)'), 4000, 'heist');
H.button(sec, 'Gianna (Deception, Perception, Counter-Thaumaturgy)').click(); await H.sleep(30);
out.heist = text();
// items: rings, life 70+ (rare), then magic names
await tab('items');
await H.waitFor(() => sec.querySelector('select[aria-label="Base group"]'), 6000, 'item mods');
const gs = sec.querySelector('select[aria-label="Base group"]');
const ring = [...gs.options].find(o => o.textContent === 'Ring') || [...gs.options].find(o => /ring/i.test(o.textContent));
gs.value = ring.value; gs.dispatchEvent(new Event('change')); await H.sleep(30);
const lifeRow = () => [...sec.querySelectorAll('.st-mod')].find(r => /to maximum Life$/.test(r.querySelector('.st-mod-text').firstChild.textContent));
out.ring = ring.textContent;
const lr = lifeRow();
out.lifeFound = !!lr;
if (lr) { const mn = lr.querySelector('input[type=number]'); mn.value = '70'; mn.dispatchEvent(new Event('input')); await H.sleep(10); }
out.itemsRare = text();
sec.querySelector('.segmented[aria-label="Rarity"] [data-value="magic"]').click(); await H.sleep(30);
out.itemsMagic = text();
// the result box: limit, custom text
out.count = H.text('.st-result .badge', sec);
return out;
"""


def scenario_regex(s, tag):
    s.fresh()
    r = s.run(S46_REGEX, timeout=90)
    check(tag + " every poe.re-style tab is there", r["tabs"] == ["Maps", "Vendor", "Items", "Flasks", "Gems", "Scarabs", "Tattoos",
          "Beasts", "Gwennen", "Heist", "Your own words"], r["tabs"])
    check(tag + " vendor: 4 linked or R-G-B, on boots", r["vendor"].startswith('"ts:.*(\\w-){3}\\w|ts:.*(') and
          'r-g-b' in r["vendor"] and r["vendor"].endswith('"ss: (boots)"'), r["vendor"])
    t = r["scarabToks"]
    check(tag + " scarabs: the two in range, dearest first", r["scarabs"] == '"%s|%s"' % (t[0], t[1]), (r["scarabs"], t))
    check(tag + " scarab prices shown", "40c" in r["scarabChips"] and "15c" in r["scarabChips"], r["scarabChips"])
    b = r["beasts"].strip('"').split("|")
    check(tag + " beasts: the two dear ones, each a unique piece of its name", len(b) == 2 and
          b[0] in "vivid vulture" and b[1] in "wild bristle matron" and b[0] not in "wild bristle matron", r["beasts"])
    check(tag + " Gwennen: only priced bases, dearest first", r["gwennenRows"][:2] == ["Heavy Belt", "Leather Belt"] or
          [x.split("best")[0] for x in r["gwennenRows"][:2]] == ["Heavy Belt", "Leather Belt"], r["gwennenRows"])
    check(tag + " Gwennen: bases with a unique worth 1000c+", r["gwennen"] == '"%s|%s"' % (r["beltToks"][1], r["beltToks"][0]),
          (r["gwennen"], r["beltToks"]))
    check(tag + " gems: the build's gems and level 20+", r["gems"].count("|") >= 2 and
          r["gems"].endswith('"level: ([2-9]\\d|\\d{3})"'), r["gems"])
    check(tag + " heist: Gianna's jobs with levels", r["heist"].startswith('"') and ".*[1-2]" in r["heist"] and
          ".*[1-3]" in r["heist"] and r["heist"].count("|") == 2, r["heist"])
    check(tag + " items: ring life 70+ as the rolled value", r["lifeFound"] and
          r["itemsRare"].startswith('"([7-9]\\d|\\d{3})\\(.*') , (r["ring"], r["itemsRare"]))
    check(tag + " items: magic picks the affix names", r["itemsMagic"].startswith('"^(') and r["itemsMagic"].endswith(') "'),
          r["itemsMagic"])
    check(tag + " limit shown as 250", r["count"].endswith("/ 250"), r["count"])


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
    { n: 'The Doctor', s: 8, a: [0], c: 1500, code: 'the-doctor', i: 'TheDoctor', r: [[['Headhunter', 'unique']]],
      f: 'They said I needed my head examined,\nbut I would rather just take yours.' },
    { n: 'A Chilling Wind', s: 4, a: [1, 0], c: 6, code: 'a-chilling-wind', i: 'AChillingWind' },
    { n: 'Rain of Chaos', s: 8, a: [0, 1, 2], c: 0.5, code: 'rain-of-chaos' },
    { n: 'Act Card', s: 3, a: [2], c: 40, code: 'act-card' },
    { n: 'Gone', s: 1, off: 1, c: 900 },
    { n: 'Unpriced', s: 5, a: [1] }] };
// card art: The Doctor's is in the art cache (a data: PNG); A Chilling Wind's must come from
// the CDN, which the e2e browser can't reach, so it fails like missing art would
const DC = 'https://web.poecdn.com/image/divination-card/';
const pc = document.createElement('canvas'); pc.width = 39; pc.height = 28;
pc.getContext('2d').fillRect(0, 0, 39, 28);
ART[DC + 'TheDoctor.png'] = pc.toDataURL('image/png');
setView('divcards');
const sec = document.querySelector('.tab-section[data-tab="divcards"]');
await H.waitFor(() => sec.querySelector('.data-table tbody tr') && H.calls('div_cards').length >= 2, 4000, 'table');
await H.sleep(20);
out.visible = sec.getBoundingClientRect().height > 100;
out.calls = H.calls('div_cards').map(c => c.args);
const rows = () => [...sec.querySelectorAll('.data-table tbody tr')].map(r => [...r.children].map(td => td.textContent.trim()));
out.byMap = rows();
// value per 1,000 drops from the community weights, recomputed here the long way:
// weight / (pool + weights of the cards that can drop there at level 83) x price x 1000
const W = window.POE_DIV_WEIGHTS, fixture = window.__stubOverrides.div_cards;
const evOf = (ai, lvl) => {
  const here = fixture.cards.filter(c => !c.off && (c.a || []).includes(ai) && W.cards[c.n] && lvl >= W.cards[c.n][1]);
  const denom = W.pool + here.reduce((s, c) => s + W.cards[c.n][0], 0);
  return here.reduce((s, c) => s + (c.c || 0) * W.cards[c.n][0] / denom * 1000, 0);
};
out.ev = { head: [...sec.querySelectorAll('.data-table thead th')].map(t => t.textContent).pop(),
  shown: out.byMap.map(r => r[6]), expect: [dcFmt(evOf(0, 83)), dcFmt(evOf(1, 83))],
  note: H.text('.dc-note', sec), weights: !!W && W.pool > 1e6 && Object.keys(W.cards).length > 250 };
const vs = [...sec.querySelectorAll('.dc-controls .toggle')].find(t => t.textContent.includes('voidstones')).querySelector('input');
vs.click(); await H.sleep(20);
out.evListed = rows().map(r => r[6]);
out.expectListed = [dcFmt(evOf(0, 75)), dcFmt(evOf(1, 78))];
vs.click(); await H.sleep(20);
sec.querySelector('.dc-controls input[type=checkbox]').click(); // include non-map areas
await H.sleep(20);
out.withActs = rows().map(r => r[0]);
H.button(sec, 'Burial Chambers ▸').click();
await H.sleep(20);
out.openTitle = H.text('.dc-list h3', sec);
out.openCards = [...sec.querySelectorAll('.dc-list tbody tr')].map(r => r.children[0].textContent);
out.openOdds = [...sec.querySelectorAll('.dc-list tbody tr')].map(r => r.children[6].textContent);
out.openSum = H.text('.dc-list p', sec);
sec.querySelector('.segmented [data-value="cards"]').click();
await H.sleep(20);
out.byCard = rows().map(r => [r[0], r[1], r[3], r[4]]);
const cardRow = name => [...sec.querySelectorAll('.data-table tbody tr')].find(r => r.children[0].textContent.trim() === name);
const docImg = cardRow('The Doctor').querySelector('.dc-art img');
const windImg = cardRow('A Chilling Wind').querySelector('.dc-art img');
await H.waitFor(() => docImg && docImg.classList.contains('ok'), 3000, 'cached art loaded').catch(() => {});
await H.waitFor(() => windImg && windImg.getAttribute('src') && windImg.complete, 3000, 'CDN art failed').catch(() => {});
out.docArt = docImg && { remote: docImg.dataset.remote, local: (docImg.getAttribute('src') || '').slice(0, 15),
  ok: docImg.classList.contains('ok'), w: docImg.naturalWidth, vis: getComputedStyle(docImg).visibility };
out.windArt = windImg && { src: windImg.getAttribute('src'), ok: windImg.classList.contains('ok'),
  vis: getComputedStyle(windImg).visibility };
out.goneArt = [cardRow('Gone').querySelectorAll('img').length, !!cardRow('Gone').querySelector('.dc-art-none')];
const docCell = cardRow('The Doctor').querySelector('.dc-card');
docCell.dispatchEvent(new MouseEvent('mouseenter'));
const pop = document.getElementById('dc-art-pop');
out.pop = pop && { shown: !pop.hidden, src: ((pop.querySelector('.dc-full-art img') || {}).getAttribute ?
    pop.querySelector('.dc-full-art img').getAttribute('src') : '').slice(0, 15),
  name: H.text('.dc-full-name', pop), stack: H.text('.dc-full-stack', pop),
  reward: [...pop.querySelectorAll('.dc-full-reward span')].map(e => [e.textContent, e.className]),
  flavour: [...pop.querySelectorAll('.dc-full-flavour div')].map(e => e.textContent),
  rewardColour: getComputedStyle(pop.querySelector('.dc-full-reward span')).color };
docCell.dispatchEvent(new MouseEvent('mouseleave'));
out.popHidden = !pop || pop.hidden;
// a card without art or reward data still shows: name, stack, "see the wiki"
const goneCell = cardRow('Gone').querySelector('.dc-card');
goneCell.dispatchEvent(new MouseEvent('mouseenter'));
out.popNoArt = { img: !!pop.querySelector('.dc-full-art img'), name: H.text('.dc-full-name', pop), reward: H.text('.dc-full-reward', pop) };
goneCell.dispatchEvent(new MouseEvent('mouseleave'));
const n0 = H.calls('open_url').length;
H.button(sec.querySelector('.data-table'), '↗').click();
await H.sleep(20);
out.url = decodeURIComponent((H.calls('open_url')[n0] || { args: [''] }).args[0]);
const f = sec.querySelector('input[aria-label="Filter cards or areas"]');
f.value = 'cold'; f.dispatchEvent(new Event('input'));
await H.sleep(20);
out.filtered = rows().map(r => r[0]);
f.value = ''; f.dispatchEvent(new Event('input'));
// app restart: the last answer saved on disk shows at once, marked, while prices refresh
DIV.data = null;
window.__stubOverrides.div_cards = Object.assign({}, window.__stubOverrides.div_cards, { cached: true, priceHour: 1767225600 });
await loadDivcardsView();
out.cachedNote = H.text('.dc-status', sec);
out.cachedRows = rows().length;
// the refresh fails: the saved prices stay on screen with a note
window.__stubOverrides.div_cards = { ok: false, error: 'feed down' };
await loadDivcardsView();
out.refreshFailed = [H.text('.dc-status', sec), rows().length];
delete window.__stubOverrides.div_cards;
return out;
"""


def scenario_divcards(s, tag):
    s.fresh()
    r = s.run(S24_DIVCARDS, timeout=60)
    calls = r["calls"] or []
    check(tag + " Div cards view visible: the saved copy first (no network), then one fresh load", r["visible"] and
          [c[1:] for c in calls] == [[True], []], calls)
    bm = r["byMap"]
    check(tag + " by area: maps only, ranked by best card, cards >= 5c counted", len(bm) == 2 and
          bm[0][0].startswith("Burial Chambers") and "The Doctor · 7.5 div" in bm[0][3] and bm[0][2] == "2 / 3" and
          bm[1][0].startswith("Cold River") and bm[1][2] == "1 / 2", bm)
    check(tag + " full set value = price x stack, in divines when 1+ div", bm[0][4] == "60 div (8)" and
          "6c" in bm[1][3], (bm[0][4], bm[1][3]))
    ev = r["ev"]
    check(tag + " value per 1,000 drops column = weight share x price (recomputed)", ev["weights"] and "1000 drops" in ev["head"]
          and [s.split(" +")[0] for s in ev["shown"]] == ev["expect"], ev)
    check(tag + " weights are labelled community estimates, not GGG numbers", "community estimates" in ev["note"]
          and "maps-of-exile" in ev["note"], ev["note"])
    check(tag + " '4 voidstones' off uses the maps' listed level", [s.split(" +")[0] for s in r["evListed"]] == r["expectListed"],
          (r["evListed"], r["expectListed"]))
    check(tag + " an opened area shows each card's odds and its share of the value",
          r["openOdds"][0].startswith("≈ ") and "drops" in r["openOdds"][0] and "per 1000 items dropped" in (r["openSum"] or ""),
          (r["openOdds"], r["openSum"]))
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
    da = r["docArt"] or {}
    check(tag + " card art: row thumbnail from the CDN art path, served from the art cache",
          da.get("remote") == "https://web.poecdn.com/image/divination-card/TheDoctor.png" and
          da.get("local") == "data:image/png;" and da.get("ok") and da.get("w", 0) > 0 and da.get("vis") == "visible", da)
    wa = r["windArt"] or {}
    check(tag + " card art that fails to load stays invisible (no broken icon)",
          (wa.get("src") or "").endswith("/AChillingWind.png") and not wa.get("ok") and wa.get("vis") == "hidden", wa)
    check(tag + " a card without art has no image at all", r["goneArt"] == [0, True], r["goneArt"])
    pp = r["pop"] or {}
    check(tag + " hovering a card shows the whole card, leaving hides it", pp.get("shown") and pp.get("src") == "data:image/png;"
          and pp.get("name") == "The Doctor" and pp.get("stack") == "1 / 8" and r["popHidden"], (pp, r["popHidden"]))
    check(tag + " full card: reward in its colour, flavour text by line", pp.get("reward") == [["Headhunter", "dc-c-unique"]]
          and pp.get("rewardColour") == "rgb(175, 96, 37)" and pp.get("flavour") == ["They said I needed my head examined,",
          "but I would rather just take yours."], pp)
    check(tag + " a card without art or reward still shows its name", r["popNoArt"] == {"img": False, "name": "Gone",
          "reward": "Reward: see the wiki"}, r["popNoArt"])
    check(tag + " saved copy after a restart: shown at once, marked as refreshing",
          "Showing prices from" in (r["cachedNote"] or "") and "refreshing" in (r["cachedNote"] or "") and
          r["cachedRows"] > 0, (r["cachedNote"], r["cachedRows"]))
    rf = r["refreshFailed"] or [None, 0]
    check(tag + " a failed refresh keeps the saved prices on screen",
          "Couldn't refresh prices (feed down)" in (rf[0] or "") and rf[1] == r["cachedRows"], rf)



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
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await H.sleep(30);
out.escBack = document.body.dataset.view;
out.extraWindows = typeof TRADES !== 'undefined' && TRADES;
return out;
"""


def scenario_trade_embed(s, tag):
    s.fresh()
    r = s.run(S25_EMBED, timeout=60)
    check(tag + " Trade helper opens as a view of the main window (no build needed)", r["view"] == "trades" and
          r["visible"] and r["tabs"] == ["Trades", "People", "Reports", "Setup"] and r["settingsClosed"], r)
    check(tag + " reads the log reader's state on open", r["status"] >= 1, r["status"])
    check(tag + " Back returns to the Builds page without a build", r["backTo"] == "home" and r["landing"], r)
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
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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
// passive icons: the stub's art cache has no sheets, so the zoomed-in draws above kept plain dots
const D = POE_TREE_VIEW;
out.iconData = !!(D.icons && D.icons.at.length === 2 * D.nodes.length && D.icons.size.length === 3);
out.iconFallback = [TREE_SPRITES && TREE_SPRITES.state, cv.iconsDrawn];
out.bgFallback = [TREE_BG && TREE_BG.state, cv.bgDrawn]; // the backdrop too: plain background
// sheets from the art cache (one flat colour each): zoomed in, allocated nodes show the active one
function sheet(rgb) {
  const c = document.createElement('canvas');
  c.width = 1400; c.height = 2000;
  const g = c.getContext('2d'); g.fillStyle = rgb; g.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
const art = {}; art[D.icons.active] = sheet('rgb(20,200,40)'); art[D.icons.inactive] = sheet('rgb(200,20,40)');
window.__stubOverrides.cache_art = { ok: true, art: art };
const nCalls = H.calls('cache_art').length;
TREE_SPRITES = null;
const notable = T.I.byId[build.tree.nodes.find(id => T.I.byId[id] && T.I.byId[id].kind === 1 && T.I.byId[id].asc < 0)];
out.notableIcon = notable.icon;
out.notableId = notable.id;
cv.cx = notable.x; cv.cy = notable.y; cv.s = 0.5; treeDraw(cv);
await H.waitFor(() => TREE_SPRITES && TREE_SPRITES.state !== 'loading', 5000, 'icon sheets');
out.spriteState = TREE_SPRITES.state;
out.artCalls = H.calls('cache_art').slice(nCalls).map(c => JSON.parse(c.args[0]));
treeDraw(cv);
out.iconsZoomed = cv.iconsDrawn;
out.masteryNoSheets = [!!TREE_SPRITES.mastery, cv.masteryDrawn]; // mastery sheets missing: plain rings
const px = cv.ctx.getImageData(Math.round(cv.w / 2 * cv.dpr), Math.round(cv.h / 2 * cv.dpr), 1, 1).data;
out.centrePixel = [px[0], px[1], px[2]];
const t0 = performance.now();
for (let i = 0; i < 10; i++) treeDraw(cv);
out.drawMs = (performance.now() - t0) / 10;
H.button(sec.querySelector('.tv-zoom'), 'Fit').click();
out.iconsFit = cv.iconsDrawn;
delete window.__stubOverrides.cache_art;
// the in-game backdrop: tile + group circles + start art from the art cache, under the nodes
const B = D.background;
function sized(w, h, rgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = rgb; g.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
}
const pixel = (x, y) => [...cv.ctx.getImageData(Math.round(x * cv.dpr), Math.round(y * cv.dpr), 1, 1).data].slice(0, 3);
const plainMs = (() => { const t = performance.now(); for (let i = 0; i < 5; i++) treeDraw(cv); return (performance.now() - t) / 5; })();
out.cornerPlain = pixel(2, 2);
const bgArt = {};
bgArt[B.tile.url] = sized(B.tile.rect[2], B.tile.rect[3], 'rgb(40,40,160)');
bgArt[B.sheet.url] = sized(1312, 1100, 'rgb(200,160,60)');
window.__stubOverrides.cache_art = { ok: true, art: bgArt };
const nBg = H.calls('cache_art').length;
TREE_BG = null;
treeDraw(cv);
await H.waitFor(() => TREE_BG && TREE_BG.state !== 'loading', 5000, 'background sheets');
out.bgState = TREE_BG.state;
out.bgCalls = H.calls('cache_art').slice(nBg).map(c => JSON.parse(c.args[0]));
treeDraw(cv);
out.bgFit = cv.bgDrawn;
out.cornerBg = pixel(2, 2);
const t1 = performance.now();
for (let i = 0; i < 5; i++) treeDraw(cv);
out.bgMs = [plainMs, (performance.now() - t1) / 5];
out.insetBg = T.inset ? T.inset.bgDrawn : 'no inset';
cv.cx = notable.x; cv.cy = notable.y; cv.s = 0.5; treeDraw(cv);
out.bgZoomed = cv.bgDrawn;
out.centreOverBg = pixel(cv.w / 2, cv.h / 2); // the allocated notable's icon still on top
delete window.__stubOverrides.cache_art;
// mastery art: locked (red), connected (blue) and chosen (green) sheets plus the pattern (yellow),
// flat colours sized to cover every sprite in the data
const MA = D.masteryArt, mErrs = [];
const ext = (ks, sz) => [Math.max(...MA.art.flatMap(a => ks.map(k => a[k]))) + sz[0], Math.max(...MA.art.flatMap(a => ks.map(k => a[k + 1]))) + sz[1]];
const mArt = {}, iw = ext([0, 2], MA.size), ew = ext([4], MA.effect.size);
mArt[MA.inactive] = sized(iw[0], iw[1], 'rgb(220,30,30)');
mArt[MA.connected] = sized(iw[0], iw[1], 'rgb(30,30,220)');
mArt[MA.active] = sized(iw[0], iw[1], 'rgb(30,220,30)');
mArt[MA.effect.url] = sized(ew[0], ew[1], 'rgb(230,230,20)');
window.__stubOverrides.cache_art = { ok: true, art: mArt };
const nM = H.calls('cache_art').length;
TREE_SPRITES = null;
const mDraw = () => { try { treeDraw(cv); } catch (e) { mErrs.push(String(e && e.stack || e)); } };
const linked = n => (T.I.mnotes[n.id] || []).some(id => T.M.alloc[id]);
const chosenM = cv.masteries.find(n => T.M.mastery[n.id] === build.tree.masteries[0][1]);
const connM = cv.masteries.find(n => !T.M.mastery[n.id] && linked(n));
const lockedM = cv.masteries.find(n => !T.M.mastery[n.id] && !linked(n));
out.mStates = [chosenM, connM, lockedM].map(n => n ? treeMasteryState(T, n) : null);
cv.cx = chosenM.x; cv.cy = chosenM.y; cv.s = 0.5; mDraw();
await H.waitFor(() => TREE_SPRITES && TREE_SPRITES.state !== 'loading', 5000, 'mastery sheets');
out.mSprites = [TREE_SPRITES.state, !!TREE_SPRITES.mastery, !!(TREE_SPRITES.mastery && TREE_SPRITES.mastery.effect)];
out.mCalls = H.calls('cache_art').slice(nM).map(c => JSON.parse(c.args[0]));
out.mCentre = {}; out.mDrawn = {};
[['chosen', chosenM], ['connected', connM], ['locked', lockedM]].forEach(([k, n]) => {
  cv.cx = n.x; cv.cy = n.y; cv.s = 0.5; mDraw();
  out.mCentre[k] = pixel(cv.w / 2, cv.h / 2);
  out.mDrawn[k] = Object.assign({}, cv.masteryDrawn);
});
// the pattern: behind the chosen mastery's group, past its icon (diagonal, between the orbits)
cv.cx = chosenM.x; cv.cy = chosenM.y; cv.s = 0.5; mDraw();
const off = 70; // px: outside the 56 px half icon, inside the 193 px half pattern
out.mPattern = pixel(cv.w / 2 + off, cv.h / 2 + off);
const fx = TREE_SPRITES.mastery.effect;
TREE_SPRITES.mastery.effect = null; mDraw();
out.mNoPattern = pixel(cv.w / 2 + off, cv.h / 2 + off);
TREE_SPRITES.mastery.effect = fx;
// compare colours stay as rings on top: the build's first mastery has another effect on the character
T.mode = 'compare'; mDraw();
const tc = document.createElement('canvas').getContext('2d'); tc.fillStyle = treeColors().take;
const take = [1, 3, 5].map(i => parseInt(tc.fillStyle.slice(i, i + 2), 16));
const ringPx = Math.max(treeNodeRadius(chosenM, cv.s), MA.size[0] / MA.zoom * cv.s * 0.42) + 4;
out.mChangeRing = 0;
for (let k = 0; k < 72; k++) {
  const p = pixel(cv.w / 2 + ringPx * Math.cos(k * Math.PI / 36), cv.h / 2 + ringPx * Math.sin(k * Math.PI / 36));
  if (p.every((v, i) => Math.abs(v - take[i]) < 40)) out.mChangeRing++;
}
T.mode = 'build';
// a zoomed-in redraw with many masteries on screen stays fast; zoomed out to fit, no mastery art
cv.s = 0.25; mDraw();
out.mMany = Object.assign({}, cv.masteryDrawn);
const t2 = performance.now();
for (let i = 0; i < 10; i++) mDraw();
out.mMs = (performance.now() - t2) / 10;
H.button(sec.querySelector('.tv-zoom'), 'Fit').click();
out.mFit = Object.assign({}, cv.masteryDrawn);
out.mErrs = mErrs;
delete window.__stubOverrides.cache_art;
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
    ic = tv["icons"]
    k = [n[0] for n in tv["nodes"]].index(r["notableId"])
    check(tag + " icons: view data has per-node icon coords, indexed onto the nodes", r["iconData"] and
          r["notableIcon"] == ic["at"][2 * k:2 * k + 2], (r["notableIcon"], ic["at"][2 * k:2 * k + 2]))
    check(tag + " icons: no sheets in the art cache -> plain dots, nothing drawn", r["iconFallback"] == ["failed", 0],
          r["iconFallback"])
    ma = tv["masteryArt"]
    m_urls = [ma["inactive"], ma["connected"], ma["active"], ma["effect"]["url"]]
    check(tag + " icons: sheets fetched through cache_art (active + inactive + the 4 mastery sheets, one call)",
          r["spriteState"] == "ready" and r["artCalls"] == [[ic["active"], ic["inactive"]] + m_urls], (r["spriteState"], r["artCalls"]))
    px = r["centrePixel"]
    check(tag + " icons: zoomed in, allocated notable drawn from the active sheet", r["iconsZoomed"] > 10 and
          px[1] > 150 and px[0] < 80 and px[2] < 90, (r["iconsZoomed"], px))
    check(tag + " masteries: no mastery sheets in the art cache -> icons still drawn, masteries keep plain rings",
          r["masteryNoSheets"] == [False, {"locked": 0, "connected": 0, "chosen": 0, "effects": 0}], r["masteryNoSheets"])
    check(tag + " icons: none when zoomed out to fit", r["iconsFit"] == 0, r["iconsFit"])
    check(tag + " icons: a zoomed-in redraw stays fast (< 30 ms)", r["drawMs"] < 30, r["drawMs"])
    bg = tv["background"]
    check(tag + " backdrop data: tile, group sheet, a circle per group, the 7 class start arts",
          bg["tile"]["url"].startswith("https://web.poecdn.com/") and bg["sheet"]["url"].startswith("https://web.poecdn.com/") and
          len(bg["groups"]) // 3 > 300 and len(bg["starts"]) == 14, (len(bg["groups"]) // 3, bg["starts"]))
    check(tag + " backdrop: no sheets in the art cache -> plain background, nothing drawn", r["bgFallback"] == ["failed", None],
          r["bgFallback"])
    check(tag + " backdrop: tile + group sheets fetched through cache_art (one call)",
          r["bgState"] == "ready" and r["bgCalls"] == [[bg["tile"]["url"], bg["sheet"]["url"]]], (r["bgState"], r["bgCalls"]))
    fit = r["bgFit"] or {}
    check(tag + " backdrop drawn at fit: tile, every group circle, every class start", fit.get("tile") and
          fit.get("groups", 0) > 300 and fit.get("starts") == 7 and not fit.get("painting"), fit)
    cp, cb = r["cornerPlain"], r["cornerBg"]
    check(tag + " backdrop: the tile shows (dimmed) where the plain background was", cb != cp and cb[2] > cp[2] and cb[2] < 160,
          (cp, cb))
    check(tag + " backdrop: the ascendancy inset keeps its plain background", r["insetBg"] is None, r["insetBg"])
    zb, c = r["bgZoomed"] or {}, r["centreOverBg"]
    check(tag + " backdrop: zoomed in, nodes stay on top of it (allocated notable's icon at the centre)",
          zb.get("tile") and c[1] > 150 and c[0] < 80 and c[2] < 90, (zb, c))
    check(tag + " backdrop: a fitted redraw stays fast (< 40 ms, < plain + 15 ms)",
          r["bgMs"][1] < 40 and r["bgMs"][1] < r["bgMs"][0] + 15, r["bgMs"])
    check(tag + " masteries: test picks a chosen, a connected and a locked one", r["mStates"] == ["chosen", "connected", "locked"],
          r["mStates"])
    check(tag + " masteries: the 4 sheets fetched through cache_art (one call), cut once, pattern included",
          r["mSprites"] == ["ready", True, True] and r["mCalls"] == [m_urls], (r["mSprites"], r["mCalls"]))
    mc, md = r["mCentre"], r["mDrawn"]
    check(tag + " masteries: chosen drawn from the active-selected sheet", md["chosen"]["chosen"] >= 1 and
          mc["chosen"][1] > 150 and mc["chosen"][0] < 90 and mc["chosen"][2] < 90, (md["chosen"], mc["chosen"]))
    check(tag + " masteries: connected drawn from the connected sheet", md["connected"]["connected"] >= 1 and
          mc["connected"][2] > 150 and mc["connected"][0] < 90 and mc["connected"][1] < 90, (md["connected"], mc["connected"]))
    lk = mc["locked"]
    check(tag + " masteries: locked drawn from the inactive sheet, dimmed", md["locked"]["locked"] >= 1 and
          lk[0] > 100 and lk[0] < 215 and lk[0] > lk[1] + 50 and lk[0] > lk[2] + 50, (md["locked"], lk))
    pp, np_ = r["mPattern"], r["mNoPattern"]
    check(tag + " masteries: the chosen one's pattern drawn large behind its group (past its icon)",
          md["chosen"]["effects"] >= 1 and pp != np_ and pp[0] > 150 and pp[1] > 150 and pp[2] < 120, (pp, np_))
    check(tag + " masteries: 'effect to change' ring (compare colour) drawn round the chosen icon", r["mChangeRing"] >= 4,
          r["mChangeRing"])
    many = r["mMany"]
    check(tag + " masteries: zoomed in on a wide area, all three states drawn", many["chosen"] >= 1 and many["connected"] >= 1 and
          many["locked"] >= 3, many)
    check(tag + " masteries: no mastery art zoomed out to fit", r["mFit"] == {"locked": 0, "connected": 0, "chosen": 0, "effects": 0},
          r["mFit"])
    check(tag + " masteries: no exceptions while drawing", not r["mErrs"], r["mErrs"][:2])
    check(tag + " masteries: a zoomed-in redraw with mastery art stays fast (< 40 ms)", r["mMs"] < 40, r["mMs"])


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


S32_GEMDIFF = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
const views = gemGroupViews.filter(v => v.group.gems.length >= 3);
out.groups = views.length;
const [A, B, C, D] = views;
// A: every gem, worn in a different item than PoB puts it
const invA = A.group.slot === 'Helmet' ? 'Gloves' : 'Helm';
out.whereA = invA === 'Helm' ? 'Helmet' : 'Gloves';
const gemsOf = (g) => g.gems.map(x => ({ name: x.name, level: x.level, quality: x.quality }));
// B: first gem kept, its last gem missing, one link short
const gB = gemsOf(B.group).slice(0, -1);
const item = (inv, groups) => ({ inventoryId: inv, x: 0, name: 'Some Name', base: 'Base', frameType: 2, icon: '', ilvl: 84,
  corrupted: false, implicitMods: [], explicitMods: [], craftedMods: [], fracturedMods: [], enchantMods: [],
  // sockets as the bridge sends them: one per link, gem name or '' when empty
  linkGroups: groups.map(g => Object.assign({ sockets: g.gems.map(x => ({ c: 'B', gem: x.name }))
    .concat(Array(Math.max(0, g.links - g.gems.length)).fill({ c: 'R', gem: '' })) }, g)) });
window.__stubOverrides.get_character_items = { ok: true, items: [
  item(invA, [{ links: A.group.gems.length, gems: gemsOf(A.group) }]),
  item('Weapon2', [{ links: gB.length, gems: gB }]),
  item('MainInventory', [{ links: 6, gems: gemsOf(C.group) }]),  // bag items don't count
  // D: all but its last two gems linked in the boots, one in a separate boots socket, one in the amulet
  item('Boots', [{ links: D.group.gems.length - 2, gems: gemsOf(D.group).slice(0, -2) }, { links: 1, gems: gemsOf(D.group).slice(-2, -1) }]),
  item('Amulet', [{ links: 1, gems: gemsOf(D.group).slice(-1) }]),
] };
window.__stubOverrides.get_character_passives = { ok: true, hashes: [], hashesEx: [], masteries: {}, jewels: [] };
document.getElementById('acct-input').value = 'Me#1';
const sel = document.getElementById('char-select');
const o = document.createElement('option'); o.value = 'MyChar'; o.textContent = 'MyChar'; sel.appendChild(o); sel.value = 'MyChar';
document.getElementById('char-compare').click();
await H.waitFor(() => /comparing against/.test(H.text('#char-status') || ''), 4000, 'compare');
const st = v => ({ cls: ['diff-matched', 'diff-close', 'diff-missing'].filter(c => v.card.classList.contains(c))[0],
  row: ['diff-matched', 'diff-close', 'diff-missing'].filter(c => v.row.classList.contains(c))[0],
  text: (v.card.querySelector('.char-diff') || {}).textContent || '',
  chips: [...v.card.querySelectorAll('.gem-you')].length,
  links: ['linked', 'unlinked', 'elsewhere', 'missing'].map(k => v.card.querySelectorAll('.gem-link-' + k).length) });
out.A = st(A); out.B = st(B); out.C = st(C); out.D = st(D); out.dN = D.group.gems.length;
// D's socket picture: both boots link groups, A outlined as this setup, the amulet beside
out.viz = { items: [...D.card.querySelectorAll('.glv-item-name')].map(e => e.textContent),
  heads: [...D.card.querySelectorAll('.glv-head')].map(e => e.textContent),
  matched: H.text('.glv-group.matched .glv-head', D.card), chains: D.card.querySelectorAll('.glv-chain.linked').length,
  chips: [...D.card.querySelectorAll('.gem-you')].map(e => e.textContent) };
out.aSlot = A.group.slot; out.bLast = B.group.gems[B.group.gems.length - 1].name;
out.bLinks = gB.length; out.bWant = Math.min(6, B.group.gems.length);
// gemFit: awakened upgrade full, plain-for-awakened half, transfigured half, heralds different
out.fit = [gemFit('Added Fire Damage', 'Awakened Added Fire Damage Support'), gemFit('Awakened Added Fire Damage', 'Added Fire Damage Support'),
  gemFit('Kinetic Blast of Clustering', 'Kinetic Blast'), gemFit('Herald of Ice', 'Herald of Thunder'), gemFit('Grace', 'Vaal Grace')];
// exact matches first, whatever the listing order: transfigured listed before its plain gem
const order = groupFit([{ name: 'Summon Stone Golem of Safeguarding', level: 20, quality: 20 }, { name: 'Summon Stone Golem', level: 20, quality: 20 }],
  { links: 2, gems: [{ name: 'Summon Stone Golem', level: 20, quality: 20 }] });
out.order = [order.full, order.missing.join(), order.variants.length];
// unticked gems: listed after the setup, dimmed, not in the group's price rows; the compare
// names them as options when you run one in place of a ticked gem
const g0 = A.group, off = { name: 'Faster Casting Support', level: 20, quality: 20, count: 1, enabled: false };
const gemsView = makeGemsCard([Object.assign({}, g0, { offGems: [off] })]);
const offCard = gemsView.querySelector('.gem-group-card');
out.off = { rows: offCard.querySelectorAll('.gem-row').length, offRows: offCard.querySelectorAll('.gem-row.gem-off').length,
  head: H.text('.gem-off-head', offCard), tag: H.text('.slot-tag', offCard), badge: !!offCard.querySelector('.gem-off .off-badge'),
  priced: gemGroupViews[0].gemRows.length, want: g0.gems.length };
const swapped = groupFit(g0.gems, { links: g0.gems.length, gems: g0.gems.slice(0, -1).concat([{ name: 'Faster Casting Support', level: 20, quality: 20 }]) }, [off]);
out.offFit = [swapped.missing.length, swapped.options.join()];
// socket colour helper (3.29): facts + bench / chromatic / omen options, never odds
const sh = c => { const el = socketColourHelp(c); return el ? { head: H.text('.sock-help-head', el),
  tips: [...el.querySelectorAll('li')].map(l => l.textContent), done: el.classList.contains('is-done') } : null; };
const mk = (socks, extra) => Object.assign({ sockets: socks, itemSockets: socks, reqs: { str: 155, dex: 0, int: 0 },
  quality: 20, corrupted: false }, extra || {});
out.sock = { colours: [gemColour('Cleave'), gemColour('Added Fire Damage Support'), gemColour('Fireball'), gemColour('Portal')],
  done: sh(mk([{ c: 'R', gem: 'Cleave' }, { c: 'R', gem: 'Added Fire Damage Support' }])),
  mixed: sh(mk([{ c: 'W', gem: 'Cleave' }, { c: 'W', gem: 'Fireball' }, { c: 'W', gem: 'Blink Arrow' }, { c: 'W', gem: '' }])),
  corrupt: sh(mk([{ c: 'W', gem: 'Cleave' }, { c: 'W', gem: 'Added Fire Damage Support' }], { corrupted: true })),
  white: sh(mk([{ c: 'W', gem: 'Portal' }])) };
delete window.__stubOverrides.get_character_items;
delete window.__stubOverrides.get_character_passives;
return out;
"""


S34_QUICKWINS = r"""
const H = window.__e2e;
await H.loadBuild();
const out = {};
const urls = () => H.calls('open_url').map(c => c.args[0]);
// 1. poe.ninja: league slugs, the card menu (uniques yes, rares no), gem panels, market categories
out.slugs = ['Allflame', 'Hardcore Allflame', 'SSF Allflame', 'Hardcore SSF Allflame', 'Standard', 'Hardcore'].map(ninjaLeague);
const uniq = cards.find(c => c.unique && c.card && !/jewel|flask/i.test(c.slot));
const rare = cards.find(c => !c.unique && c.card && c.item.rarity === 'RARE');
const menuItems = st => { st.card.querySelector('.menu-trigger').click();
  const items = [...document.querySelectorAll('.menu .menu-item')]; return items; };
let items = menuItems(uniq);
out.uniqMenu = items.map(b => b.textContent);
items.find(b => b.textContent === 'Open on poe.ninja ↗').click();
await H.sleep(20);
out.uniqUrl = urls().pop(); out.uniqCat = ninjaCategory(uniq); out.uniqName = uniq.resolvedName || uniq.item.name;
items = menuItems(rare);
out.rareMenu = items.map(b => b.textContent);
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await H.sleep(10);
out.cats = [ninjaCategory({ item: { rarity: 'GEM', name: 'x' } }),
  ninjaCategory({ unique: true, slot: 'Ring 1', item: { base: 'Gold Ring' } }),
  ninjaCategory({ unique: true, slot: 'Weapon 1', item: { base: 'Imperial Claw' } }),
  ninjaCategory({ unique: true, slot: 'Weapon 2', item: { base: 'Titanium Spirit Shield' } }),
  ninjaCategory({ unique: true, slot: 'Flask 1', item: { base: 'Quicksilver Flask' } }),
  ninjaCategory({ item: { rarity: 'CURRENCY', itemClass: 'Stackable Currency', name: 'Divine Orb' } })];
out.market = [{ name: 'Divine Orb', cat: 'Currency' }, { name: 'Gilded Ambush Scarab', cat: 'Fragments, Scarabs & Mapping' },
  { name: 'The Doctor', cat: 'Cards' }, { name: 'Omen of Amelioration', cat: 'Tattoos & Omens' }, { name: 'Some Ember', cat: 'Allflame Embers' }]
  .map(marketNinjaCategory);
setView('gems');
await H.sleep(20);
const gemRow = document.querySelector('.gem-group-card.is-active .gem-row:not(.gem-off)');
gemRow.querySelector('button[aria-label^="Listings for"]').click();
await H.sleep(20);
H.button(gemRow.nextElementSibling, 'poe.ninja ↗').click();
await H.sleep(20);
out.gemUrl = urls().pop(); out.gemName = gemRow.querySelector('.gem-name').firstChild.textContent;
// 3. search text: Flasks and Vendor tabs
setView('search');
await H.sleep(20);
const sec = document.querySelector('.tab-section[data-tab="search"]');
const tab = label => [...sec.querySelectorAll('.segmented .seg')].find(b => b.textContent === label);
const want = label => [...sec.querySelectorAll('.st-mod')].find(r => r.querySelector('.st-mod-text').textContent === label)
  .querySelector('button[title="Want"]');
tab('Flasks').click(); await H.sleep(10);
out.flaskRows = sec.querySelectorAll('.st-mod').length;
want('Bleeding immunity').click(); await H.sleep(10);
want('Instant recovery').click(); await H.sleep(10);
out.flaskText = sec.querySelector('.st-text').value;
tab('Vendor').click(); await H.sleep(10);
H.button(sec, 'Chromatic recipe (R-G-B)').click(); await H.sleep(10);
out.vendorText = sec.querySelector('.st-text').value;
tab('Flasks').click(); await H.sleep(10);
out.flaskKept = sec.querySelector('.st-text').value;
// 2. chat macros (Settings → In game)
const ml = document.getElementById('macro-list');
const rows = () => [...ml.querySelectorAll('.macro-row')];
out.macroDefaults = rows().map(r => r.querySelector('.macro-cmd').value);
out.firstSave = H.calls('set_macros').length;
H.button(rows()[2], '▶').click(); await H.sleep(20);
out.sent = H.calls('chat_macro').map(c => c.args[0]);
const key = rows()[2].querySelector('select'); key.value = 'f2'; key.dispatchEvent(new Event('change')); await H.sleep(20);
out.afterKey = JSON.parse(H.calls('set_macros').pop().args[0]);
const n = H.calls('set_macros').length;
const cmd = rows()[0].querySelector('.macro-cmd'); cmd.value = 'kingsmarch'; cmd.dispatchEvent(new Event('change')); await H.sleep(20);
out.invalid = [cmd.classList.contains('invalid'), H.calls('set_macros').length === n];
document.getElementById('macro-add').click(); await H.sleep(10);
out.added = rows().length;
H.button(rows()[1], '✕').click();
await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'remove dialog');
H.button(document.querySelector('dialog[open]'), 'Remove').click();
await H.sleep(40);
out.afterRemove = rows().map(r => r.querySelector('.macro-cmd').value);
out.prefs = JSON.parse(localStorage.getItem('pobtf-prefs')).macros.map(m => m.command + ':' + m.hotkey);
return out;
"""

S34_PRICE_OVERLAY = r"""
const H = window.__e2e;
const out = {};
const bar = document.getElementById('overlay-bar');
out.bar = !!bar && !!bar.querySelector('.ov-grip') && getComputedStyle(bar).cursor;
bar.setPointerCapture = () => {};
const t = bar.querySelector('.ov-title');
t.dispatchEvent(new PointerEvent('pointerdown', { screenX: 10, screenY: 10, pointerId: 3, button: 0, bubbles: true }));
t.dispatchEvent(new PointerEvent('pointermove', { screenX: 40, screenY: 25, pointerId: 3, bubbles: true }));
await H.sleep(20);
bar.dispatchEvent(new PointerEvent('pointerup', { screenX: 50, screenY: 30, pointerId: 3, bubbles: true }));
await H.sleep(20);
out.move = H.calls('price_overlay_move').map(c => c.args);
const close = document.getElementById('overlay-close');
close.dispatchEvent(new PointerEvent('pointerdown', { screenX: 1, screenY: 1, pointerId: 4, button: 0, bubbles: true }));
await H.sleep(10);
out.closeNoDrag = H.calls('price_overlay_move').length === out.move.length;
return out;
"""


def scenario_quickwins(s, tag):
    s.fresh()
    r = s.run(S34_QUICKWINS, timeout=60)
    check(tag + " poe.ninja league slugs", r["slugs"] == ["allflame", "allflamehc", "allflame", "allflamehc", "standard", "hardcore"],
          r["slugs"])
    check(tag + " unique card menu opens poe.ninja", "Open on poe.ninja ↗" in r["uniqMenu"] and (r["uniqUrl"] or "").startswith(
        "https://poe.ninja/poe1/economy/") and ("/" + r["uniqCat"] + "?name=") in r["uniqUrl"], (r["uniqUrl"], r["uniqCat"]))
    check(tag + " rare card menu has no poe.ninja", "Open on poe.ninja ↗" not in r["rareMenu"], r["rareMenu"])
    check(tag + " categories by item kind", r["cats"] == ["skill-gems", "unique-accessories", "unique-weapons", "unique-armours",
          "unique-flasks", "currency"], r["cats"])
    check(tag + " market categories (unknown ones get no link)", r["market"] == ["currency", "scarabs", "divination-cards",
          "omens", None], r["market"])
    check(tag + " gem panel opens poe.ninja", "/skill-gems?name=" in (r["gemUrl"] or "") and r["gemName"].replace(" ", "%20")
          in r["gemUrl"], (r["gemUrl"], r["gemName"]))
    check(tag + " flasks tab builds the search", r["flaskRows"] >= 15 and r["flaskText"] == '"bleed|nt recovery|d instantly"',
          r["flaskText"])
    check(tag + " vendor tab builds the search", r["vendorText"] == '"ts:.*(r-g-b|r-b-g|g-r-b|g-b-r|b-r-g|b-g-r)"', r["vendorText"])
    check(tag + " each tab keeps its picks", r["flaskKept"] == r["flaskText"], r["flaskKept"])
    check(tag + " default macros (no /hideout)", r["macroDefaults"] == ["/kingsmarch", "/menagerie", "/delve", "/exit"],
          r["macroDefaults"])
    check(tag + " first run saves nothing (defaults have no hotkeys)", r["firstSave"] == 0, r["firstSave"])
    check(tag + " ▶ sends one command", r["sent"] == ["/delve"], r["sent"])
    check(tag + " hotkey saved", [m["hotkey"] for m in r["afterKey"]] == ["off", "off", "f2", "off"], r["afterKey"])
    check(tag + " command without / refused, not saved", r["invalid"] == [True, True], r["invalid"])
    check(tag + " add a macro", r["added"] == 5, r["added"])
    # the refused edit was never saved, so the redrawn list shows /kingsmarch again
    check(tag + " remove asks first, then removes", r["afterRemove"] == ["/kingsmarch", "/delve", "/exit", ""], r["afterRemove"])
    check(tag + " macros kept in prefs", "/delve:f2" in r["prefs"] and "/menagerie:off" not in r["prefs"], r["prefs"])
    s.fresh("?overlay=1")
    r = s.run(S34_PRICE_OVERLAY)
    check(tag + " price check banner is the drag handle", r["bar"] == "move", r["bar"])
    check(tag + " dragging moves the window", [m[0] for m in r["move"]] == ["start", "move", "end"]
          and r["move"][1][1:] == [30, 15], r["move"])
    check(tag + " the close button doesn't start a drag", r["closeNoDrag"])


S37_LEDGER_CARDS = r"""
const H = window.__e2e;
const out = {};
const card = name => [...document.querySelectorAll('.trade-card')].find(c => c.querySelector('.tc-name').textContent === name);
localStorage.setItem('pobtf-trade-prefs', JSON.stringify({ enabled: true, ack: true, sound: 'off', wasterAt: 2 }));
await window.__tradePrefsChanged();
// one divine = 200c; every quick price answers 200c (the market check sees the sale at its going rate)
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 200, divine: 1, cat: 'Currency' };
const buy = { kind: 'item', item: 'Goldrim Leather Cap', price: 30, currency: 'chaos', league: 'Standard', tab: 'Shop', left: 1, top: 1 };
window.__tradeEvent({ type: 'whisper', dir: 'out', name: 'SellerOne', text: 'Hi, I would like to buy your Goldrim', trade: buy });
await H.sleep(30);
let c = card('SellerOne');
out.buyCard = { dir: H.text('.tc-dir', c), outcomes: [...c.querySelectorAll('.tc-other .btn')].map(b => b.textContent),
  paid: H.text('.tc-sold', c), suggested: !!c.querySelector('.tc-complete.suggested'), inputs: c.querySelectorAll('input, select').length };
H.button(c, 'Visit hideout').click();
await H.sleep(20);
window.__tradeEvent({ type: 'trade_accepted' });
await H.sleep(20);
c = card('SellerOne');
out.accepted = { status: H.text('.tc-status', c), suggested: !!c.querySelector('.tc-complete.suggested') };
c.querySelector('button[aria-label="Lower the price you paid"]').click();
await H.sleep(10);
card('SellerOne').querySelector('.tc-complete').click();
await H.sleep(100);
out.purchases = JSON.parse(localStorage.getItem('pobtf-purchases') || '[]');
out.seller = JSON.parse(localStorage.getItem('pobtf-buyers') || '{}').sellerone;
out.closed = !card('SellerOne');
// a seller who doesn't answer twice is a time waster: their next card says so
for (let i = 0; i < 2; i++) {
  window.__tradeEvent({ type: 'whisper', dir: 'out', name: 'Ghosty', text: 'hi', trade: Object.assign({}, buy, { item: 'Thing ' + i }) });
  await H.sleep(20);
  H.button(card('Ghosty'), '⌛ No answer').click();
  await H.sleep(60);
}
window.__tradeEvent({ type: 'whisper', dir: 'out', name: 'Ghosty', text: 'hi', trade: Object.assign({}, buy, { item: 'Thing 9' }) });
await H.sleep(30);
out.ghostBadge = H.text('.seller-badge', card('Ghosty'));
out.todayAfterBuy = H.text('.ov-today');
// sell the same item for 1 div: a flip, and today's line shows both sides
window.__tradeEvent({ type: 'whisper', dir: 'in', name: 'BuyerOne', text: 'Hi', trade: { kind: 'item', item: 'Goldrim Leather Cap',
  price: 1, currency: 'divine', league: 'Standard' } });
window.__tradeEvent({ type: 'joined', name: 'BuyerOne' });
await H.sleep(30);
card('BuyerOne').querySelector('.tc-complete').click();
await H.sleep(150);
out.sales = JSON.parse(localStorage.getItem('pobtf-sales') || '[]');
out.today = H.text('.ov-today');
out.flips = pairLedgerFlips(ledgerEntries()).flips.map(f => [f.item, f.profit]);
out.shapeHasToday = (H.calls('overlay_shape').slice(-1)[0] || { args: [null, []] }).args[1].length >= 2;
return out;
"""

S37_LEDGER_PAGES = r"""
const H = window.__e2e;
const out = {};
const now = Date.now(), d = 86400000;
const clickDialog = async label => { await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'dialog');
  H.button(document.querySelector('dialog[open]'), label).click(); await H.sleep(40); };
localStorage.setItem('pobtf-sales', JSON.stringify([
  { id: 's1', time: now - 2 * d, outcome: 'completed', league: 'Standard', item: 'Mageblood Heavy Belt', price: 20, currency: 'divine',
    chaos: 4000, div: 20, buyer: 'BigSpender', market: 6000, marketSource: 'poe.ninja', under: true },
  { id: 's2', time: now - d, outcome: 'completed', league: 'Standard', item: 'Goldrim Leather Cap', price: 50, currency: 'chaos', chaos: 50, buyer: 'BuyerOne' },
  { id: 's3', time: now - 3600e3, outcome: 'wasted', league: 'Standard', item: 'Junk', price: 5, currency: 'chaos', chaos: 5, buyer: 'Waster' },
  { id: 's4', time: now - 1800e3, outcome: 'completed', league: 'Standard', item: 'Chaos Orb', count: 200, bulk: true, price: 1,
    currency: 'divine', chaos: 200, goodsChaos: 190, goodsCat: 'Currency', buyer: 'Swapper' }]));
localStorage.setItem('pobtf-purchases', JSON.stringify([
  { id: 'p1', time: now - 3 * d, outcome: 'bought', league: 'Standard', item: 'Goldrim Leather Cap', price: 10, currency: 'chaos', chaos: 10, seller: 'SellerOne' },
  { id: 'p2', time: now - 7200e3, outcome: 'bought', league: 'Standard', item: 'Tabula Rasa Simple Robe', price: 15, currency: 'chaos', chaos: 15, seller: 'SellerTwo' }]));
const P = (name, extra) => Object.assign({ name: name, names: [name], completed: 0, spent: 0, wasted: 0, noShow: 0, notCompleted: 0, other: 0,
  sold: 0, paid: 0, noAnswer: 0, notBought: 0, sellerOther: 0, flag: false, hidden: false, ignored: null, waster: null, note: '', last: now }, extra);
localStorage.setItem('pobtf-buyers', JSON.stringify({ bigspender: P('BigSpender', { completed: 1, spent: 4000 }),
  waster: P('Waster', { wasted: 2 }), ghost: P('Ghost', { noAnswer: 1, hidden: true, ignored: now - 1000 }),
  sellerone: P('SellerOne', { sold: 1, paid: 10 }) }));
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 200, divine: 1 };
const tab = label => H.button(document.querySelector('.trades-tabs'), label);
const seg = label => [...document.querySelectorAll('.ledger-sub .seg')].find(b => b.textContent.startsWith(label));
const tiles = () => [...document.querySelectorAll('.sales-tile')].map(t => t.querySelector('.st-label').textContent + '=' + t.querySelector('.st-value').textContent);
const rows = () => [...document.querySelectorAll('.trades-body .data-table tbody tr')].map(r => r.textContent);
tab('Trades').click(); await H.sleep(30);
const period = [...document.querySelectorAll('.sales-filters select')].find(s => [...s.options].some(o => o.value === 'all'));
period.value = 'all'; period.dispatchEvent(new Event('change')); await H.sleep(30);
out.tiles = tiles();
out.soldRows = rows();
out.underChip = !!document.querySelector('.under-chip');
seg('Bought').click(); await H.sleep(30);
out.boughtRows = rows().length;
seg('Flips').click(); await H.sleep(30);
out.flipRows = [...document.querySelector('.trades-body .data-table').querySelectorAll('tbody tr')].map(r => r.textContent);
out.holding = H.text('.trades-body details summary');
// + Add trade (a purchase from before the app)
seg('Bought').click(); await H.sleep(20);
H.button(document, '+ Add trade').click();
await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'add dialog');
const dlg = document.querySelector('dialog[open]');
dlg.querySelector('input[aria-label=Item]').value = 'Kaom\'s Heart Glorious Plate';
dlg.querySelector('input[aria-label=Price]').value = '2';
const cur = dlg.querySelector('select[aria-label=Currency]'); cur.value = 'divine';
dlg.querySelector('input[aria-label="Buyer or seller"]').value = 'OldSeller';
await clickDialog('Add');
await H.sleep(60);
const added = JSON.parse(localStorage.getItem('pobtf-purchases')).find(p => p.manual);
out.added = added && [added.item, added.price, added.currency, added.chaos, added.seller, added.outcome];
out.addedPerson = JSON.parse(localStorage.getItem('pobtf-buyers')).oldseller;
// People
tab('People').click(); await H.sleep(30);
out.peopleSegs = [...document.querySelectorAll('.ledger-sub .seg')].map(b => b.textContent);
seg('Blocked').click(); await H.sleep(30);
out.blockedRows = [...document.querySelectorAll('.person-row')].map(r => r.querySelector('.buyer-head').textContent);
const n0 = H.calls('trade_send').length;
H.button(document.querySelector('.person-row'), 'Unignore in game…').click();
await clickDialog('Send /unignore');
await H.sleep(40);
out.unignore = H.calls('trade_send').slice(n0).map(c => c.args);
out.ghostAfter = JSON.parse(localStorage.getItem('pobtf-buyers')).ghost;
H.button(document.querySelector('.person-row'), 'Show popups').click(); await H.sleep(30);
out.blockedAfter = document.querySelectorAll('.person-row').length;
seg('⌛ Time wasters').click(); await H.sleep(30);
out.wasters = [...document.querySelectorAll('.person-row b')].map(b => b.textContent);
const tws = document.querySelector('.person-row select[aria-label^="Time waster"]');
tws.value = 'no'; tws.dispatchEvent(new Event('change')); await H.sleep(30);
out.wasterSaved = JSON.parse(localStorage.getItem('pobtf-buyers')).waster.waster;
out.wastersAfter = document.querySelectorAll('.person-row').length;
// Reports
tab('Reports').click(); await H.sleep(30);
const range = [...document.querySelectorAll('.sales-filters select')][0];
range.value = 'all'; range.dispatchEvent(new Event('change')); await H.sleep(30);
out.reportTiles = tiles();
out.itemRows = rows().filter(r => /Mageblood|Goldrim/.test(r)).length;
out.underTable = [...document.querySelectorAll('.trades-body .data-table')].some(t => /Sold under market/.test(t.textContent));
// goal: counts profit since it was set
localStorage.setItem('pobtf-trade-goal', JSON.stringify({ name: 'Mirror', target: 100, unit: 'chaos', since: 0 }));
tab('Trades').click(); tab('Reports').click(); await H.sleep(30);
out.goal = H.text('.goal-line');
out.goalBar = document.querySelector('.goal-bar').getAttribute('aria-valuenow');
// Setup: backup out, then a backup with one new sale in
tab('Setup').click(); await H.sleep(30);
H.button(document, 'Export backup').click(); await H.sleep(40);
const saved = H.calls('save_text_file').slice(-1)[0].args;
const backup = JSON.parse(saved[1]);
out.backup = [saved[0].startsWith('pobtf-trades-'), backup.kind, backup.sales.length, backup.purchases.length, Object.keys(backup.people).length];
backup.sales.push({ id: 'imported', time: now - 5 * d, outcome: 'completed', league: 'Standard', item: 'From the old PC', price: 3, currency: 'chaos', chaos: 3, buyer: 'Old' });
backup.people.newguy = P('NewGuy', { completed: 1 });
importTradeBackup(JSON.stringify(backup));
await clickDialog('Import');
await H.sleep(40);
out.afterImport = [JSON.parse(localStorage.getItem('pobtf-sales')).length, !!JSON.parse(localStorage.getItem('pobtf-buyers')).newguy];
return out;
"""


S36_DUST = r"""
const H = window.__e2e;
const out = {};
await H.loadBuild();
out.nav = [...document.querySelectorAll('#nav .nav-item')].some(b => b.dataset.view === 'dust' && b.querySelector('.ni-dust'));
window.__stubOverrides.unique_prices = { ok: true, divine: 200, items: [
  ['Mageblood', 'Heavy Belt', 36000, 50, 'UniqueAccessory'], ['Starforge', 'Infernal Sword', 300, 20, 'UniqueWeapon'],
  ["Kaom's Heart", 'Glorious Plate', 50, 3, 'UniqueArmour'], ['Tabula Rasa', 'Simple Robe', 10, 300, 'UniqueArmour'],
  ['Goldrim', 'Leather Cap', 1, 500, 'UniqueArmour']] };
setView('dust');
await H.waitFor(() => DUST.prices && document.querySelectorAll('#view-dust tbody tr').length > 0, 3000, 'dust rows');
const rows = () => [...document.querySelectorAll('#view-dust tbody tr')].map(tr => (tr.querySelector('.dust-name b') || {}).textContent);
const cell = (name, i) => { const tr = [...document.querySelectorAll('#view-dust tbody tr')].find(t => t.querySelector('.dust-name b').textContent === name);
  return tr ? tr.children[i].textContent : null; };
out.first = rows();
out.league = H.calls('unique_prices').slice(-1)[0].args[0];
out.mageblood = [cell('Mageblood', 1), cell('Mageblood', 2), cell('Mageblood', 3)];
const pick = (label) => [...document.querySelectorAll('.dust-controls .field')].find(f => f.textContent.startsWith(label)).querySelector('select');
const listed = pick('Listed at least'); listed.value = '0'; listed.dispatchEvent(new Event('change')); await H.sleep(20);
out.withThin = rows().length;
const quality = [...document.querySelectorAll('.dust-controls input[type=range]')][1];
quality.value = 20; quality.dispatchEvent(new Event('change')); await H.sleep(20);
out.starQ20 = cell('Starforge', 1);
const q = document.querySelector('.dust-controls input[type=search]'); q.value = 'gold'; q.dispatchEvent(new Event('input')); await H.sleep(20);
out.search = rows();
const before = H.calls('open_url').length;
H.button(document.querySelector('#view-dust tbody tr'), 'poe.ninja ↗').click(); await H.sleep(20);
out.url = (H.calls('open_url')[before] || { args: [] }).args[0];
// the price check's line: its own item level / quality, influences beyond the built-in ones
out.line = dustLineFor({ rarity: 'UNIQUE', name: 'Mageblood', base: 'Heavy Belt', itemLevel: 75, quality: 0, influences: ['Shaper'] });
out.lineStar = dustLineFor({ rarity: 'UNIQUE', name: 'Starforge', base: 'Infernal Sword', itemLevel: 84, quality: 20, influences: ['Shaper'] });
out.rare = dustLineFor({ rarity: 'RARE', name: 'Doom Loop' });
out.data = [window.POE_DUST.items.length, window.POE_DUST.source];
delete window.__stubOverrides.unique_prices;
return out;
"""


def scenario_ledger(s, tag):
    s.fresh("?cards=1")
    r = s.run(S37_LEDGER_CARDS, timeout=60)
    b = r["buyCard"]
    check(tag + " buying card: Paid row + Bought / Didn't happen / No answer / Other, no text inputs",
          b["dir"] == "Buying from" and b["outcomes"][:4] == ["✓ Bought · 30 c", "✗ Didn't happen", "⌛ No answer", "Other"]
          and "Paid" in (b["paid"] or "") and b["inputs"] == 0 and not b["suggested"], b)
    check(tag + " Trade accepted pre-selects Bought", r["accepted"]["status"] == "Trade accepted" and r["accepted"]["suggested"],
          r["accepted"])
    p = (r["purchases"] or [{}])[0]
    check(tag + " purchase saved at the price paid", len(r["purchases"]) >= 1 and p.get("item") == "Goldrim Leather Cap" and
          p.get("price") == 25 and p.get("chaos") == 25 and p.get("seller") == "SellerOne" and r["closed"], p)
    sl = r["seller"] or {}
    check(tag + " seller's record: sold to you 1×, paid 25c", sl.get("sold") == 1 and sl.get("paid") == 25, sl)
    check(tag + " seller who didn't answer twice gets the time-waster badge", "⌛" in (r["ghostBadge"] or "") and
          "didn't answer 2×" in (r["ghostBadge"] or ""), r["ghostBadge"])
    check(tag + " today line after a purchase", "Today" in (r["todayAfterBuy"] or "") and "−25c" in r["todayAfterBuy"], r["todayAfterBuy"])
    check(tag + " today line after the sale: in, out, net", all(x in (r["today"] or "") for x in ("+200c", "−25c", "net +175c", "2 trades")),
          r["today"])
    check(tag + " buy then sell the same item = a flip", r["flips"] == [["Goldrim Leather Cap", 175]], r["flips"])
    check(tag + " today line is part of the overlay's shape", r["shapeHasToday"])

    s.fresh("?trades=1")
    r = s.run(S37_LEDGER_PAGES, timeout=90)
    t = r["tiles"]
    check(tag + " Trades tiles: earned, spent, currency trades, net", "Earned=4050c" in t and "Spent=25c" in t and
          "Currency trades=+10c" in t and "Net profit=+4035c" in t and "Trades=5" in t, t)
    check(tag + " Sold list: finished sales only, under-market flagged", len(r["soldRows"]) == 3 and r["underChip"], r["soldRows"])
    check(tag + " Bought list", r["boughtRows"] == 2, r["boughtRows"])
    check(tag + " Flips: bought 10c, sold 50c = +40c; one still held", len(r["flipRows"]) == 1 and "+40c" in r["flipRows"][0]
          and "Bought, not sold yet (1" in (r["holding"] or ""), (r["flipRows"], r["holding"]))
    check(tag + " + Add trade saves a purchase by hand, valued in chaos, and counts the seller",
          r["added"] == ["Kaom's Heart Glorious Plate", 2, "divine", 400, "OldSeller", "bought"] and
          (r["addedPerson"] or {}).get("sold") == 1, (r["added"], r["addedPerson"]))
    segs = " ".join(r["peopleSegs"])
    check(tag + " People filters with counts", all(x in segs for x in ("Buyers (", "Sellers (", "Time wasters (1)", "Blocked (1)")), segs)
    check(tag + " Blocked lists who's hidden or ignored", len(r["blockedRows"]) == 1 and "Ghost" in r["blockedRows"][0] and
          "Ignored in game" in r["blockedRows"][0] and "Popups hidden" in r["blockedRows"][0], r["blockedRows"])
    check(tag + " Unignore asks, then sends /unignore once", r["unignore"] == [["unignore", "Ghost", None]] and
          not (r["ghostAfter"] or {}).get("ignored"), (r["unignore"], r["ghostAfter"]))
    check(tag + " Show popups unblocks them", r["blockedAfter"] == 0, r["blockedAfter"])
    check(tag + " time waster after 2; 'no' overrides it", r["wasters"] == ["Waster"] and r["wasterSaved"] is False and
          r["wastersAfter"] == 0, (r["wasters"], r["wasterSaved"], r["wastersAfter"]))
    rt = r["reportTiles"]
    check(tag + " Reports: totals, best day, time wasted, under market", any(x.startswith("Best day=") for x in rt) and
          "Time wasted=1" in rt and "Sold under market=1" in rt, rt)
    check(tag + " Reports: item stats and the under-market list", r["itemRows"] >= 2 and r["underTable"], (r["itemRows"], r["underTable"]))
    check(tag + " goal counts profit since it was set", (r["goal"] or "").startswith("Mirror:") and "reached" in r["goal"] and
          r["goalBar"] == "100", (r["goal"], r["goalBar"]))
    check(tag + " backup: one file with sales, purchases and people", r["backup"][:2] == [True, "trade-backup"] and
          r["backup"][2] == 4 and r["backup"][3] == 3 and r["backup"][4] >= 4, r["backup"])
    check(tag + " import adds only what's new", r["afterImport"] == [5, True], r["afterImport"])


def scenario_dust(s, tag):
    s.fresh()
    r = s.run(S36_DUST, timeout=60)
    check(tag + " Tools → Dust explorer with its icon", r["nav"], r["nav"])
    check(tag + " dust data: 1000+ uniques, source credited", r["data"][0] > 1000 and "MIT" in r["data"][1], r["data"])
    check(tag + " sorted by dust per chaos, thin markets hidden (Kaom's: 3 listed)",
          r["first"] == ["Starforge", "Goldrim", "Tabula Rasa", "Mageblood"], r["first"])
    check(tag + " prices for the selected league", bool(r["league"]), r["league"])
    check(tag + " row: dust, price in div, dust per chaos", r["mageblood"] == ["2.23M", "180 div", "62"], r["mageblood"])
    check(tag + " 'Listed at least: any' shows thin markets too", r["withThin"] == 5, r["withThin"])
    check(tag + " quality 20 = +40% (Starforge, built-in Shaper: the dataset's own q20 value)", r["starQ20"] == "3.34M", r["starQ20"])
    check(tag + " search filters", r["search"] == ["Goldrim"], r["search"])
    check(tag + " poe.ninja link for the row", (r["url"] or "").endswith("/unique-armours?name=Goldrim"), r["url"])
    check(tag + " price check line: ilvl 75 + 1 extra influence", r["line"] and r["line"]["dust"] == 1838018
          and r["line"]["extra"] == 1, r["line"])
    check(tag + " price check line: built-in influence not counted twice", r["lineStar"] and r["lineStar"]["dust"] == 3341578
          and r["lineStar"]["extra"] == 0, r["lineStar"])
    check(tag + " no dust line for non-uniques", r["rare"] is None, r["rare"])


S39_AUTOCOMPARE = r"""
const H = window.__e2e;
const out = {};
// what the character API answers (set before the 2.5 s start-up delay runs out)
window.__stubOverrides.get_character_items = { ok: true, items: [{ inventoryId: 'Ring', x: 0, name: 'Some Ring', base: 'Gold Ring',
  frameType: 2, icon: '', ilvl: 84, corrupted: false, implicitMods: [], explicitMods: [], craftedMods: [], fracturedMods: [],
  enchantMods: [], linkGroups: [] }] };
window.__stubOverrides.get_character_passives = { ok: true, hashes: [], hashesEx: [], masteries: {}, jewels: [] };
await H.waitFor(() => H.calls('get_character_items').length > 0 || WANT_NONE, 6000, 'auto compare');
if (WANT_NONE) await H.sleep(4000);
out.calls = H.calls('get_character_items').map(c => c.args);
out.passives = H.calls('get_character_passives').length;
await H.sleep(50);
out.status = H.text('#char-status');
out.gear = typeof charGear !== 'undefined' && charGear ? Object.keys(charGear) : null;
out.box = (document.getElementById('char-auto') || {}).checked;
out.last = JSON.parse(localStorage.getItem('pobtf-last-compare') || 'null');
// running it again does nothing: once per launch
autoCompareOnStart();
await H.sleep(50);
out.callsAfter = H.calls('get_character_items').length;
// unticking the box is remembered
const cb = document.getElementById('char-auto');
cb.checked = false; cb.dispatchEvent(new Event('change'));
out.prefOff = JSON.parse(localStorage.getItem('pobtf-prefs')).autoCompare;
return out;
"""


S39_RESTART = r"""
const H = window.__e2e;
await H.waitFor(() => H.calls('storage_get').length > 0, 5000, 'settings read back');
await H.sleep(300);
const v = id => { const e = document.getElementById(id); return e.type === 'checkbox' ? e.checked : e.value; };
const out = {};
out.ui = [v('pref-hotkey-app'), v('pref-hotkey-sheet'), v('pref-close-tray'), v('pref-over-opacity'), v('char-auto'),
  [...document.querySelectorAll('#macro-list .macro-cmd')].map(i => i.value),
  (document.querySelector('#macro-list select') || {}).value];
const theme = document.getElementById('pref-theme'); theme.value = 'slate'; theme.dispatchEvent(new Event('change'));
await H.sleep(50);
const p = JSON.parse(H.calls('storage_set').filter(c => c.args[0] === 'pobtf-prefs').slice(-1)[0].args[1]);
out.saved = [p.hotkeyApp, p.hotkeySheet, p.closeToTray, p.overGameOpacity, p.autoCompare, (p.macros || [{}])[0].command];
return out;
"""


def scenario_autocompare(s, tag):
    last = json.dumps({"account": "Me#1", "name": "MyChar", "league": "Standard", "cls": "Witch", "level": 90, "at": 1})
    for want_none, seed in ((False, {"pobtf-last-compare": last}),
                            (True, {"pobtf-last-compare": last, "pobtf-prefs": json.dumps({"autoCompare": False})}),
                            (True, {})):
        s.fresh("?e2eStore=" + urllib.parse.quote(json.dumps(seed)))
        r = s.run(S39_AUTOCOMPARE, timeout=40, WANT_NONE=want_none)
        if not want_none:
            check(tag + " app start re-runs the last compare (gear, then tree jewels)", r["calls"] == [["Me#1", "MyChar"]] and
                  r["passives"] == 1 and "comparing against MyChar" in (r["status"] or "") and r["gear"] == ["Ring 1"],
                  (r["calls"], r["status"], r["gear"]))
            check(tag + " once per launch", r["callsAfter"] == 1, r["callsAfter"])
            check(tag + " box on by default; the compare is remembered again", r["box"] is True and
                  (r["last"] or {}).get("name") == "MyChar" and (r["last"] or {}).get("at", 0) > 1, (r["box"], r["last"]))
            check(tag + " unticking is saved", r["prefOff"] is False, r["prefOff"])
        elif seed:
            check(tag + " box unticked: nothing at start", r["calls"] == [] and r["box"] is False, (r["calls"], r["box"]))
        else:
            check(tag + " never compared: nothing at start", r["calls"] == [], r["calls"])
    # settings the app saved last time come back after a restart, and survive the next save
    seed = {"pobtf-prefs": json.dumps({"theme": "dark", "hotkeyApp": "f9", "hotkeySheet": "off", "closeToTray": False,
                                       "overGameOpacity": 90, "autoCompare": False,
                                       "macros": [{"label": "Delve", "command": "/delve", "hotkey": "f2"}]})}
    s.fresh("?e2eStore=" + urllib.parse.quote(json.dumps(seed)))
    r = s.run(S39_RESTART, timeout=30)
    check(tag + " in-game settings come back after a restart", r["ui"] == ["f9", "off", False, "90", False, ["/delve"], "f2"], r["ui"])
    check(tag + " ...and survive the next settings change", r["saved"] == ["f9", "off", False, 90, False, "/delve"], r["saved"])


def scenario_gemdiff(s, tag):
    s.fresh()
    r = s.run(S32_GEMDIFF, timeout=60)
    if r["groups"] < 3:
        check(tag + " build has 3+ gem groups", False, r["groups"])
        return
    a, b, c = r["A"], r["B"], r["C"]
    check(tag + " setup in another item still matches", a["cls"] == "diff-matched" and a["row"] == "diff-matched"
          and ("your " + r["whereA"]) in a["text"], a)
    check(tag + " says where PoB has it", (not r["aSlot"]) or ("PoB has it in " + r["aSlot"]) in a["text"], (r["aSlot"], a["text"]))
    check(tag + " weapon-swap gems count, missing gem named", b["cls"] in ("diff-close", "diff-missing")
          and "Weapon 1 Swap" in b["text"] and r["bLast"] in b["text"] and b["chips"] >= 1, b)
    check(tag + " short links flagged", ("%d links, build uses %d" % (r["bLinks"], r["bWant"])) in b["text"]
          or r["bLinks"] >= r["bWant"], b["text"])
    d = r["D"]
    check(tag + " each gem marked linked / not linked / elsewhere / missing", a["links"] == [r["whereA"] and a["chips"], 0, 0, 0]
          and d["links"][0] == r["dN"] - 2 and d["links"][1] == 1 and d["links"][2] == 1 and c["links"][3] >= 1, (a["links"], d["links"], c["links"]))
    check(tag + " strip counts gems socketed but not linked", "1 socketed but not linked" in d["text"]
          and "in another item:" in d["text"] and "(your Amulet)" in d["text"], d["text"])
    z = r["viz"]
    check(tag + " socket picture shows each link group on the item", z["items"] == ["Your Boots", "Your Amulet"]
          and z["heads"][:2] == ["Link A · %dLthis setup" % (r["dN"] - 2), "Link B · 1L"] and z["heads"][2] == "1L"
          and z["matched"].startswith("Link A"), z)
    check(tag + " gem tags name the link group", ("not linked · Boots B" in z["chips"]) and ("in Amulet" in z["chips"])
          and ("linked · Boots A" in z["chips"]), z["chips"])
    check(tag + " gems in the bag don't count", c["cls"] == "diff-missing" and "no link group" in c["text"], c)
    check(tag + " gem variants scored", r["fit"] == [1, 0.5, 0.5, 0, 1], r["fit"])
    check(tag + " exact gem matched before a near version", r["order"] == [1, "Summon Stone Golem of Safeguarding", 0], r["order"])
    o = r["off"]
    check(tag + " unticked gem listed after the setup, dimmed", o["offRows"] == 1 and o["rows"] == o["want"] + 1 and o["badge"]
          and "Unticked in PoB" in (o["head"] or "") and "+ 1 unticked" in (o["tag"] or ""), o)
    check(tag + " unticked gem left out of group pricing and compare", o["priced"] == o["want"], o)
    check(tag + " running an unticked option is named", r["offFit"] == [1, "Faster Casting Support"], r["offFit"])
    k = r["sock"]
    check(tag + " gem colours from RePoE (red / blue / white)", k["colours"] == ["r", "r", "b", "w"], k["colours"])
    check(tag + " socket colours: all in their colour = done, no tips", k["done"] and k["done"]["done"]
          and "2 / 2 gems in their colour" in k["done"]["head"] and not k["done"]["tips"], k["done"])
    tips = " | ".join((k["mixed"] or {}).get("tips") or [])
    check(tag + " socket colours: wants, base lean, bench 3 non-white, chromatic, omen",
          "0 / 3" in (k["mixed"] or {}).get("head", "") and "1 red, 1 green, 1 blue" in tips and "roll red" in tips
          and "green and blue sockets are unlikely" in tips and '"At Least 3 Non-White Sockets" for 20' in tips
          and "quality (this one: 20%)" in tips and "Omen of Trichromatism" in tips
          and "%" not in tips.replace("+10% gem quality", "").replace("20%", ""), tips)  # no made-up odds
    ctips = " | ".join((k["corrupt"] or {}).get("tips") or [])
    check(tag + " socket colours: corrupted = Vaal Orbs on the bench, Tainted Chromatics, no omen",
          "plus 5 Vaal Orbs" in ctips and "Tainted Chromatic" in ctips and "Omen" not in ctips, ctips)
    check(tag + " socket colours: only white gems = no helper", k["white"] is None, k["white"])


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


S32_MECH_SHEET = r"""
const H = window.__e2e;
const out = {};
const D = window.POE_CHEATSHEETS || {};
const mechs = D.mechanics || [];
out.count = mechs.length;
out.ids = mechs.map(m => m.id);
window.__sheetToggle();
await H.sleep(30);
document.querySelector('.sheet-head [aria-label^="Other sheets"]').click();
await H.sleep(30);
out.picks = [...document.querySelectorAll('.sheet-picker .sheet-pick')].map(b => b.textContent);
const first = mechs[0];
[...document.querySelectorAll('.sheet-picker .sheet-pick')].find(b => b.textContent === first.title).click();
await H.sleep(30);
out.title = H.text('.sheet-title');
out.rows = document.querySelectorAll('.sheet-body .sheet-table tbody tr, .sheet-body .sheet-list .sheet-li').length;
out.foot = (document.querySelector('.sheet-head .sheet-title') || {}).title || ''; // credit: title tooltip (full line in the app)
out.inputs = document.querySelectorAll('.sheet-panel input, .sheet-panel select, .sheet-panel textarea').length;
document.querySelector('.sheet-head [aria-label="Back to the act sheet"]').click();
await H.sleep(30);
out.backTitle = H.text('.sheet-title');
const last = mechs[mechs.length - 1];
window.__sheetOpen(last.id);
await H.sleep(30);
out.openTitle = H.text('.sheet-title');
out.lastTitle = last.title;
return out;
"""

S32_HINT = r"""
const H = window.__e2e;
const out = {};
const mechs = (window.POE_CHEATSHEETS || {}).mechanics || [];
const m = mechs.find(x => ((x.match || {}).areaIds || []).length) || mechs.find(x => ((x.match || {}).areaNames || []).length);
out.has = !!m;
if (!m) return out;
const ev = (m.match.areaIds || []).length ? { type: 'area', id: m.match.areaIds[0] + 'E2E', level: 68, act: null }
                                           : { type: 'zone', area: m.match.areaNames[0] };
out.firstVisible = (H.calls('overlay_visible')[0] || { args: [] }).args.slice(0, 2);
// not following the game and trade helper off: a real line suggests nothing
out.realIgnored = window.__sheetEvent(Object.assign({}, ev)) === false && !document.querySelector('.sheet-hint');
localStorage.setItem('pobtf-sheet-prefs', JSON.stringify({ follow: true, ack: true }));
out.shown = window.__sheetEvent(Object.assign({}, ev)) === true;
await H.sleep(30);
out.text = H.text('.sheet-hint-text');
out.visible = H.calls('overlay_visible').slice(-1)[0].args.slice(0, 2);
out.notAgain = window.__sheetEvent(Object.assign({}, ev)) === false; // same mechanic, still there
H.button(document.querySelector('.sheet-hint'), 'Open').click();
await H.sleep(30);
out.opened = (H.calls('overlay_sheet_open').slice(-1)[0] || { args: [] }).args;
out.gone = !document.querySelector('.sheet-hint');
out.small = document.getElementById('sheet-root').getBoundingClientRect().height;
// muted: never suggested again
window.__sheetEvent({ type: 'area', id: 'HideoutE2E', level: 1, act: null }); // left
window.__sheetEvent(Object.assign({}, ev));
await H.sleep(30);
document.querySelector('.sheet-hint [aria-label^="Don\'t suggest"]').click();
await H.sleep(30);
window.__sheetEvent({ type: 'area', id: 'HideoutE2E', level: 1, act: null });
out.mutedIgnored = window.__sheetEvent(Object.assign({}, ev)) === false;
out.muted = JSON.parse(localStorage.getItem('pobtf-sheet-prefs')).muted;
out.id = m.id;
return out;
"""

S32_SYNC = r"""
const H = window.__e2e;
const out = {};
const D = JSON.parse(JSON.stringify(window.POE_CHEATSHEETS));
D.version = (D.version || 0) + 1;
D.mechanics = (D.mechanics || []).concat([{ id: 'e2enew', title: 'E2E new sheet', group: 'Endgame', source: 'e2e',
  url: '', patch: '3.29', match: { areaIds: [], areaNames: [] }, sections: [{ title: 'Rows', lines: ['from the server'] }] }]);
window.__stubOverrides.cheatsheets_data = { ok: true, data: D };
document.getElementById('open-sheets').click();
await H.sleep(80);
out.synced = (window.POE_CHEATSHEETS.version === D.version);
out.listed = [...document.querySelectorAll('#view-sheets .sheet-pick')].some(b => b.textContent === 'E2E new sheet');
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === 'E2E new sheet').click();
await H.sleep(30);
out.preview = H.text('#view-sheets .sheet-panel.is-mech');
H.button(document, 'Show in game').click();
await H.sleep(30);
out.shown = (H.calls('overlay_sheet_open').slice(-1)[0] || { args: [] }).args;
// an older server copy never replaces the shipped one
delete window.__stubOverrides.cheatsheets_data;
return out;
"""


S34_UPDATE = r"""
const H = window.__e2e;
const out = {};
window.__stubOverrides.check_update = { ok: true, current: '2.5.3', latest: 'v2.5.4', newer: true,
  notes: '## v2.5.4: socket colours in the gem compare\n\n- more', page: 'https://github.com/x/y/releases/tag/v2.5.4',
  url: 'https://github.com/x/y/releases/download/v2.5.4/PoBTradeFinder-v2.5.4.zip' };
window.__stubOverrides.apply_update = { ok: true };
checkForUpdates(true);
await H.waitFor(() => !document.getElementById('update-banner').classList.contains('hidden'), 3000, 'banner');
out.label = H.text('#update-label');
out.summary = H.text('#update-summary');
out.bannerText = H.text('#update-banner');
out.status = H.text('#update-check-status');
const sb = document.getElementById('update-now-settings');
out.settingsBtn = !sb.classList.contains('hidden') && sb.textContent;
document.getElementById('update-notes').click();
await H.sleep(20);
out.notesOpened = (H.calls('open_url').slice(-1)[0] || { args: [] }).args;
document.getElementById('update-later').click();
out.hiddenAfterLater = document.getElementById('update-banner').classList.contains('hidden');
sb.click();
await H.sleep(30);
out.applied = (H.calls('apply_update').slice(-1)[0] || { args: [] }).args;
out.busy = document.getElementById('update-now-settings').disabled;
delete window.__stubOverrides.check_update;
delete window.__stubOverrides.apply_update;
return out;
"""

S34_SAVEDCHARS = r"""
const H = window.__e2e;
const out = {};
await H.loadBuild();
window.__stubOverrides.get_character_items = { ok: true, items: [] };
window.__stubOverrides.get_characters = { ok: true, characters: [{ name: 'MyWitch', league: 'Standard', level: 95, 'class': 'Necromancer' }] };
out.hiddenFirst = document.getElementById('char-saved').classList.contains('hidden');
document.getElementById('acct-input').value = 'Me#1234';
document.getElementById('acct-load').click();
await H.waitFor(() => !document.getElementById('char-compare').classList.contains('hidden'), 3000, 'chars');
document.getElementById('char-compare').click();
await H.waitFor(() => /comparing against/.test(H.text('#char-status') || ''), 4000, 'compare');
const save = document.getElementById('char-save');
out.saveShown = !save.classList.contains('hidden');
save.click();
await H.sleep(30);
out.saved = JSON.parse(localStorage.getItem('pobtf-saved-chars') || '[]');
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-saved-chars');
out.chips = [...document.querySelectorAll('#char-saved .char-chip-go')].map(b => b.textContent);
out.saveHidden = save.classList.contains('hidden');
// a fresh start: one click on the saved chip compares again, no typing
document.getElementById('acct-input').value = '';
const before = H.calls('get_character_items').length;
document.querySelector('#char-saved .char-chip-go').click();
await H.waitFor(() => H.calls('get_character_items').length > before, 3000, 'chip compare');
out.chipCall = H.calls('get_character_items').slice(-1)[0].args;
out.acct = document.getElementById('acct-input').value;
document.querySelector('#char-saved .btn-icon').click();
await H.sleep(20);
out.afterForget = JSON.parse(localStorage.getItem('pobtf-saved-chars') || '[]').length;
out.hiddenAfter = document.getElementById('char-saved').classList.contains('hidden');
delete window.__stubOverrides.get_character_items;
delete window.__stubOverrides.get_characters;
return out;
"""


S38_SHEETS2 = r"""
const H = window.__e2e;
const out = {};
const D = window.POE_CHEATSHEETS;
const route1 = D.acts['1'].route || [];
out.routeLen = route1.length;
// the build's class + gems, as saved when a build loads (the overlay reads them from storage)
localStorage.setItem('pobtf-sheet-build', JSON.stringify({ cls: 'Witch', gems: ['Freezing Pulse', 'Spell Cascade'] }));
localStorage.setItem('pobtf-sheet-prefs', JSON.stringify({ follow: true, ack: true, act: 1 }));
window.__sheetToggle();
await H.sleep(30);
out.zones = document.querySelectorAll('.sheet-route .sheet-zone').length;
const z = route1[3];
window.__sheetEvent({ type: 'area', id: z.id, level: z.level, act: 1 });
await H.sleep(30);
out.here = H.text('.sheet-zone.is-here .sheet-zone-name');
out.hereWant = z.area;
out.townLvl = [...document.querySelectorAll('.sheet-zone.is-town .sheet-zone-lvl')].length;
out.gemsTitle = [...document.querySelectorAll('.sheet-sec-title')].map(e => e.textContent).find(t => /^Gems/.test(t));
out.mine = [...document.querySelectorAll('.sheet-gem.is-mine')].map(e => e.textContent);
out.firstInRow = (document.querySelector('.sheet-gems .sheet-gem') || {}).textContent;
// a map: no zone marked
window.__sheetEvent({ type: 'area', id: 'MapWorldsBeach', level: 70, act: null });
await H.sleep(30);
out.noneOnMap = !document.querySelector('.sheet-zone.is-here');
return out;
"""

S38_VIEW = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(60);
// a long mechanic sheet gets a filter box (app only)
// (Blight's anoint tables live in the anoint helper now: use the Scarabs sheet)
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => /Scarab/.test(b.textContent)).click();
await H.sleep(60);
const f = document.querySelector('#view-sheets .sheet-filter');
out.filter = !!f;
const all = document.querySelectorAll('#view-sheets .sheet-table tbody tr').length;
const want = document.querySelector('#view-sheets .sheet-table tbody tr td').textContent;
out.want = want;
f.value = want;
f.dispatchEvent(new Event('input'));
await H.sleep(30);
const vis = [...document.querySelectorAll('#view-sheets .sheet-table tbody tr')].filter(r => r.style.display !== 'none');
out.rows = [all, vis.length];
out.hit = vis.map(r => r.textContent).join(' | ').slice(0, 200);
// gems for a picked class
[...document.querySelectorAll('#view-sheets button')].find(b => b.textContent === '← Act sheets').click();
await H.sleep(40);
const sel = [...document.querySelectorAll('#view-sheets select')].find(s => s.getAttribute('aria-label') === 'Gems for class');
sel.value = 'Marauder'; sel.dispatchEvent(new Event('change'));
await H.sleep(40);
out.gemsTitle = [...document.querySelectorAll('#view-sheets .sheet-sec-title')].map(e => e.textContent).find(t => /^Gems/.test(t));
out.newCount = (window.POE_CHEATSHEETS.mechanics || []).length;
return out;
"""


S40_ANOINT_APP = r"""
const H = window.__e2e;
const out = {};
localStorage.setItem('pobtf-sheet-build', JSON.stringify({ cls: 'Witch', gems: [], anoint: 'Whispers of Doom', treeNodes: [] }));
document.getElementById('open-sheets').click();
await H.sleep(60);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => /Blight/.test(b.textContent)).click();
await H.waitFor(() => document.querySelector('#view-sheets .anoint-row'), 3000, 'anoint rows');
await H.sleep(60);
out.tabs = [...document.querySelectorAll('#view-sheets .anoint-tab')].map(b => b.textContent);
out.bigTablesGone = ![...document.querySelectorAll('#view-sheets .sheet-sec-title')].some(t => /^Amulet anoints/.test(t.textContent));
out.firstRow = H.text('#view-sheets .anoint-row .anoint-name');  // your anoint first
// search by what a notable does
const q = document.querySelector('#view-sheets .anoint-search');
q.value = 'whispers'; q.dispatchEvent(new Event('input'));
await H.sleep(30);
const rows = () => [...document.querySelectorAll('#view-sheets .anoint-row')];
out.searchRows = rows().map(r => r.querySelector('.anoint-name').textContent);
const wod = rows()[0];
out.wodOils = [...wod.querySelectorAll('.anoint-row-oils .anoint-oil-name')].map(e => e.textContent);
out.wodCost = H.text('.anoint-cost', wod);
out.wodStats = H.text('.anoint-text', wod);
// click oils: the recipe that uses them
q.value = ''; q.dispatchEvent(new Event('input'));
wod.click();  // picks its oils
await H.sleep(30);
out.picked = [...document.querySelectorAll('#view-sheets .anoint-picked .anoint-oil-name')].map(e => e.textContent);
out.afterPick = rows().map(r => r.querySelector('.anoint-name').textContent);
out.countText = H.text('#view-sheets .anoint-count');
H.button(document.querySelector('#view-sheets .anoint-bar'), 'Clear oils').click();
await H.sleep(30);
// one oil picked: every recipe using it
[...document.querySelectorAll('#view-sheets .anoint-oil-btn')].find(b => /Golden/.test(b.textContent)).click();
await H.sleep(30);
out.goldenAll = rows().every(r => /Golden/.test(r.textContent));
out.goldenCount = H.text('#view-sheets .anoint-count');
// cheapest first
const sel = document.querySelector('#view-sheets .anoint-bar select');
sel.value = 'cost'; sel.dispatchEvent(new Event('change'));
await H.sleep(30);
const costs = rows().map(r => H.text('.anoint-cost', r));
out.sortedCosts = costs.slice(0, 3);
// ring tab
[...document.querySelectorAll('#view-sheets .anoint-tab')].find(b => /^Ring/.test(b.textContent)).click();
await H.sleep(30);
out.ringSlots = document.querySelectorAll('#view-sheets .anoint-picked > *').length;
out.calls = H.calls('anoint_oils').length;
return out;
"""

S40_ANOINT_OV = r"""
const H = window.__e2e;
const out = {};
window.__sheetOpen('blight');
await H.waitFor(() => document.querySelector('.anoint-row'), 3000, 'overlay rows');
// the overlay opens on Quick card unless Reference was picked before: the anoint helper is on Reference
const refTab = [...document.querySelectorAll('.sheet-panel button')].find(b => b.textContent.trim() === 'Reference');
if (refTab) { refTab.click(); await H.sleep(30); }
out.helperVisible = H.visible(document.querySelector('.anoint-oil-btn'));
out.noSearch = !document.querySelector('.anoint-search') && !document.querySelector('.sheet-panel input, .sheet-panel select');
['Clear', 'Black'].forEach(n => [...document.querySelectorAll('.anoint-oil-btn')].find(b => b.textContent.startsWith(n)).click());
await H.sleep(30);
out.rowsHaveBoth = [...document.querySelectorAll('.anoint-row')].every(r => /Clear/.test(r.textContent) && /Black/.test(r.textContent));
out.fits = H.calls('overlay_fit').length > 0;
return out;
"""


S41_NOBUILD = r"""
const H = window.__e2e;
const out = {};
const navKeys = () => [...document.querySelectorAll('#nav .nav-item')].map(b => b.dataset.view);
out.shell = document.body.classList.contains('shell') && H.visible(document.getElementById('sidebar'));
out.view = document.body.dataset.view;
out.landing = H.visible(document.getElementById('input-panel'));
out.nav = navKeys();
// tools without a build
const go = async k => { document.querySelector('#nav .nav-item[data-view="' + k + '"]').click(); await H.sleep(40); };
await go('search');
out.search = H.visible(document.querySelector('#tool-sections .tab-section[data-tab="search"]')) && !H.visible(document.getElementById('input-panel'));
await go('divcards');
out.divcards = H.visible(document.querySelector('#tool-sections .tab-section[data-tab="divcards"]'));
await go('uniques');
out.uniques = H.visible(document.querySelector('#tool-sections .tab-section[data-tab="uniques"]'));
out.noBulk = !H.visible(document.getElementById('open-all')) && !H.visible(document.getElementById('check-all'));
setView('gear'); // a build view without a build: the Builds page instead
out.gearFallback = document.body.dataset.view;
await go('home');
out.homeAgain = H.visible(document.getElementById('input-panel'));
return out;
"""

S41_SAVE = r"""
const H = window.__e2e;
const out = {};
const lib = () => JSON.parse(localStorage.getItem('pobtf-builds') || '[]');
await H.loadBuild();
await H.sleep(60);
const offer = [...document.querySelectorAll('.toast')].find(t => /Save this build/.test(t.textContent));
out.offer = !!offer;
H.button(offer, '☆ Save').click();
await H.sleep(40);
const dlg = document.querySelector('dialog[open]');
out.prefill = dlg.querySelector('.lib-name-input').value;
dlg.querySelector('.lib-name-input').value = 'My league starter';
H.button(dlg, 'Save').click();
await H.sleep(40);
out.saved = lib().map(b => ({ name: b.name, asc: b.asc, cls: b.cls, skill: b.skill, has: !!b.code }));
out.btn = document.getElementById('save-build').textContent;
// the Builds page: one card, sorted, searchable
document.querySelector('#nav .nav-item[data-view="home"]').click();
await H.sleep(40);
out.cards = [...document.querySelectorAll('#saved-list .saved-name')].map(e => e.textContent);
out.count = H.text('#saved-count');
// loading it again: no second offer, marked opened
const toastsBefore = document.querySelectorAll('.toast').length;
document.querySelector('#saved-list .saved-open').click();
await H.waitFor(() => document.body.dataset.view !== 'home', 5000, 'reload');
await H.sleep(60);
out.noSecondOffer = ![...document.querySelectorAll('.toast')].some(t => /Save this build/.test(t.textContent));
out.opened = !!lib()[0].opened;
// ⋯ rename
document.querySelector('#nav .nav-item[data-view="home"]').click();
await H.sleep(30);
document.querySelector('#saved-list button[aria-label^="Rename, Atlas strategy, delete"]').click();
await H.sleep(30);
const ed = document.querySelector('dialog[open]');
ed.querySelector('.lib-name-input').value = 'Renamed starter';
H.button(ed, 'Save changes').click();
await H.sleep(40);
out.renamed = lib()[0].name;
return out;
"""

S44_SETTINGS = r"""
const H = window.__e2e;
const out = {};
const panel = document.getElementById('settings-panel');
const tabs = () => [...document.querySelectorAll('#settings-tabs .settings-tab')];
const shown = () => [...panel.querySelectorAll('.settings-section')].filter(s => getComputedStyle(s).display !== 'none')
  .map(s => s.querySelector('h3').textContent);
const tab = label => tabs().find(b => b.textContent === label);
document.getElementById('settings-btn').click();
await H.sleep(30);
out.tabs = tabs().map(b => b.textContent);
out.first = [tabs().find(b => b.getAttribute('aria-selected') === 'true').textContent, shown()];
tab('Hotkeys').click(); await H.sleep(20);
out.hotkeys = shown();
document.getElementById('settings-close').click(); await H.sleep(20);
document.getElementById('settings-btn').click(); await H.sleep(30);
out.remembered = tabs().find(b => b.getAttribute('aria-selected') === 'true').textContent;
tab('Hotkeys').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await H.sleep(20);
out.arrow = [tabs().find(b => b.getAttribute('aria-selected') === 'true').textContent, document.activeElement.textContent];
// find: every tab at once, only what matches
const find = document.getElementById('settings-find');
find.value = 'tray'; find.dispatchEvent(new Event('input')); await H.sleep(20);
const visibleItems = () => [...panel.querySelectorAll('.settings-section > :not(h3)')].filter(e => e.offsetParent !== null).map(e => e.textContent.trim().slice(0, 40));
out.findTray = [shown(), visibleItems(), document.getElementById('settings-none').hidden];
find.value = 'theme'; find.dispatchEvent(new Event('input')); await H.sleep(20);
out.findTheme = shown();
find.value = 'zzzz'; find.dispatchEvent(new Event('input')); await H.sleep(20);
out.findNone = [shown().length, document.getElementById('settings-none').hidden];
find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await H.sleep(20);
out.cleared = [find.value, shown(), !panel.classList.contains('hidden')];
document.getElementById('settings-close').click(); await H.sleep(20);
// "Add POESESSID…" style: open on the tab holding a control, focused
openSettings(null, 'sessid-input'); await H.sleep(30);
out.jump = [tabs().find(b => b.getAttribute('aria-selected') === 'true').textContent, document.activeElement.id];
// POESESSID: kept on this PC, said so after a restart; Remove asks; a failed save says why
window.__stubOverrides.session_status = { ok: true, set: true };
await refreshSessionStatus(false);
const inp = document.getElementById('sessid-input');
out.saved = [inp.placeholder, H.text('#sessid-status'), !document.getElementById('sessid-remove').classList.contains('hidden')];
document.getElementById('sessid-remove').click();
await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'remove dialog');
window.__stubOverrides.set_poesessid = { ok: true, set: false };
window.__stubOverrides.session_status = { ok: true, set: false };
H.button(document.querySelector('dialog[open]'), 'Remove').click(); await H.sleep(60);
out.removed = [H.calls('set_poesessid').map(c => c.args[0]), inp.placeholder, document.getElementById('sessid-remove').classList.contains('hidden')];
localStorage.setItem('pobtf-sessid-ack', '1');
window.__stubOverrides.set_poesessid = { ok: false, error: 'disk is read-only' };
inp.value = 'abc123'; document.getElementById('sessid-save').click(); await H.sleep(60);
out.failed = [H.text('#sessid-status'), inp.value];
return out;
"""


def scenario_nobuild(s, tag):
    s.fresh()
    r = s.run(S41_NOBUILD, timeout=60)
    check(tag + " launch: sidebar + Builds page without a build", r["shell"] and r["view"] == "home" and r["landing"], r)
    check(tag + " nav: Builds + the tools that need no build, not the build ones",
          r["nav"][:1] == ["home"] and all(k in r["nav"] for k in ("search", "divcards", "uniques", "sheets", "dust", "market"))
          and not any(k in r["nav"] for k in ("gear", "planner", "tree", "timeless", "finder")), r["nav"])
    check(tag + " search text, div cards, Watcher's Eye open with no build", r["search"] and r["divcards"] and r["uniques"], r)
    check(tag + " no build: no Open all / Check all prices", r["noBulk"], r)
    check(tag + " a build-only view falls back to the Builds page", r["gearFallback"] == "home" and r["homeAgain"], r)
    s.fresh()
    r = s.run(S41_SAVE, timeout=90)
    check(tag + " importing a new build offers to save it", r["offer"], r)
    check(tag + " save asks for a name, prefilled with skill + ascendancy", " · " in (r["prefill"] or ""), r["prefill"])
    sv = (r["saved"] or [{}])[0]
    check(tag + " saved with your name, class and main skill", sv.get("name") == "My league starter" and sv.get("has")
          and (sv.get("asc") or sv.get("cls")), r["saved"])
    check(tag + " the build card shows ★ Saved", r["btn"] == "★ Saved", r["btn"])
    check(tag + " Builds page lists it", r["cards"] == ["My league starter"] and r["count"] == "1", (r["cards"], r["count"]))
    check(tag + " reloading a saved build: no second offer, marked opened", r["noSecondOffer"] and r["opened"], r)
    check(tag + " ⋯ renames it", r["renamed"] == "Renamed starter", r["renamed"])


def scenario_settings_tabs(s, tag):
    s.fresh()
    r = s.run(S44_SETTINGS, timeout=40)
    check(tag + " Settings has tabs", r["tabs"] == ["Look", "Alerts", "Hotkeys", "In game", "Account", "Updates", "Patch notes", "Help"], r["tabs"])
    check(tag + " opens on Look: Appearance + Accessibility only", r["first"] == ["Look", ["Appearance", "Accessibility"]], r["first"])
    check(tag + " a tab shows only its sections", r["hotkeys"] == ["Hotkeys"], r["hotkeys"])
    check(tag + " the last tab is remembered", r["remembered"] == "Hotkeys", r["remembered"])
    check(tag + " arrow keys move between tabs", r["arrow"] == ["In game", "In game"], r["arrow"])
    ft = r["findTray"]
    check(tag + " Find searches every tab, shows only matches", ft[0] == ["In game"] and len(ft[1]) == 1 and
          ft[1][0].startswith("Closing the window keeps the app in the") and ft[2], ft)
    check(tag + " Find matches option text too", "Appearance" in r["findTheme"], r["findTheme"])
    check(tag + " nothing found: says so", r["findNone"] == [0, False], r["findNone"])
    check(tag + " Esc clears the search, not the panel", r["cleared"][0] == "" and r["cleared"][1] == ["In game"] and
          r["cleared"][2], r["cleared"])
    check(tag + " opening on a control jumps to its tab and focuses it", r["jump"] == ["Account", "sessid-input"], r["jump"])
    check(tag + " a saved POESESSID says so after a restart, with Remove",
          r["saved"][0].startswith("Saved on this PC") and "Saved on this PC" in (r["saved"][1] or "") and r["saved"][2], r["saved"])
    check(tag + " Remove asks, then clears it", r["removed"] == [[""], "POESESSID", True], r["removed"])
    check(tag + " a failed save says why and keeps what you typed", (r["failed"][0] or "").startswith("❌ Not saved: disk is read-only")
          and r["failed"][1] == "abc123", r["failed"])


S45_PATCHNOTES = r"""
const H = window.__e2e;
const out = {};
const panel = document.getElementById('settings-panel');
const box = document.getElementById('patch-notes');
const tabs = () => [...document.querySelectorAll('#settings-tabs .settings-tab')];
const shown = () => [...panel.querySelectorAll('.settings-section')].filter(s => getComputedStyle(s).display !== 'none')
  .map(s => s.querySelector('h3').textContent);
const notes = window.POE_PATCH_NOTES;
document.getElementById('settings-btn').click(); await H.sleep(30);
tabs().find(b => b.textContent === 'Patch notes').click(); await H.sleep(20);
out.shown = shown();
const rel = () => [...box.querySelectorAll('details.pn-release')];
out.count = [rel().length, notes.length];
const first = rel()[0];
out.first = [first.dataset.version, notes[0].v, first.open, rel().slice(1).some(d => d.open),
  first.querySelector('.pn-version').textContent, (first.querySelector('.pn-title') || {}).textContent, (first.querySelector('.pn-date') || {}).textContent];
out.firstBody = first.querySelector('.pn-body').textContent.trim().length;
[...box.querySelectorAll('button')].find(b => b.textContent.startsWith('Show older releases')).click(); await H.sleep(20);
out.all = rel().length;
out.nested = !!box.querySelector('.pn-list .pn-list li');
out.bold = box.querySelectorAll('.pn-body b').length;
out.code = box.querySelectorAll('.pn-body code').length;
out.rawMarks = /\*\*|`/.test(box.textContent);
out.oldest = rel()[rel().length - 1].dataset.version;
// the installed version is marked (the e2e build's own version is not a release)
out.noMarkDev = box.querySelectorAll('.pn-installed').length;
window.APP_VERSION = notes[1].v.slice(1); renderPatchNotes();
out.marked = [...box.querySelectorAll('.pn-installed')].map(c => c.closest('details').dataset.version);
// a newer release out: says so above the notes
markPatchNotes({ ok: true, current: notes[1].v.slice(1), latest: 'v9.9.9', newer: true });
const upd = document.getElementById('patch-notes-update');
out.update = [upd.hidden, upd.textContent];
markPatchNotes({ ok: true, current: notes[1].v.slice(1), latest: notes[1].v, newer: false });
out.updateGone = upd.hidden;
// notes are data: markup in a note stays text; links open through the app
window.POE_PATCH_NOTES = [{ v: 'v9.9.9', date: '2099-01-01', title: '<img src=x onerror="window.__pnHacked=1">',
  blocks: [{ p: [['t', '<b>not bold</b> '], ['a', 'the wiki', 'https://www.poewiki.net/wiki/Test']] }] }];
renderPatchNotes(); await H.sleep(20);
out.inject = [box.querySelectorAll('img').length, box.querySelectorAll('.pn-body b').length, box.textContent.indexOf('<img') !== -1, !!window.__pnHacked];
const n0 = H.calls('open_url').length;
box.querySelector('.pn-body a').click(); await H.sleep(20);
out.link = (H.calls('open_url')[n0] || { args: [''] }).args[0];
window.POE_PATCH_NOTES = notes; window.APP_VERSION = null; renderPatchNotes();
// Find searches settings, not the notes
const find = document.getElementById('settings-find');
find.value = 'diagnostics'; find.dispatchEvent(new Event('input')); await H.sleep(20);
out.find = shown();
find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await H.sleep(20);
out.back = shown();
document.getElementById('settings-close').click(); await H.sleep(20);
return out;
"""


def scenario_patch_notes(s, tag):
    s.fresh()
    r = s.run(S45_PATCHNOTES, timeout=40)
    check(tag + " Patch notes tab shows only the notes", r["shown"] == ["Patch notes"], r["shown"])
    check(tag + " newest 6 releases first, the rest behind Show older", r["count"][0] == 6 and r["count"][1] > 6 and
          r["all"] == r["count"][1] and r["oldest"] == "v2.0.0", (r["count"], r["all"], r["oldest"]))
    f = r["first"]
    check(tag + " the newest release is open with version, title and date", f[0] == f[1] and f[2] and not f[3] and
          f[4] == f[1] and f[5] and len(f[6] or "") == 10 and r["firstBody"] > 20, f)
    check(tag + " markdown drawn: nested lists, bold, code; no raw ** or `", r["nested"] and r["bold"] > 5 and
          r["code"] > 0 and not r["rawMarks"], (r["nested"], r["bold"], r["code"], r["rawMarks"]))
    check(tag + " the installed version is marked (not on a dev build)", r["noMarkDev"] == 0 and len(r["marked"]) == 1,
          (r["noMarkDev"], r["marked"]))
    check(tag + " a newer release out: says so, gone when up to date", r["update"][0] is False and
          r["update"][1].startswith("v9.9.9 is out") and r["updateGone"] is True, (r["update"], r["updateGone"]))
    check(tag + " markup in a note stays text", r["inject"] == [0, 0, True, False], r["inject"])
    check(tag + " links open in the browser through the app", r["link"] == "https://www.poewiki.net/wiki/Test", r["link"])
    check(tag + " Find skips the notes", "Patch notes" not in r["find"] and r["back"] == ["Patch notes"], (r["find"], r["back"]))


def scenario_anoints(s, tag):
    s.fresh()
    r = s.run(S40_ANOINT_APP, timeout=60)
    check(tag + " Blight sheet has the anoint helper: amulet / ring / map, not the long tables",
          len(r["tabs"]) == 3 and r["tabs"][0].startswith("Amulet") and r["bigTablesGone"], r["tabs"])
    check(tag + " your build's anoint is listed first", (r["firstRow"] or "").startswith("Whispers of Doom"), r["firstRow"])
    check(tag + " search finds a notable, with its stats, oils and price", r["searchRows"] and
          r["searchRows"][0].startswith("Whispers of Doom") and len(r["wodOils"]) == 3 and r["wodStats"] and
          r["wodCost"].endswith("c"), (r["searchRows"][:2], r["wodOils"], r["wodCost"]))
    check(tag + " clicking a row picks its oils and shows what they make", r["picked"] == r["wodOils"] and
          r["afterPick"][:1] and r["afterPick"][0].startswith("Whispers of Doom") and "make" in (r["countText"] or ""),
          (r["picked"], r["afterPick"][:2], r["countText"]))
    check(tag + " one oil picked lists every recipe using it", r["goldenAll"] and "match" in (r["goldenCount"] or ""), r["goldenCount"])
    check(tag + " cheapest first by oil prices", r["sortedCosts"] and all(c == r["sortedCosts"][0] or c for c in r["sortedCosts"])
          and r["sortedCosts"][0] <= r["sortedCosts"][-1] if r["sortedCosts"] else False, r["sortedCosts"])
    check(tag + " ring anoints take 2 oils", r["ringSlots"] == 2, r["ringSlots"])
    check(tag + " oil prices asked once (exchange feed)", r["calls"] == 1, r["calls"])
    s.fresh("?sheet=1")
    r = s.run(S40_ANOINT_OV, timeout=60)
    check(tag + " over the game: the helper is on the Reference tab; click oils, no typing", r["helperVisible"] and
          r["noSearch"] and r["rowsHaveBoth"] and r["fits"], r)


S43_LOOTFILTER = r"""
const H = window.__e2e;
const out = {};
await H.loadBuild();
// a small NeverSink-style filter: tagged currency tiers (best first), a hide tier, rares
const FILTER = ['#==========', "# NeverSink's Indepth Loot Filter", '# TYPE:     3-STRICT', '# VERSION:  8.20', '#==========', '',
  '#----- [[0100]] Currency',
  'Show # $type->currency $tier->t1exalted', '\tClass == "Stackable Currency"', '\tBaseType == "Mirror of Kalandra" "Divine Orb" "Chaos Orb"',
  '\tSetFontSize 45', '\tSetTextColor 255 0 0 255', '\tPlayAlertSound 6 300', '',
  'Show # $type->currency $tier->t2divine', '\tClass == "Stackable Currency"', '\tBaseType == "Exalted Orb" "Orb of Annulment" "Vaal Orb"',
  '\tSetFontSize 40', '',
  'Show # $type->currency $tier->t4chaos', '\tClass == "Stackable Currency"',
  '\tBaseType == "Orb of Alteration" "Chromatic Orb" "Jeweller\'s Orb" "Orb of Fusing"', '\tSetFontSize 35', '',
  'Hide # $type->currency $tier->t9hide', '\tClass == "Stackable Currency"',
  '\tBaseType == "Scroll of Wisdom" "Portal Scroll" "Orb of Transmutation"', '',
  'Show # $type->rares $tier->any', '\tRarity Rare', '\tSetFontSize 32', ''].join('\r\n');
const price = (name, c) => ({ name: name, cat: 'Currency', img: '', s: [[1, c, 100]] });
window.__stubOverrides.filter_list = { ok: true, dir: 'C:\\Users\\me\\Documents\\My Games\\Path of Exile', exists: true,
  filters: [{ name: 'Test.filter', size: FILTER.length, mtime: 100 }] };
window.__stubOverrides.filter_read = { ok: true, text: FILTER, bom: false, eol: '\r\n', mtime: 100, size: FILTER.length };
window.__stubOverrides.filter_write = { ok: true, mtime: 101, checkpoint: '20261101-100000' };
window.__stubOverrides.filter_checkpoints = { ok: true, name: 'Test.filter', checkpoints: [
  { id: '20261101-100000', label: 'before save', size: 4096, time: 1793520000 }] };
window.__stubOverrides.filter_restore = { ok: true, mtime: 102, checkpoint: '20261101-100100', restored: '20261101-100000' };
window.__stubOverrides.unique_prices = { ok: true, divine: 200, items: [] };
window.__stubOverrides.cx_overview = { ok: true, hour: 1, items: {
  mirror: price('Mirror of Kalandra', 30000), divine: price('Divine Orb', 200), chaos: price('Chaos Orb', 1),
  exalted: price('Exalted Orb', 15), annul: price('Orb of Annulment', 20), vaal: price('Vaal Orb', 1),
  alt: price('Orb of Alteration', 0.1), chrome: price('Chromatic Orb', 0.1), jew: price("Jeweller's Orb", 0.1), fuse: price('Orb of Fusing', 0.3),
  wis: price('Scroll of Wisdom', 0.01), port: price('Portal Scroll', 0.02), trans: price('Orb of Transmutation', 0.02) } };
out.nav = [...document.querySelectorAll('#nav .nav-item')].some(b => b.dataset.view === 'filter' && b.querySelector('.ni-filter'));
setView('filter');
const view = document.getElementById('view-filter');
await H.waitFor(() => view.querySelector('.filt-summary') && view.querySelector('.filt-body tbody tr'), 4000, 'filter page + re-tier');
out.summary = H.text('.filt-summary', view);
// price re-tier: Chaos Orb (1c) sits in t1 (median 200c) and Vaal Orb (1c) in t2: both fit t4 now
const moveRows = () => [...view.querySelectorAll('.filt-body tbody tr')].map(r => r.children[1].textContent + ' | ' + r.children[4].textContent + ' > ' + r.children[5].textContent);
out.moves = moveRows();
view.querySelectorAll('.filt-body tbody input[type=checkbox]').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change')); });
H.button(view, 'Use the ticked re-tiers').click(); await H.sleep(30);
out.pending = H.text('.filt-pending', view);
// your rules: hide Portal Scroll
H.button(view.querySelector('.trades-tabs'), 'Your rules').click(); await H.sleep(30);
const form = view.querySelector('.filt-form');
const [vis, cls, bases, rar, ilvl, look, label] = form.querySelectorAll('select, input');
vis.value = 'Hide'; bases.value = 'Portal Scroll'; label.value = 'no portals';
H.button(form, 'Add rule').click(); await H.sleep(30);
out.rules = [...view.querySelectorAll('.filt-rule-text')].map(e => e.textContent);
// build items
H.button(view.querySelector('.trades-tabs'), 'Build items').click(); await H.sleep(30);
view.querySelector('.filt-body .toggle input').click(); await H.sleep(30);
out.buildList = view.querySelectorAll('.filt-list li').length;
// save: one write, after the read, with the section in it
const w0 = H.calls('filter_write').length;
H.button(view, 'Save to filter').click();
await H.waitFor(() => H.calls('filter_write').length > w0, 3000, 'write');
const wr = H.calls('filter_write')[w0].args;
out.write = { name: wr[0], mtime: wr[2], bom: wr[3], hasMarkers: wr[1].includes(LootFilter.MARK_START) && wr[1].includes(LootFilter.MARK_END),
  crlf: !/[^\r]\n/.test(wr[1]), tail: wr[1].endsWith(FILTER.slice(-40)), body: wr[1].includes(FILTER.split('#----- [[0100]] Currency')[1]) };
const written = LootFilter.parse(wr[1]);
const chaos = LootFilter.matchItem(written, { class: 'Stackable Currency', base: 'Chaos Orb', rarity: 'Normal' });
const portal = LootFilter.matchItem(written, { class: 'Stackable Currency', base: 'Portal Scroll', rarity: 'Normal' });
out.matched = { chaosManaged: chaos.block.managed, chaosFont: (chaos.block.actions.find(a => a.key === 'SetFontSize') || { args: [] }).args[0],
  portal: portal.block.managed && portal.block.visibility, mirror: LootFilter.matchItem(written,
    { class: 'Stackable Currency', base: 'Mirror of Kalandra', rarity: 'Normal' }).block.tags.tier };
out.removed = LootFilter.applyManaged(wr[1], '') === FILTER;
// find an item: paste the in-game text
H.button(view.querySelector('.trades-tabs'), 'Find an item').click(); await H.sleep(30);
view.querySelector('.filt-body textarea').value = 'Item Class: Stackable Currency\nRarity: Currency\nDivine Orb\n--------\nStack Size: 3/20';
H.button(view, 'Find its block').click(); await H.sleep(30);
out.find = H.text('.filt-match', view);
// checkpoints: listed, restore asks first, then restores
H.button(view.querySelector('.trades-tabs'), 'Checkpoints').click();
await H.waitFor(() => view.querySelector('.filt-body tbody tr td'), 3000, 'checkpoints');
out.cps = [...view.querySelectorAll('.filt-body tbody tr')].map(r => r.children[1].textContent);
const r0 = H.calls('filter_restore').length;
H.button(view.querySelector('.filt-body tbody'), 'Restore').click();
await H.waitFor(() => document.querySelector('dialog[open]'), 3000, 'confirm');
out.asked = H.calls('filter_restore').length === r0;
H.button(document.querySelector('dialog[open]'), 'Restore').click();
await H.waitFor(() => H.calls('filter_restore').length > r0, 3000, 'restore');
out.restore = H.calls('filter_restore')[r0].args;
out.gameInput = H.calls('trade_send').length + H.calls('game_search_paste').length;
['filter_list', 'filter_read', 'filter_write', 'filter_checkpoints', 'filter_restore', 'unique_prices', 'cx_overview']
  .forEach(k => delete window.__stubOverrides[k]);
return out;
"""


def scenario_lootfilter(s, tag):
    s.fresh()
    r = s.run(S43_LOOTFILTER, timeout=90)
    check(tag + " Tools → Loot filter with its icon", r["nav"], r["nav"])
    check(tag + " summary: blocks, filter type, no app section yet", "5 blocks" in r["summary"] and "3-STRICT" in r["summary"]
          and "no app section yet" in r["summary"], r["summary"])
    check(tag + " price re-tier finds the mis-tiered items (by today's prices)", len(r["moves"]) == 2
          and any(m.startswith("Chaos Orb") and "t1exalted" in m and "> t4chaos" in m for m in r["moves"])
          and any(m.startswith("Vaal Orb") and "t2divine" in m and "> t4chaos" in m for m in r["moves"]), r["moves"])
    check(tag + " ticked re-tiers wait for Save", "2 re-tiers" in (r["pending"] or ""), r["pending"])
    check(tag + " your rule added", any("no portals" in x and "Portal Scroll" in x for x in r["rules"]), r["rules"])
    check(tag + " build items listed from the loaded build", r["buildList"] > 0, r["buildList"])
    w = r["write"]
    check(tag + " save writes the section, keeps CRLF, checks the file hasn't changed since read (mtime)",
          w["name"] == "Test.filter" and w["hasMarkers"] and w["crlf"] and w["mtime"] == 100 and w["bom"] is False, w)
    check(tag + " the filter's own blocks are left exactly as they were", w["body"] and w["tail"], w)
    m = r["matched"]
    check(tag + " written filter: Chaos Orb now shown like t4 (font 35), Portal Scroll hidden, Mirror untouched",
          m["chaosManaged"] and m["chaosFont"] == 35 and m["portal"] == "Hide" and m["mirror"] == "t1exalted", m)
    check(tag + " removing the section gives back the original file byte for byte", r["removed"])
    check(tag + " find an item: pasted Divine Orb → its block and tier", "Shown by block 1" in (r["find"] or "")
          and "t1exalted" in r["find"], r["find"])
    check(tag + " checkpoints listed; restore asks first, then restores that one", r["cps"] == ["before save"] and r["asked"]
          and r["restore"] == ["Test.filter", "20261101-100000"], (r["cps"], r["asked"], r["restore"]))
    check(tag + " nothing sent to the game", r["gameInput"] == 0, r["gameInput"])


S47_FILTEREDIT = r"""
const H = window.__e2e;
const out = {};
const FILTER = ['#----- [[0100]] Currency',
  'Show # $type->currency $tier->t1exalted', '\tClass == "Stackable Currency"', '\tBaseType == "Mirror of Kalandra" "Divine Orb" "Chaos Orb"',
  '\tSetFontSize 45', '\tSetTextColor 255 0 0 255', '\tPlayAlertSound 6 300', '',
  'Show # $type->currency $tier->t2divine', '\tClass == "Stackable Currency"', '\tBaseType == "Exalted Orb" "Vaal Orb"',
  '\tSetFontSize 40', '',
  'Show # $type->currency $tier->t4chaos', '\tClass == "Stackable Currency"', '\tBaseType == "Orb of Alteration" "Orb of Fusing"',
  '\tSetFontSize 35', '',
  'Hide # $type->currency $tier->t9hide', '\tClass == "Stackable Currency"', '\tBaseType == "Portal Scroll" "Scroll of Wisdom"', ''].join('\r\n');
const price = (name, c) => ({ name: name, cat: 'Currency', img: '', s: [[1, c, 100]] });
window.__stubOverrides.filter_list = { ok: true, dir: 'C:\\x', exists: true, filters: [{ name: 'Test.filter', size: 1, mtime: 100 }] };
window.__stubOverrides.filter_read = { ok: true, text: FILTER, bom: false, eol: '\r\n', mtime: 100, size: FILTER.length };
window.__stubOverrides.filter_write = { ok: true, mtime: 101, checkpoint: '20261101-100000' };
window.__stubOverrides.filter_reload = { ok: true };
window.__stubOverrides.filter_online_status = { ok: true, imported: false };
window.__stubOverrides.quick_price = { ok: true, source: 'GGG currency exchange', chaos: 1 };
window.__stubOverrides.unique_prices = { ok: true, divine: 200, items: [] };
window.__stubOverrides.cx_overview = { ok: true, hour: 1, items: {
  mirror: price('Mirror of Kalandra', 30000), divine: price('Divine Orb', 200), chaos: price('Chaos Orb', 1),
  exalted: price('Exalted Orb', 15), vaal: price('Vaal Orb', 1), alt: price('Orb of Alteration', 0.1), fuse: price('Orb of Fusing', 0.3),
  wis: price('Scroll of Wisdom', 0.01), port: price('Portal Scroll', 0.02) } };
try { localStorage.removeItem('pobtf-filter-edits'); localStorage.removeItem('pobtf-filter-tips'); } catch (e) {}
const ITEM = 'Item Class: Stackable Currency\nRarity: Currency\nChaos Orb\n--------\nStack Size: 3/20';
const root = () => document.getElementById('fedit');
const writes = () => H.calls('filter_write');
const reloads = () => H.calls('filter_reload').length;
const saveBtn = () => root().querySelector('.fe-hero .fe-save');
const dd = () => document.getElementById('fe-dd-layer');
const edits = () => JSON.parse(localStorage.getItem('pobtf-filter-edits') || '{}')['Test.filter'] || [];
const tierBases = (txt, tier) => (LootFilter.parse(txt).blocks.find(b => b.tags.tier === tier).conditions
  .find(c => c.key === 'BaseType') || { values: [] }).values;
async function press() {
  window.__filterEditItem(ITEM, { level: 68, id: 'MapWorldsStrand', time: 'x' });
  await H.waitFor(() => document.body.classList.contains('fedit-on') && root().querySelector('.fe-hero'), 4000, 'editor');
  await H.sleep(50);
}
async function settle(n, what) { await H.waitFor(() => reloads() === n && !FE.busy, 3000, what); await H.sleep(40); }
async function openDropdown() {
  root().querySelector('.fe-switch').click();
  await H.waitFor(() => dd(), 2000, 'dropdown');
}
await press();
out.title = H.text('#overlay-bar .ov-title');
out.priceHidden = getComputedStyle(document.getElementById('results')).display === 'none';
out.hero = [H.text('.fe-hero-name'), !!root().querySelector('.fe-hero .fe-art img'), H.text('.fe-hero .fe-price')];
out.switchTier = H.text('.fe-switch-tier');
out.zone = H.text('.fe-zone');
out.saveIdle = saveBtn().disabled && !saveBtn().classList.contains('is-dirty');
// Switch Tier: every tier's label, the current one marked, a Hide row that says what it does
await openDropdown();
out.tiers = [...dd().querySelectorAll('.fe-dd-row:not(.fe-dd-hide) .fe-dd-tier')].map(e => e.textContent);
out.current = H.text('.fe-dd-row.is-current .fe-dd-tier', dd());
out.hideText = H.text('.fe-dd-hide .fe-dd-explain', dd());
out.labelPx = getComputedStyle(dd().querySelector('.fe-dd-row.is-current .fe-label')).fontSize;
let w0 = writes().length;
[...dd().querySelectorAll('.fe-dd-row')].find(r => r.textContent.includes('T4 Chaos')).click();
await H.waitFor(() => writes().length > w0, 3000, 'move write');
let txt = writes()[w0].args[1];
out.move = { mtime: writes()[w0].args[2], crlf: !/[^\r]\n/.test(txt), t1: tierBases(txt, 't1exalted'), t4: tierBases(txt, 't4chaos') };
await settle(1, 'move saved');
out.switchAfter = H.text('.fe-switch-tier');
out.recorded = edits().map(c => c.kind);
// History: the newest edit can be undone; undo drops its recorded edit
H.button(root().querySelector('.fe-banner'), 'History (1)').click();
await H.sleep(30);
out.histRow = H.text('.fe-hist-row.is-newest .fe-hist-text');
w0 = writes().length;
root().querySelector('.fe-undo').click();
await H.waitFor(() => writes().length > w0, 3000, 'undo write');
await settle(2, 'undo saved');
out.undo = writes()[w0].args[1] === FILTER;
out.recordedAfterUndo = edits().length;
H.button(root().querySelector('.fe-banner'), '← Back to item').click();
await H.sleep(30);
// a look edit (font 45 -> 40) waits for Save; Save turns gold, then "Saved"
const fs = root().querySelector('.fe-font input[type=range]');
fs.value = '40'; fs.dispatchEvent(new Event('change'));
await H.sleep(30);
out.dirty = saveBtn().classList.contains('is-dirty') && !saveBtn().disabled;
out.waits = writes().length === w0 + 1;
w0 = writes().length;
saveBtn().click();
await H.waitFor(() => writes().length > w0, 3000, 'style write');
txt = writes()[w0].args[1];
out.font = txt.includes('\tSetFontSize 40\r\n\tSetTextColor 255 0 0 255') && txt.split('SetFontSize 40').length === 3;
await settle(3, 'style saved');
out.saved = saveBtn().textContent;
out.recordedStyle = edits().map(c => c.kind + ':' + (c.action || ''));
// colour picker: "Most used" text colours from the filter; Escape closes it
root().querySelectorAll('.fe-swatch')[0].click();
await H.waitFor(() => document.getElementById('fe-pop-layer'), 2000, 'picker');
out.freq = [...document.querySelectorAll('#fe-pop-layer .fe-freq-sw')].map(s => s.title);
document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await H.sleep(30);
out.pickerClosed = !document.getElementById('fe-pop-layer') && !saveBtn().classList.contains('is-dirty') &&
  H.calls('overlay_hide').length === 0;
// manual hex on the (unset) background keeps its alpha
root().querySelectorAll('.fe-swatch')[2].click();
await H.waitFor(() => document.getElementById('fe-pop-layer'), 2000, 'picker 2');
const hex = document.querySelector('#fe-pop-layer .fe-man-row input');
hex.value = '102030'; hex.dispatchEvent(new Event('input')); hex.dispatchEvent(new Event('change'));
await H.sleep(30);
// effects: minimap Large Star, Blue beam
root().querySelector('.fe-effects-head').click();
await H.sleep(30);
H.button(root().querySelector('.fe-btn-group'), 'Large').click();
await H.sleep(20);
root().querySelector('.fe-shape-tile[title="Star"]').click();
await H.sleep(20);
root().querySelector('.fe-beam-cell[title="Blue"]').click();
await H.sleep(20);
out.shapes = root().querySelectorAll('.fe-shape-tile svg').length;
w0 = writes().length;
saveBtn().click();
await H.waitFor(() => writes().length > w0, 3000, 'effects write');
txt = writes()[w0].args[1];
out.effects = { bg: txt.includes('SetBackgroundColor 16 32 48 240'), icon: txt.includes('MinimapIcon 0 Red Star'),
  beam: txt.includes('PlayEffect Blue') };
await settle(4, 'effects saved');
// Hide from the dropdown
await openDropdown();
w0 = writes().length;
dd().querySelector('.fe-dd-hide').click();
await H.waitFor(() => writes().length > w0, 3000, 'hide write');
txt = writes()[w0].args[1];
out.hidden = LootFilter.matchItem(LootFilter.parse(txt), { class: 'Stackable Currency', base: 'Chaos Orb', rarity: 'Normal' }).visibility;
await settle(5, 'hide saved');
out.hiddenTag = H.text('.fe-switch .fe-hidden-tag');
// economy audit of the tier it's in now (t9hide: Portal 0.02, Wisdom 0.01, Chaos 1)
H.button(root(), 'Run Economy Audit').click();
await H.sleep(40);
out.auditRows = root().querySelectorAll('.fe-arow').length;
out.auditBar = H.text('.fe-mbar.is-up .fe-mbar-tab span');
w0 = writes().length;
root().querySelector('.fe-mbar.is-up .fe-mbar-go').click();
await H.waitFor(() => writes().length > w0, 3000, 'audit write');
txt = writes()[w0].args[1];
out.audit = { t4: tierBases(txt, 't4chaos'), t9: tierBases(txt, 't9hide') };
await settle(6, 'audit saved');
out.auditMsg = H.text('.fe-audit-list .fe-gold');
H.button(root().querySelector('.fe-banner'), '← Back to item').click();
await H.sleep(30);
// reload in game can be switched off (Ctrl+Z undo here)
PREFS.filterReload = false;
w0 = writes().length;
document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
await H.waitFor(() => writes().length > w0, 3000, 'ctrl+z');
await H.sleep(80);
out.noReload = reloads() === 6;
PREFS.filterReload = true;
// Ctrl+D afterwards: back to the price check
window.__overlayItem(ITEM);
await H.sleep(50);
out.backToPrice = !document.body.classList.contains('fedit-on') && H.text('#overlay-bar .ov-title') === 'Price check';
out.gameInput = H.calls('trade_send').length + H.calls('game_search_paste').length + H.calls('filter_switch').length;
// an imported online filter: "Check for Filter Updates" = /itemfilter <online>; then "Update" replays + switches back
const ONLINE = '#Online Item Filter\r\n#name: Main\r\n#hash:v2\r\n' + FILTER.replace('"Exalted Orb" "Vaal Orb"', '"Exalted Orb" "Vaal Orb" "Orb of Annulment"');
window.__stubOverrides.filter_online_status = { ok: true, imported: true, online: 'id1', name: 'Main', version: 'v1', current: 'v1',
  changed: false, missing: false };
window.__stubOverrides.filter_online_read = { ok: true, text: ONLINE, name: 'Main', version: 'v2', mtime: 5, eol: '\r\n' };
window.__stubOverrides.filter_online_mark = { ok: true };
await press();
H.button(root().querySelector('.fe-banner'), 'Check for Filter Updates').click();
await H.waitFor(() => H.calls('filter_switch').length === 1, 3000, 'check');
out.step1 = H.calls('filter_switch')[0].args;
window.__stubOverrides.filter_online_status = Object.assign({}, window.__stubOverrides.filter_online_status, { current: 'v2', changed: true });
await H.waitFor(() => root().querySelector('.fe-banner') && H.text('.fe-banner').includes('Filter Update Available'), 4000, 'update found');
out.banner = H.text('.fe-banner-name');
w0 = writes().length;
H.button(root().querySelector('.fe-banner'), 'Update').click();
await H.waitFor(() => H.calls('filter_switch').length === 2, 3000, 'update');
txt = writes()[w0].args[1];
out.update = { name: txt.startsWith('#Online Item Filter\r\n#name: Test\r\n'), newTier: txt.includes('"Orb of Annulment"'),
  myFont: txt.includes('\tSetFontSize 40\r\n\tSetTextColor'), myIcon: txt.includes('MinimapIcon 0 Red Star'),
  mark: H.calls('filter_online_mark')[0].args, back: H.calls('filter_switch')[1].args };
['filter_list', 'filter_read', 'filter_write', 'filter_reload', 'filter_online_status', 'filter_online_read', 'filter_online_mark',
 'quick_price', 'unique_prices', 'cx_overview'].forEach(k => delete window.__stubOverrides[k]);
return out;
"""


def scenario_filter_editor(s, tag):
    s.fresh("?overlay=1")
    r = s.run(S47_FILTEREDIT, timeout=90)
    check(tag + " Ctrl+Shift+D: the price-check window becomes the filter editor", r["title"] == "Loot filter"
          and r["priceHidden"], (r["title"], r["priceHidden"]))
    check(tag + " hero: name, art, price chip", r["hero"][0] == "Chaos Orb" and r["hero"][1] and r["hero"][2], r["hero"])
    check(tag + " shows the item's tier; zone level offered (map zone)", r["switchTier"] == "T1 Exalted" and "68" in r["zone"],
          (r["switchTier"], r["zone"]))
    check(tag + " Save is grey until there's something to save", r["saveIdle"])
    check(tag + " Switch Tier lists every tier with its label; current marked; game-size label (45 x 0.48)",
          r["tiers"] == ["T1 Exalted", "T2 Divine", "T4 Chaos", "T9 Hide"] and r["current"] == "T1 Exalted"
          and r["labelPx"] == "22px", (r["tiers"], r["current"], r["labelPx"]))
    check(tag + " the Hide row says what hiding will do", "T9 Hide" in (r["hideText"] or ""), r["hideText"])
    m = r["move"]
    check(tag + " Switch tier writes at once: base moved t1 -> t4, CRLF kept, mtime checked", m["mtime"] == 100 and m["crlf"]
          and m["t1"] == ["Mirror of Kalandra", "Divine Orb"] and m["t4"][-1] == "Chaos Orb", m)
    check(tag + " /reloaditemfilter once; panel on the new tier; move recorded", r["switchAfter"] == "T4 Chaos"
          and r["recorded"] == ["move-basetype"], (r["switchAfter"], r["recorded"]))
    check(tag + " History: the edit listed; Undo writes the old file back and drops it", "Moved" in (r["histRow"] or "")
          and r["undo"] and r["recordedAfterUndo"] == 0, (r["histRow"], r["undo"], r["recordedAfterUndo"]))
    check(tag + " look edits wait for Save (gold), then change only that line, then Saved", r["dirty"] and r["waits"]
          and r["font"] and r["saved"] == "Saved", (r["dirty"], r["waits"], r["font"], r["saved"]))
    check(tag + " the look edit is recorded", r["recordedStyle"] == ["set-action:SetFontSize"], r["recordedStyle"])
    check(tag + " colour picker offers the filter's most used colours; Esc closes it unchanged",
          r["freq"] == ["255 0 0 (Stackable Currency)"] and r["pickerClosed"], (r["freq"], r["pickerClosed"]))
    check(tag + " background (manual hex, alpha kept), minimap icon and beam saved together",
          r["effects"] == {"bg": True, "icon": True, "beam": True} and r["shapes"] == 12, (r["effects"], r["shapes"]))
    check(tag + " Hide from the dropdown hides the item", r["hidden"] == "Hide" and r["hiddenTag"] == "[HIDDEN]",
          (r["hidden"], r["hiddenTag"]))
    a = r["audit"]
    check(tag + " economy audit: rows priced, move the dearer bases up a tier (the tier keeps one)", r["auditRows"] == 3
          and "Move the 2 items above to" in (r["auditBar"] or "") and a["t4"][-2:] == ["Chaos Orb", "Portal Scroll"]
          and a["t9"] == ["Scroll of Wisdom"] and "Moved 2 items to T4 Chaos" in (r["auditMsg"] or ""), (r["auditRows"], r["auditBar"], a, r["auditMsg"]))
    check(tag + " reload in game can be switched off", r["noReload"])
    check(tag + " Ctrl+D afterwards: back to the price check", r["backToPrice"])
    check(tag + " no other game input", r["gameInput"] == 0, r["gameInput"])
    check(tag + " Check for Filter Updates: /itemfilter <online name>, nothing else", r["step1"] == ["Main"], r["step1"])
    u = r["update"]
    check(tag + " update found -> Update: my edits on the new version, baseline moved, switched back",
          "Filter Update Available" in (r["banner"] or "") and u["name"] and u["newTier"] and u["myFont"] and u["myIcon"]
          and u["mark"] == ["Test.filter", "id1", "v2"] and u["back"] == ["Test.filter"], (r["banner"], u))


def scenario_sheets2(s, tag):
    s.fresh("?sheet=1")
    r = s.run(S38_SHEETS2, timeout=60)
    check(tag + " act route drawn in order", r["routeLen"] >= 6 and r["zones"] == r["routeLen"], (r["routeLen"], r["zones"]))
    check(tag + " the zone you're in is marked on the route", r["here"] == r["hereWant"], (r["here"], r["hereWant"]))
    check(tag + " towns show no level", r["townLvl"] == 0, r["townLvl"])
    check(tag + " gems for your build's class, your gems marked and first", r["gemsTitle"] == "Gems · Witch" and
          "Freezing Pulse" in r["mine"] and r["firstInRow"] in r["mine"], (r["gemsTitle"], r["mine"], r["firstInRow"]))
    check(tag + " a map marks no zone", r["noneOnMap"], r)
    s.fresh()
    r = s.run(S38_VIEW, timeout=60)
    check(tag + " long sheets get a filter that narrows rows", r["filter"] and r["rows"][0] > 100 and
          0 < r["rows"][1] < 10 and r["want"] in (r["hit"] or ""), (r["rows"], r["hit"]))
    check(tag + " gems for a picked class", r["gemsTitle"] == "Gems · Marauder", r["gemsTitle"])
    check(tag + " 20+ mechanic sheets", r["newCount"] >= 20, r["newCount"])


def scenario_ui_batch(s, tag):
    s.fresh()
    r = s.run(S34_UPDATE, timeout=60)
    check(tag + " update banner: version once, no double dash, what's new from the notes",
          r["label"] == "PoB Trade Finder v2.5.4 is ready" and "--" not in (r["bannerText"] or "") and
          "vv" not in r["bannerText"] and "Socket colours in the gem compare" in (r["summary"] or "")
          and "You have v2.5.3" in r["summary"], (r["label"], r["summary"]))
    check(tag + " Settings → Check for updates gets its own Update now", r["settingsBtn"] == "Update now" and
          "v2.5.4 is ready" in (r["status"] or ""), (r["settingsBtn"], r["status"]))
    check(tag + " What's new opens the release page; Later hides the banner", r["notesOpened"] ==
          ["https://github.com/x/y/releases/tag/v2.5.4"] and r["hiddenAfterLater"], r)
    check(tag + " Update now in Settings installs that release", r["applied"] ==
          ["https://github.com/x/y/releases/download/v2.5.4/PoBTradeFinder-v2.5.4.zip"] and r["busy"], r["applied"])
    s.fresh()
    r = s.run(S34_SAVEDCHARS, timeout=60)
    check(tag + " no saved characters yet: no row", r["hiddenFirst"], r)
    check(tag + " ☆ Save after a compare keeps it (shared storage)", r["saveShown"] and r["persisted"] and
          r["saved"][:1] and r["saved"][0]["account"] == "Me#1234" and r["saved"][0]["name"] == "MyWitch" and
          r["saved"][0]["cls"] == "Necromancer" and r["saveHidden"], r["saved"])
    check(tag + " saved chip shows name, class, level, account", r["chips"] and "MyWitch" in r["chips"][0] and
          "Necromancer lvl 95" in r["chips"][0] and "Me#1234" in r["chips"][0], r["chips"])
    check(tag + " one click on it compares again without typing", r["chipCall"] == ["Me#1234", "MyWitch"] and
          r["acct"] == "Me#1234", (r["chipCall"], r["acct"]))
    check(tag + " ✕ forgets it", r["afterForget"] == 0 and r["hiddenAfter"], r)


def scenario_mechanics(s, tag):
    s.fresh("?sheet=1")
    r = s.run(S32_MECH_SHEET, timeout=60)
    check(tag + " mechanic sheets shipped (8+)", r["count"] >= 8, r["ids"])
    check(tag + " ☰ lists the act sheet and every mechanic", len(r["picks"]) == r["count"] + 1 and
          r["picks"][0].startswith("📜"), r["picks"])
    check(tag + " a mechanic sheet shows its rows and credits the wiki", r["rows"] > 0 and r["title"] == r["picks"][1]
          and "CC BY-NC-SA" in (r["foot"] or ""), (r["title"], r["rows"], r["foot"]))
    check(tag + " overlay sheet takes no typing", r["inputs"] == 0, r["inputs"])
    check(tag + " ‹ goes back to the act sheet", (r["backTitle"] or "").startswith("Act "), r["backTitle"])
    check(tag + " Open from the hint shows that sheet", r["openTitle"] == r["lastTitle"], r)
    s.fresh("?sheethint=1")
    r = s.run(S32_HINT, timeout=60)
    check(tag + " some mechanic has area triggers", r["has"], r)
    if r["has"]:
        check(tag + " hint window hidden until a suggestion", r["firstVisible"] == ["hint", False], r["firstVisible"])
        check(tag + " no suggestions without reading the log", r["realIgnored"], r)
        check(tag + " entering the area pops a small suggestion", r["shown"] and (r["text"] or "").endswith("cheat sheet")
              and r["visible"] == ["hint", True] and r["small"] < 80, r)
        check(tag + " not suggested twice while you stay", r["notAgain"], r)
        check(tag + " Open asks for that sheet and the pill goes", r["opened"] == [r["id"]] and r["gone"], r)
        check(tag + " 🔕 stops suggestions for that mechanic", r["mutedIgnored"] and r["muted"] == [r["id"]], r)
    s.fresh()
    r = s.run(S32_SYNC, timeout=60)
    check(tag + " newer sheets from the server replace the shipped ones", r["synced"] and r["listed"], r)
    check(tag + " app page previews it and Show in game opens it", "from the server" in (r["preview"] or "") and
          r["shown"] == ["e2enew"], r)


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


S42_ATLAS = r"""
const H = window.__e2e;
const out = {};
const V = () => document.getElementById('view-atlas');
const btn = label => H.button(V(), label);
const dlg = () => document.querySelector('dialog.ui-dialog[open]');
openAtlasView();
await H.waitFor(() => ATLAS && ATLAS.main.w > 0, 3000, 'atlas canvas sized');
await H.frame();
out.view = [document.body.dataset.view, H.visible(V()), H.text('#view-title')];
// colour of the pixel at a node's centre, after centring it
const probe = document.createElement('canvas').getContext('2d');
const hex = c => { probe.fillStyle = c; return probe.fillStyle; };
const rgbAt = id => {
  atlasFocusNode(id); ATLAS.flash = null; atlasDraw();
  const cv = ATLAS.main, d = cv.ctx.getImageData(Math.round(cv.w / 2 * cv.dpr), Math.round(cv.h / 2 * cv.dpr), 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
};
out.accent = hex(treeColors().alloc);
// import the official link
const paste = t => { V().querySelector('.atlas-input').value = t; btn('Import').click(); }; // the side panel re-renders
paste(URL_);
await H.waitFor(() => ATLAS.M.points > 0, 3000, 'import');
out.status = H.text('.atlas-status', V());
out.points = [ATLAS.M.points, H.text('.atlas-points', V()), H.text('.atlas-current .tv-stat', V())];
out.ids = Object.keys(ATLAS.M.alloc).map(Number).sort((a, b) => a - b);
out.title = H.text('.atlas-title', V());
out.onPx = rgbAt(SMALL);
out.offPx = rgbAt(OFF);
// tooltip on hover
const cv = ATLAS.main, n = ATLAS.I.byId[SMALL], r = cv.el.getBoundingClientRect();
atlasFocusNode(SMALL);
cv.el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1,
  clientX: r.left + (n.x - cv.cx) * cv.s + cv.w / 2, clientY: r.top + (n.y - cv.cy) * cv.s + cv.h / 2 }));
out.tip = [!ATLAS.tip.hidden, H.text('.tv-tip-name', ATLAS.tip), H.text('.tv-tip-stat', ATLAS.tip), H.text('.tv-tip-meta .badge', ATLAS.tip)];
// search
const q = V().querySelector('.atlas-search'); q.value = SEARCH; q.dispatchEvent(new Event('input'));
out.search = H.text('.tv-count', V());
q.value = ''; q.dispatchEvent(new Event('input'));
// unknown input: a clear error, the tree stays
paste('hello world'); await H.sleep(50);
out.junk = [H.text('.atlas-status', V()), ATLAS.M.points];
// save under a name
const nameEl = () => V().querySelector('.atlas-name');
nameEl().value = 'Essence farm'; btn('Save').click(); await H.sleep(20);
const stored = () => JSON.parse(localStorage.getItem('pobtf-atlas') || '[]');
out.saved = stored().map(s => [s.name, s.nodes.length, s.url === URL_]);
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-atlas');
const id = ATLAS.savedId;
out.savedTitle = H.text('.atlas-title', V());
out.usedNone = H.text('.atlas-used-by', V());
// rename + notes
nameEl().value = 'Essence + Harvest'; btn('Rename').click(); await H.sleep(20);
out.renamed = [stored()[0].name, atlasName(id), H.text('.atlas-title', V())];
const notes = V().querySelector('.atlas-notes'); notes.value = 'Rusted essence scarabs'; notes.dispatchEvent(new Event('change'));
out.notes = stored()[0].notes;
// linked from a saved build (04-library.js entries carry atlas: id)
localStorage.setItem('pobtf-builds', JSON.stringify([{ name: 'My Witch · Necromancer', code: 'x', atlas: id }, { name: 'Other', code: 'y' }]));
setView('market'); await H.sleep(20); setView('atlas'); await H.sleep(20);
out.usedBy = H.text('.atlas-used-by', V());
out.list = atlasList();
// another tree (node names), then reopen the saved one from the list and through atlasOpen
paste(NAMES);
await H.waitFor(() => ATLAS.savedId === null, 3000, 'second import');
out.second = [ATLAS.M.points, H.text('.atlas-title', V())];
[...V().querySelectorAll('.atlas-saved-item')].find(b => b.textContent.startsWith('Essence + Harvest')).click();
await H.sleep(20);
out.reopened = [ATLAS.savedId === id, ATLAS.M.points, H.text('.atlas-title', V()), V().querySelector('.atlas-notes').value];
setView('market'); await H.sleep(20);
out.open = [atlasOpen(id), document.body.dataset.view, ATLAS.savedId === id, atlasOpen('nope')];
// delete: asks first, Cancel keeps it
btn('Delete').click(); await H.waitFor(dlg, 2000, 'confirm');
out.confirm = [H.text('.ui-dialog-title', dlg()), H.text('.ui-dialog-body', dlg())];
H.button(dlg(), 'Cancel').click(); await H.sleep(20);
out.afterCancel = stored().length;
btn('Delete').click(); await H.waitFor(dlg, 2000, 'confirm again');
H.button(dlg(), 'Delete').click(); await H.sleep(30);
out.afterDelete = [stored().length, atlasName(id), H.text('.atlas-title', V()), ATLAS.M.points];
// the in-game backdrop: none in the stub's art cache -> plain; with sheets -> tile, painting, circles
const cv2 = ATLAS.main, B = ATLAS.I.D.background;
const pixel = (x, y) => [...cv2.ctx.getImageData(Math.round(x * cv2.dpr), Math.round(y * cv2.dpr), 1, 1).data].slice(0, 3);
treeFit(cv2); atlasDraw();
out.bgFallback = [ATLAS_BG && ATLAS_BG.state, cv2.bgDrawn];
const corner = p => [(p[0] + 60 - cv2.cx) * cv2.s + cv2.w / 2, (p[1] + 60 - cv2.cy) * cv2.s + cv2.h / 2];
const pr = B.painting.rect;
out.plain = [pixel(2, 2), pixel.apply(null, corner(pr))];
function sized(w, h, rgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = rgb; g.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
}
const bgArt = {};
bgArt[B.tile.url] = sized(B.tile.rect[2], B.tile.rect[3], 'rgb(40,40,160)');
bgArt[B.sheet.url] = sized(1400, 1200, 'rgb(200,160,60)');
bgArt[B.painting.url] = sized(2048, 1974, 'rgb(170,30,30)');
window.__stubOverrides.cache_art = { ok: true, art: bgArt };
const nBg = H.calls('cache_art').length;
ATLAS_BG = null;
atlasDraw();
await H.waitFor(() => ATLAS_BG && ATLAS_BG.state !== 'loading', 5000, 'atlas background');
out.bgState = ATLAS_BG.state;
out.bgCalls = H.calls('cache_art').slice(nBg).map(c => JSON.parse(c.args[0]));
atlasDraw();
out.bgFit = cv2.bgDrawn;
out.withBg = [pixel(2, 2), pixel.apply(null, corner(pr))];
const t0 = performance.now();
for (let i = 0; i < 5; i++) atlasDraw();
out.bgMs = (performance.now() - t0) / 5;
out.onPxBg = rgbAt(SMALL); // an allocated node keeps the accent colour over the painting
delete window.__stubOverrides.cache_art;
// the Tools nav lists it
await H.loadBuild();
out.nav = !!document.querySelector('#nav .nav-item[data-view="atlas"]');
return out;
"""


def scenario_atlas(s, tag):
    with open(os.path.join(ROOT, "data", "atlasview.js"), encoding="utf-8") as f:
        src = f.read()
    av = json.loads(src[src.index("{"):src.rindex("}") + 1])
    nodes = av["nodes"]
    names = {}
    for n in nodes:
        names[n[4]] = names.get(n[4], 0) + 1
    smalls = [n[0] for n in nodes if n[3] == 0]
    notables = [n for n in nodes if n[3] == 1 and names[n[4]] == 1]
    ids = sorted(smalls[:12] + [n[0] for n in notables[:5]] + [next(n[0] for n in nodes if n[3] == 2)])
    body = bytes([0, 0, 0, 6, 0, 0, len(ids)]) + b"".join(bytes([i >> 8, i & 255]) for i in ids) + bytes([0, 0])
    url = "https://www.pathofexile.com/fullscreen-atlas-skill-tree/" + base64.urlsafe_b64encode(body).decode()
    s.fresh()
    r = s.run(S42_ATLAS, timeout=90, URL_=url, SMALL=smalls[0], OFF=smalls[-1], SEARCH=notables[0][4],
              NAMES="\n".join(n[4] for n in notables[5:8]))
    check(tag + " Atlas tree view opens", r["view"] == ["atlas", True, "Atlas tree"], r["view"])
    check(tag + " official link imported: its nodes allocated, points shown", r["ids"] == ids and
          r["points"][0] == len(ids) and r["points"][1] == str(len(ids)) and "/ %d Atlas points" % av["totalPoints"] in r["points"][2],
          (r["points"], len(ids)))
    check(tag + " import message", "Imported %d points from the Atlas link" % len(ids) in (r["status"] or ""), r["status"])
    check(tag + " allocated node drawn in the accent colour, others not", r["onPx"] == r["accent"] and r["offPx"] != r["accent"],
          (r["onPx"], r["offPx"], r["accent"]))
    check(tag + " tooltip: name, stat, Allocated", r["tip"][0] and r["tip"][1] and r["tip"][2] and r["tip"][3] == "Allocated", r["tip"])
    check(tag + " search counts matches", " match" in (r["search"] or "") and r["search"].endswith(" · 1 allocated"), r["search"])
    check(tag + " unknown input: clear error, tree kept", "isn't an Atlas tree" in (r["junk"][0] or "") and r["junk"][1] == len(ids), r["junk"])
    check(tag + " saved under its name (pobtf-atlas, through the bridge)", r["saved"] == [["Essence farm", len(ids), True]] and
          r["persisted"] and r["savedTitle"] == "Essence farm", (r["saved"], r["savedTitle"]))
    check(tag + " Used by: none yet", "no saved build" in (r["usedNone"] or ""), r["usedNone"])
    check(tag + " rename", r["renamed"] == ["Essence + Harvest"] * 3, r["renamed"])
    check(tag + " notes kept", r["notes"] == "Rusted essence scarabs", r["notes"])
    check(tag + " Used by: the saved build that links it", r["usedBy"] == "Used by: My Witch", r["usedBy"])
    check(tag + " atlasList for the build library", r["list"] and r["list"][0]["name"] == "Essence + Harvest" and
          r["list"][0]["points"] == len(ids), r["list"])
    check(tag + " node names import as an unsaved tree", r["second"] == [3, "Imported tree (not saved)"], r["second"])
    check(tag + " reopen from the saved list (points, name, notes)", r["reopened"] == [True, len(ids), "Essence + Harvest",
          "Rusted essence scarabs"], r["reopened"])
    check(tag + " atlasOpen(id) switches to the view; unknown id refused", r["open"] == [True, "atlas", True, False], r["open"])
    check(tag + " delete asks first, naming the linked build", "Essence + Harvest" in (r["confirm"][0] or "") and
          "1 saved build links to it" in (r["confirm"][1] or ""), r["confirm"])
    check(tag + " Cancel keeps it", r["afterCancel"] == 1, r["afterCancel"])
    check(tag + " Delete removes it, the tree stays on screen unsaved", r["afterDelete"] == [0, None, "Imported tree (not saved)", len(ids)],
          r["afterDelete"])
    bg = av["background"]
    urls = [bg["tile"]["url"], bg["sheet"]["url"], bg["painting"]["url"]]
    check(tag + " backdrop data: tile, group sheet, painting (GGG's CDN), a circle per group, the start art",
          all(u.startswith("https://web.poecdn.com/") for u in urls) and len(bg["groups"]) // 3 > 100 and
          len(bg["starts"]) == 2 and bg["starts"][0] in av["starts"], (len(bg["groups"]) // 3, bg["starts"]))
    check(tag + " backdrop: no sheets in the art cache -> plain background, nothing drawn", r["bgFallback"] == ["failed", None],
          r["bgFallback"])
    check(tag + " backdrop: the three sheets fetched through cache_art (one call)",
          r["bgState"] == "ready" and r["bgCalls"] == [urls], (r["bgState"], r["bgCalls"]))
    fit = r["bgFit"] or {}
    check(tag + " backdrop drawn at fit: tile, painting, every group circle, the start art", fit.get("tile") and
          fit.get("painting") and fit.get("groups") == len(bg["groups"]) // 3 and fit.get("starts") == 1, fit)
    (pc, pp), (bc, bp) = r["plain"], r["withBg"]
    check(tag + " backdrop: tile outside the painting, the painting (dimmed) inside it",
          bc != pc and bc[2] > bc[0] and bp != pp and bp[0] > bp[2] and bp[0] < 170, (r["plain"], r["withBg"]))
    check(tag + " backdrop: allocated node still in the accent colour on top", r["onPxBg"] == r["accent"], (r["onPxBg"], r["accent"]))
    check(tag + " backdrop: a fitted redraw stays fast (< 40 ms)", r["bgMs"] < 40, r["bgMs"])
    check(tag + " Tools nav lists the Atlas tree", r["nav"], r["nav"])


S49_SYND = r"""
const H = window.__e2e;
const out = {};
const host = document.createElement('div');
host.style.width = '1100px';
document.body.appendChild(host);
out.hook = window.__mechanicExtras && window.__mechanicExtras.syndicate === syndicatePlanner;
syndicatePlanner(host);
const card = n => host.querySelector('.synd-card[data-name="' + n + '"]');
const row = (d, r) => host.querySelector('.synd-col[data-div="' + d + '"] .synd-row[data-rank="' + r + '"]');
const moves = () => [...host.querySelectorAll('.synd-move-text')].map(e => e.textContent);
const st = () => JSON.parse(localStorage.getItem('pobtf-syndicate') || 'null');
const ed = () => host.querySelector('.synd-editor');
out.cols = [...host.querySelectorAll('.synd-col')].map(c => c.dataset.div);
out.unassigned = host.querySelectorAll('.synd-pool[data-pool="none"] .synd-card').length;
out.setup = moves().some(t => t.startsWith('Copy your board first'));
// goal
const gs = host.querySelector('.synd-goal-select');
gs.value = 'general'; gs.dispatchEvent(new Event('change'));
out.goalText = H.text('.synd-goal', host);
// click a member, then a division row
const put = (n, d, r) => { card(n).click(); row(d, r).click(); };
put('It That Fled', 'transportation', '3');
put('Vorici', 'transportation', '3');
put('Haku', 'intervention', '3');
// the editor path: pick Leo, a division, a rank
card('Leo').click();
out.editorOpen = !ed().hidden && H.text('.synd-ed-name', ed());
ed().querySelector('.synd-ed-place[data-div="intervention"]').click();
ed().querySelector('.segmented button[data-value="2"]').click();
// drag and drop: Guff into Intervention rank 1
const dt = new DataTransfer();
card('Guff').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
row('intervention', '1').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
row('intervention', '1').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
put('Korell', 'fortification', '1');
const s1 = st().m;
out.placed = ['It That Fled', 'Vorici', 'Haku', 'Leo', 'Guff', 'Korell'].map(n => [n, s1[n].d, s1[n].r]);
out.cards = [!!row('intervention', '3').querySelector('.synd-card[data-name="Haku"]'),
  H.text('.synd-card[data-name="Haku"] .synd-card-reward', host), H.text('.synd-card[data-name="Leo"] .synd-hint', host),
  !!row('intervention', '1').querySelector('.synd-card.is-out[data-name="Guff"]')];
out.moves1 = moves();
// intel: a filler house close to full
const rng = host.querySelector('.synd-col[data-div="research"] .synd-intel input');
rng.value = 90; rng.dispatchEvent(new Event('input')); rng.dispatchEvent(new Event('change'));
out.moves2 = moves();
out.intelSaved = st().intel.research;
// leader + rivals through the editor
card('Haku').click();
ed().querySelector('.synd-ed-ctl input[type=checkbox]').click();
out.leaderMoves = moves().filter(t => /leader/.test(t));
out.leaderRow = !!row('intervention', 'L').querySelector('.synd-card[data-name="Haku"]');
ed().querySelector('.synd-ed-ctl input[type=checkbox]').click();
[...ed().querySelectorAll('.synd-rival')].find(b => b.textContent === 'Korell').click();
out.rivals = [st().m.Haku.riv, st().m.Korell.riv];
out.betray = moves().filter(t => t.startsWith('Betray'));
// away
card('Gravicius').click();
H.button(ed(), 'Away / dead').click();
out.away = [st().m.Gravicius.d, !!host.querySelector('.synd-pool[data-pool="away"] .synd-card[data-name="Gravicius"]')];
host.querySelector('.synd-ed-head button').click();
out.editorClosed = ed().hidden;
// copy as text
window.__clip = null;
H.button(host, 'Copy board as text').click();
await H.waitFor(() => window.__clip, 3000, 'board text on the clipboard');
out.clip = window.__clip;
out.persisted = H.calls('storage_set').some(c => c.args[0] === 'pobtf-syndicate');
out.stored = H.calls('storage_set').filter(c => c.args[0] === 'pobtf-syndicate').slice(-1)[0].args[1];

// ---- review regressions: the plan itself (syndPlan on a given board) ----
const D = window.POE_SYNDICATE;
const plan = (goal, m, d) => syndPlan(d || D, syndNormalize(d || D, { goal: goal, m: m }));
// #0 Betray / Rivals only for the goal that links Rivals (2-2-5-5)
out.betrayBy = ['research', 'vorici', 'intervention', 'general'].map(g =>
  plan(g, {}).suggestions.filter(x => x.kind === 'betray').length);
out.linkRivals = D.goals.filter(g => g.linkRivals).map(g => g.id);
// #1 evictions: both filler houses at 4/5, three unwanted members in target houses
const ev = plan('general', { 'It That Fled': { d: 'transportation', r: 3 }, Vorici: { d: 'transportation', r: 3 },
  Haku: { d: 'intervention', r: 3 }, Leo: { d: 'intervention', r: 3 },
  Aisling: { d: 'fortification', r: 1 }, Guff: { d: 'fortification', r: 1 }, Janus: { d: 'fortification', r: 1 }, Riker: { d: 'fortification', r: 1 },
  Cameria: { d: 'research', r: 1 }, Elreon: { d: 'research', r: 1 }, Hillock: { d: 'research', r: 1 }, Jorgin: { d: 'research', r: 1 },
  Tora: { d: 'transportation', r: 1 }, Korell: { d: 'intervention', r: 1 }, Rin: { d: 'intervention', r: 0 } });
const evTo = { fortification: 0, research: 0 };
ev.suggestions.filter(x => x.prio === 40).forEach(x => {
  const m = x.text.match(/in an? (Fortification|Research) encounter/);
  if (m) evTo[m[1].toLowerCase()]++;
});
out.evict = { to: evTo, full: ev.suggestions.filter(x => x.prio === 40 && x.kind === 'remove').map(x => x.who[0]),
  over: ev.suggestions.some(x => / has \d+ members; this board wants/.test(x.text)) };
// #2 a kept member (Vorici) in the wrong target house: he becomes the Transportation target and moves
const kp = plan('general', { Vorici: { d: 'intervention', r: 2 }, Haku: { d: 'intervention', r: 1 }, Leo: { d: 'intervention', r: 1 } });
out.keep1 = [kp.wantTo.Vorici, kp.wantTo.Gravicius || null, kp.status.Vorici,
  kp.suggestions.filter(x => x.who.indexOf('Vorici') !== -1 && /^Interrogate Vorici out of Intervention/.test(x.text)).length];
// the mirror: Vorici already in Transportation, Gravicius (also kept) sits in Intervention
const kp2 = plan('general', { Vorici: { d: 'transportation', r: 1 }, Gravicius: { d: 'intervention', r: 1 },
  Haku: { d: 'intervention', r: 1 }, Leo: { d: 'intervention', r: 1 } });
out.keep2 = [kp2.status.Gravicius, kp2.suggestions.filter(x => /^Interrogate Gravicius out of Intervention/.test(x.text)).map(x => x.text)];
// #3 one member, one division: 'Vorici or Gravicius in Transportation' + 'Vorici in Fortification'
const g0 = D.goals.find(g => g.id === 'vorici');
const T = (ms, d) => ({ members: ms, division: d, alt: false, leaderFree: false, note: '', text: ms.join(' or ') + ' in ' + d });
const withGoal = targets => Object.assign({}, D, { goals: [Object.assign({}, g0, { id: 'x', targets: targets })] });
const D2 = withGoal([T(['Vorici', 'Gravicius'], 'transportation'), T(['Vorici'], 'fortification')]);
const p2 = plan('x', { Vorici: { d: 'transportation', r: 1 } }, D2);
out.twice = p2.needs.map(n => n.division + ':' + n.member);
out.twiceVorici = p2.suggestions.filter(x => /Vorici/.test(x.text)).map(x => x.text);
const D3 = withGoal([T(['Vorici'], 'transportation'), T(['Vorici', 'Gravicius'], 'fortification'), T(['Gravicius'], 'research')]);
const p3 = plan('x', {}, D3);
out.unmet = [p3.needs.map(n => n.division + ':' + n.member), p3.suggestions.filter(x => x.text.startsWith('No free member')).map(x => x.text)];
// #22 a remove-list member shows the status in words, also on a compact pool card
gs.value = 'research'; gs.dispatchEvent(new Event('change'));
out.removeChip = [H.text('.synd-pool[data-pool="none"] .synd-card[data-name="Riker"] .synd-status', host),
  (card('Riker').title || '').includes('Status: remove')];
out.betrayUi = moves().filter(t => t.startsWith('Betray'));
gs.value = 'general'; gs.dispatchEvent(new Event('change'));
return out;
"""

# Review regressions, UI side: inside the real Cheat sheets view (its Esc closes the page)
S49_UI = r"""
const H = window.__e2e;
const out = {};
document.getElementById('open-sheets').click();
await H.sleep(80);
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('syndicate').title).click();
await H.sleep(80);
const host = document.querySelector('#view-sheets .synd');
const card = n => host.querySelector('.synd-card[data-name="' + n + '"]');
const ed = () => host.querySelector('.synd-editor');
const st = () => JSON.parse(localStorage.getItem('pobtf-syndicate') || 'null');
const active = () => { const a = document.activeElement; return a ? (a.dataset.fk || a.tagName) : null; };
const esc = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
out.mounted = !!host;
// #17 picking a member moves focus into its editor (card says it controls the editor)
card('Haku').focus();
card('Haku').click();
out.pickFocus = [active(), ed().contains(document.activeElement), card('Haku').getAttribute('aria-expanded'),
  card('Haku').getAttribute('aria-controls') === ed().id];
// #16 focus kept after editor actions
const place = ed().querySelector('.synd-ed-place[data-div="intervention"]');
place.focus(); place.click();
out.afterPlace = active();
const rival = () => [...ed().querySelectorAll('.synd-rival')].find(b => b.textContent === 'Korell');
rival().focus(); rival().click();
out.afterRival = [active(), st().m.Haku.riv];
const seg = v => ed().querySelector('.segmented button[data-value="' + v + '"]');
seg('1').focus(); seg('1').click();
// arrow keys keep working: two presses in a row
document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
out.afterArrows = [active(), st().m.Haku.r];
const lc = ed().querySelector('.synd-ed-ctl input[type=checkbox]');
lc.focus(); lc.click();
out.afterLeader = [active(), st().m.Haku.l];
ed().querySelector('.synd-ed-ctl input[type=checkbox]').click();
// #18 clicking the Rank caption leaves the rank alone
const before = st().m.Haku.r;
const cap = ed().querySelector('.synd-ed-rank .field-label');
out.capText = cap && cap.textContent;
cap.click();
ed().querySelector('.synd-ed-rank').click();
out.rankAfterCaption = [before, st().m.Haku.r, !ed().querySelector('label .segmented')];
// #15 Esc cancels the pick and stays on the Cheat sheets page
esc();
await H.sleep(30);
out.esc = [ed().hidden, !host.querySelector('.synd-card.is-sel'), document.body.dataset.view, active()];
// a second Esc (nothing picked) is the page's again
esc();
await H.sleep(30);
out.esc2 = document.body.dataset.view;
return out;
"""

S49_RELOAD = r"""
const H = window.__e2e;
const out = {};
await H.waitFor(() => localStorage.getItem('pobtf-syndicate'), 5000, 'the board from bridge storage');
const host = document.createElement('div');
document.body.appendChild(host);
window.__mechanicExtras.syndicate(host);
const st = () => JSON.parse(localStorage.getItem('pobtf-syndicate'));
const row = (d, r) => host.querySelector('.synd-col[data-div="' + d + '"] .synd-row[data-rank="' + r + '"]');
const dlg = () => document.querySelector('dialog.ui-dialog[open]');
out.goal = host.querySelector('.synd-goal-select').value;
out.haku = !!row('intervention', '3').querySelector('.synd-card[data-name="Haku"]');
out.intel = host.querySelector('.synd-col[data-div="research"] .synd-intel input').value;
out.away = !!host.querySelector('.synd-pool[data-pool="away"] .synd-card[data-name="Gravicius"]');
out.run = [...host.querySelectorAll('.synd-move-text')].map(e => e.textContent).filter(t => t.startsWith('Run the'));
// reset asks first: Cancel keeps the board
H.button(host, 'Reset board').click();
await H.waitFor(dlg, 2000, 'reset confirm');
out.confirm = H.text('.ui-dialog-title', dlg());
H.button(dlg(), 'Cancel').click();
await H.sleep(30);
out.afterCancel = st().m.Haku.d;
H.button(host, 'Reset board').click();
await H.waitFor(dlg, 2000, 'reset confirm again');
H.button(dlg(), 'Reset').click();
await H.sleep(30);
const s = st();
out.afterReset = [Object.values(s.m).every(x => x.d === null && x.r === 0 && !x.l && !x.riv.length), s.goal, s.intel.research,
  host.querySelectorAll('.synd-pool[data-pool="none"] .synd-card').length];
out.resetSaved = JSON.parse(H.calls('storage_set').filter(c => c.args[0] === 'pobtf-syndicate').slice(-1)[0].args[1]).m.Haku.d;
return out;
"""


def scenario_syndicate(s, tag):
    s.fresh()
    r = s.run(S49_SYND, timeout=60)
    check(tag + " hook: __mechanicExtras.syndicate is the planner", r["hook"], r["hook"])
    check(tag + " board: 4 division columns, all 17 members unassigned, setup hint",
          r["cols"] == ["transportation", "fortification", "research", "intervention"] and r["unassigned"] == 17 and r["setup"],
          (r["cols"], r["unassigned"], r["setup"]))
    check(tag + " goal picker shows the 2-2-5-5 targets and rules", "Haku → Intervention" in (r["goalText"] or "") and
          "Never raid the filler houses." in r["goalText"], r["goalText"])
    check(tag + " placed by click, editor and drag and drop", r["editorOpen"] == "Leo" and r["placed"] == [
        ["It That Fled", "transportation", 3], ["Vorici", "transportation", 3], ["Haku", "intervention", 3],
        ["Leo", "intervention", 2], ["Guff", "intervention", 1], ["Korell", "fortification", 1]], r["placed"])
    check(tag + " cards: reward where they sit, value hint, unwanted marker", r["cards"] == [True, "Ambush scarabs", "~456c", True],
          r["cards"])
    m1 = r["moves1"]
    check(tag + " target at rank 3 -> run its safehouse",
          "Run the Transportation safehouse: It That Fled rank 3 and Vorici rank 3" in m1, m1)
    check(tag + " filler member in a target house -> interrogate it out, execute it in a filler house",
          "Interrogate Guff out of Intervention (-1 rank), then execute Guff in a Research encounter" in m1, m1)
    check(tag + " target below rank 3 -> execute (Test of Loyalty)",
          "Execute Leo in an Intervention encounter (needs a witness) → rank 3" in m1, m1)
    check(tag + " rank-3 targets: don't interrogate; filler houses: don't raid; unassigned fillers",
          "Don't interrogate It That Fled, Vorici and Haku before their safehouses" in m1 and
          "Don't raid Fortification: filler house" in m1 and "Hold the Intervention safehouse: Haku rank 3 and Leo rank 2 (wants rank 3)" in m1
          and any(t.startswith("Execute Aisling, Cameria") and t.endswith(": filler") for t in m1), m1)
    check(tag + " filler house close to full -> warning (intel saved)",
          "Research is close to full (90%)" in r["moves2"] and "Don't raid Research: filler house (90% full)" in r["moves2"] and
          r["intelSaved"] == 90, r["moves2"])
    check(tag + " target stuck as leader -> warning, shown in the Leader row",
          "Haku is stuck as the Intervention leader" in r["leaderMoves"] and
          "Hold the Intervention safehouse: Haku leader and Leo rank 2 (wants rank 3)" in r["leaderMoves"] and r["leaderRow"],
          r["leaderMoves"])
    check(tag + " rivals both ways; Betray suggested for targets without one",
          r["rivals"] == [["Korell"], ["Haku"]] and not any("Haku and" in t for t in r["betray"]) and
          any(t.startswith("Betray to make Leo and ") for t in r["betray"]), (r["rivals"], r["betray"]))
    check(tag + " away pool, editor closes", r["away"] == ["away", True] and r["editorClosed"], (r["away"], r["editorClosed"]))
    clip = r["clip"] or ""
    check(tag + " copy board as text", "Syndicate board (goal: General currency (2-2-5-5))" in clip and
          "Intervention: Haku R3, Leo R2, Guff R1" in clip and "Away / dead: Gravicius" in clip and "Next moves:" in clip, clip)
    check(tag + " saved through the bridge (pobtf-syndicate)", r["persisted"], r["persisted"])
    r_stored = r["stored"]
    # review regressions (plan)
    check(tag + " Betray moves only for the goal that links Rivals (none for research, vorici, intervention)",
          r["betrayBy"][:3] == [0, 0, 0] and r["betrayBy"][3] > 0 and r["linkRivals"] == ["general"] and not r["betrayUi"],
          (r["betrayBy"], r["linkRivals"], r["betrayUi"]))
    ev = r["evict"]
    check(tag + " evictions spread over both filler houses, never past 5; the rest are removed",
          ev["to"] == {"fortification": 1, "research": 1} and len(ev["full"]) == 1 and not ev["over"], ev)
    check(tag + " kept member in the wrong target house becomes the target and moves (Vorici)",
          r["keep1"] == ["transportation", None, "want", 1], r["keep1"])
    check(tag + " kept member not picked, in a target house -> flagged and moved out (Gravicius)",
          r["keep2"][0] == "out" and len(r["keep2"][1]) == 1 and "Fortification" in r["keep2"][1][0], r["keep2"])
    check(tag + " need matching uses a member once (Vorici -> Fortification, Gravicius -> Transportation)",
          r["twice"] == ["transportation:Gravicius", "fortification:Vorici"] and
          not any(t.startswith("Execute Vorici in a Transportation") for t in r["twiceVorici"]), (r["twice"], r["twiceVorici"]))
    check(tag + " no member counted twice: a target with every option taken is flagged unmet",
          r["unmet"][0] == ["transportation:Vorici", "research:Gravicius"] and
          r["unmet"][1] == ["No free member for Vorici or Gravicius in Fortification"], r["unmet"])
    check(tag + " remove-list member: 'remove' chip on the pool card and in the tooltip",
          r["removeChip"] == ["remove", True], r["removeChip"])
    s.fresh()
    r = s.run(S49_UI, timeout=60)
    check(tag + " picking a member focuses its editor (aria-expanded/controls)",
          r["mounted"] and r["pickFocus"][1:] == [True, "true", True], r["pickFocus"])
    check(tag + " focus kept after editor actions (place, rival, rank arrows, leader)",
          r["afterPlace"] == "place:intervention" and r["afterRival"] == ["rival:Korell", ["Korell"]] and
          r["afterArrows"] == ["rank:3", 3] and r["afterLeader"] == ["leader", True],
          (r["afterPlace"], r["afterRival"], r["afterArrows"], r["afterLeader"]))
    check(tag + " clicking the Rank caption doesn't change the rank", r["capText"] == "Rank" and
          r["rankAfterCaption"][0] == r["rankAfterCaption"][1] and r["rankAfterCaption"][0] > 0 and r["rankAfterCaption"][2],
          (r["capText"], r["rankAfterCaption"]))
    check(tag + " Esc cancels the pick, stays on Cheat sheets, focus back on the card; next Esc closes the page",
          r["esc"] == [True, True, "sheets", "card:Haku"] and r["esc2"] != "sheets", (r["esc"], r["esc2"]))
    s.fresh("?e2eStore=" + urllib.parse.quote(json.dumps({"pobtf-syndicate": r_stored})))
    r = s.run(S49_RELOAD, timeout=60)
    check(tag + " reload: board, goal, intel and away come back from storage",
          r["goal"] == "general" and r["haku"] and r["intel"] == "90" and r["away"], r)
    check(tag + " reload: same moves (run the full target house)",
          "Run the Transportation safehouse: It That Fled rank 3 and Vorici rank 3" in r["run"], r["run"])
    check(tag + " reset asks first; Cancel keeps the board", r["confirm"] == "Reset the Syndicate board?" and
          r["afterCancel"] == "intervention", (r["confirm"], r["afterCancel"]))
    check(tag + " reset: everyone unassigned, goal kept, saved", r["afterReset"] == [True, "general", 0, 17] and
          r["resetSaved"] is None, (r["afterReset"], r["resetSaved"]))


# ---- 48 guides: mechanic strategy guides inside the cheat sheets (js/app/33-guides.js) ----
S48_APP = r"""
const H = window.__e2e;
const out = {};
const G = window.POE_GUIDES.guides;
document.getElementById('open-sheets').click();
await H.sleep(80);
const pick = (title) => { [...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === title).click(); };
const panel = () => document.querySelector('#view-sheets .sheet-panel.is-mech');
out.listed = [...document.querySelectorAll('#view-sheets .sheet-pick')].map(b => b.textContent);
// Betrayal (sheet id syndicate)
pick(mechanicById('syndicate').title);
await H.sleep(60);
const g = panel().querySelector('.guide');
out.has = !!g;
out.asof = H.text('.guide-asof', g);
out.summary = H.text('.guide-summary', g);
out.secs = [...g.querySelectorAll('.guide-sec:not([data-key="extra"]) .guide-sec-title')].map(e => e.textContent);
out.openSecs = [...g.querySelectorAll('.guide-sec:not([data-key="extra"])')].filter(d => d.open).map(d => d.dataset.key);
// a mechanic's own tool (the Syndicate planner, 34-syndicate.js) mounts in the app guide, first and open
const ex = g.querySelector('.guide-sec[data-key="extra"]');
out.extra = typeof (window.__mechanicExtras || {}).syndicate !== 'function' ||
  (!!ex && ex.open && g.querySelector('.guide-sec') === ex && ex.querySelector('.guide-extra').childNodes.length > 0);
out.strats = [...g.querySelectorAll('.guide-strat-name')].map(e => e.textContent);
out.wantStrats = G.syndicate.strategies.map(s => s.name);
out.inv = g.querySelectorAll('.guide-strat-inv').length;
out.refTitle = H.text('.guide-ref-title', g);
out.refRows = g.querySelectorAll('.guide-ref .sheet-table tbody tr').length;
out.filterInRef = !!g.querySelector('.guide-ref-head .sheet-filter');
out.icons = [...g.querySelectorAll('img.guide-icon')].map(i => i.getAttribute('src'));
out.profitNote = H.text('.guide-sec[data-key="profit"] .guide-note', g);
out.patchTags = [...g.querySelectorAll('.guide-patch-tag')].map(e => e.textContent).slice(0, 3);
// stage filter: League start hides lines tagged only for later stages
const howItems = () => [...g.querySelectorAll('.guide-sec[data-key="howTo"] .guide-item')];
out.allShown = howItems().filter(li => !li.hidden).length;
out.howTotal = G.syndicate.howTo.length;
[...g.querySelectorAll('.guide-stage-seg .seg')].find(b => b.textContent === 'League start').click();
await H.sleep(30);
const vis = howItems().filter(li => !li.hidden);
out.lsShown = vis.length;
out.lsWant = G.syndicate.howTo.filter(l => l.stage.includes('all') || l.stage.includes('league-start')).length;
out.lsOk = [...g.querySelectorAll('[data-stages]')].every(el => el.hidden !== (el.dataset.stages.split(' ').some(t => t === 'all' || t === 'league-start')));
out.lsStrats = [...g.querySelectorAll('.guide-strat')].filter(c => !c.hidden).map(c => c.querySelector('.guide-strat-name').textContent);
out.lsStratsWant = G.syndicate.strategies.filter(s => s.stage.includes('all') || s.stage.includes('league-start')).map(s => s.name);
out.lsCount = H.text('.guide-sec[data-key="howTo"] .guide-sec-count', g);
out.hiddenNote = H.text('.guide-hidden-count', g);
out.saved = localStorage.getItem('pobtf-guide-stage');
[...g.querySelectorAll('.guide-stage-seg .seg')].find(b => b.textContent === 'All').click();
await H.sleep(30);
out.backAll = howItems().filter(li => !li.hidden).length;
// a cite marker opens Read more at that source
const cite = g.querySelector('.guide-sec[data-key="howTo"] .guide-cite');
out.citeText = cite.textContent;
cite.click();
await H.sleep(50);
out.readOpen = g.querySelector('.guide-sec[data-key="readMore"]').open;
const flash = g.querySelector('.guide-src.is-flash');
out.flashN = flash ? H.text('.guide-src-n', flash) : null;
// Read more opens the page in the browser (bridge open_url)
const n0 = H.calls('open_url').length;
flash.querySelector('.guide-link').click();
await H.sleep(30);
out.opened = (H.calls('open_url')[n0] || { args: [] }).args[0];
out.wantUrl = G.syndicate.readMore[parseInt(out.citeText.slice(1), 10) - 1].url;
out.sources = g.querySelectorAll('.guide-src').length;
out.wantSources = G.syndicate.readMore.length;
out.tableCount = H.text('.guide-sec[data-key="tables"] .guide-sec-count', g);
// the jump bar under the as-of note: a link per section, then Reference data
const jump = g.querySelector('.guide-jump');
out.jumpAfterNote = !!jump && jump.previousElementSibling === g.querySelector('.guide-asof');
out.jumpKeys = jump ? [...jump.querySelectorAll('.guide-jump-link')].map(b => b.dataset.key) : [];
out.secKeys = [...g.querySelectorAll('.guide-sec')].map(d => d.dataset.key).concat(['ref']);
window.scrollTo(0, 0);
await H.sleep(30);
const refEl = g.querySelector('.guide-ref');
out.refBelow = refEl.getBoundingClientRect().top > window.innerHeight;
jump.querySelector('.guide-jump-link[data-key="ref"]').click();
// a smooth scroll (slow headless): wait until it lands at its top, or as far as the page scrolls
const atEnd = () => Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2;
const landed = (el) => { const t = el.getBoundingClientRect().top; return t >= -2 && (t < 120 || (atEnd() && t < window.innerHeight - 60)); };
for (let i = 0; i < 60 && !landed(refEl); i++) await H.sleep(50);
out.refTop = [Math.round(refEl.getBoundingClientRect().top), window.innerHeight];
out.refInView = landed(refEl);
out.refFocus = document.activeElement === g.querySelector('.guide-ref-head .sheet-filter');
// a folded section opens when its link is clicked
const strSec = g.querySelector('.guide-sec[data-key="strategies"]');
strSec.open = false;
jump.querySelector('.guide-jump-link[data-key="strategies"]').click();
for (let i = 0; i < 60 && !landed(strSec); i++) await H.sleep(50);
out.stratJump = strSec.open && landed(strSec);
window.scrollTo(0, 0);
// Blight: guide + the anoint helper and tables under Reference data
pick(mechanicById('blight').title);
await H.sleep(60);
out.blight = !!panel().querySelector('.guide') && !!panel().querySelector('.guide-ref .anoint') &&
  H.text('.guide-summary', panel()) === G.blight.summary;
const bref = panel().querySelector('.guide-jump-link[data-key="ref"]');
out.blightJump = !!bref && /anoint helper/.test(bref.title);
if (bref) bref.click();
await H.sleep(30);
const ae = document.activeElement;
out.blightFocus = !!ae && ae.tagName === 'INPUT' && !!ae.closest('.guide-ref .anoint') && (ae.matches('.anoint-search') || !!ae.closest('.anoint-search'));
window.scrollTo(0, 0);
// Mercenaries: a guide-only sheet, no reference data
pick('Mercenaries of Trarthus');
await H.sleep(60);
out.merc = !!panel().querySelector('.guide') && !panel().querySelector('.guide-ref') &&
  panel().querySelectorAll('.guide-strat').length === G.mercenaries.strategies.length;
out.mercJump = [...panel().querySelectorAll('.guide-jump-link')].map(b => b.dataset.key);
// a sheet without a guide works as before
pick(mechanicById('scarabs').title);
await H.sleep(60);
out.noGuide = !panel().querySelector('.guide') && panel().querySelectorAll('.sheet-table tbody tr').length > 20 &&
  !!document.querySelector('#view-sheets .sheet-filter');
out.noGuideFoot = H.text('.sheet-foot', panel());
return out;
"""

S48_OVERLAY = r"""
const H = window.__e2e;
const out = {};
const G = window.POE_GUIDES.guides;
window.__sheetOpen('syndicate');
await H.sleep(60);
const p = document.querySelector('.sheet-panel');
out.title = H.text('.sheet-title');
out.quick = [...p.querySelectorAll('.guide-quick .sheet-li .guide-quick-text')].map(e => e.textContent);
out.wantQuick = G.syndicate.quickCard.map(l => l.replace(/^\[[^\]]+\]\s*/, ''));
out.quickTags = p.querySelectorAll('.guide-quick .guide-stage').length;
out.strats = [...p.querySelectorAll('.guide-ov-strats .guide-quick-text')].map(e => e.textContent);
out.wantStrats = G.syndicate.strategies.map(s => s.name);
out.more = H.text('.guide-ov-more', p);
out.long = p.querySelectorAll('.guide-sec, .guide-asof, .guide-summary, .guide-strat, .guide-src, .guide-cite, .guide-jump').length;
out.sections = [...p.querySelectorAll('.guide-ov-pane[data-tab="quick"] > .sheet-sec > .sheet-sec-title')].map(e => e.textContent);
out.inputs = p.querySelectorAll('input, select, textarea, [contenteditable="true"]').length;
const shown = (el) => !!el && el.getClientRects().length > 0;
// tabs: Quick card (default) | Reference; the quick card is first, the strategy names fold to one line
out.tabs = [...p.querySelectorAll('.guide-ov-tabs .seg')].map(b => b.textContent);
out.tabFirst = p.querySelector('.guide-ov').firstElementChild.classList.contains('guide-ov-tabs');
out.quickOn = shown(p.querySelector('.guide-quick')) && !shown(p.querySelector('.guide-ov-ref'));
const tog = p.querySelector('.guide-ov-toggle');
out.togText = tog ? tog.textContent : null;
out.stratsFolded = !shown(p.querySelector('.guide-ov-strats')) && tog.getAttribute('aria-expanded') === 'false';
let fits = H.calls('overlay_fit').length;
tog.click();
await H.sleep(40);
out.stratsOpen = shown(p.querySelector('.guide-ov-strats')) && tog.getAttribute('aria-expanded') === 'true';
out.togFit = H.calls('overlay_fit').length > fits;
fits = H.calls('overlay_fit').length;
[...p.querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Reference').click();
await H.sleep(40);
out.refOn = shown(p.querySelector('.guide-ov-ref')) && !shown(p.querySelector('.guide-quick'));
out.tabFit = H.calls('overlay_fit').length > fits;
out.refRows = [...p.querySelectorAll('.guide-ov-ref .sheet-table tbody tr')].filter(shown).length;
out.tabSaved = JSON.parse(localStorage.getItem('pobtf-guide-ov-tab') || '{}').syndicate;
[...p.querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Quick card').click();
await H.sleep(40);
out.backQuick = shown(p.querySelector('.guide-quick'));
// Blight: the anoint helper one click away, under Reference; the tab is remembered per sheet
window.__sheetOpen('blight');
await H.sleep(60);
const bp = () => document.querySelector('.sheet-panel');
out.blightQuick = shown(bp().querySelector('.guide-quick')) && !shown(bp().querySelector('.anoint'));
[...bp().querySelectorAll('.guide-ov-tabs .seg')].find(b => b.textContent === 'Reference').click();
await H.sleep(40);
const an = bp().querySelector('.guide-ov-ref .anoint');
out.blightHelper = shown(an) && an.classList.contains('is-overlay') &&
  bp().querySelector('.guide-ov-ref .sheet-sec-title').textContent === 'Anoint helper';
out.blightInputs = bp().querySelectorAll('input, select, textarea, [contenteditable="true"]').length;
window.__sheetOpen('pantheon');
await H.sleep(40);
window.__sheetOpen('blight');
await H.sleep(60);
out.blightKept = shown(bp().querySelector('.guide-ov-ref .anoint'));
out.synKept = JSON.parse(localStorage.getItem('pobtf-guide-ov-tab') || '{}').syndicate;
window.__sheetOpen('mercenaries');
await H.sleep(60);
out.mercTitle = H.text('.sheet-title');
out.mercQuick = document.querySelectorAll('.sheet-panel .guide-quick .sheet-li').length;
out.mercNoTabs = !document.querySelector('.sheet-panel .guide-ov-tabs');
window.__sheetOpen('pantheon');
await H.sleep(60);
out.pantheon = !document.querySelector('.sheet-panel .guide-ov') &&
  document.querySelectorAll('.sheet-panel .sheet-table tbody tr, .sheet-panel .sheet-li').length > 0;
return out;
"""

S48_SYNC = r"""
const H = window.__e2e;
const out = {};
const D = JSON.parse(JSON.stringify(window.POE_GUIDES));
out.shipped = D.version;
if (NEWER) {
  D.version = D.version + 1;
  D.guides.syndicate.summary = 'E2E summary from the server';
  D.guides.e2eguide = JSON.parse(JSON.stringify(D.guides.mercenaries));
  D.guides.e2eguide.title = 'E2E guide';
  D.sheets = D.sheets.concat([{ id: 'e2eguide', title: 'E2E guide sheet', group: 'League mechanics' }]);
} else {
  D.version = D.version - 1;
  D.guides.syndicate.summary = 'E2E older copy';
}
window.__stubOverrides.guides_data = { ok: true, data: D };
document.getElementById('open-sheets').click();
await H.sleep(100);
out.version = window.POE_GUIDES.version;
[...document.querySelectorAll('#view-sheets .sheet-pick')].find(b => b.textContent === mechanicById('syndicate').title).click();
await H.sleep(60);
out.summary = H.text('#view-sheets .guide-summary');
out.newSheet = [...document.querySelectorAll('#view-sheets .sheet-pick')].some(b => b.textContent === 'E2E guide sheet');
out.calls = H.calls('guides_data').length;
delete window.__stubOverrides.guides_data;
return out;
"""


def scenario_guides(s, tag):
    s.fresh()
    r = s.run(S48_APP, timeout=60)
    check(tag + " Mercenaries listed as a sheet", "Mercenaries of Trarthus" in r["listed"], r["listed"])
    check(tag + " Betrayal guide renders with the 3.29 disclaimer", r["has"] and
          "Information as of 3.29 — checked " in (r["asof"] or "") and "may change with 3.30" in r["asof"], r["asof"])
    check(tag + " summary, sections in order, How to open, Strategies folded", r["summary"] and r["secs"] ==
          ["How to run it", "Strategies", "Dangers", "What to sell", "Profit", "Changes by patch", "Tables", "Read more"]
          and r["openSecs"] == ["howTo"], (r["secs"], r["openSecs"]))
    check(tag + " jump bar under the as-of note: every section, then Reference data", r["jumpAfterNote"] and
          r["jumpKeys"] == r["secKeys"] and r["jumpKeys"][-1] == "ref", (r["jumpKeys"], r["secKeys"]))
    check(tag + " jump bar scrolls to Reference data and focuses its filter", r["refBelow"] and r["refInView"] and
          r["refFocus"], (r["refBelow"], r["refTop"], r["refFocus"]))
    check(tag + " jump bar opens a folded section", r["stratJump"], r["stratJump"])
    check(tag + " the mechanic's own tool (__mechanicExtras) mounts first, open, app only", r["extra"], r["extra"])
    check(tag + " strategy cards with investment", r["strats"] == r["wantStrats"] and r["inv"] == len(r["wantStrats"]), r["strats"])
    check(tag + " profit labelled rough community estimates", "Rough community estimates" in (r["profitNote"] or ""), r["profitNote"])
    check(tag + " changes grouped by patch, newest first", r["patchTags"] and r["patchTags"][0].startswith("3.29"), r["patchTags"])
    check(tag + " wiki tables stay under Reference data, filter on its heading", r["refTitle"] == "Reference data" and
          r["refRows"] > 10 and r["filterInRef"], (r["refTitle"], r["refRows"], r["filterInRef"]))
    check(tag + " scarab names get GGG icons (CDN url, via the art cache)", r["icons"] and
          all(u.startswith("https://web.poecdn.com/gen/image/") for u in r["icons"]), r["icons"][:2])
    check(tag + " stage filter hides lines not tagged for League start", r["allShown"] == r["howTotal"] and
          r["lsShown"] == r["lsWant"] < r["howTotal"] and r["lsOk"], (r["allShown"], r["lsShown"], r["lsWant"]))
    check(tag + " stage filter: strategies, counts, note, remembered", r["lsStrats"] == r["lsStratsWant"] and
          0 < len(r["lsStrats"]) < len(r["wantStrats"]) and r["lsCount"] == "%d of %d" % (r["lsWant"], r["howTotal"]) and "hidden" in (r["hiddenNote"] or "")
          and r["saved"] == "league-start", (r["lsStrats"], r["lsCount"], r["hiddenNote"], r["saved"]))
    check(tag + " All shows every line again", r["backAll"] == r["howTotal"], r["backAll"])
    check(tag + " [n] cite jumps to that source under Read more", r["readOpen"] and r["flashN"] == r["citeText"],
          (r["citeText"], r["flashN"]))
    check(tag + " Read more opens the source via open_url", r["opened"] == r["wantUrl"] and r["sources"] == r["wantSources"],
          (r["opened"], r["wantUrl"]))
    check(tag + " section counts for tables stay", r["tableCount"] and r["tableCount"] != "0", r["tableCount"])
    check(tag + " Blight guide with the anoint helper under Reference data (jump link names it, focuses its search)",
          r["blight"] and r["blightJump"] and r["blightFocus"], (r["blight"], r["blightJump"], r["blightFocus"]))
    check(tag + " Mercenaries: guide-only sheet, no reference data, no Reference link", r["merc"] and
          r["mercJump"] and "ref" not in r["mercJump"], r)
    check(tag + " a sheet without a guide still works (tables, filter, credit)", r["noGuide"] and
          "CC BY-NC-SA" in (r["noGuideFoot"] or ""), r["noGuideFoot"])
    s.fresh("?sheet=1")
    r = s.run(S48_OVERLAY, timeout=60)
    check(tag + " overlay: quick card lines (stage brackets as tags)", r["quick"] == r["wantQuick"] and r["quickTags"] > 0,
          r["quick"])
    check(tag + " overlay: strategy names + More in the app", r["strats"] == r["wantStrats"] and
          (r["more"] or "").startswith("More in the app"), (r["strats"], r["more"]))
    check(tag + " overlay: only the quick card, no long sections, no inputs", r["long"] == 0 and
          r["sections"] == ["Quick card"] and r["inputs"] == 0, (r["long"], r["sections"], r["inputs"]))
    check(tag + " overlay: Quick card | Reference tabs first, Quick card shown", r["tabs"] == ["Quick card", "Reference"] and
          r["tabFirst"] and r["quickOn"], (r["tabs"], r["tabFirst"], r["quickOn"]))
    check(tag + " overlay: strategy names folded to one line, a click lists them, re-fits", r["stratsFolded"] and
          (r["togText"] or "").startswith("Strategies%d" % len(r["wantStrats"])) and r["stratsOpen"] and r["togFit"],
          (r["togText"], r["stratsFolded"], r["stratsOpen"], r["togFit"]))
    check(tag + " overlay: Reference tab shows the tables, re-fits, remembered", r["refOn"] and r["refRows"] > 10 and
          r["tabFit"] and r["tabSaved"] == "ref" and r["backQuick"], (r["refOn"], r["refRows"], r["tabFit"], r["tabSaved"]))
    check(tag + " overlay: Blight's anoint helper one click away under Reference, no inputs", r["blightQuick"] and
          r["blightHelper"] and r["blightInputs"] == 0, (r["blightQuick"], r["blightHelper"], r["blightInputs"]))
    check(tag + " overlay: the tab is remembered per sheet", r["blightKept"] and r["synKept"] == "quick",
          (r["blightKept"], r["synKept"]))
    check(tag + " overlay: Mercenaries sheet opens (no tabs: nothing to reference)", r["mercTitle"] == "Mercenaries of Trarthus" and
          r["mercQuick"] > 0 and r["mercNoTabs"], r)
    check(tag + " overlay: a sheet without a guide is unchanged", r["pantheon"], r)
    s.fresh()
    r = s.run(S48_SYNC, timeout=60, NEWER=False)
    check(tag + " an older server copy keeps the shipped guides", r["version"] == r["shipped"] and
          r["summary"] != "E2E older copy" and r["calls"] == 1, r)
    s.fresh()
    r = s.run(S48_SYNC, timeout=60, NEWER=True)
    check(tag + " a newer server copy replaces the shipped one", r["version"] == r["shipped"] + 1 and
          r["summary"] == "E2E summary from the server", r)
    check(tag + " a new guide-only sheet from the server is listed", r["newSheet"], r)


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
    ("32 gemdiff", scenario_gemdiff),
    ("33 mechanics", scenario_mechanics),
    ("34 quickwins", scenario_quickwins),
    ("35 uibatch", scenario_ui_batch),
    ("36 dust", scenario_dust),
    ("37 ledger", scenario_ledger),
    ("38 sheets2", scenario_sheets2),
    ("39 autocompare", scenario_autocompare),
    ("40 anoints", scenario_anoints),
    ("41 nobuild", scenario_nobuild),
    ("42 atlas", scenario_atlas),
    ("43 lootfilter", scenario_lootfilter),
    ("44 settingstabs", scenario_settings_tabs),
    ("45 patchnotes", scenario_patch_notes),
    ("46 regex", scenario_regex),
    ("47 filtereditor", scenario_filter_editor),
    ("48 guides", scenario_guides),
    ("49 syndicate", scenario_syndicate),
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
