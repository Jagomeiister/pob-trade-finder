/* js/app/16-overlay.js — in-game price-check hotkey overlay.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ==== in-game price-check hotkey + overlay ======================================
// gui.py opens a second, always-on-top window on index.html?overlay=1 that
// shares the main window's Api instance (one GGG rate limiter). On the hotkey
// (default Ctrl+D, held only while Path of Exile is focused) Python copies the
// hovered item and calls window.__overlayItem(<item text>): the item goes
// through the normal pasted-item card and is priced automatically.
// Settings side: the "Price-check hotkey" select (PREFS.hotkey) in ⚙.
var OVERLAY = /[?&]overlay=1(&|$)/.test(location.search);
var overlayHydrate = null; // re-reads league/filters saved by the main window
var overlayLast = { text: '', at: 0 };
if (!PREFS.hotkey) PREFS.hotkey = 'ctrl+d'; // 'ctrl+d' | 'ctrl+shift+d' | 'alt+d' | 'off'
if (OVERLAY) document.body.classList.add('overlay');

// called from markGui() instead of the main window's startup work
function overlayReady(hydrate) {
  document.body.classList.add('gui');
  overlayHydrate = hydrate;
  hydrate();
}

function overlayNote(text) {
  var el = document.getElementById('overlay-meta');
  if (el) el.textContent = text;
}

// the price check has no title bar (gui.py _price_frameless): its banner moves it. Like the app
// over the game, only the latest offset is in flight at a time so the window keeps up.
function wirePriceOverlayDrag(bar) {
  var from = null, pending = null, sending = false;
  function send() {
    if (sending || !pending) return;
    sending = true;
    var d = pending; pending = null;
    Promise.resolve(window.pywebview.api.price_overlay_move(d[0], d[1], d[2])).then(function () { sending = false; send(); },
      function () { sending = false; });
  }
  bar.addEventListener('pointerdown', function (e) {
    if (!isGui() || !window.pywebview.api.price_overlay_move || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    from = { x: e.screenX, y: e.screenY };
    window.pywebview.api.price_overlay_move('start', 0, 0);
  });
  bar.addEventListener('pointermove', function (e) {
    if (!from) return;
    pending = ['move', e.screenX - from.x, e.screenY - from.y];
    send();
  });
  function end(e) {
    if (!from) return;
    pending = ['end', e.screenX - from.x, e.screenY - from.y];
    from = null;
    send();
  }
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

function overlayClose() {
  if (isGui() && window.pywebview.api.overlay_hide) window.pywebview.api.overlay_hide();
}

window.__overlayItem = async function (text) {
  if (!OVERLAY) return false;
  text = String(text || '').replace(/\r\n?/g, '\n').trim();
  var now = Date.now();
  // same item again within a minute with results showing: keep them, spare the API
  if (text === overlayLast.text && now - overlayLast.at < 60000 &&
      pastedState && pastedState.priceState) {
    ensureSoldWatcher();
    return true;
  }
  if (overlayHydrate) { try { await overlayHydrate(); } catch (e) { /* keep current settings */ } }
  var item = PoB.looksLikeGameItem(text) ? PoB.parseGameItem(text) : null;
  if (!item) { overlayNote('That item can\'t be priced here (PoE 1 items only)'); return false; }
  overlayLast = { text: text, at: now };
  renderPastedItem(item);
  var league = document.getElementById('league');
  var opt = league.options[league.selectedIndex];
  overlayNote((opt ? opt.textContent : league.value) + ' · Esc to close');
  window.scrollTo(0, 0);
  if (isGui()) checkPrice(pastedState);
  return true;
};

// overlay hidden: stop the 60s sold re-check so a hidden window costs no API calls
window.__overlayHidden = function () {
  if (soldWatcherTimer) { clearInterval(soldWatcherTimer); soldWatcherTimer = null; }
  return true;
};

function hotkeyStatusText(st) {
  if (!st || !st.ok) return '❌ ' + ((st && st.error) || 'hotkey unavailable');
  if (st.error) return '⚠ ' + st.error;
  if (st.hotkey === 'off') return 'off';
  return '✓ ' + st.label + ' prices the hovered item while Path of Exile is focused' +
    (st.active ? ' (active now)' : '');
}

function refreshHotkeyStatus(promise) {
  var el = document.getElementById('hotkey-status');
  if (!el || !isGui() || !window.pywebview.api.hotkey_status) return;
  (promise || window.pywebview.api.hotkey_status()).then(function (st) {
    el.textContent = hotkeyStatusText(st);
    if (!window.pywebview.api.hotkeys_status) return;
    return window.pywebview.api.hotkeys_status().then(function (all) {
      var errs = Object.keys((all && all.hotkeys) || {}).map(function (k) { return all.hotkeys[k].error; }).filter(Boolean);
      if (errs.length) el.textContent += ' · ⚠ ' + errs.join(' · ');
    });
  }, function () { /* bridge gone */ });
}

// Settings → In game: the other hotkeys (gui.py HOTKEY_DEFAULTS) and close-to-tray
var EXTRA_HOTKEYS = [['pref-hotkey-app', 'app', 'hotkeyApp', 'shift+space'],
                     ['pref-hotkey-trades', 'trades', 'hotkeyTrades', 'alt+t'],
                     ['pref-hotkey-sheet', 'sheet', 'hotkeySheet', 'alt+c']];
function wireExtraHotkeys() {
  EXTRA_HOTKEYS.forEach(function (h) {
    var sel = document.getElementById(h[0]);
    if (!sel) return;
    sel.value = PREFS[h[2]] || h[3];
    sel.addEventListener('change', async function () {
      var prev = PREFS[h[2]] || h[3];
      if (!isGui() || !window.pywebview.api.set_hotkey) return;
      var r = await window.pywebview.api.set_hotkey(h[1], this.value);
      if (r && r.ok === false) { UI.toast(r.error, 'warn'); this.value = prev; return; }
      PREFS[h[2]] = this.value;
      savePrefs();
      refreshHotkeyStatus();
    });
  });
  var op = document.getElementById('pref-over-opacity');
  if (op) {
    op.value = String(PREFS.overGameOpacity || 100);
    op.addEventListener('change', function () { PREFS.overGameOpacity = parseInt(this.value, 10); savePrefs(); });
  }
  var cog = document.getElementById('pref-close-on-game');
  if (cog) {
    cog.checked = PREFS.closeOnGameClick !== false;
    cog.addEventListener('change', function () { PREFS.closeOnGameClick = this.checked; savePrefs(); });
  }
  var tray = document.getElementById('pref-close-tray');
  if (tray) {
    tray.checked = PREFS.closeToTray !== false;
    tray.addEventListener('change', function () { PREFS.closeToTray = this.checked; savePrefs(); });
  }
}

// Settings → In game → Chat macros: one press (▶ or its hotkey) = one chat command. gui.py
// checks every command (one line starting with /) and only listens while the game is focused.
var MACRO_DEFAULTS = [{ label: 'Kingsmarch', command: '/kingsmarch', hotkey: 'off' },
                      { label: 'Menagerie', command: '/menagerie', hotkey: 'off' },
                      { label: 'Delve', command: '/delve', hotkey: 'off' },
                      { label: 'Log out', command: '/exit', hotkey: 'off' }];
var MACRO_KEYS = [['off', 'No hotkey'], ['f2', 'F2'], ['f3', 'F3'], ['f4', 'F4'], ['f5', 'F5'], ['f6', 'F6'],
                  ['alt+1', 'Alt+1'], ['alt+2', 'Alt+2'], ['alt+3', 'Alt+3'], ['alt+4', 'Alt+4'], ['alt+5', 'Alt+5'],
                  ['ctrl+shift+1', 'Ctrl+Shift+1'], ['ctrl+shift+2', 'Ctrl+Shift+2'], ['ctrl+shift+3', 'Ctrl+Shift+3']];
var MACRO_RE = /^\/[A-Za-z_]{1,40}( [^\r\n]{1,200})?$/;
var MAX_MACROS = 12;

function loadMacros() {
  return (Array.isArray(PREFS.macros) ? PREFS.macros : MACRO_DEFAULTS).map(function (m) { return Object.assign({}, m); });
}

async function saveMacros(list) {
  PREFS.macros = list;
  savePrefs();
  if (!isGui() || !window.pywebview.api.set_macros) return true;
  var r = await window.pywebview.api.set_macros(JSON.stringify(list.filter(function (m) { return MACRO_RE.test(m.command); })));
  if (!r || r.ok === false) { UI.toast((r && r.error) || 'Couldn\'t save the macros', 'warn'); return false; }
  if (r.errors && r.errors.length) {
    UI.toast(r.errors.join(' · '), 'warn');
    // a clashing hotkey comes back as "off"
    list.forEach(function (m) {
      var back = r.macros.find(function (x) { return x.command === m.command; });
      if (back) m.hotkey = back.hotkey;
    });
    PREFS.macros = list;
    savePrefs();
    renderMacros();
    return false;
  }
  return true;
}

function renderMacros() {
  var box = document.getElementById('macro-list');
  if (!box) return;
  box.textContent = '';
  var list = loadMacros();
  list.forEach(function (m, i) {
    var row = UI.el('div', 'macro-row');
    var cmd = UI.input({ value: m.command, cls: 'macro-cmd', ariaLabel: 'Chat command ' + (i + 1), placeholder: '/command' });
    cmd.spellcheck = false;
    cmd.addEventListener('change', function () {
      var v = cmd.value.trim();
      var ok = MACRO_RE.test(v);
      cmd.classList.toggle('invalid', !ok);
      cmd.title = ok ? '' : 'One chat command starting with /, e.g. /delve';
      if (!ok) return;
      list[i] = { label: v, command: v, hotkey: list[i].hotkey };
      saveMacros(list);
    });
    var key = UI.select(MACRO_KEYS, m.hotkey || 'off', { ariaLabel: 'Hotkey for ' + m.command, onChange: function () {
      list[i].hotkey = key.value;
      saveMacros(list);
    } });
    var send = UI.iconButton('▶', 'Send ' + m.command + ' to the game', { variant: 'secondary', size: 'sm',
      onClick: async function () {
        if (!isGui() || !window.pywebview.api.chat_macro) return;
        var r = await window.pywebview.api.chat_macro(list[i].command);
        if (r && r.ok === false) UI.toast(r.error, 'warn');
      } });
    var del = UI.iconButton('✕', 'Remove ' + m.command, { size: 'sm', onClick: function () {
      UI.confirmDanger('Remove this macro?', list[i].command + (list[i].hotkey !== 'off' ? ' (hotkey ' + list[i].hotkey + ')' : ''), 'Remove')
        .then(function (yes) {
          if (!yes) return;
          list.splice(i, 1);
          saveMacros(list).then(renderMacros);
        });
    } });
    [cmd, key, send, del].forEach(function (e) { row.appendChild(e); });
    box.appendChild(row);
  });
  var add = document.getElementById('macro-add');
  if (add) add.disabled = list.length >= MAX_MACROS;
}

function wireMacros() {
  renderMacros();
  var add = document.getElementById('macro-add');
  if (add) add.addEventListener('click', function () {
    var list = loadMacros();
    if (list.length >= MAX_MACROS) return;
    list.push({ label: '', command: '', hotkey: 'off' }); // saved once it holds a real command
    PREFS.macros = list;
    savePrefs();
    renderMacros();
    var inputs = document.querySelectorAll('#macro-list .macro-cmd');
    var last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  });
  // first run: gui.py reads PREFS.macros at start; tell it about the defaults too
  if (!Array.isArray(PREFS.macros) && isGui() && window.pywebview.api.set_macros) saveMacros(loadMacros());
}

// App hotkey (default Shift+Space): gui.py brings this window over the game and calls this.
// Esc, ✕ on the banner, or the hotkey again puts it back and returns to the game.
var appOverGame = false;
// drag the banner to move the app over the game (gui.py moves the window and remembers it)
function wireAppOverlayDrag(el) {
  var from = null, pending = null, sending = false;
  function send() {
    if (sending || !pending) return;
    sending = true;
    var d = pending; pending = null;
    Promise.resolve(window.pywebview.api.app_overlay_move('move', d[0], d[1])).then(function () { sending = false; send(); },
      function () { sending = false; });
  }
  el.addEventListener('pointerdown', function (e) {
    if (!isGui() || !window.pywebview.api.app_overlay_move || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    from = { x: e.screenX, y: e.screenY };
    window.pywebview.api.app_overlay_move('start', 0, 0);
  });
  el.addEventListener('pointermove', function (e) {
    if (!from) return;
    pending = [e.screenX - from.x, e.screenY - from.y];
    send();
  });
  function drop(e) {
    if (!from) return;
    var dx = e.screenX - from.x, dy = e.screenY - from.y;
    from = null; pending = null;
    window.pywebview.api.app_overlay_move('end', dx, dy);
  }
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
}

window.__appOverlay = function (on) {
  appOverGame = !!on;
  document.body.classList.toggle('over-game', appOverGame);
  var bar = document.getElementById('over-game-bar');
  if (appOverGame && !bar) {
    bar = UI.el('div', 'over-game-bar');
    bar.id = 'over-game-bar';
    var keyName = (document.getElementById('pref-hotkey-app') || {}).selectedOptions;
    var grip = UI.el('span', 'over-game-grip', '⠿ 🎮 Over the game · Esc, ' +
      (keyName && keyName[0] ? keyName[0].textContent : 'the hotkey') + ' or a click in the game to go back');
    grip.title = 'Drag to move. Resize from the window\'s edges, or with − / +.';
    wireAppOverlayDrag(grip);
    bar.appendChild(grip);
    bar.appendChild(UI.iconButton('−', 'Smaller', { size: 'sm', onClick: function () { window.pywebview.api.app_overlay_size(-1); } }));
    bar.appendChild(UI.iconButton('+', 'Larger', { size: 'sm', onClick: function () { window.pywebview.api.app_overlay_size(1); } }));
    bar.appendChild(UI.button('secondary', { size: 'sm', label: 'Back to the game',
      onClick: function () { window.pywebview.api.app_overlay(false); } }));
    document.body.insertBefore(bar, document.body.firstChild);
  } else if (!appOverGame && bar) {
    bar.remove();
  }
  return true;
};

document.addEventListener('DOMContentLoaded', function () {
  var sel = document.getElementById('pref-hotkey');
  if (sel) {
    sel.value = PREFS.hotkey;
    sel.addEventListener('change', function () {
      PREFS.hotkey = this.value;
      savePrefs();
      if (isGui() && window.pywebview.api.set_price_hotkey) {
        refreshHotkeyStatus(window.pywebview.api.set_price_hotkey(this.value));
      }
    });
    ['settings-btn', 'settings-btn-side'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function () { refreshHotkeyStatus(); });
    });
  }
  wireExtraHotkeys();
  wireMacros();
  var forget = document.getElementById('forget-habits');
  if (forget) forget.addEventListener('click', forgetFilterHabits);
  document.addEventListener('keydown', function (e) {
    // over the game: Esc goes back (unless a dialog, menu or the settings panel wants it first)
    if (!appOverGame || e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
    var settingsOpen = !document.getElementById('settings-panel').classList.contains('hidden');
    if (settingsOpen) return;
    window.pywebview.api.app_overlay(false);
  });
  if (!OVERLAY) return;
  var bar = document.createElement('div');
  bar.id = 'overlay-bar';
  bar.title = 'Drag to move';
  bar.innerHTML = '<span class="ov-grip" aria-hidden="true">⠿</span><span class="ov-title">Price check</span>' +
    '<span id="overlay-meta" class="ov-meta">Hover an item in Path of Exile and press the hotkey</span>' +
    '<button id="overlay-close" class="btn btn-ghost btn-icon btn-sm" aria-label="Close price check" title="Close (Esc)">✕</button>';
  var container = document.querySelector('.container');
  container.insertBefore(bar, container.firstChild);
  wirePriceOverlayDrag(bar);
  document.getElementById('overlay-close').addEventListener('click', overlayClose);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented) overlayClose();
  });
});
// ==== end price-check overlay ===================================================
