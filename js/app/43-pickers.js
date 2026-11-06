/* js/app/43-pickers.js — pick-and-check helpers inside the mechanic sheets: the Eldritch altar
   picker, the Ultimatum / Sanctum / Expedition modifier checkers, and the Incursion temple room
   planner. Every rating and tip is verified research shipped in the guides payload
   (mechToolData(), 40-mechtools.js); this file only filters it by your build and adds up what you
   picked. The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ==== the checker: mark what you see, get a verdict =======================================
// cfg = { id, entries: [{name, rating, dangerousFor, why, cite, group}], groups: [[id, label]],
//         noun: 'modifier', verdict: {deadly, caution, safe}, empty }
// A row is a toggle ("I see this one"); the verdict sums up the marked rows for your build.
// The marks last while the app runs (an encounter is short); the build tags are remembered.
var PICK_SEEN = {};
var PICK_VIEW = {}; // each checker's list filter, kept while the app runs (a sheet redraw keeps it)

// how a rating reads for your build: a mod rated deadly only for builds you didn't tick shows as
// "deadly for other builds" (caution); no ticks = the ratings as researched
// (a mod rated safe overall that the research says hurts what your build uses reads as caution, so
// the row, the filters and the verdict agree)
function pickEffective(e, tags) {
  var d = e.dangerousFor || [], r = e.rating;
  var hits = mechHitsBuild(d, tags) && !!tags.length;
  if (r === 'safe' && hits && d.indexOf('all') === -1) return { rating: 'caution', hits: true, other: false };
  if (!tags.length || r !== 'deadly' || hits || !d.length) return { rating: r, hits: hits, other: false };
  return { rating: 'caution', hits: false, other: true };
}

function pickChecker(host, ctx, cfg) {
  var seen = PICK_SEEN[cfg.id] = PICK_SEEN[cfg.id] || {};
  var state = PICK_VIEW[cfg.id + (ctx.overlay ? ':ov' : '')] = PICK_VIEW[cfg.id + (ctx.overlay ? ':ov' : '')] || { q: '', filter: 'all' };
  if (ctx.overlay) state.q = '';
  var root = UI.el('div', 'pick');

  if (!cfg.entries.length) {
    root.appendChild(UI.el('div', 'mech-empty', cfg.empty || 'No verified ratings for this yet.'));
    host.appendChild(root);
    return;
  }
  var verdict = UI.el('div', 'pick-verdict');
  verdict.setAttribute('role', 'status');
  verdict.setAttribute('aria-live', 'polite');
  root.appendChild(mechBuildPicker(function () { draw(); }));

  var bar = UI.el('div', 'pick-bar');
  var seg = UI.segmented([['all', 'All'], ['deadly', 'Run-ending'], ['mine', 'Hits my build'], ['seen', 'Marked']], state.filter, {
    ariaLabel: 'Which ' + cfg.noun + 's to list',
    titles: { all: 'Every ' + cfg.noun, deadly: 'Only the run-ending ones (for your build)',
      mine: 'Only the ones that hit what your build uses', seen: 'Only the ones you marked' },
    onChange: function (v) { state.filter = v; draw(); } });
  bar.appendChild(seg);
  if (!ctx.overlay) {
    var search = mechSearch('Find a ' + cfg.noun, function (q) { state.q = q; draw(); });
    search.value = state.q;
    bar.appendChild(search);
  }
  var clear = UI.button('ghost', { label: 'Clear marks', size: 'sm', title: 'Unmark every ' + cfg.noun,
    onClick: function () { Object.keys(seen).forEach(function (k) { delete seen[k]; }); draw(); } });
  bar.appendChild(clear);
  root.appendChild(bar);
  root.appendChild(verdict);
  var list = UI.el('div', 'pick-list');
  root.appendChild(list);
  host.appendChild(root);

  function draw() {
    var tags = mechBuildTags();
    list.textContent = '';
    var groups = cfg.groups || [[null, null]];
    var shown = 0;
    groups.forEach(function (g) {
      var rows = cfg.entries.filter(function (e) { return g[0] === null || e.group === g[0]; });
      var box = UI.el('div', 'pick-group');
      if (g[1]) box.appendChild(UI.el('div', 'pick-group-title', g[1]));
      var n = 0;
      rows.forEach(function (e) {
        var eff = pickEffective(e, tags);
        if (state.filter === 'deadly' && eff.rating !== 'deadly') return;
        if (state.filter === 'mine' && !eff.hits) return;
        if (state.filter === 'seen' && !seen[e.name]) return;
        if (!mechMatches(e.name + ' ' + (e.why || ''), state.q)) return;
        box.appendChild(pickRow(e, eff, !!seen[e.name], ctx, function () {
          if (seen[e.name]) delete seen[e.name]; else seen[e.name] = 1;
          draw();
        }));
        n++;
      });
      if (n) { list.appendChild(box); shown += n; }
    });
    if (!shown) list.appendChild(UI.el('div', 'mech-empty', 'Nothing matches.'));
    drawVerdict(tags);
    clear.disabled = !Object.keys(seen).length;
    if (ctx.onChange) ctx.onChange();
  }

  function drawVerdict(tags) {
    verdict.textContent = '';
    var marked = cfg.entries.filter(function (e) { return seen[e.name]; });
    if (!marked.length) {
      verdict.className = 'pick-verdict is-idle';
      verdict.appendChild(UI.el('span', null, 'Click the ' + cfg.noun + 's you see to check them' +
        (tags.length ? ' against your build.' : '. Tick what your build uses for a sharper answer.')));
      return;
    }
    var effs = marked.map(function (e) { return { e: e, eff: pickEffective(e, tags) }; });
    var worst = effs.some(function (x) { return x.eff.rating === 'deadly'; }) ? 'deadly'
      : effs.some(function (x) { return x.eff.rating === 'caution'; }) ? 'caution' : 'safe';
    verdict.className = 'pick-verdict is-' + worst;
    verdict.appendChild(mechRating(worst));
    var bad = effs.filter(function (x) { return x.eff.rating === worst && worst !== 'safe'; })
      .map(function (x) { return x.e.name; });
    verdict.appendChild(UI.el('span', 'pick-verdict-text', cfg.verdict[worst] + (bad.length ? ': ' + bad.join(', ') : '') + '.'));
  }
  draw();
}

function pickRow(e, eff, on, ctx, onToggle) {
  var row = UI.el('div', 'pick-row is-' + eff.rating + (on ? ' is-seen' : ''));
  var b = UI.el('button', 'pick-toggle');
  b.type = 'button';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? 'Unmark ' + e.name : 'Mark ' + e.name + ' as one you see';
  b.appendChild(UI.el('span', 'pick-check', on ? '✓' : ''));
  b.appendChild(UI.el('span', 'pick-name', e.name));
  b.addEventListener('click', onToggle);
  row.appendChild(b);
  var chips = UI.el('span', 'pick-chips');
  chips.appendChild(mechRating(eff.rating, eff.other ? 'Deadly for other builds' : null));
  if (eff.hits) chips.appendChild(UI.chip('Hits your build', 'warn', 'pick-hit'));
  row.appendChild(chips);
  // the why: always in the app; in the game only for marked rows (keeps the overlay short)
  if (e.why && (!ctx.overlay || on)) {
    var why = UI.el('div', 'pick-why');
    why.appendChild(document.createTextNode(e.why));
    var d = (e.dangerousFor || []).filter(function (t) { return t !== 'all'; });
    if (d.length) why.appendChild(UI.el('span', 'pick-for', ' Worst for: ' + d.map(mechTagName).join(', ') + '.'));
    if (!ctx.overlay) pickCites(why, e.cite);
    row.appendChild(why);
  }
  return row;
}

// [1] [2] links to the sources a line cites (the app only: the overlay has no browser to open)
// one link per site (the first page cited from it), at most PICK_CITE_MAX; the rest are counted
var PICK_CITE_MAX = 3;
function pickCites(el, cite) {
  var seen = {}, sites = [];
  mechCited(cite).forEach(function (s) {
    var key = String(s.publisher || s.url).toLowerCase().replace(/\s*\(.*\)\s*/g, '').trim();
    if (seen[key]) { seen[key].more.push(s); return; }
    seen[key] = { s: s, more: [] };
    sites.push(seen[key]);
  });
  sites.slice(0, PICK_CITE_MAX).forEach(function (x) {
    var s = x.s;
    var a = UI.el('a', 'pick-cite', String(s.publisher || 'source').replace(/\s*\(.*\)\s*$/, ''));
    a.href = '#';
    a.title = (s.title || s.url) + (s.date ? ' (' + s.date + ')' : '') + (x.more.length ? ' — and ' + x.more.length + ' more page' + (x.more.length === 1 ? '' : 's') + ' there' : '');
    a.addEventListener('click', function (ev) { ev.preventDefault(); if (typeof openUrl === 'function') openUrl(s.url); });
    el.appendChild(document.createTextNode(' '));
    el.appendChild(a);
  });
  if (sites.length > PICK_CITE_MAX) {
    var rest = sites.slice(PICK_CITE_MAX).map(function (x) { return x.s.publisher || x.s.url; });
    var m = UI.el('span', 'pick-cite-more', ' +' + rest.length);
    m.title = 'Also: ' + rest.join(', ');
    el.appendChild(m);
  }
}

// a plain list of rated lines (upsides, boons, good remnants, win conditions): value chip + text
function pickValueList(items, nameKey, textKey, ctx) {
  var order = { high: 0, medium: 1, low: 2, safe: 0, caution: 1, deadly: 2 };
  var ul = UI.el('ul', 'pick-values');
  items.slice().sort(function (a, b) {
    return (order[a.value || a.rating] || 0) - (order[b.value || b.rating] || 0);
  }).forEach(function (it) {
    var li = UI.el('li', 'pick-value');
    li.appendChild(mechRating(it.value || it.rating));
    var t = UI.el('span', 'pick-value-text');
    t.appendChild(UI.el('b', null, it[nameKey]));
    if (it.target) t.appendChild(UI.el('span', 'pick-target', ' (' + it.target + ')'));
    if (it[textKey]) t.appendChild(document.createTextNode(' — ' + it[textKey]));
    if (!ctx.overlay) pickCites(t, it.cite);
    li.appendChild(t);
    ul.appendChild(li);
  });
  return ul;
}

function pickRules(rules, ctx, title) {
  var box = UI.el('div', 'pick-rules');
  if (!(rules || []).length) return box;
  box.appendChild(UI.el('div', 'pick-group-title', title || 'Rules of thumb'));
  var ul = UI.el('ul', 'sheet-list');
  rules.forEach(function (r) {
    var li = UI.el('li', 'sheet-li');
    var t = UI.el('span', 'pick-rule-text', r.text); // one inline run: the cites follow the text
    if (!ctx.overlay) pickCites(t, r.cite);
    li.appendChild(t);
    ul.appendChild(li);
  });
  box.appendChild(ul);
  return box;
}

// a tool with sub-tabs (Check / Good ones / Rules); the tab is remembered per tool
var PICK_TAB_KEY = 'pobtf-pick-tab';
function pickTabs(host, ctx, id, tabs) {
  tabs = tabs.filter(function (t) { return t.show !== false; });
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(PICK_TAB_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var cur = tabs.some(function (t) { return t.id === saved[id]; }) ? saved[id] : tabs[0].id;
  var panes = {};
  if (tabs.length > 1) {
    var seg = UI.segmented(tabs.map(function (t) { return [t.id, t.label]; }), cur, {
      ariaLabel: 'Part of this tool to show',
      onChange: function (v) {
        saved[id] = v;
        persist(PICK_TAB_KEY, JSON.stringify(saved));
        Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== v; });
        if (ctx.onChange) ctx.onChange();
      } });
    seg.classList.add('pick-tabs');
    host.appendChild(seg);
  }
  tabs.forEach(function (t) {
    var p = UI.el('div', 'pick-pane');
    p.hidden = t.id !== cur;
    panes[t.id] = p;
    host.appendChild(p);
    t.draw(p);
  });
}

function pickAsOf(host) {
  var D = mechToolData();
  host.appendChild(UI.el('div', 'mech-foot', 'Ratings from community guides and player reports, checked by three reviewers each' +
    (D.asOf ? ' · as of ' + D.asOf : '') + '. A rough guide: your own defences decide.'));
}

// ==== Eldritch altars ====================================================================
mechTool({ id: 'altarpick', title: 'Altar picker', sheets: ['eldritch'], overlay: true, order: 10,
  available: function () { var E = mechToolData().eldritch; return E.downsides.length + E.upsides.length > 0; }, mount: function (host, ctx) {
  var E = mechToolData().eldritch;
  pickTabs(host, ctx, 'altarpick', [
    { id: 'down', label: 'Downsides', draw: function (p) {
      pickChecker(p, ctx, { id: 'altar', noun: 'downside', entries: E.downsides.map(function (d) {
        return { name: d.mod, rating: d.rating, dangerousFor: d.dangerousFor, why: d.why, cite: d.cite };
      }), verdict: { deadly: "Don't click this altar", caution: 'Click only if the upside is worth it', safe: 'Safe to click' },
      empty: 'No verified altar downside ratings yet.' });
    } },
    { id: 'up', label: 'Upsides', show: E.upsides.length > 0, draw: function (p) {
      p.appendChild(pickValueList(E.upsides, 'mod', 'note', ctx));
    } },
    { id: 'rules', label: 'Rules', show: E.rules.length > 0, draw: function (p) { p.appendChild(pickRules(E.rules, ctx)); } },
  ]);
  pickAsOf(host);
} });

// ==== Ultimatum ==========================================================================
mechTool({ id: 'ultipick', title: 'Modifier checker', sheets: ['ultimatum'], overlay: true, order: 10,
  available: function () { return mechToolData().ultimatum.mods.length > 0; }, mount: function (host, ctx) {
  var U = mechToolData().ultimatum;
  pickTabs(host, ctx, 'ultipick', [
    { id: 'mods', label: 'Modifiers', draw: function (p) {
      pickChecker(p, ctx, { id: 'ulti', noun: 'modifier', entries: U.mods.map(function (m) {
        return { name: m.name, rating: m.rating, dangerousFor: m.dangerousFor, why: m.why, cite: m.cite };
      }), verdict: { deadly: 'Take the reward and stop', caution: 'Go on with care', safe: 'Safe to go on' },
      empty: 'No verified Ultimatum modifier ratings yet.' });
    } },
    { id: 'win', label: 'Win conditions', show: U.winConditions.length > 0, draw: function (p) {
      p.appendChild(pickValueList(U.winConditions, 'name', 'note', ctx));
    } },
    { id: 'rules', label: 'Rules', show: U.rules.length > 0, draw: function (p) { p.appendChild(pickRules(U.rules, ctx)); } },
  ]);
  pickAsOf(host);
} });

// ==== Sanctum ============================================================================
mechTool({ id: 'sanctpick', title: 'Affliction checker', sheets: ['sanctum'], overlay: true, order: 10,
  available: function () { return mechToolData().sanctum.afflictions.length > 0; }, mount: function (host, ctx) {
  var S = mechToolData().sanctum;
  pickTabs(host, ctx, 'sanctpick', [
    { id: 'aff', label: 'Afflictions', draw: function (p) {
      pickChecker(p, ctx, { id: 'sanct', noun: 'affliction', groups: [['major', 'Major afflictions'], ['minor', 'Minor afflictions']],
        entries: S.afflictions.map(function (a) {
          return { name: a.name, rating: a.rating, dangerousFor: a.dangerousFor, why: a.why, cite: a.cite, group: a.major ? 'major' : 'minor' };
        }), verdict: { deadly: 'Avoid the room with', caution: 'Take it only if you must', safe: 'Fine to take' },
        empty: 'No verified affliction ratings yet.' });
    } },
    { id: 'boons', label: 'Boons', show: S.boons.length > 0, draw: function (p) { p.appendChild(pickValueList(S.boons, 'name', 'note', ctx)); } },
    { id: 'rules', label: 'Rules', show: S.rules.length > 0, draw: function (p) { p.appendChild(pickRules(S.rules, ctx)); } },
  ]);
  pickAsOf(host);
} });

// ==== Expedition =========================================================================
mechTool({ id: 'exppick', title: 'Remnant picker', sheets: ['expedition'], overlay: true, order: 10,
  available: function () { return mechToolData().expedition.remnants.length > 0; }, mount: function (host, ctx) {
  var X = mechToolData().expedition;
  var bad = X.remnants.filter(function (r) { return r.kind === 'bad'; });
  var good = X.remnants.filter(function (r) { return r.kind === 'good'; });
  pickTabs(host, ctx, 'exppick', [
    { id: 'bad', label: 'Avoid', draw: function (p) {
      pickChecker(p, ctx, { id: 'exp', noun: 'remnant', entries: bad.map(function (r) {
        return { name: r.mod, rating: r.rating, dangerousFor: r.dangerousFor, why: r.why, cite: r.cite };
      }), verdict: { deadly: "Don't detonate this remnant", caution: 'Detonate only if the reward is worth it', safe: 'Safe to detonate' },
      empty: 'No verified remnant ratings yet.' });
    } },
    { id: 'good', label: 'Want', show: good.length > 0, draw: function (p) {
      p.appendChild(pickValueList(good.map(function (r) { return { mod: r.mod, value: r.rating, note: r.why, cite: r.cite }; }), 'mod', 'note', ctx));
    } },
    { id: 'rules', label: 'Tips', show: X.rules.length > 0, draw: function (p) { p.appendChild(pickRules(X.rules, ctx, 'Tips')); } },
  ]);
  pickAsOf(host);
} });

// ==== Incursion: the temple room planner ===============================================
// Your temple as it stands: each architect's room at tier 0 (not built) to 3, and the rooms you
// want. The chains come from the wiki sheet (Room upgrade chains); the room values, goals and tips
// from the verified research. Saved: pobtf-temple (persist()).
var TEMPLE_KEY = 'pobtf-temple';
var templeWhyOpen = {}; // rooms whose "Why" you opened (while the app runs)

function templeChains() {
  var m = typeof mechanicById === 'function' ? mechanicById('incursion') : null;
  var s = ((m && m.sections) || []).filter(function (x) { return /upgrade chains/i.test(x.title || ''); })[0];
  return ((s && s.rows) || []).map(function (r) {
    return { architect: String(r[0] || ''), short: String(r[0] || '').split(',')[0].trim(), rooms: [r[1], r[2], r[3]] };
  }).filter(function (c) { return c.short && c.rooms[2]; });
}
function templeLoad() {
  var v = null;
  try { v = JSON.parse(localStorage.getItem(TEMPLE_KEY) || 'null'); } catch (e) { v = null; }
  return v && typeof v === 'object' && v.tier && v.want ? v : { tier: {}, want: {}, goal: '' };
}
function templeSave(st) { persist(TEMPLE_KEY, JSON.stringify(st)); }
function templeNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
// a goal's name for the menu: research ids like "corrupt-items" read as "Corrupt items"
var TEMPLE_GOAL_WORDS = { sell: 'Sell the temple', 'run-yourself': 'Run it yourself', 'upgrade-neighbours': 'Upgrade neighbouring rooms' };
function templeGoalLabel(name) {
  if (TEMPLE_GOAL_WORDS[name]) return TEMPLE_GOAL_WORDS[name];
  var s = String(name || '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

mechTool({ id: 'temple', title: 'Temple room planner', sheets: ['incursion'], overlay: true, order: 10, mount: function (host, ctx) {
  var I = mechToolData().incursion;
  var chains = templeChains();
  if (!chains.length) { host.appendChild(UI.el('div', 'mech-empty', 'The Incursion sheet data is missing.')); return; }
  var st = templeLoad();
  var info = {}; // tier-3 room → research entry
  I.rooms.forEach(function (r) { info[templeNorm(r.tier3Room)] = r; });
  function roomInfo(c) { return info[templeNorm(c.rooms[2])] || null; }

  var root = UI.el('div', 'temple');
  // goal presets from the research: they tick the rooms they want
  if (I.goals.length) {
    var gbar = UI.el('div', 'pick-bar');
    var opts = [['', 'Pick a goal…']].concat(I.goals.map(function (g) { return [g.name, templeGoalLabel(g.name)]; }));
    var sel = UI.select(opts, st.goal || '', { ariaLabel: 'Temple goal' });
    sel.addEventListener('change', function () {
      st.goal = sel.value;
      var g = I.goals.filter(function (x) { return x.name === sel.value; })[0];
      if (g) {
        st.want = {};
        var wanted = g.wantRooms.map(templeNorm);
        chains.forEach(function (c) { if (wanted.indexOf(templeNorm(c.rooms[2])) !== -1) st.want[c.short] = 1; });
      }
      templeSave(st); draw();
    });
    gbar.appendChild(UI.field('Goal', sel));
    gbar.appendChild(UI.button('ghost', { label: 'Reset temple', size: 'sm', title: 'Set every room back to not built',
      onClick: function () {
        UI.confirmDanger('Reset the temple?', 'Every room goes back to not built and no room is wanted.', 'Reset').then(function (ok) {
          if (!ok) return;
          st = { tier: {}, want: {}, goal: '' };
          sel.value = '';
          templeSave(st); draw();
        });
      } }));
    root.appendChild(gbar);
  }
  var sum = UI.el('div', 'temple-sum');
  sum.setAttribute('role', 'status');
  sum.setAttribute('aria-live', 'polite');
  root.appendChild(sum);
  var tips = UI.el('div', 'temple-tips');
  root.appendChild(tips);
  var grid = UI.el('div', 'temple-grid');
  root.appendChild(grid);
  host.appendChild(root);
  if (I.rules.length) host.appendChild(pickRules(I.rules, ctx, 'Temple rules'));
  pickAsOf(host);

  function draw() {
    grid.textContent = '';
    // wanted rooms first, then the valuable ones, then the rest (in sheet order)
    var rank = { high: 0, medium: 1, low: 2 };
    chains.slice().sort(function (a, b) {
      var wa = st.want[a.short] ? 0 : 1, wb = st.want[b.short] ? 0 : 1;
      if (wa !== wb) return wa - wb;
      var ra = roomInfo(a), rb = roomInfo(b);
      return (ra ? rank[ra.value] : 3) - (rb ? rank[rb.value] : 3);
    }).forEach(function (c) { grid.appendChild(templeRow(c)); });
    // summary: wanted rooms done / to go
    sum.textContent = '';
    var wanted = chains.filter(function (c) { return st.want[c.short]; });
    if (!wanted.length) {
      sum.className = 'temple-sum is-idle';
      sum.appendChild(UI.el('span', null, 'Star the rooms you want (or pick a goal), then set each room to the tier it has in your temple.'));
    } else {
      var done = wanted.filter(function (c) { return (st.tier[c.short] || 0) >= 3; });
      sum.className = 'temple-sum ' + (done.length === wanted.length ? 'is-safe' : 'is-caution');
      sum.appendChild(UI.chip(done.length + ' of ' + wanted.length + ' at tier 3', done.length === wanted.length ? 'success' : 'warn'));
      var left = wanted.filter(function (c) { return (st.tier[c.short] || 0) < 3; }).map(function (c) {
        var t = st.tier[c.short] || 0;
        return c.rooms[2] + ' (' + (t ? 'tier ' + t : 'not built') + ', ' + (3 - t) + ' upgrade' + (3 - t === 1 ? '' : 's') + ' to go — ' + c.short + ')';
      });
      sum.appendChild(UI.el('span', 'temple-left', left.length ? 'Still to upgrade: ' + left.join('; ') + '.' : 'Every wanted room is at tier 3: open the temple.'));
    }
    // the goal's tips
    tips.textContent = '';
    var g = I.goals.filter(function (x) { return x.name === st.goal; })[0];
    if (g && g.tips.length) {
      var ul = UI.el('ul', 'sheet-list');
      g.tips.forEach(function (t) {
        var li = UI.el('li', 'sheet-li');
        li.appendChild(UI.el('span', 'pick-rule-text', t));
        ul.appendChild(li);
      });
      tips.appendChild(ul);
      if (!ctx.overlay) {
        var src = UI.el('div', 'mech-foot', 'Sources for these tips:');
        pickCites(src, g.cite);
        tips.appendChild(src);
      }
    }
    if (ctx.onChange) ctx.onChange();
  }

  function templeRow(c) {
    var t = st.tier[c.short] || 0, ri = roomInfo(c), want = !!st.want[c.short];
    var row = UI.el('div', 'temple-row' + (want ? ' is-wanted' : '') + (t >= 3 ? ' is-done' : ''));
    var star = UI.el('button', 'temple-star', want ? '★' : '☆');
    star.type = 'button';
    star.setAttribute('aria-pressed', want ? 'true' : 'false');
    star.setAttribute('aria-label', (want ? 'Stop wanting ' : 'Want ') + c.rooms[2]);
    star.addEventListener('click', function () {
      if (st.want[c.short]) delete st.want[c.short]; else st.want[c.short] = 1;
      templeSave(st); draw();
    });
    row.appendChild(star);
    var head = UI.el('div', 'temple-head');
    head.appendChild(UI.el('span', 'temple-room', c.rooms[2]));
    head.appendChild(UI.el('span', 'temple-arch', c.short));
    if (ri) head.appendChild(mechRating(ri.value));
    row.appendChild(head);
    // the tier now: not built / 1 / 2 / 3, each button named after the room at that tier
    var tiers = UI.el('div', 'temple-tiers');
    tiers.setAttribute('role', 'group');
    tiers.setAttribute('aria-label', c.short + ': tier of the room in your temple');
    ['Not built', c.rooms[0], c.rooms[1], c.rooms[2]].forEach(function (label, i) {
      var b = UI.el('button', 'temple-tier' + (i === t ? ' is-on' : ''), i ? 'T' + i : '–');
      b.type = 'button';
      b.title = i ? 'Tier ' + i + ': ' + label : 'Not built';
      b.setAttribute('aria-label', c.short + ': ' + (i ? 'tier ' + i + ', ' + label : 'not built'));
      b.setAttribute('aria-pressed', i === t ? 'true' : 'false');
      b.addEventListener('click', function () { st.tier[c.short] = i; templeSave(st); draw(); });
      tiers.appendChild(b);
    });
    row.appendChild(tiers);
    // why this room is worth it: folded ("Why") so the grid stays scannable; open for wanted rooms
    // in the app, and only shown for wanted rooms in the game
    if (ri && ri.why && (!ctx.overlay || want)) {
      var det = UI.el('details', 'temple-why');
      det.open = want && !ctx.overlay ? true : !!templeWhyOpen[c.short];
      if (ctx.overlay) det.open = true;
      det.appendChild(UI.el('summary', 'temple-why-sum', 'Why'));
      var why = UI.el('div', 'pick-why', ri.why);
      if (!ctx.overlay) pickCites(why, ri.cite);
      det.appendChild(why);
      det.addEventListener('toggle', function () { templeWhyOpen[c.short] = det.open; if (ctx.onChange) ctx.onChange(); });
      row.appendChild(det);
    }
    return row;
  }
  draw();
} });
