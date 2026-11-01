// node test/prices.test.mjs — /api/prices with a stubbed poe.ninja and an in-memory cache.
import { handlePrices, compact, TYPES, UA } from '../api/prices.js';

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

const calls = [];
let failType = null;
async function fakeFetch(url, opts) {
  calls.push({ url, ua: opts.headers['User-Agent'] });
  const u = new URL(url);
  if (u.pathname.endsWith('/leagues')) return Response.json([{ id: 'Allflame', name: 'Allflame' }, { id: 'Standard' }]);
  const type = u.searchParams.get('type');
  if (type === failType) return new Response('nope', { status: 503 });
  return Response.json({ lines: [{ name: 'Headhunter', baseType: 'Leather Belt', chaosValue: 4321.7, divineValue: 21.6,
    listingCount: 12, count: 40, icon: 'x', explicitModifiers: [{ text: 'big' }], tradeInfo: [] },
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
check('lines shrunk to the app\'s fields', same(hh, { n: 'Headhunter', b: 'Leather Belt', c: 4322, d: 21.6, lc: 12 }), hh);
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

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
