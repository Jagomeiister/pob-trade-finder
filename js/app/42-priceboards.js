/* js/app/42-priceboards.js — mechanic price boards: one small, sortable board of live exchange
   prices (with the game icons) per mechanic sheet — fossils by Delve biome, the essence tier grid,
   lifeforce per 1,000, oils by tier, Delirium, Breach, Legion, Expedition, catalysts and beasts.
   Every board is one call to priceBoard() (the shared shell: sort, "no price" line, price age
   footer), registered with mechTool() (40-mechtools.js) so it also shows on the in-game sheet's
   Tools tab, click-only there. Which items belong where comes from the cheat-sheet tables
   (data/cheatsheets.js) and the price feed's own groups; nothing here names a drop source the
   data does not. The js/app/ files are one program split by feature: they load in order
   (index.html) and share their top-level names. */
'use strict';

// ==== sheet data ====================================================================
// the mechanic sheet (the server-synced copy when there is one), a table by its title, a column
function pbSheet(id) {
  if (typeof mechanicById === 'function') { var m = mechanicById(id); if (m) return m; }
  var C = window.POE_CHEATSHEETS;
  return (C && (C.mechanics || []).filter(function (x) { return x.id === id; })[0]) || null;
}
function pbTable(id, re) {
  var m = pbSheet(id);
  return m ? (m.sections || []).filter(function (s) {
    return re.test(s.title || '') && Array.isArray(s.columns) && Array.isArray(s.rows);
  })[0] || null : null;
}
function pbCol(sec, re, fallback) {
  var i = sec ? sec.columns.findIndex(function (c) { return re.test(c || ''); }) : -1;
  return i === -1 ? (fallback == null ? -1 : fallback) : i;
}
function pbLines(id, re) {
  var m = pbSheet(id), out = [];
  ((m && m.sections) || []).forEach(function (s) {
    if (re.test(s.title || '')) out = out.concat(s.lines || []);
  });
  return out;
}
// every feed item of one price group (code → item), as a list
function pbFeed(group, re) {
  var items = MECH_PRICES.items || {};
  return Object.keys(items).map(function (c) { return items[c]; }).filter(function (it) {
    return it.group === group && (!re || re.test(it.name));
  });
}
// item names from the loot-filter icon list (game data): names for the boards whose items no
// sheet table lists, so they still show without the feed
function pbKnownNames(re) {
  return Object.keys(window.POE_FILTER_ICONS || {}).filter(function (n) { return re.test(n); });
}
// "Combine 100 Splinters to create a Timeless Vaal Emblem." → 100
function pbCombineCount(text) {
  var m = /Combine\s+([\d,]+)\s+Splinters?/i.exec(text || '');
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

// ==== price text ====================================================================
// like mechPriceText, with a fallback divine rate for prices that are not from the exchange feed
function pbPrice(chaos, div) {
  if (chaos == null || !isFinite(chaos)) return '';
  var d = MECH_PRICES.divine || div;
  if (d && Math.abs(chaos) >= d) return (Math.round(chaos / d * 10) / 10) + ' div';
  return mechPriceText(chaos);
}

// ==== the shared board shell ========================================================
var PB_SORTS = [['price', 'Price'], ['name', 'Name']];

function pbSortList(list, sort) {
  return list.slice().sort(function (a, b) {
    if (sort === 'tier') return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name);
    if (sort === 'name') return (a.label || a.name).localeCompare(b.label || b.name);
    var x = a.chaos, y = b.chaos;
    if (x == null && y == null) return a.name.localeCompare(b.name);
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x || a.name.localeCompare(b.name);
  });
}

// a visually hidden text for screen readers
function pbSr(text) { return UI.el('span', 'pb-sr', text); }

// one item tile: icon (when the feed has one), name, price; notes and marks under it
function pbTile(e, ov, div) {
  var price = pbPrice(e.chaos, div);
  var t = UI.el('div', 'pb-tile' + (e.mark ? ' is-best' : '') + (price ? '' : ' no-price'));
  t.dataset.name = e.name;
  var icon = mechIcon(e.name, { iconOnly: ov, cls: 'pb-item' });
  if (e.label) { var lab = icon.querySelector('.mech-item-name'); if (lab) lab.textContent = e.label; }
  icon.title = e.name + (price ? ' · ' + price : '') + (e.note ? ' · ' + e.note : '');
  t.appendChild(icon);
  var p = UI.el('span', 'pb-price');
  if (price) p.textContent = price;
  else { p.appendChild(document.createTextNode('–')); p.appendChild(pbSr('no price')); }
  t.appendChild(p);
  if (e.mark || e.tag) {
    var chips = UI.el('div', 'pb-chips');
    if (e.mark) chips.appendChild(UI.chip(e.mark, 'success', 'pb-mark'));
    if (e.tag) {
      var c = UI.chip(e.tag, 'info', 'pb-tag');
      if (e.tagTitle) c.title = e.tagTitle;
      chips.appendChild(c);
    }
    t.appendChild(chips);
  }
  if (e.note) t.appendChild(UI.el('div', 'pb-note', e.note));
  return t;
}

// tiles in labelled groups (o.groupOrder first, then the rest in the order they came)
function pbTiles(host, list, st, o, ov) {
  var order = (o.groupOrder ? o.groupOrder() : []).slice(), by = {};
  list.forEach(function (e) {
    var g = e.group || '';
    if (!by[g]) { by[g] = []; if (order.indexOf(g) === -1) order.push(g); }
    by[g].push(e);
  });
  var limit = st.all ? 0 : (ov ? o.limitOv : o.limit) || 0, shown = 0, total = list.length;
  order.forEach(function (g) {
    var items = by[g];
    if (!items || !items.length) return;
    if (limit && shown >= limit) return;
    if (limit) items = items.slice(0, limit - shown);
    shown += items.length;
    var sec = UI.el('section', 'pb-group');
    sec.dataset.group = g;
    var info = o.groupInfo ? o.groupInfo(g, by[g], st) : null;
    if (g || info) {
      var head = UI.el('div', 'pb-group-head');
      head.setAttribute('role', 'heading');
      head.setAttribute('aria-level', '4');
      head.appendChild(UI.el('span', 'pb-group-name', g));
      if (info && info.text) head.appendChild(UI.el('span', 'pb-group-info', info.text));
      if (info && info.mark) { head.appendChild(UI.chip(info.mark, 'success', 'pb-mark')); sec.classList.add('is-best'); }
      sec.appendChild(head);
    }
    var grid = UI.el('div', 'pb-tiles' + (o.layout === 'rows' ? ' is-rows' : ''));
    items.forEach(function (e) { grid.appendChild(pbTile(e, ov, st.div)); });
    sec.appendChild(grid);
    host.appendChild(sec);
  });
  if (limit && total > limit) {
    host.appendChild(UI.button('ghost', { size: 'sm', cls: 'pb-more', label: 'Show all ' + total,
      onClick: function () { st.all = true; st.redraw(true); } }));
  } else if (st.all && (ov ? o.limitOv : o.limit) && total > (ov ? o.limitOv : o.limit)) {
    host.appendChild(UI.button('ghost', { size: 'sm', cls: 'pb-more', label: 'Show fewer',
      onClick: function () { st.all = false; st.redraw(true); } }));
  }
}

// priceBoard(container, ctx, o): the shell every board uses.
//   o.id, o.groups (mech price groups), o.entries(st) → [{ name, label, chaos, group, note,
//   order, mark, tag, tagTitle }] (chaos defaults to the feed price), o.sorts / o.sort,
//   o.summary(list, st) → Node|string, o.body(host, list, st) (default: grouped tiles),
//   o.groupOrder(), o.groupInfo(group, items, st) → { text, mark }, o.controls(st) → [Node],
//   o.search (app only), o.limit / o.limitOv, o.layout ('rows'), o.load(cb) (default: mechPrices),
//   o.hasPrices(), o.foot() (default: mechPriceAge()), o.missing(list) → count
// each board's view (sort, "Show all", tiers, beast filter) per board and window, kept while the
// app runs, so a redraw of the sheet (league change, guide update) doesn't reset it
var PB_VIEW = {};
function priceBoard(container, ctx, o) {
  ctx = ctx || {};
  var ov = !!ctx.overlay;
  var view = PB_VIEW[o.id + (ov ? ':ov' : '')] = PB_VIEW[o.id + (ov ? ':ov' : '')] || {};
  var st = { sort: view.sort || o.sort || 'price', all: !!view.all, loaded: false, q: '', ov: ov, div: null,
    tiers: view.tiers, only: view.only };
  var root = UI.el('div', 'pb' + (ov ? ' is-overlay' : '') + (o.cls ? ' ' + o.cls : ''));
  root.dataset.board = o.id;

  var bar = UI.el('div', 'pb-bar');
  var sorts = o.sorts || PB_SORTS;
  if (sorts.length > 1) {
    bar.appendChild(UI.el('span', 'pb-bar-label', 'Sort'));
    var seg = UI.segmented(sorts, st.sort, { ariaLabel: 'Sort the ' + (o.what || 'items') + ' by',
      onChange: function (v) { st.sort = v; draw(true); } });
    seg.classList.add('pb-sort');
    bar.appendChild(seg);
  }
  (o.controls ? o.controls(st) : []).forEach(function (n) { if (n) bar.appendChild(n); });
  if (o.search && !ov) {
    bar.appendChild(mechSearch('Search ' + (o.what || 'items'), function (q) { st.q = q; draw(false); }));
  }
  root.appendChild(bar);
  var summary = UI.el('div', 'pb-summary');
  var body = UI.el('div', 'pb-body');
  var miss = UI.el('div', 'pb-missing');
  var foot = UI.el('div', 'mech-foot pb-foot');
  root.appendChild(summary);
  root.appendChild(body);
  root.appendChild(miss);
  root.appendChild(foot);

  function draw(changed) {
    view.sort = st.sort; view.all = st.all; view.tiers = st.tiers; view.only = st.only;
    var seen = {}, list = [];
    (o.entries(st) || []).forEach(function (e) {
      if (!e || !e.name) return;
      var key = (e.group || '') + '\u0001' + e.name;
      if (seen[key]) return;
      seen[key] = 1;
      if (e.chaos === undefined) e.chaos = mechChaos(e.name);
      list.push(e);
    });
    var all = list;
    if (st.q) list = list.filter(function (e) { return mechMatches(e.name + ' ' + (e.note || '') + ' ' + (e.tag || ''), st.q); });
    list = pbSortList(list, st.sort);

    summary.textContent = '';
    var s = o.summary ? o.summary(all, st) : null;
    if (s) { if (s.nodeType) summary.appendChild(s); else summary.textContent = s; }
    summary.hidden = !s;

    body.textContent = '';
    if (!list.length) {
      body.appendChild(UI.el('div', 'mech-empty', st.q ? 'Nothing matches that search.' :
        (isGui() && !st.loaded ? 'Loading prices…' : 'Nothing to show yet: the names come with the prices in the app.')));
    } else if (o.body) o.body(body, list, st);
    else pbTiles(body, list, st, o, ov);

    var names = {}, missing = 0;
    all.forEach(function (e) { if (e.chaos == null && !names[e.name]) { names[e.name] = 1; missing++; } });
    if (o.missing) missing = o.missing(all, st);
    var priced = o.hasPrices ? o.hasPrices() : !!MECH_PRICES.hour;
    miss.textContent = priced && missing ? (missing === 1 ? '1 item has no price this hour.' :
      missing + ' items have no price this hour.') : '';
    miss.hidden = !miss.textContent;

    if (isGui() && !st.loaded) foot.textContent = 'Loading prices…';
    else if (o.foot) foot.textContent = o.foot();
    else mechPriceFoot(foot);
    if (changed && ctx.onChange && root.isConnected) ctx.onChange();
  }
  st.redraw = draw;
  draw(false);
  container.appendChild(root);
  (o.load || function (cb) { mechPrices(o.groups || [], cb); })(function () { st.loaded = true; draw(true); });
  return root;
}

// ==== Delve: fossils by biome =======================================================
// [{ fossil, biome, node }] from the Fossils table (Biome column: "Fungal Caverns, Abyssal Depths",
// "Petrified Forest (Stonewood Hollow node)"), plus pairs only the Biomes table names
function pbDelveDrops() {
  var out = [], have = {}, biomes = [];
  var ft = pbTable('delve', /^Fossils/i), bt = pbTable('delve', /^Biomes/i);
  if (bt) {
    var bc = pbCol(bt, /^Biome/i, 0);
    bt.rows.forEach(function (r) { if (r[bc] && biomes.indexOf(r[bc]) === -1) biomes.push(r[bc]); });
  }
  function add(fossil, biome, node) {
    fossil = (fossil || '').trim(); biome = (biome || '').trim();
    if (!fossil || !biome || fossil === '-') return;
    var k = fossil + '|' + biome;
    if (have[k]) return;
    have[k] = 1;
    if (biomes.indexOf(biome) === -1) biomes.push(biome);
    out.push({ fossil: fossil, biome: biome, node: node || '' });
  }
  if (ft) {
    var fc = pbCol(ft, /^Fossil/i, 0), wc = pbCol(ft, /Biome/i, 2);
    ft.rows.forEach(function (r) {
      String(r[wc] || '').split(/,\s*(?![^(]*\))/).forEach(function (part) {
        var m = /^(.*?)\s*\((.+)\)\s*$/.exec(part.trim());
        add(r[fc], m ? m[1] : part, m ? m[2] : '');
      });
    });
  }
  if (bt) {
    var bc2 = pbCol(bt, /^Biome/i, 0), fc2 = pbCol(bt, /^Fossils/i, 1);
    bt.rows.forEach(function (r) {
      String(r[fc2] || '').split(/,\s*/).forEach(function (f) { add(f, r[bc2]); });
    });
  }
  return { drops: out, biomes: biomes };
}

// a biome's value: the average price of the fossils that drop anywhere in it (node-only ones,
// which need that one node, are left out)
function pbBiomeValues(drops) {
  var v = {};
  drops.forEach(function (d) {
    if (d.node) return;
    var c = mechChaos(d.fossil);
    var x = v[d.biome] || (v[d.biome] = { biome: d.biome, sum: 0, n: 0, count: 0 });
    x.count++;
    if (c != null) { x.sum += c; x.n++; }
  });
  return Object.keys(v).map(function (k) { var x = v[k]; x.avg = x.n ? x.sum / x.n : null; return x; });
}
function pbBestBiome(drops) {
  return pbBiomeValues(drops).filter(function (x) { return x.avg != null; })
    .sort(function (a, b) { return b.avg - a.avg; })[0] || null;
}

function pbMountDelve(container, ctx) {
  var D = pbDelveDrops();
  priceBoard(container, ctx, {
    id: 'delve', groups: ['fossils'], what: 'fossils',
    entries: function () {
      var list = D.drops.map(function (d) {
        return { name: d.fossil, group: d.biome, note: d.node ? 'only at the ' + d.node : '' };
      });
      var inBiome = {};
      D.drops.forEach(function (d) { inBiome[d.fossil] = 1; });
      pbFeed('fossils').forEach(function (it) {
        if (/Resonator/.test(it.name)) list.push({ name: it.name, group: 'Resonators' });
        else if (!inBiome[it.name]) list.push({ name: it.name, group: 'Other fossils' });
      });
      return list;
    },
    groupOrder: function () { return D.biomes.concat(['Other fossils', 'Resonators']); },
    groupInfo: function (g) {
      var v = pbBiomeValues(D.drops).filter(function (x) { return x.biome === g; })[0];
      if (!v) return null;
      var best = pbBestBiome(D.drops);
      return { text: v.avg != null ? 'avg ' + pbPrice(v.avg) : '',
               mark: best && best.biome === g ? 'Best now' : '' };
    },
    summary: function () {
      var best = pbBestBiome(D.drops), box = UI.el('div', 'pb-best');
      if (!best) {
        box.appendChild(UI.el('span', null, 'The best biome shows once prices are in.'));
        return box;
      }
      var line = UI.el('div', 'pb-best-line');
      line.appendChild(document.createTextNode('Best biome now: '));
      line.appendChild(UI.el('strong', 'pb-best-name', best.biome));
      line.appendChild(document.createTextNode(' (avg ' + pbPrice(best.avg) + ')'));
      box.appendChild(line);
      box.appendChild(UI.el('div', 'pb-rule', 'Rule: the average price of the fossils that drop anywhere in the biome. ' +
        'Fossils that drop only at one node are left out.'));
      return box;
    },
  });
}

// ==== Essences: group × tier grid ===================================================
function pbEssenceData() {
  var tt = pbTable('essences', /^Tiers/i), gt = pbTable('essences', /^Essences by group/i);
  var tiers = [];
  if (tt) {
    var lc = pbCol(tt, /^Level/i, 0), pc = pbCol(tt, /^Prefix/i, 1);
    tiers = tt.rows.slice().sort(function (a, b) { return (+a[lc] || 0) - (+b[lc] || 0); })
      .map(function (r) { return r[pc]; }).filter(Boolean);
  }
  var rows = [], special = [];
  if (gt) {
    var gc = pbCol(gt, /^Group/i, 0), ec = pbCol(gt, /^Essence/i, 1), rc = pbCol(gt, /^Tiers/i, 2);
    gt.rows.forEach(function (r) {
      var name = r[ec], range = String(r[rc] || '');
      var m = /^(\w+)\s*(?:\.\.\.|…|to)\s*(\w+)$/.exec(range.trim());
      var a = m ? tiers.indexOf(m[1]) : -1, b = m ? tiers.indexOf(m[2]) : -1;
      if (a !== -1 && b !== -1) rows.push({ base: name, label: name.replace(/^Essence of /, ''), group: r[gc], from: a, to: b });
      else special.push({ name: name, group: r[gc] });
    });
  }
  return { tiers: tiers, rows: rows, special: special };
}

function pbMountEssences(container, ctx) {
  var E = pbEssenceData(), ov = !!(ctx && ctx.overlay);
  var top = Math.min(3, E.tiers.length);
  priceBoard(container, ctx, {
    id: 'essences', groups: ['essences'], what: 'essences',
    controls: function (st) {
      st.tiers = st.tiers === 'all' ? 'all' : 'top';
      var seg = UI.segmented([['top', 'Top ' + top + ' tiers'], ['all', 'All ' + E.tiers.length]], st.tiers, {
        ariaLabel: 'Which essence tiers to show', onChange: function (v) { st.tiers = v; st.redraw(true); } });
      seg.classList.add('pb-tier-pick');
      return [seg];
    },
    entries: function () {
      var list = [], known = {};
      E.rows.forEach(function (r) {
        for (var i = r.from; i <= r.to; i++) {
          var n = E.tiers[i] + ' ' + r.base;
          known[n] = 1;
          list.push({ name: n, group: 'grid', base: r.base, tier: i, label: r.label });
        }
      });
      E.special.forEach(function (s) { known[s.name] = 1; list.push({ name: s.name, group: 'Special (one tier)' }); });
      pbFeed('essences').forEach(function (it) {
        if (!known[it.name]) list.push({ name: it.name, group: 'Other essences on the exchange' });
      });
      return list;
    },
    body: function (host, list, st) {
      var cols = [];
      for (var i = st.tiers === 'all' ? 0 : E.tiers.length - top; i < E.tiers.length; i++) cols.push(i);
      var cell = {};
      list.forEach(function (e) { if (e.group === 'grid') cell[e.base + '|' + e.tier] = e; });
      // rows sorted like the shell sorts items: by the best shown price, or by name
      var rows = E.rows.map(function (r) {
        var best = null;
        cols.forEach(function (i) { var e = cell[r.base + '|' + i]; if (e && e.chaos != null && (best == null || e.chaos > best)) best = e.chaos; });
        return { r: r, best: best };
      });
      rows.sort(function (a, b) {
        if (st.sort === 'name') return a.r.label.localeCompare(b.r.label);
        if (a.best == null && b.best == null) return a.r.label.localeCompare(b.r.label);
        if (a.best == null) return 1;
        if (b.best == null) return -1;
        return b.best - a.best || a.r.label.localeCompare(b.r.label);
      });
      if (st.q) rows = rows.filter(function (x) { return mechMatches(x.r.base, st.q); });
      if (rows.length) {
        var wrap = UI.el('div', 'pb-grid-wrap');
        var t = UI.el('table', 'pb-grid');
        t.setAttribute('aria-label', 'Essence prices by tier');
        var hr = UI.el('tr');
        var h0 = UI.el('th', 'pb-grid-corner', 'Essence');
        h0.scope = 'col';
        hr.appendChild(h0);
        cols.forEach(function (i) {
          var th = UI.el('th', null, E.tiers[i]);
          th.scope = 'col';
          th.dataset.tier = E.tiers[i];
          hr.appendChild(th);
        });
        var thead = UI.el('thead');
        thead.appendChild(hr);
        t.appendChild(thead);
        var tb = UI.el('tbody');
        rows.forEach(function (x) {
          var r = x.r, tr = UI.el('tr');
          tr.dataset.essence = r.base;
          var th = UI.el('th', 'pb-grid-name');
          th.scope = 'row';
          var icon = mechIcon(E.tiers[r.to] + ' ' + r.base, { cls: 'pb-item' });
          var lab = icon.querySelector('.mech-item-name');
          if (lab) lab.textContent = r.label;
          icon.title = r.base;
          th.appendChild(icon);
          tr.appendChild(th);
          cols.forEach(function (i) {
            var e = cell[r.base + '|' + i], td = UI.el('td', 'pb-cell');
            td.dataset.tier = E.tiers[i];
            if (!e) {
              td.classList.add('is-na');
              td.textContent = 'n/a';
              td.title = r.base + ' has no ' + E.tiers[i] + ' tier';
            } else if (e.chaos == null) {
              td.classList.add('is-none');
              td.appendChild(document.createTextNode('–'));
              td.appendChild(pbSr('no price'));
              td.title = e.name + ': no price this hour';
            } else {
              td.textContent = pbPrice(e.chaos);
              td.title = e.name + ' · ' + td.textContent;
              if (x.best != null && e.chaos === x.best) td.classList.add('is-top');
            }
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
        t.appendChild(tb);
        wrap.appendChild(t);
        host.appendChild(wrap);
      }
      var rest = list.filter(function (e) { return e.group !== 'grid'; });
      if (rest.length) pbTiles(host, rest, st, { groupOrder: function () { return ['Special (one tier)', 'Other essences on the exchange']; } }, ov);
    },
  });
}

// ==== Harvest: lifeforce per unit, 100 and 1,000 ====================================
function pbLifeforceNames() {
  var colours = [], crafts = {};
  var m = pbSheet('harvest');
  ((m && m.sections) || []).forEach(function (s) {
    if (!Array.isArray(s.rows) || !Array.isArray(s.columns)) return;
    var cc = pbCol(s, /Lifeforce/i);
    if (cc === -1) return;
    s.rows.forEach(function (r) {
      var mm = /\d[\d,]*\s+([A-Z][a-z]+)\b/.exec(String(r[cc] || ''));
      if (!mm) return;
      if (colours.indexOf(mm[1]) === -1) colours.push(mm[1]);
      crafts[mm[1]] = (crafts[mm[1]] || 0) + 1;
    });
  });
  var names = colours.map(function (c) { return c + ' Crystallised Lifeforce'; });
  pbFeed('lifeforce').map(function (it) { return it.name; })
    .concat(pbKnownNames(/ Crystallised Lifeforce$/))
    .forEach(function (n) { if (names.indexOf(n) === -1) names.push(n); });
  return { names: names, crafts: crafts };
}

function pbMountHarvest(container, ctx) {
  var ov = !!(ctx && ctx.overlay);
  function best(list) {
    return list.filter(function (e) { return e.chaos != null; })
      .sort(function (a, b) { return b.chaos - a.chaos; })[0] || null;
  }
  priceBoard(container, ctx, {
    id: 'harvest', groups: ['lifeforce'], what: 'lifeforce',
    entries: function () {
      var L = pbLifeforceNames();
      var list = L.names.map(function (n) {
        var colour = n.replace(/ Crystallised Lifeforce$/, '');
        return { name: n, label: colour, crafts: L.crafts[colour] || 0 };
      });
      list.forEach(function (e) { e.chaos = mechChaos(e.name); });
      var b = best(list);
      if (b) b.mark = 'Most valuable';
      return list;
    },
    summary: function (list) {
      var b = best(list);
      if (!b) return 'Lifeforce trades in bulk: the board shows the price per 100 and per 1,000.';
      var box = UI.el('div', 'pb-best-line');
      box.appendChild(document.createTextNode('Most valuable now: '));
      box.appendChild(UI.el('strong', 'pb-best-name', b.label));
      box.appendChild(document.createTextNode(' (' + pbPrice(b.chaos * 1000) + ' per 1,000)'));
      return box;
    },
    body: function (host, list) {
      var cols = [
        { key: 'name', label: 'Lifeforce', render: function (e) {
          var w = UI.el('span', 'pb-lf-name');
          var icon = mechIcon(e.name, { cls: 'pb-item' });
          var lab = icon.querySelector('.mech-item-name');
          if (lab) lab.textContent = e.label;
          w.appendChild(icon);
          if (e.mark) w.appendChild(UI.chip(e.mark, 'success', 'pb-mark'));
          return w;
        } },
        { key: 'each', label: 'Each', num: true, render: function (e) { return pbPrice(e.chaos) || '–'; } },
        { key: 'h', label: 'Per 100', num: true, render: function (e) { return e.chaos == null ? '–' : pbPrice(e.chaos * 100); } },
        { key: 'k', label: 'Per 1,000', num: true, render: function (e) { return e.chaos == null ? '–' : pbPrice(e.chaos * 1000); } },
      ];
      if (!ov) cols.push({ key: 'crafts', label: 'Crafts on this sheet', num: true,
        render: function (e) { return e.crafts ? String(e.crafts) : '–'; } });
      var t = UI.table(cols, list, { caption: null, rowClass: function (e) { return 'pb-lf-row' + (e.mark ? ' is-best' : ''); } });
      t.classList.add('pb-lf');
      Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (tr, i) { tr.dataset.name = list[i].name; });
      host.appendChild(t);
    },
  });
}

// ==== Blight: oils, low to high tier ================================================
function pbMountBlight(container, ctx) {
  priceBoard(container, ctx, {
    id: 'blight', groups: ['oils'], what: 'oils',
    sorts: [['tier', 'Tier'], ['price', 'Price'], ['name', 'Name']], sort: 'tier',
    entries: function () {
      var t = pbTable('blight', /^Oil tiers/i), list = [], known = {};
      if (t) {
        var tc = pbCol(t, /^Tier/i, 0), oc = pbCol(t, /^Oil/i, 1), dc = pbCol(t, /Drop level/i);
        t.rows.forEach(function (r) {
          known[r[oc]] = 1;
          list.push({ name: r[oc], group: 'Oils, low to high tier', order: +r[tc] || 0,
                      note: 'Tier ' + r[tc] + (dc !== -1 && r[dc] ? ' · drop level ' + r[dc] : '') });
        });
      }
      pbFeed('oils').forEach(function (it) {
        if (!known[it.name]) list.push({ name: it.name, group: 'Other oils', order: 1000 });
      });
      return list;
    },
    groupOrder: function () { return ['Oils, low to high tier', 'Other oils']; },
  });
}

// ==== splinters that combine into one item (Simulacrum, Timeless emblems) ===========
function pbCombineNote(splinter, n, target) {
  var a = mechChaos(splinter), b = mechChaos(target);
  var s = n + ' make 1 ' + target.replace(/^Timeless /, '');
  if (a != null) s += ' · ' + n + '× = ' + pbPrice(a * n);
  if (b != null) s += ' (one costs ' + pbPrice(b) + ')';
  return s;
}

// ==== Delirium ======================================================================
function pbMountDelirium(container, ctx) {
  priceBoard(container, ctx, {
    id: 'delirium', groups: ['delirium', 'fragments'], what: 'Delirium items',
    entries: function () {
      var list = [], known = {};
      var t = pbTable('delirium', /^Delirium Orbs/i);
      if (t) {
        var oc = pbCol(t, /^Orb/i, 0), rc = pbCol(t, /^Reward/i, 1);
        t.rows.forEach(function (r) {
          known[r[oc]] = 1;
          list.push({ name: r[oc], group: 'Delirium Orbs (in the game now)', note: r[rc] ? 'Reward: ' + r[rc] : '' });
        });
      }
      pbFeed('delirium').forEach(function (it) {
        if (!known[it.name]) list.push({ name: it.name, group: 'Other orbs on the exchange' });
      });
      // Simulacrum: the sheet's Simulacrum lines say how many splinters make one
      var n = null;
      pbLines('delirium', /Simulacrum/i).forEach(function (l) { n = n || pbCombineCount(l); });
      list.push({ name: 'Simulacrum Splinter', group: 'Simulacrum',
                  note: n ? pbCombineNote('Simulacrum Splinter', n, 'Simulacrum') : '' });
      list.push({ name: 'Simulacrum', group: 'Simulacrum' });
      return list;
    },
    groupOrder: function () { return ['Delirium Orbs (in the game now)', 'Simulacrum', 'Other orbs on the exchange']; },
  });
}

// ==== Breach ========================================================================
function pbMountBreach(container, ctx) {
  priceBoard(container, ctx, {
    // 'foulborn' (the Foulborn orbs) is not a gui.py MECH_GROUPS key yet: the bridge skips it,
    // and the orbs show without a price until it is added
    id: 'breach', groups: ['fragments', 'currency', 'foulborn'], what: 'Breach items',
    entries: function () {
      var list = [];
      var t = pbTable('breach', /^Breach currency/i);
      var title = t ? t.title : 'Breach currency and fragments';
      if (t) {
        var ic = pbCol(t, /^Item/i, 0);
        t.rows.forEach(function (r) { list.push({ name: r[ic], group: title }); });
      }
      var inSheet = {};
      list.forEach(function (e) { inSheet[e.name] = 1; });
      pbFeed('fragments', /Breachstone|^Splinter of |^Blessing of /).forEach(function (it) {
        if (inSheet[it.name]) return;
        list.push({ name: it.name, group: /Blessing/.test(it.name) ? 'Blessings' :
          /Breachstone/.test(it.name) ? 'Breachstones' : 'Splinters' });
      });
      return list;
    },
    groupOrder: function () { return ['Blessings', 'Splinters', 'Breachstones']; },
  });
}

// ==== Legion ========================================================================
function pbMountLegion(container, ctx) {
  priceBoard(container, ctx, {
    id: 'legion', groups: ['fragments'], what: 'Legion items',
    entries: function () {
      var list = [], combine = {};
      var sp = pbTable('legion', /^Splinters/i);
      if (sp) {
        var nc = pbCol(sp, /^Splinter/i, 0), uc = pbCol(sp, /^Use/i, 1);
        sp.rows.forEach(function (r) {
          var m = /create an? (.+?)\.?$/i.exec(r[uc] || '');
          combine[r[nc]] = { n: pbCombineCount(r[uc]), target: m ? m[1] : null };
        });
      }
      var lt = pbTable('legion', /^Legions/i), names = [];
      if (lt) {
        var sc = pbCol(lt, /Splinter/i, 2);
        lt.rows.forEach(function (r) { String(r[sc] || '').split(/\s*\/\s*/).forEach(function (n) { if (n) names.push(n); }); });
      }
      Object.keys(combine).forEach(function (n) { names.push(n); });
      pbFeed('fragments', /^Timeless .*(Splinter|Emblem)$/).forEach(function (it) { names.push(it.name); });
      names.forEach(function (n) {
        var c = combine[n];
        list.push({ name: n, group: /Splinter$/.test(n) ? 'Splinters' : 'Emblems',
                    note: c && c.n && c.target ? pbCombineNote(n, c.n, c.target) : '' });
      });
      return list;
    },
    groupOrder: function () { return ['Emblems', 'Splinters']; },
  });
}

// ==== Expedition ====================================================================
function pbMountExpedition(container, ctx) {
  priceBoard(container, ctx, {
    id: 'expedition', groups: ['expedition'], what: 'Expedition currency',
    entries: function () {
      var list = [];
      var t = pbTable('expedition', /^Vendors/i);
      if (t) {
        var vc = pbCol(t, /^Vendor/i, 0), cc = pbCol(t, /Refresh currency/i, 2);
        t.rows.forEach(function (r) {
          if (r[cc]) list.push({ name: r[cc], group: 'Vendor refresh currency', note: r[vc] ? r[vc] + '’s currency' : '' });
        });
      }
      pbFeed('expedition').forEach(function (it) {
        list.push({ name: it.name, group: /Logbook/i.test(it.name) ? 'Logbooks' : 'Vendor refresh currency' });
      });
      return list;
    },
    groupOrder: function () { return ['Vendor refresh currency', 'Logbooks']; },
  });
}

// ==== Catalysts =====================================================================
// on Ultimatum (3.29 made it the only drop source of catalysts: the verified tool research says so,
// and the board quotes that line) and Vendor recipes (a quality-items recipe gives one). Not on
// Expedition any more: 3.29 removed catalyst chests there, though the wiki table still lists them.
var PB_CATALYST_SHEETS = ['ultimatum', 'vendor'];
function pbCatalystSource(sheetId) {
  if (sheetId === 'ultimatum') {
    var rule = ((mechToolData().ultimatum || {}).rules || []).filter(function (r) { return /\bCatalysts?\b/.test(r.text); })[0];
    return rule ? rule.text : '';
  }
  var m = pbSheet(sheetId), hit = null;
  ((m && m.sections) || []).forEach(function (s) {
    (s.rows || []).forEach(function (r) {
      if (!hit && (r || []).some(function (c) { return /\bCatalysts?\b/.test(String(c || '')); })) hit = { s: s, r: r };
    });
  });
  if (!hit) return '';
  var rest = hit.r.slice(1).filter(function (c) { return c != null && String(c).trim(); });
  return hit.s.title + ': ' + hit.r[0] + (rest.length ? ' (' + rest.join(', ') + ')' : '');
}
function pbMountCatalysts(container, ctx) {
  priceBoard(container, ctx, {
    id: 'catalysts', groups: ['catalysts'], what: 'catalysts',
    entries: function () {
      var names = pbFeed('catalysts').map(function (it) { return it.name; });
      if (!names.length) names = pbKnownNames(/^(?!The ).+ Catalyst$/);
      return names.map(function (n) { return { name: n }; });
    },
    summary: function () {
      var s = pbCatalystSource(ctx && ctx.sheet);
      return s ? (ctx && ctx.sheet === 'ultimatum' ? s : 'On this sheet: ' + s) : null;
    },
  });
}

// ==== Bestiary ======================================================================
// beast prices: the app's poe.ninja snapshot (beast_prices); kept 20 min per league
var PB_BEASTS = { league: null, at: 0, r: null, waiting: {} };
// the beast prices for the league picked now (none while another league's answer is cached)
function pbBeastsNow() { return PB_BEASTS.league === mechLeague() ? PB_BEASTS.r : null; }
function pbBeastPrices(cb) {
  var B = PB_BEASTS, league = mechLeague();
  var api = isGui() && window.pywebview.api.beast_prices;
  if (!api) { cb(null); return; }
  if (B.league === league && B.r && Date.now() - B.at < MECH_PRICE_TTL) { cb(B.r); return; }
  // waiters per league: an answer only ever reaches (and is cached for) the league it was asked for
  var q = B.waiting[league] = B.waiting[league] || [];
  q.push(cb);
  if (q.length > 1) return; // one call in flight for this league
  window.pywebview.api.beast_prices(league).then(function (r) { return r && r.ok ? r : null; },
    function () { return null; }).then(function (r) {
    if (mechLeague() === league) { B.league = league; B.r = r; B.at = Date.now(); }
    var w = B.waiting[league] || [];
    delete B.waiting[league];
    w.forEach(function (f) { try { f(r); } catch (e) { /* board redraw */ } });
  });
}
function pbNorm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
// beast name (normalised) → the recipes (Type: Recipe) in the Bestiary sheet that use it
function pbBeastRecipes() {
  var t = pbTable('bestiary', /^Recipes/i), out = {};
  if (!t) return out;
  var tc = pbCol(t, /^Type/i, 0), rc = pbCol(t, /^Recipe/i, 1), bc = pbCol(t, /^Beasts/i, 2);
  t.rows.forEach(function (r) {
    String(r[bc] || '').split(/\s+\+\s+/).forEach(function (b) {
      b = b.trim();
      if (!b || /^Any /i.test(b)) return;
      var k = pbNorm(b);
      (out[k] || (out[k] = { name: b, recipes: [] })).recipes.push(r[tc] + (r[rc] ? ': ' + r[rc] : ''));
    });
  });
  return out;
}
function pbMountBestiary(container, ctx) {
  var R = pbBeastRecipes();
  priceBoard(container, ctx, {
    id: 'bestiary', what: 'beasts', search: true, layout: 'rows', limit: 40, limitOv: 12,
    load: function (cb) { pbBeastPrices(function () { cb(); }); },
    hasPrices: function () { var r = pbBeastsNow(); return !!(r && (r.items || []).length); },
    controls: function (st) {
      st.only = st.only === 'recipe' ? 'recipe' : 'all';
      var seg = UI.segmented([['all', 'All beasts'], ['recipe', 'Recipe beasts']], st.only, {
        ariaLabel: 'Which beasts to show', onChange: function (v) { st.only = v; st.all = false; st.redraw(true); } });
      seg.classList.add('pb-beast-pick');
      return [seg];
    },
    entries: function (st) {
      var r = pbBeastsNow(), list = [], seen = {};
      st.div = r && r.divine;
      function tagOf(name) {
        var x = R[pbNorm(name)];
        return x ? { tag: 'Recipe', tagTitle: 'Used in: ' + x.recipes.slice(0, 4).join('; ') +
          (x.recipes.length > 4 ? ' and ' + (x.recipes.length - 4) + ' more' : '') } : {};
      }
      ((r && r.items) || []).forEach(function (b) {
        if (!b || !b[0] || seen[pbNorm(b[0])]) return;
        seen[pbNorm(b[0])] = 1;
        var t = tagOf(b[0]);
        list.push({ name: b[0], chaos: b[1] != null && isFinite(b[1]) ? +b[1] : null, tag: t.tag, tagTitle: t.tagTitle,
                    note: b[2] != null ? b[2] + ' listed' : '' });
      });
      Object.keys(R).forEach(function (k) {
        if (seen[k]) return;
        var t = tagOf(R[k].name);
        list.push({ name: R[k].name, chaos: null, tag: t.tag, tagTitle: t.tagTitle });
      });
      if (st.only === 'recipe') list = list.filter(function (e) { return e.tag; });
      return list;
    },
    foot: function () {
      if (!isGui()) return 'Prices show in the app.';
      return pbBeastsNow() ? 'Beast prices: poe.ninja, through the app’s price backend (refreshed every 20 min).' :
        'No beast prices yet (offline, or the price backend has not answered).';
    },
  });
}

// ==== registry ======================================================================
[
  { id: 'pb-delve', title: 'Fossil prices by biome', sheets: ['delve'], mount: pbMountDelve },
  { id: 'pb-essences', title: 'Essence prices', sheets: ['essences'], mount: pbMountEssences },
  { id: 'pb-harvest', title: 'Lifeforce prices', sheets: ['harvest'], mount: pbMountHarvest },
  { id: 'pb-blight', title: 'Oil prices', sheets: ['blight'], mount: pbMountBlight },
  { id: 'pb-delirium', title: 'Delirium prices', sheets: ['delirium'], mount: pbMountDelirium },
  { id: 'pb-breach', title: 'Breach prices', sheets: ['breach'], mount: pbMountBreach },
  { id: 'pb-legion', title: 'Legion prices', sheets: ['legion'], mount: pbMountLegion },
  { id: 'pb-expedition', title: 'Expedition currency prices', sheets: ['expedition'], mount: pbMountExpedition },
  { id: 'pb-catalysts', title: 'Catalyst prices', sheets: PB_CATALYST_SHEETS, mount: pbMountCatalysts },
  { id: 'pb-bestiary', title: 'Beast prices', sheets: ['bestiary'], mount: pbMountBestiary },
].forEach(function (t) {
  mechTool({ id: t.id, title: t.title, sheets: t.sheets, overlay: true, order: 40,
             mount: function (container, ctx) { t.mount(container, ctx); } });
});
