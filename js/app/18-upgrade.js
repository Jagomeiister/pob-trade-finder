/* js/app/18-upgrade.js — "is this an upgrade?" for pasted and Ctrl+D items.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- upgrade check -----------------------------------------------------------------------
// A pasted / Ctrl+D item is compared with your build's item for that slot (both rings for a
// ring) and, when your character is imported, with what you're wearing. Each of the
// reference item's stats is worth 100% at its roll, the same scale as "% of your item" on
// listings; more of a stat counts (capped at 300% each so one huge roll can't carry it).
// A stat comparison, not a Path of Building DPS/EHP calculation.
var UPGRADE_SLOTS = { 'Ring 1': ['Ring 1', 'Ring 2'], 'Ring 2': ['Ring 1', 'Ring 2'] };
var UPGRADE_AT = 105, SIDEGRADE_AT = 95;
var upgradeBuild = null;       // the overlay decodes the saved build itself (it never renders one)
var upgradeBuildLoading = null;

function modsOfItem(item) {
  return (item.mods || []).map(function (m) {
    return { line: m.line, kind: m.kind, crafted: m.crafted, fractured: m.fractured };
  });
}

// bridge-shaped items (character import): mod arrays by kind, strings or {description}
function modsOfEquipped(it) {
  var out = [];
  [['implicitMods', 'implicit'], ['enchantMods', 'implicit'], ['explicitMods', 'explicit'],
   ['craftedMods', 'explicit'], ['fracturedMods', 'explicit']].forEach(function (pair) {
    (it[pair[0]] || []).forEach(function (raw) {
      var line = typeof raw === 'string' ? raw : (raw && raw.description) || '';
      if (line) out.push({ line: line, kind: pair[1], crafted: pair[0] === 'craftedMods', fractured: pair[0] === 'fracturedMods' });
    });
  });
  return out;
}

// {key: {v, label}} — pseudo totals when Pseudo totals is on (life from every source, dual
// res ×2…), otherwise the stat itself whatever section it rolled in
function statTotals(mods, slot) {
  var pseudoOn = document.getElementById('pseudo').checked;
  var out = {};
  mods.forEach(function (mod) {
    var m = Matcher.matchMod(statIndex, mod, slot);
    if (!m || m.avg === null || m.avg === undefined || m.fixedText) return;
    var key, val, label;
    if (pseudoOn && m.pseudo) {
      key = m.pseudo.entry.id; val = m.avg * m.pseudo.multiplier; label = m.pseudo.entry.text;
    } else {
      key = 'stat:' + m.entry.id.split('.').pop().split('|')[0]; val = m.avg; label = m.entry.text;
    }
    var o = out[key] || (out[key] = { v: 0, label: label });
    o.v += val;
  });
  return out;
}

function compareStats(ref, cand) {
  var keys = Object.keys(ref).filter(function (k) { return ref[k].v > 0; });
  if (!keys.length) return null;
  var pct = 0, deltas = [];
  keys.forEach(function (k) {
    var c = cand[k] ? cand[k].v : 0;
    pct += Math.min(c / ref[k].v, 3) * 100;
    deltas.push({ label: ref[k].label, d: c - ref[k].v, missing: !cand[k] });
  });
  Object.keys(cand).forEach(function (k) {
    if (!ref[k] && cand[k].v > 0) deltas.push({ label: cand[k].label, d: cand[k].v, extra: true });
  });
  return { pct: pct / keys.length, deltas: deltas, stats: keys.length };
}

function upgradeVerdict(pct) {
  return pct >= UPGRADE_AT ? ['Upgrade', 'success'] : pct >= SIDEGRADE_AT ? ['Sidegrade', 'warn'] : ['Downgrade', 'danger'];
}

// "+# total maximum Life" with +18 -> "+18 total maximum Life"; "#% increased X" -> "−5% increased X"
function deltaText(label, d) {
  var n = Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.round(Math.abs(d) * 10) / 10;
  var sign = d >= 0 ? '+' : '−';
  label = statWords(label);
  if (/^[+-]?#/.test(label)) return label.replace(/^[+-]?#/, sign + n);
  return sign + ' ' + label.replace('#', n);
}

// pseudo labels read "+# total to Fire Resistance": drop "total (to)" for a plain stat name
function statWords(label) { return label.replace(/\btotal (to )?/i, '').replace(/\s+/g, ' ').trim(); }
function missingText(label) { return 'missing ' + statWords(label).replace(/^[+-]?#%?\s*/, '').replace(/# to # /, ''); }

function upgradeSource() {
  if (build) return build;
  if (upgradeBuild) return upgradeBuild;
  if (!upgradeBuildLoading) {
    var code = (loadSettings().lastCode || '').trim();
    if (!code || /^https?:/i.test(code) || (PoB.looksLikeGameItem && PoB.looksLikeGameItem(code))) return null;
    upgradeBuildLoading = PoB.decodePobCode(code).then(function (xml) {
      upgradeBuild = PoB.parseBuild(xml);
      if (pastedState) renderUpgradeCheck(pastedState);
    }, function () { /* no usable saved build */ });
  }
  return null;
}

function buildItemFor(b, slot) {
  var sets = b.itemSets || [];
  var set = sets[b.activeSetIndex || 0] || { slots: b.slots || [] };
  var entry = (set.slots || []).find(function (x) { return x.slot === slot; });
  return entry && b.items[entry.itemId] ? b.items[entry.itemId] : null;
}

function savedCharGear() {
  if (charGear) return charGear;
  try { var g = JSON.parse(localStorage.getItem('pobtf-chargear')); return g && g.gear ? g.gear : null; }
  catch (e) { return null; }
}

// rows of [label, reference name, comparison | note] for the pasted item's slot
function upgradeRows(item, slot) {
  var slots = UPGRADE_SLOTS[slot] || [slot];
  var cand = statTotals(modsOfItem(item), slot);
  var isUnique = item.rarity === 'UNIQUE' || item.rarity === 'RELIC';
  var rows = [];
  function add(who, s, refItem, refMods, name, refUnique) {
    if (!refItem) return;
    if ((isUnique || refUnique) && (resolveUniqueName(item.name) || item.name) !== (resolveUniqueName(name) || name)) {
      rows.push({ who: who, slot: s, name: name, note: 'a different item' + (refUnique ? ' (unique)' : '') });
      return;
    }
    var cmp = compareStats(statTotals(refMods, s), cand);
    rows.push({ who: who, slot: s, name: name, cmp: cmp, note: cmp ? null : 'no comparable stats' });
  }
  var b = upgradeSource();
  slots.forEach(function (s) {
    var bi = b && buildItemFor(b, s);
    if (bi) add('Your build', s, bi, modsOfItem(bi), bi.name || bi.base, bi.rarity === 'UNIQUE' || bi.rarity === 'RELIC');
  });
  var gear = savedCharGear();
  slots.forEach(function (s) {
    var eq = gear && gear[s];
    if (eq) add('You wear', s, eq, modsOfEquipped(eq), eq.name || eq.base || eq.typeLine, eq.frameType === 3);
  });
  return rows;
}

// ---- quick price: no trade-site call ------------------------------------------------------
// Exchange items (currency, fragments, scarabs, cards…) from GGG's hourly feed; uniques and
// gems from poe.ninja through the app's backend (Api.quick_price). Shown above the card
// straight away; the trade search below stays the authority.
async function renderQuickPrice(state) {
  if (!state || !state.card || !isGui() || !window.pywebview.api.quick_price) return;
  var it = state.item;
  var league = document.getElementById('league').value;
  var r;
  try {
    r = await window.pywebview.api.quick_price(league, JSON.stringify({ name: it.name, base: it.base, rarity: it.rarity,
      itemClass: it.itemClass, stackSize: it.stackSize, gemLevel: it.gemLevel, quality: it.quality,
      corrupted: it.corrupted, links: it.maxLinks }));
  } catch (e) { return; }
  if (state !== pastedState || !r || !r.ok || r.chaos == null) return;
  var old = state.card.querySelector('.quick-price');
  if (old) old.remove();
  var box = UI.el('div', 'quick-price');
  box.appendChild(UI.el('span', 'qp-label', 'Quick price'));
  box.appendChild(UI.el('b', 'qp-value', '≈ ' + fmtEq(r.chaos, league) +
    (r.divine && eqMode() !== 'divine' && r.divine >= 0.1 ? ' · ' + fmtCompact(r.divine) + ' div' : '')));
  if (r.stack) box.appendChild(UI.el('span', null, 'each · your stack of ' + r.stack + ' ≈ ' + fmtEq(r.stackChaos, league)));
  var src = UI.el('span', 'qp-src', r.source + (r.listings != null ? ', ' + r.listings + ' listed' : ''));
  src.title = r.source === 'poe.ninja'
    ? 'poe.ninja\'s estimate from public stash listings (refreshed about every 30 min). Thin or price-fixed items can be off.'
    : 'Average traded price on GGG\'s currency exchange in the last hour';
  box.appendChild(src);
  if (r.code && window.pywebview.api.bulk_exchange) {
    box.appendChild(UI.button('ghost', { size: 'sm', label: 'Live offers',
      title: 'Ask the trade site\'s bulk exchange who sells this right now (one request)',
      onClick: function () { renderBulkOffers(state, box, r.code, league); } }));
  }
  var main = state.card.querySelector('.card-main');
  if (main) main.insertBefore(box, main.firstChild); else state.card.appendChild(box);
}

function exchangeUrlFor(league, code) {
  return 'https://www.pathofexile.com/trade/exchange/' + encodeURIComponent(league) + '?q=' +
    encodeURIComponent(JSON.stringify({ exchange: { status: { option: 'online' }, want: [code], have: ['chaos', 'divine'] } }));
}

// One bulk-exchange request per press; nothing repeats on its own.
async function renderBulkOffers(state, box, code, league) {
  var old = box.parentNode && box.parentNode.querySelector('.qp-offers');
  if (old) old.remove();
  var wrap = UI.el('div', 'qp-offers');
  wrap.appendChild(UI.el('span', 'finder-sub', 'Asking the bulk exchange…'));
  box.insertAdjacentElement('afterend', wrap);
  var r;
  try { r = await window.pywebview.api.bulk_exchange(league, code); }
  catch (e) { r = { ok: false, error: String(e) }; }
  if (state !== pastedState) return;
  wrap.textContent = '';
  if (!r || !r.ok) {
    wrap.appendChild(UI.el('span', 'finder-sub', isCooldownError(r && r.error)
      ? 'Trade site cooldown, try again in a minute.' : 'Couldn\'t load offers: ' + ((r && r.error) || 'no answer')));
    return;
  }
  if (!r.offers.length) wrap.appendChild(UI.el('span', 'finder-sub', 'Nobody online is selling this for chaos or divines.'));
  r.offers.slice(0, 8).forEach(function (o) {
    var row = UI.el('div', 'qp-offer');
    row.appendChild(UI.el('span', 'seller-dot ' + (o.afk ? 'away' : o.online ? 'on' : 'off'), o.afk ? '◐' : o.online ? '●' : '○'));
    row.appendChild(UI.el('span', 'qp-offer-who', o.seller));
    row.appendChild(UI.el('span', null, fmtCompact(o.pay) + ' ' + o.payCurrency + ' → ' + fmtCompact(o.get)));
    row.appendChild(UI.el('b', null, o.chaosEach != null ? fmtCompact(o.chaosEach) + 'c each' : ''));
    if (o.stock != null) row.appendChild(UI.el('span', 'finder-sub', 'stock ' + o.stock));
    wrap.appendChild(row);
  });
  wrap.appendChild(UI.button('ghost', { size: 'sm', label: 'Open on trade site ↗',
    onClick: function () { openUrl(exchangeUrlFor(league, code)); } }));
}

function renderUpgradeCheck(state) {
  if (!state || !state.card) return;
  var old = state.card.querySelector('.upgrade-check');
  if (old) old.remove();
  var slot = state.item.slotGuess;
  if (!slot || /^(Flask|Jewel)/.test(slot)) return; // no single slot to compare with
  var rows = upgradeRows(state.item, slot);
  var box = UI.el('div', 'upgrade-check');
  if (!rows.length) {
    box.appendChild(UI.el('span', 'finder-sub', (build || upgradeBuild)
      ? 'Your build has nothing in ' + slot + ' to compare with.'
      : 'Load a build (or import your character) to see whether this is an upgrade.'));
  }
  rows.forEach(function (r) {
    var row = UI.el('div', 'upgrade-row');
    row.appendChild(UI.el('span', 'upgrade-who', r.who + (r.slot !== slot || UPGRADE_SLOTS[slot] ? ' · ' + r.slot : '')));
    row.appendChild(UI.el('span', 'upgrade-name', r.name || ''));
    if (r.cmp) {
      var v = upgradeVerdict(r.cmp.pct);
      row.appendChild(UI.chip(v[0] + ' · ' + Math.round(r.cmp.pct) + '%', v[1]));
      var parts = r.cmp.deltas.filter(function (x) { return x.missing || x.extra || Math.abs(x.d) >= 0.5; })
        .sort(function (a, b2) { return (a.missing ? 0 : 1) - (b2.missing ? 0 : 1) || Math.abs(b2.d) - Math.abs(a.d); })
        .slice(0, 6).map(function (x) {
          return x.missing ? missingText(x.label) : deltaText(x.label, x.d) + (x.extra ? ' (new)' : '');
        });
      if (parts.length) row.appendChild(UI.el('span', 'upgrade-deltas', parts.join(' · ')));
      row.title = 'Each of that item\'s ' + r.cmp.stats + ' stats is worth 100% at its roll; ' +
        UPGRADE_AT + '%+ = upgrade, under ' + SIDEGRADE_AT + '% = downgrade. Stats only, not a DPS calculation.';
    } else {
      row.appendChild(UI.el('span', 'finder-sub', r.note));
    }
    box.appendChild(row);
  });
  var main = state.card.querySelector('.card-main');
  if (main) main.insertBefore(box, main.firstChild); else state.card.appendChild(box);
}
