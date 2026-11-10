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
var CDN_ROOT = 'https://web.poecdn.com';
var MARKET_ROWS = 80;          // rows per page of a category table ("Show more" adds a page)
var MK_NINJA_TTL = 20 * 60000; // a poe.ninja category is asked for again after 20 minutes
var MK_FEW_LISTINGS = 5;       // poe.ninja prices from fewer listings are low-confidence
// cat: the rail entry showing (null until first read from 'pobtf-market-cat'); open: the row in
// the detail drawer; sort: per kind of table (cx = exchange feed, nj = poe.ninja snapshot);
// f: the snapshot filters; ninja: 'league|type' -> {state, at, data, error}; counts: league -> {type: lines}
var MK = { sel: 'divine', range: 7, cat: null, q: '', hideThin: false, movers: 24, limit: MARKET_ROWS,
           convAmt: '1', convCode: 'divine', alertOpen: false, els: null, open: null,
           sort: { cx: { key: 'n', dir: -1 }, nj: { key: 'c', dir: -1 } },
           f: { gl: '', gq: '', cr: '', t: '', l: '' }, ninja: {}, counts: {} };

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
  renderMarketRail(); // the Watchlist count
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
    renderMarketRail(); // an alert also watches the item
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
    if (market && market.league !== league) MK.open = null; // the drawer showed the other league's row
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
           d24: dayAgo && dayAgo[1] ? last[1] - dayAgo[1] : null,
           d7: s.length > 1 && s[0][1] ? last[1] - s[0][1] : null,
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
// amt: the same change in chaos, shown after the % as "+45c" or "+1.4 div"
function pctChip(x, costly, amt) {
  var span = UI.el('span', 'pct');
  if (x === null || x === undefined || !isFinite(x)) { span.textContent = '—'; return span; }
  var p = x * 100;
  span.textContent = Math.abs(p) < 0.05 ? '±0.0%' : (p > 0 ? '▲ ' : '▼ ') + Math.abs(p).toFixed(1) + '%';
  span.classList.add(Math.abs(p) < 0.05 ? 'flat' : (p > 0) !== !!costly ? 'up' : 'down');
  var a = Math.abs(p) < 0.05 ? '' : amtText(amt);
  if (a) span.appendChild(UI.el('span', 'pct-amt', a));
  return span;
}

// signed chaos change → "+45c", or "+1.4 div" once it is worth a divine or more
function amtText(chaos) {
  if (chaos === null || chaos === undefined || !isFinite(chaos) || chaos === 0) return '';
  var dr = market && RATES[market.league] && RATES[market.league].divine;
  var sign = chaos > 0 ? '+' : '−', v = Math.abs(chaos);
  return sign + (dr && v >= dr ? fmtCompact(v / dr) + ' div' : fmtCompact(v) + 'c');
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

// an icon that never leaves a hole: no path, or a download that fails, shows the name's initial
function mkIcon(path, name, cls) {
  cls = cls || 'mk-ic';
  function none() {
    var s = UI.el('span', cls + ' mk-noic', String(name || '?').charAt(0).toUpperCase());
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
  if (!path) return none();
  var img = UI.el('img', cls), waited = false;
  img.alt = '';
  img.loading = 'lazy';
  img.addEventListener('error', function () {
    // a cached copy that went missing: the art cache (08-cards.js) retries the CDN first
    if (img.dataset.remote && !waited) { waited = true; return; }
    if (img.parentNode) img.parentNode.replaceChild(none(), img);
  });
  img.src = CDN_ROOT + path;
  return img;
}

// show an exchange item in the Overview's chart (movers, watchlist, flips, alert toasts)
function selectMarketItem(code, scroll) {
  MK.sel = code;
  if (MK.els && !MK.els.chart) setMarketCat('overview', true);
  renderChartCard();
  if (scroll && MK.els && MK.els.chart) MK.els.chart.scrollIntoView({ block: 'nearest' });
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

  // poe.ninja-style: categories down the left, the chosen one on the right
  var layout = UI.el('div', 'mk-layout');
  var rail = UI.el('nav', 'mk-rail panel');
  rail.setAttribute('aria-label', 'Market categories');
  var main = UI.el('div', 'mk-main');
  layout.appendChild(rail);
  layout.appendChild(main);
  page.appendChild(layout);
  MK.els = { rail: rail, main: main };
  renderMarketRail();
  renderMarketMain();
  // the snapshot's item counts for the rail: one read of a category brings them all
  if (!MK.counts[market.league]) loadNinjaCat('UniqueWeapon');
}

// ---- categories: the exchange feed split like poe.ninja's sidebar, then its item snapshot ----
var MK_CX_CATS = [['cx:currency', 'Currency'], ['cx:fragments', 'Fragments'], ['cx:scarabs', 'Scarabs'],
  ['cx:essences', 'Essences'], ['cx:fossils', 'Fossils & Resonators'], ['cx:oils', 'Oils'],
  ['cx:catalysts', 'Catalysts'], ['cx:delirium', 'Delirium Orbs'], ['cx:tattoos', 'Tattoos & Omens'],
  ['cx:runegrafts', 'Runegrafts'], ['cx:embers', 'Allflame Embers'], ['cx:expedition', 'Expedition'],
  ['cx:cards', 'Divination cards'], ['cx:other', 'Other']];
// the feed's own category names
var MK_FEED_CAT = { 'Currency': 'cx:currency', 'Fragments, Scarabs & Mapping': 'cx:fragments', 'Essences': 'cx:essences',
  'Fossils & Resonators': 'cx:fossils', 'Oils & Extractor': 'cx:oils', 'Catalysts': 'cx:catalysts',
  'Delirium Orbs': 'cx:delirium', 'Tattoos & Omens': 'cx:tattoos', 'Runegrafts': 'cx:runegrafts',
  'Allflame Embers': 'cx:embers', 'Expedition Currency': 'cx:expedition', 'Cards': 'cx:cards' };
// names that say what an item is when the feed's category does not (new leagues rename categories)
var MK_NAME_CAT = [[/Scarab/, 'cx:scarabs'], [/Tattoo|^Omen of /, 'cx:tattoos'], [/Fossil$|Resonator$/, 'cx:fossils'],
  [/ Oil$/, 'cx:oils'], [/Catalyst$/, 'cx:catalysts'], [/Delirium Orb$/, 'cx:delirium'],
  [/Essence of |^Remnant of Corruption$/, 'cx:essences'], [/^Runegraft /, 'cx:runegrafts'],
  [/^Allflame Ember /, 'cx:embers']];
// anything the rules do not place lands in Other, never nowhere
function marketCatOf(it) {
  var n = it.name || '';
  if (/Scarab/.test(n)) return 'cx:scarabs'; // filed with fragments in the feed
  if (!it.cat) return 'cx:currency';
  if (MK_FEED_CAT[it.cat]) return MK_FEED_CAT[it.cat];
  for (var i = 0; i < MK_NAME_CAT.length; i++) if (MK_NAME_CAT[i][0].test(n)) return MK_NAME_CAT[i][1];
  return 'cx:other';
}
// poe.ninja snapshot: [backend type, label, poe.ninja page]
var MK_NINJA_GROUPS = [
  ['Equipment & gems', [['UniqueWeapon', 'Unique weapons', 'unique-weapons'], ['UniqueArmour', 'Unique armour', 'unique-armours'],
    ['UniqueAccessory', 'Unique accessories', 'unique-accessories'], ['UniqueFlask', 'Unique flasks', 'unique-flasks'],
    ['UniqueJewel', 'Unique jewels', 'unique-jewels'], ['UniqueRelic', 'Unique relics', 'unique-relics'],
    ['UniqueTincture', 'Unique tinctures', 'unique-tinctures'], ['ForbiddenJewel', 'Forbidden jewels', 'forbidden-jewels'],
    ['ClusterJewel', 'Cluster jewels', 'cluster-jewels'], ['SkillGem', 'Skill gems', 'skill-gems']]],
  ['Atlas', [['Map', 'Maps', 'maps'], ['UniqueMap', 'Unique maps', 'unique-maps'],
    ['Invitation', 'Invitations', 'invitations'], ['Memory', 'Memories', 'memories']]],
  ['Other', [['Beast', 'Beasts', 'beasts']]]];

// the rail: [{label, items: [{id, label, n (count, null = not known yet), kind, type, page}]}]
function marketCatGroups() {
  var n = {};
  Object.keys(market.items).forEach(function (c) { var k = marketCatOf(market.items[c]); n[k] = (n[k] || 0) + 1; });
  var watching = loadWatch().filter(function (c) { return market.items[c]; }).length;
  var counts = MK.counts[market.league] || {};
  var groups = [{ label: '', items: [{ id: 'overview', label: 'Overview', n: null, kind: 'overview' },
                                     { id: 'watch', label: 'Watchlist', n: watching, kind: 'cx' }] },
    { label: 'General', items: MK_CX_CATS.filter(function (c) { return n[c[0]]; }).map(function (c) {
      return { id: c[0], label: c[1], n: n[c[0]], kind: 'cx' };
    }) }];
  MK_NINJA_GROUPS.forEach(function (g) {
    groups.push({ label: g[0], items: g[1].map(function (c) {
      return { id: 'nj:' + c[0], label: c[1], n: counts[c[0]] === undefined ? null : counts[c[0]], kind: 'nj', type: c[0], page: c[2] };
    }) });
  });
  return groups.filter(function (g) { return g.items.length; });
}
function marketCatDef(id) {
  var hit = null;
  marketCatGroups().forEach(function (g) { g.items.forEach(function (c) { if (c.id === id) hit = c; }); });
  return hit;
}
// the entry showing: the remembered one, or Overview when this league has nothing in it
function marketCat() {
  if (MK.cat === null) {
    try { MK.cat = localStorage.getItem('pobtf-market-cat') || 'overview'; } catch (e) { MK.cat = 'overview'; }
  }
  return marketCatDef(MK.cat) ? MK.cat : 'overview';
}
// transient: a jump made for the user (an alert's View button), not their choice to remember
function setMarketCat(id, transient) {
  if (!marketCatDef(id)) id = 'overview';
  MK.cat = id;
  if (!transient) persist('pobtf-market-cat', id);
  MK.q = '';
  MK.limit = MARKET_ROWS;
  MK.open = null;
  MK.alertOpen = false;
  MK.f = { gl: '', gq: '', cr: '', t: '', l: '' };
  var def = marketCatDef(id), key = def.type && market.league + '|' + def.type;
  if (key && MK.ninja[key] && MK.ninja[key].state === 'error') delete MK.ninja[key]; // opening it again asks again
  if (!MK.els) return;
  renderMarketRail();
  renderMarketMain();
}

// keep the keyboard focus across a redraw: controls carry data-mk
function mkKeepFocus(box) {
  var a = document.activeElement, id = a && box.contains(a) ? a.dataset.mk : null;
  return function () {
    if (!id) return;
    var els = box.querySelectorAll('[data-mk]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].dataset.mk !== id) continue;
      els[i].focus();
      if (els[i].type === 'search') els[i].setSelectionRange(els[i].value.length, els[i].value.length);
      return;
    }
  };
}

function renderMarketRail() {
  if (!MK.els || !MK.els.rail) return;
  var rail = MK.els.rail, refocus = mkKeepFocus(rail), cur = marketCat(), groups = marketCatGroups();
  rail.textContent = '';
  function countText(c) { return c.n === null ? '' : String(c.n); }
  // narrow windows: the same list as one select
  var sel = UI.el('select', 'mk-rail-select');
  sel.setAttribute('aria-label', 'Market category');
  sel.dataset.mk = 'railsel';
  var list = UI.el('div', 'mk-rail-list');
  groups.forEach(function (g) {
    var into = sel, grp = UI.el('div', 'mk-rail-group');
    if (g.label) {
      into = document.createElement('optgroup');
      into.label = g.label;
      sel.appendChild(into);
      grp.appendChild(UI.el('div', 'mk-rail-label', g.label));
    }
    g.items.forEach(function (c) {
      var o = UI.el('option', null, c.label + (c.n === null ? '' : ' (' + c.n + ')'));
      o.value = c.id;
      into.appendChild(o);
      var b = UI.el('button', 'mk-rail-item');
      b.type = 'button';
      b.dataset.cat = c.id;
      b.dataset.mk = 'rail:' + c.id;
      if (c.id === cur) b.setAttribute('aria-current', 'page');
      b.appendChild(UI.el('span', 'mk-rail-name', c.label));
      var n = UI.el('span', 'mk-rail-n', countText(c));
      if (c.n !== null) n.title = c.n + (c.n === 1 ? ' item' : ' items');
      b.appendChild(n);
      b.addEventListener('click', function () { if (marketCat() !== c.id) setMarketCat(c.id); });
      grp.appendChild(b);
    });
    list.appendChild(grp);
  });
  sel.value = cur;
  sel.addEventListener('change', function () { setMarketCat(sel.value); });
  // arrows walk the list; Tab leaves it
  list.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(list.querySelectorAll('.mk-rail-item'));
    var i = items.indexOf(document.activeElement), j;
    if (i === -1) return;
    if (e.key === 'ArrowDown') j = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else return;
    e.preventDefault();
    items[j].focus();
  });
  rail.appendChild(sel);
  rail.appendChild(list);
  refocus();
}

function renderMarketMain() {
  var main = MK.els.main, cur = marketCat();
  main.textContent = '';
  MK.els = { rail: MK.els.rail, main: main };
  if (cur === 'overview') {
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
    main.appendChild(movers);
    main.appendChild(grid);
    main.appendChild(flips);
    MK.els.movers = movers; MK.els.chart = chart; MK.els.watch = watch; MK.els.conv = conv; MK.els.flips = flips;
    renderMovers();
    renderFlips();
    renderChartCard();
    renderWatch();
    renderConverter();
    return;
  }
  var view = UI.el('div', 'mk-catview');
  var table = UI.el('section', 'mk-table panel');
  var drawer = UI.el('aside', 'mk-drawer panel');
  drawer.hidden = true;
  view.appendChild(table);
  view.appendChild(drawer);
  main.appendChild(view);
  MK.els.view = view; MK.els.table = table; MK.els.drawer = drawer;
  renderMarketTable();
  renderMarketDrawer();
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
      b.appendChild(pctChip(it.st[key], false, it.st[key === 'ch24' ? 'd24' : 'd7']));
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

// the poe.ninja page for an exchange item: by the feed's category, a few split by name;
// categories poe.ninja files differently get no link rather than a wrong one
function marketNinjaCategory(it) {
  var n = it.name || '', cat = it.cat || 'Currency';
  if (/Scarab/.test(n)) return 'scarabs';
  if (/^Omen of /.test(n)) return 'omens';
  if (/Tattoo/.test(n)) return 'tattoos';
  if (/Fossil$/.test(n)) return 'fossils';
  if (/Resonator$/.test(n)) return 'resonators';
  if (/ Oil$/.test(n)) return 'oils';
  return { 'Currency': 'currency', 'Cards': 'divination-cards', 'Essences': 'essences',
           'Delirium Orbs': 'delirium-orbs', 'Fragments, Scarabs & Mapping': 'fragments' }[cat] || null;
}

// the Overview's chart, and the drawer when it shows an exchange item
function renderChartCard() {
  if (!MK.els) return;
  if (MK.els.chart) fillChartCard(MK.els.chart, MK.sel);
  if (MK.els.drawer && MK.open && MK.open.key.indexOf('#') === -1) renderMarketDrawer();
}

// one exchange item: price, watch star, alert form, poe.ninja link, chart with range buttons
async function fillChartCard(box, code) {
  var it = market.items[code], refocus = mkKeepFocus(box);
  var seq = box.mkSeq = (box.mkSeq || 0) + 1;
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
  star.dataset.mk = 'card-star';
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
  var nCat = marketNinjaCategory(it);
  if (nCat) acts.appendChild(UI.button('ghost', { label: 'poe.ninja ↗', title: 'This item on poe.ninja, in the same league',
    onClick: function () { openUrl(ninjaUrl(nCat, it.name, market.league)); } }));
  var range = UI.segmented([['1', '1 day'], ['7', '7 days'], ['30', '30 days']], String(MK.range), {
    ariaLabel: 'Chart range', onChange: function (v) { MK.range = parseInt(v, 10); renderChartCard(); } });
  Array.prototype.forEach.call(range.querySelectorAll('.seg'), function (b) { b.dataset.mk = 'card-range:' + b.dataset.value; });
  bell.dataset.mk = 'card-bell';
  acts.appendChild(range);
  head.appendChild(acts);
  box.appendChild(head);
  box.appendChild(form);

  var body = UI.el('div', 'mk-chart-body');
  box.appendChild(body);
  var stats = UI.el('div', 'mk-stats');
  box.appendChild(stats);
  refocus();
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
      if (box.mkSeq !== seq || !box.isConnected) return; // moved on meanwhile
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
    [['Change', pctChip(first ? (lastV - first) / first : null, false, first ? lastV - first : null)],
     ['24 hours', pctChip(it.st.ch24, false, it.st.d24)],
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
  if (!MK.els || !MK.els.watch) return;
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
    b.appendChild(pctChip(it.st.ch24, false, it.st.d24));
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

// ---- poe.ninja snapshot categories (Api.ninja_category), kept 20 minutes per league ----
// -> {state: 'loading' | 'ok' | 'error' | 'noapp', at, error, data: {at, divine, lines, icons}}
function loadNinjaCat(type, force) {
  var league = market.league, key = league + '|' + type, e = MK.ninja[key];
  if (!force && e && (e.state !== 'ok' || Date.now() - e.at < MK_NINJA_TTL)) return e;
  if (!isGui() || !window.pywebview.api.ninja_category) return { state: 'noapp' };
  e = MK.ninja[key] = { state: 'loading', at: Date.now() };
  window.pywebview.api.ninja_category(league, type).then(function (r) {
    if (!r || !r.ok) throw new Error((r && r.error) || 'prices unavailable');
    var lines = Array.isArray(r.lines) ? r.lines : [], icons = {};
    // the backend sends an item's icon once, on the first of its variants
    lines.forEach(function (l) { if (l.i && !icons[l.n]) icons[l.n] = l.i; });
    e.state = 'ok';
    e.at = Date.now();
    e.data = { at: r.at || Date.now(), divine: r.divine || null, lines: lines, icons: icons };
    var counts = MK.counts[league] = r.counts || MK.counts[league] || {};
    if (!r.counts) counts[type] = lines.length;
  }).then(null, function (err) {
    e.state = 'error';
    e.error = String((err && err.message) || err);
  }).then(function () {
    if (MK.ninja[key] !== e || !market || market.league !== league || !MK.els) return;
    renderMarketRail(); // the counts
    if (marketCat() === 'nj:' + type) { renderMarketTable(); renderMarketDrawer(); }
  });
  return e;
}

// ---- one row per item, the same shape for both sources ----
// key: exchange code, or 'Type#line index' for a snapshot line (codes have no '#')
function mkCxRow(code) {
  var it = market.items[code], st = it.st;
  return { key: code, kind: 'cx', code: code, it: it, name: it.name, sub: it.cat || 'Currency', icon: it.img,
           c: st.now, ch7: st.ch7, d7: st.d7, n: st.vol, low: st.thin,
           swing: st.lo > 0 ? (st.hi - st.lo) / st.lo : null,
           text: (it.name + ' ' + (it.cat || '')).toLowerCase() };
}
function mkNinjaRow(def, data, idx) {
  var l = data.lines[idx], sub = [], c = l.c || 0;
  if (l.b) sub.push(l.b);
  if (l.v) sub.push(l.v);
  if (l.l) sub.push(l.l + '-link');
  if (l.gl) sub.push('Level ' + l.gl);
  if (l.gq) sub.push(l.gq + '% quality');
  if (l.t) sub.push('Tier ' + l.t);
  var sp = Array.isArray(l.sp) && Array.isArray(l.sp[1]) ? l.sp : null;
  var ch = sp && typeof sp[0] === 'number' ? sp[0] / 100 : null;
  var seen = sp ? sp[1].filter(function (p) { return typeof p === 'number'; }) : [];
  return { key: def.type + '#' + idx, kind: 'nj', def: def, line: l, at: data.at, name: l.n || '', sub: sub.join(' · '),
           cr: !!l.cr, icon: data.icons[l.n], c: c, ch7: ch, d7: ch !== null && ch > -1 ? c - c / (1 + ch) : null,
           n: l.lc === undefined ? null : l.lc, low: l.lc !== undefined && l.lc !== null && l.lc < MK_FEW_LISTINGS,
           swing: seen.length > 1 ? (Math.max.apply(null, seen) - Math.min.apply(null, seen)) / 100 : null,
           text: ((l.n || '') + ' ' + (l.b || '') + ' ' + (l.v || '')).toLowerCase() };
}
// 7 days of prices for the sparkline. poe.ninja sends one point a day as % change against
// 7 days ago (null = no data that day); the latest price turns those back into chaos.
function mkRowPoints(row) {
  if (row.kind === 'cx') return marketPoints(row.code);
  var sp = Array.isArray(row.line.sp) && Array.isArray(row.line.sp[1]) ? row.line.sp : null;
  if (!sp || !(sp[0] > -100)) return [];
  var base = row.c / (1 + (sp[0] || 0) / 100), at = Math.floor(row.at / 1000), n = sp[1].length, pts = [];
  sp[1].forEach(function (p, k) {
    if (typeof p === 'number') pts.push({ t: at - (n - 1 - k) * 86400, v: base * (1 + p / 100) });
  });
  return pts;
}
function mkRowByKey(key) {
  var cut = key.indexOf('#');
  if (cut === -1) return market.items[key] ? mkCxRow(key) : null;
  var type = key.slice(0, cut), e = MK.ninja[market.league + '|' + type], def = marketCatDef('nj:' + type);
  var idx = parseInt(key.slice(cut + 1), 10);
  return e && e.state === 'ok' && def && e.data.lines[idx] ? mkNinjaRow(def, e.data, idx) : null;
}
function mkDivRate(data) {
  return (RATES[market.league] && RATES[market.league].divine) || (data && data.divine) || null;
}

// the snapshot's filters, only the ones its lines can answer: [state key, label, options]
function mkFilters(lines) {
  function distinct(get, text) {
    var seen = {};
    lines.forEach(function (l) { var v = get(l); if (v !== null) seen[v] = 1; });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; })
      .map(function (v) { return [String(v), text(v)]; });
  }
  var out = [];
  if (lines.some(function (l) { return l.gl; })) {
    out.push(['gl', 'Level', [['', 'Any']].concat(distinct(function (l) { return l.gl || null; }, String))]);
    out.push(['gq', 'Quality', [['', 'Any']].concat(distinct(function (l) { return l.gq || 0; }, function (v) { return v + '%'; }))]);
    out.push(['cr', 'Corrupted', [['', 'Either'], ['1', 'Yes'], ['0', 'No']]]);
  }
  if (lines.some(function (l) { return l.t; })) {
    out.push(['t', 'Tier', [['', 'Any']].concat(distinct(function (l) { return l.t || null; }, String))]);
  }
  if (lines.some(function (l) { return l.l; })) {
    out.push(['l', 'Links', [['', 'Any'], ['0', 'Under 5'], ['5', '5-link'], ['6', '6-link']]]);
  }
  return out;
}
function mkFilterPass(l) {
  var f = MK.f;
  if (f.gl && String(l.gl || '') !== f.gl) return false;
  if (f.gq && String(l.gq || 0) !== f.gq) return false;
  if (f.cr && (l.cr ? '1' : '0') !== f.cr) return false;
  if (f.t && String(l.t || '') !== f.t) return false;
  if (f.l && (f.l === '0' ? (l.l || 0) >= 5 : String(l.l || 0) !== f.l)) return false;
  return true;
}

// columns shared by both kinds of table; `sort` values of null always sink to the bottom
function mkColumns(kind, dr, watch) {
  var cols = [
    { key: 'name', label: 'Item', sort: function (r) { return r.name.toLowerCase(); }, render: function (r) {
      var b = UI.el('button', 'link-btn mk-item');
      b.type = 'button';
      b.dataset.key = r.key;
      b.dataset.mk = 'row:' + r.key;
      b.title = 'Details for ' + r.name;
      b.appendChild(mkIcon(r.icon, r.name));
      var txt = UI.el('span', 'mk-item-txt');
      txt.appendChild(UI.el('span', 'mk-name', r.name));
      var sub = UI.el('span', 'mk-sub', r.sub);
      if (r.cr) { if (r.sub) sub.appendChild(document.createTextNode(' ')); sub.appendChild(UI.chip('Corrupted', 'danger')); }
      txt.appendChild(sub);
      b.appendChild(txt);
      b.addEventListener('click', function () { openMarketDrawer(r.key); });
      return b;
    } },
    { key: 'c', label: 'Chaos', num: true, sort: function (r) { return r.c; }, render: function (r) {
      return UI.el('span', 'mk-num', fmtCompact(r.c) + 'c');
    } },
    { key: 'd', label: 'Divine', num: true, sort: function (r) { return r.c; }, render: function (r) {
      return dr ? fmtCompact(r.c / dr) + ' div' : '—';
    } },
    { key: 'trend', label: 'Last 7 days', title: 'Sort by how far the price swung in 7 days',
      sort: function (r) { return r.swing; }, render: function (r) {
        var pts = mkRowPoints(r);
        if (pts.length < 2) return UI.el('span', 'mk-sub', 'no trend yet');
        return sparkline(pts, { w: 110, h: 24, label: r.name + ' in chaos, 7 days', fmt: function (v) { return fmtCompact(v) + 'c'; } });
      } },
    { key: 'ch7', label: '7-day change', num: true, sort: function (r) { return r.ch7; },
      render: function (r) { return pctChip(r.ch7, false, r.d7); } },
    kind === 'cx'
      ? { key: 'n', label: 'Volume / h', num: true, sort: function (r) { return r.n; }, render: function (r) {
        var s = UI.el('span', null, fmtCompact(r.n) + 'c');
        if (r.low) { s.appendChild(document.createTextNode(' ')); s.appendChild(UI.chip('thin', 'warn')); }
        return s;
      } }
      : { key: 'n', label: 'Listings', num: true, sort: function (r) { return r.n; }, render: function (r) {
        if (r.n === null) return '—';
        var s = UI.el('span', null, String(r.n));
        if (r.low) { s.appendChild(document.createTextNode(' ')); s.appendChild(UI.chip('few', 'warn')); }
        return s;
      } }
  ];
  if (kind === 'cx') {
    cols.push({ key: 'star', label: '★', title: 'Sort by watched', sort: function (r) { return watch.indexOf(r.code) === -1 ? 0 : 1; },
      render: function (r) {
        var on = watch.indexOf(r.code) !== -1;
        var b = UI.iconButton(on ? '★' : '☆', (on ? 'Stop watching ' : 'Watch ') + r.name, { size: 'sm',
          cls: 'mk-star' + (on ? ' on' : ''), onClick: function () { toggleWatch(r.code); } });
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.dataset.mk = 'star:' + r.code;
        return b;
      } });
  }
  return cols;
}

// the chosen category: toolbar (search, filters, hide thin), sortable table, "Show more"
function renderMarketTable() {
  if (!MK.els || !MK.els.table) return;
  var box = MK.els.table, def = marketCatDef(marketCat()), kind = def.kind;
  var refocus = mkKeepFocus(box);
  box.textContent = '';
  var note = UI.el('span', 'mk-sub');
  box.appendChild(UI.sectionHeader(def.label, [note]));

  var rows, data = null, filters = [];
  if (kind === 'nj') {
    var e = loadNinjaCat(def.type);
    if (e.state === 'noapp') {
      box.appendChild(UI.emptyState({ title: 'Prices show in the app',
        text: 'poe.ninja prices for ' + def.label.toLowerCase() + ' load in the desktop app.' }));
      return;
    }
    if (e.state === 'loading') {
      var wait = UI.el('div', 'finder-loading', 'Loading ' + def.label.toLowerCase() + ' from poe.ninja…');
      wait.setAttribute('role', 'status');
      box.appendChild(wait);
      return;
    }
    if (e.state === 'error') {
      var retry = UI.button('primary', { label: 'Retry', onClick: function () {
        loadNinjaCat(def.type, true);
        renderMarketTable();
      } });
      retry.dataset.mk = 'retry';
      var fail = UI.emptyState({ title: 'Couldn\'t load ' + def.label.toLowerCase(),
        text: '❌ ' + e.error + '. Prices come from poe.ninja through the app\'s server; nothing was loaded.', action: retry });
      fail.classList.add('mk-error');
      fail.setAttribute('role', 'alert');
      box.appendChild(fail);
      refocus();
      return;
    }
    data = e.data;
    filters = mkFilters(data.lines);
    rows = [];
    data.lines.forEach(function (l, idx) { if (mkFilterPass(l)) rows.push(mkNinjaRow(def, data, idx)); });
  } else {
    var watch = loadWatch();
    rows = Object.keys(market.items).filter(function (c) {
      return def.id === 'watch' ? watch.indexOf(c) !== -1 : marketCatOf(market.items[c]) === def.id;
    }).map(mkCxRow);
    // the feed's category under the name only where the rows come from several of them
    if (def.id !== 'watch' && def.id !== 'cx:other') rows.forEach(function (r) { r.sub = ''; });
  }
  var all = rows.length;

  var bar = UI.el('div', 'mk-toolbar');
  var q = UI.input({ type: 'search', value: MK.q, placeholder: 'Search ' + def.label.toLowerCase() + '…',
                     ariaLabel: 'Search ' + def.label.toLowerCase() });
  q.dataset.mk = 'q';
  q.addEventListener('input', function () { MK.q = q.value; MK.limit = MARKET_ROWS; renderMarketTable(); });
  bar.appendChild(q);
  filters.forEach(function (f) {
    var sel = UI.select(f[2], MK.f[f[0]], { ariaLabel: f[1], onChange: function () {
      MK.f[f[0]] = this.value; MK.limit = MARKET_ROWS; renderMarketTable();
    } });
    if (sel.value !== MK.f[f[0]]) { MK.f[f[0]] = ''; sel.value = ''; } // a value this category does not have
    sel.dataset.mk = 'f:' + f[0];
    bar.appendChild(UI.field(f[1], sel));
  });
  var thinLab = UI.el('label', 'check');
  var thin = UI.input({ type: 'checkbox' });
  thin.checked = MK.hideThin;
  thin.dataset.mk = 'thin';
  thin.addEventListener('change', function () { MK.hideThin = thin.checked; MK.limit = MARKET_ROWS; renderMarketTable(); });
  thinLab.appendChild(thin);
  thinLab.appendChild(document.createTextNode(kind === 'cx' ? ' Hide thin markets' : ' Hide low-confidence prices'));
  thinLab.title = kind === 'cx' ? 'Under ' + fmtCompact(THIN_MARKET_CHAOS) + 'c traded in a typical hour: the price jumps on single trades'
    : 'Fewer than ' + MK_FEW_LISTINGS + ' listings: the price is a guess';
  bar.appendChild(thinLab);
  box.appendChild(bar);

  var words = MK.q.toLowerCase().split(/\s+/).filter(Boolean);
  rows = rows.filter(function (r) {
    if (MK.hideThin && r.low) return false;
    return words.every(function (w) { return r.text.indexOf(w) !== -1; });
  });
  var dr = mkDivRate(data), cols = mkColumns(kind, dr, kind === 'cx' ? loadWatch() : []);
  var s = MK.sort[kind], col = cols.filter(function (c) { return c.key === s.key; })[0] || cols[1];
  rows.sort(function (a, b) {
    var x = col.sort(a), y = col.sort(b);
    var xn = x === null || x === undefined || x !== x, yn = y === null || y === undefined || y !== y;
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1; // no value: last, whichever way
    return (x > y ? 1 : x < y ? -1 : 0) * s.dir || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0);
  });
  var total = rows.length, shown = rows.slice(0, MK.limit);
  note.textContent = (kind === 'cx' ? 'GGG currency exchange' : 'poe.ninja · read ' +
    new Date(data.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) + ' · ' +
    (total === all ? all : total + ' of ' + all) + (all === 1 ? ' item' : ' items');

  var openKey = MK.open && MK.open.key;
  var t = UI.table(cols, shown, { sortable: true, sort: { key: col.key, dir: s.dir },
    emptyText: def.id === 'watch' && !all ? 'Star items (☆) in any exchange category to keep them here.' : 'Nothing matches.',
    rowClass: function (r) { return r.key === openKey ? 'sel' : ''; },
    // numbers start high→low, names A→Z; the same column again flips it
    onSort: function (key) {
      var c = cols.filter(function (x) { return x.key === key; })[0];
      MK.sort[kind] = { key: key, dir: s.key === key ? -s.dir : c.num || key === 'trend' || key === 'star' ? -1 : 1 };
      MK.limit = MARKET_ROWS;
      renderMarketTable();
    } });
  Array.prototype.forEach.call(t.querySelectorAll('.th-sort'), function (b) { b.dataset.mk = 'sort:' + b.dataset.sort; });
  // the whole row opens the details; its controls keep their own clicks
  t.addEventListener('click', function (ev) {
    if (ev.target.closest('button, a, input, select, .spark')) return;
    var tr = ev.target.closest('tbody tr'), b = tr && tr.querySelector('.mk-item');
    if (b) openMarketDrawer(b.dataset.key);
  });
  box.appendChild(t);
  if (total > shown.length) {
    var more = UI.button('secondary', { label: 'Show ' + Math.min(MARKET_ROWS, total - shown.length) + ' more (' +
      shown.length + ' of ' + total + ' showing)', onClick: function () { MK.limit += MARKET_ROWS; renderMarketTable(); } });
    more.dataset.mk = 'more';
    box.appendChild(more);
  }
  refocus();
}

// ---- detail drawer: beside the table (below it on narrow windows) ----
function mkRowButton(key) {
  var els = MK.els && MK.els.table ? MK.els.table.querySelectorAll('.mk-item') : [];
  for (var i = 0; i < els.length; i++) if (els[i].dataset.key === key) return els[i];
  return null;
}
function mkMarkOpenRow() {
  var key = MK.open && MK.open.key;
  if (!MK.els || !MK.els.table) return;
  Array.prototype.forEach.call(MK.els.table.querySelectorAll('.mk-item'), function (b) {
    var tr = b.closest('tr');
    if (tr) tr.classList.toggle('sel', b.dataset.key === key);
  });
}
function openMarketDrawer(key) {
  if (!MK.open || MK.open.key !== key) MK.alertOpen = false;
  MK.open = { key: key };
  mkMarkOpenRow();
  renderMarketDrawer();
  var close = MK.els.drawer.querySelector('.mk-drawer-close');
  if (close) close.focus();
}
// focus goes back to the row that opened it (the search box when that row is filtered away)
function closeMarketDrawer() {
  if (!MK.open) return;
  var key = MK.open.key;
  MK.open = null;
  MK.alertOpen = false;
  mkMarkOpenRow();
  renderMarketDrawer();
  var back = mkRowButton(key) || (MK.els && MK.els.table && MK.els.table.querySelector('[data-mk="q"]'));
  if (back) back.focus();
}
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || e.defaultPrevented || !MK.open || document.body.dataset.view !== 'market') return;
  // something on top takes the key first: a dialog, a menu or popover, the settings drawer
  if (document.querySelector('dialog[open], .menu, .popover:not([hidden]), #settings-panel:not(.hidden)')) return;
  closeMarketDrawer();
}, true); // capture: asked before those layers close themselves on the same key

function renderMarketDrawer() {
  if (!MK.els || !MK.els.drawer) return;
  var box = MK.els.drawer, row = MK.open && mkRowByKey(MK.open.key);
  var refocus = mkKeepFocus(box);
  box.textContent = '';
  if (!row) MK.open = null;
  box.hidden = !row;
  MK.els.view.classList.toggle('has-drawer', !!row);
  if (!row) return;
  box.setAttribute('aria-label', row.name + ' details');
  var top = UI.el('div', 'mk-drawer-top');
  top.appendChild(UI.el('span', 'section-title', 'Details'));
  var close = UI.iconButton('✕', 'Close details', { size: 'sm', cls: 'mk-drawer-close', title: 'Close (Esc)',
    onClick: closeMarketDrawer });
  close.dataset.mk = 'close';
  top.appendChild(close);
  box.appendChild(top);
  var body = UI.el('div', 'mk-drawer-body');
  box.appendChild(body);
  if (row.kind === 'cx') fillChartCard(body, row.code);
  else fillNinjaCard(body, row);
  refocus();
}

// one snapshot item: prices, the 7-day trend enlarged, listings, its poe.ninja page
function fillNinjaCard(box, row) {
  var entry = MK.ninja[market.league + '|' + row.def.type], dr = mkDivRate(entry && entry.data);
  var head = UI.el('div', 'mk-chart-head');
  head.appendChild(mkIcon(row.icon, row.name, 'mk-ic-lg'));
  var id = UI.el('div', 'mk-id');
  id.appendChild(UI.el('div', 'mk-cat', row.def.label));
  id.appendChild(UI.el('h3', 'mk-title', row.name));
  if (row.sub || row.cr) {
    var sub = UI.el('div', 'mk-sub', row.sub);
    if (row.cr) { if (row.sub) sub.appendChild(document.createTextNode(' ')); sub.appendChild(UI.chip('Corrupted', 'danger')); }
    id.appendChild(sub);
  }
  id.appendChild(UI.el('div', 'mk-price', fmtCompact(row.c) + 'c' + (dr ? ' · ' + fmtCompact(row.c / dr) + ' div' : '')));
  head.appendChild(id);
  var acts = UI.el('div', 'mk-chart-acts');
  var link = UI.button('ghost', { label: 'poe.ninja ↗', title: 'This item on poe.ninja, in the same league',
    onClick: function () { openUrl(ninjaUrl(row.def.page, row.name, market.league)); } });
  link.dataset.mk = 'card-ninja';
  acts.appendChild(link);
  head.appendChild(acts);
  box.appendChild(head);

  var body = UI.el('div', 'mk-chart-body mk-drawer-spark');
  box.appendChild(body);
  var pts = mkRowPoints(row);
  if (pts.length > 1) {
    body.appendChild(sparkline(pts, { w: 340, h: 110, label: row.name + ' in chaos, 7 days',
      fmt: function (v) { return fmtCompact(v) + 'c'; } }));
  } else {
    body.appendChild(UI.el('div', 'finder-sub', 'poe.ninja has no 7-day trend for this one yet.'));
  }
  var stats = UI.el('div', 'mk-stats');
  var vals = pts.map(function (p) { return p.v; });
  [['7-day change', pctChip(row.ch7, false, row.d7)],
   ['Low', document.createTextNode(vals.length > 1 ? fmtCompact(Math.min.apply(null, vals)) + 'c' : '—')],
   ['High', document.createTextNode(vals.length > 1 ? fmtCompact(Math.max.apply(null, vals)) + 'c' : '—')],
   ['Listings', document.createTextNode(row.n === null ? '—' : String(row.n))]].forEach(function (s) {
    var cell = UI.el('div', 'mk-stat');
    cell.appendChild(UI.el('span', 'mk-stat-label', s[0]));
    var v = UI.el('span', 'mk-stat-value');
    v.appendChild(s[1]);
    cell.appendChild(v);
    stats.appendChild(cell);
  });
  if (row.low) stats.appendChild(UI.chip('Few listings — price is a guess', 'warn'));
  box.appendChild(stats);
  box.appendChild(UI.el('div', 'finder-sub', 'poe.ninja\'s estimate from public stash listings, read ' +
    new Date(row.at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) +
    '. The trend is one point a day.'));
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
  // value: price per % of your item (from the listing score), and the optional page sort
  priced.forEach(function (p) {
    var listing = p.el.closest('.listing');
    var pct = listing && parseFloat(listing.dataset.score);
    if (!listing || !(pct > 0)) return;
    var per = p.chaos / pct;
    listing.dataset.value = per;
    var scoreEl = listing.querySelector('.listing-score');
    if (scoreEl && !scoreEl.querySelector('.listing-value')) {
      scoreEl.appendChild(UI.el('span', 'listing-value', ' · ' + fmtEq(per, league) + ' per %'));
    }
  });
  if (state.valueSort) sortListingsByValue(state.priceBox);
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
