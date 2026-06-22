(function initBatchEngine(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BatchEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBatchEngine() {
  function getBatchProfile({ count = 1, viewportWidth = 1024, deviceMemory = 4, hardwareConcurrency = 4 } = {}) {
    const constrained = viewportWidth <= 768 || deviceMemory <= 4;
    const cpuLimit = Math.max(1, Math.floor(hardwareConcurrency / 2));
    return {
      decodeConcurrency: Math.max(1, Math.min(constrained ? 2 : 3, cpuLimit)),
      analysisSide: count > 80 ? 420 : count > 40 ? 520 : 720,
      detectorSize: count > 40 ? 320 : 416,
      useWorkerPixels: typeof Worker !== 'undefined',
    };
  }

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const run = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    };
    const workers = Math.min(Math.max(1, limit), Math.max(1, items.length));
    await Promise.all(Array.from({ length: workers }, run));
    return results;
  }

  function assessStorageCapacity(usage = 0, quota = 0, requiredBytes = 0) {
    if (!quota) return { level: 'unknown', availableBytes: 0, canStore: true };
    const availableBytes = Math.max(0, quota - usage);
    const reserve = Math.max(50 * 1024 * 1024, quota * 0.08);
    const canStore = requiredBytes + reserve <= availableBytes;
    const ratio = usage / quota;
    return { level: canStore ? ratio > 0.75 ? 'warning' : 'ok' : 'insufficient', availableBytes, canStore };
  }

  function getCapabilityReport(runtime = {}) {
    return Object.freeze({
      workerPixels: typeof runtime.Worker !== 'undefined',
      offscreenCanvas: typeof runtime.OffscreenCanvas !== 'undefined',
      persistentStorage: !!runtime.navigator?.storage,
      rawDecode: false,
      colorManagement: 'srgb',
      subjectSegmentation: 'face-regions',
    });
  }

  return Object.freeze({ getBatchProfile, mapWithConcurrency, assessStorageCapacity, getCapabilityReport });
});
