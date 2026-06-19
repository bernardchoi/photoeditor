'use strict';

const assert = require('node:assert/strict');
const {
  luminance, transformLuminance, applySmartPixel, adjustLuminancePixel,
} = require('../retouch-engine.js');

const identity = { exposureEV: 0, shadowLift: 0, highlightCompression: 0, contrastBoost: 0, wb: [1, 1, 1], wbConfidence: 1 };
const identityPixel = applySmartPixel(80, 120, 160, identity, 1);
identityPixel.forEach((value, i) => assert.ok(Math.abs(value - [80, 120, 160][i]) < 0.01));

const tone = { ...identity, exposureEV: 0.35, shadowLift: 10, highlightCompression: 0.12, contrastBoost: 0.05 };
[
  tone,
  { ...identity, exposureEV: -0.3, highlightCompression: 0.2, contrastBoost: 0.08 },
  { ...identity, shadowLift: 14, contrastBoost: 0.1 },
].forEach(correction => {
  let previous = -1;
  for (let value = 0; value <= 255; value++) {
    const mapped = transformLuminance(value, correction, 1);
    assert.ok(mapped >= previous - 0.01, `tone curve must be monotonic at ${value}`);
    assert.ok(mapped >= 0 && mapped <= 255);
    previous = mapped;
  }
});

const wb = { ...identity, wb: [1.06, 1, 0.94], wbConfidence: 1 };
const neutral = applySmartPixel(120, 120, 120, wb, 1);
const saturated = applySmartPixel(30, 90, 220, wb, 1);
assert.ok(Math.abs(neutral[0] - neutral[2]) > Math.abs((saturated[0] - 30) - (saturated[2] - 220)) * 0.3);

const skin = applySmartPixel(180, 135, 105, wb, 1);
assert.ok(Math.abs(skin[0] - 180) < Math.abs(neutral[0] - 120));

const lifted = adjustLuminancePixel(45, 70, 110, 120);
assert.ok(Math.abs(luminance(...lifted) - 120) < 0.5);
assert.ok(Math.max(...lifted) <= 255 && Math.min(...lifted) >= 0);

assert.ok(transformLuminance(245, { ...identity, highlightCompression: 0.2 }, 1) < 245);
assert.ok(Math.abs(transformLuminance(110, { ...identity, highlightCompression: 0.2 }, 1) - 110) < 0.1);

for (let r = 0; r <= 255; r += 51) {
  for (let g = 0; g <= 255; g += 51) {
    for (let b = 0; b <= 255; b += 51) {
      const pixel = applySmartPixel(r, g, b, tone, 0.7);
      assert.ok(pixel.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
    }
  }
}

console.log('retouch-engine: tone and color protection checks passed');
