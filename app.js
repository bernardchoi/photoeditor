'use strict';

// ── Print size presets (300 DPI) ──────────────────────────────
const PRINT_SIZES = {
  original: null,
  '3x5':  { w: 900,  h: 1500 },
  '4x6':  { w: 1200, h: 1800 },
  '5x7':  { w: 1500, h: 2100 },
  '8x10': { w: 2400, h: 3000 },
  'a4':   { w: 2480, h: 3508 },
};

const MAX_EXPORT_PIXELS = 18_000_000;
const MAX_EXPORT_EDGE = 6500;
const ZIP_CHUNK_BYTES = 120 * 1024 * 1024;
const {
  evaluateQualitySignals, colorDistance, getSafeExportDimensions, shouldFlushZip,
  rankPhotoForExport, buildDuplicateGroups,
} = window.SelectionEngine;
window.AutoRetouchDiagnostics = window.SelectionEngine;
const {
  luminance, transformLuminance, applySmartPixel, adjustLuminancePixel,
  applyBasicAdjustmentsPixel, getLocalLiftWeight,
} = window.RetouchEngine;
const {
  createPhotoSnapshot, applyPhotoSnapshot, replaceFiles: storeProjectFiles,
  saveMetadata: storeProjectMetadata, loadProject: loadStoredProject,
  clearProject: clearStoredProject,
} = window.ProjectStore;

const DEFAULT_PARAMS = Object.freeze({
  autoStrength: 70,
  brightness: 0, contrast: 0, saturation: 0, sharpness: 0, skinSmooth: 0,
  temperature: 0, highlights: 0, shadows: 0, clarity: 0, noiseReduction: 0,
});

const makeDefaultParams = () => ({ ...DEFAULT_PARAMS });
const makeDefaultCrop = () => ({ zoom: 1, x: 0.5, y: 0.5, autoFramed: false });

// ── State ─────────────────────────────────────────────────────
const state = {
  photos: [],        // [{ image, name, autoCorr, faceDetections, displayW, displayH, ready }]
  activeIdx: -1,
  faceApiLoaded: false,
  selectedSize: 'original',
  outputIntent: 'print-glossy',
  sliderPos: 0.5,
  reviewFilter: 'all',
  cancelRequested: false,
  params: makeDefaultParams(),
};
let faceApiReadyPromise = null;
let projectSaveTimer = null;
let projectRestoring = false;
let projectFilesPersisted = false;

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadZone    = $('upload-zone');
const uploadContent = $('upload-content');
const fileInput     = $('file-input');
const addInput      = $('add-input');
const editor        = $('editor');
const procOverlay   = $('processing-overlay');
const procText      = $('processing-text');
const procSub       = $('processing-sub');
const procProgress  = $('processing-progress-bar');
const procCancel    = $('processing-cancel');
const canvasBefore  = $('canvas-before');
const canvasAfter   = $('canvas-after');
const ctxBefore     = canvasBefore.getContext('2d', { willReadFrequently: true });
const ctxAfter      = canvasAfter.getContext('2d',  { willReadFrequently: true });
const cmpSlider     = $('comparison-slider');
const faceStatusEl  = $('face-status');
const downloadBtn   = $('download-btn');
const downloadAllBtn = $('download-all-btn');
const totalCountEl  = $('total-count');
const thumbStrip    = $('thumb-strip');
const photoCounter  = $('photo-counter');
const cropGuide     = $('crop-guide');
const cropControls  = $('crop-controls');

// ── Face API ──────────────────────────────────────────────────
async function loadFaceApi() {
  const MODEL_URL = './models';
  faceStatusEl.textContent = '얼굴 감지 모델 준비 중...';
  try {
    if (typeof faceapi === 'undefined') throw new Error('face-api library unavailable');
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    state.faceApiLoaded = true;
    faceStatusEl.textContent = '얼굴 감지 준비 완료';
  } catch (e) {
    console.warn('face-api models failed:', e);
    faceStatusEl.textContent = '얼굴 감지 준비 실패 — 색조 기반 보정';
    showToast('얼굴 감지 모델을 준비하지 못했습니다. 새로고침 후 다시 시도해주세요.', 'info');
  }
}

// ── Upload ────────────────────────────────────────────────────
$('upload-btn').addEventListener('click', () => fileInput.click());
uploadContent.addEventListener('click', e => {
  if (e.target !== $('upload-btn')) fileInput.click();
});
uploadContent.addEventListener('dragover', e => {
  e.preventDefault();
  uploadContent.classList.add('drag-over');
});
uploadContent.addEventListener('dragleave', () => uploadContent.classList.remove('drag-over'));
uploadContent.addEventListener('drop', e => {
  e.preventDefault();
  uploadContent.classList.remove('drag-over');
  handleFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
});
fileInput.addEventListener('change', e => handleFiles(Array.from(e.target.files)));

$('add-btn').addEventListener('click', () => addInput.click());
addInput.addEventListener('change', e => {
  addMoreFiles(Array.from(e.target.files));
  addInput.value = '';
});

$('reset-btn').addEventListener('click', () => {
  state.photos.forEach(p => {
    p.objectURL && URL.revokeObjectURL(p.objectURL);
    p.image?.close?.();
  });
  state.photos = [];
  state.activeIdx = -1;
  state.reviewFilter = 'all';
  projectFilesPersisted = false;
  state.params = makeDefaultParams();
  editor.classList.add('hidden');
  uploadZone.style.display = '';
  fileInput.value = '';
  thumbStrip.innerHTML = '';
  photoCounter.classList.add('hidden');
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
  clearStoredProject().catch(error => console.warn('Project clear failed:', error));
  updateProjectStatus('저장된 작업 없음');
});

// ── RAW / unsupported format detection ───────────────────────
const RAW_EXTS = new Set(['cr2','cr3','cr','nef','nrw','arw','srf','sr2','raf','orf','rw2','rwl','dng','pef','3fr','mef','mrw','x3f']);

function classifyFiles(files) {
  const ok = [], raw = [], bad = [];
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (RAW_EXTS.has(ext))                 raw.push(f.name);
    else if (!f.type.startsWith('image/')) bad.push(f.name);
    else                                   ok.push(f);
  }
  if (raw.length) showToast(`RAW 파일은 지원되지 않습니다.\n카메라에서 JPEG로 내보낸 후 사용해주세요.\n(${raw.join(', ')})`);
  if (bad.length) showToast(`이미지 파일이 아닙니다: ${bad.join(', ')}`);
  return ok;
}

// ── File Handling ─────────────────────────────────────────────
function handleFiles(files) {
  const ok = classifyFiles(files);
  if (!ok.length) return;
  uploadZone.style.display = 'none';
  editor.classList.remove('hidden');
  loadImages(ok, true);
}

async function addMoreFiles(files) {
  const ok = classifyFiles(files);
  if (!ok.length) return;
  await loadImages(ok, false);
}

async function loadImages(files, isFirst, options = {}) {
  showProc('사진 불러오는 중...', '');
  const start = state.photos.length;
  const images = await Promise.all(files.map(loadImageFile));

  images.forEach((img, i) => {
    if (!img) return;
    const photo = {
      image: img.image,
      name: img.name,
      sourceFile: files[i],
      objectURL: img.objectURL,
      orientation: img.orientation || 1,
      sizeMB: img.sizeMB || 0,
      params: makeDefaultParams(),
      paramsCustomized: false,
      autoDefaultsApplied: false,
      environmentOverride: 'auto',
      crop: makeDefaultCrop(),
      cropRestored: false,
      autoCorr: null,
      faceDetections: [],
      faceAdjustments: [],
      workflow: null,
      reviewApproved: false,
      validationResult: null,
      exportIncluded: true,
      selectionManual: false,
      autoExcluded: false,
      eventGroup: null,
      displayW: 0,
      displayH: 0,
      ready: false,
    };
    applyPhotoSnapshot(photo, options.snapshots?.[i]);
    state.photos.push(photo);
  });

  updateCounter();
  renderThumbs();

  if (!options.skipPersist) {
    try {
      await storeProjectFiles(state.photos.map(p => p.sourceFile));
      projectFilesPersisted = true;
    } catch (error) {
      projectFilesPersisted = false;
      console.warn('Photo persistence failed:', error);
      updateProjectStatus('사진 저장 공간 부족');
    }
  }

  // Switch to first new photo
  await setActive(start);
  try {
    await analyzeEventPhotos(start);
  } catch (error) {
    if (error.name === 'AbortError') showToast('자동 검수를 중지했습니다. 분석된 사진은 그대로 사용할 수 있습니다.', 'info');
    else throw error;
  }
  await saveProjectState();
  hideProc();
}

async function loadImageFile(file) {
  const [orientation, adobeRgb] = await Promise.all([
    readExifOrientation(file),
    checkAdobeRgb(file),
  ]);
  if (adobeRgb) showToast('Adobe RGB 색공간이 감지됐습니다.\n브라우저는 sRGB로 표시하므로 색감이 다소 달라 보일 수 있습니다.', 'info');
  const url = URL.createObjectURL(file);

  // Modern mobile browsers may apply EXIF rotation while decoding an <img>.
  // ImageBitmap gives us one normalized, already-oriented source and prevents
  // the manual EXIF transform from being applied twice on iOS/Android.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bitmap, name: file.name, objectURL: url, orientation: 1, sizeMB: (file.size / 1e6).toFixed(1) };
    } catch (e) {
      console.warn('ImageBitmap decode fallback:', e);
    }
  }

  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ image: img, name: file.name, objectURL: url, orientation, sizeMB: (file.size / 1e6).toFixed(1) });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function getImageSize(img) {
  return {
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height,
  };
}

function makeAnalysisFrame(p, maxSide = 720) {
  const source = getImageSize(p.image);
  const swap = (p.orientation || 1) >= 5;
  const naturalW = swap ? source.h : source.w;
  const naturalH = swap ? source.w : source.h;
  const scale = Math.min(1, maxSide / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawImageOriented(ctx, p.image, p.orientation, width, height);
  return { canvas, imageData: ctx.getImageData(0, 0, width, height) };
}

function analyzePhotoQuality(imageData) {
  const { data, width: W, height: H } = imageData;
  let focusSum = 0, focusSq = 0, focusCount = 0;
  let rSum = 0, gSum = 0, bSum = 0, colorCount = 0;
  const luminanceBins = new Array(16).fill(0);
  const gray = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  for (let y = 2; y < H - 2; y += 3) {
    for (let x = 2; x < W - 2; x += 3) {
      const lap = 4 * gray(x, y) - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1);
      focusSum += lap;
      focusSq += lap * lap;
      focusCount++;
      const i = (y * W + x) * 4;
      rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2]; colorCount++;
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      luminanceBins[Math.min(15, Math.floor(luminance / 16))]++;
    }
  }
  const focusMean = focusCount ? focusSum / focusCount : 0;
  const focusScore = focusCount ? Math.sqrt(Math.max(0, focusSq / focusCount - focusMean * focusMean)) : 0;
  return {
    focusScore,
    avgColor: colorCount ? [rSum / colorCount, gSum / colorCount, bSum / colorCount] : [128, 128, 128],
    luminanceHistogram: luminanceBins.map(value => colorCount ? value / colorCount : 0),
  };
}

function createDifferenceHash(imageData) {
  const sample = Object.assign(document.createElement('canvas'), { width: 9, height: 8 });
  const source = Object.assign(document.createElement('canvas'), { width: imageData.width, height: imageData.height });
  source.getContext('2d').putImageData(imageData, 0, 0);
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = (y * 9 + x) * 4, b = a + 4;
      const ya = 0.299 * d[a] + 0.587 * d[a + 1] + 0.114 * d[a + 2];
      const yb = 0.299 * d[b] + 0.587 * d[b + 1] + 0.114 * d[b + 2];
      hash += ya > yb ? '1' : '0';
    }
  }
  return hash;
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(points) {
  if (!points || points.length < 6) return 1;
  return (pointDistance(points[1], points[5]) + pointDistance(points[2], points[4]))
    / Math.max(1, 2 * pointDistance(points[0], points[3]));
}

function inspectFaceLandmarks(detections, width, height) {
  let closedEyes = 0, edgeFaces = 0;
  detections.forEach(det => {
    const points = det.landmarks?.positions || [];
    const box = det.detection?.box;
    const faceLargeEnough = box && box.width >= Math.max(36, width * 0.035);
    if (points.length >= 68 && faceLargeEnough) {
      const leftEye = eyeAspectRatio(points.slice(36, 42));
      const rightEye = eyeAspectRatio(points.slice(42, 48));
      if (leftEye < 0.16 && rightEye < 0.16) closedEyes++;
    }
    if (box && (box.x < width * 0.015 || box.y < height * 0.015
      || box.x + box.width > width * 0.985 || box.y + box.height > height * 0.985)) edgeFaces++;
  });
  return { closedEyes, edgeFaces };
}

async function analyzeEventPhotos(start = 0) {
  if (!state.photos.length) return;
  showProc('행사 사진 자동 정리 중...', '초점 · 노출 · 중복 · 촬영 묶음 확인');
  if (faceApiReadyPromise) await faceApiReadyPromise;
  const remaining = state.photos.length - start;
  const analysisSide = remaining > 80 ? 420 : remaining > 40 ? 520 : 720;
  const detectorSize = remaining > 40 ? 320 : 416;

  for (let i = start; i < state.photos.length; i++) {
    throwIfCancelled();
    const p = state.photos[i];
    setProc(`사진 ${i + 1}/${state.photos.length} 자동 검수 중...`);
    procSub.textContent = p.name;
    setProcProgress((i - start) / Math.max(1, remaining));
    await yieldToBrowser();
    const frame = makeAnalysisFrame(p, analysisSide);
    const corr = computeAutoCorr(frame.imageData, p.environmentOverride);
    const quality = analyzePhotoQuality(frame.imageData);
    let workflowDetections = p.ready ? p.faceDetections : [];
    if (!p.ready && state.faceApiLoaded) {
      try {
        workflowDetections = await faceapi.detectAllFaces(
          frame.canvas,
          new faceapi.TinyFaceDetectorOptions({ inputSize: detectorSize, scoreThreshold: 0.32 }),
        ).withFaceLandmarks();
      } catch { workflowDetections = []; }
    }
    const faceCount = workflowDetections.length;
    const faceChecks = inspectFaceLandmarks(
      workflowDetections,
      p.ready ? p.displayW : frame.imageData.width,
      p.ready ? p.displayH : frame.imageData.height,
    );
    const verdict = evaluateQualitySignals({
      focusScore: quality.focusScore,
      median: corr.stats.median,
      clippedBright: corr.stats.clippedBright,
      clippedDark: corr.stats.clippedDark,
    });
    if (faceChecks.closedEyes > 0) verdict.details.push({
      code: 'closed_eyes', label: `눈 감은 얼굴 ${faceChecks.closedEyes}명`, confidence: 0.82, penalty: 24,
    });
    if (faceChecks.edgeFaces > 0) verdict.details.push({
      code: 'edge_face', label: '가장자리 얼굴 잘림 확인', confidence: 0.78, penalty: 12,
    });
    verdict.score = Math.max(0, 100 - verdict.details.reduce((sum, item) => sum + item.penalty, 0));
    verdict.confidence = verdict.details.length ? Math.max(...verdict.details.map(item => item.confidence)) : 0.9;
    p.workflow = {
      ...quality,
      corr,
      faceCount,
      hash: createDifferenceHash(frame.imageData),
      aspect: frame.imageData.width / frame.imageData.height,
      issues: verdict.details.map(item => item.label),
      issueDetails: verdict.details,
      baseQualityScore: verdict.score,
      qualityScore: verdict.score,
      confidence: verdict.confidence,
      duplicateOf: null,
    };
  }

  classifyDuplicatesAndGroups();
  syncEventGroupCorrections();
  state.photos.forEach(p => {
    if (!p.ready || !p.rawPixels) return;
    const raw = new ImageData(new Uint8ClampedArray(p.rawPixels), p.displayW, p.displayH);
    p.autoCorr = computeAutoCorr(raw, p.environmentOverride);
    applyGroupConsistency(p);
    finalizePhotoAnalysis(p, raw);
  });
  renderThumbs();
  updateWorkflowUI();
  const active = state.photos[state.activeIdx];
  if (active?.autoCorr) {
    updateReviewUI(active);
    updateAnalysisUI(active);
    applyProcessing();
  }
  setProcProgress(1);
  hideProc();
}

function classifyDuplicatesAndGroups() {
  let group = 1;
  let previous = null;
  state.photos.forEach(p => {
    const w = p.workflow;
    if (!w) return;
    w.issueDetails = w.issueDetails.filter(item => item.code !== 'duplicate');
    w.issues = w.issueDetails.map(item => item.label);
    w.qualityScore = w.baseQualityScore;
    w.duplicateOf = null;
    w.bestOfGroup = false;
    p.autoExcluded = false;
    if (!p.selectionManual) p.exportIncluded = true;
    if (previous) {
      const sceneColorDistance = colorDistance(w.avgColor, previous.avgColor);
      const sameEnvironment = w.corr.environment === previous.corr.environment;
      const samePeopleType = (w.faceCount >= 3) === (previous.faceCount >= 3);
      if (!sameEnvironment || !samePeopleType || sceneColorDistance > 48) group++;
    }
    p.eventGroup = group;
    previous = w;
  });

  const workflows = state.photos.map(p => p.workflow);
  buildDuplicateGroups(workflows).forEach(indices => {
    const bestIdx = indices.reduce((best, index) => (
      rankPhotoForExport(workflows[index]) > rankPhotoForExport(workflows[best]) ? index : best
    ), indices[0]);
    workflows[bestIdx].bestOfGroup = true;
    indices.forEach(index => {
      if (index === bestIdx) return;
      const p = state.photos[index];
      const w = workflows[index];
      w.duplicateOf = bestIdx;
      const label = `${bestIdx + 1}번이 더 좋은 추천 사진`;
      w.issueDetails.push({ code: 'duplicate', label, confidence: 0.92, penalty: 30 });
      w.issues = w.issueDetails.map(item => item.label);
      w.qualityScore = Math.max(0, w.baseQualityScore - 30);
      w.confidence = Math.max(w.confidence, 0.92);
      p.autoExcluded = true;
      if (!p.selectionManual) p.exportIncluded = false;
    });
  });
}

function syncEventGroupCorrections() {
  const groups = new Map();
  state.photos.forEach(p => {
    if (!p.workflow) return;
    if (!groups.has(p.eventGroup)) groups.set(p.eventGroup, []);
    groups.get(p.eventGroup).push(p.workflow.corr);
  });
  groups.forEach((items, id) => {
    const avg = key => items.reduce((sum, item) => sum + item[key], 0) / items.length;
    const target = {
      exposureEV: avg('exposureEV'),
      shadowLift: avg('shadowLift'),
      highlightCompression: avg('highlightCompression'),
      wb: [0, 1, 2].map(channel => items.reduce((sum, item) => sum + item.wb[channel], 0) / items.length),
    };
    state.photos.filter(p => p.eventGroup === id).forEach(p => { p.groupTarget = target; });
  });
}

function applyGroupConsistency(p) {
  if (!p?.autoCorr || !p.groupTarget) return;
  const blend = 0.45;
  const target = p.groupTarget;
  for (const key of ['exposureEV', 'shadowLift', 'highlightCompression']) {
    p.autoCorr[key] = p.autoCorr[key] * (1 - blend) + target[key] * blend;
  }
  p.autoCorr.wb = p.autoCorr.wb.map((value, i) => value * (1 - blend) + target.wb[i] * blend);
  p.autoCorr.needsTone = Math.abs(p.autoCorr.exposureEV) > 0.01 || p.autoCorr.shadowLift > 0
    || p.autoCorr.highlightCompression > 0 || p.autoCorr.contrastBoost > 0;
}

// Read JPEG EXIF orientation tag (no external library needed)
function readExifOrientation(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const view = new DataView(e.target.result);
        if (view.getUint16(0, false) !== 0xFFD8) { resolve(1); return; }
        let offset = 2;
        while (offset < view.byteLength) {
          const marker = view.getUint16(offset, false);
          offset += 2;
          if (marker === 0xFFE1) {
            offset += 2;
            if (view.getUint32(offset, false) !== 0x45786966) { resolve(1); return; }
            const little = view.getUint16(offset + 6, false) === 0x4949;
            offset += 6 + view.getUint32(offset + 10, little) * 1;
            const tags = view.getUint16(offset + 4, little);
            offset += 6;
            for (let i = 0; i < tags; i++) {
              if (view.getUint16(offset + i * 12, little) === 0x0112) {
                resolve(view.getUint16(offset + i * 12 + 8, little));
                return;
              }
            }
          } else if ((marker & 0xFF00) !== 0xFF00) break;
          else offset += view.getUint16(offset, false);
        }
      } catch {}
      resolve(1);
    };
    reader.onerror = () => resolve(1);
    reader.readAsArrayBuffer(file.slice(0, 65536));
  });
}

// Detect Adobe RGB by looking for 'AdobeRGB' or ICC profile marker in JPEG
function checkAdobeRgb(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const bytes = new Uint8Array(e.target.result);
        const str = String.fromCharCode(...bytes);
        resolve(str.includes('AdobeRGB') || str.includes('Adobe RGB'));
      } catch { resolve(false); }
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 8192));
  });
}

// Draw image onto ctx with correct EXIF orientation applied
function drawImageOriented(ctx, img, orientation, cW, cH) {
  const o = orientation || 1;
  if (o === 1) { ctx.drawImage(img, 0, 0, cW, cH); return; }
  ctx.save();
  // Orientations 5-8 rotate 90/270°, so source w/h are swapped relative to canvas
  const sw = (o >= 5) ? cH : cW;
  const sh = (o >= 5) ? cW : cH;
  switch (o) {
    case 2: ctx.transform(-1,  0,  0,  1, cW,  0); break;
    case 3: ctx.transform(-1,  0,  0, -1, cW, cH); break;
    case 4: ctx.transform( 1,  0,  0, -1,  0, cH); break;
    case 5: ctx.transform( 0,  1,  1,  0,  0,  0); break;
    case 6: ctx.transform( 0,  1, -1,  0, cH,  0); break;  // iPhone portrait
    case 7: ctx.transform( 0, -1, -1,  0, cH, cW); break;
    case 8: ctx.transform( 0, -1,  1,  0,  0, cW); break;
  }
  ctx.drawImage(img, 0, 0, sw, sh);
  ctx.restore();
}

async function detectFacesForPhoto(p, targetW, targetH) {
  if (!state.faceApiLoaded) return [];
  const source = getImageSize(p.image);
  const swap = (p.orientation || 1) >= 5;
  const naturalW = swap ? source.h : source.w;
  const naturalH = swap ? source.w : source.h;
  const scale = Math.min(1, 1280 / Math.max(naturalW, naturalH));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawImageOriented(ctx, p.image, p.orientation, width, height);

  const detections = await faceapi
    .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.25 }))
    .withFaceLandmarks();
  return faceapi.resizeResults(detections, { width: targetW, height: targetH });
}

// ── Active Photo ──────────────────────────────────────────────
async function setActive(idx) {
  if (idx < 0 || idx >= state.photos.length) return;
  state.activeIdx = idx;

  const p = state.photos[idx];
  state.params = p.params;
  syncParamControls();
  const img = p.image;
  const imageSize = getImageSize(img);

  // EXIF orientation: rotations 5-8 swap width/height
  const o = p.orientation || 1;
  const swap = o >= 5;
  const naturalW = swap ? imageSize.h : imageSize.w;
  const naturalH = swap ? imageSize.w : imageSize.h;

  // Size canvases to fit display area
  const mobile = window.innerWidth <= 768;
  const container = document.querySelector('.comparison-container');
  const maxW = Math.max(120, container.clientWidth - (mobile ? 16 : 48));
  const maxH = Math.max(120, container.clientHeight - (mobile ? 16 : 28));
  const scale = Math.min(maxW / naturalW, maxH / naturalH, 1);
  const cssW = Math.max(1, Math.round(naturalW * scale));
  const cssH = Math.max(1, Math.round(naturalH * scale));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelScale = Math.min(dpr, naturalW / cssW, naturalH / cssH);
  const dW = Math.max(1, Math.round(cssW * pixelScale));
  const dH = Math.max(1, Math.round(cssH * pixelScale));
  p.displayW = dW;
  p.displayH = dH;

  canvasBefore.width = dW;  canvasBefore.height = dH;
  canvasAfter.width  = dW;  canvasAfter.height  = dH;
  canvasBefore.style.width = `${cssW}px`; canvasBefore.style.height = `${cssH}px`;
  canvasAfter.style.width  = `${cssW}px`; canvasAfter.style.height  = `${cssH}px`;
  drawImageOriented(ctxBefore, img, o, dW, dH);

  // First-time prep for this photo
  if (!p.ready) {
    showProc(`사진 ${idx + 1}/${state.photos.length} 분석 중...`, p.name);
    const raw = ctxBefore.getImageData(0, 0, dW, dH);
    p.rawPixels = new Uint8ClampedArray(raw.data); // cache for applyProcessing
    p.autoCorr = computeAutoCorr(raw, p.environmentOverride);
    applyGroupConsistency(p);

    if (faceApiReadyPromise) await faceApiReadyPromise;
    if (state.faceApiLoaded) {
      setProc(`얼굴 감지 중... (${idx + 1}/${state.photos.length})`);
      try {
        p.faceDetections = await detectFacesForPhoto(p, dW, dH);
      } catch { p.faceDetections = []; }
    }
    finalizePhotoAnalysis(p, raw);
    if (!p.cropRestored) autoFramePhoto(p);
    p.ready = true;
    thumbStrip.querySelector(`[data-idx="${idx}"]`)?.classList.add('ready');
    hideProc();
  }

  updateFaceStatus(p.faceDetections);
  updateReviewUI(p);
  updateAnalysisUI(p);
  applyProcessing();
  updateThumbActive();
  updateSliderAfterResize();
  syncCropControls();
  updateCropGuide();
}

function updateFaceStatus(dets) {
  if (!state.faceApiLoaded) {
    faceStatusEl.textContent = '얼굴 감지 사용 불가 — 색조 기반 보정';
    faceStatusEl.classList.remove('detected');
    return;
  }
  const n = dets.length;
  faceStatusEl.textContent = n > 0 ? `얼굴 ${n}명 감지 ✓` : '얼굴 미감지 — 색조 기반 보정';
  faceStatusEl.classList.toggle('detected', n > 0);
}

function getFaceBounds(det) {
  const pts = det.landmarks.positions;
  const xs = pts.map(pt => pt.x), ys = pts.map(pt => pt.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

function analyzeFaceExposure(imageData, detections, globalMedian, environment) {
  const { data, width: W, height: H } = imageData;
  return detections.map(det => {
    const box = getFaceBounds(det);
    const minX = Math.max(0, Math.floor(box.minX));
    const maxX = Math.min(W - 1, Math.ceil(box.maxX));
    const minY = Math.max(0, Math.floor(box.minY));
    const maxY = Math.min(H - 1, Math.ceil(box.maxY));
    let sum = 0, count = 0;
    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const i = (y * W + x) * 4;
        sum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        count++;
      }
    }
    const average = count ? sum / count : globalMedian;
    const environmentLift = environment === 'indoor' ? 5 : 0;
    const target = Math.min(130, Math.max(108, globalMedian * 0.88) + environmentLift);
    const lift = average < target - 6 ? Math.min(32, (target - average) * 0.7) : 0;
    return { average, lift };
  });
}

function applySceneDefaults(p, force = false) {
  if ((!force && p.paramsCustomized) || !p.autoCorr) return;
  const presets = {
    general:  { sharpness: 0, skinSmooth: 0 },
    portrait: { sharpness: 5, skinSmooth: 12 },
    group:    { sharpness: 5, skinSmooth: 6 },
  };
  Object.assign(p.params, presets[p.autoCorr.sceneType] || presets.general);
  p.autoDefaultsApplied = true;
}

function finalizePhotoAnalysis(p, imageData) {
  const faces = p.faceDetections.length;
  p.autoCorr.sceneType = faces >= 3 ? 'group' : faces > 0 ? 'portrait' : 'general';
  p.faceAdjustments = analyzeFaceExposure(
    imageData, p.faceDetections, p.autoCorr.stats.median, p.autoCorr.environment,
  );
  p.autoCorr.backlitFaces = p.faceAdjustments.filter(item => item.lift >= 8).length;
  applySceneDefaults(p);
  if (state.photos[state.activeIdx] === p) {
    state.params = p.params;
    syncParamControls();
  }
}

function updateAnalysisUI(p) {
  if (!p?.autoCorr) return;
  const corr = p.autoCorr;
  const labels = { general: '일반 사진', portrait: '인물 사진', group: `단체사진 · ${p.faceDetections.length}명` };
  const environments = { indoor: '실내', outdoor: '실외', unknown: '환경 불확실' };
  $('scene-label').textContent = `${environments[corr.environment]} · ${labels[corr.sceneType] || '사진'}`;
  $('environment-select').value = p.environmentOverride;

  const changes = [];
  if (corr.needsTone) changes.push('노출');
  if (corr.wbApplied) changes.push(corr.environment === 'indoor' ? '실내 조명색' : '색감');
  if (corr.autoNoiseReduction > 0) changes.push('실내 노이즈');
  if (corr.environment === 'outdoor' && corr.highlightCompression > 0) changes.push('실외 하이라이트');
  if (corr.backlitFaces) changes.push(`어두운 얼굴 ${corr.backlitFaces}명`);
  if (p.params.skinSmooth > 0) changes.push('인물 자연 보정');
  $('analysis-verdict').textContent = changes.length ? '필요한 부분만 보정' : '원본 유지 권장';
  $('analysis-detail').textContent = changes.length
    ? `${changes.join(' · ')}만 자동 조정합니다.${corr.guardScale < 1 ? ' 과보정 방지가 적용됐습니다.' : ''}`
    : '노출과 색감이 양호해 자동 보정을 최소화합니다.';

  setAnalysisBadge('tone-badge', corr.needsTone, corr.needsTone ? '노출 선택 보정' : '노출 유지');
  setAnalysisBadge('wb-badge', corr.wbApplied, corr.wbApplied ? '중립색 기준 보정' : '색감 유지');
  setAnalysisBadge('face-light-badge', corr.backlitFaces > 0, corr.backlitFaces ? '역광 얼굴 보정' : '얼굴 밝기 유지');
  setAnalysisBadge(
    'environment-badge', corr.environment !== 'unknown',
    corr.environment === 'indoor' ? '실내 맞춤' : corr.environment === 'outdoor' ? '실외 맞춤' : '환경 보수 판단',
  );
}

function setAnalysisBadge(id, active, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('active', active);
}

// ── Thumbnail Strip ───────────────────────────────────────────
function renderThumbs() {
  thumbStrip.innerHTML = '';
  state.photos.forEach((p, i) => {
    const item = document.createElement('div');
    const reviewState = getPhotoReviewState(p);
    item.className = 'thumb-item' + (p.ready ? ' ready' : '') + (i === state.activeIdx ? ' active' : '')
      + ` review-${reviewState}` + (p.exportIncluded === false ? ' export-excluded' : '')
      + (matchesReviewFilter(p) ? '' : ' filter-hidden');
    item.dataset.idx = i;

    const img = document.createElement('img');
    img.src = p.objectURL;
    img.alt = p.name;

    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;

    const dot = document.createElement('span');
    dot.className = 'thumb-status';

    const reviewMark = document.createElement('span');
    reviewMark.className = 'thumb-review-mark';
    reviewMark.textContent = p.exportIncluded === false ? '×' : reviewState === 'review' ? '!' : reviewState === 'duplicate' ? '=' : '✓';

    item.append(img, dot, reviewMark, num);
    item.addEventListener('click', () => setActive(i));
    thumbStrip.appendChild(item);
  });

  // Show/hide download-all
  const includedCount = state.photos.filter(p => p.exportIncluded !== false).length;
  const multi = state.photos.length > 1 && includedCount > 0;
  downloadAllBtn.classList.toggle('hidden', !multi);
  totalCountEl.textContent = includedCount;
  updateCounter();
}

function getPhotoReviewState(p) {
  if (p.exportIncluded === false) return 'excluded';
  if (p.reviewApproved) return 'good';
  if (p.workflow?.duplicateOf !== null && p.workflow?.duplicateOf !== undefined) return 'duplicate';
  if (p.workflow && p.workflow.issues.length === 0) return 'good';
  return p.workflow ? 'review' : 'pending';
}

function matchesReviewFilter(p) {
  if (state.reviewFilter === 'all') return true;
  if (state.reviewFilter === 'excluded') return p.exportIncluded === false;
  if (state.reviewFilter === 'duplicate') return p.workflow?.duplicateOf !== null && p.workflow?.duplicateOf !== undefined;
  const status = getPhotoReviewState(p);
  if (state.reviewFilter === 'review') return status === 'review';
  return status === state.reviewFilter;
}

function updateWorkflowUI() {
  const counts = { all: state.photos.length, review: 0, good: 0, duplicate: 0, excluded: 0 };
  state.photos.forEach(p => {
    const status = getPhotoReviewState(p);
    if (status === 'review') counts.review++;
    if (status === 'good') counts.good++;
    if (p.workflow?.duplicateOf !== null && p.workflow?.duplicateOf !== undefined) counts.duplicate++;
    if (p.exportIncluded === false) counts.excluded++;
  });
  Object.entries(counts).forEach(([key, value]) => {
    const el = $(`filter-${key}-count`);
    if (el) el.textContent = value;
  });
  const groups = new Set(state.photos.map(p => p.eventGroup).filter(Boolean)).size;
  const validated = state.photos.filter(p => p.validationResult).length;
  const correct = state.photos.filter(p => p.validationResult === 'correct').length;
  const accuracy = validated ? ` · 선별 검증 ${correct}/${validated} (${Math.round(correct / validated * 100)}%)` : '';
  const included = state.photos.length - counts.excluded;
  $('workflow-summary').textContent = (counts.review || counts.duplicate
    ? `${groups}개 촬영 묶음 · 추천 출력 ${included}장 · 제외 ${counts.excluded}장`
    : `${groups}개 촬영 묶음 · 추천 출력 ${included}장`) + accuracy;
  totalCountEl.textContent = included;
}

function updateReviewUI(p) {
  if (!p?.workflow) {
    $('review-status').textContent = '자동 검수 대기';
    $('review-detail').textContent = '초점, 노출, 중복 여부를 자동으로 확인합니다.';
    $('event-group-label').textContent = '촬영 묶음 분석 중';
    $('review-approve-btn').disabled = true;
    $('review-reject-btn').disabled = true;
    $('toggle-selection-btn').disabled = true;
    return;
  }
  const status = getPhotoReviewState(p);
  $('event-group-label').textContent = `촬영 묶음 ${p.eventGroup} · 색감 통일 적용`;
  $('review-status').textContent = status === 'excluded' ? '출력 제외' : status === 'good' ? '검수 완료' : status === 'duplicate' ? '중복 후보' : '확인 필요';
  const confidence = Math.round((p.workflow.confidence || 0) * 100);
  const resultText = p.workflow.bestOfGroup ? '유사 사진 중 추천본' : p.workflow.issues.length ? p.workflow.issues.join(' · ') : '초점과 노출이 양호합니다.';
  $('review-detail').textContent = `${resultText} · 자동 판단 ${confidence}% · 품질 ${p.workflow.qualityScore}점`;
  $('review-approve-btn').disabled = false;
  $('review-reject-btn').disabled = false;
  $('toggle-selection-btn').disabled = false;
  $('review-approve-btn').textContent = p.validationResult === 'correct' ? '맞음으로 기록됨' : '자동 판단 맞음';
  $('review-reject-btn').textContent = p.validationResult === 'incorrect' ? '틀림으로 기록됨' : '판단이 틀림';
  $('review-card').classList.toggle('needs-review', status === 'review' || status === 'duplicate');
  $('review-card').classList.toggle('export-excluded', p.exportIncluded === false);
  $('toggle-selection-btn').textContent = p.exportIncluded === false ? '이 사진 다시 출력에 포함' : '이 사진 출력에서 제외';
  $('toggle-selection-btn').classList.toggle('is-excluded', p.exportIncluded === false);
}

function updateThumbActive() {
  thumbStrip.querySelectorAll('.thumb-item').forEach((el, i) => {
    el.classList.toggle('active', i === state.activeIdx);
  });
  // Scroll active into view
  const active = thumbStrip.querySelector('.thumb-item.active');
  active?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
}

function updateCounter() {
  const n = state.photos.length;
  photoCounter.textContent = `${n}장`;
  photoCounter.classList.toggle('hidden', n === 0);
}

// ── Auto Correction ───────────────────────────────────────────
function computeAutoCorr(imageData, environmentOverride = 'auto') {
  const d = imageData.data;
  const n = d.length / 4;
  const W = imageData.width, H = imageData.height;
  const hY = new Int32Array(256);
  let neutralR = 0, neutralG = 0, neutralB = 0, neutralCount = 0, neutralChromaSum = 0;
  let clippedDark = 0, clippedBright = 0;
  let skyPixels = 0, greenPixels = 0, warmPixels = 0;
  let noiseSum = 0, noiseCount = 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const pixel = i / 4;
    const x = pixel % W;
    const row = Math.floor(pixel / W);
    hY[y]++;
    if (y <= 2) clippedDark++;
    if (y >= 253) clippedBright++;

    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (y > 35 && y < 225 && chroma < 24) {
      neutralR += r; neutralG += g; neutralB += b; neutralChromaSum += chroma; neutralCount++;
    }
    if (row < H * 0.6 && b > 105 && b > r + 24 && b > g + 8) skyPixels++;
    if (g > 65 && g > r * 1.08 && g > b * 1.05) greenPixels++;
    if (y > 40 && r > b + 24 && r > g * 1.02) warmPixels++;

    if (pixel % 16 === 0 && x < W - 1 && y < 190) {
      const j = i + 4;
      const nextY = 0.299 * d[j] + 0.587 * d[j+1] + 0.114 * d[j+2];
      const diff = Math.abs(y - nextY);
      if (diff < 35) { noiseSum += diff; noiseCount++; }
    }
  }

  function percentile(p) {
    const target = n * p;
    let s = 0;
    for (let i = 0; i < 256; i++) { s += hY[i]; if (s >= target) return i; }
    return 255;
  }

  const p05 = percentile(0.05), median = percentile(0.5), p95 = percentile(0.95), p99 = percentile(0.99);
  let exposureEV = 0;
  if (median < 68) exposureEV = Math.min(0.45, Math.log2(92 / Math.max(20, median)) * 0.45);
  else if (median > 188) exposureEV = Math.max(-0.3, Math.log2(168 / median) * 0.4);

  const dynamicRange = p95 - p05;
  let shadowLift = median < 108 && p05 < 12 ? Math.min(14, (12 - p05) * 0.8) : 0;
  let highlightCompression = p99 > 251 && clippedBright / n > 0.015 ? 0.1 : 0;
  const contrastBoost = dynamicRange < 105 ? Math.min(0.1, (105 - dynamicRange) / 500) : 0;

  let rawWB = [1, 1, 1], wbCandidate = false, wbConfidence = 0;
  if (neutralCount > n * 0.008) {
    const nr = neutralR / neutralCount, ng = neutralG / neutralCount, nb = neutralB / neutralCount;
    const avg = (nr + ng + nb) / 3;
    const raw = [avg / nr, avg / ng, avg / nb];
    const maxShift = Math.max(...raw.map(v => Math.abs(v - 1)));
    if (maxShift > 0.012 && maxShift < 0.12) {
      rawWB = raw;
      wbCandidate = true;
      const coverage = Math.min(1, neutralCount / Math.max(1, n * 0.06));
      const neutrality = 1 - Math.min(1, (neutralChromaSum / neutralCount) / 24);
      wbConfidence = Math.max(0.35, Math.min(1, coverage * 0.7 + neutrality * 0.45));
    }
  }

  const features = {
    skyRatio: skyPixels / n,
    greenRatio: greenPixels / n,
    warmRatio: warmPixels / n,
    noiseScore: noiseCount ? noiseSum / noiseCount : 0,
  };
  const outdoorScore = features.skyRatio * 4 + features.greenRatio * 1.5
    + (dynamicRange > 150 ? 0.2 : 0) + (median > 115 ? 0.15 : 0);
  const indoorScore = features.warmRatio * 2 + (median < 105 ? 0.25 : 0)
    + (features.noiseScore > 7 ? 0.2 : 0) + (features.skyRatio < 0.01 ? 0.1 : 0);
  let environment = 'unknown';
  if (environmentOverride !== 'auto') environment = environmentOverride;
  else if (outdoorScore > 0.55 && outdoorScore - indoorScore > 0.18) environment = 'outdoor';
  else if (indoorScore > 0.48 && indoorScore - outdoorScore > 0.18) environment = 'indoor';
  const environmentConfidence = environmentOverride !== 'auto'
    ? 1 : Math.min(1, Math.abs(outdoorScore - indoorScore) / 1.2);

  let wb = [1, 1, 1], wbApplied = false;
  if (wbCandidate) {
    const limit = environment === 'indoor' ? 0.06 : environment === 'outdoor' ? 0.03 : 0.04;
    wb = rawWB.map(v => Math.max(1 - limit, Math.min(1 + limit, v)));
    wbApplied = true;
  }

  let autoNoiseReduction = 0;
  if (environment === 'indoor') {
    if (median < 125 && p05 < 18) shadowLift = Math.max(shadowLift, Math.min(12, (18 - p05) * 0.4));
    if (features.noiseScore > 6) autoNoiseReduction = Math.min(18, (features.noiseScore - 5) * 2.5);
  } else if (environment === 'outdoor' && features.skyRatio > 0.08 && p99 > 245) {
    highlightCompression = Math.max(highlightCompression, 0.06);
  }

  const correction = {
    exposureEV, shadowLift, highlightCompression, contrastBoost, wb, wbApplied, wbConfidence,
    environment, environmentConfidence, environmentSource: environmentOverride === 'auto' ? 'auto' : 'manual',
    autoNoiseReduction, features,
    needsTone: Math.abs(exposureEV) > 0.01 || shadowLift > 0 || highlightCompression > 0 || contrastBoost > 0,
    stats: { p05, median, p95, p99, dynamicRange, clippedDark: clippedDark / n, clippedBright: clippedBright / n },
    guardScale: 1,
  };
  correction.guardScale = evaluateCorrectionSafety(d, correction);
  return correction;
}

function evaluateCorrectionSafety(d, corr) {
  let before = 0, after = 0, count = 0, totalShift = 0;
  for (let i = 0; i < d.length; i += 80) {
    const r = d[i], g = d[i+1], b = d[i+2];
    if (r <= 1 || g <= 1 || b <= 1 || r >= 254 || g >= 254 || b >= 254) before++;
    const [rr, gg, bb] = applySmartPixel(r, g, b, corr, 1);
    if (rr <= 1 || gg <= 1 || bb <= 1 || rr >= 254 || gg >= 254 || bb >= 254) after++;
    totalShift += (Math.abs(rr - r) + Math.abs(gg - g) + Math.abs(bb - b)) / 3;
    count++;
  }
  const clipIncrease = Math.max(0, (after - before) / Math.max(1, count));
  const averageShift = totalShift / Math.max(1, count);
  const clippingScale = Math.max(0.35, 1 - clipIncrease * 35);
  const shiftScale = averageShift > 22 ? Math.max(0.5, 22 / averageShift) : 1;
  return Math.min(clippingScale, shiftScale);
}

// ── Processing Pipeline ───────────────────────────────────────
function applyProcessing() {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  const { displayW: W, displayH: H } = p;
  // use cached raw pixels — avoids GPU→CPU readback on every slider move
  const id = new ImageData(new Uint8ClampedArray(p.rawPixels), W, H);
  const d  = id.data;

  const params = p.params;
  applySmartAuto(d, p.autoCorr, params.autoStrength);
  applyBCS(d, params.brightness, params.contrast, params.saturation);
  applyTemperature(d, params.temperature);
  applyHighlightsShadows(d, params.highlights, params.shadows);

  ctxAfter.putImageData(id, 0, 0);

  if (p.faceAdjustments.length && params.autoStrength > 0) {
    autoFaceLight(ctxAfter, W, H, p.faceDetections, p.faceAdjustments, params.autoStrength / 100);
  }
  const autoNoise = p.autoCorr.autoNoiseReduction * (params.autoStrength / 100);
  const noiseReduction = Math.max(params.noiseReduction, autoNoise);
  if (noiseReduction > 0) applyNoiseReduction(ctxAfter, W, H, noiseReduction / 100);
  if (params.clarity > 0)        applyClarity(ctxAfter, W, H, params.clarity);
  if (params.sharpness > 0)      unsharpMask(ctxAfter, W, H, params.sharpness / 100);
  if (params.skinSmooth > 0)     skinSmooth(ctxAfter, W, H, params.skinSmooth / 100, p.faceDetections);

  updateClip();
}

function applySmartAuto(d, corr, amount) {
  const strength = (amount / 100) * corr.guardScale;
  if (strength <= 0) return;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    const corrected = applySmartPixel(r, g, b, corr, strength);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
}

function applyBCS(d, br, co, sa) {
  if (!br && !co && !sa) return;
  for (let i = 0; i < d.length; i += 4) {
    const corrected = applyBasicAdjustmentsPixel(d[i], d[i+1], d[i+2], br, co, sa);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
}

// ── Temperature ───────────────────────────────────────────────
function applyTemperature(d, amount) {
  if (!amount) return;
  const shift = amount / 100 * 0.08;
  const corr = {
    exposureEV: 0, shadowLift: 0, highlightCompression: 0, contrastBoost: 0,
    wb: [1 + shift, 1, 1 - shift], wbConfidence: 1,
  };
  for (let i = 0; i < d.length; i += 4) {
    const corrected = applySmartPixel(d[i], d[i+1], d[i+2], corr, 1);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
}

// ── Highlights / Shadows ──────────────────────────────────────
function applyHighlightsShadows(d, highlights, shadows) {
  if (!highlights && !shadows) return;
  const hf = highlights / 100, sf = shadows / 100;
  for (let i = 0; i < d.length; i += 4) {
    const y = luminance(d[i], d[i+1], d[i+2]);
    const lum = y / 255;
    const hw = lum * lum;
    const sw = (1 - lum) * (1 - lum);
    const nextY = Math.max(0, Math.min(255, y + sf * 34 * sw - hf * 30 * hw));
    const corrected = adjustLuminancePixel(d[i], d[i+1], d[i+2], nextY);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
}

// ── Clarity (midtone contrast / local contrast) ───────────────
function applyClarity(ctx, W, H, amount) {
  if (!amount) return;
  const orig = ctx.getImageData(0, 0, W, H);
  const blur = new ImageData(new Uint8ClampedArray(orig.data), W, H);
  // single larger radius approximates 3× small-radius box blur (gaussian approx)
  const r = Math.max(6, Math.round(W / 50));
  boxBlur(blur, r);
  const d = orig.data, b = blur.data;
  const str = (amount / 100) * 0.7;
  for (let i = 0; i < d.length; i += 4) {
    const y = luminance(d[i], d[i+1], d[i+2]);
    const blurY = luminance(b[i], b[i+1], b[i+2]);
    const lum = y / 255;
    const mid = 1 - Math.abs(lum - 0.5) * 2;
    const w = str * mid;
    const detail = y - blurY;
    const nextY = y + (Math.abs(detail) > 1.2 ? detail * w : 0);
    const corrected = adjustLuminancePixel(d[i], d[i+1], d[i+2], nextY);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
  ctx.putImageData(orig, 0, 0);
}

// ── Noise Reduction ───────────────────────────────────────────
function applyNoiseReduction(ctx, W, H, amount) {
  if (!amount) return;
  const orig = ctx.getImageData(0, 0, W, H);
  const smth = new ImageData(new Uint8ClampedArray(orig.data), W, H);
  const r = Math.round(1 + (amount / 100) * 2);
  boxBlur(smth, r); boxBlur(smth, r);
  const d = orig.data, s = smth.data;
  // edge-preserving blend: where there's little detail, use smoothed version
  const str = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    const diffR = Math.abs(d[i] - s[i]);
    const diffG = Math.abs(d[i+1] - s[i+1]);
    const diffB = Math.abs(d[i+2] - s[i+2]);
    const edge = Math.max(diffR, diffG, diffB) / 255;
    // less blending on edges (edge > 0.15), more on flat areas
    const blend = str * Math.max(0, 1 - edge * 5);
    d[i]   = clamp(d[i]   * (1 - blend) + s[i]   * blend);
    d[i+1] = clamp(d[i+1] * (1 - blend) + s[i+1] * blend);
    d[i+2] = clamp(d[i+2] * (1 - blend) + s[i+2] * blend);
  }
  ctx.putImageData(orig, 0, 0);
}

// ── Sharpening ────────────────────────────────────────────────
function unsharpMask(ctx, W, H, amount) {
  const orig = ctx.getImageData(0, 0, W, H);
  const blur = new ImageData(new Uint8ClampedArray(orig.data), W, H);
  boxBlur(blur, 2); boxBlur(blur, 2);
  const d = orig.data, b = blur.data;
  const str = amount * 1.05;
  for (let i = 0; i < d.length; i += 4) {
    const y = luminance(d[i], d[i+1], d[i+2]);
    const blurY = luminance(b[i], b[i+1], b[i+2]);
    const detail = y - blurY;
    const threshold = 2 + Math.pow(1 - y / 255, 2) * 4;
    const safeDetail = Math.max(-18, Math.min(18, detail));
    const nextY = y + (Math.abs(detail) > threshold ? safeDetail * str : 0);
    const corrected = adjustLuminancePixel(d[i], d[i+1], d[i+2], nextY);
    d[i] = clamp(corrected[0]);
    d[i+1] = clamp(corrected[1]);
    d[i+2] = clamp(corrected[2]);
  }
  ctx.putImageData(orig, 0, 0);
}

// ── Selective face exposure (backlit portraits / groups) ─────
function autoFaceLight(ctx, W, H, detections, adjustments, strength) {
  if (!detections.length || strength <= 0) return;
  const image = ctx.getImageData(0, 0, W, H);
  const d = image.data;

  detections.forEach((det, index) => {
    const lift = (adjustments[index]?.lift || 0) * strength;
    if (lift < 1) return;
    const box = getFaceBounds(det);
    const faceW = Math.max(1, box.maxX - box.minX);
    const faceH = Math.max(1, box.maxY - box.minY);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2 - faceH * 0.04;
    const rx = faceW * 0.62, ry = faceH * 0.72;
    const minX = Math.max(0, Math.floor(cx - rx));
    const maxX = Math.min(W - 1, Math.ceil(cx + rx));
    const minY = Math.max(0, Math.floor(cy - ry));
    const maxY = Math.min(H - 1, Math.ceil(cy + ry));

    for (let y = minY; y <= maxY; y++) {
      const ny = (y - cy) / ry;
      for (let x = minX; x <= maxX; x++) {
        const nx = (x - cx) / rx;
        const distance = nx * nx + ny * ny;
        if (distance >= 1) continue;
        const weight = Math.pow(1 - distance, 1.7);
        const i = (y * W + x) * 4;
        const delta = lift * weight * getLocalLiftWeight(d[i], d[i+1], d[i+2]);
        const currentY = luminance(d[i], d[i+1], d[i+2]);
        const corrected = adjustLuminancePixel(d[i], d[i+1], d[i+2], Math.min(255, currentY + delta));
        d[i] = clamp(corrected[0]);
        d[i+1] = clamp(corrected[1]);
        d[i+2] = clamp(corrected[2]);
      }
    }
  });
  ctx.putImageData(image, 0, 0);
}

// ── Skin Smoothing ────────────────────────────────────────────
function skinSmooth(ctx, W, H, amount, detections) {
  if (detections.length > 0) faceSmooth(ctx, W, H, amount, detections);
}

function faceSmooth(ctx, W, H, amount, detections) {
  const orig = ctx.getImageData(0, 0, W, H);
  const blur = new ImageData(new Uint8ClampedArray(orig.data), W, H);
  const r = Math.max(2, Math.round(amount * 5));
  boxBlur(blur, r); boxBlur(blur, r); boxBlur(blur, r);

  const mc = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const mx = mc.getContext('2d');
  mx.fillStyle = '#000';
  mx.fillRect(0, 0, W, H);

  for (const det of detections) {
    const pts = det.landmarks.positions;
    mx.fillStyle = '#fff';
    mx.beginPath();
    mx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= 16; i++) mx.lineTo(pts[i].x, pts[i].y);
    mx.lineTo(pts[26].x, pts[26].y - 25);
    mx.lineTo(pts[17].x, pts[17].y - 25);
    mx.closePath();
    mx.fill();

    mx.fillStyle = '#000';
    eraseRegion(mx, pts.slice(17, 22));
    eraseRegion(mx, pts.slice(22, 27));
    eraseRegion(mx, pts.slice(36, 42));
    eraseRegion(mx, pts.slice(42, 48));
    eraseRegion(mx, pts.slice(48, 68));
  }

  const mid = mx.getImageData(0, 0, W, H);
  boxBlur(mid, 10); boxBlur(mid, 10);
  mx.putImageData(mid, 0, 0);

  const mask = mx.getImageData(0, 0, W, H).data;
  const d = orig.data, bl = blur.data;
  for (let i = 0; i < d.length; i += 4) {
    const texture = Math.max(Math.abs(d[i] - bl[i]), Math.abs(d[i+1] - bl[i+1]), Math.abs(d[i+2] - bl[i+2]));
    const textureProtection = Math.max(0, 1 - texture / 20);
    const a = (mask[i] / 255) * Math.min(0.5, amount) * textureProtection;
    d[i]   = d[i]   * (1 - a) + bl[i]   * a;
    d[i+1] = d[i+1] * (1 - a) + bl[i+1] * a;
    d[i+2] = d[i+2] * (1 - a) + bl[i+2] * a;
  }
  ctx.putImageData(orig, 0, 0);
}

function eraseRegion(ctx, pts) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill();
}

// ── Box Blur (sliding-window O(n), not O(n·r)) ────────────────
function boxBlur(imageData, radius) {
  const { data: d, width: W, height: H } = imageData;
  const tmp = new Uint8ClampedArray(d.length);
  const diam = radius * 2 + 1;

  // horizontal pass: src=d → tmp
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let rS = 0, gS = 0, bS = 0;
    // seed the window on the left edge
    for (let dx = -radius; dx <= radius; dx++) {
      const k = (row + Math.max(0, Math.min(W - 1, dx))) * 4;
      rS += d[k]; gS += d[k+1]; bS += d[k+2];
    }
    for (let x = 0; x < W; x++) {
      const k = (row + x) * 4;
      tmp[k] = rS / diam; tmp[k+1] = gS / diam; tmp[k+2] = bS / diam; tmp[k+3] = d[k+3];
      // slide: remove left edge, add right edge
      const outK = (row + Math.max(0, x - radius)) * 4;
      const inK  = (row + Math.min(W - 1, x + radius + 1)) * 4;
      rS += d[inK] - d[outK]; gS += d[inK+1] - d[outK+1]; bS += d[inK+2] - d[outK+2];
    }
  }

  // vertical pass: src=tmp → d
  for (let x = 0; x < W; x++) {
    let rS = 0, gS = 0, bS = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const k = (Math.max(0, Math.min(H - 1, dy)) * W + x) * 4;
      rS += tmp[k]; gS += tmp[k+1]; bS += tmp[k+2];
    }
    for (let y = 0; y < H; y++) {
      const k = (y * W + x) * 4;
      d[k] = rS / diam; d[k+1] = gS / diam; d[k+2] = bS / diam;
      const outK = (Math.max(0, y - radius) * W + x) * 4;
      const inK  = (Math.min(H - 1, y + radius + 1) * W + x) * 4;
      rS += tmp[inK] - tmp[outK]; gS += tmp[inK+1] - tmp[outK+1]; bS += tmp[inK+2] - tmp[outK+2];
    }
  }
}

// ── Comparison Slider ─────────────────────────────────────────
function updateSliderAfterResize() {
  state.sliderPos = 0.5;
  updateClip();
}

(function initSlider() {
  let dragging = false;
  cmpSlider.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = canvasBefore.getBoundingClientRect();
    state.sliderPos = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
    updateClip();
  });
  document.addEventListener('mouseup', () => { dragging = false; });
  cmpSlider.addEventListener('touchstart', e => { dragging = true; e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    const rect = canvasBefore.getBoundingClientRect();
    state.sliderPos = Math.max(0.02, Math.min(0.98, (e.touches[0].clientX - rect.left) / rect.width));
    updateClip();
  });
  document.addEventListener('touchend', () => { dragging = false; });
})();

function updateClip() {
  const p = state.sliderPos;
  canvasAfter.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
  cmpSlider.style.left = `${p * 100}%`;
}

// ── Print crop / automatic face framing ─────────────────────
function getPhotoDimensions(p) {
  const swap = (p.orientation || 1) >= 5;
  const source = getImageSize(p.image);
  return {
    w: swap ? source.h : source.w,
    h: swap ? source.w : source.h,
  };
}

function getPrintTarget(p) {
  const preset = PRINT_SIZES[state.selectedSize];
  if (!preset) return null;
  const { w, h } = getPhotoDimensions(p);
  return w > h ? { w: preset.h, h: preset.w } : { ...preset };
}

function calculateCropRect(sourceW, sourceH, targetW, targetH, crop) {
  const sourceAR = sourceW / sourceH;
  const targetAR = targetW / targetH;
  let baseW = sourceW, baseH = sourceH;
  if (sourceAR > targetAR) baseW = sourceH * targetAR;
  else baseH = sourceW / targetAR;

  const zoom = Math.max(1, crop.zoom || 1);
  const sw = baseW / zoom;
  const sh = baseH / zoom;
  const sx = (sourceW - sw) * Math.max(0, Math.min(1, crop.x));
  const sy = (sourceH - sh) * Math.max(0, Math.min(1, crop.y));
  return { sx, sy, sw, sh };
}

function autoFramePhoto(p) {
  if (!p || !p.displayW || !p.displayH) return;
  const target = getPrintTarget(p);
  const crop = p.crop || (p.crop = makeDefaultCrop());
  crop.zoom = 1;

  if (!p.faceDetections.length || !target) {
    crop.x = 0.5;
    crop.y = 0.5;
    crop.autoFramed = true;
    return;
  }

  const points = p.faceDetections.flatMap(det => det.landmarks.positions);
  const xs = points.map(pt => pt.x), ys = points.map(pt => pt.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const faceW = Math.max(1, maxX - minX), faceH = Math.max(1, maxY - minY);
  const faceBounds = p.faceDetections.map(getFaceBounds);
  const largestFaceW = Math.max(...faceBounds.map(box => box.maxX - box.minX));
  const largestFaceH = Math.max(...faceBounds.map(box => box.maxY - box.minY));
  const isGroup = p.faceDetections.length >= 3;
  const needW = Math.min(p.displayW, faceW + largestFaceW * (isGroup ? 1.5 : 2.1));
  const needH = Math.min(p.displayH, faceH + largestFaceH * (isGroup ? 3.0 : 3.4));
  const base = calculateCropRect(p.displayW, p.displayH, target.w, target.h, makeDefaultCrop());
  crop.zoom = Math.max(1, Math.min(isGroup ? 1.12 : 1.28, Math.min(base.sw / needW, base.sh / needH)));

  const rect = calculateCropRect(p.displayW, p.displayH, target.w, target.h, crop);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2 + largestFaceH * (isGroup ? 0.55 : 0.4);
  crop.x = p.displayW === rect.sw ? 0.5 : (centerX - rect.sw / 2) / (p.displayW - rect.sw);
  crop.y = p.displayH === rect.sh ? 0.5 : (centerY - rect.sh / 2) / (p.displayH - rect.sh);
  crop.x = Math.max(0, Math.min(1, crop.x));
  crop.y = Math.max(0, Math.min(1, crop.y));
  crop.autoFramed = true;
}

function updateCropGuide() {
  const p = state.photos[state.activeIdx];
  const target = p && getPrintTarget(p);
  if (!p || !target || !p.displayW || !p.displayH) {
    cropGuide.classList.add('hidden');
    cropControls.classList.add('hidden');
    return;
  }
  const rect = calculateCropRect(p.displayW, p.displayH, target.w, target.h, p.crop);
  cropGuide.classList.remove('hidden');
  cropControls.classList.remove('hidden');
  cropGuide.style.left = `${rect.sx / p.displayW * 100}%`;
  cropGuide.style.top = `${rect.sy / p.displayH * 100}%`;
  cropGuide.style.width = `${rect.sw / p.displayW * 100}%`;
  cropGuide.style.height = `${rect.sh / p.displayH * 100}%`;
}

function syncCropControls() {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  $('crop-zoom').value = Math.round(p.crop.zoom * 100);
  $('crop-x').value = Math.round(p.crop.x * 100);
  $('crop-y').value = Math.round(p.crop.y * 100);
  $('crop-zoom-val').textContent = `${Math.round(p.crop.zoom * 100)}%`;
  $('crop-x-val').textContent = Math.round(p.crop.x * 100);
  $('crop-y-val').textContent = Math.round(p.crop.y * 100);
  $('crop-status').textContent = p.faceDetections.length
    ? p.faceDetections.length >= 3
      ? `단체사진 ${p.faceDetections.length}명 안전 영역`
      : `얼굴 ${p.faceDetections.length}명 여백 보호`
    : '가운데 자동 맞춤';
}

function syncParamControls() {
  for (const [id, key] of Object.entries(PARAM_MAP)) {
    const value = state.params[key];
    $(id).value = value;
    $(`${id}-val`).textContent = value;
  }
}

// ── Controls ──────────────────────────────────────────────────
const PARAM_MAP = {
  'auto-strength': 'autoStrength',
  'brightness': 'brightness', 'contrast': 'contrast', 'saturation': 'saturation',
  'sharpness': 'sharpness',   'skin-smooth': 'skinSmooth',
  'temperature': 'temperature', 'highlights': 'highlights', 'shadows': 'shadows',
  'clarity': 'clarity', 'noise-reduction': 'noiseReduction',
};

const HEAVY_PARAMS = new Set(['clarity', 'noise-reduction']);
let debounce = null;
for (const id of Object.keys(PARAM_MAP)) {
  const input = $(id);
  const valEl = $(`${id}-val`);
  input.addEventListener('input', () => {
    valEl.textContent = input.value;
    state.params[PARAM_MAP[id]] = +input.value;
    const current = state.photos[state.activeIdx];
    if (current) current.paramsCustomized = true;
    clearTimeout(debounce);
    debounce = setTimeout(applyProcessing, HEAVY_PARAMS.has(id) ? 150 : 80);
  });
}

$('environment-select').addEventListener('change', function () {
  const p = state.photos[state.activeIdx];
  if (!p?.rawPixels) return;
  p.environmentOverride = this.value;
  const raw = new ImageData(new Uint8ClampedArray(p.rawPixels), p.displayW, p.displayH);
  p.autoCorr = computeAutoCorr(raw, p.environmentOverride);
  applyGroupConsistency(p);
  finalizePhotoAnalysis(p, raw);
  updateAnalysisUI(p);
  applyProcessing();
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.reviewFilter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(item => item.classList.toggle('active', item === btn));
    renderThumbs();
    const active = state.photos[state.activeIdx];
    if (!active || !matchesReviewFilter(active)) {
      const next = state.photos.findIndex(matchesReviewFilter);
      if (next >= 0) setActive(next);
    }
  });
});

$('review-approve-btn').addEventListener('click', () => {
  const p = state.photos[state.activeIdx];
  if (!p?.workflow) return;
  p.reviewApproved = true;
  p.validationResult = 'correct';
  updateReviewUI(p);
  renderThumbs();
  updateWorkflowUI();
  if (state.reviewFilter === 'review' || state.reviewFilter === 'duplicate') {
    const next = state.photos.findIndex((photo, idx) => idx !== state.activeIdx && matchesReviewFilter(photo));
    if (next >= 0) setActive(next);
  }
});

$('review-reject-btn').addEventListener('click', () => {
  const p = state.photos[state.activeIdx];
  if (!p?.workflow) return;
  p.validationResult = 'incorrect';
  p.reviewApproved = false;
  if (p.autoExcluded) {
    p.exportIncluded = true;
    p.selectionManual = true;
  }
  updateReviewUI(p);
  renderThumbs();
  updateWorkflowUI();
  showToast('오판으로 기록했습니다. 이 결과는 선별 기준 조정에 사용할 수 있습니다.', 'info');
});

$('toggle-selection-btn').addEventListener('click', () => {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  p.exportIncluded = p.exportIncluded === false;
  p.selectionManual = true;
  updateReviewUI(p);
  renderThumbs();
  updateWorkflowUI();
  if (!matchesReviewFilter(p)) {
    const next = state.photos.findIndex(matchesReviewFilter);
    if (next >= 0) setActive(next);
  }
});

$('select-recommended-btn').addEventListener('click', () => {
  state.photos.forEach(p => {
    p.selectionManual = false;
    p.exportIncluded = !p.autoExcluded;
  });
  renderThumbs();
  updateWorkflowUI();
  updateReviewUI(state.photos[state.activeIdx]);
  showToast('중복 사진 중 품질이 가장 좋은 추천본만 선택했습니다.', 'info');
});

$('select-all-btn').addEventListener('click', () => {
  state.photos.forEach(p => {
    p.selectionManual = true;
    p.exportIncluded = true;
  });
  renderThumbs();
  updateWorkflowUI();
  updateReviewUI(state.photos[state.activeIdx]);
  showToast('모든 사진을 출력에 포함했습니다.', 'info');
});

$('apply-all-btn').addEventListener('click', () => {
  const current = state.photos[state.activeIdx];
  if (!current) return;
  state.photos.forEach(p => { p.params = { ...current.params }; });
  state.photos.forEach(p => { p.paramsCustomized = true; });
  state.params = current.params;
  showToast(`${state.photos.length}장에 현재 보정 설정을 적용했습니다.`, 'info');
});

$('reset-photo-btn').addEventListener('click', () => {
  const current = state.photos[state.activeIdx];
  if (!current) return;
  current.params = makeDefaultParams();
  current.paramsCustomized = false;
  applySceneDefaults(current, true);
  state.params = current.params;
  syncParamControls();
  applyProcessing();
  showToast('현재 사진 보정을 초기화했습니다.', 'info');
});

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedSize = btn.dataset.size;
    state.photos.forEach(photo => { photo.cropRestored = false; });
    const p = state.photos[state.activeIdx];
    if (p && state.selectedSize !== 'original') autoFramePhoto(p);
    syncCropControls();
    updateCropGuide();
  });
});

for (const [id, key, scale] of [
  ['crop-zoom', 'zoom', 100], ['crop-x', 'x', 100], ['crop-y', 'y', 100],
]) {
  $(id).addEventListener('input', function () {
    const p = state.photos[state.activeIdx];
    if (!p) return;
    p.crop[key] = +this.value / scale;
    p.crop.autoFramed = false;
    syncCropControls();
    updateCropGuide();
  });
}

$('auto-crop-btn').addEventListener('click', () => {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  autoFramePhoto(p);
  syncCropControls();
  updateCropGuide();
});

$('center-crop-btn').addEventListener('click', () => {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  p.crop = makeDefaultCrop();
  syncCropControls();
  updateCropGuide();
});

$('quality').addEventListener('input', function () {
  $('quality-val').textContent = `${this.value}%`;
});

$('output-intent').addEventListener('change', function () {
  state.outputIntent = this.value;
  scheduleProjectSave();
});

// ── Export ────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => exportPhoto(state.activeIdx));
downloadAllBtn.addEventListener('click', exportAll);

async function exportPhoto(idx) {
  if (idx < 0) return;
  downloadBtn.disabled = true;
  showProc('고화질 사진 만드는 중...', state.photos[idx]?.name || '');
  await tick();
  try {
    await ensurePhotoAnalysis(idx);
    throwIfCancelled();
    const result = await buildPhotoBlob(idx);
    downloadBlob(result.blob, result.filename);
    if (state.photos[idx].exportDownscaled) {
      showToast('브라우저 안정성을 위해 매우 큰 원본은 장축 6500px 이내로 저장했습니다.', 'info');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('저장 작업을 중지했습니다.', 'info');
      return;
    }
    console.error(e);
    showToast('사진을 저장하지 못했습니다. 사진 크기를 줄여 다시 시도해주세요.');
  } finally {
    hideProc();
    downloadBtn.disabled = false;
  }
}

async function ensurePhotoAnalysis(idx) {
  const p = state.photos[idx];
  if (!p) return;
  if (p.ready) {
    if (state.selectedSize !== 'original' && p.crop.autoFramed) autoFramePhoto(p);
    return;
  }

  const img = p.image;
  const o = p.orientation || 1;
  const swap = o >= 5;
  const source = getImageSize(img);
  const oW = swap ? source.h : source.w;
  const oH = swap ? source.w : source.h;
  const scale = Math.min(1, 900 / Math.max(oW, oH));
  const w = Math.max(1, Math.round(oW * scale));
  const h = Math.max(1, Math.round(oH * scale));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawImageOriented(ctx, img, o, w, h);
  const analysisData = ctx.getImageData(0, 0, w, h);
  p.autoCorr = computeAutoCorr(analysisData, p.environmentOverride);
  applyGroupConsistency(p);
  p.displayW = w;
  p.displayH = h;

  if (faceApiReadyPromise) await faceApiReadyPromise;
  if (state.faceApiLoaded) {
    try {
      p.faceDetections = await detectFacesForPhoto(p, w, h);
    } catch { p.faceDetections = []; }
  }
  finalizePhotoAnalysis(p, analysisData);
  if (!p.cropRestored) autoFramePhoto(p);
}

async function buildPhotoBlob(idx) {
  const p = state.photos[idx];
  if (!p) throw new Error('Photo not found');

  const img = p.image;
  const o = p.orientation || 1;
  const swap = o >= 5;
  const source = getImageSize(img);
  const oW = swap ? source.h : source.w;
  const oH = swap ? source.w : source.h;
  const params = p.params;
  const target = getPrintTarget(p);
  let workW, workH, sourceCrop = null;
  if (target) {
    workW = target.w; workH = target.h;
    sourceCrop = calculateCropRect(oW, oH, target.w, target.h, p.crop);
  } else {
    const safe = getSafeExportDimensions(oW, oH, MAX_EXPORT_PIXELS, MAX_EXPORT_EDGE);
    workW = safe.width;
    workH = safe.height;
    p.exportDownscaled = safe.scale < 0.999;
  }

  const fc = Object.assign(document.createElement('canvas'), { width: workW, height: workH });
  const fx = fc.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (target && o === 1) {
    fx.drawImage(img, sourceCrop.sx, sourceCrop.sy, sourceCrop.sw, sourceCrop.sh, 0, 0, workW, workH);
  } else if (target) {
    const safe = getSafeExportDimensions(oW, oH, MAX_EXPORT_PIXELS, MAX_EXPORT_EDGE);
    const safeScale = safe.scale;
    const safeW = safe.width;
    const safeH = safe.height;
    const oriented = Object.assign(document.createElement('canvas'), { width: safeW, height: safeH });
    drawImageOriented(oriented.getContext('2d'), img, o, safeW, safeH);
    fx.drawImage(
      oriented,
      sourceCrop.sx * safeScale, sourceCrop.sy * safeScale,
      sourceCrop.sw * safeScale, sourceCrop.sh * safeScale,
      0, 0, workW, workH,
    );
    oriented.width = 1; oriented.height = 1;
  } else {
    drawImageOriented(fx, img, o, workW, workH);
  }

  // reuse autoCorr computed at display size — statistically equivalent
  const id = fx.getImageData(0, 0, workW, workH);
  const d  = id.data;
  applySmartAuto(d, p.autoCorr, params.autoStrength);
  applyBCS(d, params.brightness, params.contrast, params.saturation);
  applyTemperature(d, params.temperature);
  applyHighlightsShadows(d, params.highlights, params.shadows);
  fx.putImageData(id, 0, 0);

  let scaledDetections = [];
  if (p.faceDetections.length > 0) {
    const sourceScaleX = oW / p.displayW, sourceScaleY = oH / p.displayH;
    scaledDetections = p.faceDetections.map(det => ({
      ...det,
      landmarks: { positions: det.landmarks.positions.map(pt => {
        const sourceX = pt.x * sourceScaleX, sourceY = pt.y * sourceScaleY;
        return target
          ? { x: (sourceX - sourceCrop.sx) * workW / sourceCrop.sw, y: (sourceY - sourceCrop.sy) * workH / sourceCrop.sh }
          : { x: sourceX * workW / oW, y: sourceY * workH / oH };
      }) },
    }));
  }

  if (scaledDetections.length && params.autoStrength > 0) {
    autoFaceLight(fx, workW, workH, scaledDetections, p.faceAdjustments, params.autoStrength / 100);
  }

  const autoNoise = p.autoCorr.autoNoiseReduction * (params.autoStrength / 100);
  const noiseReduction = Math.max(params.noiseReduction, autoNoise);
  if (noiseReduction > 0) applyNoiseReduction(fx, workW, workH, noiseReduction / 100);
  if (params.clarity > 0)        applyClarity(fx, workW, workH, params.clarity);
  if (params.sharpness > 0)      unsharpMask(fx, workW, workH, params.sharpness / 100);

  if (params.skinSmooth > 0) {
    if (scaledDetections.length) faceSmooth(fx, workW, workH, params.skinSmooth / 100, scaledDetections);
  }

  const out = fc;
  if (target) {
    const outputSharpening = state.outputIntent === 'print-matte' ? 0.05
      : state.outputIntent === 'print-glossy' ? 0.035 : 0.018;
    unsharpMask(out.getContext('2d', { willReadFrequently: true }), out.width, out.height, outputSharpening);
  }

  const fmt  = $('format-select').value;
  const qual = +$('quality').value / 100;
  const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(out, mime, qual);
  out.width = 1; out.height = 1;
  const ext  = fmt === 'png' ? 'png' : 'jpg';
  const base = p.name.replace(/\.[^.]+$/, '');
  return { blob, filename: `${base}_retouched_${state.selectedSize}.${ext}` };
}

async function exportAll() {
  if (typeof JSZip === 'undefined') {
    showToast('ZIP 기능을 불러오지 못했습니다. 인터넷 연결 후 새로고침해주세요.');
    return;
  }
  const exportItems = state.photos
    .map((photo, index) => ({ photo, index }))
    .filter(item => item.photo.exportIncluded !== false);
  if (!exportItems.length) {
    showToast('출력에 포함된 사진이 없습니다. 사진을 한 장 이상 포함해주세요.');
    return;
  }
  downloadAllBtn.disabled = true;
  const total = exportItems.length;
  showProc('선택 사진 자동 처리 중...', `0 / ${total}장`);
  await tick();
  let zip = new JSZip();
  let zipBytes = 0, zipCount = 0, chunkStart = 0, chunkNumber = 1;

  async function flushZip(endExclusive, finalChunk) {
    if (!zipCount) return;
    throwIfCancelled();
    const currentZip = zip;
    setProc(`ZIP 파일 만드는 중... ${chunkNumber}번째 묶음`);
    const blob = await currentZip.generateAsync(
      { type: 'blob', compression: 'STORE', streamFiles: true },
      info => {
        setProcProgress((endExclusive - 1 + info.percent / 100) / total);
        procSub.textContent = `${chunkStart + 1}~${endExclusive}번 사진 묶는 중`;
      },
    );
    const singleChunk = chunkNumber === 1 && finalChunk;
    const suffix = singleChunk ? '' : `_part${chunkNumber}_${chunkStart + 1}-${endExclusive}`;
    downloadBlob(blob, `AutoRetouch_${total}장_${state.selectedSize}${suffix}.zip`);
    zip = new JSZip();
    zipBytes = 0; zipCount = 0; chunkStart = endExclusive; chunkNumber++;
    await yieldToBrowser();
  }

  try {
    for (let position = 0; position < total; position++) {
      throwIfCancelled();
      const { photo, index } = exportItems[position];
      setProc('사진별 자동 보정 중...');
      procSub.textContent = `${position + 1} / ${total}장 — ${photo.name}`;
      setProcProgress(position / total);
      await yieldToBrowser();
      await ensurePhotoAnalysis(index);
      const result = await buildPhotoBlob(index);
      if (shouldFlushZip(zipBytes, result.blob.size, zipCount, ZIP_CHUNK_BYTES)) await flushZip(position, false);
      zip.file(result.filename, result.blob);
      zipBytes += result.blob.size;
      zipCount++;
    }

    await flushZip(total, true);
    setProcProgress(1);
    const parts = chunkNumber - 1;
    showToast(parts > 1 ? `선택한 ${total}장을 ${parts}개 ZIP으로 나눠 저장했습니다.` : `선택한 ${total}장을 ZIP 파일로 저장했습니다.`, 'info');
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('전체 저장을 중지했습니다. 이미 저장된 ZIP은 사용할 수 있습니다.', 'info');
      return;
    }
    console.error(e);
    showToast('전체 사진 저장에 실패했습니다. 사진 수를 줄여 다시 시도해주세요.');
  } finally {
    hideProc();
    downloadAllBtn.disabled = false;
  }
}

function resizeForPrint(canvas, tW, tH, crop) {
  const { sx, sy, sw, sh } = calculateCropRect(canvas.width, canvas.height, tW, tH, crop);
  const out = Object.assign(document.createElement('canvas'), { width: tW, height: tH });
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, tW, tH);
  return out;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas export failed')), mime, quality);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Utilities ─────────────────────────────────────────────────
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const tick  = () => new Promise(r => setTimeout(r, 30));
const yieldToBrowser = () => new Promise(resolve => {
  if ('requestIdleCallback' in window) window.requestIdleCallback(resolve, { timeout: 60 });
  else setTimeout(resolve, 0);
});

function showProc(msg, sub = '') {
  state.cancelRequested = false;
  procText.textContent = msg;
  procSub.textContent = sub;
  procCancel.disabled = false;
  procCancel.textContent = '작업 중지';
  setProcProgress(0);
  procOverlay.classList.remove('hidden');
}
function setProc(msg)  { procText.textContent = msg; }
function hideProc()    { procOverlay.classList.add('hidden'); }
function setProcProgress(value) { procProgress.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`; }
function throwIfCancelled() {
  if (!state.cancelRequested) return;
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  throw error;
}

procCancel.addEventListener('click', () => {
  state.cancelRequested = true;
  procCancel.disabled = true;
  procCancel.textContent = '중지하는 중...';
});

function showToast(msg, type = 'error') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast${type === 'info' ? ' info' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Local project persistence ─────────────────────────────────
function updateProjectStatus(text) {
  $('project-status').textContent = text;
}

function getProjectMetadata() {
  return {
    selectedSize: state.selectedSize,
    outputIntent: state.outputIntent,
    activeIdx: state.activeIdx,
    reviewFilter: state.reviewFilter,
    format: $('format-select').value,
    quality: +$('quality').value,
    photos: state.photos.map(createPhotoSnapshot),
  };
}

async function saveProjectState(manual = false) {
  if (!state.photos.length || projectRestoring) return;
  if (!projectFilesPersisted) {
    updateProjectStatus('사진 저장 공간 부족');
    if (manual) showToast('브라우저 저장 공간이 부족합니다. 다운로드 후 작업을 마쳐주세요.');
    return;
  }
  try {
    updateProjectStatus('저장 중…');
    await storeProjectMetadata(getProjectMetadata());
    const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    updateProjectStatus(`${time} 자동 저장`);
    if (manual) showToast('현재 작업을 이 브라우저에 저장했습니다.', 'info');
  } catch (error) {
    console.warn('Project save failed:', error);
    updateProjectStatus('자동 저장 실패');
  }
}

function scheduleProjectSave() {
  if (!state.photos.length || projectRestoring) return;
  clearTimeout(projectSaveTimer);
  updateProjectStatus('변경사항 저장 대기');
  projectSaveTimer = setTimeout(() => saveProjectState(), 700);
}

async function restoreProject() {
  projectRestoring = true;
  try {
    const saved = await loadStoredProject();
    if (!saved.files.length || !saved.metadata) {
      updateProjectStatus('저장된 작업 없음');
      return;
    }
    const files = saved.files.map(item => new File([item.blob], item.name, {
      type: item.type || item.blob.type,
      lastModified: item.lastModified,
    }));
    projectFilesPersisted = true;
    state.selectedSize = saved.metadata.selectedSize || 'original';
    state.outputIntent = saved.metadata.outputIntent || 'print-glossy';
    state.reviewFilter = saved.metadata.reviewFilter || 'all';
    $('format-select').value = saved.metadata.format || 'jpeg';
    $('quality').value = saved.metadata.quality || 95;
    $('quality-val').textContent = `${$('quality').value}%`;
    $('output-intent').value = state.outputIntent;
    document.querySelectorAll('.size-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.size === state.selectedSize));
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === state.reviewFilter));
    uploadZone.style.display = 'none';
    editor.classList.remove('hidden');
    await loadImages(files, true, { skipPersist: true, snapshots: saved.metadata.photos || [] });
    const restoredIndex = Math.max(0, Math.min(state.photos.length - 1, saved.metadata.activeIdx || 0));
    await setActive(restoredIndex);
    updateProjectStatus('이전 작업 복구됨');
    showToast(`이전 작업 ${state.photos.length}장을 복구했습니다.`, 'info');
  } catch (error) {
    console.warn('Project restore failed:', error);
    updateProjectStatus('작업 복구 실패');
  } finally {
    projectRestoring = false;
  }
}

$('save-project-btn').addEventListener('click', async () => {
  if (!state.photos.length) {
    showToast('먼저 사진을 불러와주세요.', 'info');
    return;
  }
  try {
    await storeProjectFiles(state.photos.map(p => p.sourceFile));
    projectFilesPersisted = true;
  } catch {
    projectFilesPersisted = false;
  }
  await saveProjectState(true);
});

document.addEventListener('input', event => {
  if (event.target.matches('input[type="range"], select')) scheduleProjectSave();
});
document.addEventListener('click', event => {
  if (event.target.closest('#editor button')) scheduleProjectSave();
});

// ── Mobile Bottom Sheet ───────────────────────────────────────
(function initBottomSheet() {
  const panel   = $('controls-panel');
  const handle  = $('panel-handle');
  if (!handle) return;

  let startY = 0, startOpen = false, dragging = false;

  function isMobile() { return window.innerWidth <= 768; }

  handle.addEventListener('click', () => {
    if (!isMobile()) return;
    panel.classList.toggle('sheet-open');
  });

  // Touch drag to open/close
  handle.addEventListener('touchstart', e => {
    if (!isMobile()) return;
    startY = e.touches[0].clientY;
    startOpen = panel.classList.contains('sheet-open');
    dragging = true;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!dragging || !isMobile()) return;
    dragging = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (startOpen && dy > 60)       panel.classList.remove('sheet-open');
    else if (!startOpen && dy < -60) panel.classList.add('sheet-open');
  }, { passive: true });
})();

// ── Boot ──────────────────────────────────────────────────────
faceApiReadyPromise = loadFaceApi();
restoreProject();
