// GET /api/divcards — where each divination card drops, for PoB Trade Finder's "Div cards" tool.
//
// Drop areas and stack sizes come from the community Path of Exile Wiki's Cargo tables
// (poewiki.net, content CC BY-NC-SA 3.0 — the app credits it). They change with patches, not
// by the hour, so the wiki is asked at most twice a day (Vercel Runtime Cache) and the
// answer is served from the CDN. Prices are NOT here: the app prices cards from GGG's own
// currency exchange feed.
import { getCache } from '@vercel/functions';

export const UA = 'PoBTradeFinder-API/1.0 (contact: https://github.com/Jagomeiister/pob-trade-finder/issues)';
const WIKI = 'https://www.poewiki.net/w/api.php';
const TTL = 12 * 3600;
const PAGE = 500;      // Cargo's maximum rows per query
const AREA_CHUNK = 40; // area ids per IN (...) query

async function cargo(params, fetchImpl) {
  const qs = new URLSearchParams(Object.assign({ action: 'cargoquery', format: 'json' }, params));
  const r = await fetchImpl(WIKI + '?' + qs.toString(), {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('wiki HTTP ' + r.status);
  const d = await r.json();
  if (d.error) throw new Error('wiki: ' + (d.error.info || d.error.code));
  return (d.cargoquery || []).map((x) => x.title);
}

export async function loadDivcards(fetchImpl = fetch) {
  const rows = [];
  for (let offset = 0; offset < 5000; offset += PAGE) {
    const page = await cargo({
      tables: 'items,stackables',
      join_on: 'items._pageID=stackables._pageID',
      fields: 'items.name=name,items.drop_areas=areas,items.drop_enabled=enabled,stackables.stack_size=stack',
      where: 'items.class_id="DivinationCard"',
      order_by: 'items.name',
      limit: String(PAGE),
      offset: String(offset),
    }, fetchImpl);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const ids = [...new Set(rows.flatMap((r) => (r.areas || '').split(',').map((s) => s.trim()).filter(Boolean)))];
  const areas = {};
  for (let i = 0; i < ids.length; i += AREA_CHUNK) {
    const chunk = ids.slice(i, i + AREA_CHUNK).filter((id) => /^[\w-]+$/.test(id)); // ids only, never query text
    if (!chunk.length) continue;
    const found = await cargo({
      tables: 'areas',
      fields: 'areas.id=id,areas.name=name,areas.area_level=lvl,areas.is_map_area=map',
      where: 'areas.id IN (' + chunk.map((id) => '"' + id + '"').join(',') + ')',
      limit: String(PAGE),
    }, fetchImpl);
    for (const a of found) {
      if (!areas[a.id]) areas[a.id] = { name: a.name, lvl: Number(a.lvl) || null, map: a.map === '1' };
    }
  }
  const areaList = Object.keys(areas).sort();
  const index = Object.fromEntries(areaList.map((id, i) => [id, i]));
  const cards = rows.map((r) => {
    const o = { n: r.name, s: Number(r.stack) || 1 };
    const a = (r.areas || '').split(',').map((s) => s.trim()).filter((id) => id in index).map((id) => index[id]);
    if (a.length) o.a = a;
    if (r.enabled !== '1') o.off = 1; // no longer drops
    return o;
  });
  return {
    source: 'Path of Exile Wiki (poewiki.net), CC BY-NC-SA 3.0',
    fetchedAt: new Date().toISOString(),
    areas: areaList.map((id) => Object.assign({ id }, areas[id])),
    cards,
  };
}

const memory = new Map();
function cacheStore() {
  try { return getCache({ namespace: 'pobtf' }); } catch { /* not on Vercel */ }
  return {
    get: async (k) => { const e = memory.get(k); return e && e.until > Date.now() ? e.v : undefined; },
    set: async (k, v, o) => { memory.set(k, { v, until: Date.now() + o.ttl * 1000 }); },
  };
}

function reply(status, body, cdnSeconds) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'public, max-age=' + Math.min(cdnSeconds, 3600),
      'Vercel-CDN-Cache-Control': 'public, s-maxage=' + cdnSeconds + ', stale-while-revalidate=' + cdnSeconds * 2,
    },
  });
}

export async function handleDivcards(request, deps = {}) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length) return reply(400, { error: 'use /api/divcards (no parameters)' }, 300);
  const cache = deps.cache || cacheStore();
  try {
    let data = await cache.get('divcards');
    if (!data) {
      data = await loadDivcards(deps.fetch || fetch);
      if (data.cards.length < 100) throw new Error('wiki returned too few cards (' + data.cards.length + ')');
      await cache.set('divcards', data, { ttl: TTL, name: 'divcards' });
    }
    return reply(200, data, TTL);
  } catch (e) {
    return reply(502, { error: 'drop data unavailable: ' + e.message }, 60);
  }
}

export async function GET(request) {
  return handleDivcards(request);
}
