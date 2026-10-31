/* Craft-vs-buy simulator: Monte Carlo over PoE's rare-item mod rolling.
 *
 * Model (what a chaos orb / Screaming+ essence reforge does):
 *   - a fresh rare gets 4, 5 or 6 affixes with weights 8 : 3 : 1
 *   - at most 3 prefixes and 3 suffixes; at most one mod per mod group
 *   - each affix is drawn from the mods that can still roll, weighted by spawn
 *     weight (first spawn tag the base carries wins), limited by item level
 *   - an essence forces its mod first, the rest roll as above
 *   - a fossil resonator rolls the same way with spawn weights scaled by the
 *     fossils' tag multipliers (withFossils / fossilCombos below)
 *   - afterwards ONE bench craft may fill a free affix to supply a missing mod
 * Not modelled: non-weight fossils (Glyphic, Tangled, Sanctified, Hollow, Fractured,
 * Bloodstained, Gilded), harvest, recombinators, metamods, fractured bases,
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

    var pool = buildPool(C, tags, ilvl, contribs, null, null);
    var fams = pool.fams;

    function modInfo(i) {
      var m = C.mods[i];
      return { i: i, affix: m[0], groups: m[1], contribs: contribs(m[4]) };
    }

    // which targets can appear at all, and from where
    var reach = T.map(function () { return { random: false, essence: false, bench: false, fossil: false }; });
    fams.forEach(function (f) { f.tiers.forEach(function (t) { t.contribs.forEach(function (c) { reach[c[0]].random = true; }); }); });
    // fossil-only mods (Faceted's gem levels) that fit this base
    (C.fossils || []).forEach(function (fo) {
      fo[4].forEach(function (mi) {
        var m = C.mods[mi];
        if (m[2] > ilvl || spawnWeight(C.spawn[m[3]], tags) <= 0) return;
        contribs(m[4]).forEach(function (c) { reach[c[0]].fossil = true; });
      });
    });

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

    return { cls: cls, ilvl: ilvl, targets: T, fams: fams, famsByGroup: pool.famsByGroup,
             groupCount: C.groups.length, essences: essences, bench: bench, reach: reach,
             C: C, tags: tags, contribs: contribs };
  }

  /* The random pool grouped into families (one family = one exact group set).
     mult(mod) scales each mod's spawn weight (fossils); extra lists mod indices that
     join the pool on top of the normal random mods (fossil-added mods). */
  function buildPool(C, tags, ilvl, contribs, mult, extra) {
    var famByKey = {}, fams = [];
    function add(m) {
      if (m[2] > ilvl) return;
      var w = spawnWeight(C.spawn[m[3]], tags);
      if (w > 0 && mult) w *= mult(m);
      if (!(w > 0)) return;
      var key = m[0] + ':' + m[1].join(',');
      var f = famByKey[key];
      if (!f) {
        f = famByKey[key] = { affix: m[0], groups: m[1], w: 0, tiers: [] };
        fams.push(f);
      }
      f.w += w;
      f.tiers.push({ w: w, contribs: contribs(m[4]) });
    }
    C.mods.forEach(function (m) { if (m[5] & 1) add(m); });
    (extra || []).forEach(function (mi) { if (!(C.mods[mi][5] & 1)) add(C.mods[mi]); });
    // taking a group blocks every family that contains it
    var famsByGroup = {};
    fams.forEach(function (f, i) {
      f.groups.forEach(function (g) { (famsByGroup[g] = famsByGroup[g] || []).push(i); });
    });
    return { fams: fams, famsByGroup: famsByGroup };
  }

  /* ---- fossils -------------------------------------------------------------------
     A resonator reforge rolls like a chaos orb (4/5/6 affixes at 8:3:1) but each
     mod's spawn weight is scaled by the socketed fossils, matched on the mod's tags
     (RePoE implicit_tags, bundled as a bit mask in mods[i][6]). Fossil weights are
     percentages: 1000 = x10 ("more"), 15 = x0.15 ("fewer"), 0 = blocked ("no").
     Per poewiki ("Fossil"): each fossil affects a mod at most once even when several
     of its tags match — here a matching fewer/no entry wins, else the largest more.
     Across fossils, fewer/no multipliers multiply; "more" multipliers are combined
     per `stack`: 'additive' (sum — CraftOfExile/poeDB default and the more widely
     accepted reading) or 'multiplicative' (product). The community hasn't settled it. */
  var FOSSIL_STACK_DEFAULT = 'additive';

  function fossilMultiplier(mask, fossils, stack) {
    var neg = 1, more = [], i, j;
    for (i = 0; i < fossils.length; i++) {
      var fo = fossils[i], hitNeg = -1, hitPos = -1;
      for (j = 0; j < fo[3].length; j++) {
        if (mask & (1 << fo[3][j][0]) && (hitNeg < 0 || fo[3][j][1] < hitNeg)) hitNeg = fo[3][j][1];
      }
      if (hitNeg >= 0) { neg *= hitNeg / 100; continue; }
      for (j = 0; j < fo[2].length; j++) {
        if (mask & (1 << fo[2][j][0]) && fo[2][j][1] > hitPos) hitPos = fo[2][j][1];
      }
      if (hitPos >= 0) more.push(hitPos / 100);
    }
    if (!neg) return 0;
    var m = 1;
    if (more.length) {
      if (stack === 'multiplicative') more.forEach(function (x) { m *= x; });
      else m = more.reduce(function (s, x) { return s + x; }, 0);
    }
    return m * neg;
  }

  /* A copy of P whose random pool is reweighted by the given fossils (indices into
     C.fossils). Usable with runBatch exactly like P. */
  function withFossils(P, fossilIdx, stack) {
    var C = P.C, fossils = fossilIdx.map(function (i) { return C.fossils[i]; });
    var extra = [];
    fossils.forEach(function (fo) { fo[4].forEach(function (mi) { if (extra.indexOf(mi) === -1) extra.push(mi); }); });
    var pool = buildPool(C, P.tags, P.ilvl, P.contribs, function (m) {
      return fossilMultiplier(m[6] || 0, fossils, stack || FOSSIL_STACK_DEFAULT);
    }, extra);
    var Q = {};
    Object.keys(P).forEach(function (k) { Q[k] = P[k]; });
    Q.fams = pool.fams;
    Q.famsByGroup = pool.famsByGroup;
    Q.fossils = fossilIdx.slice();
    Q.fossilNames = fossils.map(function (fo) { return fo[0]; });
    Q.reach = P.targets.map(function () { return { random: false, essence: false, bench: false, fossil: false }; });
    pool.fams.forEach(function (f) { f.tiers.forEach(function (t) { t.contribs.forEach(function (c) { Q.reach[c[0]].random = true; }); }); });
    return Q;
  }

  /* Rough odds of one reroll hitting every target, from pool shares only: for each
     target, the weight share of tiers that can meet its minimum within its affix
     type, over ~2.2 draws of that type (a 4/5/6-affix item averages 4.4 affixes).
     Only used to rank fossil combos — the simulation gives the real numbers. */
  function roughOdds(Q) {
    var tot = [0, 0], hit = Q.targets.map(function () { return [0, 0]; });
    Q.fams.forEach(function (f) {
      tot[f.affix] += f.w;
      f.tiers.forEach(function (t) {
        t.contribs.forEach(function (c) {
          var tg = Q.targets[c[0]], lo = 0, hi = 0;
          c[1].forEach(function (s) { lo += s[0]; hi += s[1]; });
          lo /= c[1].length; hi /= c[1].length;
          var frac = tg.min === null || lo >= tg.min ? 1 : hi < tg.min ? 0 : (hi - tg.min + 1e-9) / (hi - lo);
          hit[c[0]][f.affix] += t.w * frac;
        });
      });
    });
    var p = 1;
    hit.forEach(function (h) {
      var miss = 1;
      for (var a = 0; a < 2; a++) if (tot[a] > 0) miss *= Math.pow(1 - Math.min(1, h[a] / tot[a]), 2.2);
      p *= 1 - miss;
    });
    return p;
  }

  /* Candidate fossil combos for P: every modelled fossil alone, then 2- and 3-fossil
     combos of the best singles (by rough odds). Returns [{fossils, names, Q, rough}],
     each Q ready for runBatch; combos that can't hit every target are dropped. */
  function fossilCombos(P, opts) {
    opts = opts || {};
    var C = P.C, maxSize = opts.maxSize || 3, keep = opts.keepSingles || 7;
    if (!C.fossils || !C.fossils.length) return [];
    var stack = opts.stack || FOSSIL_STACK_DEFAULT;
    function sig(fams) { // pool fingerprint — a fossil that changes nothing here is skipped
      return fams.length + ':' + fams.reduce(function (s, f) { return s + f.w; }, 0);
    }
    var plain = sig(P.fams), singles = [];
    C.fossils.forEach(function (fo, i) {
      var Q = withFossils(P, [i], stack), r = roughOdds(Q);
      if (r > 0 && sig(Q.fams) !== plain) singles.push({ fossils: [i], names: Q.fossilNames, Q: Q, rough: r });
    });
    singles.sort(function (a, b) { return b.rough - a.rough; });
    var out = singles.slice();
    var top = singles.slice(0, keep).map(function (s) { return s.fossils[0]; });
    function rec(start, cur) {
      if (cur.length >= 2) {
        var Q = withFossils(P, cur, stack), r = roughOdds(Q);
        if (r > 0) out.push({ fossils: cur.slice(), names: Q.fossilNames, Q: Q, rough: r });
      }
      if (cur.length >= maxSize) return;
      for (var i = start; i < top.length; i++) { cur.push(top[i]); rec(i + 1, cur); cur.pop(); }
    }
    rec(0, []);
    return out;
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
    // whole tries: ln(0.1)/ln(1-p) drops below 1 for high odds, but every craft costs ≥ 1 try
    out.tries90 = p >= 1 ? 1 : Math.max(1, Math.ceil(Math.log(0.1) / Math.log(1 - p)));
    out.cost90 = out.baseCost + perTry * out.tries90 + benchPer;
    return out;
  }

  return { prepare: prepare, runBatch: runBatch, summarize: summarize, mulberry32: mulberry32,
           spawnWeight: spawnWeight, AFFIX_COUNTS: AFFIX_COUNTS,
           withFossils: withFossils, fossilCombos: fossilCombos, fossilMultiplier: fossilMultiplier,
           roughOdds: roughOdds, FOSSIL_STACK_DEFAULT: FOSSIL_STACK_DEFAULT };
});
