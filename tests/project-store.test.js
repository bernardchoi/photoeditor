'use strict';

const assert = require('node:assert/strict');
const { createPhotoSnapshot, applyPhotoSnapshot } = require('../project-store.js');

const source = {
  params: { autoStrength: 55, saturation: 4 }, paramsCustomized: true,
  environmentOverride: 'indoor', crop: { zoom: 1.2, x: 0.4, y: 0.3 },
  reviewApproved: true, validationResult: 'correct', exportIncluded: false, selectionManual: true,
};
const snapshot = createPhotoSnapshot(source);
const restored = applyPhotoSnapshot({ params: {}, crop: {} }, snapshot);
assert.deepEqual(restored.params, source.params);
assert.deepEqual(restored.crop, source.crop);
assert.equal(restored.cropRestored, true);
assert.equal(restored.environmentOverride, 'indoor');
assert.equal(restored.exportIncluded, false);
assert.equal(restored.validationResult, 'correct');
console.log('project-store: snapshot restore checks passed');
