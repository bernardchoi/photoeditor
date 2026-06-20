(function initRetouchEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RetouchEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRetouchEngine() {
  const clamp = value => Math.max(0, Math.min(255, value));
  const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const smoothstep = (edge0, edge1, value) => {
    const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.0001, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const isSkinLike = (r, g, b, y = luminance(r, g, b)) => (
    r > g && g > b && r - b > 12 && r - b < 100 && r - g < 65 && y > 42 && y < 232
  );

  function transformLuminance(y, corr, strength) {
    const source = clamp(y);
    const sourceN = source / 255;
    const exposureGain = Math.pow(2, (corr.exposureEV || 0) * strength);
    const exposureDelta = source * exposureGain - source;
    const exposureProtection = exposureDelta > 0
      ? Math.min(
        1 - smoothstep(0.68, 0.98, sourceN) * 0.78,
        Math.max(0, (255 - source) * 0.65 / exposureDelta),
      )
      : 1;
    let next = source + exposureDelta * exposureProtection;

    const shadowWeight = smoothstep(0.008, 0.09, sourceN) * (1 - smoothstep(0.38, 0.7, sourceN));
    next += (corr.shadowLift || 0) * strength * shadowWeight;

    const highlightWeight = smoothstep(0.62, 0.98, next / 255);
    next -= (corr.highlightCompression || 0) * strength * highlightWeight * Math.max(0, next - 155);

    const pivot = corr.tonePivot || 128;
    const midtoneWeight = Math.max(0, 1 - Math.abs(next / 255 - 0.5) * 1.75);
    next += (next - pivot) * (corr.contrastBoost || 0) * strength * midtoneWeight;
    return clamp(next);
  }

  function fitGamut(r, g, b, targetY) {
    const y = clamp(targetY);
    const channels = [r - y, g - y, b - y];
    let scale = 1;
    channels.forEach(delta => {
      if (delta > 0) scale = Math.min(scale, (255 - y) / delta);
      else if (delta < 0) scale = Math.min(scale, (0 - y) / delta);
    });
    return channels.map(delta => clamp(y + delta * Math.max(0, scale)));
  }

  function applySmartPixel(r, g, b, corr, strength) {
    const y = luminance(r, g, b);
    const nextY = transformLuminance(y, corr, strength);
    const ratio = y > 0.5 ? nextY / y : 1;
    let rr = r * ratio, gg = g * ratio, bb = b * ratio;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max > 0 ? (max - min) / max : 0;
    const saturatedProtection = 1 - smoothstep(0.18, 0.72, saturation) * 0.72;
    const highlightProtection = 1 - smoothstep(0.78, 1, y / 255) * 0.45;
    const skinProtection = isSkinLike(r, g, b, y) ? 0.52 : 1;
    const wbStrength = strength * (corr.wbConfidence ?? 1) * saturatedProtection * highlightProtection * skinProtection;
    const wb = corr.wb || [1, 1, 1];
    rr *= 1 + (wb[0] - 1) * wbStrength;
    gg *= 1 + (wb[1] - 1) * wbStrength;
    bb *= 1 + (wb[2] - 1) * wbStrength;

    const correctedY = luminance(rr, gg, bb);
    const recenter = nextY - correctedY;
    const centered = fitGamut(rr + recenter, gg + recenter, bb + recenter, nextY);
    const vibrance = Math.max(0, corr.vibrance || 0) / 100;
    if (!vibrance) return centered;
    const vibranceProtection = (1 - smoothstep(0.16, 0.68, saturation) * 0.92)
      * (isSkinLike(r, g, b, y) ? 0.45 : 1);
    const vibranceFactor = 1 + vibrance * strength * vibranceProtection;
    return fitGamut(
      nextY + (centered[0] - nextY) * vibranceFactor,
      nextY + (centered[1] - nextY) * vibranceFactor,
      nextY + (centered[2] - nextY) * vibranceFactor,
      nextY,
    );
  }

  function adjustLuminancePixel(r, g, b, nextY) {
    const y = luminance(r, g, b);
    if (y < 0.5) return [clamp(nextY), clamp(nextY), clamp(nextY)];
    return fitGamut(r * nextY / y, g * nextY / y, b * nextY / y, nextY);
  }

  function applyBasicAdjustmentsPixel(r, g, b, brightness, contrast, saturation) {
    const sourceY = luminance(r, g, b);
    let tone = clamp(sourceY + (brightness || 0) * 2.55) / 255;
    const contrastAmount = Math.max(-1, Math.min(1, (contrast || 0) / 100));
    if (contrastAmount >= 0) {
      const exponent = 1 + contrastAmount * 0.55;
      tone = tone < 0.5
        ? 0.5 * Math.pow(tone * 2, exponent)
        : 1 - 0.5 * Math.pow((1 - tone) * 2, exponent);
    } else {
      tone += (0.5 - tone) * -contrastAmount * 0.68;
    }
    const nextY = clamp(tone * 255);
    const toned = adjustLuminancePixel(r, g, b, nextY);

    const max = Math.max(...toned), min = Math.min(...toned);
    const chroma = max > 0 ? (max - min) / max : 0;
    const saturationAmount = (saturation || 0) / 100;
    let protection = saturationAmount > 0
      ? 1 - smoothstep(0.42, 0.86, chroma) * 0.68
      : 1;
    if (saturationAmount > 0 && isSkinLike(r, g, b, sourceY)) protection *= 0.55;
    const saturationFactor = 1 + saturationAmount * protection;
    return fitGamut(
      nextY + (toned[0] - nextY) * saturationFactor,
      nextY + (toned[1] - nextY) * saturationFactor,
      nextY + (toned[2] - nextY) * saturationFactor,
      nextY,
    );
  }

  function getLocalLiftWeight(r, g, b) {
    const y = luminance(r, g, b);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max > 0 ? (max - min) / max : 0;
    const highlightProtection = 1 - smoothstep(0.64, 0.94, y / 255) * 0.9;
    const colorProtection = 1 - smoothstep(0.55, 0.92, chroma) * 0.45;
    return highlightProtection * colorProtection;
  }

  function applyTonalAdjustmentsPixel(r, g, b, highlights, shadows) {
    const y = luminance(r, g, b);
    const lum = y / 255;
    const shadowMask = smoothstep(0.015, 0.16, lum) * (1 - smoothstep(0.42, 0.72, lum));
    const highlightMask = smoothstep(0.5, 0.82, lum) * (1 - smoothstep(0.985, 1, lum) * 0.72);
    const shadowDelta = Math.max(-1, Math.min(1, (shadows || 0) / 100)) * 42 * shadowMask;
    const highlightDelta = -Math.max(-1, Math.min(1, (highlights || 0) / 100)) * 38 * highlightMask;
    return adjustLuminancePixel(r, g, b, clamp(y + shadowDelta + highlightDelta));
  }

  function computeDetailDelta(y, detail, amount, noiseScore = 0, mode = 'sharpen') {
    const lum = clamp(y) / 255;
    const strength = Math.max(0, amount || 0);
    if (!strength) return 0;
    const tonalProtection = smoothstep(0.025, 0.18, lum)
      * (1 - smoothstep(0.9, 0.995, lum) * 0.72);
    const noiseProtection = 1 - smoothstep(4.5, 12, noiseScore || 0) * 0.68;
    const threshold = (mode === 'clarity' ? 1.3 : 2.1)
      + Math.pow(1 - lum, 2) * (mode === 'clarity' ? 1.8 : 4.2)
      + Math.max(0, noiseScore || 0) * (mode === 'clarity' ? 0.08 : 0.18);
    if (Math.abs(detail) <= threshold) return 0;
    const limit = mode === 'clarity' ? 15 : 12;
    const gain = mode === 'clarity' ? 0.72 : 1.18;
    return Math.max(-limit, Math.min(limit, detail)) * strength * gain * tonalProtection * noiseProtection;
  }

  function deriveAutoTone(stats, environment = 'unknown', features = {}) {
    const median = stats.median ?? 128;
    const p05 = stats.p05 ?? 20;
    const p10 = stats.p10 ?? p05;
    const p95 = stats.p95 ?? 235;
    const p99 = stats.p99 ?? p95;
    const dynamicRange = stats.dynamicRange ?? (p95 - p05);
    const clippedBright = stats.clippedBright || 0;
    const noiseScore = features.noiseScore || 0;
    const skyRatio = features.skyRatio || 0;

    let exposureEV = 0;
    if (median < 62 && p95 < 238) {
      exposureEV = Math.min(0.38, Math.log2(92 / Math.max(20, median)) * 0.38);
    } else if (median < 88 && p95 < 222) {
      exposureEV = Math.min(0.2, Math.log2(94 / Math.max(35, median)) * 0.28);
    } else if (median > 195 && p05 > 22) {
      exposureEV = Math.max(-0.22, Math.log2(172 / median) * 0.34);
    }

    const shadowLimit = environment === 'indoor' ? 12 : 9;
    let shadowLift = median < 128 && p10 < 28
      ? Math.min(shadowLimit, (28 - p10) * (environment === 'indoor' ? 0.48 : 0.38)) : 0;
    if (exposureEV > 0.14) shadowLift *= 0.55;

    let highlightCompression = 0;
    if (p99 > 248 && (clippedBright > 0.004 || skyRatio > 0.06)) {
      highlightCompression = Math.min(0.13, 0.045 + (p99 - 248) * 0.009 + clippedBright * 1.5);
    }

    const contrastBoost = dynamicRange < 112 && noiseScore < 8.5
      ? Math.min(0.085, (112 - dynamicRange) / 620) : 0;
    return { exposureEV, shadowLift, highlightCompression, contrastBoost };
  }

  return Object.freeze({
    luminance,
    transformLuminance,
    applySmartPixel,
    adjustLuminancePixel,
    applyBasicAdjustmentsPixel,
    getLocalLiftWeight,
    applyTonalAdjustmentsPixel,
    computeDetailDelta,
    deriveAutoTone,
    fitGamut,
  });
});
