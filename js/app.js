/* app.js — UI + trade query building for PoB Trade Finder */
(function () {
  'use strict';

  var statIndex = null;
  var leagues = [];
  var build = null;         // parsed build
  var cards = [];           // per-item UI state

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
    document.body.style.zoom = (parseInt(PREFS.fontsize, 10) || 100) / 100;
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
    var def = leagues.find(function (l) { return !/Standard|Hardcore|Ruthless/i.test(l.id); });
    if (def) sel.value = def.id;
    if (saved.league && leagues.some(function (l) { return l.id === saved.league; })) sel.value = saved.league;
    if (saved.status) document.getElementById('trade-status').value = saved.status;
    if (saved.pseudo !== undefined) document.getElementById('pseudo').checked = saved.pseudo;
    if (saved.pct) {
      document.getElementById('pct').value = saved.pct;
      document.getElementById('pct-label').textContent = saved.pct + '%';
    }
    if (saved.saleType) document.getElementById('sale-type').value = saved.saleType;
    if (saved.eqCurrency) document.getElementById('eq-currency').value = saved.eqCurrency;
    if (saved.lastCode) document.getElementById('pob-input').value = saved.lastCode;

    ['league', 'trade-status', 'pseudo', 'sale-type'].forEach(function (id) {
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
    document.getElementById('back-to-build').addEventListener('click', showBuild);
    UI.popover(document.getElementById('search-settings-btn'), document.getElementById('search-settings'),
      { label: 'Search settings', cls: 'popover-search' });
    UI.popover(document.getElementById('compare-btn'), document.getElementById('char-pop'),
      { label: 'Compare with your character', align: 'start' });
    ['league', 'trade-status', 'sale-type', 'pseudo', 'eq-currency'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', updateContextChips);
    });
    document.getElementById('pct').addEventListener('input', updateContextChips);
    document.getElementById('settings-btn-side').addEventListener('click', function () {
      document.getElementById('settings-panel').classList.toggle('hidden');
      window.scrollTo(0, 0);
    });
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
        applyCharDiff();
        document.getElementById('hide-matched-wrap').classList.remove('hidden');
        document.getElementById('value-gear').classList.remove('hidden');
        charName_ = charName;
        status.textContent = '⚖ comparing against ' + charName;
      } catch (e) {
        status.textContent = '❌ ' + e.message;
      } finally {
        this.disabled = false;
      }
    });
    document.getElementById('value-gear').addEventListener('click', function () { valueMyGear(this); });
    document.getElementById('hide-matched').addEventListener('change', function () {
      document.body.classList.toggle('hide-matched', this.checked);
    });
    document.getElementById('sessid-save').addEventListener('click', async function () {
      var inp = document.getElementById('sessid-input');
      var status = document.getElementById('sessid-status');
      this.disabled = true;
      try {
        var r = await window.pywebview.api.set_poesessid(inp.value);
        inp.value = '';
        inp.placeholder = r && r.set ? 'POESESSID saved' : 'POESESSID (optional)';
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

    refreshBuildSelect();
    document.getElementById('save-build').addEventListener('click', function () {
      if (!build) return;
      var lib = loadBuildLib();
      var name = (build.ascendClass || build.className || 'Build') + ' · ' +
                 Object.keys(build.items).length + ' items · ' + new Date().toLocaleDateString();
      lib.unshift({ name: name, code: document.getElementById('pob-input').value, ts: Date.now() });
      saveBuildLib(lib);
      refreshBuildSelect();
      this.textContent = '★ Saved';
      var btn = this;
      setTimeout(function () { btn.textContent = '☆ Save'; }, 1200);
      UI.toast('Build saved — it\'s on the start screen for one-click reload.', 'success');
    });
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
    document.getElementById('settings-btn').addEventListener('click', function () {
      document.getElementById('settings-panel').classList.toggle('hidden');
    });
    document.getElementById('settings-close').addEventListener('click', function () {
      document.getElementById('settings-panel').classList.add('hidden');
    });
    document.getElementById('check-updates-btn').addEventListener('click', function () {
      checkForUpdates(true);
    });
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
      document.body.classList.add('gui');
      checkForUpdates();
      setInterval(checkForUpdates, 4 * 3600 * 1000); // not just at launch
      refreshSessionStatus(true);
      setInterval(function () { refreshSessionStatus(true); }, 30 * 60 * 1000);
      // market history loads after the saved league is restored; the feed is hourly
      hydrateFromBridge().then(function () { setTimeout(loadMarket, 1500); });
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
      }
      if (manual && statusEl) {
        statusEl.textContent = res.newer
          ? '⬆ ' + res.latest + ' available — see the banner above'
          : '✓ up to date (v' + res.current + ')';
      }
      if (!res.newer || !res.url) return;
      var bar = document.getElementById('update-banner');
      bar.classList.remove('hidden');
      document.getElementById('update-label').textContent =
        'Update ' + res.latest + ' available — you have v' + res.current;
      document.getElementById('update-btn').onclick = function () {
        this.disabled = true;
        this.textContent = 'Updating… the app will restart itself';
        window.pywebview.api.apply_update(res.url);
      };
    }).catch(function () { /* offline — skip */ });
  }

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
      status.textContent = '';
      saveSettings();
      document.getElementById('build-label').textContent =
        build.ascendClass || build.className || 'Unknown class';
      var nSets = (build.itemSets || []).length;
      document.getElementById('build-sub').textContent =
        Object.keys(build.items).length + ' items' + (nSets > 1 ? ' · ' + nSets + ' gear sets' : '');
      renderBuild();
      showBuild();
    } catch (err) {
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
    }

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
    setView(present.indexOf(keep) !== -1 || keep === 'planner' || keep === 'market' ? keep : present[0] || 'planner');
    renderCostSummary(); // clears stale summary — fresh cards have no prices yet
    applyCharDiff();     // re-annotate fresh cards if a character is loaded
  }

  // ---- app shell: views, sidebar nav, slot lists, search context ---------------
  var VIEW_ORDER = ['gear', 'jewels', 'flasks', 'gems', 'timeless', 'finder', 'pasted'];
  var MASTER_DETAIL = { gear: true, jewels: true, flasks: true };
  var VIEW_LABELS = { gear: 'Gear', jewels: 'Jewels & clusters', flasks: 'Flasks', gems: 'Gems',
                      timeless: 'Timeless jewels', finder: 'Jewel finder', pasted: 'Pasted item',
                      planner: 'Upgrade planner', market: 'Market' };

  function viewSection(k) { return document.querySelector('#results > .tab-section[data-tab="' + k + '"]'); }

  function setView(k) {
    document.body.dataset.view = k;
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
      b.appendChild(UI.el('span', null, VIEW_LABELS[k]));
      b.appendChild(UI.el('span', 'nav-count', navCount(k)));
      b.addEventListener('click', function () { setView(k); window.scrollTo(0, 0); });
      nav.appendChild(b);
    }
    var items = ['gear', 'jewels', 'flasks', 'gems', 'pasted'].filter(viewSection);
    if (items.length) { nav.appendChild(UI.el('div', 'nav-group', 'Items')); items.forEach(item); }
    nav.appendChild(UI.el('div', 'nav-group', 'Tools'));
    ['planner', 'timeless', 'finder', 'market'].filter(function (k) {
      return k === 'planner' || k === 'market' || viewSection(k);
    }).forEach(item);
    setView(document.body.dataset.view || 'gear');
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
    box.appendChild(UI.chip('Min roll ' + document.getElementById('pct').value + '%'));
    if (!document.getElementById('pseudo').checked) box.appendChild(UI.chip('No pseudo totals', 'warn'));
  }

  // landing ⇄ build
  function showBuild() {
    document.body.classList.add('has-build');
    document.getElementById('input-panel').classList.add('hidden');
    document.getElementById('build-bar').classList.remove('hidden');
    window.scrollTo(0, 0);
  }
  function showLanding() {
    document.body.classList.remove('has-build');
    document.getElementById('input-panel').classList.remove('hidden');
    document.getElementById('back-to-build').classList.toggle('hidden', !build);
    window.scrollTo(0, 0);
  }

  // ---- saved builds library --------------------------------------------------
  function loadBuildLib() {
    try { return JSON.parse(localStorage.getItem('pobtf-builds')) || []; }
    catch (e) { return []; }
  }
  function saveBuildLib(lib) {
    try { persist('pobtf-builds', JSON.stringify(lib.slice(0, 20))); }
    catch (e) { /* storage full/unavailable */ }
  }
  // saved builds as one-click cards on the start screen
  function refreshBuildSelect() {
    var list = document.getElementById('saved-list');
    var lib = loadBuildLib();
    list.textContent = '';
    document.getElementById('saved-section').classList.toggle('hidden', !lib.length);
    lib.forEach(function (b, i) {
      var parts = String(b.name || 'Build').split(' · ');
      var row = UI.el('div', 'saved-build');
      var open = UI.el('button', 'saved-open');
      open.type = 'button';
      open.appendChild(UI.el('span', 'saved-name', parts[0]));
      open.appendChild(UI.el('span', 'saved-meta', parts.slice(1).join(' · ')));
      open.addEventListener('click', function () {
        document.getElementById('pob-input').value = b.code;
        onDecode();
      });
      row.appendChild(open);
      row.appendChild(UI.iconButton('🗑', 'Delete saved build ' + parts[0], { size: 'sm', onClick: function () {
        UI.confirmDanger('Delete saved build?', '"' + b.name + '" will be removed from your library.', 'Delete build')
          .then(function (ok) {
            if (!ok) return;
            var cur = loadBuildLib();
            cur.splice(i, 1);
            saveBuildLib(cur);
            refreshBuildSelect();
            UI.toast('Saved build deleted.', 'success');
          });
      } }));
      list.appendChild(row);
    });
  }

  // ---- craft vs buy ----------------------------------------------------------------
  // Monte Carlo over chaos / essence reforges (js/craft.js) priced with the
  // currency feed, against the card's cheapest listing. Data loads on first use.
  var craftDataPromise = null;
  function ensureCraftData() {
    if (window.POE_CRAFT) return Promise.resolve(window.POE_CRAFT);
    if (!craftDataPromise) {
      craftDataPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'data/craftdata.js?v=' + Date.now();
        s.onload = function () { if (window.POE_CRAFT) resolve(window.POE_CRAFT); else reject(new Error('craft data missing')); };
        s.onerror = function () { craftDataPromise = null; reject(new Error('could not load data/craftdata.js')); };
        document.head.appendChild(s);
      });
    }
    return craftDataPromise;
  }

  var CRAFT_TRIALS_MAX = 3000000, CRAFT_TARGET_HITS = 300, CRAFT_MS_PER_METHOD = 1500;

  function craftTargets(state) {
    var targets = [], skipped = [];
    state.rows.forEach(function (r) {
      if (!r.cb.checked || !r.match || r.mod.kind !== 'explicit') return; // implicits come with the base
      var id = r.match.entry.id;
      if (id.indexOf('|') !== -1) { skipped.push(r.mod.line); return; }
      var v = parseFloat(r.minInput.value);
      targets.push({ tail: id.split('.').pop(), min: isNaN(v) ? null : v / (r.inputScale || 1), line: r.mod.line });
    });
    return { targets: targets, skipped: skipped };
  }

  function fmtOdds(sum) {
    if (!sum.successes) return 'under 1 in ' + fmtCompact(1 / sum.pUpper);
    return sum.p >= 0.5 ? Math.round(sum.p * 100) + '%' : '1 in ' + fmtCompact(Math.round(1 / sum.p));
  }

  async function craftRates(league, codes) {
    RATES[league] = RATES[league] || { chaos: 1 };
    var need = codes.filter(function (c) { return RATES[league][c] === undefined; });
    if (need.length && isGui()) {
      try {
        var r = await window.pywebview.api.exchange_rates(league, JSON.stringify(need));
        if (r && r.ok) Object.keys(r.rates).forEach(function (k) { RATES[league][k] = r.rates[k]; });
      } catch (e) { /* unpriced — shown as odds only */ }
    }
    return RATES[league];
  }

  function openCraft(state) {
    var box = state.craftBox;
    if (box.dataset.built) { // later clicks toggle; reopening re-runs with current card settings
      if (!box.classList.toggle('hidden')) runCraft(state);
      return;
    }
    box.dataset.built = '1';
    box.classList.remove('hidden');
    var head = document.createElement('div');
    head.className = 'craft-head';
    var title = document.createElement('b');
    title.textContent = 'Craft vs buy';
    head.appendChild(title);
    state.craftIlvl = makeMiniInput(head, 'Base ilvl', '86');
    state.craftIlvl.value = '86';
    state.craftIlvl.title = 'Item level of the base you would craft on — higher unlocks top tiers';
    state.craftBase = makeMiniInput(head, 'Base price', 'c');
    state.craftBase.title = 'What the blank base costs you (chaos). Leave blank to ignore';
    if (isGui()) {
      var pb = UI.button('secondary');
      pb.textContent = 'Price base';
      pb.title = 'Look up the cheapest ' + (state.item.base || 'base') + ' at this item level on the trade site (one search)';
      pb.addEventListener('click', function () { priceCraftBase(state, pb); });
      head.appendChild(pb);
    }
    var run = UI.button('secondary');
    run.textContent = '↻ Re-run';
    run.addEventListener('click', function () { runCraft(state); });
    head.appendChild(run);
    box.appendChild(head);
    var out = document.createElement('div');
    out.className = 'craft-out';
    box.appendChild(out);
    state.craftOut = out;
    [state.craftIlvl, state.craftBase].forEach(function (inp) {
      inp.addEventListener('change', function () { runCraft(state); });
    });
    runCraft(state);
  }

  async function priceCraftBase(state, btn) {
    var league = document.getElementById('league').value;
    var ilvl = parseInt(state.craftIlvl.value, 10) || 86;
    var misc = { ilvl: { min: ilvl }, corrupted: { option: 'false' } };
    (state.item.influences || []).forEach(function (inf) { if (INFLUENCE_KEY[inf]) misc[INFLUENCE_KEY[inf]] = { option: 'true' }; });
    var payload = { query: { status: { option: document.getElementById('trade-status').value }, type: state.item.base,
      filters: { type_filters: { filters: { rarity: { option: 'nonunique' } } }, misc_filters: { filters: misc },
                 trade_filters: { filters: { sale_type: { option: 'priced' } } } } }, sort: { price: 'asc' } };
    btn.disabled = true; btn.textContent = 'Pricing…';
    try {
      var r = await window.pywebview.api.trade_search(league, JSON.stringify(payload));
      if (!r.ok) throw new Error(r.error);
      var curs = [];
      r.listings.forEach(function (li) { if (li.currency && curs.indexOf(li.currency) === -1) curs.push(li.currency); });
      var rates = await craftRates(league, curs);
      var best = null;
      r.listings.forEach(function (li) {
        var rate = rates[li.currency];
        if (li.amount != null && rate !== undefined && (best === null || li.amount * rate < best)) best = li.amount * rate;
      });
      if (best === null) throw new Error('no priced bases found');
      state.craftBase.value = String(Math.round(best * 10) / 10);
      runCraft(state);
    } catch (e) {
      btn.title = String(e.message || e);
      btn.textContent = 'Price base ✕';
      return;
    } finally { btn.disabled = false; }
    btn.textContent = 'Price base';
  }

  async function runCraft(state) {
    var out = state.craftOut;
    if (!out) return;
    var seq = state.craftSeq = (state.craftSeq || 0) + 1;
    var C = await ensureCraftData();
    var league = document.getElementById('league').value;
    var t = craftTargets(state);
    out.textContent = '';
    function note(text, cls) {
      var d = document.createElement('div');
      d.className = cls || 'craft-note';
      d.textContent = text;
      out.appendChild(d);
      return d;
    }
    if (!t.targets.length) { note('Tick the explicit mods you want, then re-run.'); return; }
    var ilvl = parseInt(state.craftIlvl.value, 10) || 86;
    var P = Craft.prepare(C, state.item.base, state.item.influences, ilvl, t.targets);
    if (P.error) { note('Can\'t estimate: ' + state.item.base + ' isn\'t a craftable gear base in the bundled data.'); return; }

    // drop targets that nothing can produce on this base — and say so
    var unreachable = [];
    var kept = t.targets.filter(function (tg, i) {
      var idx = P.targets.findIndex(function (pt) { return pt.tail === tg.tail; });
      var r = P.reach[idx];
      if (r && (r.random || r.essence || r.bench || r.fossil)) return true;
      unreachable.push(tg.line);
      return false;
    });
    if (unreachable.length) {
      note('Can\'t roll on ' + state.item.base + ' at ilvl ' + ilvl + ' (influence, eldritch, veiled or fractured-only?): ' +
           unreachable.join(' · ') + '. Estimated without ' + (unreachable.length > 1 ? 'them' : 'it') + '.', 'craft-warn');
      if (!kept.length) return;
      P = Craft.prepare(C, state.item.base, state.item.influences, ilvl, kept);
    }
    if (t.skipped.length) note('Not modelled: ' + t.skipped.join(' · '), 'craft-warn');
    var allowMissing = Math.min(state.modeSel ? parseInt(state.modeSel.value, 10) || 0 : 0, P.targets.length - 1);

    // essences worth trying: their forced mod can meet a target's minimum
    var essences = P.essences.filter(function (e) {
      return e.mod.contribs.some(function (c) {
        var tg = P.targets[c[0]];
        var hi = c[1].reduce(function (s, sl) { return s + sl[1]; }, 0) / c[1].length;
        return tg.min === null || hi >= tg.min;
      });
    }).sort(function (a, b) { return b.level - a.level; }).slice(0, 6);

    // fossil resonator combos (1–3 fossils): keep the top 3 per size by rough odds, so
    // only a handful of fossil codes need prices (feed misses fall back to trade calls)
    var perSize = {};
    var combos = Craft.fossilCombos(P, { maxSize: 3 })
      .sort(function (a, b) { return b.rough - a.rough; })
      .filter(function (cb) {
        var n = cb.fossils.length;
        perSize[n] = (perSize[n] || 0) + 1;
        return perSize[n] <= 3;
      });

    var codes = ['divine'];
    essences.forEach(function (e) { codes.push(e.code); });
    P.bench.forEach(function (b) { Object.keys(b.cost).forEach(function (c) { if (codes.indexOf(c) === -1) codes.push(c); }); });
    combos.forEach(function (cb) {
      cb.fossils.forEach(function (fi) { var c = C.fossils[fi][1]; if (codes.indexOf(c) === -1) codes.push(c); });
      var rc = C.resonators[cb.fossils.length - 1];
      if (rc && codes.indexOf(rc) === -1) codes.push(rc);
    });
    var rates = await craftRates(league, codes);
    if (seq !== state.craftSeq) return;
    var bench = [];
    P.bench.forEach(function (b) {
      var cost = 0, ok = true;
      Object.keys(b.cost).forEach(function (c) { if (rates[c] === undefined) ok = false; else cost += b.cost[c] * rates[c]; });
      if (ok) bench.push({ mod: b.mod, costChaos: cost });
    });
    bench.sort(function (a, b) { return a.costChaos - b.costChaos; });

    var methods = [{ label: 'Chaos spam', perTry: 1, forced: null }];
    essences.forEach(function (e) {
      methods.push({ label: e.name + ' spam', perTry: rates[e.code], forced: e.mod });
    });
    // best fossil combo per resonator size: rough odds per chaos spent, priced first
    var bestBySize = {};
    combos.forEach(function (cb) {
      var rc = C.resonators[cb.fossils.length - 1], cost = rc ? rates[rc] : undefined;
      cb.fossils.forEach(function (fi) {
        var r = rates[C.fossils[fi][1]];
        cost = cost === undefined || r === undefined ? undefined : cost + r;
      });
      cb.perTry = cost;
      cb.rank = cost !== undefined && cost > 0 ? cb.rough / cost : -1 / cb.rough;
      var cur = bestBySize[cb.fossils.length];
      if (!cur || cb.rank > cur.rank) bestBySize[cb.fossils.length] = cb;
    });
    Object.keys(bestBySize).sort().forEach(function (n) {
      var cb = bestBySize[n];
      var rcode = C.resonators[cb.fossils.length - 1];
      var parts = [[rcode, rcode.replace(/-/g, ' ').replace(/\b\w/g, function (ch) { return ch.toUpperCase(); })]]
        .concat(cb.fossils.map(function (fi) { return [C.fossils[fi][1], C.fossils[fi][0]]; }));
      var breakdown = parts.map(function (p) {
        return p[1] + ' ' + (rates[p[0]] !== undefined ? fmtEq(rates[p[0]], league) : 'no price');
      }).join(' + ');
      methods.push({ label: 'Fossils: ' + cb.names.map(function (s) { return s.replace(/ Fossil$/, ''); }).join(' + '),
                     perTry: cb.perTry, forced: null, P: cb.Q, breakdown: breakdown });
    });
    var baseCost = parseFloat(state.craftBase.value);
    if (isNaN(baseCost)) baseCost = 0;

    var progress = note('Simulating…');
    var results = [];
    for (var mi = 0; mi < methods.length; mi++) {
      var m = methods[mi];
      var st = { n: 0, s: 0, benchUses: {} }, t0 = Date.now();
      while (st.n < CRAFT_TRIALS_MAX && st.s < CRAFT_TARGET_HITS && Date.now() - t0 < CRAFT_MS_PER_METHOD) {
        Craft.runBatch(m.P || P, { forced: m.forced, bench: bench, allowMissing: allowMissing }, 20000, st);
        progress.textContent = 'Simulating ' + m.label + '… ' + fmtCompact(st.n) + ' rolls';
        await new Promise(function (r) { setTimeout(r, 0); });
        if (seq !== state.craftSeq) return; // re-run superseded this one
      }
      var sum = Craft.summarize(st, m.perTry === undefined ? 0 : m.perTry, bench, baseCost);
      sum.label = m.label;
      sum.breakdown = m.breakdown || '';
      sum.priced = m.perTry !== undefined;
      results.push(sum);
    }
    progress.remove();
    renderCraftResults(state, out, results, league, P, allowMissing);
  }

  function renderCraftResults(state, out, results, league, P, allowMissing) {
    var priced = results.filter(function (r) { return r.priced && r.expected !== undefined; })
                        .sort(function (a, b) { return a.expected - b.expected; });
    var best = priced[0] || null;
    var buy = state.cheapestChaos;

    var verdict = document.createElement('div');
    verdict.className = 'craft-verdict';
    if (best && buy !== undefined) {
      var craftWins = best.expected < buy;
      var ratio = craftWins ? buy / best.expected : best.expected / buy;
      verdict.textContent = (craftWins ? '⚒ Craft' : '🛒 Buy') + ' — ' +
        (craftWins ? best.label + ' averages ' + fmtEq(best.expected, league) + ' vs ' + fmtEq(buy, league) + ' for the cheapest listing'
                   : 'cheapest listing ' + fmtEq(buy, league) + ' vs ' + fmtEq(best.expected, league) + ' on average to craft (' + best.label + ')') +
        (ratio >= 1.5 ? ' · ' + (ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)) + '× cheaper' : ' · close call — luck decides');
    } else if (best) {
      verdict.textContent = 'Best craft: ' + best.label + ', ' + fmtEq(best.expected, league) + ' on average. Check price to compare with buying.';
      if (state.priceBtn) {
        var cb = UI.button('secondary');
        cb.textContent = 'Check buy price';
        cb.addEventListener('click', async function () {
          cb.disabled = true;
          await checkPrice(state);
          await annotateChaosEq(state);
          renderCraftResults(state, out, results, league, P, allowMissing);
        });
        verdict.appendChild(document.createTextNode(' '));
        verdict.appendChild(cb);
      }
    } else {
      verdict.textContent = 'No priced crafting route found — spamming is not realistic for these mods (see odds below).';
    }
    out.textContent = '';
    out.appendChild(verdict);

    var table = document.createElement('table');
    table.className = 'craft-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['Method', 'Odds per try', 'Cost per try', 'Average total', 'Unlucky (90%)'].forEach(function (h, i) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      if (i) th.className = 'num';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    results.forEach(function (r) {
      var tr = document.createElement('tr');
      if (r === best) tr.className = 'best';
      var cells = [
        r.label,
        fmtOdds(r),
        r.priced ? fmtEq(r.perTry, league) : 'no price',
        r.priced && r.expected !== undefined ? fmtEq(r.expected, league) : '—',
        r.priced && r.cost90 !== undefined ? fmtEq(r.cost90, league) : '—'
      ];
      cells.forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i) td.className = 'num';
        if (i === 2 && r.breakdown) { td.title = 'Per try: ' + r.breakdown; td.classList.add('has-tip'); }
        tr.appendChild(td);
      });
      if (r.breakdown) {
        var sub = document.createElement('div');
        sub.className = 'craft-breakdown';
        sub.textContent = r.breakdown;
        tr.firstChild.appendChild(sub);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    out.appendChild(table);

    var foot = document.createElement('div');
    foot.className = 'craft-note';
    var benchUsed = results.some(function (r) { return r.benchPer > 0; });
    foot.textContent = 'Target: ' + P.targets.length + ' mod' + (P.targets.length > 1 ? 's' : '') +
      (allowMissing ? ' (any ' + (P.targets.length - allowMissing) + ', matching the card\'s match mode)' : '') +
      ' at your minimum rolls, ilvl ' + P.ilvl + ' (implicits come with the base and aren\'t counted). Totals include ' + (benchUsed ? 'a finishing bench craft where it helps, ' : '') +
      'the base price you entered. Estimate only: models chaos, Screaming+ essence and fossil rerolls (4/5/6 affixes at 8:3:1; ' +
      'the best 1-, 2- and 3-fossil resonator combo, priced as resonator + fossils, "more" multipliers stacked additively as CraftOfExile/poeDB do — disputed) — ' +
      'not Glyphic, Tangled, Sanctified, Hollow, Fractured, Bloodstained or Gilded fossils, Opulent\'s tagless block, harvest, alt-regal, recombinators or fractured bases. ' +
      'Prices: GGG currency exchange.';
    out.appendChild(foot);
  }

  // ---- jewel finder --------------------------------------------------------------
  // Reads the passive tree + main skill (js/jewels.js), ranks every rare/abyss
  // jewel mod by how much THIS build wants it, then searches trade for the best
  // jewels (weighted) or any-N-of combos. Plus a timeless jewel seed search.
  var jewelDataPromise = null;
  function ensureJewelData() {
    if (window.POE_JEWELS) return Promise.resolve(window.POE_JEWELS);
    if (!jewelDataPromise) {
      jewelDataPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'data/jeweldata.js?v=' + Date.now();
        s.onload = function () { if (window.POE_JEWELS) resolve(window.POE_JEWELS); else reject(new Error('jewel data missing')); };
        s.onerror = function () { jewelDataPromise = null; reject(new Error('could not load data/jeweldata.js')); };
        document.head.appendChild(s);
      });
    }
    return jewelDataPromise;
  }

  var FEATURE_LABEL = { spell: 'Spells', attack: 'Attacks', melee: 'Melee', projectile: 'Projectiles', area: 'Area',
    fire: 'Fire', cold: 'Cold', lightning: 'Lightning', chaos: 'Chaos', physical: 'Physical', dot: 'Damage over time',
    minion: 'Minions', totem: 'Totems', trap: 'Traps', mine: 'Mines', brand: 'Brands', staff: 'Staff', bow: 'Bow',
    wand: 'Wand', shield: 'Shield', dualwield: 'Dual wield', twohand: 'Two-handed', crit: 'Crit',
    life: 'Life', es: 'Energy shield', block: 'Block', suppress: 'Suppression', evasion: 'Evasion', armour: 'Armour' };
  var JEWEL_KINDS = [
    ['regular', 'Any jewel (Crimson / Viridian / Cobalt)', 7, null, false],
    ['crimson', 'Crimson Jewel', 1, 'Crimson Jewel', false],
    ['viridian', 'Viridian Jewel', 2, 'Viridian Jewel', false],
    ['cobalt', 'Cobalt Jewel', 4, 'Cobalt Jewel', false],
    ['murderous', 'Murderous Eye (abyss, melee)', 8, 'Murderous Eye Jewel', true],
    ['searching', 'Searching Eye (abyss, ranged)', 16, 'Searching Eye Jewel', true],
    ['hypnotic', 'Hypnotic Eye (abyss, caster)', 32, 'Hypnotic Eye Jewel', true],
    ['ghastly', 'Ghastly Eye (abyss, minion)', 64, 'Ghastly Eye Jewel', true]
  ];
  var FINDER_DEFAULT_PICKS = 8, FINDER_SHOW = 24;

  // search-as-you-type box for the finder lists (fuzzy: typos, partial words, shorthand)
  function makeFinderSearch(parent, placeholder, onChange) {
    var row = document.createElement('div');
    row.className = 'finder-search';
    var inp = document.createElement('input');
    inp.type = 'search';
    inp.placeholder = placeholder;
    inp.setAttribute('aria-label', 'Search');
    var count = document.createElement('span');
    count.className = 'finder-sub';
    inp.addEventListener('input', onChange);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; onChange(); } });
    row.appendChild(inp);
    row.appendChild(count);
    parent.appendChild(row);
    inp.setCount = function (t) { count.textContent = t; };
    return inp;
  }
  // best matches first; ties keep the list's own order (relevance)
  function fuzzyFilter(items, q, textOf) {
    return items.map(function (it, i) { return { it: it, i: i, s: Jewels.fuzzyScore(q, textOf(it)) }; })
      .filter(function (x) { return x.s >= 0; })
      .sort(function (a, b) { return b.s - a.s || a.i - b.i; })
      .map(function (x) { return x.it; });
  }

  // a card-like state so price checks, paging, live search and pins all work
  function makeFinderState(label, container, payloadFn) {
    var st = { slot: label, item: { name: '', base: '', mods: [] }, rows: [], unique: false, card: null,
               customPayload: payloadFn };
    cards.push(st);
    var btns = document.createElement('div');
    btns.className = 'btns';
    var pBtn = UI.button('secondary', { cls: 'gui-only' });
    pBtn.textContent = 'Check price';
    pBtn.addEventListener('click', function () { checkPrice(st); });
    var lBtn = UI.button('secondary', { cls: 'gui-only' });
    lBtn.textContent = '🔴 Go live';
    lBtn.addEventListener('click', function () { toggleLive(st); });
    var oBtn = UI.button('primary');
    oBtn.textContent = 'Search on trade site ↗';
    oBtn.addEventListener('click', function () { var u = buildTradeUrl(st); if (u) openUrl(u); });
    btns.appendChild(pBtn); btns.appendChild(lBtn); btns.appendChild(oBtn);
    container.appendChild(btns);
    st.priceBtn = pBtn; st.liveBtn = lBtn;
    var lBox = document.createElement('div');
    lBox.className = 'price-box live-box hidden';
    container.appendChild(lBox);
    st.liveBox = lBox;
    var prBox = document.createElement('div');
    prBox.className = 'price-box hidden';
    container.appendChild(prBox);
    st.priceBox = prBox;
    return st;
  }

  function finderOpts() {
    return { status: document.getElementById('trade-status').value,
             saleType: document.getElementById('sale-type').value };
  }

  function makeJewelFinder(b) {
    var wrap = document.createElement('div');
    wrap.className = 'card finder';
    wrap.innerHTML = '<div class="finder-loading">Reading your passive tree…</div>';
    ensureJewelData().then(function (J) { renderJewelFinder(wrap, b, J); }, function (e) {
      wrap.textContent = '❌ ' + e.message;
    });
    return wrap;
  }

  function renderJewelFinder(wrap, b, J) {
    wrap.textContent = '';
    var P = Jewels.profile(b, J);

    // ---- header: what the build is about, and its sockets
    var head = document.createElement('div');
    head.className = 'finder-head';
    var h = document.createElement('h3');
    h.textContent = '💎 Jewel finder';
    head.appendChild(h);
    var focus = document.createElement('div');
    focus.className = 'finder-focus';
    focus.appendChild(document.createTextNode('Build focus: '));
    var keys = Object.keys(P.tally).filter(function (k) { return FEATURE_LABEL[k] && k !== 'life' && k !== 'es'; })
      .sort(function (a, c) { return (P.mainQ[c] ? 1e6 : 0) + P.tally[c] - ((P.mainQ[a] ? 1e6 : 0) + P.tally[a]); })
      .slice(0, 6);
    var life = P.tally.life || 0, es = P.tally.es || 0;
    keys.push(life + es ? (life > es * 1.5 ? 'life' : es > life * 1.5 ? 'es' : 'hybrid') : null);
    keys.filter(Boolean).forEach(function (k) {
      var chip = document.createElement('span');
      chip.className = 'finder-chip' + (P.mainQ[k] ? ' main' : '');
      chip.textContent = k === 'hybrid' ? 'Life + ES' : FEATURE_LABEL[k];
      var src = (P.why[k] || []).join(', ');
      chip.title = (P.mainQ[k] ? 'Your main skill is ' + FEATURE_LABEL[k].toLowerCase() + '. ' : '') +
        (src ? 'From: ' + src : '');
      focus.appendChild(chip);
    });
    head.appendChild(focus);
    var socks = Jewels.socketReport(b, J);
    var empty = socks.filter(function (s) { return !s.itemId; });
    var sline = document.createElement('div');
    sline.className = 'finder-sub';
    sline.textContent = socks.length
      ? socks.length + ' jewel socket' + (socks.length > 1 ? 's' : '') + ' allocated in your tree — ' +
        (empty.length ? empty.length + ' empty (' + empty.map(function (s) { return s.name; }).join(', ') + ')' : 'all filled') +
        (P.gems.length ? ' · main skill: ' + P.gems[0] : '')
      : 'No jewel sockets allocated' + (P.gems.length ? ' · main skill: ' + P.gems[0] : '');
    head.appendChild(sline);
    wrap.appendChild(head);

    // ---- controls
    var ctr = document.createElement('div');
    ctr.className = 'card-opts finder-opts';
    var kindSel = makeMiniSelect(ctr, 'Jewel', JEWEL_KINDS.map(function (k) { return k[1]; }), JEWEL_KINDS[0][1]);
    var hasAbyss = Object.keys(b.items).some(function (id) { return /Eye Jewel$/.test(b.items[id].base || ''); });
    // weighted searches exceed the anonymous query budget even with 2 mods (measured) —
    // without a saved POESESSID default to the any-N-of search, which fits
    var modeSel = makeMiniSelect(ctr, 'Find', ['best for my build', 'at least N of these'],
                                 HAS_SESSION ? 'best for my build' : 'at least N of these');
    if (!HAS_SESSION) modeSel.options[0].textContent = 'best for my build (needs POESESSID in-app)';
    var nSel = makeMiniSelect(ctr, 'N', ['2', '3', '4'], '2');
    var rollSel = makeMiniSelect(ctr, 'Min roll', ['any', '50%', '70%', '90%'], '50%');
    var sortSel = makeMiniSelect(ctr, 'Sort', ['best score', 'cheapest'], 'best score');
    var minQ = makeMiniSelect(ctr, 'Min quality', ['any', '30%', '45%', '60%'], '30%');
    minQ.title = 'Weighted search: minimum share of the best possible score (all your picked mods max-rolled)';
    var maxPrice = makeMiniInput(ctr, 'Max price', 'c');
    wrap.appendChild(ctr);
    if (hasAbyss) {
      var note = document.createElement('div');
      note.className = 'finder-sub';
      note.textContent = 'Your gear has abyssal sockets — pick an Eye jewel type above for abyss jewels.';
      wrap.appendChild(note);
    }

    // ---- ranked mod list
    var modSearch = makeFinderSearch(wrap, 'Search mods — e.g. "crit multi", "es recharge", "minion dmg"', function () { renderList(); });
    var list = document.createElement('div');
    list.className = 'finder-mods';
    wrap.appendChild(list);
    var picks = {}; // tail -> {use, required, score}
    var ranked = [];
    var showAll = false;

    function kind() { return JEWEL_KINDS.find(function (k) { return k[1] === kindSel.value; }) || JEWEL_KINDS[0]; }

    function rerank(resetPicks) {
      ranked = Jewels.rankMods(J, P, kind()[2]);
      if (resetPicks) {
        picks = {};
        ranked.slice(0, FINDER_DEFAULT_PICKS).forEach(function (m) {
          if (m.score >= 0.45) picks[m.tail] = { use: true, required: false, score: m.score };
        });
      }
      renderList();
    }

    function renderList() {
      list.textContent = '';
      var table = document.createElement('table');
      table.className = 'finder-table';
      var thead = document.createElement('thead');
      thead.innerHTML = '<tr><th scope="col">Use</th><th scope="col">Must</th><th scope="col">Mod</th>' +
        '<th scope="col" class="num">Best roll</th><th scope="col">Value to your build</th></tr>';
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      var q = modSearch.value.trim();
      var shown = q ? fuzzyFilter(ranked, q, function (m) { return m.text; }) : (showAll ? ranked : ranked.slice(0, FINDER_SHOW));
      modSearch.setCount(q ? shown.length + ' of ' + ranked.length + ' mods' : '');
      shown.forEach(function (m) {
        var p = picks[m.tail];
        var tr = document.createElement('tr');
        if (p && p.use) tr.className = 'on';
        var use = document.createElement('input');
        use.type = 'checkbox'; use.checked = !!(p && p.use);
        use.setAttribute('aria-label', 'Use ' + m.text);
        var must = document.createElement('input');
        must.type = 'checkbox'; must.checked = !!(p && p.required);
        must.setAttribute('aria-label', 'Require ' + m.text);
        use.addEventListener('change', function () {
          picks[m.tail] = picks[m.tail] || { score: m.score };
          picks[m.tail].use = use.checked;
          if (!use.checked) { picks[m.tail].required = false; must.checked = false; }
          tr.classList.toggle('on', use.checked);
        });
        must.addEventListener('change', function () {
          picks[m.tail] = picks[m.tail] || { score: m.score };
          picks[m.tail].required = must.checked;
          if (must.checked) { picks[m.tail].use = true; use.checked = true; tr.classList.add('on'); }
        });
        var td1 = document.createElement('td'); td1.appendChild(use);
        var td2 = document.createElement('td'); td2.appendChild(must);
        var td3 = document.createElement('td'); td3.textContent = m.text;
        var td4 = document.createElement('td'); td4.className = 'num'; td4.textContent = fmtCompact(m.max);
        var td5 = document.createElement('td');
        var val = document.createElement('input');
        val.type = 'range'; val.min = '0'; val.max = '100'; val.step = '5';
        val.value = String(Math.round(((p && p.score) || m.score) * 100));
        val.className = 'finder-val';
        val.setAttribute('aria-label', 'Value of ' + m.text + ' to your build');
        var pct = document.createElement('span');
        pct.className = 'finder-pct';
        pct.textContent = val.value + '%';
        val.addEventListener('input', function () {
          pct.textContent = val.value + '%';
          picks[m.tail] = picks[m.tail] || { use: false, score: m.score };
          picks[m.tail].score = parseInt(val.value, 10) / 100;
        });
        td5.appendChild(val); td5.appendChild(pct);
        [td1, td2, td3, td4, td5].forEach(function (td) { tr.appendChild(td); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      list.appendChild(table);
      if (!q && ranked.length > FINDER_SHOW) {
        var more = UI.button('secondary');
        more.textContent = showAll ? 'Show top ' + FINDER_SHOW : 'Show all ' + ranked.length + ' mods';
        more.addEventListener('click', function () { showAll = !showAll; renderList(); });
        list.appendChild(more);
      }
    }

    function selected() {
      return ranked.filter(function (m) { return picks[m.tail] && picks[m.tail].use; }).map(function (m) {
        return { tail: m.tail, max: m.max, score: picks[m.tail].score, required: !!picks[m.tail].required };
      });
    }

    function payload(quiet) {
      var sel = selected();
      if (!sel.length) {
        if (!quiet) UI.toast('Tick at least one mod in the jewel finder first.', 'warn');
        return null;
      }
      var k = kind();
      var opts = finderOpts();
      opts.abyss = k[4];
      opts.base = k[3];
      var mp = parseFloat(maxPrice.value);
      if (!isNaN(mp) && mp > 0) opts.maxPrice = mp;
      if (modeSel.value === 'at least N of these') {
        opts.count = parseInt(nSel.value, 10);
        opts.minRoll = rollSel.value === 'any' ? 0 : parseInt(rollSel.value, 10) / 100;
        return Jewels.countQuery(sel, opts);
      }
      var q = minQ.value === 'any' ? 0 : parseInt(minQ.value, 10) / 100;
      if (q) opts.minScore = Math.round(Jewels.maxScore(sel.filter(function (s) { return !s.required; }).length
        ? sel.filter(function (s) { return !s.required; }) : sel) * q);
      opts.sort = sortSel.value === 'cheapest' ? 'price' : 'score';
      return Jewels.weightedQuery(sel, opts);
    }

    function syncModeControls() {
      var count = modeSel.value === 'at least N of these';
      [nSel, rollSel].forEach(function (el) { el.parentElement.classList.toggle('hidden', !count); });
      [sortSel, minQ].forEach(function (el) { el.parentElement.classList.toggle('hidden', count); });
    }
    modeSel.addEventListener('change', syncModeControls);
    kindSel.addEventListener('change', function () { rerank(true); });
    syncModeControls();
    rerank(true);

    var hint = document.createElement('div');
    hint.className = 'finder-sub';
    hint.textContent = '"Best for my build" scores every listed jewel by your picks (a max roll is worth its value % × 100) ' +
      'and sorts by score — in-app checks of weighted searches need a saved POESESSID (higher query budget); ' +
      'the trade-site link works while you are logged in there.';
    wrap.appendChild(hint);
    makeFinderState('Jewel finder', wrap, payload);

  }

  // ---- timeless jewel finder ---------------------------------------------------------
  // Python bridge (timeless.py) reads Path of Building's timeless lookup tables:
  // for a chosen jewel + socket it lists every outcome the seed can give the
  // notables in radius, then ranks all seeds by the outcomes you value.
  var TIMELESS_TYPES = [[1, 'Glorious Vanity'], [2, 'Lethal Pride'], [3, 'Brutal Restraint'], [4, 'Militant Faith'],
                        [5, 'Elegant Hubris'], [6, 'Heroic Tragedy']];
  // seeds per price check: x4 conquerors must fit the trade site's filter budget
  // one conqueror = 1 filter per seed instead of up to 4
  function timelessPriceSeeds(oneConqueror) {
    return oneConqueror ? (HAS_SESSION ? 30 : 20) : (HAS_SESSION ? 10 : 5);
  }

  function makeTimelessFinder(b) {
    var wrap = document.createElement('div');
    wrap.className = 'card finder timeless-finder';
    var h = document.createElement('h3');
    h.textContent = '⏳ Timeless jewel finder';
    wrap.appendChild(h);
    var intro = document.createElement('div');
    intro.className = 'finder-sub';
    intro.textContent = 'Pick a socket from your tree: every seed is checked against the notables in its radius, ' +
      'ranked by the outcomes your build wants, and the best seeds can be priced in one click. ' +
      'Covers all six: Glorious Vanity, Lethal Pride, Brutal Restraint, Militant Faith, Elegant Hubris and Heroic Tragedy.';
    wrap.appendChild(intro);
    var body = document.createElement('div');
    wrap.appendChild(body);
    if (!isGui() || !window.pywebview.api.timeless_info) {
      body.className = 'finder-sub';
      body.textContent = 'Seed ranking needs the desktop app. You can still price seeds you already know below.';
      wrap.appendChild(makeTimelessPanel());
      return wrap;
    }
    body.textContent = 'Reading your tree…';
    ensureJewelData().then(function (J) {
      return window.pywebview.api.timeless_sockets(JSON.stringify(b.tree.nodes)).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'socket lookup failed');
        renderTimelessFinder(body, b, J, r.sockets);
        wrap.appendChild(makeTimelessPanel());
      });
    }).catch(function (e) { body.textContent = '❌ ' + (e.message || e); });
    return wrap;
  }

  function nodeName(J, id) { var n = J.tree[id]; return n ? n[1] : 'node ' + id; }

  function renderTimelessFinder(body, b, J, sockets) {
    body.textContent = '';
    var P = Jewels.profile(b, J);
    if (!sockets.length) {
      body.className = 'finder-sub';
      body.textContent = 'No jewel sockets are allocated in this tree — allocate one in PoB first.';
      return;
    }
    // timeless jewels the build already has socketed: {socket, jewel, seed} — their
    // sockets come first (the default), then the ones covering most of your notables
    var owned = ownedTimeless(b);
    function ownedAt(sock) { return owned.find(function (o) { return o.socket === sock; }); }
    sockets.sort(function (x, y) {
      return (ownedAt(y.socket) ? 1 : 0) - (ownedAt(x.socket) ? 1 : 0) || y.notables.length - x.notables.length;
    });
    var ctr = document.createElement('div');
    ctr.className = 'card-opts finder-opts';
    var jewelSel = makeMiniSelect(ctr, 'Jewel', TIMELESS_TYPES.map(function (t) { return t[1]; }), 'Brutal Restraint');
    // conqueror decides the keystone; the seed decides the notables
    var conqSel = UI.select([]);
    UI.field('Conqueror', conqSel, { parent: ctr,
      title: 'The conqueror only changes the keystone. Pricing searches this conqueror, or all of them with "any".' });
    function fillConquerors(prefer) {
      var keep = prefer !== undefined ? prefer : conqSel.value;
      conqSel.textContent = '';
      ['any'].concat(Jewels.TIMELESS[jewelSel.value] || []).forEach(function (c) {
        var o = document.createElement('option');
        o.value = c;
        o.textContent = c === 'any' ? 'any (keystone doesn\'t matter)'
          : c.charAt(0).toUpperCase() + c.slice(1) + ' — ' + (Jewels.KEYSTONES[c] || '');
        conqSel.appendChild(o);
      });
      conqSel.value = Array.prototype.some.call(conqSel.options, function (o) { return o.value === keep; }) ? keep : 'any';
    }
    // default conqueror for the current jewel + socket: your jewel's, else PoB's saved search
    function defaultConqueror() {
      var mine = owned.find(function (o) { return String(o.socket) === sockSel.value && o.jewel === jewelSel.value; });
      if (mine && mine.conqueror) return mine.conqueror;
      var ts = b.timelessSearch;
      if (ts && ts.jewelTypeId === jtype()) return Jewels.pobConqueror(ts.jewelTypeId, ts.conquerorTypeId) || 'any';
      return 'any';
    }
    var sockSel = UI.select(sockets.map(function (s) {
      var names = s.notables.map(function (n) { return nodeName(J, n); });
      var mineHere = ownedAt(s.socket);
      var text = (mineHere ? '★ Your ' + mineHere.jewel + ' ' + mineHere.seed + ' — ' : '') + (names.length
        ? 'socket near ' + names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '') +
          ' (' + names.length + ' of your notables)'
        : 'socket ' + s.socket + ' (none of your notables in radius)');
      return [String(s.socket), text.charAt(0).toUpperCase() + text.slice(1)];
    }));
    UI.field('Socket', sockSel, { parent: ctr });
    var unalloc = makeToggle(ctr, 'Also count unallocated notables', false);
    unalloc.checkbox.parentElement.title = 'Include notables in radius you have not taken — a good seed can make pathing to them worth it';
    body.appendChild(ctr);

    var summary = document.createElement('div');
    summary.className = 'finder-sub';
    body.appendChild(summary);
    var importedNote = document.createElement('div');
    importedNote.className = 'finder-sub';
    body.appendChild(importedNote);
    var outcomeSearch = makeFinderSearch(body, 'Search outcomes — e.g. "minion", "crit", "flask"', function () { if (info) renderOutcomes(); });
    var suggestBtn = UI.button('secondary');
    suggestBtn.textContent = '✨ Suggest for my build';
    suggestBtn.title = 'Tick the outcomes that match what your tree and main skill scale (value 50% or more)';
    suggestBtn.addEventListener('click', function () {
      if (!info) return;
      Object.keys(values).forEach(function (k) { if (values[k].value >= 50) values[k].use = true; });
      renderOutcomes();
    });
    var clearBtn = UI.button('secondary');
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', function () {
      if (!info) return;
      Object.keys(values).forEach(function (k) { values[k].use = false; values[k].need = 0; });
      renderOutcomes();
    });
    outcomeSearch.parentElement.appendChild(suggestBtn);
    outcomeSearch.parentElement.appendChild(clearBtn);
    var outcomesBox = document.createElement('div');
    body.appendChild(outcomesBox);
    var findBtn = UI.button('primary');
    findBtn.textContent = '🔎 Find best seeds';
    var resultsBox = document.createElement('div');
    resultsBox.className = 'timeless-results';

    var info = null, values = {}, seq = 0;
    var priced = { name: '', seeds: [] };

    function jtype() { return TIMELESS_TYPES.find(function (t) { return t[1] === jewelSel.value; })[0]; }

    function load() {
      var my = ++seq;
      summary.textContent = 'Loading ' + jewelSel.value + ' data (the first time downloads ' +
        (jtype() === 1 ? '~22 MB' : '~2 MB') + ' from Path of Building)…';
      outcomesBox.textContent = '';
      resultsBox.textContent = '';
      fillConquerors(defaultConqueror());
      window.pywebview.api.timeless_info(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes)).then(function (r) {
        if (my !== seq) return;
        if (!r || !r.ok) { summary.textContent = '❌ ' + ((r && r.error) || 'failed'); return; }
        info = r;
        // nothing is picked for you unless the build carries PoB's own timeless search
        // weights; values are pre-filled from what the build scales, Suggest ticks them
        values = {};
        r.outcomes.forEach(function (o) {
          values[o.key] = { use: false, value: Math.round(Jewels.scoreText(P, o.sd.join('\n')) * 100), need: 0 };
        });
        importedNote.textContent = '';
        var ts = b.timelessSearch;
        if (ts && ts.searchList.length && (!ts.jewelTypeId || ts.jewelTypeId === jtype())) {
          var maxW = Math.max.apply(null, ts.searchList.map(function (x) { return Math.abs(x.weight1) || 0; }).concat([1]));
          var n = 0;
          ts.searchList.forEach(function (row) {
            var o = r.outcomes.find(function (x) { return x.id === row.id; });
            if (!o) return;
            values[o.key] = { use: true, value: Math.max(-100, Math.min(100, Math.round(100 * row.weight1 / maxW))),
                              need: row.minimum > 0 ? 1 : 0 };
            n++;
          });
          if (n) importedNote.textContent = '✔ Imported ' + n + ' outcome weight' + (n > 1 ? 's' : '') +
            ' from this build\'s Path of Building timeless search.';
        }
        if (!importedNote.textContent) {
          importedNote.textContent = 'Nothing is ticked yet: tick the outcomes you want (search below), or let ✨ Suggest pick from what your build scales.';
        }
        var allocN = r.notables.filter(function (n) { return n.allocated; }).length;
        var allocS = r.smalls.filter(function (n) { return n.allocated; }).length;
        summary.textContent = r.notables.length + ' notables in radius (' + allocN + ' yours) · ' +
          r.smalls.length + ' small passives (' + allocS + ' yours): ' + r.small +
          (r.keystones.length ? ' · keystones in radius: ' + r.keystones.map(function (k) { return nodeName(J, k); }).join(', ') +
            ' (changed by the conqueror, not the seed)' : '');
        renderOutcomes();
        showCurrentSeed(my);
      }, function (e) { if (my === seq) summary.textContent = '❌ ' + e; });
    }

    // the jewel the build already has in this socket (opened from its card)
    var currentSeed = null; // {jewel, seed}
    var currentBox = document.createElement('div');
    currentBox.className = 'timeless-current';
    function showCurrentSeed(my) {
      currentBox.textContent = '';
      // explicit preset (from a card), else a jewel the build already has in this socket
      var mine = owned.find(function (o) { return String(o.socket) === sockSel.value && o.jewel === jewelSel.value; });
      if ((!currentSeed || currentSeed.jewel !== jewelSel.value) && mine) currentSeed = { jewel: mine.jewel, seed: mine.seed };
      if (!currentSeed || currentSeed.jewel !== jewelSel.value) return;
      window.pywebview.api.timeless_seed(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes),
                                         currentSeed.seed, unalloc.checkbox.checked).then(function (r) {
        if (my !== seq || !r || !r.ok) { if (r && !r.ok) currentBox.textContent = '❌ ' + r.error; return; }
        var score = 0;
        var title = document.createElement('b');
        title.textContent = 'Your jewel (seed ' + r.seed + ') here: ';
        currentBox.appendChild(title);
        r.notables.forEach(function (p, i) {
          var w = entryWeight(p);
          score += w;
          var span = document.createElement('span');
          span.className = w > 0 ? 'ts-hit' : w < 0 ? 'ts-avoid' : 'ts-miss';
          span.textContent = nodeName(J, p.node) + ' → ' + entryLabel(p);
          if (i) currentBox.appendChild(document.createTextNode(' · '));
          currentBox.appendChild(span);
        });
        currentBox.appendChild(document.createTextNode('  — score ' + score.toFixed(2) +
          ' with your current picks. Find best seeds to compare.'));
      });
    }
    outcomesBox.parentNode.insertBefore(currentBox, outcomesBox);

    // open on a given jewel/socket (from a timeless jewel card in the build)
    timelessApplyPreset = function (p) {
      if (p.jewel && TIMELESS_TYPES.some(function (t) { return t[1] === p.jewel; })) jewelSel.value = p.jewel;
      if (p.socket) {
        var sv = String(p.socket);
        if (!Array.prototype.some.call(sockSel.options, function (o) { return o.value === sv; })) {
          var o = document.createElement('option');
          o.value = sv;
          o.textContent = 'Socket ' + sv + ' (your jewel\'s socket)';
          sockSel.appendChild(o);
        }
        sockSel.value = sv;
      }
      currentSeed = p.seed ? { jewel: p.jewel, seed: p.seed } : null;
      load();
    };

    function renderOutcomes() {
      outcomesBox.textContent = '';
      var table = document.createElement('table');
      table.className = 'finder-table';
      table.innerHTML = '<caption class="finder-sub">Everything a ' + esc(jewelSel.value) + ' can do to a notable here, across all seeds — ' +
        'tick what you want, then <b>Find best seeds</b>. Small passives always get: ' + esc(info.small) + '.</caption>' +
        '<thead><tr><th scope="col">Use</th><th scope="col">Possible outcome on a notable</th>' +
        '<th scope="col" class="num" title="Share of (seed, notable) pairs at this socket that get this outcome">Chance</th><th scope="col" class="num" title="Minimum number of your notables that must get this — seeds with fewer are dropped">Need ×</th>' +
        '<th scope="col">Value to your build (left = avoid)</th></tr></thead>';
      var tbody = document.createElement('tbody');
      var maxNeed = Math.max(1, info.notables.filter(function (n) { return n.allocated || unalloc.checkbox.checked; }).length);
      var oq = outcomeSearch.value.trim();
      var shownOutcomes = oq ? fuzzyFilter(info.outcomes, oq, function (o) { return o.dn + ' ' + o.sd.join(' '); }) : info.outcomes;
      outcomeSearch.setCount(oq ? shownOutcomes.length + ' of ' + info.outcomes.length + ' outcomes' : '');
      shownOutcomes.forEach(function (o) {
        var st = values[o.key];
        var tr = document.createElement('tr');
        if (st.use) tr.className = 'on';
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = st.use;
        cb.setAttribute('aria-label', 'Use ' + o.dn);
        cb.addEventListener('change', function () {
          st.use = cb.checked; tr.classList.toggle('on', cb.checked);
          if (!cb.checked) { st.need = 0; need.value = ''; }
        });
        var need = document.createElement('input');
        need.type = 'number'; need.min = '0'; need.max = String(maxNeed); need.step = '1';
        need.className = 'min-input ts-need';
        need.placeholder = '–';
        need.value = st.need ? String(st.need) : '';
        need.setAttribute('aria-label', 'At least this many notables with ' + o.dn);
        need.addEventListener('change', function () {
          st.need = Math.max(0, Math.min(maxNeed, parseInt(need.value, 10) || 0));
          need.value = st.need ? String(st.need) : '';
          if (st.need) { st.use = true; cb.checked = true; tr.classList.add('on'); }
        });
        var td1 = document.createElement('td'); td1.appendChild(cb);
        var td2 = document.createElement('td');
        var name = document.createElement('b');
        name.textContent = (o.replace ? 'Becomes ' : '') + o.dn;
        td2.appendChild(name);
        td2.appendChild(document.createTextNode(' — ' + o.sd.join(' · ')));
        var td3 = document.createElement('td'); td3.className = 'num';
        td3.textContent = (o.share * 100).toFixed(1) + '%';
        var tdN = document.createElement('td'); tdN.className = 'num'; tdN.appendChild(need);
        var td4 = document.createElement('td');
        var val = document.createElement('input');
        val.type = 'range'; val.min = '-100'; val.max = '100'; val.step = '5'; val.value = String(st.value);
        val.className = 'finder-val';
        val.setAttribute('aria-label', 'Value of ' + o.dn + ' (negative avoids it)');
        var pct = document.createElement('span');
        pct.className = 'finder-pct';
        function showVal() { pct.textContent = st.value < 0 ? 'avoid ' + (-st.value) + '%' : st.value + '%'; pct.classList.toggle('avoid', st.value < 0); }
        showVal();
        val.addEventListener('input', function () {
          st.value = parseInt(val.value, 10);
          showVal();
          if (st.value < 0 && !st.use) { st.use = true; cb.checked = true; tr.classList.add('on'); }
        });
        td4.appendChild(val); td4.appendChild(pct);
        [td1, td2, td3, tdN, td4].forEach(function (td) { tr.appendChild(td); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      outcomesBox.appendChild(table);
      outcomesBox.appendChild(findBtn);
      outcomesBox.appendChild(resultsBox);
    }

    findBtn.addEventListener('click', function () {
      if (!info) return;
      var weights = {}, mins = {};
      Object.keys(values).forEach(function (k) {
        if (!values[k].use) return;
        if (values[k].value) weights[k] = values[k].value / 100;
        if (values[k].need > 0) mins[k] = values[k].need;
      });
      var anyWant = Object.keys(weights).some(function (k) { return weights[k] > 0; }) || Object.keys(mins).length;
      if (!anyWant) { resultsBox.textContent = 'Tick at least one outcome you want (or set a Need ×).'; return; }
      var my = ++seq;
      resultsBox.textContent = 'Checking every ' + jewelSel.value + ' seed…';
      lastMins = mins;
      window.pywebview.api.timeless_search(jtype(), parseInt(sockSel.value, 10), JSON.stringify(b.tree.nodes),
                                           JSON.stringify(weights), unalloc.checkbox.checked,
                                           JSON.stringify(mins)).then(function (r) {
        if (my !== seq) return;
        if (!r || !r.ok) { resultsBox.textContent = '❌ ' + ((r && r.error) || 'failed'); return; }
        renderSeeds(r);
      }, function (e) { if (my === seq) resultsBox.textContent = '❌ ' + e; });
    });

    function outcomeLabel(key) {
      var o = info.outcomes.find(function (x) { return x.key === key; });
      return o ? o.dn : key;
    }
    var lastMins = {};

    // "Minion Damage ×3 (60%)": count, plus the summed value when the outcome is
    // a single fixed number ("Minions deal 20% increased Damage")
    // one notable's result: "Might of the Vaal: Fire Damage 12, Life 3" / "Ritual of Flesh [8/27]"
    function entryLabel(p) {
      var keys = p.keys || [p.key];
      function rollTxt(k) {
        var r = p.rolls && p.rolls[k];
        return r === undefined || r === null ? '' : Array.isArray(r) ? ' [' + r.join('/') + ']' : ' ' + r;
      }
      var head = outcomeLabel(keys[0]) + rollTxt(keys[0]);
      return keys.length > 1 ? head + ': ' + keys.slice(1).map(function (k) { return outcomeLabel(k) + rollTxt(k); }).join(', ') : head;
    }
    function entryWeight(p) {
      return (p.keys || [p.key]).reduce(function (s, k) {
        var v = values[k];
        return s + (v && v.use ? v.value / 100 : 0);
      }, 0);
    }

    function outcomeTotal(key, n, rollTotal) {
      var o = info.outcomes.find(function (x) { return x.key === key; });
      var label = (o ? o.dn.replace(/^Add /, '') : key) + ' ×' + n;
      if (rollTotal) { // Glorious Vanity rolls: show the summed value
        return label + ' (+' + rollTotal + (o && /%/.test(o.sd.join(' ')) ? '%' : '') + ')';
      }
      if (o && o.sd.length === 1) {
        var m = o.sd[0].match(/([+-]?)(\d+(?:\.\d+)?)(%?)/);
        if (m && !/\(\d/.test(o.sd[0])) label += ' (' + m[1] + (Math.round(parseFloat(m[2]) * n * 10) / 10) + m[3] + ')';
      }
      return label;
    }

    function renderSeeds(r) {
      resultsBox.textContent = '';
      if (!r.results.length) {
        resultsBox.textContent = 'No seed gives any of the ticked outcomes on ' +
          (unalloc.checkbox.checked ? 'these notables' : 'your allocated notables') + ' here.';
        return;
      }
      var head = document.createElement('div');
      head.className = 'finder-sub';
      var needTxt = Object.keys(lastMins).map(function (k) { return outcomeLabel(k).replace(/^Add /, '') + ' ×' + lastMins[k] + '+'; });
      head.textContent = r.matches + ' seeds ' + (needTxt.length ? 'meet ' + needTxt.join(' and ') : 'give at least one wanted outcome') +
        ' on the ' + r.considered.length + ' notable' + (r.considered.length === 1 ? '' : 's') + ' counted. Best ' + r.results.length + ':';
      resultsBox.appendChild(head);
      var priceTop = UI.button('secondary');
      var oneConq = conqSel.value !== 'any';
      priceTop.textContent = '💰 Price the top ' + Math.min(timelessPriceSeeds(oneConq), r.results.length) + ' seeds' +
        (oneConq ? ' (' + conqSel.value.charAt(0).toUpperCase() + conqSel.value.slice(1) + ')' : ' (any conqueror)');
      if (!HAS_SESSION) priceTop.title = 'Saving a POESESSID raises how many seeds fit in one trade search';
      priceTop.addEventListener('click', function () {
        priced.name = jewelSel.value;
        priced.conqueror = conqSel.value === 'any' ? '' : conqSel.value;
        priced.seeds = r.results.slice(0, timelessPriceSeeds(!!priced.conqueror)).map(function (x) { return x.seed; });
        checkPrice(priceState);
      });
      resultsBox.appendChild(priceTop);
      var table = document.createElement('table');
      table.className = 'finder-table timeless-seeds';
      table.innerHTML = '<thead><tr><th scope="col" class="num">Seed</th><th scope="col" class="num">Score</th>' +
        '<th scope="col">What your notables become</th><th scope="col"></th></tr></thead>';
      var tbody = document.createElement('tbody');
      r.results.forEach(function (x) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.className = 'num'; td1.textContent = x.seed;
        var td2 = document.createElement('td'); td2.className = 'num'; td2.textContent = x.score.toFixed(2);
        var td3 = document.createElement('td');
        // headline: totals of the outcomes you care about (wanted first, then avoided)
        var tot = document.createElement('div');
        tot.className = 'ts-totals';
        Object.keys(x.counts || {}).filter(function (k) { return values[k] && values[k].use; })
          .sort(function (a, c) { return (values[c].value - values[a].value) || (x.counts[c] - x.counts[a]); })
          .forEach(function (k, i) {
            var chip = document.createElement('span');
            chip.className = values[k].value < 0 ? 'ts-avoid' : 'ts-hit';
            chip.textContent = outcomeTotal(k, x.counts[k], x.rollTotals && x.rollTotals[k]);
            if (i) tot.appendChild(document.createTextNode(' · '));
            tot.appendChild(chip);
          });
        if (!tot.childNodes.length) tot.textContent = '—';
        td3.appendChild(tot);
        var det = document.createElement('details');
        var sm = document.createElement('summary');
        sm.textContent = 'per notable';
        det.appendChild(sm);
        x.notables.forEach(function (p, i) {
          var span = document.createElement('span');
          span.className = p.weight > 0 ? 'ts-hit' : p.weight < 0 ? 'ts-avoid' : 'ts-miss';
          span.textContent = nodeName(J, p.node) + ' → ' + entryLabel(p);
          if (i) det.appendChild(document.createTextNode(' · '));
          det.appendChild(span);
        });
        td3.appendChild(det);
        var td4 = document.createElement('td');
        var pb = UI.button('secondary');
        pb.textContent = 'Price';
        pb.title = 'Find listings of this ' + jewelSel.value + ' seed (' +
          (conqSel.value === 'any' ? 'any conqueror' : conqSel.value) + ')';
        pb.addEventListener('click', function () {
          priced.name = jewelSel.value;
          priced.conqueror = conqSel.value === 'any' ? '' : conqSel.value;
          priced.seeds = [x.seed];
          checkPrice(priceState);
        });
        td4.appendChild(pb);
        [td1, td2, td3, td4].forEach(function (td) { tr.appendChild(td); });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      resultsBox.appendChild(table);
      resultsBox.appendChild(priceBlock);
    }

    // price box for the chosen seeds — the normal listing view, live search, pins
    var priceBlock = document.createElement('div');
    var priceState = makeFinderState('Timeless jewel', priceBlock, function (quiet) {
      if (!priced.seeds.length) { if (!quiet) UI.toast('Find seeds first, then price them.', 'warn'); return null; }
      var o = finderOpts(); o.anonymous = !HAS_SESSION;
      var q = Jewels.timelessQuery(priced.name, priced.seeds, priced.conqueror || '', o);
      return { query: q.query, sort: q.sort };
    });

    [jewelSel, sockSel].forEach(function (el) { el.addEventListener('change', load); });
    if (!timelessPending && owned.length) {
      // open on the build's own timeless jewel: its type, its socket, its seed
      timelessPending = { jewel: owned[0].jewel, socket: owned[0].socket, seed: owned[0].seed };
    } else if (!timelessPending && b.timelessSearch && b.timelessSearch.jewelTypeId) {
      // no jewel yet, but the build author set up PoB's timeless search: start there
      var tsType = TIMELESS_TYPES.find(function (t) { return t[0] === b.timelessSearch.jewelTypeId; });
      if (tsType) timelessPending = { jewel: tsType[1], socket: b.timelessSearch.socketId || null, seed: null };
    }
    if (timelessPending) { var pend = timelessPending; timelessPending = null; timelessApplyPreset(pend); }
    else load();
  }

  // Timeless jewels socketed in the build's tree, with their seeds read from the mod text
  var TIMELESS_SEED_RE = /^(?:Bathed in the blood of|Commanded leadership over|Denoted service of|Carved to glorify|Commissioned|Remembrancing) (\d+)/i;
  function ownedTimeless(b) {
    var out = [];
    ((b.tree && b.tree.sockets) || []).forEach(function (s) {
      var item = s.itemId && b.items[s.itemId];
      if (!item) return;
      var name = resolveUniqueName(item.name);
      if (!TIMELESS_TYPES.some(function (t) { return t[1] === name; })) return;
      var seed = null, conq = '';
      (item.mods || []).some(function (m) {
        var x = TIMELESS_SEED_RE.exec(m.line);
        if (!x) return false;
        seed = parseInt(x[1], 10);
        // the line ends with the conqueror: "…in the akhara of Balbala"
        var last = (m.line.match(/(\w+)\s*$/) || [])[1];
        if (last && (Jewels.TIMELESS[name] || []).indexOf(last.toLowerCase()) !== -1) conq = last.toLowerCase();
        return true;
      });
      if (seed) out.push({ socket: s.nodeId, jewel: name, seed: seed, conqueror: conq });
    });
    return out;
  }

  // "Find seeds for this socket" on a timeless jewel card → Timeless tab, preset
  var timelessApplyPreset = null, timelessPending = null;
  function openTimelessFor(state) {
    var itemId = build && Object.keys(build.items).find(function (k) { return build.items[k] === state.item; });
    var sock = itemId && build.tree && build.tree.sockets.find(function (s) { return s.itemId === itemId; });
    var seedRow = state.rows.find(function (r) { return r.match && /^explicit\.pseudo_timeless_jewel_/.test(r.match.entry.id); });
    var seed = seedRow ? Math.round(parseFloat(seedRow.minInput.value)) : null;
    var preset = { jewel: state.resolvedName, socket: sock ? sock.nodeId : null, seed: seed && !isNaN(seed) ? seed : null };
    setView('timeless');
    if (timelessApplyPreset) timelessApplyPreset(preset);
    else timelessPending = preset;
    window.scrollTo(0, 0);
  }

  function makeTimelessPanel() {
    var box = document.createElement('details');
    box.className = 'finder-timeless';
    var sum = document.createElement('summary');
    sum.textContent = 'Price seeds you already have';
    box.appendChild(sum);
    var p = document.createElement('div');
    p.className = 'finder-sub';
    p.appendChild(document.createTextNode('Find the seeds you want with the '));
    var a = document.createElement('a');
    a.href = '#';
    a.textContent = 'timeless jewel calculator ↗';
    a.addEventListener('click', function (e) { e.preventDefault(); openUrl('https://vilsol.github.io/timeless-jewels/tree'); });
    p.appendChild(a);
    p.appendChild(document.createTextNode(', then paste them here to see every listing with those seeds.'));
    box.appendChild(p);
    var ctr = document.createElement('div');
    ctr.className = 'card-opts';
    var names = Object.keys(Jewels.TIMELESS);
    var jewelSel = makeMiniSelect(ctr, 'Jewel', names, names[0]);
    var conqSel = makeMiniSelect(ctr, 'Conqueror', ['any'], 'any');
    function fillConq() {
      conqSel.innerHTML = '';
      ['any'].concat(Jewels.TIMELESS[jewelSel.value]).forEach(function (c) {
        var o = document.createElement('option');
        o.value = c; o.textContent = c === 'any' ? 'any' : c.charAt(0).toUpperCase() + c.slice(1);
        conqSel.appendChild(o);
      });
    }
    jewelSel.addEventListener('change', fillConq);
    fillConq();
    var seeds = UI.input({ cls: 'finder-seeds', placeholder: 'Seeds, e.g. 4521, 7790, 12003' });
    UI.field('Seeds', seeds, { parent: ctr });
    box.appendChild(ctr);
    var warn = document.createElement('div');
    warn.className = 'finder-sub';
    box.appendChild(warn);
    makeFinderState('Timeless jewel', box, function (quiet) {
      var s = Jewels.parseSeeds(seeds.value);
      if (!s.length) { if (!quiet) UI.toast('Enter at least one seed number.', 'warn'); return null; }
      var q = Jewels.timelessQuery(jewelSel.value, s, conqSel.value === 'any' ? '' : conqSel.value, finderOpts());
      warn.textContent = q.truncated ? 'Too many seed × conqueror combinations — searching the first 40. Pick a conqueror or fewer seeds.' : '';
      return { query: q.query, sort: q.sort };
    });
    return box;
  }

  // ---- per-build search history ------------------------------------------------
  // { buildKey: { slotKey: [ {ts, league, payloadStr, total, first} ] } }
  var HISTORY_PER_SLOT = 8, HISTORY_BUILDS = 30;
  function buildKey() {
    var s = document.getElementById('pob-input').value.trim(), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'b' + h.toString(16);
  }
  function slotKey(state) {
    return state.slot + '|' + ((state.item && (state.item.name || state.item.base)) ||
                               (state.gemSpec && state.gemSpec.gem.name) || '');
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem('pobtf-history')) || {}; }
    catch (e) { return {}; }
  }
  function slotHistory(state) {
    return ((loadHistory()[buildKey()] || {})[slotKey(state)]) || [];
  }
  function tradeUrlFor(league, payloadStr) {
    return 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) +
           '?q=' + encodeURIComponent(payloadStr);
  }
  // ps is the priceState the listings came from (frozen — a newer search may
  // have replaced state.priceState by the time chaos equivalents resolve).
  // Re-running the same search appends an observation, so each saved search
  // carries its own "cheapest over time" series.
  var HISTORY_OBS = 30;
  function recordHistory(state, res, ps) {
    if (!ps) return;
    var all = loadHistory(), bk = buildKey(), sk = slotKey(state);
    var byPrice = !ps.payloadStr || JSON.parse(ps.payloadStr).sort.price !== undefined;
    var first = (byPrice && res.listings && res.listings[0]) || null;
    var chaos = byPrice && ps.cheapestChaos !== undefined ? Math.round(ps.cheapestChaos * 10) / 10 : null;
    var slotList = (all[bk] = all[bk] || {})[sk] || [];
    var prev = null;
    slotList = slotList.filter(function (h) {
      if (h.payloadStr === ps.payloadStr && h.league === ps.league) { prev = h; return false; }
      return true;
    });
    var now = Date.now();
    var obs = ((prev && prev.obs) || []).concat(chaos !== null ? [[now, chaos]] : []).slice(-HISTORY_OBS);
    slotList.unshift({ ts: now, league: ps.league, payloadStr: ps.payloadStr, total: res.total,
                       first: first && first.amount != null ? first.amount + ' ' + first.currency : null,
                       obs: obs });
    all[bk][sk] = slotList.slice(0, HISTORY_PER_SLOT);
    all[bk]._ts = Date.now();
    var keys = Object.keys(all).sort(function (a, b) { return (all[b]._ts || 0) - (all[a]._ts || 0); });
    keys.slice(HISTORY_BUILDS).forEach(function (k) { delete all[k]; });
    try { persist('pobtf-history', JSON.stringify(all)); } catch (e) { /* storage full */ }
    renderHistorySelect(state);
  }
  function renderHistorySelect(state) {
    var sel = state.historySel;
    if (!sel) return;
    var hist = slotHistory(state);
    sel.classList.toggle('hidden', !hist.length);
    sel.innerHTML = '<option value="">🕘 History (' + hist.length + ')</option>';
    hist.forEach(function (h, i) {
      var o = document.createElement('option');
      o.value = String(i);
      var d = new Date(h.ts);
      var obs = h.obs || [];
      var trend = obs.length > 1 ? ' · ' + fmtDelta(obs[0][1], obs[obs.length - 1][1]) + ' over ' + obs.length + ' checks' : '';
      o.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' · ' + h.league +
        ' · ' + (h.total != null ? h.total + ' listed' : '?') + (h.first ? ' · from ' + h.first : '') + trend;
      sel.appendChild(o);
    });
    // cheapest-over-time for the newest search, once it has been re-checked
    var box = state.trendBox;
    if (!box) return;
    box.textContent = '';
    var latest = hist[0], obs0 = (latest && latest.obs) || [];
    box.classList.toggle('hidden', obs0.length < 2);
    if (obs0.length < 2) return;
    var pts = obs0.map(function (o) { return { t: o[0] / 1000, v: o[1] }; });
    var lbl = document.createElement('span');
    lbl.textContent = 'Cheapest';
    box.appendChild(lbl);
    box.appendChild(sparkline(pts, { w: 72, label: 'Cheapest listing for this search over ' + pts.length + ' checks',
      fmt: function (v) { return fmtEq(v, latest.league); } }));
    var val = document.createElement('span');
    val.textContent = fmtEq(pts[0].v, latest.league) + ' → ' + fmtEq(pts[pts.length - 1].v, latest.league);
    box.appendChild(val);
  }

  // ---- gem shopping list ----------------------------------------------------------
  // PoB writes support gems without the " Support" suffix ("Enhance") but the
  // trade site and art database use the full name ("Enhance Support").
  function gemTradeName(name) {
    var I = window.POE_BASE_ICONS || {};
    if (I[name]) return name;
    if (I[name + ' Support']) return name + ' Support';
    return name;
  }
  function gemArtPath(name) {
    var I = window.POE_BASE_ICONS || {};
    var base = name.split(' of ')[0]; // transfigured gems share base art
    return I[name] || I[name + ' Support'] || I[base] || I[base + ' Support'] || null;
  }
  // transfigured gems are a discriminated base type on the trade API — sending
  // the full name as a plain type string gets HTTP 400 "Unknown item base type"
  function gemDisc(name) { return (window.POE_GEM_TYPES || {})[name] || null; }
  function gemIconLookup(name) {
    var tf = gemDisc(name);
    return window.pywebview.api.gem_icon(gemTradeName(name), tf ? tf.t : null, tf ? tf.d : null);
  }

  function gemPayload(gem, level, quality) {
    var misc = {};
    if (level > 1) misc.gem_level = { min: level };
    if (quality > 0) misc.quality = { min: quality };
    var filters = {};
    if (Object.keys(misc).length) filters.misc_filters = { filters: misc };
    var saleType = document.getElementById('sale-type').value;
    if (saleType !== 'any') filters.trade_filters = { filters: { sale_type: { option: saleType } } };
    var tf = gemDisc(gem.name);
    var query = {
      status: { option: document.getElementById('trade-status').value },
      type: tf ? { option: tf.t, discriminator: tf.d } : gemTradeName(gem.name)
    };
    if (Object.keys(filters).length) query.filters = filters;
    return { query: query, sort: { price: 'asc' } };
  }

  function gemUrl(payload) {
    var league = document.getElementById('league').value;
    return 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) +
           '?q=' + encodeURIComponent(JSON.stringify(payload));
  }

  function gemsWord(n) { return n + (n === 1 ? ' gem' : ' gems'); }

  // prefixed/renamed uniques ("Foulborn The Red Nightmare") -> exact trade name
  function resolveUniqueName(name) {
    var T = window.POE_UNIQUE_NAMES;
    if (!name || !T) return name;
    if (T[name]) return name;
    var best = null;
    for (var k in T) {
      if (name.length <= k.length || (best && k.length <= best.length)) continue;
      // "Foulborn The Red Nightmare" (prefix) or PoB's renamed copies like
      // "Brutal Restraint 2582; 3; Minion Instability" (suffix after a space)
      if (name.slice(-k.length) === k || name.slice(0, k.length + 1) === k + ' ') best = k;
    }
    return best || name;
  }

  var FLASK_BASE_KEYS = null;
  function findFlaskBase(name) {
    if (!name || !window.POE_BASE_ICONS) return null;
    if (!FLASK_BASE_KEYS) {
      FLASK_BASE_KEYS = Object.keys(window.POE_BASE_ICONS)
        .filter(function (k) { return / (Flask|Tincture)$/.test(k) || /Flask$|Tincture$/.test(k); })
        .sort(function (a, b) { return b.length - a.length; });
    }
    for (var i = 0; i < FLASK_BASE_KEYS.length; i++) {
      if (name.indexOf(FLASK_BASE_KEYS[i]) !== -1) return FLASK_BASE_KEYS[i];
    }
    return null;
  }

  // RePoE gem art is often a horizontal multi-frame atlas — crop to frame one,
  // but only when the ratio is a near-exact frame multiple (wide single-frame
  // art must not get chopped)
  function markAtlas() {
    if (this.dataset.swapped) return;
    var ratio = this.naturalWidth / Math.max(1, this.naturalHeight);
    var frames = Math.round(ratio);
    if (frames >= 2 && Math.abs(ratio - frames) < 0.12) {
      this.classList.add('atlas2');
    }
  }

  function applyGemIcon(name, icon) {
    document.querySelectorAll('img[data-gem="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]')
      .forEach(function (img) {
        img.src = icon;
        img.dataset.swapped = '1';
        img.classList.remove('atlas2');
      });
  }

  // background: swap every gem row to the trade site's single-frame art.
  // First run costs throttled lookups; afterwards it's all disk cache.
  async function resolveGemIcons(names, round) {
    if (!isGui() || !window.pywebview.api.gem_icon) return;
    round = round || 0;
    var skipped = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (GEM_ICONS[name]) { applyGemIcon(name, GEM_ICONS[name]); continue; }
      try {
        var res = await gemIconLookup(name);
        if (res && res.ok && res.icon) {
          GEM_ICONS[name] = res.icon;
          applyGemIcon(name, res.icon);
        } else if (res && /cooldown/i.test(res.error || '')) {
          skipped.push(name); // lookups yield to rate limits — try these again later
        }
      } catch (e) { return; /* bridge gone — stop quietly */ }
    }
    if (skipped.length && round < ICON_RETRIES) {
      setTimeout(function () { resolveGemIcons(skipped, round + 1); }, ICON_RETRY_MS);
    }
  }

  function makeGemsCard(gemGroups) {
    var totalGems = 0;
    gemGroups.forEach(function (g) { totalGems += g.gems.length; });
    var card = document.createElement('div');
    card.className = 'card';
    var head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = '<div><span class="slot-tag">Skill Gems</span>' +
      '<span class="item-name normal">' + gemGroups.length +
      (gemGroups.length === 1 ? ' link group' : ' link groups') + ' · ' + gemsWord(totalGems) + '</span></div>';
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'card-body';
    var rows = [];

    // two levels: gear piece -> link groups socketed in it
    var bySlot = {}, slotOrder = [];
    gemGroups.forEach(function (g) {
      var key = g.slot || 'Unassigned';
      if (!bySlot[key]) { bySlot[key] = []; slotOrder.push(key); }
      bySlot[key].push(g);
    });

    slotOrder.forEach(function (slotKey) {
      var slotTotal = bySlot[slotKey].reduce(function (n, g) { return n + g.gems.length; }, 0);
      var sh = document.createElement('div');
      sh.className = 'gem-gear-head';
      sh.innerHTML = '<span class="gem-gear-name">' + esc(slotKey) + '</span>' +
        '<span class="gem-count">' + gemsWord(slotTotal) + '</span>';
      body.appendChild(sh);

      bySlot[slotKey].forEach(function (group) {
      var gh = document.createElement('div');
      gh.className = 'gem-group-head';
      gh.innerHTML = esc(group.title) +
        '<span class="gem-count"> · ' + gemsWord(group.gems.length) + '</span>';
      body.appendChild(gh);

      group.gems.forEach(function (gem) {
        var row = document.createElement('div');
        row.className = 'mod-row gem-row';
        var isVaal = /^Vaal /.test(gem.name);
        var isAwakened = /^Awakened /.test(gem.name);
        var isExceptional = /^(Empower|Enlighten|Enhance)( Support)?$/.test(gem.name);
        // transfigured: "Skill of Variant" — excluding naturally "of"-named skills
        var NATURAL_OF = /^(Herald of|Purity of|Wave of Conviction|Orb of Storms|Sigil of Power|Eye of Winter|Tornado of|Fist of War)/;
        var isTransfigured = / of /.test(gem.name) && !isVaal && !NATURAL_OF.test(gem.name) &&
                             !/Support$/.test(gem.name) && gem.name.split(' of ')[1] &&
                             gem.name.split(' ').length >= 3;
        var corruptOnly = gem.level >= 21 || gem.quality >= 23 || isVaal;
        var gemIconPath = gemArtPath(gem.name);
        if (gemIconPath || GEM_ICONS[gem.name] || isGui()) {
          var gIcon = document.createElement('img');
          gIcon.className = 'gem-icon';
          gIcon.dataset.gem = gem.name;
          if (GEM_ICONS[gem.name]) {
            gIcon.src = GEM_ICONS[gem.name];
            gIcon.dataset.swapped = '1';
          } else if (isGui()) {
            // atlas frames can't be told apart from wide single-frame art —
            // hold a blank slot until the cached trade render arrives
            gIcon.src = BLANK_PX;
            gIcon.classList.add('pending');
            gIcon.title = 'Gem art loads once from the trade site, then it\'s cached forever';
          } else if (gemIconPath) {
            gIcon.src = 'https://web.poecdn.com/image/' + gemIconPath + '?scale=1';
            gIcon.onload = markAtlas;
          }
          gIcon.loading = 'lazy';
          gIcon.alt = '';
          row.appendChild(gIcon);
        }
        var label = document.createElement('span');
        label.className = 'mod-text gem-name' + (isVaal ? ' vaal' : '');
        label.textContent = gem.name + (gem.count > 1 ? ' ×' + gem.count : '');
        if (isVaal) {
          var vb = document.createElement('span');
          vb.className = 'badge vaal-badge';
          vb.textContent = 'vaal';
          label.appendChild(vb);
        }
        if (isAwakened) {
          var ab = document.createElement('span');
          ab.className = 'badge awakened-badge';
          ab.textContent = 'awakened';
          ab.title = 'Awakened support — expensive, drops from Maven content';
          label.appendChild(ab);
        }
        if (isExceptional) {
          var eb = document.createElement('span');
          eb.className = 'badge exceptional-badge';
          eb.textContent = 'exceptional';
          eb.title = 'Empower/Enlighten/Enhance — level matters far more than quality';
          label.appendChild(eb);
        }
        if (isTransfigured) {
          var tb = document.createElement('span');
          tb.className = 'badge transfigured-badge';
          tb.textContent = 'transfigured';
          tb.title = 'Transfigured version — obtained from the Lab font, tradeable by exact name';
          label.appendChild(tb);
        }
        if (corruptOnly) {
          var cb2 = document.createElement('span');
          cb2.className = 'badge corrupt';
          cb2.textContent = 'corrupted';
          cb2.title = isVaal ? 'Vaal gems are always corrupted'
                             : 'Only corrupted gems reach this level/quality (21/23+)';
          label.appendChild(cb2);
        }
        row.appendChild(label);

        var lvlIn = document.createElement('input');
        lvlIn.type = 'number'; lvlIn.className = 'min-input gem-in';
        lvlIn.value = gem.level; lvlIn.title = 'Minimum gem level';
        var qIn = document.createElement('input');
        qIn.type = 'number'; qIn.className = 'min-input gem-in';
        qIn.value = gem.quality; qIn.title = 'Minimum quality';
        row.appendChild(lvlIn);
        row.appendChild(document.createTextNode('/'));
        row.appendChild(qIn);

        var priceSpan = document.createElement('span');
        priceSpan.className = 'gem-price';
        var openBtn = UI.button('secondary');
        openBtn.textContent = '↗';
        openBtn.title = 'Open this gem search on the trade site';
        openBtn.setAttribute('aria-label', 'Open ' + gem.name + ' search on the trade site');
        openBtn.addEventListener('click', function () {
          openUrl(gemUrl(gemPayload(gem, parseInt(lvlIn.value, 10) || 1, parseInt(qIn.value, 10) || 0)));
        });
        row.appendChild(priceSpan);
        row.appendChild(openBtn);

        // expandable panel: full listings / live search / basket, like gear cards
        var panel = document.createElement('div');
        panel.className = 'gem-panel hidden';
        var gemState = null;
        function ensureGemPanel() {
          if (gemState) return gemState;
          gemState = {
            gemSpec: { gem: gem, lvlIn: lvlIn, qIn: qIn },
            slot: group.slot ? group.slot + ' gem' : 'Gem',
            item: { name: gem.name },
            rows: [], unique: false, card: null
          };
          cards.push(gemState); // joins price summary + sold watcher

          // trade-style header: big gem art + name + current minimums
          var ph = document.createElement('div');
          ph.className = 'gem-panel-head';
          if (gemIconPath || GEM_ICONS[gem.name] || isGui()) {
            var big = document.createElement('img');
            big.className = 'gem-big-icon';
            big.dataset.gem = gem.name;
            if (GEM_ICONS[gem.name]) {
              big.src = GEM_ICONS[gem.name];
              big.dataset.swapped = '1';
            } else if (isGui()) {
              big.src = BLANK_PX;
              big.classList.add('pending');
            } else if (gemIconPath) {
              big.src = 'https://web.poecdn.com/image/' + gemIconPath + '?scale=1';
              big.onload = markAtlas;
            }
            big.alt = '';
            ph.appendChild(big);
          }
          var pht = document.createElement('div');
          var sub = document.createElement('div');
          sub.className = 'gem-panel-sub';
          function updateSub() {
            sub.textContent = 'min level ' + (parseInt(lvlIn.value, 10) || 1) +
              ' · min quality ' + (parseInt(qIn.value, 10) || 0) +
              (corruptOnly ? ' · corrupted' : '');
          }
          updateSub();
          pht.innerHTML = '<div class="gem-panel-name' + (isVaal ? ' vaal' : '') + '">' + esc(gem.name) + '</div>';
          pht.appendChild(sub);
          ph.appendChild(pht);
          panel.appendChild(ph);

          // swap the RePoE atlas art for the trade site's single-frame render
          if (isGui() && window.pywebview.api.gem_icon) {
            gemIconLookup(gem.name).then(function (res) {
              if (res && res.ok && res.icon) {
                GEM_ICONS[gem.name] = res.icon;
                var bigEl = ph.querySelector('.gem-big-icon');
                if (bigEl) bigEl.src = res.icon;
                var rowIcon = row.querySelector('.gem-icon');
                if (rowIcon) rowIcon.src = res.icon;
              }
            }).catch(function () { /* keep placeholder */ });
          }

          // loosening level/quality re-runs an open price check automatically
          [lvlIn, qIn].forEach(function (inp) {
            inp.addEventListener('change', function () {
              updateSub();
              if (isGui() && gemState.priceState) checkPrice(gemState, true);
            });
          });

          var btns = document.createElement('div');
          btns.className = 'btns gem-panel-btns';
          var pBtn = UI.button('secondary', { cls: 'gui-only' });
          pBtn.textContent = 'Check price';
          pBtn.addEventListener('click', function () { checkPrice(gemState); });
          gemState.priceBtn = pBtn;
          var lBtn = UI.button('secondary', { cls: 'gui-only' });
          lBtn.textContent = '🔴 Go live';
          lBtn.addEventListener('click', function () { toggleLive(gemState); });
          gemState.liveBtn = lBtn;
          var oBtn = UI.button('primary');
          oBtn.textContent = 'Search on trade site ↗';
          oBtn.addEventListener('click', function () {
            var url = buildTradeUrl(gemState);
            if (url) openUrl(url);
          });
          btns.appendChild(pBtn); btns.appendChild(lBtn); btns.appendChild(oBtn);
          panel.appendChild(btns);

          var lBox = document.createElement('div');
          lBox.className = 'price-box live-box hidden';
          panel.appendChild(lBox);
          gemState.liveBox = lBox;
          var prBox = document.createElement('div');
          prBox.className = 'price-box hidden';
          panel.appendChild(prBox);
          gemState.priceBox = prBox;
          return gemState;
        }
        var expandBtn = UI.button('secondary', { size: 'sm' });
        expandBtn.textContent = '▾';
        expandBtn.title = 'Expand: full listings, live search, pinning — like a gear card';
        expandBtn.setAttribute('aria-label', 'Expand ' + gem.name + ' listings');
        function togglePanel() {
          if (panel.classList.contains('hidden')) {
            ensureGemPanel();
            panel.classList.remove('hidden');
            expandBtn.textContent = '▴';
          } else {
            panel.classList.add('hidden');
            expandBtn.textContent = '▾';
          }
        }
        expandBtn.addEventListener('click', togglePanel);
        label.style.cursor = 'pointer';
        label.addEventListener('click', togglePanel);
        row.appendChild(expandBtn);

        body.appendChild(row);
        body.appendChild(panel);
        rows.push({ gem: gem, lvlIn: lvlIn, qIn: qIn, priceSpan: priceSpan });
      });
      });
    });
    card.appendChild(body);

    // background: replace atlas art with proper single-frame trade renders
    var uniqueNames = [];
    gemGroups.forEach(function (g) {
      g.gems.forEach(function (gem) {
        if (uniqueNames.indexOf(gem.name) === -1) uniqueNames.push(gem.name);
      });
    });
    // start after a beat so the user's own actions (price checks) go first;
    // uncached art trickles in on the gentle background pace, cached is instant
    setTimeout(function () { resolveGemIcons(uniqueNames); }, 4000);

    var opts = document.createElement('div');
    opts.className = 'card-opts';
    var btns = document.createElement('div');
    btns.className = 'btns';
    var priceAll = UI.button('secondary', { cls: 'gui-only' });
    priceAll.textContent = 'Price all gems';
    priceAll.addEventListener('click', async function () {
      if (!isGui()) return;
      priceAll.disabled = true;
      var league = document.getElementById('league').value;
      var cheapest = []; // {amount, currency, count}
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        priceAll.textContent = 'Pricing ' + (i + 1) + '/' + rows.length + '…';
        r.priceSpan.textContent = '…';
        try {
          var res = await window.pywebview.api.trade_search(league,
            JSON.stringify(gemPayload(r.gem, parseInt(r.lvlIn.value, 10) || 1, parseInt(r.qIn.value, 10) || 0)));
          if (res.ok && res.listings.length) {
            var li = res.listings[0];
            r.priceSpan.textContent = li.amount + ' ' + li.currency + ' · ' + res.total + ' listed';
            if (li.amount !== null && li.amount !== undefined) {
              cheapest.push({ amount: li.amount, currency: li.currency, count: r.gem.count || 1 });
            }
          } else {
            r.priceSpan.textContent = res.ok ? 'none listed' : '❌ ' + (res.error || '').slice(0, 40);
          }
        } catch (e) {
          r.priceSpan.textContent = '❌ ' + e.message.slice(0, 40);
        }
      }
      // fetch any missing rates once, then total in the display currency
      var needCur = [];
      cheapest.forEach(function (c) {
        if (!(RATES[league] && RATES[league][c.currency] !== undefined) && needCur.indexOf(c.currency) === -1) needCur.push(c.currency);
      });
      if (eqMode() === 'divine' && !divRate(league) && needCur.indexOf('divine') === -1) needCur.push('divine');
      if (needCur.length) {
        try {
          var rr = await window.pywebview.api.exchange_rates(league, JSON.stringify(needCur));
          if (rr.ok) {
            RATES[league] = RATES[league] || {};
            Object.keys(rr.rates).forEach(function (k) { RATES[league][k] = rr.rates[k]; });
          }
        } catch (e) { /* totals stay partial */ }
      }
      var totalChaos = 0, known = 0;
      cheapest.forEach(function (c) {
        var rate = RATES[league] && RATES[league][c.currency];
        if (rate !== undefined) { totalChaos += c.amount * rate * c.count; known++; }
      });
      priceAll.textContent = known
        ? 'Gems ≈ ' + fmtEq(totalChaos, league) + (known < cheapest.length ? ' (partial)' : '')
        : 'Price all gems';
      priceAll.disabled = false;
    });
    var openAllG = UI.button('secondary');
    openAllG.textContent = 'Open all gem searches';
    openAllG.addEventListener('click', function () {
      rows.forEach(function (r, i) {
        setTimeout(function () {
          openUrl(gemUrl(gemPayload(r.gem, parseInt(r.lvlIn.value, 10) || 1, parseInt(r.qIn.value, 10) || 0)));
        }, i * 400);
      });
    });
    btns.appendChild(priceAll);
    btns.appendChild(openAllG);
    opts.appendChild(btns);
    card.appendChild(opts);
    return card;
  }

  // ---- pasted in-game item -------------------------------------------------------
  var pastedState = null;

  function renderPastedItem(item) {
    document.getElementById('controls').classList.remove('hidden');
    if (pastedState) {
      stopLive(pastedState);
      var i = cards.indexOf(pastedState);
      if (i !== -1) cards.splice(i, 1);
      pastedState.card.remove();
      pastedState = null;
    }
    var root = document.getElementById('results');
    var sec = viewSection('pasted');
    if (!sec) {
      sec = document.createElement('div');
      sec.className = 'tab-section';
      sec.dataset.tab = 'pasted';
      root.insertBefore(sec, root.firstChild);
    }
    var card = makeCard(item.slotGuess || 'Pasted item', item);
    pastedState = cards[cards.length - 1];
    card.classList.add('pasted');
    sec.appendChild(card);
    renderCharDiff(pastedState);
    if (build) { renderNav(); setView('pasted'); window.scrollTo(0, 0); }
    else card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function sectionHeader(text) {
    var h = document.createElement('h2');
    h.className = 'section-head';
    h.textContent = text;
    return h;
  }

  // Which gear sets contain this slot, with distinct items? Powers the
  // per-slot set dropdown (mix sets: endgame helm, budget boots).
  function setsForSlot(slot) {
    var out = [];
    (build.itemSets || []).forEach(function (s, i) {
      var entry = s.slots.concat(s.flasks).find(function (x) { return x.slot === slot; });
      if (entry && build.items[entry.itemId]) out.push({ setIndex: i, title: s.title, itemId: entry.itemId });
    });
    var distinct = {};
    out.forEach(function (o) { distinct[o.itemId] = true; });
    return Object.keys(distinct).length > 1 ? out : [];
  }

  function swapCardSet(oldState, slot, setIndex) {
    var entry = setsForSlot(slot).find(function (o) { return o.setIndex === setIndex; });
    if (!entry) return;
    stopLive(oldState);
    var pos = cards.indexOf(oldState);
    var newCard = makeCard(slot, build.items[entry.itemId], setIndex);
    var newState = cards.pop(); // makeCard pushed it to the end
    if (pos !== -1) { cards.splice(pos, 1); cards.splice(pos, 0, newState); }
    else cards.push(newState);
    if (oldState.card.classList.contains('is-active')) newCard.classList.add('is-active');
    oldState.card.replaceWith(newCard);
    renderCostSummary();
    renderCharDiff(newState);
  }

  function makeCard(slot, item, setIndex) {
    var card = document.createElement('div');
    card.className = 'card';
    var state = { slot: slot, item: item, rows: [], card: card };
    cards.push(state);

    var head = document.createElement('div');
    head.className = 'card-head';
    var iconPath = window.POE_BASE_ICONS && window.POE_BASE_ICONS[item.base];
    // magic flasks/tinctures embed the base inside the affixed name
    var flaskBase = null;
    if (!iconPath && /flask|tincture/i.test((item.name || '') + ' ' + (item.base || ''))) {
      flaskBase = findFlaskBase(item.name) || findFlaskBase(item.base);
      if (flaskBase) iconPath = window.POE_BASE_ICONS[flaskBase];
    }
    var isUnique = item.rarity === 'UNIQUE' || item.rarity === 'RELIC';
    if (isUnique) {
      state.unique = true;
      // resolve BEFORE the icon lookup below uses it — prefixed names need this
      state.resolvedName = resolveUniqueName(item.name);
    }
    var iconHtml = (iconPath || (isUnique && isGui()))
      ? '<img class="card-icon" ' +
        'src="' + (iconPath ? 'https://web.poecdn.com/image/' + iconPath + '?scale=1' : BLANK_PX) + '" ' +
        'alt="" loading="lazy">'
      : '';
    head.innerHTML =
      '<div>' + iconHtml + '<span class="slot-tag">' + esc(slot) + '</span>' +
      '<span class="item-name ' + rarityClass(item.rarity) + '">' + esc(item.name) + '</span>' +
      (item.base && item.base !== item.name ? '<span class="item-base">' + esc(item.base) + '</span>' : '') +
      (item.influences.length ? '<span class="infl-tag">' + esc(item.influences.join(' + ')) + '</span>' : '') +
      '</div>';
    // per-slot gear-set dropdown — only when other sets hold a different item here
    var slotSets = (setIndex !== undefined) ? setsForSlot(slot) : [];
    if (slotSets.length) {
      var setSel = UI.select(slotSets.map(function (o) { return [String(o.setIndex), o.title]; }), String(setIndex), {
        cls: 'set-mini', title: 'Show this slot from a different gear set', ariaLabel: 'Gear set for this slot',
        onChange: function () { swapCardSet(state, slot, parseInt(this.value, 10)); } });
      head.firstChild.appendChild(setSel);
    }
    card.appendChild(head);

    var iconEl = head.querySelector('.card-icon');
    if (iconEl) iconEl.onload = markAtlas; // flask/gem base art can be a sprite atlas
    // uniques: swap base art for the real unique art (trade lookup, disk-cached)
    if (isUnique && isGui()) {
      if (iconEl) {
        iconWithRetry(function () { return window.pywebview.api.unique_icon(state.resolvedName || item.name, item.base); },
                      iconEl);
      }
    } else if (iconEl && (flaskBase || /flask|tincture/i.test(item.base || '')) && isGui() && window.pywebview.api.gem_icon) {
      // flasks: fetch the trade site's single-frame render (cached forever)
      var fb = flaskBase || item.base;
      iconWithRetry(function () { return window.pywebview.api.gem_icon(fb); }, iconEl);
    }

    var body = document.createElement('div');
    body.className = 'card-body';
    card.appendChild(body);

    if (state.unique) {
      var note = document.createElement('div');
      note.className = 'unique-note';
      note.textContent = 'Unique — searched by name. Tick mods below to also require minimum rolls (rolls matter on this one? tick them).';
      body.appendChild(note);
      addModRows(state, body, item, slot, true); // unticked by default
    } else {
      addModRows(state, body, item, slot, false);
      if (!item.mods.length) {
        var empty = document.createElement('div');
        empty.className = 'unique-note';
        empty.textContent = 'No mods parsed on this item.';
        body.appendChild(empty);
      }
    }

    // Options row
    var opts = document.createElement('div');
    opts.className = 'card-opts';

    if (!state.unique) {
      // Magic items embed affix text in the name — their "base" is unreliable as a type filter
      var baseDefault = !categoryFor(slot, item) && !!item.base &&
                        !/flask|tincture|jewel/i.test(item.base) && item.rarity !== 'MAGIC';
      state.searchBySel = makeSearchBySelect(opts, slot, item, baseDefault);
      state.modeSel = makeModeSelect(opts, state);
      if (item.influences.length) {
        state.inflToggle = makeToggle(opts, 'Require influence: ' + item.influences.join(' + '), true);
      }
      state.ilvlInput = makeMiniInput(opts, 'Min ilvl', item.itemLevel ? String(item.itemLevel) : '');
      state.ilvlInput.parentElement.title = 'Require minimum item level — blank means no filter' +
        (item.itemLevel ? '. The build item is ilvl ' + item.itemLevel + ' (shown greyed)' : '');
      if (item.mods.some(function (m) { return m.fractured; })) {
        state.fracToggle = makeToggle(opts, 'Require fractured mod(s)', false);
      }
      // 2+ resistance mods -> offer any-split total matching (weight group)
      if (state.rows.filter(isFlexResRow).length >= 2) {
        state.flexToggle = makeToggle(opts, 'Flexible resistances (any split)', false);
        state.flexToggle.checkbox.parentElement.title =
          'Match the combined resistance total instead of each roll separately — an item with the same total split differently still matches. Needs Pseudo totals on. In-app price checks need a saved POESESSID (higher query budget); trade-site links work while you are logged in there.';
      }
    }
    // Base defence percentile filter — armour pieces only
    var isArmourSlot = /^(Helmet|Body Armour|Gloves|Boots)/i.test(slot) ||
                       /shield|buckler|bundle/i.test(item.base || '');
    if (isArmourSlot) {
      state.bpctSel = makeMiniSelect(opts, 'Base %ile ≥', ['-', '20', '40', '50', '60', '70', '80', '90'], '-');
      state.bpctSel.title = 'Minimum base defence percentile — how well the base armour/evasion/ES rolled';
    }

    // Socket / link filters, capped to what the slot can actually have
    var socketCap = socketCapFor(slot, item);
    if (socketCap > 0) {
      var range = function (from, to) {
        var a = ['-'];
        for (var n = from; n <= to; n++) a.push(String(n));
        return a;
      };
      state.socketsSel = makeMiniSelect(opts, 'Sockets ≥', range(1, socketCap), '-');
      state.linksSel = makeMiniSelect(opts, 'Links ≥', range(2, socketCap),
        item.maxLinks >= 5 ? String(Math.min(item.maxLinks, socketCap)) : '-');
    }
    if (item.mods.length) {
      state.pctSel = makeMiniSelect(opts, 'Min roll', ['global', '50%', '60%', '70%', '80%', '90%', '100%'], 'global');
      state.pctSel.addEventListener('change', function () { applyPctToCard(state); });
    }
    // budget cap: chaos-equivalent max price (applies to links, price checks, live)
    state.maxPriceInput = makeMiniInput(opts, 'Max price', 'c');
    state.maxPriceInput.title = 'Maximum price in chaos-equivalent — searches, price checks, and live alerts all respect it';
    // bought tracking: dims the card and drops it from the cost summary
    var boughtBtn = UI.button('secondary', { size: 'sm' });
    boughtBtn.textContent = '✔ Bought';
    boughtBtn.title = 'Mark this slot as purchased — removed from the build cost total';
    boughtBtn.addEventListener('click', function () {
      state.bought = !state.bought;
      card.classList.toggle('bought', state.bought);
      renderCostSummary();
    });
    opts.appendChild(boughtBtn);

    var btnWrap = document.createElement('div');
    btnWrap.className = 'btns';

    var priceBtn = UI.button('secondary', { cls: 'gui-only' });
    priceBtn.textContent = 'Check price';
    priceBtn.addEventListener('click', function () { checkPrice(state); });
    state.priceBtn = priceBtn;
    btnWrap.appendChild(priceBtn);

    var liveBtn = UI.button('secondary', { cls: 'gui-only' });
    liveBtn.textContent = '🔴 Go live';
    liveBtn.title = 'Watch this search — new listings appear here with a sound (checks ~20s)';
    liveBtn.addEventListener('click', function () { toggleLive(state); });
    state.liveBtn = liveBtn;
    btnWrap.appendChild(liveBtn);

    if (state.unique && TIMELESS_TYPES.some(function (t) { return t[1] === state.resolvedName; }) &&
        build && build.tree && build.tree.nodes.length) {
      var tsBtn = UI.button('secondary', { cls: 'gui-only' });
      tsBtn.textContent = '⏳ Find seeds for this socket';
      tsBtn.title = 'Open the timeless jewel finder on the socket this jewel sits in — see what your seed does and find better ones';
      tsBtn.addEventListener('click', function () { openTimelessFor(state); });
      btnWrap.appendChild(tsBtn);
    }

    if (item.rarity === 'RARE' && !/^(Jewel|Flask|Abyssal)/.test(slot)) {
      var craftBtn = UI.button('secondary');
      craftBtn.textContent = '⚒ Craft vs buy';
      craftBtn.title = 'Estimate what crafting this item would cost (chaos / essence spam + a bench craft) and compare it with buying';
      craftBtn.addEventListener('click', function () { openCraft(state); });
      state.craftBtn = craftBtn;
      btnWrap.appendChild(craftBtn);
    }

    var openBtn = UI.button('primary');
    openBtn.textContent = 'Search on trade site ↗';
    openBtn.addEventListener('click', function () {
      var url = buildTradeUrl(state);
      if (url) openUrl(url);
    });
    var copyBtn = UI.button('secondary');
    copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', function () {
      var url = buildTradeUrl(state);
      if (url) navigator.clipboard.writeText(url).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy URL'; }, 1200);
      });
    });
    btnWrap.appendChild(openBtn);
    btnWrap.appendChild(copyBtn);
    var histSel = document.createElement('select');
    histSel.className = 'hist-sel hidden';
    histSel.title = 'Earlier price checks for this slot in this build — pick one to reopen it on the trade site';
    histSel.setAttribute('aria-label', 'Search history');
    histSel.addEventListener('change', function () {
      var h = slotHistory(state)[parseInt(histSel.value, 10)];
      histSel.value = '';
      if (h) openUrl(tradeUrlFor(h.league, h.payloadStr));
    });
    state.historySel = histSel;
    btnWrap.appendChild(histSel);
    var trendBox = document.createElement('span');
    trendBox.className = 'slot-trend hidden';
    state.trendBox = trendBox;
    btnWrap.appendChild(trendBox);
    renderHistorySelect(state);
    opts.appendChild(btnWrap);
    card.appendChild(opts);

    var liveBox = document.createElement('div');
    liveBox.className = 'price-box live-box hidden';
    card.appendChild(liveBox);
    state.liveBox = liveBox;

    var priceBox = document.createElement('div');
    priceBox.className = 'price-box hidden';
    card.appendChild(priceBox);
    state.priceBox = priceBox;

    var craftBox = document.createElement('div');
    craftBox.className = 'price-box craft-box hidden';
    card.appendChild(craftBox);
    state.craftBox = craftBox;
    return card;
  }

  // Render an item's mod rows with a trade-site style separator between the
  // implicit block and the explicit mods.
  var DESCRIPTIVE_LINES = /^Passives in radius are Conquered by the /i;

  // ---- art from GGG's CDN, kept on disk ------------------------------------------
  // The WebView forgets its HTTP cache on exit, so the bridge saves each image to
  // data/art_cache once (art_cache.py); later launches load the local copy. Keyed by
  // the exact URL — GGG's art URLs change when the art does, so changed art is
  // simply a new download. One observer covers every <img> the app creates.
  var ART = {}, artQueue = [], artQueued = {}, artTimer = null;
  var CDN = 'https://web.poecdn.com/';

  function artSwap(img) {
    var src = img.getAttribute('src') || '';
    if (src.indexOf(CDN) !== 0) return;
    if (ART[src]) {
      img.dataset.remote = src;
      img.setAttribute('src', ART[src]);
    } else if (!artQueued[src]) {
      artQueued[src] = true;
      artQueue.push(src);
      if (!artTimer) artTimer = setTimeout(flushArt, 1500);
    }
  }

  function flushArt() {
    artTimer = null;
    var batch = artQueue.splice(0, 40);
    if (!batch.length) return;
    window.pywebview.api.cache_art(JSON.stringify(batch)).then(function (r) {
      if (r && r.ok) Object.keys(r.art).forEach(function (u) { ART[u] = r.art[u]; });
    }, function () {}).then(function () {
      if (artQueue.length && !artTimer) artTimer = setTimeout(flushArt, 1500);
    });
  }

  function startArtCache() {
    if (!isGui() || !window.pywebview.api.art_manifest) return;
    window.pywebview.api.art_manifest().then(function (r) {
      if (r && r.ok) ART = r.art || {};
      document.querySelectorAll('img').forEach(artSwap);
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          if (m.type === 'attributes') { if (m.target.tagName === 'IMG') artSwap(m.target); return; }
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'IMG') artSwap(n);
            else n.querySelectorAll && n.querySelectorAll('img').forEach(artSwap);
          });
        });
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
      // a cached file that went missing: fall back to the CDN and forget the entry
      document.addEventListener('error', function (e) {
        var img = e.target;
        if (img && img.tagName === 'IMG' && img.dataset.remote && img.getAttribute('src') !== img.dataset.remote) {
          delete ART[img.dataset.remote];
          img.setAttribute('src', img.dataset.remote);
        }
      }, true);
    }, function () {});
  }

  // Art lookups are background trade calls that yield to any rate-limit cooldown;
  // when skipped, try again later instead of leaving the card without art.
  var ICON_RETRY_MS = 30000, ICON_RETRIES = 10;
  function iconWithRetry(lookup, img, tries) {
    tries = tries || 0;
    lookup().then(function (res) {
      if (!img.isConnected) return;
      if (res && res.ok && res.icon) {
        img.src = res.icon;
        img.dataset.swapped = '1';
        img.classList.remove('atlas2');
      } else if (res && /cooldown/i.test(res.error || '') && tries < ICON_RETRIES) {
        setTimeout(function () { iconWithRetry(lookup, img, tries + 1); }, ICON_RETRY_MS);
      }
    }).catch(function () { /* keep base art */ });
  }

  function addModRows(state, body, item, slot, defaultOff) {
    var prevKind = null;
    item.mods.forEach(function (mod) {
      if (prevKind === 'implicit' && mod.kind !== 'implicit') {
        var sep = document.createElement('div');
        sep.className = 'lmod-sep';
        body.appendChild(sep);
      }
      prevKind = mod.kind;
      var match = Matcher.matchMod(statIndex, mod, slot);
      // descriptive unique text with no trade stat (timeless jewels' "Passives in
      // radius are Conquered by the …") — not searchable, so don't list it as an error
      if (!match && DESCRIPTIVE_LINES.test(mod.line)) return;
      body.appendChild(makeModRow(state, mod, match, defaultOff));
    });
  }

  function makeModRow(state, mod, match, defaultOff) {
    var row = document.createElement('div');
    row.className = 'mod-row' + (match ? '' : ' unmatched');

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    // Bench crafts (crafted explicits) start off — you'll re-craft those. Crafted
    // implicits (cluster jewel passive count / small-passive grants) must stay on.
    // On uniques (defaultOff), lines from the selected variant start ON: they're what
    // makes this copy the one the build wants (Impossible Escape's keystone, a
    // timeless jewel's conqueror + seed).
    cb.checked = !!match && (!defaultOff || !!mod.variant) && !(mod.crafted && mod.kind === 'explicit');
    cb.disabled = !match;
    cb.setAttribute('aria-label', 'Use: ' + mod.line);

    // trade-site convention: colour identifies the mod source, no text labels
    var label = document.createElement('span');
    label.className = 'mod-text' + (mod.crafted ? ' crafted' : '') + (mod.fractured ? ' fractured' : '');
    label.textContent = mod.line;
    // eldritch tags: implicit-kind mods on influenced items only — the stat
    // ids overlap with regular affixes, so kind + influence must gate them
    if (match && mod.kind === 'implicit' && !mod.crafted) {
      var eldTail = match.entry.id.split('.').pop().split('|')[0];
      var eld = window.POE_ELDRITCH && window.POE_ELDRITCH[eldTail];
      var infl = state.item.influences || [];
      if (eld === 'exarch' && infl.indexOf('Searing Exarch') === -1) eld = null;
      if (eld === 'eater' && infl.indexOf('Eater of Worlds') === -1) eld = null;
      if (eld) {
        var eldBadge = document.createElement('span');
        eldBadge.className = 'badge ' + (eld === 'exarch' ? 'exarch-mod' : 'eater-mod');
        eldBadge.textContent = eld === 'exarch' ? 'exarch' : 'eater';
        eldBadge.title = (eld === 'exarch' ? 'Searing Exarch' : 'Eater of Worlds') + ' implicit';
        label.appendChild(eldBadge);
      }
    }
    if (mod.crafted) label.title = 'Crafted mod';
    if (mod.fractured) label.title = 'Fractured mod';
    if (mod.kind === 'implicit' && !mod.crafted) label.title = 'Implicit';

    // clicking anywhere on the row toggles the mod — not just the tiny checkbox
    row.addEventListener('click', function (e) {
      if (e.target !== row && e.target !== label) return; // let inputs/buttons work
      if (cb.disabled) return;
      cb.checked = !cb.checked;
    });

    var minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.className = 'min-input';
    minInput.step = 'any';
    minInput.setAttribute('aria-label', 'Minimum for: ' + mod.line);

    var tag = document.createElement('span');
    tag.className = 'match-tag';

    var rowState = { mod: mod, match: match, cb: cb, minInput: minInput, baseAvg: null,
                     exactCount: false, pseudoMult: 1, inputScale: 1 };
    if (match && match.pseudo) {
      rowState.pseudoMult = match.pseudo.multiplier;
      if (document.getElementById('pseudo').checked) rowState.inputScale = match.pseudo.multiplier;
    }
    var showInput = false;
    var rangeHint = null;
    if (match) {
      // timeless jewel seeds are identities, not rolls: search the exact number
      rowState.exactCount = !!EXACT_COUNT_TEXTS[match.entry.text] ||
                            /^explicit\.pseudo_timeless_jewel_/.test(match.entry.id);
      var pseudoOn = document.getElementById('pseudo').checked;
      var eff = effectiveMatch(rowState, pseudoOn);
      var pct = parseInt(document.getElementById('pct').value, 10) / 100;
      if (match.fixedText || eff.avg === null) {
        // stat carries no adjustable value — no min input
      } else if (rowState.exactCount) {
        minInput.value = eff.avg; // exact match, never % scaled
        showInput = true;
      } else {
        rowState.baseAvg = eff.avg;
        minInput.value = roundMin(eff.avg * pct);
        showInput = true;
        if (state.unique) {
          // unique rolls live in their own range — PoB (a-b) bounds when the
          // build carried them, else the bundled PoB unique database; never
          // clamp uniques with rare-affix ranges
          var uB = mod.bounds;
          if (!uB && window.POE_UNIQUE_RANGES) {
            var ur = window.POE_UNIQUE_RANGES[state.resolvedName || state.item.name];
            if (ur) uB = ur[Matcher.normalize(mod.line)];
          }
          if (uB) {
            minInput.min = uB[0];
            minInput.max = uB[1];
            minInput.title = 'Rolls ' + uB[0] + ' – ' + uB[1] + ' on this unique';
            rangeHint = uB[0] + '–' + uB[1];
          }
        } else {
          // Clamp to what this mod can actually roll (lowest tier min .. highest
          // tier max, from RePoE). Pseudo totals sum several mods — never clamped.
          var usingPseudo = eff.entry !== match.entry;
          var rng = !usingPseudo && window.POE_RANGES && window.POE_RANGES[match.entry.id];
          if (rng) {
            minInput.min = rng[0];
            minInput.max = rng[1];
            minInput.title = 'This mod rolls ' + rng[0] + ' – ' + rng[1];
            minInput.addEventListener('change', function () {
              var v = parseFloat(minInput.value);
              if (isNaN(v)) return;
              if (v < rng[0]) minInput.value = rng[0];
              if (v > rng[1]) minInput.value = rng[1];
            });
          }
        }
      }
      tag.textContent = eff.entry.text;
      tag.title = eff.entry.id;
    } else {
      minInput.disabled = true;
      tag.textContent = 'no trade-stat match';
      tag.classList.add('no-match');
    }

    row.appendChild(cb);
    row.appendChild(label);
    // fixed-width control column so every input lines up down the card
    var ctrl = document.createElement('span');
    ctrl.className = 'mod-ctrl';
    if (rangeHint) {
      var rh = document.createElement('span');
      rh.className = 'range-hint';
      rh.textContent = rangeHint;
      rh.title = 'This mod rolls ' + rangeHint + ' on this unique';
      ctrl.appendChild(rh);
    }
    if (showInput) ctrl.appendChild(minInput);
    // Sort listings by this mod's roll: off -> highest first -> lowest first
    if (showInput || rowState.exactCount) {
      var sortBtn = document.createElement('button');
      sortBtn.className = 'sort-btn';
      sortBtn.textContent = '⇅';
      sortBtn.title = 'Sort search results by this mod (highest / lowest roll)';
      sortBtn.setAttribute('aria-label', 'Sort results by this mod');
      rowState.sortBtn = sortBtn;
      sortBtn.addEventListener('click', function () {
        var eff = effectiveMatch(rowState, document.getElementById('pseudo').checked);
        cycleSort(state, 'stat.' + eff.entry.id, eff.entry.text);
      });
      ctrl.appendChild(sortBtn);
    }
    row.appendChild(ctrl);
    row.appendChild(tag);
    state.rows.push(rowState);
    return row;
  }

  // One sort per card: off -> highest first -> lowest first -> off.
  // statKey is the server sort key ("stat.<statId>"); works even for stats
  // that aren't among the search filters.
  function cycleSort(state, statKey, label) {
    var cur = (state.sortSpec && state.sortSpec.statKey === statKey) ? state.sortSpec.dir : null;
    var next = cur === null ? 'desc' : (cur === 'desc' ? 'asc' : null);
    state.sortSpec = next ? { statKey: statKey, dir: next, label: label } : null;
    updateSortButtons(state);
    if (isGui() && state.priceState) checkPrice(state, true); // re-run with new sort
  }

  function updateSortButtons(state) {
    var pseudoOn = document.getElementById('pseudo').checked;
    state.rows.forEach(function (r) {
      if (!r.sortBtn) return;
      var key = r.match ? 'stat.' + effectiveMatch(r, pseudoOn).entry.id : null;
      if (state.sortSpec && key === state.sortSpec.statKey) {
        r.sortBtn.textContent = state.sortSpec.dir === 'desc' ? '↓ high' : '↑ low';
        r.sortBtn.classList.add('active');
      } else {
        r.sortBtn.textContent = '⇅';
        r.sortBtn.classList.remove('active');
      }
    });
  }

  function effectiveMatch(rowState, pseudoOn) {
    var m = rowState.match;
    if (pseudoOn && m.pseudo) {
      return { entry: m.pseudo.entry, avg: m.avg === null ? null : m.avg * m.pseudo.multiplier };
    }
    return { entry: m.entry, avg: m.avg };
  }

  function makeToggle(parent, text, checked) {
    var wrap = document.createElement('label');
    wrap.className = 'toggle';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(' ' + text));
    parent.appendChild(wrap);
    return { checkbox: cb };
  }

  function makeModeSelect(parent, state) {
    // "all but one" is the sweet spot for upgrade hunting
    var sel = UI.select([['0', 'all mods'], ['1', 'all but one'], ['2', 'all but two']], '1');
    UI.field('Match', sel, { parent: parent });
    return sel;
  }

  function makeMiniInput(parent, label, placeholder) {
    var inp = UI.input({ type: 'number', cls: 'min-input', placeholder: placeholder || '', width: '70px' });
    UI.field(label, inp, { parent: parent });
    return inp;
  }

  // "Search by": exact base → same defence type / weapon class → anything in the slot
  var DEF_LABEL = { ar: 'Armour', ev: 'Evasion', es: 'ES' };
  var WEAPON_LABEL = {
    'weapon.bow': 'bow', 'weapon.claw': 'claw', 'weapon.dagger': 'dagger', 'weapon.runedagger': 'rune dagger',
    'weapon.oneaxe': 'one-hand axe', 'weapon.onemace': 'one-hand mace', 'weapon.onesword': 'one-hand sword',
    'weapon.sceptre': 'sceptre', 'weapon.staff': 'staff', 'weapon.warstaff': 'warstaff',
    'weapon.twoaxe': 'two-hand axe', 'weapon.twomace': 'two-hand mace', 'weapon.twosword': 'two-hand sword',
    'weapon.wand': 'wand'
  };
  function searchByOptions(slot, item) {
    var bt = (window.POE_BASE_TYPES || {})[item.base] || null;
    var cat = categoryFor(slot, item);
    var out = [];
    if (item.base) out.push(['exact', 'This base (' + item.base + ')']);
    if (bt && bt[1] && cat) {
      out.push(['def', 'Any ' + bt[1].split('/').map(function (d) { return DEF_LABEL[d]; }).join('/') + ' base']);
    }
    if (bt && bt[0]) out.push(['class', 'Any ' + (WEAPON_LABEL[bt[0]] || bt[0].replace('weapon.', ''))]);
    if (cat) out.push(['slot', 'Any base']);
    return out;
  }
  function makeSearchBySelect(parent, slot, item, preferExact) {
    var options = searchByOptions(slot, item);
    if (!options.length) return null;
    var values = options.map(function (o) { return o[0]; });
    var sel = UI.select(options, (preferExact && values.indexOf('exact') !== -1) ? 'exact' : values[values.length - 1]);
    UI.field('Search by', sel, { parent: parent,
      title: 'How strictly to match the item base — broader searches find more (and cheaper) listings' });
    return sel;
  }

  function makeMiniSelect(parent, label, options, value) {
    var sel = UI.select(options, value);
    UI.field(label, sel, { parent: parent });
    return sel;
  }

  // Effective min-roll fraction for a card: per-card override, else the global slider
  function cardPct(state) {
    var v = state.pctSel && state.pctSel.value;
    if (v && v !== 'global') return parseInt(v, 10) / 100;
    return parseInt(document.getElementById('pct').value, 10) / 100;
  }

  function applyPctToCard(state) {
    var pct = cardPct(state);
    state.rows.forEach(function (r) {
      if (r.baseAvg !== null && r.match && !r.exactCount) r.minInput.value = roundMin(r.baseAvg * pct);
    });
  }

  function applyPctToAll() {
    cards.forEach(applyPctToCard);
  }

  function roundMin(v) {
    if (v === null || isNaN(v)) return '';
    return Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  }

  // ---- query building ---------------------------------------------------------
  function buildTradePayload(state, quiet) {
    // finder panels (jewel finder, timeless seeds) build their own query
    if (state.customPayload) return state.customPayload(quiet);
    // gem states search by gem name + level/quality, not by mods
    if (state.gemSpec) {
      return gemPayload(state.gemSpec.gem,
        parseInt(state.gemSpec.lvlIn.value, 10) || 1,
        parseInt(state.gemSpec.qIn.value, 10) || 0);
    }
    var pseudoOn = document.getElementById('pseudo').checked;

    var query = { status: { option: document.getElementById('trade-status').value } };
    var saleType = document.getElementById('sale-type').value;
    var tf = {};
    if (saleType !== 'any') tf.sale_type = { option: saleType };
    var maxP = state.maxPriceInput ? parseFloat(state.maxPriceInput.value) : NaN;
    if (!isNaN(maxP) && maxP > 0) tf.price = { max: maxP }; // chaos-equivalent by default
    var tradeFilters = Object.keys(tf).length ? { trade_filters: { filters: tf } } : null;

    var requireFrac = state.fracToggle && state.fracToggle.checkbox.checked;
    var flexOn = state.flexToggle && state.flexToggle.checkbox.checked && pseudoOn;
    var flexDiverted = []; // {id, weight, min}
    var filters = [];
    var seenIds = {};
    var upgradeEq = (state.upgradeOnly && charGear && charGear[state.slot] && !state.unique)
      ? equippedStats(charGear[state.slot], state.slot) : null;
    state.rows.forEach(function (r) {
      if (!r.cb.checked || !r.match) return;
      var eff = effectiveMatch(r, pseudoOn);
      var f = { id: eff.entry.id };
      // flexible resistances: divert res rows into a weight group
      if (flexOn && isFlexResRow(r) && !(requireFrac && r.mod.fractured)) {
        var min = parseFloat(r.minInput.value);
        if (!isNaN(min) && min > 0) {
          var w = /all_elemental_resistances$/.test(eff.entry.id) ? 3 : 1;
          var existing = flexDiverted.find(function (d) { return d.id === eff.entry.id; });
          if (existing) existing.min += min;
          else flexDiverted.push({ id: eff.entry.id, weight: w, min: min });
          return;
        }
      }
      // "Require fractured": swap to the fractured twin of the EXACT matched
      // stat (same stat number keeps locality — text lookup would resolve
      // local armour/evasion mods to their global twins)
      if (requireFrac && r.mod.fractured) {
        var fracTwin = Matcher.lookupById(statIndex,
          'fractured.' + r.match.entry.id.split('.').slice(1).join('.'));
        if (fracTwin) f.id = fracTwin.id;
        else {
          var fe = Matcher.findInSection(statIndex, r.mod.line, 'fractured');
          if (fe) f.id = fe.id;
        }
      }
      if (!r.match.fixedText) {
        var min = parseFloat(r.minInput.value);
        // "upgrades only": never accept a roll below what the character wears
        // (equipped values are single-mod scale; inputs may be pseudo-scaled)
        if (upgradeEq) {
          var eqv = upgradeEq[r.match.entry.id.split('.').pop().split('|')[0]];
          if (eqv !== undefined && eqv !== null && eqv > 0) {
            var floor = roundMin(eqv * (r.inputScale || 1));
            if (isNaN(min) || min < floor) min = floor;
          }
        }
        if (!isNaN(min)) {
          // the input was rendered in one scale (pseudo totals fold dual-res
          // rolls ×2) — convert if the id we're sending uses a different one
          var targetScale = (pseudoOn && r.match.pseudo && !(requireFrac && r.mod.fractured))
            ? (r.pseudoMult || 1) : 1;
          if (r.inputScale && targetScale !== r.inputScale) {
            min = Math.round(min * targetScale / r.inputScale * 10) / 10;
          }
          if (r.exactCount) f.value = { min: min, max: min };
          // negative-value mods (e.g. -# mana cost): lower is better -> use max
          else f.value = (min < 0) ? { max: min } : { min: min };
        }
      }
      if (seenIds[f.id]) {
        // merge duplicate stat ids (e.g. two res rolls folding into one pseudo total,
        // or the same notable appearing twice)
        var prev = seenIds[f.id];
        if (f.value && prev.value && prev.value.min !== undefined && f.value.min !== undefined)
          prev.value.min = roundMin(prev.value.min + f.value.min);
        else if (f.value && prev.value && prev.value.max !== undefined && f.value.max !== undefined)
          prev.value.max = roundMin(prev.value.max + f.value.max);
        else if (!f.value && !prev.value)
          prev.value = { min: 2 }; // same fixed-text stat twice -> require it twice
        else if (!f.value && prev.value && prev.value.min >= 2)
          prev.value.min += 1;
        return;
      }
      seenIds[f.id] = f;
      filters.push(f);
    });

    if (state.unique) {
      query.name = state.resolvedName || state.item.name;
      if (state.item.base && state.item.base !== state.item.name) query.type = state.item.base;
      // unique roll filters: any ticked mods become hard requirements
      if (filters.length) query.stats = [{ type: 'and', filters: filters }];
      var uFilters = {};
      var usf = socketFilters(state);
      if (usf) uFilters.socket_filters = usf;
      var ubp = basePercentileFilter(state);
      if (ubp) uFilters.armour_filters = ubp;
      if (tradeFilters) uFilters.trade_filters = tradeFilters.trade_filters;
      if (Object.keys(uFilters).length) query.filters = uFilters;
    } else {
      // a weight group needs 2+ members to mean anything — otherwise restore
      if (flexDiverted.length === 1) {
        var lone = flexDiverted.pop();
        filters.push({ id: lone.id, value: { min: lone.min } });
      }
      if (!filters.length && !flexDiverted.length) {
        if (!quiet) UI.toast('No mods selected for this search.', 'warn');
        return null;
      }

      var mode = state.modeSel ? parseInt(state.modeSel.value, 10) : 0;
      query.stats = [];
      if (filters.length) {
        var group;
        if (mode > 0 && filters.length > mode) {
          group = { type: 'count', value: { min: filters.length - mode }, filters: filters };
        } else {
          group = { type: 'and', filters: filters };
        }
        query.stats.push(group);
      }
      if (flexDiverted.length >= 2) {
        var flexMin = 0;
        flexDiverted.forEach(function (d) { flexMin += d.min * d.weight; });
        query.stats.push({
          type: 'weight',
          value: { min: Math.round(flexMin) },
          filters: flexDiverted.map(function (d) { return { id: d.id, value: { weight: d.weight } }; })
        });
      }

      var qFilters = {};
      var cat = categoryFor(state.slot, state.item);
      var searchBy = state.searchBySel ? state.searchBySel.value : (cat ? 'slot' : null);
      var bt = (window.POE_BASE_TYPES || {})[state.item.base] || null;
      var armourF = {};
      if (searchBy === 'exact' && state.item.base) {
        query.type = state.item.base;
      } else if (searchBy === 'class' && bt && bt[0]) {
        qFilters.type_filters = { filters: { category: { option: bt[0] } } };
      } else if (cat) {
        qFilters.type_filters = { filters: { category: { option: cat } } };
        if (searchBy === 'def' && bt && bt[1]) {
          // absent defences capped at 0 — "min 1" alone admits other bases that
          // pick up incidental ES/armour from implicits or mods
          var has = bt[1].split('/');
          ['ar', 'ev', 'es'].forEach(function (d) {
            armourF[d] = has.indexOf(d) !== -1 ? { min: 1 } : { max: 0 };
          });
        }
      }
      var sf = socketFilters(state);
      if (sf) qFilters.socket_filters = sf;
      var bp = basePercentileFilter(state);
      if (bp) Object.keys(bp.filters).forEach(function (k) { armourF[k] = bp.filters[k]; });
      if (Object.keys(armourF).length) qFilters.armour_filters = { filters: armourF };
      var misc = {};
      if (state.inflToggle && state.inflToggle.checkbox.checked) {
        state.item.influences.forEach(function (inf) {
          if (INFLUENCE_KEY[inf]) misc[INFLUENCE_KEY[inf]] = { option: true };
        });
      }
      var ilvlMin = state.ilvlInput ? parseInt(state.ilvlInput.value, 10) : NaN;
      if (!isNaN(ilvlMin) && ilvlMin > 0) {
        misc.ilvl = { min: ilvlMin };
      }
      if (Object.keys(misc).length) qFilters.misc_filters = { filters: misc };
      if (tradeFilters) qFilters.trade_filters = tradeFilters.trade_filters;
      if (Object.keys(qFilters).length) query.filters = qFilters;
    }

    // Sort: by a chosen mod's roll (server-side, across ALL listings), else price
    var sort = { price: 'asc' };
    if (state.sortSpec) {
      sort = {};
      sort[state.sortSpec.statKey] = state.sortSpec.dir;
    }
    return { query: query, sort: sort };
  }

  // Max sockets a slot can hold: helm/gloves/boots 4, shield 3, body 6,
  // weapons 6 (two-handers) or 3 (one-handers, inferred from the item's sockets)
  function socketCapFor(slot, item) {
    if (/^(Helmet|Gloves|Boots)/i.test(slot)) return 4;
    if (/^Body Armour/i.test(slot)) return 6;
    if (/shield|buckler|bundle/i.test(item.base || '')) return 3;
    if (/quiver/i.test(item.base || '')) return 0;
    if (/^Weapon/i.test(slot)) {
      var sc = item.sockets ? item.sockets.split(/[- ]/).filter(Boolean).length : 0;
      if (sc > 3 || item.maxLinks > 3) return 6;
      return sc > 0 ? 3 : 6; // unknown sockets: don't restrict below 6
    }
    return 0; // jewellery, jewels, flasks
  }

  var FLEX_RES_RE = /pseudo_total_(fire|cold|lightning|chaos)_resistance$|pseudo_total_elemental_resistance$|pseudo_total_all_elemental_resistances$/;

  function isFlexResRow(r) {
    return !!(r.match && r.match.pseudo && FLEX_RES_RE.test(r.match.pseudo.entry.id));
  }

  function basePercentileFilter(state) {
    if (!state.bpctSel || state.bpctSel.value === '-') return null;
    return { filters: { base_defence_percentile: { min: parseInt(state.bpctSel.value, 10) } } };
  }

  function socketFilters(state) {
    var f = {};
    if (state.socketsSel && state.socketsSel.value !== '-') f.sockets = { min: parseInt(state.socketsSel.value, 10) };
    if (state.linksSel && state.linksSel.value !== '-') f.links = { min: parseInt(state.linksSel.value, 10) };
    return Object.keys(f).length ? { filters: f } : null;
  }

  function buildTradeUrl(state) {
    var payload = buildTradePayload(state);
    if (!payload) return null;
    var league = document.getElementById('league').value;
    return 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) +
           '?q=' + encodeURIComponent(JSON.stringify(payload));
  }

  // ---- live countdown for GGG rate-limit cooldown messages ---------------------
  // The bridge reports "…cooldown — 3m 20s remaining" / "…cooling down 60s…" once;
  // this turns it into a ticking countdown and offers a retry when it reaches zero.
  var COOLDOWN_RE = /cooldown — (\d+)m (\d+)s remaining|cooling down (\d+)s/;
  var cooldownTicker = null;

  function showCooldown(box, msg, retry) {
    var m = COOLDOWN_RE.exec(msg || '');
    if (!m) return false;
    var secs = m[3] !== undefined ? parseInt(m[3], 10) : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    box.classList.remove('hidden');
    box.textContent = '';
    var line = document.createElement('span');
    line.className = 'cooldown-line';
    line.dataset.until = String(Date.now() + secs * 1000);
    box.appendChild(line);
    box._cooldownRetry = retry || null;
    tickCooldowns();
    if (!cooldownTicker) cooldownTicker = setInterval(tickCooldowns, 1000);
    return true;
  }

  function fmtCountdown(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return (s >= 60 ? Math.floor(s / 60) + 'm ' : '') + (s % 60) + 's';
  }

  function tickCooldowns() {
    var lines = document.querySelectorAll('.cooldown-line[data-until]');
    if (!lines.length) { clearInterval(cooldownTicker); cooldownTicker = null; return; }
    lines.forEach(function (line) {
      var left = parseInt(line.dataset.until, 10) - Date.now();
      if (left > 0) {
        line.textContent = '⏳ GGG rate-limit cooldown — ' + fmtCountdown(left) + ' remaining';
        return;
      }
      delete line.dataset.until;
      line.textContent = '✔ Cooldown over — safe to search again. ';
      var box = line.parentElement;
      if (box && box._cooldownRetry) {
        var b = UI.button('secondary');
        b.textContent = '↻ Retry';
        var fn = box._cooldownRetry;
        b.addEventListener('click', function () { fn(); });
        line.appendChild(b);
      }
    });
  }

  function openUrl(url) {
    if (isGui() && window.pywebview.api.open_url) window.pywebview.api.open_url(url);
    else window.open(url, '_blank');
  }

  function openAllSearches() {
    var i = 0;
    cards.forEach(function (state) {
      var payload = buildTradePayload(state, true); // quiet: skip cards with nothing selected
      if (!payload) return;
      var league = document.getElementById('league').value;
      var url = 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) +
                '?q=' + encodeURIComponent(JSON.stringify(payload));
      setTimeout(function () { openUrl(url); }, i++ * 400);
    });
  }

  // ---- character import + gear-gap diff ------------------------------------------
  var charGear = null; // slot name -> equipped item (bridge shape)
  var charName_ = '';

  // ---- value my gear: price what the imported character is wearing -------------
  // Uniques search by name; rares search for similar items (same base type, any N-1
  // of their mods at ≥85% of each roll). One search per item through the shared
  // rate limiter. "Similar listings" is an estimate — rares are notoriously hard to price.
  var VALUE_ROLL_PCT = 0.85;
  var VALUE_SLOT_ORDER = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots',
                          'Amulet', 'Ring 1', 'Ring 2', 'Belt', 'Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];

  function valuePayload(it, slot) {
    var status = document.getElementById('trade-status').value;
    var filters = { trade_filters: { filters: { sale_type: { option: 'priced' } } } };
    if (it.frameType === 3) { // unique
      var q = { status: { option: status }, name: resolveUniqueName(it.name), type: it.base, filters: filters };
      return { query: q, sort: { price: 'asc' } };
    }
    var stats = [];
    [['explicitMods', 'explicit', false, false], ['craftedMods', 'explicit', true, false],
     ['fracturedMods', 'explicit', false, true], ['implicitMods', 'implicit', false, false]].forEach(function (spec) {
      (it[spec[0]] || []).forEach(function (line) {
        if (line && typeof line === 'object') line = line.description || '';
        if (!line) return;
        var m = Matcher.matchMod(statIndex, { line: line, kind: spec[1], crafted: spec[2], fractured: spec[3] }, slot);
        if (!m || spec[0] === 'implicitMods' || spec[0] === 'craftedMods') return; // base/bench mods don't set value
        var f = { id: m.entry.id };
        if (m.avg !== null && m.avg !== undefined && !m.fixedText) {
          var v = m.avg * VALUE_ROLL_PCT;
          f.value = m.avg < 0 ? { max: roundMin(m.avg * VALUE_ROLL_PCT) } : { min: roundMin(v) };
        }
        if (!stats.some(function (s) { return s.id === f.id; })) stats.push(f);
      });
    });
    var q2 = { status: { option: status }, filters: filters, type: it.base };
    if (stats.length) {
      q2.stats = [{ type: 'count', value: { min: Math.max(1, stats.length - 1) }, filters: stats.slice(0, 10) }];
    }
    return { query: q2, sort: { price: 'asc' } };
  }

  async function valueMyGear(btn) {
    if (!charGear || !isGui()) return;
    var box = document.getElementById('gear-value');
    box.classList.remove('hidden');
    box.textContent = '';
    var league = document.getElementById('league').value;
    var head = document.createElement('div');
    head.className = 'cost-head';
    head.textContent = 'Your gear (' + charName_ + ') — cheapest similar listings';
    box.appendChild(head);
    var slots = VALUE_SLOT_ORDER.filter(function (s) { return charGear[s]; });
    var rows = {}, total = 0, priced = 0;
    slots.forEach(function (s) {
      var it = charGear[s];
      var row = document.createElement('div');
      row.className = 'cost-row';
      row.innerHTML = '<span class="cost-slot">' + esc(s) + '</span><span class="cost-item">' +
        esc((it.name ? it.name + ' ' : '') + it.base) + '</span><span class="cost-amt">queued</span>';
      box.appendChild(row);
      rows[s] = row;
    });
    var totalRow = document.createElement('div');
    totalRow.className = 'cost-row cost-total';
    box.appendChild(totalRow);
    btn.disabled = true;
    try {
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i], it = charGear[s], amt = rows[s].querySelector('.cost-amt');
        amt.textContent = 'checking…';
        var payload = valuePayload(it, s);
        try {
          var res = await window.pywebview.api.trade_search(league, JSON.stringify(payload));
          if (!res.ok) { amt.textContent = '❌ ' + String(res.error).slice(0, 60); continue; }
          var curs = [];
          res.listings.forEach(function (li) { if (li.currency && curs.indexOf(li.currency) === -1) curs.push(li.currency); });
          var rates = await craftRates(league, curs);
          var best = null;
          res.listings.forEach(function (li) {
            var r = rates[li.currency];
            if (li.amount != null && r !== undefined && (best === null || li.amount * r < best)) best = li.amount * r;
          });
          var url = 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) + '?q=' + encodeURIComponent(JSON.stringify(payload));
          amt.textContent = '';
          var a = document.createElement('a');
          a.href = '#';
          a.textContent = best === null ? (res.total ? 'no priced match' : 'no similar listings') :
            fmtEq(best, league) + ' · ' + res.total + ' similar';
          a.title = 'Open these similar listings on the trade site';
          a.addEventListener('click', (function (u) { return function (e) { e.preventDefault(); openUrl(u); }; })(url));
          amt.appendChild(a);
          if (best !== null) { total += best; priced++; }
        } catch (e) {
          amt.textContent = '❌ ' + (e.message || e);
        }
        totalRow.innerHTML = '<span class="cost-slot">TOTAL</span><span class="cost-item">' + priced + ' of ' +
          slots.length + ' items priced (estimate)</span><span class="cost-amt">' + fmtEq(total, league) + '</span>';
      }
    } finally {
      btn.disabled = false;
    }
  }
  var INV_SLOT = { Helm: 'Helmet', BodyArmour: 'Body Armour', Gloves: 'Gloves', Boots: 'Boots',
                   Amulet: 'Amulet', Ring: 'Ring 1', Ring2: 'Ring 2', Belt: 'Belt',
                   Weapon: 'Weapon 1', Offhand: 'Weapon 2' };

  function slotForInv(it) {
    if (it.inventoryId === 'Flask') return 'Flask ' + ((it.x || 0) + 1);
    return INV_SLOT[it.inventoryId] || null;
  }

  // stat-tail -> value map for an equipped item's mods
  function equippedStats(equipped, slot) {
    var tails = {};
    [['implicitMods', 'implicit'], ['explicitMods', 'explicit'], ['craftedMods', 'crafted'],
     ['fracturedMods', 'fractured'], ['enchantMods', 'implicit']].forEach(function (pair) {
      (equipped[pair[0]] || []).forEach(function (line) {
        // newer character-window responses wrap mods as {description, flags}
        if (line && typeof line === 'object') line = line.description || '';
        if (typeof line !== 'string' || !line) return;
        var m = Matcher.matchMod(statIndex, {
          line: line, kind: pair[1] === 'implicit' ? 'implicit' : 'explicit',
          crafted: pair[0] === 'craftedMods', fractured: pair[0] === 'fracturedMods'
        }, slot);
        if (m) {
          var tail = m.entry.id.split('.').pop().split('|')[0];
          if (!(tail in tails) || (m.avg !== null && m.avg > tails[tail])) tails[tail] = m.avg;
        }
      });
    });
    return tails;
  }

  function renderCharDiff(state) {
    if (!state.card) return; // gem panels have no card element
    var old = state.card.querySelector('.char-diff');
    if (old) old.remove();
    state.card.classList.remove('diff-matched', 'diff-close', 'diff-missing');
    if (!charGear) return;

    var strip = document.createElement('div');
    strip.className = 'char-diff';
    var equipped = charGear[state.slot];
    var status;

    if (!equipped) {
      status = 'diff-missing';
      strip.innerHTML = '<b>You:</b> <span class="miss">nothing equipped in this slot</span>';
    } else if (state.unique) {
      var same = equipped.name === state.item.name;
      status = same ? 'diff-matched' : 'diff-missing';
      strip.innerHTML = '<b>You:</b> ' + esc((equipped.name || equipped.base)) +
        (same ? ' <span class="ok">— matches the build</span>'
              : ' <span class="miss">— build wants ' + esc(state.item.name) + '</span>');
    } else {
      var eq = equippedStats(equipped, state.slot);
      var total = 0, have = 0, lowRolls = 0;
      var missing = [];
      state.rows.forEach(function (r) {
        if (!r.cb.checked || !r.match) return;
        total++;
        var tail = r.match.entry.id.split('.').pop().split('|')[0];
        if (tail in eq) {
          have++;
          var min = parseFloat(r.minInput.value);
          if (!isNaN(min) && min > 0 && eq[tail] !== null && eq[tail] < min) lowRolls++;
        } else {
          missing.push(r.mod.line);
        }
      });
      if (!total) { strip.remove(); return; }
      status = (have === total && !lowRolls) ? 'diff-matched'
             : (have * 2 >= total) ? 'diff-close' : 'diff-missing';
      strip.innerHTML = '<b>You:</b> ' + esc(equipped.name || equipped.base) +
        ' — <span class="' + (have === total ? 'ok' : 'miss') + '">' + have + '/' + total + ' target mods</span>' +
        (missing.length ? ' · missing: <span class="miss">' + esc(missing.slice(0, 3).join(' · ')) +
          (missing.length > 3 ? ' +' + (missing.length - 3) : '') + '</span>' : '') +
        (lowRolls ? ' · <span class="miss">' + lowRolls + ' low roll(s)</span>' : '');
      // upgrade finder: search only items at least as good as yours on every ticked stat
      var up = document.createElement('label');
      up.className = 'toggle upgrade-toggle';
      up.title = 'Raise each ticked mod\'s minimum to your equipped roll — searches, price checks and live alerts then only show upgrades';
      var upCb = document.createElement('input');
      upCb.type = 'checkbox';
      upCb.checked = !!state.upgradeOnly;
      upCb.addEventListener('change', function () {
        state.upgradeOnly = upCb.checked;
        if (state.upgradeOnly && isGui() && state.priceBtn) checkPrice(state);
      });
      up.appendChild(upCb);
      up.appendChild(document.createTextNode(' ⬆ Upgrades only'));
      strip.appendChild(document.createTextNode(' '));
      strip.appendChild(up);
    }
    state.card.classList.add(status);
    state.card.insertBefore(strip, state.card.children[1]);
  }

  function applyCharDiff() {
    cards.forEach(renderCharDiff);
    refreshSlotLists();
  }

  // ---- chaos-equivalent prices + build cost summary ------------------------------
  var RATES = {}; // league -> {currency: chaosRate}

  // ---- sparkline: one series, de-emphasis line, accent latest point, crosshair --
  // points: [{t: unix seconds, v: number, sub: optional secondary text}]
  function sparkline(points, opts) {
    opts = opts || {};
    var w = opts.w || 96, h = opts.h || 22, pad = 3;
    var wrap = document.createElement('span');
    wrap.className = 'spark';
    if (!points || points.length < 2) return wrap;
    var NS = 'http://www.w3.org/2000/svg';
    var vals = points.map(function (p) { return p.v; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    var t0 = points[0].t, t1 = points[points.length - 1].t;
    function x(p) { return pad + (t1 === t0 ? 0 : (p.t - t0) / (t1 - t0)) * (w - 2 * pad); }
    function y(p) { return h - pad - (p.v - lo) / (hi - lo) * (h - 2 * pad); }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('aria-hidden', 'true');
    var line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', points.map(function (p) { return x(p).toFixed(1) + ',' + y(p).toFixed(1); }).join(' '));
    line.setAttribute('class', 'spark-line');
    svg.appendChild(line);
    var hair = document.createElementNS(NS, 'line');
    hair.setAttribute('class', 'spark-hair'); hair.setAttribute('y1', 0); hair.setAttribute('y2', h);
    svg.appendChild(hair);
    var last = points[points.length - 1];
    var dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('class', 'spark-dot'); dot.setAttribute('r', 3);
    dot.setAttribute('cx', x(last)); dot.setAttribute('cy', y(last));
    svg.appendChild(dot);
    wrap.appendChild(svg);

    var fmt = opts.fmt || function (v) { return String(v); };
    var tip = document.createElement('span');
    tip.className = 'spark-tip hidden';
    wrap.appendChild(tip);
    function show(i) {
      var p = points[i];
      hair.setAttribute('x1', x(p)); hair.setAttribute('x2', x(p));
      hair.classList.add('on');
      dot.setAttribute('cx', x(p)); dot.setAttribute('cy', y(p));
      tip.textContent = '';
      var b = document.createElement('b');
      b.textContent = fmt(p.v);
      tip.appendChild(b);
      var when = new Date(p.t * 1000);
      tip.appendChild(document.createTextNode(' · ' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + (p.sub ? ' · ' + p.sub : '')));
      tip.classList.remove('hidden');
      tip.style.left = Math.min(Math.max(0, x(p) - 60), w) + 'px';
    }
    function hide() {
      hair.classList.remove('on');
      dot.setAttribute('cx', x(last)); dot.setAttribute('cy', y(last));
      tip.classList.add('hidden');
    }
    function nearest(clientX) {
      var r = svg.getBoundingClientRect();
      var px = (clientX - r.left) * (w / r.width), best = 0;
      points.forEach(function (p, i) { if (Math.abs(x(p) - px) < Math.abs(x(points[best]) - px)) best = i; });
      return best;
    }
    var idx = points.length - 1;
    svg.addEventListener('pointermove', function (e) { idx = nearest(e.clientX); show(idx); });
    svg.addEventListener('pointerleave', hide);
    // keyboard: focus the chart, arrows walk the points
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', (opts.label || 'Trend') + ': from ' + fmt(points[0].v) + ' to ' + fmt(last.v) +
      ', low ' + fmt(Math.min.apply(null, vals)) + ', high ' + fmt(Math.max.apply(null, vals)));
    wrap.addEventListener('focus', function () { show(idx); });
    wrap.addEventListener('blur', hide);
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
      else if (e.key === 'ArrowRight') idx = Math.min(points.length - 1, idx + 1);
      else return;
      e.preventDefault(); show(idx);
    });
    return wrap;
  }

  function fmtCompact(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    if (v >= 100) return String(Math.round(v));
    if (v >= 1) return String(Math.round(v * 10) / 10);
    return String(+v.toPrecision(2)); // cheap orbs: 0.042, not 0
  }
  function fmtDelta(first, last) {
    if (!first) return '';
    var d = (last - first) / first * 100;
    return (Math.abs(d) < 0.05 ? '±0.0' : (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1)) + '%';
  }

  // ---- market: GGG's hourly currency-exchange feed (no trade-API quota) -------
  var MARKET_CODES = ['divine', 'exalted', 'mirror', 'annul', 'vaal', 'gcp', 'regal',
                      'fusing', 'alch', 'chrome', 'scour', 'alt', 'jewellers', 'chance'];
  var market = null; // {league, hour, series, names}
  var THIN_MARKET_CHAOS = 5000; // median chaos-equivalent traded per hour
  var marketSeq = 0;

  async function loadMarket() {
    if (!isGui() || !window.pywebview.api.cx_history) return;
    var league = document.getElementById('league').value;
    var seq = ++marketSeq;
    var tile = document.getElementById('market-tile');
    tile.classList.remove('hidden');
    if (!market || market.league !== league) {
      tile.querySelector('.mt-value').textContent = '…';
      tile.querySelector('.mt-delta').textContent = 'loading 7-day history';
    }
    try {
      var r = await window.pywebview.api.cx_history(league, JSON.stringify(MARKET_CODES), 7);
      if (seq !== marketSeq) return; // league switched mid-load
      if (!r || !r.ok) throw new Error((r && r.error) || 'feed unavailable');
      market = { league: league, hour: r.hour, series: r.series, names: r.names };
      // seed the rate cache: chaos equivalents render instantly, no trade-API calls
      RATES[league] = RATES[league] || {};
      RATES[league].chaos = 1;
      Object.keys(r.series).forEach(function (c) {
        var s = r.series[c];
        if (s.length) RATES[league][c] = s[s.length - 1][1];
      });
      refreshEqDisplays(); // re-annotates listings and renders the market tile/panel
    } catch (e) {
      if (seq !== marketSeq) return;
      tile.querySelector('.mt-value').textContent = '—';
      tile.querySelector('.mt-delta').textContent = 'market feed unavailable';
      tile.title = String(e.message || e);
    }
  }

  function marketPoints(code) {
    return ((market && market.series[code]) || []).map(function (p) {
      return { t: p[0], v: p[1], sub: p[2] ? fmtCompact(p[2]) + 'c traded/h' : 'no trades that hour' };
    });
  }

  function renderMarket() {
    if (!market) return;
    document.getElementById('view-market').classList.add('has-data');
    var league = market.league;
    var tile = document.getElementById('market-tile');
    var div = marketPoints('divine');
    var lastDiv = div.length ? div[div.length - 1].v : null;
    tile.querySelector('.mt-value').textContent = lastDiv ? fmtCompact(lastDiv) + 'c' : '—';
    tile.querySelector('.mt-delta').textContent = div.length > 1 ? fmtDelta(div[0].v, lastDiv) + ' 7d' : '';
    var sp = tile.querySelector('.mt-spark');
    sp.textContent = '';
    sp.appendChild(sparkline(div, { label: 'Divine Orb in chaos, 7 days', fmt: function (v) { return fmtCompact(v) + 'c'; } }));
    var updated = new Date(market.hour * 1000);
    tile.title = 'Divine Orb price, 7 days — GGG currency exchange (' + league + '), hour of ' +
      updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '. Click for more currencies.';

    var panel = document.getElementById('market-panel');
    var body = panel.querySelector('tbody');
    body.textContent = '';
    MARKET_CODES.forEach(function (c) {
      var pts = marketPoints(c);
      if (!pts.length) return;
      var tr = document.createElement('tr');
      var name = document.createElement('td');
      name.textContent = market.names[c] || c;
      var now = document.createElement('td');
      now.className = 'num';
      var cur = pts[pts.length - 1].v, dr = RATES[league] && RATES[league].divine;
      now.textContent = fmtCompact(cur) + 'c' + (dr && cur >= dr && c !== 'divine' ? ' · ' + fmtCompact(cur / dr) + ' div' : '');
      var delta = document.createElement('td');
      delta.className = 'num';
      delta.textContent = pts.length > 1 ? fmtDelta(pts[0].v, cur) : '';
      // thin markets: hourly samples of a few thousand chaos swing on single trades
      var vols = market.series[c].map(function (p) { return p[2]; }).sort(function (a, b) { return a - b; });
      if (vols[Math.floor(vols.length / 2)] < THIN_MARKET_CHAOS) {
        var thin = document.createElement('span');
        thin.className = 'thin';
        thin.textContent = ' · thin';
        delta.title = 'Thin market — under ' + fmtCompact(THIN_MARKET_CHAOS) + 'c traded in a typical hour, so hourly samples are noisy';
        delta.appendChild(thin);
      }
      var trend = document.createElement('td');
      trend.appendChild(sparkline(pts, { label: (market.names[c] || c) + ' in chaos, 7 days',
        fmt: function (v) { return fmtCompact(v) + 'c'; } }));
      [name, now, delta, trend].forEach(function (td) { tr.appendChild(td); });
      body.appendChild(tr);
    });
    panel.querySelector('.mp-caption').textContent = 'GGG currency exchange · ' + league + ' · hourly, sampled every 12h · updated ' +
      updated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function annotateChaosEq(state) {
    if (!isGui() || !state.priceState) return;
    var league = state.priceState.league;
    var amts = state.priceBox.querySelectorAll('.price-amt[data-currency]');
    var need = [];
    amts.forEach(function (el) {
      var cur = el.dataset.currency;
      if (!(RATES[league] && RATES[league][cur] !== undefined) && need.indexOf(cur) === -1) need.push(cur);
    });
    if (eqMode() === 'divine' && !divRate(league) && need.indexOf('divine') === -1) need.push('divine');
    if (need.length) {
      try {
        var res = await window.pywebview.api.exchange_rates(league, JSON.stringify(need));
        if (res.ok) {
          RATES[league] = RATES[league] || {};
          Object.keys(res.rates).forEach(function (k) { RATES[league][k] = res.rates[k]; });
        }
      } catch (e) { /* rates unavailable — skip annotations */ }
    }
    var cheapest = null;
    var priced = [];
    state.priceBox.querySelectorAll('.price-amt[data-currency]').forEach(function (el) {
      var cur = el.dataset.currency;
      var amount = parseFloat(el.dataset.amount);
      var rate = RATES[league] && RATES[league][cur];
      if (rate === undefined || isNaN(amount)) return;
      var chaos = amount * rate;
      if (cur !== eqMode() && !el.querySelector('.chaos-eq')) {
        var span = document.createElement('span');
        span.className = 'chaos-eq';
        span.textContent = ' ≈ ' + fmtEq(chaos, league);
        el.appendChild(span);
      }
      priced.push({ el: el, chaos: chaos });
      if (cheapest === null || chaos < cheapest) cheapest = chaos;
    });
    // sniper badges: flag listings well under the cluster median
    if (priced.length >= 5) {
      var sortedVals = priced.map(function (p) { return p.chaos; }).sort(function (a, b) { return a - b; });
      var median = sortedVals[Math.floor(sortedVals.length / 2)];
      priced.forEach(function (p) {
        if (median > 0 && p.chaos < median * 0.6) {
          var listing = p.el.closest('.listing');
          var nameEl = listing && listing.querySelector('.listing-name');
          if (nameEl && !nameEl.querySelector('.badge.deal')) {
            var b = document.createElement('span');
            b.className = 'badge deal';
            b.textContent = '🔥 deal';
            b.title = 'Priced well under the going rate — verify the mods, could be a snipe (or a scam listing)';
            nameEl.appendChild(b);
          }
        }
      });
    }
    if (cheapest !== null) {
      // merge across pages — later pages must never raise the "cheapest"
      var ps2 = state.priceState;
      if (ps2) {
        if (ps2.cheapestChaos === undefined || cheapest < ps2.cheapestChaos) ps2.cheapestChaos = cheapest;
        state.cheapestChaos = ps2.cheapestChaos;
      } else {
        state.cheapestChaos = cheapest;
      }
      renderCostSummary();
    }
  }

  // ---- budget solver: cheapest listing combo meeting build-wide targets ----------
  // Scores every cached listing's total elemental resistance and life via the
  // matcher, then optimizes one pick per slot: start cheapest, then repeatedly
  // make the best "stat gained per chaos added" swap until targets are met.
  var RES_TAILS = { stat_3372524247: 1, stat_4220027924: 1, stat_1671376347: 1,   // fire/cold/lightning
                    stat_2901986750: 3,                                            // all ele res
                    stat_2915988346: 2, stat_4277795662: 2, stat_1876857497: 2 };  // dual res
  var LIFE_TAIL = 'stat_3299347043';

  function scoreListing(li, slot) {
    var res = 0, life = 0;
    [['implicitMods', 'implicit'], ['explicitMods', 'explicit'], ['craftedMods', 'crafted'],
     ['fracturedMods', 'fractured'], ['enchantMods', 'implicit']].forEach(function (pair) {
      (li[pair[0]] || []).forEach(function (raw) {
        var line = typeof raw === 'string' ? raw : (raw.description || '');
        if (!line) return;
        var m = Matcher.matchMod(statIndex, {
          line: line, kind: pair[1] === 'implicit' ? 'implicit' : 'explicit',
          crafted: pair[0] === 'craftedMods', fractured: pair[0] === 'fracturedMods'
        }, slot);
        if (!m || m.avg === null) return;
        var tail = m.entry.id.split('.').pop().split('|')[0];
        if (tail in RES_TAILS) res += m.avg * RES_TAILS[tail];
        if (tail === LIFE_TAIL) life += m.avg;
      });
    });
    return { res: res, life: life };
  }

  function solveBudget(resTarget, lifeTarget) {
    var league = document.getElementById('league').value;
    var slots = [];
    cards.forEach(function (state) {
      if (!state.priceState || state.bought || state.gemSpec) return;
      var cands = [];
      Object.keys(state.priceState.cache).forEach(function (pg) {
        state.priceState.cache[pg].forEach(function (li) {
          if (li.amount === null || li.amount === undefined) return;
          var rate = RATES[league] && RATES[league][li.currency];
          if (rate === undefined) return;
          var score = scoreListing(li, state.slot);
          cands.push({ li: li, chaos: li.amount * rate, res: score.res, life: score.life });
        });
      });
      if (cands.length) {
        cands.sort(function (a, b) { return a.chaos - b.chaos; });
        slots.push({ state: state, cands: cands, pick: 0 });
      }
    });
    if (slots.length < 2) return { ok: false, error: 'Price-check at least two slots first (Check all prices).' };

    function totals() {
      var t = { chaos: 0, res: 0, life: 0 };
      slots.forEach(function (s) {
        var c = s.cands[s.pick];
        t.chaos += c.chaos; t.res += c.res; t.life += c.life;
      });
      return t;
    }

    // greedy upgrades: best deficit-closed-per-chaos swap until targets met
    var guard = 0;
    while (guard++ < 500) {
      var t = totals();
      var resDef = Math.max(0, resTarget - t.res);
      var lifeDef = Math.max(0, lifeTarget - t.life);
      if (resDef <= 0 && lifeDef <= 0) break;
      var best = null;
      slots.forEach(function (s) {
        var cur = s.cands[s.pick];
        s.cands.forEach(function (cand, idx) {
          if (idx === s.pick) return;
          var dChaos = cand.chaos - cur.chaos;
          var gain = Math.min(resDef, Math.max(0, cand.res - cur.res)) +
                     Math.min(lifeDef, Math.max(0, cand.life - cur.life)) / 10;
          if (gain <= 0) return;
          var eff = gain / Math.max(0.5, dChaos);
          if (dChaos <= 0) eff = Infinity; // strictly better and cheaper/equal
          if (!best || eff > best.eff) best = { slot: s, idx: idx, eff: eff };
        });
      });
      if (!best) break; // no swap helps — targets unreachable with these listings
      best.slot.pick = best.idx;
    }
    var finalT = totals();
    return {
      ok: true,
      met: finalT.res >= resTarget && finalT.life >= lifeTarget,
      totals: finalT,
      picks: slots.map(function (s) { return { state: s.state, cand: s.cands[s.pick] }; })
    };
  }

  function renderCostSummary() {
    refreshSlotLists(); // prices + bought state in the slot lists follow the summary
    var box = document.getElementById('cost-summary');
    if (!box) return;
    var league = document.getElementById('league').value;
    var rows = cards.filter(function (s) { return s.cheapestChaos !== undefined && !s.bought; });
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="cost-head">Build cost — cheapest listing per checked slot</div>';
    box.firstChild.appendChild(copyButton('📋 Copy', function () {
      var lines = ['Build cost (' + league + ') — cheapest listing per slot'];
      var t = 0;
      rows.forEach(function (s) { t += s.cheapestChaos; lines.push(s.slot + ': ' + (s.item.name || s.item.base || '') + ' — ' + fmtEq(s.cheapestChaos, league)); });
      lines.push('TOTAL: ' + fmtEq(t, league) + ' for ' + rows.length + ' slot(s)');
      return lines.join('\n');
    }));
    var total = 0;
    rows.forEach(function (s) {
      total += s.cheapestChaos;
      var row = document.createElement('div');
      row.className = 'cost-row';
      row.innerHTML = '<span class="cost-slot">' + esc(s.slot) + '</span>' +
        '<span class="cost-item">' + esc(s.item.name) + '</span>' +
        '<span class="cost-amt">' + fmtEq(s.cheapestChaos, league) + '</span>';
      box.appendChild(row);
    });
    var dr = divRate(league);
    var secondary = eqMode() === 'divine'
      ? '  (' + fmtChaos(total) + ')'
      : (dr ? '  (' + (Math.round(total / dr * 10) / 10) + ' div)' : '');
    var totalRow = document.createElement('div');
    totalRow.className = 'cost-row cost-total';
    totalRow.innerHTML = '<span class="cost-slot">TOTAL</span><span class="cost-item">' +
      rows.length + ' slot(s) priced</span><span class="cost-amt">' + fmtEq(total, league) + secondary + '</span>';
    box.appendChild(totalRow);
    renderSolver(box, league);
  }

  var solverResTarget = 300, solverLifeTarget = 0, solverResult = null;

  function renderSolver(box, league) {
    var bar = document.createElement('div');
    bar.className = 'solve-bar';
    var lbl = document.createElement('span');
    lbl.className = 'cost-slot';
    lbl.textContent = 'SOLVER';
    lbl.title = 'Cheapest combination of priced listings that still meets build-wide targets — slots trade off against each other';
    bar.appendChild(lbl);
    var resIn = makeMiniInput(bar, 'Total ele res ≥', '300');
    resIn.value = solverResTarget || '';
    resIn.addEventListener('change', function () { solverResTarget = parseFloat(this.value) || 0; });
    var lifeIn = makeMiniInput(bar, 'Total life ≥', '0');
    lifeIn.value = solverLifeTarget || '';
    lifeIn.addEventListener('change', function () { solverLifeTarget = parseFloat(this.value) || 0; });
    var solveBtn = UI.button('secondary', { size: 'sm' });
    solveBtn.textContent = 'Solve cheapest combo';
    solveBtn.addEventListener('click', function () {
      solverResult = solveBudget(solverResTarget || 0, solverLifeTarget || 0);
      renderCostSummary();
    });
    bar.appendChild(solveBtn);
    box.appendChild(bar);

    if (!solverResult) return;
    if (!solverResult.ok) {
      var err = document.createElement('div');
      err.className = 'cost-row';
      err.innerHTML = '<span class="cost-slot"></span><span class="cost-item">' + esc(solverResult.error) + '</span>';
      box.appendChild(err);
      return;
    }
    solverResult.picks.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'cost-row';
      row.innerHTML = '<span class="cost-slot">' + esc(p.state.slot) + '</span>' +
        '<span class="cost-item">' + esc(((p.cand.li.name ? p.cand.li.name + ' ' : '') + p.cand.li.base)) +
        ' <span class="chaos-eq">res ' + Math.round(p.cand.res) + ' · life ' + Math.round(p.cand.life) + '</span></span>' +
        '<span class="cost-amt">' + fmtEq(p.cand.chaos, league) + '</span>';
      box.appendChild(row);
    });
    var t = solverResult.totals;
    var sumRow = document.createElement('div');
    sumRow.className = 'cost-row cost-total';
    sumRow.innerHTML = '<span class="cost-slot">' + (solverResult.met ? '✔ COMBO' : '⚠ BEST TRY') + '</span>' +
      '<span class="cost-item">res ' + Math.round(t.res) + ' · life ' + Math.round(t.life) +
      (solverResult.met ? '' : ' — targets not reachable with the priced listings (price more pages/slots)') + '</span>' +
      '<span class="cost-amt">' + fmtEq(t.chaos, league) + '</span>';
    box.appendChild(sumRow);
    var pinAll = UI.button('secondary');
    pinAll.textContent = '☆ Pin combo to basket';
    pinAll.addEventListener('click', function () {
      solverResult.picks.forEach(function (p) { pinToBasket(p.cand.li, p.state); });
      pinAll.textContent = '★ Pinned ' + solverResult.picks.length;
    });
    box.appendChild(pinAll);
  }

  function fmtChaos(v) {
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + 'c';
  }

  function eqMode() { return document.getElementById('eq-currency').value; }
  function divRate(league) { return RATES[league] && RATES[league]['divine']; }

  // format a chaos value in the chosen display currency (chaos or divine)
  function fmtEq(chaosVal, league) {
    if (eqMode() === 'divine') {
      var dr = divRate(league);
      if (dr && chaosVal >= dr / 10) { // below 0.1 div, chaos reads better than "0 div"
        var d = chaosVal / dr;
        return (d >= 10 ? Math.round(d) : Math.round(d * 100) / 100) + ' div';
      }
    }
    return fmtChaos(chaosVal);
  }

  function refreshEqDisplays() {
    cards.forEach(function (state) {
      if (!state.priceState) return;
      state.priceBox.querySelectorAll('.chaos-eq').forEach(function (el) { el.remove(); });
      annotateChaosEq(state);
    });
    renderCostSummary();
    renderBasket();
    renderMarket();
  }

  // ---- shopping basket ------------------------------------------------------------
  // button that copies text built at click time, with a brief confirmation
  function copyButton(label, textFn) {
    var btn = UI.button('secondary');
    btn.textContent = label;
    btn.title = 'Copy as text — paste into Discord, notes, or a message to a friend';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = textFn();
      var done = function () { btn.textContent = '✔ Copied'; setTimeout(function () { btn.textContent = label; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    });
    return btn;
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
    ta.remove();
  }

  function loadBasket() {
    try { return JSON.parse(localStorage.getItem('pobtf-basket')) || []; }
    catch (e) { return []; }
  }
  function saveBasket(b) {
    try { persist('pobtf-basket', JSON.stringify(b.slice(0, 40))); }
    catch (e) { /* fine */ }
  }
  function pinToBasket(li, state) {
    var b = loadBasket();
    // link back to the trade-site search that produced this listing (frozen at
    // search time, so later UI tweaks don't change what the pin points at)
    var tradeUrl = null;
    var ps = state && state.priceState;
    if (ps && ps.payloadStr && ps.league) {
      tradeUrl = 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(ps.league) +
                 '?q=' + encodeURIComponent(ps.payloadStr);
    }
    b.push({ name: li.name, base: li.base, amount: li.amount, currency: li.currency,
             account: li.account, whisper: li.whisper, tradeUrl: tradeUrl, ts: Date.now() });
    saveBasket(b);
    renderBasket();
    UI.toast('Pinned to your basket in the Upgrade planner.', 'success',
      { action: { label: 'View', onClick: function () { setView('planner'); window.scrollTo(0, 0); } } });
  }
  function renderBasket() {
    updateNavCounts();
    var box = document.getElementById('basket');
    var b = loadBasket();
    if (!b.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '';
    var league = document.getElementById('league').value;
    var head = document.createElement('div');
    head.className = 'basket-head';
    var total = 0, totalKnown = true;
    b.forEach(function (it) {
      var rate = RATES[league] && RATES[league][it.currency];
      if (it.amount !== null && it.amount !== undefined && rate !== undefined) total += it.amount * rate;
      else totalKnown = false;
    });
    head.textContent = 'Shopping basket — ' + b.length + ' item(s)' +
      (total ? ' · ' + (totalKnown ? '' : '≥ ') + fmtEq(total, league) : '');
    head.appendChild(copyButton('📋 Copy list', function () {
      var lines = ['Shopping list (' + league + ')' + (total ? ' — ' + (totalKnown ? '' : '≥ ') + fmtEq(total, league) : '')];
      b.forEach(function (it) {
        lines.push('- ' + ((it.name ? it.name + ' ' : '') + it.base) + ' — ' + it.account + ' — ' +
          ((it.amount !== null && it.amount !== undefined) ? it.amount + ' ' + it.currency : 'no price'));
        if (it.whisper) lines.push('  ' + it.whisper);
        if (it.tradeUrl) lines.push('  ' + it.tradeUrl);
      });
      return lines.join('\n');
    }));
    head.appendChild(UI.button('secondary', { size: 'sm', label: 'Clear', onClick: function () {
      UI.confirmDanger('Clear the basket?', 'All ' + b.length + ' pinned item(s) will be removed.', 'Clear basket')
        .then(function (ok) { if (ok) { saveBasket([]); renderBasket(); } });
    } }));
    box.appendChild(head);

    b.forEach(function (it, idx) {
      var row = document.createElement('div');
      row.className = 'basket-row';
      var label = document.createElement('span');
      label.className = 'basket-item';
      label.textContent = ((it.name ? it.name + ' ' : '') + it.base) + '  —  ' + it.account;
      var price = document.createElement('span');
      price.className = 'basket-price';
      price.textContent = (it.amount !== null && it.amount !== undefined)
        ? it.amount + ' ' + it.currency : 'no price';
      row.appendChild(label);
      row.appendChild(price);
      if (it.tradeUrl) {
        var tl = UI.button('secondary', { size: 'sm' });
        tl.textContent = '↗ Trade';
        tl.title = 'Open the search that found this item on the trade site';
        tl.addEventListener('click', function () { openUrl(it.tradeUrl); });
        row.appendChild(tl);
      }
      if (it.whisper && isGui()) {
        var w = UI.button('secondary', { size: 'sm' });
        w.textContent = '⚡ Whisper';
        w.addEventListener('click', function () { sendPoeChat(w, it.whisper, '⚡ Whisper'); });
        row.appendChild(w);
      }
      row.appendChild(UI.iconButton('✕', 'Remove from basket', { variant: 'secondary', size: 'sm', onClick: function () {
        UI.confirmDanger('Remove from basket?', ((it.name ? it.name + ' ' : '') + it.base) + ' — ' + it.account, 'Remove')
          .then(function (ok) {
            if (!ok) return;
            var cur = loadBasket();
            cur.splice(idx, 1);
            saveBasket(cur);
            renderBasket();
          });
      } }));
      box.appendChild(row);
    });
  }

  // ---- sold watcher: periodically re-check open results, grey out listings ------
  // that have disappeared (sold/delisted) until the next manual Check price.
  // One shared timer, round-robin over cards with open results — one API call
  // per tick keeps rate limits safe no matter how many result panels are open.
  var soldWatcherTimer = null;
  var soldWatcherIdx = 0;

  function ensureSoldWatcher() {
    if (soldWatcherTimer || !isGui()) return;
    soldWatcherTimer = setInterval(soldWatcherTick, window.SOLD_WATCH_MS || 60000);
  }

  async function soldWatcherTick() {
    var watchable = cards.filter(function (s) { return s.priceState && !s.live; });
    if (!watchable.length) return;
    var state = watchable[soldWatcherIdx++ % watchable.length];
    try {
      // re-run the exact query that produced the displayed listings — NOT a
      // rebuild from current controls, which may have been tweaked since
      var ps = state.priceState;
      if (!ps.payloadStr) return;
      var res = await window.pywebview.api.trade_search(ps.league, ps.payloadStr);
      if (!res.ok || state.priceState !== ps) return;
      var alive = {};
      (res.ids || []).forEach(function (i) { alive[i] = 1; });
      state.priceBox.querySelectorAll('.listing[data-lid]').forEach(function (el) {
        if (!alive[el.dataset.lid] && !el.classList.contains('sold')) {
          el.classList.add('sold');
          var nm = el.querySelector('.listing-name');
          if (nm) {
            var b = document.createElement('span');
            b.className = 'badge sold-badge';
            b.textContent = 'sold / delisted';
            nm.appendChild(b);
          }
        }
      });
    } catch (e) { /* transient — try again next tick */ }
  }

  // ---- live search: poll for new listings, ding on arrival (desktop app only) ----
  var liveCount = 0;
  var audioCtx = null;
  var HAS_SESSION = false; // POESESSID saved -> instant WebSocket live search

  // fill the character dropdown, current league first, then by level
  function populateCharSelect(characters) {
    var league = document.getElementById('league').value;
    var sorted = characters.slice().sort(function (a, b) {
      var al = a.league === league ? 0 : 1, bl = b.league === league ? 0 : 1;
      return al !== bl ? al - bl : (b.level || 0) - (a.level || 0);
    });
    var sel = document.getElementById('char-select');
    sel.innerHTML = '';
    sorted.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.name;
      o.textContent = (c.league === league ? '★ ' : '') + c.name +
        ' (' + c.league + ' lvl ' + c.level + ' ' + c['class'] + ')';
      sel.appendChild(o);
    });
    sel.classList.remove('hidden');
    document.getElementById('char-compare').classList.remove('hidden');
  }

  async function refreshSessionStatus(deep) {
    if (!isGui() || !window.pywebview.api.session_status) return;
    try {
      var r = await window.pywebview.api.session_status();
      HAS_SESSION = !!(r && r.set);
      var el = document.getElementById('sessid-status');
      if (!el) return;
      if (!HAS_SESSION) { el.textContent = ''; return; }
      if (deep && window.pywebview.api.session_validate) {
        // live check against GGG — expired sessions show up here instead of
        // failing silently when a live search tries to connect
        var v = await window.pywebview.api.session_validate();
        if (v && v.ok && v.valid) {
          el.textContent = '🟢 session active — instant alerts on';
        } else if (v && v.ok) {
          HAS_SESSION = false;
          el.textContent = '🔴 session expired — save a fresh POESESSID';
        } // network errors: leave the last known state alone
      } else {
        el.textContent = '🟢 instant alerts on';
      }
    } catch (e) { /* browser mode */ }
  }

  function initAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no sound */ }
    }
  }

  function playDing() {
    if (!audioCtx || !PREFS.sound) return;
    try {
      var peak = Math.max(0.02, Math.min(1, (parseInt(PREFS.volume, 10) || 25) / 100));
      var t = audioCtx.currentTime;
      [880, 1320].forEach(function (freq, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(peak, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.4);
      });
    } catch (e) { /* ignore */ }
  }

  async function toggleLive(state) {
    if (!isGui()) { UI.toast('Live search needs the desktop app (run PoB Trade Finder.bat).', 'warn'); return; }
    if (state.live) { stopLive(state); return; }
    if (liveCount >= 2) { UI.toast('Max 2 live searches at once — GGG rate limits.', 'warn'); return; }
    var payload = buildTradePayload(state);
    if (!payload) return;
    initAudio();
    liveCount++;
    // freeze the query at go-live: mid-session control changes must not shift
    // the result window (that would make old listings look "new")
    state.live = { seen: null, timer: null, found: 0, subId: null,
                   mode: HAS_SESSION ? 'ws' : 'poll',
                   payloadStr: JSON.stringify(payload),
                   league: document.getElementById('league').value };
    state.liveBtn.textContent = '⏹ Stop live';
    state.liveBtn.classList.add('live-active');
    state.liveBox.classList.remove('hidden');
    state.liveBox.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'live-head';
    head.textContent = state.live.mode === 'ws'
      ? '🟢 INSTANT — connecting to the live-search WebSocket…'
      : '🔴 LIVE — watching for new listings…';
    var feed = document.createElement('div');
    state.liveBox.appendChild(head);
    state.liveBox.appendChild(feed);
    state.live.head = head;
    state.live.feed = feed;
    if (state.live.mode === 'ws') startWsLive(state);
    else liveTick(state);
  }

  function stopLive(state) {
    if (!state.live) return;
    clearTimeout(state.live.timer);
    clearInterval(state.live.timer);
    if (state.live.subId && isGui() && window.pywebview.api.live_stop) {
      window.pywebview.api.live_stop(state.live.subId).then(function () {}, function () {});
    }
    state.live = null;
    liveCount--;
    if (state.liveBtn) {
      state.liveBtn.textContent = '🔴 Go live';
      state.liveBtn.classList.remove('live-active');
    }
    if (state.liveBox && state.live === null) {
      var h = state.liveBox.querySelector('.live-head');
      if (h) h.textContent = '⏹ live stopped';
    }
  }

  // Windows toast for live hits — only when the app is in the background
  // (the in-app ding and highlight cover the foreground case)
  function notifyLiveHit(state, listings, freshCount) {
    if (PREFS.notify === false || !isGui() || !window.pywebview.api.notify || document.hasFocus()) return;
    var cheapest = null;
    (listings || []).forEach(function (li) {
      if (li.amount == null) return;
      var rate = RATES[document.getElementById('league').value] && RATES[document.getElementById('league').value][li.currency];
      var chaos = rate !== undefined ? li.amount * rate : null;
      if (!cheapest || (chaos !== null && (cheapest.chaos === null || chaos < cheapest.chaos))) cheapest = { li: li, chaos: chaos };
    });
    var title = freshCount + ' new listing' + (freshCount > 1 ? 's' : '') + ' — ' + (state.slot || 'live search');
    var body = cheapest
      ? ((cheapest.li.name ? cheapest.li.name + ' ' : '') + cheapest.li.base + ' for ' + cheapest.li.amount + ' ' + cheapest.li.currency)
      : 'Open PoB Trade Finder to see it';
    window.pywebview.api.notify(title, body).then(function () {}, function () {});
  }

  // shared renderer for freshly-arrived live listings (polling or WebSocket)
  function renderLiveFresh(state, session, listings, freshCount) {
    playDing();
    notifyLiveHit(state, listings, freshCount);
    session.found += freshCount;
    var tails = tailsFor(state);
    var stamp = document.createElement('div');
    stamp.className = 'live-stamp';
    stamp.textContent = '— ' + freshCount + ' new @ ' + new Date().toLocaleTimeString() + ' —';
    session.feed.insertBefore(stamp, session.feed.firstChild);
    listings.slice().reverse().forEach(function (li) {
      var card = listingCard(li, tails, state);
      card.classList.add('live-new');
      session.feed.insertBefore(card, session.feed.firstChild);
    });
    session.head.textContent = (session.mode === 'ws' ? '🟢 INSTANT — ' : '🔴 LIVE — ') +
      session.found + ' new listing(s) found so far';
  }

  async function startWsLive(state) {
    var session = state.live;
    try {
      var res = await window.pywebview.api.live_start(session.league, session.payloadStr);
      if (state.live !== session) {
        if (res && res.ok) window.pywebview.api.live_stop(res.subId).then(function () {}, function () {});
        return;
      }
      if (!res.ok) {
        session.mode = 'poll';
        session.head.textContent = '🔴 LIVE (polling — instant unavailable: ' + res.error + ')';
        liveTick(state);
        return;
      }
      session.subId = res.subId;
      session.head.textContent = '🟢 INSTANT — ' + res.total +
        ' existing listings, new ones alert the moment they appear';
      session.timer = setInterval(function () { wsPoll(state, session); }, 1500);
    } catch (e) {
      if (state.live === session) {
        session.mode = 'poll';
        session.head.textContent = '🔴 LIVE (polling — ' + e.message + ')';
        liveTick(state);
      }
    }
  }

  async function wsPoll(state, session) {
    if (state.live !== session) return;
    try {
      var r = await window.pywebview.api.live_poll(session.subId);
      if (state.live !== session || !r.ok) return;
      if (r.status && r.status.indexOf('error') === 0) {
        session.head.textContent = '🟠 INSTANT (reconnect needed) — ' + r.status +
          ' — is your POESESSID still valid?';
        return;
      }
      if (r.ids && r.ids.length) {
        var r2 = await window.pywebview.api.trade_fetch(session.subId, JSON.stringify(r.ids.slice(0, 10)));
        if (r2.ok && state.live === session && r2.listings.length) {
          renderLiveFresh(state, session, r2.listings, r.ids.length);
        }
      }
    } catch (e) { /* transient — next poll */ }
  }

  async function liveTick(state) {
    var session = state.live; // identity: a stop+restart must not revive this chain
    if (!session) return;
    try {
      var res = await window.pywebview.api.trade_search(session.league, session.payloadStr);
      if (res.ok && state.live === session) {
        var ids = res.ids || [];
        if (session.seen === null) {
          session.seen = {};
          ids.forEach(function (i) { session.seen[i] = 1; });
          session.head.textContent = '🔴 LIVE — ' + res.total + ' existing listings, watching for new ones (checks ~20s)';
        } else {
          var fresh = ids.filter(function (i) { return !session.seen[i]; });
          ids.forEach(function (i) { session.seen[i] = 1; });
          if (fresh.length) {
            var r2 = await window.pywebview.api.trade_fetch(res.searchId, JSON.stringify(fresh.slice(0, 10)));
            if (r2.ok && state.live === session) {
              renderLiveFresh(state, session, r2.listings, fresh.length);
            }
          }
        }
      }
    } catch (e) {
      // rate-limit cooldowns are worth surfacing; other errors just retry
      if (state.live === session && /cooldown|rate.?limit/i.test(e.message || '')) {
        session.head.textContent = '🔴 LIVE (paused) — ' + e.message;
      }
    }
    if (state.live === session) {
      session.timer = setTimeout(function () { liveTick(state); }, window.LIVE_INTERVAL_MS || 30000);
    }
  }

  // ---- live price checking (desktop app only) -----------------------------------
  async function checkPrice(state, quiet) {
    if (!isGui()) { UI.toast('Live price checking needs the desktop app (run PoB Trade Finder.bat).', 'warn'); return; }
    var payload = null;
    try { payload = buildTradePayload(state, quiet); } catch (e) { /* stale card after re-render */ }
    if (!payload) return;
    var league = document.getElementById('league').value;
    var payloadStr = JSON.stringify(payload);
    // request generation token: rapid sort clicks race — only the newest wins
    var seq = state.priceSeq = (state.priceSeq || 0) + 1;
    var box = state.priceBox;
    box.classList.remove('hidden');
    box.textContent = 'Checking prices… (rate-limited, be patient)';
    state.priceBtn.disabled = true;
    try {
      var res = await window.pywebview.api.trade_search(league, payloadStr);
      if (seq !== state.priceSeq) return; // superseded by a newer search
      if (!res.ok) {
        if (showCooldown(box, res.error, function () { checkPrice(state, quiet); })) { state.priceState = null; return; }
        box.textContent = '❌ ' + res.error +
          (/complex/i.test(res.error || '') && !HAS_SESSION
            ? ' — flexible-resistance checks need a saved POESESSID (higher query budget); the trade-site link works while logged in there.'
            : '');
        state.priceState = null; // stop the sold watcher polling a dead panel
        return;
      }
      state.priceState = {
        searchId: res.searchId,
        ids: res.ids || [],
        total: res.total,
        pageSize: res.pageSize || 10,
        page: 0,
        cache: { 0: res.listings },
        // freeze the query the listings came from — the sold watcher must
        // validate against THIS, not whatever the controls say later
        payloadStr: payloadStr,
        league: league
      };
      renderListings(state);
      ensureSoldWatcher();
      var frozen = state.priceState;
      annotateChaosEq(state).then(function () { recordHistory(state, res, frozen); },
                                  function () { recordHistory(state, res, frozen); });
    } catch (e) {
      if (seq === state.priceSeq) {
        box.textContent = '❌ ' + e.message;
        state.priceState = null;
      }
    } finally {
      state.priceBtn.disabled = false;
    }
  }

  async function gotoPage(state, page) {
    var ps = state.priceState;
    if (!ps) return;
    var lastPage = Math.max(0, Math.ceil(ps.ids.length / ps.pageSize) - 1);
    if (page < 0 || page > lastPage || ps.loading) return;
    if (!ps.cache[page]) {
      ps.loading = true;
      renderListings(state);
      try {
        var ids = ps.ids.slice(page * ps.pageSize, (page + 1) * ps.pageSize);
        var r = await window.pywebview.api.trade_fetch(ps.searchId, JSON.stringify(ids));
        if (!r.ok) {
          if (!showCooldown(state.priceBox, r.error, function () { gotoPage(state, page); })) {
            state.priceBox.textContent = '❌ ' + r.error;
          }
          return;
        }
        ps.cache[page] = r.listings;
      } catch (e) {
        state.priceBox.textContent = '❌ ' + e.message;
        return;
      } finally {
        ps.loading = false;
      }
    }
    ps.page = page;
    renderListings(state);
    annotateChaosEq(state);
  }

  function renderListings(state) {
    var box = state.priceBox;
    var ps = state.priceState;
    box.innerHTML = '';

    var pageCount = Math.max(1, Math.ceil(ps.ids.length / ps.pageSize));
    function makeNav() {
      if (pageCount <= 1) return null;
      var nav = document.createElement('span');
      nav.className = 'price-nav';
      var prev = UI.button('secondary', { size: 'sm' });
      prev.textContent = '‹ Prev';
      prev.disabled = ps.page === 0 || !!ps.loading;
      prev.addEventListener('click', function () { gotoPage(state, ps.page - 1); });
      var pageLbl = document.createElement('span');
      pageLbl.className = 'page-label';
      pageLbl.textContent = 'page ' + (ps.page + 1) + ' / ' + pageCount +
        (ps.total > ps.ids.length ? ' (first ' + ps.ids.length + ')' : '');
      var next = UI.button('secondary', { size: 'sm' });
      next.textContent = 'Next ›';
      next.disabled = ps.page >= pageCount - 1 || !!ps.loading;
      next.addEventListener('click', function () { gotoPage(state, ps.page + 1); });
      nav.appendChild(prev); nav.appendChild(pageLbl); nav.appendChild(next);
      return nav;
    }
    var head = document.createElement('div');
    head.className = 'price-head';
    var label = document.createElement('span');
    label.textContent = ps.total + ' listed';
    head.appendChild(label);
    if (state.sortSpec) {
      var chip = document.createElement('span');
      chip.className = 'sort-chip';
      chip.textContent = 'sorted: ' + state.sortSpec.label + ' ' + (state.sortSpec.dir === 'desc' ? '↓' : '↑');
      var clear = document.createElement('button');
      clear.className = 'sort-btn active';
      clear.textContent = '✕';
      clear.title = 'Clear sort (back to price)';
      clear.addEventListener('click', function () {
        state.sortSpec = null;
        updateSortButtons(state);
        if (isGui()) checkPrice(state, true);
      });
      chip.appendChild(clear);
      head.appendChild(chip);
    }
    var topNav = makeNav();
    if (topNav) head.appendChild(topNav);
    box.appendChild(head);

    if (isGui()) {
      var hint = document.createElement('div');
      hint.className = 'price-hint';
      hint.textContent = '⚡ instant: ⌂ Go to hideout opens the search on the site — travel + buy there (gold fee, seller can be offline). 💬 in-person: whisper first, /hideout once they party you. Click any mod on a listing to sort by it.';
      box.appendChild(hint);
    }
    if (state.gemSpec && ps.total < 5) {
      var scarce = document.createElement('div');
      scarce.className = 'price-hint';
      scarce.textContent = '⚠ only ' + ps.total + ' listed at these minimums — lower the gem level or quality to see more (it re-searches automatically).';
      box.appendChild(scarce);
    }

    var listings = ps.cache[ps.page] || [];
    if (ps.loading) {
      var ld = document.createElement('div');
      ld.className = 'unique-note';
      ld.textContent = 'Loading page… (rate-limited)';
      box.appendChild(ld);
      return;
    }
    if (!listings.length) {
      box.appendChild(document.createTextNode('No listings found. Loosen the mods or drop the min-roll %.'));
      return;
    }
    var tails = tailsFor(state);
    listings.forEach(function (li) {
      box.appendChild(listingCard(li, tails, state));
    });
    // bottom nav so you don't scroll back up after reading the last item
    var bottomNav = makeNav();
    if (bottomNav) {
      var foot = document.createElement('div');
      foot.className = 'price-head price-foot';
      foot.appendChild(bottomNav);
      box.appendChild(foot);
    }
  }

  // stat-id tails of the mods a search filtered on — used to highlight them on listings
  function tailsFor(state) {
    var tails = {};
    (state.rows || []).forEach(function (r) {
      if (r.cb.checked && r.match) {
        tails[r.match.entry.id.split('.').pop().split('|')[0]] = true;
        if (r.match.pseudo) tails[r.match.pseudo.entry.id.split('.').pop()] = true;
      }
    });
    return tails;
  }

  var FRAME_CLASS = { 0: 'normal', 1: 'magic', 2: 'rare', 3: 'unique', 4: 'gem' };
  var GEM_ICONS = {}; // gem name -> single-frame trade art (bridge-cached)
  // srcless <img> renders a broken frame — pending slots use a blank pixel
  var BLANK_PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  var PROP_WHITELIST = ['Quality', 'Armour', 'Evasion Rating', 'Energy Shield', 'Ward',
                        'Physical Damage', 'Elemental Damage', 'Critical Strike Chance',
                        'Attacks per Second', 'Level'];

  // fetch API mod entries are either plain strings or rich objects
  // {description, hash: "stat.explicit.stat_XXX", mods: [{tier: "P2"|"S2", ...}]}
  function normListingMod(entry) {
    if (typeof entry === 'string') return { text: entry, tier: null, tail: null, hash: null, magnitudes: null };
    var mods = entry.mods || [];
    var tier = null, magnitudes = null;
    if (mods.length === 1) {
      tier = mods[0].tier || null;
      magnitudes = mods[0].magnitudes || null;
    } else if (mods.length > 1) {
      // combined line (several affixes feeding one stat): tiers joined, roll
      // range = sum of the contributing ranges when the shapes agree
      var tiers = mods.map(function (m) { return m.tier; }).filter(Boolean);
      tier = tiers.length ? tiers.join('+') : null;
      var lists = mods.map(function (m) { return m.magnitudes || []; });
      var n = lists[0].length;
      if (n && lists.every(function (l) { return l.length === n; })) {
        magnitudes = [];
        for (var i = 0; i < n; i++) {
          var lo = 0, hi = 0, ok = true;
          lists.forEach(function (l) {
            var a = parseFloat(l[i].min), b = parseFloat(l[i].max);
            if (isNaN(a) || isNaN(b)) ok = false; else { lo += a; hi += b; }
          });
          if (!ok) { magnitudes = null; break; }
          magnitudes.push({ min: lo, max: hi });
        }
      }
    }
    return {
      text: entry.description || '',
      tier: tier,
      tail: entry.hash ? entry.hash.split('.').pop() : null,
      hash: entry.hash || null,
      magnitudes: magnitudes
    };
  }

  // Where in its tier range did this mod roll? Returns {range, pct} or null.
  // magnitudes come from the trade API: [{min:"115", max:"129"}, ...] per line.
  function rollInfo(text, magnitudes) {
    if (!magnitudes || !magnitudes.length) return null;
    var values = Matcher.extractNumbers(text);
    // stat templates can contain literal digits before the rolled ones
    // ("With at least 40 Dexterity in Radius, …") — align from the tail
    if (values.length > magnitudes.length) {
      values = values.slice(values.length - magnitudes.length);
    }
    var parts = [], fracs = [];
    for (var i = 0; i < magnitudes.length && i < values.length; i++) {
      var lo = parseFloat(magnitudes[i].min), hi = parseFloat(magnitudes[i].max);
      if (isNaN(lo) || isNaN(hi)) continue;
      if (lo === hi) continue; // fixed — no range to show
      parts.push(lo + '–' + hi);
      fracs.push(Math.min(1, Math.max(0, (values[i] - lo) / (hi - lo))));
    }
    if (!fracs.length) return null;
    var pct = Math.round(100 * fracs.reduce(function (a, b) { return a + b; }, 0) / fracs.length);
    return { range: parts.join(', '), pct: pct };
  }

  // Open prefix/suffix estimate from mod tier codes (P#/S#). Hybrid mods list
  // one affix across several lines — dedupe by tier+affix name. Crafted and
  // fractured mods occupy slots too; veiled mods say which side they hide.
  function affixSummary(li) {
    var p = 0, s = 0, seen = {};
    ['explicitMods', 'craftedMods', 'fracturedMods'].forEach(function (k) {
      (li[k] || []).forEach(function (raw) {
        if (typeof raw === 'string') return;
        var m0 = raw.mods && raw.mods[0];
        var tier = (m0 && m0.tier) || '';
        var key = tier + '|' + ((m0 && m0.name) || raw.description);
        if (seen[key]) return;
        seen[key] = true;
        if (/^P/.test(tier)) p++;
        else if (/^S/.test(tier)) s++;
      });
    });
    (li.veiledMods || []).forEach(function (raw) {
      var t = typeof raw === 'string' ? raw : (raw.description || '');
      if (/prefix/i.test(t)) p++;
      else if (/suffix/i.test(t)) s++;
    });
    var cap = li.frameType === 1 ? 1 : 3; // magic 1/1, rare 3/3
    if (li.frameType !== 1 && li.frameType !== 2) return null;
    return { p: p, s: s, cap: cap, openP: Math.max(0, cap - p), openS: Math.max(0, cap - s) };
  }

  // trade-style socket display: coloured dots, gold bars for links, gaps between groups
  function socketStrip(sockets) {
    if (!sockets || !sockets.length) return null;
    var wrap = document.createElement('div');
    wrap.className = 'sockets-strip';
    var prevGroup = null;
    var NAMES = { R: 'Red', G: 'Green', B: 'Blue', W: 'White', A: 'Abyssal', DV: 'Resonator' };
    sockets.forEach(function (s) {
      if (prevGroup !== null) {
        var link = document.createElement('span');
        link.className = 'sock-link' + (s.group === prevGroup ? ' linked' : '');
        wrap.appendChild(link);
      }
      var dot = document.createElement('span');
      var colour = s.sColour || s.attr || 'W';
      dot.className = 'sock sock-' + colour;
      dot.title = NAMES[colour] || colour;
      wrap.appendChild(dot);
      prevGroup = s.group;
    });
    return wrap;
  }

  function maxLinks(sockets) {
    var counts = {};
    (sockets || []).forEach(function (s) { counts[s.group] = (counts[s.group] || 0) + 1; });
    var max = 0;
    Object.keys(counts).forEach(function (g) { if (counts[g] > max) max = counts[g]; });
    return max;
  }

  function listingCard(li, tails, state) {
    var card = document.createElement('div');
    card.className = 'listing';
    if (li.id) card.dataset.lid = li.id;

    // gem listings occasionally arrive without art — borrow the cached gem icon
    var iconUrl = li.icon ||
      (state && state.gemSpec && GEM_ICONS[state.gemSpec.gem.name]) || '';
    if (iconUrl) {
      var iconWrap = document.createElement('div');
      iconWrap.className = 'listing-icon';
      var img = document.createElement('img');
      img.src = iconUrl;
      img.loading = 'lazy';
      img.alt = '';
      iconWrap.appendChild(img);
      card.appendChild(iconWrap);
    }

    var main = document.createElement('div');
    main.className = 'listing-main';

    var nameEl = document.createElement('div');
    nameEl.className = 'listing-name ' + (FRAME_CLASS[li.frameType] || 'rare');
    nameEl.textContent = (li.name ? li.name + ' ' : '') + li.base;
    var qualProp = (li.properties || []).find(function (p) { return /^Quality/.test(p.name || '') && p.values && p.values.length; });
    var qualNum = qualProp ? parseInt(String(qualProp.values[0][0]).replace(/[^0-9]/g, ''), 10) : 0;
    var links = maxLinks(li.sockets);
    var badges = '';
    if (qualNum > 0) {
      // catalyst quality carries its type: "Quality (Resistance Modifiers)" -> "resistance"
      var qtMatch = qualProp.name.match(/^Quality \(([^)]+)\)/);
      var qtype = qtMatch ? ' · ' + qtMatch[1].replace(/ Modifiers$/i, '').toLowerCase() : '';
      badges += '<span class="badge qual' + (qualNum >= 28 ? ' qual-hi' : '') + '" title="' +
        esc(qualProp.name + ': ' + qualProp.values[0][0]) + '">Q' + qualNum + esc(qtype) + '</span>';
    }
    if (links >= 5) badges += '<span class="badge links">' + links + 'L</span>';
    if (li.corrupted) badges += '<span class="badge corrupt">corrupted</span>';
    if (li.identified === false) badges += '<span class="badge unid">unidentified</span>';
    if (li.searing) badges += '<span class="badge exarch">exarch</span>';
    if (li.tangled) badges += '<span class="badge eater">eater</span>';
    if (li.synthesised) badges += '<span class="badge synth">synthesised</span>';
    if (li.ilvl) badges += '<span class="badge">ilvl ' + li.ilvl + '</span>';
    var afx = affixSummary(li);
    if (afx && (afx.openP || afx.openS)) {
      badges += '<span class="badge open-affix" title="Estimated from mod tiers — open affix slots for crafting">open: ' +
        (afx.openP ? afx.openP + 'P' : '') + (afx.openP && afx.openS ? ' ' : '') +
        (afx.openS ? afx.openS + 'S' : '') + '</span>';
    } else if (afx) {
      badges += '<span class="badge" title="Prefixes/suffixes used — no open affix slots">' +
        afx.p + '/' + afx.cap + 'P · ' + afx.s + '/' + afx.cap + 'S</span>';
    }
    if (badges) nameEl.innerHTML = esc(nameEl.textContent) + badges;
    main.appendChild(nameEl);
    var sockStrip = socketStrip(li.sockets);
    if (sockStrip) main.appendChild(sockStrip);

    // "Quality" plus catalyst variants like "Quality (Resistance Modifiers)"
    var props = (li.properties || []).filter(function (p) {
      return (PROP_WHITELIST.indexOf(p.name) !== -1 || /^Quality/.test(p.name || '')) &&
             p.values && p.values.length;
    }).map(function (p) { return p.name + ': ' + p.values[0][0]; });
    // trade-site extended stats: weapons always show all three DPS numbers
    if (li.dps !== null && li.dps !== undefined) {
      props.unshift('DPS: ' + li.dps + '  ·  pDPS: ' + (li.pdps || 0) + '  ·  eDPS: ' + (li.edps || 0));
    }
    if (props.length || li.basePercentile !== null && li.basePercentile !== undefined) {
      var propEl = document.createElement('div');
      propEl.className = 'listing-props';
      propEl.textContent = props.join('  ·  ');
      if (li.basePercentile !== null && li.basePercentile !== undefined) {
        var bp = document.createElement('span');
        bp.className = 'base-pct' + (li.basePercentile >= 85 ? ' roll-hi' : (li.basePercentile <= 15 ? ' roll-lo' : ''));
        bp.textContent = (props.length ? '  ·  ' : '') + 'Base Percentile: ' + li.basePercentile + '%';
        bp.title = 'How well this item\'s base defences rolled for its basetype';
        propEl.appendChild(bp);
      }
      main.appendChild(propEl);
    }

    // gem experience: progress toward the next level
    var expProp = (li.additionalProperties || []).find(function (p) { return p.name === 'Experience'; });
    if (expProp) {
      var frac = typeof expProp.progress === 'number' ? expProp.progress : 0;
      var expText = (expProp.values && expProp.values[0] && expProp.values[0][0]) || '';
      var expWrap = document.createElement('div');
      expWrap.className = 'gem-exp';
      expWrap.title = 'Experience: ' + expText;
      var bar = document.createElement('div');
      bar.className = 'gem-exp-bar';
      var fill = document.createElement('div');
      fill.className = 'gem-exp-fill';
      fill.style.width = Math.round(frac * 100) + '%';
      bar.appendChild(fill);
      var lbl = document.createElement('span');
      lbl.className = 'gem-exp-label';
      lbl.textContent = Math.round(frac * 1000) / 10 + '% to next level';
      expWrap.appendChild(bar);
      expWrap.appendChild(lbl);
      main.appendChild(expWrap);
    }

    var modsEl = document.createElement('div');
    modsEl.className = 'listing-mods';
    function addMods(arr, cls, prefix) {
      (arr || []).forEach(function (raw) {
        var m = normListingMod(raw);
        if (!m.text) return;
        var line = document.createElement('div');
        var eldL = null;
        if (cls.indexOf('implicit') === 0 && m.tail && window.POE_ELDRITCH) {
          eldL = window.POE_ELDRITCH[m.tail];
          if (eldL === 'exarch' && !li.searing) eldL = null;
          if (eldL === 'eater' && !li.tangled) eldL = null;
        }
        line.className = 'lmod ' + cls + (m.tail && tails[m.tail] ? ' hl' : '');
        var tierBadge = m.tier ? '<span class="tier">' + esc(m.tier) + '</span>' : '';
        var roll = rollInfo(m.text, m.magnitudes);
        var rollHtml = '';
        if (roll) {
          var rollCls = roll.pct >= 70 ? ' roll-hi' : (roll.pct <= 30 ? ' roll-lo' : '');
          rollHtml = ' <span class="roll-range' + rollCls + '" title="Tier range ' + esc(roll.range) +
                     ' — this rolled at ' + roll.pct + '%">[' + esc(roll.range) + '] ' + roll.pct + '%</span>';
        }
        var eldHtml = eldL
          ? ' <span class="badge ' + (eldL === 'exarch' ? 'exarch-mod' : 'eater-mod') + '">' +
            (eldL === 'exarch' ? 'exarch' : 'eater') + '</span>'
          : '';
        line.innerHTML = tierBadge + esc(m.text) + eldHtml + rollHtml + (prefix ? ' <span class="lmod-src">(' + prefix + ')</span>' : '');
        if (m.hash && state) {
          // click any listing mod to sort all results by it
          line.classList.add('sortable');
          line.title = 'Click to sort results by this mod (again for lowest, again to clear)';
          line.addEventListener('click', function () { cycleSort(state, m.hash, m.text); });
        }
        modsEl.appendChild(line);
      });
    }
    addMods(li.enchantMods, 'enchant', null);
    addMods(li.implicitMods, 'implicit', null); // eldritch tints applied per-line
    if ((li.enchantMods || []).length + (li.implicitMods || []).length) {
      var sep = document.createElement('div');
      sep.className = 'lmod-sep';
      modsEl.appendChild(sep);
    }
    addMods(li.fracturedMods, 'fractured', null);
    addMods(li.explicitMods, 'explicit', null);
    addMods(li.craftedMods, 'crafted', null);
    addMods(li.veiledMods, 'veiled', 'veiled');
    main.appendChild(modsEl);
    card.appendChild(main);

    var side = document.createElement('div');
    side.className = 'listing-side';
    var pinBtn = UI.button('secondary', { size: 'sm' });
    pinBtn.textContent = '☆ Pin';
    pinBtn.title = 'Add to the shopping basket';
    pinBtn.addEventListener('click', function () {
      pinToBasket(li, state);
      pinBtn.textContent = '★ Pinned';
      setTimeout(function () { pinBtn.textContent = '☆ Pin'; }, 1200);
    });
    side.appendChild(pinBtn);
    var priced = (li.amount !== null && li.amount !== undefined);
    var amt = document.createElement('div');
    amt.className = 'price-amt' + (/divine/i.test(li.currency) ? ' divine' : '');
    amt.textContent = priced ? li.amount + ' ' + li.currency : 'no price';
    if (priced) {
      amt.dataset.amount = li.amount;
      amt.dataset.currency = li.currency;
    }
    // price type: ~b/o = buyout, ~price = fixed, neither = negotiable
    var ptype = document.createElement('span');
    ptype.className = 'ptype';
    ptype.textContent = li.priceType === '~price' ? 'fixed' : (li.priceType === '~b/o' ? 'b/o' : (priced ? '' : 'negotiable'));
    if (ptype.textContent) amt.appendChild(ptype);
    side.appendChild(amt);
    var instant = li.fee !== null && li.fee !== undefined;
    if (instant) {
      var feeEl = document.createElement('div');
      feeEl.className = 'fee-tag';
      feeEl.textContent = '⚡ instant · fee ' + li.fee.toLocaleString() + ' gold';
      feeEl.title = 'Instant buyout — purchase on the trade site for a gold fee, no whisper needed';
      side.appendChild(feeEl);
    }
    var acct = document.createElement('div');
    acct.className = 'price-acct';
    acct.textContent = li.account;
    side.appendChild(acct);
    if (li.whisper) {
      // "@CharName Hi, I would like to buy your…" -> character name for /hideout
      var charMatch = li.whisper.match(/^@(\S+)/);

      var wBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only' });
      wBtn.textContent = '⚡ Whisper in game';
      wBtn.title = 'Pastes the whisper into the PoE chat and sends it';
      wBtn.addEventListener('click', function () { sendPoeChat(wBtn, li.whisper, '⚡ Whisper in game'); });
      side.appendChild(wBtn);

      // Hideout travel only makes sense for priced listings (set price, go get it);
      // unpriced listings are a negotiation — whisper only.
      if (charMatch && priced) {
        var hBtn = UI.button('secondary', { size: 'sm', cls: 'gui-only' });
        hBtn.textContent = '⌂ Hideout';
        hBtn.title = 'Sends /hideout ' + charMatch[1] + ' in game — works once the seller has partied you';
        hBtn.addEventListener('click', function () { sendPoeChat(hBtn, '/hideout ' + charMatch[1], '⌂ Hideout'); });
        side.appendChild(hBtn);
      }

      var cBtn = UI.button('secondary', { size: 'sm' });
      cBtn.textContent = 'Copy whisper';
      cBtn.dataset.role = 'copy-whisper';
      cBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(li.whisper).then(function () {
          cBtn.textContent = 'Copied!';
          setTimeout(function () { cBtn.textContent = 'Copy whisper'; }, 1200);
        });
      });
      side.appendChild(cBtn);
    }
    if (instant && state) {
      // Instant buyout flow: travel to the seller's hideout via the trade
      // site's "Travel to Hideout" (gold fee, seller can be offline).
      var bBtn = UI.button('secondary', { size: 'sm' });
      bBtn.textContent = '⌂ Go to hideout ↗';
      bBtn.title = 'Opens this search on the trade site — use its "Travel to Hideout" button there (fee ' +
                   (li.fee ? li.fee.toLocaleString() + ' gold' : 'applies') + '). Travel needs your logged-in session, so it happens on the site.';
      bBtn.addEventListener('click', function () {
        var url = buildTradeUrl(state);
        if (url) openUrl(url);
      });
      side.appendChild(bBtn);
    }
    card.appendChild(side);
    return card;
  }

  async function sendPoeChat(btn, text, restoreLabel) {
    if (!isGui()) return;
    btn.disabled = true;
    var ok = false;
    try {
      var res = await window.pywebview.api.poe_chat(text);
      ok = !!(res && res.ok);
      btn.textContent = ok ? 'Sent!' : '❌ ' + ((res && res.error) || 'failed');
    } catch (e) {
      btn.textContent = '❌ ' + e.message;
    }
    setTimeout(function () { btn.textContent = restoreLabel; btn.disabled = false; }, ok ? 1200 : 3000);
  }

  async function checkAllPrices() {
    if (!isGui()) { UI.toast('Live price checking needs the desktop app (run PoB Trade Finder.bat).', 'warn'); return; }
    var btn = document.getElementById('check-all');
    btn.disabled = true;
    var snapshot = cards; // renderBuild() replaces `cards` if the user switches gear set mid-scan
    try {
      for (var i = 0; i < snapshot.length; i++) {
        if (cards !== snapshot) break; // build/set changed — stale cards, stop
        btn.textContent = 'Checking ' + (i + 1) + '/' + snapshot.length + '…';
        await checkPrice(snapshot[i], true); // Python bridge throttles between API calls
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check all prices';
    }
  }

  // ---- refresh bundled trade data (desktop app only) -----------------------------
  async function refreshData() {
    if (!isGui()) { UI.toast('Data refresh needs the desktop app — or run: node tools/make-data-js.js --fetch', 'warn'); return; }
    var btn = document.getElementById('refresh-data');
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      var res = await window.pywebview.api.refresh_data();
      if (res.ok) { btn.textContent = 'Done — reloading'; setTimeout(function () { location.reload(); }, 600); }
      else { btn.textContent = '❌ ' + res.error; btn.disabled = false; }
    } catch (e) {
      btn.textContent = '❌ ' + e.message; btn.disabled = false;
    }
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

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
      document.getElementById('settings-btn').addEventListener('click', function () {
        refreshHotkeyStatus();
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
})();
