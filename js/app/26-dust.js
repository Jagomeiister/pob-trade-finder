/* js/app/26-dust.js — dust explorer: which uniques are worth buying to disenchant for
   Thaumaturgic Dust (Kingsmarch), and an item's dust on the price check. The js/app/ files
   are one program split by feature: they load in order (index.html) and share their
   top-level names. */
'use strict';

// ==== dust explorer =================================================================
// Dust per unique: data/dust.js (tools/make_dust.py), an MIT dataset at item level 84 and
// quality 0 that already counts influences a unique always has (entry[5]). The game's rules
// (PoE Wiki, Kingsmarch → Disenchanting): item level 65–84 scales it linearly, each 1%
// quality adds 2%, each influence type or corruption implicit adds 50%, added together.
// Prices: the cheapest plain copy of each unique from poe.ninja, through the app's backend.
var DUST = { prices: null, divine: null, league: null, loading: false, error: null,
  ilvl: 84, quality: 0, extra: 0, q: '', minListings: 5, maxPrice: 0, limit: 150 };
var dustIndex = null; // "name|base" and "name" -> entry

function dustEntry(name, base) {
  if (!dustIndex) {
    dustIndex = {};
    ((window.POE_DUST || {}).items || []).forEach(function (e) {
      dustIndex[e[0] + '|' + e[1]] = e;
      dustIndex[e[0]] = dustIndex[e[0]] === undefined ? e : null; // a name on two bases needs the base
    });
  }
  return dustIndex[name + '|' + (base || '')] || dustIndex[name] || null;
}

// entry: [name, base, dust at ilvl 84 / q0 incl. its own influences, gold fee, slots, influences]
function dustValue(entry, ilvl, quality, extra) {
  var lv = Math.max(65, Math.min(84, ilvl || 84));
  var inf = entry[5] || 0;
  var base = entry[2] / (1 + 0.5 * inf);
  return Math.round(base * (lv - 64) / 20 * (1 + 0.02 * Math.max(0, quality || 0) + 0.5 * (inf + Math.max(0, extra || 0))));
}

function dustFmt(v) {
  if (v == null) return '—';
  return v >= 1e6 ? (Math.round(v / 1e4) / 100) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : fmtCompact(v);
}
function dustPriceFmt(chaos) {
  if (chaos == null) return '—';
  var d = DUST.divine;
  if (d && chaos >= d) return (chaos / d >= 100 ? Math.round(chaos / d) : Math.round(chaos / d * 10) / 10) + ' div';
  return fmtChaos(chaos);
}

async function loadDustPrices(force) {
  var league = document.getElementById('league').value;
  if (!force && (DUST.loading || (DUST.prices && DUST.league === league))) return;
  if (!isGui() || !window.pywebview.api.unique_prices) {
    DUST.error = 'Prices come from poe.ninja in the desktop app; dust values show without them.';
    renderDustView();
    return;
  }
  DUST.loading = true;
  DUST.error = null;
  renderDustView();
  var r;
  try { r = await window.pywebview.api.unique_prices(league); } catch (e) { r = { ok: false, error: String(e) }; }
  DUST.loading = false;
  if (r && r.ok) {
    DUST.prices = {};
    (r.items || []).forEach(function (p) {
      // by name + base, and by name alone for a line without its base
      [p[0] + '|' + p[1], p[0]].forEach(function (key) {
        var cur = DUST.prices[key];
        if (!cur || p[2] < cur.c) DUST.prices[key] = { c: p[2], lc: p[3], k: p[4] };
      });
    });
    DUST.divine = r.divine || null;
    DUST.league = league;
  } else {
    DUST.error = 'Couldn\'t load prices from poe.ninja: ' + ((r && r.error) || 'no answer') + '. Try again in a minute.';
  }
  renderDustView();
}

// poe.ninja's page for a unique type ("UniqueArmour" -> unique-armours)
var DUST_NINJA = { UniqueWeapon: 'unique-weapons', UniqueArmour: 'unique-armours', UniqueAccessory: 'unique-accessories',
  UniqueFlask: 'unique-flasks', UniqueJewel: 'unique-jewels', UniqueTincture: 'unique-tinctures', UniqueRelic: 'unique-relics' };

function dustRows() {
  var q = DUST.q.trim().toLowerCase();
  return ((window.POE_DUST || {}).items || []).map(function (e) {
    var p = DUST.prices ? DUST.prices[e[0] + '|' + e[1]] || DUST.prices[e[0]] : null;
    var dust = dustValue(e, DUST.ilvl, DUST.quality, DUST.extra);
    return { e: e, name: e[0], base: e[1], dust: dust, gold: e[3], slots: e[4], inf: e[5],
             chaos: p ? p.c : null, listings: p ? p.lc : null, kind: p ? p.k : null,
             perChaos: p && p.c > 0 ? dust / p.c : null };
  }).filter(function (r) {
    if (q && (r.name + ' ' + r.base).toLowerCase().indexOf(q) === -1) return false;
    if (!DUST.prices) return true;
    if (r.chaos == null) return false;
    if (DUST.minListings && (r.listings || 0) < DUST.minListings) return false;
    if (DUST.maxPrice && r.chaos > DUST.maxPrice) return false;
    return true;
  }).sort(function (a, b) {
    return DUST.prices ? (b.perChaos || 0) - (a.perChaos || 0) : b.dust - a.dust;
  });
}

var dustViewBack = null;
function openDustView() {
  var cur = document.body.dataset.view;
  if (cur && cur !== 'dust') dustViewBack = cur;
  setView('dust');
  window.scrollTo(0, 0);
}
function dustClose() { setView(build ? (dustViewBack || 'gear') : ''); }

function renderDustView() {
  var view = document.getElementById('view-dust');
  if (!view) return;
  if (!DUST.prices && !DUST.loading && !DUST.error) { loadDustPrices(); return; }
  view.textContent = '';
  var page = UI.el('div', 'dust-page');
  var bar = UI.el('div', 'trades-bar');
  bar.appendChild(UI.button('ghost', { size: 'sm', label: '← Back', onClick: dustClose, title: 'Back to where you were (Esc)' }));
  bar.appendChild(UI.el('span', 'ov-title', 'Dust explorer'));
  page.appendChild(bar);
  page.appendChild(UI.el('p', 'finder-sub', 'Which uniques give the most Thaumaturgic Dust for their price when your ' +
    'Kingsmarch disenchanter breaks them down. Sorted by dust per chaos; click a column to sort by it.'));

  var ctl = UI.el('div', 'dust-controls');
  function slider(label, value, min, max, unit, key, title) {
    var r = UI.input({ type: 'range', min: min, max: max, step: 1, value: value, ariaLabel: label, cls: 'trade-slider' });
    var v = UI.el('span', 'slider-val', value + unit);
    r.addEventListener('input', function () { v.textContent = r.value + unit; });
    r.addEventListener('change', function () { DUST[key] = parseInt(r.value, 10); renderDustView(); });
    var f = UI.field(label, r, { title: title });
    f.appendChild(v);
    return f;
  }
  ctl.appendChild(slider('Item level', DUST.ilvl, 65, 84, '', 'ilvl', 'Dust grows with item level from 65 to 84 (below 65 counts as 65)'));
  ctl.appendChild(slider('Quality', DUST.quality, 0, 20, '%', 'quality', 'Each 1% quality adds 2% dust'));
  ctl.appendChild(UI.field('Extra', UI.select([['0', 'none'], ['1', '+1 influence / corruption implicit'], ['2', '+2']],
    String(DUST.extra), { onChange: function () { DUST.extra = parseInt(this.value, 10); renderDustView(); } }),
    { title: 'Each influence type or corruption implicit adds 50% dust (influences a unique always has are already counted)' }));
  var q = UI.input({ type: 'search', placeholder: 'Unique or base', width: '170px', ariaLabel: 'Filter uniques', value: DUST.q });
  q.addEventListener('input', function () { DUST.q = q.value; renderDustTable(page); });
  ctl.appendChild(q);
  if (DUST.prices) {
    ctl.appendChild(UI.field('Listed at least', UI.select([['0', 'any'], ['5', '5'], ['20', '20'], ['50', '50']], String(DUST.minListings),
      { onChange: function () { DUST.minListings = parseInt(this.value, 10); renderDustView(); } }),
      { title: 'Hide thin markets: poe.ninja\'s price for a rarely listed unique is often off' }));
    var div = DUST.divine || 0;
    var caps = [['0', 'any'], ['5', '5c'], ['20', '20c'], ['50', '50c']].concat(div ? [[String(Math.round(div)), '1 div'],
      [String(Math.round(div * 5)), '5 div']] : []);
    ctl.appendChild(UI.field('Price up to', UI.select(caps, String(DUST.maxPrice),
      { onChange: function () { DUST.maxPrice = parseInt(this.value, 10); renderDustView(); } })));
  }
  ctl.appendChild(UI.button('ghost', { size: 'sm', label: '↻ Prices', title: 'Load poe.ninja prices again',
    onClick: function () { loadDustPrices(true); } }));
  page.appendChild(ctl);

  if (DUST.loading) page.appendChild(UI.el('p', 'finder-sub', 'Loading prices from poe.ninja…'));
  if (DUST.error) page.appendChild(UI.el('p', 'trade-warn', DUST.error));
  page.appendChild(UI.el('div', 'dust-table-wrap'));
  var src = (window.POE_DUST || {}).source;
  page.appendChild(UI.el('p', 'sheet-foot', 'Dust values: ' + (src || 'missing (data/dust.js)') + ', item level 84 data scaled ' +
    'by the game\'s rules. Prices: poe.ninja (' + (DUST.league || document.getElementById('league').value) +
    '), the cheapest plain copy (not corrupted, not 5/6-linked). Disenchanting also costs gold: see Gold fee.'));
  view.appendChild(page);
  renderDustTable(page);
}

function renderDustTable(page) {
  var wrap = page.querySelector('.dust-table-wrap');
  if (!wrap) return;
  wrap.textContent = '';
  var rows = dustRows();
  var shown = rows.slice(0, DUST.limit);
  var league = DUST.league || document.getElementById('league').value;
  var cols = [
    { key: 'name', label: 'Unique', render: function (r) {
      var c = UI.el('span', 'dust-name');
      c.appendChild(UI.el('b', null, r.name));
      c.appendChild(UI.el('span', 'finder-sub', ' ' + r.base + (r.inf ? ' · ' + r.inf + ' built-in influence' + (r.inf > 1 ? 's' : '') : '')));
      return c;
    } },
    { key: 'dust', label: 'Dust', num: true, render: function (r) { return dustFmt(r.dust); } },
  ];
  if (DUST.prices) {
    cols.push({ key: 'chaos', label: 'Price', num: true, render: function (r) { return dustPriceFmt(r.chaos); } });
    cols.push({ key: 'perChaos', label: 'Dust / chaos', num: true, render: function (r) { return r.perChaos == null ? '—' : dustFmt(Math.round(r.perChaos)); } });
  }
  cols.push({ key: 'gold', label: 'Gold fee', num: true, render: function (r) { return dustFmt(r.gold); } });
  cols.push({ key: 'slots', label: 'Size', num: true, render: function (r) { return r.slots + ' sq'; } });
  if (DUST.prices) {
    cols.push({ key: 'listings', label: 'Listed', num: true });
    cols.push({ key: 'link', label: '', render: function (r) {
      var cat = DUST_NINJA[r.kind];
      return cat ? UI.button('ghost', { size: 'sm', label: 'poe.ninja ↗', title: 'Price history on poe.ninja',
        onClick: function () { openUrl(ninjaUrl(cat, r.name, league)); } }) : '';
    } });
  }
  wrap.appendChild(UI.table(cols, shown, { sortable: true, emptyText: DUST.prices ? 'No unique matches these filters.' : 'No dust data.' }));
  if (rows.length > shown.length) {
    wrap.appendChild(UI.button('secondary', { size: 'sm', label: 'Show ' + Math.min(150, rows.length - shown.length) + ' more (' +
      (rows.length - shown.length) + ' left)', onClick: function () { DUST.limit += 150; renderDustTable(page); } }));
  }
}

// the price check / pasted unique: "Dust ≈ 1.2M" from its own item level, quality, influences
function dustLineFor(item) {
  if (!item || item.rarity !== 'UNIQUE') return null;
  var e = dustEntry(item.name, item.base);
  if (!e) return null;
  var extra = Math.max(0, (item.influences || []).length - (e[5] || 0));
  var ilvl = item.itemLevel || 84;
  return { dust: dustValue(e, ilvl, item.quality || 0, extra), ilvl: ilvl, quality: item.quality || 0, extra: extra, gold: e[3] };
}

document.addEventListener('DOMContentLoaded', function () {
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (document.body.dataset.view !== 'dust' || document.body.classList.contains('over-game')) return;
    dustClose();
  });
  var league = document.getElementById('league');
  if (league) league.addEventListener('change', function () { if (document.body.dataset.view === 'dust') loadDustPrices(true); });
});
// ==== end dust explorer =============================================================
