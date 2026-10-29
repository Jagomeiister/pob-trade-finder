/* Craft-vs-buy simulator: Monte Carlo over PoE's rare-item mod rolling.
 *
 * Model (what a chaos orb / Screaming+ essence reforge does):
 *   - a fresh rare gets 4, 5 or 6 affixes with weights 8 : 3 : 1
 *   - at most 3 prefixes and 3 suffixes; at most one mod per mod group
 *   - each affix is drawn from the mods that can still roll, weighted by spawn
 *     weight (first spawn tag the base carries wins), limited by item level
 *   - an essence forces its mod first, the rest roll as above
 *   - afterwards ONE bench craft may fill a free affix to supply a missing mod
 * Not modelled: fossils, harvest, recombinators, metamods, fractured bases,
 * alt-regal, eldritch implicits. The UI says so.
 *
 * Draws are made over mod "families" (all tiers sharing one group set) so a
 * trial costs ~60 weight checks per affix instead of ~250.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Craft = factory();
})(this, function () {
  'use strict';

  var AFFIX_COUNTS = [[4, 8], [5, 3], [6, 1]];
  var INFLUENCE_TAG = { Shaper: 'shaper', Elder: 'elder', Crusader: 'crusader',
                        Redeemer: 'eyrie', Hunter: 'basilisk', Warlord: 'adjudicator' };

  function spawnWeight(list, tags) {
    for (var i = 0; i < list.length; i++) if (tags[list[i][0]]) return list[i][1];
    return 0;
  }

  // rolled trade value of one stat line: mean of its slots ("Adds 10 to 20" -> 15)
  function rollValue(slots, rng) {
    var sum = 0;
    for (var i = 0; i < slots.length; i++) {
      var lo = slots[i][0], hi = slots[i][1];
      sum += (lo === Math.floor(lo) && hi === Math.floor(hi))
        ? lo + Math.floor(rng() * (hi - lo + 1))
        : lo + rng() * (hi - lo);
    }
    return sum / slots.length;
  }

  /* Everything a simulation needs for one base + targets.
     targets: [{tail, min}] — min null means "just has the stat". */
  function prepare(C, baseName, influences, ilvl, targets) {
    var base = C.bases[baseName];
    if (!base) return { error: 'unknown base "' + baseName + '"' };
    var cls = base[0], tags = {};
    base[1].forEach(function (t) { tags[t] = 1; });
    (influences || []).forEach(function (inf) {
      if (INFLUENCE_TAG[inf] && base[2]) tags[base[2] + '_' + INFLUENCE_TAG[inf]] = 1;
    });

    // merge duplicate targets (same stat twice) keeping the stricter minimum
    var tIndex = {}, T = [];
    targets.forEach(function (t) {
      if (t.tail in tIndex) {
        var cur = T[tIndex[t.tail]];
        if (t.min !== null && (cur.min === null || t.min > cur.min)) cur.min = t.min;
      } else {
        tIndex[t.tail] = T.length;
        T.push({ tail: t.tail, min: t.min });
      }
    });

    function contribs(stats) {
      var out = [];
      stats.forEach(function (s) { if (s[0] in tIndex) out.push([tIndex[s[0]], s[1]]); });
      return out;
    }

    // random pool grouped into families (one family = one exact group set)
    var famByKey = {}, fams = [];
    C.mods.forEach(function (m) {
      if (!(m[5] & 1) || m[2] > ilvl) return;
      var w = spawnWeight(C.spawn[m[3]], tags);
      if (w <= 0) return;
      var key = m[0] + ':' + m[1].join(',');
      var f = famByKey[key];
      if (!f) {
        f = famByKey[key] = { affix: m[0], groups: m[1], w: 0, tiers: [] };
        fams.push(f);
      }
      f.w += w;
      f.tiers.push({ w: w, contribs: contribs(m[4]) });
    });
    // taking a group blocks every family that contains it
    var famsByGroup = {};
    fams.forEach(function (f, i) {
      f.groups.forEach(function (g) { (famsByGroup[g] = famsByGroup[g] || []).push(i); });
    });

    function modInfo(i) {
      var m = C.mods[i];
      return { i: i, affix: m[0], groups: m[1], contribs: contribs(m[4]) };
    }

    // which targets can appear at all, and from where
    var reach = T.map(function () { return { random: false, essence: false, bench: false }; });
    fams.forEach(function (f) { f.tiers.forEach(function (t) { t.contribs.forEach(function (c) { reach[c[0]].random = true; }); }); });

    var essences = [];
    C.essences.forEach(function (e) {
      var mi = e[3][cls];
      if (mi === undefined) return;
      var info = modInfo(mi);
      if (!info.contribs.length) return; // forces a mod we don't need
      info.contribs.forEach(function (c) { reach[c[0]].essence = true; });
      essences.push({ name: e[0], code: e[1], level: e[2], mod: info });
    });

    var bench = [];
    Object.keys(C.bench).forEach(function (k) {
      var info = modInfo(+k);
      if (!info.contribs.length) return;
      C.bench[k].forEach(function (opt) {
        if (opt[1].indexOf(cls) === -1) return;
        info.contribs.forEach(function (c) { reach[c[0]].bench = true; });
        bench.push({ mod: info, cost: opt[0] });
      });
    });

    return { cls: cls, ilvl: ilvl, targets: T, fams: fams, famsByGroup: famsByGroup,
             groupCount: C.groups.length, essences: essences, bench: bench, reach: reach };
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* One batch of trials. state accumulates across batches:
     { n, s, benchUses: {idx: count} }.
     opts: { forced: modInfo|null, bench: [{mod, costChaos}] sorted cheapest first,
             allowMissing, rng } */
  function runBatch(P, opts, trials, state) {
    var rng = opts.rng || Math.random;
    var fams = P.fams, F = fams.length, T = P.targets, nT = T.length;
    var blocked = new Int32Array(F), groupTaken = new Int32Array(P.groupCount + 1);
    var acc = new Float64Array(nT), present = new Uint8Array(nT);
    var stamp = state.stamp || 0;
    var forced = opts.forced, bench = opts.bench || [], allowMissing = opts.allowMissing || 0;

    function apply(contribs) {
      for (var c = 0; c < contribs.length; c++) {
        acc[contribs[c][0]] += rollValue(contribs[c][1], rng);
        present[contribs[c][0]] = 1;
      }
    }
    function takeGroups(groups) {
      for (var g = 0; g < groups.length; g++) {
        groupTaken[groups[g]] = stamp;
        var fl = P.famsByGroup[groups[g]];
        if (fl) for (var j = 0; j < fl.length; j++) blocked[fl[j]] = stamp;
      }
    }
    function missingCount() {
      var miss = 0;
      for (var t = 0; t < nT; t++) {
        if (!present[t] || (T[t].min !== null && acc[t] < T[t].min - 1e-9)) miss++;
      }
      return miss;
    }

    for (var trial = 0; trial < trials; trial++) {
      stamp++;
      acc.fill(0); present.fill(0);
      var counts = [0, 0];
      var r = rng() * 12, k = r < 8 ? 4 : r < 11 ? 5 : 6;
      if (forced) {
        counts[forced.affix]++;
        takeGroups(forced.groups);
        apply(forced.contribs);
        k--;
      }
      for (var d = 0; d < k; d++) {
        var total = 0;
        for (var f = 0; f < F; f++) {
          if (blocked[f] !== stamp && counts[fams[f].affix] < 3) total += fams[f].w;
        }
        if (total <= 0) break;
        var pick = rng() * total, chosen = -1;
        for (f = 0; f < F; f++) {
          if (blocked[f] === stamp || counts[fams[f].affix] >= 3) continue;
          pick -= fams[f].w;
          if (pick < 0) { chosen = f; break; }
        }
        if (chosen < 0) chosen = F - 1;
        var fam = fams[chosen];
        var tp = rng() * fam.w, tier = fam.tiers[fam.tiers.length - 1];
        for (var ti = 0; ti < fam.tiers.length; ti++) {
          tp -= fam.tiers[ti].w;
          if (tp < 0) { tier = fam.tiers[ti]; break; }
        }
        counts[fam.affix]++;
        takeGroups(fam.groups);
        apply(tier.contribs);
      }

      var miss = missingCount();
      if (miss <= allowMissing) { state.s++; state.n++; continue; }
      // one bench craft into a free affix, cheapest option that finishes the item
      for (var b = 0; b < bench.length; b++) {
        var bm = bench[b].mod;
        if (counts[bm.affix] >= 3) continue;
        var clash = false;
        for (var g = 0; g < bm.groups.length; g++) if (groupTaken[bm.groups[g]] === stamp) { clash = true; break; }
        if (clash) continue;
        var saveAcc = Array.prototype.slice.call(acc), savePres = Array.prototype.slice.call(present);
        apply(bm.contribs);
        if (missingCount() <= allowMissing) {
          state.s++;
          state.benchUses[b] = (state.benchUses[b] || 0) + 1;
          break;
        }
        acc.set(saveAcc); present.set(savePres);
      }
      state.n++;
    }
    state.stamp = stamp;
    return state;
  }

  /* Summarise a finished simulation into costs (all chaos).
     perTry: cost of one reroll; bench: the same list passed to runBatch. */
  function summarize(state, perTry, bench, baseCost) {
    var p = state.n ? state.s / state.n : 0;
    var benchSpend = 0;
    Object.keys(state.benchUses).forEach(function (b) { benchSpend += state.benchUses[b] * bench[b].costChaos; });
    var benchPer = state.s ? benchSpend / state.s : 0;
    var out = { trials: state.n, successes: state.s, p: p, perTry: perTry, benchPer: benchPer,
                baseCost: baseCost || 0 };
    if (!p) {
      out.pUpper = 3 / state.n; // ~95% bound with zero successes
      return out;
    }
    out.tries = 1 / p;
    out.expected = out.baseCost + perTry / p + benchPer;
    // unlucky case: tries needed for a 90% chance of having succeeded
    out.tries90 = p >= 1 ? 1 : Math.log(0.1) / Math.log(1 - p);
    out.cost90 = out.baseCost + perTry * out.tries90 + benchPer;
    return out;
  }

  return { prepare: prepare, runBatch: runBatch, summarize: summarize, mulberry32: mulberry32,
           spawnWeight: spawnWeight, AFFIX_COUNTS: AFFIX_COUNTS };
});
