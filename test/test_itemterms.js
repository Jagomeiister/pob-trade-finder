// Search text → Items: the "at least N" search for every mod in data/itemmods.js —
// run: node test/test_itemterms.js
// For each single-line mod, a sample advanced line ("+105(100-114) to maximum Life") is built
// from its text: the search with the best tier's minimum must find the best roll and skip a
// roll one below, and a high second number must not stand in for a low first one.
'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
global.window = {};
global.document = { getElementById: () => null };
['js/app/21-search-text.js', 'js/app/31-regex.js', 'data/itemmods.js'].forEach(f =>
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8')));
const D = window.POE_ITEM_MODS;

let failures = 0, checks = 0, skipped = 0;
function check(name, cond, detail) {
  checks++;
  if (!cond) { failures++; if (failures <= 40) console.log('FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function fmt(v, d) { return d ? v.toFixed(1).replace(/\.0$/, '.5') : String(Math.round(v)); }
// the advanced text of a line: first number = value with its tier range, the rest small rolls
function line(t, v, range, others, d) {
  let i = 0;
  return t.replace(/#/g, () => {
    const k = i++;
    if (k === 0) return fmt(v, d) + '(' + range[0] + '-' + range[1] + ')';
    const o = others[k - 1] || 1;
    return o + '(' + o + '-' + (o + 1) + ')';
  });
}
function hits(term, text) { return new RegExp(term, 'im').test(text); }

check('item mods loaded', D && D.mods && D.mods.length > 300, D && D.mods && D.mods.length);
D.mods.forEach((m, i) => {
  if (m.t.indexOf(' / ') !== -1 || !m.x || !m.x.length || !m.x[0][2]) { skipped++; return; }
  const best = m.x[0][2], lo = Math.min(best[0], best[1]), hi = Math.max(best[0], best[1]);
  if (lo < 1) { skipped++; return; }
  const term = itemModTerm(m, lo);
  const good = line(m.t, hi, [lo, hi], [], m.d), bad = line(m.t, lo - 1, [lo, hi], [], m.d);
  check('#' + i + ' finds ' + good, hits(term, good), term);
  check('#' + i + ' skips ' + bad, !hits(term, bad), term);
  if ((m.t.match(/#/g) || []).length >= 2) {
    // the second number rolls high, the first low: still no match
    const tricky = line(m.t, lo - 1, [lo, hi], [hi + 50], m.d);
    check('#' + i + ' second number does not count: ' + tricky, !hits(term, tricky), term);
  }
  check('#' + i + ' plain token finds the line', hits(itemModTerm(m, ''), good), m.r);
});

console.log((failures ? failures + ' FAILED' : 'ALL TESTS PASSED') + ' (' + checks + ' checks, ' + skipped + ' hybrid/odd mods skipped)');
process.exit(failures ? 1 : 0);
