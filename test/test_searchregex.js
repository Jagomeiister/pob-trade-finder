// Search text number regex — run: node test/test_searchregex.js
// atLeastRegex(n) and rangeRegex(lo, hi) (js/app/21-search-text.js), checked against every
// number they could meet: whole-match exactness, and no false hits when a ".*" in front lets
// the regex start part-way into a longer number (how the map totals use it). Also the term
// joiners and the socket patterns' basic shape.
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
global.window = {};
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app', '21-search-text.js'), 'utf8'));

let failures = 0, checks = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// at least n: exact on whole numbers, safe after ".*"
for (let n = 1; n <= 1200; n++) {
  const re = atLeastRegex(n), whole = new RegExp('^' + re + '$'), loose = new RegExp('as drops:.*' + re + '%', 'i');
  let bad = null;
  for (let v = 0; v <= 2500 && !bad; v++) {
    // whole-number form: \d{L+1} stands for "more digits", so only check numbers of n's length or one more
    if (String(v).length <= String(n).length + 1 && whole.test(String(v)) !== (v >= n)) bad = ['whole', v];
    if (loose.test('Atlas Drops: +' + v + '% (augmented)') !== (v >= n)) bad = ['after .*', v];
  }
  check('atLeastRegex(' + n + ') = ' + re, !bad, bad);
}
check('atLeastRegex(60) is short', atLeastRegex(60) === '([6-9]\\d|\\d{3})', atLeastRegex(60));
check('atLeastRegex(87)', atLeastRegex(87) === '(8[7-9]|9\\d|\\d{3})', atLeastRegex(87));
check('atLeastRegex(5)', atLeastRegex(5) === '([5-9]|\\d{2})', atLeastRegex(5));
check('atLeastRegex(0) matches anything', atLeastRegex(0) === '\\d');

// from lo to hi: exact on whole numbers
const pairs = [[0, 9], [1, 99], [15, 120], [5, 5], [7, 23], [100, 199], [99, 101], [0, 1000], [250, 999], [19, 81],
  [120, 15], [3, 1999], [40, 40], [10, 19]];
for (let i = 0; i < 300; i++) { const a = Math.floor(Math.random() * 1500), b = Math.floor(Math.random() * 1500); pairs.push([a, b]); }
pairs.forEach(([lo, hi]) => {
  const re = rangeRegex(lo, hi), rx = new RegExp('^' + re + '$'), a = Math.min(lo, hi), b = Math.max(lo, hi);
  let bad = null;
  for (let v = 0; v <= 2100 && !bad; v++) if (rx.test(String(v)) !== (v >= a && v <= b)) bad = v;
  check('rangeRegex(' + lo + ', ' + hi + ') = ' + re, bad === null, bad);
});
check('rangeRegex(15, 120)', rangeRegex(15, 120) === '(1[5-9]|[2-9]\\d|1([01]\\d|20))' || new RegExp('^' + rangeRegex(15, 120) + '$').test('120'), rangeRegex(15, 120));

// joining
check('any of', searchAny(['a', 'b c']) === '"a|b c"');
check('all of', searchAll(['a', 'b']) === '"a" "b"');
check('none of', searchNone(['a', 'b']) === '"!a|b"');
check('empty parts vanish', searchJoin(['', searchAny([]), '"x"']) === '"x"');
check('quotes inside are dropped', searchQuote('say "hi"') === '"say hi"');
check('escape', searchEscape('a.b(c)') === 'a\\.b\\(c\\)');
check('round to tens', searchRound(87, true) === 80 && searchRound(87, false) === 87 && searchRound(7, true) === 7);

// maps: totals and state
const mt = mapSearchText({ picks: { abc: 'avoid', def: 'want' }, yields: { quant: 80, pack: 25 }, quality: {}, rarity: { rare: true },
  types: {}, corrupted: 'no' });
check('map search parts', mt === '"!abc" "def" "as drops:.*([8-9]\\d|\\d{3})%" "k size:.*(2[5-9]|[3-9]\\d|\\d{3})%" "y: (r)" "!^corrupted$"', mt);
const MAP = 'Item Class: Maps\nRarity: Rare\nDread Paradise\nCrater Map\nMap Tier: 16\nAtlas Drops: +85% (augmented)\n' +
  'Item Rarity: +45% (augmented)\nMonster Pack Size: +30% (augmented)\nQuality (Pack Size): +20% (augmented)\n' +
  'More Maps: +40% (augmented)\nMore Threads: +10% (augmented)\nQuality (Threads): +20% (augmented)\nMore Currency: +12% (augmented)\nItem Quantity: +95% (augmented)\n' +
  'Item Level: 83';
function hits(term, text) { return new RegExp(term.replace(/^"|"$/g, ''), 'im').test(text); }
check('Atlas Drops 80 finds 85', hits(mapSearchText({ yields: { quant: 80 } }), MAP));
check('Atlas Drops 90 skips 85 (Item Quantity +95 does not count)', !hits(mapSearchText({ yields: { quant: 90 } }), MAP));
check('pack size 30 finds +30 (not the quality line)', hits(mapSearchText({ yields: { pack: 30 } }), MAP));
check('pack size 31 skips (quality 20 stays out)', !hits(mapSearchText({ yields: { pack: 31 } }), MAP) &&
  !hits(mapSearchText({ yields: { pack: 15 } }), MAP.replace('Monster Pack Size: +30%', 'Monster Pack Size: +10%')));
check('more maps 40 finds', hits(mapSearchText({ yields: { maps: 40 } }), MAP) && !hits(mapSearchText({ yields: { maps: 41 } }), MAP));
check('more currency 12 vs quality', hits(mapSearchText({ yields: { currency: 12 } }), MAP) &&
  !hits(mapSearchText({ yields: { currency: 13 } }), MAP));
check('rarity 45 vs "Rarity: Rare"', hits(mapSearchText({ yields: { rarity: 45 } }), MAP) && !hits(mapSearchText({ yields: { rarity: 46 } }), MAP));
check('quality (pack size) 20', hits(mapSearchText({ quality: { pack: 20 } }), MAP) && !hits(mapSearchText({ quality: { pack: 21 } }), MAP));
check('more threads 10 (not Quality (Threads) 20)', hits(mapSearchText({ yields: { scarabs: 10 } }), MAP) &&
  !hits(mapSearchText({ yields: { scarabs: 11 } }), MAP));
check('quality (threads) 20', hits(mapSearchText({ quality: { scarabs: 20 } }), MAP) && !hits(mapSearchText({ quality: { scarabs: 21 } }), MAP));
check('plain quality skips typed quality', !hits(mapSearchText({ quality: { plain: 5 } }), MAP));
check('map price note', hits(mapSearchText({ priceOn: true, priceMin: 5, priceMax: 20 }), MAP + '\nNote: ~price 15 chaos') &&
  !hits(mapSearchText({ priceOn: true, priceMin: 5, priceMax: 20 }), MAP + '\nNote: ~price 25 chaos'));

// map mod tokens (data/mapmods.js) never hit a line every 3.30 map shows: avoiding a mod must not
// drop every map with More Threads (3.30 added "% more Threads" to every T17 mod)
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'data', 'mapmods.js'), 'utf8'));
const MAP330 = ['Item Class: Maps', 'Rarity: Rare', 'Map Tier: 17', 'Atlas Drops: +45% (augmented)', 'More Threads: +12% (augmented)',
  'Quality (Threads): +20% (augmented)', 'Item Quantity: +20% (augmented)', 'Item Rarity: +45% (augmented)',
  "This Map's Modifiers to Atlas Drops also apply to Item Rarity", 'More Maps: +40% (augmented)', 'More Currency: +12% (augmented)',
  'Monster Pack Size: +30% (augmented)', 'Quality (Pack Size): +20% (augmented)', 'Corrupted', 'Unidentified'];
const hitsCommon = (window.POE_MAP_MODS || []).filter(m => MAP330.some(l => new RegExp(m.token, 'i').test(l)));
check('map mod tokens miss every line all 3.30 maps carry', window.POE_MAP_MODS.length > 40 && !hitsCommon.length,
  hitsCommon.map(m => m.token + ' <- ' + m.text));
check('no map mod text carries the Threads or Atlas Drops totals', !window.POE_MAP_MODS.some(m => /Threads found|Atlas Drops/.test(m.text)));

// old presets (one flat state) load into the tabs
const old = migrateSearchState({ tab: 'custom', picks: { x: 'want' }, quant: '70', custom: 'a\nb', customMode: 'all',
  preset: { flasks: { bleed: true } }, presetAll: { flasks: true } });
check('old preset migrates', old.tab === 'custom' && old.tabs.maps.picks.x === 'want' && old.tabs.maps.yields.quant === '70' &&
  old.tabs.flasks.picked.bleed && old.tabs.flasks.all && old.tabs.custom.text === 'a\nb' && old.tabs.custom.mode === 'all', old);

console.log(failures ? failures + ' FAILED (of ' + checks + ')' : 'ALL TESTS PASSED (' + checks + ' checks)');
process.exit(failures ? 1 : 0);
