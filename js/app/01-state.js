/* js/app/01-state.js — shared state, error log, slot categories, preferences, settings persistence.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

var statIndex = null;
var leagues = [];
var build = null;         // parsed build
var cards = [];           // per-item UI state

// ---- recent errors, for Settings → Copy diagnostics ------------------------------
var RECENT_ERRORS = [];
function noteError(msg) {
  RECENT_ERRORS.push(new Date().toLocaleTimeString() + ' ' + String(msg).slice(0, 300));
  if (RECENT_ERRORS.length > 15) RECENT_ERRORS.shift();
}
window.addEventListener('error', function (e) {
  noteError('JS error: ' + e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
});
window.addEventListener('unhandledrejection', function (e) {
  noteError('JS error (async): ' + ((e.reason && e.reason.message) || e.reason));
});
var uiToast = UI.toast; // warnings and errors the user was shown
UI.toast = function (message, tone, opts) {
  if (tone === 'danger' || tone === 'warn') noteError('shown: ' + message);
  return uiToast(message, tone, opts);
};

// ---- slot -> trade category ---------------------------------------------
var SLOT_CATEGORY = {
  'Helmet': 'armour.helmet',
  'Body Armour': 'armour.chest',
  'Gloves': 'armour.gloves',
  'Boots': 'armour.boots',
  'Amulet': 'accessory.amulet',
  'Ring 1': 'accessory.ring',
  'Ring 2': 'accessory.ring',
  'Belt': 'accessory.belt'
};
var INFLUENCE_KEY = {
  'Shaper': 'shaper_item', 'Elder': 'elder_item', 'Crusader': 'crusader_item',
  'Redeemer': 'redeemer_item', 'Hunter': 'hunter_item', 'Warlord': 'warlord_item',
  'Searing Exarch': 'searing_item', 'Eater of Worlds': 'tangled_item'
};
// Cluster stats where the roll must match exactly, not "at least"
var EXACT_COUNT_TEXTS = {
  'Adds # Passive Skills': true,
  '# Added Passive Skills are Jewel Sockets': true
};

function categoryFor(slot, item) {
  if (SLOT_CATEGORY[slot]) return SLOT_CATEGORY[slot];
  var base = (item.base || '').toLowerCase();
  if (/quiver/.test(base)) return 'armour.quiver';
  if (/shield|buckler|bundle/.test(base)) return 'armour.shield';
  if (/cluster jewel/.test(base)) return 'jewel.cluster';
  if (/eye jewel/.test(base)) return 'jewel.abyss';
  if (/jewel/.test(base)) return 'jewel.base';
  if (/flask/.test(base)) return 'flask';
  if (/tincture/.test(base)) return 'tincture';
  return null; // weapons: rely on base-type filter instead
}

function rarityClass(r) {
  return { UNIQUE: 'unique', RARE: 'rare', MAGIC: 'magic', RELIC: 'unique' }[r] || 'normal';
}

function isGui() {
  return !!(window.pywebview && window.pywebview.api);
}

// ---- user preferences (text size, density, sound, accessibility) ---------
var PREFS = { fontsize: '100', density: 'comfortable', sound: true, notify: true,
              volume: 25, motion: false, contrast: false, cb: false, theme: 'dark', accent: 'gold' };
// pre-2.0 colour schemes → base theme + accent (docs/UI-PLAN.md §3)
var LEGACY_THEMES = { classic: ['dark', 'gold'], obsidian: ['dark', 'teal'], midnight: ['dark', 'violet'],
                      blood: ['dark', 'crimson'], forest: ['dark', 'green'] };

function migratePrefs() {
  var old = LEGACY_THEMES[PREFS.theme];
  if (old) { PREFS.theme = old[0]; PREFS.accent = old[1]; }
  if (['dark', 'light', 'system'].indexOf(PREFS.theme) < 0) PREFS.theme = 'dark';
}

function loadPrefs() {
  try {
    var p = JSON.parse(localStorage.getItem('pobtf-prefs'));
    if (p) Object.keys(PREFS).forEach(function (k) { if (k in p) PREFS[k] = p[k]; });
  } catch (e) { /* defaults */ }
  migratePrefs();
}

var LIGHT_QUERY = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function applyPrefs() {
  migratePrefs(); // prefs hydrated from the desktop store can still carry old names
  var root = document.documentElement;
  var light = PREFS.theme === 'light' || (PREFS.theme === 'system' && LIGHT_QUERY && LIGHT_QUERY.matches);
  if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
  if (PREFS.accent && PREFS.accent !== 'gold') root.dataset.accent = PREFS.accent; else delete root.dataset.accent;
  if (PREFS.contrast) root.dataset.contrast = 'high'; else delete root.dataset.contrast;
  var zoom = (parseInt(PREFS.fontsize, 10) || 100) / 100;
  document.body.style.zoom = zoom;
  root.style.setProperty('--zoom', zoom); // css/layout.css: viewport-tall pieces divide by it
  document.body.classList.toggle('compact', PREFS.density === 'compact');
  document.body.classList.toggle('reduce-motion', !!PREFS.motion);
  document.body.classList.toggle('cb-sockets', !!PREFS.cb);
  var ids = { 'pref-theme': PREFS.theme, 'pref-accent': PREFS.accent,
              'pref-fontsize': PREFS.fontsize, 'pref-density': PREFS.density };
  Object.keys(ids).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = ids[id];
  });
  var s = document.getElementById('pref-sound'); if (s) s.checked = !!PREFS.sound;
  var nt = document.getElementById('pref-notify'); if (nt) nt.checked = PREFS.notify !== false;
  var v = document.getElementById('pref-volume'); if (v) v.value = PREFS.volume;
  var m = document.getElementById('pref-motion'); if (m) m.checked = !!PREFS.motion;
  var c = document.getElementById('pref-contrast'); if (c) c.checked = !!PREFS.contrast;
  var cb = document.getElementById('pref-cb'); if (cb) cb.checked = !!PREFS.cb;
  var hk = document.getElementById('pref-hotkey'); if (hk) hk.value = PREFS.hotkey || 'ctrl+d';
}

function savePrefs() {
  persist('pobtf-prefs', JSON.stringify(PREFS));
}

// ---- settings persistence ----------------------------------------------
// localStorage is the live cache; the Python bridge is the durable copy
// (the exe's WebView2 storage does not survive restarts reliably)
var SETTINGS_KEY = 'pobtf-settings';
function persist(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* fine */ }
  if (isGui() && window.pywebview.api.storage_set) {
    window.pywebview.api.storage_set(key, value).then(function () {}, function () {});
  }
}
function saveSettings() {
  try {
    persist(SETTINGS_KEY, JSON.stringify({
      league: document.getElementById('league').value,
      status: document.getElementById('trade-status').value,
      saleType: document.getElementById('sale-type').value,
      eqCurrency: document.getElementById('eq-currency').value,
      pseudo: document.getElementById('pseudo').checked,
      pct: document.getElementById('pct').value,
      lastCode: document.getElementById('pob-input').value.slice(0, 200000)
    }));
  } catch (e) { /* storage unavailable — fine */ }
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
  catch (e) { return {}; }
}
