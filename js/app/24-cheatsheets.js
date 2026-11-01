/* js/app/24-cheatsheets.js — leveling cheat sheets: a sheet over the game (index.html?sheet=1,
   shown / hidden by its hotkey) and the Tools → Cheat sheets view to read and edit them. The
   js/app/ files are one program split by feature: they load in order (index.html) and share
   their top-level names. */
'use strict';

// ==== cheat sheets ==================================================================
// Ready-made part: data/cheatsheets.js (tools/make_cheatsheets.py, from the PoE Wiki): the
// skill point and respec quests, trials, bandits and resistance penalties of each act.
// Your part: sheets of your own (text + pictures), for one act or for every act.
// "Follow my act": the log reader (the one the trade helper uses) sees the game generate a
// campaign area ("2_6_town" = Act 6) and the sheet turns to that act. Display only.
// Mechanic sheets (Betrayal, Blight, Delve, …) come in the same data under "mechanics". Entering
// a mechanic's area doesn't open anything big: a small pill (index.html?sheethint=1, its own
// movable overlay, top centre by default) offers "Open", and the sheet shows only if you click.
// The data updates from the app's server between releases (cheatsheets_data in gui.py).
var SHEET_HINT = /[?&]sheethint=1(&|$)/.test(location.search);
var SHEET_OV = SHEET_HINT || /[?&]sheet=1(&|$)/.test(location.search); // either sheet overlay page
if (SHEET_OV) document.body.classList.add('trades', 'trade-cards', 'sheet-ov');

var SHEET_PREFS_KEY = 'pobtf-sheet-prefs', SHEETS_KEY = 'pobtf-sheets';
var SHEET_IMG_PREFIX = 'data/cheatsheets/';
var sheetOpen = false;     // overlay: showing
var sheetArea = null;      // overlay: the area you're in (from "You have entered ...")
var sheetViewAct = null;   // main view: the act being previewed
var sheetViewMech = null;  // main view: the mechanic being previewed (instead of an act)
var sheetEditing = null;   // main view: id of the sheet open in the editor ('new' for a new one)

function sheetPrefs() {
  var p;
  try { p = JSON.parse(localStorage.getItem(SHEET_PREFS_KEY)) || {}; } catch (e) { p = {}; }
  if (!(p.act >= 1 && p.act <= 10)) p.act = 1;
  if (p.opacity === undefined) p.opacity = 95; // nearly solid: readable over bright scenes
  if (!p.scale) p.scale = 100;
  if (!p.width) p.width = 320;
  if (!p.height) p.height = 520;          // the sheet scrolls past this (mechanic tables are long)
  if (p.suggest === undefined) p.suggest = true;
  if (!Array.isArray(p.muted)) p.muted = []; // mechanics you said not to suggest
  if (p.sheet && !mechanicById(p.sheet)) p.sheet = null; // null: the act sheet; else a mechanic id
  p.show = Object.assign({ points: true, trials: true, notes: true, mine: true }, p.show || {});
  return p;
}
function saveSheetPrefs(p) { saveShared(SHEET_PREFS_KEY, JSON.stringify(p)); }
// the cards window asks this when deciding whether the log reader should run (19-trades.js)
function sheetWantsLog() { return !!sheetPrefs().follow; }

function loadSheets() {
  var list;
  try { list = JSON.parse(localStorage.getItem(SHEETS_KEY)) || []; } catch (e) { list = []; }
  return Array.isArray(list) ? list.filter(function (s) { return s && s.id; }) : [];
}
function saveSheets(list) { saveShared(SHEETS_KEY, JSON.stringify(list)); }
function sheetsForAct(act) {
  return loadSheets().filter(function (s) { return !s.act || s.act === act; });
}
function sheetImgOk(src) {
  return typeof src === 'string' && src.indexOf(SHEET_IMG_PREFIX) === 0 && src.indexOf('..') === -1;
}

// ---- the sheet itself (overlay and main-view preview) ---------------------------------------
function sheetData() { return window.POE_CHEATSHEETS || null; }
function sheetMechanics() { var d = sheetData(); return (d && Array.isArray(d.mechanics)) ? d.mechanics : []; }
function mechanicById(id) { return sheetMechanics().filter(function (m) { return m.id === id; })[0] || null; }

// newer sheets from the app's server (fixes between releases); the shipped copy otherwise
var sheetSynced = false;
async function sheetSync(onNew) {
  if (sheetSynced || !isGui() || !window.pywebview.api.cheatsheets_data) return;
  sheetSynced = true;
  try {
    var r = await window.pywebview.api.cheatsheets_data();
    var mine = sheetData();
    if (r && r.ok && r.data && r.data.version > ((mine && mine.version) || 0)) {
      window.POE_CHEATSHEETS = r.data;
      if (onNew) onNew();
    }
  } catch (e) { /* keep the shipped copy */ }
}

// which mechanic's sheet fits this area: an area id ("Generating level 68 area ...") or name
function sheetMatch(ev) {
  return sheetMechanics().filter(function (m) {
    var mt = m.match || {};
    if (ev.type === 'area' && ev.id) {
      return (mt.areaIds || []).some(function (pre) { return pre && ev.id.indexOf(pre) === 0; });
    }
    return ev.type === 'zone' && (mt.areaNames || []).indexOf(ev.area) !== -1;
  })[0] || null;
}

// a mechanic sheet: tables and lists straight from the data
function mechanicContent(m, opts) {
  opts = opts || {};
  var box = UI.el('div', 'sheet-content');
  (m.sections || []).forEach(function (s) {
    var sec = UI.el('div', 'sheet-sec');
    if (s.title) sec.appendChild(UI.el('div', 'sheet-sec-title', s.title));
    if (Array.isArray(s.columns) && Array.isArray(s.rows)) {
      var t = UI.el('table', 'sheet-table');
      var hr = UI.el('tr');
      s.columns.forEach(function (c) { hr.appendChild(UI.el('th', null, c)); });
      var th = UI.el('thead');
      th.appendChild(hr);
      t.appendChild(th);
      var tb = UI.el('tbody');
      s.rows.forEach(function (row) {
        var tr = UI.el('tr');
        (row || []).forEach(function (cell) { tr.appendChild(UI.el('td', null, cell == null ? '' : String(cell))); });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      sec.appendChild(t);
    } else if (Array.isArray(s.lines)) {
      var ul = UI.el('ul', 'sheet-list');
      s.lines.forEach(function (l) { ul.appendChild(UI.el('li', 'sheet-li', String(l))); });
      sec.appendChild(ul);
    }
    box.appendChild(sec);
  });
  if (!opts.noSource) {
    box.appendChild(UI.el('div', 'sheet-foot', (m.source || 'Path of Exile Wiki') + (m.patch ? ' · checked for ' + m.patch : '') +
      ' · CC BY-NC-SA 3.0'));
  }
  return box;
}

// the act whose trials finish a labyrinth difficulty gets a line about that labyrinth
function sheetLabFor(act) {
  var d = sheetData();
  if (!d) return null;
  var acts = d.acts || {}, mine = (acts[act] || {}).trials || [];
  if (!mine.length) return null;
  var lab = mine[0].lab, last = 0, count = 0;
  Object.keys(acts).forEach(function (a) {
    (acts[a].trials || []).forEach(function (t) { if (t.lab === lab) { count++; last = Math.max(last, +a); } });
  });
  if (last !== act || !lab) return null;
  return { lab: lab, count: count, level: (d.labs || {})[lab] || null };
}

function sheetContent(act, opts) {
  opts = opts || {};
  var p = sheetPrefs(), d = sheetData();
  var box = UI.el('div', 'sheet-content');
  var a = d && d.acts ? d.acts[act] || {} : {};
  function section(title) {
    var s = UI.el('div', 'sheet-sec');
    s.appendChild(UI.el('div', 'sheet-sec-title', title));
    box.appendChild(s);
    return s;
  }
  if (!d) box.appendChild(UI.el('div', 'sheet-empty', 'The built-in sheet data is missing (data/cheatsheets.js).'));
  if (d && p.show.points && (a.points || []).length) {
    var ul = UI.el('ul', 'sheet-list');
    a.points.forEach(function (q) {
      var li = UI.el('li', 'sheet-li');
      li.appendChild(UI.el('span', 'sheet-tag ' + (q.kind === 'respec' ? 'is-respec' : 'is-point'),
        q.kind === 'respec' ? 'respec' : '+1 point'));
      li.appendChild(UI.el('span', null, q.quest));
      ul.appendChild(li);
    });
    section('Quests').appendChild(ul);
  }
  if (d && p.show.trials && (a.trials || []).length) {
    var tl = UI.el('ul', 'sheet-list');
    a.trials.forEach(function (t) {
      var here = sheetArea && sheetArea === t.area;
      var li = UI.el('li', 'sheet-li' + (here ? ' is-here' : ''));
      li.appendChild(UI.el('span', 'sheet-tag is-trial', 'trial'));
      var txt = UI.el('span', 'sheet-li-text'); // area on top, its traps quieter underneath
      txt.appendChild(UI.el('span', null, t.area));
      txt.appendChild(UI.el('span', 'sheet-li-sub', t.trap));
      li.appendChild(txt);
      if (here) li.appendChild(UI.chip('you\'re here', 'success'));
      tl.appendChild(li);
    });
    var lab = sheetLabFor(act);
    if (lab) {
      tl.appendChild(UI.el('li', 'sheet-li sheet-sub', lab.lab + ' Labyrinth' + (lab.level ? ' (area level ' + lab.level + ')' : '') +
        ': opens after these ' + lab.count + ' trials'));
    }
    section('Trials of Ascendancy').appendChild(tl);
  }
  if (d && p.show.notes) {
    (a.notes || []).forEach(function (n) {
      var nl = UI.el('ul', 'sheet-list');
      n.lines.forEach(function (l) { nl.appendChild(UI.el('li', 'sheet-li', l)); });
      section(n.title).appendChild(nl);
    });
  }
  if (p.show.mine) {
    sheetsForAct(act).forEach(function (s) {
      var sec = section(s.title || 'Your notes');
      if (s.text) sec.appendChild(UI.el('div', 'sheet-user-text', s.text));
      (s.images || []).filter(sheetImgOk).forEach(function (src) {
        var img = UI.el('img', 'sheet-img');
        img.src = src;
        img.alt = s.title || 'Your picture';
        img.addEventListener('load', function () { if (SHEET_OV) fitSheetOverlay(); });
        sec.appendChild(img);
      });
    });
  }
  if (!box.querySelector('.sheet-sec') && d) box.appendChild(UI.el('div', 'sheet-empty', 'Nothing for this act.'));
  if (d && !opts.noSource) box.appendChild(UI.el('div', 'sheet-foot', 'Game data: ' + d.source));
  return box;
}

// ---- overlay window (index.html?sheet=1) ----------------------------------------------------
function renderSheetOverlay() {
  var root = document.getElementById('sheet-root');
  if (!root) return;
  if (ovDrag) { setTimeout(renderSheetOverlay, 300); return; } // never rebuild the grip mid-drag
  var p = sheetPrefs();
  root.textContent = '';
  root.style.setProperty('--ov-opacity', String(Math.max(30, Math.min(100, p.opacity)) / 100));
  root.style.zoom = String(p.scale / 100);
  reportOverlay('sheet', sheetOpen);
  if (!sheetOpen) { fitSheetOverlay(); return; }
  var mech = p.sheet ? mechanicById(p.sheet) : null;
  var panel = UI.el('div', 'sheet-panel');
  if (mech) { // a mechanic's table sets its width (up to 900px); the act sheet keeps the Width setting
    panel.style.minWidth = Math.max(220, Math.min(640, p.width)) + 'px';
    panel.style.maxWidth = '900px';
  } else {
    panel.style.width = Math.max(220, Math.min(640, p.width)) + 'px';
  }
  var head = UI.el('div', 'sheet-head');
  var grip = overlayGrip(p, 'the cheat sheet', 'sheet', renderSheetOverlay);
  if (grip) head.appendChild(grip);
  if (mech) {
    head.appendChild(UI.iconButton('‹', 'Back to the act sheet', { size: 'sm', onClick: function () { sheetShow(null); } }));
    var mt = UI.el('span', 'sheet-title', mech.title);
    mt.title = 'Game data: ' + (mech.source || 'Path of Exile Wiki') + ' (CC BY-NC-SA 3.0)'; // the full credit line is in Tools → Cheat sheets
    head.appendChild(mt);
  } else {
    head.appendChild(UI.iconButton('‹', 'Previous act', { size: 'sm', onClick: function () { sheetStep(-1); } }));
    var title = UI.el('span', 'sheet-title', 'Act ' + p.act);
    var src = sheetData();
    if (src) title.title = 'Game data: ' + src.source; // the full credit line is in Tools → Cheat sheets
    if (p.follow) {
      var dot = UI.el('span', 'sheet-follow-dot');
      dot.title = 'Follows your act from the game log';
      title.appendChild(dot);
    }
    head.appendChild(title);
    head.appendChild(UI.iconButton('›', 'Next act', { size: 'sm', onClick: function () { sheetStep(1); } }));
  }
  if (sheetMechanics().length) {
    var pick = UI.iconButton('☰', sheetPicking ? 'Close the sheet list' : 'Other sheets: mechanics and acts',
      { size: 'sm', cls: sheetPicking ? 'is-on' : '', onClick: function () { sheetPicking = !sheetPicking; renderSheetOverlay(); } });
    head.appendChild(pick);
  }
  var hk = (overlayState.hotkeys || {}).sheet;
  head.appendChild(UI.iconButton('✕', 'Hide the cheat sheet' + (hk ? ' (' + hk + ' brings it back)' : ''),
    { size: 'sm', onClick: function () { sheetOpen = false; sheetPicking = false; renderSheetOverlay(); } }));
  panel.appendChild(head);
  var body = UI.el('div', 'sheet-body');
  body.style.maxHeight = Math.max(200, Math.min(1400, p.height)) + 'px';
  if (sheetPicking) body.appendChild(sheetPicker(function (id) { sheetPicking = false; sheetShow(id); }, p.sheet));
  else body.appendChild(mech ? mechanicContent(mech, { noSource: true }) : sheetContent(p.act, { noSource: true }));
  panel.appendChild(body);
  root.appendChild(panel);
  fitSheetOverlay();
}
var sheetPicking = false;

// the list of sheets: the act sheet, then each mechanic by group (click-only: no typing in game)
function sheetPicker(onPick, current) {
  var box = UI.el('div', 'sheet-picker');
  var acts = UI.el('button', 'sheet-pick' + (!current ? ' is-current' : ''), '📜 Leveling: act sheet');
  acts.type = 'button';
  acts.addEventListener('click', function () { onPick(null); });
  box.appendChild(acts);
  var groups = {};
  sheetMechanics().forEach(function (m) { (groups[m.group || 'Mechanics'] = groups[m.group || 'Mechanics'] || []).push(m); });
  Object.keys(groups).forEach(function (g) {
    box.appendChild(UI.el('div', 'sheet-sec-title', g));
    var row = UI.el('div', 'sheet-pick-row');
    groups[g].forEach(function (m) {
      var b = UI.el('button', 'sheet-pick' + (current === m.id ? ' is-current' : ''), m.title);
      b.type = 'button';
      b.addEventListener('click', function () { onPick(m.id); });
      row.appendChild(b);
    });
    box.appendChild(row);
  });
  return box;
}

// show the act sheet (id null or an act number) or a mechanic's sheet in the overlay
function sheetShow(id) {
  var p = sheetPrefs();
  var act = parseInt(id, 10);
  if (act >= 1 && act <= 10) { p.act = act; p.sheet = null; }
  else p.sheet = id && mechanicById(id) ? id : null;
  persist(SHEET_PREFS_KEY, JSON.stringify(p));
  renderSheetOverlay();
}

function sheetStep(d) {
  var p = sheetPrefs();
  p.act = Math.max(1, Math.min(10, p.act + d));
  persist(SHEET_PREFS_KEY, JSON.stringify(p));
  renderSheetOverlay();
}

// ---- the suggestion pill (index.html?sheethint=1) ----------------------------------------------
var hintFor = null;      // the mechanic being suggested
var hintTimer = null;
var hintLast = null;     // don't suggest the same mechanic again until you've been elsewhere
var HINT_SECONDS = 20;
function renderSheetHint() {
  var root = document.getElementById('sheet-root');
  if (!root) return;
  if (ovDrag) { setTimeout(renderSheetHint, 300); return; }
  var p = sheetPrefs();
  root.textContent = '';
  root.style.setProperty('--ov-opacity', String(Math.max(30, Math.min(100, p.opacity)) / 100));
  root.style.zoom = String(p.scale / 100);
  reportOverlay('hint', !!hintFor);
  if (hintFor) {
    var pill = UI.el('div', 'sheet-hint');
    var grip = overlayGrip(p, 'the sheet suggestion', 'hint', renderSheetHint);
    if (grip) pill.appendChild(grip);
    pill.appendChild(UI.el('span', 'sheet-hint-text', '📜 ' + hintFor.title + ' cheat sheet'));
    var m = hintFor;
    pill.appendChild(UI.button('primary', { size: 'sm', label: 'Open', onClick: function () {
      if (window.pywebview.api.overlay_sheet_open) window.pywebview.api.overlay_sheet_open(m.id);
      sheetHintClear();
    } }));
    pill.appendChild(UI.iconButton('🔕', 'Don\'t suggest ' + m.title + ' again (Tools → Cheat sheets to undo)', { size: 'sm',
      onClick: function () {
        var q = sheetPrefs();
        if (q.muted.indexOf(m.id) === -1) q.muted.push(m.id);
        saveSheetPrefs(q);
        sheetHintClear();
      } }));
    pill.appendChild(UI.iconButton('✕', 'Not now', { size: 'sm', onClick: sheetHintClear }));
    root.appendChild(pill);
  }
  fitSheetOverlay('hint', '.sheet-hint');
}
function sheetHintClear() {
  hintFor = null;
  clearTimeout(hintTimer);
  renderSheetHint();
}
function sheetHintFor(ev) {
  var p = sheetPrefs();
  if (!ev.test && !(p.suggest && (p.follow || tradePrefs().enabled))) return false;
  if (ev.type !== 'area' && ev.type !== 'zone') return false;
  var m = sheetMatch(ev);
  if (!m) { if (ev.type === 'area') hintLast = null; return false; } // left the mechanic's areas
  if (!ev.test && (p.muted.indexOf(m.id) !== -1 || hintLast === m.id)) return false;
  hintLast = m.id;
  hintFor = m;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(sheetHintClear, HINT_SECONDS * 1000); // it goes away on its own
  renderSheetHint();
  return true;
}

// size the window to the drawn piece and clip it to that shape (see-through elsewhere)
function fitSheetOverlay(name, selector) {
  name = name || 'sheet';
  if (!isGui() || !window.pywebview.api.overlay_fit) return;
  requestAnimationFrame(function () {
    var root = document.getElementById('sheet-root');
    if (!root) return;
    // rects already include the CSS zoom (as in fitOverlay, 19-trades.js)
    var r = root.getBoundingClientRect();
    window.pywebview.api.overlay_fit(name, Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
    var panel = root.querySelector(selector || '.sheet-panel');
    if (!panel || !window.pywebview.api.overlay_shape) return;
    var b = panel.getBoundingClientRect();
    var rad = Math.min(parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0, b.height / 2); // the pill is round
    window.pywebview.api.overlay_shape(name, [[Math.floor(b.left), Math.floor(b.top),
      Math.ceil(b.width), Math.ceil(b.height), Math.round(rad * (parseFloat(root.style.zoom) || 1))]]);
  });
}

// hotkey / "Show in game" (via gui.py)
window.__sheetToggle = function () {
  if (!SHEET_OV || SHEET_HINT) return false;
  sheetOpen = !sheetOpen;
  sheetPicking = false;
  renderSheetOverlay();
  return sheetOpen;
};
// the hint's Open (via gui.py): show that sheet (a mechanic id or an act number)
window.__sheetOpen = function (id) {
  if (!SHEET_OV || SHEET_HINT) return false;
  sheetOpen = true;
  sheetPicking = false;
  sheetShow(id);
  return true;
};
// area / zone lines from Client.txt (via gui.py); test mode's made-up ones always count
window.__sheetEvent = function (ev) {
  if (!SHEET_OV || !ev) return false;
  if (typeof ev === 'string') { try { ev = JSON.parse(ev); } catch (e) { return false; } }
  if (SHEET_HINT) return sheetHintFor(ev);
  var p = sheetPrefs();
  if (!ev.test && !p.follow) return false;
  if (ev.type === 'zone') {
    sheetArea = ev.area;
  } else if (ev.type === 'area' && ev.act) {
    var changed = ev.act !== p.act;
    p.act = ev.act;
    if (changed && (p.autoOpen || ev.test)) { sheetOpen = true; p.sheet = null; } // a new act: its sheet
    if (changed) persist(SHEET_PREFS_KEY, JSON.stringify(p));
  } else {
    return false;
  }
  renderSheetOverlay();
  return true;
};
// a setting or a sheet changed in the main window: re-read it here
window.__sheetPrefsChanged = async function () {
  if (!SHEET_OV) return false;
  if (sheetHydrate) { try { await sheetHydrate(); } catch (e) { /* keep */ } }
  overlayWanted = null;
  sheetRender();
  return true;
};
function sheetRender() { if (SHEET_HINT) renderSheetHint(); else renderSheetOverlay(); }

var sheetHydrate = null;
function sheetReady(hydrate) { // markGui() in the sheet / hint overlay windows (02-init.js)
  document.body.classList.add('gui');
  sheetHydrate = hydrate;
  Promise.resolve(hydrate()).then(sheetStatusLoop, sheetStatusLoop);
  sheetSync(sheetRender);
}
function sheetStatusLoop() {
  refreshSheetStatus();
  setInterval(refreshSheetStatus, 10000);
}
async function refreshSheetStatus() { // hotkey labels for the tooltips
  if (isGui() && window.pywebview.api.overlay_status) {
    try { var st = await window.pywebview.api.overlay_status(); if (st && st.ok) overlayState = st; } catch (e) { /* keep */ }
  }
  sheetRender();
}

// ---- main window: Tools → Cheat sheets ------------------------------------------------------
var sheetViewBack = null;
function openSheetsView() {
  var cur = document.body.dataset.view;
  if (cur && cur !== 'sheets') sheetViewBack = cur;
  setView('sheets');
  window.scrollTo(0, 0);
}
function sheetsClose() { setView(build ? (sheetViewBack || 'gear') : ''); }

function renderSheetsView() {
  var view = document.getElementById('view-sheets');
  if (!view) return;
  var p = sheetPrefs();
  if (sheetViewAct === null) sheetViewAct = p.act;
  view.textContent = '';
  var page = UI.el('div', 'sheets-page');
  var bar = UI.el('div', 'trades-bar');
  bar.appendChild(UI.button('ghost', { size: 'sm', label: '← Back', onClick: sheetsClose, title: 'Back to where you were (Esc)' }));
  bar.appendChild(UI.el('span', 'ov-title', 'Cheat sheets'));
  page.appendChild(bar);
  page.appendChild(UI.el('p', 'finder-sub', 'Sheets over the game: one for each act (skill point quests, trials, bandits, ' +
    'resistance penalties), one for each mechanic (Betrayal, Blight, Delve, …), and your own notes and pictures. Open it ' +
    'in game with its hotkey; entering a mechanic\'s area offers its sheet in a small pop-up.'));
  if (isGui()) page.appendChild(renderSheetGameControls(p));
  sheetSync(renderSheetsView); // newer sheets from the server, if there are any

  // mechanics: pick one to preview it
  var mechs = sheetMechanics();
  if (mechs.length) {
    var mcol = UI.el('div', 'sheets-mech');
    mcol.appendChild(UI.el('h3', 'trade-h3', 'Mechanics'));
    mcol.appendChild(sheetPicker(function (id) { sheetViewMech = id; renderSheetsView(); }, sheetViewMech || ''));
    page.appendChild(mcol);
  }
  var vm = sheetViewMech ? mechanicById(sheetViewMech) : null;
  if (vm) {
    var mprev = UI.el('div', 'sheets-col');
    var mh = UI.el('div', 'trade-row');
    mh.appendChild(UI.el('h3', 'trade-h3', vm.title));
    if (isGui() && window.pywebview.api.overlay_sheet_open) {
      mh.appendChild(UI.button('primary', { size: 'sm', label: 'Show in game', title: 'Opens this sheet over the game',
        onClick: function () { window.pywebview.api.overlay_sheet_open(vm.id); UI.toast('Switch to the game to see it', 'info'); } }));
    }
    var muted = p.muted.indexOf(vm.id) !== -1;
    if ((vm.match || {}).areaIds && (vm.match.areaIds.length || (vm.match.areaNames || []).length)) {
      mh.appendChild(sheetToggle('Suggest it in its areas', !muted, function (on) {
        var q = sheetPrefs();
        q.muted = q.muted.filter(function (x) { return x !== vm.id; });
        if (!on) q.muted.push(vm.id);
        saveSheetPrefs(q);
      }));
    }
    mh.appendChild(UI.button('ghost', { size: 'sm', label: '← Act sheets', onClick: function () { sheetViewMech = null; renderSheetsView(); } }));
    mprev.appendChild(mh);
    var mcard = UI.el('div', 'sheet-panel is-preview is-mech');
    mcard.appendChild(mechanicContent(vm));
    mprev.appendChild(mcard);
    page.appendChild(mprev);
    view.appendChild(page);
    return;
  }

  // preview: the same sheet the game shows
  var acts = UI.el('div', 'sheet-acts');
  acts.setAttribute('role', 'tablist');
  for (var i = 1; i <= 10; i++) {
    (function (n) {
      var b = UI.el('button', 'sheet-act-btn', String(n));
      b.type = 'button';
      b.title = 'Act ' + n;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', n === sheetViewAct ? 'true' : 'false');
      b.addEventListener('click', function () { sheetViewAct = n; renderSheetsView(); });
      acts.appendChild(b);
    })(i);
  }
  var prev = UI.el('div', 'sheets-col');
  prev.appendChild(UI.el('h3', 'trade-h3', 'Act ' + sheetViewAct));
  prev.appendChild(acts);
  var card = UI.el('div', 'sheet-panel is-preview');
  card.appendChild(sheetContent(sheetViewAct));
  prev.appendChild(card);
  var shows = UI.el('div', 'trade-row');
  [['points', 'Quests'], ['trials', 'Trials'], ['notes', 'Bandits & penalties'], ['mine', 'Your sheets']].forEach(function (s) {
    shows.appendChild(sheetToggle(s[1], p.show[s[0]], function (on) {
      var q = sheetPrefs(); q.show[s[0]] = on; saveSheetPrefs(q); renderSheetsView();
    }));
  });
  prev.appendChild(shows);

  var mine = UI.el('div', 'sheets-col');
  mine.appendChild(UI.el('h3', 'trade-h3', 'Your sheets'));
  renderSheetList(mine);

  var cols = UI.el('div', 'sheets-cols');
  cols.appendChild(prev);
  cols.appendChild(mine);
  page.appendChild(cols);
  view.appendChild(page);
}

function sheetToggle(label, on, onChange) {
  var w = UI.el('label', 'toggle');
  var c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = !!on;
  c.addEventListener('change', function () { onChange(c.checked); });
  w.appendChild(c);
  w.appendChild(UI.el('span', null, label));
  return w;
}

function renderSheetGameControls(p) {
  var api = window.pywebview.api;
  var box = UI.el('div', 'sheet-controls');
  box.appendChild(UI.el('h3', 'trade-h3', 'In game'));
  var row = UI.el('div', 'trade-row');
  var hk = PREFS.hotkeySheet || 'alt+c';
  row.appendChild(UI.button('primary', { size: 'sm', label: 'Show / hide in game',
    title: 'Same as ' + (hk === 'off' ? 'its hotkey (off: Settings → In game)' : hk.toUpperCase()) + ' in game',
    onClick: function () { if (api.overlay_toggle_sheet) api.overlay_toggle_sheet(); } }));
  row.appendChild(UI.el('span', 'finder-sub', hk === 'off' ? 'Hotkey off (Settings → In game)' : 'Hotkey: ' + hk.replace(/\b\w/g, function (c) { return c.toUpperCase(); })));
  box.appendChild(row);

  var follow = UI.el('div', 'trade-row');
  follow.appendChild(sheetToggle('Follow my act from the game log', p.follow, async function (on) {
    var q = sheetPrefs();
    if (on && !q.ack) {
      var ok = await UI.dialog({ title: 'Follow your act?',
        body: 'The app will read Path of Exile\'s log file (Client.txt) on this PC while it runs, to see which act ' +
          'you are in and turn the sheet to it. It stays on this computer and sends nothing to the game.',
        confirmLabel: 'Follow my act' });
      if (!ok) { renderSheetsView(); return; }
      q.ack = true;
    }
    q.follow = on;
    saveSheetPrefs(q);
    renderSheetsView();
  }));
  follow.appendChild(sheetToggle('Open it when a new act starts', p.autoOpen, function (on) {
    var q = sheetPrefs(); q.autoOpen = on; saveSheetPrefs(q);
  }));
  follow.appendChild(sheetToggle('Suggest a mechanic\'s sheet in its areas', p.suggest, function (on) {
    var q = sheetPrefs(); q.suggest = on; saveSheetPrefs(q);
  }));
  if (p.muted.length) {
    follow.appendChild(UI.button('ghost', { size: 'sm', label: 'Suggest all again (' + p.muted.length + ' off)',
      onClick: function () { var q = sheetPrefs(); q.muted = []; saveSheetPrefs(q); renderSheetsView(); } }));
  }
  box.appendChild(follow);
  box.appendChild(UI.el('p', 'finder-sub', 'Following your act and the suggestions read the game log; the suggestions ' +
    'also work while the trade helper is on. A suggestion is a small pop-up at the top of the game for ' + HINT_SECONDS +
    ' seconds: Open shows the sheet, 🔕 stops it for that mechanic. Drag it by ⠿ to put it elsewhere.'));

  function slider(label, value, min, max, step, unit, key) {
    var r = UI.input({ type: 'range', min: min, max: max, step: step, value: value, ariaLabel: label, cls: 'trade-slider' });
    var v = UI.el('span', 'slider-val', value + unit);
    r.addEventListener('input', function () { v.textContent = r.value + unit; });
    r.addEventListener('change', function () { var q = sheetPrefs(); q[key] = parseInt(r.value, 10); saveSheetPrefs(q); });
    var f = UI.field(label, r);
    f.appendChild(v);
    return f;
  }
  var look = UI.el('div', 'trade-row');
  look.appendChild(slider('Width', p.width, 220, 640, 20, 'px', 'width'));
  look.appendChild(slider('Max height', p.height, 200, 1400, 20, 'px', 'height'));
  look.appendChild(slider('Size', p.scale, 70, 150, 5, '%', 'scale'));
  look.appendChild(slider('Opacity', p.opacity, 30, 100, 5, '%', 'opacity'));
  box.appendChild(look);

  var more = UI.el('div', 'trade-row');
  more.appendChild(sheetToggle('📌 Lock in place', p.locked, function (on) { var q = sheetPrefs(); q.locked = on; saveSheetPrefs(q); }));
  more.appendChild(UI.button('ghost', { size: 'sm', label: 'Reset position',
    onClick: function () { if (api.overlay_reset_pos) api.overlay_reset_pos('sheet'); UI.toast('Back to its first spot next time it shows', 'info'); } }));
  if (api.trade_test) { // test mode: pretend the game started an act
    var actSel = UI.select([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return [String(n), 'Act ' + n]; }), String(sheetViewAct),
      { ariaLabel: 'Act to test' });
    more.appendChild(UI.field('Test', actSel, { title: 'Pretends the game entered that act: the sheet in game turns to it and opens' }));
    var go = UI.button('ghost', { size: 'sm', label: '▶ Pretend I entered it', onClick: function () {
      Promise.resolve(api.trade_test('act', null, parseInt(actSel.value, 10))).then(function (r) {
        UI.toast(r && r.ok ? 'Switch to the game to see the sheet' : 'Test failed: ' + ((r && r.error) || 'no answer'), r && r.ok ? 'info' : 'danger');
      });
    } });
    more.appendChild(go);
    // a mechanic's area: the suggestion pop-up should appear at the top of the game
    var withArea = sheetMechanics().filter(function (m) {
      var mt = m.match || {};
      return (mt.areaNames || []).length || (mt.areaIds || []).length;
    });
    if (withArea.length) {
      var mSel = UI.select(withArea.map(function (m) { return [m.id, m.title]; }), withArea[0].id, { ariaLabel: 'Mechanic to test' });
      more.appendChild(UI.field('Test', mSel, { title: 'Pretends you entered that mechanic\'s area: the suggestion pops up in game' }));
      var goM = UI.button('ghost', { size: 'sm', label: '▶ Pretend I entered its area', onClick: function () {
        var mt = mechanicById(mSel.value).match || {};
        var area = (mt.areaNames || [])[0] || (mt.areaIds || [])[0];
        Promise.resolve(api.trade_test('enter', null, null, area)).then(function (r) {
          UI.toast(r && r.ok ? 'Switch to the game to see the suggestion' : 'Test failed: ' + ((r && r.error) || 'no answer'), r && r.ok ? 'info' : 'danger');
        });
      } });
      more.appendChild(goM);
    }
  }
  box.appendChild(more);
  return box;
}

function renderSheetList(col) {
  var list = loadSheets();
  if (!list.length && sheetEditing === null) {
    col.appendChild(UI.el('p', 'finder-sub', 'Your own notes for an act (or every act): a route, a reminder, a picture of a ' +
      'map or a passive tree. They show under the built-in part.'));
  }
  list.forEach(function (s) {
    if (sheetEditing === s.id) { col.appendChild(sheetEditor(s)); return; }
    var row = UI.el('div', 'sheet-row');
    var t = UI.el('div', 'sheet-row-main');
    t.appendChild(UI.el('b', null, s.title || 'Untitled'));
    t.appendChild(UI.el('span', 'finder-sub', (s.act ? 'Act ' + s.act : 'Every act') +
      ((s.images || []).length ? ' · ' + s.images.length + ' picture' + (s.images.length > 1 ? 's' : '') : '')));
    row.appendChild(t);
    row.appendChild(UI.button('ghost', { size: 'sm', label: 'Edit', onClick: function () { sheetEditing = s.id; renderSheetsView(); } }));
    col.appendChild(row);
  });
  if (sheetEditing === 'new') col.appendChild(sheetEditor({ id: 'new', title: '', act: sheetViewAct, text: '', images: [] }));
  else col.appendChild(UI.button('secondary', { size: 'sm', label: '+ New sheet', onClick: function () { sheetEditing = 'new'; renderSheetsView(); } }));
}

function sheetEditor(s) {
  var draft = { title: s.title || '', act: s.act || 0, text: s.text || '', images: (s.images || []).slice() };
  var box = UI.el('div', 'sheet-editor');
  var title = UI.input({ placeholder: 'Title, e.g. "Act 2 route"', value: draft.title, ariaLabel: 'Title', cls: 'sheet-title-input' });
  box.appendChild(UI.field('Title', title));
  var acts = [['0', 'Every act']].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return [String(n), 'Act ' + n]; }));
  var act = UI.select(acts, String(draft.act), { ariaLabel: 'Shown for' });
  box.appendChild(UI.field('Shown for', act));
  var text = document.createElement('textarea');
  text.className = 'sheet-textarea';
  text.rows = 6;
  text.value = draft.text;
  text.placeholder = 'Your notes. Plain text; line breaks are kept.';
  text.setAttribute('aria-label', 'Notes');
  box.appendChild(text);
  var pics = UI.el('div', 'sheet-pics');
  function drawPics() {
    pics.textContent = '';
    draft.images.filter(sheetImgOk).forEach(function (src) {
      var w = UI.el('div', 'sheet-pic');
      var img = UI.el('img', 'sheet-img');
      img.src = src;
      img.alt = 'Picture';
      w.appendChild(img);
      w.appendChild(UI.iconButton('✕', 'Remove this picture', { size: 'sm', onClick: function () {
        draft.images = draft.images.filter(function (x) { return x !== src; });
        drawPics();
      } }));
      pics.appendChild(w);
    });
  }
  drawPics();
  box.appendChild(pics);
  var row = UI.el('div', 'trade-row');
  if (isGui() && window.pywebview.api.pick_sheet_image) {
    row.appendChild(UI.button('ghost', { size: 'sm', label: '🖼 Add picture…', onClick: async function () {
      var r = await window.pywebview.api.pick_sheet_image();
      if (r && r.ok && r.file) { draft.images.push(r.file); drawPics(); }
      else if (r && !r.ok) UI.toast(r.error || 'Could not add that picture', 'danger');
    } }));
  }
  row.appendChild(UI.button('primary', { size: 'sm', label: 'Save', onClick: function () {
    var list = loadSheets();
    var before = list.filter(function (x) { return x.id === s.id; })[0];
    var item = { id: s.id === 'new' ? 's' + Date.now().toString(36) : s.id, title: title.value.trim().slice(0, 80),
      act: parseInt(act.value, 10) || 0, text: text.value.slice(0, 20000), images: draft.images.filter(sheetImgOk) };
    if (before) list = list.map(function (x) { return x.id === s.id ? item : x; });
    else list.push(item);
    sheetDropImages(before ? before.images : [], item.images);
    saveSheets(list);
    sheetEditing = null;
    if (item.act) sheetViewAct = item.act;
    renderSheetsView();
  } }));
  row.appendChild(UI.button('ghost', { size: 'sm', label: 'Cancel', onClick: function () {
    var saved = loadSheets().filter(function (x) { return x.id === s.id; })[0];
    sheetDropImages(draft.images, saved ? saved.images : []); // pictures added and not saved
    sheetEditing = null;
    renderSheetsView();
  } }));
  if (s.id !== 'new') {
    row.appendChild(UI.button('danger', { size: 'sm', label: 'Delete', onClick: async function () {
      var ok = await UI.confirmDanger('Delete "' + (s.title || 'Untitled') + '"?', 'The sheet and its pictures are removed.', 'Delete');
      if (!ok) return;
      sheetDropImages(s.images || [], []);
      saveSheets(loadSheets().filter(function (x) { return x.id !== s.id; }));
      sheetEditing = null;
      renderSheetsView();
    } }));
  }
  box.appendChild(row);
  return box;
}

// pictures no longer used by a sheet: remove their copies from data/cheatsheets/
function sheetDropImages(before, after) {
  if (!isGui() || !window.pywebview.api.delete_sheet_image) return;
  var used = {};
  loadSheets().forEach(function (x) { (x.images || []).forEach(function (src) { used[src] = true; }); });
  (after || []).forEach(function (src) { used[src] = true; });
  (before || []).forEach(function (src) {
    if (!used[src] && sheetImgOk(src)) window.pywebview.api.delete_sheet_image(src);
  });
}

document.addEventListener('DOMContentLoaded', function () {
  if (SHEET_OV) {
    var root = UI.el('div', 'sheet-root');
    root.id = 'sheet-root';
    var container = document.querySelector('.container');
    container.insertBefore(root, container.firstChild);
    sheetRender();
    return;
  }
  var opener = document.getElementById('open-sheets');
  if (opener) opener.addEventListener('click', function () { closeSettings(); openSheetsView(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (document.body.dataset.view !== 'sheets' || document.body.classList.contains('over-game')) return;
    if (sheetEditing !== null) { sheetEditing = null; renderSheetsView(); return; }
    sheetsClose();
  });
});
// ==== end cheat sheets ==============================================================
