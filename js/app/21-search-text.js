/* js/app/21-search-text.js — in-game search text builder (like poe.re): pick what you want and
   the app writes the search for the stash, vendor, Gwennen, bestiary… box. This file has the
   frame (tabs, result box, presets), the number helpers and the Maps / Vendor / Flasks / own
   words tabs; js/app/31-regex.js adds Items, Gems, Scarabs, Tattoos, Beasts, Gwennen, Heist.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// The game's search box: a case-insensitive regex, 250 characters at most, matched against
// the item's advanced text (a rolled number shows its range: "+73(70-79) to maximum Life").
// "a|b" = either, "!a|b" = neither, and separate "quoted" parts must all match.
// Paste into game = one press: Ctrl+F, paste (no Enter).
var SEARCH_LIMIT = 250;
var SEARCH_PRESETS_KEY = 'pobtf-search-presets';
var SEARCH_OPTS_KEY = 'pobtf-search-opts';

// ==== numbers as regex ===================================================================
function srxDigits(k) { return k <= 0 ? '' : k === 1 ? '\\d' : '\\d{' + k + '}'; }
function srxClass(a, b) { a = +a; b = +b; return a === b ? String(a) : a === 0 && b === 9 ? '\\d' : '[' + a + '-' + b + ']'; }

// a whole number >= n, e.g. 60 -> ([6-9]\d|\d{3}), 87 -> (8[7-9]|9\d|\d{3}). Safe after ".*" or
// a fixed prefix: any digits it matches inside a longer number are a part worth no more than the
// whole, so it never lights up a smaller number.
function atLeastRegex(n) {
  n = Math.floor(+n || 0);
  if (n <= 0) return '\\d';
  var s = String(n), L = s.length, zeros = s.length - s.replace(/0+$/, '').length, core = L - zeros;
  var alts = [s.slice(0, core - 1) + srxClass(s[core - 1], 9) + srxDigits(zeros)];
  for (var i = core - 2; i >= 0; i--) {
    if (+s[i] < 9) alts.push(s.slice(0, i) + srxClass(+s[i] + 1, 9) + srxDigits(L - i - 1));
  }
  alts.push(srxDigits(L + 1));
  return alts.length > 1 ? '(' + alts.join('|') + ')' : alts[0];
}

// a whole number from lo to hi (inclusive), e.g. 15..120 -> (1[5-9]|[2-9]\d|1[01]\d|120)
function rangeRegex(lo, hi) {
  lo = Math.max(0, Math.floor(+lo || 0)); hi = Math.floor(+hi || 0);
  if (hi < lo) { var t = lo; lo = hi; hi = t; }
  function same(a, b) { // equal-length digit strings a <= b
    if (a === b) return a;
    if (a.length === 1) return srxClass(a, b);
    if (a[0] === b[0]) return a[0] + wrap(same(a.slice(1), b.slice(1)));
    var k = a.length - 1, parts = [];
    var lowFull = /^0*$/.test(a.slice(1)), highFull = /^9*$/.test(b.slice(1));
    var from = +a[0] + (lowFull ? 0 : 1), to = +b[0] - (highFull ? 0 : 1);
    if (!lowFull) parts.push(a[0] + wrap(same(a.slice(1), new Array(k + 1).join('9'))));
    if (from <= to) parts.push(srxClass(from, to) + srxDigits(k));
    if (!highFull) parts.push(b[0] + wrap(same(new Array(k + 1).join('0'), b.slice(1))));
    return parts.join('|');
  }
  function wrap(x) { return x.indexOf('|') !== -1 ? '(' + x + ')' : x; }
  var parts = [];
  for (var L = String(lo).length; L <= String(hi).length; L++) {
    var a = Math.max(lo, L === 1 ? 0 : Math.pow(10, L - 1)), b = Math.min(hi, Math.pow(10, L) - 1);
    if (a <= b) parts.push(same(String(a), String(b)));
  }
  var out = parts.join('|');
  return parts.length > 1 || out.indexOf('|') !== -1 ? '(' + out + ')' : out;
}

// "shorter numbers": round a threshold down to tens (fewer characters, a few more matches)
function searchRound(n, on) { n = Math.floor(+n || 0); return on && n >= 10 ? Math.floor(n / 10) * 10 : n; }

// ==== joining parts ======================================================================
function searchQuote(term) { return term ? '"' + String(term).replace(/"/g, '') + '"' : ''; }
function searchAny(terms) { terms = terms.filter(Boolean); return terms.length ? searchQuote(terms.join('|')) : ''; }
function searchAll(terms) { return terms.filter(Boolean).map(searchQuote).join(' '); }
function searchNone(terms) { terms = terms.filter(Boolean); return terms.length ? searchQuote('!' + terms.join('|')) : ''; }
function searchJoin(parts) { return parts.filter(Boolean).join(' '); }
// a literal piece of text as regex
function searchEscape(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// the map search from picks: { avoid: [tokens], want: [tokens], wantAll, quant } (+ yields etc.)
function buildSearchText(s) {
  var parts = [searchNone(s.avoid || [])];
  if ((s.want || []).length) parts.push(s.wantAll ? searchAll(s.want) : searchAny(s.want));
  if (s.quant) parts.push(searchQuote('m q.*' + atLeastRegex(s.quant) + '%'));
  return searchJoin(parts);
}

// ==== ready-made picks ===================================================================
// Flask tokens are pieces of the mods' own text (every tier shares it), each checked against
// every current flask mod (test/test_search_presets.py) so it finds only the mod it names.
// Vendor tokens read the item's mods.
var SEARCH_PRESET_TABS = {
  flasks: [
    { group: 'Suffixes', items: [
      { label: 'Bleeding immunity', token: 'bleed' },
      { label: 'Freeze and chill immunity', token: 'nity to (fre|chil)' },
      { label: 'Shock immunity', token: 'nity to sh' },
      { label: 'Ignite immunity', token: 'nity to ig' },
      { label: 'Poison immunity', token: 'nity to po' },
      { label: 'Maim and hinder immunity', token: 'nity to hi' },
      { label: 'Removes curses', token: 'es curs' },
      { label: 'Movement speed during effect', token: 'speed d' },
      { label: 'Armour during effect', token: 'armour d' },
      { label: 'Evasion during effect', token: 'rating d' },
      { label: 'Resistances during effect', token: 'resistances d' },
      { label: 'Critical strike chance during effect', token: 'chance d' }
    ] },
    { group: 'Prefixes', items: [
      { label: 'Increased effect', token: 'increased effect' },
      { label: 'Reduced charges per use', token: 'reduced charges' },
      { label: 'Increased duration', token: 'increased duration' },
      { label: 'More maximum charges', token: 'maximum charges' },
      { label: 'Charge recovery', token: 'charge recovery' },
      { label: 'Charge on critical strike', token: 'deal a crit' },
      { label: 'Charge when hit', token: 'hit by an' },
      { label: 'Instant recovery', token: 'nt recovery|d instantly' }
    ] }
  ],
  vendor: [
    { group: 'Mods', items: [
      { label: 'Movement speed (any)', token: 'increased movement' },
      { label: 'Movement speed 15% or more', token: '(1[5-9]|[2-9]\\d)(\\(\\d+-\\d+\\))?% increased movement' },
      { label: '+ level of socketed gems (any)', token: 'level of socketed' },
      { label: '+ level of socketed fire / cold / lightning gems', token: 'socketed (fire|cold|light)' },
      { label: '+ level of all spell skill gems', token: 'all (\\w+ )?spell skill' },
      { label: 'Adds damage to spells', token: 'to spells' },
      { label: 'Spell damage', token: 'increased spell d' },
      { label: 'Adds damage to attacks (physical / elemental / chaos)', token: '^adds.*(damage|attacks)$' },
      { label: 'Physical damage % (weapons)', token: 'increased physical d' },
      { label: 'Attack speed', token: 'increased attack s' },
      { label: 'Cast speed', token: 'increased cast s' },
      { label: 'Life', token: 'maximum life' },
      { label: 'Any resistance', token: 'resistance' },
      { label: 'Energy shield', token: '(m|d) energy shield' }
    ] }
  ]
};

// Sockets read like "Sockets: R-G-B B" on the item ("-" = linked); every socket pattern sits
// after "ts:" so it can't match a word in a mod
var VENDOR_LINKS = [
  ['2', '2 linked', 'ts:.*\\w-\\w'], ['3', '3 linked', 'ts:.*(\\w-){2}\\w'], ['4', '4 linked', 'ts:.*(\\w-){3}\\w'],
  ['5', '5 linked', 'ts:.*(\\w-){4}\\w'], ['6', '6 linked', 'ts:.*(\\w-){5}\\w'], ['6s', '6 sockets', 'ts: (\\w[ -]){5}\\w']
];
var VENDOR_CLASSES = ['Boots', 'Gloves', 'Helmets', 'Body Armours', 'Shields', 'Rings', 'Amulets', 'Belts', 'Quivers',
  'Wands', 'Sceptres', 'Staves', 'Bows', 'Claws', 'Daggers', 'One Hand Swords', 'Two Hand Swords', 'One Hand Axes',
  'Two Hand Axes', 'One Hand Maces', 'Two Hand Maces', 'Warstaves', 'Rune Daggers', 'Thrusting One Hand Swords'];

// every order of the picked colours, e.g. [r, r, g] -> r-r-g|r-g-r|g-r-r ("any" = \w)
function socketPerms(cols) {
  var out = {};
  (function perm(rest, acc) {
    if (!rest.length) { out[acc.join('-')] = 1; return; }
    rest.forEach(function (c, i) { perm(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat(c === 'x' ? '\\w' : c)); });
  })(cols, []);
  return Object.keys(out);
}
// sockets: { links, combos: [[r,g,b]...], counts: {r,g,b} } -> regex terms
function vendorSocketTerms(v) {
  var terms = [];
  VENDOR_LINKS.forEach(function (l) { if (v.links && v.links[l[0]]) terms.push(l[2]); });
  (v.combos || []).forEach(function (c) {
    var cols = c.filter(function (x) { return x && x !== '-'; });
    if (cols.length >= 2) terms.push('ts:.*(' + socketPerms(cols).join('|') + ')');
  });
  var cnt = v.counts || {}, look = '';
  ['r', 'g', 'b', 'w'].forEach(function (c) {
    var n = Math.floor(+cnt[c] || 0);
    if (n > 0) look += '(?=(\\S*' + c + '){' + n + '})';
  });
  if (look) terms.push('ts:.+' + look);
  return terms;
}

// ==== the view ===========================================================================
// Tabs register here: { id, label, init() -> state, draw(body, st, ctx), text(st) -> string,
// help }. ctx: { redraw(), out() (redraw the result box only), state (everything) }.
var SEARCH_TABS = [];
function registerSearchTab(tab, before) {
  var i = before ? SEARCH_TABS.findIndex(function (t) { return t.id === before; }) : -1;
  if (i === -1) SEARCH_TABS.push(tab); else SEARCH_TABS.splice(i, 0, tab);
}

function loadSearchPresets() {
  try { return JSON.parse(localStorage.getItem(SEARCH_PRESETS_KEY)) || []; } catch (e) { return []; }
}
function saveSearchPresets(list) { persist(SEARCH_PRESETS_KEY, JSON.stringify(list)); }
function loadSearchOpts() {
  try { return JSON.parse(localStorage.getItem(SEARCH_OPTS_KEY)) || {}; } catch (e) { return {}; }
}

// presets saved before the tabs had their own state (v2.5.5–v2.5.19): one flat state
function migrateSearchState(s) {
  if (!s || s.tabs) return s;
  var maps = { picks: s.picks || {}, wantAll: !!s.wantAll, filter: s.filter || '', t17: s.t17 !== false,
               yields: { quant: s.quant || '' } };
  var pre = s.preset || {}, all = s.presetAll || {};
  return { tab: s.tab || 'maps', tabs: {
    maps: maps,
    flasks: { picked: pre.flasks || {}, all: !!all.flasks },
    vendor: { picked: pre.vendor || {}, all: !!all.vendor },
    custom: { text: s.custom || '', mode: s.customMode || 'any' } } };
}

function searchTabState(state, id) {
  var tab = SEARCH_TABS.find(function (t) { return t.id === id; });
  if (!state.tabs[id]) state.tabs[id] = tab && tab.init ? tab.init() : {};
  return state.tabs[id];
}

// a list of picks: rows of { key, label, token, sub, chip, chipTone, kinds: ['want'] | ['avoid','want'] }
// picked: { key: kind }. onChange() after a click.
function searchPickList(rows, picked, onChange, opts) {
  opts = opts || {};
  var list = UI.el('div', 'st-list' + (opts.cls ? ' ' + opts.cls : ''));
  rows.forEach(function (r) {
    var kind = picked[r.key];
    var row = UI.el('div', 'st-mod' + (kind ? ' is-' + kind : ''));
    (r.kinds || ['want']).forEach(function (k) {
      var glyph = k === 'avoid' ? '✗' : '✓', label = k === 'avoid' ? 'Avoid' : 'Want';
      var b = UI.button('ghost', { size: 'sm', cls: 'st-pick', label: glyph, ariaLabel: label + ': ' + r.label, title: label,
        onClick: function () {
          if (picked[r.key] === k) delete picked[r.key]; else picked[r.key] = k;
          onChange(r);
        } });
      b.setAttribute('aria-pressed', kind === k ? 'true' : 'false');
      row.appendChild(b);
    });
    var txt = UI.el('span', 'st-mod-text', r.label);
    if (r.sub) txt.appendChild(UI.el('span', 'st-sub', r.sub));
    row.appendChild(txt);
    if (r.extra) row.appendChild(r.extra);
    if (r.chip) row.appendChild(UI.chip(r.chip, r.chipTone || 'neutral'));
    var tok = UI.el('code', 'st-token', r.token || 'no short text');
    tok.title = r.token ? 'Searched as "' + r.token + '"' : 'This one can\'t be told apart from the others by its text';
    row.appendChild(tok);
    list.appendChild(row);
  });
  if (!rows.length) list.appendChild(UI.el('div', 'st-empty finder-sub', opts.empty || 'Nothing matches.'));
  return list;
}

// small labelled number box
function searchNumber(label, value, onInput, opts) {
  opts = opts || {};
  var q = UI.input({ type: 'number', min: opts.min != null ? opts.min : 0, max: opts.max || 99999, value: value,
    width: opts.width || '70px', ariaLabel: opts.aria || label });
  q.addEventListener('input', function () { onInput(q.value); });
  return UI.field(label, q, { title: opts.title });
}
function searchCheck(label, on, onChange, title) {
  var l = UI.el('label', 'toggle');
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!on;
  cb.addEventListener('change', function () { onChange(cb.checked); });
  l.appendChild(cb);
  l.appendChild(UI.el('span', null, label));
  if (title) l.title = title;
  return l;
}
// any / yes / no for a property (corrupted, unidentified…)
function searchTri(label, value, onChange) {
  return UI.field(label, UI.select([['any', 'either'], ['yes', 'only these'], ['no', 'not these']], value || 'any',
    { onChange: function () { onChange(this.value); } }));
}

function makeSearchText() {
  var wrap = UI.el('div', 'finder st');
  var opts = loadSearchOpts();
  var state = { tab: 'maps', tabs: {} };
  var tabBar = UI.segmented(SEARCH_TABS.map(function (t) { return [t.id, t.label]; }), state.tab, {
    ariaLabel: 'Search for', onChange: function (v) { state.tab = v; draw(); } });
  tabBar.classList.add('st-tabs');
  wrap.appendChild(tabBar);
  var help = UI.el('div', 'finder-sub st-help');
  wrap.appendChild(help);
  var body = UI.el('div', 'st-body');
  wrap.appendChild(body);
  var outBox = UI.el('div', 'st-out');
  wrap.appendChild(outBox);
  var ctx = { state: state, redraw: draw, out: drawOut };

  function tabOf(id) { return SEARCH_TABS.find(function (t) { return t.id === id; }) || SEARCH_TABS[0]; }
  function current() {
    var tab = tabOf(state.tab);
    var text = tab.text(searchTabState(state, tab.id), ctx) || '';
    var extra = (opts.extra || '').trim();
    if (opts.extraOn && extra) text = searchJoin([text, extra]);
    return text;
  }
  function saveOpts() { try { localStorage.setItem(SEARCH_OPTS_KEY, JSON.stringify(opts)); } catch (e) { /* fine */ } }

  function copy(text, quiet) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      if (!quiet) UI.toast('Copied: in game, Ctrl+F then Ctrl+V.', 'success');
    }).catch(function () { if (!quiet) UI.toast('Could not copy.', 'danger'); });
  }

  var lastAuto = null;
  function drawOut() {
    outBox.textContent = '';
    var text = current();
    var row = UI.el('div', 'st-result');
    var field = UI.input({ value: text, ariaLabel: 'Search text', cls: 'st-text' });
    field.readOnly = true;
    row.appendChild(field);
    var count = UI.chip(text.length + ' / ' + SEARCH_LIMIT, text.length > SEARCH_LIMIT ? 'danger' : 'neutral', 'st-count');
    count.title = 'The in-game search box takes ' + SEARCH_LIMIT + ' characters';
    row.appendChild(count);
    row.appendChild(UI.button('secondary', { size: 'sm', label: 'Copy', onClick: function () { copy(text); } }));
    if (isGui() && window.pywebview.api.game_search_paste) {
      var paste = UI.button('primary', { size: 'sm', label: 'Paste into game', onClick: async function () {
        if (!text) return;
        paste.disabled = true;
        var r = await window.pywebview.api.game_search_paste(text);
        paste.disabled = false;
        if (!r || !r.ok) UI.toast('Not pasted: ' + ((r && r.error) || 'no answer'), 'danger');
      } });
      paste.title = 'Open your stash or a vendor first. One press: Ctrl+F and paste into the game\'s search box.';
      row.appendChild(paste);
    }
    outBox.appendChild(row);
    if (text.length > SEARCH_LIMIT) {
      outBox.appendChild(UI.el('div', 'finder-sub st-warn', 'Too long for the game\'s box (' + text.length + ' of ' +
        SEARCH_LIMIT + '): untick a few, or save it as two presets.'));
    }
    if (opts.auto && text && text !== lastAuto && text.length <= SEARCH_LIMIT) { lastAuto = text; copy(text, true); }
    // options: your own text after the search, copy on every change
    var o = UI.el('div', 'st-controls st-opts');
    o.appendChild(searchCheck('Add my own text:', opts.extraOn, function (v) { opts.extraOn = v; saveOpts(); drawOut(); },
      'Added after the search with a space, e.g. a price note or "corrupted"'));
    var ex = UI.input({ value: opts.extra || '', placeholder: 'e.g. "!corrupted"', width: '200px', ariaLabel: 'My own text' });
    ex.addEventListener('change', function () { opts.extra = ex.value; saveOpts(); drawOut(); });
    o.appendChild(ex);
    o.appendChild(searchCheck('Copy automatically', opts.auto, function (v) { opts.auto = v; saveOpts(); if (v) { lastAuto = null; drawOut(); } },
      'Copies the search every time it changes'));
    outBox.appendChild(o);
    // presets: every tab's picks at once
    var pre = UI.el('div', 'st-presets');
    var name = UI.input({ placeholder: 'Preset name', width: '160px', ariaLabel: 'Preset name' });
    pre.appendChild(name);
    pre.appendChild(UI.button('ghost', { size: 'sm', label: 'Save preset', onClick: function () {
      var n = name.value.trim();
      if (!n) { UI.toast('Give the preset a name.', 'warn'); return; }
      var list = loadSearchPresets().filter(function (p) { return p.name !== n; });
      list.push({ name: n, state: JSON.parse(JSON.stringify(state)) });
      saveSearchPresets(list);
      drawOut();
    } }));
    loadSearchPresets().forEach(function (p) {
      var chip = UI.el('span', 'st-preset');
      chip.appendChild(UI.button('ghost', { size: 'sm', label: p.name, title: 'Load this preset', onClick: function () {
        var s = migrateSearchState(JSON.parse(JSON.stringify(p.state)));
        state.tabs = s.tabs || {};
        state.tab = tabOf(s.tab).id;
        tabBar.setValue(state.tab);
        draw();
      } }));
      chip.appendChild(UI.iconButton('✕', 'Delete preset ' + p.name, { size: 'sm', onClick: function () {
        saveSearchPresets(loadSearchPresets().filter(function (x) { return x.name !== p.name; }));
        drawOut();
      } }));
      pre.appendChild(chip);
    });
    outBox.appendChild(pre);
  }

  function draw() {
    var tab = tabOf(state.tab);
    body.textContent = '';
    help.textContent = tab.help || '';
    help.hidden = !tab.help;
    tab.draw(body, searchTabState(state, tab.id), ctx);
    drawOut();
  }
  draw();
  return wrap;
}

// ==== Maps ===============================================================================
// Data: data/mapmods.js (tools/make_mapmods.py): each map mod with the shortest piece of its
// text that no other map mod has (no digits, so every roll matches).
// The totals a map shows: "Item Quantity: +80%", "Monster Pack Size: +30%", "More Maps: +40%"…
// each anchor matches only its own line (a quality type reads "Quality (Pack Size): +20%").
var MAP_YIELDS = [
  ['quant', 'Item quantity', 'm q'], ['pack', 'Pack size', 'k size:'], ['rarity', 'Item rarity', 'm rarity:'],
  ['maps', 'More maps', 're maps:'], ['currency', 'More currency', 'currency:'], ['scarabs', 'More scarabs', 'scarabs:'],
  ['div', 'More div cards', 'n cards:']
];
var MAP_QUALITY = [
  ['plain', 'Quality', 'quality: \\+'], ['pack', 'Quality (pack size)', 'quality.*pack'],
  ['rarity', 'Quality (rarity)', 'quality.*rarity'], ['currency', 'Quality (currency)', 'quality.*currency'],
  ['div', 'Quality (div cards)', 'quality.*divination'], ['scarabs', 'Quality (scarabs)', 'quality.*scarab']
];
var MAP_TYPES = [
  ['shaper', 'Shaper', 'the shaper'], ['elder', 'Elder', 'the elder'], ['originator', 'Originator', 'originator'],
  ['blighted', 'Blighted', '^blighted'], ['ravaged', 'Blight-ravaged', 'blight-ravaged']
];

function mapSearchText(m) {
  var avoid = [], want = [];
  Object.keys(m.picks || {}).forEach(function (tok) { (m.picks[tok] === 'avoid' ? avoid : want).push(tok); });
  var types = m.types || {}, tIn = [], tOut = [];
  MAP_TYPES.forEach(function (t) { if (types[t[0]] === 'want') tIn.push(t[2]); else if (types[t[0]] === 'avoid') tOut.push(t[2]); });
  var parts = [searchNone(avoid.concat(tOut))];
  if (want.length) parts.push(m.wantAll ? searchAll(want) : searchAny(want));
  if (tIn.length) parts.push(searchAny(tIn));
  var y = m.yields || {}, yTerms = [];
  MAP_YIELDS.forEach(function (d) {
    var n = searchRound(y[d[0]], m.short);
    if (n > 0) yTerms.push(d[2] + '.*' + atLeastRegex(n) + '%');
  });
  parts.push(m.anyYield ? searchAny(yTerms) : searchAll(yTerms));
  var q = m.quality || {}, qTerms = [];
  MAP_QUALITY.forEach(function (d) {
    var n = searchRound(q[d[0]], m.short);
    if (n > 0) qTerms.push(d[2] + '.*' + atLeastRegex(n) + '%');
  });
  parts.push(m.anyQuality ? searchAny(qTerms) : searchAll(qTerms));
  var rar = m.rarity || {}, rIn = ['normal', 'magic', 'rare', 'unique'].filter(function (r) { return rar[r]; });
  if (rIn.length && rIn.length < 4) parts.push(searchQuote('y: (' + rIn.map(function (r) { return r[0]; }).join('|') + ')'));
  if (m.corrupted === 'yes') parts.push(searchQuote('^corrupted$')); else if (m.corrupted === 'no') parts.push(searchQuote('!^corrupted$'));
  if (m.unid === 'yes') parts.push(searchQuote('^unidentified$')); else if (m.unid === 'no') parts.push(searchQuote('!^unidentified$'));
  if (m.priceOn && (+m.priceMax || 0) > 0) {
    parts.push(searchQuote('\\s' + rangeRegex(+m.priceMin || 0, +m.priceMax) + ' ' + (m.priceCur || 'chaos')));
  }
  return searchJoin(parts);
}

registerSearchTab({
  id: 'maps', label: 'Maps',
  help: '✗ = maps with this mod don\'t match (avoid). ✓ = maps need it. Totals and quality match "at least". Open your map tab, then paste.',
  init: function () { return { picks: {}, wantAll: false, filter: '', t17: true, yields: {}, quality: {}, rarity: {}, types: {} }; },
  text: mapSearchText,
  draw: function (body, m, ctx) {
    var mods = window.POE_MAP_MODS || [];
    m.yields = m.yields || {}; m.quality = m.quality || {}; m.rarity = m.rarity || {}; m.types = m.types || {};
    // totals
    var yb = UI.el('div', 'st-controls st-yields');
    MAP_YIELDS.forEach(function (d) {
      yb.appendChild(searchNumber(d[1] + ' ≥ %', m.yields[d[0]] || '', function (v) { m.yields[d[0]] = v; ctx.out(); },
        { max: 999, aria: 'Minimum ' + d[1].toLowerCase() }));
    });
    yb.appendChild(searchCheck('Any one of these is enough', m.anyYield, function (v) { m.anyYield = v; ctx.out(); }));
    yb.appendChild(searchCheck('Shorter numbers', m.short, function (v) { m.short = v; ctx.out(); },
      'Rounds each minimum down to tens: shorter search, a few more maps light up'));
    body.appendChild(searchSection('Totals (quantity, pack size, more maps…)', yb, true));
    // quality, state, types, price
    var qb = UI.el('div', 'st-controls');
    MAP_QUALITY.forEach(function (d) {
      qb.appendChild(searchNumber(d[1] + ' ≥ %', m.quality[d[0]] || '', function (v) { m.quality[d[0]] = v; ctx.out(); },
        { max: 99, aria: 'Minimum ' + d[1].toLowerCase() }));
    });
    qb.appendChild(searchCheck('Any one of these is enough', m.anyQuality, function (v) { m.anyQuality = v; ctx.out(); }));
    body.appendChild(searchSection('Quality', qb, false));
    var sb = UI.el('div', 'st-controls');
    ['normal', 'magic', 'rare', 'unique'].forEach(function (r) {
      sb.appendChild(searchCheck(r[0].toUpperCase() + r.slice(1), m.rarity[r], function (v) { m.rarity[r] = v; ctx.out(); }));
    });
    sb.appendChild(searchTri('Corrupted', m.corrupted, function (v) { m.corrupted = v; ctx.out(); }));
    sb.appendChild(searchTri('Unidentified', m.unid, function (v) { m.unid = v; ctx.out(); }));
    MAP_TYPES.forEach(function (t) {
      sb.appendChild(UI.field(t[1], UI.select([['', 'either'], ['want', 'only these'], ['avoid', 'not these']], m.types[t[0]] || '',
        { onChange: function () { if (this.value) m.types[t[0]] = this.value; else delete m.types[t[0]]; ctx.out(); } })));
    });
    body.appendChild(searchSection('Rarity, corrupted, map type', sb, false));
    var pb = UI.el('div', 'st-controls');
    pb.appendChild(searchCheck('Price note between', m.priceOn, function (v) { m.priceOn = v; ctx.out(); },
      'Maps in a premium tab with a price note like "~price 15 chaos"'));
    pb.appendChild(searchNumber('from', m.priceMin || '', function (v) { m.priceMin = v; ctx.out(); }, { aria: 'Lowest price' }));
    pb.appendChild(searchNumber('to', m.priceMax || '', function (v) { m.priceMax = v; ctx.out(); }, { aria: 'Highest price' }));
    pb.appendChild(UI.select([['chaos', 'chaos'], ['divine', 'divine']], m.priceCur || 'chaos',
      { ariaLabel: 'Price currency', onChange: function () { m.priceCur = this.value; ctx.out(); } }));
    body.appendChild(searchSection('Price note', pb, false));
    // mods
    var bar = UI.el('div', 'st-controls');
    var f = UI.input({ placeholder: 'Filter mods', value: m.filter || '', width: '180px', ariaLabel: 'Filter map mods' });
    f.addEventListener('input', function () { m.filter = f.value; drawList(); });
    bar.appendChild(f);
    UI.field('Wanted mods', UI.select([['any', 'any of them'], ['all', 'all of them']], m.wantAll ? 'all' : 'any',
      { onChange: function () { m.wantAll = this.value === 'all'; ctx.out(); } }), { parent: bar });
    bar.appendChild(searchCheck('Tier 17 mods', m.t17 !== false, function (v) { m.t17 = v; drawList(); }));
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () {
      var keep = m.filter;
      Object.keys(m).forEach(function (k) { delete m[k]; });
      Object.assign(m, { picks: {}, wantAll: false, filter: keep, t17: true, yields: {}, quality: {}, rarity: {}, types: {} });
      ctx.redraw();
    } }));
    body.appendChild(bar);
    var holder = UI.el('div');
    body.appendChild(holder);
    function drawList() {
      holder.textContent = '';
      var q2 = (m.filter || '').toLowerCase();
      holder.appendChild(searchPickList(mods.filter(function (x) {
        return (m.t17 !== false || !x.t17) && (!q2 || x.text.toLowerCase().indexOf(q2) !== -1);
      }).map(function (x) {
        return { key: x.token, label: x.text, token: x.token, kinds: x.token ? ['avoid', 'want'] : [], chip: x.t17 ? 'T17' : '' };
      }), m.picks, function () { drawList(); ctx.out(); }));
    }
    drawList();
  }
});

// a titled block that opens and closes (open ones show their settings straight away)
function searchSection(title, content, open) {
  var d = UI.el('details', 'st-section');
  if (open) d.open = true;
  d.appendChild(UI.el('summary', null, title));
  d.appendChild(content);
  return d;
}

// ==== Vendor =============================================================================
function vendorSearchText(v) {
  var terms = vendorSocketTerms(v);
  var picked = v.picked || {};
  Object.keys(picked).forEach(function (t) { if (picked[t]) terms.push(t); });
  var cls = Object.keys(v.classes || {}).filter(function (c) { return v.classes[c]; });
  var rar = ['normal', 'magic', 'rare'].filter(function (r) { return (v.rarity || {})[r]; });
  var main = v.all ? searchAll(terms) : searchAny(terms);
  // item class and rarity narrow everything else down (always "and")
  return searchJoin([main,
    cls.length ? searchQuote('ss: (' + cls.map(function (c) { return c.toLowerCase(); }).join('|') + ')') : '',
    rar.length && rar.length < 3 ? searchQuote('y: (' + rar.map(function (r) { return r[0]; }).join('|') + ')') : '']);
}

registerSearchTab({
  id: 'vendor', label: 'Vendor',
  help: 'For vendors while levelling: links and colours read the item\'s sockets ("R-G-B"); item type and rarity narrow everything down. Open the vendor, then paste.',
  init: function () { return { links: {}, combos: [], counts: {}, picked: {}, classes: {}, rarity: {}, all: false }; },
  text: vendorSearchText,
  draw: function (body, v, ctx) {
    v.links = v.links || {}; v.combos = v.combos || []; v.counts = v.counts || {}; v.picked = v.picked || {};
    v.classes = v.classes || {}; v.rarity = v.rarity || {};
    var bar = UI.el('div', 'st-controls');
    UI.field('Items must have', UI.select([['any', 'any of the picks'], ['all', 'all of the picks']], v.all ? 'all' : 'any',
      { onChange: function () { v.all = this.value === 'all'; ctx.out(); } }), { parent: bar });
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () {
      Object.assign(v, { links: {}, combos: [], counts: {}, picked: {}, classes: {}, rarity: {}, all: false }); ctx.redraw();
    } }));
    body.appendChild(bar);
    // links
    var lb = UI.el('div', 'st-controls');
    VENDOR_LINKS.forEach(function (l) {
      lb.appendChild(searchCheck(l[1], v.links[l[0]], function (on) { if (on) v.links[l[0]] = 1; else delete v.links[l[0]]; ctx.out(); }));
    });
    body.appendChild(searchSection('Sockets and links', lb, true));
    // linked colours: up to 3 slots, any order
    var cb = UI.el('div', 'st-combos');
    var COLS = [['-', '–'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['w', 'White'], ['x', 'Any']];
    function drawCombos() {
      cb.textContent = '';
      v.combos.forEach(function (c, i) {
        var row = UI.el('div', 'st-controls');
        row.appendChild(UI.el('span', 'st-label', 'Linked'));
        [0, 1, 2].forEach(function (k) {
          row.appendChild(UI.select(COLS, c[k] || '-', { ariaLabel: 'Socket ' + (k + 1) + ' colour', onChange: function () {
            c[k] = this.value; ctx.out();
          } }));
        });
        row.appendChild(UI.iconButton('✕', 'Remove this colour pick', { size: 'sm', onClick: function () { v.combos.splice(i, 1); drawCombos(); ctx.out(); } }));
        cb.appendChild(row);
      });
      cb.appendChild(UI.button('ghost', { size: 'sm', label: '+ Linked colours', title: 'e.g. Red-Red-Green in any order',
        onClick: function () { v.combos.push(['r', 'r', 'x']); drawCombos(); ctx.out(); } }));
      cb.appendChild(UI.button('ghost', { size: 'sm', label: 'Chromatic recipe (R-G-B)', onClick: function () {
        v.combos.push(['r', 'g', 'b']); drawCombos(); ctx.out();
      } }));
    }
    drawCombos();
    var cnt = UI.el('div', 'st-controls');
    [['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['w', 'White']].forEach(function (c) {
      cnt.appendChild(searchNumber(c[1] + ' ≥', v.counts[c[0]] || '', function (n) { v.counts[c[0]] = n; ctx.out(); },
        { max: 6, width: '56px', aria: 'At least this many ' + c[1].toLowerCase() + ' sockets linked' }));
    });
    var colWrap = UI.el('div');
    colWrap.appendChild(cb);
    colWrap.appendChild(UI.el('div', 'finder-sub', 'Colours in one linked group (takes more characters):'));
    colWrap.appendChild(cnt);
    body.appendChild(searchSection('Socket colours', colWrap, false));
    // mods
    var ml = UI.el('div');
    SEARCH_PRESET_TABS.vendor.forEach(function (grp) {
      ml.appendChild(searchPickList(grp.items.map(function (p) { return { key: p.token, label: p.label, token: p.token }; }),
        v.picked, function () { ctx.redraw(); }, { cls: 'st-preset-list' }));
    });
    body.appendChild(searchSection('Mods', ml, true));
    // item type and rarity
    var tb = UI.el('div', 'st-controls st-wrap');
    VENDOR_CLASSES.forEach(function (c) {
      tb.appendChild(searchCheck(c, v.classes[c], function (on) { if (on) v.classes[c] = 1; else delete v.classes[c]; ctx.out(); }));
    });
    var rb = UI.el('div', 'st-controls');
    ['normal', 'magic', 'rare'].forEach(function (r) {
      rb.appendChild(searchCheck(r[0].toUpperCase() + r.slice(1), v.rarity[r], function (on) { v.rarity[r] = on; ctx.out(); }));
    });
    var tw = UI.el('div');
    tw.appendChild(tb);
    tw.appendChild(rb);
    body.appendChild(searchSection('Item type and rarity', tw, false));
  }
});

// ==== Flasks (ready-made picks) ===========================================================
function presetSearchText(kind) {
  return function (p) {
    var picked = p.picked || {};
    var want = Object.keys(picked).filter(function (t) { return picked[t]; });
    return p.all ? searchAll(want) : searchAny(want);
  };
}
registerSearchTab({
  id: 'flasks', label: 'Flasks',
  help: 'Matches the mod text, so every tier of a mod counts. Open your stash or a vendor, then paste. For flask mods with values, use Items.',
  init: function () { return { picked: {}, all: false }; },
  text: presetSearchText('flasks'),
  draw: function (body, p, ctx) {
    p.picked = p.picked || {};
    var bar = UI.el('div', 'st-controls');
    UI.field('Items must have', UI.select([['any', 'any of these'], ['all', 'all of these']], p.all ? 'all' : 'any',
      { onChange: function () { p.all = this.value === 'all'; ctx.out(); } }), { parent: bar });
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { p.picked = {}; ctx.redraw(); } }));
    body.appendChild(bar);
    SEARCH_PRESET_TABS.flasks.forEach(function (grp) {
      body.appendChild(UI.el('div', 'st-group', grp.group));
      body.appendChild(searchPickList(grp.items.map(function (x) { return { key: x.token, label: x.label, token: x.token }; }),
        p.picked, function () { ctx.redraw(); }, { cls: 'st-preset-list' }));
    });
  }
});

// ==== your own words =====================================================================
registerSearchTab({
  id: 'custom', label: 'Your own words',
  help: 'One word or phrase per line. Matching is any part of the item\'s text, not case-sensitive.',
  init: function () { return { text: '', mode: 'any' }; },
  text: function (c) {
    var words = (c.text || '').split('\n').map(function (w) { return w.trim().replace(/"/g, ''); }).filter(Boolean);
    return c.mode === 'exclude' ? searchNone(words) : c.mode === 'all' ? searchAll(words) : searchAny(words);
  },
  draw: function (body, c, ctx) {
    var bar = UI.el('div', 'st-controls');
    UI.field('Items must', UI.select([['any', 'have any of these'], ['all', 'have all of these'], ['exclude', 'have none of these']],
      c.mode || 'any', { onChange: function () { c.mode = this.value; ctx.out(); } }), { parent: bar });
    body.appendChild(bar);
    var ta = document.createElement('textarea');
    ta.className = 'st-words';
    ta.value = c.text || '';
    ta.placeholder = 'movement speed\n+1 to level\nr-g-b';
    ta.setAttribute('aria-label', 'Words to search for');
    ta.addEventListener('input', function () { c.text = ta.value; ctx.out(); });
    body.appendChild(ta);
  }
});
