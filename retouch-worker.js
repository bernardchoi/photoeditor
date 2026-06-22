'use strict';

importScripts('retouch-engine.js?v=5');

self.onmessage = event => {
  const { id, buffer, corr, params } = event.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    for (let i = 0; i < data.length; i += 4) {
      const pixel = RetouchEngine.applyPipelinePixel(data[i], data[i + 1], data[i + 2], corr, params);
      data[i] = pixel[0];
      data[i + 1] = pixel[1];
      data[i + 2] = pixel[2];
    }
    self.postMessage({ id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Worker processing failed' });
  }
};
