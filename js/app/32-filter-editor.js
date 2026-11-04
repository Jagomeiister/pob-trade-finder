/* js/app/32-filter-editor.js — the in-game loot filter editor (Ctrl+Shift+D over an item).
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ==== in-game loot filter editor ========================================================
// gui.py _show_filter_editor: the price-check window (?overlay=1) switches to this panel for the
// hovered item, docked beside the inventory or the stash. It edits the filter itself, the way
// Scalpel does: move the item's base to another tier, hide it, restyle its tier, shift a
// stack / quality threshold, retier a whole tier by today's prices. The edit logic is
// js/filter-edit.js (window.FilterEdit); files, checkpoints and online filters are gui.py's
// filter_* bridge (filter_files.py).
// - Look edits (visibility, colours, font, effects, other lines) and threshold boundaries wait
//   for Save. Switch tier, Hide, audit moves, the audit's Show / Hide tier and Undo write at once.
// - Every write: the file is checkpointed first (filter_files.py) and kept on an undo list (30).
// - Every edit of a tier-tagged block is recorded per filter, so a new version of the filter
//   (FilterBlade / NeverSink update) gets the same edits replayed onto it.
// - Game commands only from a button press, one each: /reloaditemfilter after a write (Settings →
//   Hotkeys, on by default) and /itemfilter <name> for switching filters and the online update.
var FE = { on: false, view: 'item', name: null, file: null, parsed: null, text: '', item: null, itemText: '',
  fitem: null, zone: null, match: null, sel: -1, draft: {}, pendingTh: null, undo: [], busy: false,
  save: 'idle', error: null, files: null, online: null, onlineStep: 0, importable: [], onlineList: [],
  dd: false, picker: null, effects: false, expand: false, pickFilter: false, msg: {}, px: null, pxLeague: null,
  pxLoading: false, audit: null, cards: null, font: null };
var FE_EDITS_KEY = 'pobtf-filter-edits';
var FE_TIPS_KEY = 'pobtf-filter-tips';
var FE_UNDO_MAX = 30;
var FE_CDN = 'https://web.poecdn.com';
// the game's minimap / beam colours, as filters name them (the swatches show these)
var FE_COLOURS = [['Red', '#e53935'], ['Green', '#43a047'], ['Blue', '#1e88e5'], ['Brown', '#8d6e63'],
  ['White', '#eeeeee'], ['Yellow', '#fdd835'], ['Cyan', '#00bcd4'], ['Grey', '#9e9e9e'], ['Orange', '#fb8c00'],
  ['Pink', '#ec407a'], ['Purple', '#ab47bc']];
var FE_SHAPES = ['Circle', 'Diamond', 'Hexagon', 'Square', 'Star', 'Triangle', 'Cross', 'Moon', 'Raindrop', 'Kite',
  'Pentagon', 'UpsideDownHouse'];
// 24×24 outlines of the minimap shapes, drawn for this app (filled with the chosen colour)
var FE_SHAPE_SVG = {
  Circle: '<circle cx="12" cy="12" r="8.5"/>',
  Diamond: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12Z"/>',
  Hexagon: '<path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5Z"/>',
  Square: '<rect x="4" y="4" width="16" height="16" rx="1.5"/>',
  Star: '<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.5 1.3 6.6L12 17.2l-5.9 3.3 1.3-6.6-4.9-4.5 6.6-.8Z"/>',
  Triangle: '<path d="M12 3 21.5 20.5h-19Z"/>',
  Cross: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z"/>',
  Moon: '<path d="M15.5 3.2A9 9 0 1 0 20.8 15 7.2 7.2 0 0 1 15.5 3.2Z"/>',
  Raindrop: '<path d="M12 2.5C9 7.4 5.5 10.8 5.5 14.6a6.5 6.5 0 0 0 13 0C18.5 10.8 15 7.4 12 2.5Z"/>',
  Kite: '<path d="M12 2.5 19.5 9.5 12 21.5 4.5 9.5Z"/>',
  Pentagon: '<path d="M12 2.5 21.5 9.4 17.9 20.5H6.1L2.5 9.4Z"/>',
  UpsideDownHouse: '<path d="M3.5 3.5h17v10L12 21 3.5 13.5Z"/>'
};
var FE_SOUNDS = { 1: 'Currency Stack Plonk', 2: 'General Currency Plonk', 3: 'Important Rare Plonk', 5: 'The Map Sound',
  6: 'Schwing/Tink' };
var FE_SOUND_KEYS = ['PlayAlertSound', 'PlayAlertSoundPositional', 'CustomAlertSound', 'CustomAlertSoundOptional'];
var FE_STYLE_KEYS = ['SetFontSize', 'SetTextColor', 'SetBorderColor', 'SetBackgroundColor', 'MinimapIcon', 'PlayEffect']
  .concat(FE_SOUND_KEYS);
var FE_SLOTS = [['SetTextColor', 'Text', [200, 200, 200, 255]], ['SetBorderColor', 'Border', [200, 200, 200, 255]],
  ['SetBackgroundColor', 'Background', [0, 0, 0, 240]]];
var FE_THRESHOLDS = [['StackSize', 'Stack Size Thresholds', 1, ''], ['Quality', 'Quality Thresholds', 0, '%'],
  ['MemoryStrands', 'Strand Thresholds', 0, '']];
var FE_OTHER_NAMES = { DisableDropSound: 'Disable Drop Sound', EnableDropSound: 'Enable Drop Sound',
  DisableDropSoundIfAlertSound: 'Disable Drop Sound (if alert)', EnableDropSoundIfAlertSound: 'Enable Drop Sound (if alert)' };
var FE_NUM_CONDS = { itemlevel: 1, arealevel: 1, droplevel: 1, quality: 1, sockets: 1, linkedsockets: 1, gemlevel: 1,
  stacksize: 1, waystonetier: 1, maptier: 1, basearmour: 1, baseevasion: 1, baseenergyshield: 1, baseward: 1 };

function feApi() { return isGui() && window.pywebview.api.filter_read ? window.pywebview.api : null; }
function feNorm(s) { return String(s == null ? '' : s).toLowerCase(); }

// ---- recorded edits (per filter file) ---------------------------------------------------------------
function feEditsAll() {
  try {
    var o = JSON.parse(localStorage.getItem(FE_EDITS_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}
function feEdits(name) { var l = feEditsAll()[name || FE.name]; return Array.isArray(l) ? l : []; }
function feSetEdits(list, name) {
  var all = feEditsAll();
  all[name || FE.name] = list;
  persist(FE_EDITS_KEY, JSON.stringify(all));
}
function feRecord(change) {
  if (!change || (Array.isArray(change) && !change.length)) return;
  feSetEdits(FilterEdit.compactChanges(feEdits().concat(Array.isArray(change) ? change : [change])));
}
function feTipDismissed(id) {
  try { return !!(JSON.parse(localStorage.getItem(FE_TIPS_KEY) || '{}') || {})[id]; } catch (e) { return false; }
}
function feDismissTip(id) {
  var o;
  try { o = JSON.parse(localStorage.getItem(FE_TIPS_KEY) || '{}') || {}; } catch (e) { o = {}; }
  o[id] = 1;
  persist(FE_TIPS_KEY, JSON.stringify(o));
}

// ---- art + prices ------------------------------------------------------------------------------------
function feIcon(name) {
  if (!name) return null;
  var p = (window.POE_BASE_ICONS || {})[name] || (window.POE_FILTER_ICONS || {})[name];
  if (p) return FE_CDN + '/image/' + p + '?scale=1';
  var g = FE.px && FE.px.img[name];
  return g ? (/^https?:/.test(g) ? g : FE_CDN + g) : null;
}
function feCardArt(name) {
  var id = FE.cards && FE.cards[name];
  return id ? FE_CDN + '/image/divination-card/' + encodeURIComponent(id) + '.png' : null;
}
// img with the soft glow of itself behind it (the look of Scalpel's art: no colour extraction)
function feArt(url, size, cls) {
  var w = UI.el('span', 'fe-art' + (cls ? ' ' + cls : ''));
  w.style.setProperty('--fe-art', size + 'px');
  if (!url) return w;
  var glow = document.createElement('img');
  glow.className = 'fe-art-glow';
  glow.alt = '';
  glow.src = url;
  var img = document.createElement('img');
  img.className = 'fe-art-img';
  img.alt = '';
  img.src = url;
  img.loading = 'lazy';
  w.appendChild(glow);
  w.appendChild(img);
  return w;
}

async function feLoadPrices() {
  var api = isGui() ? window.pywebview.api : null;
  var league = (document.getElementById('league') || {}).value || '';
  if (!api || FE.pxLoading || (FE.px && FE.pxLeague === league)) return;
  FE.pxLoading = true;
  var px = { names: {}, img: {}, uniques: {}, bestUnique: {}, divine: null, mirror: null };
  try {
    var cx = await api.cx_overview(league);
    if (cx && cx.ok) Object.keys(cx.items || {}).forEach(function (code) {
      var it = cx.items[code], s = it.s || [];
      if (it.img) px.img[it.name] = it.img;
      if (s.length) px.names[it.name] = s[s.length - 1][1];
    });
  } catch (e) { /* exchange prices missing */ }
  try {
    var up = await api.unique_prices(league);
    if (up && up.ok) {
      if (up.divine) px.divine = up.divine;
      (up.items || []).forEach(function (p) {
        px.uniques[p[0] + '|' + (p[1] || '')] = p[2];
        if (px.uniques[p[0]] == null || p[2] < px.uniques[p[0]]) px.uniques[p[0]] = p[2];
        if (p[1] && (px.bestUnique[p[1]] == null || p[2] > px.bestUnique[p[1]])) px.bestUnique[p[1]] = p[2];
      });
    }
  } catch (e) { /* unique prices missing */ }
  px.divine = px.divine || px.names['Divine Orb'] || null;
  px.mirror = px.names['Mirror of Kalandra'] || null;
  FE.px = px;
  FE.pxLeague = league;
  FE.pxLoading = false;
  if (FE.on) feRender();
}
async function feLoadCards() {
  var api = isGui() ? window.pywebview.api : null;
  if (FE.cards || !api || !api.div_cards) return;
  FE.cards = {};
  try {
    var r = await api.div_cards((document.getElementById('league') || {}).value || '', true);
    ((r && r.cards) || []).forEach(function (c) { if (c.n && c.i) FE.cards[c.n] = c.i; });
  } catch (e) { /* no card art: the deck icon */ }
}
// chaos for a base name (unique tiers: its most valuable unique), null when unpriced
function fePrice(name, unique) {
  var p = FE.px;
  if (!p || !name) return null;
  var v = unique ? p.bestUnique[name] : p.names[name];
  return typeof v === 'number' && v > 0 ? v : null;
}
// "1.2k" / "12" / "4.5" / "0.35" + c, div or mirror (Scalpel's rule)
function feFmtNum(v) {
  if (v >= 1000) return (Math.round(v / 100) / 10).toString().replace(/\.0$/, '') + 'k';
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return (Math.round(v * 10) / 10).toString();
  return (Math.round(v * 100) / 100).toString();
}
function feMoney(chaos, mirrors) {
  var p = FE.px || {};
  if (mirrors && p.mirror && chaos >= p.mirror) {
    var m = chaos / p.mirror;
    return { v: m >= 10 ? String(Math.round(m)) : (Math.round(m * 10) / 10).toString(), cur: 'mirror' };
  }
  if (p.divine && chaos >= p.divine) return { v: feFmtNum(chaos / p.divine), cur: 'div' };
  return { v: feFmtNum(chaos), cur: 'c' };
}
var FE_CUR = { c: ['Chaos Orb', 'chaos'], div: ['Divine Orb', 'divine'], mirror: ['Mirror of Kalandra', 'mirror'] };
function fePriceChip(chaos, cls, mirrors) {
  var m = feMoney(chaos, mirrors);
  var chip = UI.el('span', 'fe-price' + (cls ? ' ' + cls : ''));
  chip.title = feFmtNum(chaos) + ' chaos';
  chip.appendChild(UI.el('span', 'fe-price-v', m.v));
  var icon = feIcon(FE_CUR[m.cur][0]);
  if (icon) {
    var img = document.createElement('img');
    img.src = icon;
    img.alt = FE_CUR[m.cur][1];
    img.className = 'fe-cur';
    chip.appendChild(img);
  } else {
    chip.appendChild(UI.el('span', 'fe-dim', m.cur));
  }
  return chip;
}

// the Fontin SmallCaps font the game draws labels with: fetched once into data/ by the app
// (gui.py filter_asset); until then, a small-caps serif
async function feLoadFont() {
  var api = isGui() ? window.pywebview.api : null;
  if (FE.font || !api || !api.filter_asset || !window.FontFace) return;
  FE.font = 'loading';
  try {
    var r = await api.filter_asset('font', 'Fontin-SmallCaps.woff');
    if (!r || !r.ok) { FE.font = 'failed'; return; }
    var f = new FontFace('Fontin SmallCaps', 'url("' + r.path + '")');
    await f.load();
    document.fonts.add(f);
    FE.font = 'ok';
  } catch (e) { FE.font = 'failed'; }
}

// ---- the item ------------------------------------------------------------------------------------------
function feZoneUsable() {
  var z = FE.zone;
  return !!(z && z.level && z.level <= 75 && !/town|hideout/i.test(z.id || ''));
}
function feFilterItem() {
  if (!FE.item) return null;
  var f = LootFilter.fromAppItem(FE.item);
  f.areaLevel = PREFS.filterUseZone && feZoneUsable() ? FE.zone.level : Math.max(FE.item.itemLevel || 1, 83);
  return f;
}
function feBase() { return FE.item ? FE.item.base || FE.item.name : ''; }
function feIsUnique() { return /UNIQUE|RELIC/i.test((FE.item || {}).rarity || ''); }

function feRematch(keepSel) {
  FE.fitem = feFilterItem();
  FE.match = FE.parsed && FE.fitem ? LootFilter.matchItem(FE.parsed, FE.fitem) : null;
  var sel = FE.match && FE.match.block ? FE.match.index : -1;
  FE.sel = keepSel && FE.parsed && FE.parsed.blocks[FE.sel] ? FE.sel : sel;
  FE.draft = {};
  FE.pendingTh = null;
  FE.dd = false;
  FE.picker = null;
}

// load another base into the panel (a chip, unique card, tier row or audit row): nothing is written
function feLoadBase(name, opts) {
  opts = opts || {};
  if (!FE.item || !name) return;
  var it = { name: name, base: name, rarity: 'NORMAL', itemClass: FE.item.itemClass, itemLevel: FE.item.itemLevel,
    mods: [], influences: [], synthetic: true };
  if (opts.unique) { it.rarity = 'UNIQUE'; it.name = opts.unique; it.base = opts.base || name; }
  else if (feIsUnique() && opts.asUnique) { it.rarity = 'UNIQUE'; }
  else if (/MAGIC|RARE/i.test(FE.item.rarity || '')) it.rarity = FE.item.rarity;
  if (FE.item.stackSize) it.stackSize = 1;
  if (feDirty() && !opts.discard) {
    UI.confirmDanger('Discard unsaved changes?', 'Your changes to this tier\'s look haven\'t been saved yet.', 'Discard')
      .then(function (ok) { if (ok) feLoadBase(name, Object.assign({}, opts, { discard: true })); });
    return;
  }
  FE.item = it;
  FE.view = 'item';
  feRematch();
  feRender();
  window.scrollTo(0, 0);
}

// ---- the file --------------------------------------------------------------------------------------------
async function feLoadFile(name) {
  var api = feApi();
  if (!api || !name) return false;
  var r;
  try { r = await api.filter_read(name); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r || !r.ok) { FE.error = 'Couldn\'t read ' + name + ': ' + ((r && r.error) || 'no answer'); return false; }
  FE.name = name;
  FE.file = { bom: !!r.bom, eol: r.eol, mtime: r.mtime };
  FE.text = r.text;
  FE.parsed = LootFilter.parse(r.text);
  FE.error = null;
  var c = filtConfig();
  c.last = name;
  saveFiltConfig(c);
  if (typeof FILT !== 'undefined') FILT.parsed = null; // the price check / Tools page read it again
  return true;
}

async function feLoadList() {
  var api = feApi();
  var r;
  try { r = await api.filter_list(); } catch (e) { r = { ok: false, error: String(e) }; }
  FE.files = r && r.ok ? (r.filters || []).map(function (f) { return f.name; }) : [];
  return FE.files;
}

async function feOnlineCheck() {
  var api = feApi();
  FE.online = null;
  FE.importable = [];
  FE.onlineList = [];
  if (!api || !api.filter_online_status) return;
  try {
    var st = FE.name ? await api.filter_online_status(FE.name) : null;
    if (st && st.ok && st.imported) FE.online = st;
    var ol = await api.filter_online_list();
    if (ol && ol.ok) {
      FE.onlineList = ol.filters || [];
      FE.importable = FE.onlineList.filter(function (f) { return !f.imported; });
    }
  } catch (e) { /* no online info: no banner */ }
}

// write a whole new text: checkpoint (gui) → undo list → recorded edit → reload in game
async function feWrite(text, change, desc, undoing) {
  var api = feApi();
  if (!api || FE.busy) return false;
  FE.busy = true;
  FE.save = 'saving';
  feRender();
  var r;
  try { r = await api.filter_write(FE.name, text, FE.file.mtime, FE.file.bom, 'before: ' + (desc || 'filter edit')); }
  catch (e) { r = { ok: false, error: String(e) }; }
  FE.busy = false;
  if (!r || !r.ok) {
    FE.save = 'idle';
    if (r && r.conflict) {
      UI.toast('The filter changed on disk (another program saved it). Reloaded it: try again.', 'warn');
      await feLoadFile(FE.name);
      feRematch();
    } else {
      UI.toast('Not saved: ' + ((r && r.error) || 'no answer'), 'danger');
    }
    feRender();
    return false;
  }
  if (!undoing) {
    FE.undo.push({ text: FE.text, edits: feEdits().slice(), desc: desc || 'Edit', item: feBase(),
      icon: feIcon(feBase()), time: Date.now() });
    if (FE.undo.length > FE_UNDO_MAX) FE.undo.shift();
    feRecord(change);
  }
  var keep = FE.sel;
  FE.text = text;
  FE.file.mtime = r.mtime;
  FE.parsed = LootFilter.parse(text);
  if (typeof FILT !== 'undefined') FILT.parsed = null;
  feRematch();
  // a look edit keeps the block you were editing (e.g. a threshold segment you picked)
  if (FE.keepSel && FE.parsed.blocks[keep]) FE.sel = keep;
  FE.keepSel = false;
  FE.save = 'saved';
  setTimeout(function () { if (FE.save === 'saved') { FE.save = 'idle'; feRender(); } }, 2000);
  await feReloadInGame();
  feRender();
  return true;
}

async function feReloadInGame() {
  var api = feApi();
  if (PREFS.filterReload === false || !api || !api.filter_reload) return;
  var r;
  try { r = await api.filter_reload(); } catch (e) { r = { ok: false, error: String(e) }; }
  if (!r || !r.ok) UI.toast('Saved, but couldn\'t reload it in game: ' + ((r && r.error) || 'no answer'), 'warn');
}

async function feUndo() {
  var u = FE.undo.pop();
  if (!u) return;
  var ok = await feWrite(u.text, null, 'undo ' + u.desc, true);
  if (ok) feSetEdits(u.edits);
  else FE.undo.push(u);
}

// an immediate write while look edits wait for Save: ask first
async function feConfirmDiscard() {
  if (!feDirty()) return true;
  return UI.confirmDanger('Discard unsaved changes?', 'Your changes to this tier\'s look haven\'t been saved. ' +
    'This action saves the filter now, without them.', 'Discard and continue');
}

// an engine result {ok, text, reason, changes}: save it, or show why not (card = where)
async function feApply(res, desc, card) {
  FE.msg = {};
  if (!res || !res.ok) {
    FE.msg[card || 'block'] = (res && res.reason) || 'That edit isn\'t possible here';
    feRender();
    return false;
  }
  if (res.text === FE.text) { UI.toast('Nothing to change', 'info'); return false; }
  return feWrite(res.text, res.changes && res.changes.length ? res.changes : res.change, desc);
}

// ---- buffered look edits (Save) ----------------------------------------------------------------------------
function feDirty() { return Object.keys(FE.draft).length > 0 || !!FE.pendingTh; }
function feIsWinner() { return !!(FE.match && FE.match.block && FE.sel === FE.match.index); }
// the blocks that draw the item's label, file order: the Continue blocks above + the one edited
function feChain() {
  var out = [];
  if (feIsWinner()) (FE.match.trail || []).forEach(function (t) { out.push(t.index); });
  if (FE.sel >= 0) out.push(FE.sel);
  return out;
}
function feBlockActs(i) {
  var b = FE.parsed.blocks[i], d = FE.draft[i], out = [];
  if (!b) return out;
  var over = d && d.actions || {};
  b.actions.forEach(function (a) {
    if (Object.prototype.hasOwnProperty.call(over, a.key)) return;
    out.push({ key: a.key, args: a.args.slice() });
  });
  Object.keys(over).forEach(function (k) { if (over[k]) out.push({ key: k, args: over[k].slice() }); });
  return out;
}
function feSoundKey(k) { return FE_SOUND_KEYS.indexOf(k) >= 0; }
// composed actions over the chain (later wins; the sound keys are one slot)
function feComposed() {
  var by = {};
  feChain().forEach(function (i) {
    var acts = feBlockActs(i);
    if (acts.some(function (a) { return feSoundKey(a.key); })) FE_SOUND_KEYS.forEach(function (k) { delete by[k]; });
    acts.forEach(function (a) { by[a.key] = a.args; });
  });
  return by;
}
// which block gets an edit of this action: the last block in the chain that sets it, else the edited one
function feTargetFor(key) {
  var chain = feChain();
  for (var n = chain.length - 1; n >= 0; n--) {
    if (feBlockActs(chain[n]).some(function (a) { return a.key === key || (feSoundKey(key) && feSoundKey(a.key)); })) return chain[n];
  }
  return FE.sel;
}
function feSetAct(key, args) {
  var i = feTargetFor(key);
  var d = FE.draft[i] = FE.draft[i] || { actions: {} };
  if (feSoundKey(key)) {
    FE_SOUND_KEYS.forEach(function (k) {
      if (k !== key && FE.parsed.blocks[i].actions.some(function (a) { return a.key === k; })) d.actions[k] = null;
      else if (k !== key) delete d.actions[k];
    });
  }
  var orig = FE.parsed.blocks[i].actions.filter(function (a) { return a.key === key; })[0];
  if (orig && args && JSON.stringify(orig.args.map(String)) === JSON.stringify(args.map(String))) delete d.actions[key];
  else if (!orig && !args) delete d.actions[key];
  else d.actions[key] = args;
  feCleanDraft(i);
  feRender();
}
function feSetVisibility(vis) {
  var i = FE.sel, b = FE.parsed.blocks[i];
  var d = FE.draft[i] = FE.draft[i] || { actions: {} };
  if (vis === b.visibility) delete d.visibility; else d.visibility = vis;
  feCleanDraft(i);
  feRender();
}
function feCleanDraft(i) {
  var d = FE.draft[i];
  if (d && d.visibility == null && !Object.keys(d.actions).length) delete FE.draft[i];
}
function feVisibility() {
  var d = FE.draft[FE.sel];
  return d && d.visibility ? d.visibility : (FE.parsed.blocks[FE.sel] || {}).visibility;
}

async function feSave() {
  if (!feDirty() || FE.busy) return;
  var text = FE.text, changes = [], what = [];
  var order = Object.keys(FE.draft).map(Number).sort(function (a, b) { return a - b; });
  for (var n = 0; n < order.length; n++) {
    var d = FE.draft[order[n]], edit = { actions: d.actions };
    if (d.visibility) edit.visibility = d.visibility;
    var r = FilterEdit.editBlock(text, order[n], edit);
    if (!r || !r.ok) { FE.msg = { block: (r && r.reason) || 'Couldn\'t save that' }; feRender(); return; }
    text = r.text;
    changes = changes.concat(r.changes || []);
    what = what.concat(feDescribeDraft(d));
  }
  if (FE.pendingTh) {
    var t = FE.pendingTh;
    var rt = FilterEdit.setThreshold(text, t.type, t.key, t.old, t.value);
    if (!rt || !rt.ok) { FE.msg = { th: (rt && rt.reason) || 'Failed to update threshold' }; feRender(); return; }
    text = rt.text;
    changes = changes.concat(rt.changes || []);
    what.push('changed ' + t.label.toLowerCase().replace(' thresholds', '') + ' boundary ' + t.old + ' → ' + t.value);
  }
  FE.keepSel = true;
  await feWrite(text, changes, (feTierName(FE.parsed.blocks[FE.sel]) + ': ' + (what.join(', ') || 'edited')));
}
function feDescribeDraft(d) {
  var out = [];
  if (d.visibility) out.push(d.visibility === 'Hide' ? 'Show → Hide' : 'Hide → Show');
  Object.keys(d.actions).forEach(function (k) {
    var name = { SetTextColor: 'text colour', SetBorderColor: 'border colour', SetBackgroundColor: 'background colour',
      SetFontSize: 'font size', MinimapIcon: 'minimap icon', PlayEffect: 'beam effect' }[k] ||
      (feSoundKey(k) ? 'alert sound' : k);
    out.push((d.actions[k] ? 'changed ' : 'removed ') + name);
  });
  return out;
}

// ---- entry points --------------------------------------------------------------------------------------
function feShow(on) {
  FE.on = on;
  document.body.classList.toggle('fedit-on', on);
  var t = document.querySelector('#overlay-bar .ov-title');
  if (t) t.textContent = on ? 'Loot filter' : 'Price check';
  if (!on) { feCloseLayers(); feRender(); }
}

window.__filterEditItem = async function (text, zone) {
  if (!OVERLAY) return false;
  feShow(true);
  FE.item = null; // "Loading…" until this press's item and file are in, never the last item's panel
  FE.error = null;
  FE.view = 'item';
  FE.expand = false;
  FE.msg = {};
  feRender();
  text = String(text || '').replace(/\r\n?/g, '\n').trim();
  FE.zone = zone && typeof zone === 'object' ? zone : null;
  if (overlayHydrate) { try { await overlayHydrate(); } catch (e) { /* keep current settings */ } }
  var item = PoB.looksLikeGameItem(text) ? PoB.parseGameItem(text) : null;
  FE.itemText = text;
  FE.error = item ? null : 'That item can\'t be read here (PoE 1 items only)';
  if (item && feApi()) {
    var name = filtConfig().last;
    var list = await feLoadList();
    if (!name || list.indexOf(name) < 0) name = list[0] || null;
    if (!name) FE.error = 'No .filter files in your filter folder yet.';
    else {
      if (name !== FE.name) FE.undo = [];
      await feLoadFile(name); // always the file as it is on disk now
    }
    await feOnlineCheck();
  } else if (item) {
    FE.error = 'The filter editor needs the desktop app (it edits your .filter file).';
  }
  FE.item = item;
  feRematch();
  overlayNote((FE.name || 'no filter').replace(/\.filter$/i, '') + ' · Esc to close');
  feRender();
  window.scrollTo(0, 0);
  feLoadPrices();
  feLoadCards();
  feLoadFont();
  feLoadHeroPrice();
  return true;
};

// Ctrl+D afterwards: back to the price check
(function () {
  var priceItem = window.__overlayItem;
  if (typeof priceItem !== 'function') return;
  window.__overlayItem = function (text) {
    feShow(false);
    return priceItem(text);
  };
})();

// the hero's price: exchange feed / poe.ninja via the app's quick price (no trade search)
async function feLoadHeroPrice() {
  var api = isGui() ? window.pywebview.api : null;
  FE.heroPrice = null;
  if (!api || !api.quick_price || !FE.item) return;
  var it = FE.item;
  try {
    var r = await api.quick_price((document.getElementById('league') || {}).value || '',
      JSON.stringify({ name: it.name, base: it.base, rarity: it.rarity, stackSize: it.stackSize, links: it.links,
        gemLevel: it.gemLevel, quality: it.quality, corrupted: it.corrupted }));
    if (r && r.ok && r.chaos > 0 && FE.item === it) { FE.heroPrice = r.chaos; feRender(); }
  } catch (e) { /* no price chip */ }
}

// ---- render ---------------------------------------------------------------------------------------------
function feRoot() {
  var root = document.getElementById('fedit');
  if (root) return root;
  root = UI.el('section', 'fedit');
  root.id = 'fedit';
  root.setAttribute('aria-label', 'Loot filter editor');
  var bar = document.getElementById('overlay-bar');
  if (bar && bar.parentNode) bar.parentNode.insertBefore(root, bar.nextSibling);
  else document.body.appendChild(root);
  return root;
}
function feCard(cls) { return UI.el('div', 'fe-card' + (cls ? ' ' + cls : '')); }
function feCardHead(icon, title, extra) {
  var h = UI.el('div', 'fe-card-head');
  if (icon) h.appendChild(UI.el('span', 'fe-card-icon', icon));
  h.appendChild(UI.el('h3', 'fe-title', title));
  if (extra) { var x = UI.el('span', 'fe-head-extra'); extra.forEach(function (e) { if (e) x.appendChild(e); }); h.appendChild(x); }
  return h;
}
function feSub(caption) {
  var s = UI.el('div', 'fe-sub');
  if (caption) s.appendChild(UI.el('div', 'fe-caption', caption));
  return s;
}
function feChip(text, title) { var c = UI.el('span', 'fe-info', text); if (title) c.title = title; return c; }
function feErr(key) { return FE.msg[key] ? UI.el('div', 'fe-error', FE.msg[key]) : null; }
function feTierName(block) {
  if (!block) return 'No block';
  if (block.tags && block.tags.tier) return FilterEdit.tierLabel(block.tags.tier);
  return 'Block #' + (block.index + 1);
}
function feTypePath(block) {
  return block && block.tags && block.tags.type ? block.tags.type.split('->').join(' > ') : '';
}
function feCloseLayers() {
  ['fe-dd-layer', 'fe-pop-layer'].forEach(function (id) { var x = document.getElementById(id); if (x) x.remove(); });
}

function feRender() {
  if (!OVERLAY) return;
  var root = feRoot();
  feCloseLayers();
  root.textContent = '';
  if (!FE.on) return;
  root.appendChild(feBanner());
  if (FE.error) {
    root.appendChild(UI.el('p', 'fe-error fe-pad', FE.error));
    if (FE.item && FE.importable && FE.importable.length) root.appendChild(feImportCard());
    return;
  }
  if (!FE.item || !FE.parsed) { root.appendChild(UI.el('p', 'fe-dim fe-pad', 'Loading…')); return; }
  if (FE.pickFilter) root.appendChild(feFilterPicker());
  if (FE.view === 'audit') { root.appendChild(feAuditView()); return; }
  if (FE.view === 'history') { root.appendChild(feHistoryView()); return; }
  root.appendChild(feHero());
  root.appendChild(feSticky());
  var m = FE.match, b = FE.parsed.blocks[FE.sel];
  var col = UI.el('div', 'fe-col');
  if (!FE.online && FE.importable.length && !feTipDismissed('import')) col.appendChild(feImportCard());
  var nav = m && m.block ? feRetierCard(m) : null;
  if (nav) col.appendChild(nav);
  else if (m && m.block) {
    col.appendChild(feTierStrip(m.block));
    col.appendChild(feHideItemCard());
  }
  if (b && b.conditions.some(function (c) { return feNorm(c.key) === 'rarity' && c.values.some(function (v) { return /unique/i.test(v); }); })) {
    var rail = feUniquesRail();
    if (rail) col.appendChild(rail);
  }
  var th = feThresholdCards();
  th.forEach(function (c) { col.appendChild(c); });
  if (FE.msg.th) col.appendChild(feErr('th'));
  col.appendChild(b ? feBlockCard(b) : feNoMatch());
  root.appendChild(col);
}

// ---- banner: the filter + online update + history -------------------------------------------------
function feBanner() {
  var bar = UI.el('div', 'fe-banner');
  var left = UI.el('button', 'fe-banner-name');
  left.type = 'button';
  left.title = 'Pick another filter';
  var shown = (FE.name || 'No filter').replace(/\.filter$/i, '').replace(/-local$/i, '');
  if (FE.online && FE.online.changed) left.appendChild(UI.el('span', 'fe-gold', 'Filter Update Available '));
  left.appendChild(UI.el('strong', null, shown));
  left.appendChild(UI.el('span', 'fe-chev', FE.pickFilter ? '▴' : '▾'));
  left.addEventListener('click', function () { FE.pickFilter = !FE.pickFilter; feRender(); });
  bar.appendChild(left);
  var right = UI.el('span', 'fe-banner-right');
  if (FE.online) right.appendChild(feOnlineControl());
  if (FE.view !== 'item') {
    right.appendChild(UI.button('ghost', { size: 'sm', label: '← Back to item', onClick: function () { FE.view = 'item'; feRender(); } }));
  } else {
    var hist = UI.button('ghost', { size: 'sm', label: 'History' + (FE.undo.length ? ' (' + FE.undo.length + ')' : ''),
      title: 'Session edits (undo), checkpoints, recorded filter changes', onClick: function () { FE.view = 'history'; feRender(); } });
    right.appendChild(hist);
  }
  bar.appendChild(right);
  return bar;
}

// "Check for Filter Updates" → /itemfilter <online> (the game downloads it); then "Update" replays
function feOnlineControl() {
  var st = FE.online, api = feApi();
  if (st.missing) { var m = UI.el('span', 'fe-dim', 'Online source gone'); m.title = 'The online filter this copy came from is no longer in OnlineFilters'; return m; }
  if (st.changed) {
    var up = UI.button('primary', { size: 'sm', label: FE.busy ? 'Updating...' : 'Update',
      title: 'Replays your ' + feEdits().length + ' recorded edits onto the new version, saves ' + FE.name +
        ', then sends /itemfilter ' + FE.name.replace(/\.filter$/i, ''), onClick: feOnlineUpdate });
    up.disabled = FE.busy;
    return up;
  }
  return UI.button('ghost', { size: 'sm', label: FE.onlineStep === 1 ? 'Checking...' : 'Check for Filter Updates',
    title: 'Sends /itemfilter ' + st.name + ': the game downloads the newest version of the online filter',
    onClick: async function () {
      if (FE.onlineStep === 1) return;
      var r = await api.filter_switch(st.name);
      if (!r || !r.ok) { UI.toast('Couldn\'t switch: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
      FE.onlineStep = 1;
      feRender();
      setTimeout(async function () {
        await feOnlineCheck();
        FE.onlineStep = 0;
        if (FE.online && !FE.online.changed) UI.toast('No new version. Your game is on ' + st.name +
          ' now: press Update or pick ' + FE.name.replace(/\.filter$/i, '') + ' to switch back.', 'info', { timeout: 8000 });
        feRender();
      }, 2000);
    } });
}

async function feOnlineUpdate() {
  var api = feApi();
  await feOnlineCheck();
  var st = FE.online;
  if (!st) return;
  var src;
  try { src = await api.filter_online_read(st.online); } catch (e) { src = { ok: false, error: String(e) }; }
  if (!src || !src.ok) { UI.toast('Couldn\'t read the online filter: ' + ((src && src.error) || 'no answer'), 'danger'); return; }
  var edits = feEdits();
  var rep = FilterEdit.replayChanges(src.text, edits) || {};
  var text = (rep.text || src.text).replace(/^#[ \t]*name[ \t]*:[^\r\n]*/m, '#name: ' + FE.name.replace(/\.filter$/i, ''));
  var ok = await feWrite(text, null, 'online update', true);
  if (!ok) return;
  FE.undo = [];
  await api.filter_online_mark(FE.name, st.online, src.version);
  var skipped = rep.skipped || [];
  UI.toast(skipped.length ? 'Filter updated — ' + skipped.length + ' edit' + (skipped.length === 1 ? '' : 's') + ' could not be reapplied (' +
    skipped.map(function (s) { return s.reason; }).slice(0, 2).join('; ') + ')'
    : edits.length ? edits.length + ' changes reapplied successfully' : 'Filter updated', skipped.length ? 'warn' : 'success', { timeout: 10000 });
  var r = await api.filter_switch(FE.name);
  if (!r || !r.ok) UI.toast('Couldn\'t switch back in game: ' + ((r && r.error) || 'no answer'), 'warn');
  await feOnlineCheck();
  feRender();
}

// the filter list (local first, then online filters to import): picking one sends /itemfilter once
function feFilterPicker() {
  var api = feApi();
  var box = UI.el('div', 'fe-picker');
  (FE.files || []).forEach(function (n) {
    var row = UI.el('button', 'fe-pick-row' + (n === FE.name ? ' is-active' : ''));
    row.type = 'button';
    var online = FE.onlineList.some(function (o) { return o.local === n; });
    row.appendChild(UI.el('span', 'fe-pick-name', (online ? '(Local) ' : '') + n.replace(/\.filter$/i, '').replace(/-local$/i, '')));
    row.appendChild(UI.el('span', 'fe-pick-tag', n === FE.name ? 'Active' : ''));
    row.addEventListener('click', async function () {
      if (n === FE.name) { FE.pickFilter = false; feRender(); return; }
      if (!await feConfirmDiscard()) return;
      FE.undo = [];
      await feLoadFile(n);
      await feOnlineCheck();
      FE.pickFilter = false;
      feRematch();
      feRender();
      var r = await api.filter_switch(n);
      UI.toast(r && r.ok ? 'Switched the game to ' + n.replace(/\.filter$/i, '') : 'Opened ' + n + '. Pick it in game: Options → Game → Item filter.',
        r && r.ok ? 'success' : 'warn');
    });
    box.appendChild(row);
  });
  if (FE.importable.length) {
    box.appendChild(UI.el('div', 'fe-caption', 'Online Filters'));
    FE.importable.forEach(function (f) {
      var row = UI.el('button', 'fe-pick-row');
      row.type = 'button';
      row.appendChild(UI.el('span', 'fe-pick-name', f.name));
      row.appendChild(UI.el('span', 'fe-pick-tag fe-dim', 'Online · import'));
      row.addEventListener('click', function () { feImport(f); });
      box.appendChild(row);
    });
  }
  box.appendChild(UI.el('p', 'fe-hint', 'To add an online filter, load it in game first (Options → Game → Item filter): ' +
    'it then appears here. Importing makes a local copy you can edit; your edits are kept when the online one updates.'));
  return box;
}

async function feImport(f) {
  var api = feApi();
  var r = await api.filter_online_import(f.id, false);
  if (!r || !r.ok) { UI.toast('Couldn\'t import: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
  FE.undo = [];
  FE.pickFilter = false;
  await feLoadList();
  await feLoadFile(r.local);
  await feOnlineCheck();
  feRematch();
  feRender();
  var sw = await api.filter_switch(r.local);
  UI.toast(sw && sw.ok ? 'Imported and switched to ' + r.local + ' in game' : 'Imported ' + r.local +
    '. Pick it in game: Options → Game → Item filter.', sw && sw.ok ? 'success' : 'warn');
}

function feImportCard() {
  var box = UI.el('div', 'fe-tip');
  box.appendChild(UI.el('span', 'fe-tip-i', 'i'));
  var t = UI.el('span', 'fe-tip-text', 'Online filters can\'t be edited directly. Import one to edit a local copy ' +
    '(your edits are kept when the online one updates): ');
  FE.importable.slice(0, 3).forEach(function (f) {
    t.appendChild(UI.button('secondary', { size: 'sm', label: 'Import ' + f.name, onClick: function () { feImport(f); } }));
  });
  box.appendChild(t);
  box.appendChild(UI.iconButton('✕', 'Dismiss', { size: 'sm', onClick: function () { feDismissTip('import'); feRender(); } }));
  return box;
}

// ---- hero: the item + Save ---------------------------------------------------------------------------------
var FE_RARITY = { NORMAL: 'normal', MAGIC: 'magic', RARE: 'rare', UNIQUE: 'unique', RELIC: 'unique', GEM: 'gem',
  CURRENCY: 'normal', DIVINATION: 'div' };
function feRarityCls() {
  var it = FE.item || {}, r = String(it.rarity || 'NORMAL').toUpperCase();
  if (/divination card/i.test(it.itemClass || '')) return 'div';
  return FE_RARITY[r] || 'normal';
}
function feItemArt() {
  var it = FE.item;
  if (/divination card/i.test(it.itemClass || '')) return feCardArt(it.name) || feIcon(it.base || it.name);
  return feIcon(it.base) || feIcon(it.name);
}
function feSaveButton(compact) {
  var dirty = feDirty();
  var label = FE.save === 'saving' ? 'Saving...' : FE.save === 'saved' ? 'Saved' : 'Save';
  var b = UI.el('button', 'fe-save' + (compact ? ' is-compact' : '') + (dirty ? ' is-dirty' : '') +
    (FE.save === 'saved' ? ' is-saved' : '') + (FE.save === 'saving' ? ' is-saving' : ''), label);
  b.type = 'button';
  b.disabled = !dirty || FE.busy;
  b.title = dirty ? 'Save your changes to the filter' + (PREFS.filterReload === false ? '' : ' (and reload it in game)') : 'No unsaved changes';
  b.addEventListener('click', feSave);
  return b;
}
function feHero() {
  var it = FE.item;
  var hero = UI.el('div', 'fe-hero');
  hero.appendChild(feArt(feItemArt(), 44, 'fe-hero-art'));
  var txt = UI.el('div', 'fe-hero-text');
  var nm = UI.el('div', 'fe-hero-name fe-r-' + feRarityCls(), it.name || it.base);
  txt.appendChild(nm);
  if (it.base && it.name && it.base !== it.name) txt.appendChild(UI.el('div', 'fe-dim fe-hero-base', it.base));
  var chips = UI.el('div', 'fe-chips');
  if (FE.heroPrice) chips.appendChild(fePriceChip(FE.heroPrice * (it.stackSize > 1 ? 1 : 1), 'fe-price-hero'));
  if (it.itemClass) chips.appendChild(feChip(it.itemClass));
  if (it.itemLevel) { var il = UI.el('span', 'fe-info'); il.appendChild(UI.el('span', 'fe-dim', 'iLvl ')); il.appendChild(UI.el('strong', null, String(it.itemLevel))); chips.appendChild(il); }
  if (it.quality) chips.appendChild(feChip('Quality ' + it.quality + '%'));
  if (it.stackSize > 1) chips.appendChild(feChip('Stack ' + it.stackSize));
  if (it.corrupted) chips.appendChild(UI.el('span', 'fe-info fe-red', 'Corrupted'));
  (it.influences || []).forEach(function (inf) { chips.appendChild(UI.el('span', 'fe-info fe-gold', inf)); });
  if (it.synthetic) chips.appendChild(feChip('looked up', 'Loaded from the panel, not the item you hovered'));
  txt.appendChild(chips);
  var z = feZoneToggle();
  if (z) txt.appendChild(z);
  hero.appendChild(txt);
  hero.appendChild(feSaveButton(false));
  return hero;
}
function feSticky() {
  var s = UI.el('div', 'fe-sticky');
  s.id = 'fe-sticky';
  s.appendChild(feArt(feItemArt(), 22));
  s.appendChild(UI.el('span', 'fe-sticky-name fe-r-' + feRarityCls(), FE.item.name || FE.item.base));
  s.appendChild(feSaveButton(true));
  s.classList.toggle('is-on', window.scrollY > 60);
  return s;
}
// art that can't load (offline, unknown base) leaves an empty space, never a broken-image icon;
// the art cache (08-cards.js) may swap in another copy, which shows again once it loads
document.addEventListener('error', function (e) {
  var t = e.target;
  if (t && t.tagName === 'IMG' && t.closest && t.closest('.fedit, .fe-dd')) t.classList.add('fe-img-off');
}, true);
document.addEventListener('load', function (e) {
  var t = e.target;
  if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('fe-img-off')) t.classList.remove('fe-img-off');
}, true);
window.addEventListener('scroll', function () {
  var s = document.getElementById('fe-sticky');
  if (s) s.classList.toggle('is-on', window.scrollY > 60);
}, { passive: true });

function feToggle(on, onChange, disabled) {
  var t = UI.el('button', 'fe-toggle' + (on ? ' is-on' : ''));
  t.type = 'button';
  t.setAttribute('role', 'switch');
  t.setAttribute('aria-checked', on ? 'true' : 'false');
  t.disabled = !!disabled;
  t.appendChild(UI.el('span', 'fe-knob'));
  t.addEventListener('click', function (e) { e.stopPropagation(); onChange(!on); });
  return t;
}
function feZoneToggle() {
  if (!feZoneUsable()) return null;
  var on = !!PREFS.filterUseZone;
  var pill = UI.el('span', 'fe-info fe-zone');
  pill.title = 'Override the item\'s area level with the zone you\'re in (' + FE.zone.id + ')';
  function flip(v) { PREFS.filterUseZone = v; savePrefs(); feRematch(); feRender(); }
  pill.appendChild(feToggle(on, flip));
  pill.appendChild(UI.el('span', 'fe-dim', 'Use Zone Level'));
  pill.appendChild(UI.el('strong', null, String(FE.zone.level)));
  pill.addEventListener('click', function () { flip(!on); });
  return pill;
}

// ---- the label preview (Fontin, scaled like the game) ---------------------------------------------------------
function feRgba(v, dflt) {
  v = (v || dflt || [0, 0, 0, 0]).map(function (n) { return parseInt(n, 10) || 0; });
  return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + ((v[3] == null ? 255 : v[3]) / 255).toFixed(3) + ')';
}
function feFontSize(acts) { var f = acts && acts.SetFontSize; return f ? Math.max(1, Math.min(45, parseInt(f[0], 10) || 32)) : 32; }
function feLabel(acts, text, hidden) {
  if (hidden) return UI.el('span', 'fe-label is-hidden', text);
  acts = acts || {};
  var lab = UI.el('span', 'fe-label', text);
  lab.style.color = feRgba(acts.SetTextColor, [200, 200, 200, 255]);
  lab.style.backgroundColor = feRgba(acts.SetBackgroundColor, [0, 0, 0, 153]);
  lab.style.borderColor = acts.SetBorderColor ? feRgba(acts.SetBorderColor) : 'transparent';
  lab.style.fontSize = Math.round(feFontSize(acts) * 0.48) + 'px';
  return lab;
}
// one block's look as the game draws it for this item (Continue blocks above composed in)
function feBlockLook(index) {
  var by = {};
  (FE.match && FE.match.trail || []).forEach(function (t) { t.block.actions.forEach(function (a) { by[a.key] = a.args; }); });
  var b = FE.parsed.blocks[index];
  if (b) b.actions.forEach(function (a) { by[a.key] = a.args; });
  return by;
}
function feActsObj(block) { var by = {}; (block.actions || []).forEach(function (a) { by[a.key] = a.args; }); return by; }

// ---- Retier card: Switch Tier dropdown with every tier's label ------------------------------------------------
function feRetierCard(m) {
  var targets = FilterEdit.moveTargets(FE.text, FE.fitem, m.index) || [];
  var ok = targets.filter(function (t) { return t.ok; });
  var plan = FilterEdit.hidePlan(FE.text, FE.fitem);
  if (!m.block.tags || !m.block.tags.type) return null;
  if (!ok.length && (!plan || plan.kind === 'none') && m.visibility !== 'Hide') return null;
  var card = feCard();
  card.appendChild(feCardHead('⇅', 'Retier ' + feBase()));
  var body = UI.el('div', 'fe-card-body');
  var group = FilterEdit.tierGroup(FE.parsed, m.block);
  // equal height whatever the tier: the biggest sibling label decides
  var biggest = 11;
  group.forEach(function (t) { biggest = Math.max(biggest, t.visibility === 'Hide' ? 11 : Math.round(feFontSize(feActsObj(t.block)) * 0.48)); });
  var minH = Math.round(biggest * 1.2 + 6);
  var row = UI.el('div', 'fe-switch' + (FE.busy ? ' is-busy' : ''));
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('aria-haspopup', 'listbox');
  row.setAttribute('aria-expanded', FE.dd ? 'true' : 'false');
  row.appendChild(UI.el('span', 'fe-switch-label', 'Switch Tier'));
  var prev = UI.el('span', 'fe-switch-prev');
  prev.style.minHeight = minH + 'px';
  var hidden = m.visibility === 'Hide';
  prev.appendChild(feLabel(feBlockLook(m.index), feBase(), hidden));
  if (hidden) prev.appendChild(UI.el('span', 'fe-hidden-tag', '[HIDDEN]'));
  row.appendChild(prev);
  row.appendChild(UI.el('span', 'fe-switch-tier', feTierName(m.block)));
  row.appendChild(UI.el('span', 'fe-chev', FE.busy ? 'saving...' : FE.dd ? '▴' : '▾'));
  function toggle() { if (FE.busy) return; FE.dd = !FE.dd; feRender(); }
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  body.appendChild(row);
  var err = feErr('retier');
  if (err) body.appendChild(err);
  card.appendChild(body);
  if (FE.dd) setTimeout(function () { feDropdown(row, m, group, ok, plan, minH); }, 0);
  return card;
}

function feDropdown(anchor, m, group, ok, plan, minH) {
  feCloseLayers();
  var r = anchor.getBoundingClientRect();
  var list = UI.el('div', 'fe-dd');
  list.id = 'fe-dd-layer';
  list.setAttribute('role', 'listbox');
  list.style.top = (r.bottom + window.scrollY + 2) + 'px';
  list.style.left = (r.left + window.scrollX) + 'px';
  list.style.width = r.width + 'px';
  var okIdx = {};
  ok.forEach(function (t) { okIdx[t.index] = t; });
  var stack = m.block.conditions.some(function (c) { return feNorm(c.key) === 'stacksize'; });
  group.forEach(function (t) {
    var cur = t.index === m.index;
    if (!cur && !okIdx[t.index]) return; // tiers that can't take the item aren't offered
    var opt = UI.el('div', 'fe-dd-row' + (cur ? ' is-current' : ''));
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', cur ? 'true' : 'false');
    opt.tabIndex = 0;
    opt.appendChild(UI.el('span', 'fe-dd-tier', t.label || feTierName(t.block)));
    var text = feBase();
    if (stack) {
      var sc = t.block.conditions.filter(function (c) { return feNorm(c.key) === 'stacksize'; })[0];
      if (sc && sc.values[0] > 1) text = sc.values[0] + 'x ' + text;
    }
    var pv = UI.el('span', 'fe-dd-prev');
    pv.style.minHeight = minH + 'px';
    pv.appendChild(feLabel(feActsObj(t.block), text, t.visibility === 'Hide'));
    if (t.visibility === 'Hide') pv.appendChild(UI.el('span', 'fe-hidden-tag', '[HIDDEN]'));
    opt.appendChild(pv);
    if (cur) opt.appendChild(UI.el('span', 'fe-dd-cur', 'current'));
    function pick() {
      FE.dd = false;
      if (cur) { feRender(); return; }
      feConfirmDiscard().then(function (go) {
        if (!go) { feRender(); return; }
        feApply(FilterEdit.moveBase(FE.text, FE.fitem, feBase(), m.index, t.index),
          'Moved "' + feBase() + '" from ' + feTierName(m.block) + ' to ' + (t.label || feTierName(t.block)), 'retier');
      });
    }
    opt.addEventListener('click', pick);
    opt.addEventListener('keydown', function (e) { if (e.key === 'Enter') pick(); });
    list.appendChild(opt);
  });
  // Hide: says what it will do
  var hide = UI.el('div', 'fe-dd-row fe-dd-hide' + (plan && plan.kind !== 'none' ? '' : ' is-off'));
  hide.style.minHeight = (minH + 12) + 'px';
  hide.appendChild(UI.el('span', 'fe-dd-tier fe-red', 'Hide'));
  hide.appendChild(UI.el('span', 'fe-dd-explain', feHideText(plan)));
  if (plan && plan.kind !== 'none') {
    hide.setAttribute('role', 'option');
    hide.tabIndex = 0;
    hide.addEventListener('click', function () { FE.dd = false; feDoHide('retier'); });
  }
  list.appendChild(hide);
  document.body.appendChild(list);
  setTimeout(function () {
    document.addEventListener('mousedown', function close(e) {
      if (list.contains(e.target) || anchor.contains(e.target)) { if (!document.getElementById('fe-dd-layer')) document.removeEventListener('mousedown', close); return; }
      document.removeEventListener('mousedown', close);
      FE.dd = false;
      feRender();
    });
  }, 0);
}

function feHideText(plan) {
  if (!plan) return '';
  if (plan.kind === 'flip') return 'Hides the ' + feTierName(FE.parsed.blocks[plan.target]) + ' tier, which lists only this item';
  if (plan.kind === 'strip') return 'Hides the item by removing it from ' + plan.steps.length + ' tier' + (plan.steps.length === 1 ? '' : 's') + ' that show it';
  if (plan.kind === 'strip-add') return 'Hides the item by adding it to tier: ' + feTierName(FE.parsed.blocks[plan.target]) +
    (plan.steps.length > 1 ? ' (and taking it out of ' + (plan.steps.length - 1) + ' that show it)' : '');
  if (/already hidden/i.test(plan.reason || '')) return 'Already hidden — nothing to change';
  return plan.reason || 'No hidden tier is available for this item';
}
async function feDoHide(card) {
  if (!await feConfirmDiscard()) { feRender(); return; }
  feApply(FilterEdit.applyHide(FE.text, FE.fitem), 'Hid "' + feBase() + '"', card);
}

function feTierStrip(block) {
  var s = UI.el('div', 'fe-strip');
  s.appendChild(UI.el('span', 'fe-gold fe-strong', feTierName(block)));
  if (feTypePath(block)) s.appendChild(UI.el('span', 'fe-dim fe-small', feTypePath(block)));
  return s;
}
function feHideItemCard() {
  var plan = FilterEdit.hidePlan(FE.text, FE.fitem);
  var can = plan && plan.kind !== 'none';
  var s = feSub('Hide Item');
  var b = UI.el('button', 'fe-hide-btn' + (can ? '' : ' is-off'), 'Hide "' + feBase() + '"');
  b.type = 'button';
  b.disabled = !can || FE.busy;
  b.addEventListener('click', function () { feDoHide('hide'); });
  s.appendChild(b);
  s.appendChild(UI.el('div', 'fe-dim fe-small', feHideText(plan) || ' '));
  var e = feErr('hide');
  if (e) s.appendChild(e);
  return s;
}
function feNoMatch() {
  var c = feCard('fe-pad');
  c.appendChild(UI.el('p', 'fe-dim fe-center', 'No filter blocks match this item - it uses default visibility.'));
  return c;
}

// ---- uniques on this base ---------------------------------------------------------------------------------------
function feUniquesFor(base) {
  var seen = {}, out = [];
  ((window.POE_DUST || {}).items || []).forEach(function (e) {
    if (e[1] === base && !seen[e[0]]) { seen[e[0]] = 1; out.push({ name: e[0], dust: e[2] }); }
  });
  if (FE.px) Object.keys(FE.px.uniques).forEach(function (k) {
    var p = k.split('|');
    if (p.length === 2 && p[1] === base && !seen[p[0]]) { seen[p[0]] = 1; out.push({ name: p[0] }); }
  });
  out.forEach(function (u) { u.price = FE.px ? FE.px.uniques[u.name + '|' + base] || FE.px.uniques[u.name] || null : null; });
  out.sort(function (a, b) { return (b.price || -1) - (a.price || -1) || a.name.localeCompare(b.name); });
  return out;
}
function feUniquesRail() {
  var base = feBase(), list = feUniquesFor(base);
  if (!list.length) return null;
  var rail = UI.el('div', 'fe-rail');
  rail.setAttribute('aria-label', 'Uniques on ' + base);
  list.forEach(function (u) {
    var c = UI.el('button', 'fe-ucard' + (FE.item.name === u.name ? ' is-current' : ''));
    c.type = 'button';
    c.title = 'Look at ' + u.name;
    c.appendChild(UI.el('span', 'fe-ucard-name fe-r-unique', u.name));
    c.appendChild(feArt(feIcon(base), 40));
    if (u.price) c.appendChild(fePriceChip(u.price, 'fe-price-sm'));
    c.addEventListener('click', function () { feLoadBase(base, { unique: u.name, base: base }); });
    rail.appendChild(c);
  });
  return rail;
}

// ---- threshold editors (stack size / quality / strands) ------------------------------------------------------
function feThresholdCards() {
  var out = [], strands = false;
  FE_THRESHOLDS.forEach(function (k) {
    if (k[0] === 'Quality' && strands) return;
    var segs = FilterEdit.thresholdSegments(FE.text, FE.fitem, k[0]) || [];
    if (segs.length < 2) return;
    if (k[0] === 'MemoryStrands') strands = true;
    out.push(feThresholdCard(k, segs));
  });
  // strands win over quality (the game shows strands on those items)
  if (strands && out.length > 1) out = out.filter(function (c) { return c.dataset.key !== 'Quality'; });
  return out;
}
function feThresholdCard(k, segs) {
  var key = k[0], start = k[2], suffix = k[3];
  var card = feCard('fe-th');
  card.dataset.key = key;
  card.appendChild(UI.el('div', 'fe-th-label', k[1]));
  var bar = UI.el('div', 'fe-th-bar');
  var row = UI.el('div', 'fe-th-row');
  var pend = FE.pendingTh && FE.pendingTh.key === key ? FE.pendingTh : null;
  segs.forEach(function (g, i) {
    var blk = g.block, vis = blk ? blk.visibility : 'Hide';
    bar.appendChild(UI.el('span', 'fe-th-cell is-' + feNorm(vis)));
    var from = i === 0 ? start : (pend && pend.old === g.from ? pend.value : g.from);
    var next = segs[i + 1];
    var to = next ? (pend && pend.old === next.from ? pend.value : next.from) - 1 : null;
    var cell = UI.el('div', 'fe-th-seg');
    var txt = to == null ? from + suffix + '+' : from === to ? from + suffix : from + '-' + to + suffix;
    var pill = UI.el('button', 'fe-th-pill' + (g.index === FE.sel ? ' is-sel' : ''), txt);
    pill.type = 'button';
    pill.title = blk ? (blk.visibility === 'Hide' ? 'Hidden by ' : 'Shown by ') + feTierName(blk) : 'No block: default look';
    pill.addEventListener('mousedown', function (e) {
      e.preventDefault();
      if (g.index < 0) return;
      FE.sel = g.index;
      FE.draft = {};
      feRender();
    });
    cell.appendChild(pill);
    row.appendChild(cell);
    if (next) row.appendChild(feBoundary(k, segs, i));
  });
  card.appendChild(bar);
  card.appendChild(row);
  if (!feTipDismissed('threshold')) {
    var tip = UI.el('div', 'fe-tip');
    tip.appendChild(UI.el('span', 'fe-tip-i', 'i'));
    tip.appendChild(UI.el('span', 'fe-tip-text', 'Tip: Selecting a different segment in the threshold editor changes which block is being viewed and edited in your filter.'));
    tip.appendChild(UI.iconButton('✕', 'Dismiss tip', { size: 'sm', onClick: function () { feDismissTip('threshold'); feRender(); } }));
    card.appendChild(tip);
  }
  return card;
}
// the boundary between segment i and i+1: an input with ‹ › (buffered until Save)
function feBoundary(k, segs, i) {
  var key = k[0], min = k[2] + 1;
  var next = segs[i + 1];
  var pend = FE.pendingTh && FE.pendingTh.key === key && FE.pendingTh.old === next.from ? FE.pendingTh : null;
  var val = pend ? pend.value : next.from;
  var lo = Math.max(min, (i === 0 ? k[2] : segs[i].from) + 1);
  var hi = segs[i + 2] ? segs[i + 2].from - 1 : Infinity;
  var type = null;
  [segs[i].block, next.block].forEach(function (b) { if (!type && b && b.tags && b.tags.type) type = b.tags.type; });
  var box = UI.el('div', 'fe-bound');
  var inp = document.createElement('input');
  inp.className = 'fe-bound-in';
  inp.type = 'text';
  inp.inputMode = 'numeric';
  inp.value = String(val);
  inp.setAttribute('aria-label', k[1] + ' boundary');
  inp.disabled = !type;
  inp.title = type ? 'Where ' + (next.block ? feTierName(next.block) : 'the next segment') + ' starts (only in the ' + type + ' tiers)'
    : 'These blocks have no tier tag: the boundary can\'t be changed here';
  function set(v) {
    v = parseInt(v, 10);
    if (isNaN(v) || v < lo || v > hi) { inp.value = String(val); return; }
    if (v === next.from) FE.pendingTh = null;
    else FE.pendingTh = { key: key, type: type, old: next.from, value: v, label: k[1] };
    feRender();
  }
  inp.addEventListener('change', function () { set(this.value); });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp') { e.preventDefault(); set(val + 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); set(val - 1); }
  });
  box.appendChild(inp);
  var ch = UI.el('div', 'fe-bound-ch');
  ch.appendChild(UI.iconButton('‹', 'Lower', { size: 'sm', onClick: function () { if (type) set(val - 1); } }));
  ch.appendChild(UI.iconButton('›', 'Higher', { size: 'sm', onClick: function () { if (type) set(val + 1); } }));
  box.appendChild(ch);
  return box;
}

// ---- Edit Tier card -----------------------------------------------------------------------------------------------
function feBlockCard(b) {
  var card = feCard('fe-block');
  var cls = b.conditions.filter(function (c) { return feNorm(c.key) === 'class'; })[0];
  card.appendChild(feCardHead('⚙', 'Edit Tier: ' + (b.tags && b.tags.tier ? feTierName(b) : 'Block #' + (b.index + 1)),
    [cls ? feChip(cls.values.join(', ')) : (FE.item.itemClass ? feChip(FE.item.itemClass) : null),
     feTypePath(b) ? feChip(feTypePath(b)) : null]));
  var body = UI.el('div', 'fe-card-body');
  var items = feItemsInTier(b);
  if (items) body.appendChild(items);
  if (FE.expand) body.appendChild(feTierItemsList(b));
  body.appendChild(feVisibilityToggle());
  var det = feDetails(b);
  if (det) body.appendChild(det);
  body.appendChild(feTierLabel());
  body.appendChild(feEffects());
  var other = feOther();
  if (other) body.appendChild(other);
  var e = feErr('block');
  if (e) body.appendChild(e);
  card.appendChild(body);
  return card;
}

function feItemsInTier(b) {
  var bases = FilterEdit.tierBases(b) || [];
  if (!bases.length) return null;
  var s = feSub('Items in this Tier');
  var row = UI.el('div', 'fe-actions');
  // Expand: the tier's bases, icons first
  var c1 = UI.el('div', 'fe-action');
  var strip = UI.el('div', 'fe-strip-icons');
  bases.slice(0, 40).forEach(function (n) {
    var u = feIcon(n);
    if (!u) return;
    var img = document.createElement('img');
    img.src = u;
    img.alt = '';
    img.title = n;
    strip.appendChild(img);
  });
  c1.appendChild(strip);
  c1.appendChild(UI.button(FE.expand ? 'secondary' : 'ghost', { size: 'sm', label: (FE.expand ? 'Collapse' : 'Expand') + ' (' + bases.length + ')',
    onClick: function () { FE.expand = !FE.expand; feRender(); } }));
  row.appendChild(c1);
  // Economy audit
  var unique = /unique/i.test((b.tags && b.tags.type) || '') || b.conditions.some(function (c) {
    return feNorm(c.key) === 'rarity' && c.values.some(function (v) { return /unique/i.test(v); }); });
  var priced = bases.some(function (n) { return fePrice(n, unique); });
  var auditable = b.tags && b.tags.type && !FilterEdit.isExceptionTier(b.tags.tier);
  if (auditable) {
    var c2 = UI.el('div', 'fe-action');
    c2.appendChild(UI.el('div', 'fe-dim fe-small fe-center', !FE.px ? 'Loading prices…'
      : priced ? 'Make bulk changes to this tier based on the current economy.' : 'No bulk retiering in this category yet.'));
    var au = UI.button(priced || !FE.px ? 'primary' : 'ghost', { size: 'sm', label: priced || !FE.px ? 'Run Economy Audit' : 'Audit Unavailable',
      onClick: function () { if (!priced) return; FE.view = 'audit'; FE.audit = { index: b.index }; feRender(); window.scrollTo(0, 0); } });
    au.disabled = !!FE.px && !priced;
    c2.appendChild(au);
    row.appendChild(c2);
  }
  s.appendChild(row);
  return s;
}

// the tier's bases with art and price, dearest first (Scalpel's side column, here in the card)
function feTierItemsList(b) {
  var unique = /unique/i.test((b.tags && b.tags.type) || '');
  var list = (FilterEdit.tierBases(b) || []).map(function (n) { return { n: n, p: fePrice(n, unique) }; });
  list.sort(function (x, y) { return (y.p || -1) - (x.p || -1) || x.n.localeCompare(y.n); });
  var box = UI.el('div', 'fe-tier-items');
  list.forEach(function (x) {
    var cur = feNorm(x.n) === feNorm(feBase());
    var row = UI.el('button', 'fe-item-chip' + (cur ? ' is-current' : ''));
    row.type = 'button';
    row.title = cur ? 'This item' : 'Switch to ' + x.n;
    var icon = feIcon(x.n);
    if (icon) {
      var g = document.createElement('img'); g.className = 'fe-chip-glow'; g.src = icon; g.alt = ''; row.appendChild(g);
      var i = document.createElement('img'); i.className = 'fe-chip-icon'; i.src = icon; i.alt = ''; row.appendChild(i);
    }
    row.appendChild(UI.el('span', 'fe-chip-name', x.n));
    if (x.p) row.appendChild(fePriceChip(x.p, 'fe-price-sm'));
    if (!cur) row.addEventListener('click', function () { feLoadBase(x.n, { asUnique: unique }); });
    box.appendChild(row);
  });
  return box;
}

function feVisibilityToggle() {
  var vis = feVisibility();
  var s = feSub('Tier Visibility');
  var seg = UI.el('div', 'fe-seg');
  [['Show', 'Show', 'Show Tier'], ['Hide', 'Hide', 'Hide Tier']].forEach(function (o) {
    var on = vis === o[0];
    var b = UI.el('button', 'fe-seg-btn' + (on ? ' is-on is-' + feNorm(o[0]) : ''), on ? o[1] : o[2]);
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', function () { feSetVisibility(o[0]); });
    seg.appendChild(b);
  });
  s.appendChild(seg);
  return s;
}

function feDetails(b) {
  var rows = b.conditions.filter(function (c) { return ['class', 'basetype'].indexOf(feNorm(c.key)) < 0; });
  var bases = b.conditions.filter(function (c) { return feNorm(c.key) === 'basetype'; });
  if (!rows.length && !(FE.expand ? false : bases.length && !FilterEdit.tierBases(b).length)) return null;
  if (!rows.length) return null;
  var s = feSub('Additional Tier Details');
  rows.forEach(function (c) {
    var r = UI.el('div', 'fe-cond');
    r.appendChild(UI.el('span', 'fe-cond-key', c.key));
    if (FE_NUM_CONDS[feNorm(c.key)] && c.op && c.op !== '=' && c.op !== '==') r.appendChild(UI.el('span', 'fe-cond-op', c.op));
    else if (c.op && c.op !== '=' && c.op !== '') r.appendChild(UI.el('span', 'fe-cond-op', c.op));
    r.appendChild(UI.el('span', 'fe-cond-val', c.values.join(' ')));
    s.appendChild(r);
  });
  return s;
}

function feTierLabel() {
  var acts = feComposed();
  var s = UI.el('div', 'fe-sub fe-labelbox');
  s.appendChild(UI.el('div', 'fe-caption', 'Tier Label'));
  var prev = UI.el('div', 'fe-label-row');
  var hidden = feVisibility() === 'Hide';
  var holder = UI.el('span', 'fe-label-holder');
  var size = feFontSize(acts);
  var lab = feLabel(acts, feBase() || 'Sample Label', false);
  lab.style.fontSize = '15px';
  var scale = (size * 0.48) / 15;
  lab.style.transform = 'scale(' + scale.toFixed(3) + ')';
  lab.style.borderWidth = Math.max(0.25, 7.5 / (size * 0.48)) + 'px';
  if (hidden) lab.classList.add('is-dimmed');
  holder.appendChild(lab);
  prev.appendChild(holder);
  var fsWrap = UI.el('span', 'fe-font');
  var fs = UI.input({ type: 'range', min: 18, max: 45, step: 1, value: size, ariaLabel: 'Font size' });
  var val = UI.el('span', 'fe-font-v', String(size));
  fs.addEventListener('input', function () {
    var v = parseInt(this.value, 10);
    val.textContent = String(v);
    lab.style.transform = 'scale(' + ((v * 0.48) / 15).toFixed(3) + ')';
  });
  fs.addEventListener('change', function () { feSetAct('SetFontSize', [parseInt(this.value, 10)]); });
  fsWrap.appendChild(fs);
  fsWrap.appendChild(val);
  prev.appendChild(fsWrap);
  s.appendChild(prev);
  var sw = UI.el('div', 'fe-swatches');
  FE_SLOTS.forEach(function (slot) { sw.appendChild(feSwatch(slot, acts[slot[0]])); });
  s.appendChild(sw);
  return s;
}

// a colour slot: the colour itself, its name readable on it; click → picker (opens upward)
function feSwatch(slot, args) {
  var b = UI.el('button', 'fe-swatch' + (args ? '' : ' is-none'));
  b.type = 'button';
  var v = (args || []).map(function (n) { return parseInt(n, 10) || 0; });
  var dark = true;
  if (args) {
    var a = (v[3] == null ? 255 : v[3]) / 255;
    var lum = (299 * v[0] * a + 587 * v[1] * a + 114 * v[2] * a) / 1000;
    dark = lum < 128;
    b.style.background = feRgba(v);
  }
  b.classList.add(dark ? 'on-dark' : 'on-light');
  b.appendChild(UI.el('span', 'fe-swatch-name', slot[1].toUpperCase() + (args ? '' : ' (NONE)')));
  b.appendChild(UI.el('span', 'fe-swatch-pip', '✎'));
  b.title = args ? slot[1] + ': ' + v.join(' ') : slot[1] + ': not set (the game default)';
  b.addEventListener('click', function () { fePicker(b, slot, args); });
  return b;
}

// ---- colour picker: saturation/value square, hue, alpha, the filter's most used colours, manual --------------------
function feHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, mx ? d / mx : 0, mx];
}
function feRgb(h, s, v) {
  var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function feHex(v) { return v.slice(0, 3).map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join(''); }
// the colours the filter uses most for this action (Show blocks, weighted like Scalpel's)
function feColourFreq(key) {
  FE.freq = FE.freq && FE.freq.text === FE.text ? FE.freq : { text: FE.text, by: {} };
  if (FE.freq.by[key]) return FE.freq.by[key];
  var counts = {};
  var CLS = { 'stackable currency': 5, currency: 5, 'map fragments': 4, 'divination cards': 4, jewels: 3, maps: 3,
    'skill gems': 2, 'support gems': 2 };
  FE.parsed.blocks.forEach(function (b) {
    if (b.visibility !== 'Show') return;
    var a = b.actions.filter(function (x) { return x.key === key; })[0];
    if (!a || a.args.length < 3) return;
    var bt = b.conditions.filter(function (c) { return feNorm(c.key) === 'basetype'; })[0];
    var cl = b.conditions.filter(function (c) { return feNorm(c.key) === 'class'; })[0];
    var rar = b.conditions.filter(function (c) { return feNorm(c.key) === 'rarity'; })[0];
    var w = Math.max(1, bt ? bt.values.length : 1) * (cl ? CLS[feNorm(cl.values[0])] || 1 : 1);
    if (rar) w *= /unique/i.test(rar.values.join(' ')) ? 4 : /rare/i.test(rar.values.join(' ')) ? 1 : /magic/i.test(rar.values.join(' ')) ? 0.5 : 0.25;
    var v = a.args.slice(0, 4).map(function (n) { return parseInt(n, 10) || 0; });
    if (v.length < 4) v.push(255);
    var k = v.join(' ');
    counts[k] = counts[k] || { v: v, w: 0, cat: {} };
    counts[k].w += w;
    var cat = cl ? cl.values[0] : rar ? rar.values.join('/') : 'General';
    counts[k].cat[cat] = (counts[k].cat[cat] || 0) + w;
  });
  var out = Object.keys(counts).map(function (k) { return counts[k]; }).sort(function (a, b) { return b.w - a.w; }).slice(0, 18);
  out.forEach(function (c) { c.label = Object.keys(c.cat).sort(function (a, b) { return c.cat[b] - c.cat[a]; })[0]; });
  FE.freq.by[key] = out;
  return out;
}
function fePicker(anchor, slot, args) {
  feCloseLayers();
  var key = slot[0];
  var v = (args || slot[2]).map(function (n) { return parseInt(n, 10) || 0; });
  if (v.length < 4) v.push(255);
  var hsv = feHsv(v[0], v[1], v[2]);
  var layer = UI.el('div', 'fe-pop-back');
  layer.id = 'fe-pop-layer';
  var pop = UI.el('div', 'fe-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', slot[1] + ' colour');
  var sq = UI.el('div', 'fe-sv');
  var sqDot = UI.el('span', 'fe-sv-dot');
  sq.appendChild(sqDot);
  var hue = UI.el('div', 'fe-hue');
  var hueDot = UI.el('span', 'fe-bar-dot');
  hue.appendChild(hueDot);
  var alpha = UI.el('div', 'fe-alpha');
  var alphaFill = UI.el('span', 'fe-alpha-fill');
  var alphaDot = UI.el('span', 'fe-bar-dot');
  alpha.appendChild(alphaFill);
  alpha.appendChild(alphaDot);
  var hexIn = UI.input({ value: feHex(v), ariaLabel: 'Hex', cls: 'fe-man-in' });
  var rgbaIn = [0, 1, 2, 3].map(function (i) { return UI.input({ type: 'number', min: 0, max: 255, value: v[i], ariaLabel: 'RGBA'[i], cls: 'fe-man-in' }); });
  function paint() {
    var rgb = feRgb(hsv[0], hsv[1], hsv[2]);
    v = [rgb[0], rgb[1], rgb[2], v[3]];
    sq.style.background = 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(' + hsv[0] + ',100%,50%))';
    sqDot.style.left = (hsv[1] * 100) + '%';
    sqDot.style.top = ((1 - hsv[2]) * 100) + '%';
    hueDot.style.left = (hsv[0] / 360 * 100) + '%';
    alphaFill.style.background = 'linear-gradient(to right, transparent, rgb(' + rgb.join(',') + '))';
    alphaDot.style.left = (v[3] / 255 * 100) + '%';
    if (document.activeElement !== hexIn) hexIn.value = feHex(v);
    rgbaIn.forEach(function (inp, i) { if (document.activeElement !== inp) inp.value = v[i]; });
    anchor.style.background = feRgba(v);
  }
  function commit() { feSetAct(key, v.slice()); }
  function drag(el, fn) {
    el.addEventListener('pointerdown', function (e) {
      el.setPointerCapture(e.pointerId);
      fn(e); paint();
      function mv(ev) { fn(ev); paint(); }
      function up() { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); commit(); }
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
  }
  function frac(e, el) { var r = el.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))]; }
  drag(sq, function (e) { var f = frac(e, sq); hsv[1] = f[0]; hsv[2] = 1 - f[1]; });
  drag(hue, function (e) { hsv[0] = frac(e, hue)[0] * 359.9; });
  drag(alpha, function (e) { v[3] = Math.round(frac(e, alpha)[0] * 255); });
  pop.appendChild(sq);
  pop.appendChild(hue);
  pop.appendChild(alpha);
  var freq = feColourFreq(key);
  if (freq.length) {
    pop.appendChild(UI.el('div', 'fe-pop-cap', 'Most used'));
    var grid = UI.el('div', 'fe-freq');
    freq.forEach(function (c) {
      var sw = UI.el('button', 'fe-freq-sw' + (c.v.join(' ') === v.join(' ') ? ' is-sel' : ''));
      sw.type = 'button';
      sw.style.background = feRgba(c.v);
      sw.title = c.v.slice(0, c.v[3] < 255 ? 4 : 3).join(' ') + ' (' + c.label + ')';
      sw.setAttribute('aria-label', sw.title);
      sw.addEventListener('click', function () { v = c.v.slice(); hsv = feHsv(v[0], v[1], v[2]); paint(); commit(); });
      grid.appendChild(sw);
    });
    pop.appendChild(grid);
  }
  var man = UI.el('details', 'fe-man');
  man.appendChild(UI.el('summary', 'fe-pop-cap', 'Manual input'));
  var hr = UI.el('div', 'fe-man-row');
  hr.appendChild(UI.el('span', 'fe-man-l', 'Hex'));
  hr.appendChild(hexIn);
  man.appendChild(hr);
  var rr = UI.el('div', 'fe-man-row');
  rr.appendChild(UI.el('span', 'fe-man-l', 'RGBA'));
  rgbaIn.forEach(function (i) { rr.appendChild(i); });
  man.appendChild(rr);
  hexIn.addEventListener('input', function () {
    var h = this.value.replace(/[^0-9a-f]/gi, '');
    if (h.length !== 6) return;
    v = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), v[3]];
    hsv = feHsv(v[0], v[1], v[2]);
    paint();
  });
  hexIn.addEventListener('change', commit);
  rgbaIn.forEach(function (inp, i) {
    inp.addEventListener('change', function () {
      v[i] = Math.max(0, Math.min(255, parseInt(this.value, 10) || 0));
      hsv = feHsv(v[0], v[1], v[2]);
      paint();
      commit();
    });
  });
  pop.appendChild(man);
  if (args) pop.appendChild(UI.button('ghost', { size: 'sm', label: 'Remove ' + slot[1].toLowerCase() + ' colour',
    onClick: function () { feCloseLayers(); feSetAct(key, null); } }));
  layer.appendChild(pop);
  layer.addEventListener('mousedown', function (e) { if (e.target === layer) { feCloseLayers(); feRender(); } });
  layer.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); feCloseLayers(); feRender(); } });
  document.body.appendChild(layer);
  paint();
  // centred on the swatch, its bottom 4 px above it (opens upward; below when there's no room)
  var r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
  var top = r.top - pr.height - 4;
  if (top < 4) top = r.bottom + 4;
  pop.style.top = top + 'px';
  pop.style.left = Math.max(4, Math.min(window.innerWidth - pr.width - 4, r.left + r.width / 2 - pr.width / 2)) + 'px';
  sq.focus && sq.setAttribute('tabindex', '-1');
}

// ---- effects: minimap icon, beam, sound ---------------------------------------------------------------------------------
function feShapeSvg(shape, colour, size) {
  var s = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true"><g fill="' + colour +
    '" stroke="rgba(0,0,0,.55)" stroke-width="1.2" stroke-linejoin="round">' + (FE_SHAPE_SVG[shape] || FE_SHAPE_SVG.Circle) + '</g></svg>';
  var span = UI.el('span', 'fe-shape');
  span.innerHTML = s; // fixed markup from FE_SHAPE_SVG + a colour from FE_COLOURS
  return span;
}
function feColourHex(name) { var c = FE_COLOURS.filter(function (x) { return feNorm(x[0]) === feNorm(name); })[0]; return c ? c[1] : '#eeeeee'; }

function feEffects() {
  var acts = feComposed();
  var wrap = UI.el('div', 'fe-effects');
  var head = UI.el('button', 'fe-effects-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', FE.effects ? 'true' : 'false');
  head.appendChild(UI.el('span', 'fe-chev', FE.effects ? '▾' : '▸'));
  head.appendChild(UI.el('span', null, 'Effects (Minimap, Beam, Sound)'));
  var sum = [];
  if (acts.MinimapIcon && parseInt(acts.MinimapIcon[0], 10) >= 0) sum.push(feShapeSvg(acts.MinimapIcon[2], feColourHex(acts.MinimapIcon[1]), 14));
  if (acts.PlayEffect && feNorm(acts.PlayEffect[0]) !== 'none') { var bm = UI.el('span', 'fe-beam-mini'); bm.style.background = feColourHex(acts.PlayEffect[0]); sum.push(bm); }
  if (FE_SOUND_KEYS.some(function (k) { return acts[k]; })) sum.push(UI.el('span', 'fe-dim', '♪'));
  sum.forEach(function (x) { head.appendChild(x); });
  head.addEventListener('click', function () { FE.effects = !FE.effects; feRender(); });
  wrap.appendChild(head);
  if (!FE.effects) return wrap;
  var body = UI.el('div', 'fe-effects-body');
  body.appendChild(feMinimapBox(acts.MinimapIcon));
  body.appendChild(feBeamBox(acts.PlayEffect));
  body.appendChild(feSoundBox(acts));
  wrap.appendChild(body);
  return wrap;
}
function feBox(title) { var b = UI.el('div', 'fe-box'); b.appendChild(UI.el('div', 'fe-box-title', title)); return b; }

function feMinimapBox(mi) {
  var on = mi && parseInt(mi[0], 10) >= 0;
  var size = on ? String(parseInt(mi[0], 10)) : '', colour = on ? mi[1] : 'Red', shape = on ? mi[2] : 'Circle';
  var box = feBox('Minimap Icon');
  var r1 = UI.el('div', 'fe-row');
  if (on) r1.appendChild(feShapeSvg(shape, feColourHex(colour), 24));
  var sizes = UI.el('span', 'fe-btn-group');
  [['', 'None'], ['0', 'Large'], ['1', 'Medium'], ['2', 'Small']].forEach(function (o) {
    var sel = size === o[0];
    var b = UI.el('button', 'fe-mini-btn' + (sel ? (o[0] === '' ? ' is-none' : ' is-sel') : ''), o[1]);
    b.type = 'button';
    b.setAttribute('aria-pressed', sel ? 'true' : 'false');
    b.addEventListener('click', function () { feSetAct('MinimapIcon', o[0] === '' ? null : [parseInt(o[0], 10), colour, shape]); });
    sizes.appendChild(b);
  });
  r1.appendChild(sizes);
  box.appendChild(r1);
  var bar = UI.el('div', 'fe-colour-bar' + (on ? '' : ' is-off'));
  FE_COLOURS.forEach(function (c) {
    var b = UI.el('button', 'fe-colour-cell' + (on && feNorm(colour) === feNorm(c[0]) ? ' is-sel' : ''));
    b.type = 'button';
    b.style.background = c[1];
    b.title = c[0];
    b.setAttribute('aria-label', c[0]);
    b.disabled = !on;
    b.addEventListener('click', function () { feSetAct('MinimapIcon', [parseInt(size, 10), c[0], shape]); });
    bar.appendChild(b);
  });
  box.appendChild(bar);
  var grid = UI.el('div', 'fe-shapes' + (on ? '' : ' is-off'));
  FE_SHAPES.forEach(function (s) {
    var sel = on && feNorm(shape) === feNorm(s);
    var b = UI.el('button', 'fe-shape-tile' + (sel ? ' is-sel' : ''));
    b.type = 'button';
    b.title = s === 'UpsideDownHouse' ? 'House' : s;
    b.setAttribute('aria-label', b.title);
    b.disabled = !on;
    b.appendChild(feShapeSvg(s, sel ? feColourHex(colour) : '#eeeeee', 20));
    b.addEventListener('click', function () { feSetAct('MinimapIcon', [parseInt(size, 10), colour, s]); });
    grid.appendChild(b);
  });
  box.appendChild(grid);
  return box;
}

function feBeamBox(pe) {
  var on = pe && feNorm(pe[0]) !== 'none';
  var colour = on ? pe[0] : '', temp = on && feNorm(pe[1]) === 'temp';
  var box = feBox('Beam Effect');
  var row = UI.el('div', 'fe-row');
  var cells = UI.el('div', 'fe-beam');
  var none = UI.el('button', 'fe-beam-cell is-none' + (on ? '' : ' is-sel'), 'NONE');
  none.type = 'button';
  none.addEventListener('click', function () { feSetAct('PlayEffect', null); });
  cells.appendChild(none);
  FE_COLOURS.slice(0, 7).forEach(function (c) {
    var b = UI.el('button', 'fe-beam-cell' + (on && feNorm(colour) === feNorm(c[0]) ? ' is-sel' : ''));
    b.type = 'button';
    b.style.background = c[1];
    b.title = c[0];
    b.setAttribute('aria-label', c[0] + ' beam');
    b.addEventListener('click', function () { feSetAct('PlayEffect', temp ? [c[0], 'Temp'] : [c[0]]); });
    cells.appendChild(b);
  });
  row.appendChild(cells);
  var t = UI.el('span', 'fe-temp' + (on ? '' : ' is-off'));
  t.appendChild(feToggle(temp, function (v) { feSetAct('PlayEffect', v ? [colour || 'Red', 'Temp'] : [colour || 'Red']); }, !on));
  t.appendChild(UI.el('span', 'fe-dim fe-small', 'Temp'));
  t.title = 'Temp: the beam shows only while the item drops';
  row.appendChild(t);
  box.appendChild(row);
  return box;
}

function feSoundBox(acts) {
  var box = feBox('Alert Sound');
  var row = UI.el('div', 'fe-row');
  var key = FE_SOUND_KEYS.filter(function (k) { return acts[k]; })[0];
  var cur = key ? acts[key] : null;
  var sel = document.createElement('select');
  sel.className = 'fe-select';
  sel.setAttribute('aria-label', 'Alert sound');
  function opt(parent, value, label) { var o = document.createElement('option'); o.value = value; o.textContent = label; parent.appendChild(o); }
  opt(sel, '', 'None');
  var g1 = document.createElement('optgroup');
  g1.label = 'Built-in';
  for (var i = 1; i <= 16; i++) opt(g1, 'b:' + i, i + (FE_SOUNDS[i] ? ' - ' + FE_SOUNDS[i] : ' - Sound ' + i));
  sel.appendChild(g1);
  var customs = FE.soundFiles || [];
  var curFile = key && /custom/i.test(key) ? String(cur[0]) : null;
  if (customs.length || curFile) {
    var g2 = document.createElement('optgroup');
    g2.label = 'Custom Sounds';
    customs.forEach(function (f) { opt(g2, 'c:' + f, f); });
    if (curFile && customs.indexOf(curFile) < 0) opt(g2, 'c:' + curFile, curFile + (FE.soundFiles ? ' (missing)' : ''));
    sel.appendChild(g2);
  }
  sel.value = !key ? '' : curFile ? 'c:' + curFile : 'b:' + parseInt(cur[0], 10);
  var vol = cur && cur[1] != null ? parseInt(cur[1], 10) || 300 : 300;
  sel.addEventListener('change', function () {
    var v = this.value;
    if (!v) { feSetAct(key || 'PlayAlertSound', null); return; }
    if (v.indexOf('b:') === 0) { fePlaySound(v); feSetAct('PlayAlertSound', [parseInt(v.slice(2), 10), vol]); }
    else { fePlaySound(v); feSetAct('CustomAlertSound', [v.slice(2), vol]); }
  });
  row.appendChild(sel);
  if (key) {
    var play = UI.iconButton('▶', 'Preview sound', { size: 'sm', onClick: function () { fePlaySound(sel.value); } });
    row.appendChild(play);
  }
  box.appendChild(row);
  if (!FE.soundFiles) feLoadSoundList();
  return box;
}
async function feLoadSoundList() {
  var api = feApi();
  FE.soundFiles = [];
  if (!api || !api.filter_sound_list) return;
  try {
    var r = await api.filter_sound_list();
    if (r && r.ok) { FE.soundFiles = r.files || []; if (FE.effects) feRender(); }
  } catch (e) { /* no custom sounds */ }
}
var feAudio = null;
async function fePlaySound(v) {
  var api = feApi();
  if (!api || !v) return;
  try {
    var r = v.indexOf('b:') === 0 ? await api.filter_asset('sound', 'AlertSound_' + ('0' + parseInt(v.slice(2), 10)).slice(-2) + '.ogg')
      : await api.filter_sound_file(v.slice(2));
    if (!r || !r.ok) return;
    if (feAudio) feAudio.pause();
    feAudio = new Audio(r.url || r.path);
    feAudio.volume = Math.max(0, Math.min(1, (PREFS.filterPreviewVolume == null ? 25 : PREFS.filterPreviewVolume) / 100));
    feAudio.play().catch(function () {});
  } catch (e) { /* preview only */ }
}

function feOther() {
  var acts = feComposed();
  var keys = Object.keys(acts).filter(function (k) { return FE_STYLE_KEYS.indexOf(k) < 0; });
  if (!keys.length) return null;
  var box = feBox('Other');
  keys.forEach(function (k) {
    var row = UI.el('label', 'fe-other');
    row.appendChild(UI.el('span', 'fe-dim fe-small fe-other-k', FE_OTHER_NAMES[k] || k));
    var inp = UI.input({ value: (acts[k] || []).join(' '), ariaLabel: k, cls: 'fe-other-in' });
    inp.addEventListener('change', function () {
      var v = this.value.trim();
      feSetAct(k, v ? v.split(/\s+/) : null);
    });
    row.appendChild(inp);
    box.appendChild(row);
  });
  return box;
}

// ---- economy audit page ---------------------------------------------------------------------------------------------------
function feAuditTier() {
  var a = FE.audit || {};
  return FE.parsed.blocks[a.index] || FE.parsed.blocks[FE.sel];
}
function feAuditGroup(b) {
  return FilterEdit.tierGroup(FE.parsed, b).filter(function (t) { return !t.exception && !/^rest/i.test(t.tier); });
}
function feAuditView() {
  var b = feAuditTier();
  var page = UI.el('div', 'fe-audit');
  if (!b || !b.tags || !b.tags.type || !(FilterEdit.tierBases(b) || []).length) {
    var n = feCard('fe-notice');
    n.appendChild(UI.el('div', 'fe-notice-t', 'Nothing to audit'));
    n.appendChild(UI.el('div', 'fe-dim', !b ? 'This item doesn\'t match any block in your filter.' : 'The matched block doesn\'t list any base types.'));
    page.appendChild(n);
    return page;
  }
  var unique = /unique/i.test(b.tags.type) || b.conditions.some(function (c) { return feNorm(c.key) === 'rarity' && /unique/i.test(c.values.join(' ')); });
  var bases = FilterEdit.tierBases(b);
  var group = feAuditGroup(b);
  var pos = group.map(function (t) { return t.index; }).indexOf(b.index);
  var higher = pos > 0 ? group.slice(0, pos).reverse() : [];
  var lower = pos >= 0 ? group.slice(pos + 1) : [];
  // hero: 4 of the tier's icons, the tier, the class; the tier picker + Show / Hide tier
  var hero = UI.el('div', 'fe-hero fe-audit-hero');
  var mosaic = UI.el('span', 'fe-mosaic');
  var icons = bases.map(feIcon).filter(Boolean);
  var seed = bases.join('|').length;
  var pick = [];
  for (var k = 0; k < Math.min(4, icons.length); k++) pick.push(icons[(seed * (k + 3) + k * 7) % icons.length]);
  if (pick[0]) { var g = document.createElement('img'); g.className = 'fe-mosaic-glow'; g.src = pick[0]; g.alt = ''; mosaic.appendChild(g); }
  pick.forEach(function (u) { var i = document.createElement('img'); i.src = u; i.alt = ''; mosaic.appendChild(i); });
  hero.appendChild(mosaic);
  var txt = UI.el('div', 'fe-hero-text');
  var st = b.conditions.filter(function (c) { return feNorm(c.key) === 'stacksize'; })[0];
  txt.appendChild(UI.el('div', 'fe-gold fe-strong', feTierName(b) + (st ? ' (Stack ' + (st.op || '>=') + ' ' + st.values[0] + ')' : '')));
  var cls = b.conditions.filter(function (c) { return feNorm(c.key) === 'class'; })[0];
  txt.appendChild(UI.el('div', 'fe-dim fe-small', cls ? cls.values.join(', ') : (FE.item.itemClass || '')));
  hero.appendChild(txt);
  var rc = UI.el('div', 'fe-audit-right');
  rc.appendChild(UI.el('div', 'fe-dim fe-small', group.length > 1 ? 'Audit Other Tier' : 'Current Tier'));
  var rr = UI.el('div', 'fe-row');
  rr.appendChild(feTierVisButton(b));
  var ts = UI.select(group.map(function (t) { return [String(t.index), t.label + (t.visibility === 'Hide' ? ' [HIDDEN]' : '')]; }), String(b.index), {
    ariaLabel: 'Tier to audit', cls: 'fe-select', onChange: function () { FE.audit = { index: parseInt(this.value, 10) }; feRender(); } });
  ts.disabled = group.length < 2;
  rr.appendChild(ts);
  rc.appendChild(rr);
  hero.appendChild(rc);
  page.appendChild(hero);
  if (!FE.px) { page.appendChild(UI.el('p', 'fe-dim fe-center fe-pad', 'Fetching prices for ' + bases.length + ' items...')); feLoadPrices(); return page; }
  var rows = bases.map(function (n) {
    var d = unique ? feUniquesFor(n).reduce(function (m, u) { return Math.max(m, u.dust || 0); }, 0) : 0;
    return { n: n, p: fePrice(n, unique), d: d || null };
  });
  var priced = rows.filter(function (r) { return r.p; });
  if (!priced.length) {
    page.appendChild(UI.el('p', 'fe-center fe-pad', 'Auditing currently unavailable for this tier'));
    page.appendChild(UI.el('p', 'fe-dim fe-small fe-center', 'Prices come from GGG\'s currency exchange and poe.ninja, which don\'t cover these items.'));
    return page;
  }
  var a = FE.audit = FE.audit || { index: b.index };
  if (a.index !== b.index) a.index = b.index;
  var max = Math.max.apply(null, priced.map(function (r) { return r.p; }));
  if (a.at == null) a.at = Math.min.apply(null, priced.map(function (r) { return r.p; }));
  var dusts = rows.filter(function (r) { return r.d; });
  var mode = unique && dusts.length ? (a.mode || 'price') : 'price';
  // controls: explanation, mode, the log price slider (and dust slider)
  var ctl = UI.el('div', 'fe-audit-ctl');
  ctl.appendChild(UI.el('h3', 'fe-title', 'Audit Tier'));
  ctl.appendChild(UI.el('p', 'fe-dim fe-small', 'Easily retier multiple items at once based on the current economy. Select a price on the slider ' +
    'and you will have the option to move the items below to a lower tier or the items above to a higher one.' +
    (unique && dusts.length ? ' On unique tiers, choose price, dust or both first.' : '')));
  if (unique && dusts.length) {
    var modes = UI.el('span', 'fe-pills');
    ['price', 'dust', 'both'].forEach(function (m) {
      var b2 = UI.el('button', 'fe-pill' + (mode === m ? ' is-on' : ''), m.toUpperCase());
      b2.type = 'button';
      b2.addEventListener('click', function () { a.mode = m; a.msg = null; feRender(); });
      modes.appendChild(b2);
    });
    ctl.appendChild(modes);
  }
  if (mode !== 'dust') ctl.appendChild(feLogSlider(a, max));
  if (mode !== 'price') ctl.appendChild(feDustSlider(a, dusts));
  page.appendChild(ctl);
  // the list: above (green), below (red), the bars at the split with the move buttons
  function passP(r) { return r.p >= a.at; }
  function passD(r) { return (r.d || 0) >= (a.dust || 0); }
  function zone(r) {
    if (mode === 'price') return passP(r) ? 'above' : 'below';
    if (mode === 'dust') return passD(r) ? 'above' : 'below';
    return passP(r) && passD(r) ? 'above' : !passP(r) && !passD(r) ? 'below' : 'middle';
  }
  var pr = mode === 'dust' ? rows.filter(function (r) { return r.d; }) : priced;
  pr.forEach(function (r) { r.z = zone(r); });
  var order = { above: 0, middle: 1, below: 2 };
  pr.sort(function (x, y) { return order[x.z] - order[y.z] || (mode === 'dust' ? y.d - x.d : y.p - x.p); });
  var above = pr.filter(function (r) { return r.z === 'above'; }).map(function (r) { return r.n; });
  var below = pr.filter(function (r) { return r.z === 'below'; }).map(function (r) { return r.n; });
  // the tier keeps at least one base
  if (above.length === bases.length) above = above.slice(0, -1);
  if (below.length === bases.length) below = below.slice(1);
  var list = UI.el('div', 'fe-audit-list');
  var zebra = 0, placed = { up: false, down: false };
  function bars() {
    if (!placed.up) { placed.up = true; if (higher.length && above.length) list.appendChild(feMoveBar('up', above, higher, b, a)); }
  }
  pr.forEach(function (r, idx) {
    if (r.z !== 'above') bars();
    if (r.z === 'below' && !placed.down) { placed.down = true; if (lower.length && below.length) list.appendChild(feMoveBar('down', below, lower, b, a)); }
    list.appendChild(feAuditRow(r, r.z === 'above' && higher.length ? 'is-up' : r.z === 'below' && lower.length ? 'is-down' : '', zebra++ % 2, unique, mode));
    if (idx === pr.length - 1) bars();
  });
  var un = rows.filter(function (r) { return mode === 'dust' ? !r.d : !r.p; });
  if (un.length) {
    list.appendChild(UI.el('div', 'fe-caption fe-pad-x', 'No Price Data'));
    un.forEach(function (r) { list.appendChild(feAuditRow(r, '', zebra++ % 2, unique, mode)); });
  }
  if (a.msg) list.insertBefore(UI.el('div', 'fe-gold fe-strong fe-pad', a.msg), list.firstChild);
  page.appendChild(list);
  return page;
}
function feLogSlider(a, max) {
  var pill = UI.el('div', 'fe-slider');
  var m = feMoney(a.at, true);
  var cur = feIcon(FE_CUR[m.cur][0]);
  if (cur) { var g = document.createElement('img'); g.className = 'fe-slider-glow'; g.src = cur; g.alt = ''; pill.appendChild(g);
    var i = document.createElement('img'); i.className = 'fe-cur'; i.src = cur; i.alt = ''; pill.appendChild(i); }
  var range = UI.input({ type: 'range', min: 0, max: 1000, step: 1, ariaLabel: 'Price split' });
  var L = Math.log(1 + max);
  range.value = String(Math.round(Math.log(1 + a.at) / L * 1000));
  range.style.setProperty('--fe-fill', (range.value / 10) + '%');
  var val = UI.el('span', 'fe-slider-v', m.v + (m.cur === 'c' ? 'c' : m.cur === 'div' ? 'd' : 'm'));
  range.addEventListener('input', function () {
    var v = Math.expm1(this.value / 1000 * L);
    v = v < 1 ? Math.round(v * 100) / 100 : v < 10 ? Math.round(v * 10) / 10 : Math.round(v); // never "0c" for cheap tiers
    a.at = v;
    var mm = feMoney(v, true);
    val.textContent = mm.v + (mm.cur === 'c' ? 'c' : mm.cur === 'div' ? 'd' : 'm');
    this.style.setProperty('--fe-fill', (this.value / 10) + '%');
  });
  range.addEventListener('change', function () { a.msg = null; feRender(); });
  pill.appendChild(range);
  pill.appendChild(val);
  return pill;
}
function feDustSlider(a, dusts) {
  var lo = Math.min.apply(null, dusts.map(function (r) { return r.d; })), hi = Math.max.apply(null, dusts.map(function (r) { return r.d; }));
  if (a.dust == null) a.dust = lo;
  var pill = UI.el('div', 'fe-slider is-dust');
  pill.appendChild(UI.el('span', 'fe-dim fe-small', 'Dust'));
  var range = UI.input({ type: 'range', min: lo, max: hi, step: Math.max(1, Math.round((hi - lo) / 200)), value: a.dust, ariaLabel: 'Dust split' });
  function fmt(v) { return v >= 1e6 ? (Math.round(v / 1e5) / 10) + 'm' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(v); }
  var val = UI.el('span', 'fe-slider-v', fmt(a.dust));
  range.addEventListener('input', function () { a.dust = parseInt(this.value, 10); val.textContent = fmt(a.dust); });
  range.addEventListener('change', function () { a.msg = null; feRender(); });
  pill.appendChild(range);
  pill.appendChild(val);
  return pill;
}
function feAuditRow(r, zone, odd, unique, mode) {
  var row = UI.el('div', 'fe-arow ' + zone + (odd ? ' is-odd' : '') + (r.z === 'middle' ? ' is-mid' : ''));
  row.appendChild(feArt(feIcon(r.n), 22));
  var nm = UI.el('button', 'fe-arow-name', r.n);
  nm.type = 'button';
  nm.title = 'Look at ' + r.n + ' in the filter';
  nm.addEventListener('click', function () {
    if (unique) { var u = feUniquesFor(r.n)[0]; feLoadBase(r.n, u ? { unique: u.name, base: r.n } : {}); }
    else feLoadBase(r.n);
  });
  row.appendChild(nm);
  if (mode !== 'dust') row.appendChild(r.p ? fePriceChip(r.p, 'fe-price-row', true) : UI.el('span', 'fe-noprice', 'No price'));
  if (unique && mode !== 'price') row.appendChild(UI.el('span', 'fe-price fe-price-row', r.d ? (r.d >= 1000 ? Math.round(r.d / 1000) + 'k' : String(r.d)) + ' dust' : '–'));
  return row;
}
function feMoveBar(dir, names, targets, from, a) {
  var bar = UI.el('div', 'fe-mbar is-' + dir);
  var tab = UI.el('div', 'fe-mbar-tab');
  tab.appendChild(UI.el('span', null, 'Move the ' + names.length + ' item' + (names.length === 1 ? '' : 's') + ' ' + (dir === 'up' ? 'above' : 'below') + ' to'));
  var key = dir === 'up' ? 'upTo' : 'downTo';
  if (a[key] == null || !targets.some(function (t) { return t.index === a[key]; })) a[key] = targets[0].index;
  var sel = UI.select(targets.map(function (t) { return [String(t.index), t.label + (t.visibility === 'Hide' ? ' [HIDDEN]' : '')]; }), String(a[key]), {
    ariaLabel: 'Target tier', cls: 'fe-select fe-mbar-sel', onChange: function () { a[key] = parseInt(this.value, 10); } });
  sel.disabled = targets.length < 2;
  tab.appendChild(sel);
  var go = UI.el('button', 'fe-mbar-go', FE.busy ? 'Moving…' : 'Retier Items');
  go.type = 'button';
  go.title = names.join(', ');
  go.addEventListener('click', async function () {
    if (FE.busy) return;
    var to = FE.parsed.blocks[a[key]];
    var r = FilterEdit.moveBases(FE.text, null, names, from.index, a[key]);
    if (!r || !r.ok) { a.msg = (r && r.reason) || 'Move failed'; feRender(); return; }
    var label = feTierName(to);
    var ok = await feWrite(r.text, r.changes, 'Moved ' + names.length + ' items from ' + feTierName(from) + ' to ' + label);
    if (ok) { FE.view = 'audit'; FE.audit = { index: from.index, mode: a.mode, msg: 'Moved ' + names.length + ' items to ' + label }; feRender(); }
  });
  tab.appendChild(go);
  bar.appendChild(tab);
  return bar;
}
function feTierVisButton(b) {
  var hidden = b.visibility === 'Hide';
  var btn = UI.el('button', 'fe-tvis ' + (hidden ? 'fe-green' : 'fe-red'), (hidden ? '◉ Show Tier' : '◌ Hide Tier'));
  btn.type = 'button';
  btn.title = hidden ? 'Show this tier (saves now)' : 'Hide this tier (saves now)';
  btn.addEventListener('click', async function () {
    if (FE.busy) return;
    var r = FilterEdit.editBlock(FE.text, b.index, { visibility: hidden ? 'Show' : 'Hide' });
    if (!r || !r.ok) { UI.toast((r && r.reason) || 'Failed to save', 'danger'); return; }
    var a = FE.audit;
    var ok = await feWrite(r.text, r.changes, (hidden ? 'Showed ' : 'Hid ') + 'tier ' + feTierName(b));
    if (ok) { FE.view = 'audit'; FE.audit = a; feRender(); }
  });
  return btn;
}

// ---- history: session edits (undo the newest), checkpoints, recorded changes ------------------------------------------------
function feAgo(t) {
  var s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function feDescribeChange(c) {
  var t = c.tier || c.toTier || '';
  switch (c.kind) {
    case 'move-basetype': return 'Moved "' + c.base + '" to ' + FilterEdit.tierLabel(c.toTier) + ' (from ' + FilterEdit.tierLabel(c.fromTier) + ')';
    case 'add-basetype': return 'Added "' + c.base + '" to ' + FilterEdit.tierLabel(t);
    case 'remove-basetype': return 'Removed "' + c.base + '" from ' + FilterEdit.tierLabel(t);
    case 'set-visibility': return 'Set ' + c.type + ' / ' + FilterEdit.tierLabel(t) + ' to ' + c.visibility;
    case 'set-threshold': return 'Changed ' + c.condition + ' in ' + FilterEdit.tierLabel(t) + ' to ' + c.value;
    case 'set-action': return (c.values ? 'Changed ' : 'Removed ') + c.action + ' on ' + c.type + ' / ' + FilterEdit.tierLabel(t);
    default: return c.kind;
  }
}
function feHistoryView() {
  var api = feApi();
  var page = UI.el('div', 'fe-col');
  var c1 = feCard('fe-pad');
  c1.appendChild(UI.el('div', 'fe-hist-title', 'Session Edits'));
  if (!FE.undo.length) c1.appendChild(UI.el('p', 'fe-dim fe-center', 'No edits yet this session.'));
  FE.undo.slice().reverse().forEach(function (u, i) {
    var row = UI.el('div', 'fe-hist-row' + (i === 0 ? ' is-newest' : ''));
    row.appendChild(feArt(u.icon, 22));
    var t = UI.el('div', 'fe-hist-text');
    var line = UI.el('div', 'fe-ellipsis');
    line.appendChild(UI.el('strong', null, u.item + ': '));
    line.appendChild(document.createTextNode(u.desc));
    line.title = u.item + ': ' + u.desc;
    t.appendChild(line);
    t.appendChild(UI.el('div', 'fe-dim fe-tiny', feAgo(u.time)));
    row.appendChild(t);
    if (i === 0) row.appendChild(UI.el('button', 'fe-undo', FE.busy ? '...' : '↩ Undo'));
    else row.appendChild(UI.el('span', 'fe-dim fe-undo-ph', '-'));
    if (i === 0) row.lastChild.addEventListener('click', function () { if (!FE.busy) feUndo().then(function () { FE.view = 'history'; feRender(); }); });
    c1.appendChild(row);
  });
  page.appendChild(c1);
  var c2 = feCard('fe-pad');
  var head = UI.el('div', 'fe-row');
  head.appendChild(UI.el('div', 'fe-hist-title', 'Filter Versions'));
  head.appendChild(UI.button('primary', { size: 'sm', label: 'Create Checkpoint', onClick: async function () {
    var r = await api.filter_checkpoint(FE.name, 'checkpoint from the filter editor');
    UI.toast(r && r.ok ? 'Checkpoint made' : 'Failed to create checkpoint', r && r.ok ? 'success' : 'danger');
    FE.cps = null;
    feRender();
  } }));
  c2.appendChild(head);
  var holder = UI.el('div');
  c2.appendChild(holder);
  if (!FE.cps || FE.cps.name !== FE.name) {
    holder.appendChild(UI.el('p', 'fe-dim', 'Loading…'));
    Promise.resolve(api.filter_checkpoints(FE.name)).then(function (r) {
      FE.cps = { name: FE.name, list: r && r.ok ? r.checkpoints || [] : [] };
      if (FE.view === 'history') feRender();
    });
  } else {
    if (!FE.cps.list.length) holder.appendChild(UI.el('p', 'fe-dim fe-center', 'No versions saved yet. One is made before every save.'));
    FE.cps.list.slice(0, 50).forEach(function (cp) {
      var row = UI.el('div', 'fe-hist-row');
      row.appendChild(UI.el('span', 'fe-dim', '💾'));
      var t = UI.el('div', 'fe-hist-text');
      t.appendChild(UI.el('div', 'fe-ellipsis', (cp.label || 'Auto-save').replace(/^before: /, 'Before: ')));
      t.appendChild(UI.el('div', 'fe-dim fe-tiny', cp.time ? new Date(cp.time * 1000).toLocaleString() : cp.id));
      row.appendChild(t);
      row.appendChild(UI.button('ghost', { size: 'sm', label: 'Restore', onClick: async function () {
        if (!await UI.confirmDanger('Restore this version?', 'The filter goes back to this version. The current file is kept as a version first.', 'Restore')) return;
        var r = await api.filter_restore(FE.name, cp.id);
        if (!r || !r.ok) { UI.toast('Failed to restore: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
        FE.undo = [];
        FE.cps = null;
        await feLoadFile(FE.name);
        feRematch();
        await feReloadInGame();
        UI.toast('Restored', 'success');
        feRender();
      } }));
      holder.appendChild(row);
    });
  }
  page.appendChild(c2);
  var edits = feEdits();
  var c3 = feCard('fe-pad');
  var d = UI.el('details', 'fe-hist-changes');
  d.appendChild(UI.el('summary', 'fe-hist-title', 'Filter Changes (' + edits.length + ')'));
  d.appendChild(UI.el('p', 'fe-dim fe-small', 'Recorded edits: when your online filter gets a new version, these are applied to it again.'));
  edits.forEach(function (c) { var r = UI.el('div', 'fe-hist-row'); r.appendChild(UI.el('span', 'fe-dim', '✎')); r.appendChild(UI.el('div', 'fe-hist-text fe-ellipsis', feDescribeChange(c))); d.appendChild(r); });
  c3.appendChild(d);
  page.appendChild(c3);
  return page;
}

document.addEventListener('keydown', function (e) {
  if (!FE.on || e.defaultPrevented) return;
  if (e.key === 'Escape' && (FE.dd || document.getElementById('fe-pop-layer'))) {
    e.preventDefault();
    FE.dd = false;
    feCloseLayers();
    feRender();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target || {}).tagName || '')) {
    e.preventDefault();
    if (FE.undo.length && !FE.busy) feUndo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    feSave();
  }
}, true);
// ==== end loot filter editor ============================================================
