/* js/app/02-init.js — start-up wiring, Copy diagnostics, new-league banner.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- init ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {
  statIndex = Matcher.buildStatIndex(window.POE_STATS);
  leagues = (window.POE_LEAGUES.result || []).filter(function (l) { return l.realm === 'pc'; });

  var saved = loadSettings();
  var sel = document.getElementById('league');
  leagues.forEach(function (l) {
    var o = document.createElement('option');
    o.value = l.id; o.textContent = l.text;
    sel.appendChild(o);
  });
  var def = leagues.find(function (l) { return isChallengeLeague(l.id); });
  if (def) sel.value = def.id;
  if (saved.league && leagues.some(function (l) { return l.id === saved.league; })) sel.value = saved.league;
  if (saved.status) document.getElementById('trade-status').value = saved.status;
  if (saved.pseudo !== undefined) document.getElementById('pseudo').checked = saved.pseudo;
  if (saved.pct) {
    document.getElementById('pct').value = saved.pct;
    document.getElementById('pct-label').textContent = saved.pct + '%';
  }
  if (saved.saleType) document.getElementById('sale-type').value = saved.saleType;
  if (saved.listedWithin) document.getElementById('listed-within').value = saved.listedWithin;
  if (saved.pricedIn) document.getElementById('priced-in').value = saved.pricedIn;
  if (saved.eqCurrency) document.getElementById('eq-currency').value = saved.eqCurrency;
  if (saved.lastCode) document.getElementById('pob-input').value = saved.lastCode;

  ['league', 'trade-status', 'pseudo', 'sale-type', 'listed-within', 'priced-in'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  // pseudo totals change the SCALE of dual-res inputs (×2) — rescale live so
  // the number in the box always matches the stat the search will use
  document.getElementById('pseudo').addEventListener('change', function () {
    var on = this.checked;
    cards.forEach(function (state) {
      (state.rows || []).forEach(function (r) {
        if (!r.match || !r.match.pseudo || !r.minInput) return;
        var newScale = on ? (r.pseudoMult || 1) : 1;
        if (newScale === r.inputScale) return;
        var v = parseFloat(r.minInput.value);
        if (!isNaN(v)) r.minInput.value = roundMin(v * newScale / r.inputScale);
        if (r.baseAvg !== null) r.baseAvg = r.baseAvg * newScale / r.inputScale;
        r.inputScale = newScale;
      });
    });
  });
  document.getElementById('eq-currency').addEventListener('change', function () {
    saveSettings();
    refreshEqDisplays();
  });

  document.getElementById('decode-btn').addEventListener('click', onDecode);
  document.getElementById('pob-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onDecode();
  });
  // pasting a code decodes immediately
  document.getElementById('pob-input').addEventListener('paste', function () {
    setTimeout(onDecode, 50);
  });
  document.getElementById('new-build').addEventListener('click', function () {
    showLanding();
    var ta = document.getElementById('pob-input');
    ta.focus();
    ta.select();
  });
  document.getElementById('back-to-build').addEventListener('click', function () {
    showBuild();
    setView(viewSection('gear') ? 'gear' : 'planner'); // the Builds page stays a view of its own
  });
  // narrow windows: the sidebar is an icon rail and the build card opens as a flyout
  var sidebar = document.getElementById('sidebar');
  var railBtn = document.getElementById('rail-build-btn');
  function setFlyout(on) {
    sidebar.classList.toggle('show-build', on);
    railBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  railBtn.addEventListener('click', function () { setFlyout(!sidebar.classList.contains('show-build')); });
  document.addEventListener('mousedown', function (e) {
    if (sidebar.classList.contains('show-build') && !e.target.closest('#build-bar, #rail-build-btn, .popover')) setFlyout(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar.classList.contains('show-build')) { setFlyout(false); railBtn.focus(); }
  });
  UI.popover(document.getElementById('search-settings-btn'), document.getElementById('search-settings'),
    { label: 'Search settings', cls: 'popover-search' });
  UI.popover(document.getElementById('compare-btn'), document.getElementById('char-pop'),
    { label: 'Compare with your character', align: 'start' });
  ['league', 'trade-status', 'sale-type', 'listed-within', 'priced-in', 'pseudo', 'eq-currency'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', updateContextChips);
  });
  document.getElementById('pct').addEventListener('input', updateContextChips);
  document.getElementById('settings-btn-side').addEventListener('click', function () { openSettings(this); });
  // character import
  if (saved.account) document.getElementById('acct-input').value = saved.account;
  document.getElementById('acct-load').addEventListener('click', async function () {
    var acct = document.getElementById('acct-input').value.trim();
    var status = document.getElementById('char-status');
    if (!acct) { status.textContent = 'enter Account#1234'; return; }
    this.disabled = true;
    status.textContent = 'loading…';
    try {
      var res = await window.pywebview.api.get_characters(acct);
      if (!res.ok) { status.textContent = '❌ ' + res.error; return; }
      populateCharSelect(res.characters);
      status.textContent = res.characters.length + ' characters';
      try {
        var s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
        s.account = acct;
        persist(SETTINGS_KEY, JSON.stringify(s));
      } catch (e) { /* fine */ }
    } catch (e) {
      status.textContent = '❌ ' + e.message;
    } finally {
      this.disabled = false;
    }
  });
  document.getElementById('char-compare').addEventListener('click', async function () {
    var acct = document.getElementById('acct-input').value.trim();
    var charName = document.getElementById('char-select').value;
    var status = document.getElementById('char-status');
    this.disabled = true;
    status.textContent = 'fetching gear…';
    try {
      var res = await window.pywebview.api.get_character_items(acct, charName);
      if (!res.ok) { status.textContent = '❌ ' + res.error; return; }
      charGear = {};
      res.items.forEach(function (it) {
        var slot = slotForInv(it);
        if (slot) charGear[slot] = it;
      });
      setCharLinks(res.items); // gem setups, matched on any worn item (10-character.js)
      // jewels sit in the passive tree, not the inventory: read them too (same click), so a
      // build jewel counts as owned wherever in the tree you socketed it
      charJewels = [];
      charPassives_ = null;
      if (window.pywebview.api.get_character_passives) {
        status.textContent = 'fetching tree jewels…';
        try {
          var pas = await window.pywebview.api.get_character_passives(acct, charName);
          if (pas && pas.ok) {
            charJewels = pas.jewels || [];
            charPassives_ = Object.assign({ name: charName }, pas); // the Skill tree compare reuses it
          }
        } catch (e) { /* gear still compares */ }
      }
      applyCharDiff();
      // the price-check overlay compares Ctrl+D items with what you wear (18-upgrade.js)
      try { persist('pobtf-chargear', JSON.stringify({ name: charName, gear: charGear })); } catch (e) { /* storage full */ }
      if (pastedState) renderUpgradeCheck(pastedState);
      document.getElementById('hide-matched-wrap').classList.remove('hidden');
      document.getElementById('value-gear').classList.remove('hidden');
      charName_ = charName;
      status.textContent = '⚖ comparing against ' + charName;
      rememberLastCompare(acct, charName);
      var saveBtn = document.getElementById('char-save');
      var isSaved = loadSavedChars().some(function (c) { return sameChar(c, acct, charName); });
      saveBtn.classList.toggle('hidden', isSaved);
    } catch (e) {
      status.textContent = '❌ ' + e.message;
    } finally {
      this.disabled = false;
    }
  });
  document.getElementById('char-save').addEventListener('click', function () {
    var acct = document.getElementById('acct-input').value.trim();
    var sel = document.getElementById('char-select');
    var o = sel.options[sel.selectedIndex];
    if (!acct || !o) return;
    var list = loadSavedChars().filter(function (c) { return !sameChar(c, acct, o.value); });
    list.unshift({ account: acct, name: o.value, league: o.dataset.league || '', cls: o.dataset.cls || '',
                   level: parseInt(o.dataset.level, 10) || null, at: Date.now() });
    saveSavedChars(list.slice(0, SAVED_CHARS_MAX));
    this.classList.add('hidden');
    renderSavedChars();
    UI.toast(o.value + ' saved: one click to compare next time', 'success');
  });
  renderSavedChars();
  var autoCb = document.getElementById('char-auto');
  if (autoCb) {
    autoCb.checked = PREFS.autoCompare !== false;
    autoCb.addEventListener('change', function () { PREFS.autoCompare = this.checked; savePrefs(); });
  }
  document.getElementById('value-gear').addEventListener('click', function () { valueMyGear(this); });
  document.getElementById('hide-matched').addEventListener('change', function () {
    document.body.classList.toggle('hide-matched', this.checked);
  });
  document.getElementById('sessid-save').addEventListener('click', async function () {
    var inp = document.getElementById('sessid-input');
    var status = document.getElementById('sessid-status');
    // the user's choice: a one-time disclaimer before the first save (clearing never asks)
    if (inp.value.trim() && localStorage.getItem('pobtf-sessid-ack') !== '1') {
      var ok = await UI.dialog({ title: 'Using your POESESSID', confirmLabel: 'I understand, save it', body: sessidDisclaimer() });
      if (!ok) { inp.focus(); return; }
      persist('pobtf-sessid-ack', '1');
    }
    this.disabled = true;
    try {
      var r = await window.pywebview.api.set_poesessid(inp.value);
      if (!r || r.ok === false) { // couldn't write it: say so and keep what was typed
        status.textContent = '❌ Not saved: ' + ((r && r.error) || 'no answer from the app');
        this.disabled = false;
        return;
      }
      inp.value = '';
      await refreshSessionStatus();
      if (r && r.set) {
        status.textContent = 'validating…';
        var v = await window.pywebview.api.session_validate();
        if (v && v.ok && v.valid) {
          status.textContent = '🟢 valid — instant alerts on';
          // the session tells us who you are — fill the compare flow for free
          if (v.account) document.getElementById('acct-input').value = v.account;
          populateCharSelect(v.characters || []);
          document.getElementById('char-status').textContent =
            (v.characters || []).length + ' characters loaded from your session';
        } else {
          status.textContent = '🟠 saved, but ' + ((v && v.error) || 'validation failed') +
            ' — instant alerts won\'t connect';
        }
      }
    } catch (e) { /* bridge missing in browser */ }
    this.disabled = false;
  });
  document.getElementById('sessid-remove').addEventListener('click', async function () {
    var ok = await UI.confirmDanger('Remove your POESESSID?', 'It\'s deleted from this PC. Instant live-search alerts and ' +
      'bigger searches stop until you save one again.', 'Remove');
    if (!ok) return;
    var r = await window.pywebview.api.set_poesessid('');
    if (!r || r.ok === false) { UI.toast('Not removed: ' + ((r && r.error) || 'no answer'), 'danger'); return; }
    await refreshSessionStatus();
    UI.toast('POESESSID removed.', 'success');
  });

  refreshBuildSelect();
  // the main window works without a build: sidebar + the tools that don't need one, Builds page first
  if (!OVERLAY && !TRADES && !(typeof SHEET_OV !== 'undefined' && SHEET_OV)) {
    document.body.classList.add('shell');
    renderToolSections();
    renderNav();
    if (!build) setView('home');
  }
  document.getElementById('save-build').addEventListener('click', libSaveCurrent); // 04-library.js
  var savedSearch = document.getElementById('saved-search');
  if (savedSearch) savedSearch.addEventListener('input', function () { libQuery = this.value; refreshBuildSelect(); });
  document.getElementById('pct').addEventListener('input', function () {
    document.getElementById('pct-label').textContent = this.value + '%';
    applyPctToAll();
    saveSettings();
  });
  document.getElementById('open-all').addEventListener('click', openAllSearches);
  document.getElementById('check-all').addEventListener('click', checkAllPrices);
  document.getElementById('refresh-data').addEventListener('click', refreshData);

  renderBasket();
  loadPrefs();
  applyPrefs();

  // first-run welcome: shown until dismissed (re-checked after bridge storage loads)
  function syncWelcome() {
    var done = false;
    try { done = !!localStorage.getItem('pobtf-welcome-done'); } catch (e) { /* storage off */ }
    document.getElementById('welcome').classList.toggle('hidden', done);
  }
  syncWelcome();
  document.getElementById('welcome-close').addEventListener('click', function () {
    persist('pobtf-welcome-done', '1');
    syncWelcome();
  });
  document.getElementById('welcome-sample').addEventListener('click', function () {
    if (!window.POE_SAMPLE_BUILD) return;
    document.getElementById('pob-input').value = window.POE_SAMPLE_BUILD;
    document.getElementById('decode-btn').click();
  });
  document.getElementById('settings-btn').addEventListener('click', function () { openSettings(this); });
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
  document.getElementById('settings-panel').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); return; }
    if (e.key !== 'Tab') return;
    // modal drawer: Tab wraps around inside it
    var f = Array.prototype.filter.call(this.querySelectorAll('button, select, input'), function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  document.getElementById('check-updates-btn').addEventListener('click', function () {
    checkForUpdates(true);
  });
  document.getElementById('copy-diagnostics').addEventListener('click', copyDiagnostics);
  if (LIGHT_QUERY && LIGHT_QUERY.addEventListener) {
    LIGHT_QUERY.addEventListener('change', function () { if (PREFS.theme === 'system') applyPrefs(); });
  }
  [['pref-theme', 'theme', 'value'], ['pref-accent', 'accent', 'value'],
   ['pref-fontsize', 'fontsize', 'value'], ['pref-density', 'density', 'value'],
   ['pref-sound', 'sound', 'checked'], ['pref-notify', 'notify', 'checked'], ['pref-volume', 'volume', 'value'],
   ['pref-motion', 'motion', 'checked'], ['pref-contrast', 'contrast', 'checked'],
   ['pref-cb', 'cb', 'checked']].forEach(function (spec) {
    document.getElementById(spec[0]).addEventListener('change', function () {
      PREFS[spec[1]] = spec[2] === 'checked' ? this.checked : this.value;
      applyPrefs();
      savePrefs();
    });
  });
  function markGui() {
    startArtCache(); // both windows load art from the on-disk cache
    if (OVERLAY) { overlayReady(hydrateFromBridge); return; } // price-check overlay: see block at the end
    if (TRADES) { tradesReady(hydrateFromBridge); return; } // in-game overlays (19-trades.js)
    if (typeof SHEET_OV !== 'undefined' && SHEET_OV) { sheetReady(hydrateFromBridge); return; } // cheat sheet overlay (24-cheatsheets.js)
    window.hydrateFromBridge = hydrateFromBridge; // the Trade helper view re-reads what the overlay saved
    document.body.classList.add('gui');
    checkForUpdates();
    setInterval(checkForUpdates, 4 * 3600 * 1000); // not just at launch
    refreshSessionStatus(true);
    refreshOAuth(); // official login: off until GGG issues a client id (17-stash.js)
    setInterval(function () { refreshSessionStatus(true); }, 30 * 60 * 1000);
    // market history loads after the saved league is restored; the feed is hourly
    hydrateFromBridge().then(function () {
      setTimeout(loadMarket, 1500);
      setTimeout(checkNewLeague, 4000);
      setTimeout(autoCompareOnStart, 2500); // the compare isn't kept across restarts: run the last one again
    });
    setInterval(checkNewLeague, 6 * 3600 * 1000);
    setTimeout(remindTrackedBuilds, 60 * 1000); // reminders only: searches need a click
    setInterval(remindTrackedBuilds, 60 * 60 * 1000);
    setInterval(loadMarket, 60 * 60 * 1000);
    document.getElementById('league').addEventListener('change', loadMarket);
    var tile = document.getElementById('market-tile');
    tile.addEventListener('click', function (e) {
      if (e.target.closest('.spark')) return; // hovering/focusing the chart isn't navigation
      setView('market');
      window.scrollTo(0, 0);
    });
    tile.addEventListener('keydown', function (e) {
      if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tile.click(); }
    });
    // surface rate-limit cooldowns so the app never feels silently stuck: poll the
    // bridge every 10s, count down locally every second in between
    var chipUntil = 0;
    setInterval(async function () {
      try {
        var r = await window.pywebview.api.rate_status();
        chipUntil = (r && r.ok && r.cooldownSeconds > 5) ? Date.now() + r.cooldownSeconds * 1000 : 0;
        tickChip();
      } catch (e) { /* bridge missing */ }
    }, 10000);
    function tickChip() {
      var chip = document.getElementById('rate-chip');
      var left = chipUntil - Date.now();
      if (left > 0) {
        chip.textContent = '⏳ API cooldown ' + fmtCountdown(left);
        chip.classList.remove('hidden');
      } else {
        chip.classList.add('hidden');
      }
    }
    setInterval(tickChip, 1000);
  }

  // pull durable state from the bridge and re-apply it to the UI
  async function hydrateFromBridge() {
    if (!window.pywebview.api.storage_get) return;
    try {
      var r = await window.pywebview.api.storage_get();
      if (!r || !r.ok || !r.data) return;
      Object.keys(r.data).forEach(function (k) {
        try { localStorage.setItem(k, r.data[k]); } catch (e) { /* fine */ }
      });
      var saved = loadSettings();
      if (saved.league && Array.prototype.some.call(document.getElementById('league').options,
          function (o) { return o.value === saved.league; })) {
        document.getElementById('league').value = saved.league;
      }
      if (saved.status) document.getElementById('trade-status').value = saved.status;
      if (saved.saleType) document.getElementById('sale-type').value = saved.saleType;
      if (saved.listedWithin) document.getElementById('listed-within').value = saved.listedWithin;
      if (saved.pricedIn) document.getElementById('priced-in').value = saved.pricedIn;
      if (saved.eqCurrency) document.getElementById('eq-currency').value = saved.eqCurrency;
      if (saved.pseudo !== undefined) document.getElementById('pseudo').checked = saved.pseudo;
      if (saved.pct) {
        document.getElementById('pct').value = saved.pct;
        document.getElementById('pct-label').textContent = saved.pct + '%';
      }
      if (saved.account) document.getElementById('acct-input').value = saved.account;
      var ta = document.getElementById('pob-input');
      if (saved.lastCode && !ta.value.trim()) ta.value = saved.lastCode;
      refreshBuildSelect();
      renderBasket();
      loadPrefs();
      applyPrefs();
      if (typeof syncInGameSettings === 'function') syncInGameSettings(); // hotkeys, tray, macros… (16-overlay.js)
      syncWelcome();
      updateContextChips();
    } catch (e) { /* browser mode / bridge unavailable */ }
  }
  if (isGui()) markGui();
  else window.addEventListener('pywebviewready', markGui);
});

function checkForUpdates(manual) {
  if (!isGui() || !window.pywebview.api.check_update) return;
  var statusEl = document.getElementById('update-check-status');
  if (manual && statusEl) statusEl.textContent = 'checking…';
  window.pywebview.api.check_update().then(function (res) {
    if (!res || !res.ok) {
      if (manual && statusEl) statusEl.textContent = '❌ ' + ((res && res.error) || 'could not reach GitHub');
      return;
    }
    if (res.current) {
      var foot = document.querySelector('.footer');
      if (foot && foot.textContent.indexOf('· v') === -1) foot.textContent += ' · v' + res.current;
      window.APP_VERSION = String(res.current).replace(/^v/i, '');
    }
    if (typeof markPatchNotes === 'function') markPatchNotes(res); // Settings → Patch notes (30-patchnotes.js)
    var latest = 'v' + String(res.latest || '').replace(/^v/i, ''), current = 'v' + String(res.current || '').replace(/^v/i, '');
    var settingsBtn = document.getElementById('update-now-settings');
    if (manual && statusEl) {
      statusEl.textContent = res.newer ? '⬆ ' + latest + ' is ready (you have ' + current + ')' : '✓ Up to date (' + current + ')';
    }
    if (!res.newer || !res.url) { if (settingsBtn) settingsBtn.classList.add('hidden'); return; }
    // the same Update now in Settings → Data and updates, so you don't have to find the banner
    if (settingsBtn) {
      settingsBtn.classList.remove('hidden');
      settingsBtn.onclick = function () { startUpdate(res.url); };
    }
    var bar = document.getElementById('update-banner');
    if (updateLaterFor === res.latest && !manual) return; // "Later" hides it until the next version
    bar.classList.remove('hidden');
    document.getElementById('update-label').textContent = 'PoB Trade Finder ' + latest + ' is ready';
    document.getElementById('update-summary').textContent = 'You have ' + current +
      (releaseHeadline(res.notes) ? ' · New: ' + releaseHeadline(res.notes) : '');
    var notes = document.getElementById('update-notes');
    notes.classList.toggle('hidden', !res.page);
    notes.onclick = function () { if (res.page) openUrl(res.page); };
    document.getElementById('update-later').onclick = function () {
      updateLaterFor = res.latest;
      bar.classList.add('hidden');
    };
    document.getElementById('update-btn').onclick = function () { startUpdate(res.url); };
  }).catch(function () { /* offline — skip */ });
}
var updateLaterFor = null;

// ---- saved characters (Compare with your character) ------------------------------------
// Yours or anyone's: one click fills the account and character and compares, no re-typing.
var SAVED_CHARS_KEY = 'pobtf-saved-chars', SAVED_CHARS_MAX = 12;
function loadSavedChars() {
  try { var l = JSON.parse(localStorage.getItem(SAVED_CHARS_KEY)); return Array.isArray(l) ? l.filter(function (c) { return c && c.account && c.name; }) : []; }
  catch (e) { return []; }
}
function saveSavedChars(list) { persist(SAVED_CHARS_KEY, JSON.stringify(list)); }
function sameChar(c, acct, name) {
  return c.account.toLowerCase() === String(acct || '').toLowerCase() && c.name.toLowerCase() === String(name || '').toLowerCase();
}
function renderSavedChars() {
  var box = document.getElementById('char-saved');
  if (!box) return;
  var list = loadSavedChars();
  box.textContent = '';
  box.classList.toggle('hidden', !list.length || !isGui());
  if (!list.length) return;
  box.appendChild(UI.el('span', 'char-label', 'Saved'));
  list.forEach(function (c) {
    var chip = UI.el('span', 'char-chip');
    var go = UI.el('button', 'char-chip-go');
    go.type = 'button';
    go.title = 'Compare with ' + c.name + ' (' + c.account + (c.league ? ', ' + c.league : '') + ')';
    go.appendChild(UI.el('b', null, c.name));
    var info = [c.cls, c.level ? 'lvl ' + c.level : ''].filter(Boolean).join(' ');
    go.appendChild(UI.el('span', 'char-chip-sub', (info ? info + ' · ' : '') + c.account));
    go.addEventListener('click', function () { compareSavedChar(c); });
    chip.appendChild(go);
    chip.appendChild(UI.iconButton('✕', 'Forget ' + c.name, { size: 'sm', onClick: function () {
      saveSavedChars(loadSavedChars().filter(function (x) { return !sameChar(x, c.account, c.name); }));
      renderSavedChars();
    } }));
    box.appendChild(chip);
  });
}
// The character compare lives in memory, so a restart (an update installs with one) cleared it
// and the gear / gem marks were gone until you compared again. The last compare is remembered and,
// unless you untick "Compare again when the app starts", run once at launch: the same requests
// as pressing Compare gear (gear, then tree jewels), never repeated on its own.
var LAST_COMPARE_KEY = 'pobtf-last-compare';
function rememberLastCompare(acct, name) {
  var o = document.getElementById('char-select');
  o = o && o.options[o.selectedIndex];
  try {
    persist(LAST_COMPARE_KEY, JSON.stringify({ account: acct, name: name, league: (o && o.dataset.league) || '',
      cls: (o && o.dataset.cls) || '', level: (o && parseInt(o.dataset.level, 10)) || null, at: Date.now() }));
  } catch (e) { /* storage full: nothing to remember */ }
}
function loadLastCompare() {
  try {
    var c = JSON.parse(localStorage.getItem(LAST_COMPARE_KEY));
    return c && c.account && c.name ? c : null;
  } catch (e) { return null; }
}
var autoCompared = false;
function autoCompareOnStart() {
  if (autoCompared || !isGui() || PREFS.autoCompare === false || charGear) return;
  var last = loadLastCompare();
  if (!last || !window.pywebview.api.get_character_items) return;
  autoCompared = true;
  compareSavedChar(last);
}

// fill the account + character from a saved one and run the usual Compare gear
function compareSavedChar(c) {
  document.getElementById('acct-input').value = c.account;
  populateCharSelect([{ name: c.name, league: c.league || '', level: c.level || '?', 'class': c.cls || '' }]);
  document.getElementById('char-select').value = c.name;
  document.getElementById('char-status').textContent = '';
  document.getElementById('char-compare').click();
}

// "## v2.5.4: socket colours in the gem compare" → "Socket colours in the gem compare"
function releaseHeadline(notes) {
  var first = String(notes || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || '';
  var h = first.replace(/^#+\s*/, '').replace(/^v?\d+(\.\d+)+\s*[:\-–—]?\s*/i, '').trim();
  if (!h || h.length > 90) return '';
  return h.charAt(0).toUpperCase() + h.slice(1);
}

// both Update now buttons (banner and Settings): one download, then the app restarts itself
function startUpdate(url) {
  ['update-btn', 'update-now-settings'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) { b.disabled = true; b.textContent = 'Updating… the app restarts itself'; }
  });
  var st = document.getElementById('update-check-status');
  if (st) st.textContent = 'Downloading the update…';
  Promise.resolve(window.pywebview.api.apply_update(url)).then(function (r) {
    if (r && r.ok === false) {
      UI.toast('Update failed: ' + (r.error || 'unknown error'), 'danger');
      ['update-btn', 'update-now-settings'].forEach(function (id) {
        var b = document.getElementById(id);
        if (b) { b.disabled = false; b.textContent = 'Update now'; }
      });
      if (st) st.textContent = '❌ Update failed: ' + (r.error || 'unknown error');
    }
  }, function () { /* the app is closing to install it */ });
}

function sessidDisclaimer() {
  var box = UI.el('div', 'sessid-disclaimer');
  [['It\'s your logged-in pathofexile.com session. ', 'Anyone who has it can act as you on the website, so never share it. ' +
    'The app keeps it only on this PC and sends it only to www.pathofexile.com.'],
   ['It unlocks bigger searches and instant live alerts ', 'through the trade site\'s own endpoints with your login. Grinding ' +
    'Gear Games doesn\'t officially support that for third-party tools. Many trade tools work this way, but you use it at ' +
    'your own risk.'],
   ['You can stop any time: ', 'save an empty box here, or log out on pathofexile.com, which ends that session.']
  ].forEach(function (p) {
    var para = UI.el('p');
    para.appendChild(UI.el('b', null, p[0]));
    para.appendChild(document.createTextNode(p[1]));
    box.appendChild(para);
  });
  return box;
}

// ---- Settings → Copy diagnostics ---------------------------------------------------
// Bridge summary (version, OS, data dates, log tails — redacted in gui.py) plus what
// the page knows: view, league, build size, display settings, recent errors.
async function copyDiagnostics() {
  var btn = document.getElementById('copy-diagnostics');
  btn.disabled = true;
  var parts = [];
  if (isGui() && window.pywebview.api.diagnostics) {
    try {
      var r = await window.pywebview.api.diagnostics();
      parts.push(r && r.ok ? r.text : 'desktop diagnostics failed: ' + ((r && r.error) || 'unknown'));
    } catch (e) { parts.push('desktop diagnostics failed: ' + e.message); }
  } else {
    parts.push('PoB Trade Finder (browser mode, no desktop app)');
  }
  var page = ['', '--- page ---',
    'View: ' + (document.body.dataset.view || 'start') + ' · League: ' + document.getElementById('league').value,
    'Build: ' + (build ? (build.ascendClass || build.className || '?') + ', ' + Object.keys(build.items).length +
      ' items, ' + cards.length + ' cards' : 'none loaded'),
    'Display: theme ' + PREFS.theme + ', text ' + (PREFS.fontsize || 100) + '%, window ' + window.innerWidth + '×' +
      window.innerHeight + ', ' + navigator.userAgent.replace(/^.*?(Edg\/[\d.]+|Chrome\/[\d.]+).*$/, '$1'),
    'Market: ' + (market ? Object.keys(market.items).length + ' items, feed hour ' +
      new Date(market.hour * 1000).toISOString().slice(0, 16) : 'not loaded')];
  page.push('', '--- recent errors (' + RECENT_ERRORS.length + ') ---');
  page = page.concat(RECENT_ERRORS.length ? RECENT_ERRORS : ['none']);
  var text = parts.concat(page).join('\n');
  var done = function () {
    btn.disabled = false;
    UI.toast('Diagnostics copied. Paste them into your bug report.', 'success');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
}

// ---- new league autopilot ------------------------------------------------------
// On launch and every 6h the live trade-league list (one background call) is compared
// with the bundled one. A challenge league the user hasn't been offered yet gets a
// banner; switching refreshes the bundled stats + leagues first when they lack it.
function isChallengeLeague(id) { return !/Standard|Hardcore|Ruthless/i.test(id); }
var LEAGUE_SEEN_KEY = 'pobtf-league-seen';
function leaguesSeen() {
  try { var s = JSON.parse(localStorage.getItem(LEAGUE_SEEN_KEY)); if (Array.isArray(s)) return s; }
  catch (e) { /* none yet */ }
  return [];
}
// awaited: a reload right after must not race the bridge write
async function persistNow(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* fine */ }
  if (isGui() && window.pywebview.api.storage_set) {
    try { await window.pywebview.api.storage_set(key, value); } catch (e) { /* fine */ }
  }
}

async function checkNewLeague() {
  if (!isGui() || !window.pywebview.api.league_check) return;
  var r;
  try { r = await window.pywebview.api.league_check(); } catch (e) { return; }
  if (!r || !r.ok) return;
  var challenge = r.leagues.filter(function (l) { return isChallengeLeague(l.id); });
  var target = challenge.filter(function (l) { return r.new.indexOf(l.id) !== -1; })[0] || challenge[0];
  var sel = document.getElementById('league');
  if (!target || sel.value === target.id || leaguesSeen().indexOf(target.id) !== -1) return;
  var known = Array.prototype.some.call(sel.options, function (o) { return o.value === target.id; });
  var needsRefresh = r.new.length > 0 || !known;
  var bar = document.getElementById('league-banner');
  var go = document.getElementById('league-switch');
  var later = document.getElementById('league-dismiss');
  document.getElementById('league-label').textContent = target.text + ' is live' +
    (needsRefresh ? '. Switch to it and refresh trade data for the new league?' : '. Switch searches and prices to it?');
  go.textContent = 'Switch to ' + target.text;
  go.disabled = false;
  bar.classList.remove('hidden');
  function seen() { return persistNow(LEAGUE_SEEN_KEY, JSON.stringify(leaguesSeen().concat([target.id]))); }
  later.onclick = function () { seen(); bar.classList.add('hidden'); };
  go.onclick = async function () {
    go.disabled = true;
    if (needsRefresh) {
      go.textContent = 'Refreshing trade data…';
      var res;
      try { res = await window.pywebview.api.refresh_data(); } catch (e) { res = { ok: false, error: e.message }; }
      if (!res || !res.ok) {
        UI.toast('Couldn\'t refresh trade data: ' + ((res && res.error) || 'unknown error') + '. Try again later.', 'danger');
        go.textContent = 'Switch to ' + target.text;
        go.disabled = false;
        return;
      }
      var s = loadSettings();
      s.league = target.id;
      await persistNow(SETTINGS_KEY, JSON.stringify(s));
      await seen();
      location.reload(); // picks up the regenerated data/leagues.js + stats.js
      return;
    }
    await seen();
    bar.classList.add('hidden');
    sel.value = target.id;
    sel.dispatchEvent(new Event('change')); // saves settings, updates chips, reloads the market
    UI.toast('Switched to ' + target.text, 'success');
  };
}
