// Craft simulator tests — run: node test/test_craft.js
// The sampler is checked against an exact enumeration of the same rolling model.
const Craft = require('../js/craft.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

// synthetic data: 5 prefixes + 5 suffixes, one group each, unequal weights
const W = [4000, 2000, 1000, 1000, 500];
function makeData(extra) {
  const C = { spawn: [], groups: [], mods: [], essences: [], bench: {},
              bases: { 'Test Ring': ['Ring', ['ring', 'default'], 'ring'] } };
  for (let a = 0; a < 2; a++) {
    W.forEach((w, i) => {
      C.spawn.push([['default', w]]);
      C.groups.push((a ? 'S' : 'P') + i);
      C.mods.push([a, [C.groups.length - 1], 1, C.spawn.length - 1,
                   [['stat_' + (a ? 'S' : 'P') + i, [[10, 20]]]], 1]);
    });
  }
  if (extra) extra(C);
  return C;
}

// exact probability that the chosen families satisfy pred(chosenSet)
function exact(C, pred, forcedIdx) {
  const fams = C.mods.map((m, i) => ({ i, affix: m[0], w: C.spawn[m[3]][0][1] })).filter(f => C.mods[f.i][5] & 1);
  function rec(chosen, counts, left) {
    if (left === 0) return pred(chosen) ? 1 : 0;
    const elig = fams.filter(f => !chosen.includes(f.i) && counts[f.affix] < 3);
    const total = elig.reduce((s, f) => s + f.w, 0);
    if (!total) return pred(chosen) ? 1 : 0;
    let p = 0;
    for (const f of elig) {
      const c2 = counts.slice(); c2[f.affix]++;
      p += f.w / total * rec(chosen.concat([f.i]), c2, left - 1);
    }
    return p;
  }
  let p = 0;
  for (const [k, w] of Craft.AFFIX_COUNTS) {
    const counts = [0, 0], chosen = [];
    if (forcedIdx !== undefined) { counts[C.mods[forcedIdx][0]]++; chosen.push(forcedIdx); }
    p += w / 12 * rec(chosen, counts, forcedIdx !== undefined ? k - 1 : k);
  }
  return p;
}

function simulate(P, opts, n, seed) {
  const state = { n: 0, s: 0, benchUses: {} };
  Craft.runBatch(P, Object.assign({ rng: Craft.mulberry32(seed || 1) }, opts), n, state);
  return state;
}
function within(pHat, p, n) { // 4 standard errors
  const se = Math.sqrt(p * (1 - p) / n);
  return Math.abs(pHat - p) <= 4 * se + 1e-9;
}

// 1) single target, presence only: a low-weight prefix
{
  const C = makeData();
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P4', min: null }]);
  const want = exact(C, ch => ch.includes(4));
  const st = simulate(P, {}, 200000);
  check('single low-weight prefix matches exact', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
}

// 2) two targets across prefix + suffix
{
  const C = makeData();
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P1', min: null }, { tail: 'stat_S3', min: null }]);
  const want = exact(C, ch => ch.includes(1) && ch.includes(8));
  const st = simulate(P, {}, 200000, 7);
  check('prefix + suffix pair matches exact', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
}

// 3) roll threshold: min 15 on a 10-20 integer roll => 6/11 of hits qualify
{
  const C = makeData();
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P0', min: 15 }]);
  const want = exact(C, ch => ch.includes(0)) * 6 / 11;
  const st = simulate(P, {}, 200000, 3);
  check('roll threshold scales probability', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
}

// 4) essence forces its mod first
{
  const C = makeData(C => {
    C.spawn.push([['default', 0]]);
    C.groups.push('EssLife');
    C.mods.push([0, [C.groups.length - 1], 1, C.spawn.length - 1, [['stat_E', [[50, 50]]]], 2]);
    C.essences.push(['Test Essence', 'test-essence', 7, { Ring: C.mods.length - 1 }]);
  });
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_E', min: null }, { tail: 'stat_S0', min: null }]);
  check('essence is offered for its target', P.essences.length === 1);
  const want = exact(C, ch => ch.includes(5), C.mods.length - 1);
  const st = simulate(P, { forced: P.essences[0].mod }, 200000, 11);
  check('essence-forced roll matches exact', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
}

// 5) bench craft fills a missing suffix when one is free
{
  const C = makeData(C => {
    C.spawn.push([['default', 0]]);
    C.groups.push('BenchRes');
    C.mods.push([1, [C.groups.length - 1], 1, C.spawn.length - 1, [['stat_B', [[30, 30]]]], 4]);
    C.bench[C.mods.length - 1] = [[{ chaos: 4 }, ['Ring']]];
  });
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P0', min: null }, { tail: 'stat_B', min: null }]);
  check('bench recipe found for the class', P.bench.length === 1 && P.reach[1].bench && !P.reach[1].random);
  // success = P0 rolled AND a suffix slot free (fewer than 3 suffixes)
  const want = exact(C, ch => ch.includes(0) && ch.filter(i => i >= 5).length < 3);
  const st = simulate(P, { bench: [{ mod: P.bench[0].mod, costChaos: 4 }] }, 200000, 5);
  check('bench finish matches exact', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
  const sum = Craft.summarize(st, 1, [{ costChaos: 4 }], 10);
  check('summary adds bench + base cost', Math.abs(sum.expected - (10 + 1 / sum.p + 4)) < 1e-6,
        'expected ' + sum.expected.toFixed(2));
}

// 6) allow-missing mirrors the card's "all but one" mode
{
  const C = makeData();
  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P4', min: null }, { tail: 'stat_S4', min: null }]);
  const want = exact(C, ch => ch.includes(4) || ch.includes(9));
  const st = simulate(P, { allowMissing: 1 }, 200000, 9);
  check('all-but-one mode matches exact', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4));
}

// 7) item level gates tiers; influence tags unlock influenced mods
{
  const C = makeData(C => {
    C.spawn.push([['ring_shaper', 1000], ['default', 0]]);
    C.groups.push('ShaperMod');
    C.mods.push([1, [C.groups.length - 1], 1, C.spawn.length - 1, [['stat_SH', [[1, 1]]]], 1]);
    C.mods[0][2] = 90; // P0 needs ilvl 90
  });
  const plain = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_SH', min: null }, { tail: 'stat_P0', min: null }]);
  check('influenced mod unreachable without influence', !plain.reach[0].random);
  check('ilvl gate removes high tiers', !plain.reach[1].random);
  const shaper = Craft.prepare(C, 'Test Ring', ['Shaper'], 90, [{ tail: 'stat_SH', min: null }]);
  check('Shaper tag unlocks the mod', shaper.reach[0].random);
}

// 8) real data smoke: ES helmet with life + res
try {
  global.window = {};
  require('../data/craftdata.js');
  const C = window.POE_CRAFT;
  const P = Craft.prepare(C, 'Hubris Circlet', [], 86, [
    { tail: 'stat_3299347043', min: 70 },  // +# to maximum Life
    { tail: 'stat_3372524247', min: 36 }   // +#% to Fire Resistance
  ]);
  const t0 = Date.now();
  const st = simulate(P, {}, 200000, 13);
  const ms = Date.now() - t0;
  check('real helmet: both targets reachable', P.reach.every(r => r.random));
  check('real helmet: plausible chaos odds', st.s > 0 && st.s / st.n < 0.2,
        '1 in ' + Math.round(st.n / Math.max(1, st.s)) + ', ' + Math.round(200000 / ms) + 'k trials/s... ' + ms + 'ms for 200k');
  check('real helmet: essence of Greed offered', P.essences.some(e => /Greed/.test(e.name)));
} catch (e) {
  check('real data smoke', false, e.message);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
