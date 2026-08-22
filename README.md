# Claude Limits

A Tampermonkey userscript that shows your Claude usage limits at a glance, without
opening the Usage page — the 5-hour session window front and center, the weekly
limit and monthly credit spend one line each, with activity-aware forecasting and
inline charts.

## What it shows

**Badge** (always visible, draggable)
The session reset time and how much of the window is used: `15:50 · 10%`.
The colour tells you the state without opening anything.

**Panel** (click the badge) — three view modes, cycled by clicking the panel title:

- **compact** (~280px) — the original minimal view: ring, bars, one line each.
- **expanded** (~420px) — compact plus the norm/pace line, the weekly forecast
  chart, and a chart of the current 5-hour window.
- **wide** (700–1100px, 2 or 4 columns depending on window width) — the same
  information laid out horizontally: 5-hour window / Week / Forecast / Credits.
  This is the mode worth using on a large monitor or a tablet in desktop mode —
  it's shorter, not just wider, which matters when the panel has to fit inside a
  window instead of scrolling.

Below 700px window width the panel always falls back to compact, regardless of
which mode is selected — there isn't room for anything else.

## How the numbers are derived

Session and weekly figures come from the same internal endpoint the Usage page
uses, polled every five minutes and refreshed whenever the page fetches it on its
own.

The balance and promotional credit are read from the Usage page — either from the
billing API response or, failing that, from the page itself. Between visits to that
page the promo figure is kept current by subtracting spend recorded since the
snapshot, so it does not drift.

### Activity-aware forecasting

The weekly limit isn't spread evenly across the calendar — it's spread across an
activity profile: work hours only (configurable, defaults to 7:00–21:00 local time,
Mon–Fri at full weight, weekends at reduced weight), with any stretch where the
5-hour window is exhausted subtracted from what's left. That profile drives:

- **norm** — the %/active-hour needed to land exactly on the limit at reset, shown
  next to the weekly row once there's enough active time left to compute it.
- **pace** — the actual rate over the last 3 active hours, shown once there's
  enough history to trust it (20% of the week elapsed, or 2 weeks of accumulated
  history — whichever comes first).
- the even-pace marker on the bar, and the plan curve on the forecast chart.

Uncertainty produces silence, not an alarm: a status line only appears once the
forecast is trustworthy, and only when the current pace is meaningfully ahead of
the norm (not just reaching 80–90% at reset — unused quota expires either way, so
that alone isn't a problem).

### Charts

Inline SVG, no external libraries — CSP on claude.ai blocks `@require` anyway. The
weekly forecast chart plots the accumulated fact against the activity-profile
curve, with a "now" marker and hatching over any blocked (session-exhausted)
stretches. The 5-hour chart is scoped to the current window only — not a rolling
sparkline across old, already-reset cycles, which reads as noise rather than
signal.

### Promo warning

Promotional credits are ordinary usage credits — they pay for premium models and
overage beyond plan limits — but they expire on a fixed date, and the monthly spend
limit caps how much of them can be drawn down before then. If the two don't fit
together, the widget says how much will expire and what the limit would need to
be. Silent unless the shortfall is over $10 and over 10% of the remaining promo.

## Cross-device sync (optional)

`S.hist` lives in `localStorage`, which is per-device. If you use Claude from more
than one device, the ⇄ button opens a small form for a sync endpoint URL and
token — a small self-hosted server (a Cloudflare Worker reference implementation is
in [`worker/sync-worker.js`](worker/sync-worker.js); see
[`docs/TZ-sync-etap9.md`](docs/TZ-sync-etap9.md) for the protocol) that merges
history from every device that pushes to it. Off by default; nothing leaves the
browser unless a URL and token are configured. Sync runs every 15 minutes and on
startup, fails silently on network/auth errors (shown as `sync: offline` in the
footer, never thrown as an exception), and always calls the endpoint directly via
the browser's native `fetch` — never through anything the script itself
intercepts.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [claude-limits.user.js](https://raw.githubusercontent.com/LeonidLLL/claude-limits-userscript/main/claude-limits.user.js).
3. Tampermonkey will offer to install it. Accept.
4. Open [claude.ai](https://claude.ai) — the badge appears in the lower right.

Installing from the raw URL matters: it wires up `@updateURL`, so Tampermonkey
checks for new versions. A script pasted in by hand never updates.

## Privacy

Everything runs locally in your browser by default. State — usage history, badge
position, panel mode, sync settings — lives in `localStorage` under `clt25_state`.
The organisation ID is read from your session at runtime and is not stored in the
source. Nothing is sent anywhere *unless you configure sync yourself*, in which
case history (not org ID, not balance, not raw API responses) is sent to the
endpoint you provided, and only there.

## Testing the 8-hour leak scenario

Not automated — this is a manual DevTools pass, done once in a while rather than on
every change. Reproduce it like this:

1. Open claude.ai with the script active, open DevTools → **Memory**.
2. Take a heap snapshot right after the badge appears (baseline).
3. Leave the tab open for ~8 hours — normal use is fine, it doesn't need to be idle.
   The panel only needs to be opened/closed a few times over that period; it doesn't
   need to stay open.
4. Take another snapshot (or a few, spaced out) and compare against the baseline —
   the snapshot comparison view groups by constructor and shows retained-size deltas
   directly.

**What should stay flat:**

- **DOM node count** (Memory panel's summary, or the Elements panel's node counter).
  `render()` always does `panel.innerHTML = ...` — a full wholesale replacement, not
  an append — so old nodes should be released every render (every 20s, plus after
  every poll/sync). If the node count trends upward over the 8 hours instead of
  oscillating around a constant, something is retaining old panel content.
- **Detached DOM tree count**, in the snapshot's summary view. This is the specific
  signal for "nodes were removed from the document but something still references
  them" — normally a closure holding an old element. Since every `onclick` handler
  is reassigned fresh on each `render()` and nothing stores element references
  outside of `render()`'s own local scope, this should sit at zero.
- **Event listener count** (Elements panel → Event Listeners, on `window` and
  `document`). Everything is registered once in `start()`/`buildUI()` — poll and
  sync intervals, `visibilitychange`, `resize`, and the badge's drag handlers
  (`mousedown`/`mousemove`/`mouseup`) — never inside `render()`. This count should
  be identical at hour 0 and hour 8.
- **Active timers**: exactly three `setInterval`s (poll every 5 min, sync every 15
  min, render every 20s) plus the debounced `resize` handler's single in-flight
  `setTimeout` at most. Nothing in the code path creates more of these over time.

**What's expected to grow, and isn't a leak:** the JS heap size itself, slowly and
boundedly — `S.hist.*` (session, weekly_all, spend, promo_left, pairs, blocks, and
any active `slot_*` sub-limits) only ever grows within a single 8-hour window, since
the `KEEP` retention windows (30–90 days) don't start trimming anything that
recently. Each stored point is a tiny `{t,p}` (or `{t,ds,dw}`, or `{start,end}`)
object, so even the busiest key adding a point every 5 minutes for 8 hours is under
a hundred entries — this should read as a small, linear, unremarkable increase, not
an accelerating one. If total heap growth over 8 hours looks disproportionate to
that (megabytes rather than tens of kilobytes), look at DOM/listener/timer counts
first — a genuine `S.hist` sizing problem would show up in `localStorage` usage
(and the `⚠ storage` footer indicator) long before it shows up as a memory leak.

## Compatibility

Chrome + Tampermonkey on Windows, and Firefox Android + Tampermonkey (tested in
desktop mode on a tablet, landscape) are the two configurations this is actively
used and tested on. Other Chromium browsers should work. The DOM fallback for
balance and promo looks for English labels on the Usage page; on other interface
languages the API path still works. UI is bilingual (EN/RU), switchable from the
panel.

## Licence

MIT
