/* js/app/22-divcards.js — Div cards: which maps drop the valuable cards, and where each card drops.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Drop areas + stack sizes: the community Path of Exile Wiki via tools/make_divcards.py, shipped
// in data/divcards.json and served (newer) from the backend's static divcards.json. Prices: GGG's hourly currency exchange feed
// (Api.div_cards). Drop weights: community stacked deck data (data/divweights.js), so "by
// area" can rank areas by card value per 1,000 item drops (see dcAreaValue).
var DIV = { data: null, loading: null, league: null, mode: 'maps', q: '', min: 5, mapsOnly: true, open: null,
  voidstones: true };
var DC_PER = 1000;      // value is shown per this many item drops
var DC_MAP_LEVEL = 83;  // maps with 4 voidstones

// ---- drop weights: a card's share of an area's item drops ---------------------------------
// weight / (drop pool weight + weights of the cards that can drop there), the model the
// weights' source (maps-of-exile) uses. Community estimates from opening stacked decks, not
// GGG numbers: good for comparing areas, not a promise of what one map gives.
function dcWeight(name) {
  var w = (window.POE_DIV_WEIGHTS || {}).cards || {};
  return w[name] || null; // [weight, min area level]
}
function dcAreaLevel(area) {
  return area.map && DIV.voidstones ? Math.max(area.lvl || 0, DC_MAP_LEVEL) : area.lvl || 0;
}
// every card that can drop in an area at its level: { cards: [{c, w, share, value}], unknown, total }
function dcAreaValue(d, areaIndex) {
  var area = d.areas[areaIndex], lvl = dcAreaLevel(area);
  var pool = (window.POE_DIV_WEIGHTS || {}).pool || 0;
  var here = [], unknown = 0, sumW = 0;
  d.cards.forEach(function (c) {
    if (c.off || !c.a || c.a.indexOf(areaIndex) === -1) return;
    var w = dcWeight(c.n);
    if (!w) { unknown++; return; }
    if (lvl && w[1] && lvl < w[1]) return; // needs a higher area level
    here.push({ c: c, w: w[0] });
    sumW += w[0];
  });
  var denom = pool + sumW, total = 0;
  here.forEach(function (h) {
    h.share = denom ? h.w / denom : 0;
    h.value = h.c.c != null ? h.share * h.c.c * DC_PER : 0;
    total += h.value;
  });
  return { cards: here, unknown: unknown, total: total, level: lvl };
}

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
// broken icon. Hover a thumbnail for the full card.
var DC_ART = 'https://web.poecdn.com/image/divination-card/';

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
  box.addEventListener('mouseenter', function () { if (img.classList.contains('ok')) dcArtPop(img, box); });
  box.addEventListener('mouseleave', function () { dcArtPop(null); });
  var io = dcArtObserver();
  if (io) io.observe(box);
  else img.setAttribute('src', img.dataset.src);
  return box;
}

// one shared enlarged view, beside the thumbnail, kept on screen
function dcArtPop(img, anchor) {
  var pop = document.getElementById('dc-art-pop');
  if (!img) { if (pop) pop.hidden = true; return; }
  if (!pop) {
    pop = UI.el('div', 'dc-art-pop');
    pop.id = 'dc-art-pop';
    pop.setAttribute('aria-hidden', 'true');
    pop.appendChild(document.createElement('img'));
    document.body.appendChild(pop);
  }
  pop.firstChild.src = img.currentSrc || img.src;
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
  var weights = !!window.POE_DIV_WEIGHTS;
  return maps.filter(function (m) { return (!mapsOnly || m.area.map) && m.cards.length; }).map(function (m) {
    var worth = m.cards.filter(function (c) { return c.c >= min; }).sort(function (a, b) { return b.c - a.c; });
    var best = worth[0] || null;
    var ev = weights ? dcAreaValue(d, m.i) : null;
    return { area: m.area, index: m.i, all: m.cards.length, worth: worth, best: best, ev: ev,
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
    ].concat(window.POE_DIV_WEIGHTS ? [
      { key: 'ev', label: '≈ per ' + fmtCompact(DC_PER) + ' drops', num: true, sort: function (m) { return m.ev.total; },
        render: function (m) {
          var s = UI.el('span', 'dc-ev', dcFmt(m.ev.total));
          s.title = 'Card value you\'d expect per ' + fmtCompact(DC_PER) + ' items dropped here (area level ' + m.ev.level + '), ' +
            'from community drop weights' + (m.ev.unknown ? '. ' + m.ev.unknown + ' card' + (m.ev.unknown > 1 ? 's' : '') +
            ' here have no known weight and aren\'t counted' : '');
          if (m.ev.unknown) s.appendChild(UI.el('sup', 'dc-ev-unknown', ' +' + m.ev.unknown + '?'));
          return s;
        } }] : []),
    rows.sort(function (a, b) { return a.ev && b.ev ? b.ev.total - a.ev.total : b.best.c - a.best.c; }), { sortable: true,
      emptyText: 'No area drops a card worth ' + DIV.min + 'c or more' + (q ? ' matching "' + DIV.q + '"' : '') + '.' }));
    var openRow = rows.filter(function (m) { return m.area.id === DIV.open; })[0];
    if (openRow) box.insertBefore(divcardList(openRow.area.name + ': cards that can drop here', openRow.worth, league, openRow.ev),
      mapTable);
    return;
  }
  var cards = d.cards.filter(function (c) {
    return (c.c == null ? DIV.min === 0 : c.c >= DIV.min) &&
      (!q || c.n.toLowerCase().indexOf(q) !== -1 || (c.a || []).some(function (i) { return d.areas[i].name.toLowerCase().indexOf(q) !== -1; }));
  }).sort(function (a, b) { return (b.c || 0) - (a.c || 0); });
  box.appendChild(divcardList(null, cards, league));
}

// ev (an area's dcAreaValue): adds each card's chance and value per DC_PER drops there
function divcardList(title, cards, league, ev) {
  var d = DIV.data;
  var wrap = UI.el('div', 'dc-list');
  if (title) wrap.appendChild(UI.el('h3', 'trade-h3', title));
  var inArea = {};
  if (ev) {
    ev.cards.forEach(function (h) { inArea[h.c.n] = h; });
    wrap.appendChild(UI.el('p', 'finder-sub', 'At area level ' + ev.level + ': ≈ ' + dcFmt(ev.total) + ' in cards per ' +
      fmtCompact(DC_PER) + ' items dropped' + (ev.unknown ? ' (' + ev.unknown + ' card' + (ev.unknown > 1 ? 's' : '') +
      ' without a known weight left out)' : '') + '.'));
  }
  var areaCols = ev ? [
    { key: 'odds', label: 'One per', num: true, sort: function (c) { var h = inArea[c.n]; return h ? -h.share : 1; },
      render: function (c) {
        var h = inArea[c.n];
        if (!h) return dcWeight(c.n) ? 'level too low' : 'weight unknown';
        return '≈ ' + fmtCompact(Math.round(1 / h.share)) + ' drops';
      } },
    { key: 'ev', label: '≈ per ' + fmtCompact(DC_PER), num: true, sort: function (c) { var h = inArea[c.n]; return h ? h.value : -1; },
      render: function (c) { var h = inArea[c.n]; return h && c.c != null ? dcFmt(h.value) : ''; } }
  ] : [];
  wrap.appendChild(UI.table([
    { key: 'n', label: 'Card', render: function (c) {
      var cell = UI.el('span', 'dc-card');
      cell.appendChild(dcArtThumb(c));
      cell.appendChild(UI.el('span', null, c.n));
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
  ].concat(areaCols), ev ? cards.slice().sort(function (a, b) {
    return ((inArea[b.n] || {}).value || 0) - ((inArea[a.n] || {}).value || 0);
  }) : cards, { sortable: true, emptyText: 'No cards match.' }));
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
  if (window.POE_DIV_WEIGHTS) { // some cards only drop from a higher area level
    var vs = UI.el('label', 'toggle');
    vs.title = 'Count maps at area level ' + DC_MAP_LEVEL + ', as with all 4 voidstones (otherwise their listed level)';
    var vcb = document.createElement('input');
    vcb.type = 'checkbox';
    vcb.checked = DIV.voidstones;
    vcb.addEventListener('change', function () { DIV.voidstones = vcb.checked; renderDivcards(); });
    vs.appendChild(vcb);
    vs.appendChild(UI.el('span', null, '4 voidstones'));
    bar.appendChild(vs);
  }
  bar.appendChild(UI.button('ghost', { size: 'sm', cls: 'gui-only', label: '↻', title: 'Reload prices',
    onClick: function () { loadDivcardsView(true); } }));
  wrap.appendChild(bar);
  var dw = window.POE_DIV_WEIGHTS;
  wrap.appendChild(UI.el('div', 'finder-sub dc-note', (dw
    ? 'Areas are ranked by the card value you\'d expect per ' + fmtCompact(DC_PER) + ' items dropped there. Drop weights are ' +
      'community estimates from opening stacked decks (Prohibited Library, via maps-of-exile, MIT; ' + (dw.league || '') +
      '), not GGG numbers, and monster density isn\'t counted: use it to compare areas. '
    : 'Drop rates aren\'t public, so areas are ranked by the cards that can drop there, not by expected value. ') +
    'Prices: GGG\'s currency exchange (last hour). Drop areas: Path of Exile Wiki (CC BY-NC-SA), updated through the ' +
    'app\'s server between releases.'));
  var body = UI.el('div', 'dc-body');
  body.appendChild(UI.el('div', 'finder-sub', isGui() ? 'Open this view to load drop data and prices.'
    : 'The Div cards tool needs the desktop app.'));
  wrap.appendChild(body);
  return wrap;
}
