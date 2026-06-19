'use strict';

const assert = require('node:assert/strict');
const {
  evaluateQualitySignals, isDuplicateCandidate, getSafeExportDimensions, shouldFlushZip,
} = require('../selection-engine.js');

const codes = metrics => evaluateQualitySignals(metrics).details.map(item => item.code);

assert.deepEqual(codes({ focusScore: 18, median: 125, clippedBright: 0.002, clippedDark: 0.004 }), []);
assert.ok(codes({ focusScore: 3, median: 120, clippedBright: 0, clippedDark: 0 }).includes('blur'));
assert.ok(codes({ focusScore: 14, median: 28, clippedBright: 0, clippedDark: 0.12 }).includes('dark'));
assert.ok(codes({ focusScore: 14, median: 228, clippedBright: 0.12, clippedDark: 0 }).includes('bright'));

const base = {
  aspect: 1.5,
  hash: '0'.repeat(64),
  avgColor: [120, 118, 116],
  luminanceHistogram: [0, 0, 0, 0.05, 0.1, 0.2, 0.25, 0.2, 0.1, 0.05, 0.03, 0.02, 0, 0, 0, 0],
  corr: { stats: { median: 122 } },
  faceCount: 4,
};

assert.equal(isDuplicateCandidate(base, { ...base, hash: `${'0'.repeat(62)}11` }), true);
assert.equal(isDuplicateCandidate(base, { ...base, avgColor: [180, 70, 60] }), false);
assert.equal(isDuplicateCandidate(base, { ...base, faceCount: 0 }), false);

assert.deepEqual(getSafeExportDimensions(6000, 4000), { width: 5196, height: 3464, scale: Math.sqrt(18_000_000 / 24_000_000) });
assert.equal(shouldFlushZip(100, 30, 5, 120), true);
assert.equal(shouldFlushZip(0, 130, 0, 120), false);

console.log('selection-engine: 10 checks passed');
