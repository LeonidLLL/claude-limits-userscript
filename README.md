# Claude Limits

A Tampermonkey userscript that shows your Claude usage limits at a glance, without
opening the Usage page. It answers one question: *can I send this message now, and
what will it cost.* No forecast of "when will I run out" — that question isn't
useful, so it isn't answered.

## What it shows

**Badge** (always visible, draggable) — the 5-hour session reset time and how much
of the window is used: `15:50 · 10%`. The colour comes straight from the server's
own `severity` field.

**Panel** (click the badge) — four lines, no charts, no view modes:

```
5-hour     53%          resets in 2:19
Weekly     52%          resets in 17:00
Credits    $30.05 / $50.00   (60%)
Headroom   $19.95 until Sep 1
```

- **5-hour** / **Weekly** and anything else the server adds to its `limits` array
  — new limit kinds appear as their own line automatically, no code change needed.
- **Credits** — this month's spend against the plan's extra-usage limit.
- **Headroom** — `limit − used`, the direct answer to "how much room is left before
  the plan starts charging." This is the number the widget exists for.
- A line for credits appears only when something is abnormal: credits turned off,
  the monthly spend limit reached, or credits disabled manually.

Countdowns are computed locally from the `resets_at` timestamps and tick every few
seconds — they keep going even if the network drops, and the whole widget dims
once the underlying data is more than 10 minutes old.

### Fail-loud

If the response doesn't match the expected shape (missing `limits`, missing
`spend.used.amount_minor`, a non-numeric exponent), the panel shows `⚠ schema
changed` instead of any numbers — including old ones already on screen. A stale or
wrong number is worse than no number.

## How the numbers are derived

Everything comes from one endpoint:

```
GET /api/organizations/{org_uuid}/usage
```

`org_uuid` is never hardcoded — it's read out of the URL of whatever API request
the page makes first, and cached. Two paths feed the widget: a **passive** listener
on every `/usage` response the page itself triggers (free), and an **active** poll
via the same URL every 60 seconds while the tab is visible (5 minutes while
hidden). A passive update resets the active timer, so the two never double up.

Money fields (`amount_minor` / `exponent`) are converted as `amount_minor /
10^exponent` — never parsed from formatted strings. Percentages for plan limits
come from the server's `limits[]` array (already rounded); `extra_usage`'s
utilization is a genuine float and is left as-is.

## Cross-device sync (off by default)

`S.hist` lives in `localStorage`, which is per-device. Since the widget itself
never reads history back for anything shown on screen, sync — and the local
history collection that feeds it — is inert until you turn it on: no timer, no
requests, nothing written to `S.hist`.

If you do use Claude from more than one device, the ⇄ button opens a small form
for a sync endpoint URL and token. Saving turns sync on; a small self-hosted
server (a Cloudflare Worker reference implementation is in
[`worker/sync-worker.js`](worker/sync-worker.js); see
[`docs/TZ-sync-etap9.md`](docs/TZ-sync-etap9.md) for the protocol) then merges
history from every device that pushes to it. **Disable** erases the stored URL
and token outright — turning sync back on later means re-entering them, which the
form tells you before you click it. Sync runs every 15 minutes and on startup
while enabled, fails silently on network/auth errors (shown as `sync: offline` in
the footer, never thrown as an exception), and always calls the endpoint directly
via the browser's native `fetch` — never through anything the script itself
intercepts.

This history also feeds [`lib/ceiling.js`](lib/ceiling.js) (an unwired,
tested-but-unused weekly-ceiling estimator kept around for a possible future
stage) once sync is on — the widget itself never reads it back for anything shown
on screen.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [claude-limits.user.js](https://raw.githubusercontent.com/LeonidLLL/claude-limits-userscript/main/claude-limits.user.js).
3. Tampermonkey will offer to install it. Accept.
4. Open [claude.ai](https://claude.ai) — the badge appears in the lower right.

Installing from the raw URL matters: it wires up `@updateURL`, so Tampermonkey
checks for new versions. A script pasted in by hand never updates.

## Privacy

Everything runs locally in your browser by default. State — usage history, badge
position, sync settings — lives in `localStorage` under `clt25_state`. The
organisation ID is read from your session at runtime and is not stored in the
source. Nothing is sent anywhere *unless you configure sync yourself*, in which
case history (not org ID, not raw API responses) is sent to the endpoint you
provided, and only there.

## Testing

Node.js, no framework — plain `node:assert`:

```
node test/parse.test.js
node test/ceiling.test.js
```

`test/parse.test.js` exercises `parseUsage()` against a real captured response
(`test/fixtures/usage-2026-08-23.json`, org id redacted) plus the fail-loud paths:
a missing `limits` array, a missing `spend.used.amount_minor`, a non-numeric
exponent, and an unknown `limits[].kind` that must not crash the parser.

## Compatibility

Chrome + Tampermonkey on Windows, and Firefox Android + Tampermonkey (tested in
desktop mode on a tablet, landscape) are the two configurations this is actively
used and tested on. Other Chromium browsers should work. UI is bilingual (EN/RU),
switchable from the panel.

## Licence

MIT
