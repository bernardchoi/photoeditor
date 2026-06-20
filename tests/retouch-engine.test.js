'use strict';

const assert = require('node:assert/strict');
const {
  luminance, transformLuminance, applySmartPixel, adjustLuminancePixel,
  applyBasicAdjustmentsPixel, getLocalLiftWeight, applyTonalAdjustmentsPixel,
  computeDetailDelta, deriveAutoTone,
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
assert.ok(transformLuminance(245, { ...identity, exposureEV: 0.4 }, 1) < 252);

const neutralContrast = applyBasicAdjustmentsPixel(120, 120, 120, 0, 20, 0);
assert.ok(Math.max(...neutralContrast) - Math.min(...neutralContrast) < 0.01);
const colorContrast = applyBasicAdjustmentsPixel(170, 110, 90, 0, 20, 0);
assert.ok(colorContrast[0] > colorContrast[1] && colorContrast[1] > colorContrast[2]);
const vividBoost = applyBasicAdjustmentsPixel(25, 80, 220, 0, 0, 50);
assert.ok(vividBoost.every(value => value >= 0 && value <= 255));
assert.ok(getLocalLiftWeight(245, 245, 245) < getLocalLiftWeight(90, 90, 90));

const safeContrast = applyBasicAdjustmentsPixel(245, 245, 245, 0, 100, 0);
assert.ok(safeContrast[0] < 253);
const blackShadow = applyTonalAdjustmentsPixel(0, 0, 0, 0, 100);
assert.ok(blackShadow.every(value => value < 0.01));
const recoveredShadow = applyTonalAdjustmentsPixel(55, 55, 55, 0, 60);
assert.ok(recoveredShadow[0] > 55);
const protectedHighlight = applyTonalAdjustmentsPixel(220, 220, 220, 60, 0);
assert.ok(protectedHighlight[0] < 220 && protectedHighlight[0] > 180);
assert.ok(Math.abs(computeDetailDelta(45, 10, 0.7, 12)) < Math.abs(computeDetailDelta(120, 10, 0.7, 2)));

const balancedTone = deriveAutoTone(
  { p05: 24, p10: 36, median: 128, p95: 230, p99: 242, dynamicRange: 206, clippedBright: 0.001 },
  'unknown', { noiseScore: 3, skyRatio: 0 },
);
assert.deepEqual(balancedTone, { exposureEV: 0, shadowLift: 0, highlightCompression: 0, contrastBoost: 0 });
const darkIndoorTone = deriveAutoTone(
  { p05: 3, p10: 10, median: 55, p95: 185, p99: 220, dynamicRange: 182, clippedBright: 0 },
  'indoor', { noiseScore: 7, skyRatio: 0 },
);
assert.ok(darkIndoorTone.exposureEV > 0 && darkIndoorTone.shadowLift > 0);
const brightOutdoorTone = deriveAutoTone(
  { p05: 18, p10: 30, median: 150, p95: 247, p99: 254, dynamicRange: 229, clippedBright: 0.02 },
  'outdoor', { noiseScore: 2, skyRatio: 0.2 },
);
assert.ok(brightOutdoorTone.highlightCompression > 0);
const flatTone = deriveAutoTone(
  { p05: 70, p10: 80, median: 128, p95: 170, p99: 185, dynamicRange: 100, clippedBright: 0 },
  'unknown', { noiseScore: 2, skyRatio: 0 },
);
assert.ok(flatTone.contrastBoost > 0);

for (const contrast of [-100, -40, 40, 100]) {
  let previous = -1;
  for (let value = 0; value <= 255; value++) {
    const adjusted = applyBasicAdjustmentsPixel(value, value, value, 0, contrast, 0)[0];
    assert.ok(adjusted >= previous - 0.01, `contrast curve must be monotonic at ${value}`);
    previous = adjusted;
  }
}

for (const controls of [[100, 100], [100, -100], [-100, 100], [-100, -100]]) {
  for (let value = 0; value <= 255; value += 17) {
    const adjusted = applyTonalAdjustmentsPixel(value, value, value, controls[0], controls[1]);
    assert.ok(adjusted.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255));
  }
}

for (let r = 0; r <= 255; r += 51) {
  for (let g = 0; g <= 255; g += 51) {
    for (let b = 0; b <= 255; b += 51) {
      const pixel = applySmartPixel(r, g, b, tone, 0.7);
      assert.ok(pixel.every(value => Number.isFinite(value) && value >= 0 && value <= 255));
    }
  }
}

console.log('retouch-engine: tone and color protection checks passed');
