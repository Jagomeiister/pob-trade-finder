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
// weightOf(modIdx) overrides the spawn weight (fossils); 0 drops the mod. Mods
// flagged 8 (fossil-added) join only when weightOf gives them a weight.
function exact(C, pred, forcedIdx, weightOf) {
  const wOf = weightOf || (i => (C.mods[i][5] & 1) ? C.spawn[C.mods[i][3]][0][1] : 0);
  const fams = C.mods.map((m, i) => ({ i, affix: m[0], w: wOf(i) })).filter(f => f.w > 0);
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
  const easy = Craft.summarize({ n: 1000, s: 990, benchUses: {} }, 12, [], 0);
  check('unlucky cost is never below one try (99% odds)', easy.tries90 === 1 && easy.cost90 >= 12, easy.cost90);
  const hard = Craft.summarize({ n: 1000, s: 10, benchUses: {} }, 1, [], 0);
  check('unlucky cost is at least the average', hard.cost90 >= hard.expected, hard.cost90 + ' vs ' + hard.expected);
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

// 8) fossils: tag multipliers, blocking, additive vs multiplicative "more", added mods
{
  const LIFE = 0, DEF = 1, FIRE = 2, GEM = 3, MINION = 4;
  const C = makeData(C => {
    C.fossilTags = ['life', 'defences', 'fire', 'gem', 'minion'];
    C.mods[4][6] = 1 << LIFE;                  // P4: life
    C.mods[3][6] = (1 << LIFE) | (1 << DEF);   // P3: hybrid life + defences
    C.mods[5][6] = 1 << DEF;                   // S0: defences
    C.mods[8][6] = 1 << FIRE;                  // S3: fire
    C.mods[9][6] = 1 << FIRE;                  // S4: fire
    C.spawn.push([['default', 1000]]);
    C.groups.push('GemLevel');
    C.mods.push([1, [C.groups.length - 1], 1, C.spawn.length - 1, [['stat_G', [[1, 1]]]], 8, 1 << GEM]);
    const G = C.mods.length - 1;
    C.fossils = [
      ['Pristine-like', 'pristine-fossil', [[LIFE, 1000]], [[DEF, 0]], []],
      ['Scorched-like', 'scorched-fossil', [[FIRE, 1000]], [], []],
      ['Half-life', 'half-fossil', [[LIFE, 500]], [], []],
      ['Faceted-like', 'faceted-fossil', [[GEM, 1000]], [], [G]],
      ['Minion-only', 'bound-fossil', [[MINION, 1000]], [], []],
      ['Fewer-fire', 'aetheric-fossil', [], [[FIRE, 15]], []]
    ];
  });
  const G = C.mods.length - 1;
  const base = i => (C.mods[i][5] & 1) ? C.spawn[C.mods[i][3]][0][1] : 0;
  const fm = Craft.fossilMultiplier;
  check('fossil: more x10 on a matching tag', fm(1 << LIFE, [C.fossils[0]]) === 10);
  check('fossil: "no" tag blocks', fm(1 << DEF, [C.fossils[0]]) === 0);
  check('fossil: hybrid with a blocked tag is blocked', fm((1 << LIFE) | (1 << DEF), [C.fossils[0]]) === 0);
  check('fossil: untouched mod keeps x1', fm(1 << FIRE, [C.fossils[0]]) === 1);
  check('fossil: "more" stacks additively by default', fm(1 << LIFE, [C.fossils[0], C.fossils[2]]) === 15);
  check('fossil: multiplicative option', fm(1 << LIFE, [C.fossils[0], C.fossils[2]], 'multiplicative') === 50);
  check('fossil: fewer multiplies the more', Math.abs(fm(1 << FIRE, [C.fossils[1], C.fossils[5]]) - 1.5) < 1e-12);

  const P = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_P4', min: null }, { tail: 'stat_S1', min: null }]);
  const Q = Craft.withFossils(P, [0]);
  const wQ = i => base(i) * fm(C.mods[i][6] || 0, [C.fossils[0]]);
  const want = exact(C, ch => ch.includes(4) && ch.includes(6), undefined, wQ);
  const st = simulate(Q, {}, 200000, 21);
  check('fossil reroll matches exact (x10 + block)', within(st.s / st.n, want, st.n),
        'sim ' + (st.s / st.n).toFixed(4) + ' vs exact ' + want.toFixed(4) + ', chaos ' + exact(C, ch => ch.includes(4) && ch.includes(6)).toFixed(4));
  check('fossil raises odds over chaos', want > exact(C, ch => ch.includes(4) && ch.includes(6)));
  const Pdef = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_S0', min: null }]);
  check('blocked target unreachable under the fossil', Pdef.reach[0].random && !Craft.withFossils(Pdef, [0]).reach[0].random);

  for (const stack of ['additive', 'multiplicative']) {
    const Q2 = Craft.withFossils(P, [0, 2], stack);
    const w2 = i => base(i) * fm(C.mods[i][6] || 0, [C.fossils[0], C.fossils[2]], stack);
    const want2 = exact(C, ch => ch.includes(4) && ch.includes(6), undefined, w2);
    const st2 = simulate(Q2, {}, 200000, stack === 'additive' ? 23 : 29);
    check('two-fossil ' + stack + ' matches exact', within(st2.s / st2.n, want2, st2.n),
          'sim ' + (st2.s / st2.n).toFixed(4) + ' vs exact ' + want2.toFixed(4));
  }

  const Pg = Craft.prepare(C, 'Test Ring', [], 86, [{ tail: 'stat_G', min: null }]);
  check('fossil-only mod: not in the chaos pool', !Pg.reach[0].random && Pg.reach[0].fossil);
  const Qg = Craft.withFossils(Pg, [3]);
  const wg = i => i === G ? 1000 * 10 : base(i);
  const wantG = exact(C, ch => ch.includes(G), undefined, wg);
  const stG = simulate(Qg, {}, 200000, 31);
  check('fossil-added mod matches exact', Qg.reach[0].random && within(stG.s / stG.n, wantG, stG.n),
        'sim ' + (stG.s / stG.n).toFixed(4) + ' vs exact ' + wantG.toFixed(4));

  const combos = Craft.fossilCombos(P);
  const names = combos.map(c => c.names.join('+'));
  check('combos skip fossils with no effect on this base', !names.some(n => /Minion-only/.test(n)));
  combos.sort((a, b) => b.rough - a.rough);
  check('best combo for a life target uses the life fossil', /Pristine-like/.test(combos[0].names.join('+')), names.slice(0, 3).join(', '));
  check('combos include pairs and triples', combos.some(c => c.fossils.length === 2) && combos.some(c => c.fossils.length === 3));
}

// 9) real data smoke: ES helmet with life + res
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

  // Pristine Fossil (poewiki: "Life" x10, no "Defence") on a body armour
  const fi = C.fossils.findIndex(f => f[0] === 'Pristine Fossil');
  check('real data: Pristine Fossil bundled as life x10 / defences blocked', fi >= 0 &&
        C.fossilTags[C.fossils[fi][2][0][0]] === 'life' && C.fossils[fi][2][0][1] === 1000 &&
        C.fossilTags[C.fossils[fi][3][0][0]] === 'defences' && C.fossils[fi][3][0][1] === 0);
  check('real data: resonator codes bundled', C.resonators.length === 4 && C.resonators.every(Boolean));
  const BA = Craft.prepare(C, 'Vaal Regalia', [], 86, [{ tail: 'stat_3299347043', min: 80 }]); // +# to maximum Life
  const chaosSt = simulate(BA, {}, 200000, 41);
  const pr = Craft.withFossils(BA, [fi]);
  const prSt = simulate(pr, {}, 200000, 43);
  const pc = chaosSt.s / chaosSt.n, pp = prSt.s / prSt.n;
  check('real body armour: Pristine raises P(80+ life) over chaos', pp > 2 * pc,
        'chaos ' + (pc * 100).toFixed(1) + '% vs Pristine ' + (pp * 100).toFixed(1) + '%');
  const es = Craft.prepare(C, 'Vaal Regalia', [], 86, [{ tail: 'stat_4015621042', min: null }]); // #% increased Energy Shield (local)
  check('real body armour: Pristine blocks ES% (defences)', es.reach[0].random && !Craft.withFossils(es, [fi]).reach[0].random);
  const t1 = Date.now(), combos = Craft.fossilCombos(BA);
  check('real body armour: combo search is quick and finds Pristine', Date.now() - t1 < 500 &&
        combos.sort((a, b) => b.rough - a.rough)[0].names.indexOf('Pristine Fossil') !== -1,
        combos.length + ' combos in ' + (Date.now() - t1) + 'ms, best ' + combos[0].names.join(' + '));
} catch (e) {
  check('real data smoke', false, e.message);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
