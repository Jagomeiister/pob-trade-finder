/* js/app/03-shell.js — decoding builds, rendering, settings drawer, views and slot lists.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- decode flow -----------------------------------------------------------
async function onDecode() {
  var input = document.getElementById('pob-input').value.trim();
  var status = document.getElementById('status');
  if (!input) { status.textContent = 'Paste a PoB export code first.'; return; }
  status.textContent = 'Decoding…';

  // in-game Ctrl+C item text -> standalone price-check card
  if (window.PoB.looksLikeGameItem && PoB.looksLikeGameItem(input)) {
    var pasted = PoB.parseGameItem(input);
    if (pasted) {
      status.textContent = '';
      renderPastedItem(pasted);
      return;
    }
  }
  try {
    var code = input;
    var linkMatch = input.match(/(?:pobb\.in|pastebin\.com\/raw|pastebin\.com)\/([A-Za-z0-9_-]+)/);
    if (/^https?:\/\//i.test(input)) {
      code = await fetchCodeFromLink(input, linkMatch);
    }
    var xml = await PoB.decodePobCode(code);
    if (xml.indexOf('<PathOfBuilding') === -1) throw new Error('Decoded data is not a PoB build.');
    build = PoB.parseBuild(xml);
    if (typeof sheetRememberBuild === 'function') sheetRememberBuild(build); // cheat sheet gems (24-cheatsheets.js)
    status.textContent = '';
    saveSettings();
    document.getElementById('build-label').textContent =
      build.ascendClass || build.className || 'Unknown class';
    var nSets = (build.itemSets || []).length;
    document.getElementById('build-sub').textContent =
      Object.keys(build.items).length + ' items' + (nSets > 1 ? ' · ' + nSets + ' gear sets' : '');
    renderBuild();
    computeBuildDiff(); // before the cost line: it carries unchanged slots' history over
    showLastBuildCost();
    renderBuildDiff();
    refreshSlotLists();
    showBuild();
    libAfterLoad(); // saved: mark it opened; new: offer to save it (04-library.js)
    if (buildDiff) {
      UI.toast(buildDiff.rows.length + ' slot' + (buildDiff.rows.length > 1 ? 's' : '') +
        ' changed since the last version of this build. They\'re listed above the gear.', 'info');
    }
  } catch (err) {
    UI.toast('Could not load that build — see the message under the paste box.', 'danger');
    status.textContent = '❌ ' + err.message +
      (/^https?:\/\//i.test(input) && !isGui()
        ? ' — link fetching can be blocked by the site (CORS). Open the link, copy the PoB export code, and paste the code itself.'
        : /^https?:\/\//i.test(input)
          ? ''
          : ' — make sure you pasted the full export code from PoB (Import/Export Build → Generate).');
  }
}

async function fetchCodeFromLink(url, m) {
  // Desktop app: the Python bridge fetches links without CORS restrictions
  if (isGui() && window.pywebview.api.fetch_pob_link) {
    var res = await window.pywebview.api.fetch_pob_link(url);
    if (res && res.ok) return res.code;
    throw new Error('Could not fetch the build from that link (' + (res && res.error || 'unknown error') + ')');
  }
  var tryUrls = [];
  if (/pobb\.in/.test(url) && m) tryUrls.push('https://pobb.in/' + m[1] + '/raw');
  if (/pastebin\.com/.test(url) && m) tryUrls.push('https://pastebin.com/raw/' + m[1]);
  tryUrls.push(url);
  for (var i = 0; i < tryUrls.length; i++) {
    try {
      var r = await fetch(tryUrls[i]);
      if (r.ok) {
        var t = (await r.text()).trim();
        if (/^[A-Za-z0-9_\-=+\/\s]+$/.test(t) && t.length > 100) return t;
      }
    } catch (e) { /* CORS or network — try next */ }
  }
  throw new Error('Could not fetch the build from that link');
}

// ---- rendering -------------------------------------------------------------
function renderBuild(setIndex) {
  var root = document.getElementById('results');
  root.innerHTML = '';
  cards.forEach(stopLive); // kill any live-search timers before replacing cards
  cards = [];
  pastedState = null;
  buildDiff = null; // the diff describes the default gear set as loaded

  var sets = build.itemSets || [];
  if (setIndex === undefined) setIndex = build.activeSetIndex || 0;
  var set = sets[setIndex] || { slots: build.slots, flasks: build.flasks };

  // Gear-set picker — guide PoBs ship several (Leveling / Budget / Endgame…)
  var pickSlot = document.getElementById('set-picker-slot');
  pickSlot.textContent = '';
  if (sets.length > 1) {
    var pick = UI.select(sets.map(function (s, i) {
      return [String(i), s.title + (i === build.activeSetIndex ? ' (active in PoB)' : '')];
    }), String(setIndex), { onChange: function () { renderBuild(parseInt(this.value, 10)); } });
    pickSlot.appendChild(UI.field('Gear set', pick));
  }

  // one section per view; item views are a slot list + one item at a time
  var sections = {};
  function section(key) {
    if (!sections[key]) {
      var sec = document.createElement('div');
      sec.className = 'tab-section';
      sec.dataset.tab = key;
      if (MASTER_DETAIL[key]) {
        sec.classList.add('master-detail');
        var list = document.createElement('div');
        list.className = 'slot-list';
        sec.appendChild(list);
        var detail = document.createElement('div');
        detail.className = 'slot-detail';
        sec.appendChild(detail);
        sec.detail = detail;
      }
      sections[key] = sec;
    }
    return sections[key].detail || sections[key];
  }

  set.slots.forEach(function (s) {
    var item = build.items[s.itemId];
    if (!item) return;
    var target = /Abyssal/i.test(s.slot) ? section('jewels') : section('gear');
    target.appendChild(makeCard(s.slot, item, setIndex));
  });
  build.jewels.forEach(function (id) {
    section('jewels').appendChild(makeCard('Jewel', build.items[id]));
  });
  set.flasks.forEach(function (f) {
    var item = build.items[f.itemId];
    if (item) section('flasks').appendChild(makeCard(f.slot, item, setIndex));
  });
  if (build.gemGroups && build.gemGroups.length) {
    section('gems').appendChild(makeGemsCard(build.gemGroups));
  }

  if (build.tree && build.tree.nodes && build.tree.nodes.length) {
    section('timeless').appendChild(makeTimelessFinder(build));
    section('finder').appendChild(makeJewelFinder(build));
    section('tree').appendChild(makeTreeView(build)); // mini PoB: the tree, jewels, points still to take
  }
  renderToolSections(); // Watcher's Eye & co. with this build's auras; search text, div cards

  var present = VIEW_ORDER.filter(function (k) { return sections[k]; });
  present.forEach(function (k) { root.appendChild(sections[k]); });
  Object.keys(MASTER_DETAIL).forEach(function (k) {
    var first = sections[k] && sections[k].detail.querySelector('.card');
    if (first) first.classList.add('is-active');
  });
  document.getElementById('char-bar').classList.remove('hidden');
  updateContextChips();
  renderNav();
  var keep = document.body.dataset.view;
  setView(present.indexOf(keep) !== -1 || (keep && keep !== 'home' && !BUILD_VIEWS[keep]) || keep === 'planner' ? keep : present[0] || 'planner');
  renderCostSummary(); // clears stale summary — fresh cards have no prices yet
  applyCharDiff();     // re-annotate fresh cards if a character is loaded
}

// ---- settings drawer: slides in from the right, focus stays inside until closed ----
var settingsOpener = null;
// Tabs: each <section class="settings-section" data-tab="…"> belongs to one tab (a tab can hold
// several sections); new settings just go in a section with the right data-tab. "Find a setting"
// searches every tab at once. The last tab is remembered on this PC (a convenience only).
var SETTINGS_TABS = [['look', 'Look'], ['alerts', 'Alerts'], ['hotkeys', 'Hotkeys'], ['ingame', 'In game'],
                     ['account', 'Account'], ['updates', 'Updates'], ['notes', 'Patch notes'], ['help', 'Help']];
var SETTINGS_TAB_KEY = 'pobtf-settings-tab';
var settingsTab = null;
function settingsSections() {
  return Array.prototype.slice.call(document.querySelectorAll('#settings-panel .settings-section[data-tab]'));
}
// gui-only sections don't exist in the browser version: their tab isn't offered there
function settingsSectionUsable(sec) {
  return !sec.classList.contains('gui-only') || document.body.classList.contains('gui');
}
function settingsTabsUsable() {
  var secs = settingsSections();
  return SETTINGS_TABS.filter(function (t) {
    return secs.some(function (s) { return s.dataset.tab === t[0] && settingsSectionUsable(s); });
  });
}
function renderSettingsTabs() {
  var bar = document.getElementById('settings-tabs');
  if (!bar) return;
  bar.textContent = '';
  var tabs = settingsTabsUsable();
  if (!tabs.some(function (t) { return t[0] === settingsTab; })) {
    var saved = null;
    try { saved = localStorage.getItem(SETTINGS_TAB_KEY); } catch (e) { /* fine */ }
    settingsTab = tabs.some(function (t) { return t[0] === saved; }) ? saved : (tabs[0] || [null])[0];
  }
  tabs.forEach(function (t, i) {
    var b = UI.el('button', 'settings-tab', t[1]);
    b.type = 'button';
    b.dataset.settingsTab = t[0];
    b.id = 'settings-tab-' + t[0];
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', t[0] === settingsTab ? 'true' : 'false');
    b.tabIndex = t[0] === settingsTab ? 0 : -1;
    b.addEventListener('click', function () { showSettingsTab(t[0]); });
    b.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var next = tabs[(i + d + tabs.length) % tabs.length][0];
      showSettingsTab(next);
      var nb = document.getElementById('settings-tab-' + next);
      if (nb) nb.focus();
    });
    bar.appendChild(b);
  });
}
function showSettingsTab(id) {
  settingsTab = id;
  try { localStorage.setItem(SETTINGS_TAB_KEY, id); } catch (e) { /* fine */ }
  var find = document.getElementById('settings-find');
  if (find && find.value) { find.value = ''; findSetting(''); }
  document.querySelectorAll('#settings-tabs .settings-tab').forEach(function (b) {
    var on = b.dataset.settingsTab === id;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  settingsSections().forEach(function (s) {
    s.classList.toggle('is-away', s.dataset.tab !== id);
    s.setAttribute('role', 'tabpanel');
    s.setAttribute('aria-labelledby', 'settings-tab-' + s.dataset.tab);
  });
  var panel = document.getElementById('settings-panel');
  if (panel) panel.scrollTop = 0;
}
// Find a setting: every tab's settings at once, only the ones that match every word typed
// (their label, help text or choices); a match in a section's heading shows the whole section.
// Sections marked data-no-find (the patch notes) hold no settings: hidden while finding.
function findSetting(q) {
  var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  var panel = document.getElementById('settings-panel');
  panel.classList.toggle('is-finding', words.length > 0);
  var any = false;
  settingsSections().forEach(function (s) {
    if (s.hasAttribute('data-no-find')) { s.classList.toggle('set-miss', words.length > 0); return; }
    var head = (s.querySelector('h3') || {}).textContent || '';
    var headHit = words.length && words.every(function (w) { return head.toLowerCase().indexOf(w) !== -1; });
    var hits = 0;
    Array.prototype.forEach.call(s.children, function (item) {
      if (item.tagName === 'H3') return;
      var text = item.textContent + ' ' + (item.title || '') + ' ' +
        Array.prototype.map.call(item.querySelectorAll('[title],[aria-label],[placeholder]'), function (e) {
          return (e.title || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '');
        }).join(' ');
      var hit = !words.length || headHit || words.every(function (w) { return text.toLowerCase().indexOf(w) !== -1; });
      item.classList.toggle('set-miss', !hit);
      if (hit) hits++;
    });
    var show = !words.length || (settingsSectionUsable(s) && hits > 0);
    s.classList.toggle('set-miss', !show);
    if (words.length && show) any = true;
  });
  document.getElementById('settings-none').hidden = !words.length || any;
  if (!words.length) showSettingsTab(settingsTab);
}
function wireSettingsFind() {
  var find = document.getElementById('settings-find');
  if (!find || find.dataset.wired) return;
  find.dataset.wired = '1';
  find.addEventListener('input', function () { findSetting(find.value); });
  find.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && find.value) { e.preventDefault(); e.stopPropagation(); find.value = ''; findSetting(''); }
  });
}
// focusId: open on the tab holding that control and focus it (e.g. "Add POESESSID…")
function openSettings(opener, focusId) {
  settingsOpener = opener && opener.focus ? opener : null;
  document.getElementById('settings-backdrop').classList.remove('hidden');
  var panel = document.getElementById('settings-panel');
  panel.classList.remove('hidden');
  wireSettingsFind();
  renderSettingsTabs();
  var target = focusId && document.getElementById(focusId);
  var sec = target && target.closest('.settings-section[data-tab]');
  showSettingsTab(sec ? sec.dataset.tab : settingsTab);
  if (target) target.focus(); else document.getElementById('settings-close').focus();
}
function closeSettings() {
  document.getElementById('settings-backdrop').classList.add('hidden');
  document.getElementById('settings-panel').classList.add('hidden');
  if (settingsOpener) settingsOpener.focus();
}

// ---- app shell: views, sidebar nav, slot lists, search context ---------------
var VIEW_ORDER = ['gear', 'jewels', 'flasks', 'gems', 'timeless', 'finder', 'uniques', 'search', 'divcards', 'tree', 'pasted'];
var MASTER_DETAIL = { gear: true, jewels: true, flasks: true };
var VIEW_LABELS = { gear: 'Gear', jewels: 'Jewels & clusters', flasks: 'Flasks', gems: 'Gems',
                    timeless: 'Timeless jewels', finder: 'Jewel finder', uniques: 'Watcher\'s Eye & co.', search: 'Search text', divcards: 'Div cards', tree: 'Skill tree', pasted: 'Pasted item',
                    planner: 'Upgrade planner', market: 'Market', stash: 'Stash value', trades: 'Trade helper', sheets: 'Cheat sheets', dust: 'Dust explorer', filter: 'Loot filter',
                    atlas: 'Atlas tree', home: 'Builds' };
// icons carry the narrow-window rail, where labels are hidden (labels stay as tooltips)
var VIEW_ICONS = { gear: '⚔', jewels: '◈', flasks: '⚗', gems: '◆', pasted: '📋', planner: '🛒',
                   timeless: '⏳', finder: '🔍', uniques: '👁', search: '🔤', divcards: '🃏', tree: '🌳', market: '📈', stash: '💰', trades: '🤝', sheets: '📜', dust: '✨', filter: '⏚', atlas: '🗺', home: '⌂' };

// views with line-art icons in css/navicons.css (tools/make_navicons.py); the rest keep VIEW_ICONS
var NAV_ICON_NAMES = { gear: 1, jewels: 1, flasks: 1, gems: 1, pasted: 1, planner: 1, timeless: 1, finder: 1,
  uniques: 1, search: 1, divcards: 1, tree: 1, market: 1, stash: 1, trades: 1, sheets: 1, settings: 1, home: 1, dust: 1, filter: 1 };
function navIcon(k, cls) {
  var art = NAV_ICON_NAMES[k];
  var ic = UI.el('span', (cls || 'nav-icon') + (art ? ' ni ni-' + k : ''), art ? '' : VIEW_ICONS[k] || '•');
  ic.setAttribute('aria-hidden', 'true');
  return ic;
}
// icon-only button with an art icon (the overlays' buttons)
function navIconButton(k, label, onClick) {
  var b = UI.iconButton('', label, { size: 'sm', onClick: onClick });
  b.appendChild(navIcon(k, 'btn-ni'));
  return b;
}

// a view's section: the build's (#results) or a tool that works without a build (#tool-sections)
function viewSection(k) {
  return document.querySelector('#results > .tab-section[data-tab="' + k + '"], #tool-sections > .tab-section[data-tab="' + k + '"]');
}
// views that need a loaded build; every other tool works from launch
var BUILD_VIEWS = { gear: 1, jewels: 1, flasks: 1, gems: 1, planner: 1, tree: 1, timeless: 1, finder: 1 };
// the tools without a build: their sections live in #tool-sections and are made once (a loaded
// build refreshes the build-aware one, Watcher's Eye & co.)
function renderToolSections() {
  var box = document.getElementById('tool-sections');
  if (!box) return;
  box.textContent = '';
  [['uniques', function () { return makeUniqueJewels(build); }], // Watcher's Eye, Forbidden pair, Thread of Hope
   ['search', makeSearchText],    // in-game search text builder
   ['divcards', makeDivcards]       // which areas drop the valuable cards
  ].forEach(function (t) {
    var sec = document.createElement('div');
    sec.className = 'tab-section';
    sec.dataset.tab = t[0];
    sec.appendChild(t[1]());
    box.appendChild(sec);
  });
}

function setView(k) {
  if (!k || (!build && BUILD_VIEWS[k])) k = 'home'; // no build: the Builds page (saved builds + paste box)
  document.body.dataset.view = k;
  if (k === 'market') renderMarketPage(); // built lazily: hundreds of rows
  if (k === 'stash') renderStashPage();
  if (k === 'divcards') loadDivcardsView(); // drop data + prices load on first open
  if (k === 'tree') showTreeView(); // the canvas is sized and drawn once it's visible
  if (k === 'trades') showTradeHelperView(); // re-reads what the overlay saved
  if (k === 'sheets') renderSheetsView(); // cheat sheets: built-in acts + your own
  if (k === 'dust') renderDustView(); // dust per chaos for every unique (26-dust.js)
  if (k === 'atlas') showAtlasView(); // Atlas tree: built once, canvas sized once visible (28-atlas.js)
  if (k === 'filter') renderFilterView(); // loot filter tools (29-lootfilter.js)
  document.getElementById('view-title').textContent = VIEW_LABELS[k] || '';
  document.querySelectorAll('#nav .nav-item').forEach(function (b) {
    if (b.dataset.view === k) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

function navCount(k) {
  if (k === 'planner') {
    var n = loadBasket().length;
    return n ? String(n) : '';
  }
  var sec = viewSection(k);
  if (!sec || !MASTER_DETAIL[k] && k !== 'gems') return '';
  if (k === 'gems') return String(build && build.gemGroups ? build.gemGroups.length : '');
  return String(sec.querySelectorAll('.slot-detail > .card').length);
}

function renderNav() {
  var nav = document.getElementById('nav');
  nav.textContent = '';
  function item(k) {
    var b = UI.el('button', 'nav-item');
    b.type = 'button';
    b.dataset.view = k;
    b.title = VIEW_LABELS[k];
    b.appendChild(navIcon(k));
    b.appendChild(UI.el('span', 'nav-label', VIEW_LABELS[k]));
    b.appendChild(UI.el('span', 'nav-count', navCount(k)));
    b.addEventListener('click', function () {
      if (k === 'trades') { openTradesWindow(); return; } // the Trade helper view (19-trades.js)
      setView(k); window.scrollTo(0, 0);
    });
    nav.appendChild(b);
  }
  item('home'); // your saved builds and the paste box, with or without a build loaded
  var items = ['gear', 'jewels', 'flasks', 'gems', 'pasted'].filter(viewSection);
  if (items.length) { nav.appendChild(UI.el('div', 'nav-group', 'Items')); items.forEach(item); }
  nav.appendChild(UI.el('div', 'nav-group', 'Tools'));
  ['planner', 'tree', 'timeless', 'finder', 'uniques', 'search', 'divcards', 'sheets', 'atlas', 'dust', 'filter', 'market', 'stash', 'trades'].filter(function (k) {
    if (k === 'stash') return OAUTH.signedIn; // official login only
    if (k === 'trades') return isGui();
    if (k === 'atlas') return typeof atlasOpen === 'function'; // 28-atlas.js
    if (BUILD_VIEWS[k]) return !!build && (k === 'planner' || viewSection(k));
    return k === 'market' || k === 'sheets' || k === 'dust' || k === 'filter' || viewSection(k);
  }).forEach(item);
  setView(document.body.dataset.view || (build ? 'gear' : 'home'));
}

function updateNavCounts() {
  document.querySelectorAll('#nav .nav-item').forEach(function (b) {
    b.querySelector('.nav-count').textContent = navCount(b.dataset.view);
  });
}

// slot list rows mirror the cards in each item view: name, then price / status
function slotStatus(state) {
  var c = state.card.classList;
  if (state.bought) return UI.chip('Bought', 'success');
  var league = document.getElementById('league').value;
  if (state.cheapestChaos !== undefined) return document.createTextNode(fmtEq(state.cheapestChaos, league));
  if (state.priceState && state.priceState.total === 0) return UI.chip('None listed', 'danger');
  if (state.diffKind) return UI.chip(state.diffKind === 'added' ? 'New' : 'Changed', 'accent');
  if (c.contains('diff-matched')) return UI.chip('Equipped', 'success');
  if (c.contains('diff-close')) return UI.chip('Close', 'warn');
  if (c.contains('diff-missing')) return UI.chip('Missing', 'danger');
  return null;
}

function selectSlot(sec, card, focus) {
  sec.querySelectorAll('.slot-detail > .card').forEach(function (c) { c.classList.toggle('is-active', c === card); });
  sec.querySelectorAll('.slot-row').forEach(function (r) {
    if (r.slotCard === card) { r.setAttribute('aria-current', 'true'); if (focus) r.focus(); }
    else r.removeAttribute('aria-current');
  });
}

// art that arrives later (unique renders, atlas crops, disk cache) — one redraw per burst
var slotRefreshTimer = null;
function queueSlotRefresh() {
  if (slotRefreshTimer) return;
  slotRefreshTimer = setTimeout(function () { slotRefreshTimer = null; refreshSlotLists(); }, 300);
}

function refreshSlotLists() {
  Object.keys(MASTER_DETAIL).forEach(function (k) {
    var sec = viewSection(k);
    if (!sec) return;
    var list = sec.querySelector('.slot-list');
    var focusedIdx = Array.prototype.indexOf.call(list.querySelectorAll('.slot-row'), document.activeElement);
    list.textContent = '';
    var head = UI.el('div', 'slot-list-head');
    var cardEls = Array.prototype.slice.call(sec.querySelectorAll('.slot-detail > .card'));
    head.appendChild(UI.el('b', null, VIEW_LABELS[k]));
    var priced = cards.filter(function (s) { return cardEls.indexOf(s.card) !== -1 && s.cheapestChaos !== undefined; }).length;
    head.appendChild(UI.el('span', 'slot-label', priced ? priced + ' of ' + cardEls.length + ' priced' : cardEls.length + ' slots'));
    list.appendChild(head);
    var rows = [];
    cardEls.forEach(function (cardEl) {
      var state = cards.find(function (s) { return s.card === cardEl; });
      if (!state) return;
      var row = UI.el('button', 'slot-row');
      row.type = 'button';
      row.slotCard = cardEl;
      ['diff-matched', 'diff-close', 'diff-missing'].forEach(function (d) { if (cardEl.classList.contains(d)) row.classList.add(d); });
      if (state.bought) row.classList.add('bought');
      var src = cardEl.querySelector('.card-icon');
      var ic = UI.el('img', 'slot-ic' + (src && src.classList.contains('atlas2') ? ' atlas2' : ''));
      ic.alt = '';
      ic.src = src && src.src ? src.src : BLANK_PX;
      row.appendChild(ic);
      var txt = UI.el('span', 'slot-txt');
      txt.appendChild(UI.el('span', 'slot-label', state.slot));
      var rarity = (state.item.rarity || 'normal').toLowerCase();
      txt.appendChild(UI.el('span', 'slot-name ' + (rarity === 'relic' ? 'unique' : rarity),
        state.resolvedName || state.item.name || state.item.base || state.slot));
      row.appendChild(txt);
      var st = UI.el('span', 'slot-status');
      var status = slotStatus(state);
      if (status) st.appendChild(status);
      row.appendChild(st);
      if (cardEl.classList.contains('is-active')) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', function () { selectSlot(sec, cardEl); });
      row.addEventListener('keydown', function (e) {
        var i = rows.indexOf(row);
        var j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : -1;
        if (j < 0 || j >= rows.length) return;
        e.preventDefault();
        selectSlot(sec, rows[j].slotCard, true);
      });
      rows.push(row);
      list.appendChild(row);
    });
    if (focusedIdx !== -1 && rows[focusedIdx]) rows[focusedIdx].focus();
  });
  updateNavCounts();
}

// read-only summary of the search settings, shown in the top bar
function updateContextChips() {
  var box = document.getElementById('context-chips');
  if (!box) return;
  box.textContent = '';
  function optText(id) {
    var s = document.getElementById(id);
    var o = s && s.options[s.selectedIndex];
    return o ? o.textContent : '';
  }
  box.appendChild(UI.chip(optText('league') || document.getElementById('league').value));
  box.appendChild(UI.chip(optText('trade-status')));
  if (document.getElementById('sale-type').value !== 'priced') box.appendChild(UI.chip('Sale: ' + optText('sale-type')));
  if (document.getElementById('listed-within').value) box.appendChild(UI.chip('Listed within ' + optText('listed-within')));
  if (document.getElementById('priced-in').value) box.appendChild(UI.chip('Priced in ' + optText('priced-in').toLowerCase()));
  box.appendChild(UI.chip('Min roll ' + document.getElementById('pct').value + '%'));
  if (!document.getElementById('pseudo').checked) box.appendChild(UI.chip('No pseudo totals', 'warn'));
}

// landing ⇄ build
// The sidebar is always there (tools work without a build); has-build = a build is loaded and its
// views exist. The Builds page ('home' view) shows the saved builds and the paste box.
function showBuild() {
  document.body.classList.add('has-build');
  document.getElementById('input-panel').classList.remove('hidden');
  document.getElementById('build-bar').classList.remove('hidden');
  window.scrollTo(0, 0);
}
function showLanding() {
  document.getElementById('input-panel').classList.remove('hidden');
  document.getElementById('back-to-build').classList.toggle('hidden', !build);
  setView('home');
  window.scrollTo(0, 0);
}
