/* js/app/21-search-text.js — in-game search text builder (like poe.re): map mods to avoid or
   want, item quantity, or your own words, as one search string for the stash / vendor box.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Data: data/mapmods.js (tools/make_mapmods.py): each map mod with the shortest piece of its
// text that no other map mod has (no digits, so every roll matches).
// In game the box takes 50 characters; "a|b" = either, "!a|b" = neither, and separate
// "quoted" parts must all match. Paste into game = one press: Ctrl+F, paste (no Enter).
var SEARCH_LIMIT = 50;
var SEARCH_PRESETS_KEY = 'pobtf-search-presets';

// regex for a whole number >= n (1..199), e.g. 60 -> (\d{3}|[6-9]\d)
function atLeastRegex(n) {
  n = Math.max(1, Math.min(199, Math.floor(n)));
  if (n >= 100) {
    var t = Math.floor((n - 100) / 10), o = n % 10;
    var p100 = [];
    if (o === 0) p100.push('1' + cls(t, 9) + '\\d');
    else { p100.push('1' + t + cls(o, 9)); if (t < 9) p100.push('1' + cls(t + 1, 9) + '\\d'); }
    return '(' + p100.concat(['[2-9]\\d\\d']).join('|') + ')';
  }
  if (n < 10) return '(\\d\\d+|' + cls(n, 9) + ')';
  var tens = Math.floor(n / 10), ones = n % 10, parts = ['\\d{3}'];
  if (ones === 0) parts.push(cls(tens, 9) + '\\d');
  else { parts.push(tens + cls(ones, 9)); if (tens < 9) parts.push(cls(tens + 1, 9) + '\\d'); }
  return '(' + parts.join('|') + ')';
  function cls(a, b) { return a === b ? String(a) : '[' + a + '-' + b + ']'; }
}

// the search string from picks: { avoid: [tokens], want: [tokens], wantAll, quant }
function buildSearchText(s) {
  var parts = [];
  if (s.avoid.length) parts.push('"!' + s.avoid.join('|') + '"');
  if (s.want.length) {
    if (s.wantAll) s.want.forEach(function (t) { parts.push('"' + t + '"'); });
    else parts.push('"' + s.want.join('|') + '"');
  }
  if (s.quant) parts.push('"m q.*' + atLeastRegex(s.quant) + '%"');
  return parts.join(' ');
}

// Ready-made picks for flasks and vendors. Flask tokens are pieces of the mods' own text (every
// tier shares it), each checked against every current flask mod (test/test_search_presets.py)
// so it finds only the mod it names. Vendor tokens read the item's sockets ("R-G-B") and mods.
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
    { group: 'Sockets', items: [
      { label: 'Chromatic recipe (R, G and B linked)', token: 'r-g-b|r-b-g|g-r-b|g-b-r|b-r-g|b-g-r' },
      { label: '3 linked sockets or more', token: '(.-){2}' },
      { label: '4 linked sockets or more', token: '(.-){3}' },
      { label: '5 linked sockets or more', token: '(.-){4}' }
    ] },
    { group: 'Mods', items: [
      { label: 'Movement speed (boots)', token: 'increased movement' },
      { label: '+ level of socketed gems', token: 'level of socketed' },
      { label: 'Adds damage to spells', token: 'to spells' },
      { label: 'Life', token: 'maximum life' }
    ] }
  ]
};

function loadSearchPresets() {
  try { return JSON.parse(localStorage.getItem(SEARCH_PRESETS_KEY)) || []; } catch (e) { return []; }
}
function saveSearchPresets(list) { persist(SEARCH_PRESETS_KEY, JSON.stringify(list)); }

function makeSearchText() {
  var wrap = UI.el('div', 'finder st');
  var state = { tab: 'maps', picks: {}, wantAll: false, quant: '', filter: '', t17: true, custom: '', customMode: 'any',
                preset: { flasks: {}, vendor: {} }, presetAll: { flasks: false, vendor: false } };
  var tabs = UI.segmented([['maps', 'Maps'], ['flasks', 'Flasks'], ['vendor', 'Vendor'], ['custom', 'Your own words']], 'maps', {
    ariaLabel: 'Search for', onChange: function (v) { state.tab = v; draw(); } });
  wrap.appendChild(tabs);
  var body = UI.el('div', 'st-body');
  wrap.appendChild(body);
  var outBox = UI.el('div', 'st-out');
  wrap.appendChild(outBox);

  function current() {
    if (state.tab === 'custom') {
      var words = state.custom.split('\n').map(function (w) { return w.trim().replace(/"/g, ''); }).filter(Boolean);
      return buildSearchText({ avoid: state.customMode === 'exclude' ? words : [],
        want: state.customMode === 'exclude' ? [] : words, wantAll: state.customMode === 'all', quant: 0 });
    }
    if (SEARCH_PRESET_TABS[state.tab]) {
      var picked = (state.preset || {})[state.tab] || {};
      return buildSearchText({ avoid: [], want: Object.keys(picked).filter(function (t) { return picked[t]; }),
        wantAll: !!(state.presetAll || {})[state.tab], quant: 0 });
    }
    var avoid = [], want = [];
    Object.keys(state.picks).forEach(function (tok) { (state.picks[tok] === 'avoid' ? avoid : want).push(tok); });
    return buildSearchText({ avoid: avoid, want: want, wantAll: state.wantAll, quant: parseInt(state.quant, 10) || 0 });
  }

  function drawOut() {
    outBox.textContent = '';
    var text = current();
    var row = UI.el('div', 'st-result');
    var field = UI.input({ value: text, ariaLabel: 'Search text', cls: 'st-text' });
    field.readOnly = true;
    row.appendChild(field);
    var count = UI.chip(text.length + ' / ' + SEARCH_LIMIT, text.length > SEARCH_LIMIT ? 'danger' : 'neutral');
    count.title = 'The in-game search box takes ' + SEARCH_LIMIT + ' characters';
    row.appendChild(count);
    row.appendChild(UI.button('secondary', { size: 'sm', label: 'Copy', onClick: function () {
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () { UI.toast('Copied: in game, Ctrl+F then Ctrl+V.', 'success'); });
    } }));
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
      outBox.appendChild(UI.el('div', 'finder-sub st-warn', 'Too long for the game\'s box: untick a few, or save it as two presets.'));
    }
    // presets
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
        Object.assign(state, JSON.parse(JSON.stringify(p.state)));
        tabs.querySelectorAll('[data-value]').forEach(function (b) {
          b.setAttribute('aria-checked', b.dataset.value === state.tab ? 'true' : 'false');
        });
        tabs.value = state.tab;
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

  function drawMaps() {
    var mods = window.POE_MAP_MODS || [];
    var bar = UI.el('div', 'st-controls');
    var f = UI.input({ placeholder: 'Filter mods', value: state.filter, width: '180px', ariaLabel: 'Filter map mods' });
    f.addEventListener('input', function () { state.filter = f.value; drawList(); });
    bar.appendChild(f);
    UI.field('Wanted mods', UI.select([['any', 'any of them'], ['all', 'all of them']], state.wantAll ? 'all' : 'any',
      { onChange: function () { state.wantAll = this.value === 'all'; drawOut(); } }), { parent: bar });
    var q = UI.input({ type: 'number', min: 1, max: 199, value: state.quant, width: '70px', ariaLabel: 'Minimum item quantity' });
    q.addEventListener('input', function () { state.quant = q.value; drawOut(); });
    UI.field('Item quantity ≥ %', q, { parent: bar });
    var t17 = UI.el('label', 'toggle');
    var tcb = document.createElement('input');
    tcb.type = 'checkbox';
    tcb.checked = state.t17;
    tcb.addEventListener('change', function () { state.t17 = tcb.checked; drawList(); });
    t17.appendChild(tcb);
    t17.appendChild(UI.el('span', null, 'Tier 17 mods'));
    bar.appendChild(t17);
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () {
      state.picks = {}; state.quant = ''; state.filter = ''; draw();
    } }));
    body.appendChild(bar);
    body.appendChild(UI.el('div', 'finder-sub', '✗ = maps with this mod don\'t match (avoid). ✓ = maps need this mod.'));
    var list = UI.el('div', 'st-list');
    body.appendChild(list);
    function drawList() {
      list.textContent = '';
      var q2 = state.filter.toLowerCase();
      mods.filter(function (m) {
        return (state.t17 || !m.t17) && (!q2 || m.text.toLowerCase().indexOf(q2) !== -1);
      }).forEach(function (m) {
        var row = UI.el('div', 'st-mod' + (state.picks[m.token] ? ' is-' + state.picks[m.token] : ''));
        function pick(kind, glyph, label) {
          var b = UI.button('ghost', { size: 'sm', cls: 'st-pick', label: glyph,
            ariaLabel: label + ': ' + m.text, title: label, onClick: function () {
              if (state.picks[m.token] === kind) delete state.picks[m.token]; else state.picks[m.token] = kind;
              drawList(); drawOut();
            } });
          b.setAttribute('aria-pressed', state.picks[m.token] === kind ? 'true' : 'false');
          return b;
        }
        if (m.token) {
          row.appendChild(pick('avoid', '✗', 'Avoid'));
          row.appendChild(pick('want', '✓', 'Want'));
        } else {
          row.appendChild(UI.el('span', 'st-none', '–'));
        }
        row.appendChild(UI.el('span', 'st-mod-text', m.text));
        if (m.t17) row.appendChild(UI.chip('T17', 'neutral'));
        var tok = UI.el('code', 'st-token', m.token || 'no short text');
        tok.title = m.token ? 'Searched as "' + m.token + '"' : 'This one can\'t be told apart from other mods by its text';
        row.appendChild(tok);
        list.appendChild(row);
      });
    }
    drawList();
  }

  function drawCustom() {
    body.appendChild(UI.el('div', 'finder-sub', 'One word or phrase per line. Matching is any part of the item\'s text, ' +
      'not case-sensitive.'));
    var bar = UI.el('div', 'st-controls');
    UI.field('Items must', UI.select([['any', 'have any of these'], ['all', 'have all of these'], ['exclude', 'have none of these']],
      state.customMode, { onChange: function () { state.customMode = this.value; drawOut(); } }), { parent: bar });
    body.appendChild(bar);
    var ta = document.createElement('textarea');
    ta.className = 'st-words';
    ta.value = state.custom;
    ta.placeholder = 'movement speed\n+1 to level\nr-g-b';
    ta.setAttribute('aria-label', 'Words to search for');
    ta.addEventListener('input', function () { state.custom = ta.value; drawOut(); });
    body.appendChild(ta);
  }

  // Flasks / Vendor: tick what you want; any (or all) of them must be on the item
  function drawPresetTab(kind) {
    state.preset = state.preset || { flasks: {}, vendor: {} }; // presets saved before these tabs existed
    state.presetAll = state.presetAll || { flasks: false, vendor: false };
    var picked = state.preset[kind] = state.preset[kind] || {};
    var bar = UI.el('div', 'st-controls');
    UI.field('Items must have', UI.select([['any', 'any of these'], ['all', 'all of these']], state.presetAll[kind] ? 'all' : 'any',
      { onChange: function () { state.presetAll[kind] = this.value === 'all'; drawOut(); } }), { parent: bar });
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { state.preset[kind] = {}; draw(); } }));
    body.appendChild(bar);
    body.appendChild(UI.el('div', 'finder-sub', kind === 'flasks'
      ? 'Matches the mod text, so every tier of a mod counts. Open your stash or a vendor, then paste.'
      : 'For vendors while levelling: sockets read like "R-G-B" on the item. Open the vendor, then paste.'));
    SEARCH_PRESET_TABS[kind].forEach(function (grp) {
      body.appendChild(UI.el('div', 'st-group', grp.group));
      var list = UI.el('div', 'st-list st-preset-list');
      grp.items.forEach(function (p) {
        var on = !!picked[p.token];
        var row = UI.el('div', 'st-mod' + (on ? ' is-want' : ''));
        var b = UI.button('ghost', { size: 'sm', cls: 'st-pick', label: '✓', ariaLabel: 'Want: ' + p.label, title: 'Want',
          onClick: function () {
            if (picked[p.token]) delete picked[p.token]; else picked[p.token] = true;
            draw();
          } });
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        row.appendChild(b);
        row.appendChild(UI.el('span', 'st-mod-text', p.label));
        var tok = UI.el('code', 'st-token', p.token);
        tok.title = 'Searched as "' + p.token + '"';
        row.appendChild(tok);
        list.appendChild(row);
      });
      body.appendChild(list);
    });
  }

  function draw() {
    body.textContent = '';
    if (state.tab === 'custom') drawCustom();
    else if (SEARCH_PRESET_TABS[state.tab]) drawPresetTab(state.tab);
    else drawMaps();
    drawOut();
  }
  draw();
  return wrap;
}
