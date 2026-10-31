// Everything Crystal Mountain — Cloudflare Worker.
// Serves the static site (assets binding) and a small same-origin fetch proxy at /api/proxy so the
// page no longer depends on flaky public CORS proxies for sources that lack CORS headers.
// Only the hosts below can be proxied; responses are cached at Cloudflare's edge for `ttl` seconds.

const ALLOWED_HOSTS = new Set([
  'api.membershipworks.com',      // Enumclaw Chamber events (ICS)
  'wcc.sc.egov.usda.gov',         // NRCS SNOTEL report generator (CSV)
  'wcc.sc.egov.usda.gov.',
  'www.lawsonsfinest.com',        // tap-list JSON (legacy, Sugarbush template)
]);

const UA = 'EverythingCrystalMountain/1.0 (+https://everythingcrystalmountain.brianwhitman71.workers.dev)';

function withCors(res, extra = {}) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET, OPTIONS');
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200) {
  return withCors(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
}

async function proxy(request, url) {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const target = url.searchParams.get('url') || '';
  let t;
  try { t = new URL(target); } catch { return json({ error: 'bad url' }, 400); }
  if (t.protocol !== 'https:' || !ALLOWED_HOSTS.has(t.hostname)) return json({ error: 'host not allowed', host: t.hostname }, 403);
  const ttl = Math.min(3600, Math.max(60, parseInt(url.searchParams.get('ttl') || '300', 10) || 300));
  let upstream;
  try {
    upstream = await fetch(t.href, {
      headers: { 'user-agent': UA, 'accept': '*/*' },
      cf: { cacheTtl: ttl, cacheEverything: true },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e && e.message || e) }, 502);
  }
  const body = await upstream.arrayBuffer();
  const res = new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
      'x-proxy-upstream-status': String(upstream.status),
    },
  });
  return withCors(res);
}

// WSDOT Traveler Information API — mountain pass conditions for the SR-410 corridor.
// Needs the WSDOT_ACCESS_CODE secret (free, registered to Brian's email on 2026-10-30).
const WSDOT_PASS_IDS = { 3: 'chinook', 2: 'cayuse', 5: 'crystal-greenwater' };
async function wsdotPasses(env) {
  if (!env.WSDOT_ACCESS_CODE) return json({ error: 'WSDOT_ACCESS_CODE secret not set' }, 503);
  const api = `https://wsdot.wa.gov/traffic/api/MountainPassConditions/MountainPassConditionsREST.svc/GetMountainPassConditionsAsJson?AccessCode=${encodeURIComponent(env.WSDOT_ACCESS_CODE)}`;
  let upstream;
  try {
    upstream = await fetch(api, { headers: { 'user-agent': UA, 'accept': 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true }, signal: AbortSignal.timeout(15000) });
  } catch (e) { return json({ error: 'wsdot fetch failed', detail: String(e && e.message || e) }, 502); }
  if (!upstream.ok) return json({ error: 'wsdot ' + upstream.status }, 502);
  let list;
  try { list = JSON.parse((await upstream.text()).replace(/^\uFEFF/, '')); } catch { return json({ error: 'wsdot bad json' }, 502); }
  const ms = s => { const m = /\/Date\((\d+)/.exec(s || ''); return m ? +m[1] : null; };
  const passes = (list || []).filter(p => WSDOT_PASS_IDS[p.MountainPassId]).map(p => ({
    id: p.MountainPassId, key: WSDOT_PASS_IDS[p.MountainPassId], name: p.MountainPassName,
    updated: ms(p.DateUpdated), elevFt: p.ElevationInFeet,
    road: p.RoadCondition || '', weather: p.WeatherCondition || '', tempF: p.TemperatureInFahrenheit,
    advisory: !!p.TravelAdvisoryActive,
    restrictions: [p.RestrictionOne, p.RestrictionTwo].filter(r => r && r.RestrictionText).map(r => ({ dir: r.TravelDirection, text: r.RestrictionText })),
  }));
  const res = new Response(JSON.stringify({ fetched: Date.now(), passes }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
  return withCors(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // www -> apex, permanent. Done here because the API token cannot write zone redirect rules;
    // run_worker_first is true in wrangler.jsonc so this sees every request, not just /api/*.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api/proxy') return proxy(request, url);
    if (url.pathname === '/api/wsdot/passes') return wsdotPasses(env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
