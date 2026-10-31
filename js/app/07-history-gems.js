/* js/app/07-history-gems.js — per-slot search history, gem shopping list.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- per-build search history ------------------------------------------------
// { buildKey: { slotKey: [ {ts, league, payloadStr, total, first} ] } }
var HISTORY_PER_SLOT = 8, HISTORY_BUILDS = 30;
function buildKey() { return codeKey(document.getElementById('pob-input').value); }
function codeKey(code) {
  var s = String(code || '').trim(), h = 5381;
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
    if (this.classList.contains('card-icon')) queueSlotRefresh();
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

// Gems page: a summary bar (price / open everything), then the same master–detail
// shape as the gear pages — link groups on the left, one group's gem table on the right
function makeGemsCard(gemGroups) {
  var totalGems = 0;
  gemGroups.forEach(function (g) { totalGems += g.gems.length; });
  var view = document.createElement('div');
  view.className = 'gems-view';
  var rows = [];             // every gem row: {gem, lvlIn, qIn, priceSpan, group}
  var groupStatus = [];      // per group: the status cell in its list row
  var mainName = (build && build.mainSkill && build.mainSkill[0]) || '';
  // open on the main skill's group (★), else the first one
  var startGroup = Math.max(0, gemGroups.findIndex(function (g) {
    return !!mainName && g.gems.some(function (x) { return x.name === mainName; });
  }));

  // ---- summary bar
  var summary = document.createElement('div');
  summary.className = 'gems-summary';
  summary.appendChild(UI.el('span', 'gems-count',
    gemGroups.length + (gemGroups.length === 1 ? ' link group' : ' link groups') + ' · ' + gemsWord(totalGems)));
  var totalEl = UI.el('span', 'gems-total');
  summary.appendChild(totalEl);
  summary.appendChild(UI.el('span', 'ctrl-spacer'));
  var priceAll = UI.button('primary', { cls: 'gui-only', label: 'Price all gems',
    title: 'Cheapest listing for every gem at its level and quality (one search each, rate-limit safe)' });
  var openAllG = UI.button('secondary', { label: 'Open all gem searches ↗' });
  summary.appendChild(priceAll);
  summary.appendChild(openAllG);
  view.appendChild(summary);

  var layout = document.createElement('div');
  layout.className = 'master-detail gems-layout';
  var list = document.createElement('div');
  list.className = 'slot-list';
  var detail = document.createElement('div');
  detail.className = 'slot-detail';
  layout.appendChild(list);
  layout.appendChild(detail);
  view.appendChild(layout);
  var head = UI.el('div', 'slot-list-head');
  head.appendChild(UI.el('b', null, 'Link groups'));
  head.appendChild(UI.el('span', 'slot-label', String(gemGroups.length)));
  list.appendChild(head);

  function gemFlags(name) {
    var isVaal = /^Vaal /.test(name);
    // transfigured: "Skill of Variant" — excluding naturally "of"-named skills
    var NATURAL_OF = /^(Herald of|Purity of|Wave of Conviction|Orb of Storms|Sigil of Power|Eye of Winter|Tornado of|Fist of War)/;
    return {
      vaal: isVaal,
      awakened: /^Awakened /.test(name),
      exceptional: /^(Empower|Enlighten|Enhance)( Support)?$/.test(name),
      transfigured: / of /.test(name) && !isVaal && !NATURAL_OF.test(name) && !/Support$/.test(name) &&
                    name.split(' of ')[1] && name.split(' ').length >= 3
    };
  }

  function gemImg(gem, cls) {
    var path = gemArtPath(gem.name);
    if (!path && !GEM_ICONS[gem.name] && !isGui()) return null;
    var img = document.createElement('img');
    img.className = cls;
    img.dataset.gem = gem.name;
    if (GEM_ICONS[gem.name]) {
      img.src = GEM_ICONS[gem.name];
      img.dataset.swapped = '1';
    } else if (isGui()) {
      // atlas frames can't be told apart from wide single-frame art —
      // hold a blank slot until the cached trade render arrives
      img.src = BLANK_PX;
      img.classList.add('pending');
      img.title = 'Gem art loads once from the trade site, then it\'s cached forever';
    } else {
      img.src = 'https://web.poecdn.com/image/' + path + '?scale=1';
      img.onload = markAtlas;
    }
    img.loading = 'lazy';
    img.alt = '';
    return img;
  }

  var listRows = [];
  gemGroups.forEach(function (group, gi) {
    var isMain = !!mainName && group.gems.some(function (g) { return g.name === mainName; });
    var card = document.createElement('div');
    card.className = 'card gem-group-card';
    var groupRows = [];

    // ---- detail header: the group, its gear piece, its actions
    var ch = document.createElement('div');
    ch.className = 'card-head';
    var title = document.createElement('div');
    title.className = 'card-title';
    var mainIcon = gemImg(group.gems[0], 'card-icon gem-head-icon');
    if (mainIcon) title.appendChild(mainIcon);
    var id = UI.el('div', 'card-id');
    id.appendChild(UI.el('span', 'slot-tag', (group.slot || 'No gear slot') + ' · ' + gemsWord(group.gems.length)));
    id.appendChild(UI.el('span', 'item-name gem-name', group.title));
    if (isMain) {
      var meta = UI.el('span', 'item-meta');
      meta.appendChild(UI.chip('★ Main skill', 'accent'));
      id.appendChild(meta);
    }
    title.appendChild(id);
    ch.appendChild(title);
    var acts = UI.el('div', 'card-actions');
    var priceGroup = UI.button('primary', { cls: 'gui-only', label: 'Price this group' });
    priceGroup.addEventListener('click', function () { priceRows(groupRows, priceGroup, 'Price this group'); });
    acts.appendChild(priceGroup);
    acts.appendChild(UI.button('secondary', { label: 'Open searches ↗', title: 'Open every gem in this group on the trade site',
      onClick: function () { openRows(groupRows); } }));
    ch.appendChild(acts);
    card.appendChild(ch);

    // ---- gem table
    var body = document.createElement('div');
    body.className = 'card-body';
    var th = UI.el('div', 'gem-head');
    th.setAttribute('aria-hidden', 'true');
    th.innerHTML = '<span></span><span>Gem</span><span>Level / quality</span><span class="num">Cheapest</span><span></span>';
    body.appendChild(th);

    group.gems.forEach(function (gem) {
      var f = gemFlags(gem.name);
      var corruptOnly = gem.level >= 21 || gem.quality >= 23 || f.vaal;
      var row = document.createElement('div');
      row.className = 'gem-row';
      var ic = gemImg(gem, 'gem-icon');
      row.appendChild(ic || UI.el('span', 'gem-icon'));

      var label = document.createElement('span');
      label.className = 'gem-name' + (f.vaal ? ' vaal' : '');
      label.textContent = gem.name + (gem.count > 1 ? ' ×' + gem.count : '');
      if (f.vaal) label.appendChild(UI.chip('vaal', 'danger', 'vaal-badge'));
      if (f.awakened) {
        var ab = UI.chip('awakened', 'unique', 'awakened-badge');
        ab.title = 'Awakened support — expensive, drops from Maven content';
        label.appendChild(ab);
      }
      if (f.exceptional) {
        var eb = UI.chip('exceptional', 'crafted', 'exceptional-badge');
        eb.title = 'Empower/Enlighten/Enhance — level matters far more than quality';
        label.appendChild(eb);
      }
      if (f.transfigured) {
        var tb = UI.chip('transfigured', 'divine', 'transfigured-badge');
        tb.title = 'Transfigured version — obtained from the Lab font, tradeable by exact name';
        label.appendChild(tb);
      }
      if (corruptOnly) {
        var cb2 = UI.chip('corrupted', 'danger', 'corrupt');
        cb2.title = f.vaal ? 'Vaal gems are always corrupted' : 'Only corrupted gems reach this level/quality (21/23+)';
        label.appendChild(cb2);
      }
      row.appendChild(label);

      var lq = UI.el('span', 'gem-lq');
      var lvlIn = UI.input({ type: 'number', cls: 'min-input gem-in', value: gem.level,
                             ariaLabel: 'Minimum level for ' + gem.name });
      lvlIn.title = 'Minimum gem level';
      var qIn = UI.input({ type: 'number', cls: 'min-input gem-in', value: gem.quality,
                           ariaLabel: 'Minimum quality for ' + gem.name });
      qIn.title = 'Minimum quality';
      lq.appendChild(lvlIn);
      lq.appendChild(UI.el('span', 'gem-sep', '/'));
      lq.appendChild(qIn);
      row.appendChild(lq);

      var priceSpan = UI.el('span', 'gem-price');
      row.appendChild(priceSpan);

      var rowActs = UI.el('span', 'row-acts');
      rowActs.appendChild(UI.iconButton('↗', 'Open ' + gem.name + ' search on the trade site', { variant: 'secondary', size: 'sm',
        onClick: function () { openUrl(gemUrl(gemPayload(gem, parseInt(lvlIn.value, 10) || 1, parseInt(qIn.value, 10) || 0))); } }));

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

        var sub = UI.el('div', 'gem-panel-sub');
        function updateSub() {
          sub.textContent = 'min level ' + (parseInt(lvlIn.value, 10) || 1) +
            ' · min quality ' + (parseInt(qIn.value, 10) || 0) + (corruptOnly ? ' · corrupted' : '');
        }
        updateSub();
        // loosening level/quality re-runs an open price check automatically
        [lvlIn, qIn].forEach(function (inp) {
          inp.addEventListener('change', function () {
            updateSub();
            if (isGui() && gemState.priceState) checkPrice(gemState, true);
          });
        });
        var bar = UI.el('div', 'gem-panel-btns');
        bar.appendChild(sub);
        bar.appendChild(UI.el('span', 'ctrl-spacer'));
        var pBtn = UI.button('primary', { cls: 'gui-only', label: 'Check price', onClick: function () { checkPrice(gemState); } });
        gemState.priceBtn = pBtn;
        var lBtn = UI.button('secondary', { cls: 'gui-only', label: '🔴 Go live', onClick: function () { toggleLive(gemState); } });
        gemState.liveBtn = lBtn;
        var oBtn = UI.button('secondary', { cls: 'act-search', label: 'Search on trade ↗',
          onClick: function () { var url = buildTradeUrl(gemState); if (url) openUrl(url); } });
        bar.appendChild(pBtn); bar.appendChild(lBtn); bar.appendChild(oBtn);
        panel.appendChild(bar);

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
      var expandBtn = UI.iconButton('▾', 'Listings for ' + gem.name, { variant: 'secondary', size: 'sm',
        title: 'Listings, live search and pinning for this gem' });
      expandBtn.setAttribute('aria-expanded', 'false');
      expandBtn.addEventListener('click', function () {
        var opening = panel.classList.contains('hidden');
        if (opening) ensureGemPanel();
        panel.classList.toggle('hidden', !opening);
        expandBtn.textContent = opening ? '▴' : '▾';
        expandBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      });
      rowActs.appendChild(expandBtn);
      row.appendChild(rowActs);

      body.appendChild(row);
      body.appendChild(panel);
      var r = { gem: gem, lvlIn: lvlIn, qIn: qIn, priceSpan: priceSpan, group: gi };
      rows.push(r);
      groupRows.push(r);
    });
    card.appendChild(body);
    if (gi === startGroup) card.classList.add('is-active');
    detail.appendChild(card);

    // ---- list row
    var lr = UI.el('button', 'slot-row');
    lr.type = 'button';
    lr.slotCard = card;
    var lic = gemImg(group.gems[0], 'slot-ic');
    if (lic) { lic.classList.remove('pending'); lr.appendChild(lic); } else lr.appendChild(UI.el('span', 'slot-ic'));
    var txt = UI.el('span', 'slot-txt');
    txt.appendChild(UI.el('span', 'slot-label', (isMain ? '★ ' : '') + (group.slot || 'No gear slot') +
      ' · ' + gemsWord(group.gems.length)));
    txt.appendChild(UI.el('span', 'slot-name gem-name', group.title));
    lr.appendChild(txt);
    var st = UI.el('span', 'slot-status');
    lr.appendChild(st);
    groupStatus[gi] = st;
    if (gi === startGroup) lr.setAttribute('aria-current', 'true');
    lr.addEventListener('click', function () { selectSlot(layout, card); });
    lr.addEventListener('keydown', function (e) {
      var i = listRows.indexOf(lr);
      var j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : -1;
      if (j < 0 || j >= listRows.length) return;
      e.preventDefault();
      selectSlot(layout, listRows[j].slotCard, true);
    });
    listRows.push(lr);
    list.appendChild(lr);
  });

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

  function openRows(subset) {
    subset.forEach(function (r, i) {
      setTimeout(function () {
        openUrl(gemUrl(gemPayload(r.gem, parseInt(r.lvlIn.value, 10) || 1, parseInt(r.qIn.value, 10) || 0)));
      }, i * 400);
    });
  }

  // cheapest listing per gem; group and page totals in the display currency
  async function priceRows(subset, btn, idleLabel) {
    if (!isGui()) return;
    btn.disabled = true;
    var league = document.getElementById('league').value;
    for (var i = 0; i < subset.length; i++) {
      var r = subset[i];
      btn.textContent = 'Pricing ' + (i + 1) + '/' + subset.length + '…';
      r.priceSpan.textContent = '…';
      r.cheapest = null;
      try {
        var res = await window.pywebview.api.trade_search(league,
          JSON.stringify(gemPayload(r.gem, parseInt(r.lvlIn.value, 10) || 1, parseInt(r.qIn.value, 10) || 0)));
        if (res.ok && res.listings.length) {
          var li = res.listings[0];
          r.priceSpan.textContent = li.amount + ' ' + li.currency;
          r.priceSpan.title = res.total + ' listed';
          if (li.amount !== null && li.amount !== undefined) {
            r.cheapest = { amount: li.amount, currency: li.currency, count: r.gem.count || 1 };
          }
        } else {
          r.priceSpan.textContent = '';
          r.priceSpan.appendChild(res.ok ? UI.chip('None listed', 'danger') : UI.chip('Failed', 'danger'));
          if (!res.ok) r.priceSpan.title = res.error || '';
        }
      } catch (e) {
        r.priceSpan.textContent = '';
        r.priceSpan.appendChild(UI.chip('Failed', 'danger'));
        r.priceSpan.title = e.message;
      }
    }
    // fetch any missing rates once, then total in the display currency
    var needCur = [];
    rows.forEach(function (r) {
      var c = r.cheapest;
      if (c && !(RATES[league] && RATES[league][c.currency] !== undefined) && needCur.indexOf(c.currency) === -1) needCur.push(c.currency);
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
    function total(subsetRows) {
      var t = 0, known = 0, priced = 0;
      subsetRows.forEach(function (r) {
        if (!r.cheapest) return;
        priced++;
        var rate = RATES[league] && RATES[league][r.cheapest.currency];
        if (rate !== undefined) { t += r.cheapest.amount * rate * r.cheapest.count; known++; }
      });
      return known ? fmtEq(t, league) + (known < priced ? ' (partial)' : '') : '';
    }
    gemGroups.forEach(function (g, gi) {
      var gr = rows.filter(function (r) { return r.group === gi; });
      var attempted = gr.some(function (r) { return r.priceSpan.textContent; });
      groupStatus[gi].textContent = total(gr) || (attempted ? '—' : '');
    });
    var all = total(rows);
    totalEl.textContent = all ? 'Gems ≈ ' + all : '';
    btn.textContent = idleLabel;
    btn.disabled = false;
  }
  priceAll.addEventListener('click', function () { priceRows(rows, priceAll, 'Price all gems'); });
  openAllG.addEventListener('click', function () { openRows(rows); });
  return view;
}
