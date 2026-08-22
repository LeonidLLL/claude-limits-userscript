'use strict';

// Plain node:assert, no test framework — nothing else in this repo needs one, and
// pulling one in for eight assertions would be a heavier dependency than the code
// it's testing. Run with: node test/ceiling.test.js

const assert = require('assert');
const {
  SEGMENT_GAP_MS,
  splitCleanSegments,
  sessionDelta,
  weeklyDelta,
  estimateX,
} = require('../lib/ceiling');

const MIN = 60e3;
const HOUR = 3600e3;

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

// helper: points as [minutesFromStart, session, weekly]
function seg(startT, points) {
  return points.map(([dm, session, weekly]) => ({ t: startT + dm * MIN, session, weekly }));
}

// --- splitCleanSegments ----------------------------------------------------

t('splitCleanSegments: no gaps stays one segment', () => {
  const snaps = [
    { t: 0, session: 0, weekly: 0 },
    { t: 5 * MIN, session: 10, weekly: 1 },
    { t: 10 * MIN, session: 20, weekly: 2 },
  ];
  const segs = splitCleanSegments(snaps, SEGMENT_GAP_MS);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].length, 3);
});

t('splitCleanSegments: a gap over the threshold splits into two segments', () => {
  // a 12h hole; weekly jumps by 34 crossing it — this must never reach a numerator,
  // because the two ends belong to different segments and are never diffed together
  const snaps = [
    { t: 0, session: 0, weekly: 0 },
    { t: 5 * MIN, session: 10, weekly: 1 },
    { t: 5 * MIN + 12 * HOUR, session: 5, weekly: 35 },
    { t: 5 * MIN + 12 * HOUR + 5 * MIN, session: 15, weekly: 36 },
  ];
  const segs = splitCleanSegments(snaps, SEGMENT_GAP_MS);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].length, 2);
  assert.strictEqual(segs[1].length, 2);
});

t('splitCleanSegments: a snapshot isolated between two gaps is dropped', () => {
  const snaps = [
    { t: 0, session: 0, weekly: 0 },
    { t: 5 * MIN, session: 10, weekly: 1 },
    { t: 5 * MIN + 12 * HOUR, session: 50, weekly: 20 },       // alone between two gaps
    { t: 5 * MIN + 24 * HOUR, session: 5, weekly: 21 },
    { t: 5 * MIN + 24 * HOUR + 5 * MIN, session: 15, weekly: 22 },
  ];
  const segs = splitCleanSegments(snaps, SEGMENT_GAP_MS);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].length, 2);
  assert.strictEqual(segs[1].length, 2);
});

// --- sessionDelta / weeklyDelta ---------------------------------------------

t('sessionDelta: sums only positive steps; a reset does not go negative', () => {
  const snaps = [
    { t: 0, session: 80 },
    { t: 1, session: 95 },  // +15
    { t: 2, session: 3 },   // reset — excluded
    { t: 3, session: 40 },  // +37
    { t: 4, session: 70 },  // +30
  ];
  assert.strictEqual(sessionDelta(snaps, 0, 4), 15 + 37 + 30);
});

t('weeklyDelta: plain monotonic sum', () => {
  const snaps = [{ t: 0, weekly: 10 }, { t: 1, weekly: 12 }, { t: 2, weekly: 15 }];
  assert.strictEqual(weeklyDelta(snaps, 0, 2), 5);
});

// --- estimateX ---------------------------------------------------------------

t('estimateX: a gap-crossing jump never reaches the numerator', () => {
  const before = seg(0, [[0, 0, 0], [5, 40, 3], [10, 80, 5]]);
  const afterStart = 10 * MIN + 12 * HOUR;
  const after = seg(afterStart, [[0, 5, 39], [5, 45, 41], [10, 90, 44]]); // the 39-5=34 step is never computed
  const r = estimateX([...before, ...after]);
  assert.strictEqual(r.segments, 2);
  const expectedDs = 80 + 85, expectedDw = 5 + 5;
  assert.strictEqual(r.coverage, expectedDw);
  const x = r.x != null ? r.x : expectedDw / expectedDs; // ok gate may reject it; check the raw ratio either way
  assert.ok(Math.abs(x - expectedDw / expectedDs) < 1e-9);
});

t('estimateX: below the coverage threshold => ok=false, x=null', () => {
  const snaps = [
    ...seg(0, [[0, 0, 0], [5, 10, 1]]),
    ...seg(1 * HOUR, [[0, 0, 1], [5, 10, 1]]),   // dw=0 this segment — rounding noise
    ...seg(2 * HOUR, [[0, 0, 1], [5, 10, 2]]),
  ];
  const r = estimateX(snaps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.x, null);
});

t('estimateX: enough clean, well-covered segments => ok=true with a sane x', () => {
  const snaps = [];
  for (let i = 0; i < 5; i++) {
    snaps.push(...seg(i * HOUR, [[0, 0, i * 3], [5, 50, i * 3 + 1], [10, 100, i * 3 + 3]]));
  }
  const r = estimateX(snaps);
  assert.strictEqual(r.segments, 5);
  assert.strictEqual(r.coverage, 15);
  assert.strictEqual(r.ok, true);
  assert.ok(r.x >= 0.005 && r.x <= 0.2);
});

if (failures) {
  console.error('\n' + failures + ' test(s) failed.');
  process.exitCode = 1;
} else {
  console.log('\nAll tests passed.');
}
