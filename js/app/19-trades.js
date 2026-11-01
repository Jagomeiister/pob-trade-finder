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
var tradeTab = 'trades'; // Trade helper window: trades | people | reports | setup
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
  if (p.opacity === undefined) p.opacity = 95; // nearly solid: readable over bright scenes
  if (!p.scale) p.scale = 100;
  if (!p.iconMode) p.iconMode = 'always';  // 'always' | 'trades': only while there are trades
  if (p.autoOpen === undefined) p.autoOpen = true;
  if (!p.cardLayout) p.cardLayout = 'stack';   // 'stack' (vertical) | 'row' (side by side)
  if (!Array.isArray(p.customButtons)) p.customButtons = []; // [{ label, text, when: new|here|always|buying }]
  if (!p.noShowMin) p.noShowMin = 5;
  if (!p.wasterAt) p.wasterAt = 2;            // time waster after this many bad outcomes (People)
  if (p.showToday === undefined) p.showToday = true; // today's earned / spent line on the trade cards
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
// what you bought (cards for whispers you sent): same shape as a sale, with seller instead of buyer
var PURCHASES_KEY = 'pobtf-purchases';
function loadPurchases() {
  try { return JSON.parse(localStorage.getItem(PURCHASES_KEY)) || []; } catch (e) { return []; }
}
function savePurchases(list) { persist(PURCHASES_KEY, JSON.stringify(list.slice(-SALES_MAX))); }
function loadBuyers() {
  try { return JSON.parse(localStorage.getItem(BUYERS_KEY)) || {}; } catch (e) { return {}; }
}
function saveBuyers(b) { saveShared(BUYERS_KEY, JSON.stringify(b)); }

// buyers are tracked by account name when known, else by character name
// one person, several characters: Buyers → Merge links a character to another buyer
// (whispers don't carry account names, so the link is yours to make)
var BUYER_ALIASES_KEY = 'pobtf-buyer-aliases';
function loadBuyerAliases() {
  try { return JSON.parse(localStorage.getItem(BUYER_ALIASES_KEY)) || {}; } catch (e) { return {}; }
}
function buyerKey(card) {
  var k = (card.account || card.name || '').toLowerCase();
  return loadBuyerAliases()[k] || k;
}
function mergeBuyers(fromKey, intoKey) {
  if (!fromKey || !intoKey || fromKey === intoKey) return false;
  var all = loadBuyers(), a = all[fromKey], b = all[intoKey];
  if (!a || !b) return false;
  PERSON_COUNTS.forEach(function (f) { b[f] = (b[f] || 0) + (a[f] || 0); });
  b.spent = Math.round(((b.spent || 0) + (a.spent || 0)) * 100) / 100;
  b.paid = Math.round(((b.paid || 0) + (a.paid || 0)) * 100) / 100;
  b.names = (b.names || []).concat((a.names || []).filter(function (n) { return (b.names || []).indexOf(n) === -1; }));
  b.flag = b.flag || a.flag;
  b.hidden = b.hidden || a.hidden;
  b.ignored = Math.max(b.ignored || 0, a.ignored || 0) || null;
  if (a.waster != null && b.waster == null) b.waster = a.waster;
  b.note = [b.note, a.note].filter(Boolean).join(' · ');
  b.first = Math.min(b.first || Date.now(), a.first || Date.now());
  b.last = Math.max(b.last || 0, a.last || 0);
  delete all[fromKey];
  var aliases = loadBuyerAliases();
  aliases[fromKey] = intoKey;
  (a.names || []).forEach(function (n) { aliases[n.toLowerCase()] = intoKey; });
  Object.keys(aliases).forEach(function (k) { if (aliases[k] === fromKey) aliases[k] = intoKey; });
  delete aliases[intoKey];
  saveBuyers(all);
  saveShared(BUYER_ALIASES_KEY, JSON.stringify(aliases));
  return true;
}
function buyerFor(card) {
  var all = loadBuyers();
  return all[buyerKey(card)] || null;
}
// People: everyone you've traded with, by the same key, buyers and sellers alike (one player can
// be both). As a buyer: completed / spent (with you) / wasted / noShow / notCompleted / other.
// As a seller: sold (to you) / paid (by you) / noAnswer / notBought / sellerOther.
// waster: null = automatic (Setup → time waster after N), true / false = your call.
// hidden = no popups here; ignored = when you sent /ignore from this app (null after /unignore).
var PERSON_COUNTS = ['completed', 'wasted', 'noShow', 'notCompleted', 'other', 'sold', 'noAnswer', 'notBought', 'sellerOther'];
function newPerson(card) {
  return { name: card.name, account: card.account || null, names: [], completed: 0, spent: 0, wasted: 0, noShow: 0,
    notCompleted: 0, other: 0, sold: 0, paid: 0, noAnswer: 0, notBought: 0, sellerOther: 0, flag: false, hidden: false,
    ignored: null, waster: null, note: '', first: Date.now() };
}
function updateBuyer(card, fn) {
  if (card.test) return; // test mode: nothing about made-up buyers is kept
  var all = loadBuyers(), k = buyerKey(card);
  if (!k) return;
  var b = Object.assign(newPerson(card), all[k] || {});
  if (b.names.indexOf(card.name) === -1) b.names.push(card.name);
  b.name = card.name;
  b.last = Date.now();
  fn(b);
  all[k] = b;
  saveBuyers(all);
}
// bad outcomes with you, either side: time wasted, no-show, a seller who didn't answer
function wasteCount(b) { return (b.wasted || 0) + (b.noShow || 0) + (b.noAnswer || 0); }
function isTimeWaster(b) {
  if (!b) return false;
  if (b.waster === true || b.waster === false) return b.waster;
  return wasteCount(b) >= (tradePrefs().wasterAt || 2);
}
function buyerBadge(b) {
  if (!b) return null;
  var parts = [];
  if (b.completed) parts.push(b.completed + ' bought');
  if (b.wasted || b.noShow) parts.push((b.wasted + b.noShow) + ' wasted');
  var waster = isTimeWaster(b);
  if (!parts.length && !b.flag && !waster) return null;
  var tone = b.flag || waster || (b.wasted + b.noShow) > b.completed ? 'danger' : 'success';
  var c = UI.chip((b.flag ? '⚑ ' : '') + (waster ? '⌛ ' : '') + (parts.join(' · ') || (b.flag ? 'flagged' : 'time waster')),
    tone, 'buyer-badge');
  c.title = (b.flag ? 'You flagged this buyer. ' : '') + (waster ? 'Time waster. ' : '') + (b.note || '') +
    (b.spent ? ' Spent ' + fmtChaos(b.spent) + ' with you.' : '');
  return c;
}
// the same for the seller on a card for a whisper you sent: their record of selling to you
function sellerBadge(b) {
  if (!b) return null;
  var parts = [];
  if (b.sold) parts.push('sold to you ' + b.sold + '×');
  if (b.noAnswer) parts.push('didn\'t answer ' + b.noAnswer + '×');
  var waster = isTimeWaster(b);
  if (!parts.length && !b.flag && !waster) return null;
  var tone = b.flag || waster || (b.noAnswer || 0) > (b.sold || 0) ? 'danger' : 'success';
  var c = UI.chip((b.flag ? '⚑ ' : '') + (waster ? '⌛ ' : '') + (parts.join(' · ') || (b.flag ? 'flagged' : 'time waster')),
    tone, 'buyer-badge seller-badge');
  c.title = (b.flag ? 'You flagged this player. ' : '') + (waster ? 'Time waster. ' : '') + (b.note || '') +
    (b.paid ? ' You paid them ' + fmtChaos(b.paid) + ' in all.' : '');
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
  // the log reader may be running only for the cheat sheet: trades need the helper switched on
  // (test mode's made-up events always show)
  if (!ev.test && !tradePrefs().enabled) return false;
  if (ev.type === 'clear_tests') {
    tradeCards = tradeCards.filter(function (c) { return !c.test; });
    if (zoneNote && zoneNote.test) zoneNote = null;
    renderTrades();
    return true;
  }
  if (ev.test && ev.type === 'whisper') overlayOpen = true;
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
                 invitedAt: null, acceptHint: false, sent: {}, test: !!ev.test };
        var b = dir === 'in' && !ev.test ? buyerFor(card) : null;
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
    // the log doesn't say with whom: the buyer who joined most recently, else (you were buying)
    // the seller whose hideout you went to, else your latest whisper to a seller
    var cands = tradeCards.filter(function (x) { return x.dir === 'in' && x.joined; })
      .sort(function (a, b2) { return (b2.joinedAt || 0) - (a.joinedAt || 0); });
    if (!cands.length) {
      cands = tradeCards.filter(function (x) { return x.dir === 'out' && now - x.at < 60 * 60 * 1000; })
        .sort(function (a, b2) { return ((b2.sent.hideout || b2.at) - (a.sent.hideout || a.at)); });
    }
    if (!cands.length) return;
    cands[0].acceptHint = true;
  } else if (ev.type === 'afk' || ev.type === 'dnd') {
    tradeStatusFlags[ev.type] = !!ev.on;
  } else if (ev.type === 'zone') {
    // zone notes: display only, from "You have entered <area>." in the log
    var note = tradePrefs().zoneNotes === false ? null : zoneNoteFor(ev.area);
    zoneNote = note ? { area: ev.area, text: note, test: !!ev.test } : null;
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
  var vol = Math.max(0, Math.min(100, parseInt(p.volume, 10) || 0)) / 100;
  if (p.sound === 'custom') { playCustomSound(kind, p, vol); return; }
  var snd = TRADE_SOUNDS[p.sound];
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

// your own sound files (Setup → Sound → Your own): copied into data/sounds/ by pick_sound;
// "buyer arrived" falls back to the new-trade sound when you only picked one
var customAudio = {};
function playCustomSound(kind, p, vol) {
  var files = p.customSound || {};
  var file = files[kind] || files.new;
  if (!file || !vol) return;
  try {
    var a = customAudio[file] = customAudio[file] || new Audio(file);
    a.volume = Math.min(1, vol);
    a.currentTime = 0;
    var pr = a.play();
    if (pr && pr.catch) pr.catch(function () { /* missing or unplayable file: stay quiet */ });
  } catch (e) { /* no sound */ }
}

// ---- one press = one chat command --------------------------------------------------
async function tradeSend(card, action, text, btn) {
  if (card.test) { // test mode: show what would happen, send nothing to the game
    UI.toast('Test card: nothing sent (would send ' + action + (text ? ': "' + text + '"' : '') + ')', 'info');
    card.sent[action + (text ? ':' + text : '')] = Date.now();
    if (action === 'invite') card.invitedAt = card.invitedAt || Date.now();
    renderTrades();
    return true;
  }
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
  // People → Blocked lists who you ignored through the app (the game's own list can't be read)
  if (action === 'ignore') updateBuyer(card, function (b) { b.ignored = Date.now(); });
  if (action === 'unignore') updateBuyer(card, function (b) { b.ignored = null; });
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
  if (card.test) { UI.toast('Test card closed: not saved to your sales', 'info'); closeCard(card); return; }
  var t = card.trade || {};
  var league = t.league || document.getElementById('league').value;
  var price = opts.price != null ? opts.price : t.price;
  var currency = opts.currency || t.currency;
  var div = await tradeDivRate(league);
  var v = tradeValue(price, currency, div);
  var id = Date.now() + '-' + card.id;
  var entry = { id: id, time: Date.now(), outcome: outcome, league: league, bulk: t.kind === 'bulk' || undefined,
    item: t.item || '', count: t.count || null, price: price, currency: currency || null,
    chaos: v.chaos != null ? Math.round(v.chaos * 100) / 100 : null,
    div: v.div != null ? Math.round(v.div * 1000) / 1000 : null,
    account: card.account || null, tab: t.tab || null, left: t.left || null, top: t.top || null, note: opts.note || '' };
  if (card.dir === 'in') {
    entry.buyer = card.name;
    var list = loadSales();
    list.push(entry);
    saveSales(list);
    updateBuyer(card, function (b) {
      if (outcome === 'completed') { b.completed++; b.spent = Math.round(((b.spent || 0) + (v.chaos || 0)) * 100) / 100; }
      else if (outcome === 'wasted') b.wasted++;
      else if (outcome === 'no_show') b.noShow++;
      else if (outcome === 'not_completed') b.notCompleted++;
      else b.other++;
    });
  } else {
    entry.seller = card.name;
    var bought = loadPurchases();
    bought.push(entry);
    savePurchases(bought);
    updateBuyer(card, function (b) {
      if (outcome === 'bought') { b.sold++; b.paid = Math.round(((b.paid || 0) + (v.chaos || 0)) * 100) / 100; }
      else if (outcome === 'no_answer') b.noAnswer++;
      else if (outcome === 'not_bought') b.notBought++;
      else b.sellerOther++;
    });
  }
  closeCard(card);
  // after the card is gone: what the goods were worth at the time (bulk trades), and whether a
  // sale went well under the market (Reports). Looked up once, saved on the entry.
  if (outcome === 'completed' || outcome === 'bought') ledgerEnrich(card.dir === 'in' ? 'sold' : 'bought', id);
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

// one status per card, in words, with the matching colour on the card's edge (never colour alone)
function tradeCardStatus(card) {
  if (card.dir === 'out') {
    if (card.acceptHint) return ['Trade accepted', 'success'];
    return card.sent.hideout ? ['Going to their hideout', 'info'] : ['You whispered', 'neutral'];
  }
  if (card.left) return ['Left', 'neutral'];
  if (card.acceptHint) return ['Trade accepted', 'success'];
  if (card.joined) return ['In your hideout', 'success'];
  if (card.invitedAt) return ['Invited', 'warn'];
  return ['Waiting', 'neutral'];
}

function renderTradeCard(card) {
  var p = tradePrefs();
  var t = card.trade || {};
  var status = tradeCardStatus(card);
  var el = UI.el('div', 'trade-card ' + card.dir + (card.joined ? ' joined' : '') + (card.acceptHint ? ' accepted' : ''));
  el.dataset.id = card.id;
  el.dataset.status = status[1];
  // line 1: who + age + dismiss (never wraps: a long name is cut short)
  var head = UI.el('div', 'tc-head');
  head.appendChild(UI.el('span', 'tc-dir', card.dir === 'in' ? 'Selling to' : 'Buying from'));
  var who = UI.el('b', 'tc-name', card.name);
  who.title = card.name + (card.guild ? ' <' + card.guild + '>' : '');
  head.appendChild(who);
  head.appendChild(UI.el('span', 'tc-age', tradeAge(card.at)));
  head.appendChild(UI.iconButton('✕', 'Dismiss this card', { size: 'sm', onClick: function () { closeCard(card); } }));
  el.appendChild(head);
  // line 2: where the trade is at, then anything else worth knowing about it
  var tags = UI.el('div', 'tc-tags');
  tags.appendChild(UI.chip(status[0], status[1], 'tc-status'));
  if (card.test) tags.appendChild(UI.chip('test', 'warn', 'tc-test'));
  var bb = card.test ? null : card.dir === 'in' ? buyerBadge(buyerFor(card)) : sellerBadge(buyerFor(card));
  if (bb) tags.appendChild(bb);
  if (card.repeats > 1) tags.appendChild(UI.chip('×' + card.repeats + ' whispers', 'info'));
  el.appendChild(tags);

  var what = UI.el('div', 'tc-item');
  what.appendChild(UI.el('span', 'tc-item-name', (t.count ? fmtCompact(t.count) + ' × ' : '') + (t.item || card.text)));
  if (t.item) what.appendChild(UI.el('b', 'tc-price', priceText(t.price, t.currency)));
  el.appendChild(what);
  var where = [];
  var myLeague = (document.getElementById('league') || {}).value;
  if (t.league && t.league !== myLeague) where.push(t.league); // only when it isn't your league
  if (t.tab) where.push('Tab "' + t.tab + '"' + (t.left ? ' · left ' + t.left + ', top ' + t.top : ''));
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
        title: 'Outline the item\'s cell over your open stash tab for 20 seconds. Amber = normal tab, ' +
          'blue = quad tab (the whisper doesn\'t say which, so both show when it could be either).',
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
    acts.appendChild(UI.iconButton('⋯', 'More for ' + card.name, { size: 'sm', cls: card.more ? 'is-on' : '',
      onClick: function () { card.more = !card.more; card.ignoreArmed = false; renderTrades(); } }));
  }
  el.appendChild(acts);
  if (card.more) el.appendChild(renderMoreRow(card));

  el.appendChild(card.dir === 'in' ? renderOutcomes(card, p) : renderBuyOutcomes(card));
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
  if (card.dir === 'in') {
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Hide buyer',
      title: 'No more popups or sounds from them here; their whispers go to the Hidden list',
      onClick: function () { hideBuyer(card); } }));
  }
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

// ---- the price you actually got: − / + on the card (no typing in the overlay) ---------------
// steps sized to the price, so 180c → 170c or 2 div → 1.5 div is one click
function priceStep(v, currency) {
  if (currency === 'divine') return v < 1 ? 0.1 : v < 10 ? 0.5 : 1;
  return v < 10 ? 1 : v < 100 ? 5 : 10;
}
function soldPrice(card) {
  var t = card.trade || {};
  return card.sold || { price: t.price, currency: t.currency };
}
function stepSoldPrice(card, dir) {
  var s = soldPrice(card), v = s.price || 0;
  // going down uses the step of the range below (10c - 1 = 9c, not 5c)
  var next = Math.round((v + dir * priceStep(dir < 0 ? v - 1e-9 : v, s.currency)) * 100) / 100;
  if (next <= 0) return;
  card.sold = { price: next, currency: s.currency };
  renderTrades();
}
// chaos ⇄ divines, converted at the current rate (kept as is when there's no rate)
async function swapSoldCurrency(card) {
  var s = soldPrice(card), t = card.trade || {};
  var to = s.currency === 'divine' ? 'chaos' : 'divine';
  var div = await tradeDivRate(t.league || (document.getElementById('league') || {}).value);
  var price = s.price;
  if (div && price != null) {
    price = to === 'divine' ? price / div : price * div;
    var st = priceStep(price, to);
    price = Math.round(Math.max(st, Math.round(price / st) * st) * 100) / 100;
  }
  card.sold = { price: price, currency: to };
  renderTrades();
}
function renderSoldRow(card, sold, changed) {
  var t = card.trade || {}, buying = card.dir === 'out';
  var row = UI.el('div', 'tc-sold');
  row.appendChild(UI.el('span', 'tc-sold-label', buying ? 'Paid' : 'Sold for'));
  row.appendChild(UI.iconButton('−', buying ? 'Lower the price you paid' : 'Lower the price you got', { size: 'sm',
    onClick: function () { stepSoldPrice(card, -1); } }));
  row.appendChild(UI.el('b', 'tc-sold-price', priceText(sold.price, sold.currency)));
  row.appendChild(UI.iconButton('+', buying ? 'Raise the price you paid' : 'Raise the price you got', { size: 'sm',
    onClick: function () { stepSoldPrice(card, 1); } }));
  if (sold.currency === 'chaos' || sold.currency === 'divine') {
    row.appendChild(UI.button('ghost', { size: 'sm', label: sold.currency === 'chaos' ? 'in div' : 'in c',
      title: 'Paid in ' + (sold.currency === 'chaos' ? 'divines' : 'chaos') + ' instead (converted at the current rate)',
      onClick: function () { swapSoldCurrency(card); } }));
  }
  if (changed) {
    row.appendChild(UI.el('span', 'tc-sold-listed', 'listed ' + priceText(t.price, t.currency)));
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Reset', title: 'Back to the listed price',
      onClick: function () { card.sold = null; renderTrades(); } }));
  }
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
  // price on the "Sold for" row, which starts at the listed price; a note is added later in
  // Trade helper → Trades
  var sold = soldPrice(card), changed = sold.price !== t.price || sold.currency !== t.currency;
  if (t.price != null) box.appendChild(renderSoldRow(card, sold, changed));
  var done = UI.button(card.acceptHint ? 'primary' : 'secondary', { size: 'sm',
    label: '✓ Completed' + (sold.price != null ? ' · ' + priceText(sold.price, sold.currency) : ''),
    title: (card.acceptHint ? 'The game logged "Trade accepted". ' : '') +
      'Records the sale at the "Sold for" price. A note can be added in Trade helper → Trades.',
    onClick: function () { recordOutcome(card, 'completed', changed ? { price: sold.price, currency: sold.currency } : {}); } });
  done.classList.add('tc-complete');
  if (card.acceptHint) done.classList.add('suggested');
  var more = UI.el('div', 'tc-other');
  more.appendChild(done);
  // the other outcomes: one even row of quiet buttons
  more.appendChild(UI.button('secondary', { size: 'sm', label: '✗ Not completed', onClick: function () { recordOutcome(card, 'not_completed'); } }));
  more.appendChild(UI.button('secondary', { size: 'sm', label: '⌛ Time wasted', onClick: function () { recordOutcome(card, 'wasted'); } }));
  more.appendChild(UI.button('secondary', { size: 'sm', label: 'Other', title: 'Add a note in Trade helper → Trades',
    onClick: function () { recordOutcome(card, 'other'); } }));
  box.appendChild(more);
  return box;
}

// your own whisper to a seller: what happened, click-only like the selling side. "Trade
// accepted" in the log pre-selects Bought; the Paid row starts at the listed price.
function renderBuyOutcomes(card) {
  var t = card.trade || {};
  var box = UI.el('div', 'tc-outcomes');
  var paid = soldPrice(card), changed = paid.price !== t.price || paid.currency !== t.currency;
  if (t.price != null) box.appendChild(renderSoldRow(card, paid, changed));
  var done = UI.button(card.acceptHint ? 'primary' : 'secondary', { size: 'sm',
    label: '✓ Bought' + (paid.price != null ? ' · ' + priceText(paid.price, paid.currency) : ''),
    title: (card.acceptHint ? 'The game logged "Trade accepted". ' : '') +
      'Records the purchase at the "Paid" price (Trade helper → Trades → Bought). A note can be added there.',
    onClick: function () { recordOutcome(card, 'bought', changed ? { price: paid.price, currency: paid.currency } : {}); } });
  done.classList.add('tc-complete');
  if (card.acceptHint) done.classList.add('suggested');
  var more = UI.el('div', 'tc-other');
  more.appendChild(done);
  more.appendChild(UI.button('secondary', { size: 'sm', label: '✗ Didn\'t happen', onClick: function () { recordOutcome(card, 'not_bought'); } }));
  more.appendChild(UI.button('secondary', { size: 'sm', label: '⌛ No answer', title: 'The seller never answered or invited you',
    onClick: function () { recordOutcome(card, 'no_answer'); } }));
  more.appendChild(UI.button('secondary', { size: 'sm', label: 'Other', title: 'Add a note in Trade helper → Trades',
    onClick: function () { recordOutcome(card, 'buy_other'); } }));
  box.appendChild(more);
  return box;
}

async function hideBuyer(card) {
  updateBuyer(card, function (b) { b.hidden = true; });
  tradeCards.forEach(function (c) { if (c.dir === 'in' && buyerKey(c) === buyerKey(card)) c.hidden = true; });
  UI.toast(card.name + ' is hidden here. People → Blocked to undo.', 'info');
  renderTrades();
}
// Buyers page (Trade helper window, which can show a dialog)
async function ignoreInGame(card) {
  var ok = await UI.dialog({ title: 'Ignore ' + card.name + ' in game?',
    body: 'Sends /ignore ' + card.name + ' to Path of Exile once. Undo it here (People → Blocked) or in game with /unignore.',
    confirmLabel: 'Send /ignore' });
  if (ok) tradeSend(card, 'ignore');
}
async function unignoreInGame(card) {
  var ok = await UI.dialog({ title: 'Unignore ' + card.name + ' in game?',
    body: 'Sends /unignore ' + card.name + ' to Path of Exile once.', confirmLabel: 'Send /unignore' });
  if (ok) tradeSend(card, 'unignore');
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
  if (tradeTab === 'trades') renderLedgerPage(body);
  else if (tradeTab === 'people') renderPeoplePage(body);
  else if (tradeTab === 'reports') renderReportsPage(body);
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
function overlayGrip(p, what, name, rerender) {
  if (p.locked) return null; // 📌 Lock in Setup pins it where it is
  name = name || (TRADE_ICON ? 'icon' : 'cards');
  rerender = rerender || renderTrades;
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
    rerender();
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
    (hk.sheet ? '\n• ' + hk.sheet + ': show / hide the cheat sheet' : '') +
    (overlayState.logWatching ? '\n• Reading the game log' : '\n• Trade helper: off') +
    '\nClick: show / hide trade cards';
  icon.appendChild(UI.el('span', 'ov-logo', 'PoB'));
  icon.appendChild(UI.el('span', 'ov-dot'));
  if (iconCount) icon.appendChild(UI.el('span', 'ov-count', String(iconCount)));
  icon.addEventListener('click', function () { window.pywebview.api.overlay_toggle_cards(); });
  bar.appendChild(icon);
  var grip = overlayGrip(p, 'the icon');
  if (grip) bar.appendChild(grip);
  if (iconHover) { // extra buttons only while the mouse is over it: out of the way otherwise
    // the same icons as the app's sidebar, so each one means one thing everywhere
    var api = window.pywebview.api;
    bar.appendChild(navIconButton('trades', 'Trade helper: trades, people, reports', function () { api.trades_show(); }));
    if (api.overlay_toggle_sheet) {
      bar.appendChild(navIconButton('sheets', 'Show / hide the cheat sheet' + (hk.sheet ? ' (' + hk.sheet + ')' : ''),
        function () { api.overlay_toggle_sheet(); }));
    }
    bar.appendChild(navIconButton('home', 'Open PoB Trade Finder' + (hk.app ? ' (' + hk.app + ')' : ''),
      function () { api.open_main(false); }));
    bar.appendChild(navIconButton('settings', 'Settings (app over the game)', function () { api.open_main(true); }));
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
  if (p.showToday) { var today = todayLine(); if (today) root.appendChild(today); }
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

function fitOverlay(name, rootId) {
  if (!isGui() || !window.pywebview.api.overlay_fit) return;
  requestAnimationFrame(function () {
    var root = document.getElementById(rootId || 'trades-root');
    if (!root) return;
    var r = root.getBoundingClientRect();
    window.pywebview.api.overlay_fit(name, Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
    if (window.pywebview.api.overlay_shape) window.pywebview.api.overlay_shape(name, overlayShapes(root));
  });
}

// What's actually drawn, as rounded rectangles: gui.py clips the overlay window to these
// (SetWindowRgn), so everything else is truly see-through and clicks go to the game.
// WebView2 can't do real transparency here, so the window is cut to shape instead.
var OVERLAY_SHAPES = '.ov-icon, .ov-grip, .ov-bar > .btn, .ov-head, .ov-today, .ov-zone, .ov-note, .ov-cards > .trade-card, ' +
  '.ov-cards > .disclosure';
function overlayShapes(root) {
  return Array.prototype.map.call(root.querySelectorAll(OVERLAY_SHAPES), function (el) {
    var b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    var rad = el.classList.contains('ov-icon') ? b.width / 2 : parseFloat(cs.borderTopLeftRadius) || 0;
    return [Math.floor(b.left), Math.floor(b.top), Math.ceil(b.width), Math.ceil(b.height), Math.round(rad)];
  }).filter(function (s) { return s[2] > 0 && s[3] > 0; });
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
  // the cheat sheet's "follow my act" was switched on / off: start or stop the log reader
  if (TRADE_CARDS && tradeReaderOn !== null && logReaderWanted() !== tradeReaderOn) startTradeHelper();
  tradeCards.forEach(function (c) { var b = c.dir === 'in' && !c.test ? buyerFor(c) : null; c.hidden = !!(b && b.hidden); });
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

// ---- Trades, People and Reports pages: js/app/25-trade-ledger.js -------------------------

// ---- Setup → Test mode: made-up trades in the in-game overlay -----------------------------
// gui.py runs made-up Client.txt lines through the real parser and hands the events to the
// overlays marked test: buttons on those cards send nothing and nothing is saved.
var TRADE_TESTS = [
  ['whisper', 'Buyer whispers', 'An item trade from the trade site, with a stash tab spot'],
  ['bulk', 'Bulk whisper', 'A currency exchange whisper'],
  ['joined', 'Buyer arrives', 'The buyer joins your hideout (needs a buyer card)'],
  ['accepted', 'Trade accepted', 'The trade window was accepted'],
  ['left', 'Buyer leaves', 'The buyer left your hideout'],
  ['buying', 'You buy', 'Your own whisper to a seller'],
  ['zone', 'Enter a zone', 'Shows the zone note for The Lower Prison']
];
function renderTradeTestMode(sec) {
  if (!isGui() || !window.pywebview.api.trade_test) return;
  sec.appendChild(UI.el('h3', 'trade-h3', 'Test mode'));
  sec.appendChild(UI.el('p', 'finder-sub', 'See what trades look like over the game without a real buyer: these make up ' +
    'trade events and show them as cards marked TEST. Their buttons send nothing to the game and nothing is saved. ' +
    'Works with the trade helper on or off. Switch to the game to look at them.'));
  var row = UI.el('div', 'trade-row trade-test-row');
  function run(kind, btn) {
    btn.disabled = true;
    var league = (document.getElementById('league') || {}).value || 'Standard';
    Promise.resolve(window.pywebview.api.trade_test(kind, league)).then(function (r) {
      btn.disabled = false;
      if (!r || !r.ok) UI.toast('Test failed: ' + ((r && r.error) || 'no answer'), 'danger');
      else if (kind === 'full') UI.toast('Playing a whole trade over 12 s: switch to the game', 'info');
    }, function () { btn.disabled = false; });
  }
  var full = UI.button('primary', { size: 'sm', label: '▶ Whole trade', title: 'Whisper, arrives, accepts, leaves (12 s)',
    onClick: function () { run('full', full); } });
  row.appendChild(full);
  TRADE_TESTS.forEach(function (t) {
    var b = UI.button('ghost', { size: 'sm', label: t[1], title: t[2], onClick: function () { run(t[0], b); } });
    row.appendChild(b);
  });
  var clear = UI.button('ghost', { size: 'sm', label: 'Clear test cards', onClick: function () { run('clear', clear); } });
  row.appendChild(clear);
  sec.appendChild(row);
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
  renderTradeTestMode(sec);

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
  var soundSel = UI.select([['off', 'Off']].concat(Object.keys(TRADE_SOUNDS).map(function (k) { return [k, TRADE_SOUNDS[k].label]; }))
    .concat([['custom', 'Your own sound…']]),
    p.sound, { ariaLabel: 'Sound', onChange: function () {
      setPref('sound', this.value);
      customRow.hidden = this.value !== 'custom';
      tradeChime('new', { sound: this.value });
    } });
  UI.field('Sound', soundSel, { parent: soundRow });
  var volRange = slider('Volume', p.volume, 0, 100, 5, '%', function (v) { setPref('volume', v); tradeChime('new', { volume: v }); }, soundRow);
  soundRow.appendChild(UI.button('ghost', { size: 'sm', label: '▶ Test', onClick: function () {
    tradeChime('new', { sound: soundSel.value, volume: parseInt(volRange.value, 10) });
    setTimeout(function () { tradeChime('joined', { sound: soundSel.value, volume: parseInt(volRange.value, 10) }); }, 900);
  } }));
  sec.appendChild(soundRow);
  // your own files: one for a new trade, one (optional) for the buyer arriving
  var customRow = UI.el('div', 'trade-row');
  customRow.hidden = p.sound !== 'custom';
  [['new', 'New trade'], ['joined', 'Buyer arrived']].forEach(function (k) {
    var cur = (p.customSound || {})[k[0]];
    var label = UI.el('span', 'finder-sub', cur ? (p.customSoundName || {})[k[0]] || 'your file' : (k[0] === 'joined' ? 'same as new trade' : 'none yet'));
    customRow.appendChild(UI.el('b', null, k[1] + ':'));
    customRow.appendChild(label);
    customRow.appendChild(UI.button('ghost', { size: 'sm', cls: 'gui-only', label: 'Choose file…', onClick: async function () {
      var r = await window.pywebview.api.pick_sound(k[0]);
      if (!r || !r.ok) { UI.toast('Not added: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
      if (!r.file) return; // cancelled
      var q = tradePrefs();
      q.customSound = Object.assign({}, q.customSound, (function (o) { o[k[0]] = r.file; return o; })({}));
      q.customSoundName = Object.assign({}, q.customSoundName, (function (o) { o[k[0]] = r.name; return o; })({}));
      saveTradePrefs(q);
      label.textContent = r.name;
      tradeChime(k[0], { sound: 'custom', customSound: q.customSound });
    } }));
    if (cur) {
      customRow.appendChild(UI.iconButton('✕', 'Remove ' + k[1] + ' sound', { size: 'sm', onClick: function () {
        var q = tradePrefs();
        q.customSound = Object.assign({}, q.customSound); delete q.customSound[k[0]];
        saveTradePrefs(q);
        label.textContent = k[0] === 'joined' ? 'same as new trade' : 'none yet';
      } }));
    }
  });
  sec.appendChild(customRow);
  sec.appendChild(UI.el('p', 'finder-sub', 'Plays for a new trade whisper, and a shorter one when the buyer enters your area. ' +
    'Your own sound: an mp3, wav, ogg or m4a up to 3 MB. Hidden buyers never make a sound.'));

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
  var wa = UI.select([['1', 'after 1'], ['2', 'after 2'], ['3', 'after 3'], ['5', 'after 5']], String(p.wasterAt), {
    onChange: function () { var q = tradePrefs(); q.wasterAt = parseInt(this.value, 10); saveTradePrefs(q); } });
  wa.title = 'Time wasted, no-show or a seller who didn\'t answer: after this many, People marks them a time waster ' +
    '(you can always say yes or no yourself)';
  UI.field('Time waster', wa, { parent: sec });
  sec.appendChild(toggle('Today\'s earned / spent line on the trade cards', p.showToday,
    function (v) { setPref('showToday', v); }));

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
  renderTradeDataSetup(sec); // backup / restore (25-trade-ledger.js)
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

// one log reader for both users of Client.txt: the trade helper and the cheat sheet's
// "follow my act" (24-cheatsheets.js); each was switched on by the user with its own consent
var tradeReaderOn = null;
function logReaderWanted() {
  return !!tradePrefs().enabled || (typeof sheetWantsLog === 'function' && sheetWantsLog());
}
async function startTradeHelper() {
  if (!isGui() || !window.pywebview.api.trade_enable) return;
  var p = tradePrefs();
  tradeReaderOn = logReaderWanted();
  try { tradeStatus = await window.pywebview.api.trade_enable(tradeReaderOn, p.logPath || null); }
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
  [['trades', 'Trades'], ['people', 'People'], ['reports', 'Reports'], ['setup', 'Setup']].forEach(function (t) {
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
    if (typeof SHEET_OV !== 'undefined' && SHEET_OV) return; // the cheat sheet overlay (24-cheatsheets.js)
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
