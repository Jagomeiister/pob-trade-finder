// GET /api/health — liveness check for PoB Trade Finder's backend.
export function GET() {
  return Response.json({ ok: true, service: 'pobtf-api', endpoints: ['/api/prices?league=<league id>'] },
    { headers: { 'Cache-Control': 'no-store' } });
}
