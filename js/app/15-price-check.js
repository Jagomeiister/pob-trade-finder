/* js/app/15-price-check.js — price checking, listings, trade data refresh.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

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
        line.tabIndex = 0;
        line.setAttribute('role', 'button');
        line.addEventListener('click', function () { cycleSort(state, m.hash, m.text); });
        line.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSort(state, m.hash, m.text); }
        });
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

  // one main action per listing — the way this listing is bought — the rest in ⋯
  // "@CharName Hi, I would like to buy your…" -> character name for /hideout
  var charMatch = li.whisper && li.whisper.match(/^@(\S+)/);
  var gui = isGui();
  function openSearch() { var url = buildTradeUrl(state); if (url) openUrl(url); }
  function copyWhisper() {
    navigator.clipboard.writeText(li.whisper).then(function () { UI.toast('Whisper copied — paste it in game.', 'success'); });
  }
  var main = null, mainKind = null;
  if (instant && state) {
    // Instant buyout: travel to the seller's hideout via the trade site's
    // "Travel to Hideout" (gold fee, seller can be offline).
    main = UI.button('primary', { size: 'sm', label: '⌂ Go to hideout ↗', onClick: openSearch,
      title: 'Opens this search on the trade site — use its "Travel to Hideout" button there (fee ' +
             (li.fee ? li.fee.toLocaleString() + ' gold' : 'applies') + '). Travel needs your logged-in session, so it happens on the site.' });
    mainKind = 'travel';
  } else if (li.whisper && gui) {
    main = UI.button('primary', { size: 'sm', label: '⚡ Whisper', title: 'Pastes the whisper into the PoE chat and sends it',
      onClick: function () { sendPoeChat(main, li.whisper, '⚡ Whisper'); } });
    mainKind = 'whisper';
  } else if (li.whisper) {
    main = UI.button('primary', { size: 'sm', label: 'Copy whisper', onClick: copyWhisper });
    mainKind = 'copy';
  }
  var acts = document.createElement('div');
  acts.className = 'listing-acts';
  if (main) acts.appendChild(main);
  acts.appendChild(UI.menu([
    { label: '☆ Pin to basket', onClick: function () { pinToBasket(li, state); } },
    { label: '⚡ Whisper in game', hidden: !li.whisper || !gui || mainKind === 'whisper',
      onClick: function () { sendPoeChatToast(li.whisper, 'Whisper sent.'); } },
    { label: 'Copy whisper', hidden: !li.whisper || mainKind === 'copy', onClick: copyWhisper },
    // hideout travel only makes sense for priced listings (set price, go get it);
    // unpriced listings are a negotiation — whisper only
    { label: '⌂ /hideout ' + (charMatch ? charMatch[1] : ''), hidden: !gui || !charMatch || !priced,
      title: 'Works once the seller has partied you',
      onClick: function () { sendPoeChatToast('/hideout ' + charMatch[1], 'Sent /hideout.'); } },
    { label: '⌂ Go to hideout ↗', hidden: !instant || !state || mainKind === 'travel', onClick: openSearch }
  ], { size: 'sm', ariaLabel: 'More actions for this listing' }));
  side.appendChild(acts);
  card.appendChild(side);
  return card;
}

// chat commands fired from a menu: no button to relabel, so report with a toast
async function sendPoeChatToast(text, okMsg) {
  if (!isGui()) return;
  try {
    var res = await window.pywebview.api.poe_chat(text);
    if (res && res.ok) UI.toast(okMsg, 'success');
    else UI.toast('Could not send: ' + ((res && res.error) || 'failed'), 'danger');
  } catch (e) {
    UI.toast('Could not send: ' + e.message, 'danger');
  }
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
