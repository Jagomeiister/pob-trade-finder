/* js/app/19-trades.js — trade helper: incoming / outgoing trade cards from Client.txt, sales
   history and buyer notes. The js/app/ files are one program split by feature: they load in
   order (index.html) and share their top-level names. */
'use strict';

// ==== trade helper ================================================================
// gui.py opens a third window on index.html?trades=1 (always on top, hidden until needed)
// that shares the Api instance. With the helper switched on, Python tails Client.txt
// (trade_helper.LogTail) and calls window.__tradeEvent(<event>) for whispers, players
// joining/leaving your area and "Trade accepted".
//
// GGG's rules for tools, kept by design here:
// - every in-game command is ONE button press → ONE chat command (trade_send), never on
//   a timer, never from a log event, never cycling between actions (Invite and Trade are
//   separate buttons);
// - nothing is shared: sales, buyer notes, flags and hidden buyers stay on this machine;
// - "Ignore in game" sends /ignore once, only when pressed. Hiding a buyer only hides
//   their popups here.
var TRADES = /[?&]trades=1(&|$)/.test(location.search);
if (TRADES) document.body.classList.add('trades');

var TRADE_PREFS_KEY = 'pobtf-trade-prefs', SALES_KEY = 'pobtf-sales', BUYERS_KEY = 'pobtf-buyers';
var SALES_MAX = 5000;
var TRADE_MSGS = {
  busy: 'I\'m busy right now, I\'ll invite you shortly',
  sold: 'sorry, {item} is already sold',
  still: 'are you still interested in {item} for {price}?',
  thanks: 'thanks, have fun!'
};
var tradeCards = [];         // open cards, newest first
var tradeSeq = 0;
var tradeTab = 'trades';
var tradeStatus = null;      // last trade_status() answer
var tradeRates = {};         // league -> { div: chaos per divine, at }
var tradeAudio = null;

function tradePrefs() {
  var p;
  try { p = JSON.parse(localStorage.getItem(TRADE_PREFS_KEY)) || {}; } catch (e) { p = {}; }
  if (p.sound === undefined) p.sound = true;
  if (!p.noShowMin) p.noShowMin = 5;
  p.msgs = Object.assign({}, TRADE_MSGS, p.msgs || {});
  return p;
}
function saveTradePrefs(p) { persist(TRADE_PREFS_KEY, JSON.stringify(p)); }
function loadSales() {
  try { return JSON.parse(localStorage.getItem(SALES_KEY)) || []; } catch (e) { return []; }
}
function saveSales(list) { persist(SALES_KEY, JSON.stringify(list.slice(-SALES_MAX))); }
function loadBuyers() {
  try { return JSON.parse(localStorage.getItem(BUYERS_KEY)) || {}; } catch (e) { return {}; }
}
function saveBuyers(b) { persist(BUYERS_KEY, JSON.stringify(b)); }

// buyers are tracked by account name when known, else by character name
function buyerKey(card) { return (card.account || card.name || '').toLowerCase(); }
function buyerFor(card) {
  var all = loadBuyers();
  return all[buyerKey(card)] || null;
}
function updateBuyer(card, fn) {
  var all = loadBuyers(), k = buyerKey(card);
  if (!k) return;
  var b = all[k] || { name: card.name, account: card.account || null, names: [], completed: 0, spent: 0,
    wasted: 0, noShow: 0, notCompleted: 0, other: 0, flag: false, hidden: false, note: '', first: Date.now() };
  if (b.names.indexOf(card.name) === -1) b.names.push(card.name);
  b.name = card.name;
  b.last = Date.now();
  fn(b);
  all[k] = b;
  saveBuyers(all);
}
function buyerBadge(b) {
  if (!b) return null;
  var parts = [];
  if (b.completed) parts.push(b.completed + ' bought');
  if (b.wasted || b.noShow) parts.push((b.wasted + b.noShow) + ' wasted');
  if (!parts.length && !b.flag) return null;
  var tone = b.flag || (b.wasted + b.noShow) > b.completed ? 'danger' : 'success';
  var c = UI.chip((b.flag ? '⚑ ' : '') + (parts.join(' · ') || 'flagged'), tone, 'buyer-badge');
  c.title = (b.flag ? 'You flagged this buyer. ' : '') + (b.note || '') +
    (b.spent ? ' Spent ' + fmtChaos(b.spent) + ' with you.' : '');
  return c;
}

// ---- prices --------------------------------------------------------------------------
async function tradeDivRate(league) {
  var c = tradeRates[league];
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.div;
  var div = null;
  try {
    var r = await window.pywebview.api.quick_price(league, JSON.stringify({ name: 'Divine Orb', rarity: 'CURRENCY' }));
    if (r && r.ok && r.chaos) div = r.chaos;
  } catch (e) { /* no rate: chaos only */ }
  tradeRates[league] = { div: div, at: Date.now() };
  return div;
}
// {chaos, div} for a price in a currency, or nulls when it can't be converted
function tradeValue(price, currency, div) {
  if (price == null) return { chaos: null, div: null };
  var chaos = currency === 'chaos' ? price : currency === 'divine' && div ? price * div : null;
  return { chaos: chaos, div: chaos != null && div ? chaos / div : (currency === 'divine' ? price : null) };
}
function priceText(price, currency) {
  if (price == null) return 'no price';
  return fmtCompact(price) + ' ' + (currency === 'chaos' ? 'c' : currency === 'divine' ? 'div' : currency || '');
}

// ---- events from Client.txt --------------------------------------------------------
window.__tradeEvent = function (ev) {
  if (!TRADES || !ev) return false;
  if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch (e) { return false; } }
  handleTradeEvent(ev);
  return true;
};

function findCard(name, dir) {
  var n = (name || '').toLowerCase();
  return tradeCards.filter(function (c) { return c.name.toLowerCase() === n && (!dir || c.dir === dir); })[0] || null;
}

function handleTradeEvent(ev) {
  var now = Date.now();
  if (ev.type === 'whisper') {
    var dir = ev.dir === 'out' ? 'out' : 'in';
    var card = findCard(ev.name, dir);
    if (ev.trade) {
      var same = card && card.trade && card.trade.item === ev.trade.item && now - card.at < 15 * 60 * 1000;
      if (same) {
        card.repeats = (card.repeats || 1) + 1;
        card.lastText = ev.text;
      } else {
        card = { id: ++tradeSeq, dir: dir, name: ev.name, guild: ev.guild || null, trade: ev.trade, text: ev.text,
                 lastText: null, at: now, time: ev.time, repeats: 1, joined: false, left: false,
                 invitedAt: null, acceptHint: false, sent: {} };
        var b = dir === 'in' ? buyerFor(card) : null;
        card.hidden = !!(b && b.hidden);
        tradeCards.unshift(card);
        if (dir === 'in' && !card.hidden) tradeChime('new');
      }
    } else if (card) {
      card.lastText = ev.text; // a chat reply to an open trade
      card.lastDir = dir;
    } else {
      return;
    }
  } else if (ev.type === 'joined') {
    var c = findCard(ev.name, 'in');
    if (!c) return;
    c.joined = true;
    c.left = false;
    c.joinedAt = now;
    if (!c.hidden) tradeChime('joined');
  } else if (ev.type === 'left') {
    var cl = findCard(ev.name, 'in');
    if (!cl) return;
    cl.left = true;
  } else if (ev.type === 'trade_accepted') {
    // the log doesn't say with whom: the buyer who joined most recently
    var cands = tradeCards.filter(function (x) { return x.dir === 'in' && x.joined; })
      .sort(function (a, b2) { return (b2.joinedAt || 0) - (a.joinedAt || 0); });
    if (!cands.length) return;
    cands[0].acceptHint = true;
  } else if (ev.type === 'afk' || ev.type === 'dnd') {
    tradeStatusFlags[ev.type] = !!ev.on;
  } else {
    return;
  }
  renderTrades();
}
var tradeStatusFlags = { afk: false, dnd: false };

function tradeChime(kind) {
  var p = tradePrefs();
  if (!p.sound) return;
  try {
    if (!tradeAudio) tradeAudio = new (window.AudioContext || window.webkitAudioContext)();
    var t = tradeAudio.currentTime;
    var notes = kind === 'joined' ? [660, 990] : [784, 1175, 1568];
    var peak = Math.max(0.02, Math.min(1, (parseInt(PREFS.volume, 10) || 25) / 100));
    notes.forEach(function (f, i) {
      var o = tradeAudio.createOscillator(), g = tradeAudio.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.1);
      g.gain.exponentialRampToValueAtTime(peak, t + i * 0.1 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.1 + 0.3);
      o.connect(g); g.connect(tradeAudio.destination);
      o.start(t + i * 0.1); o.stop(t + i * 0.1 + 0.35);
    });
  } catch (e) { /* no sound */ }
}

// ---- one press = one chat command --------------------------------------------------
async function tradeSend(card, action, text, btn) {
  if (!isGui() || !window.pywebview.api.trade_send) return false;
  if (btn) btn.disabled = true;
  var r;
  try { r = await window.pywebview.api.trade_send(action, card.name, text || null); }
  catch (e) { r = { ok: false, error: String(e) }; }
  if (btn) btn.disabled = false;
  if (!r || !r.ok) {
    UI.toast('Not sent: ' + ((r && r.error) || 'no answer'), 'danger');
    return false;
  }
  card.sent[action + (text ? ':' + text : '')] = Date.now();
  if (action === 'invite') card.invitedAt = card.invitedAt || Date.now();
  renderTrades();
  return true;
}
function fillMsg(tpl, card) {
  var t = card.trade || {};
  return tpl.replace(/\{item\}/g, t.item || 'that').replace(/\{price\}/g, priceText(t.price, t.currency));
}

// ---- outcomes --------------------------------------------------------------------------
async function recordOutcome(card, outcome, opts) {
  opts = opts || {};
  var t = card.trade || {};
  var league = t.league || document.getElementById('league').value;
  var price = opts.price != null ? opts.price : t.price;
  var currency = opts.currency || t.currency;
  var div = await tradeDivRate(league);
  var v = tradeValue(price, currency, div);
  if (card.dir === 'in') {
    var list = loadSales();
    list.push({ id: Date.now() + '-' + card.id, time: Date.now(), outcome: outcome, league: league,
      item: t.item || '', count: t.count || null, price: price, currency: currency || null,
      chaos: v.chaos != null ? Math.round(v.chaos * 100) / 100 : null,
      div: v.div != null ? Math.round(v.div * 1000) / 1000 : null,
      buyer: card.name, account: card.account || null, tab: t.tab || null, left: t.left || null, top: t.top || null,
      note: opts.note || '' });
    saveSales(list);
    updateBuyer(card, function (b) {
      if (outcome === 'completed') { b.completed++; b.spent = Math.round(((b.spent || 0) + (v.chaos || 0)) * 100) / 100; }
      else if (outcome === 'wasted') b.wasted++;
      else if (outcome === 'no_show') b.noShow++;
      else if (outcome === 'not_completed') b.notCompleted++;
      else b.other++;
    });
  }
  closeCard(card);
}
function closeCard(card) {
  tradeCards = tradeCards.filter(function (c) { return c !== card; });
  renderTrades();
}

// ---- rendering ---------------------------------------------------------------------------
function tradeAge(ms) {
  var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
}

function renderTradeCard(card) {
  var p = tradePrefs();
  var t = card.trade || {};
  var el = UI.el('div', 'trade-card ' + card.dir + (card.joined ? ' joined' : '') + (card.acceptHint ? ' accepted' : ''));
  el.dataset.id = card.id;
  var head = UI.el('div', 'tc-head');
  head.appendChild(UI.el('span', 'tc-dir', card.dir === 'in' ? 'Buyer' : 'Seller'));
  var who = UI.el('b', 'tc-name', card.name);
  if (card.guild) who.title = '<' + card.guild + '>';
  head.appendChild(who);
  if (card.dir === 'in') { var bb = buyerBadge(buyerFor(card)); if (bb) head.appendChild(bb); }
  if (card.joined && !card.left) head.appendChild(UI.chip('In your hideout', 'success', 'tc-here'));
  if (card.left) head.appendChild(UI.chip('Left', 'warn'));
  if (card.repeats > 1) head.appendChild(UI.chip('×' + card.repeats + ' whispers', 'info'));
  head.appendChild(UI.el('span', 'tc-age', tradeAge(card.at)));
  head.appendChild(UI.iconButton('✕', 'Dismiss this card', { size: 'sm', onClick: function () { closeCard(card); } }));
  el.appendChild(head);

  var what = UI.el('div', 'tc-item');
  what.appendChild(UI.el('span', 'tc-item-name', (t.count ? fmtCompact(t.count) + ' × ' : '') + (t.item || card.text)));
  if (t.item) what.appendChild(UI.el('b', 'tc-price', priceText(t.price, t.currency)));
  el.appendChild(what);
  var where = [];
  if (t.league) where.push(t.league);
  if (t.tab) where.push('tab "' + t.tab + '"' + (t.left ? ' · left ' + t.left + ', top ' + t.top : ''));
  if (where.length) el.appendChild(UI.el('div', 'tc-where', where.join(' · ')));
  if (t.note) el.appendChild(UI.el('div', 'tc-note', '“' + t.note + '”'));
  if (card.lastText) el.appendChild(UI.el('div', 'tc-last', (card.lastDir === 'out' ? 'You: ' : card.name + ': ') + card.lastText));

  var acts = UI.el('div', 'tc-actions');
  function act(label, action, text, variant, title) {
    var b = UI.button(variant || 'secondary', { size: 'sm', label: label, title: title,
      onClick: function () { tradeSend(card, action, text, b); } });
    if (card.sent[action + (text ? ':' + text : '')]) b.classList.add('was-sent');
    acts.appendChild(b);
    return b;
  }
  if (card.dir === 'in') {
    if (!card.joined) {
      act('Invite', 'invite', null, 'primary', 'Send /invite ' + card.name);
      act('Busy', 'whisper', fillMsg(p.msgs.busy, card), null, 'Whisper: ' + fillMsg(p.msgs.busy, card));
      act('Sold', 'whisper', fillMsg(p.msgs.sold, card), null, 'Whisper: ' + fillMsg(p.msgs.sold, card));
      act('Still interested?', 'whisper', fillMsg(p.msgs.still, card), null, 'Whisper: ' + fillMsg(p.msgs.still, card));
    } else {
      act('Trade', 'trade', null, 'primary', 'Send /tradewith ' + card.name);
      act('Kick', 'kick', null, null, 'Send /kick ' + card.name + ' (removes them from your party)');
      act('Thanks', 'whisper', fillMsg(p.msgs.thanks, card), null, 'Whisper: ' + fillMsg(p.msgs.thanks, card));
    }
    if (t.left && isGui() && window.pywebview.api.trade_highlight) {
      acts.appendChild(UI.button('ghost', { size: 'sm', label: '▣ Show in stash',
        title: 'Outline the item\'s cell over your open stash tab for 20 seconds',
        onClick: function () { window.pywebview.api.trade_highlight(t.left, t.top, t.tab || ''); } }));
    }
    acts.appendChild(UI.menu(function () {
      return [
        { label: 'Whois', onClick: function () { tradeSend(card, 'whois'); }, title: 'Send /whois ' + card.name },
        { label: (buyerFor(card) || {}).flag ? 'Unflag buyer' : '⚑ Flag buyer', onClick: function () {
          updateBuyer(card, function (b) { b.flag = !b.flag; }); renderTrades(); } },
        { label: 'Hide this buyer', onClick: function () { hideBuyer(card); },
          title: 'No more popups or sounds from them here; their whispers go to the Hidden list' },
        { label: 'Ignore in game…', onClick: function () { ignoreInGame(card); },
          title: 'Send /ignore ' + card.name + ' once' }
      ];
    }, { ariaLabel: 'More for ' + card.name, size: 'sm' }));
  } else {
    act('Visit hideout', 'hideout', null, 'primary', 'Send /hideout ' + card.name);
    act('Trade', 'trade', null, null, 'Send /tradewith ' + card.name);
    act('Re-whisper', 'whisper', card.text, null, 'Send your original whisper again');
  }
  el.appendChild(acts);

  if (card.dir === 'in') el.appendChild(renderOutcomes(card, p));
  return el;
}

function renderOutcomes(card, p) {
  var t = card.trade || {};
  var box = UI.el('div', 'tc-outcomes');
  var waited = card.invitedAt && !card.joined && Date.now() - card.invitedAt > p.noShowMin * 60 * 1000;
  if (!card.joined) {
    if (waited) {
      box.appendChild(UI.button('ghost', { size: 'sm', label: '⌛ Mark as no-show',
        title: 'Invited ' + tradeAge(card.invitedAt) + ' ago and never came', onClick: function () { recordOutcome(card, 'no_show'); } }));
    }
    return box;
  }
  var row = UI.el('div', 'tc-done');
  var priceIn = UI.input({ type: 'number', cls: 'tc-price-in', value: t.price != null ? t.price : '', min: 0, step: 'any',
    width: '72px', ariaLabel: 'Price received' });
  var curSel = UI.select([['chaos', 'c'], ['divine', 'div']].concat(
    t.currency && t.currency !== 'chaos' && t.currency !== 'divine' ? [[t.currency, t.currency]] : []), t.currency || 'chaos',
    { ariaLabel: 'Currency received' });
  var done = UI.button(card.acceptHint ? 'primary' : 'secondary', { size: 'sm', label: '✓ Completed',
    title: card.acceptHint ? 'The game logged "Trade accepted"' : 'Record the sale at this price',
    onClick: function () {
      var v = parseFloat(priceIn.value);
      recordOutcome(card, 'completed', { price: isNaN(v) ? null : v, currency: curSel.value });
    } });
  if (card.acceptHint) done.classList.add('suggested');
  row.appendChild(done);
  row.appendChild(priceIn);
  row.appendChild(curSel);
  box.appendChild(row);
  var more = UI.el('div', 'tc-other');
  more.appendChild(UI.button('ghost', { size: 'sm', label: '✗ Not completed', onClick: function () { recordOutcome(card, 'not_completed'); } }));
  more.appendChild(UI.button('ghost', { size: 'sm', label: '⌛ Time wasted', onClick: function () { recordOutcome(card, 'wasted'); } }));
  more.appendChild(UI.button('ghost', { size: 'sm', label: 'Other…', onClick: function () {
    var note = UI.input({ placeholder: 'What happened?', width: '180px', ariaLabel: 'Note' });
    UI.dialog({ title: 'Other outcome', body: note, confirmLabel: 'Save' }).then(function (ok) {
      if (ok) recordOutcome(card, 'other', { note: note.value.trim() });
    });
    setTimeout(function () { note.focus(); }, 30);
  } }));
  box.appendChild(more);
  return box;
}

async function hideBuyer(card) {
  updateBuyer(card, function (b) { b.hidden = true; });
  tradeCards.forEach(function (c) { if (c.dir === 'in' && buyerKey(c) === buyerKey(card)) c.hidden = true; });
  UI.toast(card.name + ' is hidden here. Buyers tab to undo.', 'info');
  renderTrades();
}
async function ignoreInGame(card) {
  var ok = await UI.dialog({ title: 'Ignore ' + card.name + ' in game?',
    body: 'Sends /ignore ' + card.name + ' to Path of Exile once. Undo in game with /unignore.', confirmLabel: 'Send /ignore' });
  if (ok) tradeSend(card, 'ignore');
}

function renderTrades() {
  var root = document.getElementById('trades-root');
  if (!root) return;
  root.querySelectorAll('.trades-tab').forEach(function (b) {
    b.setAttribute('aria-selected', b.dataset.tab === tradeTab ? 'true' : 'false');
  });
  var body = document.getElementById('trades-body');
  body.textContent = '';
  if (tradeTab === 'trades') renderTradeList(body);
  else if (tradeTab === 'sales') renderSalesPage(body);
  else if (tradeTab === 'buyers') renderBuyersPage(body);
  else renderTradeSetup(body);
  renderTradeStatusLine();
}

function renderTradeList(body) {
  var p = tradePrefs();
  if (!p.enabled) {
    body.appendChild(UI.emptyState({ title: 'Trade helper is off',
      text: 'Switch it on in Setup to get a card for every trade whisper.',
      action: UI.button('primary', { label: 'Open Setup', onClick: function () { tradeTab = 'setup'; renderTrades(); } }) }));
    return;
  }
  var shown = tradeCards.filter(function (c) { return !c.hidden; });
  var hidden = tradeCards.filter(function (c) { return c.hidden; });
  if (!shown.length) {
    body.appendChild(UI.emptyState({ title: 'No trades right now',
      text: 'Trade whispers you get or send in game show up here.' }));
  }
  shown.forEach(function (c) { body.appendChild(renderTradeCard(c)); });
  if (hidden.length) {
    var box = UI.el('div', 'tc-hidden');
    hidden.forEach(function (c) {
      var r = UI.el('div', 'tc-hidden-row');
      r.appendChild(UI.el('b', null, c.name));
      r.appendChild(UI.el('span', null, (c.trade && c.trade.item) || c.text));
      r.appendChild(UI.button('ghost', { size: 'sm', label: 'Show', onClick: function () { c.hidden = false; renderTrades(); } }));
      r.appendChild(UI.button('ghost', { size: 'sm', label: 'Dismiss', onClick: function () { closeCard(c); } }));
      box.appendChild(r);
    });
    body.appendChild(UI.disclosure('Hidden (' + hidden.length + ')', box));
  }
}

function renderTradeStatusLine() {
  var el = document.getElementById('trades-status');
  if (!el) return;
  var st = tradeStatus, p = tradePrefs();
  var txt;
  if (!p.enabled) txt = 'Off';
  else if (!st) txt = 'Starting…';
  else if (st.error) txt = '⚠ ' + st.error;
  else if (st.watching) txt = '● Reading ' + (st.logName || 'Client.txt');
  else txt = 'Not reading the log';
  if (tradeStatusFlags.afk) txt += ' · AFK on';
  if (tradeStatusFlags.dnd) txt += ' · DND on';
  el.textContent = txt;
  el.className = 'trades-status' + (st && st.error ? ' warn' : st && st.watching ? ' ok' : '');
}

// ---- Sales page ------------------------------------------------------------------------
var salesFilter = { league: '', period: '30', outcome: 'completed', q: '' };
function filteredSales() {
  var since = salesFilter.period === 'all' ? 0 : Date.now() - parseInt(salesFilter.period, 10) * 86400000;
  var q = salesFilter.q.toLowerCase();
  return loadSales().filter(function (s) {
    return s.time >= since && (!salesFilter.league || s.league === salesFilter.league) &&
      (salesFilter.outcome === 'all' || s.outcome === salesFilter.outcome) &&
      (!q || (s.item + ' ' + s.buyer).toLowerCase().indexOf(q) !== -1);
  });
}
function dayKey(ms) {
  var d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function salesSummary(list) {
  var done = list.filter(function (s) { return s.outcome === 'completed'; });
  var chaos = 0, div = 0, priced = 0, byLeague = {}, byDay = {}, byItem = {};
  done.forEach(function (s) {
    if (s.chaos != null) { chaos += s.chaos; priced++; }
    if (s.div != null) div += s.div;
    var L = byLeague[s.league] = byLeague[s.league] || { n: 0, chaos: 0, div: 0 };
    L.n++; L.chaos += s.chaos || 0; L.div += s.div || 0;
    var d = byDay[dayKey(s.time)] = byDay[dayKey(s.time)] || { n: 0, chaos: 0 };
    d.n++; d.chaos += s.chaos || 0;
    var it = byItem[s.item] = byItem[s.item] || { item: s.item, n: 0, chaos: 0 };
    it.n++; it.chaos += s.chaos || 0;
  });
  var best = Object.keys(byItem).map(function (k) { return byItem[k]; })
    .sort(function (a, b) { return b.chaos - a.chaos || b.n - a.n; }).slice(0, 10);
  return { count: done.length, chaos: chaos, div: div, avg: priced ? chaos / priced : null,
    byLeague: byLeague, byDay: byDay, best: best };
}

function salesCsv(list) {
  var cols = ['time', 'outcome', 'league', 'item', 'count', 'price', 'currency', 'chaos', 'div', 'buyer', 'account',
              'tab', 'left', 'top', 'note'];
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

function salesChart(byDay, days) {
  var keys = [];
  for (var i = days - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
  var max = Math.max.apply(null, keys.map(function (k) { return (byDay[k] || {}).chaos || 0; }).concat([1]));
  var w = 600, h = 90, bw = w / keys.length;
  var svg = '<svg class="sales-chart" viewBox="0 0 ' + w + ' ' + (h + 14) + '" role="img" aria-label="Chaos earned per day, last ' + days + ' days">';
  keys.forEach(function (k, i) {
    var v = (byDay[k] || {}).chaos || 0, bh = Math.round(v / max * h);
    svg += '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (h - bh) + '" width="' + Math.max(1, bw - 2).toFixed(1) +
      '" height="' + bh + '"><title>' + k + ': ' + Math.round(v) + 'c, ' + ((byDay[k] || {}).n || 0) + ' sold</title></rect>';
  });
  svg += '<text x="0" y="' + (h + 12) + '">' + keys[0].slice(5) + '</text><text x="' + w + '" y="' + (h + 12) +
    '" text-anchor="end">today</text></svg>';
  var box = UI.el('div', 'sales-chart-box');
  box.innerHTML = svg;
  return box;
}

function renderSalesPage(body) {
  var all = loadSales();
  var leagues = [];
  all.forEach(function (s) { if (s.league && leagues.indexOf(s.league) === -1) leagues.push(s.league); });
  var bar = UI.el('div', 'sales-filters');
  function onF(k) { return function () { salesFilter[k] = this.value; renderTrades(); }; }
  UI.field('League', UI.select([['', 'All']].concat(leagues.map(function (l) { return [l, l]; })), salesFilter.league,
    { onChange: onF('league') }), { parent: bar });
  UI.field('Period', UI.select([['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time']], salesFilter.period,
    { onChange: onF('period') }), { parent: bar });
  UI.field('Show', UI.select([['completed', 'Sales'], ['all', 'All outcomes'], ['wasted', 'Time wasted'],
    ['no_show', 'No-shows'], ['not_completed', 'Not completed'], ['other', 'Other']], salesFilter.outcome,
    { onChange: onF('outcome') }), { parent: bar });
  var q = UI.input({ placeholder: 'Item or buyer', width: '140px', value: salesFilter.q, ariaLabel: 'Search sales' });
  q.addEventListener('change', onF('q'));
  UI.field('Search', q, { parent: bar });
  var list = filteredSales();
  bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Export CSV', onClick: function () { exportSalesCsv(list); } }));
  body.appendChild(bar);

  var sum = salesSummary(list);
  var tiles = UI.el('div', 'sales-tiles');
  [['Sales', String(sum.count)], ['Total', fmtChaos(sum.chaos) + (sum.div ? ' · ' + fmtCompact(sum.div) + ' div' : '')],
   ['Average', sum.avg != null ? fmtChaos(sum.avg) : '—']].forEach(function (x) {
    var tl = UI.el('div', 'sales-tile');
    tl.appendChild(UI.el('span', 'st-label', x[0]));
    tl.appendChild(UI.el('b', 'st-value', x[1]));
    tiles.appendChild(tl);
  });
  body.appendChild(tiles);
  if (sum.count) body.appendChild(salesChart(sum.byDay, salesFilter.period === '1' ? 7 : 30));
  var lk = Object.keys(sum.byLeague);
  if (lk.length > 1) {
    body.appendChild(UI.table([{ key: 'l', label: 'League' }, { key: 'n', label: 'Sales', num: true },
      { key: 'c', label: 'Chaos', num: true }, { key: 'd', label: 'Divine', num: true }],
      lk.map(function (l) { var L = sum.byLeague[l]; return { l: l, n: L.n, c: Math.round(L.chaos), d: fmtCompact(L.div) }; }),
      { caption: 'Per league' }));
  }
  if (sum.best.length) {
    body.appendChild(UI.table([{ key: 'item', label: 'Best sellers' }, { key: 'n', label: 'Sold', num: true },
      { key: 'c', label: 'Chaos', num: true }],
      sum.best.map(function (b) { return { item: b.item, n: b.n, c: Math.round(b.chaos) }; })));
  }
  body.appendChild(UI.table([
    { key: 'time', label: 'When', render: function (s) { return new Date(s.time).toLocaleString(); }, sort: function (s) { return s.time; } },
    { key: 'item', label: 'Item' },
    { key: 'price', label: 'Price', render: function (s) { return priceText(s.price, s.currency); } },
    { key: 'chaos', label: 'Chaos', num: true, render: function (s) { return s.chaos != null ? fmtCompact(s.chaos) : ''; } },
    { key: 'div', label: 'Div', num: true, render: function (s) { return s.div != null ? fmtCompact(s.div) : ''; } },
    { key: 'buyer', label: 'Buyer' },
    { key: 'league', label: 'League' },
    { key: 'tab', label: 'Stash', render: function (s) { return s.tab ? s.tab + (s.left ? ' (' + s.left + ',' + s.top + ')' : '') : ''; } },
    { key: 'outcome', label: 'Outcome', render: function (s) { return OUTCOME_LABEL[s.outcome] || s.outcome; } }
  ], list.slice().reverse(), { sortable: true, emptyText: 'Nothing recorded yet. Mark a trade ✓ Completed to see it here.' }));
}
var OUTCOME_LABEL = { completed: 'Sold', not_completed: 'Not completed', wasted: 'Time wasted', no_show: 'No-show', other: 'Other' };

async function exportSalesCsv(list) {
  var text = salesCsv(list);
  if (isGui() && window.pywebview.api.save_text_file) {
    var r = await window.pywebview.api.save_text_file('sales-' + dayKey(Date.now()) + '.csv', text);
    if (r && r.ok) UI.toast('Saved ' + list.length + ' rows.', 'success');
    else if (r && r.error) UI.toast('Not saved: ' + r.error, 'danger');
    return;
  }
  navigator.clipboard.writeText(text).then(function () { UI.toast('CSV copied to the clipboard.', 'success'); });
}

// ---- Buyers page -----------------------------------------------------------------------
function renderBuyersPage(body) {
  var all = loadBuyers();
  var keys = Object.keys(all).sort(function (a, b) { return (all[b].last || 0) - (all[a].last || 0); });
  if (!keys.length) {
    body.appendChild(UI.emptyState({ title: 'No buyers yet', text: 'Buyers appear here after you record a trade outcome or flag someone.' }));
    return;
  }
  keys.forEach(function (k) {
    var b = all[k];
    var row = UI.el('div', 'buyer-row' + (b.hidden ? ' is-hidden' : ''));
    var head = UI.el('div', 'buyer-head');
    head.appendChild(UI.el('b', null, b.account || b.name));
    if (b.names && b.names.length > 1) head.appendChild(UI.el('span', 'finder-sub', b.names.join(', ')));
    if (b.flag) head.appendChild(UI.chip('⚑ Flagged', 'danger'));
    if (b.hidden) head.appendChild(UI.chip('Hidden', 'neutral'));
    row.appendChild(head);
    row.appendChild(UI.el('div', 'buyer-stats', b.completed + ' bought · ' + fmtChaos(b.spent || 0) + ' spent · ' +
      b.wasted + ' time wasted · ' + b.noShow + ' no-shows · ' + b.notCompleted + ' not completed'));
    var note = UI.input({ placeholder: 'Note (only you see this)', value: b.note || '', width: '100%', ariaLabel: 'Note on ' + b.name });
    note.addEventListener('change', function () {
      var a = loadBuyers(); if (a[k]) { a[k].note = note.value; saveBuyers(a); }
    });
    row.appendChild(note);
    var acts = UI.el('div', 'buyer-actions');
    function toggle(field, on, off) {
      acts.appendChild(UI.button('ghost', { size: 'sm', label: b[field] ? off : on, onClick: function () {
        var a = loadBuyers(); a[k][field] = !a[k][field]; saveBuyers(a);
        if (field === 'hidden') tradeCards.forEach(function (c) { if (buyerKey(c) === k) c.hidden = a[k].hidden; });
        renderTrades();
      } }));
    }
    toggle('flag', '⚑ Flag', 'Unflag');
    toggle('hidden', 'Hide popups', 'Show popups');
    acts.appendChild(UI.button('ghost', { size: 'sm', label: 'Ignore in game…',
      onClick: function () { ignoreInGame({ name: b.name, sent: {} }); } }));
    acts.appendChild(UI.button('danger', { size: 'sm', label: 'Clear history', onClick: function () {
      UI.confirmDanger('Clear ' + b.name + '?', 'Removes their counts, note, flag and hidden setting. Your sales list keeps the sales.',
        'Clear').then(function (ok) {
        if (!ok) return;
        var a = loadBuyers(); delete a[k]; saveBuyers(a);
        tradeCards.forEach(function (c) { if (buyerKey(c) === k) c.hidden = false; });
        renderTrades();
      });
    } }));
    row.appendChild(acts);
    body.appendChild(row);
  });
}

// ---- Setup -----------------------------------------------------------------------------
function renderTradeSetup(body) {
  var p = tradePrefs();
  var sec = UI.el('div', 'trade-setup');
  var on = UI.el('label', 'toggle');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!p.enabled;
  cb.id = 'trade-enabled';
  on.appendChild(cb);
  on.appendChild(UI.el('span', null, 'Trade helper on'));
  cb.addEventListener('change', function () { setTradeEnabled(cb.checked); });
  sec.appendChild(on);
  sec.appendChild(UI.el('p', 'finder-sub', 'Reads Path of Exile\'s chat log (Client.txt) on this PC to show trade whispers. ' +
    'Nothing leaves your computer: sales, buyer notes and flags are stored only here. Each button sends exactly one ' +
    'chat command when you press it; the app never acts on its own.'));
  var st = tradeStatus || {};
  var logRow = UI.el('div', 'trade-log-row');
  logRow.appendChild(UI.el('span', null, st.logPath ? 'Log: ' + st.logPath : 'Log: not found yet (start Path of Exile, or choose it)'));
  logRow.appendChild(UI.button('ghost', { size: 'sm', label: 'Choose Client.txt…', onClick: async function () {
    var r = await window.pywebview.api.trade_pick_log();
    if (r && r.ok && r.path) { var q = tradePrefs(); q.logPath = r.path; saveTradePrefs(q); await startTradeHelper(); }
  } }));
  sec.appendChild(logRow);
  if (st.elevationMismatch) {
    sec.appendChild(UI.el('p', 'trade-warn', '⚠ Path of Exile runs as administrator and this app doesn\'t, so Windows blocks ' +
      'the buttons from typing in the game. Run both the same way.'));
  }
  if (st.chatKeyName) sec.appendChild(UI.el('p', 'finder-sub', 'Chat key (from your game settings): ' + st.chatKeyName));

  var snd = UI.el('label', 'toggle');
  var scb = document.createElement('input');
  scb.type = 'checkbox';
  scb.checked = !!p.sound;
  scb.addEventListener('change', function () { var q = tradePrefs(); q.sound = scb.checked; saveTradePrefs(q); });
  snd.appendChild(scb);
  snd.appendChild(UI.el('span', null, 'Sound on new trades and when a buyer arrives'));
  sec.appendChild(snd);
  var ns = UI.select([['3', '3 min'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min']], String(p.noShowMin), {
    onChange: function () { var q = tradePrefs(); q.noShowMin = parseInt(this.value, 10); saveTradePrefs(q); } });
  UI.field('Offer "no-show" after', ns, { parent: sec });

  sec.appendChild(UI.el('h3', 'trade-h3', 'Messages'));
  sec.appendChild(UI.el('p', 'finder-sub', '{item} and {price} are filled in from the trade.'));
  [['busy', 'Busy'], ['sold', 'Sold'], ['still', 'Still interested?'], ['thanks', 'Thanks']].forEach(function (m) {
    var inp = UI.input({ value: p.msgs[m[0]], width: '100%', ariaLabel: m[1] + ' message' });
    inp.addEventListener('change', function () {
      var q = tradePrefs(); q.msgs[m[0]] = inp.value.trim() || TRADE_MSGS[m[0]]; saveTradePrefs(q);
    });
    UI.field(m[1], inp, { parent: sec, cls: 'field-wide' });
  });
  body.appendChild(sec);
}

async function setTradeEnabled(on) {
  var p = tradePrefs();
  if (on && !p.ack) {
    var ok = await UI.dialog({ title: 'Switch on the trade helper?',
      body: 'The app will read Path of Exile\'s chat log file (Client.txt) on this PC while it runs, to show trade ' +
        'whispers as cards. It stays on this computer. Buttons send one chat command each, only when you press them.',
      confirmLabel: 'Switch on' });
    if (!ok) { renderTrades(); return; }
    p.ack = true;
  }
  p.enabled = on;
  saveTradePrefs(p);
  await startTradeHelper();
}

async function startTradeHelper() {
  if (!isGui() || !window.pywebview.api.trade_enable) return;
  var p = tradePrefs();
  try { tradeStatus = await window.pywebview.api.trade_enable(!!p.enabled, p.logPath || null); }
  catch (e) { tradeStatus = { ok: false, error: String(e) }; }
  renderTrades();
}

// main window: Settings → In game → Trade helper…, and Tools → Trade helper in the sidebar
function openTradesWindow() {
  if (isGui() && window.pywebview.api.trades_show) window.pywebview.api.trades_show();
  else UI.toast('The trade helper needs the desktop app.', 'warn');
}

function tradesClose() {
  if (isGui() && window.pywebview.api.trades_hide) window.pywebview.api.trades_hide();
}

// called from markGui() in the trades window
function tradesReady(hydrate) {
  document.body.classList.add('gui');
  Promise.resolve(hydrate()).then(startTradeHelper, startTradeHelper);
  setInterval(function () { if (tradeTab === 'trades' && tradeCards.length) renderTrades(); }, 30000); // ages, no-show
}

document.addEventListener('DOMContentLoaded', function () {
  var opener = document.getElementById('open-trades');
  if (opener) opener.addEventListener('click', openTradesWindow);
  if (!TRADES) return;
  var root = UI.el('div', 'trades-root');
  root.id = 'trades-root';
  var bar = UI.el('div', 'trades-bar');
  bar.appendChild(UI.el('span', 'ov-title', 'Trades'));
  var st = UI.el('span', 'trades-status');
  st.id = 'trades-status';
  bar.appendChild(st);
  bar.appendChild(UI.iconButton('✕', 'Hide the trade window', { size: 'sm', onClick: tradesClose }));
  root.appendChild(bar);
  var tabs = UI.el('div', 'trades-tabs');
  tabs.setAttribute('role', 'tablist');
  [['trades', 'Trades'], ['sales', 'Sales'], ['buyers', 'Buyers'], ['setup', 'Setup']].forEach(function (t) {
    var b = UI.el('button', 'trades-tab', t[1]);
    b.type = 'button';
    b.dataset.tab = t[0];
    b.setAttribute('role', 'tab');
    b.addEventListener('click', function () { tradeTab = t[0]; renderTrades(); });
    tabs.appendChild(b);
  });
  root.appendChild(tabs);
  var body = UI.el('div', 'trades-body');
  body.id = 'trades-body';
  root.appendChild(body);
  var container = document.querySelector('.container');
  container.insertBefore(root, container.firstChild);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) tradesClose();
  });
  renderTrades();
});
// ==== end trade helper ==============================================================
