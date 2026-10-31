/* js/app/05-craft.js — craft vs buy.
   The js/app/ files are one program split by feature: they load in order (index.html)
   and share their top-level names. */
'use strict';

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
