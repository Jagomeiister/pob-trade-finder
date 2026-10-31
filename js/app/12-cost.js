/* js/app/12-cost.js — sell suggestion, budget solver, build cost + history.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

// ---- selling: suggested list price ------------------------------------------------
// From the first page (the cheapest listings at the card's filters): listings under
// 60% of the page median are bait or price fixers (the 🔥 deal rule), so the
// suggestion matches the cheapest listing that's left.
function sellSuggestion(values) {
  var v = values.slice().sort(function (a, b) { return a - b; });
  if (v.length < 3) return null;
  var median = v[Math.floor(v.length / 2)];
  var real = v.filter(function (x) { return x >= median * 0.6; });
  return { price: real[0], median: median, count: v.length, skipped: v.length - real.length };
}

function renderSellHint(state) {
  var box = state.priceBox, ps = state.priceState, sug = ps.sell;
  var old = box.querySelector('.sell-hint');
  if (old) old.remove();
  var hint = UI.el('div', 'sell-hint');
  if (!sug) {
    hint.appendChild(UI.el('span', 'sell-note', 'Only ' + ps.total + ' listed with these filters, too few to suggest a ' +
      'price. Lower the min roll % to compare with more listings.'));
  } else {
    hint.appendChild(UI.el('span', 'sell-label', 'List at'));
    hint.appendChild(UI.el('b', 'sell-price', '~' + fmtEq(sug.price, ps.league)));
    hint.appendChild(UI.el('span', 'sell-note', 'the cheapest real competitor of ' + ps.total + ' listed. ' +
      'The middle of the cheapest ' + sug.count + ' is ' + fmtEq(sug.median, ps.league) + '.' +
      (sug.skipped ? ' Ignored ' + sug.skipped + ' suspiciously cheap listing' + (sug.skipped > 1 ? 's' : '') + '.' : '')));
  }
  hint.appendChild(UI.button('ghost', { label: 'Open full search ↗', size: 'sm',
    title: 'Open this search on pathofexile.com/trade', onClick: function () { openUrl(tradeUrlFor(ps.league, ps.payloadStr)); } }));
  var head = box.querySelector('.price-head');
  if (head) head.after(hint); else box.insertBefore(hint, box.firstChild);
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
  if (buildDiff) renderBuildDiff();
  var box = document.getElementById('cost-summary');
  if (!box) return;
  var league = document.getElementById('league').value;
  var rows = cards.filter(function (s) { return s.cheapestChaos !== undefined && !s.bought; });
  if (!rows.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  box.appendChild(UI.sectionHeader('Build cost — cheapest listing per checked slot', [copyButton('📋 Copy', function () {
    var lines = ['Build cost (' + league + ') — cheapest listing per slot'];
    var t = 0;
    rows.forEach(function (s) { t += s.cheapestChaos; lines.push(s.slot + ': ' + (s.item.name || s.item.base || '') + ' — ' + fmtEq(s.cheapestChaos, league)); });
    lines.push('TOTAL: ' + fmtEq(t, league) + ' for ' + rows.length + ' slot(s)');
    return lines.join('\n');
  })]));
  var total = 0;
  rows.forEach(function (s) { total += s.cheapestChaos; });
  box.appendChild(UI.table([
    { key: 'slot', label: 'Slot', render: function (s) { return s.slot; }, sort: function (s) { return s.slot; } },
    { key: 'item', label: 'Item', render: function (s) { return slotLink(s); }, sort: function (s) { return s.item.name || ''; } },
    { key: 'price', label: 'Cheapest', num: true, render: function (s) { return fmtEq(s.cheapestChaos, league); },
      sort: function (s) { return s.cheapestChaos; } }
  ], rows, { sortable: true }));
  var dr = divRate(league);
  var secondary = eqMode() === 'divine'
    ? '  (' + fmtChaos(total) + ')'
    : (dr ? '  (' + (Math.round(total / dr * 10) / 10) + ' div)' : '');
  var totalRow = document.createElement('div');
  totalRow.className = 'cost-total';
  totalRow.innerHTML = '<span>Total · ' + rows.length + ' slot(s) priced</span><span class="cost-amt">' +
    fmtEq(total, league) + esc(secondary) + '</span>';
  box.appendChild(totalRow);
  var trend = buildCostTrend(recordBuildCost(rows, league), league);
  renderBuildCostCard(trend, league);
  if (trend && trend.points.length > 1) box.appendChild(costTrendPanel(trend, league));
  renderSolver(box, league);
}

// ---- build cost history ------------------------------------------------------------
// pobtf-costhist: { buildKey: { _ts, snaps: [{ ts, league, slots: {slotKey: chaos}}] } }.
// One snapshot per pricing session (checks less than an hour apart refine the same
// one). Sessions are compared on the slots priced now, so pricing more or fewer slots
// never looks like a price change.
var COST_SESSION_MS = 3600 * 1000, COST_SNAPS = 60, COST_BUILDS = 30;
function loadCostHist() {
  try { var h = JSON.parse(localStorage.getItem('pobtf-costhist')); if (h && typeof h === 'object') return h; }
  catch (e) { /* none yet */ }
  return {};
}

function recordBuildCost(rows, league) {
  if (!build) return null;
  var slots = {}, n = 0;
  rows.forEach(function (s) {
    if (s === pastedState) return; // a pasted item isn't part of the build
    slots[slotKey(s)] = Math.round(s.cheapestChaos * 10) / 10;
    n++;
  });
  return storeCostSnapshot(buildKey(), league, slots);
}

// add a pricing session's {slotKey: chaos} to a build's cost history (merging into the
// last snapshot when it's the same session); returns that build's history
function storeCostSnapshot(bk, league, slots) {
  var all = loadCostHist();
  var h = all[bk] = all[bk] || { snaps: [] };
  if (!Object.keys(slots).length) return h;
  var now = Date.now(), last = h.snaps[h.snaps.length - 1];
  if (last && last.league === league && now - last.ts < COST_SESSION_MS) {
    if (JSON.stringify(last.slots) === JSON.stringify(slots)) return h; // nothing new to store
    last.slots = slots;
    last.ts = now;
  } else {
    h.snaps.push({ ts: now, league: league, slots: slots });
    h.snaps = h.snaps.slice(-COST_SNAPS);
  }
  h._ts = now;
  var keys = Object.keys(all).sort(function (a, b) { return (all[b]._ts || 0) - (all[a]._ts || 0); });
  keys.slice(COST_BUILDS).forEach(function (k) { delete all[k]; });
  try { persist('pobtf-costhist', JSON.stringify(all)); } catch (e) { /* storage full */ }
  return h;
}

// the latest snapshot's slots, summed in every earlier session (same league) that
// priced all of them
function buildCostTrend(h, league) {
  if (!h || !h.snaps.length) return null;
  var cur = h.snaps[h.snaps.length - 1];
  if (cur.league !== league) return null;
  var keys = Object.keys(cur.slots);
  var points = [];
  h.snaps.forEach(function (s) {
    if (s.league !== league) return;
    var sum = 0;
    for (var i = 0; i < keys.length; i++) {
      if (s.slots[keys[i]] === undefined) return;
      sum += s.slots[keys[i]];
    }
    points.push({ t: Math.round(s.ts / 1000), v: sum });
  });
  var now = points[points.length - 1], prev = points.length > 1 ? points[points.length - 2] : null;
  return { points: points, now: now.v, slots: keys.length, prev: prev,
           change: prev && prev.v ? (now.v - prev.v) / prev.v : null };
}

function fmtShortDate(t) {
  return new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// the planner is often hidden while prices come in (width 0): assume its usual width
function costChartWidth() {
  var cw = document.getElementById('cost-summary').clientWidth;
  return cw > 360 ? cw - 40 : 720;
}

function costTrendPanel(trend, league) {
  var wrap = UI.el('div', 'cost-trend');
  var line = UI.el('div', 'cost-trend-line');
  line.appendChild(UI.el('span', null, 'Since your last check (' + fmtShortDate(trend.prev.t) + ', was ' +
    fmtEq(trend.prev.v, league) + ') '));
  line.appendChild(pctChip(trend.change, true));
  line.appendChild(UI.el('span', 'finder-sub', ' · same ' + trend.slots + ' slot' + (trend.slots > 1 ? 's' : '') +
    ', cheapest listing each'));
  wrap.appendChild(line);
  wrap.appendChild(priceChart(trend.points.map(function (p) {
    return { t: p.t, v: p.v, sub: fmtEq(p.v, league) };
  }), { w: costChartWidth(), h: 150,
        label: 'Build cost over time in chaos' }));
  return wrap;
}

// sidebar build card: total + change since the last session
function renderBuildCostCard(trend, league) {
  var el = document.getElementById('build-cost');
  if (!el) return;
  el.textContent = '';
  if (!trend) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.appendChild(UI.el('span', null, 'Cost ' + fmtEq(trend.now, league) + ' '));
  if (trend.change !== null) {
    el.appendChild(pctChip(trend.change, true));
    el.title = 'Cheapest listings for the ' + trend.slots + ' priced slots, vs. ' + fmtShortDate(trend.prev.t);
  } else {
    el.title = 'Cheapest listings for the ' + trend.slots + ' priced slots';
  }
}
