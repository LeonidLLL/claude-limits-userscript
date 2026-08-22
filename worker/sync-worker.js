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
//
// v3: closes the server side of the contract the client already enforces — a key
// whitelist (isSyncable) instead of merging whatever keys happen to show up, and a
// per-item shape filter inside each merge function (a non-numeric t would otherwise sort
// as NaN and scramble ordering unpredictably). Neither fires today since the client only
// ever sends well-formed data, which is exactly why they're easy to lose track of —
// they're for whatever adds a new key or a malformed client six months from now.
//
// v4: every filter above drops silently — a 200 with an empty-looking hist.session gives
// no way to tell "nothing was sent", "the key isn't whitelisted", "shape check failed",
// "collapsed as a near-duplicate" and "aged out past KEEP" apart. The POST response now
// carries a `sync` block with those counts (per reason, plus a per-key breakdown) so a
// stuck sync is diagnosable from the response alone. `hist` itself is untouched — this is
// additive, the old `{ hist }` shape still round-trips through anything reading only that.

const KEEP = {
  session: 30 * 86400e3,
  weekly_all: 90 * 86400e3,
  spend: 62 * 86400e3,
  promo_left: 62 * 86400e3,
  pairs: 90 * 86400e3,
};
// Server-side half of the contract, mirroring the client's sanitizeHist(): only these
// keys (plus dynamic slot_* sub-limits — Opus/Sonnet/Cowork/Fable, present only once a
// model wakes a sub-limit, so they can't be enumerated up front) are ever read from or
// written to KV. Without this, the merge loop iterated every key present on either side,
// so 'blocks' (a different {start,end} shape entirely) or any future unknown key would
// pass straight through — the client-side whitelist alone isn't a contract, just one
// implementation's opinion.
const SYNCABLE_BASE = ['session', 'weekly_all', 'spend', 'promo_left', 'pairs'];
function isSyncable(k) { return SYNCABLE_BASE.includes(k) || k.startsWith('slot_'); }
const CORS = {
  'Access-Control-Allow-Origin': 'https://claude.ai',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

// Shared merge/dedup/expiry pipeline for both point shapes below. `wellFormed` is the
// per-item shape check, `sameValue` decides whether two same-second entries count as a
// duplicate (points compare .p; pairs have no natural "same value" so always collapse).
// Every incoming item is bucketed into exactly one outcome — accepted, malformed (failed
// wellFormed), duplicate (collapsed against a same-window entry) or expired (older than
// `keep` after the merge) — via reference identity through the filter/sort/dedupe/cut
// pipeline, since none of those steps clone the objects.
function classify(a, b, keep, wellFormed, sameValue) {
  const stored = a || [], incoming = b || [];
  const incomingValid = new Set(incoming.filter(wellFormed));
  const malformed = incoming.length - incomingValid.size;

  const all = [...stored, ...incoming].filter(wellFormed).sort((x, y) => x.t - y.t);

  const deduped = [];
  for (const p of all) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(p.t - last.t) < 60000 && sameValue(last, p)) continue;
    deduped.push(p);
  }

  const cut = Date.now() - keep;
  const out = deduped.filter(p => p.t >= cut);

  const dedupedSet = new Set(deduped), outSet = new Set(out);
  let accepted = 0, duplicate = 0, expired = 0;
  for (const item of incomingValid) {
    if (outSet.has(item)) accepted++;
    else if (dedupedSet.has(item)) expired++;
    else duplicate++;
  }

  return { out, stats: { received: incoming.length, accepted, malformed, duplicate, expired } };
}

// {t,p} shape — collapse near-duplicate samples of the same reading.
function mergePoints(a, b, keep) {
  return classify(a, b, keep,
    p => p && typeof p.t === 'number' && typeof p.p === 'number',
    (x, y) => x.p === y.p);
}

// {t,ds,dw} shape — no value to compare, dedup on t alone
function mergePairs(a, b, keep) {
  return classify(a, b, keep,
    p => p && typeof p.t === 'number' && typeof p.ds === 'number' && typeof p.dw === 'number',
    () => true);
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
      const incomingKeys = Object.keys(incoming);
      const out = {};
      const by_key = {};
      const rejected_by = { unsyncable_key: 0, bad_shape: 0, duplicate: 0, expired: 0 };

      // Keys the client sent that aren't on the whitelist never reach merge() at all —
      // count them here or they'd vanish from the diagnostic the same way they vanish
      // from hist.
      for (const k of incomingKeys) {
        if (isSyncable(k)) continue;
        const n = Array.isArray(incoming[k]) ? incoming[k].length : 0;
        rejected_by.unsyncable_key += n;
      }

      const keys = new Set([...SYNCABLE_BASE, ...Object.keys(stored), ...incomingKeys].filter(isSyncable));
      let received = rejected_by.unsyncable_key, accepted = 0;
      for (const k of keys) {
        const { out: mergedArr, stats } = merge(k, stored[k], incoming[k], KEEP[k] || KEEP.weekly_all);
        out[k] = mergedArr;
        by_key[k] = stats;
        received += stats.received;
        accepted += stats.accepted;
        rejected_by.bad_shape += stats.malformed;
        rejected_by.duplicate += stats.duplicate;
        rejected_by.expired += stats.expired;
      }

      const sync = {
        received, accepted,
        rejected: rejected_by.unsyncable_key + rejected_by.bad_shape + rejected_by.duplicate + rejected_by.expired,
        rejected_by, by_key,
      };

      await env.HIST.put('hist', JSON.stringify(out));
      return Response.json({ hist: out, sync }, { headers: CORS });
    }
    return new Response('method not allowed', { status: 405, headers: CORS });
  },
};
