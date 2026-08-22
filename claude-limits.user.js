// ==UserScript==
// @name         Claude Limits
// @namespace    lisin.claude.limits
// @version      29.8
// @description  Claude usage tracker (EN/RU): the 5-hour window front and center, weekly limit and credits on one line each, with activity-aware forecasting and SVG charts. Full detail lives on the Usage page.
// @homepageURL  https://github.com/LeonidLLL/claude-limits-userscript
// @supportURL   https://github.com/LeonidLLL/claude-limits-userscript/issues
// @updateURL    https://raw.githubusercontent.com/LeonidLLL/claude-limits-userscript/main/claude-limits.user.js
// @downloadURL  https://raw.githubusercontent.com/LeonidLLL/claude-limits-userscript/main/claude-limits.user.js
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  /* ================= CONFIG ================= */
  const VERSION = '29.8';
  const POLL_MINUTES = 5;
  const PROMO_GRANT = 100;              // original promotional grant size, $
  const LS_KEY = 'clt25_state';         // legacy key — keeps history and badge position across upgrades
  const SESSION_WINDOW_MS = 5 * 3600e3;
  const WEEK_WINDOW_MS = 7 * 86400e3;
  const DEDUP_MS = 20 * 60e3;
  const AVG_RATE_GATE_FRAC = 0.20;      // hide the weekly forecast before this fraction of the window has elapsed...
  const MIN_HISTORY_FOR_FORECAST = 14 * 86400e3; // ...unless this much history has already accumulated
  const KEEP = { session: 30 * 86400e3, weekly: 90 * 86400e3, spend: 62 * 86400e3, promo_left: 62 * 86400e3 };
  // activity profile — user-specific, not universal. Local time, matches the browser's clock.
  const WORK_START = 7, WORK_END = 21;  // work window, hours
  const WEEKEND_WEIGHT = 0.15;          // Sat/Sun inside the work window count at this weight
  const SESSION_BLOCK_PCT = 97;         // session considered exhausted (blocking work) at/above this pct
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFs2lUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNS41LjAiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iCiAgICB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIKICAgZXhpZjpDb2xvclNwYWNlPSIxIgogICBleGlmOlBpeGVsWERpbWVuc2lvbj0iNjQiCiAgIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSI2NCIKICAgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIKICAgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIgogICB0aWZmOkltYWdlTGVuZ3RoPSI2NCIKICAgdGlmZjpJbWFnZVdpZHRoPSI2NCIKICAgdGlmZjpSZXNvbHV0aW9uVW5pdD0iMiIKICAgdGlmZjpYUmVzb2x1dGlvbj0iNzIvMSIKICAgdGlmZjpZUmVzb2x1dGlvbj0iNzIvMSIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0w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';

  /* ================= STATE ================= */
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function saveState() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
  const S = Object.assign({ orgId: null, last: null, lastT: 0, hist: {}, ui: { open: false, pos: null }, balance: null, promo: null, sync: null }, loadState());
  if (!S.hist) S.hist = {};
  if (!S.ui) S.ui = { open: false, pos: null };
  if (!S.sync) S.sync = { url: null, token: null, lastOk: null, ok: null };
  if (!S.ui.mode) S.ui.mode = 'compact';   // compact stays the default — it's what works on a phone
  // first run: follow the browser language, then remember whatever the user picks
  if (!S.ui.lang) S.ui.lang = /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';

  /* ================= I18N ================= */
  // UI strings only. Code and comments stay English so the repo is contributor-friendly.
  const I18N = {
    en: {
      code: 'EN',
      hero: '5-hour window', notStarted: 'not started', beginsWith: 'begins with your first message',
      resetsAt: t => 'resets at ' + t, windowIdle: 'window idle',
      noData: 'no data', pressRefresh: 'press ↻',
      weekAll: 'Week · all models', weekPrefix: 'Week · ', fableShare: 'Fable 5 · share',
      creditsMonth: 'Credits · month',
      rowResets: (day, time, left) => 'resets ' + day + ' ' + time + ' · in ' + left,
      balance: v => 'balance $' + v, spendResets: d => 'resets ' + d,
      inclPromo: (v, d) => 'incl. promo $' + v + ' · expires ' + d,
      promoWarn: (cap, left, day, lost, need) =>
        '⚠ only $' + cap + ' of your $' + left + ' promo can be spent before ' + day +
        ' — $' + lost + ' will expire. Raise the spend limit to $' + need + '/mo',
      onPace: 'on pace', evenPace: v => 'even pace: ' + v,
      spendNearLimit: 'monthly spend limit nearly exhausted',
      exhausted: left => 'exhausted, resets in ' + left,
      runsOut: (day, time) => 'runs out ' + day + ' ~' + time + ', short of the reset',
      paceAhead: r => 'pace ' + r + '× the norm',
      expiresUnused: (pct, day, time) => pct + '% left will expire ' + day + ' ' + time,
      normBase: (norm, windows) => 'norm ' + norm + '%/active-h · ~' + windows + ' 5h windows left',
      paceSuffix: p => ' · pace ' + p + '%/active-h',
      fullDetail: 'Full detail → Usage',
      tipRefresh: 'Refresh', tipCollapse: 'Collapse', tipLang: 'Switch language',
      tipSync: 'Sync settings', syncUrlPh: 'Sync URL', syncTokenPh: 'Sync token',
      syncSave: 'Save', syncClear: 'Disable', syncCancel: 'Cancel',
      syncOffline: 'sync: offline', syncAgo: t => 'sync: ' + t,
      tipMode: 'Click to switch view: compact / expanded / wide',
      colSession: '5-hour window', colWeek: 'Week', colForecast: 'Forecast', colCredits: 'Credits',
      tipBadge: '5-hour window — click for detail, drag to move',
      noOrg: 'orgId not detected — open any chat', error: e => 'Error: ' + e,
      days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      today: 'today', tomorrow: 'tomorrow',
      dur: (d, h, m) => d > 0 ? d + 'd ' + h + 'h' : (h > 0 ? h + 'h ' + m + 'm' : m + 'm'),
      justNow: 'just now', minAgo: m => m + ' min ago', hourAgo: h => h + ' h ago'
    },
    ru: {
      code: 'RU',
      hero: 'окно 5 ч', notStarted: 'не начато', beginsWith: 'стартует с первого сообщения',
      resetsAt: t => 'сброс в ' + t, windowIdle: 'окно не начато',
      noData: 'нет данных', pressRefresh: 'нажми ↻',
      weekAll: 'Неделя · все модели', weekPrefix: 'Неделя · ', fableShare: 'Fable 5 · доля',
      creditsMonth: 'Кредиты · месяц',
      rowResets: (day, time, left) => 'сброс ' + day + ' ' + time + ' · через ' + left,
      balance: v => 'баланс $' + v, spendResets: d => 'сброс ' + d,
      inclPromo: (v, d) => 'из них промо $' + v + ' · сгорает ' + d,
      promoWarn: (cap, left, day, lost, need) =>
        '⚠ до ' + day + ' успеешь потратить только $' + cap + ' из $' + left +
        ' промо — сгорит $' + lost + '. Лимит трат надо поднять до $' + need + '/мес',
      onPace: 'по плану', evenPace: v => 'равномерный план: ' + v,
      spendNearLimit: 'месячный лимит трат почти выбран',
      exhausted: left => 'исчерпан, сброс через ' + left,
      runsOut: (day, time) => 'кончится ' + day + ' ~' + time + ', до сброса не хватит',
      paceAhead: r => 'темп ' + r + '× от нормы',
      expiresUnused: (pct, day, time) => 'остаток ' + pct + '% сгорит ' + day + ' ' + time,
      normBase: (norm, windows) => 'норма ' + norm + '%/акт.ч · ~' + windows + ' окон по 5ч',
      paceSuffix: p => ' · темп ' + p + '%/акт.ч',
      fullDetail: 'Подробности → Usage',
      tipRefresh: 'Обновить', tipCollapse: 'Свернуть', tipLang: 'Переключить язык',
      tipSync: 'Настройки синхронизации', syncUrlPh: 'URL синхронизации', syncTokenPh: 'Токен синхронизации',
      syncSave: 'Сохранить', syncClear: 'Выключить', syncCancel: 'Отмена',
      syncOffline: 'синхр.: офлайн', syncAgo: t => 'синхр.: ' + t,
      tipMode: 'Клик — переключить вид: compact / expanded / wide',
      colSession: 'Окно 5ч', colWeek: 'Неделя', colForecast: 'Прогноз', colCredits: 'Кредиты',
      tipBadge: '5-часовое окно — клик: детали, перетаскивание: переместить',
      noOrg: 'orgId не определён — открой любой чат', error: e => 'Ошибка: ' + e,
      days: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
      today: 'сегодня', tomorrow: 'завтра',
      dur: (d, h, m) => d > 0 ? d + 'д ' + h + 'ч' : (h > 0 ? h + 'ч ' + m + 'м' : m + 'м'),
      justNow: 'только что', minAgo: m => m + ' мин назад', hourAgo: h => h + ' ч назад'
    }
  };
  function L() { return I18N[S.ui.lang] || I18N.en; }
  function toggleLang() { S.ui.lang = (S.ui.lang === 'ru') ? 'en' : 'ru'; saveState(); render(); }

  /* ================= DATA CAPTURE ================= */
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    try {
      const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
      if (m && S.orgId !== m[1]) { S.orgId = m[1]; saveState(); }
      if (/\/api\/organizations\/[0-9a-f-]{36}\/usage(\?|$)/i.test(url)) {
        p.then(r => { if (r.ok) r.clone().json().then(ingest).catch(() => {}); }).catch(() => {});
      } else if (/\/api\/.*(billing|credit|prepaid|wallet|balance|promo)/i.test(url)) {
        p.then(r => {
          if (r.ok && (r.headers.get('content-type') || '').indexOf('json') >= 0)
            r.clone().json().then(ingestCredits).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  function detectOrg() {
    if (S.orgId) return S.orgId;
    const c = document.cookie.match(/lastActiveOrg=([0-9a-f-]{36})/i);
    if (c) { S.orgId = c[1]; saveState(); return S.orgId; }
    return null;
  }

  let polling = false;
  async function poll(manual) {
    if (polling) return;
    polling = true; setBadgeSpin(true); scanDOM();
    try {
      const org = detectOrg();
      if (!org) { if (manual) toast(L().noOrg); polling = false; setBadgeSpin(false); return; }
      const r = await origFetch(`/api/organizations/${org}/usage`, { headers: { accept: 'application/json' }, credentials: 'include' });
      if (r.ok) ingest(await r.json());
      else if (manual) toast('usage: HTTP ' + r.status);
    } catch (e) { if (manual) toast(L().error(e.message)); }
    polling = false; setBadgeSpin(false);
  }

  function pushHist(key, val) {
    const arr = S.hist[key] = S.hist[key] || [];
    const prev = arr[arr.length - 1], now = Date.now();
    if (!prev || prev.p !== val || now - prev.t > DEDUP_MS) arr.push({ t: now, p: val });
    const keep = KEEP[key] || KEEP.weekly;
    while (arr.length && arr[0].t < now - keep) arr.shift();
  }

  function ingest(data) {
    if (!data || typeof data !== 'object') return;
    S.last = data; S.lastT = Date.now();
    const items = extract(data);
    for (const it of items) pushHist(it.key, it.pct);
    recordBlock(items.find(i => i.key === 'session'));
    saveState(); render();
  }

  /* ================= ACTIVITY PROFILE ================= */
  // weight of the instant t: 1.0 Mon-Fri inside the work window, WEEKEND_WEIGHT Sat/Sun
  // inside it, 0 outside. Uses the browser's local clock — assumes it matches the work timezone.
  function actWeight(t) {
    const d = new Date(t), h = d.getHours() + d.getMinutes() / 60;
    if (h < WORK_START || h >= WORK_END) return 0;
    const day = d.getDay();
    return (day === 0 || day === 6) ? WEEKEND_WEIGHT : 1;
  }

  // activity-weighted hours between two timestamps (a <= b), 15-min numeric integration —
  // simple and accurate enough; work-window edges only ever fall on the hour.
  function activeHours(a, b) {
    if (!(b > a)) return 0;
    const STEP = 15 * 60e3;
    let total = 0, t = a;
    while (t < b) {
      const next = Math.min(t + STEP, b);
      total += actWeight((t + next) / 2) * (next - t) / 3600e3;
      t = next;
    }
    return total;
  }

  // walk back from `to` until `hours` of activity-weighted time have accumulated
  function activeHoursAgo(to, hours) {
    const STEP = 15 * 60e3, floor = to - 30 * 86400e3; // 30-day safety cap
    let acc = 0, t = to;
    while (acc < hours && t > floor) {
      const prev = Math.max(t - STEP, floor);
      acc += actWeight((prev + t) / 2) * (t - prev) / 3600e3;
      t = prev;
    }
    return t;
  }

  // n+1 evenly spaced points of the activity-weighted plan curve across [start, end] —
  // the curve planPct() reads a single point off of
  function activityProfileCurve(start, end, n) {
    const total = activeHours(start, end), out = [];
    for (let i = 0; i <= n; i++) {
      const t = start + (end - start) * i / n;
      out.push({ t, pct: total > 0 ? activeHours(start, t) / total * 100 : 0 });
    }
    return out;
  }

  /* ================= BLOCKS ================= */
  // remember when the 5-hour window was exhausted — needed for honest weekly stats
  // (the weekly-ceiling regression in a later stage excludes blocked stretches)
  function recordBlock(sess) {
    if (!sess || sess.idle || !sess.resetAt || sess.pct < SESSION_BLOCK_PCT) return;
    const now = Date.now();
    if (sess.resetAt <= now) return;
    const arr = S.hist.blocks = S.hist.blocks || [];
    const last = arr[arr.length - 1];
    if (last && Math.abs(last.end - sess.resetAt) < 5 * 60e3) return; // same block, already logged
    arr.push({ start: now, end: sess.resetAt });
    const keep = 62 * 86400e3;
    while (arr.length && arr[0].end < now - keep) arr.shift();
  }

  // active hours still blocked by an exhausted 5-hour window, up to `until`
  function blockedActiveHours(sess, until) {
    if (!sess || sess.idle || !sess.resetAt || sess.pct < SESSION_BLOCK_PCT) return 0;
    const now = Date.now();
    if (sess.resetAt <= now) return 0;
    return activeHours(now, Math.min(sess.resetAt, until));
  }

  /* ================= SYNC ================= */
  // Merges S.hist across devices through a small self-hosted endpoint (docs/TZ-sync-etap9.md).
  // Uses origFetch exclusively — the intercepted window.fetch above would recurse into its
  // own usage-endpoint matcher and back into ingest(). URL/token live only in S.sync,
  // set through the UI prompt below; never hardcoded, never logged.
  function syncUrl() { return S.sync.url.replace(/\/+$/, '') + '/sync'; }

  // {t,p} point series only — S.hist.blocks holds {start,end} intervals, a different
  // shape the server's t/p merge doesn't understand, so it's excluded from the wire format.
  function syncPayload() {
    const out = {};
    for (const k in S.hist) { if (k !== 'blocks') out[k] = S.hist[k]; }
    let body = JSON.stringify({ hist: out });
    if (body.length > 1e6 && S.sync.lastOk) {
      const trimmed = {};
      for (const k in out) trimmed[k] = (out[k] || []).filter(p => p.t > S.sync.lastOk);
      body = JSON.stringify({ hist: trimmed });
    }
    return body;
  }

  // Only accept well-formed {t,p} point arrays for known-shaped keys. A malformed or
  // unexpected server response must never corrupt S.hist — that would break every
  // subsequent render() (pace()/charts assume this shape) instead of just this one sync.
  function sanitizeHist(hist) {
    const out = {};
    for (const k in hist) {
      if (k === 'blocks') continue;
      const arr = hist[k];
      if (!Array.isArray(arr)) continue;
      out[k] = arr.filter(p => p && typeof p.t === 'number' && typeof p.p === 'number');
    }
    return out;
  }

  async function syncNow() {
    if (!S.sync || !S.sync.url || !S.sync.token) return;
    const ac = new AbortController();
    const abortT = setTimeout(() => ac.abort(), 10000); // a silently-dropped connection must not hang indefinitely
    try {
      const r = await origFetch(syncUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + S.sync.token },
        body: syncPayload(),
        signal: ac.signal
      });
      if (!r.ok) { S.sync.ok = false; saveState(); render(); return; }
      const data = await r.json();
      if (!data || typeof data.hist !== 'object') { S.sync.ok = false; saveState(); render(); return; }
      S.hist = Object.assign(sanitizeHist(data.hist), S.hist.blocks ? { blocks: S.hist.blocks } : {});
      S.sync.ok = true; S.sync.lastOk = Date.now();
      saveState(); render();
    } catch (e) {
      // network error, timeout, or bad JSON — stay silent, keep working on local data;
      // footer shows "sync: offline"
      S.sync.ok = false; saveState(); render();
    } finally {
      clearTimeout(abortT);
    }
  }

  // In-panel form, not prompt(): two sequential native prompt() dialogs froze the whole
  // tab on Firefox Android (a known class of mobile-browser bug — prompt() blocks the
  // main thread, and a dialog that doesn't resolve cleanly takes the page down with it).
  let syncFormOpen = false;
  function toggleSyncForm() { syncFormOpen = !syncFormOpen; render(); }

  /* ---- balance and promo: API first, DOM as fallback ---- */
  function moneyVal(k, v) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1e6) return null;
    return /minor|cents/i.test(k) ? v / 100 : v;
  }
  function ingestCredits(json) {
    try {
      let promo = null, expires = null, balance = null;
      (function walk(o, inPromo) {
        if (!o || typeof o !== 'object') return;
        for (const k in o) {
          const v = o[k], ctx = inPromo || /promo/i.test(k);
          if (v && typeof v === 'object') { walk(v, ctx); continue; }
          if (ctx) {
            if (/expir/i.test(k) && typeof v === 'string') { const t = Date.parse(v); if (isFinite(t)) expires = t; }
            if (/amount|balance|remain|minor|cents/i.test(k)) { const x = moneyVal(k, v); if (x != null) promo = x; }
          } else if (/balance/i.test(k)) { const x = moneyVal(k, v); if (x != null) balance = x; }
        }
      })(json, false);
      let changed = false;
      if (promo != null) { setPromo(promo, expires, 'api'); changed = true; }
      if (balance != null && (!S.balance || S.balance.amount !== balance)) { S.balance = { amount: balance, capturedAt: Date.now(), source: 'api' }; changed = true; }
      if (changed) { saveState(); render(); }
    } catch (e) {}
  }
  function setPromo(amount, expiresAt, source) {
    const peak = Math.max(PROMO_GRANT, (S.promo && S.promo.peak) || 0, amount);
    const sp = spendNow();
    S.promo = {
      amount, expiresAt: expiresAt || (S.promo && S.promo.expiresAt) || null, peak,
      capturedAt: Date.now(), source,
      spendAtCapture: sp ? sp.used : null,     // month-to-date spend at capture time
      monthAtCapture: monthStart()             // which month it was captured in
    };
    pushHist('promo_left', amount);
  }

  // current month-to-date credit spend
  function spendNow() {
    const sp = S.last && S.last.spend;
    if (!sp || !sp.limit || sp.enabled === false) return null;
    const pw = Math.pow(10, (sp.limit.exponent != null ? sp.limit.exponent : 2));
    return { used: (sp.used ? sp.used.amount_minor : 0) / pw, lim: sp.limit.amount_minor / pw };
  }

  // Live promo estimate: the Usage-page snapshot minus whatever was spent after it.
  // Without this, spend was subtracted from the ceiling but not from the promo balance,
  // so the widget kept reporting a shortfall that did not exist.
  function promoLeft() {
    if (!S.promo || S.promo.amount == null) return null;
    const sp = spendNow();
    if (!sp || S.promo.spendAtCapture == null || S.promo.monthAtCapture !== monthStart()) return S.promo.amount;
    return Math.max(0, S.promo.amount - Math.max(0, sp.used - S.promo.spendAtCapture));
  }

  function findTextNode(re) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const t = (n.nodeValue || '').trim(); if (t && re.test(t)) return n; }
    return null;
  }
  function nearbyAmount(labelRow) {
    const cand = [labelRow.previousElementSibling, labelRow.parentElement && labelRow.parentElement.previousElementSibling, labelRow.parentElement];
    for (const c of cand) { if (c) { const m = (c.textContent || '').match(/\$[\d][\d.,]*/); if (m) return parseFloat(m[0].replace(/[^\d.]/g, '')); } }
    return null;
  }
  function scanDOM() {
    if (!document.body) return;
    try {
      const bn = findTextNode(/^current balance$/i) || findTextNode(/^account balance$/i);
      if (bn) {
        const row = bn.parentElement && bn.parentElement.closest('div');
        const amt = row && nearbyAmount(row);
        if (amt != null && isFinite(amt) && (!S.balance || S.balance.amount !== amt)) {
          S.balance = { amount: amt, capturedAt: Date.now(), source: 'dom' }; saveState(); render();
        }
      }
      const pn = findTextNode(/^promotional credit$/i) || findTextNode(/^promo credit$/i);
      if (pn) {
        const row = pn.parentElement && pn.parentElement.closest('div');
        const amt = row && nearbyAmount(row);
        const blockTxt = (row && row.parentElement ? row.parentElement.textContent : '') || '';
        const ex = blockTxt.match(/(?:expires|expiring|expiration)\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[.\/]\d{1,2}[.\/]\d{4})/i);
        let expiresAt = null;
        if (ex) { const t = Date.parse(ex[1]); if (isFinite(t)) expiresAt = t; }
        if (amt != null && isFinite(amt)) {
          const changed = !S.promo || S.promo.amount !== amt;
          setPromo(amt, expiresAt, 'dom'); saveState();
          if (changed) render();
        }
      }
    } catch (e) {}
  }

  /* ================= EXTRACTION ================= */
  function parseReset(s) {
    if (!s) return null;
    const t = Date.parse(s);
    if (!isFinite(t) || t < Date.UTC(2020, 0, 1)) return null; // unix epoch = limit never triggered
    return t;
  }
  const SLOT_MAP = {
    seven_day_opus:       'Opus',
    seven_day_sonnet:     'Sonnet',
    seven_day_cowork:     'Cowork',
    seven_day_oauth_apps: 'API apps',
    seven_day_omelette:   'Fable 5',
    omelette_promotional: '@fableShare',
  };

  function extract(data) {
    const out = [], now = Date.now();
    const limits = Array.isArray(data.limits) ? data.limits : [];

    // --- session, 5 h ---
    const sessLim = limits.find(l => l.kind === 'session'), fh = data.five_hour;
    if (fh || sessLim) {
      const pct = (fh && fh.utilization != null) ? fh.utilization : (sessLim ? sessLim.percent : 0);
      const resetAt = parseReset(fh ? fh.resets_at : (sessLim ? sessLim.resets_at : null));
      const idle = !resetAt || resetAt <= now;
      out.push({ key: 'session', pct: idle ? 0 : pct, resetAt: idle ? null : resetAt, windowMs: SESSION_WINDOW_MS, severity: sessLim ? sessLim.severity : 'normal', idle });
    }

    // --- weekly, all models ---
    const weekLim = limits.find(l => l.kind === 'weekly_all'), sd = data.seven_day;
    if (sd || weekLim) {
      const pct = (sd && sd.utilization != null) ? sd.utilization : (weekLim ? weekLim.percent : 0);
      out.push({ key: 'weekly_all', title: L().weekAll, pct, resetAt: parseReset(sd ? sd.resets_at : (weekLim ? weekLim.resets_at : null)), windowMs: WEEK_WINDOW_MS, severity: weekLim ? weekLim.severity : 'normal' });
    }

    // --- sub-limits: only the ones that actually woke up ---
    for (const key in SLOT_MAP) {
      const o = data[key];
      if (!o) continue;
      const pct = o.utilization != null ? o.utilization : 0;
      const resetAt = parseReset(o.resets_at);
      if (pct <= 0 && !resetAt) continue;                       // dormant — do not render
      out.push({ key: 'slot_' + key, title: L().weekPrefix + (SLOT_MAP[key] === '@fableShare' ? L().fableShare : SLOT_MAP[key]), pct, resetAt, windowMs: WEEK_WINDOW_MS, severity: o.severity || 'normal', scoped: true });
    }

    // --- monthly credits ---
    const sp = data.spend;
    if (sp && sp.limit && sp.enabled !== false) {
      const e = (sp.limit.exponent != null ? sp.limit.exponent : 2), pw = Math.pow(10, e);
      const used = (sp.used ? sp.used.amount_minor : 0) / pw, lim = sp.limit.amount_minor / pw;
      const mr = monthReset();
      out.push({ key: 'spend', title: L().creditsMonth, pct: (sp.percent != null) ? sp.percent : (lim > 0 ? used / lim * 100 : 0), resetAt: mr, windowMs: mr - monthStart(), severity: sp.severity, money: { used, lim } });
    }
    return out;
  }
  function monthReset() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  function monthStart() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }

  // Even-pace target for this point in the window: where usage "should" be if spent
  // evenly. Actual below target = headroom, above = burning faster than the window.
  // Weekly limits are spread over the activity profile (work hours only, weekends
  // discounted) instead of the flat calendar — otherwise Wednesday evening reads as a
  // false overspend because the calendar model expects usage through nights and weekends
  // that never happen. Money (spend) stays flat calendar — monthly billing isn't tied
  // to work hours.
  function planPct(it) {
    if (!it.resetAt || !it.windowMs) return null;
    const start = it.resetAt - it.windowMs;
    if (it.windowMs === WEEK_WINDOW_MS) {
      const total = activeHours(start, it.resetAt);
      if (total <= 0) return null;
      const elapsedActive = activeHours(start, Math.min(Date.now(), it.resetAt));
      return elapsedActive / total * 100;
    }
    const el = Math.min(Math.max(Date.now() - start, 0), it.windowMs);
    return el / it.windowMs * 100;
  }

  /* ================= STATUS ================= */
  // Rule: only the risk of running out BEFORE the reset is worth an alert.
  // Reaching 80-90% at reset is headroom, not a problem — unused quota expires anyway.
  //
  // Weekly-style items (weekly_all, slot_*) are judged against a norm — the %/active-hour
  // needed to land exactly on the limit at reset, given the active hours actually left
  // (activity profile minus any 5-hour blocks) — rather than a flat time-based forecast.
  // Uncertainty (early in the window, thin history) yields silence, not an alarm.
  function pace(it, sess) {
    const now = Date.now();
    if (it.idle) return { status: 'idle', note: '' };

    if (it.key === 'session') {
      // green < 65 ≤ yellow < 75 ≤ orange < 85 ≤ red
      let st = it.pct >= 85 ? 'bad' : (it.pct >= 75 ? 'hot' : (it.pct >= 65 ? 'warn' : 'ok'));
      if (it.severity === 'critical') st = 'bad';
      return { status: st, note: '' };
    }

    if (it.key === 'spend') {
      const st = it.pct >= 95 ? 'bad' : (it.pct >= 80 ? 'warn' : 'ok');
      return { status: st, note: st === 'bad' ? L().spendNearLimit : '' };
    }

    if (!it.resetAt) return { status: 'ok', note: '' };
    const left = it.resetAt - now;
    if (it.pct >= 100) return { status: 'bad', note: L().exhausted(fmtDur(left)) };
    // an API-reported severity is an external signal, not our own noisy math —
    // it shouldn't be silenced by the local uncertainty gate below
    if (it.severity === 'critical') return { status: 'bad', note: '' };

    const start = it.resetAt - it.windowMs;
    const elapsed = Math.min(Math.max(now - start, 0), it.windowMs);
    const fracElapsed = it.windowMs ? elapsed / it.windowMs : 0;
    const hist = S.hist[it.key] || [];
    const historyDepthMs = hist.length ? now - hist[0].t : 0;
    // gates the ALARM only — norm/pace are still worth showing during the uncertain
    // window, per TZ 3.5: "прогноз скрыт, показывать только факт и норму"
    const forecastReady = fracElapsed >= AVG_RATE_GATE_FRAC || historyDepthMs >= MIN_HISTORY_FOR_FORECAST;

    const blocked = blockedActiveHours(sess, it.resetAt);
    const activeRemaining = Math.max(0, activeHours(now, it.resetAt) - blocked);
    if (activeRemaining <= 0) {
      return { status: 'ok', note: L().expiresUnused(Math.round(100 - it.pct), fmtDay(it.resetAt), fmtTime(it.resetAt)) };
    }

    const norm = (100 - it.pct) / activeRemaining;          // % needed per active hour to land on the limit
    const paceStart = activeHoursAgo(now, 3);                // pace over the last 3 *active* hours, not wall-clock
    let pastPct = null;
    for (const p of hist) { if (p.t <= paceStart) pastPct = p.p; else break; }
    const curPace = (hist.length && hist[0].t <= paceStart && pastPct != null) ? (it.pct - pastPct) / 3 : null;
    const ratio = (curPace != null && norm > 0) ? curPace / norm : null;
    const info = { norm, curPace, ratio, activeRemaining, forecastReady };

    if (!forecastReady || ratio == null || ratio < 1.15) {
      return Object.assign({ status: 'ok', note: '' }, info);
    }

    const proj = it.pct + curPace * activeRemaining;        // % at reset if the current active-hour pace holds
    if (ratio >= 1.8 && proj >= 100) {
      // active-hour rate converted to calendar time via the average active-ms/calendar-ms
      // over what's left — good enough for a "roughly when" readout, not exact
      const calRate = curPace * (activeRemaining / left);
      const d = calRate > 0 ? now + (100 - it.pct) / calRate : it.resetAt;
      return Object.assign({ status: 'bad', note: L().runsOut(fmtDay(d), fmtTime(d)) }, info);
    }
    return Object.assign({ status: 'warn', note: L().paceAhead(ratio.toFixed(1)) }, info);
  }

  /* ================= PROMO ================= */
  // Promo credits are ordinary usage credits: they pay for Fable 5 and for any overage
  // beyond plan limits. The monthly spend limit caps how much of the promo you can
  // actually draw down before it expires.
  function promoWarning() {
    const left = promoLeft();
    if (left == null || left <= 1) return null;
    if (!S.promo.expiresAt || S.promo.expiresAt <= Date.now()) return null;
    const sp = spendNow();
    if (!sp) return null;
    // a promo snapshot older than 30 days is too stale to assert anything from
    if (Date.now() - (S.promo.capturedAt || 0) > 30 * 86400e3) return null;

    // how much can physically be spent before expiry at the current monthly limit
    let cap = 0, months = 0, first = true, d = new Date();
    let w = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (w < S.promo.expiresAt && months < 24) {
      cap += first ? Math.max(0, sp.lim - sp.used) : sp.lim; first = false; months++;
      const x = new Date(w); w = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1);
    }
    const lost = left - cap;
    // threshold: stay silent until the loss is material (rounding noise is not a reason)
    if (lost < 10 || lost < left * 0.1) return null;
    const need = Math.ceil(left / Math.max(1, months));
    if (need <= sp.lim) return null;               // nothing to raise — the limit is already sufficient
    return { left, cap, lost, need, lim: sp.lim, months };
  }

  /* ================= FORMATTING ================= */
  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    ms = Math.max(0, ms);
    const d = Math.floor(ms / 86400e3), h = Math.floor(ms % 86400e3 / 3600e3), m = Math.floor(ms % 3600e3 / 60e3);
    return L().dur(d, h, m);
  }
  function fmtTime(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function fmtDay(ts) {
    const d = new Date(ts), n = new Date();
    if (d.toDateString() === n.toDateString()) return L().today;
    if (d.toDateString() === new Date(n.getTime() + 86400e3).toDateString()) return L().tomorrow;
    return L().days[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function fmtAgo(ms) {
    const m = Math.floor(ms / 60e3);
    if (m < 1) return L().justNow;
    if (m < 60) return L().minAgo(m);
    return L().hourAgo(Math.floor(m / 60));
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ================= UI ================= */
  const COLORS = { ok: '#4ade80', warn: '#fbbf24', hot: '#fb923c', bad: '#ef4444', idle: '#7c7c86', muted: '#8b8b94', accent: '#D97757' };
  let root, badge, badgeTxt, panel;

  function css() {
    return `
#clt-root{position:fixed;z-index:2147483000;right:16px;bottom:90px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}
#clt-badge{display:flex;align-items:center;gap:7px;background:#1a1a1f;border:1px solid #33333c;border-radius:999px;padding:5px 12px 5px 6px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);user-select:none;}
#clt-badge:hover{border-color:#4b4b57;}
#clt-badge img{width:24px;height:24px;display:block;}
#clt-badge .t{font-size:13px;font-weight:700;letter-spacing:.2px;white-space:nowrap;}
#clt-badge.spin img{animation:cltrot 1s linear infinite;}
@keyframes cltrot{to{transform:rotate(360deg)}}
#clt-panel{position:absolute;right:0;bottom:44px;width:268px;max-width:calc(100vw - 32px);background:#17171c;border:1px solid #33333c;border-radius:16px;padding:12px 14px 9px;box-shadow:0 10px 34px rgba(0,0,0,.6);color:#e8e8ee;display:none;}
#clt-panel.open{display:block;}
.clt-hd{display:flex;align-items:center;gap:6px;margin-bottom:10px;}
.clt-hd .t{font-size:11px;font-weight:600;color:#8b8b94;flex:1;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;user-select:none;}
.clt-hd .t:hover{color:#c9c9d2;}
.clt-wide{display:grid;gap:16px;}
.clt-col{min-width:0;}
.clt-col .clt-row:first-child{border-top:none;padding-top:0;}
.clt-col-hd{font-size:10px;font-weight:600;color:#6f6f78;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;}
.clt-hd button{background:none;border:none;color:#8b8b94;cursor:pointer;font-size:13px;padding:2px 5px;border-radius:6px;line-height:1;}
.clt-hd button:hover{background:#26262d;color:#fff;}
.clt-hd button.lang{font-size:9.5px;font-weight:700;letter-spacing:.5px;border:1px solid #3a3a44;padding:2px 5px;}
/* --- hero: the 5-hour window --- */
.clt-hero{display:flex;align-items:center;gap:14px;padding:2px 0 12px;}
.clt-hero .ring{position:relative;width:54px;height:54px;flex:none;}
.clt-hero .ring svg{width:54px;height:54px;transform:rotate(-90deg);display:block;}
#clt-root .clt-hero .ring,#clt-root .clt-hero .ring svg,#clt-root .clt-hero .ring .rpct{border:0!important;outline:0!important;box-shadow:none!important;background:transparent!important;border-radius:50%;}
#clt-root .clt-hero .ring::before,#clt-root .clt-hero .ring::after,#clt-root .clt-hero .ring svg::before,#clt-root .clt-hero .ring svg::after{content:none!important;display:none!important;}
.clt-hero .ring .rpct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;}
.clt-hero .big{font-size:26px;font-weight:800;line-height:1.05;letter-spacing:-.5px;}
.clt-hero .sub{font-size:11.5px;color:#8b8b94;margin-top:3px;}
.clt-hero .lbl{font-size:10px;color:#6f6f78;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px;}
/* --- rows --- */
.clt-row{padding:8px 0;border-top:1px solid #26262d;}
.clt-row .l1{display:flex;align-items:baseline;gap:8px;font-size:12px;}
.clt-row .l1 .n{color:#c9c9d2;flex:1;}
.clt-row .l1 .v{font-weight:700;font-size:12.5px;}
.clt-bar{position:relative;height:4px;background:#2a2a31;border-radius:3px;margin:6px 0 0;}
.clt-bar i{display:block;height:100%;border-radius:3px;transition:width .4s;}
.clt-bar u{position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:#e8e8ee;opacity:.18;}
.clt-bar b{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:#e8e8ee;opacity:.75;border-radius:1px;}
.clt-plan{font-size:10.5px;font-weight:600;}
.clt-sub{font-size:10.5px;color:#6f6f78;margin-top:4px;}
.clt-warn{font-size:11px;margin-top:4px;font-weight:500;}
.clt-sync{padding:2px 0 12px;border-bottom:1px solid #26262d;margin-bottom:2px;}
.clt-sync input{width:100%;box-sizing:border-box;background:#0f0f13;border:1px solid #33333c;border-radius:8px;color:#e8e8ee;font-size:13px;padding:9px 10px;margin-bottom:8px;min-height:36px;}
.clt-sync input:focus{outline:none;border-color:${COLORS.accent};}
.clt-sync-btns{display:flex;gap:8px;justify-content:flex-end;}
.clt-sync-btns button{background:#26262d;border:none;color:#c9c9d2;cursor:pointer;font-size:12px;padding:8px 12px;border-radius:8px;min-height:36px;}
.clt-sync-btns button:hover{background:#33333c;}
.clt-sync-btns button.primary{background:${COLORS.accent};color:#fff;font-weight:600;}
.clt-sync-btns button.primary:hover{filter:brightness(1.1);}
.clt-ft{display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid #26262d;font-size:10px;color:#5f5f68;}
.clt-ft a{color:${COLORS.accent};text-decoration:none;font-weight:600;font-size:10.5px;}
.clt-ft a:hover{text-decoration:underline;}
.clt-ft .sp{flex:1;}
`;
  }

  // even-pace marker on the bar
  function planMark(plan) {
    if (plan == null || plan <= 1 || plan >= 99.5) return '';
    return `<b style="left:${plan.toFixed(1)}%" title="${L().evenPace(Math.round(plan) + '%')}"></b>`;
  }
  // faint ticks — a reference for which day the pace marker sits on
  function tickMarks(positions) {
    return positions.filter(p => p > 1 && p < 99)
      .map(p => `<u style="left:${p.toFixed(2)}%"></u>`).join('');
  }
  function dayTicks() {                       // week: day boundaries
    const out = []; for (let i = 1; i < 7; i++) out.push(i / 7 * 100); return tickMarks(out);
  }
  function decadeTicks(resetAt, windowMs) {   // month: every 10 days
    const days = windowMs / 86400e3, out = [];
    for (let d = 10; d < days; d += 10) out.push(d / days * 100);
    return tickMarks(out);
  }

  // behind / ahead of the even pace
  function planTag(fact, plan, unit) {
    if (plan == null || plan <= 0.5) return '';
    const d = fact - plan;
    const eps = unit === '$' ? 0.5 : 2;
    if (Math.abs(d) < eps) return `<span class="clt-plan" style="color:${COLORS.muted}">${L().onPace}</span>`;
    const ahead = d > 0;                      // spending faster than even pace
    const txt = unit === '$'
      ? '$' + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0)
      : Math.round(Math.abs(d)) + '%';
    const tip = L().evenPace(unit === '$' ? '$' + plan.toFixed(2) : Math.round(plan) + '%');
    return `<span class="clt-plan" style="color:${ahead ? COLORS.warn : COLORS.ok}" title="${tip}">${ahead ? '+' : '−'}${txt}</span>`;
  }

  function ring(pct, color) {
    const R = 23, C = 2 * Math.PI * R;
    const off = C * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return `<svg viewBox="0 0 54 54">
      <circle cx="27" cy="27" r="${R}" fill="none" stroke="#2a2a31" stroke-width="5"/>
      <circle cx="27" cy="27" r="${R}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>`;
  }

  // weekly forecast chart: accumulated fact from S.hist, the activity-profile curve,
  // a "now" marker, and blocked-interval hatching. No ceiling line yet — that needs the
  // X-coefficient regression from a later stage, and stays silent until there's data.
  function weeklyChartSvg(it) {
    if (!it.resetAt || !it.windowMs) return '';
    const start = it.resetAt - it.windowMs, now = Date.now();
    const W = 300, H = 96, PAD = 4;
    const x = t => PAD + Math.min(1, Math.max(0, (t - start) / it.windowMs)) * (W - PAD * 2);
    const y = p => H - PAD - Math.min(100, Math.max(0, p)) / 100 * (H - PAD * 2);

    const blocks = (S.hist.blocks || []).filter(b => b.end > start && b.start < it.resetAt);
    const hatches = blocks.map(b => {
      const x1 = x(Math.max(b.start, start)), x2 = x(Math.min(b.end, it.resetAt));
      return `<rect x="${x1.toFixed(1)}" y="${PAD}" width="${Math.max(0, x2 - x1).toFixed(1)}" height="${H - PAD * 2}" fill="#e8e8ee" opacity="0.06"/>`;
    }).join('');

    const dayLines = [];
    for (let d = 1; d * 86400e3 < it.windowMs; d++) {
      const xt = x(start + d * 86400e3);
      dayLines.push(`<line x1="${xt.toFixed(1)}" y1="${PAD}" x2="${xt.toFixed(1)}" y2="${H - PAD}" stroke="#2a2a31" stroke-width="1"/>`);
    }

    const prof = activityProfileCurve(start, it.resetAt, 28);
    const profPath = prof.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.pct).toFixed(1)).join(' ');

    const hist = (S.hist[it.key] || []).filter(p => p.t >= start && p.t <= it.resetAt);
    const factPts = now <= it.resetAt ? hist.concat([{ t: now, p: it.pct }]) : hist;
    const factPath = factPts.length >= 2
      ? factPts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.p).toFixed(1)).join(' ')
      : '';

    const nowX = x(Math.min(now, it.resetAt));

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block;margin-top:8px;">
      ${hatches}${dayLines.join('')}
      <path d="${profPath}" fill="none" stroke="#6f6f78" stroke-width="1.5" stroke-dasharray="3,3"/>
      ${factPath ? `<path d="${factPath}" fill="none" stroke="${COLORS.accent}" stroke-width="1.75"/>` : ''}
      <line x1="${nowX.toFixed(1)}" y1="${PAD}" x2="${nowX.toFixed(1)}" y2="${H - PAD}" stroke="#e8e8ee" stroke-width="1" opacity="0.35"/>
    </svg>`;
  }

  // 5-hour window chart, scoped to the *current* window only (start = resetAt - 5h) —
  // shows how this session is tracking toward the limit against an even-pace line.
  // Earlier versions plotted the last 24h across multiple reset cycles; that read as
  // noise (old, already-reset windows) and didn't answer "am I approaching the limit
  // right now", so it's gone.
  function sessionChartSvg(sess, col) {
    if (!sess || sess.idle || !sess.resetAt) return '';
    const start = sess.resetAt - SESSION_WINDOW_MS, now = Date.now();
    const W = 240, H = 56, PAD = 3;
    const x = t => PAD + Math.min(1, Math.max(0, (t - start) / SESSION_WINDOW_MS)) * (W - PAD * 2);
    const y = p => H - PAD - Math.min(100, Math.max(0, p)) / 100 * (H - PAD * 2);

    const hourLines = [];
    for (let h = 1; h < 5; h++) {
      const xt = x(start + h * 3600e3);
      hourLines.push(`<line x1="${xt.toFixed(1)}" y1="${PAD}" x2="${xt.toFixed(1)}" y2="${H - PAD}" stroke="#2a2a31" stroke-width="1"/>`);
    }

    const evenPacePath = `M${x(start).toFixed(1)},${y(0).toFixed(1)} L${x(sess.resetAt).toFixed(1)},${y(100).toFixed(1)}`;

    const hist = (S.hist.session || []).filter(p => p.t >= start && p.t <= sess.resetAt);
    const factPts = hist.concat([{ t: now, p: sess.pct }]);
    const factPath = factPts.length >= 2
      ? factPts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.p).toFixed(1)).join(' ')
      : '';

    const nowX = x(now);

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block;margin-top:6px;">
      ${hourLines.join('')}
      <path d="${evenPacePath}" fill="none" stroke="#6f6f78" stroke-width="1.5" stroke-dasharray="3,3"/>
      ${factPath ? `<path d="${factPath}" fill="none" stroke="${col}" stroke-width="1.75"/>` : ''}
      <line x1="${nowX.toFixed(1)}" y1="${PAD}" x2="${nowX.toFixed(1)}" y2="${H - PAD}" stroke="#e8e8ee" stroke-width="1" opacity="0.35"/>
    </svg>`;
  }

  function buildUI() {
    const st = document.createElement('style');
    st.textContent = css();
    document.documentElement.appendChild(st);

    root = document.createElement('div');
    root.id = 'clt-root';
    if (S.ui && S.ui.pos) { root.style.right = S.ui.pos.r + 'px'; root.style.bottom = S.ui.pos.b + 'px'; }
    root.innerHTML = `<div id="clt-panel"></div>
      <div id="clt-badge">
        <img src="${ICON}" alt=""><span class="t">—</span></div>`;
    document.documentElement.appendChild(root);
    badge = root.querySelector('#clt-badge');
    badgeTxt = badge.querySelector('.t');
    panel = root.querySelector('#clt-panel');

    let drag = null;
    badge.addEventListener('mousedown', e => {
      drag = { x: e.clientX, y: e.clientY, r: parseFloat(root.style.right) || 16, b: parseFloat(root.style.bottom) || 90, moved: false };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      root.style.right = Math.max(4, drag.r - dx) + 'px';
      root.style.bottom = Math.max(4, drag.b - dy) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      if (drag.moved) { S.ui.pos = { r: parseFloat(root.style.right), b: parseFloat(root.style.bottom) }; }
      else { S.ui.open = !S.ui.open; }
      saveState(); render(); drag = null;
    });
    render();
  }

  function setBadgeSpin(on) { if (badge) badge.classList.toggle('spin', on); }

  // <700px cannot fit expanded/wide's minimum content — fall back regardless of
  // what the user picked, per stage-5 breakpoints
  function effectiveMode() {
    const vw = document.documentElement.clientWidth || window.innerWidth || 1200;
    return vw < 700 ? 'compact' : S.ui.mode;
  }
  function cycleMode() {
    const order = ['compact', 'expanded', 'wide'];
    S.ui.mode = order[(order.indexOf(S.ui.mode) + 1) % order.length];
    saveState(); render();
  }

  function headerHtml() {
    return `<div class="clt-hd"><span class="t" id="clt-t" title="${L().tipMode}">Claude Limits</span>
      <button id="clt-l" class="lang" title="${L().tipLang}">${L().code}</button>
      <button id="clt-s" title="${L().tipSync}">⇄</button>
      <button id="clt-r" title="${L().tipRefresh}">↻</button>
      <button id="clt-x" title="${L().tipCollapse}">✕</button></div>`;
  }

  function syncFormHtml() {
    return `<div class="clt-sync">
      <input id="clt-sync-url" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${L().syncUrlPh}" value="${esc(S.sync.url || '')}">
      <input id="clt-sync-token" type="password" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${L().syncTokenPh}" value="${esc(S.sync.token || '')}">
      <div class="clt-sync-btns">
        <button id="clt-sync-cancel">${L().syncCancel}</button>
        <button id="clt-sync-clear">${L().syncClear}</button>
        <button id="clt-sync-save" class="primary">${L().syncSave}</button>
      </div>
    </div>`;
  }

  function heroHtml(sess, withChart) {
    if (!sess) return `<div class="clt-hero"><div><div class="big" style="color:${COLORS.muted}">${L().noData}</div>
      <div class="sub">${L().pressRefresh}</div></div></div>`;
    const p = pace(sess), col = COLORS[p.status];
    if (sess.idle) {
      return `<div class="clt-hero">
        <div class="ring">${ring(0, COLORS.idle)}<div class="rpct" style="color:${COLORS.idle}">0%</div></div>
        <div><div class="lbl">${L().hero}</div><div class="big" style="color:${COLORS.idle}">${L().notStarted}</div>
        <div class="sub">${L().beginsWith}</div></div></div>`;
    }
    let html = `<div class="clt-hero">
      <div class="ring">${ring(sess.pct, col)}<div class="rpct" style="color:${col}">${Math.round(sess.pct)}%</div></div>
      <div><div class="lbl">${L().hero}</div><div class="big" style="color:${col}">${fmtDur(sess.resetAt - Date.now())}</div>
      <div class="sub">${L().resetsAt(fmtTime(sess.resetAt))}</div></div></div>`;
    if (withChart) html += sessionChartSvg(sess, col);
    return html;
  }

  function weeklyRowHtml(it, sess, opts) {
    const p = pace(it, sess), col = COLORS[p.status];
    const plan = planPct(it);
    let normLine = '';
    if (opts.norm && p.norm != null) {
      normLine = L().normBase(p.norm.toFixed(2), Math.floor(p.activeRemaining / 5));
      if (p.forecastReady && p.curPace != null) normLine += L().paceSuffix(p.curPace.toFixed(2));
    }
    return `<div class="clt-row">
      <div class="l1"><span class="n">${esc(it.title)}</span>${planTag(it.pct, plan, '%')}<span class="v" style="color:${col}">${Math.round(it.pct)}%</span></div>
      <div class="clt-bar"><i style="width:${Math.min(100, it.pct)}%;background:${col}"></i>${dayTicks()}${planMark(plan)}</div>
      ${it.resetAt ? `<div class="clt-sub">${L().rowResets(fmtDay(it.resetAt), fmtTime(it.resetAt), fmtDur(it.resetAt - Date.now()))}</div>` : ''}
      ${normLine ? `<div class="clt-sub">${normLine}</div>` : ''}
      ${p.note ? `<div class="clt-warn" style="color:${col}">${esc(p.note)}</div>` : ''}
      ${opts.chart && it.key === 'weekly_all' ? weeklyChartSvg(it) : ''}
    </div>`;
  }

  function moneyHtml(sp) {
    if (!sp && !S.balance) return '';
    let html = `<div class="clt-row">`;
    if (sp) {
      const p = pace(sp), col = COLORS[p.status];
      const plan = planPct(sp);
      const planUsd = plan != null ? plan / 100 * sp.money.lim : null;   // what should have been spent by this point
      html += `<div class="l1"><span class="n">${L().creditsMonth}</span>${planTag(sp.money.used, planUsd, '$')}<span class="v" style="color:${col}">$${sp.money.used.toFixed(2)} / $${sp.money.lim.toFixed(0)}</span></div>
        <div class="clt-bar"><i style="width:${Math.min(100, sp.pct)}%;background:${col}"></i>${decadeTicks(sp.resetAt, sp.windowMs)}${planMark(plan)}</div>`;
    }
    const bits = [];
    if (S.balance && S.balance.amount != null) bits.push(L().balance(S.balance.amount.toFixed(2)));
    if (sp) bits.push(L().spendResets(fmtDay(sp.resetAt)));
    if (bits.length) html += `<div class="clt-sub">${bits.join(' · ')}</div>`;

    // quiet note: how much promo is left and when it expires (part of the balance, not extra)
    const pl = promoLeft();
    if (pl != null && pl > 1 && S.promo.expiresAt && S.promo.expiresAt > Date.now()) {
      html += `<div class="clt-sub">${L().inclPromo(pl.toFixed(2), fmtDay(S.promo.expiresAt))}</div>`;
    }
    const pw = promoWarning();
    if (pw) html += `<div class="clt-warn" style="color:${COLORS.warn}">${L().promoWarn(pw.cap.toFixed(0), pw.left.toFixed(0), fmtDay(S.promo.expiresAt), pw.lost.toFixed(0), pw.need)}</div>`;
    html += `</div>`;
    return html;
  }

  function footerHtml() {
    const stale = S.lastT && (Date.now() - S.lastT > POLL_MINUTES * 2 * 60e3);
    const syncBit = !S.sync.url ? '' : (S.sync.ok === false)
      ? `<span style="color:${COLORS.warn}">${L().syncOffline}</span>`
      : (S.sync.lastOk ? `<span style="color:#5f5f68">${L().syncAgo(fmtAgo(Date.now() - S.sync.lastOk))}</span>` : '');
    return `<div class="clt-ft">
      <a href="/settings/usage" target="_blank">${L().fullDetail}</a><span class="sp"></span>
      ${syncBit}
      <span style="color:${stale ? COLORS.warn : '#5f5f68'}">${S.lastT ? fmtAgo(Date.now() - S.lastT) : L().noData}</span>
      <span>v${VERSION}</span></div>`;
  }

  // compact: v29.1 content, unchanged — no norm line, no charts
  function compactBody(items, sess) {
    let html = heroHtml(sess, false);
    for (const it of items) {
      if (it.key === 'session' || it.key === 'spend') continue;
      html += weeklyRowHtml(it, sess, { norm: false, chart: false });
    }
    html += moneyHtml(items.find(i => i.key === 'spend'));
    return html;
  }

  // expanded: today's vertical stack — norm line + inline weekly chart + session chart
  function expandedBody(items, sess) {
    let html = heroHtml(sess, true);
    for (const it of items) {
      if (it.key === 'session' || it.key === 'spend') continue;
      html += weeklyRowHtml(it, sess, { norm: true, chart: true });
    }
    html += moneyHtml(items.find(i => i.key === 'spend'));
    return html;
  }

  // wide: horizontal columns per TZ 4.2 — 5h window / Week (all weekly-style rows,
  // norm shown, chart pulled out) / Forecast (the weekly_all chart, given room to breathe)
  // / Credits
  function wideBody(items, sess, cols) {
    const weeklyAll = items.find(i => i.key === 'weekly_all');
    const weekRows = items.filter(i => i.key !== 'session' && i.key !== 'spend')
      .map(it => weeklyRowHtml(it, sess, { norm: true, chart: false })).join('');
    const forecast = weeklyAll ? weeklyChartSvg(weeklyAll) : `<div class="clt-sub">${L().noData}</div>`;
    return `<div class="clt-wide" style="grid-template-columns:repeat(${cols},1fr)">
      <div class="clt-col"><div class="clt-col-hd">${L().colSession}</div>${heroHtml(sess, true)}</div>
      <div class="clt-col"><div class="clt-col-hd">${L().colWeek}</div>${weekRows}</div>
      <div class="clt-col"><div class="clt-col-hd">${L().colForecast}</div>${forecast}</div>
      <div class="clt-col"><div class="clt-col-hd">${L().colCredits}</div>${moneyHtml(items.find(i => i.key === 'spend'))}</div>
    </div>`;
  }

  // One bad data point (malformed history, an unexpected sync response) must not
  // wedge the widget into a permanently stale state — catch, show something honest,
  // keep the poll/sync timers running so it can recover on its own next tick.
  function render() {
    if (!badge) return;
    try {
      renderInner();
    } catch (e) {
      badgeTxt.textContent = '⚠'; badgeTxt.style.color = COLORS.warn;
      if (panel) panel.classList.remove('open');
    }
  }

  function renderInner() {
    const items = S.last ? extract(S.last) : [];
    const sess = items.find(i => i.key === 'session');

    /* --- badge: reset time + percentage --- */
    if (sess && !sess.idle) {
      const p = pace(sess);
      badgeTxt.textContent = fmtTime(sess.resetAt) + ' · ' + Math.round(sess.pct) + '%';
      badgeTxt.style.color = COLORS[p.status];
    } else if (sess) {
      badgeTxt.textContent = L().windowIdle;
      badgeTxt.style.color = COLORS.idle;
    } else {
      badgeTxt.textContent = '—'; badgeTxt.style.color = COLORS.muted;
    }

    badge.title = L().tipBadge;
    panel.classList.toggle('open', !!S.ui.open);
    if (!S.ui.open) return;

    const mode = effectiveMode();
    let width, body;
    if (mode === 'wide') {
      const vw = document.documentElement.clientWidth || window.innerWidth || 1200;
      width = Math.min(1100, Math.max(700, vw - 32));
      body = wideBody(items, sess, vw >= 1100 ? 4 : 2);   // breakpoint is viewport width, not panel width
    } else if (mode === 'expanded') {
      width = 420;
      body = expandedBody(items, sess);
    } else {
      width = 268;
      body = compactBody(items, sess);
    }
    panel.style.width = width + 'px';
    panel.innerHTML = headerHtml() + (syncFormOpen ? syncFormHtml() : '') + body + footerHtml();

    const rb = panel.querySelector('#clt-r'), xb = panel.querySelector('#clt-x'), lb = panel.querySelector('#clt-l'), sb = panel.querySelector('#clt-s'), tb = panel.querySelector('#clt-t');
    if (lb) lb.onclick = toggleLang;
    if (sb) sb.onclick = toggleSyncForm;
    if (tb) tb.onclick = cycleMode;
    if (rb) rb.onclick = () => poll(true);
    if (xb) xb.onclick = () => { S.ui.open = false; saveState(); render(); };

    if (syncFormOpen) {
      const uEl = panel.querySelector('#clt-sync-url'), tEl = panel.querySelector('#clt-sync-token');
      const saveB = panel.querySelector('#clt-sync-save'), clearB = panel.querySelector('#clt-sync-clear'), cancelB = panel.querySelector('#clt-sync-cancel');
      if (saveB) saveB.onclick = () => {
        const url = ((uEl && uEl.value) || '').trim(), token = ((tEl && tEl.value) || '').trim();
        S.sync = { url: url || null, token: token || null, lastOk: null, ok: null };
        syncFormOpen = false; saveState(); render();
        if (S.sync.url && S.sync.token) syncNow();
      };
      if (clearB) clearB.onclick = () => {
        S.sync = { url: null, token: null, lastOk: null, ok: null };
        syncFormOpen = false; saveState(); render();
      };
      if (cancelB) cancelB.onclick = () => { syncFormOpen = false; render(); };
    }
  }

  function toast(msg) {
    const x = document.createElement('div');
    x.textContent = msg;
    x.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#b91c1c;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;z-index:2147483001';
    document.body.appendChild(x);
    setTimeout(() => x.remove(), 4000);
  }

  /* ================= STARTUP ================= */
  function start() {
    buildUI();
    scanDOM();
    setTimeout(() => poll(false), 2500);
    setInterval(() => poll(false), POLL_MINUTES * 60e3);
    setTimeout(syncNow, 4000);
    setInterval(syncNow, 15 * 60e3);
    setInterval(render, 20e3);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - S.lastT > 2 * 60e3) poll(false);
    });
    // re-check the wide/expanded/compact breakpoints on rotate/resize
    let resizeT = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(render, 150);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
