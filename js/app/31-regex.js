/* js/app/31-regex.js — more Search text tabs (like poe.re): Items (rare / magic mods with
   values), Gems, Scarabs, Tattoos & Runegrafts, Beasts, Gwennen (Expedition), Heist.
   The frame, number helpers and the Maps / Vendor / Flasks tabs are in 21-search-text.js.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// Data (loaded when a tab first opens): data/searchdata.js (tools/make_searchdata.py: scarabs,
// tattoos, runegrafts, gems, Heist jobs and targets, Gwennen bases, each with the shortest
// piece of its name that no other one in its stash shows) and data/itemmods.js
// (tools/make_itemmods.py: the mods each base group can roll, with tiers and tokens).
var regexScripts = {};
function loadDataScript(src, name) {
  if (window[name]) return Promise.resolve(window[name]);
  if (!regexScripts[src]) {
    regexScripts[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src + '?v=' + Date.now();
      s.onload = function () { if (window[name]) resolve(window[name]); else { regexScripts[src] = null; reject(new Error(src + ' is empty')); } };
      s.onerror = function () { regexScripts[src] = null; reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  return regexScripts[src];
}
function ensureSearchData() { return loadDataScript('data/searchdata.js', 'POE_SEARCH_DATA'); }
function ensureItemMods() { return loadDataScript('data/itemmods.js', 'POE_ITEM_MODS'); }

// a token as search regex: the stored piece, or the whole name on its own line when no piece
// of it is unique (the generator stores those as ^name$ already)
function regexToken(row) { return row.t || '^' + searchEscape(String(row.n).toLowerCase()) + '$'; }

// The shortest piece of each name that no other name (and none of `common`) contains: for
// lists only known at run time (beasts come from the price feed). Pieces skip regex
// characters and digits; a name inside another name is matched whole on its own line.
function shortestTokens(names, common, minLen) {
  var low = names.map(function (n) { return String(n).toLowerCase(); });
  common = String(common || '').toLowerCase();
  minLen = minLen || 3;
  var out = {};
  low.forEach(function (s, i) {
    var found = null;
    for (var n = minLen; n <= s.length && !found; n++) {
      var cands = [];
      for (var k = 0; k + n <= s.length; k++) {
        var t = s.substr(k, n);
        if (t[0] === ' ' || t[n - 1] === ' ' || /[\d.*+?^${}()|[\]\\]/.test(t)) continue;
        if (common.indexOf(t) !== -1) continue;
        if (low.some(function (o, j) { return j !== i && o.indexOf(t) !== -1; })) continue;
        cands.push(t);
      }
      if (cands.length) {
        cands.sort(function (a, b) { return (a.indexOf(' ') !== -1) - (b.indexOf(' ') !== -1) || (a < b ? -1 : 1); });
        found = cands[0];
      }
    }
    out[names[i]] = found || '^' + searchEscape(s) + '$';
  });
  return out;
}

// ==== prices =============================================================================
// From what the app already reads: GGG's hourly exchange feed (scarabs, tattoos, runegrafts)
// and the backend's poe.ninja snapshot (beasts, uniques). Kept 30 minutes per league.
var REGEX_PRICE_TTL = 30 * 60 * 1000;
var regexPriceCache = {};
function regexLeague() { var l = document.getElementById('league'); return l ? l.value : ''; }
function regexPrices(kind) {
  var league = regexLeague(), key = kind + '|' + league, hit = regexPriceCache[key];
  if (hit && Date.now() - hit.at < REGEX_PRICE_TTL) return hit.p;
  if (!isGui()) return Promise.resolve({ ok: false, error: 'prices come with the desktop app' });
  var api = window.pywebview.api;
  var p = (async function () {
    if (kind === 'cx') {
      var r = await api.cx_overview(league);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'no answer' };
      var by = {}, div = null;
      Object.keys(r.items || {}).forEach(function (code) {
        var it = r.items[code], s = it.s || [], last = s[s.length - 1];
        if (last) by[it.name] = last[1];
        if (code === 'divine' && last) div = last[1];
      });
      return { ok: true, by: by, divine: div };
    }
    if (kind === 'beast') {
      var b = await api.beast_prices(league);
      if (!b || !b.ok) return { ok: false, error: (b && b.error) || 'no answer' };
      var bb = {}, listed = {};
      (b.items || []).forEach(function (x) { bb[x[0]] = x[1]; listed[x[0]] = x[2]; });
      return { ok: true, by: bb, listed: listed, divine: b.divine };
    }
    // uniques: the dearest unique on each base (what Gwennen's base might be)
    var u = await api.unique_prices(league);
    if (!u || !u.ok) return { ok: false, error: (u && u.error) || 'no answer' };
    var base = {}, top = {};
    (u.items || []).forEach(function (x) {
      if ((x[3] || 0) < 3 || !x[1]) return; // too few listings to trust
      if (!(x[1] in base) || x[2] > base[x[1]]) { base[x[1]] = x[2]; top[x[1]] = x[0]; }
    });
    return { ok: true, by: base, top: top, divine: u.divine };
  })().catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  regexPriceCache[key] = { at: Date.now(), p: p };
  p.then(function (r) { if (!r.ok) delete regexPriceCache[key]; });
  return p;
}
function regexPriceLabel(chaos, divine) {
  if (chaos == null) return '';
  if (divine && chaos >= divine) return (chaos / divine).toFixed(chaos >= divine * 10 ? 0 : 1) + ' div';
  return (chaos >= 10 ? Math.round(chaos) : +chaos.toFixed(1)) + 'c';
}

// ==== a priced list tab (scarabs, tattoos, beasts, Gwennen) ================================
// cfg: { id, label, help, rows(data, prices) -> [{ n, t, g, sub }], prices: 'cx'|'beast'|'unique',
//        groupLabel, before, data: () => Promise (data/searchdata.js by default) }
function makePricedTab(cfg) {
  function rowsFor(st, data, pr) {
    var rows = cfg.rows(data, pr, st) || [];
    rows.forEach(function (r) { r.price = pr && pr.ok ? pr.by[r.n] : undefined; });
    rows.sort(function (a, b) { return (b.price == null ? -1 : b.price) - (a.price == null ? -1 : a.price) || (a.n < b.n ? -1 : 1); });
    return rows;
  }
  function inRange(st, r) {
    var lo = +st.min || 0, hi = +st.max || 0;
    return r.price != null && r.price >= lo && (!hi || r.price <= hi);
  }
  var cache = { rows: [], pr: null };
  registerSearchTab({
    id: cfg.id, label: cfg.label, help: cfg.help,
    init: function () { return { picked: {}, min: '', max: '', filter: '', group: '' }; },
    text: function (st) {
      var toks = cache.rows.filter(function (r) { return st.picked[r.n]; }).map(regexToken);
      // picks from a saved preset whose rows haven't loaded yet: their tokens were saved too
      Object.keys(st.picked).forEach(function (n) {
        if (typeof st.picked[n] === 'string' && !cache.rows.some(function (r) { return r.n === n; })) toks.push(st.picked[n]);
      });
      return searchAny(toks);
    },
    draw: function (body, st, ctx) {
      st.picked = st.picked || {};
      var status = UI.el('div', 'finder-sub st-status', 'Loading…');
      body.appendChild(status);
      var bar = UI.el('div', 'st-controls');
      var f = UI.input({ placeholder: 'Filter', value: st.filter || '', width: '160px', ariaLabel: 'Filter ' + cfg.label.toLowerCase() });
      f.addEventListener('input', function () { st.filter = f.value; drawList(); });
      bar.appendChild(f);
      var groupBox = UI.el('span');
      bar.appendChild(groupBox);
      bar.appendChild(searchNumber('Price from', st.min, function (v) { st.min = v; drawList(); }, { aria: 'Lowest price in chaos' }));
      bar.appendChild(searchNumber('to', st.max, function (v) { st.max = v; drawList(); }, { aria: 'Highest price in chaos (empty = no limit)' }));
      bar.appendChild(UI.el('span', 'finder-sub', 'chaos'));
      bar.appendChild(UI.button('secondary', { size: 'sm', label: 'Pick the dearest in range',
        title: 'Ticks every one priced in this range, dearest first, until the search box is full', onClick: function () {
          var toks = [];
          st.picked = {};
          cache.rows.filter(function (r) { return inRange(st, r); }).forEach(function (r) {
            var t = regexToken(r);
            if (searchAny(toks.concat(t)).length <= SEARCH_LIMIT) { toks.push(t); st.picked[r.n] = t; }
          });
          drawList(); ctx.out();
        } }));
      bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { st.picked = {}; drawList(); ctx.out(); } }));
      body.appendChild(bar);
      var holder = UI.el('div');
      body.appendChild(holder);
      function drawList() {
        holder.textContent = '';
        var q = (st.filter || '').toLowerCase();
        var rows = cache.rows.filter(function (r) {
          return (!q || r.n.toLowerCase().indexOf(q) !== -1 || (r.sub || '').toLowerCase().indexOf(q) !== -1) &&
            (!st.group || r.g === st.group) && (!(+st.min || +st.max) || inRange(st, r));
        });
        var div = cache.pr && cache.pr.divine;
        holder.appendChild(searchPickList(rows.map(function (r) {
          return { key: r.n, label: r.n, sub: r.sub, token: regexToken(r), chip: regexPriceLabel(r.price, div),
                   chipTone: r.price != null && div && r.price >= div ? 'divine' : 'neutral' };
        }), st.picked, function (r) {
          if (st.picked[r.key]) st.picked[r.key] = r.token; // keep the token: presets work before data loads
          drawList(); ctx.out();
        }, { empty: cache.rows.length ? 'Nothing in this filter or price range.' : 'Nothing to show yet.' }));
      }
      (cfg.data || ensureSearchData)().then(function (data) {
        cache.rows = rowsFor(st, data, null);
        drawGroups(); drawList(); ctx.out();
        status.textContent = 'Prices loading…';
        return regexPrices(cfg.prices).then(function (pr) {
          cache.pr = pr;
          cache.rows = rowsFor(st, data, pr);
          status.textContent = pr.ok ? cfg.help2 || 'Prices for ' + regexLeague() + '.' : 'No prices (' + pr.error + '): pick by hand.';
          drawGroups(); drawList(); ctx.out();
        });
      }).catch(function (e) { status.textContent = 'Could not load the list: ' + (e && e.message || e); });
      function drawGroups() {
        groupBox.textContent = '';
        var groups = {};
        cache.rows.forEach(function (r) { if (r.g) groups[r.g] = 1; });
        var names = Object.keys(groups).sort();
        if (names.length < 2) return;
        groupBox.appendChild(UI.field(cfg.groupLabel || 'Group', UI.select([['', 'all']].concat(names.map(function (g) { return [g, g]; })),
          st.group || '', { onChange: function () { st.group = this.value; drawList(); } })));
      }
    }
  }, cfg.before || 'custom');
}

makePricedTab({
  id: 'scarabs', label: 'Scarabs', prices: 'cx', groupLabel: 'Kind',
  help: 'Tick scarabs, or set a price range and pick the dearest. Open your fragment tab (scarab section), then paste.',
  rows: function (d) { return (d.scarabs || []).map(function (s) { return { n: s.n, t: s.t, g: s.g, sub: s.d }; }); }
});
makePricedTab({
  id: 'tattoos', label: 'Tattoos', prices: 'cx', groupLabel: 'Kind',
  help: 'Tattoos and runegrafts. Tick them, or set a price range and pick the dearest. Open your currency tab, then paste.',
  rows: function (d) {
    return (d.tattoos || []).map(function (s) { return { n: s.n, t: s.t, g: 'Tattoos', sub: s.d }; })
      .concat((d.runegrafts || []).map(function (s) { return { n: s.n, t: s.t, g: 'Runegrafts', sub: s.d }; }));
  }
});
// beasts: the list is whatever poe.ninja prices (names straight from the feed)
makePricedTab({
  id: 'beasts', label: 'Beasts', prices: 'beast',
  help: 'Captured beasts poe.ninja prices. Set a price range and pick the dearest, then paste into the Bestiary search. ' +
        'Short pieces are unique among the priced beasts; a rare beast with a similar name may light up too.',
  data: function () {
    return regexPrices('beast').then(function (pr) { return { beasts: pr.ok ? Object.keys(pr.by) : [] }; });
  },
  rows: function (d) {
    var tok = shortestTokens(d.beasts, 'item class: rarity: captured beast', 4);
    return d.beasts.map(function (n) { return { n: n, t: tok[n] }; });
  }
});
// Gwennen sells unidentified uniques that show only their base: rank bases by their dearest unique
makePricedTab({
  id: 'gwennen', label: 'Gwennen', prices: 'unique', groupLabel: 'Item type',
  help: 'Gwennen (Expedition) shows unidentified uniques as their base. Bases are priced by their dearest unique; ' +
        'set a minimum and pick the dearest, then paste into her window.',
  rows: function (d, pr) {
    var top = pr && pr.ok ? pr.top : {};
    return (d.gwennen || []).filter(function (b) { return !pr || !pr.ok || b.n in pr.by; }).map(function (b) {
      return { n: b.n, t: b.t, g: b.c, sub: top[b.n] ? 'best: ' + top[b.n] : '' };
    });
  }
});

// ==== Gems ===============================================================================
var GEM_KINDS = [['all', 'all gems'], ['skill', 'skill gems'], ['support', 'supports'], ['awakened', 'awakened'],
                 ['transfigured', 'transfigured'], ['vaal', 'Vaal gems']];
function gemSearchText(g) {
  var names = Object.keys(g.picked || {}).map(function (n) { return g.picked[n]; }).filter(function (t) { return typeof t === 'string'; });
  var parts = [searchAny(names)];
  if (+g.level > 0) parts.push(searchQuote('level: ' + atLeastRegex(g.level)));
  if (+g.quality > 0) parts.push(searchQuote('quality: \\+' + atLeastRegex(g.quality) + '%'));
  if (g.corrupted === 'yes') parts.push(searchQuote('^corrupted$')); else if (g.corrupted === 'no') parts.push(searchQuote('!^corrupted$'));
  return searchJoin(parts);
}
registerSearchTab({
  id: 'gems', label: 'Gems',
  help: 'Tick gems (or add your build\'s), and set a level or quality. For Lilly\'s and other vendors, or your gem tab.',
  init: function () { return { picked: {}, kind: 'all', colour: '', filter: '', level: '', quality: '', corrupted: 'any' }; },
  text: gemSearchText,
  draw: function (body, g, ctx) {
    g.picked = g.picked || {};
    var status = UI.el('div', 'finder-sub st-status', 'Loading gems…');
    body.appendChild(status);
    var bar = UI.el('div', 'st-controls');
    var f = UI.input({ placeholder: 'Filter gems', value: g.filter || '', width: '160px', ariaLabel: 'Filter gems' });
    f.addEventListener('input', function () { g.filter = f.value; drawList(); });
    bar.appendChild(f);
    bar.appendChild(UI.field('Show', UI.select(GEM_KINDS, g.kind || 'all', { onChange: function () { g.kind = this.value; drawList(); } })));
    bar.appendChild(UI.field('Colour', UI.select([['', 'any'], ['r', 'red'], ['g', 'green'], ['b', 'blue'], ['w', 'white']], g.colour || '',
      { onChange: function () { g.colour = this.value; drawList(); } })));
    var mine = UI.button('secondary', { size: 'sm', label: 'Add my build\'s gems', onClick: function () {
      var have = {};
      ((typeof build !== 'undefined' && build && build.gems) || []).forEach(function (x) { if (x && x.name) have[x.name.toLowerCase()] = 1; });
      var n = 0;
      gems.forEach(function (x) { if (have[x.n.toLowerCase()] && !g.picked[x.n]) { g.picked[x.n] = regexToken(x); n++; } });
      UI.toast(n ? 'Added ' + n + ' gem' + (n > 1 ? 's' : '') + ' from your build.' : 'No gems from your build to add.', n ? 'success' : 'warn');
      drawList(); ctx.out();
    } });
    mine.disabled = !(typeof build !== 'undefined' && build && (build.gems || []).length);
    if (mine.disabled) mine.title = 'Load a build first';
    bar.appendChild(mine);
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { g.picked = {}; drawList(); ctx.out(); } }));
    body.appendChild(bar);
    var lb = UI.el('div', 'st-controls');
    lb.appendChild(searchNumber('Level ≥', g.level, function (v) { g.level = v; ctx.out(); }, { max: 21, aria: 'Minimum gem level' }));
    lb.appendChild(searchNumber('Quality ≥ %', g.quality, function (v) { g.quality = v; ctx.out(); }, { max: 23, aria: 'Minimum gem quality' }));
    lb.appendChild(searchTri('Corrupted', g.corrupted, function (v) { g.corrupted = v; ctx.out(); }));
    body.appendChild(lb);
    var holder = UI.el('div');
    body.appendChild(holder);
    var gems = [];
    function drawList() {
      holder.textContent = '';
      var q = (g.filter || '').toLowerCase();
      var rows = gems.filter(function (x) {
        if (q && x.n.toLowerCase().indexOf(q) === -1) return false;
        if (g.colour && x.c !== g.colour) return false;
        switch (g.kind) {
          case 'skill': return !x.s;
          case 'support': return !!x.s;
          case 'awakened': return !!x.a;
          case 'transfigured': return !!x.x;
          case 'vaal': return /^vaal /i.test(x.n);
          default: return true;
        }
      });
      var shown = rows.slice(0, 300);
      // picked gems first, so they stay in view
      shown.sort(function (a, b) { return (!g.picked[a.n]) - (!g.picked[b.n]); });
      holder.appendChild(searchPickList(shown.map(function (x) {
        return { key: x.n, label: x.n, token: regexToken(x), chip: x.s ? 'support' : '', sub: '' };
      }), g.picked, function (r) {
        if (g.picked[r.key]) g.picked[r.key] = r.token;
        drawList(); ctx.out();
      }, { empty: 'No gems match.' }));
      if (rows.length > shown.length) holder.appendChild(UI.el('div', 'finder-sub', (rows.length - shown.length) + ' more: filter to narrow down.'));
    }
    ensureSearchData().then(function (d) {
      gems = (d.gems || []).slice().sort(function (a, b) { return a.n < b.n ? -1 : 1; });
      status.hidden = true;
      drawList();
    }).catch(function (e) { status.textContent = 'Could not load gems: ' + (e && e.message || e); });
  }
}, 'scarabs');

// ==== Heist ==============================================================================
// A contract reads "Requires Deception (Level 4)" and "Heist Target: <name>".
function heistSearchText(h) {
  var jobs = [];
  Object.keys(h.jobs || {}).forEach(function (t) {
    var j = h.jobs[t];
    if (!j || !j.on) return;
    var lo = Math.max(1, Math.min(5, +j.lo || 1)), hi = Math.max(lo, Math.min(5, +j.hi || 5));
    jobs.push(lo === 1 && hi === 5 ? t : t + '.*' + srxClass(lo, hi));
  });
  var targets = Object.keys(h.targets || {}).map(function (n) { return h.targets[n]; }).filter(function (t) { return typeof t === 'string'; });
  if (h.both && jobs.length && targets.length) return searchJoin([searchAny(jobs), searchAny(targets)]);
  return searchAny(jobs.concat(targets));
}
var HEIST_PRESETS = [
  ['Gianna (Deception, Perception, Counter-Thaumaturgy)', { deception: [1, 5], perception: [1, 2], counter: [1, 3] }]
];
registerSearchTab({
  id: 'heist', label: 'Heist',
  help: 'Contracts by job and level, and by target. Open your contract tab, then paste.',
  init: function () { return { jobs: {}, targets: {}, both: false }; },
  text: heistSearchText,
  draw: function (body, h, ctx) {
    h.jobs = h.jobs || {}; h.targets = h.targets || {};
    var status = UI.el('div', 'finder-sub st-status', 'Loading…');
    body.appendChild(status);
    var bar = UI.el('div', 'st-controls');
    bar.appendChild(searchCheck('Need both a job and a target', h.both, function (v) { h.both = v; ctx.out(); },
      'Off: a contract with any ticked job or any ticked target matches'));
    bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { h.jobs = {}; h.targets = {}; ctx.redraw(); } }));
    body.appendChild(bar);
    var jobsBox = UI.el('div', 'st-list st-preset-list');
    body.appendChild(searchSection('Jobs and levels', jobsBox, true));
    var tgtBox = UI.el('div');
    body.appendChild(searchSection('Targets', tgtBox, false));
    ensureSearchData().then(function (d) {
      status.hidden = true;
      var heist = d.heist || { jobs: [], targets: [] };
      var presetRow = UI.el('div', 'st-controls');
      HEIST_PRESETS.forEach(function (p) {
        presetRow.appendChild(UI.button('ghost', { size: 'sm', label: p[0], onClick: function () {
          h.jobs = {};
          Object.keys(p[1]).forEach(function (k) {
            var job = heist.jobs.find(function (j) { return j.n.toLowerCase().indexOf(k) === 0; });
            if (job) h.jobs[job.t] = { on: true, lo: p[1][k][0], hi: p[1][k][1] };
          });
          ctx.redraw();
        } }));
      });
      jobsBox.appendChild(presetRow);
      heist.jobs.forEach(function (j) {
        var s = h.jobs[j.t] = h.jobs[j.t] || { on: false, lo: 1, hi: 5 };
        var row = UI.el('div', 'st-mod' + (s.on ? ' is-want' : ''));
        row.appendChild(searchCheck(j.n, s.on, function (v) { s.on = v; row.classList.toggle('is-want', v); ctx.out(); }));
        var lv = [1, 2, 3, 4, 5].map(function (n) { return [String(n), String(n)]; });
        row.appendChild(UI.field('level', UI.select(lv, String(s.lo || 1), { ariaLabel: j.n + ' lowest level',
          onChange: function () { s.lo = +this.value; ctx.out(); } })));
        row.appendChild(UI.field('to', UI.select(lv, String(s.hi || 5), { ariaLabel: j.n + ' highest level',
          onChange: function () { s.hi = +this.value; ctx.out(); } })));
        row.appendChild(UI.el('code', 'st-token', j.t));
        jobsBox.appendChild(row);
      });
      tgtBox.appendChild(searchPickList((heist.targets || []).map(function (t) {
        return { key: t.n, label: t.n, token: regexToken(t) };
      }), h.targets, function (r) {
        if (h.targets[r.key]) h.targets[r.key] = r.token;
        ctx.redraw();
      }));
      ctx.out();
    }).catch(function (e) { status.textContent = 'Could not load Heist data: ' + (e && e.message || e); });
  }
}, 'custom');

// ==== Items (rare and magic, by base) ======================================================
// Rare: each ticked mod as its token, with an optional minimum on its first number ("+73(70-79)
// to maximum Life": the rolled value is the number right before "("). Magic: the item's name
// carries its affix names ("Hale Iron Ring of the Fox"), so pick the tiers you'd keep.
function itemModTerm(mod, min) {
  if (!(+min > 0)) return mod.r;
  // decimals: start at the whole number, or "2.3(" would read as 3
  var num = mod.d ? '(^|[^\\d.])' + atLeastRegex(min) + '(\\.\\d+)?\\(' : atLeastRegex(min) + '\\(';
  // a token that only works from the start of the line carries its own number slot
  if (mod.q) return mod.q.replace('#', num);
  // two numbers on one line ("Adds # to # Fire Damage"): pin the minimum to the first one by
  // spelling out the text before it from the start of the line
  var t = String(mod.t || '');
  if (t.indexOf(' / ') === -1 && (t.match(/#/g) || []).length >= 2) {
    var head = '^' + searchEscape(t.slice(0, t.indexOf('#')).toLowerCase()) + num;
    return mod.o || mod.r.charAt(0) === '^' ? head : head + '.*' + mod.r;
  }
  return mod.o ? mod.r + '.*' + num : num + '.*' + mod.r;
}
function itemSearchText(it) {
  var D = window.POE_ITEM_MODS;
  if (!D || !it.group) return '';
  var picks = it.picks || {};
  var chosen = Object.keys(picks).filter(function (k) { return picks[k] && picks[k].on && D.mods[k]; });
  if (it.rarity === 'magic') {
    var P = [], S = [];
    chosen.forEach(function (k) {
      var m = D.mods[k], tiers = m.x || [], upto = Math.max(1, Math.min(tiers.length, +picks[k].tier || tiers.length));
      tiers.slice(0, upto).forEach(function (x) {
        var name = searchEscape(String(x[1] || '').toLowerCase());
        if (!name) return;
        var list = m.k === 'p' ? P : S;
        if (list.indexOf(name) === -1) list.push(name);
      });
    });
    var pre = P.length ? '(' + P.join('|') + ')' : '', suf = S.length ? '(' + S.join('|') + ')' : '';
    var term;
    if (it.magicBoth && pre && suf) term = '^' + pre + ' .* ' + suf + '$';
    else term = [pre ? '^' + pre + ' ' : '', suf ? ' ' + suf + '$' : ''].filter(Boolean).join('|');
    return searchJoin([searchQuote(term), it.rarityLine ? searchQuote('y: m') : '']);
  }
  var pTerms = [], sTerms = [];
  chosen.forEach(function (k) {
    var t = itemModTerm(D.mods[k], picks[k].min);
    (D.mods[k].k === 'p' ? pTerms : sTerms).push(t);
  });
  var all = pTerms.concat(sTerms), out;
  if (it.mode === 'any') out = searchAny(all);
  else if (it.mode === 'ps') out = searchJoin([searchAny(pTerms), searchAny(sTerms)]);
  else out = searchAll(all);
  return searchJoin([out, it.rarityLine ? searchQuote('y: r') : '']);
}
registerSearchTab({
  id: 'items', label: 'Items',
  help: 'Pick a base, then the mods you want. Rare: an optional minimum per mod. Magic: matches the affix names in the item\'s name (for alteration crafting).',
  init: function () { return { group: '', rarity: 'rare', mode: 'all', picks: {}, filter: '', magicBoth: false, rarityLine: false }; },
  text: itemSearchText,
  draw: function (body, it, ctx) {
    it.picks = it.picks || {};
    var status = UI.el('div', 'finder-sub st-status', 'Loading item mods…');
    body.appendChild(status);
    var bar = UI.el('div', 'st-controls');
    body.appendChild(bar);
    var holder = UI.el('div');
    body.appendChild(holder);
    ensureItemMods().then(function (D) {
      status.hidden = true;
      var groups = (D.groups || []).map(function (g, i) { return [String(i), g.n]; })
        .sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
      if (it.group === '' || !D.groups[it.group]) it.group = groups.length ? groups[0][0] : '';
      bar.appendChild(UI.field('Base', UI.select(groups, it.group, { ariaLabel: 'Base group', onChange: function () {
        it.group = this.value; it.picks = {}; ctx.redraw();
      } })));
      bar.appendChild(UI.segmented([['rare', 'Rare'], ['magic', 'Magic']], it.rarity || 'rare', { ariaLabel: 'Rarity',
        onChange: function (v) { it.rarity = v; ctx.redraw(); } }));
      if (it.rarity === 'magic') {
        bar.appendChild(searchCheck('Needs both a prefix and a suffix', it.magicBoth, function (v) { it.magicBoth = v; ctx.out(); }));
      } else {
        bar.appendChild(UI.field('Items must have', UI.select([['all', 'all of these'], ['any', 'any of these'],
          ['ps', 'a ticked prefix and a ticked suffix']], it.mode || 'all', { onChange: function () { it.mode = this.value; ctx.out(); } })));
      }
      bar.appendChild(searchCheck(it.rarity === 'magic' ? 'Only magic items' : 'Only rare items', it.rarityLine,
        function (v) { it.rarityLine = v; ctx.out(); }));
      var f = UI.input({ placeholder: 'Filter mods', value: it.filter || '', width: '160px', ariaLabel: 'Filter item mods' });
      f.addEventListener('input', function () { it.filter = f.value; drawList(); });
      bar.appendChild(f);
      bar.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear', onClick: function () { it.picks = {}; drawList(); ctx.out(); } }));
      var g = D.groups[it.group];
      if (g) {
        var bases = g.b || [];
        holder.parentNode.insertBefore(UI.el('div', 'finder-sub st-bases', 'Bases: ' + bases.slice(0, 12).join(', ') +
          (bases.length > 12 ? ' and ' + (bases.length - 12) + ' more' : '')), holder);
      }
      function drawList() {
        holder.textContent = '';
        if (!g) return;
        var q = (it.filter || '').toLowerCase();
        ['p', 's'].forEach(function (kind) {
          var mods = (g.m || []).filter(function (k) {
            var m = D.mods[k];
            return m && m.k === kind && (!q || m.t.toLowerCase().indexOf(q) !== -1);
          });
          if (!mods.length) return;
          holder.appendChild(UI.el('div', 'st-group', kind === 'p' ? 'Prefixes' : 'Suffixes'));
          var list = UI.el('div', 'st-list');
          mods.forEach(function (k) {
            var m = D.mods[k], p = it.picks[k] || {};
            var row = UI.el('div', 'st-mod' + (p.on ? ' is-want' : ''));
            var b = UI.button('ghost', { size: 'sm', cls: 'st-pick', label: '✓', ariaLabel: 'Want: ' + m.t, title: 'Want', onClick: function () {
              if (p.on) delete it.picks[k]; else it.picks[k] = Object.assign(p, { on: true });
              drawList(); ctx.out();
            } });
            b.setAttribute('aria-pressed', p.on ? 'true' : 'false');
            row.appendChild(b);
            var tiers = m.x || [];
            var best = tiers[0] && tiers[0][2] ? tiers[0][2] : null;
            var txt = UI.el('span', 'st-mod-text', m.t);
            if (best) txt.appendChild(UI.el('span', 'st-sub', 'best ' + best[0] + '–' + best[1] + ' · ' + tiers.length + ' tiers'));
            row.appendChild(txt);
            if (it.rarity === 'magic') {
              var opts = tiers.map(function (x, i) { return [String(i + 1), 'T' + (i + 1) + ' ' + (x[1] || '') + (i ? ' or better' : '')]; });
              if (opts.length) {
                row.appendChild(UI.select(opts, String(p.tier || tiers.length), { ariaLabel: 'Lowest tier for ' + m.t,
                  onChange: function () { p.tier = +this.value; it.picks[k] = Object.assign(p, { on: true }); drawList(); ctx.out(); } }));
              }
            } else {
              var mn = UI.input({ type: 'number', min: 0, value: p.min || '', width: '70px', ariaLabel: 'Minimum for ' + m.t,
                placeholder: best ? String(tiers[tiers.length - 1][2][0]) + '+' : 'min' });
              mn.addEventListener('input', function () {
                p.min = mn.value;
                if (+mn.value > 0) it.picks[k] = Object.assign(p, { on: true });
                row.classList.toggle('is-want', !!(it.picks[k] && it.picks[k].on));
                b.setAttribute('aria-pressed', it.picks[k] && it.picks[k].on ? 'true' : 'false');
                ctx.out();
              });
              row.appendChild(mn);
            }
            row.appendChild(UI.el('code', 'st-token', it.rarity === 'magic' ? (tiers[0] && tiers[0][1]) || '' : itemModTerm(m, p.min)));
            list.appendChild(row);
          });
          holder.appendChild(list);
        });
      }
      drawList();
      ctx.out();
    }).catch(function (e) { status.textContent = 'Could not load item mods: ' + (e && e.message || e); });
  }
}, 'flasks');
