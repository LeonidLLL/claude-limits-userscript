'use strict';

// Plain node:assert, matching test/ceiling.test.js — run with: node test/parse.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseUsage, fmtCountdown } = require('../claude-limits.user.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/usage-2026-08-23.json'), 'utf8'));

let failures = 0;
function t(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL - ' + name);
    console.error('  ' + e.message);
  }
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// --- money -------------------------------------------------------------

t('money: 3005 / 10^2 -> 30.05', () => {
  const p = parseUsage(fixture);
  assert.strictEqual(p.spend.used, 30.05);
});

t('headroom: 50.00 - 30.05 -> 19.95', () => {
  const p = parseUsage(fixture);
  assert.strictEqual(Math.round(p.spend.headroom * 100) / 100, 19.95);
});

t('exponent: 3 in a hypothetical response is handled correctly', () => {
  const data = clone(fixture);
  data.spend.used = { amount_minor: 12345, currency: 'USD', exponent: 3 };
  data.spend.limit = { amount_minor: 50000, currency: 'USD', exponent: 3 };
  const p = parseUsage(data);
  assert.strictEqual(p.spend.used, 12.345);
  assert.strictEqual(p.spend.limit, 50);
});

// --- countdown -----------------------------------------------------------

t('countdown: derived from resets_at against an injected "now"', () => {
  const p = parseUsage(fixture);
  const sess = p.limits.find(l => l.kind === 'session');
  const now = Date.parse('2026-08-23T05:00:00.000Z');
  const ms = sess.resetsAt - now;
  assert.strictEqual(fmtCountdown(ms), '2:19');
});

// --- robustness ------------------------------------------------------------

t('unknown kind in limits does not crash the parser', () => {
  const data = clone(fixture);
  data.limits.push({ kind: 'tangelo_v2', group: 'promo', percent: 10, severity: 'normal', resets_at: null, scope: null, is_active: false });
  const p = parseUsage(data);
  const extra = p.limits.find(l => l.kind === 'tangelo_v2');
  assert.ok(extra);
  assert.strictEqual(extra.label, 'Tangelo V2');
});

t('missing limits array throws, does not silently return null', () => {
  const data = clone(fixture);
  delete data.limits;
  assert.throws(() => parseUsage(data));
});

t('missing spend.used.amount_minor throws', () => {
  const data = clone(fixture);
  delete data.spend.used.amount_minor;
  assert.throws(() => parseUsage(data));
});

t('non-numeric exponent throws', () => {
  const data = clone(fixture);
  data.spend.used.exponent = '2';
  assert.throws(() => parseUsage(data));
});

t('truncated JSON without spend throws (same fail-loud reaction)', () => {
  const data = clone(fixture);
  delete data.spend;
  assert.throws(() => parseUsage(data));
});

t('extra_usage warnings surface only on non-normal state', () => {
  const data = clone(fixture);
  data.extra_usage.is_enabled = false;
  const p = parseUsage(data);
  assert.strictEqual(p.extraUsage.isEnabled, false);
});

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
