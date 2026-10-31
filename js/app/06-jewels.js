/* js/app/06-jewels.js — jewel finder and timeless jewel finder.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- jewel finder --------------------------------------------------------------
// Reads the passive tree + main skill (js/jewels.js), ranks every rare/abyss
// jewel mod by how much THIS build wants it, then searches trade for the best
// jewels (weighted) or any-N-of combos. Plus a timeless jewel seed search.
var jewelDataPromise = null;
function ensureJewelData() {
  if (window.POE_JEWELS) return Promise.resolve(window.POE_JEWELS);
  if (!jewelDataPromise) {
    jewelDataPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'data/jeweldata.js?v=' + Date.now();
      s.onload = function () { if (window.POE_JEWELS) resolve(window.POE_JEWELS); else reject(new Error('jewel data missing')); };
      s.onerror = function () { jewelDataPromise = null; reject(new Error('could not load data/jeweldata.js')); };
      document.head.appendChild(s);
    });
  }
  return jewelDataPromise;
}

var FEATURE_LABEL = { spell: 'Spells', attack: 'Attacks', melee: 'Melee', projectile: 'Projectiles', area: 'Area',
  fire: 'Fire', cold: 'Cold', lightning: 'Lightning', chaos: 'Chaos', physical: 'Physical', dot: 'Damage over time',
  minion: 'Minions', totem: 'Totems', trap: 'Traps', mine: 'Mines', brand: 'Brands', staff: 'Staff', bow: 'Bow',
  wand: 'Wand', shield: 'Shield', dualwield: 'Dual wield', twohand: 'Two-handed', crit: 'Crit',
  life: 'Life', es: 'Energy shield', block: 'Block', suppress: 'Suppression', evasion: 'Evasion', armour: 'Armour' };
var JEWEL_KINDS = [
  ['regular', 'Any jewel (Crimson / Viridian / Cobalt)', 7, null, false],
  ['crimson', 'Crimson Jewel', 1, 'Crimson Jewel', false],
  ['viridian', 'Viridian Jewel', 2, 'Viridian Jewel', false],
  ['cobalt', 'Cobalt Jewel', 4, 'Cobalt Jewel', false],
  ['murderous', 'Murderous Eye (abyss, melee)', 8, 'Murderous Eye Jewel', true],
  ['searching', 'Searching Eye (abyss, ranged)', 16, 'Searching Eye Jewel', true],
  ['hypnotic', 'Hypnotic Eye (abyss, caster)', 32, 'Hypnotic Eye Jewel', true],
  ['ghastly', 'Ghastly Eye (abyss, minion)', 64, 'Ghastly Eye Jewel', true]
];
var FINDER_DEFAULT_PICKS = 8, FINDER_SHOW = 24;

// search-as-you-type box for the finder lists (fuzzy: typos, partial words, shorthand)
function makeFinderSearch(parent, placeholder, onChange) {
  var row = document.createElement('div');
  row.className = 'finder-search';
  var inp = document.createElement('input');
  inp.type = 'search';
  inp.placeholder = placeholder;
  inp.setAttribute('aria-label', 'Search');
  var count = document.createElement('span');
  count.className = 'finder-sub';
  inp.addEventListener('input', onChange);
  inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; onChange(); } });
  row.appendChild(inp);
  row.appendChild(count);
  parent.appendChild(row);
  inp.setCount = function (t) { count.textContent = t; };
  return inp;
}
// best matches first; ties keep the list's own order (relevance)
function fuzzyFilter(items, q, textOf) {
  return items.map(function (it, i) { return { it: it, i: i, s: Jewels.fuzzyScore(q, textOf(it)) }; })
    .filter(function (x) { return x.s >= 0; })
    .sort(function (a, b) { return b.s - a.s || a.i - b.i; })
    .map(function (x) { return x.it; });
}

// a card-like state so price checks, paging, live search and pins all work
function makeFinderState(label, container, payloadFn) {
  var st = { slot: label, item: { name: '', base: '', mods: [] }, rows: [], unique: false, card: null,
             customPayload: payloadFn };
  cards.push(st);
  var btns = document.createElement('div');
  btns.className = 'btns finder-actions';
  var pBtn = UI.button('primary', { cls: 'gui-only', label: 'Check price', onClick: function () { checkPrice(st); } });
  var lBtn = UI.button('secondary', { cls: 'gui-only', label: '🔴 Go live', onClick: function () { toggleLive(st); } });
  var oBtn = UI.button('secondary', { cls: 'act-search', label: 'Search on trade ↗',
    onClick: function () { var u = buildTradeUrl(st); if (u) openUrl(u); } });
  btns.appendChild(pBtn); btns.appendChild(lBtn); btns.appendChild(oBtn);
  container.appendChild(btns);
  st.priceBtn = pBtn; st.liveBtn = lBtn;
  var lBox = document.createElement('div');
  lBox.className = 'price-box live-box hidden';
  container.appendChild(lBox);
  st.liveBox = lBox;
  var prBox = document.createElement('div');
  prBox.className = 'price-box hidden';
  container.appendChild(prBox);
  st.priceBox = prBox;
  return st;
}

// numbered step panel: the jewel tools read top to bottom as 1 → 2 → 3 → 4
function finderStep(parent, n, title, hint) {
  var sec = UI.el('section', 'finder-step');
  var h = UI.el('h3', 'step-title');
  h.appendChild(UI.el('span', 'step-num', String(n)));
  h.appendChild(document.createTextNode(title));
  sec.appendChild(h);
  if (hint) sec.appendChild(UI.el('div', 'finder-sub step-hint', hint));
  parent.appendChild(sec);
  return sec;
}

function finderOpts() {
  return { status: document.getElementById('trade-status').value,
           saleType: document.getElementById('sale-type').value };
}

function makeJewelFinder(b) {
  var wrap = document.createElement('div');
  wrap.className = 'finder';
  wrap.innerHTML = '<div class="finder-loading">Reading your passive tree…</div>';
  ensureJewelData().then(function (J) { renderJewelFinder(wrap, b, J); }, function (e) {
    wrap.textContent = '❌ ' + e.message;
  });
  return wrap;
}

function renderJewelFinder(wrap, b, J) {
  wrap.textContent = '';
  var P = Jewels.profile(b, J);

  // ---- 1: what the build is about, and its sockets
  var head = finderStep(wrap, 1, 'Your build', 'What your tree and main skill scale — mods are ranked by this.');
  var focus = document.createElement('div');
  focus.className = 'finder-focus';
  focus.appendChild(document.createTextNode('Build focus: '));
  var keys = Object.keys(P.tally).filter(function (k) { return FEATURE_LABEL[k] && k !== 'life' && k !== 'es'; })
    .sort(function (a, c) { return (P.mainQ[c] ? 1e6 : 0) + P.tally[c] - ((P.mainQ[a] ? 1e6 : 0) + P.tally[a]); })
    .slice(0, 6);
  var life = P.tally.life || 0, es = P.tally.es || 0;
  keys.push(life + es ? (life > es * 1.5 ? 'life' : es > life * 1.5 ? 'es' : 'hybrid') : null);
  keys.filter(Boolean).forEach(function (k) {
    var chip = document.createElement('span');
    chip.className = 'finder-chip' + (P.mainQ[k] ? ' main' : '');
    chip.textContent = k === 'hybrid' ? 'Life + ES' : FEATURE_LABEL[k];
    var src = (P.why[k] || []).join(', ');
    chip.title = (P.mainQ[k] ? 'Your main skill is ' + FEATURE_LABEL[k].toLowerCase() + '. ' : '') +
      (src ? 'From: ' + src : '');
    focus.appendChild(chip);
  });
  head.appendChild(focus);
  var socks = Jewels.socketReport(b, J);
  var empty = socks.filter(function (s) { return !s.itemId; });
  var sline = document.createElement('div');
  sline.className = 'finder-sub';
  sline.textContent = socks.length
    ? socks.length + ' jewel socket' + (socks.length > 1 ? 's' : '') + ' allocated in your tree — ' +
      (empty.length ? empty.length + ' empty (' + empty.map(function (s) { return s.name; }).join(', ') + ')' : 'all filled') +
      (P.gems.length ? ' · main skill: ' + P.gems[0] : '')
    : 'No jewel sockets allocated' + (P.gems.length ? ' · main skill: ' + P.gems[0] : '');
  head.appendChild(sline);

  // ---- 2: what kind of jewel, and how to search
  var step2 = finderStep(wrap, 2, 'Jewel and search type');
  var ctr = document.createElement('div');
  ctr.className = 'card-opts finder-opts';
  var kindSel = makeMiniSelect(ctr, 'Jewel', JEWEL_KINDS.map(function (k) { return k[1]; }), JEWEL_KINDS[0][1]);
  var hasAbyss = Object.keys(b.items).some(function (id) { return /Eye Jewel$/.test(b.items[id].base || ''); });
  // weighted searches exceed the anonymous query budget even with 2 mods (measured) —
  // without a saved POESESSID default to the any-N-of search, which fits
  var modeSel = makeMiniSelect(ctr, 'Find', ['best for my build', 'at least N of these'],
                               HAS_SESSION ? 'best for my build' : 'at least N of these');
  if (!HAS_SESSION) modeSel.options[0].textContent = 'best for my build (needs POESESSID in-app)';
  var nSel = makeMiniSelect(ctr, 'N', ['2', '3', '4'], '2');
  var rollSel = makeMiniSelect(ctr, 'Min roll', ['any', '50%', '70%', '90%'], '50%');
  var sortSel = makeMiniSelect(ctr, 'Sort', ['best score', 'cheapest'], 'best score');
  var minQ = makeMiniSelect(ctr, 'Min quality', ['any', '30%', '45%', '60%'], '30%');
  minQ.title = 'Weighted search: minimum share of the best possible score (all your picked mods max-rolled)';
  var maxPrice = makeMiniInput(ctr, 'Max price', 'c');
  step2.appendChild(ctr);
  if (hasAbyss) {
    var note = document.createElement('div');
    note.className = 'finder-sub';
    note.textContent = 'Your gear has abyssal sockets — pick an Eye jewel type above for abyss jewels.';
    step2.appendChild(note);
  }

  // ---- 3: ranked mod list
  var step3 = finderStep(wrap, 3, 'Pick mods',
    'Want = counts toward the search · Must = every result has it. Best for your build is at the top.');
  var modSearch = makeFinderSearch(step3, 'Search mods — e.g. "crit multi", "es recharge", "minion dmg"', function () { renderList(); });
  var list = document.createElement('div');
  list.className = 'finder-mods';
  step3.appendChild(list);
  var picks = {}; // tail -> {use, required, score}
  var ranked = [];
  var showAll = false;

  function kind() { return JEWEL_KINDS.find(function (k) { return k[1] === kindSel.value; }) || JEWEL_KINDS[0]; }

  function rerank(resetPicks) {
    ranked = Jewels.rankMods(J, P, kind()[2]);
    if (resetPicks) {
      picks = {};
      ranked.slice(0, FINDER_DEFAULT_PICKS).forEach(function (m) {
        if (m.score >= 0.45) picks[m.tail] = { use: true, required: false, score: m.score };
      });
    }
    renderList();
  }

  function renderList() {
    list.textContent = '';
    var table = document.createElement('table');
    table.className = 'finder-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th scope="col">Pick</th><th scope="col">Mod</th>' +
      '<th scope="col" class="num">Best roll</th><th scope="col">Value to your build</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var q = modSearch.value.trim();
    var shown = q ? fuzzyFilter(ranked, q, function (m) { return m.text; }) : (showAll ? ranked : ranked.slice(0, FINDER_SHOW));
    modSearch.setCount(q ? shown.length + ' of ' + ranked.length + ' mods' : '');
    shown.forEach(function (m) {
      var p = picks[m.tail];
      var tr = document.createElement('tr');
      if (p && p.use) tr.className = 'on';
      var pick = UI.segmented([['off', 'Off'], ['want', 'Want'], ['must', 'Must']],
        p && p.required ? 'must' : p && p.use ? 'want' : 'off', {
          ariaLabel: m.text,
          titles: { want: 'Counts toward the search', must: 'Every result must have this mod' },
          onChange: function (v) {
            picks[m.tail] = picks[m.tail] || { score: m.score };
            picks[m.tail].use = v !== 'off';
            picks[m.tail].required = v === 'must';
            tr.classList.toggle('on', v !== 'off');
          } });
      var td1 = document.createElement('td'); td1.appendChild(pick);
      var td3 = document.createElement('td'); td3.textContent = m.text;
      var td4 = document.createElement('td'); td4.className = 'num'; td4.textContent = fmtCompact(m.max);
      var td5 = document.createElement('td');
      var val = document.createElement('input');
      val.type = 'range'; val.min = '0'; val.max = '100'; val.step = '5';
      val.value = String(Math.round(((p && p.score) || m.score) * 100));
      val.className = 'finder-val';
      val.setAttribute('aria-label', 'Value of ' + m.text + ' to your build');
      var pct = document.createElement('span');
      pct.className = 'finder-pct';
      pct.textContent = val.value + '%';
      val.addEventListener('input', function () {
        pct.textContent = val.value + '%';
        picks[m.tail] = picks[m.tail] || { use: false, score: m.score };
        picks[m.tail].score = parseInt(val.value, 10) / 100;
      });
      td5.appendChild(val); td5.appendChild(pct);
      [td1, td3, td4, td5].forEach(function (td) { tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    list.appendChild(table);
    if (!q && ranked.length > FINDER_SHOW) {
      var more = UI.button('secondary');
      more.textContent = showAll ? 'Show top ' + FINDER_SHOW : 'Show all ' + ranked.length + ' mods';
      more.addEventListener('click', function () { showAll = !showAll; renderList(); });
      list.appendChild(more);
    }
  }

  function selected() {
    return ranked.filter(function (m) { return picks[m.tail] && picks[m.tail].use; }).map(function (m) {
      return { tail: m.tail, max: m.max, score: picks[m.tail].score, required: !!picks[m.tail].required };
    });
  }

  function payload(quiet) {
    var sel = selected();
    if (!sel.length) {
      if (!quiet) UI.toast('Set at least one mod to Want or Must first.', 'warn');
      return null;
    }
    var k = kind();
    var opts = finderOpts();
    opts.abyss = k[4];
    opts.base = k[3];
    var mp = parseFloat(maxPrice.value);
    if (!isNaN(mp) && mp > 0) opts.maxPrice = mp;
    if (modeSel.value === 'at least N of these') {
      opts.count = parseInt(nSel.value, 10);
      opts.minRoll = rollSel.value === 'any' ? 0 : parseInt(rollSel.value, 10) / 100;
      return Jewels.countQuery(sel, opts);
    }
    var q = minQ.value === 'any' ? 0 : parseInt(minQ.value, 10) / 100;
    if (q) opts.minScore = Math.round(Jewels.maxScore(sel.filter(function (s) { return !s.required; }).length
      ? sel.filter(function (s) { return !s.required; }) : sel) * q);
    opts.sort = sortSel.value === 'cheapest' ? 'price' : 'score';
    return Jewels.weightedQuery(sel, opts);
  }

  function syncModeControls() {
    var count = modeSel.value === 'at least N of these';
    [nSel, rollSel].forEach(function (el) { el.parentElement.classList.toggle('hidden', !count); });
    [sortSel, minQ].forEach(function (el) { el.parentElement.classList.toggle('hidden', count); });
  }
  modeSel.addEventListener('change', syncModeControls);
  kindSel.addEventListener('change', function () { rerank(true); });
  syncModeControls();
  rerank(true);

  // ---- 4: search
  var step4 = finderStep(wrap, 4, 'Find jewels',
    '"Best for my build" scores every listed jewel by your picks (a max roll is worth its value % × 100) ' +
    'and sorts by score — in-app checks of weighted searches need a saved POESESSID (higher query budget); ' +
    'the trade-site link works while you are logged in there.');
  makeFinderState('Jewel finder', step4, payload);

}

// ---- timeless jewel finder ---------------------------------------------------------
// Python bridge (timeless.py) reads Path of Building's timeless lookup tables:
// for a chosen jewel + socket it lists every outcome the seed can give the
// notables in radius, then ranks all seeds by the outcomes you value.
var TIMELESS_TYPES = [[1, 'Glorious Vanity'], [2, 'Lethal Pride'], [3, 'Brutal Restraint'], [4, 'Militant Faith'],
                      [5, 'Elegant Hubris'], [6, 'Heroic Tragedy']];
// seeds per price check: x4 conquerors must fit the trade site's filter budget
// one conqueror = 1 filter per seed instead of up to 4
function timelessPriceSeeds(oneConqueror) {
  return oneConqueror ? (HAS_SESSION ? 30 : 20) : (HAS_SESSION ? 10 : 5);
}

function makeTimelessFinder(b) {
  var wrap = document.createElement('div');
  wrap.className = 'finder timeless-finder';
  var intro = document.createElement('div');
  intro.className = 'finder-sub finder-intro';
  intro.textContent = 'Pick a socket from your tree: every seed is checked against the notables in its radius, ' +
    'ranked by the outcomes your build wants, and the best seeds can be priced in one click. ' +
    'Covers all six: Glorious Vanity, Lethal Pride, Brutal Restraint, Militant Faith, Elegant Hubris and Heroic Tragedy.';
  wrap.appendChild(intro);
  var body = document.createElement('div');
  wrap.appendChild(body);
  if (!isGui() || !window.pywebview.api.timeless_info) {
    body.className = 'finder-sub';
    body.textContent = 'Seed ranking needs the desktop app. You can still price seeds you already know below.';
    wrap.appendChild(makeTimelessPanel());
    return wrap;
  }
  body.textContent = 'Reading your tree…';
  ensureJewelData().then(function (J) {
    return window.pywebview.api.timeless_sockets(JSON.stringify(b.tree.nodes)).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || 'socket lookup failed');
      renderTimelessFinder(body, b, J, r.sockets);
      wrap.appendChild(makeTimelessPanel());
    });
  }).catch(function (e) { body.textContent = '❌ ' + (e.message || e); });
  return wrap;
}

function nodeName(J, id) { var n = J.tree[id]; return n ? n[1] : 'node ' + id; }

function renderTimelessFinder(body, b, J, sockets) {
  body.textContent = '';
  var P = Jewels.profile(b, J);
  if (!sockets.length) {
    body.className = 'finder-sub';
    body.textContent = 'No jewel sockets are allocated in this tree — allocate one in PoB first.';
    return;
  }
  // timeless jewels the build already has socketed: {socket, jewel, seed} — their
  // sockets come first (the default), then the ones covering most of your notables
  var owned = ownedTimeless(b);
  function ownedAt(sock) { return owned.find(function (o) { return o.socket === sock; }); }
  sockets.sort(function (x, y) {
    return (ownedAt(y.socket) ? 1 : 0) - (ownedAt(x.socket) ? 1 : 0) || y.notables.length - x.notables.length;
  });
  var ctr = document.createElement('div');
  ctr.className = 'card-opts finder-opts';
  var jewelSel = makeMiniSelect(ctr, 'Jewel', TIMELESS_TYPES.map(function (t) { return t[1]; }), 'Brutal Restraint');
  // conqueror decides the keystone; the seed decides the notables
  var conqSel = UI.select([]);
  UI.field('Conqueror', conqSel, { parent: ctr,
    title: 'The conqueror only changes the keystone. Pricing searches this conqueror, or all of them with "any".' });
  function fillConquerors(prefer) {
    var keep = prefer !== undefined ? prefer : conqSel.value;
    conqSel.textContent = '';
    ['any'].concat(Jewels.TIMELESS[jewelSel.value] || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c === 'any' ? 'any (keystone doesn\'t matter)'
        : c.charAt(0).toUpperCase() + c.slice(1) + ' — ' + (Jewels.KEYSTONES[c] || '');
      conqSel.appendChild(o);
    });
    conqSel.value = Array.prototype.some.call(conqSel.options, function (o) { return o.value === keep; }) ? keep : 'any';
  }
  // default conqueror for the current jewel + socket: your jewel's, else PoB's saved search
  function defaultConqueror() {
    var mine = owned.find(function (o) { return String(o.socket) === sockSel.value && o.jewel === jewelSel.value; });
    if (mine && mine.conqueror) return mine.conqueror;
    var ts = b.timelessSearch;
    if (ts && ts.jewelTypeId === jtype()) return Jewels.pobConqueror(ts.jewelTypeId, ts.conquerorTypeId) || 'any';
    return 'any';
  }
  var sockSel = UI.select(sockets.map(function (s) {
    var names = s.notables.map(function (n) { return nodeName(J, n); });
    var mineHere = ownedAt(s.socket);
    var text = (mineHere ? '★ Your ' + mineHere.jewel + ' ' + mineHere.seed + ' — ' : '') + (names.length
      ? 'socket near ' + names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '') +
        ' (' + names.length + ' of your notables)'
      : 'socket ' + s.socket + ' (none of your notables in radius)');
    return [String(s.socket), text.charAt(0).toUpperCase() + text.slice(1)];
  }));
  UI.field('Socket', sockSel, { parent: ctr });
  var unalloc = makeToggle(ctr, 'Also count unallocated notables', false);
  unalloc.checkbox.parentElement.title = 'Include notables in radius you have not taken — a good seed can make pathing to them worth it';
  var step1 = finderStep(body, 1, 'Jewel and socket',
    'The seed decides what each notable in the radius becomes; the conqueror only changes the keystone.');
  step1.appendChild(ctr);

  var summary = document.createElement('div');
  summary.className = 'finder-sub';
  step1.appendChild(summary);
  var step2 = finderStep(body, 2, 'What you want',
    'Tick the outcomes you want. Need × drops seeds with fewer; drag a value left of zero to avoid an outcome.');
  var importedNote = document.createElement('div');
  importedNote.className = 'finder-sub';
  step2.appendChild(importedNote);
  var outcomeSearch = makeFinderSearch(step2, 'Search outcomes — e.g. "minion", "crit", "flask"', function () { if (info) renderOutcomes(); });
  var suggestBtn = UI.button('secondary');
  suggestBtn.textContent = '✨ Suggest for my build';
  suggestBtn.title = 'Tick the outcomes that match what your tree and main skill scale (value 50% or more)';
  suggestBtn.addEventListener('click', function () {
    if (!info) return;
    Object.keys(values).forEach(function (k) { if (values[k].value >= 50) values[k].use = true; });
    renderOutcomes();
  });
  var clearBtn = UI.button('secondary');
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', function () {
    if (!info) return;
    Object.keys(values).forEach(function (k) { values[k].use = false; values[k].need = 0; });
    renderOutcomes();
  });
  outcomeSearch.parentElement.appendChild(suggestBtn);
  outcomeSearch.parentElement.appendChild(clearBtn);
  var outcomesBox = document.createElement('div');
  step2.appendChild(outcomesBox);
  var findBtn = UI.button('primary');
  findBtn.textContent = '🔎 Find best seeds';
  var resultsBox = document.createElement('div');
  resultsBox.className = 'timeless-results';
  var step3 = finderStep(body, 3, 'Best seeds', 'Every seed is scored against your picks; price the top ones in one click.');
  step3.appendChild(findBtn);
  step3.appendChild(resultsBox);

  var info = null, values = {}, seq = 0;
  var priced = { name: '', seeds: [] };

  function jtype() { return TIMELESS_TYPES.find(function (t) { return t[1] === jewelSel.value; })[0]; }

  function load() {
    var my = ++seq;
    summary.textContent = 'Loading ' + jewelSel.value + ' data (the first time downloads ' +
      (jtype() === 1 ? '~22 MB' : '~2 MB') + ' from Path of Building)…';
    outcomesBox.textContent = '';
    resultsBox.textContent = '';
    fillConquerors(defaultConqueror());
    window.pywebview.api.timeless_info(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes)).then(function (r) {
      if (my !== seq) return;
      if (!r || !r.ok) { summary.textContent = '❌ ' + ((r && r.error) || 'failed'); return; }
      info = r;
      // nothing is picked for you unless the build carries PoB's own timeless search
      // weights; values are pre-filled from what the build scales, Suggest ticks them
      values = {};
      r.outcomes.forEach(function (o) {
        values[o.key] = { use: false, value: Math.round(Jewels.scoreText(P, o.sd.join('\n')) * 100), need: 0 };
      });
      importedNote.textContent = '';
      var ts = b.timelessSearch;
      if (ts && ts.searchList.length && (!ts.jewelTypeId || ts.jewelTypeId === jtype())) {
        var maxW = Math.max.apply(null, ts.searchList.map(function (x) { return Math.abs(x.weight1) || 0; }).concat([1]));
        var n = 0;
        ts.searchList.forEach(function (row) {
          var o = r.outcomes.find(function (x) { return x.id === row.id; });
          if (!o) return;
          values[o.key] = { use: true, value: Math.max(-100, Math.min(100, Math.round(100 * row.weight1 / maxW))),
                            need: row.minimum > 0 ? 1 : 0 };
          n++;
        });
        if (n) importedNote.textContent = '✔ Imported ' + n + ' outcome weight' + (n > 1 ? 's' : '') +
          ' from this build\'s Path of Building timeless search.';
      }
      if (!importedNote.textContent) {
        importedNote.textContent = 'Nothing is ticked yet: tick the outcomes you want (search below), or let ✨ Suggest pick from what your build scales.';
      }
      var allocN = r.notables.filter(function (n) { return n.allocated; }).length;
      var allocS = r.smalls.filter(function (n) { return n.allocated; }).length;
      summary.textContent = r.notables.length + ' notables in radius (' + allocN + ' yours) · ' +
        r.smalls.length + ' small passives (' + allocS + ' yours): ' + r.small +
        (r.keystones.length ? ' · keystones in radius: ' + r.keystones.map(function (k) { return nodeName(J, k); }).join(', ') +
          ' (changed by the conqueror, not the seed)' : '');
      renderOutcomes();
      showCurrentSeed(my);
    }, function (e) { if (my === seq) summary.textContent = '❌ ' + e; });
  }

  // the jewel the build already has in this socket (opened from its card)
  var currentSeed = null; // {jewel, seed}
  var currentBox = document.createElement('div');
  currentBox.className = 'timeless-current';
  function showCurrentSeed(my) {
    currentBox.textContent = '';
    // explicit preset (from a card), else a jewel the build already has in this socket
    var mine = owned.find(function (o) { return String(o.socket) === sockSel.value && o.jewel === jewelSel.value; });
    if ((!currentSeed || currentSeed.jewel !== jewelSel.value) && mine) currentSeed = { jewel: mine.jewel, seed: mine.seed };
    if (!currentSeed || currentSeed.jewel !== jewelSel.value) return;
    window.pywebview.api.timeless_seed(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes),
                                       currentSeed.seed, unalloc.checkbox.checked).then(function (r) {
      if (my !== seq || !r || !r.ok) { if (r && !r.ok) currentBox.textContent = '❌ ' + r.error; return; }
      var score = 0;
      var title = document.createElement('b');
      title.textContent = 'Your jewel (seed ' + r.seed + ') here: ';
      currentBox.appendChild(title);
      r.notables.forEach(function (p, i) {
        var w = entryWeight(p);
        score += w;
        var span = document.createElement('span');
        span.className = w > 0 ? 'ts-hit' : w < 0 ? 'ts-avoid' : 'ts-miss';
        span.textContent = nodeName(J, p.node) + ' → ' + entryLabel(p);
        if (i) currentBox.appendChild(document.createTextNode(' · '));
        currentBox.appendChild(span);
      });
      currentBox.appendChild(document.createTextNode('  — score ' + score.toFixed(2) +
        ' with your current picks. Find best seeds to compare.'));
    });
  }
  step1.appendChild(currentBox);

  // open on a given jewel/socket (from a timeless jewel card in the build)
  timelessApplyPreset = function (p) {
    if (p.jewel && TIMELESS_TYPES.some(function (t) { return t[1] === p.jewel; })) jewelSel.value = p.jewel;
    if (p.socket) {
      var sv = String(p.socket);
      if (!Array.prototype.some.call(sockSel.options, function (o) { return o.value === sv; })) {
        var o = document.createElement('option');
        o.value = sv;
        o.textContent = 'Socket ' + sv + ' (your jewel\'s socket)';
        sockSel.appendChild(o);
      }
      sockSel.value = sv;
    }
    currentSeed = p.seed ? { jewel: p.jewel, seed: p.seed } : null;
    load();
  };

  function renderOutcomes() {
    outcomesBox.textContent = '';
    var table = document.createElement('table');
    table.className = 'finder-table';
    table.innerHTML = '<caption class="finder-sub">Everything a ' + esc(jewelSel.value) + ' can do to a notable here, across all seeds — ' +
      'tick what you want, then <b>Find best seeds</b>. Small passives always get: ' + esc(info.small) + '.</caption>' +
      '<thead><tr><th scope="col">Use</th><th scope="col">Possible outcome on a notable</th>' +
      '<th scope="col" class="num" title="Share of (seed, notable) pairs at this socket that get this outcome">Chance</th><th scope="col" class="num" title="Minimum number of your notables that must get this — seeds with fewer are dropped">Need ×</th>' +
      '<th scope="col">Value to your build (left = avoid)</th></tr></thead>';
    var tbody = document.createElement('tbody');
    var maxNeed = Math.max(1, info.notables.filter(function (n) { return n.allocated || unalloc.checkbox.checked; }).length);
    var oq = outcomeSearch.value.trim();
    var shownOutcomes = oq ? fuzzyFilter(info.outcomes, oq, function (o) { return o.dn + ' ' + o.sd.join(' '); }) : info.outcomes;
    outcomeSearch.setCount(oq ? shownOutcomes.length + ' of ' + info.outcomes.length + ' outcomes' : '');
    shownOutcomes.forEach(function (o) {
      var st = values[o.key];
      var tr = document.createElement('tr');
      if (st.use) tr.className = 'on';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = st.use;
      cb.setAttribute('aria-label', 'Use ' + o.dn);
      cb.addEventListener('change', function () {
        st.use = cb.checked; tr.classList.toggle('on', cb.checked);
        if (!cb.checked) { st.need = 0; need.value = ''; }
      });
      var need = document.createElement('input');
      need.type = 'number'; need.min = '0'; need.max = String(maxNeed); need.step = '1';
      need.className = 'min-input ts-need';
      need.placeholder = '–';
      need.value = st.need ? String(st.need) : '';
      need.setAttribute('aria-label', 'At least this many notables with ' + o.dn);
      need.addEventListener('change', function () {
        st.need = Math.max(0, Math.min(maxNeed, parseInt(need.value, 10) || 0));
        need.value = st.need ? String(st.need) : '';
        if (st.need) { st.use = true; cb.checked = true; tr.classList.add('on'); }
      });
      var td1 = document.createElement('td'); td1.appendChild(cb);
      var td2 = document.createElement('td');
      var name = document.createElement('b');
      name.textContent = (o.replace ? 'Becomes ' : '') + o.dn;
      td2.appendChild(name);
      td2.appendChild(document.createTextNode(' — ' + o.sd.join(' · ')));
      var td3 = document.createElement('td'); td3.className = 'num';
      td3.textContent = (o.share * 100).toFixed(1) + '%';
      var tdN = document.createElement('td'); tdN.className = 'num'; tdN.appendChild(need);
      var td4 = document.createElement('td');
      var val = document.createElement('input');
      val.type = 'range'; val.min = '-100'; val.max = '100'; val.step = '5'; val.value = String(st.value);
      val.className = 'finder-val';
      val.setAttribute('aria-label', 'Value of ' + o.dn + ' (negative avoids it)');
      var pct = document.createElement('span');
      pct.className = 'finder-pct';
      function showVal() { pct.textContent = st.value < 0 ? 'avoid ' + (-st.value) + '%' : st.value + '%'; pct.classList.toggle('avoid', st.value < 0); }
      showVal();
      val.addEventListener('input', function () {
        st.value = parseInt(val.value, 10);
        showVal();
        if (st.value < 0 && !st.use) { st.use = true; cb.checked = true; tr.classList.add('on'); }
      });
      td4.appendChild(val); td4.appendChild(pct);
      [td1, td2, td3, tdN, td4].forEach(function (td) { tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    outcomesBox.appendChild(table);
  }

  findBtn.addEventListener('click', function () {
    if (!info) return;
    var weights = {}, mins = {};
    Object.keys(values).forEach(function (k) {
      if (!values[k].use) return;
      if (values[k].value) weights[k] = values[k].value / 100;
      if (values[k].need > 0) mins[k] = values[k].need;
    });
    var anyWant = Object.keys(weights).some(function (k) { return weights[k] > 0; }) || Object.keys(mins).length;
    if (!anyWant) { resultsBox.textContent = 'Tick at least one outcome you want (or set a Need ×).'; return; }
    var my = ++seq;
    resultsBox.textContent = 'Checking every ' + jewelSel.value + ' seed…';
    lastMins = mins;
    window.pywebview.api.timeless_search(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes),
                                         JSON.stringify(weights), unalloc.checkbox.checked,
                                         JSON.stringify(mins)).then(function (r) {
      if (my !== seq) return;
      if (!r || !r.ok) { resultsBox.textContent = '❌ ' + ((r && r.error) || 'failed'); return; }
      renderSeeds(r);
    }, function (e) { if (my === seq) resultsBox.textContent = '❌ ' + e; });
  });

  function outcomeLabel(key) {
    var o = info.outcomes.find(function (x) { return x.key === key; });
    return o ? o.dn : key;
  }
  var lastMins = {};

  // "Minion Damage ×3 (60%)": count, plus the summed value when the outcome is
  // a single fixed number ("Minions deal 20% increased Damage")
  // one notable's result: "Might of the Vaal: Fire Damage 12, Life 3" / "Ritual of Flesh [8/27]"
  function entryLabel(p) {
    var keys = p.keys || [p.key];
    function rollTxt(k) {
      var r = p.rolls && p.rolls[k];
      return r === undefined || r === null ? '' : Array.isArray(r) ? ' [' + r.join('/') + ']' : ' ' + r;
    }
    var head = outcomeLabel(keys[0]) + rollTxt(keys[0]);
    return keys.length > 1 ? head + ': ' + keys.slice(1).map(function (k) { return outcomeLabel(k) + rollTxt(k); }).join(', ') : head;
  }
  function entryWeight(p) {
    return (p.keys || [p.key]).reduce(function (s, k) {
      var v = values[k];
      return s + (v && v.use ? v.value / 100 : 0);
    }, 0);
  }

  function outcomeTotal(key, n, rollTotal) {
    var o = info.outcomes.find(function (x) { return x.key === key; });
    var label = (o ? o.dn.replace(/^Add /, '') : key) + ' ×' + n;
    if (rollTotal) { // Glorious Vanity rolls: show the summed value
      return label + ' (+' + rollTotal + (o && /%/.test(o.sd.join(' ')) ? '%' : '') + ')';
    }
    if (o && o.sd.length === 1) {
      var m = o.sd[0].match(/([+-]?)(\d+(?:\.\d+)?)(%?)/);
      if (m && !/\(\d/.test(o.sd[0])) label += ' (' + m[1] + (Math.round(parseFloat(m[2]) * n * 10) / 10) + m[3] + ')';
    }
    return label;
  }

  function renderSeeds(r) {
    resultsBox.textContent = '';
    if (!r.results.length) {
      resultsBox.textContent = 'No seed gives any of the ticked outcomes on ' +
        (unalloc.checkbox.checked ? 'these notables' : 'your allocated notables') + ' here.';
      return;
    }
    var head = document.createElement('div');
    head.className = 'finder-sub';
    var needTxt = Object.keys(lastMins).map(function (k) { return outcomeLabel(k).replace(/^Add /, '') + ' ×' + lastMins[k] + '+'; });
    head.textContent = r.matches + ' seeds ' + (needTxt.length ? 'meet ' + needTxt.join(' and ') : 'give at least one wanted outcome') +
      ' on the ' + r.considered.length + ' notable' + (r.considered.length === 1 ? '' : 's') + ' counted. Best ' + r.results.length + ':';
    resultsBox.appendChild(head);
    var priceTop = UI.button('secondary');
    var oneConq = conqSel.value !== 'any';
    priceTop.textContent = '💰 Price the top ' + Math.min(timelessPriceSeeds(oneConq), r.results.length) + ' seeds' +
      (oneConq ? ' (' + conqSel.value.charAt(0).toUpperCase() + conqSel.value.slice(1) + ')' : ' (any conqueror)');
    if (!HAS_SESSION) priceTop.title = 'Saving a POESESSID raises how many seeds fit in one trade search';
    priceTop.addEventListener('click', function () {
      priced.name = jewelSel.value;
      priced.conqueror = conqSel.value === 'any' ? '' : conqSel.value;
      priced.seeds = r.results.slice(0, timelessPriceSeeds(!!priced.conqueror)).map(function (x) { return x.seed; });
      checkPrice(priceState);
    });
    resultsBox.appendChild(priceTop);
    var table = document.createElement('table');
    table.className = 'finder-table timeless-seeds';
    table.innerHTML = '<thead><tr><th scope="col" class="num">Seed</th><th scope="col" class="num">Score</th>' +
      '<th scope="col">What your notables become</th><th scope="col"></th></tr></thead>';
    var tbody = document.createElement('tbody');
    r.results.forEach(function (x) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); td1.className = 'num'; td1.textContent = x.seed;
      var td2 = document.createElement('td'); td2.className = 'num'; td2.textContent = x.score.toFixed(2);
      var td3 = document.createElement('td');
      // headline: totals of the outcomes you care about (wanted first, then avoided)
      var tot = document.createElement('div');
      tot.className = 'ts-totals';
      Object.keys(x.counts || {}).filter(function (k) { return values[k] && values[k].use; })
        .sort(function (a, c) { return (values[c].value - values[a].value) || (x.counts[c] - x.counts[a]); })
        .forEach(function (k, i) {
          var chip = document.createElement('span');
          chip.className = values[k].value < 0 ? 'ts-avoid' : 'ts-hit';
          chip.textContent = outcomeTotal(k, x.counts[k], x.rollTotals && x.rollTotals[k]);
          if (i) tot.appendChild(document.createTextNode(' · '));
          tot.appendChild(chip);
        });
      if (!tot.childNodes.length) tot.textContent = '—';
      td3.appendChild(tot);
      var det = document.createElement('details');
      var sm = document.createElement('summary');
      sm.textContent = 'per notable';
      det.appendChild(sm);
      x.notables.forEach(function (p, i) {
        var span = document.createElement('span');
        span.className = p.weight > 0 ? 'ts-hit' : p.weight < 0 ? 'ts-avoid' : 'ts-miss';
        span.textContent = nodeName(J, p.node) + ' → ' + entryLabel(p);
        if (i) det.appendChild(document.createTextNode(' · '));
        det.appendChild(span);
      });
      td3.appendChild(det);
      var td4 = document.createElement('td');
      var pb = UI.button('secondary');
      pb.textContent = 'Price';
      pb.title = 'Find listings of this ' + jewelSel.value + ' seed (' +
        (conqSel.value === 'any' ? 'any conqueror' : conqSel.value) + ')';
      pb.addEventListener('click', function () {
        priced.name = jewelSel.value;
        priced.conqueror = conqSel.value === 'any' ? '' : conqSel.value;
        priced.seeds = [x.seed];
        checkPrice(priceState);
      });
      td4.appendChild(pb);
      [td1, td2, td3, td4].forEach(function (td) { tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    resultsBox.appendChild(table);
    resultsBox.appendChild(priceBlock);
  }

  // price box for the chosen seeds — the normal listing view, live search, pins
  var priceBlock = document.createElement('div');
  var priceState = makeFinderState('Timeless jewel', priceBlock, function (quiet) {
    if (!priced.seeds.length) { if (!quiet) UI.toast('Find seeds first, then price them.', 'warn'); return null; }
    var o = finderOpts(); o.anonymous = !HAS_SESSION;
    var q = Jewels.timelessQuery(priced.name, priced.seeds, priced.conqueror || '', o);
    return { query: q.query, sort: q.sort };
  });

  [jewelSel, sockSel].forEach(function (el) { el.addEventListener('change', load); });
  if (!timelessPending && owned.length) {
    // open on the build's own timeless jewel: its type, its socket, its seed
    timelessPending = { jewel: owned[0].jewel, socket: owned[0].socket, seed: owned[0].seed };
  } else if (!timelessPending && b.timelessSearch && b.timelessSearch.jewelTypeId) {
    // no jewel yet, but the build author set up PoB's timeless search: start there
    var tsType = TIMELESS_TYPES.find(function (t) { return t[0] === b.timelessSearch.jewelTypeId; });
    if (tsType) timelessPending = { jewel: tsType[1], socket: b.timelessSearch.socketId || null, seed: null };
  }
  if (timelessPending) { var pend = timelessPending; timelessPending = null; timelessApplyPreset(pend); }
  else load();
}

// Timeless jewels socketed in the build's tree, with their seeds read from the mod text
var TIMELESS_SEED_RE = /^(?:Bathed in the blood of|Commanded leadership over|Denoted service of|Carved to glorify|Commissioned|Remembrancing) (\d+)/i;
function ownedTimeless(b) {
  var out = [];
  ((b.tree && b.tree.sockets) || []).forEach(function (s) {
    var item = s.itemId && b.items[s.itemId];
    if (!item) return;
    var name = resolveUniqueName(item.name);
    if (!TIMELESS_TYPES.some(function (t) { return t[1] === name; })) return;
    var seed = null, conq = '';
    (item.mods || []).some(function (m) {
      var x = TIMELESS_SEED_RE.exec(m.line);
      if (!x) return false;
      seed = parseInt(x[1], 10);
      // the line ends with the conqueror: "…in the akhara of Balbala"
      var last = (m.line.match(/(\w+)\s*$/) || [])[1];
      if (last && (Jewels.TIMELESS[name] || []).indexOf(last.toLowerCase()) !== -1) conq = last.toLowerCase();
      return true;
    });
    if (seed) out.push({ socket: s.nodeId, jewel: name, seed: seed, conqueror: conq });
  });
  return out;
}

// "Find seeds for this socket" on a timeless jewel card → Timeless tab, preset
var timelessApplyPreset = null, timelessPending = null;
function openTimelessFor(state) {
  var itemId = build && Object.keys(build.items).find(function (k) { return build.items[k] === state.item; });
  var sock = itemId && build.tree && build.tree.sockets.find(function (s) { return s.itemId === itemId; });
  var seedRow = state.rows.find(function (r) { return r.match && /^explicit\.pseudo_timeless_jewel_/.test(r.match.entry.id); });
  var seed = seedRow ? Math.round(parseFloat(seedRow.minInput.value)) : null;
  var preset = { jewel: state.resolvedName, socket: sock ? sock.nodeId : null, seed: seed && !isNaN(seed) ? seed : null };
  setView('timeless');
  if (timelessApplyPreset) timelessApplyPreset(preset);
  else timelessPending = preset;
  window.scrollTo(0, 0);
}

function makeTimelessPanel() {
  var box = document.createElement('details');
  box.className = 'finder-timeless';
  var sum = document.createElement('summary');
  sum.textContent = 'Price seeds you already have';
  box.appendChild(sum);
  var p = document.createElement('div');
  p.className = 'finder-sub';
  p.appendChild(document.createTextNode('Find the seeds you want with the '));
  var a = document.createElement('a');
  a.href = '#';
  a.textContent = 'timeless jewel calculator ↗';
  a.addEventListener('click', function (e) { e.preventDefault(); openUrl('https://vilsol.github.io/timeless-jewels/tree'); });
  p.appendChild(a);
  p.appendChild(document.createTextNode(', then paste them here to see every listing with those seeds.'));
  box.appendChild(p);
  var ctr = document.createElement('div');
  ctr.className = 'card-opts';
  var names = Object.keys(Jewels.TIMELESS);
  var jewelSel = makeMiniSelect(ctr, 'Jewel', names, names[0]);
  var conqSel = makeMiniSelect(ctr, 'Conqueror', ['any'], 'any');
  function fillConq() {
    conqSel.innerHTML = '';
    ['any'].concat(Jewels.TIMELESS[jewelSel.value]).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c === 'any' ? 'any' : c.charAt(0).toUpperCase() + c.slice(1);
      conqSel.appendChild(o);
    });
  }
  jewelSel.addEventListener('change', fillConq);
  fillConq();
  var seeds = UI.input({ cls: 'finder-seeds', placeholder: 'Seeds, e.g. 4521, 7790, 12003' });
  UI.field('Seeds', seeds, { parent: ctr });
  box.appendChild(ctr);
  var warn = document.createElement('div');
  warn.className = 'finder-sub';
  box.appendChild(warn);
  makeFinderState('Timeless jewel', box, function (quiet) {
    var s = Jewels.parseSeeds(seeds.value);
    if (!s.length) { if (!quiet) UI.toast('Enter at least one seed number.', 'warn'); return null; }
    var q = Jewels.timelessQuery(jewelSel.value, s, conqSel.value === 'any' ? '' : conqSel.value, finderOpts());
    warn.textContent = q.truncated ? 'Too many seed × conqueror combinations — searching the first 40. Pick a conqueror or fewer seeds.' : '';
    return { query: q.query, sort: q.sort };
  });
  return box;
}
