(function initProjectStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProjectStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProjectStore() {
  const DB_NAME = 'autoretouch-project';
  const DB_VERSION = 1;
  const STORE_NAME = 'current';

  function openDatabase() {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transact(mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const result = action(store);
      transaction.oncomplete = () => { db.close(); resolve(result?.result); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  }

  function createPhotoSnapshot(photo) {
    return {
      params: { ...photo.params },
      paramsCustomized: !!photo.paramsCustomized,
      environmentOverride: photo.environmentOverride || 'auto',
      crop: { ...photo.crop },
      reviewApproved: !!photo.reviewApproved,
      validationResult: photo.validationResult || null,
      exportIncluded: photo.exportIncluded !== false,
      selectionManual: !!photo.selectionManual,
    };
  }

  function applyPhotoSnapshot(photo, snapshot) {
    if (!photo || !snapshot) return photo;
    if (snapshot.params) photo.params = { ...photo.params, ...snapshot.params };
    photo.paramsCustomized = !!snapshot.paramsCustomized;
    photo.environmentOverride = snapshot.environmentOverride || 'auto';
    if (snapshot.crop) {
      photo.crop = { ...photo.crop, ...snapshot.crop };
      photo.cropRestored = true;
    }
    photo.reviewApproved = !!snapshot.reviewApproved;
    photo.validationResult = snapshot.validationResult || null;
    photo.exportIncluded = snapshot.exportIncluded !== false;
    photo.selectionManual = !!snapshot.selectionManual;
    return photo;
  }

  async function replaceFiles(files) {
    const records = files.filter(Boolean).map(file => ({
      name: file.name,
      type: file.type,
      lastModified: file.lastModified || Date.now(),
      blob: file,
    }));
    return transact('readwrite', store => store.put(records, 'files'));
  }

  async function saveMetadata(metadata) {
    return transact('readwrite', store => store.put({ ...metadata, updatedAt: Date.now() }, 'metadata'));
  }

  async function loadProject() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const fileRequest = store.get('files');
      const metadataRequest = store.get('metadata');
      transaction.oncomplete = () => {
        db.close();
        resolve({ files: fileRequest.result || [], metadata: metadataRequest.result || null });
      };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  }

  async function clearProject() {
    return transact('readwrite', store => store.clear());
  }

  return Object.freeze({
    createPhotoSnapshot,
    applyPhotoSnapshot,
    replaceFiles,
    saveMetadata,
    loadProject,
    clearProject,
  });
});
