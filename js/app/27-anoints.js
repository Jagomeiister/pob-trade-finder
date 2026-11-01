/* js/app/27-anoints.js — anoint helper, built into the Blight cheat sheet: every amulet, ring and
   blighted-map anoint with the oils it takes and what those oils cost now. Search a notable by
   name or by what it does (in the app), or click oils to see what they make (also over the game:
   click-only, no typing). Your build's anoint and your tree's notables are marked. The js/app/
   files are one program split by feature: they load in order (index.html) and share their
   top-level names. */
'use strict';

// Data: the Blight sheet (data/cheatsheets.js, from the PoE Wiki) for the recipes, the skill tree
// view (data/treeview.js) for each notable's stats, and anoint_oils (gui.py) for each oil's icon
// and price from GGG's hourly exchange feed.
var ANOINT_KINDS = [
  { key: 'amulet', label: 'Amulet', title: /^Amulet anoints/i, oils: 3 },
  { key: 'ring', label: 'Ring', title: /^Ring anoints/i, oils: 2 },
  { key: 'map', label: 'Blighted map', title: /^Blighted map anoints/i, oils: 1 }
];
var ANOINT_SHOW = 60; // rows drawn at once; "Show more" adds the rest
var anoint = { kind: 'amulet', picked: [], query: '', sort: 'name', more: false, prices: null, league: null, loading: false };

function anointBlight() { return typeof mechanicById === 'function' ? mechanicById('blight') : null; }
function anointSection(re) {
  var b = anointBlight();
  return b ? (b.sections || []).filter(function (s) { return re.test(s.title || ''); })[0] || null : null;
}
// oils in tier order (Clear → Golden), from the sheet's "Oil tiers" table
function anointOilOrder() {
  var s = anointSection(/^Oil tiers/i);
  return s ? s.rows.map(function (r) { return r[1]; }) : [];
}
function anointOilList(text) {
  return String(text || '').split(',').map(function (o) { return o.trim(); }).filter(Boolean);
}
// a notable's stat text, from the skill tree data (amulets only)
var anointStats_ = null;
function anointStats(name) {
  if (!anointStats_) {
    anointStats_ = {};
    ((window.POE_TREE_VIEW || {}).nodes || []).forEach(function (n) {
      if (n && (n[3] === 1 || n[3] === 2) && n[4] && !anointStats_[n[4]]) anointStats_[n[4]] = { id: n[0], stats: n[5] || '' };
    });
  }
  return anointStats_[name] || null;
}

// every recipe of one kind: { name, text, oils: [..] }
function anointRows(kind) {
  var k = ANOINT_KINDS.filter(function (x) { return x.key === kind; })[0];
  var s = k && anointSection(k.title);
  if (!s) return [];
  return s.rows.map(function (r) {
    if (kind === 'map') return { name: r[0].replace(/ Oil$/, '') + ' Oil', text: r[1] || '', oils: [r[0]] };
    var st = kind === 'amulet' ? anointStats(r[0]) : null;
    return { name: r[0], text: st ? st.stats : '', nodeId: st ? st.id : null, oils: anointOilList(r[1]) };
  });
}

// prices: chaos per oil (exchange feed), and the divine rate to show big totals in divines
async function anointLoadPrices(onDone) {
  var league = (document.getElementById('league') || {}).value || 'Standard';
  if (anoint.loading || (anoint.prices && anoint.league === league) || !isGui() || !window.pywebview.api.anoint_oils) return;
  anoint.loading = true;
  try {
    var r = await window.pywebview.api.anoint_oils(league);
    if (r && r.ok) { anoint.prices = r; anoint.league = league; }
  } catch (e) { /* no prices: recipes still show */ }
  anoint.loading = false;
  if (onDone) onDone();
}
function anointCost(oils) {
  var p = anoint.prices && anoint.prices.oils;
  if (!p) return null;
  var sum = 0;
  for (var i = 0; i < oils.length; i++) {
    var c = (p[oils[i]] || {}).chaos;
    if (c == null) return null;
    sum += c;
  }
  return sum;
}
function anointCostText(chaos) {
  if (chaos == null) return '';
  var div = anoint.prices && anoint.prices.divine;
  if (div && chaos >= div) return (Math.round(chaos / div * 10) / 10) + ' div';
  return (chaos < 10 ? Math.round(chaos * 10) / 10 : Math.round(chaos)) + 'c';
}

// picked oils match a recipe when every picked oil is in it (as many times as picked)
function anointUses(oils, picked) {
  var left = oils.slice();
  return picked.every(function (o) { var i = left.indexOf(o); if (i === -1) return false; left.splice(i, 1); return true; });
}
function anointMatches(row, q) {
  if (!q) return true;
  var hay = (row.name + ' ' + row.text + ' ' + row.oils.join(' ')).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) !== -1; });
}

// your build: the amulet's "Allocates X" and the notables already in your tree (24-cheatsheets.js)
function anointYours() {
  var b = typeof sheetBuild === 'function' ? sheetBuild() : {};
  var tree = {};
  (b.treeNodes || []).forEach(function (id) { tree[id] = 1; });
  return { anoint: b.anoint || null, tree: tree };
}

// an oil: its in-game icon; the name shows next to it (iconOnly: as a tooltip only), and alone
// when there's no icon (offline before the first download, or in a plain browser)
function anointOilIcon(name, cls, iconOnly) {
  var o = anoint.prices && anoint.prices.oils && anoint.prices.oils[name];
  var short = name.replace(/ Oil$/, '');
  var el = UI.el('span', 'anoint-oil' + (cls ? ' ' + cls : ''));
  el.title = name + (o && o.chaos != null ? ' · ' + anointCostText(o.chaos) : '');
  el.setAttribute('aria-label', name);
  var label = UI.el('span', 'anoint-oil-name', short);
  if (o && o.img) {
    var img = document.createElement('img');
    img.src = o.img;
    img.alt = '';
    img.loading = 'lazy';
    // a missing icon falls back to the oil's name, never a blank
    img.addEventListener('error', function () { img.remove(); el.classList.remove('has-icon', 'icon-only'); });
    el.appendChild(img);
    el.classList.add('has-icon');
    if (iconOnly) el.classList.add('icon-only');
  }
  el.appendChild(label);
  return el;
}

// The helper. opts.overlay: over the game (no search box: typing would go to the game).
// opts.onChange: called after it redraws (the overlay re-fits its window).
function anointHelper(opts) {
  opts = opts || {};
  var box = UI.el('div', 'anoint' + (opts.overlay ? ' is-overlay' : ''));
  function draw() {
    box.textContent = '';
    var kind = ANOINT_KINDS.filter(function (x) { return x.key === anoint.kind; })[0];
    var rows = anointRows(anoint.kind);
    if (!rows.length) {
      box.appendChild(UI.el('div', 'sheet-empty', 'Anoint data is missing from the Blight sheet.'));
      return;
    }
    // amulet / ring / map
    var tabs = UI.el('div', 'anoint-tabs');
    ANOINT_KINDS.forEach(function (k) {
      var n = anointRows(k.key).length;
      if (!n) return;
      var b = UI.el('button', 'anoint-tab' + (k.key === anoint.kind ? ' is-on' : ''), k.label + ' · ' + n);
      b.type = 'button';
      b.addEventListener('click', function () { anoint.kind = k.key; anoint.picked = []; anoint.more = false; draw(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    // oils: click to pick (up to the recipe size), click a picked one to remove it
    var order = anointOilOrder().filter(function (o) { return rows.some(function (r) { return r.oils.indexOf(o) !== -1; }); });
    var pal = UI.el('div', 'anoint-oils');
    order.forEach(function (o) {
      var count = anoint.picked.filter(function (x) { return x === o; }).length;
      var b = UI.el('button', 'anoint-oil-btn' + (count ? ' is-on' : ''));
      b.type = 'button';
      b.appendChild(anointOilIcon(o));
      var c = anoint.prices && anoint.prices.oils && anoint.prices.oils[o];
      if (c && c.chaos != null) b.appendChild(UI.el('span', 'anoint-oil-price', anointCostText(c.chaos)));
      if (count > 1) b.appendChild(UI.el('span', 'anoint-oil-count', '×' + count));
      b.title = 'Pick ' + o + (anoint.picked.length >= kind.oils ? ' (replaces the last pick)' : '');
      b.addEventListener('click', function () {
        if (anoint.picked.length >= kind.oils) anoint.picked.pop();
        anoint.picked.push(o);
        anoint.more = false;
        draw();
      });
      pal.appendChild(b);
    });
    box.appendChild(pal);

    var bar = UI.el('div', 'anoint-bar');
    var slots = UI.el('span', 'anoint-picked');
    for (var i = 0; i < kind.oils; i++) {
      var o = anoint.picked[i];
      if (o) {
        var chip = anointOilIcon(o, 'is-picked', true);
        (function (idx) {
          chip.title = 'Remove ' + o;
          chip.addEventListener('click', function () { anoint.picked.splice(idx, 1); draw(); });
        })(i);
        slots.appendChild(chip);
      } else {
        slots.appendChild(UI.el('span', 'anoint-slot', '?'));
      }
    }
    bar.appendChild(slots);
    if (anoint.picked.length) {
      bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear oils', onClick: function () { anoint.picked = []; draw(); } }));
    }
    if (!opts.overlay) {
      var q = UI.input({ type: 'search', placeholder: kind.key === 'amulet' ? 'Search a notable or what it does…' : 'Search…',
        value: anoint.query, ariaLabel: 'Search anoints', cls: 'anoint-search' });
      q.addEventListener('input', function () { anoint.query = q.value; anoint.more = false; drawRows(); });
      bar.appendChild(q);
      var sort = UI.select([['name', 'A–Z'], ['cost', 'Cheapest first'], ['dear', 'Priciest first']], anoint.sort,
        { ariaLabel: 'Sort anoints', onChange: function () { anoint.sort = sort.value; drawRows(); } });
      bar.appendChild(sort);
    }
    box.appendChild(bar);
    var list = UI.el('div', 'anoint-list');
    box.appendChild(list);
    if (!anoint.prices && anoint.loading) box.appendChild(UI.el('div', 'anoint-note', 'Loading oil prices…'));
    else if (anoint.prices && anoint.prices.hour) {
      box.appendChild(UI.el('div', 'anoint-note', 'Oil prices: GGG\'s currency exchange (' + anoint.league + ', last hour).'));
    }

    function drawRows() {
      list.textContent = '';
      var yours = anointYours();
      var shown = rows.filter(function (r) { return anointUses(r.oils, anoint.picked) && anointMatches(r, anoint.query); });
      shown.forEach(function (r) { r.cost = anointCost(r.oils); });
      if (anoint.sort !== 'name') {
        var dir = anoint.sort === 'cost' ? 1 : -1;
        shown.sort(function (a, b) {
          if (a.cost == null) return 1;
          if (b.cost == null) return -1;
          return dir * (a.cost - b.cost);
        });
      }
      // your build's anoint first
      shown.sort(function (a, b) { return (b.name === yours.anoint) - (a.name === yours.anoint); });
      var full = anoint.picked.length === kind.oils;
      list.appendChild(UI.el('div', 'anoint-count', !anoint.picked.length && !anoint.query
        ? shown.length + ' ' + kind.label.toLowerCase() + ' anoints'
        : full && shown.length === 1 ? 'These oils make:' : shown.length + ' match' + (shown.length === 1 ? '' : 'es')));
      var cap = opts.overlay ? 30 : ANOINT_SHOW;
      shown.slice(0, anoint.more ? shown.length : cap).forEach(function (r) {
        var row = UI.el('div', 'anoint-row' + (r.name === yours.anoint ? ' is-yours' : ''));
        var main = UI.el('div', 'anoint-main');
        var title = UI.el('div', 'anoint-name', r.name);
        if (r.name === yours.anoint) title.appendChild(UI.chip('your anoint', 'success'));
        else if (r.nodeId != null && yours.tree[r.nodeId]) title.appendChild(UI.chip('in your tree', 'neutral'));
        main.appendChild(title);
        if (r.text) main.appendChild(UI.el('div', 'anoint-text', r.text));
        row.appendChild(main);
        var oils = UI.el('div', 'anoint-row-oils');
        r.oils.forEach(function (o) { oils.appendChild(anointOilIcon(o, null, true)); });
        row.appendChild(oils);
        row.appendChild(UI.el('div', 'anoint-cost', anointCostText(r.cost)));
        if (!opts.overlay && kind.key !== 'map') {
          // pick these oils: shows the recipe on its own, e.g. to check you have them
          row.addEventListener('click', function () { anoint.picked = r.oils.slice(); anoint.query = ''; draw(); });
          row.title = 'Click: pick these oils';
        }
        list.appendChild(row);
      });
      if (!anoint.more && shown.length > cap) {
        list.appendChild(UI.button('ghost', { size: 'sm', label: 'Show all ' + shown.length, onClick: function () { anoint.more = true; drawRows(); } }));
      }
      if (!shown.length) list.appendChild(UI.el('div', 'sheet-empty', 'No anoint uses these oils' + (anoint.query ? ' and matches that search.' : '.')));
      if (opts.onChange) opts.onChange();
    }
    drawRows();
  }
  draw();
  anointLoadPrices(draw);
  return box;
}
