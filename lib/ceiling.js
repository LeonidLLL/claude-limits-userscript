'use strict';

// Pure functions estimating the weekly-ceiling conversion coefficient X (the dw/ds
// ratio used by stage 7b: potolok = used + available_windows * X). Deliberately
// isolated from claude-limits.user.js — not required by it, not wired into any UI —
// so it's testable without a browser and without touching the running script.
// See docs/STATUS.md ("Гранулярность weekly") and docs/TZ-v30.md section 3.4.
//
// Input shape: an array of snapshots { t, session, weekly } — the session and weekly
// percentages read at the same moment. A real caller eventually builds this by joining
// S.hist.session and S.hist.weekly_all; that join isn't implemented here on purpose —
// it's a separate concern from the math, and premature to design before 7b actually
// wires this up.

const NOMINAL_POLL_MS = 5 * 60e3;            // matches POLL_MINUTES in the userscript
const SEGMENT_GAP_MS = 2 * NOMINAL_POLL_MS;  // segment boundary: gap > 2x nominal interval

const MIN_SEGMENTS = 3;
const MIN_COVERAGE_PP = 15;   // minimum summed Delta(weekly) across used segments, percentage points
const X_MIN = 0.005;
const X_MAX = 0.2;

// Cut a time-sorted snapshot array into runs with no gap larger than maxGapMs. Does
// NOT filter by length — splitCleanSegments does that; estimateX wants the raw split
// too, to report how much got dropped and why.
function splitRawSegments(snapshots, maxGapMs) {
  if (!snapshots || !snapshots.length) return [];
  const segments = [];
  let cur = [snapshots[0]];
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i].t - snapshots[i - 1].t > maxGapMs) {
      segments.push(cur);
      cur = [];
    }
    cur.push(snapshots[i]);
  }
  segments.push(cur);
  return segments;
}

// Segments shorter than two snapshots carry no delta and are discarded.
function splitCleanSegments(snapshots, maxGapMs) {
  return splitRawSegments(snapshots, maxGapMs).filter(seg => seg.length >= 2);
}

// Sum of only the positive steps of `key` across [fromIdx, toIdx] (inclusive). The
// endpoints-only difference is unsafe for `session`, which resets every 5 hours and
// can be lower at toIdx than somewhere in between; summing only forward movement
// measures total progress instead of a net (and possibly negative, or wrongly small)
// displacement.
function deltaSum(snapshots, fromIdx, toIdx, key) {
  let sum = 0;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const d = snapshots[i][key] - snapshots[i - 1][key];
    if (d > 0) sum += d;
  }
  return sum;
}

function sessionDelta(snapshots, fromIdx, toIdx) {
  return deltaSum(snapshots, fromIdx, toIdx, 'session');
}

function weeklyDelta(snapshots, fromIdx, toIdx) {
  return deltaSum(snapshots, fromIdx, toIdx, 'weekly');
}

// X = Sigma(Delta weekly) / Sigma(Delta session) across all clean segments — a ratio
// of sums, not a median of per-segment ratios. Weekly is API-rounded to whole percent
// (confirmed empirically against real history, see docs/STATUS.md), so any single
// segment's own ratio can be off by roughly +-50%; pooling numerator and denominator
// separately before dividing once cancels that noise instead of letting a handful of
// zero- or noise-dominated segments drag a median around.
//
// A segment with zero session movement (ds <= 0) is skipped — it carries no signal
// for the denominator. A segment with positive session movement but zero weekly
// movement (rounding) is kept: it correctly contributes 0 to the numerator and its
// real ds to the denominator, which is exactly how "ratio of sums" absorbs that noise.
//
// ok is true only when every guard passes; when it's false, x is null and nothing
// else here is meant to reach the UI — per the widget's standing rule, uncertainty
// produces silence, not a "low confidence" badge.
function estimateX(snapshots) {
  const sorted = (snapshots || []).slice().sort((a, b) => a.t - b.t);
  const raw = splitRawSegments(sorted, SEGMENT_GAP_MS);
  const clean = raw.filter(seg => seg.length >= 2);

  let sumDs = 0, sumDw = 0, usedSegments = 0;
  for (const seg of clean) {
    const ds = sessionDelta(seg, 0, seg.length - 1);
    if (ds <= 0) continue;
    const dw = weeklyDelta(seg, 0, seg.length - 1);
    sumDs += ds;
    sumDw += dw;
    usedSegments++;
  }

  const x = sumDs > 0 ? sumDw / sumDs : null;
  const coverage = sumDw;
  const ok = usedSegments >= MIN_SEGMENTS && coverage >= MIN_COVERAGE_PP &&
    x != null && x >= X_MIN && x <= X_MAX;

  return {
    x: ok ? x : null,
    coverage,
    segments: usedSegments,
    ok,
    // debugging only — never surface in the UI
    diagnostics: {
      totalSnapshots: sorted.length,
      segmentsFound: raw.length,
      gapBoundaries: Math.max(0, raw.length - 1),
      segmentsDroppedForLength: raw.length - clean.length,
    },
  };
}

module.exports = {
  NOMINAL_POLL_MS, SEGMENT_GAP_MS, MIN_SEGMENTS, MIN_COVERAGE_PP, X_MIN, X_MAX,
  splitRawSegments, splitCleanSegments, sessionDelta, weeklyDelta, estimateX,
};
