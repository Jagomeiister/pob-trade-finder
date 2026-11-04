/* js/app/40-mechtools.js — the shared core of the interactive mechanic tools (scarab hub, price
   boards, pickers, room planner, profit calculator in 41-43): a registry that puts each tool into
   its mechanic sheet, live prices with the game icon for whole item groups, and the small shared
   pieces (item icon, price text, rating pill). The js/app/ files are one program split by
   feature: they load in order (index.html) and share their top-level names. */
'use strict';

// ==== registry ======================================================================
// mechTool({ id, title, sheets: [mechanic ids], mount(container, ctx), overlay: bool, order })
// ctx = { overlay: bool, sheet: mechanic id, onChange() } — onChange re-fits the in-game sheet
// window after the tool changed its height. Tools with overlay: true also show in the in-game
// sheet (a "Tools" tab next to Quick card / Reference); the rest show in the app only.
var MECH_TOOLS = [];

function mechTool(def) {
  if (!def || !def.id || typeof def.mount !== 'function') return;
  MECH_TOOLS = MECH_TOOLS.filter(function (t) { return t.id !== def.id; });
  MECH_TOOLS.push(def);
  MECH_TOOLS.sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
}

// the tools for one sheet; in the overlay only the ones made for it
function mechToolsFor(sheetId, overlay) {
  return MECH_TOOLS.filter(function (t) {
    return (t.sheets || []).indexOf(sheetId) !== -1 && (!overlay || t.overlay);
  });
}

// draw one tool into a fresh box; a tool that throws shows a line instead of breaking the sheet
function mechMount(t, ctx) {
  var host = UI.el('div', 'mech-tool');
  host.dataset.tool = t.id;
  try { t.mount(host, ctx); } catch (e) {
    host.textContent = '';
    host.appendChild(UI.el('div', 'sheet-empty', 'This tool could not load.'));
  }
  return host;
}

// ==== prices ========================================================================
// mech_prices (gui.py): icons and chaos prices for whole groups from GGG's hourly exchange
// feed — no trade-site calls. One load per league and hour covers every tool; a tool asks for
// the groups it needs and gets called back once they are in (straight away when cached).
var MECH_PRICES = { league: null, hour: null, at: 0, groups: {}, items: {}, byName: {}, divine: null, loading: {} };
var MECH_PRICE_TTL = 20 * 60 * 1000; // re-ask after 20 min: the feed is hourly

function mechLeague() { return (document.getElementById('league') || {}).value || 'Standard'; }

function mechPrices(groups, cb) {
  var P = MECH_PRICES, league = mechLeague();
  if (P.league !== league || Date.now() - P.at > MECH_PRICE_TTL) {
    P.league = league; P.groups = {}; P.items = {}; P.byName = {}; P.divine = null; P.at = Date.now();
  }
  var need = groups.filter(function (g) { return !P.groups[g] && !P.loading[g]; });
  var api = isGui() && window.pywebview.api.mech_prices;
  if (!need.length || !api) {
    // already in, or loading (the waiting tool redraws when that load ends), or no bridge
    if (!api || groups.every(function (g) { return P.groups[g]; })) { if (cb) cb(P); }
    else if (cb) mechPriceWaiters.push({ groups: groups, cb: cb });
    return P;
  }
  need.forEach(function (g) { P.loading[g] = 1; });
  if (cb) mechPriceWaiters.push({ groups: groups, cb: cb });
  window.pywebview.api.mech_prices(league, JSON.stringify(need)).then(function (r) {
    if (r && r.ok && P.league === league) {
      Object.keys(r.items || {}).forEach(function (code) {
        var it = r.items[code];
        it.code = code;
        P.items[code] = it;
        P.byName[it.name] = it;
      });
      if (r.divine) P.divine = r.divine;
      P.hour = r.hour || P.hour;
    }
  }).catch(function () { /* no prices: the tools still show names and icons they have */ })
    .then(function () {
      need.forEach(function (g) { delete P.loading[g]; P.groups[g] = 1; });
      var left = [];
      mechPriceWaiters.forEach(function (w) {
        if (w.groups.every(function (g) { return P.groups[g]; })) { try { w.cb(P); } catch (e) { /* tool redraw */ } }
        else left.push(w);
      });
      mechPriceWaiters = left;
    });
  return P;
}
var mechPriceWaiters = [];

// an item by its in-game name ("Ambush Scarab of Containment"); null when the feed lacks it
function mechItem(name) { return MECH_PRICES.byName[name] || null; }
function mechChaos(name) { var it = mechItem(name); return it && it.chaos != null ? it.chaos : null; }

// "4.2c", "38c", "2.3 div" (at or above one divine); '' for no price
function mechPriceText(chaos) {
  if (chaos == null || !isFinite(chaos)) return '';
  var div = MECH_PRICES.divine;
  if (div && Math.abs(chaos) >= div) return (Math.round(chaos / div * 10) / 10) + ' div';
  var a = Math.abs(chaos);
  return (a < 10 ? Math.round(chaos * 10) / 10 : Math.round(chaos)) + 'c';
}
// how old the prices are: "prices from 14:00" (the feed hour), for the tools' footers
function mechPriceAge() {
  var h = MECH_PRICES.hour;
  if (!h) return isGui() ? 'No prices yet (offline, or the feed has not answered).' : 'Prices show in the app.';
  var d = new Date(h * 1000);
  return 'Prices: GGG currency exchange, hour of ' + d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + '.';
}

// ==== shared pieces =================================================================
// an item: its game icon (when the feed knows it) and its name; opts.price adds the price,
// opts.iconOnly keeps the name as a tooltip only, opts.count prefixes "3×"
function mechIcon(name, opts) {
  opts = opts || {};
  var it = mechItem(name);
  var el = UI.el('span', 'mech-item' + (opts.cls ? ' ' + opts.cls : ''));
  var price = it && it.chaos != null ? mechPriceText(it.chaos) : '';
  el.title = name + (price ? ' · ' + price + ' each' : '');
  if (opts.count && opts.count > 1) el.appendChild(UI.el('span', 'mech-item-n', opts.count + '×'));
  if (it && it.img) {
    var img = document.createElement('img');
    img.src = it.img;
    img.alt = '';
    img.loading = 'lazy';
    img.className = 'mech-item-img';
    img.addEventListener('error', function () { img.remove(); el.classList.remove('has-img'); });
    el.classList.add('has-img');
    el.appendChild(img);
  }
  var label = UI.el('span', 'mech-item-name', name);
  if (opts.iconOnly && it && it.img) el.classList.add('icon-only'); // the name stays for screen readers
  el.appendChild(label);
  if (opts.price && price) el.appendChild(UI.el('span', 'mech-item-price', price));
  return el;
}

// a rating: colour and words together (never colour alone)
var MECH_RATINGS = {
  safe: ['Safe', 'success'], caution: ['Caution', 'warn'], deadly: ['Run-ending', 'danger'],
  high: ['High value', 'success'], medium: ['Some value', 'warn'], low: ['Low value', 'neutral'],
};
function mechRating(r, label) {
  var x = MECH_RATINGS[r] || [r || '?', 'neutral'];
  return UI.chip(label || x[0], x[1], 'mech-rating mech-rating-' + (r || 'none'));
}

// the build-type tags the pickers use (dangerousFor), with words for the chips
var MECH_BUILD_TAGS = [
  ['life-regen', 'Life regen'], ['leech', 'Leech'], ['es', 'Energy shield'], ['minion', 'Minions'],
  ['dot', 'Damage over time'], ['attack', 'Attacks'], ['spell', 'Spells'], ['low-max-res', 'Low max res'],
  ['flask', 'Flask-reliant'], ['curse', 'Curses'], ['mana', 'Mana-reliant'], ['low-ehp', 'Low EHP / glass'],
];
function mechTagName(t) {
  var p = MECH_BUILD_TAGS.filter(function (x) { return x[0] === t; })[0];
  return p ? p[1] : t === 'all' ? 'Every build' : t;
}

// the build types the pickers check against: remembered (persist), shared by every picker
var MECH_BUILD_KEY = 'pobtf-mech-build';
function mechBuildTags() {
  try { var v = JSON.parse(localStorage.getItem(MECH_BUILD_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function mechSetBuildTags(tags) { persist(MECH_BUILD_KEY, JSON.stringify(tags)); }

// a row of toggle chips for "my build is ..."; onChange(tags)
function mechBuildPicker(onChange) {
  var box = UI.el('div', 'mech-build');
  box.appendChild(UI.el('span', 'mech-build-label', 'My build uses'));
  var row = UI.el('div', 'mech-build-tags');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'What your build relies on');
  var mine = mechBuildTags();
  MECH_BUILD_TAGS.forEach(function (p) {
    var b = UI.el('button', 'mech-tag', p[1]);
    b.type = 'button';
    b.setAttribute('aria-pressed', mine.indexOf(p[0]) !== -1 ? 'true' : 'false');
    b.addEventListener('click', function () {
      var on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var cur = mechBuildTags().filter(function (t) { return t !== p[0]; });
      if (on) cur.push(p[0]);
      mechSetBuildTags(cur);
      if (onChange) onChange(cur);
    });
    row.appendChild(b);
  });
  box.appendChild(row);
  return box;
}

// does this mod hit my build? 'all' always does; no tags picked = only 'all'
function mechHitsBuild(dangerousFor, tags) {
  var d = dangerousFor || [];
  if (d.indexOf('all') !== -1) return true;
  return d.some(function (t) { return tags.indexOf(t) !== -1; });
}

// a text filter box; onInput(query)
function mechSearch(placeholder, onInput) {
  var inp = UI.input({ placeholder: placeholder, cls: 'mech-search' });
  inp.type = 'search';
  inp.setAttribute('aria-label', placeholder);
  inp.addEventListener('input', function () { onInput(inp.value.trim().toLowerCase()); });
  return inp;
}
function mechMatches(hay, q) {
  if (!q) return true;
  hay = String(hay || '').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
}

// a source footnote line: "Sources: Maxroll · PoE Wiki" with the links opening outside
function mechSources(sources) {
  var f = UI.el('div', 'mech-foot');
  if (!(sources || []).length) return f;
  f.appendChild(document.createTextNode('Sources: '));
  sources.forEach(function (s, i) {
    if (i) f.appendChild(document.createTextNode(' · '));
    var a = UI.el('a', 'mech-src', s.publisher || s.title || s.url);
    a.href = '#';
    a.title = (s.title || '') + (s.date ? ' (' + s.date + ')' : '');
    a.addEventListener('click', function (e) { e.preventDefault(); if (typeof openUrl === 'function') openUrl(s.url); });
    f.appendChild(a);
  });
  return f;
}
