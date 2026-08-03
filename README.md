# Claude Limits

A minimal Tampermonkey userscript that shows your Claude usage limits at a glance,
without opening the Usage page.

The 5-hour session window is the limit that actually interrupts your work, so it gets
the whole top of the panel. Everything else — the weekly limit and monthly credit
spend — is one line each. There are no charts: if you need detail, the Usage page
already has it.

## What it shows

**Badge** (always visible, draggable)
The session reset time and how much of the window is used: `15:50 · 10%`.
The colour tells you the state without opening anything.

**Panel** (click the badge)

- **5-hour window** — a progress ring, time left until reset, and the reset time.
  Ring colour: green below 65%, yellow 65–75%, orange 75–85%, red above 85%.
- **Week · all models** — percentage used, an even-pace marker on the bar, faint
  ticks for day boundaries, and how far ahead or behind that pace you are.
- **Credits · month** — spent against your monthly spend limit, your account
  balance, and how much of it is promotional credit with an expiry date.

Per-model weekly sub-limits (Opus, Sonnet, Cowork, Fable) appear only when they have
actual usage. On most plans they stay dormant and the rows never render.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [claude-limits.user.js](https://raw.githubusercontent.com/LeonidLLL/claude-limits-userscript/main/claude-limits.user.js).
3. Tampermonkey will offer to install it. Accept.
4. Open [claude.ai](https://claude.ai) — the badge appears in the lower right.

Installing from the raw URL matters: it wires up `@updateURL`, so Tampermonkey checks
for new versions daily. A script pasted in by hand never updates.

## How the numbers are derived

Session and weekly figures come from the same internal endpoint the Usage page uses,
polled every five minutes and refreshed whenever the page fetches it on its own.

The balance and promotional credit are read from the Usage page — either from the
billing API response or, failing that, from the page itself. Between visits to that
page the promo figure is kept current by subtracting spend recorded since the
snapshot, so it does not drift.

### The pace marker

The bright vertical line on the weekly and monthly bars is where usage would be if
you spent evenly across the window. Fill to the left of it means headroom; fill to
the right means you are burning faster than the window allows. The small number next
to the row name is the gap, in percent for quota and in dollars for credits.

### When it warns

Only the risk of running out *before* a reset is worth an alert. Finishing a week at
85% is headroom, not a problem — unused quota expires either way. So a status line
appears only when the projection actually crosses 100% before the reset, when the
last 24 hours are running hot enough to change that projection, or when the
projected headroom drops under 10 points. Otherwise the row stays quiet.

Promotional credits get one extra check. They are ordinary usage credits — they pay
for premium models and for overage beyond plan limits — but they expire on a fixed
date, and your monthly spend limit caps how much of them you can draw down before
then. If the two do not fit together, the widget says how much will expire and what
the limit would need to be. That warning stays silent unless the shortfall is over
$10 and over 10% of the remaining promo, so rounding noise never triggers it.

## Privacy

Everything runs locally in your browser. Nothing is sent anywhere. State — usage
history, badge position, panel open/closed — lives in `localStorage` under
`clt25_state`. The organisation ID is read from your session at runtime and is not
stored in the source.

## Compatibility

Chrome with Tampermonkey, tested on the English claude.ai interface. Other
Chromium browsers should work. The DOM fallback for balance and promo looks for
English labels on the Usage page; on other interface languages the API path still
works.

## Licence

MIT
