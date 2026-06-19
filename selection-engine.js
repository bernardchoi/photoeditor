(function initSelectionEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SelectionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSelectionEngine() {
  function hashDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let distance = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
    return distance;
  }

  function evaluateQualitySignals(metrics) {
    const details = [];
    const add = (code, label, confidence, penalty) => details.push({ code, label, confidence, penalty });
    if (metrics.focusScore < 4.5) add('blur', '초점이 흐릴 가능성 높음', 0.94, 28);
    else if (metrics.focusScore < 7.5) add('blur', '초점 상태 확인', 0.72, 14);

    if (metrics.median < 38) add('dark', '사진이 많이 어두움', 0.94, 22);
    else if (metrics.median < 52 && metrics.clippedDark > 0.035) add('dark', '어두운 부분 확인', 0.76, 12);
    if (metrics.median > 218) add('bright', '사진이 너무 밝음', 0.92, 22);
    else if (metrics.median > 202 && metrics.clippedBright > 0.025) add('bright', '밝은 부분 확인', 0.75, 12);

    if (metrics.clippedBright > 0.06) add('highlight_clip', '밝은 부분 손실', 0.9, 16);
    else if (metrics.clippedBright > 0.035) add('highlight_clip', '밝은 부분 손실 가능성', 0.7, 8);
    if (metrics.clippedDark > 0.09) add('shadow_clip', '어두운 부분 손실', 0.88, 14);
    else if (metrics.clippedDark > 0.055) add('shadow_clip', '어두운 부분 손실 가능성', 0.68, 7);

    return {
      details,
      score: Math.max(0, 100 - details.reduce((sum, item) => sum + item.penalty, 0)),
      confidence: details.length ? Math.max(...details.map(item => item.confidence)) : 0.9,
    };
  }

  function histogramDistance(a = [], b = []) {
    return a.reduce((sum, value, i) => sum + Math.abs(value - (b[i] || 0)), 0) / 2;
  }

  function colorDistance(a = [], b = []) {
    return Math.sqrt(a.reduce((sum, value, i) => sum + Math.pow(value - (b[i] || 0), 2), 0));
  }

  function isDuplicateCandidate(a, b) {
    if (!a || !b || Math.abs(a.aspect - b.aspect) > 0.04) return false;
    return hashDistance(a.hash, b.hash) <= 5
      && colorDistance(a.avgColor, b.avgColor) < 20
      && histogramDistance(a.luminanceHistogram, b.luminanceHistogram) < 0.14
      && Math.abs(a.corr.stats.median - b.corr.stats.median) < 18
      && Math.abs(a.faceCount - b.faceCount) <= 1;
  }

  function getSafeExportDimensions(width, height, maxPixels = 18_000_000, maxEdge = 6500) {
    const scale = Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    };
  }

  function shouldFlushZip(currentBytes, nextBytes, fileCount, limitBytes) {
    return fileCount > 0 && currentBytes + nextBytes > limitBytes;
  }

  return Object.freeze({
    evaluateQualitySignals,
    isDuplicateCandidate,
    colorDistance,
    getSafeExportDimensions,
    shouldFlushZip,
  });
});
