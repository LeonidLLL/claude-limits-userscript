// ==UserScript==
// @name         Claude Limits
// @namespace    lisin.claude.limits
// @version      31.2
// @description  Claude usage tracker (EN/RU): four lines from the single /usage JSON endpoint — 5-hour window, weekly limit, credits, headroom, plus a quiet calendar-pace bar under the weekly limit. No DOM scraping, no charts. Sync is off by default.
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

  /* ============================================================
   * PARSING — pure functions, no window/document/localStorage.
   * Lives here (not in lib/) so the running widget and the test
   * suite share one implementation instead of two copies that can
   * drift apart. Requiring this file from Node skips the browser
   * block below (guarded on `typeof window`) and only evaluates
   * this section, then reads the module.exports at the bottom.
   * ============================================================ */

  // Generic fallback label for any `limits[].kind` the server sends — a humanized
  // version of the slug. session/weekly_all get a proper localized name from the
  // UI layer's I18N.kindLabels instead; this is only ever shown for kinds that
  // aren't in that map, so it stays English (there's no reasonable way to
  // translate a name we don't know in advance).
  function labelForKind(kind) {
    return String(kind).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // unix epoch (or anything before 2020) means "never triggered", not a real date
  function parseIsoDate(s) {
    if (!s) return null;
    const t = Date.parse(s);
    if (!isFinite(t) || t < Date.UTC(2020, 0, 1)) return null;
    return t;
  }

  function moneyFromMinor(minor, exponent) {
    if (typeof minor !== 'number' || typeof exponent !== 'number' || !isFinite(exponent)) return null;
    return minor / Math.pow(10, exponent);
  }

  // limit_dollars/used_dollars/remaining_dollars live on the five_hour/seven_day
  // top-level buckets, currently always null (fixed 23.08.2026). Not part of the
  // `limits` array itself — this is the one place those buckets are still read,
  // purely as an optional dollar overlay, never for percent or resets_at.
  function dollarsFromBucket(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    const limit = bucket.limit_dollars, used = bucket.used_dollars, remaining = bucket.remaining_dollars;
    if (limit == null && used == null && remaining == null) return null;
    return { limit, used, remaining };
  }

  // `units` lets the day/hour suffix (only used past the 24h mark — below that
  // it's a plain "H:MM" with no letters to translate) be localized by the
  // caller; defaults to English so existing callers/tests are unaffected.
  function fmtCountdown(ms, units) {
    if (ms == null || !isFinite(ms) || ms < 0) return '—';
    const u = units || { d: 'd', h: 'h' };
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return days + u.d + ' ' + hours + u.h;
    return hours + ':' + String(mins).padStart(2, '0');
  }

  // Rule: iterate the `limits` array, never read five_hour/seven_day directly for
  // percent/resets_at — those are legacy top-level duplicates that may disappear.
  // Fail-loud: no `limits` array, no spend.used.amount_minor, or a non-numeric
  // exponent all throw — the caller must not fall back to stale numbers.
  function parseUsage(data) {
    if (!data || typeof data !== 'object') throw new Error('response is not an object');
    const rawLimits = data.limits;
    if (!Array.isArray(rawLimits)) throw new Error('missing limits array');

    const dollarBucketByKind = { session: data.five_hour, weekly_all: data.seven_day };
    const limits = rawLimits.map(l => {
      const kind = l && l.kind;
      return {
        kind,
        label: labelForKind(kind),
        group: (l && l.group) || null,
        percent: (l && typeof l.percent === 'number') ? l.percent : null,
        severity: (l && l.severity) || 'normal',
        resetsAt: parseIsoDate(l && l.resets_at),
        isActive: !!(l && l.is_active),
        dollars: dollarsFromBucket(dollarBucketByKind[kind]),
      };
    });

    const sp = data.spend;
    if (!sp || !sp.used || typeof sp.used.amount_minor !== 'number') throw new Error('missing spend.used.amount_minor');
    const usedExponent = sp.used.exponent;
    if (typeof usedExponent !== 'number' || !isFinite(usedExponent)) throw new Error('missing/invalid spend.used.exponent');

    const used = moneyFromMinor(sp.used.amount_minor, usedExponent);
    let limit = null;
    if (sp.limit && typeof sp.limit.amount_minor === 'number') {
      const limitExponent = typeof sp.limit.exponent === 'number' ? sp.limit.exponent : usedExponent;
      limit = moneyFromMinor(sp.limit.amount_minor, limitExponent);
    }
    const headroom = (used != null && limit != null) ? limit - used : null;

    const spend = {
      used, limit, headroom,
      percent: typeof sp.percent === 'number' ? sp.percent : null,
      severity: sp.severity || 'normal',
      enabled: sp.enabled !== false,
    };

    const eu = data.extra_usage;
    const extraUsage = eu ? {
      isEnabled: eu.is_enabled !== false,
      spendLimitReached: !!eu.spend_limit_reached,
      userDisabled: !!eu.user_disabled,
    } : null;

    return { limits, spend, extraUsage, receivedAt: Date.now() };
  }

  /* ============================================================
   * BROWSER RUNTIME
   * ============================================================ */
  if (typeof window !== 'undefined' && window.top === window.self) {
    (function () {

  /* ================= CONFIG ================= */
  const VERSION = '31.2';
  const LS_KEY = 'clt25_state';         // legacy key — keeps orgId and badge position across upgrades
  const STALE_MS = 10 * 60e3;           // widget dims past this data age
  const POLL_ACTIVE_MS = 60e3;          // active poll interval, tab visible
  const POLL_HIDDEN_MS = 5 * 60e3;      // active poll interval, tab hidden
  const HEARTBEAT_MS = 15e3;            // local tick: countdown render + poll-due check
  const DEDUP_MS = 20 * 60e3;
  const KEEP = { session: 30 * 86400e3, weekly_all: 90 * 86400e3, spend: 62 * 86400e3, pairs: 90 * 86400e3 };
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFs2lUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNS41LjAiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iCiAgICB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIgogICAgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIKICAgZXhpZjpDb2xvclNwYWNlPSIxIgogICBleGlmOlBpeGVsWERpbWVuc2lvbj0iNjQiCiAgIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSI2NCIKICAgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIKICAgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIgogICB0aWZmOkltYWdlTGVuZ3RoPSI2NCIKICAgdGlmZjpJbWFnZVdpZHRoPSI2NCIKICAgdGlmZjpSZXNvbHV0aW9uVW5pdD0iMiIKICAgdGlmZjpYUmVzb2x1dGlvbj0iNzIvMSIKICAgdGlmZjpZUmVzb2x1dGlvbj0iNzIvMSIKICAgeG1wOk1ldGFkYXRhRGF0ZT0iMjAyNi0w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';

  /* ================= STATE ================= */
  function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }

  // TZ 31.1 §8: state is now small and fixed-size by default (sync, and the
  // history it feeds, are both off unless the user explicitly turns them on) —
  // the old 20%-trim-and-retry dance had nothing left worth trimming.
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); S.storageWarn = false; }
    catch (e) { S.storageWarn = true; }
  }

  const S = Object.assign({
    orgId: null, last: null, parsed: null, parseError: null, lastT: 0, hist: {},
    ui: { open: false, pos: null }, sync: null, syncEnabled: false, pairsPrev: null,
    storageWarn: false, histCleanedV311: false
  }, loadState());
  if (!S.hist) S.hist = {};
  if (!S.ui) S.ui = { open: false, pos: null };
  if (!S.sync) S.sync = { url: null, token: null, lastOk: null, ok: null };
  S.parsed = null;       // never trust a persisted "last good parse" across reloads — refetch and prove it fresh
  S.parseError = null;
  // first run: follow the browser language, then remember whatever the user picks
  if (!S.ui.lang) S.ui.lang = /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';

  // TZ 31.1 §7: one-time cleanup on upgrading to 31.1 — sync (and the history it
  // fed) is now off by default, so the arrays accumulated under 30.x/31.0 are
  // just dead weight in localStorage. Runs once ever, guarded by its own flag;
  // doesn't touch S.sync.url/token so a user who re-enables sync later doesn't
  // have to retype credentials.
  if (!S.histCleanedV311) {
    S.hist = {};
    S.pairsPrev = null;
    S.histCleanedV311 = true;
    saveState();
  }

  /* ================= I18N ================= */
  // UI strings only. Code and comments stay English so the repo is contributor-friendly.
  const I18N = {
    en: {
      code: 'EN',
      kindLabels: { session: '5-hour', weekly_all: 'Weekly' },
      countdownUnits: { d: 'd', h: 'h' },
      waitingData: '⏳ waiting for data', notStarted: 'not started',
      resetsInWord: 'resets in',
      creditsLabel: 'Credits', headroomLabel: 'Headroom', untilDate: d => 'until ' + d,
      creditsOffWarn: '⚠ credits OFF — work will stop when the plan limit is hit',
      spendLimitWarn: '⚠ monthly spend limit reached',
      userDisabledWarn: 'credits disabled manually',
      schemaChanged: '⚠ schema changed',
      fullDetail: 'Full detail → Usage',
      tipRefresh: 'Refresh', tipCollapse: 'Collapse', tipLang: 'Switch language',
      tipSync: 'Sync settings', syncUrlPh: 'Sync URL', syncTokenPh: 'Sync token',
      syncSave: 'Save', syncClear: 'Disable', syncCancel: 'Cancel',
      syncDisableWarn: 'Disabling erases the saved token — re-enter it to turn sync back on.',
      syncDisabledNote: 'Sync is off. Fill in and save to turn it on.',
      syncOffline: 'sync: offline', syncAgo: t => 'sync: ' + t,
      storageWarn: '⚠ storage', storageWarnTip: 'localStorage quota is tight — oldest history was trimmed to keep saving',
      rateLimited: t => 'rate-limited — retrying ' + t, paused: t => 'paused · retry ' + t,
      tipBadge: '5-hour window — click for detail, drag to move',
      noOrg: 'orgId not detected — open any chat', error: e => 'Error: ' + e,
      updatedAgo: t => 'updated ' + t,
      justNow: 'just now', minAgo: m => m + ' min ago', hourAgo: h => h + ' h ago'
    },
    ru: {
      code: 'RU',
      kindLabels: { session: '5 часов', weekly_all: 'Неделя' },
      countdownUnits: { d: 'д', h: 'ч' },
      waitingData: '⏳ ожидание данных', notStarted: 'не начато',
      resetsInWord: 'сброс через',
      creditsLabel: 'Кредиты', headroomLabel: 'Запас', untilDate: d => 'до ' + d,
      creditsOffWarn: '⚠ credits выключены — при исчерпании лимита работа встанет',
      spendLimitWarn: '⚠ месячный лимит трат достигнут',
      userDisabledWarn: 'credits выключены вручную',
      schemaChanged: '⚠ схема изменилась',
      fullDetail: 'Подробности → Usage',
      tipRefresh: 'Обновить', tipCollapse: 'Свернуть', tipLang: 'Переключить язык',
      tipSync: 'Настройки синхронизации', syncUrlPh: 'URL синхронизации', syncTokenPh: 'Токен синхронизации',
      syncSave: 'Сохранить', syncClear: 'Выключить', syncCancel: 'Отмена',
      syncDisableWarn: 'Выключение сотрёт сохранённый токен — при включении его нужно будет ввести заново.',
      syncDisabledNote: 'Синхронизация выключена. Заполни и сохрани, чтобы включить.',
      syncOffline: 'синхр.: офлайн', syncAgo: t => 'синхр.: ' + t,
      storageWarn: '⚠ память', storageWarnTip: 'локальное хранилище почти заполнено — старая история обрезана, чтобы сохранение продолжало работать',
      rateLimited: t => 'ограничение частоты — повтор ' + t, paused: t => 'пауза · повтор ' + t,
      tipBadge: '5-часовое окно — клик: детали, перетаскивание: переместить',
      noOrg: 'orgId не определён — открой любой чат', error: e => 'Ошибка: ' + e,
      updatedAgo: t => 'обновлено ' + t,
      justNow: 'только что', minAgo: m => m + ' мин назад', hourAgo: h => h + ' ч назад'
    }
  };
  function L() { return I18N[S.ui.lang] || I18N.en; }
  function toggleLang() { S.ui.lang = (S.ui.lang === 'ru') ? 'en' : 'ru'; saveState(); render(); }

  /* ================= DATA CAPTURE =================
   * Dual mode per TZ 31.0 section 1:
   *  - passive: the patched fetch below ingests any /usage response the UI itself
   *    triggers — free, and it fires exactly when the UI has fresh data.
   *  - active: a heartbeat-driven timer hits the same URL via origFetch (NOT
   *    window.fetch — that would recurse into this same patch) every 60s while
   *    the tab is visible, 5 min while hidden. A passive ingest resets that timer,
   *    since a request we'd have made ourselves is now redundant.
   */
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const p = origFetch.apply(this, arguments);
    try {
      const m = url.match(/\/api\/organizations\/([0-9a-f-]{36})/i);
      if (m && S.orgId !== m[1]) { S.orgId = m[1]; saveState(); }
      if (/\/api\/organizations\/[0-9a-f-]{36}\/usage(\?|$)/i.test(url)) {
        p.then(r => { if (r.ok) r.clone().json().then(ingest).catch(() => {}); }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  // Waits purely for interception, per TZ: no cookie/DOM fallback for org id.
  function detectOrg() { return S.orgId || null; }

  let polling = false;
  let nextPollAt = 0;    // heartbeat fires an active poll once Date.now() reaches this
  // In-memory only, deliberately — a paused state shouldn't survive a reload. If the
  // tab reopens, it should just try again rather than resume a stale backoff.
  let rateLimit = { until: 0, backoffMs: 0 };
  const BACKOFF_BASE_MS = POLL_ACTIVE_MS;
  const BACKOFF_MAX_MS = 15 * 60e3;

  function activePollInterval() { return document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS; }
  function scheduleNextPoll() { nextPollAt = Date.now() + activePollInterval(); }

  // Retry-After is either delta-seconds ("120") or an HTTP-date. Anything that parses
  // as neither returns null and falls through to our own exponential backoff.
  function parseRetryAfter(v) {
    if (!v) return null;
    const s = v.trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
    const t = Date.parse(s);
    return isFinite(t) ? Math.max(0, t - Date.now()) : null;
  }
  function scheduleBackoff(retryAfterMs) {
    let delay;
    if (retryAfterMs != null) {
      delay = Math.min(retryAfterMs, BACKOFF_MAX_MS);
      rateLimit.backoffMs = 0; // server gave an authoritative delay — our own ladder resets
    } else {
      rateLimit.backoffMs = Math.min(rateLimit.backoffMs ? rateLimit.backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
      delay = rateLimit.backoffMs;
    }
    rateLimit.until = Date.now() + delay;
  }

  function setParseError(msg) {
    S.parseError = msg; S.parsed = null;
    saveState(); render();
    console.warn('[claude-limits] parse error:', msg);
  }

  // Network-level failures (offline, DNS, timeout) stay silent and just retry later —
  // the countdown keeps ticking off the last good data. Only a response that actually
  // arrived but doesn't match the expected schema is fail-loud.
  //
  // `finally` always reschedules the next attempt exactly once per real attempt —
  // without it, a poll that returns early (no org yet, a network exception) would
  // leave nextPollAt at the Infinity the heartbeat sets before calling poll(),
  // and the heartbeat would never try again.
  async function poll(manual) {
    if (polling) return;
    polling = true;
    try {
      if (Date.now() < rateLimit.until) {
        if (manual) toast(L().rateLimited(fmtTime(rateLimit.until)));
        return;
      }
      const org = detectOrg();
      if (!org) { if (manual) toast(L().noOrg); return; }

      setBadgeSpin(true);
      let r;
      try {
        r = await origFetch(`/api/organizations/${org}/usage`, { headers: { accept: 'application/json' }, credentials: 'include' });
      } catch (e) {
        if (manual) toast(L().error(e.message));
        return;
      }

      if (r.status === 429) {
        scheduleBackoff(parseRetryAfter(r.headers.get('retry-after')));
        if (manual) toast('usage: HTTP 429');
        return;
      }

      rateLimit = { until: 0, backoffMs: 0 };
      let json = null, jsonErr = null;
      try { json = await r.json(); } catch (e) { jsonErr = e; }
      if (!r.ok) setParseError('http ' + r.status);
      else if (jsonErr) setParseError(jsonErr.message);
      else ingest(json);
    } finally {
      scheduleNextPoll();
      polling = false; setBadgeSpin(false); render();
    }
  }

  function pushHist(key, val) {
    const arr = S.hist[key] = S.hist[key] || [];
    const prev = arr[arr.length - 1], now = Date.now();
    if (!prev || prev.p !== val || now - prev.t > DEDUP_MS) arr.push({ t: now, p: val });
    const keep = KEEP[key] || KEEP.weekly_all;
    while (arr.length && arr[0].t < now - keep) arr.shift();
  }

  // Stage 7a: collect raw {t, ds, dw} deltas between successive polls, whenever both
  // the session and weekly percentage grew (a session reset makes ds negative and the
  // pair is skipped). Pure accumulation for lib/ceiling.js's weekly-ceiling regression,
  // frozen and unwired per TZ 31.0 section 5 — not read by this widget.
  function recordPair(sessPct, weekPct) {
    if (sessPct == null || weekPct == null) return;
    const prev = S.pairsPrev;
    if (prev && prev.session != null && prev.weekly != null) {
      const ds = sessPct - prev.session, dw = weekPct - prev.weekly;
      if (ds > 0 && dw > 0) {
        const arr = S.hist.pairs = S.hist.pairs || [];
        const now = Date.now();
        arr.push({ t: now, ds, dw });
        const keep = KEEP.pairs;
        while (arr.length && arr[0].t < now - keep) arr.shift();
      }
    }
    S.pairsPrev = { session: sessPct, weekly: weekPct };
  }

  // limits[].is_active flips between buckets for reasons not yet understood — log it,
  // never act on it. Per TZ 31.0: "писать в консоль при изменении, в UI не использовать."
  let lastActiveByKind = {};
  function logActiveChanges(limits) {
    for (const l of limits) {
      if (l.kind == null) continue;
      const prev = lastActiveByKind[l.kind];
      if (prev !== undefined && prev !== l.isActive) {
        console.log('[claude-limits] limits.is_active changed for', l.kind, prev, '->', l.isActive);
      }
      lastActiveByKind[l.kind] = l.isActive;
    }
  }

  function ingest(data) {
    let parsed;
    try {
      parsed = parseUsage(data);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    S.last = data; S.parsed = parsed; S.parseError = null; S.lastT = Date.now();

    // TZ 31.1 §6: local history collection is stubbed out along with sync itself —
    // nothing reads S.hist except the sync payload, so there's no point accumulating
    // it while sync is off. Code stays intact; only the execution path is gated,
    // so turning sync back on resumes collection with a single flag flip.
    if (S.syncEnabled) {
      for (const l of parsed.limits) pushHist(l.kind, l.percent != null ? l.percent : 0);
      if (parsed.spend && parsed.spend.limit != null) {
        const pct = parsed.spend.percent != null ? parsed.spend.percent
          : (parsed.spend.limit > 0 ? parsed.spend.used / parsed.spend.limit * 100 : 0);
        pushHist('spend', pct);
      }
      const sess = parsed.limits.find(l => l.kind === 'session');
      const week = parsed.limits.find(l => l.kind === 'weekly_all');
      recordPair(sess ? sess.percent : null, week ? week.percent : null);
    }
    logActiveChanges(parsed.limits);

    scheduleNextPoll();  // passive ingest resets the active-poll timer too
    saveState(); render();
  }

  /* ================= SYNC =================
   * Frozen per TZ 31.0 section 5 — merges S.hist across devices through a small
   * self-hosted endpoint (docs/TZ-sync-etap9.md). Works, verified 23.08. Keeps
   * writing history; not read by this widget for any decision. Uses origFetch
   * exclusively — the patched window.fetch above would recurse back into ingest().
   */
  function syncUrl() { return S.sync.url.replace(/\/+$/, '') + '/sync'; }

  function syncPayload() {
    const out = {};
    for (const k in S.hist) out[k] = S.hist[k];
    let body = JSON.stringify({ hist: out });
    if (body.length > 1e6 && S.sync.lastOk) {
      const trimmed = {};
      for (const k in out) trimmed[k] = (out[k] || []).filter(p => p.t > S.sync.lastOk);
      body = JSON.stringify({ hist: trimmed });
    }
    return body;
  }

  // Only accept well-formed point arrays for known-shaped keys. A malformed or
  // unexpected server response must never corrupt S.hist. 'pairs' is {t,ds,dw}, not
  // {t,p} — filtering it against the point shape would silently strip every entry.
  function sanitizeHist(hist) {
    const out = {};
    for (const k in hist) {
      const arr = hist[k];
      if (!Array.isArray(arr)) continue;
      out[k] = (k === 'pairs')
        ? arr.filter(p => p && typeof p.t === 'number' && typeof p.ds === 'number' && typeof p.dw === 'number')
        : arr.filter(p => p && typeof p.t === 'number' && typeof p.p === 'number');
    }
    return out;
  }

  async function syncNow() {
    // TZ 31.1 §1/§3: off by default, and while off this must be the only check —
    // zero requests to the worker domain, not even a check of stored credentials.
    if (!S.syncEnabled) return;
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
      S.hist = sanitizeHist(data.hist);
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

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ================= FORMATTING ================= */
  function fmtTime(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function fmtAgo(ms) {
    const m = Math.floor(ms / 60e3);
    if (m < 1) return L().justNow;
    if (m < 60) return L().minAgo(m);
    return L().hourAgo(Math.floor(m / 60));
  }
  function fmtMonthDay(ts) {
    try { return new Intl.DateTimeFormat(S.ui.lang === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric' }).format(new Date(ts)); }
    catch (e) { return new Date(ts).toDateString(); }
  }
  function monthReset() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }

  const SEVERITY_COLORS = { normal: '#4ade80', warning: '#fbbf24', critical: '#ef4444' };
  function severityColor(sev) { return SEVERITY_COLORS[sev] || '#8b8b94'; } // unknown severity -> neutral, not an error

  /* ================= UI ================= */
  const COLORS = { muted: '#8b8b94', bad: '#ef4444', accent: '#D97757' };
  let root, badge, badgeTxt, panel;

  function css() {
    return `
#clt-root{position:fixed;z-index:2147483000;right:16px;bottom:90px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;transition:opacity .3s;}
#clt-root.clt-stale{opacity:.55;}
#clt-badge{display:flex;align-items:center;gap:7px;background:#1a1a1f;border:1px solid #33333c;border-radius:999px;padding:5px 12px 5px 6px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);user-select:none;}
#clt-badge:hover{border-color:#4b4b57;}
#clt-badge img{width:24px;height:24px;display:block;}
#clt-badge .t{font-size:13px;font-weight:700;letter-spacing:.2px;white-space:nowrap;}
#clt-badge.spin img{animation:cltrot 1s linear infinite;}
@keyframes cltrot{to{transform:rotate(360deg)}}
#clt-panel{position:absolute;right:0;bottom:44px;width:270px;max-width:calc(100vw - 32px);background:#17171c;border:1px solid #33333c;border-radius:16px;padding:12px 14px 9px;box-shadow:0 10px 34px rgba(0,0,0,.6);color:#e8e8ee;display:none;}
#clt-panel.open{display:block;}
.clt-hd{display:flex;align-items:center;gap:6px;margin-bottom:8px;}
.clt-hd .t{font-size:11px;font-weight:600;color:#8b8b94;flex:1;letter-spacing:.3px;text-transform:uppercase;}
.clt-hd button{background:none;border:none;color:#8b8b94;cursor:pointer;font-size:13px;padding:2px 5px;border-radius:6px;line-height:1;}
.clt-hd button:hover{background:#26262d;color:#fff;}
.clt-hd button.lang{font-size:9.5px;font-weight:700;letter-spacing:.5px;border:1px solid #3a3a44;padding:2px 5px;}
.clt-row{display:flex;align-items:baseline;gap:8px;padding:7px 0;border-top:1px solid #26262d;font-size:12.5px;}
.clt-row:first-child{border-top:none;padding-top:0;}
.clt-row .n{color:#c9c9d2;flex:0 0 auto;}
.clt-row .v{font-weight:700;flex:0 0 auto;}
.clt-row .r{color:#8b8b94;margin-left:auto;text-align:right;font-size:11px;white-space:nowrap;}
.clt-row .r b{color:#e8e8ee;font-weight:700;font-style:normal;}
.clt-wbar{position:relative;height:3px;background:#2a2a31;border-radius:2px;margin:-1px 0 8px;}
.clt-wbar i{display:block;height:100%;border-radius:2px;transition:width .4s;}
.clt-wbar b{position:absolute;top:-2.5px;bottom:-2.5px;width:1.5px;margin-left:-.75px;background:#e8e8ee;opacity:.55;border-radius:1px;}
.clt-warn{font-size:11px;margin-top:2px;padding:2px 0;color:${COLORS.bad};font-weight:500;}
.clt-sync{padding:2px 0 12px;border-bottom:1px solid #26262d;margin-bottom:2px;}
.clt-sync-note{font-size:10.5px;color:#8b8b94;margin-bottom:8px;line-height:1.4;}
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

  function headerHtml() {
    return `<div class="clt-hd"><span class="t">Claude Limits</span>
      <button id="clt-l" class="lang" title="${L().tipLang}">${L().code}</button>
      <button id="clt-s" title="${L().tipSync}">⇄</button>
      <button id="clt-r" title="${L().tipRefresh}">↻</button>
      <button id="clt-x" title="${L().tipCollapse}">✕</button></div>`;
  }

  function syncFormHtml() {
    // TZ 31.1 §2: the warning shows *before* Disable is clicked, not as an
    // after-the-fact confirmation — it's a static caption, always visible
    // whenever there's a token that Disable would actually erase.
    const note = S.syncEnabled
      ? `<div class="clt-sync-note">${L().syncDisableWarn}</div>`
      : `<div class="clt-sync-note">${L().syncDisabledNote}</div>`;
    return `<div class="clt-sync">
      ${note}
      <input id="clt-sync-url" type="text" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${L().syncUrlPh}" value="${esc(S.sync.url || '')}">
      <input id="clt-sync-token" type="password" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${L().syncTokenPh}" value="${esc(S.sync.token || '')}">
      <div class="clt-sync-btns">
        <button id="clt-sync-cancel">${L().syncCancel}</button>
        <button id="clt-sync-clear">${L().syncClear}</button>
        <button id="clt-sync-save" class="primary">${L().syncSave}</button>
      </div>
    </div>`;
  }

  // one row per `limits[]` entry, generic by design — a new `kind` Anthropic ships
  // tomorrow renders on its own via labelForKind(), nothing here special-cases names.
  function limitRowHtml(l) {
    const now = Date.now();
    const idle = l.kind === 'session' && (!l.resetsAt || l.resetsAt <= now);
    const col = severityColor(l.severity);
    // session/weekly_all get a proper localized name; anything else falls back
    // to the generic humanized label parseUsage already computed.
    const label = (L().kindLabels && L().kindLabels[l.kind]) || l.label;
    let valueTxt;
    if (l.dollars && (l.dollars.used != null || l.dollars.remaining != null)) {
      valueTxt = l.dollars.used != null && l.dollars.limit != null
        ? '$' + l.dollars.used.toFixed(2) + ' / $' + l.dollars.limit.toFixed(2)
        : '$' + (l.dollars.remaining != null ? l.dollars.remaining.toFixed(2) : l.dollars.used.toFixed(2));
    } else {
      valueTxt = idle ? '0%' : (l.percent != null ? Math.round(l.percent) + '%' : '—');
    }
    // the countdown figure itself is highlighted bright/bold, same treatment as
    // the Headroom value — everything around it (the label word) stays muted.
    let right;
    if (idle) right = esc(L().notStarted);
    else if (l.resetsAt && l.resetsAt > now) right = esc(L().resetsInWord) + ' <b class="rt">' + esc(fmtCountdown(l.resetsAt - now, L().countdownUnits)) + '</b>';
    else right = '';
    return `<div class="clt-row"><span class="n">${esc(label)}</span><span class="v" style="color:${col}">${valueTxt}</span><span class="r">${right}</span></div>`;
  }

  const WEEK_MS = 7 * 86400e3;

  // A quiet, label-free read of "am I ahead of or behind a plain calendar-linear
  // pace toward the weekly limit" — the tick sits where usage would be if it grew
  // evenly across the 7-day window (no activity-profile weighting, just elapsed
  // / total); the bar is the real percent. Green while under the tick, Anthropic
  // orange once it's past it. Only for weekly_all — deliberately not a generic
  // per-row feature, and not extended to any other `limits[]` kind.
  function weeklyProgressHtml(l) {
    if (l.kind !== 'weekly_all' || !l.resetsAt || l.percent == null) return '';
    const weekStart = l.resetsAt - WEEK_MS;
    const elapsed = Math.min(Math.max(Date.now() - weekStart, 0), WEEK_MS);
    const tickPct = elapsed / WEEK_MS * 100;
    const fillPct = Math.min(100, Math.max(0, l.percent));
    const barColor = fillPct > tickPct ? COLORS.accent : '#4ade80';
    return `<div class="clt-wbar"><i style="width:${fillPct.toFixed(1)}%;background:${barColor}"></i><b style="left:${tickPct.toFixed(1)}%"></b></div>`;
  }

  function creditsRowHtml(spend) {
    if (!spend || !spend.enabled || spend.limit == null) return '';
    const col = severityColor(spend.severity);
    const pct = spend.percent != null ? Math.round(spend.percent) : (spend.limit > 0 ? Math.round(spend.used / spend.limit * 100) : 0);
    return `<div class="clt-row"><span class="n">${L().creditsLabel}</span><span class="v" style="color:${col}">$${spend.used.toFixed(2)} / $${spend.limit.toFixed(2)}</span><span class="r">(${pct}%)</span></div>`;
  }

  function headroomRowHtml(spend) {
    if (!spend || spend.headroom == null) return '';
    return `<div class="clt-row"><span class="n">${L().headroomLabel}</span><span class="v">$${spend.headroom.toFixed(2)}</span><span class="r">${L().untilDate(fmtMonthDay(monthReset()))}</span></div>`;
  }

  function creditWarningsHtml(extra) {
    if (!extra) return '';
    const lines = [];
    if (extra.isEnabled === false) lines.push(L().creditsOffWarn);
    if (extra.spendLimitReached) lines.push(L().spendLimitWarn);
    if (extra.userDisabled) lines.push(L().userDisabledWarn);
    return lines.map(t => `<div class="clt-warn">${esc(t)}</div>`).join('');
  }

  function bodyHtml() {
    if (S.parseError) {
      return `<div class="clt-row"><span class="n" style="color:${COLORS.bad}">${L().schemaChanged}</span></div>`;
    }
    if (!S.parsed) {
      return `<div class="clt-row"><span class="n" style="color:${COLORS.muted}">${L().waitingData}</span></div>`;
    }
    let html = '';
    for (const l of S.parsed.limits) {
      html += limitRowHtml(l);
      html += weeklyProgressHtml(l);
    }
    html += creditsRowHtml(S.parsed.spend);
    html += headroomRowHtml(S.parsed.spend);
    html += creditWarningsHtml(S.parsed.extraUsage);
    return html;
  }

  function footerHtml() {
    if (S.parseError) {
      return `<div class="clt-ft"><a href="/settings/usage" target="_blank">${L().fullDetail}</a><span class="sp"></span><span>v${VERSION}</span></div>`;
    }
    // TZ 31.1 §3: silent about sync entirely while it's off — not even "offline"
    const syncBit = (!S.syncEnabled || !S.sync.url) ? '' : (S.sync.ok === false)
      ? `<span style="color:#fbbf24">${L().syncOffline}</span>`
      : (S.sync.lastOk ? `<span style="color:#5f5f68">${L().syncAgo(fmtAgo(Date.now() - S.sync.lastOk))}</span>` : '');
    const storBit = S.storageWarn ? `<span style="color:#fbbf24" title="${L().storageWarnTip}">${L().storageWarn}</span>` : '';
    const pauseBit = Date.now() < rateLimit.until ? `<span style="color:#fbbf24">${L().paused(fmtTime(rateLimit.until))}</span>` : '';
    const stale = S.lastT && (Date.now() - S.lastT > STALE_MS);
    return `<div class="clt-ft">
      <a href="/settings/usage" target="_blank">${L().fullDetail}</a><span class="sp"></span>
      ${pauseBit}
      ${storBit}
      ${syncBit}
      <span style="color:${stale ? '#fbbf24' : '#5f5f68'}">${S.lastT ? L().updatedAgo(fmtAgo(Date.now() - S.lastT)) : L().waitingData}</span>
      <span>v${VERSION}</span></div>`;
  }

  // One bad data point (malformed history, an unexpected sync response) must not
  // wedge the widget into a permanently stale state — catch, show something honest,
  // keep the poll/sync timers running so it can recover on its own next tick.
  function render() {
    if (!badge) return;
    try {
      renderInner();
    } catch (e) {
      badgeTxt.textContent = '⚠'; badgeTxt.style.color = COLORS.bad;
      if (panel) panel.classList.remove('open');
    }
  }

  function renderInner() {
    /* --- badge --- */
    if (S.parseError) {
      badgeTxt.textContent = '⚠'; badgeTxt.style.color = COLORS.bad;
    } else if (!S.parsed) {
      badgeTxt.textContent = '⏳'; badgeTxt.style.color = COLORS.muted;
    } else {
      const sess = S.parsed.limits.find(l => l.kind === 'session');
      const now = Date.now();
      if (sess && sess.resetsAt && sess.resetsAt > now) {
        badgeTxt.textContent = fmtTime(sess.resetsAt) + ' · ' + Math.round(sess.percent) + '%';
        badgeTxt.style.color = severityColor(sess.severity);
      } else if (sess) {
        badgeTxt.textContent = L().notStarted; badgeTxt.style.color = COLORS.muted;
      } else {
        badgeTxt.textContent = '—'; badgeTxt.style.color = COLORS.muted;
      }
    }
    badge.title = L().tipBadge;

    root.classList.toggle('clt-stale', !!(!S.parseError && S.lastT && Date.now() - S.lastT > STALE_MS));
    panel.classList.toggle('open', !!S.ui.open);
    if (!S.ui.open) return;

    panel.innerHTML = headerHtml() + (syncFormOpen ? syncFormHtml() : '') + bodyHtml() + footerHtml();

    const rb = panel.querySelector('#clt-r'), xb = panel.querySelector('#clt-x'), lb = panel.querySelector('#clt-l'), sb = panel.querySelector('#clt-s');
    if (lb) lb.onclick = toggleLang;
    if (sb) sb.onclick = toggleSyncForm;
    if (rb) rb.onclick = () => poll(true);
    if (xb) xb.onclick = () => { S.ui.open = false; saveState(); render(); };

    if (syncFormOpen) {
      const uEl = panel.querySelector('#clt-sync-url'), tEl = panel.querySelector('#clt-sync-token');
      const saveB = panel.querySelector('#clt-sync-save'), clearB = panel.querySelector('#clt-sync-clear'), cancelB = panel.querySelector('#clt-sync-cancel');
      if (saveB) saveB.onclick = () => {
        const url = ((uEl && uEl.value) || '').trim(), token = ((tEl && tEl.value) || '').trim();
        S.sync = { url: url || null, token: token || null, lastOk: null, ok: null };
        S.syncEnabled = !!(S.sync.url && S.sync.token);   // TZ 31.1 §2: Save turns sync on
        syncFormOpen = false; saveState(); render();
        if (S.syncEnabled) syncNow();
      };
      if (clearB) clearB.onclick = () => {
        // TZ 31.1 §2: Disable erases the stored URL/token, not just the flag —
        // re-enabling later means typing them in again.
        S.sync = { url: null, token: null, lastOk: null, ok: null };
        S.syncEnabled = false;
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
  function heartbeat() {
    render();
    if (Date.now() >= nextPollAt && Date.now() >= rateLimit.until) {
      nextPollAt = Infinity;   // poll() reschedules on completion; prevents re-entry while in flight
      poll(false);
    }
  }

  function start() {
    buildUI();
    setTimeout(heartbeat, 2500);   // first paint shouldn't wait a full heartbeat cycle
    setInterval(heartbeat, HEARTBEAT_MS);
    setTimeout(syncNow, 4000);
    setInterval(syncNow, 15 * 60e3);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - S.lastT > POLL_ACTIVE_MS) nextPollAt = 0;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

    })();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseUsage, parseIsoDate, fmtCountdown, labelForKind, moneyFromMinor };
  }
})();
