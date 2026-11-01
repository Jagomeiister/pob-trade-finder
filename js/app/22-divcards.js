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
  var have = DIV.data && DIV.league === league;
  if (have && !DIV.data.cached && !force) return renderDivcards();
  if (DIV.loading) return DIV.loading;
  var box = sec.querySelector('.dc-body');
  DIV.loading = (async function () {
    // after a restart: the last answer saved on disk shows at once (no network), then fresh
    // prices replace it — the drop data and the hourly feed can take seconds to download
    if (!have) {
      if (box) box.textContent = 'Loading drop data and prices…';
      var last = null;
      try { last = await window.pywebview.api.div_cards(league, true); } catch (e) { /* none saved */ }
      if (last && last.ok && !(DIV.data && DIV.league === league)) {
        DIV.data = last;
        DIV.league = league;
        renderDivcards();
      }
    } else if (!DIV.data.cached && box) {
      box.textContent = 'Loading drop data and prices…'; // ↻: start over
    }
    var r;
    try { r = await window.pywebview.api.div_cards(league); } catch (e) { r = { ok: false, error: String(e) }; }
    DIV.loading = null;
    if (!r || !r.ok) {
      var err = (r && r.error) || 'no answer';
      if (DIV.data && DIV.league === league && DIV.data.cached) { // keep the saved prices on screen
        DIV.data.refreshError = err;
        renderDivcards();
        return;
      }
      if (box) { box.textContent = ''; box.appendChild(UI.el('div', 'finder-sub', '❌ Couldn\'t load div cards: ' + err)); }
      return;
    }
    DIV.data = r;
    DIV.league = league;
    renderDivcards();
  })();
  return DIV.loading;
}

// "prices from 14:00, 1 Nov" for a feed hour (unix seconds)
function dcHour(hour) {
  if (!hour) return 'an earlier session';
  return new Date(hour * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

// ---- div card art ------------------------------------------------------------------
// GGG's CDN art (name checked by tools/make_divcards.py), loaded only when its row scrolls
// into view: the global art cache (08-cards.js) swaps a cached copy in, or queues the URL —
// 40 per call, 1.5 s apart — so a few hundred rows never fire a few hundred downloads.
// The <img> stays invisible until it has loaded: a missing image shows nothing, never a
// broken icon. Hover a card (thumbnail or name) for the whole card, laid out like the game's:
// name, the picture with the stack size, the reward in its colours, the flavour text.
var DC_ART = 'https://web.poecdn.com/image/divination-card/';
// reward colours as the game uses them (data: tools/make_divcards.py "r")
var DC_COLOURS = { unique: 1, currency: 1, divination: 1, gem: 1, magic: 1, rare: 1, normal: 1, corrupted: 1,
                   enchanted: 1, fractured: 1, crafted: 1, augmented: 1, default: 1 };

function dcArtObserver() {
  if (!DIV.io && window.IntersectionObserver) {
    DIV.io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        DIV.io.unobserve(e.target);
        var img = e.target.querySelector('img');
        if (img && img.dataset.src) { img.setAttribute('src', img.dataset.src); img.removeAttribute('data-src'); }
      });
    }, { rootMargin: '200px 0px' });
  }
  return DIV.io;
}

function dcArtThumb(c) {
  var box = UI.el('span', 'dc-art');
  if (!c.i) { box.classList.add('dc-art-none'); return box; }
  var img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.dataset.src = DC_ART + encodeURIComponent(c.i) + '.png';
  img.addEventListener('load', function () { img.classList.add('ok'); });
  img.addEventListener('error', function () { img.classList.remove('ok'); }); // the art cache may retry the CDN
  box.appendChild(img);
  var io = dcArtObserver();
  if (io) io.observe(box);
  else img.setAttribute('src', img.dataset.src);
  return box;
}

// the whole card: name, picture (when its art loaded) with the stack size, reward, flavour text
function dcFullCard(c, img) {
  var card = UI.el('div', 'dc-full');
  card.appendChild(UI.el('div', 'dc-full-name', c.n));
  var art = UI.el('div', 'dc-full-art');
  if (img && img.classList.contains('ok')) {
    var big = document.createElement('img');
    big.alt = '';
    big.src = img.currentSrc || img.src;
    art.appendChild(big);
  } else {
    art.classList.add('is-empty');
  }
  art.appendChild(UI.el('span', 'dc-full-stack', (c.s || 1) > 1 ? '1 / ' + c.s : '1 / 1'));
  card.appendChild(art);
  var reward = UI.el('div', 'dc-full-reward');
  (c.r || []).forEach(function (line) {
    var row = UI.el('div', 'dc-full-line');
    line.forEach(function (seg) {
      row.appendChild(UI.el('span', 'dc-c-' + (DC_COLOURS[seg[1]] ? seg[1] : 'default'), seg[0]));
    });
    reward.appendChild(row);
  });
  if (!(c.r || []).length) reward.appendChild(UI.el('div', 'dc-full-line dc-c-default', 'Reward: see the wiki'));
  card.appendChild(reward);
  if (c.f) {
    var fl = UI.el('div', 'dc-full-flavour');
    c.f.split('\n').forEach(function (t) { fl.appendChild(UI.el('div', null, t)); });
    card.appendChild(fl);
  }
  return card;
}

// one shared pop-up beside the card's row, kept on screen
function dcArtPop(c, anchor, img) {
  var pop = document.getElementById('dc-art-pop');
  if (!c) { if (pop) pop.hidden = true; return; }
  if (!pop) {
    pop = UI.el('div', 'dc-art-pop');
    pop.id = 'dc-art-pop';
    pop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(pop);
  }
  pop.textContent = '';
  pop.appendChild(dcFullCard(c, img));
  pop.hidden = false;
  var r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  var x = r.right + 10 + w > window.innerWidth ? r.left - 10 - w : r.right + 10;
  var y = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = y + 'px';
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
  if (DIV.io) { DIV.io.disconnect(); DIV.io = null; } // the old rows are gone
  dcArtPop(null);
  var d = DIV.data, league = DIV.league;
  if (d.cached) {
    box.appendChild(UI.el('div', 'finder-sub dc-status', d.refreshError
      ? '⚠ Couldn\'t refresh prices (' + d.refreshError + '): showing prices from ' + dcHour(d.priceHour) + '.'
      : 'Showing prices from ' + dcHour(d.priceHour) + ' — refreshing…'));
  }
  var q = DIV.q.toLowerCase();
  if (DIV.mode === 'maps') {
    var rows = divcardsByMap(d, DIV.min, DIV.mapsOnly).filter(function (m) {
      return !q || m.area.name.toLowerCase().indexOf(q) !== -1 ||
        m.worth.some(function (c) { return c.n.toLowerCase().indexOf(q) !== -1; });
    });
    var mapTable = box.appendChild(UI.table([
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
      mapTable);
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
    { key: 'n', label: 'Card', render: function (c) {
      var cell = UI.el('span', 'dc-card');
      var thumb = dcArtThumb(c);
      cell.appendChild(thumb);
      cell.appendChild(UI.el('span', null, c.n));
      cell.addEventListener('mouseenter', function () { dcArtPop(c, cell, thumb.querySelector('img')); });
      cell.addEventListener('mouseleave', function () { dcArtPop(null); });
      return cell;
    } },
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
