/* js/app/33-guides.js — strategy guides inside the mechanic cheat sheets. The js/app/ files are one
   program split by feature: they load in order (index.html) and share their top-level names. */
'use strict';

// ==== mechanic guides ===============================================================
// Data: data/guides.js (tools/make_guides.py, from a verified community research run): per cheat
// sheet id a summary, how to run it, strategies, dangers, what to sell, rough profit, changes by
// patch, tables and the written sources (readMore) every line cites by index. mechanicContent()
// (24-cheatsheets.js) hands a sheet that has a guide to guideContent():
// - in the app (Tools → Cheat sheets): the whole guide with a jump bar to each section, a stage
//   filter, collapsible sections, [n] cite markers that jump to Read more, GGG icons for currency /
//   scarab names; the sheet's wiki tables follow under "Reference data"
// - in the game overlay (?sheet=1): click-only and short, two tabs: "Quick card" (the card and the
//   strategy names folded into one line) and "Reference" (the same tables; Blight's anoint helper)
// Like the sheets, the guides update from the app's server between releases (guides_data in gui.py).
var GUIDE_STAGE_KEY = 'pobtf-guide-stage';
var GUIDE_STAGES = [['all', 'All'], ['league-start', 'League start'], ['mid', 'Mid'], ['late', 'Late'], ['ssf', 'SSF']];
var GUIDE_STAGE_NAME = { 'league-start': 'League start', mid: 'Mid', late: 'Late', ssf: 'SSF', all: 'Any stage' };
var GUIDE_CDN = 'https://web.poecdn.com'; // + the icon path ("/gen/image/..."): the art cache (08-cards.js) keeps a copy
// open at first; your clicks are kept while the app runs. Strategies start folded: its cards are the
// longest block (18 for the Atlas) and pushed Dangers, What to sell and Reference data screens down;
// its header shows the count and the jump bar opens it in one click.
var GUIDE_OPEN = { extra: true, howTo: true };

function guideData() {
  var d = window.POE_GUIDES;
  return d && d.guides && typeof d.guides === 'object' ? d : null;
}
function guideFor(id) {
  var d = guideData();
  return d && id && Object.prototype.hasOwnProperty.call(d.guides, id) ? d.guides[id] : null;
}

// guides for mechanics the wiki sheets don't cover yet (Mercenaries) bring a sheet entry of their own
function guidesPatchSheets() {
  var d = guideData(), s = window.POE_CHEATSHEETS;
  if (!d || !s || !Array.isArray(s.mechanics) || !Array.isArray(d.sheets)) return;
  d.sheets.forEach(function (x) {
    if (!x || typeof x.id !== 'string' || !guideFor(x.id)) return;
    if (s.mechanics.some(function (m) { return m.id === x.id; })) return;
    s.mechanics.push({ id: x.id, title: x.title || guideFor(x.id).title, group: x.group || 'League mechanics',
      source: 'Mechanic guide (community research)', patch: d.asOf, match: { areaIds: [], areaNames: [] }, sections: [] });
  });
}
guidesPatchSheets();

// a newer copy from the app's server replaces the shipped one (like sheetSync)
var guideSynced = false;
async function guideSync(onNew) {
  if (guideSynced || !isGui() || !window.pywebview.api.guides_data) return;
  guideSynced = true;
  try {
    var r = await window.pywebview.api.guides_data();
    var mine = guideData();
    if (r && r.ok && r.data && r.data.guides && typeof r.data.guides === 'object' &&
        r.data.version > ((mine && mine.version) || 0)) {
      window.POE_GUIDES = r.data;
      guidesPatchSheets();
      if (onNew) onNew();
    }
  } catch (e) { /* keep the shipped copy */ }
}

// ---- stage filter -------------------------------------------------------------------------
function guideStage() {
  var v = null;
  try { v = localStorage.getItem(GUIDE_STAGE_KEY); } catch (e) { /* none */ }
  return GUIDE_STAGES.some(function (s) { return s[0] === v; }) ? v : 'all';
}
// a line shows for the picked stage when it's tagged for it (or for every stage); untagged lines always do
function guideStageOk(tags, stage) {
  return stage === 'all' || !tags || !tags.length || tags.indexOf('all') !== -1 || tags.indexOf(stage) !== -1;
}
function guideStageTags(tags) {
  var box = UI.el('span', 'guide-stages');
  (tags || []).forEach(function (t) {
    if (t !== 'all' && GUIDE_STAGE_NAME[t]) box.appendChild(UI.el('span', 'guide-stage is-' + t, GUIDE_STAGE_NAME[t]));
  });
  return box.childNodes.length ? box : null;
}
function guideTagged(el, tags) {
  if (tags && tags.length) el.dataset.stages = tags.join(' ');
  return el;
}

// ---- text: currency / scarab icons and cite markers ------------------------------------------
var guideIconRe = null, guideIconFor = null;
function guideIconPattern() {
  var d = guideData(), icons = (d && d.icons) || {};
  if (guideIconFor === icons) return guideIconRe;
  guideIconFor = icons;
  var names = Object.keys(icons).filter(function (n) { return typeof icons[n] === 'string' && icons[n].charAt(0) === '/'; })
    .sort(function (a, b) { return b.length - a.length; });
  guideIconRe = names.length ? new RegExp('(?<![A-Za-z\'])(' + names.map(function (n) {
    return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|') + ')(?=s?(?![A-Za-z]))', 'g') : null;
  return guideIconRe;
}
function guideIcon(name) {
  var d = guideData(), path = d && d.icons && d.icons[name];
  if (!path) return null;
  var img = UI.el('img', 'guide-icon');
  img.alt = '';
  img.title = name;
  img.decoding = 'async';
  // offline and not cached yet: no broken-image box (the art cache may still swap in a local copy)
  img.addEventListener('error', function () { img.classList.add('is-missing'); });
  img.addEventListener('load', function () { img.classList.remove('is-missing'); });
  img.src = GUIDE_CDN + path;
  return img;
}
// plain text with an icon before each currency / scarab name (the first time it appears in the line)
function guideText(text, cls) {
  var span = UI.el('span', cls || null);
  var s = String(text == null ? '' : text), re = guideIconPattern(), at = 0, seen = {}, m;
  if (re) {
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      if (seen[m[1]]) continue;
      seen[m[1]] = 1;
      var img = guideIcon(m[1]);
      if (!img) continue;
      if (m.index > at) span.appendChild(document.createTextNode(s.slice(at, m.index)));
      span.appendChild(img);
      span.appendChild(document.createTextNode(m[1]));
      at = m.index + m[1].length;
    }
  }
  if (at < s.length) span.appendChild(document.createTextNode(s.slice(at)));
  return span;
}
// [1] [4]: each jumps to that source under Read more
function guideCites(cites, ctx) {
  var box = UI.el('span', 'guide-cites');
  (cites || []).forEach(function (i) {
    var src = ctx.sources[i];
    if (!src) return;
    var b = UI.el('button', 'guide-cite', '[' + (i + 1) + ']');
    b.type = 'button';
    b.title = (src.publisher ? src.publisher + ': ' : '') + src.title;
    b.setAttribute('aria-label', 'Source ' + (i + 1) + ': ' + b.title);
    b.addEventListener('click', function () { guideShowSource(ctx.root, i); });
    box.appendChild(b);
  });
  return box.childNodes.length ? box : null;
}
function guideShowSource(root, i) {
  var sec = root.querySelector('.guide-sec[data-key="readMore"]');
  var li = root.querySelector('.guide-src[data-src="' + i + '"]');
  if (!sec || !li) return;
  sec.open = true;
  li.scrollIntoView({ block: 'center', behavior: PREFS.motion ? 'auto' : 'smooth' });
  li.classList.remove('is-flash');
  void li.offsetWidth; // restart the highlight
  li.classList.add('is-flash');
  var link = li.querySelector('.guide-link');
  if (link) link.focus({ preventScroll: true });
}
function guideLine(tag, item, ctx, cls) {
  var li = guideTagged(UI.el(tag, 'guide-item' + (cls ? ' ' + cls : '')), item.stage);
  li.appendChild(guideText(item.text, 'guide-line-text'));
  var tags = guideStageTags(item.stage);
  if (tags) li.appendChild(tags);
  var c = guideCites(item.cite, ctx);
  if (c) li.appendChild(c);
  return li;
}

// ---- dates and patches ---------------------------------------------------------------------
function guideDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
}
function guideNextPatch(p) {
  var m = /^(\d+)\.(\d+)$/.exec(p || '');
  return m ? m[1] + '.' + (parseInt(m[2], 10) + 1) : 'the next patch';
}

// ---- the guide in the app -------------------------------------------------------------------
function guideContent(m, opts) {
  opts = opts || {};
  var g = guideFor(m.id);
  if (SHEET_OV) return guideOverlay(m, g, opts);
  var d = guideData() || {};
  var root = UI.el('div', 'sheet-content guide');
  var ctx = { root: root, sources: g.readMore || [], guide: g };
  var asOf = g.asOf || d.asOf || '';

  var note = UI.el('div', 'guide-asof');
  note.setAttribute('role', 'note');
  note.appendChild(UI.el('span', 'guide-asof-icon', 'ⓘ'));
  var nt = UI.el('span', 'guide-asof-text');
  nt.appendChild(UI.el('b', null, 'Information as of ' + asOf + (d.checked ? ' — checked ' + guideDate(d.checked) : '') +
    '; may change with ' + guideNextPatch(asOf) + '.'));
  nt.appendChild(document.createTextNode(' A summary of community guides: each line\'s [n] names its source under Read more.'));
  note.appendChild(nt);
  root.appendChild(note);
  // the jump bar: filled at the end, once every section is drawn
  var jump = UI.el('nav', 'guide-jump');
  jump.setAttribute('aria-label', 'Jump to a section of this guide');
  root.appendChild(jump);

  var bar = UI.el('div', 'guide-bar');
  bar.appendChild(UI.el('span', 'guide-bar-label', 'Stage'));
  var seg = UI.segmented(GUIDE_STAGES, guideStage(), { ariaLabel: 'Show the lines for this stage of the league',
    titles: { all: 'Every line', 'league-start': 'Fresh league, little currency', mid: 'Mapping, some currency',
      late: 'Juiced maps, big investment', ssf: 'Solo self-found: no trading' },
    onChange: function (v) { persist(GUIDE_STAGE_KEY, v); guideApplyStage(root, v); } });
  seg.classList.add('guide-stage-seg');
  bar.appendChild(seg);
  var hidden = UI.el('span', 'guide-hidden-count');
  hidden.setAttribute('aria-live', 'polite');
  bar.appendChild(hidden);
  root.appendChild(bar);

  if (g.summary) root.appendChild(guideText(g.summary, 'guide-summary'));

  function section(key, title, body, count) {
    var det = UI.el('details', 'guide-sec');
    det.dataset.key = key;
    det.open = !!GUIDE_OPEN[key];
    var sum = UI.el('summary', 'guide-sec-head');
    sum.appendChild(UI.el('span', 'guide-sec-title', title));
    if (count !== null) sum.appendChild(UI.chip(String(count), 'neutral', 'guide-sec-count'));
    det.appendChild(sum);
    var inner = UI.el('div', 'guide-sec-body');
    inner.appendChild(body);
    inner.appendChild(UI.el('div', 'guide-none', 'Nothing here for this stage.'));
    det.appendChild(inner);
    det.addEventListener('toggle', function () { GUIDE_OPEN[key] = det.open; });
    root.appendChild(det);
    return det;
  }
  function list(tag, items, cls) {
    var l = UI.el(tag, 'guide-list' + (cls ? ' ' + cls : ''));
    items.forEach(function (it) { l.appendChild(guideLine('li', it, ctx)); });
    return l;
  }

  // a mechanic's own tool (window.__mechanicExtras[id](container), e.g. the Syndicate planner in
  // 34-syndicate.js): first, open; app only (it has inputs, the overlay has none)
  var extra = window.__mechanicExtras && window.__mechanicExtras[m.id];
  if (typeof extra === 'function') {
    var host = UI.el('div', 'guide-extra');
    try { extra(host); } catch (e) { host.appendChild(UI.el('div', 'sheet-empty', 'This planner could not load.')); }
    section('extra', extra.guideTitle || 'Planner', host, null);
  }

  if ((g.howTo || []).length) section('howTo', 'How to run it', list('ol', g.howTo, 'is-steps'), g.howTo.length);

  if ((g.strategies || []).length) {
    var grid = UI.el('div', 'guide-strats');
    g.strategies.forEach(function (s) {
      var card = guideTagged(UI.el('article', 'guide-item guide-strat'), s.stage);
      var head = UI.el('div', 'guide-strat-head');
      head.appendChild(UI.el('h4', 'guide-strat-name', s.name));
      var tags = guideStageTags(s.stage);
      if (tags) head.appendChild(tags);
      card.appendChild(head);
      if (s.investment) {
        var inv = UI.el('div', 'guide-strat-inv');
        inv.appendChild(UI.el('span', 'guide-k', 'Investment'));
        inv.appendChild(guideText(s.investment));
        card.appendChild(inv);
      }
      var steps = UI.el('ol', 'guide-strat-steps');
      (s.steps || []).forEach(function (t) { steps.appendChild(UI.el('li', null)).appendChild(guideText(t)); });
      card.appendChild(steps);
      if ((s.atlasPassives || []).length) {
        var ap = UI.el('div', 'guide-strat-row');
        ap.appendChild(UI.el('span', 'guide-k', 'Atlas passives'));
        var apl = UI.el('span', 'guide-pills');
        s.atlasPassives.forEach(function (t) { apl.appendChild(UI.el('span', 'guide-pill', t)); });
        ap.appendChild(apl);
        card.appendChild(ap);
      }
      if ((s.scarabs || []).length) {
        var sc = UI.el('div', 'guide-strat-row');
        sc.appendChild(UI.el('span', 'guide-k', 'Scarabs'));
        var scl = UI.el('span', 'guide-pills');
        s.scarabs.forEach(function (t) { scl.appendChild(guideText(t, 'guide-pill is-scarab')); });
        sc.appendChild(scl);
        card.appendChild(sc);
      }
      var c = guideCites(s.cite, ctx);
      if (c) { var foot = UI.el('div', 'guide-strat-foot'); foot.appendChild(UI.el('span', 'guide-k', 'Sources')); foot.appendChild(c); card.appendChild(foot); }
      grid.appendChild(card);
    });
    section('strategies', 'Strategies', grid, g.strategies.length);
  }

  if ((g.dangers || []).length) section('dangers', 'Dangers', list('ul', g.dangers, 'is-dangers'), g.dangers.length);
  if ((g.sell || []).length) section('sell', 'What to sell', list('ul', g.sell, 'is-sell'), g.sell.length);

  if ((g.profit || []).length) {
    var pbox = UI.el('div', 'guide-profit');
    pbox.appendChild(UI.el('p', 'guide-note', 'Rough community estimates: who said it and when is under each line. ' +
      'Prices move every day, so check the market before you plan around a number.'));
    var pl = UI.el('ul', 'guide-list');
    g.profit.forEach(function (p) {
      var li = UI.el('li', 'guide-item');
      li.appendChild(guideText(p.text, 'guide-line-text'));
      var meta = [p.who, p.date].filter(Boolean).join(' · ');
      if (meta) li.appendChild(UI.el('span', 'guide-meta', meta));
      var c = guideCites(p.cite, ctx);
      if (c) li.appendChild(c);
      pl.appendChild(li);
    });
    pbox.appendChild(pl);
    section('profit', 'Profit', pbox, g.profit.length);
  }

  if ((g.changes || []).length) {
    var cbox = UI.el('div', 'guide-changes');
    var byPatch = [], at = {};
    g.changes.forEach(function (c) {
      if (!(c.patch in at)) { at[c.patch] = byPatch.length; byPatch.push({ patch: c.patch, items: [] }); }
      byPatch[at[c.patch]].items.push(c);
    });
    byPatch.forEach(function (grp) {
      var row = UI.el('div', 'guide-patch');
      row.appendChild(UI.el('span', 'guide-patch-tag', grp.patch));
      var ul = UI.el('ul', 'guide-list');
      grp.items.forEach(function (c) {
        var li = UI.el('li', 'guide-item');
        li.appendChild(guideText(c.text, 'guide-line-text'));
        var ct = guideCites(c.cite, ctx);
        if (ct) li.appendChild(ct);
        ul.appendChild(li);
      });
      row.appendChild(ul);
      cbox.appendChild(row);
    });
    section('changes', 'Changes by patch', cbox, g.changes.length);
  }

  if ((g.tables || []).length) {
    var tbox = UI.el('div', 'guide-tables');
    g.tables.forEach(function (t) {
      var wrap = UI.el('div', 'guide-table-wrap');
      var cap = UI.el('div', 'guide-table-title');
      cap.appendChild(UI.el('span', null, t.title));
      var ct = guideCites(t.cite, ctx);
      if (ct) cap.appendChild(ct);
      wrap.appendChild(cap);
      var scroll = UI.el('div', 'guide-table-scroll');
      var tb = UI.el('table', 'guide-table');
      var hr = UI.el('tr');
      t.columns.forEach(function (c) { hr.appendChild(UI.el('th', null, c)); });
      tb.appendChild(UI.el('thead')).appendChild(hr);
      var body = UI.el('tbody');
      t.rows.forEach(function (r) {
        var tr = UI.el('tr');
        r.forEach(function (cell) { tr.appendChild(UI.el('td', null, cell)); });
        body.appendChild(tr);
      });
      tb.appendChild(body);
      scroll.appendChild(tb);
      wrap.appendChild(scroll);
      tbox.appendChild(wrap);
    });
    section('tables', 'Tables', tbox, g.tables.length);
  }

  if (ctx.sources.length) {
    var ol = UI.el('ol', 'guide-sources');
    ctx.sources.forEach(function (src, i) {
      var li = UI.el('li', 'guide-src');
      li.dataset.src = String(i);
      li.appendChild(UI.el('span', 'guide-src-n', '[' + (i + 1) + ']'));
      var main = UI.el('span', 'guide-src-main');
      var a = UI.el('button', 'guide-link', src.title);
      a.type = 'button';
      var host = '';
      try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep */ }
      a.title = 'Opens ' + (host || 'the page') + ' in your browser';
      a.addEventListener('click', function () { openUrl(src.url); });
      main.appendChild(a);
      var meta = [src.publisher, src.date, src.patch ? 'patch ' + src.patch : ''].filter(Boolean).join(' · ');
      if (meta) main.appendChild(UI.el('span', 'guide-meta', meta));
      li.appendChild(main);
      ol.appendChild(li);
    });
    section('readMore', 'Read more', ol, ctx.sources.length);
  }

  // the sheet's wiki tables (and Blight's anoint helper) as before
  if ((m.sections || []).length || m.id === 'blight') {
    var ref = UI.el('div', 'guide-ref');
    var rh = UI.el('div', 'guide-ref-head');
    rh.appendChild(UI.el('h4', 'guide-ref-title', 'Reference data'));
    ref.appendChild(rh);
    ref.appendChild(mechanicContent(m, Object.assign({}, opts, { plain: true })));
    root.appendChild(ref);
  }
  guideFillJump(jump, root);
  guideApplyStage(root, guideStage());
  return root;
}

// the jump bar: a link per section (it opens a folded one) and one to Reference data (its filter
// box, or Blight's anoint search, gets the focus, so a player can type a fossil or anoint name
// straight away)
var GUIDE_JUMP_LABEL = { changes: 'Changes' };
function guideJumpTo(root, target, focusEl) {
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: PREFS.motion ? 'auto' : 'smooth' });
  if (focusEl) focusEl.focus({ preventScroll: true });
}
function guideFillJump(jump, root) {
  function link(label, cls, onClick) {
    var b = UI.el('button', 'guide-jump-link' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    jump.appendChild(b);
    return b;
  }
  root.querySelectorAll('.guide-sec').forEach(function (det) {
    var key = det.dataset.key;
    var title = det.querySelector('.guide-sec-title');
    var b = link(GUIDE_JUMP_LABEL[key] || (title ? title.textContent : key), null, function () {
      det.open = true;
      guideJumpTo(root, det, det.querySelector('.guide-sec-head'));
    });
    b.dataset.key = key;
    b.title = 'Go to ' + (title ? title.textContent : key);
  });
  var ref = root.querySelector('.guide-ref');
  if (ref) {
    var rb = link('Reference data', 'is-ref', function () {
      var head = ref.querySelector('.guide-ref-title');
      head.tabIndex = -1;
      guideJumpTo(root, ref, ref.querySelector('.guide-ref-head .sheet-filter') ||
        ref.querySelector('input.anoint-search, .anoint-search input') || head);
    });
    rb.dataset.key = 'ref';
    rb.title = 'Go to the wiki tables' + (ref.querySelector('.anoint') ? ' and the anoint helper' : '') + ' under the guide';
  }
  if (!jump.childNodes.length) jump.remove();
  else jump.insertBefore(UI.el('span', 'guide-bar-label', 'Jump to'), jump.firstChild);
}

// hide what isn't tagged for the stage; empty sections say so; the counts follow
function guideApplyStage(root, stage) {
  root.dataset.stage = stage;
  var hid = 0;
  root.querySelectorAll('[data-stages]').forEach(function (el) {
    var ok = guideStageOk(el.dataset.stages.split(' '), stage);
    el.hidden = !ok;
    if (!ok) hid++;
  });
  root.querySelectorAll('.guide-sec').forEach(function (sec) {
    var items = sec.querySelectorAll('.guide-sec-body .guide-item');
    var shown = 0;
    items.forEach(function (it) { if (!it.hidden) shown++; });
    var count = sec.querySelector('.guide-sec-count');
    // (tables and sources aren't lines: their count stays as drawn)
    if (count && items.length) count.textContent = shown === items.length ? String(items.length) : shown + ' of ' + items.length;
    sec.classList.toggle('is-empty', items.length > 0 && shown === 0);
  });
  var hc = root.querySelector('.guide-hidden-count');
  if (hc) hc.textContent = hid ? hid + ' line' + (hid === 1 ? '' : 's') + ' for other stages hidden' : '';
}

// ---- the guide over the game: short, click-only, nothing to type --------------------------------
// Two tabs: "Quick card" (the card, then the strategy names folded into one line) and "Reference"
// (the sheet's wiki tables; for Blight the anoint helper first). The tab you pick is remembered per
// sheet, so a player who opens Blight for anoints lands on them next time. Every change re-fits the
// overlay window (fitSheetOverlay).
var GUIDE_OV_TAB_KEY = 'pobtf-guide-ov-tab';
var guideOvStratsOpen = {}; // the strategy names, unfolded, per sheet (while the overlay runs)
function guideOvTabs() {
  var v = null;
  try { v = JSON.parse(localStorage.getItem(GUIDE_OV_TAB_KEY) || 'null'); } catch (e) { /* none */ }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function guideOvTab(id) { return guideOvTabs()[id] === 'ref' ? 'ref' : 'quick'; }
function guideOvSetTab(id, tab) {
  var all = guideOvTabs();
  all[id] = tab;
  persist(GUIDE_OV_TAB_KEY, JSON.stringify(all));
}
function guideOvFit() { if (typeof fitSheetOverlay === 'function') fitSheetOverlay(); }

function guideOverlay(m, g, opts) {
  var box = UI.el('div', 'sheet-content guide-ov');
  var hasRef = (m.sections || []).length > 0 || m.id === 'blight';
  var quick = UI.el('div', 'guide-ov-pane');
  quick.dataset.tab = 'quick';
  var ref = null;
  if (hasRef) {
    ref = UI.el('div', 'guide-ov-pane guide-ov-ref');
    ref.dataset.tab = 'ref';
    var tab = guideOvTab(m.id);
    var tabs = UI.segmented([['quick', 'Quick card'], ['ref', 'Reference']], tab, {
      ariaLabel: 'Show the quick card or the reference tables',
      titles: { quick: 'The quick card and the strategy names',
        ref: m.id === 'blight' ? 'The anoint helper and the wiki tables' : 'The wiki tables' },
      onChange: function (v) {
        guideOvSetTab(m.id, v);
        quick.hidden = v !== 'quick';
        ref.hidden = v !== 'ref';
        guideOvFit();
      } });
    tabs.classList.add('guide-ov-tabs');
    box.appendChild(tabs);
    quick.hidden = tab !== 'quick';
    ref.hidden = tab !== 'ref';
  }
  box.appendChild(quick);
  if (ref) {
    ref.appendChild(mechanicContent(m, Object.assign({}, opts, { plain: true })));
    box.appendChild(ref);
  }

  var qs = UI.el('div', 'sheet-sec');
  qs.appendChild(UI.el('div', 'sheet-sec-title', 'Quick card'));
  var ql = UI.el('ul', 'sheet-list guide-quick');
  (g.quickCard || []).forEach(function (line) {
    // "[mid/late] text": the bracket is the line's stage
    var mt = /^\[([a-z\-\/ ]+)\]\s*(.*)$/i.exec(line), tags = mt ? mt[1].split('/').map(function (t) { return t.trim(); }) : null;
    var li = UI.el('li', 'sheet-li');
    li.appendChild(UI.el('span', 'guide-quick-text', mt ? mt[2] : line));
    var tg = guideStageTags(tags);
    if (tg) li.appendChild(tg);
    ql.appendChild(li);
  });
  qs.appendChild(ql);
  quick.appendChild(qs);
  // the strategy names: one folded line ("Strategies · 8 ▸"); a click lists them
  if ((g.strategies || []).length) {
    var ss = UI.el('div', 'sheet-sec guide-ov-strat-sec');
    var open = !!guideOvStratsOpen[m.id];
    var tog = UI.el('button', 'guide-ov-toggle');
    tog.type = 'button';
    tog.appendChild(UI.el('span', 'guide-ov-toggle-label', 'Strategies'));
    tog.appendChild(UI.el('span', 'guide-ov-toggle-n', String(g.strategies.length)));
    var arrow = UI.el('span', 'guide-ov-toggle-arrow', open ? '▾' : '▸');
    tog.appendChild(arrow);
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
    tog.title = 'Show or hide the ' + g.strategies.length + ' strategy names';
    var sl = UI.el('ul', 'sheet-list guide-ov-strats');
    sl.hidden = !open;
    g.strategies.forEach(function (s) {
      var li = UI.el('li', 'sheet-li');
      li.appendChild(UI.el('span', 'guide-quick-text', s.name));
      var tg = guideStageTags(s.stage);
      if (tg) li.appendChild(tg);
      sl.appendChild(li);
    });
    tog.addEventListener('click', function () {
      var on = sl.hidden;
      guideOvStratsOpen[m.id] = on;
      sl.hidden = !on;
      arrow.textContent = on ? '▾' : '▸';
      tog.setAttribute('aria-expanded', on ? 'true' : 'false');
      guideOvFit();
    });
    ss.appendChild(tog);
    ss.appendChild(sl);
    quick.appendChild(ss);
  }
  quick.appendChild(UI.el('div', 'guide-ov-more', 'More in the app: Tools → Cheat sheets → ' + m.title +
    ' (steps, dangers, what to sell, sources).'));
  return box;
}
// ==== end mechanic guides ===========================================================
