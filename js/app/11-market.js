/* js/app/11-market.js — sparklines, Market page, price alerts, chart, flips.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- chaos-equivalent prices + build cost summary ------------------------------
var RATES = {}; // league -> {currency: chaosRate}

// ---- sparkline: one series, de-emphasis line, accent latest point, crosshair --
// points: [{t: unix seconds, v: number, sub: optional secondary text}]
function sparkline(points, opts) {
  opts = opts || {};
  var w = opts.w || 96, h = opts.h || 22, pad = 3;
  var wrap = document.createElement('span');
  wrap.className = 'spark';
  if (!points || points.length < 2) return wrap;
  var NS = 'http://www.w3.org/2000/svg';
  var vals = points.map(function (p) { return p.v; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (hi === lo) { hi += 1; lo -= 1; }
  var t0 = points[0].t, t1 = points[points.length - 1].t;
  function x(p) { return pad + (t1 === t0 ? 0 : (p.t - t0) / (t1 - t0)) * (w - 2 * pad); }
  function y(p) { return h - pad - (p.v - lo) / (hi - lo) * (h - 2 * pad); }
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('aria-hidden', 'true');
  var line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points.map(function (p) { return x(p).toFixed(1) + ',' + y(p).toFixed(1); }).join(' '));
  line.setAttribute('class', 'spark-line');
  svg.appendChild(line);
  var hair = document.createElementNS(NS, 'line');
  hair.setAttribute('class', 'spark-hair'); hair.setAttribute('y1', 0); hair.setAttribute('y2', h);
  svg.appendChild(hair);
  var last = points[points.length - 1];
  var dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', 'spark-dot'); dot.setAttribute('r', 3);
  dot.setAttribute('cx', x(last)); dot.setAttribute('cy', y(last));
  svg.appendChild(dot);
  wrap.appendChild(svg);

  var fmt = opts.fmt || function (v) { return String(v); };
  var tip = document.createElement('span');
  tip.className = 'spark-tip hidden';
  wrap.appendChild(tip);
  function show(i) {
    var p = points[i];
    hair.setAttribute('x1', x(p)); hair.setAttribute('x2', x(p));
    hair.classList.add('on');
    dot.setAttribute('cx', x(p)); dot.setAttribute('cy', y(p));
    tip.textContent = '';
    var b = document.createElement('b');
    b.textContent = fmt(p.v);
    tip.appendChild(b);
    var when = new Date(p.t * 1000);
    tip.appendChild(document.createTextNode(' · ' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + (p.sub ? ' · ' + p.sub : '')));
    tip.classList.remove('hidden');
    tip.style.left = Math.min(Math.max(0, x(p) - 60), w) + 'px';
  }
  function hide() {
    hair.classList.remove('on');
    dot.setAttribute('cx', x(last)); dot.setAttribute('cy', y(last));
    tip.classList.add('hidden');
  }
  function nearest(clientX) {
    var r = svg.getBoundingClientRect();
    var px = (clientX - r.left) * (w / r.width), best = 0;
    points.forEach(function (p, i) { if (Math.abs(x(p) - px) < Math.abs(x(points[best]) - px)) best = i; });
    return best;
  }
  var idx = points.length - 1;
  svg.addEventListener('pointermove', function (e) { idx = nearest(e.clientX); show(idx); });
  svg.addEventListener('pointerleave', hide);
  // keyboard: focus the chart, arrows walk the points
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', (opts.label || 'Trend') + ': from ' + fmt(points[0].v) + ' to ' + fmt(last.v) +
    ', low ' + fmt(Math.min.apply(null, vals)) + ', high ' + fmt(Math.max.apply(null, vals)));
  wrap.addEventListener('focus', function () { show(idx); });
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight') idx = Math.min(points.length - 1, idx + 1);
    else return;
    e.preventDefault(); show(idx);
  });
  return wrap;
}

function fmtCompact(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (v >= 100) return String(Math.round(v));
  if (v >= 1) return String(Math.round(v * 10) / 10);
  return String(+v.toPrecision(2)); // cheap orbs: 0.042, not 0
}
function fmtDelta(first, last) {
  if (!first) return '';
  var d = (last - first) / first * 100;
  return (Math.abs(d) < 0.05 ? '±0.0' : (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1)) + '%';
}

// ---- market: GGG's hourly currency-exchange feed (no trade-API quota) -------
// One overview call prices every exchange item over 7 days (6-hourly); the big
// chart loads the 1-day and 30-day views for the selected item on demand.
var market = null; // {league, hour, items: {code: {name, cat, img, s: [[t, chaos, vol]], st}}, hist}
var THIN_MARKET_CHAOS = 5000; // median chaos-equivalent traded per hour
var marketSeq = 0;
var marketDirty = false;
var MK = { sel: 'divine', range: 7, cat: 'All', q: '', hideThin: false, movers: 24, showAll: false,
           convAmt: '1', convCode: 'divine', alertOpen: false, els: null };
var CDN_ROOT = 'https://web.poecdn.com';
var MARKET_ROWS = 80;

function loadWatch() {
  try { var w = JSON.parse(localStorage.getItem('pobtf-watch')); if (Array.isArray(w)) return w; }
  catch (e) { /* default below */ }
  return ['divine', 'exalted', 'mirror', 'annul'];
}
function saveWatch(w) { persist('pobtf-watch', JSON.stringify(w)); }
function toggleWatch(code) {
  var w = loadWatch();
  var i = w.indexOf(code);
  if (i === -1) w.push(code); else w.splice(i, 1);
  saveWatch(w);
  renderWatch();
  renderMarketTable();
  renderChartCard();
}

// ---- price alerts ------------------------------------------------------------------
// pobtf-alerts: {code: {above, below, unit: 'c'|'div', move (24h %), fired: {rule: bool}}}.
// Checked on every market load (the feed is hourly). A rule fires when it becomes true
// and re-arms once it is false again, so a price sitting past a level alerts once.
function loadAlerts() {
  try {
    var a = JSON.parse(localStorage.getItem('pobtf-alerts'));
    if (a && typeof a === 'object' && !Array.isArray(a)) return a;
  } catch (e) { /* none yet */ }
  return {};
}
function saveAlerts(a) { persist('pobtf-alerts', JSON.stringify(a)); }

// which rules hold right now, plus the readable price they were judged on
function alertState(al, it) {
  var dr = RATES[market.league] && RATES[market.league].divine;
  var div = al.unit === 'div';
  var now = div ? (dr ? it.st.now / dr : null) : it.st.now;
  var ch = it.st.ch24;
  return {
    price: now === null ? '' : fmtCompact(now) + (div ? ' div' : 'c'),
    above: al.above != null && now !== null && now >= al.above,
    below: al.below != null && now !== null && now <= al.below,
    move: al.move != null && ch !== null && isFinite(ch) && Math.abs(ch) * 100 >= al.move
  };
}

function alertMessage(rule, al, it, s) {
  var u = al.unit === 'div' ? ' div' : 'c';
  if (rule === 'above') return it.name + ' rose to ' + s.price + ' (alert: above ' + al.above + u + ')';
  if (rule === 'below') return it.name + ' fell to ' + s.price + ' (alert: below ' + al.below + u + ')';
  var p = it.st.ch24 * 100;
  return it.name + (p > 0 ? ' up ' : ' down ') + Math.abs(p).toFixed(1) + '% in 24h (now ' + s.price + ')';
}

function checkAlerts() {
  if (!market) return;
  var alerts = loadAlerts(), hits = [], changed = false;
  Object.keys(alerts).forEach(function (code) {
    var al = alerts[code], it = market.items[code];
    if (!it) return;
    al.fired = al.fired || {};
    var s = alertState(al, it);
    ['above', 'below', 'move'].forEach(function (rule) {
      if (s[rule] && !al.fired[rule]) {
        hits.push({ code: code, text: alertMessage(rule, al, it, s) });
        al.fired[rule] = true;
        changed = true;
      } else if (!s[rule] && al.fired[rule]) {
        al.fired[rule] = false;
        changed = true;
      }
    });
  });
  if (changed) saveAlerts(alerts);
  if (!hits.length) return;
  hits.forEach(function (h) {
    UI.toast('🔔 ' + h.text, 'info', { timeout: 0, action: { label: 'View', onClick: function () {
      setView('market');
      selectMarketItem(h.code, true);
    } } });
  });
  if (PREFS.notify !== false && isGui() && window.pywebview.api.notify && !document.hasFocus()) {
    window.pywebview.api.notify(hits.length === 1 ? 'Price alert' : hits.length + ' price alerts',
      hits.map(function (h) { return h.text; }).join(' · ')).then(function () {}, function () {});
  }
}

// inline form under the chart header: rise above / fall below / 24h move
function alertForm(code, it) {
  var alerts = loadAlerts(), al = alerts[code] || {};
  var form = UI.el('div', 'mk-alert');
  form.appendChild(UI.el('div', 'mk-alert-title', 'Notify me when ' + it.name + '…'));
  var row = UI.el('div', 'mk-alert-row');
  function num(v, label) {
    return UI.input({ type: 'number', cls: 'min-input', min: 0, step: 'any', ariaLabel: label,
                      value: v == null ? '' : v, placeholder: '—' });
  }
  var above = num(al.above, 'Rises above'), below = num(al.below, 'Falls below');
  var dr = RATES[market.league] && RATES[market.league].divine;
  var unit = UI.select([['c', 'chaos'], ['div', 'divine']], al.unit || (dr && it.st.now >= 2 * dr ? 'div' : 'c'),
    { ariaLabel: 'Price unit' });
  var move = num(al.move, 'Moves more than, percent');
  UI.field('Rises above', above, { parent: row });
  UI.field('Falls below', below, { parent: row });
  UI.field('Unit', unit, { parent: row });
  UI.field('Moves more than (% in 24h)', move, { parent: row });
  form.appendChild(row);
  var note = UI.el('div', 'finder-sub');
  note.setAttribute('aria-live', 'polite');
  form.appendChild(note);
  function val(i) { var v = parseFloat(i.value); return isFinite(v) && v > 0 ? v : null; }
  var acts = UI.el('div', 'mk-alert-acts');
  acts.appendChild(UI.button('primary', { label: 'Save alert', size: 'sm', onClick: function () {
    var next = { above: val(above), below: val(below), unit: unit.value, move: val(move) };
    var all = loadAlerts();
    if (next.above === null && next.below === null && next.move === null) {
      delete all[code];
    } else {
      // start from what is true now: only a fresh crossing notifies
      var s = alertState(next, it);
      next.fired = { above: s.above, below: s.below, move: s.move };
      all[code] = next;
      var w = loadWatch();
      if (w.indexOf(code) === -1) { w.push(code); saveWatch(w); }
    }
    saveAlerts(all);
    MK.alertOpen = false;
    renderChartCard();
    renderWatch();
    renderMarketTable();
    var held = all[code] && ['above', 'below', 'move'].filter(function (r) { return all[code].fired[r]; });
    UI.toast(!all[code] ? 'Alert removed for ' + it.name
      : held.length ? 'Alert saved. That\'s already true now, so it will notify the next time it happens.'
      : 'Alert saved for ' + it.name + '. Checked each hour while the app is open.', 'success');
  } }));
  if (alerts[code]) {
    acts.appendChild(UI.button('ghost', { label: 'Remove alert', size: 'sm', onClick: function () {
      var all = loadAlerts();
      delete all[code];
      saveAlerts(all);
      MK.alertOpen = false;
      renderChartCard();
      renderWatch();
      UI.toast('Alert removed for ' + it.name, 'success');
    } }));
  }
  form.appendChild(acts);
  function showNow() {
    note.textContent = 'Now ' + (unit.value === 'div' && dr ? fmtCompact(it.st.now / dr) + ' div' : fmtCompact(it.st.now) + 'c') +
      '. Checked each hour while the app is open. Windows notification when it\'s in the background.';
  }
  unit.addEventListener('change', showNow);
  showNow();
  return form;
}

async function loadMarket() {
  if (!isGui() || !window.pywebview.api.cx_overview) return;
  var league = document.getElementById('league').value;
  var seq = ++marketSeq;
  var tile = document.getElementById('market-tile');
  tile.classList.remove('hidden');
  if (!market || market.league !== league) {
    tile.querySelector('.mt-value').textContent = '…';
    tile.querySelector('.mt-delta').textContent = 'loading 7-day history';
  }
  try {
    var r = await window.pywebview.api.cx_overview(league);
    if (seq !== marketSeq) return; // league switched mid-load
    if (!r || !r.ok) throw new Error((r && r.error) || 'feed unavailable');
    Object.keys(r.items).forEach(function (c) { r.items[c].st = marketStats(r.items[c]); });
    market = { league: league, hour: r.hour, items: r.items, hist: {} };
    if (!market.items[MK.sel]) MK.sel = market.items.divine ? 'divine' : Object.keys(market.items)[0];
    // seed the rate cache: chaos equivalents for every exchange item, no trade-API calls
    RATES[league] = RATES[league] || {};
    RATES[league].chaos = 1;
    Object.keys(r.items).forEach(function (c) { RATES[league][c] = r.items[c].st.now; });
    marketDirty = true;
    refreshEqDisplays(); // re-annotates listings and renders the market tile/page
    checkAlerts();
  } catch (e) {
    if (seq !== marketSeq) return;
    tile.querySelector('.mt-value').textContent = '—';
    tile.querySelector('.mt-delta').textContent = 'market feed unavailable';
    tile.title = String(e.message || e);
  }
}

// now, typical volume, 24h / 7d change, 7-day range — from the 6-hourly series
function marketStats(it) {
  var s = it.s, last = s[s.length - 1];
  var vols = s.map(function (p) { return p[2]; }).sort(function (a, b) { return a - b; });
  var med = vols[Math.floor(vols.length / 2)] || 0;
  var dayAgo = null;
  for (var i = s.length - 1; i >= 0; i--) { if (s[i][0] <= last[0] - 86400) { dayAgo = s[i]; break; } }
  var vals = s.map(function (p) { return p[1]; });
  return { now: last[1], vol: med, thin: med < THIN_MARKET_CHAOS,
           ch24: dayAgo && dayAgo[1] ? (last[1] - dayAgo[1]) / dayAgo[1] : null,
           ch7: s.length > 1 && s[0][1] ? (last[1] - s[0][1]) / s[0][1] : null,
           lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals) };
}

function marketPoints(code) {
  var it = market && market.items[code];
  return ((it && it.s) || []).map(function (p) {
    return { t: p[0], v: p[1], sub: p[2] ? fmtCompact(p[2]) + 'c traded/h' : 'no trades that hour' };
  });
}

// "▲ 12.3%": arrow + number, never colour alone
// costly: a rise is bad news (build cost), so it takes the "down" colour
function pctChip(x, costly) {
  var span = UI.el('span', 'pct');
  if (x === null || x === undefined || !isFinite(x)) { span.textContent = '—'; return span; }
  var p = x * 100;
  span.textContent = Math.abs(p) < 0.05 ? '±0.0%' : (p > 0 ? '▲ ' : '▼ ') + Math.abs(p).toFixed(1) + '%';
  span.classList.add(Math.abs(p) < 0.05 ? 'flat' : (p > 0) !== !!costly ? 'up' : 'down');
  return span;
}

function mPrice(chaos) {
  var dr = market && RATES[market.league] && RATES[market.league].divine;
  return fmtCompact(chaos) + 'c' + (dr && chaos >= dr ? ' · ' + fmtCompact(chaos / dr) + ' div' : '');
}

function itemImg(it, cls) {
  var img = UI.el('img', cls || 'mk-ic');
  img.alt = '';
  img.loading = 'lazy';
  img.src = it && it.img ? CDN_ROOT + it.img : BLANK_PX;
  return img;
}

function selectMarketItem(code, scroll) {
  MK.sel = code;
  renderChartCard();
  renderMarketTable();
  if (scroll && MK.els) MK.els.chart.scrollIntoView({ block: 'nearest' });
}

// ---- price chart: line + area, labelled axes, crosshair tooltip, keyboard ----
function priceChart(points, opts) {
  opts = opts || {};
  var w = Math.max(320, opts.w || 640), h = opts.h || 220;
  var pl = 56, pr = 12, pt = 10, pb = 26;
  var wrap = UI.el('div', 'pc');
  if (points.length < 2) { wrap.appendChild(UI.el('div', 'finder-sub', 'Not enough history yet.')); return wrap; }
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  var vals = points.map(function (p) { return p.v; });
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var padV = (hi - lo) * 0.08 || hi * 0.05 || 1;
  lo = Math.max(0, lo - padV); hi += padV;
  var t0 = points[0].t, t1 = points[points.length - 1].t;
  function x(t) { return pl + (t - t0) / Math.max(1, t1 - t0) * (w - pl - pr); }
  function y(v) { return pt + (1 - (v - lo) / (hi - lo)) * (h - pt - pb); }
  var svg = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, 'aria-hidden': 'true' });
  // y grid + labels
  for (var i = 0; i <= 4; i++) {
    var v = lo + (hi - lo) * i / 4, yy = y(v);
    svg.appendChild(el('line', { x1: pl, x2: w - pr, y1: yy, y2: yy, 'class': 'pc-grid' }));
    var lab = el('text', { x: pl - 8, y: yy + 4, 'text-anchor': 'end', 'class': 'pc-label' });
    lab.textContent = fmtCompact(v) + 'c';
    svg.appendChild(lab);
  }
  // x labels: hours for a day, days for a week, dates for a month
  var span = t1 - t0;
  var stepT = span <= 2 * 86400 ? 4 * 3600 : span <= 8 * 86400 ? 86400 : 5 * 86400;
  var first = Math.ceil(t0 / stepT) * stepT;
  for (var tt = first; tt <= t1; tt += stepT) {
    var d = new Date(tt * 1000);
    var txt = span <= 2 * 86400 ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : span <= 8 * 86400 ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var tl = el('text', { x: x(tt), y: h - 6, 'text-anchor': 'middle', 'class': 'pc-label' });
    tl.textContent = txt;
    svg.appendChild(tl);
    svg.appendChild(el('line', { x1: x(tt), x2: x(tt), y1: h - pb, y2: h - pb + 4, 'class': 'pc-grid' }));
  }
  var d1 = points.map(function (p, k) { return (k ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
  svg.appendChild(el('path', { d: d1 + ' L' + x(t1).toFixed(1) + ' ' + (h - pb) + ' L' + pl + ' ' + (h - pb) + ' Z', 'class': 'pc-area' }));
  svg.appendChild(el('path', { d: d1, 'class': 'pc-line' }));
  var hair = el('line', { y1: pt, y2: h - pb, 'class': 'pc-hair' });
  var dot = el('circle', { r: 4, 'class': 'pc-dot' });
  var last = points[points.length - 1];
  dot.setAttribute('cx', x(last.t)); dot.setAttribute('cy', y(last.v));
  svg.appendChild(hair);
  svg.appendChild(dot);
  wrap.appendChild(svg);
  var tip = UI.el('div', 'pc-tip hidden');
  wrap.appendChild(tip);
  var fmt = opts.fmt || function (vv) { return fmtCompact(vv) + 'c'; };
  function show(k) {
    var p = points[k], px = x(p.t);
    hair.setAttribute('x1', px); hair.setAttribute('x2', px);
    hair.classList.add('on');
    dot.setAttribute('cx', px); dot.setAttribute('cy', y(p.v));
    var when = new Date(p.t * 1000);
    tip.textContent = '';
    tip.appendChild(UI.el('b', null, fmt(p.v)));
    tip.appendChild(document.createTextNode(' · ' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + (p.sub ? ' · ' + p.sub : '')));
    tip.classList.remove('hidden');
    tip.style.left = Math.min(Math.max(0, px - 90), w - 200) + 'px';
  }
  function hide() {
    hair.classList.remove('on');
    dot.setAttribute('cx', x(last.t)); dot.setAttribute('cy', y(last.v));
    tip.classList.add('hidden');
  }
  var idx = points.length - 1;
  svg.addEventListener('pointermove', function (e) {
    var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (w / r.width), best = 0;
    points.forEach(function (p, k) { if (Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px)) best = k; });
    idx = best; show(idx);
  });
  svg.addEventListener('pointerleave', hide);
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', (opts.label || 'Price') + ': from ' + fmt(points[0].v) + ' to ' + fmt(last.v) +
    ', low ' + fmt(Math.min.apply(null, vals)) + ', high ' + fmt(Math.max.apply(null, vals)) + '. Arrow keys step through the points.');
  wrap.addEventListener('focus', function () { show(idx); });
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight') idx = Math.min(points.length - 1, idx + 1);
    else return;
    e.preventDefault(); show(idx);
  });
  return wrap;
}

// ---- sidebar tile (always) + Market page (only while it is showing) ----------
function renderMarket() {
  if (!market) return;
  var league = market.league;
  var tile = document.getElementById('market-tile');
  var div = marketPoints('divine');
  var lastDiv = div.length ? div[div.length - 1].v : null;
  tile.querySelector('.mt-value').textContent = lastDiv ? fmtCompact(lastDiv) + 'c' : '—';
  tile.querySelector('.mt-delta').textContent = div.length > 1 ? fmtDelta(div[0].v, lastDiv) + ' 7d' : '';
  var sp = tile.querySelector('.mt-spark');
  sp.textContent = '';
  sp.appendChild(sparkline(div, { label: 'Divine Orb in chaos, 7 days', fmt: function (v) { return fmtCompact(v) + 'c'; } }));
  var updated = new Date(market.hour * 1000);
  tile.title = 'Divine Orb price, 7 days — GGG currency exchange (' + league + '), hour of ' +
    updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '. Click for the market.';
  marketDirty = true;
  if (document.body.dataset.view === 'market') renderMarketPage();
}

function renderMarketPage() {
  if (!market || !marketDirty) return;
  marketDirty = false;
  document.getElementById('view-market').classList.add('has-data');
  var page = document.getElementById('market-page');
  page.textContent = '';
  var updated = new Date(market.hour * 1000);
  var head = UI.el('div', 'mk-head');
  head.appendChild(UI.el('span', null, 'GGG currency exchange · ' + market.league + ' · ' +
    Object.keys(market.items).length + ' items traded · updated ' +
    updated.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })));
  page.appendChild(head);

  var movers = UI.el('section', 'mk-movers panel');
  var flips = UI.el('section', 'mk-flips panel');
  var grid = UI.el('div', 'mk-grid');
  var chart = UI.el('section', 'mk-chart panel');
  var side = UI.el('div', 'mk-side');
  var watch = UI.el('section', 'mk-watch panel');
  var conv = UI.el('section', 'mk-conv panel');
  side.appendChild(watch);
  side.appendChild(conv);
  grid.appendChild(chart);
  grid.appendChild(side);
  var table = UI.el('section', 'mk-table panel');
  page.appendChild(movers);
  page.appendChild(grid);
  page.appendChild(flips);
  page.appendChild(table);
  MK.els = { movers: movers, chart: chart, watch: watch, conv: conv, table: table, flips: flips };
  renderMovers();
  renderFlips();
  renderChartCard();
  renderWatch();
  renderConverter();
  renderMarketTable();
}

function renderMovers() {
  var box = MK.els.movers;
  box.textContent = '';
  var seg = UI.segmented([['24', '24 hours'], ['168', '7 days']], String(MK.movers === 24 ? 24 : 168), {
    ariaLabel: 'Movers period', onChange: function (v) { MK.movers = v === '24' ? 24 : 168; renderMovers(); } });
  box.appendChild(UI.sectionHeader('Biggest movers', [seg]));
  var key = MK.movers === 24 ? 'ch24' : 'ch7';
  // thin markets swing on single trades — movers only from markets with real volume
  var codes = Object.keys(market.items).filter(function (c) {
    var st = market.items[c].st;
    return !st.thin && st[key] !== null && isFinite(st[key]);
  });
  codes.sort(function (a, b) { return market.items[b].st[key] - market.items[a].st[key]; });
  var up = codes.slice(0, 4).filter(function (c) { return market.items[c].st[key] > 0; });
  var down = codes.slice(-4).reverse().filter(function (c) { return market.items[c].st[key] < 0; });
  var row = UI.el('div', 'mk-mover-row');
  [['Rising', up], ['Falling', down]].forEach(function (grp) {
    var col = UI.el('div', 'mk-mover-col');
    col.appendChild(UI.el('div', 'mk-mover-label', grp[0]));
    if (!grp[1].length) col.appendChild(UI.el('div', 'finder-sub', 'Nothing moved much.'));
    grp[1].forEach(function (c) {
      var it = market.items[c];
      var b = UI.el('button', 'mk-mover');
      b.type = 'button';
      b.appendChild(itemImg(it));
      var t = UI.el('span', 'mk-mover-txt');
      t.appendChild(UI.el('span', 'mk-name', it.name));
      t.appendChild(UI.el('span', 'mk-sub', mPrice(it.st.now)));
      b.appendChild(t);
      b.appendChild(pctChip(it.st[key]));
      b.addEventListener('click', function () { selectMarketItem(c, true); });
      col.appendChild(b);
    });
    row.appendChild(col);
  });
  box.appendChild(row);
  box.appendChild(UI.el('div', 'finder-sub', 'Markets under ' + fmtCompact(THIN_MARKET_CHAOS) +
    'c traded in a typical hour are left out — their price jumps on single trades.'));
}

// ---- chaos ↔ divine gaps: the same item priced differently in its two markets --------
// From the latest hour of the exchange feed (Api.cx_flips). A gap means buyers in one
// market paid more than sellers in the other got — last hour's averages, not a promise:
// cheap items bought with divines trade in coarse batches, and markets move.
var FLIP_MIN_VOL = [[1000, '1K'], [2000, '2K'], [5000, '5K'], [10000, '10K']];
async function renderFlips() {
  var box = MK.els && MK.els.flips;
  if (!box) return;
  box.textContent = '';
  var minSel = UI.select(FLIP_MIN_VOL.map(function (o) { return [String(o[0]), o[1] + 'c+ / hour']; }),
    String(MK.flipMin || 2000), { ariaLabel: 'Minimum traded volume', onChange: function () {
      MK.flipMin = parseInt(this.value, 10); renderFlips(); } });
  box.appendChild(UI.sectionHeader('Chaos ↔ divine price gaps · last hour', [UI.field('Both markets traded', minSel)]));
  if (!market.flips) {
    box.appendChild(UI.el('div', 'finder-loading', 'Reading the latest hour…'));
    try {
      var r = await window.pywebview.api.cx_flips(market.league);
      if (!r || !r.ok) throw new Error((r && r.error) || 'feed unavailable');
      market.flips = r;
    } catch (e) {
      box.textContent = '';
      box.appendChild(UI.sectionHeader('Chaos ↔ divine price gaps · last hour'));
      box.appendChild(UI.el('div', 'finder-sub', '❌ ' + (e.message || e)));
      return;
    }
    if (MK.els.flips !== box) return; // page re-rendered meanwhile
    return renderFlips();
  }
  var min = MK.flipMin || 2000;
  var rows = market.flips.rows.filter(function (r) { return r.volume >= min && r.gap >= 0.02; }).slice(0, 12);
  if (!rows.length) {
    box.appendChild(UI.el('div', 'finder-sub', 'No gaps of 2% or more between markets with that much trading last hour.'));
    return;
  }
  function rng(lohi, mult) {
    return lohi && lohi[0] != null ? fmtCompact(lohi[0] * mult) + '–' + fmtCompact(lohi[1] * mult) + 'c' : '';
  }
  box.appendChild(UI.table([
    { key: 'name', label: 'Item', render: function (r) {
      var b = UI.el('button', 'link-btn mk-item');
      b.type = 'button';
      b.appendChild(itemImg(r));
      var txt = UI.el('span', 'mk-item-txt');
      txt.appendChild(UI.el('span', 'mk-name', r.name));
      txt.appendChild(UI.el('span', 'mk-sub', r.cat || ''));
      b.appendChild(txt);
      b.addEventListener('click', function () { if (market.items[r.code]) selectMarketItem(r.code, true); });
      return b;
    } },
    { key: 'c', label: 'Chaos market', num: true, render: function (r) {
      var s = UI.el('span', null, fmtCompact(r.viaChaos) + 'c');
      s.title = 'Traded between ' + rng(r.cRange, 1) + ' last hour';
      return s;
    } },
    { key: 'd', label: 'Divine market', num: true, render: function (r) {
      var s = UI.el('span', null, fmtCompact(r.viaDiv) + 'c');
      s.title = fmtCompact(r.divEach) + ' div each; traded between ' + rng(r.dRange, market.flips.div) + ' last hour';
      return s;
    } },
    { key: 'gap', label: 'Gap', num: true, render: function (r) { return '+' + (r.gap * 100).toFixed(1) + '%'; } },
    { key: 'how', label: 'Buy in → sell in', render: function (r) {
      return r.buyWith === 'chaos' ? 'chaos → divine' : 'divine → chaos';
    } },
    { key: 'vol', label: 'Volume', num: true, render: function (r) { return fmtCompact(r.volume) + 'c/h'; } }
  ], rows));
  box.appendChild(UI.el('div', 'finder-sub', 'Average prices from GGG\'s exchange feed for the last hour, the divine side ' +
    'at that hour\'s divine rate. Hover a price for the hour\'s range. Check the live exchange before trading: ' +
    'gaps close, cheap items bought with divines trade in batches, and each trade costs gold.'));
}

async function renderChartCard() {
  if (!MK.els) return;
  var box = MK.els.chart;
  var code = MK.sel, it = market.items[code];
  box.textContent = '';
  if (!it) return;
  var head = UI.el('div', 'mk-chart-head');
  head.appendChild(itemImg(it, 'mk-ic-lg'));
  var id = UI.el('div', 'mk-id');
  id.appendChild(UI.el('div', 'mk-cat', it.cat || 'Currency'));
  id.appendChild(UI.el('h3', 'mk-title', it.name));
  var price = UI.el('div', 'mk-price', mPrice(it.st.now));
  id.appendChild(price);
  head.appendChild(id);
  var acts = UI.el('div', 'mk-chart-acts');
  var watching = loadWatch().indexOf(code) !== -1;
  var star = UI.button(watching ? 'secondary' : 'ghost', { label: watching ? '★ Watching' : '☆ Watch',
    onClick: function () { toggleWatch(code); } });
  star.setAttribute('aria-pressed', watching ? 'true' : 'false');
  acts.appendChild(star);
  var hasAlert = !!loadAlerts()[code];
  var form = alertForm(code, it);
  form.hidden = !MK.alertOpen;
  var bell = UI.button(hasAlert ? 'secondary' : 'ghost', { label: hasAlert ? '🔔 Alert on' : '🔔 Alert',
    title: 'Notify me when this price crosses a level or moves sharply', onClick: function () {
      MK.alertOpen = form.hidden;
      form.hidden = !MK.alertOpen;
      bell.setAttribute('aria-expanded', MK.alertOpen ? 'true' : 'false');
      if (MK.alertOpen) form.querySelector('input').focus();
    } });
  bell.setAttribute('aria-expanded', MK.alertOpen ? 'true' : 'false');
  acts.appendChild(bell);
  var range = UI.segmented([['1', '1 day'], ['7', '7 days'], ['30', '30 days']], String(MK.range), {
    ariaLabel: 'Chart range', onChange: function (v) { MK.range = parseInt(v, 10); renderChartCard(); } });
  acts.appendChild(range);
  head.appendChild(acts);
  box.appendChild(head);
  box.appendChild(form);

  var body = UI.el('div', 'mk-chart-body');
  box.appendChild(body);
  var stats = UI.el('div', 'mk-stats');
  box.appendChild(stats);
  var pts;
  if (MK.range === 7) pts = marketPoints(code);
  else {
    var key = code + ':' + MK.range;
    if (!market.hist[key]) {
      body.appendChild(UI.el('div', 'finder-loading', MK.range === 30
        ? 'Loading 30 days (the first time downloads about 20 daily snapshots)…' : 'Loading the last day…'));
      try {
        var r = await window.pywebview.api.cx_history(market.league, JSON.stringify([code]), MK.range);
        if (!r || !r.ok) throw new Error((r && r.error) || 'history unavailable');
        market.hist[key] = r.series[code] || [];
      } catch (e) {
        body.textContent = '';
        body.appendChild(UI.el('div', 'finder-sub', '❌ ' + (e.message || e)));
        return;
      }
      if (MK.sel !== code || MK.els.chart !== box) return; // moved on meanwhile
      body.textContent = '';
    }
    pts = market.hist[key].map(function (p) {
      return { t: p[0], v: p[1], sub: p[2] ? fmtCompact(p[2]) + 'c traded/h' : 'no trades that hour' };
    });
  }
  body.appendChild(priceChart(pts, { w: Math.max(320, body.clientWidth || 640), h: 230, label: it.name + ' in chaos' }));
  if (pts.length > 1) {
    var vals = pts.map(function (p) { return p.v; });
    var first = pts[0].v, lastV = pts[pts.length - 1].v;
    [['Change', pctChip(first ? (lastV - first) / first : null)],
     ['Low', document.createTextNode(fmtCompact(Math.min.apply(null, vals)) + 'c')],
     ['High', document.createTextNode(fmtCompact(Math.max.apply(null, vals)) + 'c')],
     ['Typical volume', document.createTextNode(fmtCompact(it.st.vol) + 'c / hour')]].forEach(function (s) {
      var cell = UI.el('div', 'mk-stat');
      cell.appendChild(UI.el('span', 'mk-stat-label', s[0]));
      var v = UI.el('span', 'mk-stat-value');
      v.appendChild(s[1]);
      cell.appendChild(v);
      stats.appendChild(cell);
    });
    if (it.st.thin) stats.appendChild(UI.chip('Thin market — price is noisy', 'warn'));
  }
}

function renderWatch() {
  var box = MK.els.watch;
  box.textContent = '';
  box.appendChild(UI.sectionHeader('Watchlist'));
  var list = UI.el('div', 'mk-watch-list');
  var codes = loadWatch().filter(function (c) { return market.items[c]; });
  var alerts = loadAlerts();
  if (!codes.length) list.appendChild(UI.el('div', 'finder-sub', 'Star items (☆) to keep them here.'));
  codes.forEach(function (c) {
    var it = market.items[c];
    var b = UI.el('button', 'mk-watch-row' + (c === MK.sel ? ' on' : ''));
    b.type = 'button';
    b.appendChild(itemImg(it));
    b.appendChild(UI.el('span', 'mk-name', it.name));
    var bell = UI.el('span', 'mk-bell', alerts[c] ? '🔔' : ''); // empty cell keeps the columns aligned
    if (alerts[c]) bell.title = 'Price alert set';
    b.appendChild(bell);
    b.appendChild(UI.el('span', 'mk-num', mPrice(it.st.now)));
    b.appendChild(pctChip(it.st.ch24));
    b.title = it.name + ' — 24h change' + (alerts[c] ? ' · price alert set' : '');
    b.addEventListener('click', function () { selectMarketItem(c); renderWatch(); });
    list.appendChild(b);
  });
  box.appendChild(list);
}

function renderConverter() {
  var box = MK.els.conv;
  box.textContent = '';
  box.appendChild(UI.sectionHeader('Converter'));
  var opts = Object.keys(market.items).sort(function (a, b) {
    return market.items[a].name.localeCompare(market.items[b].name);
  }).map(function (c) { return [c, market.items[c].name]; });
  opts.unshift(['chaos', 'Chaos Orb']);
  var amt = UI.input({ type: 'number', cls: 'min-input', value: MK.convAmt, ariaLabel: 'Amount', min: 0, step: 'any' });
  var sel = UI.select(opts, MK.convCode, { ariaLabel: 'Currency to convert' });
  var out = UI.el('div', 'mk-conv-out');
  out.setAttribute('aria-live', 'polite');
  function calc() {
    MK.convAmt = amt.value; MK.convCode = sel.value;
    var n = parseFloat(amt.value) || 0;
    var each = sel.value === 'chaos' ? 1 : market.items[sel.value].st.now;
    var chaos = n * each, dr = RATES[market.league] && RATES[market.league].divine;
    out.textContent = 'Worth ';
    // the amount's own currency is already in the row above — show the other one(s)
    if (sel.value !== 'chaos') out.appendChild(UI.el('b', null, fmtCompact(chaos) + ' chaos'));
    if (dr && sel.value !== 'divine' && (sel.value === 'chaos' || chaos >= dr / 10)) {
      out.appendChild(sel.value === 'chaos' ? UI.el('b', null, fmtCompact(chaos / dr) + ' divine')
        : UI.el('span', null, ' · ' + fmtCompact(chaos / dr) + ' divine'));
    }
  }
  amt.addEventListener('input', calc);
  sel.addEventListener('change', calc);
  var row = UI.el('div', 'mk-conv-row');
  row.appendChild(amt);
  row.appendChild(sel);
  box.appendChild(row);
  box.appendChild(out);
  calc();
}

function renderMarketTable() {
  if (!MK.els) return;
  var box = MK.els.table;
  var focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.mk : null;
  box.textContent = '';
  var cats = {};
  Object.keys(market.items).forEach(function (c) { var k = market.items[c].cat || 'Other'; cats[k] = (cats[k] || 0) + 1; });
  var catOpts = [['All', 'All categories (' + Object.keys(market.items).length + ')'], ['Watchlist', 'Watchlist']]
    .concat(Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })
      .map(function (k) { return [k, k + ' (' + cats[k] + ')']; }));
  var bar = UI.el('div', 'mk-toolbar');
  var q = UI.input({ type: 'search', value: MK.q, placeholder: 'Search items — e.g. "prismatic", "div", "scarab"',
                     ariaLabel: 'Search market items' });
  q.dataset.mk = 'q';
  q.addEventListener('input', function () { MK.q = q.value; MK.showAll = false; renderMarketTable(); });
  var cat = UI.select(catOpts, MK.cat, { ariaLabel: 'Category',
    onChange: function () { MK.cat = this.value; MK.showAll = false; renderMarketTable(); } });
  cat.dataset.mk = 'cat';
  var thinLab = UI.el('label', 'check');
  var thin = UI.input({ type: 'checkbox' });
  thin.checked = MK.hideThin;
  thin.dataset.mk = 'thin';
  thin.addEventListener('change', function () { MK.hideThin = thin.checked; renderMarketTable(); });
  thinLab.appendChild(thin);
  thinLab.appendChild(document.createTextNode(' Hide thin markets'));
  bar.appendChild(q);
  bar.appendChild(cat);
  bar.appendChild(thinLab);
  box.appendChild(bar);

  var watch = loadWatch();
  var codes = Object.keys(market.items).filter(function (c) {
    var it = market.items[c];
    if (MK.cat === 'Watchlist' ? watch.indexOf(c) === -1 : MK.cat !== 'All' && (it.cat || 'Other') !== MK.cat) return false;
    return !(MK.hideThin && it.st.thin);
  });
  if (MK.q.trim()) codes = fuzzyFilter(codes, MK.q.trim(), function (c) { return market.items[c].name + ' ' + (market.items[c].cat || ''); });
  else codes.sort(function (a, b) { return market.items[b].st.vol - market.items[a].st.vol; }); // busiest first
  var total = codes.length;
  if (!MK.showAll) codes = codes.slice(0, MARKET_ROWS);
  var rows = codes.map(function (c) { return { code: c, it: market.items[c] }; });
  var t = UI.table([
    { key: 'star', label: '', render: function (r) {
      var on = watch.indexOf(r.code) !== -1;
      var b = UI.iconButton(on ? '★' : '☆', (on ? 'Stop watching ' : 'Watch ') + r.it.name, { size: 'sm',
        cls: 'mk-star' + (on ? ' on' : ''), onClick: function () { toggleWatch(r.code); } });
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      return b;
    } },
    { key: 'name', label: 'Item', sort: function (r) { return r.it.name; }, render: function (r) {
      var b = UI.el('button', 'link-btn mk-item');
      b.type = 'button';
      b.appendChild(itemImg(r.it));
      var txt = UI.el('span', 'mk-item-txt');
      txt.appendChild(UI.el('span', 'mk-name', r.it.name));
      txt.appendChild(UI.el('span', 'mk-sub', r.it.cat || ''));
      b.appendChild(txt);
      b.addEventListener('click', function () { selectMarketItem(r.code, true); });
      return b;
    } },
    { key: 'now', label: 'Price', num: true, sort: function (r) { return r.it.st.now; }, render: function (r) { return mPrice(r.it.st.now); } },
    { key: 'ch24', label: '24h', num: true, sort: function (r) { return r.it.st.ch24 === null ? -Infinity : r.it.st.ch24; },
      render: function (r) { return pctChip(r.it.st.ch24); } },
    { key: 'ch7', label: '7 days', num: true, sort: function (r) { return r.it.st.ch7 === null ? -Infinity : r.it.st.ch7; },
      render: function (r) { return pctChip(r.it.st.ch7); } },
    { key: 'range', label: '7-day range', num: true, sort: function (r) { return r.it.st.hi; },
      render: function (r) { return fmtCompact(r.it.st.lo) + ' – ' + fmtCompact(r.it.st.hi) + 'c'; } },
    { key: 'vol', label: 'Volume / h', num: true, sort: function (r) { return r.it.st.vol; }, render: function (r) {
      var s = UI.el('span', null, fmtCompact(r.it.st.vol) + 'c');
      if (r.it.st.thin) { s.appendChild(document.createTextNode(' ')); s.appendChild(UI.chip('thin', 'warn')); }
      return s;
    } },
    { key: 'trend', label: 'Trend', render: function (r) {
      return sparkline(marketPoints(r.code), { w: 110, h: 24, label: r.it.name + ' in chaos, 7 days',
        fmt: function (v) { return fmtCompact(v) + 'c'; } });
    } }
  ], rows, { sortable: true, emptyText: 'Nothing matches.',
             rowClass: function (r) { return r.code === MK.sel ? 'sel' : ''; } });
  box.appendChild(t);
  if (total > codes.length || MK.showAll && total > MARKET_ROWS) {
    box.appendChild(UI.button('secondary', { label: MK.showAll ? 'Show the busiest ' + MARKET_ROWS : 'Show all ' + total,
      onClick: function () { MK.showAll = !MK.showAll; renderMarketTable(); } }));
  }
  if (focused) {
    var again = box.querySelector('[data-mk="' + focused + '"]');
    if (again) { again.focus(); if (again.type === 'search') again.setSelectionRange(again.value.length, again.value.length); }
  }
}

async function annotateChaosEq(state) {
  if (!isGui() || !state.priceState) return;
  var league = state.priceState.league;
  var amts = state.priceBox.querySelectorAll('.price-amt[data-currency]');
  var need = [];
  amts.forEach(function (el) {
    var cur = el.dataset.currency;
    if (!(RATES[league] && RATES[league][cur] !== undefined) && need.indexOf(cur) === -1) need.push(cur);
  });
  if (eqMode() === 'divine' && !divRate(league) && need.indexOf('divine') === -1) need.push('divine');
  if (need.length) {
    try {
      var res = await window.pywebview.api.exchange_rates(league, JSON.stringify(need));
      if (res.ok) {
        RATES[league] = RATES[league] || {};
        Object.keys(res.rates).forEach(function (k) { RATES[league][k] = res.rates[k]; });
      }
    } catch (e) { /* rates unavailable — skip annotations */ }
  }
  var cheapest = null;
  var priced = [];
  state.priceBox.querySelectorAll('.price-amt[data-currency]').forEach(function (el) {
    var cur = el.dataset.currency;
    var amount = parseFloat(el.dataset.amount);
    var rate = RATES[league] && RATES[league][cur];
    if (rate === undefined || isNaN(amount)) return;
    var chaos = amount * rate;
    if (cur !== eqMode() && !el.querySelector('.chaos-eq')) {
      var span = document.createElement('span');
      span.className = 'chaos-eq';
      span.textContent = ' ≈ ' + fmtEq(chaos, league);
      el.appendChild(span);
    }
    priced.push({ el: el, chaos: chaos });
    if (cheapest === null || chaos < cheapest) cheapest = chaos;
  });
  // sniper badges: flag listings well under the cluster median
  if (priced.length >= 5) {
    var sortedVals = priced.map(function (p) { return p.chaos; }).sort(function (a, b) { return a - b; });
    var median = sortedVals[Math.floor(sortedVals.length / 2)];
    priced.forEach(function (p) {
      if (median > 0 && p.chaos < median * 0.6) {
        var listing = p.el.closest('.listing');
        var nameEl = listing && listing.querySelector('.listing-name');
        if (nameEl && !nameEl.querySelector('.badge.deal')) {
          var b = document.createElement('span');
          b.className = 'badge deal';
          b.textContent = '🔥 deal';
          b.title = 'Priced well under the going rate — verify the mods, could be a snipe (or a scam listing)';
          nameEl.appendChild(b);
        }
      }
    });
  }
  // pasted / Ctrl+D items: you're selling — suggest a list price from the cheapest page
  var psSell = state.priceState;
  if (state === pastedState && psSell && !state.sortSpec) {
    if (psSell.page === 0) psSell.sell = sellSuggestion(priced.map(function (p) { return p.chaos; }));
    if (psSell.sell !== undefined) renderSellHint(state);
  }
  if (cheapest !== null) {
    // merge across pages — later pages must never raise the "cheapest"
    var ps2 = state.priceState;
    if (ps2) {
      if (ps2.cheapestChaos === undefined || cheapest < ps2.cheapestChaos) ps2.cheapestChaos = cheapest;
      state.cheapestChaos = ps2.cheapestChaos;
    } else {
      state.cheapestChaos = cheapest;
    }
    renderCostSummary();
  }
}
