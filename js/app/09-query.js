/* js/app/09-query.js — trade query building, cooldown countdowns.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

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
