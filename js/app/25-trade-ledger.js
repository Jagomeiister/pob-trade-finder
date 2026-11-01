/* js/app/25-trade-ledger.js — Trade helper pages: Trades (sold / bought / flips, earned, spent,
   profit), People (buyers and sellers, time wasters, blocked) and Reports (a league or date range,
   item stats, sales under the market, a goal), plus backup / restore and the overlay's Today line.
   The js/app/ files are one program split by feature: they load in order (index.html) and share
   their top-level names. Everything stays on this PC; nothing here sends anything to the game
   except the /ignore and /unignore buttons, one command per press (19-trades.js tradeSend). */
'use strict';

// ---- the ledger: sales (19-trades.js SALES_KEY) and purchases (PURCHASES_KEY) as one list ------
// A finished sale adds its price to "earned", a finished purchase to "spent". Bulk swaps of one
// currency for another are valued both ways at the hour they happened (goodsChaos, filled in by
// ledgerEnrich) and only their difference counts, so changing 1 div for its chaos value is ±0.
var UNDER_MARKET = 0.2; // a sale this far under poe.ninja / the exchange is flagged in Reports
var GOAL_KEY = 'pobtf-trade-goal';
var OUTCOME_LABEL = { completed: 'Sold', not_completed: 'Not completed', wasted: 'Time wasted', no_show: 'No-show', other: 'Other' };
var BUY_OUTCOME_LABEL = { bought: 'Bought', not_bought: 'Didn\'t happen', no_answer: 'No answer', buy_other: 'Other' };

function dayKey(ms) {
  var d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function round2(v) { return Math.round(v * 100) / 100; }
function fmtSigned(v) { return (v < 0 ? '−' : '+') + fmtChaos(Math.abs(v)); }

function ledgerEntries() {
  return loadSales().map(function (s) { return Object.assign({ side: 'sold', person: s.buyer }, s); })
    .concat(loadPurchases().map(function (s) { return Object.assign({ side: 'bought', person: s.seller }, s); }));
}
function isDone(e) { return e.side === 'sold' ? e.outcome === 'completed' : e.outcome === 'bought'; }
function isSwap(e) { return !!(e.bulk && e.goodsCat === 'Currency'); }
function isWasteOutcome(o) { return o === 'wasted' || o === 'no_show' || o === 'no_answer'; }

// totals for a list: earned / spent / currency swaps / net, counts, and in / out per day
function ledgerTotals(list) {
  var t = { earned: 0, spent: 0, swap: 0, swapN: 0, sold: 0, bought: 0, unpriced: 0, wasted: 0, byDay: {} };
  list.forEach(function (e) {
    if (!isDone(e)) { if (isWasteOutcome(e.outcome)) t.wasted++; return; }
    var k = dayKey(e.time), d = t.byDay[k] = t.byDay[k] || { in: 0, out: 0, n: 0 };
    d.n++;
    if (e.side === 'sold') t.sold++; else t.bought++;
    if (isSwap(e)) {
      if (e.chaos == null || e.goodsChaos == null) { t.unpriced++; return; }
      var g = e.side === 'sold' ? e.chaos - e.goodsChaos : e.goodsChaos - e.chaos;
      t.swap += g; t.swapN++;
      if (g >= 0) d.in += g; else d.out -= g;
      return;
    }
    if (e.chaos == null) { t.unpriced++; return; }
    if (e.side === 'sold') { t.earned += e.chaos; d.in += e.chaos; } else { t.spent += e.chaos; d.out += e.chaos; }
  });
  t.net = t.earned - t.spent + t.swap;
  return t;
}

// flips: each sale paired with the earliest earlier purchase of the same item in the same
// league that isn't paired yet (single items; bulk trades count through their value instead)
function itemKey(e) { return (e.league || '') + '|' + String(e.item || '').toLowerCase().trim(); }
function pairLedgerFlips(entries) {
  var byTime = function (a, b) { return a.time - b.time; };
  var buys = entries.filter(function (e) { return e.side === 'bought' && e.outcome === 'bought' && !e.bulk && e.chaos != null; })
    .sort(byTime);
  var used = {}, flips = [];
  entries.filter(function (e) { return e.side === 'sold' && e.outcome === 'completed' && !e.bulk && e.chaos != null; })
    .sort(byTime).forEach(function (s) {
      var k = itemKey(s);
      var b = buys.filter(function (x) { return !used[x.id] && itemKey(x) === k && x.time <= s.time; })[0];
      if (!b) return;
      used[b.id] = true;
      flips.push({ item: s.item, league: s.league, buy: b, sell: s, profit: round2(s.chaos - b.chaos), held: s.time - b.time });
    });
  var holding = buys.filter(function (b) { return !used[b.id]; });
  return { flips: flips, holding: holding };
}
function heldText(ms) {
  var h = ms / 3600000;
  return h < 1 ? Math.max(1, Math.round(ms / 60000)) + ' min' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' days';
}

// ---- what a trade was worth at the time: looked up once after it's recorded -------------------
// whisper item text -> an item quick_price understands: "level 21 23% Vaal Grace" is a gem, a
// unique is "<name> <base>" (the longest unique name it starts with), anything else by its name
// (currency, fragments, scarabs, cards on GGG's exchange)
function marketItemFor(text) {
  var s = String(text || '').trim();
  var g = /^level (\d+) (\d+)% (.+)$/i.exec(s);
  if (g) return { name: g[3], rarity: 'GEM', gemLevel: +g[1], quality: +g[2] };
  var best = null;
  Object.keys(window.POE_UNIQUE_NAMES || {}).forEach(function (n) {
    if ((s === n || s.indexOf(n + ' ') === 0) && (!best || n.length > best.length)) best = n;
  });
  if (best) return { name: best, rarity: 'UNIQUE', base: s.slice(best.length).trim() };
  return { name: s, rarity: 'CURRENCY' };
}
async function quickPriceFor(item, league) {
  if (!isGui() || !window.pywebview.api.quick_price) return null;
  var r = await window.pywebview.api.quick_price(league, JSON.stringify(item));
  return r && r.ok && r.chaos != null ? r : null;
}
async function ledgerEnrich(side, id) {
  var load = side === 'sold' ? loadSales : loadPurchases, save = side === 'sold' ? saveSales : savePurchases;
  var e = load().filter(function (x) { return x.id === id; })[0];
  if (!e) return;
  var upd = {};
  try {
    if (e.bulk && e.count) { // what the goods were worth (currency swaps count by the difference)
      var r = await quickPriceFor({ name: e.item, rarity: 'CURRENCY' }, e.league);
      if (r) { upd.goodsChaos = round2(r.chaos * e.count); upd.goodsCat = r.cat || null; }
    } else if (side === 'sold') { // the going rate when you sold it
      var m = await quickPriceFor(marketItemFor(e.item), e.league);
      if (m) {
        upd.market = round2(m.chaos);
        upd.marketSource = m.source;
        if (e.chaos != null) upd.under = e.chaos < m.chaos * (1 - UNDER_MARKET);
      }
    }
  } catch (err) { return; }
  if (!Object.keys(upd).length) return;
  var list = load(), x = list.filter(function (y) { return y.id === id; })[0];
  if (!x) return;
  Object.assign(x, upd);
  save(list);
  if (!TRADE_OVERLAY) renderTrades();
}

// ---- in-game: today's line under the trade cards' header -------------------------------------
function todayLine() {
  var since = new Date(); since.setHours(0, 0, 0, 0);
  var list = ledgerEntries().filter(function (e) { return e.time >= since.getTime(); });
  var t = ledgerTotals(list);
  if (!t.sold && !t.bought) return null;
  var el = UI.el('div', 'ov-today');
  el.appendChild(UI.el('span', 'ov-today-label', 'Today'));
  if (t.sold) el.appendChild(UI.el('span', 'ov-today-in', fmtSigned(t.earned + Math.max(0, t.swap))));
  if (t.bought) el.appendChild(UI.el('span', 'ov-today-out', fmtSigned(-(t.spent + Math.max(0, -t.swap)))));
  el.appendChild(UI.el('b', 'ov-today-net', 'net ' + fmtSigned(t.net)));
  el.appendChild(UI.el('span', 'ov-today-n', (t.sold + t.bought) + ' trade' + (t.sold + t.bought === 1 ? '' : 's')));
  el.title = t.sold + ' sold, ' + t.bought + ' bought today. Trade helper → Trades for the list.';
  return el;
}

// ---- shared bits for the pages ----------------------------------------------------------------
function ledgerTiles(items) {
  var tiles = UI.el('div', 'sales-tiles');
  items.forEach(function (x) {
    if (!x) return;
    var tl = UI.el('div', 'sales-tile' + (x[2] ? ' ' + x[2] : ''));
    tl.appendChild(UI.el('span', 'st-label', x[0]));
    tl.appendChild(UI.el('b', 'st-value', x[1]));
    if (x[3]) tl.title = x[3];
    tiles.appendChild(tl);
  });
  return tiles;
}
function totalsTiles(t) {
  return ledgerTiles([
    ['Earned', fmtChaos(t.earned), 'is-in', t.sold + ' sale(s)'],
    ['Spent', fmtChaos(t.spent), 'is-out', t.bought + ' purchase(s)'],
    t.swapN ? ['Currency trades', fmtSigned(t.swap), t.swap >= 0 ? 'is-in' : 'is-out',
      t.swapN + ' currency swap(s), valued at the hour they happened'] : null,
    ['Net profit', fmtSigned(t.net), t.net >= 0 ? 'is-in' : 'is-out', 'Earned − spent' + (t.swapN ? ' + currency trades' : '')],
    ['Trades', String(t.sold + t.bought), '', t.unpriced ? t.unpriced + ' without a chaos value (paid in other currency)' : '']
  ]);
}
// money in (up) and out (down) per day: two bars, with the numbers in each bar's tooltip
function ledgerChart(byDay, days) {
  var keys = [];
  for (var i = days - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
  var max = Math.max.apply(null, keys.map(function (k) { var d = byDay[k] || {}; return Math.max(d.in || 0, d.out || 0); }).concat([1]));
  // fixed height, stretched to the width (preserveAspectRatio none): the labels sit outside the
  // drawing so they don't stretch with it
  var w = 600, h = 120, mid = h / 2, bw = w / keys.length;
  var svg = '<svg class="sales-chart ledger-chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" ' +
    'aria-label="Chaos in and out per day, last ' + days + ' days">';
  svg += '<line x1="0" x2="' + w + '" y1="' + mid + '" y2="' + mid + '" class="lc-axis"/>';
  keys.forEach(function (k, i) {
    var d = byDay[k] || {}, up = Math.round((d.in || 0) / max * (mid - 2)), dn = Math.round((d.out || 0) / max * (mid - 2));
    var x = (i * bw + 1).toFixed(1), bwid = Math.max(1, bw - 2).toFixed(1);
    var tip = '<title>' + k + ': in ' + Math.round(d.in || 0) + 'c, out ' + Math.round(d.out || 0) + 'c, ' + (d.n || 0) + ' trade(s)</title>';
    if (up) svg += '<rect class="lc-in" x="' + x + '" y="' + (mid - up) + '" width="' + bwid + '" height="' + up + '">' + tip + '</rect>';
    if (dn) svg += '<rect class="lc-out" x="' + x + '" y="' + mid + '" width="' + bwid + '" height="' + dn + '">' + tip + '</rect>';
  });
  svg += '</svg>';
  var box = UI.el('div', 'sales-chart-box');
  box.innerHTML = svg;
  var legend = UI.el('div', 'lc-legend');
  legend.appendChild(UI.el('span', 'lc-date', keys[0].slice(5)));
  legend.appendChild(UI.el('span', 'lc-key is-in', '▲ money in (sales)'));
  legend.appendChild(UI.el('span', 'lc-key is-out', '▼ money out (purchases)'));
  legend.appendChild(UI.el('span', 'lc-date lc-today', 'today'));
  box.appendChild(legend);
  return box;
}
function ledgerCsv(list) {
  var cols = ['time', 'side', 'outcome', 'league', 'item', 'count', 'price', 'currency', 'chaos', 'div', 'person', 'account',
              'tab', 'left', 'top', 'market', 'note'];
  function cell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s; // spreadsheet formula injection
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return [cols.join(',')].concat(list.map(function (s) {
    return cols.map(function (c) { return cell(c === 'time' ? new Date(s.time).toISOString() : s[c]); }).join(',');
  })).join('\n');
}
async function exportLedgerCsv(list, name) {
  var text = ledgerCsv(list);
  if (isGui() && window.pywebview.api.save_text_file) {
    var r = await window.pywebview.api.save_text_file(name + '-' + dayKey(Date.now()) + '.csv', text);
    if (r && r.ok) UI.toast('Saved ' + list.length + ' rows.', 'success');
    else if (r && r.error) UI.toast('Not saved: ' + r.error, 'danger');
    return;
  }
  navigator.clipboard.writeText(text).then(function () { UI.toast('CSV copied to the clipboard.', 'success'); });
}
function knownLeagues(entries) {
  var out = [];
  entries.forEach(function (e) { if (e.league && out.indexOf(e.league) === -1) out.push(e.league); });
  var cur = (document.getElementById('league') || {}).value;
  if (cur && out.indexOf(cur) === -1) out.unshift(cur);
  return out;
}
function periodSince(period) {
  if (period === 'all') return 0;
  if (period === '1') { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return Date.now() - parseInt(period, 10) * 86400000;
}

// ---- Trades page: Sold / Bought / Flips ---------------------------------------------------------
var ledgerFilter = { sub: 'sold', league: '', period: '30', outcome: 'done', q: '' };
function renderLedgerPage(body) {
  var all = ledgerEntries();
  var since = periodSince(ledgerFilter.period), q = ledgerFilter.q.toLowerCase();
  var inRange = all.filter(function (e) {
    return e.time >= since && (!ledgerFilter.league || e.league === ledgerFilter.league);
  });

  var sub = UI.segmented([['sold', 'Sold'], ['bought', 'Bought'], ['flips', 'Flips']], ledgerFilter.sub, {
    ariaLabel: 'Show', onChange: function (v) { ledgerFilter.sub = v; ledgerFilter.outcome = 'done'; renderTrades(); } });
  sub.classList.add('ledger-sub');
  body.appendChild(sub);

  var bar = UI.el('div', 'sales-filters');
  function onF(k) { return function () { ledgerFilter[k] = this.value; renderTrades(); }; }
  UI.field('League', UI.select([['', 'All']].concat(knownLeagues(all).map(function (l) { return [l, l]; })), ledgerFilter.league,
    { onChange: onF('league') }), { parent: bar });
  UI.field('Period', UI.select([['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']],
    ledgerFilter.period, { onChange: onF('period') }), { parent: bar });
  var side = ledgerFilter.sub;
  if (side !== 'flips') {
    var labels = side === 'sold' ? OUTCOME_LABEL : BUY_OUTCOME_LABEL;
    var outs = [['done', side === 'sold' ? 'Sales' : 'Purchases'], ['all', 'All outcomes']].concat(
      Object.keys(labels).filter(function (k) { return k !== 'completed' && k !== 'bought'; }).map(function (k) { return [k, labels[k]]; }));
    UI.field('Show', UI.select(outs, ledgerFilter.outcome, { onChange: onF('outcome') }), { parent: bar });
  }
  var qi = UI.input({ placeholder: side === 'bought' ? 'Item or seller' : 'Item or buyer', width: '140px', value: ledgerFilter.q,
    ariaLabel: 'Search trades' });
  qi.addEventListener('change', onF('q'));
  UI.field('Search', qi, { parent: bar });
  bar.appendChild(UI.button('secondary', { size: 'sm', label: '+ Add trade', title: 'A trade done before the app or outside the trade helper',
    onClick: function () { addTradeDialog(); } }));
  body.appendChild(bar);

  var t = ledgerTotals(inRange);
  body.appendChild(totalsTiles(t));
  if (t.sold || t.bought) body.appendChild(ledgerChart(t.byDay, ledgerFilter.period === '1' || ledgerFilter.period === '7' ? 7 :
    ledgerFilter.period === '90' ? 90 : 30));

  if (side === 'flips') { renderLedgerFlips(body, inRange, all); return; }
  var list = inRange.filter(function (e) {
    return e.side === side && (ledgerFilter.outcome === 'all' || (ledgerFilter.outcome === 'done' ? isDone(e) : e.outcome === ledgerFilter.outcome)) &&
      (!q || (e.item + ' ' + (e.person || '')).toLowerCase().indexOf(q) !== -1);
  });
  var tools = UI.el('div', 'ledger-tools');
  tools.appendChild(UI.button('ghost', { size: 'sm', label: 'Export CSV', onClick: function () { exportLedgerCsv(list, side === 'sold' ? 'sales' : 'purchases'); } }));
  body.appendChild(tools);
  var labelsFor = side === 'sold' ? OUTCOME_LABEL : BUY_OUTCOME_LABEL;
  body.appendChild(UI.table([
    { key: 'time', label: 'When', render: function (s) { return new Date(s.time).toLocaleString(); }, sort: function (s) { return s.time; } },
    { key: 'item', label: 'Item', render: function (s) {
      var span = UI.el('span', null, (s.count ? fmtCompact(s.count) + ' × ' : '') + s.item);
      if (s.under) {
        var c = UI.chip('under market', 'warn', 'under-chip');
        c.title = 'Sold ' + Math.round((1 - s.chaos / s.market) * 100) + '% under the going rate then (' + fmtChaos(s.market) +
          ', ' + (s.marketSource || 'market') + ')';
        span.appendChild(c);
      }
      if (s.manual) span.appendChild(UI.chip('added by hand', 'neutral'));
      return span;
    }, sort: function (s) { return s.item; } },
    { key: 'price', label: side === 'sold' ? 'Price' : 'Paid', render: function (s) { return priceText(s.price, s.currency); } },
    { key: 'chaos', label: 'Chaos', num: true, render: function (s) { return s.chaos != null ? fmtCompact(s.chaos) : ''; } },
    { key: 'div', label: 'Div', num: true, render: function (s) { return s.div != null ? fmtCompact(s.div) : ''; } },
    { key: 'person', label: side === 'sold' ? 'Buyer' : 'Seller' },
    { key: 'league', label: 'League' },
    side === 'sold' ? { key: 'tab', label: 'Stash', render: function (s) { return s.tab ? s.tab + (s.left ? ' (' + s.left + ',' + s.top + ')' : '') : ''; } } : null,
    { key: 'outcome', label: 'Outcome', render: function (s) { return labelsFor[s.outcome] || s.outcome; } },
    { key: 'note', label: 'Note' },
    { key: 'edit', label: '', render: function (s) {
      var w = UI.el('span', 'ledger-row-acts');
      w.appendChild(UI.button('ghost', { size: 'sm', label: 'Edit', title: 'Change the price, outcome or note',
        onClick: function () { editEntry(s.side, s.id); } }));
      w.appendChild(UI.iconButton('✕', 'Delete this trade', { size: 'sm', onClick: function () { deleteEntry(s.side, s.id); } }));
      return w;
    } }
  ].filter(Boolean), list.slice().sort(function (a, b) { return b.time - a.time; }), { sortable: true,
    emptyText: side === 'sold' ? 'No sales here yet. Mark a trade ✓ Completed, or + Add trade.'
      : 'No purchases here yet. On a card for a whisper you sent, press ✓ Bought, or + Add trade.' }));
}

function renderLedgerFlips(body, inRange, all) {
  // flips are paired over everything, then shown when the sale falls in the range
  var m = pairLedgerFlips(all), ids = {};
  inRange.forEach(function (e) { ids[e.side + e.id] = true; });
  var flips = m.flips.filter(function (f) { return ids['sold' + f.sell.id]; });
  var total = flips.reduce(function (a, f) { return a + f.profit; }, 0);
  var best = flips.slice().sort(function (a, b) { return b.profit - a.profit; })[0];
  body.appendChild(ledgerTiles([
    ['Flips', String(flips.length), '', 'Items you bought and later sold (same item, same league)'],
    ['Flip profit', fmtSigned(total), total >= 0 ? 'is-in' : 'is-out'],
    ['Average', flips.length ? fmtSigned(total / flips.length) : '—', ''],
    ['Best', best ? fmtSigned(best.profit) + ' · ' + best.item : '—', best && best.profit >= 0 ? 'is-in' : '']
  ]));
  body.appendChild(UI.table([
    { key: 'item', label: 'Item' },
    { key: 'buy', label: 'Bought', render: function (f) { return priceText(f.buy.price, f.buy.currency) + ' · ' + new Date(f.buy.time).toLocaleDateString(); },
      sort: function (f) { return f.buy.chaos; } },
    { key: 'sell', label: 'Sold', render: function (f) { return priceText(f.sell.price, f.sell.currency) + ' · ' + new Date(f.sell.time).toLocaleDateString(); },
      sort: function (f) { return f.sell.chaos; } },
    { key: 'profit', label: 'Profit', num: true, render: function (f) {
      return UI.el('span', f.profit >= 0 ? 'is-in' : 'is-out', fmtSigned(f.profit));
    }, sort: function (f) { return f.profit; } },
    { key: 'held', label: 'Held', num: true, render: function (f) { return heldText(f.held); }, sort: function (f) { return f.held; } },
    { key: 'league', label: 'League' }
  ], flips.slice().reverse(), { sortable: true, emptyText: 'No flips yet: when you buy an item and later sell the same item, it shows here.' }));
  if (m.holding.length) {
    var hold = UI.table([
      { key: 'item', label: 'Item' },
      { key: 'price', label: 'Paid', render: function (b) { return priceText(b.price, b.currency); } },
      { key: 'time', label: 'Bought', render: function (b) { return new Date(b.time).toLocaleDateString(); }, sort: function (b) { return b.time; } },
      { key: 'league', label: 'League' }
    ], m.holding.slice().reverse(), { sortable: true });
    var held = m.holding.reduce(function (a, b) { return a + (b.chaos || 0); }, 0);
    body.appendChild(UI.disclosure('Bought, not sold yet (' + m.holding.length + ' · ' + fmtChaos(held) + ')', hold));
  }
}

function entryStore(side) {
  return side === 'sold' ? { load: loadSales, save: saveSales } : { load: loadPurchases, save: savePurchases };
}
async function editEntry(side, id) {
  var st = entryStore(side), list = st.load();
  var s = list.filter(function (x) { return x.id === id; })[0];
  if (!s) return;
  var labels = side === 'sold' ? OUTCOME_LABEL : BUY_OUTCOME_LABEL;
  var box = UI.el('div', 'sale-edit');
  var price = UI.input({ type: 'number', value: s.price != null ? s.price : '', min: 0, step: 'any', width: '90px', ariaLabel: 'Price' });
  var cur = UI.select([['chaos', 'chaos'], ['divine', 'divine']].concat(
    s.currency && s.currency !== 'chaos' && s.currency !== 'divine' ? [[s.currency, s.currency]] : []), s.currency || 'chaos',
    { ariaLabel: 'Currency' });
  var out = UI.select(Object.keys(labels).map(function (k) { return [k, labels[k]]; }), s.outcome, { ariaLabel: 'Outcome' });
  var note = UI.input({ value: s.note || '', width: '100%', placeholder: 'Note', ariaLabel: 'Note' });
  UI.field('Price', price, { parent: box });
  UI.field('Currency', cur, { parent: box });
  UI.field('Outcome', out, { parent: box });
  UI.field('Note', note, { parent: box, cls: 'field-wide' });
  if (!(await UI.dialog({ title: 'Edit: ' + (s.item || 'trade'), body: box, confirmLabel: 'Save' }))) return;
  var p = parseFloat(price.value);
  s.price = isNaN(p) ? null : p;
  s.currency = cur.value;
  s.outcome = out.value;
  s.note = note.value.trim();
  var v = tradeValue(s.price, s.currency, await tradeDivRate(s.league));
  s.chaos = v.chaos != null ? round2(v.chaos) : null;
  s.div = v.div != null ? Math.round(v.div * 1000) / 1000 : null;
  if (s.market != null && side === 'sold') s.under = s.chaos != null && s.chaos < s.market * (1 - UNDER_MARKET);
  st.save(list);
  renderTrades();
}
async function deleteEntry(side, id) {
  var st = entryStore(side), list = st.load();
  var s = list.filter(function (x) { return x.id === id; })[0];
  if (!s) return;
  if (!(await UI.confirmDanger('Delete this ' + (side === 'sold' ? 'sale' : 'purchase') + '?',
    (s.item || '') + ' · ' + priceText(s.price, s.currency) + ' · ' + new Date(s.time).toLocaleString() +
    '. The person\'s counts on People stay as they are.', 'Delete'))) return;
  st.save(list.filter(function (x) { return x.id !== id; }));
  renderTrades();
}

// + Add trade: one done before the app or outside the trade helper
function localDateTime(ms) {
  var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
async function addTradeDialog() {
  var box = UI.el('div', 'sale-edit add-trade');
  var side = UI.select([['sold', 'I sold'], ['bought', 'I bought']], ledgerFilter.sub === 'bought' ? 'bought' : 'sold',
    { ariaLabel: 'Sold or bought' });
  var item = UI.input({ placeholder: 'e.g. Headhunter Leather Belt', width: '100%', ariaLabel: 'Item' });
  var count = UI.input({ type: 'number', min: 1, step: 1, width: '70px', ariaLabel: 'How many', placeholder: '1' });
  var price = UI.input({ type: 'number', min: 0, step: 'any', width: '90px', ariaLabel: 'Price' });
  var cur = UI.select([['chaos', 'chaos'], ['divine', 'divine']], 'chaos', { ariaLabel: 'Currency' });
  var who = UI.input({ placeholder: 'Character name (optional)', width: '100%', ariaLabel: 'Buyer or seller' });
  var leagues = knownLeagues(ledgerEntries());
  var league = UI.select(leagues.map(function (l) { return [l, l]; }), (document.getElementById('league') || {}).value || leagues[0],
    { ariaLabel: 'League' });
  var when = UI.input({ type: 'datetime-local', value: localDateTime(Date.now()), ariaLabel: 'When' });
  var note = UI.input({ placeholder: 'Note', width: '100%', ariaLabel: 'Note' });
  UI.field('Trade', side, { parent: box });
  UI.field('Item', item, { parent: box, cls: 'field-wide' });
  UI.field('How many', count, { parent: box });
  UI.field('Price (all of them)', price, { parent: box });
  UI.field('Currency', cur, { parent: box });
  UI.field('Buyer / seller', who, { parent: box, cls: 'field-wide' });
  UI.field('League', league, { parent: box });
  UI.field('When', when, { parent: box });
  UI.field('Note', note, { parent: box, cls: 'field-wide' });
  if (!(await UI.dialog({ title: 'Add a trade', body: box, confirmLabel: 'Add' }))) return;
  var p = parseFloat(price.value), n = parseInt(count.value, 10);
  if (!item.value.trim() || isNaN(p) || p < 0) { UI.toast('Not added: an item and a price are needed.', 'warn'); return; }
  var s = side.value, L = league.value, t = Date.parse(when.value) || Date.now();
  var v = tradeValue(p, cur.value, await tradeDivRate(L));
  var e = { id: 'm' + Date.now(), time: t, outcome: s === 'sold' ? 'completed' : 'bought', league: L, item: item.value.trim(),
    count: n > 1 ? n : null, price: p, currency: cur.value, chaos: v.chaos != null ? round2(v.chaos) : null,
    div: v.div != null ? Math.round(v.div * 1000) / 1000 : null, account: null, tab: null, left: null, top: null,
    note: note.value.trim(), manual: true };
  var name = who.value.trim();
  if (s === 'sold') { e.buyer = name || ''; var ls = loadSales(); ls.push(e); ls.sort(function (a, b) { return a.time - b.time; }); saveSales(ls); }
  else { e.seller = name || ''; var lp = loadPurchases(); lp.push(e); lp.sort(function (a, b) { return a.time - b.time; }); savePurchases(lp); }
  if (name && /^\w{1,40}$/.test(name)) {
    updateBuyer({ name: name }, function (b) {
      if (s === 'sold') { b.completed++; b.spent = round2((b.spent || 0) + (e.chaos || 0)); }
      else { b.sold++; b.paid = round2((b.paid || 0) + (e.chaos || 0)); }
    });
  }
  UI.toast('Added: ' + e.item + '.', 'success');
  renderTrades();
  ledgerEnrich(s, e.id);
}

// ---- People page: buyers and sellers, time wasters, blocked ------------------------------------
var peopleFilter = { kind: 'all', q: '' };
function isBuyerP(b) { return !!((b.completed || 0) + (b.wasted || 0) + (b.noShow || 0) + (b.notCompleted || 0) + (b.other || 0)); }
function isSellerP(b) { return !!((b.sold || 0) + (b.noAnswer || 0) + (b.notBought || 0) + (b.sellerOther || 0)); }
function isBlockedP(b) { return !!(b.hidden || b.ignored); }
function renderPeoplePage(body) {
  var all = loadBuyers();
  var keys = Object.keys(all).sort(function (a, b) { return (all[b].last || 0) - (all[a].last || 0); });
  var counts = { all: keys.length, buyers: 0, sellers: 0, wasters: 0, flagged: 0, blocked: 0 };
  keys.forEach(function (k) {
    var b = all[k];
    if (isBuyerP(b)) counts.buyers++;
    if (isSellerP(b)) counts.sellers++;
    if (isTimeWaster(b)) counts.wasters++;
    if (b.flag) counts.flagged++;
    if (isBlockedP(b)) counts.blocked++;
  });
  var seg = UI.segmented([['all', 'All (' + counts.all + ')'], ['buyers', 'Buyers (' + counts.buyers + ')'],
    ['sellers', 'Sellers (' + counts.sellers + ')'], ['wasters', '⌛ Time wasters (' + counts.wasters + ')'],
    ['flagged', '⚑ Flagged (' + counts.flagged + ')'], ['blocked', 'Blocked (' + counts.blocked + ')']], peopleFilter.kind,
    { ariaLabel: 'Show people', onChange: function (v) { peopleFilter.kind = v; renderTrades(); } });
  seg.classList.add('ledger-sub');
  body.appendChild(seg);
  var bar = UI.el('div', 'sales-filters');
  var qi = UI.input({ placeholder: 'Name or note', width: '160px', value: peopleFilter.q, ariaLabel: 'Search people' });
  qi.addEventListener('change', function () { peopleFilter.q = qi.value; renderTrades(); });
  UI.field('Search', qi, { parent: bar });
  bar.appendChild(UI.el('span', 'finder-sub', 'Time waster: after ' + tradePrefs().wasterAt +
    ' time wasted / no-show / no answer (Setup). Blocked: popups hidden here, or ignored in game from this app.'));
  body.appendChild(bar);
  var q = peopleFilter.q.toLowerCase();
  var shown = keys.filter(function (k) {
    var b = all[k], f = peopleFilter.kind;
    if (f === 'buyers' && !isBuyerP(b)) return false;
    if (f === 'sellers' && !isSellerP(b)) return false;
    if (f === 'wasters' && !isTimeWaster(b)) return false;
    if (f === 'flagged' && !b.flag) return false;
    if (f === 'blocked' && !isBlockedP(b)) return false;
    return !q || ((b.names || []).join(' ') + ' ' + (b.account || '') + ' ' + (b.note || '')).toLowerCase().indexOf(q) !== -1;
  });
  if (!shown.length) {
    body.appendChild(UI.emptyState({ title: keys.length ? 'Nobody here' : 'No one yet',
      text: keys.length ? 'No one matches this filter.' : 'Buyers and sellers appear here after you record a trade outcome or flag someone.' }));
    return;
  }
  shown.forEach(function (k) { body.appendChild(personRow(all, keys, k)); });
}

function personRow(all, keys, k) {
  var b = all[k];
  var row = UI.el('div', 'buyer-row person-row' + (isBlockedP(b) ? ' is-hidden' : ''));
  var head = UI.el('div', 'buyer-head');
  head.appendChild(UI.el('b', null, b.account || b.name));
  if (b.names && b.names.length > 1) head.appendChild(UI.el('span', 'finder-sub', b.names.join(', ')));
  if (isBuyerP(b)) head.appendChild(UI.chip('Buyer', 'neutral'));
  if (isSellerP(b)) head.appendChild(UI.chip('Seller', 'neutral'));
  if (b.flag) head.appendChild(UI.chip('⚑ Flagged', 'danger'));
  if (isTimeWaster(b)) {
    var tw = UI.chip('⌛ Time waster', 'warn');
    tw.title = b.waster === true ? 'You marked them' : wasteCount(b) + ' bad outcome(s) with you';
    head.appendChild(tw);
  }
  if (b.hidden) head.appendChild(UI.chip('Popups hidden', 'neutral'));
  if (b.ignored) head.appendChild(UI.chip('Ignored in game · ' + new Date(b.ignored).toLocaleDateString(), 'danger'));
  row.appendChild(head);
  if (isBuyerP(b)) {
    row.appendChild(UI.el('div', 'buyer-stats', 'Bought from you ' + (b.completed || 0) + '× · ' + fmtChaos(b.spent || 0) +
      ' · ' + (b.wasted || 0) + ' time wasted · ' + (b.noShow || 0) + ' no-shows · ' + (b.notCompleted || 0) + ' not completed'));
  }
  if (isSellerP(b)) {
    row.appendChild(UI.el('div', 'buyer-stats', 'Sold to you ' + (b.sold || 0) + '× · you paid ' + fmtChaos(b.paid || 0) +
      ' · didn\'t answer ' + (b.noAnswer || 0) + '× · didn\'t happen ' + (b.notBought || 0) + '×'));
  }
  if (b.last) row.appendChild(UI.el('div', 'finder-sub', 'Last trade ' + new Date(b.last).toLocaleString()));
  var note = UI.input({ placeholder: 'Note (only you see this)', value: b.note || '', width: '100%', ariaLabel: 'Note on ' + b.name });
  note.addEventListener('change', function () {
    var a = loadBuyers(); if (a[k]) { a[k].note = note.value; saveBuyers(a); }
  });
  row.appendChild(note);

  var acts = UI.el('div', 'buyer-actions');
  function setField(field, value) {
    var a = loadBuyers();
    if (!a[k]) return;
    a[k][field] = value;
    saveBuyers(a);
    if (field === 'hidden') tradeCards.forEach(function (c) { if (c.dir === 'in' && buyerKey(c) === k) c.hidden = !!value; });
    renderTrades();
  }
  acts.appendChild(UI.button('ghost', { size: 'sm', label: b.flag ? 'Unflag' : '⚑ Flag', onClick: function () { setField('flag', !b.flag); } }));
  var tw2 = UI.select([['auto', 'Time waster: automatic'], ['yes', 'Time waster: yes'], ['no', 'Time waster: no']],
    b.waster === true ? 'yes' : b.waster === false ? 'no' : 'auto', { ariaLabel: 'Time waster for ' + b.name, onChange: function () {
      setField('waster', this.value === 'yes' ? true : this.value === 'no' ? false : null);
    } });
  tw2.title = 'Automatic: after ' + tradePrefs().wasterAt + ' time wasted / no-show / no answer (Setup)';
  acts.appendChild(tw2);
  acts.appendChild(UI.button('ghost', { size: 'sm', label: b.hidden ? 'Show popups' : 'Hide popups',
    title: b.hidden ? 'Their whispers pop up again' : 'No popups or sounds from them here; nothing is sent to the game',
    onClick: function () { setField('hidden', !b.hidden); } }));
  if (b.ignored) {
    acts.appendChild(UI.button('secondary', { size: 'sm', label: 'Unignore in game…', title: 'Sends /unignore ' + b.name + ' once',
      onClick: function () { unignoreInGame({ name: b.name, sent: {} }); } }));
  } else {
    acts.appendChild(UI.button('ghost', { size: 'sm', label: 'Ignore in game…', title: 'Sends /ignore ' + b.name + ' once',
      onClick: function () { ignoreInGame({ name: b.name, sent: {} }); } }));
  }
  var others = keys.filter(function (o) { return o !== k; });
  if (others.length) {
    var into = UI.select([['', 'Same person as…']].concat(others.map(function (o) { return [o, all[o].name]; })), '',
      { ariaLabel: 'Merge ' + b.name + ' into another person', onChange: function () {
        if (!this.value) return;
        var target = all[this.value];
        if (mergeBuyers(k, this.value)) UI.toast(b.name + ' now counts as ' + target.name + '.', 'success');
        renderTrades();
      } });
    into.title = 'One player on several characters: their history adds up, and future whispers from ' + b.name +
      ' count for the person you pick';
    acts.appendChild(into);
  }
  acts.appendChild(UI.button('danger', { size: 'sm', label: 'Clear history', onClick: function () {
    UI.confirmDanger('Clear ' + b.name + '?', 'Removes their counts, note, flag and blocked setting here. Your trades list keeps ' +
      'the trades, and an in-game /ignore stays until you /unignore.', 'Clear').then(function (ok) {
      if (!ok) return;
      var a = loadBuyers(); delete a[k]; saveBuyers(a);
      tradeCards.forEach(function (c) { if (buyerKey(c) === k) c.hidden = false; });
      renderTrades();
    });
  } }));
  row.appendChild(acts);
  return row;
}

// ---- Reports page: a league or date range ------------------------------------------------------
var reportFilter = { range: '30', league: '', from: '', to: '' };
function reportRange() {
  var f = reportFilter;
  if (f.range === 'custom') {
    var from = f.from ? Date.parse(f.from + 'T00:00') : 0, to = f.to ? Date.parse(f.to + 'T23:59:59') : Infinity;
    return [from || 0, to || Infinity];
  }
  return [periodSince(f.range), Infinity];
}
function renderReportsPage(body) {
  var all = ledgerEntries();
  var bar = UI.el('div', 'sales-filters');
  UI.field('Range', UI.select([['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time'],
    ['custom', 'From – to…']], reportFilter.range, { onChange: function () { reportFilter.range = this.value; renderTrades(); } }), { parent: bar });
  if (reportFilter.range === 'custom') {
    ['from', 'to'].forEach(function (k) {
      var d = UI.input({ type: 'date', value: reportFilter[k], ariaLabel: k === 'from' ? 'From' : 'To' });
      d.addEventListener('change', function () { reportFilter[k] = d.value; renderTrades(); });
      UI.field(k === 'from' ? 'From' : 'To', d, { parent: bar });
    });
  }
  UI.field('League', UI.select([['', 'All leagues']].concat(knownLeagues(all).map(function (l) { return [l, l]; })), reportFilter.league,
    { onChange: function () { reportFilter.league = this.value; renderTrades(); } }), { parent: bar });
  body.appendChild(bar);
  var r = reportRange();
  var list = all.filter(function (e) { return e.time >= r[0] && e.time <= r[1] && (!reportFilter.league || e.league === reportFilter.league); });
  var t = ledgerTotals(list);
  body.appendChild(totalsTiles(t));
  var days = Object.keys(t.byDay).map(function (k) { var d = t.byDay[k]; return { day: k, net: d.in - d.out, n: d.n }; });
  var bestDay = days.slice().sort(function (a, b) { return b.net - a.net; })[0];
  body.appendChild(ledgerTiles([
    ['Best day', bestDay ? bestDay.day + ' · ' + fmtSigned(bestDay.net) : '—', bestDay && bestDay.net >= 0 ? 'is-in' : ''],
    ['Time wasted', String(t.wasted), t.wasted ? 'is-out' : '', 'Time wasted, no-shows and sellers who didn\'t answer'],
    ['Sold under market', String(list.filter(function (e) { return e.side === 'sold' && e.under; }).length), '',
      'Sales ' + Math.round(UNDER_MARKET * 100) + '% or more under poe.ninja / the exchange at the time (uniques, gems, currency, cards)']
  ]));
  renderGoal(body);
  var done = list.filter(isDone);
  // items you sold: count, total, average, low / high, last sold, best buyer
  var items = {};
  done.filter(function (e) { return e.side === 'sold' && e.chaos != null && !isSwap(e); }).forEach(function (e) {
    var it = items[e.item] = items[e.item] || { item: e.item, n: 0, total: 0, lo: Infinity, hi: 0, last: 0, buyers: {} };
    it.n++; it.total += e.chaos; it.lo = Math.min(it.lo, e.chaos); it.hi = Math.max(it.hi, e.chaos); it.last = Math.max(it.last, e.time);
    if (e.person) it.buyers[e.person] = (it.buyers[e.person] || 0) + e.chaos;
  });
  var itemRows = Object.keys(items).map(function (k) {
    var it = items[k], top = Object.keys(it.buyers).sort(function (a, b) { return it.buyers[b] - it.buyers[a]; })[0] || '';
    return { item: it.item, n: it.n, total: Math.round(it.total), avg: fmtChaos(it.total / it.n), lo: fmtChaos(it.lo), hi: fmtChaos(it.hi),
      last: new Date(it.last).toLocaleDateString(), lastMs: it.last, top: top };
  }).sort(function (a, b) { return b.total - a.total; });
  body.appendChild(UI.table([
    { key: 'item', label: 'Items you sold' }, { key: 'n', label: 'Sold', num: true }, { key: 'total', label: 'Chaos', num: true },
    { key: 'avg', label: 'Average', num: true }, { key: 'lo', label: 'Low', num: true }, { key: 'hi', label: 'High', num: true },
    { key: 'last', label: 'Last sold', sort: function (x) { return x.lastMs; } }, { key: 'top', label: 'Best buyer' }
  ], itemRows, { sortable: true, emptyText: 'No sales in this range.' }));
  // who you trade with most
  function topPeople(side) {
    var by = {};
    done.filter(function (e) { return e.side === side && e.person && e.chaos != null; }).forEach(function (e) {
      var p = by[e.person] = by[e.person] || { name: e.person, n: 0, chaos: 0 };
      p.n++; p.chaos += e.chaos;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.chaos - a.chaos; }).slice(0, 10)
      .map(function (p) { return { name: p.name, n: p.n, chaos: Math.round(p.chaos) }; });
  }
  var tops = UI.el('div', 'report-pair');
  tops.appendChild(UI.table([{ key: 'name', label: 'Top buyers' }, { key: 'n', label: 'Trades', num: true },
    { key: 'chaos', label: 'Chaos', num: true }], topPeople('sold'), { emptyText: 'No sales in this range.' }));
  tops.appendChild(UI.table([{ key: 'name', label: 'Top sellers' }, { key: 'n', label: 'Trades', num: true },
    { key: 'chaos', label: 'Chaos', num: true }], topPeople('bought'), { emptyText: 'No purchases in this range.' }));
  body.appendChild(tops);
  var under = list.filter(function (e) { return e.side === 'sold' && e.under; });
  if (under.length) {
    body.appendChild(UI.table([
      { key: 'item', label: 'Sold under market' },
      { key: 'price', label: 'You got', render: function (e) { return priceText(e.price, e.currency); } },
      { key: 'market', label: 'Going rate', num: true, render: function (e) { return fmtChaos(e.market); } },
      { key: 'pct', label: 'Under', num: true, render: function (e) { return Math.round((1 - e.chaos / e.market) * 100) + '%'; },
        sort: function (e) { return e.chaos / e.market; } },
      { key: 'time', label: 'When', render: function (e) { return new Date(e.time).toLocaleString(); }, sort: function (e) { return e.time; } }
    ], under.slice().reverse(), { sortable: true }));
  }
}

// ---- goal: profit since you set it, towards a target ------------------------------------------
function loadGoal() {
  try { return JSON.parse(localStorage.getItem(GOAL_KEY)) || null; } catch (e) { return null; }
}
function saveGoal(g) {
  if (g) saveShared(GOAL_KEY, JSON.stringify(g));
  else { try { localStorage.removeItem(GOAL_KEY); } catch (e) { /* fine */ } saveShared(GOAL_KEY, 'null'); }
}
function goalProgress(g) {
  return ledgerTotals(ledgerEntries().filter(function (e) { return e.time >= g.since; })).net;
}
function renderGoal(body) {
  var box = UI.el('div', 'goal-box');
  var g = loadGoal();
  box.appendChild(UI.el('h3', 'trade-h3', 'Goal'));
  if (!g) {
    var form = UI.el('div', 'goal-form');
    var name = UI.input({ placeholder: 'e.g. Mageblood', width: '160px', ariaLabel: 'Goal name' });
    var target = UI.input({ type: 'number', min: 1, step: 'any', width: '80px', ariaLabel: 'Goal amount' });
    var unit = UI.select([['div', 'divines'], ['chaos', 'chaos']], 'div', { ariaLabel: 'Goal currency' });
    UI.field('Saving for', name, { parent: form });
    UI.field('Amount', target, { parent: form });
    form.appendChild(unit);
    form.appendChild(UI.button('primary', { size: 'sm', label: 'Set goal', onClick: function () {
      var t = parseFloat(target.value);
      if (!name.value.trim() || !(t > 0)) { UI.toast('Give the goal a name and an amount.', 'warn'); return; }
      saveGoal({ name: name.value.trim(), target: t, unit: unit.value, since: Date.now() });
      renderTrades();
    } }));
    box.appendChild(form);
    box.appendChild(UI.el('p', 'finder-sub', 'Counts your net profit (earned − spent) from the moment you set it.'));
    body.appendChild(box);
    return;
  }
  var line = UI.el('div', 'goal-line');
  var bar = UI.el('div', 'goal-bar');
  var fill = UI.el('span', 'goal-fill');
  bar.appendChild(fill);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Goal progress');
  box.appendChild(line);
  box.appendChild(bar);
  var net = goalProgress(g);
  function show(rate) {
    var have = g.unit === 'div' ? (rate ? net / rate : null) : net;
    var pct = have == null ? 0 : Math.max(0, Math.min(100, have / g.target * 100));
    line.textContent = g.name + ': ' + (have == null ? fmtChaos(net) + ' so far (no divine rate yet)' :
      fmtCompact(Math.round(have * 10) / 10) + ' / ' + fmtCompact(g.target) + (g.unit === 'div' ? ' div' : 'c') + ' (' + Math.round(pct) + '%)') +
      ' · since ' + new Date(g.since).toLocaleDateString();
    fill.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    if (pct >= 100) line.textContent += ' · reached!';
  }
  show(null);
  if (g.unit === 'div') tradeDivRate((document.getElementById('league') || {}).value).then(show, function () {});
  var acts = UI.el('div', 'buyer-actions');
  acts.appendChild(UI.button('danger', { size: 'sm', label: 'Clear goal', onClick: function () {
    UI.confirmDanger('Clear the goal?', g.name + ' (' + fmtCompact(g.target) + (g.unit === 'div' ? ' div' : 'c') + '). Your trades stay.', 'Clear')
      .then(function (ok) { if (ok) { saveGoal(null); renderTrades(); } });
  } }));
  box.appendChild(acts);
  body.appendChild(box);
}

// ---- Setup → Your trade data: backup / restore -------------------------------------------------
function renderTradeDataSetup(sec) {
  sec.appendChild(UI.el('h3', 'trade-h3', 'Your trade data'));
  sec.appendChild(UI.el('p', 'finder-sub', 'Sales, purchases, people (notes, flags, blocked), merged characters and your goal, ' +
    'as one file: keep a copy, or move it to a new PC. Importing adds what you don\'t have yet and never removes anything.'));
  var row = UI.el('div', 'trade-row');
  row.appendChild(UI.button('secondary', { size: 'sm', label: 'Export backup', onClick: exportTradeBackup }));
  var file = document.createElement('input');
  file.type = 'file';
  file.accept = '.json,application/json';
  file.hidden = true;
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    f.text().then(importTradeBackup, function () { UI.toast('Couldn\'t read that file.', 'danger'); });
    file.value = '';
  });
  row.appendChild(file);
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Import backup…', onClick: function () { file.click(); } }));
  sec.appendChild(row);
}
function tradeBackup() {
  return { app: 'PoB Trade Finder', kind: 'trade-backup', version: 1, exported: new Date().toISOString(),
    sales: loadSales(), purchases: loadPurchases(), people: loadBuyers(), aliases: loadBuyerAliases(), goal: loadGoal() };
}
async function exportTradeBackup() {
  var text = JSON.stringify(tradeBackup());
  if (isGui() && window.pywebview.api.save_text_file) {
    var r = await window.pywebview.api.save_text_file('pobtf-trades-' + dayKey(Date.now()) + '.json', text);
    if (r && r.ok) UI.toast('Backup saved.', 'success');
    else if (r && r.error) UI.toast('Not saved: ' + r.error, 'danger');
    return;
  }
  navigator.clipboard.writeText(text).then(function () { UI.toast('Backup copied to the clipboard.', 'success'); });
}
// merge: new trades by id, new people by key (people you already have keep their record), new aliases
function mergeTradeBackup(data) {
  var add = { sales: 0, purchases: 0, people: 0 };
  function mergeList(cur, extra, key) {
    var ids = {};
    cur.forEach(function (x) { ids[x.id] = true; });
    var fresh = (extra || []).filter(function (x) { return x && x.id && x.time && !ids[x.id]; });
    add[key] = fresh.length;
    return cur.concat(fresh).sort(function (a, b) { return a.time - b.time; });
  }
  var sales = mergeList(loadSales(), data.sales, 'sales');
  var purchases = mergeList(loadPurchases(), data.purchases, 'purchases');
  var people = loadBuyers();
  Object.keys(data.people || {}).forEach(function (k) {
    if (!people[k] && data.people[k] && data.people[k].name) { people[k] = data.people[k]; add.people++; }
  });
  var aliases = loadBuyerAliases();
  Object.keys(data.aliases || {}).forEach(function (k) { if (!aliases[k]) aliases[k] = data.aliases[k]; });
  return { add: add, sales: sales, purchases: purchases, people: people, aliases: aliases,
    goal: loadGoal() || data.goal || null };
}
async function importTradeBackup(text) {
  var data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!data || data.kind !== 'trade-backup') { UI.toast('That isn\'t a PoB Trade Finder trade backup.', 'danger'); return; }
  var m = mergeTradeBackup(data);
  if (!m.add.sales && !m.add.purchases && !m.add.people) { UI.toast('Nothing new in that backup: you have all of it.', 'info'); return; }
  var ok = await UI.dialog({ title: 'Import this backup?', body: 'Adds ' + m.add.sales + ' sale(s), ' + m.add.purchases +
    ' purchase(s) and ' + m.add.people + ' person(s) from ' + (data.exported ? new Date(data.exported).toLocaleString() : 'the file') +
    '. Nothing you have now is changed or removed.', confirmLabel: 'Import' });
  if (!ok) return;
  saveSales(m.sales);
  savePurchases(m.purchases);
  saveBuyers(m.people);
  saveShared(BUYER_ALIASES_KEY, JSON.stringify(m.aliases));
  if (m.goal && !loadGoal()) saveGoal(m.goal);
  UI.toast('Imported.', 'success');
  renderTrades();
}
