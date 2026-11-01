/* js/app/20-unique-jewels.js — Watcher's Eye, Forbidden Flame/Flesh and Thread of Hope finder.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Data: data/watcherseye.js (tools/make_watcherseye.py: the CURRENT mod pool from Path of
// Building, legacy mods dropped, every stat id checked against the trade site) and
// data/forbidden.js (tools/make_forbidden.py: ascendancy notables + Thread of Hope rings).
// Every search here runs on a click; "price each pair / notable / size" are paced batches
// with a Stop button (runBatch), never on their own.

var UJ_MAX_PAIRS = 21;   // 7 ticked mods; more would be a long batch at the trade site's pace
var UJ_MAX_TRIPLES = 10; // 5 ticked mods

function wePool() { return window.POE_WATCHERS_EYE || []; }
function weAuras() {
  var seen = [];
  wePool().forEach(function (m) { if (seen.indexOf(m.aura) === -1) seen.push(m.aura); });
  return seen;
}
// auras the build actually runs (enabled gems), by name; Vaal versions count
function buildAuras(b) {
  var have = [];
  ((b && b.gemGroups) || []).forEach(function (g) {
    g.gems.forEach(function (gem) {
      var n = gem.name.replace(/^Vaal /, '');
      if (weAuras().indexOf(n) !== -1 && have.indexOf(n) === -1) have.push(n);
    });
  });
  return have;
}

// search settings shared with every other search (sale type, listed within, priced in)
function settingsTradeFilters() {
  var tf = {};
  var saleType = document.getElementById('sale-type').value;
  if (saleType !== 'any') tf.sale_type = { option: saleType };
  var listed = document.getElementById('listed-within').value;
  if (listed) tf.indexed = { option: listed };
  var pricedIn = pricedInFilter(null);
  if (pricedIn) tf.price = pricedIn;
  return Object.keys(tf).length ? { trade_filters: { filters: tf } } : null;
}

function ujPayload(name, type, groups) {
  var q = { status: { option: document.getElementById('trade-status').value }, name: name, type: type, stats: groups };
  var f = settingsTradeFilters();
  if (f) q.filters = f;
  return { query: q, sort: { price: 'asc' } };
}

// one in-app search → { total, cheapest (chaos), listings } (listings with .chaos added)
async function ujSearch(payload) {
  var league = document.getElementById('league').value;
  var r = await window.pywebview.api.trade_search(league, JSON.stringify(payload));
  if (!r || !r.ok) throw new Error((r && r.error) || 'search failed');
  var curs = [];
  r.listings.forEach(function (li) { if (li.currency && curs.indexOf(li.currency) === -1) curs.push(li.currency); });
  var rates = await craftRates(league, curs);
  var cheapest = null;
  r.listings.forEach(function (li) {
    var rate = rates[li.currency];
    li.chaos = li.amount != null && rate !== undefined ? li.amount * rate : null;
    if (li.chaos != null && (cheapest === null || li.chaos < cheapest)) cheapest = li.chaos;
  });
  return { total: r.total || 0, cheapest: cheapest, listings: r.listings };
}

function ujTradeLink(payload, label) {
  return UI.button('ghost', { size: 'sm', label: label || 'Search on trade ↗',
    title: 'Opens this search on pathofexile.com/trade (' + document.getElementById('league').value + ')',
    onClick: function () { openUrl(tradeUrlFor(document.getElementById('league').value, JSON.stringify(payload))); } });
}

function ujListings(box, res, keepMod) {
  box.textContent = '';
  if (!res.listings.length) { box.appendChild(UI.el('div', 'finder-sub', 'None listed right now.')); return; }
  box.appendChild(UI.el('div', 'finder-sub', res.total + ' listed · cheapest ' +
    (res.cheapest != null ? fmtEq(res.cheapest, document.getElementById('league').value) : '?')));
  res.listings.slice(0, 10).forEach(function (li) {
    var row = UI.el('div', 'uj-listing');
    row.appendChild(UI.el('b', 'uj-price', li.amount != null ? fmtCompact(li.amount) + ' ' + (li.currency || '') : 'no price'));
    var mods = (li.explicitMods || []).map(function (m) { return typeof m === 'string' ? m : m.text || ''; })
      .filter(function (t) { return !keepMod || keepMod(t); });
    row.appendChild(UI.el('span', 'uj-mods', mods.join(' · ')));
    row.appendChild(UI.el('span', 'finder-sub', (li.account || '') + (li.online === false ? ' (offline)' : '')));
    if (li.whisper && isGui()) {
      var b = UI.button('secondary', { size: 'sm', label: '⚡ Whisper', title: 'Pastes the whisper into the PoE chat and sends it',
        onClick: function () { sendPoeChat(b, li.whisper, '⚡ Whisper'); } });
      row.appendChild(b);
    } else if (li.whisper) {
      row.appendChild(UI.button('ghost', { size: 'sm', label: 'Copy whisper', onClick: function () {
        navigator.clipboard.writeText(li.whisper).then(function () { UI.toast('Whisper copied: paste it in game.', 'success'); });
      } }));
    }
    box.appendChild(row);
  });
}

function ujError(box, e) {
  box.textContent = '';
  var msg = String((e && e.message) || e);
  box.appendChild(UI.el('div', 'finder-sub', isCooldownError(msg) ? 'Trade site cooldown, try again in a minute.' : '❌ ' + msg));
}

// ---- the view ----------------------------------------------------------------------------
function makeUniqueJewels(b) {
  var wrap = UI.el('div', 'finder uj');
  var tabs = UI.segmented([['we', 'Watcher\'s Eye'], ['forbidden', 'Forbidden Flame & Flesh'], ['thread', 'Thread of Hope']], 'we', {
    ariaLabel: 'Which jewel', onChange: function (v) { show(v); } });
  wrap.appendChild(tabs);
  var body = UI.el('div', 'uj-body');
  wrap.appendChild(body);
  function show(v) {
    body.textContent = '';
    if (v === 'we') renderWatchersEye(body, b);
    else if (v === 'forbidden') renderForbidden(body, b);
    else renderThread(body);
  }
  show('we');
  return wrap;
}

// ---- Watcher's Eye -----------------------------------------------------------------------
function renderWatchersEye(body, b) {
  if (!wePool().length) { body.appendChild(UI.el('div', 'finder-sub', 'Watcher\'s Eye data is missing (data/watcherseye.js).')); return; }
  var picked = buildAuras(b);
  var ticked = {}; // stat id -> { mod, minInput }
  var step1 = finderStep(body, 1, 'Your auras', picked.length
    ? 'Picked from your build\'s gems. Click to add or remove.'
    : 'No auras found in this build: pick the ones you run.');
  var chips = UI.el('div', 'uj-auras');
  weAuras().forEach(function (a) {
    var c = UI.el('button', 'uj-aura' + (picked.indexOf(a) !== -1 ? ' is-on' : ''), a);
    c.type = 'button';
    c.setAttribute('aria-pressed', picked.indexOf(a) !== -1 ? 'true' : 'false');
    c.addEventListener('click', function () {
      var i = picked.indexOf(a);
      if (i === -1) picked.push(a); else picked.splice(i, 1);
      c.classList.toggle('is-on', i === -1);
      c.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
      renderMods();
    });
    chips.appendChild(c);
  });
  step1.appendChild(chips);

  var step2 = finderStep(body, 2, 'Mods you want', 'Tick the mods worth having. A minimum is optional (blank = any roll).');
  var legacyWrap = UI.el('label', 'toggle');
  var showLegacy = document.createElement('input');
  showLegacy.type = 'checkbox';
  showLegacy.addEventListener('change', function () { renderMods(); });
  legacyWrap.appendChild(showLegacy);
  legacyWrap.appendChild(UI.el('span', null, 'Include legacy mods (old jewels: they no longer roll but still trade)'));
  step2.appendChild(legacyWrap);
  var modsBox = UI.el('div', 'uj-mods-list');
  step2.appendChild(modsBox);
  function renderMods() {
    modsBox.textContent = '';
    if (!picked.length) { modsBox.appendChild(UI.el('div', 'finder-sub', 'Pick at least one aura above.')); }
    picked.forEach(function (aura) {
      modsBox.appendChild(UI.el('div', 'uj-aura-head', aura));
      wePool().filter(function (m) { return m.aura === aura && (!m.legacy || showLegacy.checked); }).forEach(function (m) {
        var row = UI.el('label', 'uj-mod');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        var key = m.ids[0];
        cb.checked = !!ticked[key];
        var min = UI.input({ type: 'number', placeholder: m.min != null ? 'min' : '', width: '70px',
          ariaLabel: 'Minimum for ' + m.text, value: ticked[key] ? ticked[key].minInput.value : '' });
        min.disabled = m.min == null;
        cb.addEventListener('change', function () {
          if (cb.checked) ticked[key] = { mod: m, minInput: min }; else delete ticked[key];
          updateMatch();
        });
        min.addEventListener('input', function () { if (ticked[key]) ticked[key].minInput = min; });
        if (ticked[key]) ticked[key].minInput = min;
        row.appendChild(cb);
        row.appendChild(UI.el('span', 'uj-mod-text', m.text.replace(' while affected by ' + aura, '')));
        if (m.legacy) {
          var lg = UI.chip('legacy', 'warn');
          lg.title = 'No longer rolls on new Watcher\'s Eyes; old jewels with it still trade';
          row.appendChild(lg);
        }
        row.appendChild(UI.el('span', 'finder-sub', m.min != null ? '(' + m.min + '–' + m.max + ')' : ''));
        row.appendChild(min);
        modsBox.appendChild(row);
      });
    });
    // forget ticks for auras that were removed
    Object.keys(ticked).forEach(function (k) {
      if (picked.indexOf(ticked[k].mod.aura) === -1 || (ticked[k].mod.legacy && !showLegacy.checked)) delete ticked[k];
    });
    updateMatch();
  }

  var step3 = finderStep(body, 3, 'Search', 'Watcher\'s Eye rolls 2 or 3 of these. "Any 2" finds every jewel with at least two of your ticked mods.');
  var controls = UI.el('div', 'uj-controls');
  var matchSel = UI.select([['1', 'Any 1'], ['2', 'Any 2'], ['3', 'Any 3'], ['all', 'All ticked']], '2', { ariaLabel: 'How many must match' });
  UI.field('Match', matchSel, { parent: controls });
  var out = UI.el('div', 'uj-out');
  var linkSlot = UI.el('span');
  controls.appendChild(linkSlot);
  var checkBtn = UI.button('primary', { size: 'sm', cls: 'gui-only', label: 'Check price', onClick: async function () {
    var p = wePayload();
    if (!p) return;
    checkBtn.disabled = true;
    out.textContent = 'Searching…';
    try { ujListings(out, await ujSearch(p), function (t) { return / while affected by /.test(t); }); }
    catch (e) { ujError(out, e); }
    finally { checkBtn.disabled = false; }
  } });
  controls.appendChild(checkBtn);
  var pairBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only', label: 'Price each pair',
    onClick: function () { priceCombos(2, pairBtn, 'Price each pair'); },
    title: 'One search per pair of ticked mods, paced for the trade site. Click again to stop.' });
  controls.appendChild(pairBtn);
  var tripleBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only', label: 'Price each triple',
    onClick: function () { priceCombos(3, tripleBtn, 'Price each triple'); } });
  controls.appendChild(tripleBtn);
  step3.appendChild(controls);
  step3.appendChild(out);

  function tickedList() { return Object.keys(ticked).map(function (k) { return ticked[k]; }); }
  function filterOf(t) {
    var v = parseFloat(t.minInput.value);
    return { id: t.mod.ids[0], value: isNaN(v) ? {} : { min: v } };
  }
  function wePayload() {
    var list = tickedList();
    if (!list.length) { UI.toast('Tick at least one mod.', 'warn'); return null; }
    var need = matchSel.value === 'all' ? list.length : Math.min(parseInt(matchSel.value, 10), list.length);
    var group = need >= list.length ? { type: 'and', filters: list.map(filterOf) }
      : { type: 'count', value: { min: need }, filters: list.map(filterOf) };
    return ujPayload('Watcher\'s Eye', 'Prismatic Jewel', [group]);
  }
  function updateMatch() {
    var n = tickedList().length;
    linkSlot.textContent = '';
    if (n) linkSlot.appendChild(ujTradeLink(wePayload()));
    pairBtn.disabled = n < 2;
    pairBtn.title = n > 7 ? 'Tick 7 or fewer mods to price every pair (' + UJ_MAX_PAIRS + ' searches max)'
      : 'One search per pair of ticked mods (' + (n * (n - 1) / 2) + '), paced for the trade site. Click again to stop.';
    tripleBtn.disabled = n < 3;
    tripleBtn.title = n > 5 ? 'Tick 5 or fewer mods to price every triple (' + UJ_MAX_TRIPLES + ' searches max)'
      : 'One search per 3 ticked mods together (' + (n * (n - 1) * (n - 2) / 6) + '): the jewels with all three. ' +
        'Paced for the trade site. Click again to stop.';
  }

  // every combination of `size` ticked mods (pairs: up to 7 ticked = 21 searches; triples:
  // up to 5 ticked = 10), one paced search each, cheapest first
  function combos(list, size) {
    var out = [];
    (function pick(start, acc) {
      if (acc.length === size) { out.push(acc.slice()); return; }
      for (var i = start; i < list.length; i++) { acc.push(list[i]); pick(i + 1, acc); acc.pop(); }
    })(0, []);
    return out;
  }
  async function priceCombos(size, btn, label) {
    var sets = combos(tickedList(), size);
    var cap = size === 2 ? UJ_MAX_PAIRS : UJ_MAX_TRIPLES;
    if (sets.length > cap) {
      UI.toast('Tick ' + (size === 2 ? 7 : 5) + ' or fewer mods to price every ' + (size === 2 ? 'pair' : 'triple') + '.', 'warn');
      return;
    }
    out.textContent = '';
    var rows = sets.map(function (set) {
      return { mods: set.map(function (t) { return t.mod; }), payload: ujPayload('Watcher\'s Eye', 'Prismatic Jewel',
        [{ type: 'and', filters: set.map(filterOf) }]), total: null, cheapest: null, state: 'waiting' };
    });
    var table = UI.el('div', 'uj-pairs');
    out.appendChild(table);
    function draw() {
      table.textContent = '';
      rows.slice().sort(function (x, y) {
        return (x.cheapest == null) - (y.cheapest == null) || (y.cheapest || 0) - (x.cheapest || 0);
      }).forEach(function (r) {
        var row = UI.el('div', 'uj-pair');
        row.appendChild(UI.el('span', 'uj-pair-mods', r.mods.map(function (m) {
          return m.aura + ': ' + m.text.replace(' while affected by ' + m.aura, '');
        }).join('  +  ')));
        row.appendChild(UI.el('b', 'uj-price', r.state === 'done' ? (r.cheapest != null
          ? fmtEq(r.cheapest, document.getElementById('league').value) : '—') : r.state === 'error' ? '✕' : '…'));
        row.appendChild(UI.el('span', 'finder-sub', r.state === 'done' ? r.total + ' listed' : ''));
        row.appendChild(ujTradeLink(r.payload, '↗'));
        table.appendChild(row);
      });
    }
    draw();
    await runBatch(btn, label, rows.length, async function (k) {
      try {
        var res = await ujSearch(rows[k].payload);
        rows[k].total = res.total; rows[k].cheapest = res.cheapest; rows[k].state = 'done';
      } catch (e) {
        rows[k].state = 'error';
        draw();
        if (isCooldownError(String(e.message || e))) { UI.toast('Trade site cooldown: stopped. Try again in a minute.', 'warn'); return false; }
      }
      draw();
    });
  }
  renderMods();
}

// ---- Forbidden Flame & Flesh --------------------------------------------------------------
function renderForbidden(body, b) {
  var F = window.POE_FORBIDDEN;
  if (!F) { body.appendChild(UI.el('div', 'finder-sub', 'Forbidden jewel data is missing (data/forbidden.js).')); return; }
  var ascs = [];
  F.notables.forEach(function (n) { if (ascs.indexOf(n.asc) === -1) ascs.push(n.asc); });
  var asc = b && ascs.indexOf(b.ascendClass) !== -1 ? b.ascendClass : ascs[0];
  var allocated = (b && b.tree && b.tree.nodes) || [];
  var s1 = finderStep(body, 1, 'Ascendancy', 'A matching Forbidden Flame + Forbidden Flesh pair allocates one more ' +
    'notable from your ascendancy. Both jewels must name the same notable, and only work for that class.');
  var sel = UI.select(ascs.map(function (a) { return [a, a + (b && a === b.ascendClass ? ' (your build)' : '')]; }), asc,
    { ariaLabel: 'Ascendancy', onChange: function () { asc = this.value; drawList(); } });
  s1.appendChild(sel);
  var s2 = finderStep(body, 2, 'Notables', 'Price one pair, or every notable you don\'t have yet (2 searches each, paced).');
  var listBox = UI.el('div', 'uj-forbidden');
  var allBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only', label: 'Price all I don\'t have', onClick: function () { priceAll(); } });
  s2.appendChild(allBtn);
  s2.appendChild(listBox);
  var rows = {};

  function payloads(n) {
    return {
      flame: ujPayload('Forbidden Flame', 'Crimson Jewel', [{ type: 'and', filters: [{ id: F.flame + '|' + n.node }] }]),
      flesh: ujPayload('Forbidden Flesh', 'Cobalt Jewel', [{ type: 'and', filters: [{ id: F.flesh + '|' + n.node }] }])
    };
  }
  function drawList() {
    listBox.textContent = '';
    rows = {};
    F.notables.filter(function (n) { return n.asc === asc; }).forEach(function (n) {
      var have = allocated.indexOf(n.node) !== -1;
      var row = UI.el('div', 'uj-fb' + (have ? ' is-have' : ''));
      var head = UI.el('div', 'uj-fb-head');
      head.appendChild(UI.el('b', null, n.name));
      if (have) head.appendChild(UI.chip('In your tree', 'success'));
      var p = payloads(n);
      var price = UI.el('span', 'uj-price');
      head.appendChild(price);
      head.appendChild(UI.button('ghost', { size: 'sm', cls: 'gui-only', label: 'Price pair', onClick: function () { pricePair(n); } }));
      head.appendChild(ujTradeLink(p.flame, 'Flame ↗'));
      head.appendChild(ujTradeLink(p.flesh, 'Flesh ↗'));
      row.appendChild(head);
      row.appendChild(UI.el('div', 'finder-sub', n.stats.join(' · ')));
      rows[n.node] = { n: n, price: price, p: p, have: have };
      listBox.appendChild(row);
    });
  }
  async function pricePair(n) {
    var r = rows[n.node];
    r.price.textContent = 'Flame…';
    try {
      var a = await ujSearch(r.p.flame);
      r.price.textContent = 'Flesh…';
      await sleep(BATCH_GAP_MS);
      var c = await ujSearch(r.p.flesh);
      var league = document.getElementById('league').value;
      r.price.textContent = (a.cheapest != null && c.cheapest != null ? fmtEq(a.cheapest + c.cheapest, league) + ' the pair · ' : '') +
        'Flame ' + (a.cheapest != null ? fmtEq(a.cheapest, league) : 'none') + ' (' + a.total + ') · Flesh ' +
        (c.cheapest != null ? fmtEq(c.cheapest, league) : 'none') + ' (' + c.total + ')';
    } catch (e) {
      r.price.textContent = isCooldownError(String(e.message || e)) ? 'cooldown' : '✕';
      throw e;
    }
  }
  async function priceAll() {
    var todo = Object.keys(rows).map(function (k) { return rows[k]; }).filter(function (r) { return !r.have; });
    await runBatch(allBtn, 'Price all I don\'t have', todo.length, async function (i) {
      try { await pricePair(todo[i].n); }
      catch (e) { if (isCooldownError(String(e.message || e))) { UI.toast('Trade site cooldown: stopped.', 'warn'); return false; } }
    });
  }
  drawList();
}

// ---- Thread of Hope ------------------------------------------------------------------------
function renderThread(body) {
  var F = window.POE_FORBIDDEN;
  if (!F) { body.appendChild(UI.el('div', 'finder-sub', 'Thread of Hope data is missing (data/forbidden.js).')); return; }
  var s = finderStep(body, 1, 'Ring size', 'Thread of Hope lets you allocate passives in a ring around its socket without ' +
    'connecting to them. Bigger rings reach more but cost more.');
  var allBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only', label: 'Price every size', onClick: function () { priceAll(); } });
  s.appendChild(allBtn);
  var rows = F.rings.map(function (r) {
    var payload = ujPayload('Thread of Hope', 'Crimson Jewel', [{ type: 'and', filters: [{ id: F.thread + '|' + r[0] }] }]);
    var row = UI.el('div', 'uj-pair');
    row.appendChild(UI.el('b', 'uj-pair-mods', r[1] + ' Ring'));
    var price = UI.el('span', 'uj-price');
    row.appendChild(price);
    row.appendChild(ujTradeLink(payload));
    s.appendChild(row);
    return { payload: payload, price: price };
  });
  async function priceAll() {
    await runBatch(allBtn, 'Price every size', rows.length, async function (i) {
      rows[i].price.textContent = '…';
      try {
        var res = await ujSearch(rows[i].payload);
        rows[i].price.textContent = (res.cheapest != null ? fmtEq(res.cheapest, document.getElementById('league').value) : 'none') +
          ' · ' + res.total + ' listed';
      } catch (e) {
        rows[i].price.textContent = '✕';
        if (isCooldownError(String(e.message || e))) { UI.toast('Trade site cooldown: stopped.', 'warn'); return false; }
      }
    });
  }
}
