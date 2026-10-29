// Jewel finder tests — run: node test/test_jewels.js
const Jw = require('../js/jewels.js');
global.window = {};
require('../data/jeweldata.js');
const J = window.POE_JEWELS;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

// synthetic builds: tree lines + main skill, no real tree needed
function fakeBuild(lines, mainSkill) {
  const tree = {}, nodes = [];
  lines.forEach((l, i) => { tree[900000 + i] = [1, 'n' + i, l]; nodes.push(900000 + i); });
  const Jx = Object.assign({}, J, { tree: Object.assign({}, J.tree, tree) });
  return { P: Jw.profile({ tree: { nodes, masteries: [] }, mainSkill }, Jx), J: Jx };
}
function score(P, text) { return Jw.scoreText(P, text); }

// 1) cold crit spell caster
{
  const { P } = fakeBuild(['30% increased Spell Damage', '40% increased Critical Strike Chance for Spells',
    '+20% to Critical Strike Multiplier for Spells', '15% increased maximum Energy Shield'], ['Ice Nova', 'Increased Critical Damage']);
  check('caster: cold damage is top value', score(P, '#% increased Cold Damage') >= 0.95);
  check('caster: spell crit multi is top value', score(P, '+#% to Critical Strike Multiplier for Spell Damage') >= 0.95);
  check('caster: fire-skill crit is worthless', score(P, '#% increased Critical Strike Chance with Fire Skills') < 0.2);
  check('caster: minion damage is worthless', score(P, 'Minions deal #% increased Damage') < 0.2);
  check('caster: attack speed ranks below cast speed',
        score(P, '#% increased Attack Speed') < score(P, '#% increased Cast Speed'));
  check('caster: ES build prefers % ES over % life',
        score(P, '#% increased maximum Energy Shield') > score(P, '#% increased maximum Life'));
}

// 2) minion summoner on life
{
  const { P } = fakeBuild(['Minions deal 20% increased Damage', 'Minions have 15% increased maximum Life',
    '8% increased maximum Life', 'Minions have 10% increased Attack Speed'], ['Raise Spectre', 'Minion Damage']);
  check('minion: minion damage is top value', score(P, 'Minions deal #% increased Damage') >= 0.95);
  check('minion: spell damage is low', score(P, '#% increased Spell Damage') < 0.5,
        score(P, '#% increased Spell Damage').toFixed(2));
  check('minion: life build prefers % life over % ES',
        score(P, '#% increased maximum Life') > score(P, '#% increased maximum Energy Shield'));
}

// 3) bow attack build
{
  const { P } = fakeBuild(['20% increased Physical Damage with Bows', '10% increased Attack Speed with Bows',
    '15% increased Projectile Damage', '30% increased Global Critical Strike Chance'], ['Tornado Shot']);
  check('bow: projectile damage valued', score(P, '#% increased Projectile Damage') >= 0.7);
  check('bow: bow attack speed valued', score(P, '#% increased Attack Speed with Bows') >= 0.6);
  check('bow: wand damage worthless', score(P, '#% increased Damage with Wands') < 0.2);
}

// 4) defensive/self lines and resist baselines
{
  const { P } = fakeBuild(['30% increased Spell Damage'], ['Fireball']);
  check('"Block Spell Damage" is not treated as damage',
        !Jw.features('+#% Chance to Block Spell Damage').e.includes('damage'));
  check('"…on you" lines stay low', score(P, '#% reduced Effect of Chill on you') <= 0.2);
  check('resistances keep a low baseline', Math.abs(score(P, '+#% to Cold Resistance') - 0.25) < 1e-9);
  check('fire resistance does not count as fire damage', !Jw.features('+#% to Fire Resistance').q.includes('fire'));
}

// 5) query builders
{
  const sel = [{ tail: 'stat_1', max: 10, score: 1, required: true }, { tail: 'stat_2', max: 20, score: 0.5 }];
  const w = Jw.weightedQuery(sel, { status: 'available', minScore: 50 });
  check('weighted: required mods in an and-group first', w.query.stats[0].type === 'and' && w.query.stats[0].filters.length === 1);
  check('weighted: sorts by the weight group', w.sort['statgroup.1'] === 'desc');
  check('weighted: max roll worth score×100', Math.abs(Jw.weightFor(sel[0]) * 10 - 100) < 0.01 && Math.abs(Jw.weightFor(sel[1]) * 20 - 50) < 0.01);
  check('weighted: jewel category + non-unique', w.query.filters.type_filters.filters.category.option === 'jewel.base');
  const c = Jw.countQuery(sel, { count: 3, minRoll: 0.5, abyss: true });
  check('count: clamps N to the optional mods', c.query.stats[1].value.min === 1);
  check('count: min roll = max × pct', c.query.stats[1].filters[0].value.min === 10);
  check('count: abyss category', c.query.filters.type_filters.filters.category.option === 'jewel.abyss');
}

// 6) timeless seeds
{
  check('seed parser dedupes and ignores junk', JSON.stringify(Jw.parseSeeds('123, 456 abc 123;789')) === '[123,456,789]');
  const t = Jw.timelessQuery('Lethal Pride', [10000, 12345], '', {});
  check('timeless: every conqueror × seed', t.query.stats[0].filters.length === 8 && t.query.name === 'Lethal Pride');
  check('timeless: exact seed value', t.query.stats[0].filters[0].value.min === 10000 && t.query.stats[0].filters[0].value.max === 10000);
  const one = Jw.timelessQuery('Glorious Vanity', [5000], 'xibaqua', {});
  check('timeless: single conqueror', one.query.stats[0].filters.length === 1 &&
        one.query.stats[0].filters[0].id === 'explicit.pseudo_timeless_jewel_xibaqua');
  const many = Jw.timelessQuery('Militant Faith', Array.from({ length: 20 }, (_, i) => 2000 + i * 20), '', {});
  check('timeless: caps the filter count', many.truncated && many.query.stats[0].filters.length === 40);
}

// 7) every timeless stat id exists in the bundled trade stats
{
  const stats = JSON.parse(require('fs').readFileSync(__dirname + '/../data/stats.json', 'utf8'));
  const ids = new Set(stats.result.flatMap(g => g.entries.map(e => e.id)));
  const missing = [];
  Object.values(Jw.TIMELESS).flat().forEach(c => { if (!ids.has('explicit.pseudo_timeless_jewel_' + c)) missing.push(c); });
  check('timeless stat ids exist in trade data', !missing.length, missing.join(','));
  const jm = J.mods.filter(m => !ids.has('explicit.' + m[0]));
  check('every jewel mod maps to a trade stat', !jm.length, jm.slice(0, 3).map(m => m[1]).join(' | '));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
