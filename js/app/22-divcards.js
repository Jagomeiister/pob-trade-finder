/* js/app/22-divcards.js — Div cards: which maps drop the valuable cards, and where each card drops.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Drop areas + stack sizes: the community Path of Exile Wiki via tools/make_divcards.py, shipped
// in data/divcards.json and served (newer) from the backend's static divcards.json. Prices: GGG's hourly currency exchange feed
// (Api.div_cards). Drop *rates* aren't public, so "by map" ranks maps by the value of the
// cards that can drop there — it is not an expected value per map.
var DIV = { data: null, loading: null, league: null, mode: 'maps', q: '', min: 5, mapsOnly: true, open: null };

// 1 divine or more reads as divines (e.g. "3.4 div"), under that as chaos — whatever the
// app-wide "Show prices in" setting says; card prices span 1c to hundreds of divines
function dcFmt(chaos) {
  var div = DIV.data && DIV.data.divine;
  if (div && chaos >= div) {
    var d = chaos / div;
    return (d >= 100 ? Math.round(d) : Math.round(d * 10) / 10) + ' div';
  }
  return fmtChaos(chaos);
}

async function loadDivcardsView(force) {
  var sec = viewSection('divcards');
  if (!sec || !isGui() || !window.pywebview.api.div_cards) return;
  var league = document.getElementById('league').value;
  if (DIV.data && DIV.league === league && !force) return renderDivcards();
  if (DIV.loading) return DIV.loading;
  var box = sec.querySelector('.dc-body');
  if (box) box.textContent = 'Loading drop data and prices…';
  DIV.loading = (async function () {
    var r;
    try { r = await window.pywebview.api.div_cards(league); } catch (e) { r = { ok: false, error: String(e) }; }
    DIV.loading = null;
    if (!r || !r.ok) {
      if (box) { box.textContent = ''; box.appendChild(UI.el('div', 'finder-sub', '❌ Couldn\'t load div cards: ' + ((r && r.error) || 'no answer'))); }
      return;
    }
    DIV.data = r;
    DIV.league = league;
    renderDivcards();
  })();
  return DIV.loading;
}

// maps -> priced cards that can drop there
function divcardsByMap(d, min, mapsOnly) {
  var maps = d.areas.map(function (a, i) { return { i: i, area: a, cards: [] }; });
  d.cards.forEach(function (c) {
    if (c.off || c.c == null || !c.a) return;
    c.a.forEach(function (i) { if (maps[i]) maps[i].cards.push(c); });
  });
  return maps.filter(function (m) { return (!mapsOnly || m.area.map) && m.cards.length; }).map(function (m) {
    var worth = m.cards.filter(function (c) { return c.c >= min; }).sort(function (a, b) { return b.c - a.c; });
    var best = worth[0] || null;
    return { area: m.area, all: m.cards.length, worth: worth, best: best,
      bestStack: best ? best.c * best.s : 0, total: worth.reduce(function (s, c) { return s + c.c; }, 0) };
  }).filter(function (m) { return m.worth.length; });
}

function renderDivcards() {
  var sec = viewSection('divcards');
  if (!sec || !DIV.data) return;
  var box = sec.querySelector('.dc-body');
  box.textContent = '';
  var d = DIV.data, league = DIV.league;
  var q = DIV.q.toLowerCase();
  if (DIV.mode === 'maps') {
    var rows = divcardsByMap(d, DIV.min, DIV.mapsOnly).filter(function (m) {
      return !q || m.area.name.toLowerCase().indexOf(q) !== -1 ||
        m.worth.some(function (c) { return c.n.toLowerCase().indexOf(q) !== -1; });
    });
    box.appendChild(UI.table([
      { key: 'name', label: 'Area', sort: function (m) { return m.area.name; }, render: function (m) {
        var b = UI.button('ghost', { size: 'sm', label: m.area.name + (DIV.open === m.area.id ? ' ▾' : ' ▸'),
          onClick: function () { DIV.open = DIV.open === m.area.id ? null : m.area.id; renderDivcards(); } });
        return b;
      } },
      { key: 'lvl', label: 'Level', num: true, sort: function (m) { return m.area.lvl || 0; },
        render: function (m) { return m.area.lvl || ''; } },
      { key: 'n', label: 'Cards ≥ ' + DIV.min + 'c', num: true, sort: function (m) { return m.worth.length; },
        render: function (m) { return m.worth.length + ' / ' + m.all; } },
      { key: 'best', label: 'Best card', sort: function (m) { return m.best ? m.best.c : 0; }, render: function (m) {
        return m.best ? m.best.n + ' · ' + dcFmt(m.best.c) : '';
      } },
      { key: 'stack', label: 'Its full set', num: true, sort: function (m) { return m.bestStack; },
        render: function (m) { return m.best ? dcFmt(m.bestStack) + ' (' + m.best.s + ')' : ''; } },
      { key: 'total', label: 'Sum of one each', num: true, sort: function (m) { return m.total; },
        render: function (m) { return dcFmt(m.total); } }
    ], rows.sort(function (a, b) { return b.best.c - a.best.c; }), { sortable: true,
      emptyText: 'No area drops a card worth ' + DIV.min + 'c or more' + (q ? ' matching "' + DIV.q + '"' : '') + '.' }));
    var openRow = rows.filter(function (m) { return m.area.id === DIV.open; })[0];
    if (openRow) box.insertBefore(divcardList(openRow.area.name + ': cards that can drop here', openRow.worth, league),
      box.firstChild);
    return;
  }
  var cards = d.cards.filter(function (c) {
    return (c.c == null ? DIV.min === 0 : c.c >= DIV.min) &&
      (!q || c.n.toLowerCase().indexOf(q) !== -1 || (c.a || []).some(function (i) { return d.areas[i].name.toLowerCase().indexOf(q) !== -1; }));
  }).sort(function (a, b) { return (b.c || 0) - (a.c || 0); });
  box.appendChild(divcardList(null, cards, league));
}

function divcardList(title, cards, league) {
  var d = DIV.data;
  var wrap = UI.el('div', 'dc-list');
  if (title) wrap.appendChild(UI.el('h3', 'trade-h3', title));
  wrap.appendChild(UI.table([
    { key: 'n', label: 'Card' },
    { key: 'c', label: 'Each', num: true, render: function (c) { return c.c != null ? dcFmt(c.c) : '?'; } },
    { key: 's', label: 'Set', num: true },
    { key: 'set', label: 'Full set', num: true, sort: function (c) { return (c.c || 0) * c.s; },
      render: function (c) { return c.c != null ? dcFmt(c.c * c.s) : ''; } },
    { key: 'a', label: 'Drops in', sort: function (c) { return (c.a || []).length; }, render: function (c) {
      if (c.off) return 'no longer drops';
      var names = (c.a || []).map(function (i) { return d.areas[i].name; });
      if (!names.length) return 'special (see the wiki)';
      return names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) : '');
    } },
    { key: 't', label: '', render: function (c) {
      return c.code ? UI.button('ghost', { size: 'sm', label: '↗', title: 'Bulk exchange on the trade site',
        onClick: function () { openUrl(exchangeUrlFor(league, c.code)); } }) : '';
    } }
  ], cards, { sortable: true, emptyText: 'No cards match.' }));
  return wrap;
}

document.addEventListener('DOMContentLoaded', function () {
  var lg = document.getElementById('league');
  if (lg) lg.addEventListener('change', function () {
    DIV.data = null; // prices are per league
    if (document.body.dataset.view === 'divcards') loadDivcardsView(true);
  });
});

function makeDivcards() {
  var wrap = UI.el('div', 'finder dc');
  var bar = UI.el('div', 'dc-controls');
  bar.appendChild(UI.segmented([['maps', 'By area'], ['cards', 'By card']], DIV.mode, { ariaLabel: 'View',
    onChange: function (v) { DIV.mode = v; renderDivcards(); } }));
  var q = UI.input({ placeholder: 'Card or area', width: '170px', ariaLabel: 'Filter cards or areas', value: DIV.q });
  q.addEventListener('input', function () { DIV.q = q.value; renderDivcards(); });
  bar.appendChild(q);
  UI.field('Worth at least', UI.select([['0', 'any'], ['5', '5c'], ['20', '20c'], ['50', '50c'], ['200', '200c'], ['1000', '1000c']],
    String(DIV.min), { onChange: function () { DIV.min = parseInt(this.value, 10); renderDivcards(); } }), { parent: bar });
  var mo = UI.el('label', 'toggle');
  var mcb = document.createElement('input');
  mcb.type = 'checkbox';
  mcb.checked = DIV.mapsOnly;
  mcb.addEventListener('change', function () { DIV.mapsOnly = mcb.checked; renderDivcards(); });
  mo.appendChild(mcb);
  mo.appendChild(UI.el('span', null, 'Maps only'));
  bar.appendChild(mo);
  bar.appendChild(UI.button('ghost', { size: 'sm', cls: 'gui-only', label: '↻', title: 'Reload prices',
    onClick: function () { loadDivcardsView(true); } }));
  wrap.appendChild(bar);
  wrap.appendChild(UI.el('div', 'finder-sub dc-note', 'Drop rates aren\'t public, so areas are ranked by the cards that ' +
    'can drop there, not by expected value. Prices: GGG\'s currency exchange (last hour). Drop areas: Path of Exile ' +
    'Wiki (CC BY-NC-SA), updated through the app\'s server between releases.'));
  var body = UI.el('div', 'dc-body');
  body.appendChild(UI.el('div', 'finder-sub', isGui() ? 'Open this view to load drop data and prices.'
    : 'The Div cards tool needs the desktop app.'));
  wrap.appendChild(body);
  return wrap;
}
