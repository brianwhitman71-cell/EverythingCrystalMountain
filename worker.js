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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/proxy') return proxy(request, url);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
