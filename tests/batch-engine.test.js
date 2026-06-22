'use strict';

const assert = require('node:assert/strict');
const {
  getBatchProfile, mapWithConcurrency, assessStorageCapacity, getCapabilityReport,
} = require('../batch-engine.js');

assert.equal(getBatchProfile({ count: 100, viewportWidth: 390, deviceMemory: 4 }).analysisSide, 420);
assert.equal(getBatchProfile({ viewportWidth: 390, deviceMemory: 4, hardwareConcurrency: 2 }).decodeConcurrency, 1);
assert.equal(getBatchProfile({ viewportWidth: 1200, deviceMemory: 8, hardwareConcurrency: 8 }).decodeConcurrency, 3);
const MB = 1024 * 1024;
assert.equal(assessStorageCapacity(900 * MB, 1000 * MB, 200 * MB).canStore, false);
assert.equal(assessStorageCapacity(100 * MB, 1000 * MB, 100 * MB).level, 'ok');
assert.equal(getCapabilityReport({ Worker() {} }).workerPixels, true);
assert.equal(getCapabilityReport({}).rawDecode, false);

(async () => {
  let active = 0, maxActive = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4], 2, async value => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8]);
  assert.ok(maxActive <= 2);
  console.log('batch-engine: concurrency and storage checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
