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
  }, function () { /* bridge gone */ });
}

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
  if (!OVERLAY) return;
  var bar = document.createElement('div');
  bar.id = 'overlay-bar';
  bar.innerHTML = '<span class="ov-title">Price check</span>' +
    '<span id="overlay-meta" class="ov-meta">Hover an item in Path of Exile and press the hotkey</span>' +
    '<button id="overlay-close" class="btn btn-ghost btn-icon btn-sm" aria-label="Close price check" title="Close (Esc)">✕</button>';
  var container = document.querySelector('.container');
  container.insertBefore(bar, container.firstChild);
  document.getElementById('overlay-close').addEventListener('click', overlayClose);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented) overlayClose();
  });
});
// ==== end price-check overlay ===================================================
