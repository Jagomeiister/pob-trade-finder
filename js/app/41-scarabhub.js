/* js/app/41-scarabhub.js — Scarab hub and profit calculator: every scarab with its icon, live price,
   effect and per-map limit; a "My setup" list (scarabs plus map cost, embers, astrolabes, delirium
   orbs ... or typed amounts) with the cost per map; Atlas strategy presets that fill the setup; and
   a profit calculator (maps per hour, cost per map, expected return) next to the community
   estimates for the picked strategy. Both tools register with 40-mechtools.js and share one state
   (the strategy pick and the setup total), so a change in either redraws both. The js/app/ files are
   one program split by feature: they load in order (index.html) and share their top-level names. */
'use strict';

// ==== data ==========================================================================
// Scarab effect / limit / rarity: the Scarabs cheat sheet table (data/cheatsheets.js). Prices and
// icons: mech_prices (40-mechtools.js). Strategies: mechToolData().strategies, else the Atlas
// guide's strategies (data/guides.js). Nothing here is a game fact of its own: every number shown
// comes from those, or from what the user typed.
// Saved: pobtf-scarab-setup and pobtf-profit-calc (persist(), so they survive restarts).

var SHUB_SETUP_KEY = 'pobtf-scarab-setup';
var SHUB_CALC_KEY = 'pobtf-profit-calc';
var SHUB_HUB_GROUPS = ['scarabs', 'fragments', 'delirium', 'embers', 'currency'];
var SHUB_COST_GROUPS = ['fragments', 'delirium', 'embers', 'currency'];
var SHUB_ALL_GROUPS = ['scarabs', 'fossils', 'essences', 'lifeforce', 'oils', 'catalysts', 'delirium',
  'fragments', 'expedition', 'embers', 'currency'];
var SHUB_MAX_COUNT = 99;      // a stepper cap when the sheet gives no per-map limit (a UI bound)
var SHUB_MAX_CHAOS = 1e7;     // typed amounts above this are a typo (a UI bound)
var SHUB_PICK_SHOWN = 8;      // item picker: matches shown at once

var SHUB = { setup: null, calc: null, views: [], ui: { q: '', fam: '', sort: 'price' }, sheetSec: null, sheetMap: null };

// ---- the Scarabs cheat sheet table ---------------------------------------------------
function shubSheetSection() {
  var m = typeof mechanicById === 'function' ? mechanicById('scarabs') : null;
  if (!m) {
    var C = window.POE_CHEATSHEETS;
    m = C && (C.mechanics || []).filter(function (x) { return x.id === 'scarabs'; })[0];
  }
  return m && (m.sections || []).filter(function (s) {
    return /effect, limit per map/i.test(s.title || '') && Array.isArray(s.columns) && Array.isArray(s.rows);
  })[0] || null;
}
// lower-case name -> { name, effect, limit (number|null), rarity }
function shubSheet() {
  var sec = shubSheetSection();
  if (sec === SHUB.sheetSec && SHUB.sheetMap) return SHUB.sheetMap;
  var map = {};
  if (sec) {
    var col = function (re, def) {
      for (var i = 0; i < sec.columns.length; i++) if (re.test(sec.columns[i])) return i;
      return def;
    };
    var cn = col(/^scarab/i, 0), ce = col(/effect/i, -1), cl = col(/max per map|limit/i, -1), cr = col(/rarity/i, -1);
    sec.rows.forEach(function (r) {
      var name = String(r[cn] || '').trim();
      if (!name) return;
      var lim = cl >= 0 ? parseInt(r[cl], 10) : NaN;
      map[name.toLowerCase()] = { name: name, effect: ce >= 0 ? String(r[ce] || '') : '',
        limit: lim >= 1 ? lim : null, rarity: cr >= 0 && r[cr] && r[cr] !== '-' ? String(r[cr]) : '' };
    });
  }
  SHUB.sheetSec = sec;
  SHUB.sheetMap = map;
  return map;
}
function shubSheetRow(name) { return shubSheet()[String(name || '').toLowerCase()] || null; }

// ---- price items by lower-case name ----------------------------------------------------
var shubPriceIdx = { src: null, n: -1, map: {} };
function shubPriceIndex() {
  var items = MECH_PRICES.items, keys = Object.keys(items);
  if (shubPriceIdx.src !== items || shubPriceIdx.n !== keys.length) {
    var map = {};
    keys.forEach(function (k) { var it = items[k]; if (it && it.name) map[it.name.toLowerCase()] = it; });
    shubPriceIdx = { src: items, n: keys.length, map: map };
  }
  return shubPriceIdx.map;
}
function shubHasPrices() { return Object.keys(MECH_PRICES.items).length > 0; }
// the in-game spelling of a name: a price item first, then the cheat sheet; null when neither knows it
function shubCanon(name) {
  var k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  var it = shubPriceIndex()[k];
  if (it) return it.name;
  var r = shubSheet()[k];
  return r ? r.name : null;
}
function shubChaos(name) {
  var it = mechItem(name) || shubPriceIndex()[String(name || '').toLowerCase()];
  return it && it.chaos != null && isFinite(it.chaos) ? it.chaos : null;
}

// "Ambush Scarab of X" -> Ambush; "Titanic Scarab" -> Titanic; "Scarab of Wisps" -> Other
function shubFamily(name) {
  var m = /^(.*?)\s*Scarab\b/i.exec(name || '');
  var f = m && m[1].trim();
  return f || 'Other';
}

// every scarab: the cheat sheet rows plus any the price feed has that the sheet lacks
function shubScarabs() {
  var seen = {}, out = [];
  var sheet = shubSheet();
  Object.keys(sheet).forEach(function (k) {
    var r = sheet[k];
    seen[k] = 1;
    out.push({ name: r.name, effect: r.effect, limit: r.limit, rarity: r.rarity, family: shubFamily(r.name) });
  });
  Object.keys(MECH_PRICES.items).forEach(function (code) {
    var it = MECH_PRICES.items[code];
    if (!it || it.group !== 'scarabs' || !it.name) return;
    var k = it.name.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ name: it.name, effect: '', limit: null, rarity: '', family: shubFamily(it.name) });
  });
  return out;
}

// ---- strategies ----------------------------------------------------------------------
// One shape for both sources: { name, stage, lines: [{ text, name|null, count, max|null, optional }],
// mapsPerHour, costPerMapChaos, url, profit: [{ text, who, date }], asOf }
function shubToolData() {
  return typeof mechToolData === 'function' ? mechToolData() : { strategies: [], sources: [], asOf: '' };
}
function shubAtlasGuide() {
  var g = typeof guideFor === 'function' ? guideFor('atlas') : null;
  if (!g) { var d = window.POE_GUIDES; g = d && d.guides && d.guides.atlas; }
  return g || null;
}
function shubAsOf() {
  var T = shubToolData(), g = shubAtlasGuide(), d = window.POE_GUIDES;
  return (T && T.asOf) || (g && g.asOf) || (d && d.asOf) || '';
}

// "3x Allflame Ember of the Ethereal (up to 4 allowed)" -> 3 × the ember, max 4.
// "Optional: X" / "Budget: X" / "X (juiced)" are alternatives: listed, not added.
function shubParseLine(line) {
  var t = String(line || '').trim(), optional = false, notes = [];
  var lab = /^([A-Za-z][A-Za-z ]{1,30}):\s*(.+)$/.exec(t);
  if (lab) { optional = true; t = lab[2]; }
  t = t.replace(/\s*\(([^)]*)\)/g, function (_, n) { notes.push(n); return ''; }).trim();
  if (notes.some(function (n) { return /juiced|optional|budget/i.test(n); })) optional = true;
  var c = /^(\d+)\s*[x×]\s+(.+)$/i.exec(t);
  var count = c ? parseInt(c[1], 10) : 1, name = c ? c[2].trim() : t, max = null;
  notes.forEach(function (n) {
    var m = /(?:up to|limit)\s*(\d+)/i.exec(n);
    if (m) max = parseInt(m[1], 10);
  });
  return { text: String(line || '').trim(), name: shubCanon(name), count: count >= 1 ? count : 1,
           max: max >= 1 ? max : null, optional: optional };
}

var SHUB_STOP = { farm: 1, farming: 1, scarab: 1, scarabs: 1, league: 1, start: 1, with: 1, play: 1, only: 1,
  tier: 1, boss: 1, rush: 1, maxroll: 1, vault: 1 };
function shubWords(s) {
  return String(s || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)
    .filter(function (w) { return w.length >= 4 && !SHUB_STOP[w]; });
}
// the atlas guide's profit lines about one strategy: the line's subject (before its first colon)
// names the strategy's first key word, or two of them; or the line starts with the author the
// strategy name carries in brackets ("(pohx)")
function shubProfitFor(name, lines) {
  var main = String(name || '').replace(/\([^)]*\)/g, ' ');
  var authors = shubWords((String(name || '').match(/\(([^)]*)\)/g) || []).join(' '));
  var words = shubWords(main);
  return (lines || []).filter(function (p) {
    var t = String(p && p.text || ''), ci = t.indexOf(':');
    var subj = (ci > 0 && ci < 60 ? t.slice(0, ci) : t).toLowerCase();
    if (words.length && subj.indexOf(words[0]) !== -1) return true;
    if (words.filter(function (w) { return subj.indexOf(w) !== -1; }).length >= 2) return true;
    var first = t.toLowerCase().split(/\s+/)[0];
    return authors.indexOf(first) !== -1;
  });
}
function shubUrlIn(lines) {
  for (var i = 0; i < (lines || []).length; i++) {
    var m = /https?:\/\/[^\s)]+/.exec(String(lines[i] || ''));
    if (m) return m[0].replace(/[.,;]+$/, '');
  }
  return '';
}
function shubNum(x) { return typeof x === 'number' && isFinite(x) && x > 0 ? x : null; }

function shubStrategies() {
  var T = shubToolData(), asOf = shubAsOf();
  if (T && (T.strategies || []).length) {
    return T.strategies.filter(function (s) { return s && s.name; }).map(function (s) {
      return { name: s.name, stage: s.stage || [], src: 'tools', asOf: asOf,
        lines: (s.scarabs || []).map(function (x) {
          var n = Math.round(+x.count) >= 1 ? Math.round(+x.count) : 1;
          return { text: (n > 1 ? n + 'x ' : '') + x.name, name: shubCanon(x.name), count: n, max: null, optional: false };
        }),
        mapsPerHour: shubNum(s.mapsPerHour), costPerMapChaos: shubNum(s.costPerMapChaos),
        url: s.atlasTreeUrl || '', profit: (s.profit || []).filter(function (p) { return p && p.text; }) };
    });
  }
  var g = shubAtlasGuide();
  return ((g && g.strategies) || []).filter(function (s) { return s && s.name; }).map(function (s) {
    return { name: s.name, stage: s.stage || [], src: 'guide', asOf: asOf,
      lines: (s.scarabs || []).map(shubParseLine),
      mapsPerHour: shubNum(s.mapsPerHour), costPerMapChaos: shubNum(s.costPerMapChaos),
      url: s.atlasTreeUrl || shubUrlIn(s.atlasPassives), profit: shubProfitFor(s.name, g.profit) };
  });
}
function shubStrategy(name) {
  if (!name) return null;
  return shubStrategies().filter(function (s) { return s.name === name; })[0] || null;
}

// ---- state ---------------------------------------------------------------------------
function shubText(s, n) { return typeof s === 'string' ? s.trim().slice(0, n) : ''; }
function shubAmount(x) { var v = Number(x); return isFinite(v) && v >= 0 && v <= SHUB_MAX_CHAOS ? v : null; }

// { v, strategy, items: [{ name, n, max? }], extras: [{ label, chaos }] }
function shubNormSetup(s) {
  var o = { v: 1, strategy: '', items: [], extras: [] };
  if (!s || typeof s !== 'object') return o;
  o.strategy = shubText(s.strategy, 200);
  (Array.isArray(s.items) ? s.items : []).slice(0, 60).forEach(function (x) {
    var name = x && shubText(x.name, 120);
    if (!name || o.items.some(function (y) { return y.name === name; })) return;
    var n = Math.round(Number(x.n)), mx = Math.round(Number(x.max));
    var it = { name: name, n: n >= 1 ? Math.min(n, SHUB_MAX_COUNT) : 1 };
    if (mx >= 1 && mx <= SHUB_MAX_COUNT) it.max = mx;
    o.items.push(it);
  });
  (Array.isArray(s.extras) ? s.extras : []).slice(0, 30).forEach(function (x) {
    var c = x && shubAmount(x.chaos);
    if (c == null) return;
    o.extras.push({ label: shubText(x.label, 40) || 'Other cost', chaos: c });
  });
  return o;
}
// { v, mph, cost (override or null), rows: [{ name, n } | { label, chaos }] }
function shubNormCalc(s) {
  var o = { v: 1, mph: null, cost: null, rows: [] };
  if (!s || typeof s !== 'object') return o;
  var mph = Number(s.mph);
  if (s.mph != null && isFinite(mph) && mph > 0 && mph <= 1000) o.mph = mph;
  if (s.cost != null) o.cost = shubAmount(s.cost);
  (Array.isArray(s.rows) ? s.rows : []).slice(0, 60).forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    if (typeof x.name === 'string' && x.name) {
      var n = Number(x.n);
      o.rows.push({ name: shubText(x.name, 120), n: isFinite(n) && n >= 0 && n <= 1e5 ? n : 1 });
    } else {
      var c = shubAmount(x.chaos);
      if (c != null) o.rows.push({ label: shubText(x.label, 40) || 'Other return', chaos: c });
    }
  });
  return o;
}
function shubRead(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}
function shubInit() {
  if (!SHUB.setup) SHUB.setup = shubNormSetup(shubRead(SHUB_SETUP_KEY));
  if (!SHUB.calc) SHUB.calc = shubNormCalc(shubRead(SHUB_CALC_KEY));
}
function shubSaveSetup() { try { persist(SHUB_SETUP_KEY, JSON.stringify(SHUB.setup)); } catch (e) { /* storage off */ } }
function shubSaveCalc() { try { persist(SHUB_CALC_KEY, JSON.stringify(SHUB.calc)); } catch (e) { /* storage off */ } }

// the most of one item per map: the strategy's note, else the cheat sheet, else the UI cap
function shubLimit(name) { var r = shubSheetRow(name); return r ? r.limit : null; }
function shubMax(it) { return it.max || shubLimit(it.name) || SHUB_MAX_COUNT; }

// ---- redraw: every mounted view of either tool ---------------------------------------------
function shubView(host, render) {
  var v = { host: host, render: render, seen: false };
  SHUB.views.push(v);
  if (SHUB.views.length > 40) SHUB.views = SHUB.views.slice(-40); // never-shown hosts don't pile up
  return v;
}
function shubRefresh() {
  SHUB.views = SHUB.views.filter(function (v) {
    if (v.host.isConnected) v.seen = true;
    else if (v.seen) return false; // the sheet was closed or redrawn: drop it
    try { v.render(); } catch (e) { /* one view failing keeps the others */ }
    return true;
  });
}
// rebuild one region, keeping keyboard focus on the control with the same data-fk
function shubRegion(el, build) {
  var a = document.activeElement;
  var fk = a && a !== document.body && el.contains(a) && a.dataset ? a.dataset.fk : null;
  el.textContent = '';
  build(el);
  if (fk) {
    var n = el.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(fk) : fk) + '"]');
    if (n && !n.disabled) n.focus();
  }
}

// ---- amounts ---------------------------------------------------------------------------
function shubC(c) {
  if (c == null || !isFinite(c)) return '-';
  var v = Math.abs(c) < 10 ? Math.round(c * 10) / 10 : Math.round(c);
  if (v === 0) v = 0; // no "-0c"
  return v.toLocaleString('en-US') + 'c';
}
function shubD(c) {
  var d = MECH_PRICES.divine;
  if (!d || c == null || !isFinite(c)) return '';
  var v = Math.round(c / d * 100) / 100;
  if (v === 0) v = 0;
  return v.toLocaleString('en-US') + ' div';
}
// "155c · 0.78 div", the chaos value on data-chaos for tests and screen readers alike
function shubAmt(c, cls) {
  var el = UI.el('span', 'shub-amt' + (cls ? ' ' + cls : ''));
  el.dataset.chaos = c == null || !isFinite(c) ? '' : String(Math.round(c * 100) / 100);
  el.appendChild(UI.el('span', 'shub-amt-c', shubC(c)));
  var d = shubD(c);
  if (d) el.appendChild(UI.el('span', 'shub-amt-d', d));
  return el;
}
function shubPriceLabel(chaos) {
  if (chaos != null) return UI.el('span', 'mech-item-price shub-price', mechPriceText(chaos));
  return MECH_PRICES.hour ? UI.chip('no price', 'neutral', 'shub-noprice') : null;
}
function shubPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// ---- totals -----------------------------------------------------------------------------
function shubSetupTotal() {
  var S = SHUB.setup, chaos = 0, missing = [];
  S.items.forEach(function (it) {
    var c = shubChaos(it.name);
    if (c == null) missing.push(it.name); else chaos += c * Math.min(it.n, shubMax(it));
  });
  S.extras.forEach(function (x) { chaos += x.chaos; });
  return { chaos: chaos, missing: missing, rows: S.items.length + S.extras.length };
}
function shubReturnTotal() {
  var chaos = 0, missing = [];
  SHUB.calc.rows.forEach(function (r) {
    if (r.name) {
      var c = shubChaos(r.name);
      if (c == null) missing.push(r.name); else chaos += c * r.n;
    } else chaos += r.chaos;
  });
  return { chaos: chaos, missing: missing };
}
function shubCostPerMap() {
  return SHUB.calc.cost != null ? SHUB.calc.cost : shubSetupTotal().chaos;
}

// ---- setup edits --------------------------------------------------------------------------
function shubAdd(name, n) {
  var S = SHUB.setup, it = S.items.filter(function (x) { return x.name === name; })[0];
  if (!it) { it = { name: name, n: 0 }; S.items.push(it); }
  var max = shubMax(it), want = it.n + (n || 1);
  if (it.n >= max) {
    UI.toast('Limit reached: ' + name + ' allows ' + max + ' per map.', 'info');
    return;
  }
  it.n = Math.min(want, max);
  shubSaveSetup();
  shubRefresh();
}
function shubSetCount(name, n) {
  var it = SHUB.setup.items.filter(function (x) { return x.name === name; })[0];
  if (!it) return;
  n = Math.round(Number(n));
  it.n = Math.max(1, Math.min(isFinite(n) ? n : 1, shubMax(it)));
  shubSaveSetup();
  shubRefresh();
}
function shubRemove(name) {
  SHUB.setup.items = SHUB.setup.items.filter(function (x) { return x.name !== name; });
  shubSaveSetup();
  shubRefresh();
}

// the setup a strategy fills: its matched, non-optional lines (counts capped by the limit)
function shubPresetItems(st) {
  var out = [];
  st.lines.forEach(function (l) {
    if (!l.name || l.optional) return;
    var have = out.filter(function (x) { return x.name === l.name; })[0];
    if (have) { have.n += l.count; return; }
    var it = { name: l.name, n: l.count };
    if (l.max) it.max = l.max;
    out.push(it);
  });
  out.forEach(function (it) { it.n = Math.max(1, Math.min(it.n, shubMax(it))); });
  return out;
}
// pick a strategy (from either tool): fills My setup, after a confirm when it isn't empty
function shubPickStrategy(name, sel) {
  var S = SHUB.setup, st = shubStrategy(name);
  function apply(fill) {
    S.strategy = st ? st.name : '';
    if (fill) S.items = shubPresetItems(st);
    if (st && st.mapsPerHour) { SHUB.calc.mph = st.mapsPerHour; shubSaveCalc(); }
    shubSaveSetup();
    shubRefresh();
  }
  var fills = !!(st && st.lines.some(function (l) { return l.name && !l.optional; }));
  if (!fills || !S.items.length) { apply(fills); return; }
  UI.confirmDanger('Replace My setup?',
    'Picking "' + st.name + '" replaces the scarabs and items in My setup. Typed costs stay.', 'Replace')
    .then(function (ok) {
      if (ok) apply(true);
      else if (sel) { sel.value = S.strategy; shubRefresh(); }
    });
}

// ==== shared pieces ==========================================================================
// the strategy select + its links; opts.lines: also list the lines that were not added
function shubStrategyBar(opts) {
  var box = UI.el('div', 'shub-strat');
  var list = shubStrategies();
  var sel = UI.select([['', 'My own (no strategy)']].concat(list.map(function (s) { return [s.name, s.name]; })),
    '', { ariaLabel: 'Atlas strategy preset', cls: 'shub-strat-select' });
  sel.dataset.fk = 'strategy';
  sel.addEventListener('change', function () { shubPickStrategy(sel.value, sel); });
  var row = UI.el('div', 'shub-strat-row');
  row.appendChild(UI.field('Strategy', sel));
  var link = UI.el('span', 'shub-strat-link');
  row.appendChild(link);
  box.appendChild(row);
  var info = UI.el('div', 'shub-strat-info');
  box.appendChild(info);
  function render() {
    var st = shubStrategy(SHUB.setup.strategy);
    if (sel.value !== (st ? st.name : '') && document.activeElement !== sel) sel.value = st ? st.name : '';
    shubRegion(link, function (el) {
      if (!st || !st.url) return;
      var b = UI.button('secondary', { size: 'sm', label: 'Open atlas tree', cls: 'shub-atlas-link',
        title: st.url, onClick: function () { openUrl(st.url); } });
      b.dataset.fk = 'atlas';
      el.appendChild(b);
    });
    shubRegion(info, function (el) {
      if (!st) return;
      var facts = [];
      if (st.mapsPerHour) facts.push('about ' + st.mapsPerHour + ' maps per hour');
      if (st.costPerMapChaos) facts.push('about ' + shubC(st.costPerMapChaos) + ' per map');
      if (facts.length) {
        el.appendChild(UI.el('div', 'shub-note', 'Strategy figures (rough' + (st.asOf ? ', as of ' + st.asOf : '') + '): ' +
          facts.join(', ') + '.'));
      }
      if (!opts || !opts.lines) return;
      if (!st.lines.length) { el.appendChild(UI.el('div', 'shub-note', 'This strategy lists no scarabs.')); return; }
      var left = st.lines.filter(function (l) { return l.optional || !l.name; });
      if (!left.length) return;
      var wrap = UI.el('div', 'shub-left');
      wrap.appendChild(UI.el('div', 'shub-left-title', 'Not added from this strategy'));
      var ul = UI.el('ul', 'shub-left-list');
      left.forEach(function (l) {
        var li = UI.el('li', 'shub-left-item');
        li.appendChild(UI.el('span', 'shub-left-text', l.text));
        if (l.name) {
          li.appendChild(UI.chip('optional', 'info'));
          var b = UI.button('ghost', { size: 'sm', label: 'Add', ariaLabel: 'Add ' + l.name + ' to My setup',
            onClick: function () { shubAdd(l.name, l.count); } });
          b.dataset.fk = 'left:' + l.name;
          li.appendChild(b);
        } else {
          li.appendChild(UI.chip(l.optional ? 'optional, no matching item' : 'no matching item', 'neutral'));
        }
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      el.appendChild(wrap);
    });
  }
  return { el: box, render: render };
}

// an item picker (search with icons) plus a typed amount; onItem(name), onTyped(label, chaos)
function shubPicker(groups, fk, what, onItem, onTyped) {
  var box = UI.el('div', 'shub-picker');
  var q = mechSearch('Find ' + what, function () { draw(); });
  q.dataset.fk = fk + ':q';
  box.appendChild(q);
  var res = UI.el('div', 'shub-picker-res');
  res.setAttribute('role', 'group');
  res.setAttribute('aria-label', 'Matching items');
  box.appendChild(res);
  function draw() {
    shubRegion(res, function (el) {
      var v = q.value.trim().toLowerCase();
      if (!v) return;
      if (!shubHasPrices()) {
        el.appendChild(UI.el('div', 'mech-empty', isGui() ? 'No price list yet (offline?). Add a typed amount below.'
          : 'Item search works in the app (prices show there). Add a typed amount below.'));
        return;
      }
      var found = Object.keys(MECH_PRICES.items).map(function (k) { return MECH_PRICES.items[k]; })
        .filter(function (it) { return it && groups.indexOf(it.group) !== -1 && mechMatches(it.name, v); })
        .sort(function (a, b) {
          var sa = a.name.toLowerCase().indexOf(v) === 0 ? 0 : 1, sb = b.name.toLowerCase().indexOf(v) === 0 ? 0 : 1;
          return sa - sb || (a.name < b.name ? -1 : 1);
        });
      if (!found.length) { el.appendChild(UI.el('div', 'mech-empty', 'No item matches "' + q.value.trim() + '".')); return; }
      found.slice(0, SHUB_PICK_SHOWN).forEach(function (it) {
        var b = UI.button('ghost', { cls: 'shub-pick', ariaLabel: 'Add ' + it.name +
          (it.chaos != null ? ', ' + mechPriceText(it.chaos) + ' each' : ', no price') });
        b.dataset.name = it.name;
        b.dataset.fk = fk + ':pick:' + it.name;
        b.appendChild(mechIcon(it.name, { price: true }));
        if (it.chaos == null) b.appendChild(UI.chip('no price', 'neutral'));
        b.addEventListener('click', function () {
          onItem(it.name);
          q.value = '';
          draw();
          q.focus();
        });
        el.appendChild(b);
      });
      if (found.length > SHUB_PICK_SHOWN) {
        el.appendChild(UI.el('div', 'mech-empty', (found.length - SHUB_PICK_SHOWN) + ' more: type more of the name.'));
      }
    });
  }
  // a typed amount with a label
  var typed = UI.el('div', 'shub-typed');
  var lab = UI.input({ placeholder: 'Label', ariaLabel: 'Label for a typed amount', cls: 'shub-typed-label' });
  lab.maxLength = 40;
  var amt = UI.input({ type: 'number', min: 0, step: 'any', placeholder: 'Chaos', ariaLabel: 'Chaos per map',
    cls: 'shub-typed-chaos' });
  var add = UI.button('secondary', { size: 'sm', label: 'Add amount', cls: 'shub-typed-add', onClick: function () {
    var c = shubAmount(amt.value === '' ? NaN : amt.value);
    if (c == null) { UI.toast('Type a chaos amount (0 or more).', 'warn'); amt.focus(); return; }
    onTyped(lab.value.trim().slice(0, 40), c);
    lab.value = '';
    amt.value = '';
    lab.focus();
  } });
  [lab, amt].forEach(function (i) {
    i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
  });
  typed.appendChild(lab);
  typed.appendChild(amt);
  typed.appendChild(UI.el('span', 'shub-unit', 'c'));
  typed.appendChild(add);
  box.appendChild(typed);
  box.draw = draw;
  return box;
}

// a − [n] + stepper; onSet(n)
function shubStepper(name, n, max, fk, onSet) {
  var g = UI.el('span', 'shub-step');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', 'How many ' + name);
  var dec = UI.iconButton('−', 'One fewer ' + name, { size: 'sm', onClick: function () { onSet(n - 1); } });
  dec.dataset.fk = fk + ':dec';
  dec.disabled = n <= 1;
  var inp = UI.input({ type: 'number', min: 1, max: max, step: 1, value: n, ariaLabel: 'Count of ' + name,
    cls: 'shub-step-n' });
  inp.dataset.fk = fk + ':n';
  inp.addEventListener('change', function () { onSet(inp.value); });
  var inc = UI.iconButton('+', 'One more ' + name, { size: 'sm', onClick: function () { onSet(n + 1); } });
  inc.dataset.fk = fk + ':inc';
  inc.disabled = n >= max;
  g.appendChild(dec);
  g.appendChild(inp);
  g.appendChild(inc);
  return g;
}

// ==== Scarab hub ==============================================================================
function shubMount(host, ctx) {
  shubInit();
  var root = UI.el('div', 'shub');
  host.appendChild(root);
  var bar = shubStrategyBar({ lines: true });
  root.appendChild(bar.el);

  var cols = UI.el('div', 'shub-cols');
  root.appendChild(cols);

  // ---- left: every scarab
  var left = UI.el('section', 'shub-list-col');
  left.setAttribute('aria-label', 'Scarabs');
  var ctl = UI.el('div', 'shub-controls');
  var search = mechSearch('Search scarabs, effects', function (q) { SHUB.ui.q = q; drawList(); });
  search.value = SHUB.ui.q;
  ctl.appendChild(search);
  var fam = UI.select([['', 'All families']], SHUB.ui.fam, { ariaLabel: 'Mechanic family', cls: 'shub-fam',
    onChange: function () { SHUB.ui.fam = fam.value; drawList(); } });
  ctl.appendChild(fam);
  var sort = UI.segmented([['price', 'Price'], ['name', 'Name']], SHUB.ui.sort, { ariaLabel: 'Sort scarabs by',
    titles: { price: 'Price, high to low', name: 'Name, A to Z' },
    onChange: function (v) { SHUB.ui.sort = v; drawList(); } });
  sort.classList.add('shub-sort');
  ctl.appendChild(sort);
  left.appendChild(ctl);
  var count = UI.el('div', 'shub-count');
  count.setAttribute('aria-live', 'polite');
  left.appendChild(count);
  var list = UI.el('div', 'shub-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Scarabs: pick one to add it to My setup');
  left.appendChild(list);
  cols.appendChild(left);

  // ---- right: my setup
  var right = UI.el('section', 'shub-setup');
  right.setAttribute('aria-label', 'My setup');
  right.appendChild(UI.el('h4', 'shub-h', 'My setup'));
  var rows = UI.el('div', 'shub-rows');
  right.appendChild(rows);
  var total = UI.el('div', 'shub-total');
  total.setAttribute('aria-live', 'polite');
  right.appendChild(total);
  var other = UI.el('div', 'shub-other');
  other.appendChild(UI.el('div', 'shub-sub', 'Add a map cost or other item'));
  var picker = shubPicker(SHUB_COST_GROUPS, 'cost', 'a map, ember, astrolabe, delirium orb, chisel ...',
    function (name) { shubAdd(name, 1); },
    function (label, chaos) {
      SHUB.setup.extras.push({ label: label || 'Other cost', chaos: chaos });
      shubSaveSetup();
      shubRefresh();
    });
  other.appendChild(picker);
  right.appendChild(other);
  var clear = UI.button('ghost', { size: 'sm', label: 'Clear setup', cls: 'shub-clear', onClick: function () {
    UI.confirmDanger('Clear My setup?', 'Removes every scarab, item and typed cost from My setup.', 'Clear')
      .then(function (ok) {
        if (!ok) return;
        SHUB.setup.items = [];
        SHUB.setup.extras = [];
        SHUB.setup.strategy = '';
        shubSaveSetup();
        shubRefresh();
      });
  } });
  right.appendChild(clear);
  cols.appendChild(right);

  var foot = UI.el('div', 'mech-foot shub-foot');
  root.appendChild(foot);

  var famKey = '';
  function drawFamilies(all) {
    var counts = {};
    all.forEach(function (s) { counts[s.family] = (counts[s.family] || 0) + 1; });
    var names = Object.keys(counts).sort(function (a, b) {
      return (a === 'Other') - (b === 'Other') || (a < b ? -1 : 1);
    });
    var key = names.map(function (n) { return n + counts[n]; }).join('|');
    if (key === famKey) return;
    famKey = key;
    var cur = SHUB.ui.fam;
    fam.textContent = '';
    [['', 'All families']].concat(names.map(function (n) {
      return [n, (n === 'Other' ? 'Other (Scarab of ...)' : n) + ' (' + counts[n] + ')'];
    })).forEach(function (p) {
      var o = UI.el('option', null, p[1]);
      o.value = p[0];
      fam.appendChild(o);
    });
    fam.value = counts[cur] ? cur : '';
    SHUB.ui.fam = fam.value;
  }

  function drawList() {
    var all = shubScarabs();
    drawFamilies(all);
    var q = SHUB.ui.q, f = SHUB.ui.fam;
    var shown = all.filter(function (s) {
      return (!f || s.family === f) && mechMatches(s.name + ' ' + s.effect, q);
    }).map(function (s) { s.chaos = shubChaos(s.name); return s; });
    shown.sort(function (a, b) {
      if (SHUB.ui.sort === 'price') {
        var pa = a.chaos == null ? -1 : a.chaos, pb = b.chaos == null ? -1 : b.chaos;
        if (pa !== pb) return pb - pa;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    count.textContent = all.length ? 'Showing ' + shown.length + ' of ' + shubPlural(all.length, 'scarab', 'scarabs') + '.'
      : 'No scarab list (the Scarabs cheat sheet is missing).';
    var inSetup = {};
    SHUB.setup.items.forEach(function (it) { inSetup[it.name] = it; });
    shubRegion(list, function (el) {
      if (!shown.length && all.length) { el.appendChild(UI.el('div', 'mech-empty', 'No scarab matches.')); return; }
      shown.forEach(function (s) {
        var have = inSetup[s.name], lim = s.limit;
        var price = s.chaos != null ? mechPriceText(s.chaos) : (MECH_PRICES.hour ? 'no price' : '');
        var b = UI.button('ghost', { cls: 'shub-scarab' + (have ? ' is-in' : ''),
          ariaLabel: 'Add ' + s.name + ' to My setup.' + (price ? ' ' + price + '.' : '') +
            (s.effect ? ' ' + s.effect + '.' : '') + (lim ? ' Up to ' + lim + ' per map.' : '') +
            (have ? ' In setup: ' + have.n + '.' : '') });
        b.dataset.name = s.name;
        b.dataset.fk = 'add:' + s.name;
        var top = UI.el('span', 'shub-scarab-top');
        top.appendChild(mechIcon(s.name));
        var pl = shubPriceLabel(s.chaos);
        if (pl) top.appendChild(pl);
        b.appendChild(top);
        if (s.effect) b.appendChild(UI.el('span', 'shub-effect', s.effect));
        var meta = UI.el('span', 'shub-meta');
        meta.appendChild(UI.el('span', 'shub-limit', lim ? 'Max ' + lim + ' per map' : 'Limit not listed'));
        if (s.rarity) meta.appendChild(UI.el('span', 'shub-rarity', s.rarity));
        if (have) meta.appendChild(UI.chip('In setup: ' + have.n, 'success', 'shub-in'));
        b.appendChild(meta);
        b.addEventListener('click', function () { shubAdd(s.name, 1); });
        el.appendChild(b);
      });
    });
  }

  function drawSetup() {
    var S = SHUB.setup;
    shubRegion(rows, function (el) {
      if (!S.items.length && !S.extras.length) {
        el.appendChild(UI.el('div', 'mech-empty', 'Empty. Pick scarabs on the left, or a strategy above.'));
        return;
      }
      S.items.forEach(function (it) {
        var row = UI.el('div', 'shub-row');
        row.dataset.name = it.name;
        var max = shubMax(it), lim = it.max || shubLimit(it.name), c = shubChaos(it.name);
        var name = UI.el('div', 'shub-row-name');
        name.appendChild(mechIcon(it.name));
        if (lim) name.appendChild(UI.el('span', 'shub-limit', 'max ' + lim));
        row.appendChild(name);
        row.appendChild(shubStepper(it.name, Math.min(it.n, max), max, 'it:' + it.name, function (n) { shubSetCount(it.name, n); }));
        var cost = UI.el('div', 'shub-row-cost');
        if (c != null) {
          cost.appendChild(shubAmt(c * Math.min(it.n, max), 'shub-line'));
          if (it.n > 1) cost.appendChild(UI.el('span', 'shub-each', mechPriceText(c) + ' each'));
        } else cost.appendChild(UI.chip('no price', 'neutral', 'shub-noprice'));
        row.appendChild(cost);
        var rm = UI.iconButton('✕', 'Remove ' + it.name, { size: 'sm', onClick: function () { shubRemove(it.name); } });
        rm.dataset.fk = 'it:' + it.name + ':rm';
        row.appendChild(rm);
        el.appendChild(row);
      });
      S.extras.forEach(function (x, i) {
        var row = UI.el('div', 'shub-row is-typed');
        row.dataset.label = x.label;
        var name = UI.el('div', 'shub-row-name');
        name.appendChild(UI.el('span', 'shub-typed-name', x.label));
        name.appendChild(UI.chip('typed', 'neutral'));
        row.appendChild(name);
        row.appendChild(UI.el('span', 'shub-step-gap'));
        var cost = UI.el('div', 'shub-row-cost');
        cost.appendChild(shubAmt(x.chaos, 'shub-line'));
        row.appendChild(cost);
        var rm = UI.iconButton('✕', 'Remove ' + x.label, { size: 'sm', onClick: function () {
          S.extras.splice(i, 1);
          shubSaveSetup();
          shubRefresh();
        } });
        rm.dataset.fk = 'ex:' + i + ':rm';
        row.appendChild(rm);
        el.appendChild(row);
      });
    });
    var T = shubSetupTotal();
    shubRegion(total, function (el) {
      var line = UI.el('div', 'shub-total-line');
      line.appendChild(UI.el('span', 'shub-total-label', 'Cost per map'));
      line.appendChild(shubAmt(T.chaos, 'shub-total-amt'));
      el.appendChild(line);
      if (T.missing.length) {
        el.appendChild(UI.el('div', 'shub-note shub-missing', shubPlural(T.missing.length, 'item has', 'items have') +
          ' no price and ' + (T.missing.length === 1 ? 'is' : 'are') + ' left out of the total: ' + T.missing.join(', ') + '.'));
      }
    });
  }

  function render() {
    bar.render();
    drawList();
    drawSetup();
    picker.draw();
    mechPriceFoot(foot);
    if (ctx && ctx.onChange) ctx.onChange();
  }
  shubView(host, render);
  render();
  mechPrices(SHUB_HUB_GROUPS, shubRefresh);
}

// ==== Profit calculator =========================================================================
function shubCalcMount(host, ctx) {
  shubInit();
  var C = SHUB.calc;
  var root = UI.el('div', 'pcalc');
  host.appendChild(root);
  var bar = shubStrategyBar({ lines: false });
  root.appendChild(bar.el);

  var cols = UI.el('div', 'pcalc-cols');
  root.appendChild(cols);
  var inputs = UI.el('section', 'pcalc-in');
  inputs.setAttribute('aria-label', 'Inputs');
  cols.appendChild(inputs);

  // maps per hour
  var mph = UI.input({ type: 'number', min: 0, step: 'any', placeholder: 'Maps', ariaLabel: 'Maps per hour', cls: 'pcalc-mph' });
  mph.dataset.fk = 'mph';
  mph.addEventListener('input', function () {
    var v = Number(mph.value);
    SHUB.calc.mph = mph.value !== '' && isFinite(v) && v > 0 && v <= 1000 ? v : null;
    shubSaveCalc();
    shubRefresh();
  });
  var mphRow = UI.el('div', 'pcalc-field');
  mphRow.appendChild(UI.field('Maps per hour', mph));
  var mphHint = UI.el('div', 'shub-note pcalc-mph-hint');
  mphRow.appendChild(mphHint);
  inputs.appendChild(mphRow);

  // cost per map: the setup total, or an override
  var cost = UI.input({ type: 'number', min: 0, step: 'any', placeholder: 'My setup', ariaLabel: 'Cost per map override, chaos',
    cls: 'pcalc-cost' });
  cost.dataset.fk = 'cost';
  cost.addEventListener('input', function () {
    SHUB.calc.cost = cost.value === '' ? null : shubAmount(cost.value);
    shubSaveCalc();
    shubRefresh();
  });
  var costRow = UI.el('div', 'pcalc-field');
  var costLine = UI.el('div', 'pcalc-cost-line');
  costLine.appendChild(UI.field('Cost per map', cost));
  costLine.appendChild(UI.el('span', 'shub-unit', 'c'));
  var useSetup = UI.button('ghost', { size: 'sm', label: 'Use My setup', cls: 'pcalc-use-setup', onClick: function () {
    SHUB.calc.cost = null;
    cost.value = '';
    shubSaveCalc();
    shubRefresh();
    cost.focus();
  } });
  costLine.appendChild(useSetup);
  costRow.appendChild(costLine);
  var costHint = UI.el('div', 'shub-note pcalc-cost-hint');
  costRow.appendChild(costHint);
  inputs.appendChild(costRow);

  // expected return per map
  var ret = UI.el('div', 'pcalc-field pcalc-ret');
  ret.appendChild(UI.el('div', 'shub-sub', 'Expected return per map'));
  var retRows = UI.el('div', 'shub-rows pcalc-rows');
  ret.appendChild(retRows);
  var picker = shubPicker(SHUB_ALL_GROUPS, 'ret', 'an item you expect to drop',
    function (name) {
      var have = SHUB.calc.rows.filter(function (r) { return r.name === name; })[0];
      if (have) have.n += 1; else SHUB.calc.rows.push({ name: name, n: 1 });
      shubSaveCalc();
      shubRefresh();
    },
    function (label, chaos) {
      SHUB.calc.rows.push({ label: label || 'Other return', chaos: chaos });
      shubSaveCalc();
      shubRefresh();
    });
  ret.appendChild(picker);
  inputs.appendChild(ret);

  // output + community estimates
  var side = UI.el('section', 'pcalc-out-col');
  side.setAttribute('aria-label', 'Result');
  var out = UI.el('div', 'pcalc-out');
  out.setAttribute('aria-live', 'polite');
  side.appendChild(out);
  var est = UI.el('div', 'pcalc-est');
  side.appendChild(est);
  cols.appendChild(side);

  var foot = UI.el('div', 'mech-foot shub-foot');
  root.appendChild(foot);

  function drawRows() {
    shubRegion(retRows, function (el) {
      var R = SHUB.calc.rows;
      if (!R.length) { el.appendChild(UI.el('div', 'mech-empty', 'Nothing yet. Find an item below, or type an amount.')); return; }
      R.forEach(function (r, i) {
        var row = UI.el('div', 'shub-row' + (r.name ? '' : ' is-typed'));
        var name = UI.el('div', 'shub-row-name');
        var c = r.name ? shubChaos(r.name) : null;
        if (r.name) {
          row.dataset.name = r.name;
          name.appendChild(mechIcon(r.name));
          var n = UI.input({ type: 'number', min: 0, step: 'any', value: r.n, ariaLabel: 'How many ' + r.name + ' per map',
            cls: 'shub-step-n' });
          n.dataset.fk = 'ret:' + i + ':n';
          n.addEventListener('change', function () {
            var v = Number(n.value);
            r.n = isFinite(v) && v >= 0 && v <= 1e5 ? v : r.n;
            shubSaveCalc();
            shubRefresh();
          });
          row.appendChild(name);
          var q = UI.el('span', 'shub-step');
          q.appendChild(n);
          q.appendChild(UI.el('span', 'shub-unit', '×'));
          row.appendChild(q);
        } else {
          row.dataset.label = r.label;
          name.appendChild(UI.el('span', 'shub-typed-name', r.label));
          name.appendChild(UI.chip('typed', 'neutral'));
          row.appendChild(name);
          row.appendChild(UI.el('span', 'shub-step-gap'));
        }
        var cc = UI.el('div', 'shub-row-cost');
        if (!r.name) cc.appendChild(shubAmt(r.chaos, 'shub-line'));
        else if (c != null) {
          cc.appendChild(shubAmt(c * r.n, 'shub-line'));
          cc.appendChild(UI.el('span', 'shub-each', mechPriceText(c) + ' each'));
        } else cc.appendChild(UI.chip('no price', 'neutral', 'shub-noprice'));
        row.appendChild(cc);
        var rm = UI.iconButton('✕', 'Remove ' + (r.name || r.label), { size: 'sm', onClick: function () {
          SHUB.calc.rows.splice(i, 1);
          shubSaveCalc();
          shubRefresh();
        } });
        rm.dataset.fk = 'ret:' + i + ':rm';
        row.appendChild(rm);
        el.appendChild(row);
      });
    });
  }

  function outLine(el, label, chaos, key, cls) {
    var row = UI.el('div', 'pcalc-line' + (cls ? ' ' + cls : ''));
    row.dataset.key = key;
    row.appendChild(UI.el('span', 'pcalc-label', label));
    if (chaos == null) row.appendChild(UI.el('span', 'shub-amt pcalc-none', '-'));
    else row.appendChild(shubAmt(chaos));
    el.appendChild(row);
  }

  function drawOut() {
    var st = shubStrategy(SHUB.setup.strategy);
    var setupT = shubSetupTotal(), retT = shubReturnTotal();
    var costC = shubCostPerMap(), m = SHUB.calc.mph;
    var profit = retT.chaos - costC;
    shubRegion(out, function (el) {
      el.appendChild(UI.el('h4', 'shub-h', 'Result'));
      outLine(el, 'Return per map', retT.chaos, 'return');
      outLine(el, 'Cost per map', costC, 'cost');
      outLine(el, profit < 0 ? 'Loss per map' : 'Profit per map', profit, 'profit', profit < 0 ? 'is-loss' : 'is-profit');
      outLine(el, profit < 0 ? 'Loss per hour' : 'Profit per hour', m ? profit * m : null, 'profitHour',
        'pcalc-big ' + (profit < 0 ? 'is-loss' : 'is-profit'));
      outLine(el, 'Investment per hour', m ? costC * m : null, 'investHour');
      if (!m) el.appendChild(UI.el('div', 'shub-note', 'Enter maps per hour for the per-hour lines.'));
      var miss = retT.missing.concat(SHUB.calc.cost == null ? setupT.missing : []);
      if (miss.length) {
        el.appendChild(UI.el('div', 'shub-note shub-missing', shubPlural(miss.length, 'item has', 'items have') +
          ' no price and ' + (miss.length === 1 ? 'is' : 'are') + ' left out: ' + miss.join(', ') + '.'));
      }
    });
    shubRegion(est, function (el) {
      el.appendChild(UI.el('h4', 'shub-h', 'Community estimates'));
      el.appendChild(UI.chip('rough, community claims', 'warn', 'pcalc-rough'));
      var asOf = (st && st.asOf) || shubAsOf();
      if (asOf) el.appendChild(UI.chip('as of ' + asOf, 'neutral', 'pcalc-asof'));
      if (!st) { el.appendChild(UI.el('div', 'mech-empty', 'Pick a strategy to see what players report for it.')); return; }
      if (!st.profit.length) { el.appendChild(UI.el('div', 'mech-empty', 'No estimate listed for ' + st.name + '.')); return; }
      var ul = UI.el('ul', 'pcalc-est-list');
      st.profit.forEach(function (p) {
        var li = UI.el('li', 'pcalc-est-item');
        li.appendChild(UI.el('span', 'pcalc-est-text', p.text));
        var by = [p.who, p.date].filter(Boolean).join(', ');
        if (by) li.appendChild(UI.el('span', 'pcalc-est-who', by));
        ul.appendChild(li);
      });
      el.appendChild(ul);
    });
    // input hints and values (not while the user types in them)
    if (document.activeElement !== mph) mph.value = m != null ? String(m) : '';
    mphHint.textContent = st && st.mapsPerHour ? 'From the strategy: about ' + st.mapsPerHour + ' (rough). Change it to your pace.'
      : m ? '' : 'Your own pace: count the maps you finish in one hour.';
    if (document.activeElement !== cost) cost.value = SHUB.calc.cost != null ? String(SHUB.calc.cost) : '';
    useSetup.hidden = SHUB.calc.cost == null;
    costHint.textContent = SHUB.calc.cost == null
      ? 'From My setup: ' + shubC(setupT.chaos) + (setupT.rows ? '' : ' (empty: add scarabs in the Scarab hub)') + '.'
      : 'Typed. My setup costs ' + shubC(setupT.chaos) + '.';
  }

  function render() {
    bar.render();
    drawRows();
    drawOut();
    picker.draw();
    mechPriceFoot(foot);
    if (ctx && ctx.onChange) ctx.onChange();
  }
  shubView(host, render);
  render();
  mechPrices(SHUB_ALL_GROUPS, shubRefresh);
}

mechTool({ id: 'scarabhub', title: 'Scarab hub', sheets: ['scarabs', 'atlas'], overlay: false, order: 10, mount: shubMount });
mechTool({ id: 'profitcalc', title: 'Profit calculator', sheets: ['atlas', 'scarabs'], overlay: false, order: 11,
  mount: shubCalcMount });
