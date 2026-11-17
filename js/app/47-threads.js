/* js/app/47-threads.js — Threads planner (3.30, replaces the retired scarab hub): the ten Threads
   with live prices, what you put in the Map Device per map, free Threads from a Shaped Region, the
   Unwavering Vision keystone, and the cost per map and per hour.

   The rules come from the 3.30.0 patch notes and GGG's FAQ (the Threads and Shaped Regions sheet,
   tools/guides/league-sheets-3.30.json): ten Thread types, "up to a maximum of eight" spent on one
   map, Shaped Regions give free Threads of their type, Unwavering Vision allows one Thread type and
   adds 2 Threads past the cap. What the notes leave open is said as such, never guessed: the odds of
   the transformative effects, whether free Threads count toward the 8, and how many types one map
   takes (Maxroll, unofficial: 3). Prices: mech_prices group "threads" (40-mechtools.js).
   Saved: pobtf-thread-setup (persist(), survives restarts). */
'use strict';

var THR_TYPES = ['Abyss', 'Bestiary', 'Betrayal', 'Blight', 'Breach', 'Expedition', 'Incursion', 'Legion', 'Ritual',
  'Ultimatum'];
var THR_CAP = 8;              // 3.30.0 notes: "up to a maximum of eight"
var THR_UV_EXTRA = 2;         // Unwavering Vision: "2 extra Threads that can go past the cap of 8"
var THR_TYPES_UNOFFICIAL = 3; // Maxroll (unofficial): up to 3 Thread types per map
var THR_KEY = 'pobtf-thread-setup';
var THR_MAX_MAPS = 200;       // maps per hour above this is a typo (a UI bound)
var THR_MAX_CHAOS = 1e6;      // typed costs above this are a typo (a UI bound)
var THR_NO_THREAD = ['Harvest', 'Delirium', 'Essence', 'Delve', 'Heist', 'Mercenaries', 'Strongboxes'];
var THR = { setup: null, views: [] };

function thrName(type) { return type + ' Thread'; }
function thrNum(x, max) { var v = Math.floor(Number(x)); return isFinite(v) && v > 0 ? Math.min(v, max) : 0; }
function thrAmount(x, max) { var v = Number(x); return isFinite(v) && v >= 0 && v <= max ? v : 0; }

// ---- the saved setup --------------------------------------------------------------------
function thrNorm(s) {
  s = s && typeof s === 'object' ? s : {};
  var out = { counts: {}, freeType: '', free: 0, uv: !!s.uv, maps: thrAmount(s.maps, THR_MAX_MAPS),
    other: thrAmount(s.other, THR_MAX_CHAOS) };
  var counts = s.counts && typeof s.counts === 'object' ? s.counts : {};
  var total = 0;
  THR_TYPES.forEach(function (t) {
    var n = Math.min(thrNum(counts[t], THR_CAP), THR_CAP - total);
    if (n > 0) { out.counts[t] = n; total += n; }
  });
  if (out.uv) { // one type only: keep the first one set
    var first = THR_TYPES.filter(function (t) { return out.counts[t]; })[0];
    var keep = first ? out.counts[first] : 0;
    out.counts = {};
    if (first) out.counts[first] = keep;
  }
  if (THR_TYPES.indexOf(s.freeType) !== -1) { out.freeType = s.freeType; out.free = thrNum(s.free, THR_CAP); }
  return out;
}
function thrInit() {
  if (THR.setup) return;
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(THR_KEY)); } catch (e) { raw = null; }
  THR.setup = thrNorm(raw);
}
function thrSave() { try { persist(THR_KEY, JSON.stringify(THR.setup)); } catch (e) { /* storage off */ } }

// ---- sums ---------------------------------------------------------------------------------
function thrPaid() {
  var s = THR.setup;
  return THR_TYPES.reduce(function (a, t) { return a + (s.counts[t] || 0); }, 0);
}
function thrTypesUsed() {
  var s = THR.setup, used = THR_TYPES.filter(function (t) { return s.counts[t]; });
  if (s.free && s.freeType && used.indexOf(s.freeType) === -1) used.push(s.freeType);
  return used;
}
// chaos for the Threads you pay for per map; null when a priced Thread has no price yet
function thrCostPerMap() {
  var s = THR.setup, sum = 0, missing = false;
  THR_TYPES.forEach(function (t) {
    var n = s.counts[t] || 0;
    if (!n) return;
    var c = mechChaos(thrName(t));
    if (c == null) missing = true; else sum += c * n;
  });
  return { chaos: sum + (s.other || 0), missing: missing };
}
function thrC(c) {
  if (c == null || !isFinite(c)) return '-';
  var t = mechPriceText(c);
  return t || (Math.round(c * 10) / 10) + 'c';
}

// ---- changes --------------------------------------------------------------------------------
function thrSetCount(type, n) {
  var s = THR.setup;
  n = thrNum(n, THR_CAP);
  if (s.uv && n > 0) Object.keys(s.counts).forEach(function (t) { if (t !== type) delete s.counts[t]; });
  var others = thrPaid() - (s.counts[type] || 0);
  n = Math.min(n, THR_CAP - others);
  if (n > 0) s.counts[type] = n; else delete s.counts[type];
  thrSave();
  thrRefresh();
}
function thrSet(key, v) { THR.setup[key] = v; THR.setup = thrNorm(THR.setup); thrSave(); thrRefresh(); }

// ---- redraw every mounted planner (app + in-game) -----------------------------------------
function thrRefresh() {
  THR.views = THR.views.filter(function (v) {
    if (v.host.isConnected) v.seen = true;
    else if (v.seen) return false;
    try { v.render(); } catch (e) { /* one view failing keeps the others */ }
    return true;
  });
}
function thrRegion(el, build) { // rebuild, keeping keyboard focus on the same control
  var a = document.activeElement;
  var fk = a && a !== document.body && el.contains(a) && a.dataset ? a.dataset.fk : null;
  el.textContent = '';
  build(el);
  if (fk) {
    var n = el.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(fk) : fk) + '"]');
    if (n && !n.disabled) n.focus();
  }
}

function thrStepper(type, n, max, disabled) {
  var name = thrName(type);
  var g = UI.el('span', 'shub-step thr-step');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', 'How many ' + name);
  var dec = UI.iconButton('−', 'One fewer ' + name, { size: 'sm', onClick: function () { thrSetCount(type, n - 1); } });
  dec.dataset.fk = type + ':dec';
  dec.disabled = disabled || n <= 0;
  var inp = UI.input({ type: 'number', min: 0, max: max, step: 1, value: n, ariaLabel: 'Count of ' + name, cls: 'shub-step-n' });
  inp.dataset.fk = type + ':n';
  inp.disabled = disabled;
  inp.addEventListener('change', function () { thrSetCount(type, inp.value); });
  var inc = UI.iconButton('+', 'One more ' + name, { size: 'sm', onClick: function () { thrSetCount(type, n + 1); } });
  inc.dataset.fk = type + ':inc';
  inc.disabled = disabled || n >= max;
  g.appendChild(dec);
  g.appendChild(inp);
  g.appendChild(inc);
  return g;
}

function thrMount(host, ctx) {
  thrInit();
  var overlay = !!(ctx && ctx.overlay);
  var root = UI.el('div', 'thr' + (overlay ? ' is-overlay' : ''));
  host.appendChild(root);
  if (!overlay) {
    root.appendChild(UI.el('p', 'thr-lead', 'Threads go in the Map Device when you open a map; each adds its ' +
      'league mechanic to that map, and more of one Thread raises the chance of strong random effects for it.'));
  }
  var opts = UI.el('div', 'thr-opts');
  var list = UI.el('div', 'thr-list');
  list.setAttribute('role', 'list');
  var sum = UI.el('div', 'thr-sum');
  sum.setAttribute('aria-live', 'polite');
  var notes = UI.el('ul', 'thr-notes');
  var foot = UI.el('div', 'mech-foot');
  root.appendChild(opts);
  root.appendChild(list);
  root.appendChild(sum);
  root.appendChild(notes);
  root.appendChild(foot);

  function drawOpts(el) {
    var s = THR.setup;
    var uv = UI.el('label', 'toggle thr-uv');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!s.uv;
    cb.dataset.fk = 'uv';
    cb.addEventListener('change', function () { thrSet('uv', cb.checked); });
    uv.appendChild(cb);
    uv.appendChild(UI.el('span', null, 'Unwavering Vision (one Thread type, +' + THR_UV_EXTRA + ' past the cap)'));
    uv.title = 'Atlas keystone: one Thread type on your maps, and maps with Threads get 2 extra that can go past 8. ' +
      'Threads found in your maps have a 75% chance to turn into Gold.';
    el.appendChild(uv);
    var free = UI.el('span', 'thr-free');
    free.appendChild(UI.el('span', 'thr-free-lab', 'Shaped Region:'));
    var sel = UI.select([['', 'none']].concat(THR_TYPES.map(function (t) { return [t, t]; })), s.freeType,
      { ariaLabel: 'Shaped Region type of this map', onChange: function () { thrSet('freeType', sel.value); } });
    sel.dataset.fk = 'freeType';
    free.appendChild(sel);
    if (s.freeType) {
      var fn = UI.input({ type: 'number', min: 0, max: THR_CAP, step: 1, value: s.free || 0, cls: 'shub-step-n',
        ariaLabel: 'Free ' + s.freeType + ' Threads from the Shaped Region' });
      fn.dataset.fk = 'free';
      fn.addEventListener('change', function () { thrSet('free', fn.value); });
      free.appendChild(fn);
      free.appendChild(UI.el('span', 'thr-free-lab', 'free'));
    }
    el.appendChild(free);
    if (!overlay) {
      var mph = UI.el('label', 'thr-mph');
      mph.appendChild(UI.el('span', null, 'Maps per hour'));
      var mi = UI.input({ type: 'number', min: 0, max: THR_MAX_MAPS, step: 1, value: s.maps || '', ariaLabel: 'Maps per hour', cls: 'thr-num' });
      mi.dataset.fk = 'maps';
      mi.addEventListener('change', function () { thrSet('maps', mi.value); });
      mph.appendChild(mi);
      el.appendChild(mph);
      var oth = UI.el('label', 'thr-mph');
      oth.appendChild(UI.el('span', null, 'Other cost per map (c)'));
      var oi = UI.input({ type: 'number', min: 0, max: THR_MAX_CHAOS, step: 1, value: s.other || '',
        ariaLabel: 'Other cost per map in chaos: the map, Embers, Delirium Orbs', cls: 'thr-num' });
      oi.dataset.fk = 'other';
      oi.title = 'The map itself, Embers, Divine Vessels, Delirium Orbs …';
      oi.addEventListener('change', function () { thrSet('other', oi.value); });
      oth.appendChild(oi);
      el.appendChild(oth);
    }
  }

  function drawList(el) {
    var s = THR.setup, paid = thrPaid(), uvType = s.uv ? THR_TYPES.filter(function (t) { return s.counts[t]; })[0] : null;
    THR_TYPES.forEach(function (t) {
      var n = s.counts[t] || 0;
      var row = UI.el('div', 'thr-row' + (n ? ' is-on' : ''));
      row.setAttribute('role', 'listitem');
      row.dataset.type = t;
      row.appendChild(mechIcon(thrName(t), { cls: 'thr-item' }));
      var c = mechChaos(thrName(t));
      row.appendChild(UI.el('span', 'thr-price', c != null ? mechPriceText(c) : (MECH_PRICES.hour ? 'no price' : '')));
      // every row keeps the chip's column, so the steppers line up
      row.appendChild(s.freeType === t && s.free ? UI.chip('+' + s.free + ' free', 'success', 'thr-freechip')
        : UI.el('span', 'thr-freeslot'));
      var locked = !!(uvType && uvType !== t);
      var max = Math.min(THR_CAP, THR_CAP - (paid - n));
      var st = thrStepper(t, n, max, locked);
      if (locked) st.title = 'Unwavering Vision: one Thread type only';
      row.appendChild(st);
      el.appendChild(row);
    });
    var fr = UI.el('div', 'thr-row thr-frayed');
    fr.appendChild(mechIcon('Frayed Thread', { cls: 'thr-item' }));
    var fc = mechChaos('Frayed Thread');
    fr.appendChild(UI.el('span', 'thr-price', fc != null ? mechPriceText(fc) : ''));
    fr.appendChild(UI.el('span', 'thr-frayed-note', 'gives a random Thread when used or sold'));
    el.appendChild(fr);
  }

  function drawSum(el) {
    var s = THR.setup, paid = thrPaid(), cost = thrCostPerMap(), types = thrTypesUsed();
    var extra = s.uv && paid > 0 ? THR_UV_EXTRA : 0;
    var line = UI.el('div', 'thr-sum-line');
    line.appendChild(UI.el('span', 'thr-k', 'Per map'));
    line.appendChild(UI.el('b', 'thr-total', paid + ' / ' + THR_CAP + ' Threads'));
    if (extra) line.appendChild(UI.el('span', 'thr-extra', '+' + extra + ' from Unwavering Vision'));
    if (s.free && s.freeType) line.appendChild(UI.el('span', 'thr-extra', '+' + s.free + ' free (' + s.freeType + ')'));
    var amt = UI.el('b', 'thr-cost', thrC(cost.chaos) + (cost.missing ? ' + unpriced' : ''));
    amt.dataset.chaos = String(Math.round(cost.chaos * 100) / 100);
    line.appendChild(UI.el('span', 'thr-k', 'cost'));
    line.appendChild(amt);
    el.appendChild(line);
    if (s.maps && !overlay) {
      var hr = UI.el('div', 'thr-sum-line');
      hr.appendChild(UI.el('span', 'thr-k', 'Per hour (' + s.maps + ' maps)'));
      var h = UI.el('b', 'thr-cost-hour', thrC(cost.chaos * s.maps));
      h.dataset.chaos = String(Math.round(cost.chaos * s.maps * 100) / 100);
      hr.appendChild(h);
      el.appendChild(hr);
    }
    if (types.length > THR_TYPES_UNOFFICIAL) {
      var w = UI.el('div', 'thr-warn', types.length + ' Thread types on one map: Maxroll (unofficial) says a map takes ' +
        'up to ' + THR_TYPES_UNOFFICIAL + '; the patch notes only cap the count at ' + THR_CAP + '.');
      w.setAttribute('role', 'note');
      el.appendChild(w);
    }
    if (s.free && s.freeType && paid + s.free > THR_CAP) {
      var w2 = UI.el('div', 'thr-warn', 'With the free Threads that is ' + (paid + s.free) + ': not known yet whether ' +
        'free Threads count toward the ' + THR_CAP + '.');
      w2.setAttribute('role', 'note');
      el.appendChild(w2);
    }
  }

  function drawNotes(el) {
    var lines = overlay ? [
      'Shaped Region objective done: +1 free Thread in that region\'s other maps.',
      'No Thread or Shaped Region: that mechanic does not appear.'
    ] : [
      'A map leaves its Shaped Region after one run (FAQ), so run the region\'s maps before regenerating.',
      'Completing a Shaped Region objective gives every other map in that region 1 more free Thread.',
      'Without a Thread or a Shaped Region these ten mechanics do not appear in maps any more.',
      'No Thread for ' + THR_NO_THREAD.join(', ') + '.',
      'The transformative effects are listed on each Thread in game; GGG does not give the odds.'
    ];
    lines.forEach(function (t) { el.appendChild(UI.el('li', null, t)); });
  }

  function render() {
    thrRegion(opts, drawOpts);
    thrRegion(list, drawList);
    thrRegion(sum, drawSum);
    mechPriceFoot(foot);
    if (ctx && typeof ctx.onChange === 'function') ctx.onChange();
  }
  THR.views.push({ host: host, render: render, seen: false });
  if (THR.views.length > 40) THR.views = THR.views.slice(-40);
  drawNotes(notes);
  render();
  mechPrices(['threads'], thrRefresh);
}

mechTool({ id: 'threads', title: 'Threads planner', sheets: ['threads', 'atlas', 'scarabs'], overlay: true, order: 9,
  mount: thrMount });
