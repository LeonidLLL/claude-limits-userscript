// Cloudflare Worker for claude-limits-userscript history sync.
// Deploy via the Cloudflare dashboard (Workers & Pages -> Create -> paste this in),
// bind a KV namespace named HIST, and set the TOKEN environment variable.
// See ../docs/TZ-sync-etap9.md for the protocol this implements.
//
// v2: adds the 'pairs' key ({t, ds, dw} — session/weekly delta pairs for the weekly-
// ceiling regression, stage 7). Its shape has no natural "same value" to dedup on like
// {t,p} points do, so it gets its own merge function instead of being forced through
// mergePoints() (which would compare .p on entries that don't have one, at best a no-op,
// at worst silently coalescing distinct pairs that happen to land within 60s of each other).

const KEEP = {
  session: 30 * 86400e3,
  weekly_all: 90 * 86400e3,
  spend: 62 * 86400e3,
  promo_left: 62 * 86400e3,
  pairs: 90 * 86400e3,
};
const CORS = {
  'Access-Control-Allow-Origin': 'https://claude.ai',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// {t,p} shape — collapse near-duplicate samples of the same reading
function mergePoints(a, b, keep) {
  const all = [...(a || []), ...(b || [])].sort((x, y) => x.t - y.t);
  const out = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.t - last.t) < 60000 && last.p === p.p) continue;
    out.push(p);
  }
  const cut = Date.now() - keep;
  return out.filter(p => p.t >= cut);
}

// {t,ds,dw} shape — no value to compare, dedup on t alone
function mergePairs(a, b, keep) {
  const all = [...(a || []), ...(b || [])].sort((x, y) => x.t - y.t);
  const out = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.t - last.t) < 60000) continue;
    out.push(p);
  }
  const cut = Date.now() - keep;
  return out.filter(p => p.t >= cut);
}

function merge(key, a, b, keep) {
  return key === 'pairs' ? mergePairs(a, b, keep) : mergePoints(a, b, keep);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.headers.get('authorization') !== 'Bearer ' + env.TOKEN)
      return new Response('unauthorized', { status: 401, headers: CORS });

    const stored = JSON.parse(await env.HIST.get('hist') || '{}');
    if (req.method === 'GET')
      return Response.json({ hist: stored }, { headers: CORS });

    if (req.method === 'POST') {
      const body = await req.json();
      const incoming = body.hist || {};
      const out = {};
      for (const k of new Set([...Object.keys(stored), ...Object.keys(incoming)]))
        out[k] = merge(k, stored[k], incoming[k], KEEP[k] || KEEP.weekly_all);
      await env.HIST.put('hist', JSON.stringify(out));
      return Response.json({ hist: out }, { headers: CORS });
    }
    return new Response('method not allowed', { status: 405, headers: CORS });
  },
};
