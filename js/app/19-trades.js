/* js/app/19-trades.js — trade helper: incoming / outgoing trade cards from Client.txt, sales
   history and buyer notes. The js/app/ files are one program split by feature: they load in
   order (index.html) and share their top-level names. */
'use strict';

// ==== trade helper ================================================================
// With the helper switched on, Python tails Client.txt (trade_helper.LogTail) and calls
// window.__tradeEvent(<event>) in the overlay for whispers, players joining/leaving your
// area and "Trade accepted".
//
// GGG's rules for tools, kept by design here:
// - every in-game command is ONE button press → ONE chat command (trade_send), never on
//   a timer, never from a log event, never cycling between actions (Invite and Trade are
//   separate buttons);
// - nothing is shared: sales, buyer notes, flags and hidden buyers stay on this machine;
// - "Ignore in game" sends /ignore once, only when pressed. Hiding a buyer only hides
//   their popups here.
// Two windows, both on this file:
// - index.html?cards=1  the overlay: frameless, see-through, never takes focus from the game
//   (like PoE Lurker). Cards only, click-only (typing would go to the game).
// - index.html?trades=1 the Trade helper window: Sales, Buyers and Setup, normal focus.
// - index.html?ovicon=1 the PoB icon over the game (status, trade count): its own window, so
//   it and the cards can be dragged to different places (e.g. cards above the XP bar).
var TRADE_CARDS = /[?&]cards=1(&|$)/.test(location.search);
var TRADE_ICON = /[?&]ovicon=1(&|$)/.test(location.search);
var TRADE_OVERLAY = TRADE_CARDS || TRADE_ICON;
var TRADES = TRADE_OVERLAY || /[?&]trades=1(&|$)/.test(location.search);
if (TRADES) document.body.classList.add('trades');
if (TRADE_OVERLAY) document.body.classList.add('trade-cards');

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
var tradeTab = TRADE_CARDS ? 'trades' : 'sales';
var tradeStatus = null;      // last trade_status() answer
var tradeRates = {};         // league -> { div: chaos per divine, at }
var tradeAudio = null;

function tradePrefs() {
  var p;
  try { p = JSON.parse(localStorage.getItem(TRADE_PREFS_KEY)) || {}; } catch (e) { p = {}; }
  // overlay + sound customisation (Setup → Overlay / Sound)
  if (p.sound === undefined || p.sound === true) p.sound = 'chime';
  if (p.sound === false) p.sound = 'off';
  if (p.volume === undefined) p.volume = 40;
  if (p.opacity === undefined) p.opacity = 92;
  if (!p.scale) p.scale = 100;
  if (!p.iconMode) p.iconMode = 'always';  // 'always' | 'trades': only while there are trades
  if (p.autoOpen === undefined) p.autoOpen = true;
  if (!p.cardLayout) p.cardLayout = 'stack';   // 'stack' (vertical) | 'row' (side by side)
  if (!Array.isArray(p.customButtons)) p.customButtons = []; // [{ label, text, when: new|here|always|buying }]
  if (!p.noShowMin) p.noShowMin = 5;
  p.msgs = Object.assign({}, TRADE_MSGS, p.msgs || {});
  return p;
}
function saveTradePrefs(p) { saveShared(TRADE_PREFS_KEY, JSON.stringify(p)); }
// Trade helper window → overlay: save durably first, then tell the overlay to re-read
function saveShared(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* fine */ }
  if (!isGui() || !window.pywebview.api.storage_set) return;
  window.pywebview.api.storage_set(key, value).then(function () {
    if (!TRADE_CARDS && window.pywebview.api.trade_prefs_changed) window.pywebview.api.trade_prefs_changed();
  }, function () {});
}
function loadSales() {
  try { return JSON.parse(localStorage.getItem(SALES_KEY)) || []; } catch (e) { return []; }
}
function saveSales(list) { persist(SALES_KEY, JSON.stringify(list.slice(-SALES_MAX))); }
function loadBuyers() {
  try { return JSON.parse(localStorage.getItem(BUYERS_KEY)) || {}; } catch (e) { return {}; }
}
function saveBuyers(b) { saveShared(BUYERS_KEY, JSON.stringify(b)); }

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
  if (!TRADE_CARDS || !ev) return false;
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
        var autoOpen = tradePrefs().autoOpen;
        if (dir === 'in' && !card.hidden) { tradeChime('new'); if (autoOpen) overlayOpen = true; }
        if (dir === 'out' && autoOpen) overlayOpen = true;
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
  } else if (ev.type === 'zone') {
    // zone notes: display only, from "You have entered <area>." in the log
    var note = tradePrefs().zoneNotes === false ? null : zoneNoteFor(ev.area);
    zoneNote = note ? { area: ev.area, text: note } : null;
  } else {
    return;
  }
  renderTrades();
}

// ---- zone notes (Trade helper → Setup): your notes per area, shown when you enter it ------
var ZONE_NOTES_KEY = 'pobtf-zone-notes';
var zoneNote = null; // { area, text } for the area you're in, until dismissed or you leave
// starters: only facts that don't change between leagues; edit or delete them freely
var ZONE_NOTE_STARTERS = {
  'The Lower Prison': 'Trial of Ascendancy here (normal Labyrinth).',
  'The Crypt Level 1': 'Trial of Ascendancy here (normal Labyrinth).',
  'The Chamber of Sins Level 2': 'Trial of Ascendancy here (normal Labyrinth).',
  'The Crematorium': 'Trial of Ascendancy here (normal Labyrinth).',
  'The Catacombs': 'Trial of Ascendancy here (normal Labyrinth).',
  'The Imperial Gardens': 'Trial of Ascendancy here (normal Labyrinth).'
};
function loadZoneNotes() {
  var raw = null;
  try { raw = localStorage.getItem(ZONE_NOTES_KEY); } catch (e) { /* fine */ }
  if (raw === null) return Object.assign({}, ZONE_NOTE_STARTERS);
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}
function saveZoneNotes(n) { saveShared(ZONE_NOTES_KEY, JSON.stringify(n)); }
function zoneNoteFor(area) {
  var notes = loadZoneNotes(), a = String(area || '').toLowerCase();
  var key = Object.keys(notes).filter(function (k) { return k.toLowerCase() === a; })[0];
  return key ? notes[key] : null;
}
var tradeStatusFlags = { afk: false, dnd: false };

// Sounds (Setup → Sound): a style, a volume slider, or off. Synthesised, so no files ship.
// Each style: [new trade notes, buyer arrived notes, wave, note length s, gap s]
var TRADE_SOUNDS = {
  chime: { label: 'Chime', fresh: [784, 1175, 1568], joined: [660, 990], wave: 'triangle', len: 0.3, gap: 0.1 },
  bell: { label: 'Bell', fresh: [1047, 1568], joined: [880], wave: 'sine', len: 0.9, gap: 0.16 },
  soft: { label: 'Soft', fresh: [523, 659], joined: [440], wave: 'sine', len: 0.45, gap: 0.14 },
  ping: { label: 'Ping', fresh: [1760], joined: [1320], wave: 'square', len: 0.12, gap: 0.08 },
  coins: { label: 'Coins', fresh: [2093, 2637, 2093, 2637], joined: [1568, 2093], wave: 'triangle', len: 0.09, gap: 0.07 }
};
function tradeChime(kind, override) {
  var p = Object.assign(tradePrefs(), override || {});
  var snd = TRADE_SOUNDS[p.sound];
  var vol = Math.max(0, Math.min(100, parseInt(p.volume, 10) || 0)) / 100;
  if (!snd || !vol) return;
  try {
    if (!tradeAudio) tradeAudio = new (window.AudioContext || window.webkitAudioContext)();
    var t = tradeAudio.currentTime;
    var peak = Math.max(0.001, vol * vol); // perceived loudness: the slider feels even
    (kind === 'joined' ? snd.joined : snd.fresh).forEach(function (f, i) {
      var o = tradeAudio.createOscillator(), g = tradeAudio.createGain();
      var at = t + i * snd.gap;
      o.type = snd.wave;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + snd.len);
      o.connect(g); g.connect(tradeAudio.destination);
      o.start(at); o.stop(at + snd.len + 0.05);
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
    customButtonsFor(p, card.joined ? 'here' : 'new').forEach(function (b) {
      act(b.label, 'whisper', fillMsg(b.text, card), null, 'Your button. Whisper: ' + fillMsg(b.text, card));
    });
    if (t.left && isGui() && window.pywebview.api.trade_highlight) {
      acts.appendChild(UI.button('ghost', { size: 'sm', label: '▣ Show in stash',
        title: 'Outline the item\'s cell over your open stash tab for 20 seconds',
        onClick: function () { window.pywebview.api.trade_highlight(t.left, t.top, t.tab || ''); } }));
    }
    // inline, not a pop-up menu: the overlay window is only as big as its content
    acts.appendChild(UI.iconButton('⋯', 'More for ' + card.name, { size: 'sm', cls: card.more ? 'is-on' : '',
      onClick: function () { card.more = !card.more; card.ignoreArmed = false; renderTrades(); } }));
  } else {
    act('Visit hideout', 'hideout', null, 'primary', 'Send /hideout ' + card.name);
    act('Trade', 'trade', null, null, 'Send /tradewith ' + card.name);
    act('Re-whisper', 'whisper', card.text, null, 'Send your original whisper again');
    customButtonsFor(p, 'buying').forEach(function (b) {
      act(b.label, 'whisper', fillMsg(b.text, card), null, 'Your button. Whisper: ' + fillMsg(b.text, card));
    });
  }
  el.appendChild(acts);
  if (card.dir === 'in' && card.more) el.appendChild(renderMoreRow(card));

  if (card.dir === 'in') el.appendChild(renderOutcomes(card, p));
  return el;
}

// your own whisper buttons (Setup → Your buttons): new = before the buyer arrives, here = once
// they're in your hideout, always = both, buying = on cards for whispers you sent
function customButtonsFor(p, stage) {
  return (p.customButtons || []).filter(function (b) {
    return b.label && b.text && (b.when === stage || (b.when === 'always' && stage !== 'buying'));
  });
}

function renderMoreRow(card) {
  var row = UI.el('div', 'tc-more');
  var flagged = (buyerFor(card) || {}).flag;
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Whois', title: 'Send /whois ' + card.name,
    onClick: function () { tradeSend(card, 'whois'); } }));
  row.appendChild(UI.button('ghost', { size: 'sm', label: flagged ? 'Unflag' : '⚑ Flag', onClick: function () {
    updateBuyer(card, function (b) { b.flag = !b.flag; }); renderTrades(); } }));
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Hide buyer',
    title: 'No more popups or sounds from them here; their whispers go to the Hidden list',
    onClick: function () { hideBuyer(card); } }));
  // two clicks, no dialog: the first arms it, the second sends /ignore once
  var ig = UI.button(card.ignoreArmed ? 'danger' : 'ghost', { size: 'sm',
    label: card.ignoreArmed ? 'Click again: /ignore ' + card.name : 'Ignore in game',
    title: 'Sends /ignore ' + card.name + ' once. Undo in game with /unignore.',
    onClick: function () {
      if (!card.ignoreArmed) { card.ignoreArmed = true; renderTrades(); return; }
      card.ignoreArmed = false;
      tradeSend(card, 'ignore', null, ig);
    } });
  row.appendChild(ig);
  return row;
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
  // click-only (the overlay never takes the keyboard from the game): Completed records the
  // listed price; a different price or a note is edited later in Trade helper → Sales
  var done = UI.button(card.acceptHint ? 'primary' : 'secondary', { size: 'sm',
    label: '✓ Completed' + (t.price != null ? ' · ' + priceText(t.price, t.currency) : ''),
    title: (card.acceptHint ? 'The game logged "Trade accepted". ' : '') +
      'Records the sale at the listed price. Got a different price? Edit it in Trade helper → Sales.',
    onClick: function () { recordOutcome(card, 'completed'); } });
  if (card.acceptHint) done.classList.add('suggested');
  var more = UI.el('div', 'tc-other');
  more.appendChild(done);
  more.appendChild(UI.button('ghost', { size: 'sm', label: '✗ Not completed', onClick: function () { recordOutcome(card, 'not_completed'); } }));
  more.appendChild(UI.button('ghost', { size: 'sm', label: '⌛ Time wasted', onClick: function () { recordOutcome(card, 'wasted'); } }));
  more.appendChild(UI.button('ghost', { size: 'sm', label: 'Other', title: 'Add a note in Trade helper → Sales',
    onClick: function () { recordOutcome(card, 'other'); } }));
  box.appendChild(more);
  return box;
}

async function hideBuyer(card) {
  updateBuyer(card, function (b) { b.hidden = true; });
  tradeCards.forEach(function (c) { if (c.dir === 'in' && buyerKey(c) === buyerKey(card)) c.hidden = true; });
  UI.toast(card.name + ' is hidden here. Buyers tab to undo.', 'info');
  renderTrades();
}
// Buyers page (Trade helper window, which can show a dialog)
async function ignoreInGame(card) {
  var ok = await UI.dialog({ title: 'Ignore ' + card.name + ' in game?',
    body: 'Sends /ignore ' + card.name + ' to Path of Exile once. Undo in game with /unignore.', confirmLabel: 'Send /ignore' });
  if (ok) tradeSend(card, 'ignore');
}

function renderTrades() {
  var root = document.getElementById('trades-root');
  if (!root) return;
  if (ovDrag) { setTimeout(renderTrades, 300); return; } // never rebuild the grip mid-drag
  if (TRADE_CARDS) { renderCardsOverlay(root); return; }
  if (TRADE_ICON) { renderIconOverlay(root); return; }
  root.querySelectorAll('.trades-tab').forEach(function (b) {
    b.setAttribute('aria-selected', b.dataset.tab === tradeTab ? 'true' : 'false');
  });
  var body = document.getElementById('trades-body');
  body.textContent = '';
  if (tradeTab === 'sales') renderSalesPage(body);
  else if (tradeTab === 'buyers') renderBuyersPage(body);
  else renderTradeSetup(body);
  renderTradeStatusLine();
}

// ---- in-game overlays: two windows, each dragged to its own spot ------------------------
// icon: the PoB button (status dot + open-trade count) — click shows/hides the cards;
// cards: the trade cards. gui.py keeps each where it was dropped, relative to the game.
var overlayOpen = false;     // cards window: cards showing
var overlayWanted = null;    // last value sent to overlay_visible()
var overlayState = {};       // overlay_status(): hotkeys, log reader
var iconCount = 0, iconHover = false;

function overlayLook(root, p) {
  root.style.setProperty('--ov-opacity', String(Math.max(30, Math.min(100, p.opacity)) / 100));
  root.style.zoom = String((p.scale || 100) / 100);
}
// Drag: the grip reports how far the mouse moved and gui.py moves the window (pywebview's own
// drag region leaves a white patch on see-through windows). Re-renders wait until it's dropped.
var ovDrag = null;
function overlayGrip(p, what) {
  if (p.locked) return null; // 📌 Lock in Setup pins it where it is
  var name = TRADE_ICON ? 'icon' : 'cards';
  var grip = UI.el('span', 'ov-grip', '⠿');
  grip.title = 'Drag to move ' + what + ' (lock it in Trade helper → Setup)';
  var pending = null, sending = false;
  function send() {
    if (sending || !pending) return;
    sending = true;
    var d = pending;
    pending = null;
    Promise.resolve(window.pywebview.api.overlay_drag(name, 'move', d[0], d[1])).then(function () {
      sending = false; send();
    }, function () { sending = false; });
  }
  grip.addEventListener('pointerdown', function (e) {
    if (!isGui() || !window.pywebview.api.overlay_drag) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    ovDrag = { x: e.screenX, y: e.screenY };
    grip.classList.add('is-dragging');
    window.pywebview.api.overlay_drag(name, 'start', 0, 0);
  });
  grip.addEventListener('pointermove', function (e) {
    if (!ovDrag) return;
    pending = [e.screenX - ovDrag.x, e.screenY - ovDrag.y];
    send();
  });
  function drop(e) {
    if (!ovDrag) return;
    var dx = e.screenX - ovDrag.x, dy = e.screenY - ovDrag.y;
    ovDrag = null;
    pending = null;
    window.pywebview.api.overlay_drag(name, 'end', dx, dy);
    renderTrades();
  }
  grip.addEventListener('pointerup', drop);
  grip.addEventListener('pointercancel', drop);
  return grip;
}
function reportOverlay(name, wanted, count) {
  if (!isGui() || !window.pywebview.api.overlay_visible) return;
  var key = name + ':' + wanted + ':' + count;
  if (overlayWanted === key) return;
  overlayWanted = key;
  window.pywebview.api.overlay_visible(name, wanted, count == null ? null : count);
}

function renderIconOverlay(root) {
  root.textContent = '';
  var p = tradePrefs();
  overlayLook(root, p);
  // "only when there are trades": no icon until a whisper arrives
  reportOverlay('icon', p.iconMode !== 'trades' || iconCount > 0);
  var bar = UI.el('div', 'ov-bar');
  var hk = overlayState.hotkeys || {};
  var running = !!(hk.price || overlayState.logWatching);
  var icon = UI.el('button', 'ov-icon' + (running ? ' is-running' : ''));
  icon.type = 'button';
  icon.title = 'PoB Trade Finder is running' +
    (hk.price ? '\n• ' + hk.price + ': price the item under your cursor' : '') +
    (hk.app ? '\n• ' + hk.app + ': open the app over the game' : '') +
    (hk.trades ? '\n• ' + hk.trades + ': show / hide trade cards' : '') +
    (overlayState.logWatching ? '\n• Trade helper: reading the chat log' : '\n• Trade helper: off') +
    '\nClick: show / hide trade cards';
  icon.appendChild(UI.el('span', 'ov-logo', 'PoB'));
  icon.appendChild(UI.el('span', 'ov-dot'));
  if (iconCount) icon.appendChild(UI.el('span', 'ov-count', String(iconCount)));
  icon.addEventListener('click', function () { window.pywebview.api.overlay_toggle_cards(); });
  bar.appendChild(icon);
  var grip = overlayGrip(p, 'the icon');
  if (grip) bar.appendChild(grip);
  if (iconHover) { // extra buttons only while the mouse is over it: out of the way otherwise
    bar.appendChild(UI.iconButton('⚙', 'Settings (app over the game)', { size: 'sm',
      onClick: function () { window.pywebview.api.open_main(true); } }));
    bar.appendChild(UI.iconButton('⌂', 'Open PoB Trade Finder', { size: 'sm',
      onClick: function () { window.pywebview.api.open_main(false); } }));
    bar.appendChild(UI.iconButton('$', 'Trade helper: sales, buyers, setup', { size: 'sm',
      onClick: function () { window.pywebview.api.trades_show(); } }));
  }
  root.appendChild(bar);
  fitOverlay('icon');
}

function renderCardsOverlay(root) {
  root.textContent = '';
  var p = tradePrefs();
  overlayLook(root, p);
  var shown = tradeCards.filter(function (c) { return !c.hidden; });
  var showing = overlayOpen && (shown.length > 0 || tradeCards.length > 0 || overlayOpenedByHand);
  reportOverlay('cards', showing || !!zoneNote, shown.length);
  if (zoneNote) {
    var zn = UI.el('div', 'ov-zone');
    zn.appendChild(UI.el('b', 'ov-zone-area', zoneNote.area));
    zn.appendChild(UI.el('span', 'ov-zone-text', zoneNote.text));
    zn.appendChild(UI.iconButton('✕', 'Hide this zone note', { size: 'sm', onClick: function () { zoneNote = null; renderTrades(); } }));
    root.appendChild(zn);
  }
  if (!showing) { fitOverlay('cards'); return; }
  var head = UI.el('div', 'ov-head');
  head.appendChild(UI.el('span', 'ov-head-title', 'Trades' + (shown.length ? ' (' + shown.length + ')' : '')));
  var grip = overlayGrip(p, 'the trade cards');
  if (grip) head.appendChild(grip);
  head.appendChild(UI.iconButton('–', 'Hide the trade cards (the icon or ' + ((overlayState.hotkeys || {}).trades || 'its hotkey') +
    ' brings them back)', { size: 'sm', onClick: function () { overlayOpen = false; overlayOpenedByHand = false; renderTrades(); } }));
  root.appendChild(head);
  var list = UI.el('div', 'ov-cards' + (p.cardLayout === 'row' ? ' is-row' : ''));
  if (!p.enabled && !shown.length) {
    list.appendChild(UI.el('div', 'ov-note', 'Trade helper is off. Trade helper → Setup to switch it on.'));
  } else if (!shown.length) {
    list.appendChild(UI.el('div', 'ov-note', 'No trades right now.'));
  }
  shown.forEach(function (c) { list.appendChild(renderTradeCard(c)); });
  renderHiddenList(list);
  root.appendChild(list);
  fitOverlay('cards');
}
var overlayOpenedByHand = false;

// icon click / trade cards hotkey (via gui.py)
window.__ovToggle = function () {
  if (!TRADE_CARDS) return false;
  overlayOpen = !overlayOpen;
  overlayOpenedByHand = overlayOpen;
  renderTrades();
  return overlayOpen;
};
// the cards window reports how many trades are open (via gui.py)
window.__ovCount = function (n, cardsShowing) {
  if (!TRADE_ICON) return false;
  iconCount = n;
  renderTrades();
  return true;
};

function fitOverlay(name) {
  if (!isGui() || !window.pywebview.api.overlay_fit) return;
  requestAnimationFrame(function () {
    var root = document.getElementById('trades-root');
    if (!root) return;
    var r = root.getBoundingClientRect();
    window.pywebview.api.overlay_fit(name, Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
  });
}

async function refreshOverlayStatus() {
  if (!isGui() || !window.pywebview.api.overlay_status) return;
  try {
    var st = await window.pywebview.api.overlay_status();
    if (st && st.ok && JSON.stringify(st) !== JSON.stringify(overlayState)) { overlayState = st; renderTrades(); }
  } catch (e) { /* bridge gone */ }
}

// the Trade helper window changed a setting: re-read it here
window.__tradePrefsChanged = async function () {
  if (!TRADE_OVERLAY) return false;
  if (tradeHydrate) { try { await tradeHydrate(); } catch (e) { /* keep */ } }
  tradeCards.forEach(function (c) { var b = c.dir === 'in' ? buyerFor(c) : null; c.hidden = !!(b && b.hidden); });
  overlayWanted = null;
  refreshOverlayStatus();
  renderTrades();
  return true;
};

function renderHiddenList(body) {
  var hidden = tradeCards.filter(function (c) { return c.hidden; });
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
    var d = UI.disclosure('Hidden (' + hidden.length + ')', box);
    d.addEventListener('toggle', function () { fitOverlay('cards'); });
    body.appendChild(d);
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
    { key: 'outcome', label: 'Outcome', render: function (s) { return OUTCOME_LABEL[s.outcome] || s.outcome; } },
    { key: 'note', label: 'Note' },
    { key: 'edit', label: '', render: function (s) {
      return UI.button('ghost', { size: 'sm', label: 'Edit', title: 'Change the price, outcome or note',
        onClick: function () { editSale(s.id); } });
    } }
  ], list.slice().reverse(), { sortable: true, emptyText: 'Nothing recorded yet. Mark a trade ✓ Completed to see it here.' }));
}

async function editSale(id) {
  var list = loadSales();
  var s = list.filter(function (x) { return x.id === id; })[0];
  if (!s) return;
  var box = UI.el('div', 'sale-edit');
  var price = UI.input({ type: 'number', value: s.price != null ? s.price : '', min: 0, step: 'any', width: '90px', ariaLabel: 'Price' });
  var cur = UI.select([['chaos', 'chaos'], ['divine', 'divine']].concat(
    s.currency && s.currency !== 'chaos' && s.currency !== 'divine' ? [[s.currency, s.currency]] : []), s.currency || 'chaos',
    { ariaLabel: 'Currency' });
  var out = UI.select(Object.keys(OUTCOME_LABEL).map(function (k) { return [k, OUTCOME_LABEL[k]]; }), s.outcome,
    { ariaLabel: 'Outcome' });
  var note = UI.input({ value: s.note || '', width: '100%', placeholder: 'Note', ariaLabel: 'Note' });
  UI.field('Price', price, { parent: box });
  UI.field('Currency', cur, { parent: box });
  UI.field('Outcome', out, { parent: box });
  UI.field('Note', note, { parent: box, cls: 'field-wide' });
  if (!(await UI.dialog({ title: 'Edit: ' + (s.item || 'sale'), body: box, confirmLabel: 'Save' }))) return;
  var p = parseFloat(price.value);
  s.price = isNaN(p) ? null : p;
  s.currency = cur.value;
  s.outcome = out.value;
  s.note = note.value.trim();
  var v = tradeValue(s.price, s.currency, await tradeDivRate(s.league));
  s.chaos = v.chaos != null ? Math.round(v.chaos * 100) / 100 : null;
  s.div = v.div != null ? Math.round(v.div * 1000) / 1000 : null;
  saveSales(list);
  renderTrades();
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

  function setPref(k, v) { var q = tradePrefs(); q[k] = v; saveTradePrefs(q); }
  function toggle(label, on, onChange) {
    var w = UI.el('label', 'toggle');
    var c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!on;
    c.addEventListener('change', function () { onChange(c.checked); });
    w.appendChild(c);
    w.appendChild(UI.el('span', null, label));
    return w;
  }
  // a range slider with its value shown next to it
  function slider(label, value, min, max, step, unit, onInput, parent) {
    var r = UI.input({ type: 'range', min: min, max: max, step: step, value: value, ariaLabel: label, cls: 'trade-slider' });
    var v = UI.el('span', 'slider-val', value + unit);
    r.addEventListener('input', function () { v.textContent = r.value + unit; });
    r.addEventListener('change', function () { onInput(parseInt(r.value, 10)); });
    var f = UI.field(label, r, { parent: parent });
    f.appendChild(v);
    return r;
  }

  // Sound: style, volume slider (0 = silent), test
  sec.appendChild(UI.el('h3', 'trade-h3', 'Sound'));
  var soundRow = UI.el('div', 'trade-row');
  var soundSel = UI.select([['off', 'Off']].concat(Object.keys(TRADE_SOUNDS).map(function (k) { return [k, TRADE_SOUNDS[k].label]; })),
    p.sound, { ariaLabel: 'Sound', onChange: function () { setPref('sound', this.value); tradeChime('new', { sound: this.value }); } });
  UI.field('Sound', soundSel, { parent: soundRow });
  var volRange = slider('Volume', p.volume, 0, 100, 5, '%', function (v) { setPref('volume', v); tradeChime('new', { volume: v }); }, soundRow);
  soundRow.appendChild(UI.button('ghost', { size: 'sm', label: '▶ Test', onClick: function () {
    tradeChime('new', { sound: soundSel.value, volume: parseInt(volRange.value, 10) });
    setTimeout(function () { tradeChime('joined', { sound: soundSel.value, volume: parseInt(volRange.value, 10) }); }, 900);
  } }));
  sec.appendChild(soundRow);
  sec.appendChild(UI.el('p', 'finder-sub', 'Plays for a new trade whisper, and a shorter one when the buyer enters your area. ' +
    'Hidden buyers never make a sound.'));

  // Overlay over the game (Awakened Trade / Lurker style)
  sec.appendChild(UI.el('h3', 'trade-h3', 'Overlay in game'));
  sec.appendChild(toggle('Show the PoB icon over the game while it\'s focused', p.icon !== false,
    function (v) { setPref('icon', v); }));
  var ovRow = UI.el('div', 'trade-row');
  UI.field('Show it', UI.select([['always', 'Always'], ['trades', 'Only when there are trades']], p.iconMode,
    { onChange: function () { setPref('iconMode', this.value); } }), { parent: ovRow });
  UI.field('Trade cards', UI.select([['stack', 'Stacked (vertical)'], ['row', 'Side by side (horizontal)']], p.cardLayout,
    { onChange: function () { setPref('cardLayout', this.value); } }), { parent: ovRow });
  UI.field('Size', UI.select([['85', 'Small'], ['100', 'Normal'], ['120', 'Large']], String(p.scale),
    { onChange: function () { setPref('scale', parseInt(this.value, 10)); } }), { parent: ovRow });
  slider('Opacity', p.opacity, 30, 100, 5, '%', function (v) { setPref('opacity', v); }, ovRow);
  sec.appendChild(ovRow);
  sec.appendChild(toggle('Open the cards when a trade arrives (off: the icon just counts them)', p.autoOpen,
    function (v) { setPref('autoOpen', v); }));
  var posRow = UI.el('div', 'trade-row');
  posRow.appendChild(toggle('📌 Lock position', p.locked, function (v) { setPref('locked', v); }));
  posRow.appendChild(UI.button('ghost', { size: 'sm', label: 'Reset position', title: 'Back to the top of the game window',
    onClick: function () { window.pywebview.api.overlay_reset_pos(); UI.toast('The overlay moves back next time the game is focused.', 'success'); } }));
  sec.appendChild(posRow);
  sec.appendChild(UI.el('p', 'finder-sub', 'The icon and the trade cards are separate: drag the ⠿ grip on each to put ' +
    'them anywhere, e.g. the cards just above your XP bar. Each stays where you put it, relative to the game window; ' +
    'cards placed in the lower half stack upwards. They\'re see-through at the opacity above and solid while your ' +
    'mouse is over them. Path of Exile must run in Windowed or Windowed Fullscreen for any overlay to show.'));

  sec.appendChild(UI.el('h3', 'trade-h3', 'Trades'));
  var ns = UI.select([['3', '3 min'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min']], String(p.noShowMin), {
    onChange: function () { var q = tradePrefs(); q.noShowMin = parseInt(this.value, 10); saveTradePrefs(q); } });
  UI.field('Offer "no-show" after', ns, { parent: sec });

  sec.appendChild(UI.el('h3', 'trade-h3', 'Zone notes'));
  sec.appendChild(toggle('Show my note for an area when I enter it (from the chat log; display only)',
    p.zoneNotes !== false, function (v) { setPref('zoneNotes', v); }));
  var zl = UI.el('div', 'zone-notes');
  function drawZones() {
    zl.textContent = '';
    var notes = loadZoneNotes();
    Object.keys(notes).sort().forEach(function (area) {
      var row = UI.el('div', 'zone-row');
      row.appendChild(UI.el('b', 'zone-area', area));
      var inp = UI.input({ value: notes[area], width: '100%', ariaLabel: 'Note for ' + area });
      inp.addEventListener('change', function () { var n = loadZoneNotes(); n[area] = inp.value; saveZoneNotes(n); });
      row.appendChild(inp);
      row.appendChild(UI.iconButton('✕', 'Delete the note for ' + area, { size: 'sm', onClick: function () {
        var n = loadZoneNotes(); delete n[area]; saveZoneNotes(n); drawZones();
      } }));
      zl.appendChild(row);
    });
    var add = UI.el('div', 'zone-row');
    var an = UI.input({ placeholder: 'Area, e.g. The Ledge', width: '200px', ariaLabel: 'New zone note area' });
    var at = UI.input({ placeholder: 'Your note', width: '100%', ariaLabel: 'New zone note text' });
    add.appendChild(an);
    add.appendChild(at);
    add.appendChild(UI.button('ghost', { size: 'sm', label: 'Add', onClick: function () {
      var area = an.value.trim(), text = at.value.trim();
      if (!area || !text) { UI.toast('Type the area name and a note.', 'warn'); return; }
      var n = loadZoneNotes(); n[area] = text; saveZoneNotes(n); drawZones();
    } }));
    zl.appendChild(add);
  }
  drawZones();
  sec.appendChild(zl);

  sec.appendChild(UI.el('h3', 'trade-h3', 'Your buttons'));
  sec.appendChild(UI.el('p', 'finder-sub', 'Extra buttons on trade cards. Each press whispers the buyer (or seller) ' +
    'your message once. {item} and {price} are filled in.'));
  var cbBox = UI.el('div', 'custom-buttons');
  var WHEN = [['new', 'Before they arrive'], ['here', 'Once they\'re here'], ['always', 'Always (selling)'], ['buying', 'When I\'m buying']];
  function drawCustom() {
    cbBox.textContent = '';
    var list = tradePrefs().customButtons;
    function save(l) { var q = tradePrefs(); q.customButtons = l; saveTradePrefs(q); }
    list.forEach(function (b, i) {
      var row = UI.el('div', 'zone-row');
      var lab = UI.input({ value: b.label, width: '120px', ariaLabel: 'Button label' });
      var txt = UI.input({ value: b.text, width: '100%', ariaLabel: 'Button message' });
      var when = UI.select(WHEN, b.when || 'always', { ariaLabel: 'When the button shows' });
      function upd() { var l = tradePrefs().customButtons; l[i] = { label: lab.value.trim(), text: txt.value.trim(), when: when.value }; save(l); }
      lab.addEventListener('change', upd);
      txt.addEventListener('change', upd);
      when.addEventListener('change', upd);
      row.appendChild(lab);
      row.appendChild(txt);
      row.appendChild(when);
      row.appendChild(UI.iconButton('✕', 'Delete button ' + b.label, { size: 'sm', onClick: function () {
        var l = tradePrefs().customButtons; l.splice(i, 1); save(l); drawCustom();
      } }));
      cbBox.appendChild(row);
    });
    cbBox.appendChild(UI.button('ghost', { size: 'sm', label: '+ Add a button', onClick: function () {
      var l = tradePrefs().customButtons;
      l.push({ label: '1 min', text: 'one minute, finishing a map', when: 'new' });
      save(l); drawCustom();
    } }));
  }
  drawCustom();
  sec.appendChild(cbBox);

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
  if (TRADE_OVERLAY) refreshOverlayStatus();
  renderTrades();
}

// Trade helper window: show what's running without restarting the log reader
async function refreshTradeStatus() {
  if (!isGui() || !window.pywebview.api.trade_status) return;
  try { tradeStatus = await window.pywebview.api.trade_status(); } catch (e) { /* keep */ }
  renderTrades();
}

// main window: Tools → Trade helper, Settings → In game → Trade helper…, the overlay's $ button
// and the tray menu all open the Trade helper as a view here (no extra window)
var tradeViewBack = null;
function openTradesWindow() {
  if (!document.getElementById('view-trades')) {
    if (isGui() && window.pywebview.api.trades_show) window.pywebview.api.trades_show();
    return;
  }
  var cur = document.body.dataset.view;
  if (cur && cur !== 'trades') tradeViewBack = cur;
  setView('trades');
  window.scrollTo(0, 0);
}
window.__openTradeHelper = function () { openTradesWindow(); return true; };

// shown: re-read what the overlay saved (sales, buyers) and the log reader's state
async function showTradeHelperView() {
  if (!document.getElementById('trades-root')) return;
  if (window.hydrateFromBridge) { try { await window.hydrateFromBridge(); } catch (e) { /* keep */ } }
  await refreshTradeStatus();
}

function tradesClose() {
  if (TRADES) {
    if (isGui() && window.pywebview.api.trades_hide) window.pywebview.api.trades_hide();
    return;
  }
  setView(build ? (tradeViewBack || 'gear') : ''); // no build: back to the landing
}

// called from markGui() in the overlays (and a standalone ?trades=1 window)
var tradeHydrate = null;
function tradesReady(hydrate) {
  document.body.classList.add('gui');
  tradeHydrate = hydrate;
  if (TRADE_CARDS) {
    // the cards overlay owns the log reader: it is created at startup and lives as long as the app
    Promise.resolve(hydrate()).then(startTradeHelper, startTradeHelper);
    setInterval(function () { if (tradeCards.length && !ovDrag) renderTrades(); }, 30000); // ages, no-show
    setInterval(refreshOverlayStatus, 10000);
    return;
  }
  if (TRADE_ICON) {
    Promise.resolve(hydrate()).then(refreshOverlayStatus, refreshOverlayStatus);
    setInterval(refreshOverlayStatus, 5000);
    return;
  }
  Promise.resolve(hydrate()).then(refreshTradeStatus, refreshTradeStatus);
}

function mountTradeHelper(container, embedded) {
  var root = UI.el('div', 'trades-root');
  root.id = 'trades-root';
  var bar = UI.el('div', 'trades-bar');
  if (embedded) {
    bar.appendChild(UI.button('ghost', { size: 'sm', label: '← Back', onClick: tradesClose,
      title: 'Back to where you were (Esc)' }));
  }
  bar.appendChild(UI.el('span', 'ov-title', 'Trade helper'));
  var st = UI.el('span', 'trades-status');
  st.id = 'trades-status';
  bar.appendChild(st);
  if (!embedded) bar.appendChild(UI.iconButton('✕', 'Hide the trade window', { size: 'sm', onClick: tradesClose }));
  root.appendChild(bar);
  var tabs = UI.el('div', 'trades-tabs');
  tabs.setAttribute('role', 'tablist');
  [['sales', 'Sales'], ['buyers', 'Buyers'], ['setup', 'Setup']].forEach(function (t) {
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
  container.insertBefore(root, container.firstChild);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (embedded && (document.body.dataset.view !== 'trades' || document.body.classList.contains('over-game'))) return;
    tradesClose();
  });
  renderTrades();
}

document.addEventListener('DOMContentLoaded', function () {
  var opener = document.getElementById('open-trades');
  if (opener) opener.addEventListener('click', function () { closeSettings(); openTradesWindow(); });
  if (!TRADES) { // the main window: the Trade helper is one of its views
    var view = document.getElementById('view-trades');
    if (view) mountTradeHelper(view, true);
    return;
  }
  var container = document.querySelector('.container');
  if (TRADE_OVERLAY) {
    var root = UI.el('div', 'trades-root');
    root.id = 'trades-root';
    container.insertBefore(root, container.firstChild);
    if (TRADE_ICON) { // the extra buttons show only while the mouse is over the icon
      root.addEventListener('mouseenter', function () { iconHover = true; if (!ovDrag) renderTrades(); });
      root.addEventListener('mouseleave', function () { iconHover = false; if (!ovDrag) renderTrades(); });
    }
    renderTrades();
    return;
  }
  mountTradeHelper(container, false);
});
// ==== end trade helper ==============================================================
