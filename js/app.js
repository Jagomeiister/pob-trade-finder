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
  var PREFS = { fontsize: '100', density: 'comfortable', sound: true,
                volume: 25, motion: false, contrast: false, cb: false, theme: 'classic' };

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('pobtf-prefs'));
      if (p) Object.keys(PREFS).forEach(function (k) { if (k in p) PREFS[k] = p[k]; });
    } catch (e) { /* defaults */ }
  }

  function applyPrefs() {
    if (PREFS.theme && PREFS.theme !== 'classic') document.body.dataset.theme = PREFS.theme;
    else delete document.body.dataset.theme;
    var themeSel = document.getElementById('pref-theme');
    if (themeSel) themeSel.value = PREFS.theme || 'classic';
    document.body.style.zoom = (parseInt(PREFS.fontsize, 10) || 100) / 100;
    document.body.classList.toggle('compact', PREFS.density === 'compact');
    document.body.classList.toggle('reduce-motion', !!PREFS.motion);
    document.body.classList.toggle('high-contrast', !!PREFS.contrast);
    document.body.classList.toggle('cb-sockets', !!PREFS.cb);
    var ids = { 'pref-fontsize': PREFS.fontsize, 'pref-density': PREFS.density };
    Object.keys(ids).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = ids[id];
    });
    var s = document.getElementById('pref-sound'); if (s) s.checked = !!PREFS.sound;
    var v = document.getElementById('pref-volume'); if (v) v.value = PREFS.volume;
    var m = document.getElementById('pref-motion'); if (m) m.checked = !!PREFS.motion;
    var c = document.getElementById('pref-contrast'); if (c) c.checked = !!PREFS.contrast;
    var cb = document.getElementById('pref-cb'); if (cb) cb.checked = !!PREFS.cb;
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
      document.getElementById('input-panel').classList.remove('hidden');
      document.getElementById('build-bar').classList.add('hidden');
      var ta = document.getElementById('pob-input');
      ta.focus();
      ta.select();
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
        var sel = document.getElementById('char-select');
        sel.innerHTML = '';
        res.characters.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c.name;
          o.textContent = c.name + ' (' + c.league + ' lvl ' + c.level + ' ' + c['class'] + ')';
          sel.appendChild(o);
        });
        sel.classList.remove('hidden');
        document.getElementById('char-compare').classList.remove('hidden');
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
        status.textContent = '⚖ comparing against ' + charName;
      } catch (e) {
        status.textContent = '❌ ' + e.message;
      } finally {
        this.disabled = false;
      }
    });
    document.getElementById('hide-matched').addEventListener('change', function () {
      document.body.classList.toggle('hide-matched', this.checked);
    });
    document.getElementById('sessid-save').addEventListener('click', async function () {
      var inp = document.getElementById('sessid-input');
      this.disabled = true;
      try {
        var r = await window.pywebview.api.set_poesessid(inp.value);
        inp.value = '';
        inp.placeholder = r && r.set ? 'POESESSID saved' : 'POESESSID (optional)';
        await refreshSessionStatus();
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
      setTimeout(function () { btn.textContent = '☆ Save build'; }, 1200);
    });
    document.getElementById('saved-builds').addEventListener('change', function () {
      var lib = loadBuildLib();
      var b = lib[parseInt(this.value, 10)];
      if (b) {
        document.getElementById('pob-input').value = b.code;
        onDecode();
      }
    });
    document.getElementById('delete-build').addEventListener('click', function () {
      var sel = document.getElementById('saved-builds');
      var idx = parseInt(sel.value, 10);
      if (isNaN(idx)) return;
      var lib = loadBuildLib();
      lib.splice(idx, 1);
      saveBuildLib(lib);
      refreshBuildSelect();
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
    document.getElementById('settings-btn').addEventListener('click', function () {
      document.getElementById('settings-panel').classList.toggle('hidden');
    });
    document.getElementById('settings-close').addEventListener('click', function () {
      document.getElementById('settings-panel').classList.add('hidden');
    });
    document.getElementById('check-updates-btn').addEventListener('click', function () {
      checkForUpdates(true);
    });
    [['pref-theme', 'theme', 'value'],
     ['pref-fontsize', 'fontsize', 'value'], ['pref-density', 'density', 'value'],
     ['pref-sound', 'sound', 'checked'], ['pref-volume', 'volume', 'value'],
     ['pref-motion', 'motion', 'checked'], ['pref-contrast', 'contrast', 'checked'],
     ['pref-cb', 'cb', 'checked']].forEach(function (spec) {
      document.getElementById(spec[0]).addEventListener('change', function () {
        PREFS[spec[1]] = spec[2] === 'checked' ? this.checked : this.value;
        applyPrefs();
        savePrefs();
      });
    });
    function markGui() {
      document.body.classList.add('gui');
      checkForUpdates();
      setInterval(checkForUpdates, 4 * 3600 * 1000); // not just at launch
      refreshSessionStatus();
      hydrateFromBridge();
      // surface rate-limit cooldowns so the app never feels silently stuck
      setInterval(async function () {
        try {
          var r = await window.pywebview.api.rate_status();
          var chip = document.getElementById('rate-chip');
          if (r && r.ok && r.cooldownSeconds > 5) {
            chip.textContent = '⏳ API cooldown ' + Math.floor(r.cooldownSeconds / 60) + 'm ' +
              (r.cooldownSeconds % 60) + 's';
            chip.classList.remove('hidden');
          } else {
            chip.classList.add('hidden');
          }
        } catch (e) { /* bridge missing */ }
      }, 10000);
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
      document.getElementById('input-panel').classList.add('hidden');
      document.getElementById('build-bar').classList.remove('hidden');
      document.getElementById('build-label').textContent =
        build.ascendClass || build.className || 'Unknown class';
      var nSets = (build.itemSets || []).length;
      document.getElementById('build-sub').textContent =
        Object.keys(build.items).length + ' items' + (nSets > 1 ? ' · ' + nSets + ' gear sets' : '');
      renderBuild();
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
    if (sets.length > 1) {
      var pickWrap = document.createElement('div');
      pickWrap.className = 'set-picker';
      pickWrap.appendChild(document.createTextNode('Gear set: '));
      var pick = document.createElement('select');
      sets.forEach(function (s, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = s.title + (i === build.activeSetIndex ? ' (active in PoB)' : '');
        pick.appendChild(o);
      });
      pick.value = String(setIndex);
      pick.addEventListener('change', function () { renderBuild(parseInt(this.value, 10)); });
      pickWrap.appendChild(pick);
      root.appendChild(pickWrap);
    }

    // tabbed sections: gear / jewels & clusters / flasks / gems
    var sections = {};
    function section(key) {
      if (!sections[key]) {
        sections[key] = document.createElement('div');
        sections[key].className = 'tab-section';
        sections[key].dataset.tab = key;
      }
      return sections[key];
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

    var TAB_LABELS = { gear: 'Gear', jewels: 'Jewels & Clusters', flasks: 'Flasks', gems: 'Gems' };
    var present = ['gear', 'jewels', 'flasks', 'gems'].filter(function (k) { return sections[k]; });
    if (present.length > 1) {
      var bar = document.createElement('div');
      bar.className = 'tab-bar';
      ['all'].concat(present).forEach(function (k) {
        var btn = document.createElement('button');
        btn.className = 'tab-btn' + (k === 'all' ? ' active' : '');
        var count = k === 'all' ? null : sections[k].children.length;
        btn.textContent = (k === 'all' ? 'All' : TAB_LABELS[k]) + (count ? ' (' + count + ')' : '');
        btn.addEventListener('click', function () {
          root.dataset.tab = k;
          bar.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
        });
        bar.appendChild(btn);
      });
      root.appendChild(bar);
    }
    root.dataset.tab = 'all';
    present.forEach(function (k) { root.appendChild(sections[k]); });
    document.getElementById('controls').classList.remove('hidden');
    document.getElementById('char-bar').classList.remove('hidden');
    renderCostSummary(); // clears stale summary — fresh cards have no prices yet
    applyCharDiff();     // re-annotate fresh cards if a character is loaded
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
  function refreshBuildSelect() {
    var sel = document.getElementById('saved-builds');
    sel.innerHTML = '<option value="">Saved builds…</option>';
    loadBuildLib().forEach(function (b, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = b.name;
      sel.appendChild(o);
    });
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

  function gemPayload(gem, level, quality) {
    var misc = {};
    if (level > 1) misc.gem_level = { min: level };
    if (quality > 0) misc.quality = { min: quality };
    var filters = {};
    if (Object.keys(misc).length) filters.misc_filters = { filters: misc };
    var saleType = document.getElementById('sale-type').value;
    if (saleType !== 'any') filters.trade_filters = { filters: { sale_type: { option: saleType } } };
    var query = {
      status: { option: document.getElementById('trade-status').value },
      type: gemTradeName(gem.name)
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
      if (name.length > k.length && name.slice(-k.length) === k &&
          (!best || k.length > best.length)) best = k;
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
  async function resolveGemIcons(names) {
    if (!isGui() || !window.pywebview.api.gem_icon) return;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (GEM_ICONS[name]) { applyGemIcon(name, GEM_ICONS[name]); continue; }
      try {
        var res = await window.pywebview.api.gem_icon(gemTradeName(name));
        if (res && res.ok && res.icon) {
          GEM_ICONS[name] = res.icon;
          applyGemIcon(name, res.icon);
        }
      } catch (e) { return; /* bridge gone — stop quietly */ }
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
        var openBtn = document.createElement('button');
        openBtn.className = 'copy-btn';
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
            window.pywebview.api.gem_icon(gemTradeName(gem.name)).then(function (res) {
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
          var pBtn = document.createElement('button');
          pBtn.className = 'copy-btn gui-only';
          pBtn.textContent = 'Check price';
          pBtn.addEventListener('click', function () { checkPrice(gemState); });
          gemState.priceBtn = pBtn;
          var lBtn = document.createElement('button');
          lBtn.className = 'copy-btn gui-only';
          lBtn.textContent = '🔴 Go live';
          lBtn.addEventListener('click', function () { toggleLive(gemState); });
          gemState.liveBtn = lBtn;
          var oBtn = document.createElement('button');
          oBtn.className = 'trade-btn';
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
        var expandBtn = document.createElement('button');
        expandBtn.className = 'copy-btn gem-expand';
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
    var priceAll = document.createElement('button');
    priceAll.className = 'copy-btn gui-only';
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
    var openAllG = document.createElement('button');
    openAllG.className = 'copy-btn';
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
    var card = makeCard(item.slotGuess || 'Pasted item', item);
    pastedState = cards[cards.length - 1];
    card.classList.add('pasted');
    root.insertBefore(card, root.firstChild);
    renderCharDiff(pastedState);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    var iconHtml = (iconPath || (isUnique && isGui()))
      ? '<img class="card-icon" ' +
        (iconPath ? 'src="https://web.poecdn.com/image/' + iconPath + '?scale=1" ' : '') +
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
      var setSel = document.createElement('select');
      setSel.className = 'set-mini';
      slotSets.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = String(o.setIndex);
        opt.textContent = o.title;
        setSel.appendChild(opt);
      });
      setSel.value = String(setIndex);
      setSel.title = 'Show this slot from a different gear set';
      setSel.addEventListener('change', function () {
        swapCardSet(state, slot, parseInt(this.value, 10));
      });
      head.firstChild.appendChild(setSel);
    }
    card.appendChild(head);

    var iconEl = head.querySelector('.card-icon');
    if (iconEl) iconEl.onload = markAtlas; // flask/gem base art can be a sprite atlas
    // uniques: swap base art for the real unique art (trade lookup, disk-cached)
    if (isUnique && isGui()) {
      if (iconEl) {
        window.pywebview.api.unique_icon(state.resolvedName || item.name, item.base).then(function (res) {
          if (res && res.ok && res.icon && iconEl.isConnected) {
            iconEl.src = res.icon;
            iconEl.dataset.swapped = '1';
            iconEl.classList.remove('atlas2');
          }
        }).catch(function () { /* keep base art */ });
      }
    } else if (iconEl && (flaskBase || /flask|tincture/i.test(item.base || '')) && isGui() && window.pywebview.api.gem_icon) {
      // flasks: fetch the trade site's single-frame render (cached forever)
      var fb = flaskBase || item.base;
      window.pywebview.api.gem_icon(fb).then(function (res) {
        if (res && res.ok && res.icon && iconEl.isConnected) {
          iconEl.src = res.icon;
          iconEl.dataset.swapped = '1';
          iconEl.classList.remove('atlas2');
        }
      }).catch(function () { /* keep cropped art */ });
    }

    var body = document.createElement('div');
    body.className = 'card-body';
    card.appendChild(body);

    if (item.rarity === 'UNIQUE' || item.rarity === 'RELIC') {
      state.unique = true;
      state.resolvedName = resolveUniqueName(item.name);
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
      state.baseToggle = makeToggle(opts, 'Same base type (' + (item.base || '?') + ')', baseDefault);
      state.modeSel = makeModeSelect(opts, state);
      if (item.influences.length) {
        state.inflToggle = makeToggle(opts, 'Require influence: ' + item.influences.join(' + '), true);
      }
      if (item.itemLevel) {
        state.ilvlToggle = makeToggle(opts, 'Min item level ' + item.itemLevel, false);
      }
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
    var boughtBtn = document.createElement('button');
    boughtBtn.className = 'copy-btn';
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

    var priceBtn = document.createElement('button');
    priceBtn.className = 'copy-btn gui-only';
    priceBtn.textContent = 'Check price';
    priceBtn.addEventListener('click', function () { checkPrice(state); });
    state.priceBtn = priceBtn;
    btnWrap.appendChild(priceBtn);

    var liveBtn = document.createElement('button');
    liveBtn.className = 'copy-btn gui-only';
    liveBtn.textContent = '🔴 Go live';
    liveBtn.title = 'Watch this search — new listings appear here with a sound (checks ~20s)';
    liveBtn.addEventListener('click', function () { toggleLive(state); });
    state.liveBtn = liveBtn;
    btnWrap.appendChild(liveBtn);

    var openBtn = document.createElement('button');
    openBtn.className = 'trade-btn';
    openBtn.textContent = 'Search on trade site ↗';
    openBtn.addEventListener('click', function () {
      var url = buildTradeUrl(state);
      if (url) openUrl(url);
    });
    var copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
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
    return card;
  }

  // Render an item's mod rows with a trade-site style separator between the
  // implicit block and the explicit mods.
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
    cb.checked = !!match && !defaultOff && !(mod.crafted && mod.kind === 'explicit');
    cb.disabled = !match;

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
      rowState.exactCount = !!EXACT_COUNT_TEXTS[match.entry.text];
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
    var wrap = document.createElement('label');
    wrap.className = 'toggle';
    wrap.appendChild(document.createTextNode('Match: '));
    var sel = document.createElement('select');
    ['all mods', 'all but one', 'all but two'].forEach(function (t, i) {
      var o = document.createElement('option');
      o.value = String(i); o.textContent = t;
      sel.appendChild(o);
    });
    sel.value = '1'; // "all but one" is the sweet spot for upgrade hunting
    wrap.appendChild(sel);
    parent.appendChild(wrap);
    return sel;
  }

  function makeMiniInput(parent, label, placeholder) {
    var wrap = document.createElement('label');
    wrap.className = 'toggle';
    wrap.appendChild(document.createTextNode(label + ' '));
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.className = 'min-input';
    inp.placeholder = placeholder || '';
    inp.style.width = '70px';
    wrap.appendChild(inp);
    parent.appendChild(wrap);
    return inp;
  }

  function makeMiniSelect(parent, label, options, value) {
    var wrap = document.createElement('label');
    wrap.className = 'toggle';
    wrap.appendChild(document.createTextNode(label + ' '));
    var sel = document.createElement('select');
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      sel.appendChild(opt);
    });
    sel.value = value;
    wrap.appendChild(sel);
    parent.appendChild(wrap);
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
        if (!quiet) alert('No mods selected for this search.');
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
      var useBase = state.baseToggle && state.baseToggle.checkbox.checked && state.item.base;
      if (useBase) {
        query.type = state.item.base;
      } else if (cat) {
        qFilters.type_filters = { filters: { category: { option: cat } } };
      }
      var sf = socketFilters(state);
      if (sf) qFilters.socket_filters = sf;
      var bp = basePercentileFilter(state);
      if (bp) qFilters.armour_filters = bp;
      var misc = {};
      if (state.inflToggle && state.inflToggle.checkbox.checked) {
        state.item.influences.forEach(function (inf) {
          if (INFLUENCE_KEY[inf]) misc[INFLUENCE_KEY[inf]] = { option: true };
        });
      }
      if (state.ilvlToggle && state.ilvlToggle.checkbox.checked) {
        misc.ilvl = { min: state.item.itemLevel };
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
        if (typeof line !== 'string') return;
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
    }
    state.card.classList.add(status);
    state.card.insertBefore(strip, state.card.children[1]);
  }

  function applyCharDiff() {
    cards.forEach(renderCharDiff);
  }

  // ---- chaos-equivalent prices + build cost summary ------------------------------
  var RATES = {}; // league -> {currency: chaosRate}

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
    var box = document.getElementById('cost-summary');
    if (!box) return;
    var league = document.getElementById('league').value;
    var rows = cards.filter(function (s) { return s.cheapestChaos !== undefined && !s.bought; });
    if (!rows.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="cost-head">Build cost — cheapest listing per checked slot</div>';
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
    var solveBtn = document.createElement('button');
    solveBtn.className = 'copy-btn';
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
    var pinAll = document.createElement('button');
    pinAll.className = 'copy-btn';
    pinAll.textContent = '☆ Pin combo to basket';
    pinAll.addEventListener('click', function () {
      solverResult.picks.forEach(function (p) { pinToBasket(p.cand.li); });
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
      if (dr) {
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
  }

  // ---- shopping basket ------------------------------------------------------------
  function loadBasket() {
    try { return JSON.parse(localStorage.getItem('pobtf-basket')) || []; }
    catch (e) { return []; }
  }
  function saveBasket(b) {
    try { persist('pobtf-basket', JSON.stringify(b.slice(0, 40))); }
    catch (e) { /* fine */ }
  }
  function pinToBasket(li) {
    var b = loadBasket();
    b.push({ name: li.name, base: li.base, amount: li.amount, currency: li.currency,
             account: li.account, whisper: li.whisper, ts: Date.now() });
    saveBasket(b);
    renderBasket();
  }
  function renderBasket() {
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
    var clear = document.createElement('button');
    clear.className = 'copy-btn';
    clear.textContent = 'Clear';
    clear.addEventListener('click', function () { saveBasket([]); renderBasket(); });
    head.appendChild(clear);
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
      if (it.whisper && isGui()) {
        var w = document.createElement('button');
        w.className = 'copy-btn';
        w.textContent = '⚡ Whisper';
        w.addEventListener('click', function () { sendPoeChat(w, it.whisper, '⚡ Whisper'); });
        row.appendChild(w);
      }
      var del = document.createElement('button');
      del.className = 'copy-btn';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Remove from basket');
      del.addEventListener('click', function () {
        var cur = loadBasket();
        cur.splice(idx, 1);
        saveBasket(cur);
        renderBasket();
      });
      row.appendChild(del);
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

  async function refreshSessionStatus() {
    if (!isGui() || !window.pywebview.api.session_status) return;
    try {
      var r = await window.pywebview.api.session_status();
      HAS_SESSION = !!(r && r.set);
      var el = document.getElementById('sessid-status');
      if (el) el.textContent = HAS_SESSION ? '🟢 instant alerts on' : '';
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
    if (!isGui()) { alert('Live search needs the desktop app (run PoB Trade Finder.bat).'); return; }
    if (state.live) { stopLive(state); return; }
    if (liveCount >= 2) { alert('Max 2 live searches at once — GGG rate limits.'); return; }
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

  // shared renderer for freshly-arrived live listings (polling or WebSocket)
  function renderLiveFresh(state, session, listings, freshCount) {
    playDing();
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
    if (!isGui()) { alert('Live price checking needs the desktop app (run PoB Trade Finder.bat).'); return; }
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
      annotateChaosEq(state);
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
        if (!r.ok) { state.priceBox.textContent = '❌ ' + r.error; return; }
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
      var prev = document.createElement('button');
      prev.className = 'copy-btn';
      prev.textContent = '‹ Prev';
      prev.disabled = ps.page === 0 || !!ps.loading;
      prev.addEventListener('click', function () { gotoPage(state, ps.page - 1); });
      var pageLbl = document.createElement('span');
      pageLbl.className = 'page-label';
      pageLbl.textContent = 'page ' + (ps.page + 1) + ' / ' + pageCount +
        (ps.total > ps.ids.length ? ' (first ' + ps.ids.length + ')' : '');
      var next = document.createElement('button');
      next.className = 'copy-btn';
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
    var pinBtn = document.createElement('button');
    pinBtn.className = 'copy-btn whisper-btn';
    pinBtn.textContent = '☆ Pin';
    pinBtn.title = 'Add to the shopping basket';
    pinBtn.addEventListener('click', function () {
      pinToBasket(li);
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

      var wBtn = document.createElement('button');
      wBtn.className = 'copy-btn whisper-btn gui-only';
      wBtn.textContent = '⚡ Whisper in game';
      wBtn.title = 'Pastes the whisper into the PoE chat and sends it';
      wBtn.addEventListener('click', function () { sendPoeChat(wBtn, li.whisper, '⚡ Whisper in game'); });
      side.appendChild(wBtn);

      // Hideout travel only makes sense for priced listings (set price, go get it);
      // unpriced listings are a negotiation — whisper only.
      if (charMatch && priced) {
        var hBtn = document.createElement('button');
        hBtn.className = 'copy-btn hideout-btn gui-only';
        hBtn.textContent = '⌂ Hideout';
        hBtn.title = 'Sends /hideout ' + charMatch[1] + ' in game — works once the seller has partied you';
        hBtn.addEventListener('click', function () { sendPoeChat(hBtn, '/hideout ' + charMatch[1], '⌂ Hideout'); });
        side.appendChild(hBtn);
      }

      var cBtn = document.createElement('button');
      cBtn.className = 'copy-btn whisper-btn';
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
      var bBtn = document.createElement('button');
      bBtn.className = 'copy-btn whisper-btn';
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
    if (!isGui()) { alert('Live price checking needs the desktop app (run PoB Trade Finder.bat).'); return; }
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
    if (!isGui()) { alert('Data refresh needs the desktop app — or run: node tools/make-data-js.js --fetch'); return; }
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
})();
