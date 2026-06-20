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

    const shadowWeight = 1 - smoothstep(0.12, 0.68, sourceN);
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
    const skinLike = r > g && g > b && r - b > 14 && r - b < 95 && y > 45 && y < 230;
    const skinProtection = skinLike ? 0.52 : 1;
    const wbStrength = strength * (corr.wbConfidence ?? 1) * saturatedProtection * highlightProtection * skinProtection;
    const wb = corr.wb || [1, 1, 1];
    rr *= 1 + (wb[0] - 1) * wbStrength;
    gg *= 1 + (wb[1] - 1) * wbStrength;
    bb *= 1 + (wb[2] - 1) * wbStrength;

    const correctedY = luminance(rr, gg, bb);
    const recenter = nextY - correctedY;
    return fitGamut(rr + recenter, gg + recenter, bb + recenter, nextY);
  }

  function adjustLuminancePixel(r, g, b, nextY) {
    const y = luminance(r, g, b);
    if (y < 0.5) return [clamp(nextY), clamp(nextY), clamp(nextY)];
    return fitGamut(r * nextY / y, g * nextY / y, b * nextY / y, nextY);
  }

  function applyBasicAdjustmentsPixel(r, g, b, brightness, contrast, saturation) {
    const sourceY = luminance(r, g, b);
    const brightnessDelta = (brightness || 0) * 2.55;
    const contrastValue = contrast || 0;
    const contrastFactor = (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));
    const nextY = clamp(contrastFactor * (sourceY + brightnessDelta - 128) + 128);
    const toned = adjustLuminancePixel(r, g, b, nextY);

    const max = Math.max(...toned), min = Math.min(...toned);
    const chroma = max > 0 ? (max - min) / max : 0;
    const saturationAmount = (saturation || 0) / 100;
    const protection = saturationAmount > 0
      ? 1 - smoothstep(0.42, 0.86, chroma) * 0.68
      : 1;
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

  return Object.freeze({
    luminance,
    transformLuminance,
    applySmartPixel,
    adjustLuminancePixel,
    applyBasicAdjustmentsPixel,
    getLocalLiftWeight,
    fitGamut,
  });
});
