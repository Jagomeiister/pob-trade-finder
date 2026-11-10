// node test/prices.test.mjs — /api/prices with a stubbed poe.ninja and an in-memory cache.
import { handlePrices, compact, compactLines, TYPES, UA } from '../api/prices.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
}

const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function memCache() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, size: () => m.size };
}

const CDN = 'https://web.poecdn.com';
const HH_ICON = CDN + '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQmVsdHMvSGVhZGh1bnRlciIsInciOjIsImgiOjEsInNjYWxlIjoxfV0/8f2e5b6d1c/Headhunter.png';
const calls = [];
let failType = null;
async function fakeFetch(url, opts) {
  calls.push({ url, ua: opts.headers['User-Agent'] });
  const u = new URL(url);
  if (u.pathname.endsWith('/leagues')) return Response.json([{ id: 'Allflame', name: 'Allflame' }, { id: 'Standard' }]);
  const type = u.searchParams.get('type');
  if (type === failType) return new Response('nope', { status: 503 });
  return Response.json({ lines: [{ name: 'Headhunter', baseType: 'Leather Belt', chaosValue: 4321.7, divineValue: 21.6,
    listingCount: 12, count: 40, icon: HH_ICON, explicitModifiers: [{ text: 'big' }], tradeInfo: [],
    sparkLine: { data: [0, 1.234, null, -2.5, 3.01, 4, 5.55], totalChange: 5.55 },
    lowConfidenceSparkLine: { data: [0, 9, 9, 9, 9, 9, 9], totalChange: 9 } },
  { name: 'Enlighten Support', chaosValue: 0.456, gemLevel: 3, gemQuality: 20, corrupted: true }] });
}

const req = (q) => new Request('https://pobtf-api.vercel.app/api/prices' + q);

// input validation: one canonical URL per league
let r = await handlePrices(req(''), { cache: memCache(), fetch: fakeFetch });
check('missing league -> 400', r.status === 400);
r = await handlePrices(req('?league=Allflame&x=1'), { cache: memCache(), fetch: fakeFetch });
check('extra parameter -> 400 (cache-busting blocked)', r.status === 400);
calls.length = 0;
r = await handlePrices(req('?league=Nope'), { cache: memCache(), fetch: fakeFetch });
const body404 = await r.json();
check('unknown league -> 404 with the list', r.status === 404 && body404.leagues.includes('Allflame'), body404);
check('unknown league never asks for item prices', calls.every((c) => c.url.endsWith('/leagues')), calls);

// happy path
const cache = memCache();
calls.length = 0;
r = await handlePrices(req('?league=Allflame'), { cache, fetch: fakeFetch });
const body = await r.json();
check('200', r.status === 200, r.status);
check('every category fetched once', calls.length === 1 + TYPES.length, calls.length);
check('identifying User-Agent on every call', calls.every((c) => c.ua === UA));
check('all categories in the reply', Object.keys(body.types).length === TYPES.length);
const hh = body.types.UniqueAccessory.lines[0];
check('lines shrunk to the app\'s fields', same(hh, { n: 'Headhunter', b: 'Leather Belt', c: 4322, d: 21.6, lc: 12,
  i: HH_ICON.slice(CDN.length), sp: [5.6, [0, 1.2, null, -2.5, 3, 4, 5.6]] }), hh);
check('CDN cache 30 min', r.headers.get('vercel-cdn-cache-control').includes('s-maxage=1800'));

// second request inside the TTL: served from the cache, poe.ninja not asked again
calls.length = 0;
r = await handlePrices(req('?league=Allflame'), { cache, fetch: fakeFetch });
check('cached: no poe.ninja calls on the second request', calls.length === 0 && r.status === 200, calls.length);

// one category failing: the rest still served, shorter cache so it heals quickly
failType = 'Beast';
r = await handlePrices(req('?league=Allflame'), { cache: memCache(), fetch: fakeFetch });
const partial = await r.json();
check('partial failure still 200 with errors listed', r.status === 200 && partial.errors && partial.errors.Beast, partial.errors);
check('partial reply cached briefly', r.headers.get('vercel-cdn-cache-control').includes('s-maxage=120'));

check('gem fields kept', same(compact({ name: 'Enlighten Support', chaosValue: 0.456, gemLevel: 3,
  gemQuality: 20, corrupted: true }), { n: 'Enlighten Support', c: 0.46, gl: 3, gq: 20, cr: 1 }));

// icon: only a path on GGG's CDN; anything else is left out
check('icon kept as a CDN path', compact({ name: 'A', chaosValue: 1, icon: CDN + '/image/Art/A.png' }).i === '/image/Art/A.png');
check('icon elsewhere is skipped', !('i' in compact({ name: 'A', chaosValue: 1, icon: 'https://example.com/a.png' })) &&
  !('i' in compact({ name: 'A', chaosValue: 1, icon: CDN + '.evil.example/a.png' })) && !('i' in compact({ name: 'A', chaosValue: 1 })));

// 7-day trend: [totalChange, up to 7 points], 1 decimal; absent or empty -> no key
const long = compact({ name: 'A', chaosValue: 1, sparkLine: { data: [1, 2, 3, 4, 5, 6, 7, 8, 9.99], totalChange: -12.345 } });
check('trend: last 7 points, rounded', JSON.stringify(long.sp) === '[-12.3,[3,4,5,6,7,8,10]]', long.sp);
check('trend: lower-case key read too', JSON.stringify(compact({ name: 'A', chaosValue: 1,
  sparkline: { data: [0, 1.04], totalChange: 1.04 } }).sp) === '[1,[0,1]]');
check('trend: empty falls back to the low-confidence one', JSON.stringify(compact({ name: 'A', chaosValue: 1,
  sparkLine: { data: [], totalChange: 0 }, lowConfidenceSparkLine: { data: [0, null, 2], totalChange: 2 } }).sp) === '[2,[0,null,2]]');
check('trend: absent or all-null is left out', !('sp' in compact({ name: 'A', chaosValue: 1 })) &&
  !('sp' in compact({ name: 'A', chaosValue: 1, sparkLine: { data: [null, null], totalChange: 0 } })) &&
  !('sp' in compact({ name: 'A', chaosValue: 1, sparkLine: {} })));

// a whole category: the variants of one item share an icon, sent once
const gemIcon = CDN + '/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvR2Vtcy9TdXBwb3J0L0VubGlnaHRlbiIsInciOjEsImgiOjEsInNjYWxlIjoxfV0/7a1b9c3d5e/Enlighten.png';
const gems = [];
for (let lvl = 1; lvl <= 5; lvl++) for (const q of [0, 20, 23]) for (const cr of [false, true]) {
  for (let g = 0; g < 20; g++) gems.push({ name: 'Gem ' + g + ' Support', chaosValue: 10 * lvl + q + g, divineValue: 0.5, gemLevel: lvl,
    gemQuality: q, corrupted: cr, listingCount: 30 + g, icon: gemIcon.replace('Enlighten', 'Gem' + g),
    sparkLine: { data: [0, 1.5, -2.25, 3.1, 4.4, -5.6, 6.7], totalChange: 6.7 } });
}
const packed = compactLines(gems);
const withIcon = packed.filter((l) => l.i);
check('category: one icon per item name', withIcon.length === 20 && packed.length === 600 && withIcon[0].i.startsWith('/gen/image/'),
  withIcon.length);
const size = (lines) => JSON.stringify(lines).length;
const before = size(packed.map((l) => { const o = { ...l }; delete o.i; delete o.sp; return o; }));
const after = size(packed), naive = size(gems.map(compact));
console.log('     size of a 600-line category: ' + before + ' B before, ' + after + ' B with icon + trend (' +
  Math.round(after / packed.length) + ' B/line; ' + naive + ' B if every line carried its icon)');
check('category stays small: under 130 B a line, under 2x the old size', after / packed.length < 130 && after < before * 2,
  [before, after]);
check('icon de-duplication saves most of the icon bytes', after < naive * 0.6, [after, naive]);

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
