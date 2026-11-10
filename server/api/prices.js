// GET /api/prices?league=<league id> — poe.ninja PoE1 item prices for PoB Trade Finder.
//
// poe.ninja asks desktop apps to go through their own backend rather than calling it from
// every user's PC (https://poe.ninja/docs/api). This is that backend: each category is
// fetched at most once per 30 minutes per league (Vercel Runtime Cache) with an identifying
// User-Agent, shrunk to the fields the app uses, and served from the CDN cache. Only the
// documented economy endpoints are used — never builds/profiles/characters.
import { getCache } from '@vercel/functions';

export const UA = 'PoBTradeFinder-API/1.0 (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)';
const NINJA = 'https://poe.ninja/poe1/api/economy';
const CDN = 'https://web.poecdn.com';
// stash item overviews: things that aren't on the currency exchange (the app prices those
// from GGG's own exchange feed)
export const TYPES = ['UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel',
  'UniqueTincture', 'UniqueRelic', 'ForbiddenJewel', 'SkillGem', 'ClusterJewel', 'Map', 'UniqueMap',
  'Invitation', 'Memory', 'Beast'];
const TTL = 1800;          // poe.ninja itself caches PoE1 overviews for 30 minutes
const LEAGUES_TTL = 3600;
const CONCURRENCY = 3;     // "be reasonable with concurrency" (poe.ninja docs)

async function ninja(path, fetchImpl = fetch) {
  const r = await fetchImpl(NINJA + path, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('poe.ninja HTTP ' + r.status);
  return r.json();
}

function round(v) { return v >= 100 ? Math.round(v) : Math.round(v * 100) / 100; }

// the fields the app reads, under short keys (a category goes from ~1 MB to ~60 KB)
export function compact(line) {
  const o = { n: line.name, c: round(line.chaosValue || 0) };
  if (line.baseType && line.baseType !== line.name) o.b = line.baseType;
  if (line.variant) o.v = line.variant;
  if (line.divineValue >= 0.1) o.d = round(line.divineValue);
  if (line.links) o.l = line.links;
  if (line.gemLevel) o.gl = line.gemLevel;
  if (line.gemQuality) o.gq = line.gemQuality;
  if (line.corrupted) o.cr = 1;
  if (line.mapTier) o.t = line.mapTier;
  if (line.listingCount != null) o.lc = line.listingCount;
  // icon: the path on GGG's CDN (the app adds the origin back); anything else is left out
  if (typeof line.icon === 'string' && line.icon.startsWith(CDN + '/')) o.i = line.icon.slice(CDN.length);
  const sp = spark(line.sparkLine || line.sparkline) || spark(line.lowConfidenceSparkLine);
  if (sp) o.sp = sp;
  return o;
}

// poe.ninja's 7-day trend {data: [% change vs 7 days ago, one per day, null = no data], totalChange}
// -> [totalChange, [up to 7 points]], rounded to 1 decimal; nothing when there is no trend
function spark(s) {
  if (!s || !Array.isArray(s.data)) return null;
  const r1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
  const pts = s.data.slice(-7).map(r1);
  if (!pts.some((v) => v !== null)) return null;
  return [r1(s.totalChange) || 0, pts];
}

// a whole category: every variant of an item shares one icon, so only the first line of each
// name carries it (the app looks an icon up by name); a 6,000-line gem list stays small
export function compactLines(lines) {
  const seen = new Map();
  return (lines || []).map((line) => {
    const o = compact(line);
    if (o.i) {
      if (seen.get(o.n) === o.i) delete o.i; else if (!seen.has(o.n)) seen.set(o.n, o.i);
    }
    return o;
  });
}

// Vercel Runtime Cache in production; a per-process Map when run locally (tests)
const memory = new Map();
function cacheStore() {
  try { return getCache({ namespace: 'pobtf' }); } catch { /* not on Vercel */ }
  return {
    get: async (k) => { const e = memory.get(k); return e && e.until > Date.now() ? e.v : undefined; },
    set: async (k, v, o) => { memory.set(k, { v, until: Date.now() + o.ttl * 1000 }); },
  };
}

async function cached(cache, key, ttl, load) {
  const hit = await cache.get(key);
  if (hit !== undefined && hit !== null) return hit;
  const value = await load();
  await cache.set(key, value, { ttl, name: key.split(':')[0] });
  return value;
}

function reply(status, body, cdnSeconds) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'public, max-age=' + Math.min(cdnSeconds, 600),
      'Vercel-CDN-Cache-Control': 'public, s-maxage=' + cdnSeconds + ', stale-while-revalidate=' + cdnSeconds * 2,
    },
  });
}

export async function handlePrices(request, deps = {}) {
  const url = new URL(request.url);
  const params = [...url.searchParams.keys()];
  // one canonical URL per league: extra parameters would bypass the CDN cache
  if (params.length !== 1 || params[0] !== 'league') {
    return reply(400, { error: 'use /api/prices?league=<league id>' }, 300);
  }
  const league = url.searchParams.get('league');
  const cache = deps.cache || cacheStore();
  const fetchImpl = deps.fetch || fetch;
  let leagues;
  try {
    leagues = await cached(cache, 'leagues', LEAGUES_TTL,
      async () => (await ninja('/leagues', fetchImpl)).map((l) => l.id));
  } catch (e) {
    return reply(502, { error: 'poe.ninja unavailable: ' + e.message }, 60);
  }
  // only real leagues reach poe.ninja: unknown names can't be used to fan out requests
  if (!leagues.includes(league)) return reply(404, { error: 'unknown league', leagues }, 300);

  const types = {}, errors = {};
  for (let i = 0; i < TYPES.length; i += CONCURRENCY) {
    await Promise.all(TYPES.slice(i, i + CONCURRENCY).map(async (t) => {
      try {
        types[t] = await cached(cache, 'type:' + league + ':' + t, TTL, async () => {
          const d = await ninja('/stash/current/item/overview?league=' + encodeURIComponent(league) +
            '&type=' + t, fetchImpl);
          return { at: Date.now(), lines: compactLines(d.lines) };
        });
      } catch (e) {
        errors[t] = e.message;
      }
    }));
  }
  if (!Object.keys(types).length) return reply(502, { error: 'poe.ninja unavailable', errors }, 60);
  const oldest = Math.min(...Object.values(types).map((t) => t.at));
  const body = { league, source: 'poe.ninja', fetchedAt: new Date(oldest).toISOString(), types };
  if (Object.keys(errors).length) body.errors = errors;
  return reply(200, body, Object.keys(errors).length ? 120 : TTL);
}

export async function GET(request) {
  return handlePrices(request);
}
