/* js/app/08-cards.js — pasted items, item cards, art cache.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

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

var INFLUENCE_TONE = { 'Searing Exarch': 'tone-exarch', 'Eater of Worlds': 'tone-eater' };

// bought slots: dimmed, labelled, and out of the build cost total
function setBought(state, on) {
  state.bought = on;
  state.card.classList.toggle('bought', on);
  var chip = state.metaEl && state.metaEl.querySelector('.bought-chip');
  if (on && !chip && state.metaEl) state.metaEl.appendChild(UI.chip('✔ Bought', 'success', 'bought-chip'));
  if (!on && chip) chip.remove();
  renderCostSummary();
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
    '<div class="card-title">' + iconHtml + '<div class="card-id">' +
    '<span class="slot-tag">' + esc(slot) + '</span>' +
    '<span class="item-name ' + rarityClass(item.rarity) + '">' + esc(item.name) + '</span>' +
    '<span class="item-meta">' +
    (item.base && item.base !== item.name ? '<span class="item-base">' + esc(item.base) + '</span>' : '') +
    (item.itemLevel ? '<span>ilvl ' + item.itemLevel + '</span>' : '') +
    item.influences.map(function (inf) {
      return '<span class="badge infl-tag ' + (INFLUENCE_TONE[inf] || 'tone-info') + '">' + esc(inf) + '</span>';
    }).join('') +
    '</span></div></div>';
  var meta = head.querySelector('.item-meta');
  state.metaEl = meta;
  // per-slot gear-set dropdown — only when other sets hold a different item here
  var slotSets = (setIndex !== undefined) ? setsForSlot(slot) : [];
  if (slotSets.length) {
    var setSel = UI.select(slotSets.map(function (o) { return [String(o.setIndex), o.title]; }), String(setIndex), {
      cls: 'set-mini', title: 'Show this slot from a different gear set', ariaLabel: 'Gear set for this slot',
      onChange: function () { swapCardSet(state, slot, parseInt(this.value, 10)); } });
    meta.appendChild(setSel);
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

  // main = the item (mods, actions, filters); side = its listings. They stack, or sit
  // side by side on wide windows once there are listings (css/layout.css)
  var cardMain = UI.el('div', 'card-main');
  var cardSide = UI.el('div', 'card-side');
  card.appendChild(cardMain);
  card.appendChild(cardSide);
  var body = document.createElement('div');
  body.className = 'card-body';
  cardMain.appendChild(body);

  if (item.mods.length) {
    var modHead = document.createElement('div');
    modHead.className = 'mod-head';
    modHead.setAttribute('aria-hidden', 'true'); // each control carries its own label
    modHead.innerHTML = '<span class="mh-use">Use</span><span class="mh-mod">Mod</span>' +
      '<span class="mh-min">Min</span><span class="mh-stat">Trade stat</span>';
    body.appendChild(modHead);
  }
  if (state.unique) {
    var note = document.createElement('div');
    note.className = 'unique-note';
    note.textContent = 'Unique — searched by name. Tick a mod to also require a minimum roll.';
    body.insertBefore(note, body.firstChild);
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

  // header actions: the main action, live watch, the trade site, everything else in ⋯
  var actions = document.createElement('div');
  actions.className = 'card-actions';
  var priceBtn = UI.button('primary', { cls: 'gui-only', label: 'Check price',
    onClick: function () { checkPrice(state); } });
  state.priceBtn = priceBtn;
  var liveBtn = UI.button('secondary', { cls: 'gui-only', label: '🔴 Go live',
    title: 'Watch this search — new listings appear here with a sound (checks ~20s)',
    onClick: function () { toggleLive(state); } });
  state.liveBtn = liveBtn;
  // in the browser (no Check price) this is the main action — CSS promotes it
  var openBtn = UI.button('secondary', { cls: 'act-search', label: 'Search on trade ↗',
    title: 'Open this search on pathofexile.com/trade',
    onClick: function () { var url = buildTradeUrl(state); if (url) openUrl(url); } });
  var isTimeless = state.unique && TIMELESS_TYPES.some(function (t) { return t[1] === state.resolvedName; }) &&
    build && build.tree && build.tree.nodes.length;
  var canCraft = item.rarity === 'RARE' && !/^(Jewel|Flask|Abyssal)/.test(slot);
  var more = UI.menu(function () {
    return [
      { label: 'Copy search URL', onClick: function () {
        var url = buildTradeUrl(state);
        if (url) navigator.clipboard.writeText(url).then(function () { UI.toast('Search URL copied.', 'success'); });
      } },
      { label: '⚒ Craft vs buy', hidden: !canCraft, onClick: function () { openCraft(state); },
        title: 'Estimate what crafting this item would cost (chaos / essence spam + a bench craft) and compare it with buying' },
      { label: '⏳ Find seeds for this socket', hidden: !isTimeless || !isGui(), onClick: function () { openTimelessFor(state); },
        title: 'Open the timeless jewel finder on the socket this jewel sits in' },
      { label: state.bought ? 'Unmark bought' : '✔ Mark bought', onClick: function () { setBought(state, !state.bought); },
        title: 'Bought slots drop out of the build cost total' }
    ];
  }, { ariaLabel: 'More actions for ' + slot });
  [priceBtn, liveBtn, openBtn, more].forEach(function (b) { actions.appendChild(b); });
  head.appendChild(actions);

  var btnWrap = document.createElement('div');
  btnWrap.className = 'card-meta';
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
  cardMain.appendChild(btnWrap);

  // advanced filters fold away; the summary counts what differs from the defaults
  var moreFilters = UI.disclosure('More filters', opts);
  moreFilters.classList.add('card-more');
  var fields = Array.prototype.slice.call(opts.querySelectorAll('select, input'));
  var defaults = fields.map(function (f) { return f.type === 'checkbox' ? f.checked : f.value; });
  function countChanged() {
    moreFilters.setCount(fields.filter(function (f, i) {
      return (f.type === 'checkbox' ? f.checked : f.value) !== defaults[i];
    }).length);
  }
  opts.addEventListener('change', countChanged);
  opts.addEventListener('input', countChanged);
  cardMain.appendChild(moreFilters);

  var liveBox = document.createElement('div');
  liveBox.className = 'price-box live-box hidden';
  cardSide.appendChild(liveBox);
  state.liveBox = liveBox;

  var priceBox = document.createElement('div');
  priceBox.className = 'price-box hidden';
  cardSide.appendChild(priceBox);
  state.priceBox = priceBox;

  var craftBox = document.createElement('div');
  craftBox.className = 'price-box craft-box hidden';
  cardSide.appendChild(craftBox);
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
      if (img.classList.contains('card-icon')) queueSlotRefresh(); // slot list mirrors card art
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
  // mod source is spelled out too, not colour alone
  // PoB writes enchants (anoints, cluster and lab enchants) as crafted implicit lines
  if (mod.crafted) label.appendChild(UI.chip(mod.kind === 'implicit' ? 'enchant' : 'crafted', 'crafted'));
  if (mod.fractured) label.appendChild(UI.chip('fractured', 'fractured'));
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
