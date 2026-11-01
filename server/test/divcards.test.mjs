// node test/divcards.test.mjs — /api/divcards with a stubbed wiki and an in-memory cache.
import { handleDivcards, loadDivcards, UA } from '../api/divcards.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail)));
}

function memCache() {
  const m = new Map();
  return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, size: () => m.size };
}

const CARDS = [
  { name: 'A Chilling Wind', areas: 'MapWorldsColdRiver_,MapWorldsSummit', enabled: '1', stack: '4' },
  { name: 'The Doctor', areas: 'MapWorldsBurialChambers', enabled: '1', stack: '8' },
  { name: 'Gone Card', areas: null, enabled: '0', stack: '1' },
  { name: 'Weird', areas: 'Bad Id",x', enabled: '1', stack: null },
];
const AREAS = {
  MapWorldsColdRiver_: { id: 'MapWorldsColdRiver_', name: 'Cold River', lvl: '78', map: '1' },
  MapWorldsSummit: { id: 'MapWorldsSummit', name: 'Summit', lvl: '79', map: '1' },
  MapWorldsBurialChambers: { id: 'MapWorldsBurialChambers', name: 'Burial Chambers', lvl: '75', map: '1' },
};
const calls = [];
let many = 0; // extra filler cards so the >=100 sanity check passes
async function fakeFetch(url, opts) {
  calls.push({ url, ua: opts.headers['User-Agent'] });
  const q = new URL(url).searchParams;
  if (q.get('tables') === 'areas') {
    const ids = [...q.get('where').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return Response.json({ cargoquery: ids.filter((id) => AREAS[id]).map((id) => ({ title: AREAS[id] })) });
  }
  const rows = CARDS.concat(Array.from({ length: many }, (_, i) => ({ name: 'Filler ' + i, areas: '', enabled: '1', stack: '1' })));
  const off = Number(q.get('offset') || 0);
  return Response.json({ cargoquery: rows.slice(off, off + 500).map((t) => ({ title: t })) });
}

const d = await loadDivcards(fakeFetch);
const byName = Object.fromEntries(d.cards.map((c) => [c.n, c]));
check('identifies itself', calls.every((c) => c.ua === UA), calls.map((c) => c.ua));
check('areas resolved to names / levels / map flag', d.areas.length === 3 &&
  d.areas.find((a) => a.id === 'MapWorldsSummit').name === 'Summit' && d.areas.every((a) => a.map), d.areas);
const chill = byName['A Chilling Wind'];
check('card -> area indexes + stack size', chill.s === 4 && chill.a.length === 2 &&
  chill.a.map((i) => d.areas[i].name).sort().join() === 'Cold River,Summit', chill);
check('disabled card marked off', byName['Gone Card'].off === 1 && !byName['Gone Card'].a, byName['Gone Card']);
check('odd area ids never reach the query', !calls.some((c) => decodeURIComponent(c.url).includes('Bad Id')),
  calls.map((c) => c.url));
check('source credited', /Path of Exile Wiki/.test(d.source) && /CC BY-NC-SA/.test(d.source));

// endpoint: pagination, cache, validation
many = 600;
calls.length = 0;
const cache = memCache();
let r = await handleDivcards(new Request('https://x/api/divcards'), { cache, fetch: fakeFetch });
let body = await r.json();
const pages = calls.filter((c) => !c.url.includes('tables=areas')).length;
check('200 with all cards over two pages', r.status === 200 && body.cards.length === 604 && pages === 2, [r.status, body.cards && body.cards.length, pages]);
check('cached on the CDN for 12 h', /s-maxage=43200/.test(r.headers.get('Vercel-CDN-Cache-Control') || ''));
calls.length = 0;
r = await handleDivcards(new Request('https://x/api/divcards'), { cache, fetch: fakeFetch });
check('second request from the cache (no wiki calls)', r.status === 200 && calls.length === 0, calls.length);
r = await handleDivcards(new Request('https://x/api/divcards?x=1'), { cache: memCache(), fetch: fakeFetch });
check('parameters refused (cache-busting)', r.status === 400);
many = 0;
r = await handleDivcards(new Request('https://x/api/divcards'), { cache: memCache(), fetch: fakeFetch });
check('implausibly few cards -> 502, nothing cached', r.status === 502);
r = await handleDivcards(new Request('https://x/api/divcards'), { cache: memCache(),
  fetch: async () => new Response('down', { status: 503 }) });
check('wiki down -> 502', r.status === 502);

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
