/* js/app/29-lootfilter.js — loot filter tools: price re-tier, your build's items, quick rules,
   checkpoints, and "which block shows this item" (also on the price check). The js/app/ files
   are one program split by feature: they load in order (index.html) and share their
   top-level names. */
'use strict';

// ==== loot filter tools ===============================================================
// The filter logic is js/filter.js (window.LootFilter); files and checkpoints are gui.py's
// filter_* bridge (filter_files.py). Everything the app adds lives in ONE managed section at
// the top of your .filter, between marker lines: a filter shows an item by the first block
// that matches it, so these blocks win without the app ever rewriting the filter's own body.
// When you download a new version of your filter (NeverSink / FilterBlade), Save puts the
// section back: your re-tiers, build items and rules survive filter updates. Every save makes
// a checkpoint first. The app never reloads the filter or touches the game: you re-select the
// filter in game (Options → UI) after saving.
var FILT = { files: null, dir: null, name: null, file: null, parsed: null, tab: 'retier', loading: false,
  error: null, prices: null, pricesLeague: null, audit: null, checkpoints: null, saving: false, saved: null, find: null };
var FILT_KEY = 'pobtf-filter-config';
var FILT_TIER_GAP = 3; // suggest a move when the price is this many times off its tier's median

// ---- per-filter settings (kept in the app, not in the filter file) ---------------------------
function filtConfig() {
  var c;
  try { c = JSON.parse(localStorage.getItem(FILT_KEY)) || {}; } catch (e) { c = {}; }
  if (!c.filters || typeof c.filters !== 'object') c.filters = {};
  return c;
}
function saveFiltConfig(c) { persist(FILT_KEY, JSON.stringify(c)); }
function filtCfg(name, c) {
  c = c || filtConfig();
  var f = c.filters[name] = c.filters[name] || {};
  if (!Array.isArray(f.rules)) f.rules = [];
  if (!Array.isArray(f.retier)) f.retier = [];
  f.build = Object.assign({ on: false, bases: true, uniques: true, gems: false, minIlvl: 82, style: 'build' }, f.build || {});
  return f;
}
function updateFiltCfg(fn) {
  var c = filtConfig();
  fn(filtCfg(FILT.name, c), c);
  saveFiltConfig(c);
}

// ---- looks for the app's own blocks ----------------------------------------------------------
var FILT_STYLES = {
  top: { label: 'Top (red, big, sound)', textColor: [255, 0, 0, 255], borderColor: [255, 0, 0, 255],
    backgroundColor: [255, 255, 255, 255], fontSize: 45, sound: [6, 300], minimapIcon: [0, 'Red', 'Star'], effect: ['Red'] },
  good: { label: 'Good (orange, sound)', textColor: [0, 0, 0, 255], borderColor: [0, 0, 0, 255],
    backgroundColor: [249, 150, 25, 255], fontSize: 40, sound: [1, 300], minimapIcon: [1, 'Orange', 'Diamond'], effect: ['Orange'] },
  build: { label: 'Build (green, sound)', textColor: [255, 255, 255, 255], borderColor: [74, 230, 58, 255],
    backgroundColor: [20, 80, 20, 255], fontSize: 40, sound: [2, 300], minimapIcon: [1, 'Green', 'Hexagon'], effect: ['Green', 'Temp'] },
  plain: { label: 'Plain (shown, quiet)', textColor: [200, 200, 200, 255], fontSize: 32 }
};
function filtStyleActions(key) {
  var s = FILT_STYLES[key] || FILT_STYLES.plain, a = [];
  if (s.textColor) a.push({ key: 'SetTextColor', args: s.textColor });
  if (s.borderColor) a.push({ key: 'SetBorderColor', args: s.borderColor });
  if (s.backgroundColor) a.push({ key: 'SetBackgroundColor', args: s.backgroundColor });
  if (s.fontSize) a.push({ key: 'SetFontSize', args: [s.fontSize] });
  if (s.sound) a.push({ key: 'PlayAlertSound', args: s.sound });
  if (s.minimapIcon) a.push({ key: 'MinimapIcon', args: s.minimapIcon });
  if (s.effect) a.push({ key: 'PlayEffect', args: s.effect });
  return a;
}

// ---- loading the file ---------------------------------------------------------------------------
function filtApi() { return isGui() && window.pywebview.api.filter_list ? window.pywebview.api : null; }

async function loadFilterList() {
  var api = filtApi();
  if (!api) { FILT.error = 'Loot filter tools need the desktop app (they read and save your .filter file).'; return; }
  var r;
  try { r = await api.filter_list(); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r || !r.ok) { FILT.error = 'Couldn\'t list your filters: ' + ((r && r.error) || 'no answer'); return; }
  FILT.files = r.filters || [];
  FILT.dir = r.dir || '';
  var last = filtConfig().last;
  if (!FILT.name) FILT.name = FILT.files.some(function (f) { return f.name === last; }) ? last : (FILT.files[0] || {}).name || null;
}

async function loadFilterFile(name) {
  var api = filtApi();
  if (!api || !name) return;
  FILT.loading = true;
  FILT.error = null;
  renderFilterView();
  var r;
  try { r = await api.filter_read(name); } catch (e) { r = { ok: false, error: String(e) }; }
  FILT.loading = false;
  if (!r || !r.ok) { FILT.error = 'Couldn\'t read ' + name + ': ' + ((r && r.error) || 'no answer'); renderFilterView(); return; }
  FILT.name = name;
  FILT.file = { text: r.text, bom: !!r.bom, eol: r.eol, mtime: r.mtime };
  FILT.parsed = LootFilter.parse(r.text);
  FILT.audit = null;
  FILT.checkpoints = null;
  var c = filtConfig();
  c.last = name;
  saveFiltConfig(c);
  renderFilterView();
}

// ---- the managed section: rules + build items + price re-tiers --------------------------------
function filtTierBlock(type, tier) {
  if (!FILT.parsed) return null;
  return FILT.parsed.blocks.filter(function (b) { return !b.managed && b.tags && b.tags.type === type && b.tags.tier === tier; })[0] || null;
}
function filtCond(block, key) {
  return (block.conditions || []).filter(function (c) { return c.key === key; })[0] || null;
}

// your rules first (explicit choices), then build items, then price re-tiers
function filtManagedRules() {
  var cfg = filtCfg(FILT.name), out = [];
  cfg.rules.forEach(function (r) {
    if (r.on === false) return;
    var cond = {};
    if (r.cls) cond.Class = ['==', r.cls];
    if (r.bases && r.bases.length) cond.BaseType = ['=='].concat(r.bases);
    if (r.rarity) cond.Rarity = [r.rarity === 'Unique' ? '==' : '<=', r.rarity];
    if (r.minIlvl) cond.ItemLevel = ['>=', r.minIlvl];
    var tierB = r.style === 'copy' && r.copy ? filtTierBlock(r.copy.type, r.copy.tier) : null;
    out.push({ visibility: r.show === 'Hide' ? 'Hide' : 'Show', comment: 'your rule: ' + (r.label || 'rule'), conditions: cond,
      actions: r.show === 'Hide' ? [] : tierB ? LootFilter.actionsOf(tierB) : filtStyleActions(r.style) });
  });
  if (cfg.build.on) filtBuildRules(cfg.build).forEach(function (r) { out.push(r); });
  cfg.retier.forEach(function (o) {
    var target = filtTierBlock(o.type, o.tier);
    if (!target) return; // that tier isn't in this version of the filter any more
    var cond = { BaseType: ['==', o.name] };
    ['Class', 'Rarity'].forEach(function (k) {
      var c = filtCond(target, k);
      if (c) cond[k] = [c.op || '='].concat(c.values);
    });
    out.push({ visibility: target.visibility, comment: 'price re-tier: ' + o.name + ' → ' + o.type + ' ' + o.tier,
      conditions: cond, actions: LootFilter.actionsOf(target) });
  });
  return out;
}

// the loaded build: rare bases worth picking up to craft on, its uniques' bases, its gems
function filtBuildItems() {
  var bases = {}, uniques = {}, gems = {};
  (typeof cards !== 'undefined' ? cards : []).forEach(function (s) {
    var it = s && s.item;
    if (!it || !it.base) return;
    if (s.unique || /UNIQUE/i.test(it.rarity || '')) uniques[it.base] = it.name || it.base;
    else if (!/jewel/i.test(s.slot || '')) bases[it.base] = true;
  });
  ((typeof build !== 'undefined' && build && build.gemGroups) || []).forEach(function (g) {
    (g.gems || []).forEach(function (gm) { if (gm && gm.name) gems[gm.name] = true; });
  });
  return { bases: Object.keys(bases).sort(), uniques: uniques, gems: Object.keys(gems).sort() };
}
function filtBuildRules(b) {
  var items = filtBuildItems(), out = [], acts = filtStyleActions(b.style || 'build');
  if (b.uniques && Object.keys(items.uniques).length) {
    out.push({ visibility: 'Show', comment: 'build uniques: ' + Object.keys(items.uniques).map(function (k) { return items.uniques[k]; }).join(', '),
      conditions: { Rarity: ['==', 'Unique'], BaseType: ['=='].concat(Object.keys(items.uniques).sort()) }, actions: acts });
  }
  if (b.bases && items.bases.length) {
    var cond = { Rarity: ['<=', 'Rare'], BaseType: ['=='].concat(items.bases) };
    if (b.minIlvl) cond.ItemLevel = ['>=', b.minIlvl];
    out.push({ visibility: 'Show', comment: 'build bases to craft on', conditions: cond, actions: acts });
  }
  if (b.gems && items.gems.length) {
    out.push({ visibility: 'Show', comment: 'build gems', conditions: { Class: ['==', 'Skill Gems', 'Support Gems'],
      BaseType: ['=='].concat(items.gems) }, actions: filtStyleActions('plain') });
  }
  return out;
}

function filtManagedText() {
  var rules = filtManagedRules();
  if (!rules.length) return '';
  return LootFilter.buildManaged(rules, 'PoB Trade Finder ' + (window.APP_VERSION || '') + ': ' + rules.length +
    ' block' + (rules.length > 1 ? 's' : '') + ' (your rules, build items, price re-tiers). Edit them in the app.', FILT.file.eol);
}

async function saveFilter() {
  var api = filtApi();
  if (!api || !FILT.file || FILT.saving) return;
  FILT.saving = true;
  renderFilterView();
  var text = LootFilter.applyManaged(FILT.file.text, filtManagedText());
  var r;
  try { r = await api.filter_write(FILT.name, text, FILT.file.mtime, FILT.file.bom, 'before PoB Trade Finder save'); }
  catch (e) { r = { ok: false, error: String(e) }; }
  FILT.saving = false;
  if (!r || !r.ok) {
    UI.toast('Not saved: ' + ((r && r.error) || 'no answer'), 'danger');
    renderFilterView();
    return;
  }
  FILT.saved = Date.now();
  UI.toast('Saved. In game: Options → UI → pick the filter again to load it.', 'success');
  await loadFilterFile(FILT.name); // what's on disk now, incl. the section
}

// ---- price re-tier (economy audit) -------------------------------------------------------------
// Prices by name: GGG's exchange feed (currency, cards, scarabs, fragments…) and the most
// valuable unique on each base (poe.ninja via the app's server, for unique tiers).
async function loadFilterPrices(force) {
  var league = document.getElementById('league').value;
  if (!force && FILT.prices && FILT.pricesLeague === league) return;
  var api = isGui() ? window.pywebview.api : null;
  if (!api) return;
  var names = {}, uniqueBases = {};
  try {
    var cx = await api.cx_overview(league);
    if (cx && cx.ok) Object.keys(cx.items || {}).forEach(function (code) {
      var it = cx.items[code], s = it.s || [];
      if (s.length) names[it.name] = s[s.length - 1][1];
    });
  } catch (e) { /* exchange prices missing: skip those tiers */ }
  try {
    var up = await api.unique_prices(league);
    if (up && up.ok) (up.items || []).forEach(function (p) {
      if (p[1] && (uniqueBases[p[1]] == null || p[2] > uniqueBases[p[1]])) uniqueBases[p[1]] = p[2];
    });
  } catch (e) { /* unique prices missing */ }
  FILT.prices = { names: names, uniqueBases: uniqueBases };
  FILT.pricesLeague = league;
}

function filtPriceOf(name, isUnique) {
  var p = FILT.prices || {};
  return isUnique ? (p.uniqueBases || {})[name] : (p.names || {})[name];
}
function median(xs) {
  var s = xs.slice().sort(function (a, b) { return a - b; });
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
}

// per NeverSink $type: tiers in file order (best first), each with its priced names and their
// median; an item belongs where its price sits between the neighbouring tiers' medians
function filterAudit() {
  if (!FILT.parsed || !FILT.prices) return null;
  var byType = {};
  FILT.parsed.blocks.forEach(function (b) {
    if (b.managed || !b.tags || !b.tags.type) return;
    var bt = filtCond(b, 'BaseType');
    if (!bt || !bt.values || !bt.values.length) return;
    var unique = /unique/i.test(b.tags.type) || (filtCond(b, 'Rarity') || { values: [] }).values.indexOf('Unique') !== -1;
    var t = byType[b.tags.type] = byType[b.tags.type] || { type: b.tags.type, unique: unique, tiers: [], seen: {} };
    if (t.seen[b.tags.tier]) return; // a tier split over several blocks: the first one is the tier's look
    t.seen[b.tags.tier] = true;
    var items = bt.values.map(function (n) { return { name: n, price: filtPriceOf(n, unique) }; });
    var priced = items.filter(function (i) { return i.price != null; });
    t.tiers.push({ tier: b.tags.tier, block: b, hide: b.visibility === 'Hide', items: items,
      median: priced.length ? median(priced.map(function (i) { return i.price; })) : null, priced: priced.length });
  });
  var moves = [];
  Object.keys(byType).forEach(function (k) {
    var t = byType[k];
    // tiers we can place by price: 2+ priced names, medians falling from the best tier down
    var ladder = [], last = Infinity;
    t.tiers.forEach(function (tr) {
      if (tr.priced >= 2 && tr.median != null && tr.median <= last) { ladder.push(tr); last = tr.median; }
    });
    if (ladder.length < 2) return;
    t.ladder = ladder;
    ladder.forEach(function (tr) {
      tr.items.forEach(function (it) {
        if (it.price == null) return;
        var best = ladder[ladder.length - 1];
        for (var i = 0; i < ladder.length - 1; i++) {
          var cut = Math.sqrt(ladder[i].median * Math.max(ladder[i + 1].median, 0.01)); // between the two medians
          if (it.price >= cut) { best = ladder[i]; break; }
        }
        if (best === tr) return;
        var off = it.price > tr.median ? it.price / Math.max(tr.median, 0.01) : tr.median / Math.max(it.price, 0.01);
        if (off < FILT_TIER_GAP) return;
        moves.push({ type: t.type, name: it.name, price: it.price, from: tr.tier, fromMedian: tr.median, to: best.tier,
          toMedian: best.median, up: ladder.indexOf(best) < ladder.indexOf(tr), toHide: best.hide });
      });
    });
  });
  moves.sort(function (a, b) { return (b.up - a.up) || (b.price - a.price); });
  return { types: byType, moves: moves };
}

// ---- "which block shows this item" -------------------------------------------------------------
function filterMatch(appItem) {
  if (!FILT.parsed || !appItem) return null;
  var r = LootFilter.matchItem(FILT.parsed, LootFilter.fromAppItem(appItem));
  return r && r.block ? r : null;
}
function filterMatchText(m) {
  if (!m) return 'No block matches: the game shows it with its default look.';
  var b = m.block;
  return (b.visibility === 'Hide' ? 'Hidden' : 'Shown') + ' by ' + (b.managed ? 'your section' : 'block ' + (b.index + 1)) +
    (b.tags ? ' (' + b.tags.type + ' · ' + b.tags.tier + ')' : '') + ', line ' + (b.startLine + 1) + (m.certain === false ? ' (probably)' : '');
}

// one click from an item: hide it / show it like another tier / highlight it (adds a rule)
function filterQuickRule(appItem, kind) {
  var base = appItem.base || appItem.name, cls = appItem.itemClass || '';
  updateFiltCfg(function (f) {
    f.rules = f.rules.filter(function (r) { return !(r.quick && r.bases && r.bases[0] === base); }); // one quick rule per base
    f.rules.unshift({ id: 'q' + Date.now().toString(36), quick: true, on: true, label: (kind === 'hide' ? 'hide ' : 'highlight ') + base,
      show: kind === 'hide' ? 'Hide' : 'Show', cls: cls, bases: [base], style: kind === 'hide' ? 'plain' : 'top',
      rarity: /UNIQUE/i.test(appItem.rarity || '') ? 'Unique' : '' });
  });
}

// ---- the page -------------------------------------------------------------------------------------
var filterViewBack = null;
function openFilterView() {
  var cur = document.body.dataset.view;
  if (cur && cur !== 'filter') filterViewBack = cur;
  setView('filter');
  window.scrollTo(0, 0);
}
function filterClose() { setView(build ? (filterViewBack || 'gear') : ''); }

async function renderFilterView() {
  var view = document.getElementById('view-filter');
  if (!view) return;
  if (FILT.files === null && !FILT.error) {
    await loadFilterList();
    if (FILT.name && !FILT.file && !FILT.error) { loadFilterFile(FILT.name); return; }
  }
  view.textContent = '';
  var page = UI.el('div', 'filt-page');
  var bar = UI.el('div', 'trades-bar');
  bar.appendChild(UI.button('ghost', { size: 'sm', label: '← Back', onClick: filterClose, title: 'Back to where you were (Esc)' }));
  bar.appendChild(UI.el('span', 'ov-title', 'Loot filter'));
  page.appendChild(bar);
  page.appendChild(UI.el('p', 'finder-sub', 'Tune your own loot filter: re-tier items by today\'s prices, highlight your ' +
    'build\'s items, add your own rules. The app keeps its changes in one section at the top of the file, so they ' +
    'survive filter updates, and makes a checkpoint before every save. It never touches the game: after saving, ' +
    'pick the filter again in game (Options → UI).'));
  if (FILT.error) { page.appendChild(UI.el('p', 'trade-warn', FILT.error)); view.appendChild(page); return; }
  page.appendChild(renderFilterPicker());
  if (FILT.loading) page.appendChild(UI.el('p', 'finder-sub', 'Reading the filter…'));
  if (FILT.parsed) {
    page.appendChild(renderFilterSummary());
    var tabs = UI.el('div', 'trades-tabs');
    tabs.setAttribute('role', 'tablist');
    [['retier', 'Price re-tier'], ['build', 'Build items'], ['rules', 'Your rules'], ['find', 'Find an item'], ['checkpoints', 'Checkpoints']]
      .forEach(function (t) {
        var b = UI.el('button', 'trades-tab', t[1]);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', FILT.tab === t[0] ? 'true' : 'false');
        b.addEventListener('click', function () { FILT.tab = t[0]; renderFilterView(); });
        tabs.appendChild(b);
      });
    page.appendChild(tabs);
    var body = UI.el('div', 'filt-body');
    ({ retier: renderFilterRetier, build: renderFilterBuild, rules: renderFilterRules, find: renderFilterFind,
       checkpoints: renderFilterCheckpoints })[FILT.tab](body);
    page.appendChild(body);
  }
  view.appendChild(page);
}

function renderFilterPicker() {
  var row = UI.el('div', 'filt-picker');
  if (!FILT.files || !FILT.files.length) {
    row.appendChild(UI.el('span', 'finder-sub', 'No .filter files in ' + (FILT.dir || 'your Path of Exile folder') +
      '. Download one (e.g. NeverSink from FilterBlade) and put it there.'));
  } else {
    var sel = UI.select(FILT.files.map(function (f) { return [f.name, f.name]; }), FILT.name, { ariaLabel: 'Filter file',
      onChange: function () { loadFilterFile(this.value); } });
    row.appendChild(UI.field('Filter', sel));
    row.appendChild(UI.button('ghost', { size: 'sm', label: '↻ Reload', title: 'Read the file again (after you changed it outside the app)',
      onClick: function () { loadFilterFile(FILT.name); } }));
  }
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Open folder', onClick: function () {
    var api = filtApi(); if (api) api.filter_open_folder();
  } }));
  return row;
}

function renderFilterSummary() {
  var p = FILT.parsed, cfg = filtCfg(FILT.name), rules = filtManagedRules();
  var box = UI.el('div', 'filt-summary');
  var head = (FILT.file.text.match(/^#\s*TYPE:\s*(.+)$/m) || [])[1];
  var ver = (FILT.file.text.match(/^#\s*VERSION:\s*(.+)$/m) || [])[1];
  var own = p.blocks.filter(function (b) { return !b.managed; }).length;
  box.appendChild(UI.el('span', null, own + ' blocks' + (head ? ' · ' + head.trim() : '') + (ver ? ' · v' + ver.trim() : '')));
  var inFile = p.blocks.filter(function (b) { return b.managed; }).length;
  box.appendChild(UI.chip(inFile ? 'app section: ' + inFile + ' block' + (inFile > 1 ? 's' : '') + ' in the file' : 'no app section yet',
    inFile ? 'success' : 'neutral'));
  var pending = rules.length !== inFile || LootFilter.applyManaged(FILT.file.text, filtManagedText()) !== FILT.file.text;
  var save = UI.button(pending ? 'primary' : 'secondary', { size: 'sm', label: FILT.saving ? 'Saving…' : 'Save to filter',
    title: 'Writes the app section (' + rules.length + ' block' + (rules.length === 1 ? '' : 's') + ') into the file. A checkpoint is made first.',
    onClick: saveFilter });
  save.disabled = FILT.saving;
  box.appendChild(save);
  if (pending) box.appendChild(UI.el('span', 'filt-pending', 'unsaved changes (' + cfg.rules.length + ' rules, ' + cfg.retier.length + ' re-tiers)'));
  return box;
}

function renderFilterRetier(body) {
  if (!FILT.prices || FILT.pricesLeague !== document.getElementById('league').value) {
    body.appendChild(UI.el('p', 'finder-sub', 'Loading prices…'));
    loadFilterPrices().then(function () { FILT.audit = filterAudit(); renderFilterView(); });
    return;
  }
  if (!FILT.audit) FILT.audit = filterAudit();
  var a = FILT.audit, cfg = filtCfg(FILT.name);
  var types = Object.keys(a.types).filter(function (k) { return a.types[k].ladder; });
  if (!types.length) {
    body.appendChild(UI.el('p', 'finder-sub', 'This filter has no price tiers the app can read. Re-tiering works with ' +
      'NeverSink / FilterBlade filters (their blocks carry "$type->… $tier->…" tags).'));
    return;
  }
  body.appendChild(UI.el('p', 'finder-sub', 'Items whose price today (' + FILT.pricesLeague + ') is at least ' + FILT_TIER_GAP +
    '× off their tier, with the tier it fits now. Ticked ones are shown like that tier, from the app section. Tiers read: ' +
    types.join(', ') + '.'));
  var applied = {};
  cfg.retier.forEach(function (o) { applied[o.type + '|' + o.name] = o; });
  var chosen = {};
  a.moves.forEach(function (m) { if (applied[m.type + '|' + m.name]) chosen[m.type + '|' + m.name] = true; });
  var table = UI.table([
    { key: 'pick', label: '', render: function (m) {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!chosen[m.type + '|' + m.name];
      cb.setAttribute('aria-label', 'Re-tier ' + m.name);
      cb.addEventListener('change', function () { chosen[m.type + '|' + m.name] = cb.checked; });
      return cb;
    } },
    { key: 'name', label: 'Item', render: function (m) {
      var s = UI.el('span', null, m.name + ' ');
      s.appendChild(UI.chip(m.up ? '▲ up' : (m.toHide ? '▼ hide' : '▼ down'), m.up ? 'success' : 'warn'));
      return s;
    } },
    { key: 'type', label: 'Kind' },
    { key: 'price', label: 'Price', num: true, render: function (m) { return fmtChaos(m.price); } },
    { key: 'from', label: 'Now in', render: function (m) { return m.from + ' (~' + fmtChaos(m.fromMedian) + ')'; } },
    { key: 'to', label: 'Fits', render: function (m) { return m.to + ' (~' + fmtChaos(m.toMedian) + ')'; } }
  ], a.moves, { sortable: true, emptyText: 'Everything sits in a tier that fits its price.' });
  var row = UI.el('div', 'trade-row');
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Tick all going up', onClick: function () {
    table.querySelectorAll('tbody input[type=checkbox]').forEach(function (cb, i) { if (a.moves[i] && a.moves[i].up) { cb.checked = true; chosen[a.moves[i].type + '|' + a.moves[i].name] = true; } });
  } }));
  row.appendChild(UI.button('primary', { size: 'sm', label: 'Use the ticked re-tiers', title: 'Adds them to the app section (then Save to filter)',
    onClick: function () {
      updateFiltCfg(function (f) {
        var keep = f.retier.filter(function (o) { return !a.moves.some(function (m) { return m.type === o.type && m.name === o.name; }); });
        a.moves.forEach(function (m) { if (chosen[m.type + '|' + m.name]) keep.push({ type: m.type, name: m.name, tier: m.to }); });
        f.retier = keep;
      });
      renderFilterView();
    } }));
  if (cfg.retier.length) row.appendChild(UI.button('ghost', { size: 'sm', label: 'Clear all re-tiers (' + cfg.retier.length + ')',
    onClick: async function () {
      if (!await UI.confirmDanger('Clear all price re-tiers?', 'The app section drops them on the next save; the filter\'s own tiers apply again.', 'Clear')) return;
      updateFiltCfg(function (f) { f.retier = []; });
      renderFilterView();
    } }));
  row.appendChild(UI.button('ghost', { size: 'sm', label: '↻ Prices', onClick: function () {
    loadFilterPrices(true).then(function () { FILT.audit = filterAudit(); renderFilterView(); });
  } }));
  body.appendChild(row);
  body.appendChild(table);
}

function renderFilterBuild(body) {
  var cfg = filtCfg(FILT.name), b = cfg.build, items = filtBuildItems();
  function set(k, v) { updateFiltCfg(function (f) { f.build[k] = v; }); renderFilterView(); }
  function toggle(label, on, fn) {
    var w = UI.el('label', 'toggle'), c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = !!on;
    c.addEventListener('change', function () { fn(c.checked); });
    w.appendChild(c);
    w.appendChild(UI.el('span', null, label));
    return w;
  }
  if (typeof build === 'undefined' || !build) {
    body.appendChild(UI.el('p', 'finder-sub', 'Load a build first: its items are what this highlights.'));
    return;
  }
  body.appendChild(toggle('Highlight my build\'s items in the filter', b.on, function (v) { set('on', v); }));
  var row = UI.el('div', 'trade-row');
  row.appendChild(toggle('Bases to craft on (' + items.bases.length + ')', b.bases, function (v) { set('bases', v); }));
  row.appendChild(toggle('Unique bases (' + Object.keys(items.uniques).length + ')', b.uniques, function (v) { set('uniques', v); }));
  row.appendChild(toggle('Gems (' + items.gems.length + ')', b.gems, function (v) { set('gems', v); }));
  body.appendChild(row);
  var row2 = UI.el('div', 'trade-row');
  row2.appendChild(UI.field('Bases from item level', UI.select([['0', 'any'], ['75', '75'], ['82', '82'], ['84', '84'], ['86', '86']],
    String(b.minIlvl || 0), { onChange: function () { set('minIlvl', parseInt(this.value, 10)); } })));
  row2.appendChild(UI.field('Look', UI.select(Object.keys(FILT_STYLES).map(function (k) { return [k, FILT_STYLES[k].label]; }), b.style,
    { onChange: function () { set('style', this.value); } })));
  body.appendChild(row2);
  var list = UI.el('ul', 'filt-list');
  if (b.bases) items.bases.forEach(function (n) { list.appendChild(UI.el('li', null, n + ' (rare base' + (b.minIlvl ? ', ilvl ' + b.minIlvl + '+' : '') + ')')); });
  if (b.uniques) Object.keys(items.uniques).forEach(function (k) { list.appendChild(UI.el('li', null, items.uniques[k] + ' (unique ' + k + ')')); });
  if (b.gems) items.gems.forEach(function (n) { list.appendChild(UI.el('li', null, n + ' (gem)')); });
  body.appendChild(list);
  body.appendChild(UI.el('p', 'finder-sub', 'Uniques are matched by base type (filters can\'t see a unique\'s name), so every ' +
    'unique on that base is highlighted.'));
}

function renderFilterRules(body) {
  var cfg = filtCfg(FILT.name);
  body.appendChild(UI.el('p', 'finder-sub', 'Simple rules: hide or show an item class or base types with a look. They come ' +
    'first in the app section, so they beat everything in the filter.'));
  cfg.rules.forEach(function (r) {
    var row = UI.el('div', 'filt-rule' + (r.on === false ? ' is-off' : ''));
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = r.on !== false;
    cb.setAttribute('aria-label', 'Use this rule');
    cb.addEventListener('change', function () { updateFiltCfg(function (f) { f.rules.forEach(function (x) { if (x.id === r.id) x.on = cb.checked; }); }); renderFilterView(); });
    row.appendChild(cb);
    row.appendChild(UI.chip(r.show === 'Hide' ? 'hide' : 'show', r.show === 'Hide' ? 'neutral' : 'success'));
    row.appendChild(UI.el('span', 'filt-rule-text', (r.label || '') + ' — ' + [r.cls, (r.bases || []).join(', '), r.rarity,
      r.minIlvl ? 'ilvl ' + r.minIlvl + '+' : ''].filter(Boolean).join(' · ')));
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Delete', onClick: async function () {
      if (!await UI.confirmDanger('Delete this rule?', r.label || '', 'Delete')) return;
      updateFiltCfg(function (f) { f.rules = f.rules.filter(function (x) { return x.id !== r.id; }); });
      renderFilterView();
    } }));
    body.appendChild(row);
  });
  // add a rule
  var form = UI.el('div', 'filt-form');
  var show = UI.select([['Show', 'Show'], ['Hide', 'Hide']], 'Show', { ariaLabel: 'Show or hide' });
  var classes = {};
  FILT.parsed.blocks.forEach(function (b) { var c = filtCond(b, 'Class'); if (c) c.values.forEach(function (v) { classes[v] = true; }); });
  var cls = UI.select([['', 'any class']].concat(Object.keys(classes).sort().map(function (c) { return [c, c]; })), '', { ariaLabel: 'Item class' });
  var bases = UI.input({ placeholder: 'Base types, comma separated (e.g. Vaal Regalia, Hubris Circlet)', ariaLabel: 'Base types', width: '360px' });
  var rarity = UI.select([['', 'any rarity'], ['Normal', 'up to normal'], ['Magic', 'up to magic'], ['Rare', 'up to rare'], ['Unique', 'unique']], '', { ariaLabel: 'Rarity' });
  var ilvl = UI.select([['0', 'any item level'], ['68', '68+'], ['75', '75+'], ['82', '82+'], ['84', '84+'], ['86', '86+']], '0', { ariaLabel: 'Item level' });
  var tierOpts = [];
  FILT.parsed.blocks.forEach(function (b) { if (!b.managed && b.tags && b.visibility !== 'Hide') tierOpts.push(['copy:' + b.tags.type + '|' + b.tags.tier, 'look of ' + b.tags.type + ' ' + b.tags.tier]); });
  var seen = {};
  tierOpts = tierOpts.filter(function (o) { if (seen[o[0]]) return false; seen[o[0]] = true; return true; });
  var style = UI.select(Object.keys(FILT_STYLES).map(function (k) { return [k, FILT_STYLES[k].label]; }).concat(tierOpts), 'good', { ariaLabel: 'Look' });
  var label = UI.input({ placeholder: 'Name (optional)', ariaLabel: 'Rule name', width: '180px' });
  [show, cls, bases, rarity, ilvl, style, label].forEach(function (e) { form.appendChild(e); });
  form.appendChild(UI.button('primary', { size: 'sm', label: 'Add rule', onClick: function () {
    var list = bases.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!cls.value && !list.length) { UI.toast('Pick an item class or type a base type', 'warn'); return; }
    var st = style.value, copy = null;
    if (st.indexOf('copy:') === 0) { var p = st.slice(5).split('|'); copy = { type: p[0], tier: p[1] }; st = 'copy'; }
    updateFiltCfg(function (f) {
      f.rules.push({ id: 'r' + Date.now().toString(36), on: true, label: label.value.trim() || (show.value === 'Hide' ? 'hide ' : 'show ') +
        (list.join(', ') || cls.value), show: show.value, cls: cls.value, bases: list, rarity: rarity.value,
        minIlvl: parseInt(ilvl.value, 10) || 0, style: st, copy: copy });
    });
    renderFilterView();
  } }));
  body.appendChild(form);
}

function renderFilterFind(body) {
  body.appendChild(UI.el('p', 'finder-sub', 'Paste an item (Ctrl+C on it in game) to see which block of the filter shows or ' +
    'hides it. The price check (Ctrl+D) shows the same line, with one-click Hide / Highlight.'));
  var ta = document.createElement('textarea');
  ta.className = 'sheet-textarea';
  ta.rows = 6;
  ta.placeholder = 'Item Class: Body Armours\nRarity: Rare\n…';
  ta.setAttribute('aria-label', 'Item text');
  body.appendChild(ta);
  var out = UI.el('div', 'filt-find');
  body.appendChild(UI.button('secondary', { size: 'sm', label: 'Find its block', onClick: function () {
    var it = null;
    try { it = PoB.parseGameItem(ta.value); } catch (e) { it = null; } // the in-game Ctrl+C text
    out.textContent = '';
    if (!it) { out.appendChild(UI.el('p', 'trade-warn', 'That doesn\'t look like a copied item.')); return; }
    FILT.find = it;
    out.appendChild(renderFilterItemLine(it));
  } }));
  body.appendChild(out);
  if (FILT.find) out.appendChild(renderFilterItemLine(FILT.find));
}

// the line used on the Find tab and the price check: its block + Hide / Highlight
function renderFilterItemLine(it) {
  var m = filterMatch(it);
  var box = UI.el('div', 'filt-match');
  box.appendChild(UI.el('span', 'qp-label', 'Loot filter'));
  box.appendChild(UI.el('span', null, filterMatchText(m)));
  if (filtApi()) {
    box.appendChild(UI.button('ghost', { size: 'sm', label: 'Hide it', title: 'Adds a rule hiding this base, then saves the filter',
      onClick: async function () { filterQuickRule(it, 'hide'); await saveFilter(); } }));
    box.appendChild(UI.button('ghost', { size: 'sm', label: 'Highlight it', title: 'Adds a rule showing this base big and loud, then saves the filter',
      onClick: async function () { filterQuickRule(it, 'show'); await saveFilter(); } }));
  }
  return box;
}

async function renderFilterCheckpoints(body) {
  var api = filtApi();
  body.appendChild(UI.el('p', 'finder-sub', 'The app keeps a copy of the file before every save (the last 50). Restore puts an ' +
    'older one back; the current file is kept as a checkpoint first.'));
  var row = UI.el('div', 'trade-row');
  row.appendChild(UI.button('secondary', { size: 'sm', label: 'Make a checkpoint now', onClick: async function () {
    var r = await api.filter_checkpoint(FILT.name, 'made by hand');
    UI.toast(r && r.ok ? 'Checkpoint made' : 'Couldn\'t: ' + ((r && r.error) || 'no answer'), r && r.ok ? 'success' : 'danger');
    FILT.checkpoints = null;
    renderFilterView();
  } }));
  body.appendChild(row);
  var holder = UI.el('div');
  body.appendChild(holder);
  if (!FILT.checkpoints) {
    holder.textContent = 'Loading…';
    var r;
    try { r = await api.filter_checkpoints(FILT.name); } catch (e) { r = { ok: false, error: String(e) }; }
    FILT.checkpoints = r && r.ok ? r.checkpoints || [] : [];
    if (!r || !r.ok) { holder.textContent = 'Couldn\'t list checkpoints: ' + ((r && r.error) || 'no answer'); return; }
    holder.textContent = '';
  }
  holder.appendChild(UI.table([
    { key: 'time', label: 'When', render: function (c) { return c.time ? new Date(c.time * 1000).toLocaleString() : c.id; } },
    { key: 'label', label: 'Why' },
    { key: 'size', label: 'Size', num: true, render: function (c) { return Math.round((c.size || 0) / 1024) + ' KB'; } },
    { key: 'go', label: '', render: function (c) {
      return UI.button('ghost', { size: 'sm', label: 'Restore', onClick: async function () {
        if (!await UI.confirmDanger('Restore this checkpoint?', 'The filter file goes back to this version. The current file ' +
          'is kept as a checkpoint first, so you can undo this.', 'Restore')) return;
        var rr = await api.filter_restore(FILT.name, c.id);
        UI.toast(rr && rr.ok ? 'Restored. Pick the filter again in game to load it.' : 'Couldn\'t restore: ' + ((rr && rr.error) || 'no answer'),
          rr && rr.ok ? 'success' : 'danger');
        FILT.checkpoints = null;
        await loadFilterFile(FILT.name);
      } });
    } }
  ], FILT.checkpoints, { emptyText: 'No checkpoints yet: one is made before the first save.' }));
}

// ---- the price check: which block shows the item (filter read once per window) --------------------
async function filterLineForPriceCheck(state) {
  if (!filtApi() || !state || !state.item) return null;
  var name = filtConfig().last;
  if (!name) return null;
  if (!FILT.parsed || FILT.name !== name) {
    var r;
    try { r = await window.pywebview.api.filter_read(name); } catch (e) { return null; }
    if (!r || !r.ok) return null;
    FILT.name = name;
    FILT.file = { text: r.text, bom: !!r.bom, eol: r.eol, mtime: r.mtime };
    FILT.parsed = LootFilter.parse(r.text);
  }
  return renderFilterItemLine(state.item);
}
// pasted item / Ctrl+D (08-cards.js renderPastedItem): the line goes at the top of the card
async function renderFilterLine(state) {
  var line = await filterLineForPriceCheck(state);
  if (!line || state !== pastedState || !state.card) return;
  var old = state.card.querySelector('.filt-match');
  if (old) old.remove();
  var main = state.card.querySelector('.card-main');
  if (main) main.insertBefore(line, main.firstChild); else state.card.appendChild(line);
}

document.addEventListener('DOMContentLoaded', function () {
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (document.body.dataset.view !== 'filter' || document.body.classList.contains('over-game')) return;
    filterClose();
  });
  var league = document.getElementById('league');
  if (league) league.addEventListener('change', function () { FILT.prices = null; FILT.audit = null; if (document.body.dataset.view === 'filter') renderFilterView(); });
});
// ==== end loot filter tools ===========================================================
