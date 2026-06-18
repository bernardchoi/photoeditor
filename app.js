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

const DEFAULT_PARAMS = Object.freeze({
  brightness: 0, contrast: 0, saturation: 0, sharpness: 30, skinSmooth: 50,
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
  sliderPos: 0.5,
  params: makeDefaultParams(),
};
let faceApiReadyPromise = null;

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
  state.params = makeDefaultParams();
  editor.classList.add('hidden');
  uploadZone.style.display = '';
  fileInput.value = '';
  thumbStrip.innerHTML = '';
  photoCounter.classList.add('hidden');
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

async function loadImages(files, isFirst) {
  showProc('사진 불러오는 중...', '');
  const start = state.photos.length;
  const images = await Promise.all(files.map(loadImageFile));

  images.forEach((img, i) => {
    if (!img) return;
    state.photos.push({
      image: img.image,
      name: img.name,
      objectURL: img.objectURL,
      orientation: img.orientation || 1,
      sizeMB: img.sizeMB || 0,
      params: makeDefaultParams(),
      crop: makeDefaultCrop(),
      autoCorr: null,
      faceDetections: [],
      displayW: 0,
      displayH: 0,
      ready: false,
    });
  });

  updateCounter();
  renderThumbs();

  // Switch to first new photo
  await setActive(start);
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
    p.autoCorr = computeAutoCorr(raw);

    if (faceApiReadyPromise) await faceApiReadyPromise;
    if (state.faceApiLoaded) {
      setProc(`얼굴 감지 중... (${idx + 1}/${state.photos.length})`);
      try {
        p.faceDetections = await detectFacesForPhoto(p, dW, dH);
      } catch { p.faceDetections = []; }
    }
    autoFramePhoto(p);
    p.ready = true;
    thumbStrip.querySelector(`[data-idx="${idx}"]`)?.classList.add('ready');
    hideProc();
  }

  updateFaceStatus(p.faceDetections);
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

// ── Thumbnail Strip ───────────────────────────────────────────
function renderThumbs() {
  thumbStrip.innerHTML = '';
  state.photos.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (p.ready ? ' ready' : '') + (i === state.activeIdx ? ' active' : '');
    item.dataset.idx = i;

    const img = document.createElement('img');
    img.src = p.objectURL;
    img.alt = p.name;

    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;

    const dot = document.createElement('span');
    dot.className = 'thumb-status';

    item.append(img, dot, num);
    item.addEventListener('click', () => setActive(i));
    thumbStrip.appendChild(item);
  });

  // Show/hide download-all
  const multi = state.photos.length > 1;
  downloadAllBtn.classList.toggle('hidden', !multi);
  totalCountEl.textContent = state.photos.length;
  updateCounter();
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
function computeAutoCorr(imageData) {
  const d = imageData.data;
  const n = d.length / 4;
  const hR = new Int32Array(256), hG = new Int32Array(256), hB = new Int32Array(256);
  let rS = 0, gS = 0, bS = 0;

  for (let i = 0; i < d.length; i += 4) {
    hR[d[i]]++; hG[d[i+1]]++; hB[d[i+2]]++;
    rS += d[i]; gS += d[i+1]; bS += d[i+2];
  }

  const clip = n * 0.005;
  function pct(h, lo) {
    let s = 0;
    for (let i = 0; i < 256; i++) { s += h[i]; if (s >= lo) return i; }
    return 255;
  }

  const avg = (rS + gS + bS) / (3 * n);
  // Clamp WB shifts to ±8% — prevents yellow/blue cast on outdoor scenes with dominant sky
  const wbClamp = (v) => Math.max(0.92, Math.min(1.08, v));
  return {
    levels: [
      [pct(hR, clip), pct(hR, n - clip)],
      [pct(hG, clip), pct(hG, n - clip)],
      [pct(hB, clip), pct(hB, n - clip)],
    ],
    wb: [wbClamp(avg / (rS / n)), wbClamp(avg / (gS / n)), wbClamp(avg / (bS / n))],
  };
}

// ── Processing Pipeline ───────────────────────────────────────
function applyProcessing() {
  const p = state.photos[state.activeIdx];
  if (!p) return;
  const { displayW: W, displayH: H } = p;
  // use cached raw pixels — avoids GPU→CPU readback on every slider move
  const id = new ImageData(new Uint8ClampedArray(p.rawPixels), W, H);
  const d  = id.data;

  applyAutoLevels(d, p.autoCorr.levels);
  applyWhiteBalance(d, p.autoCorr.wb);
  const params = p.params;
  applyBCS(d, params.brightness, params.contrast, params.saturation);
  applyTemperature(d, params.temperature);
  applyHighlightsShadows(d, params.highlights, params.shadows);

  ctxAfter.putImageData(id, 0, 0);

  if (params.noiseReduction > 0) applyNoiseReduction(ctxAfter, W, H, params.noiseReduction / 100);
  if (params.clarity > 0)        applyClarity(ctxAfter, W, H, params.clarity);
  if (params.sharpness > 0)      unsharpMask(ctxAfter, W, H, params.sharpness / 100);
  if (params.skinSmooth > 0)     skinSmooth(ctxAfter, W, H, params.skinSmooth / 100, p.faceDetections);

  updateClip();
}

function applyAutoLevels(d, levels) {
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = levels[c];
      const rng = hi - lo;
      if (rng > 0) d[i+c] = clamp(Math.round(((d[i+c] - lo) / rng) * 255));
    }
  }
}

function applyWhiteBalance(d, wb) {
  const [rS, gS, bS] = wb;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = clamp(d[i]   * rS);
    d[i+1] = clamp(d[i+1] * gS);
    d[i+2] = clamp(d[i+2] * bS);
  }
}

function applyBCS(d, br, co, sa) {
  const bv = br * 2.55;
  const cf = (259 * (co + 255)) / (255 * (259 - co));
  const sf = (sa + 100) / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i+1], b = d[i+2];
    r = clamp(r + bv); g = clamp(g + bv); b = clamp(b + bv);
    r = clamp(cf * (r - 128) + 128);
    g = clamp(cf * (g - 128) + 128);
    b = clamp(cf * (b - 128) + 128);
    const gr = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i]   = clamp(gr + (r - gr) * sf);
    d[i+1] = clamp(gr + (g - gr) * sf);
    d[i+2] = clamp(gr + (b - gr) * sf);
  }
}

// ── Temperature ───────────────────────────────────────────────
function applyTemperature(d, amount) {
  if (!amount) return;
  const rv = amount * 0.8, bv = -amount * 0.8;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = clamp(d[i]   + rv);
    d[i+2] = clamp(d[i+2] + bv);
  }
}

// ── Highlights / Shadows ──────────────────────────────────────
function applyHighlightsShadows(d, highlights, shadows) {
  if (!highlights && !shadows) return;
  const hf = highlights / 100, sf = shadows / 100;
  for (let i = 0; i < d.length; i += 4) {
    // compute luminance once, share weight across all 3 channels
    const lum = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) / 255;
    const hw = lum * lum;
    const sw = (1 - lum) * (1 - lum);
    const delta = (hf * hw * (1 - lum) - hf * hw * lum * 0.5
                 + sf * sw * (1 - lum) * 0.8) * 255;
    d[i]   = clamp(d[i]   + delta);
    d[i+1] = clamp(d[i+1] + delta);
    d[i+2] = clamp(d[i+2] + delta);
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
    const lum = (d[i] + d[i+1] + d[i+2]) / 3 / 255;
    // only boost midtones (avoid blowing highlights/crushing shadows)
    const mid = 1 - Math.abs(lum - 0.5) * 2;
    const w = str * mid;
    d[i]   = clamp(d[i]   + w * (d[i]   - b[i]));
    d[i+1] = clamp(d[i+1] + w * (d[i+1] - b[i+1]));
    d[i+2] = clamp(d[i+2] + w * (d[i+2] - b[i+2]));
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
  const str = amount * 1.2;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = clamp(d[i]   + str * (d[i]   - b[i]));
    d[i+1] = clamp(d[i+1] + str * (d[i+1] - b[i+1]));
    d[i+2] = clamp(d[i+2] + str * (d[i+2] - b[i+2]));
  }
  ctx.putImageData(orig, 0, 0);
}

// ── Skin Smoothing ────────────────────────────────────────────
function skinSmooth(ctx, W, H, amount, detections) {
  if (detections.length > 0) faceSmooth(ctx, W, H, amount, detections);
  else skinToneSmooth(ctx, W, H, amount * 0.4);
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
    const a = (mask[i] / 255) * amount;
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

function skinToneSmooth(ctx, W, H, amount) {
  const id = ctx.getImageData(0, 0, W, H);
  const d  = id.data;
  const bl = new ImageData(new Uint8ClampedArray(d), W, H);
  boxBlur(bl, 3);
  const b = bl.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], bv = d[i+2];
    if (r > 95 && g > 40 && bv > 20 && r > g && r > bv && r - Math.min(g, bv) > 15) {
      d[i]   = d[i]   * (1 - amount) + b[i]   * amount;
      d[i+1] = d[i+1] * (1 - amount) + b[i+1] * amount;
      d[i+2] = d[i+2] * (1 - amount) + b[i+2] * amount;
    }
  }
  ctx.putImageData(id, 0, 0);
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
  const needW = Math.min(p.displayW, faceW * 2.0);
  const needH = Math.min(p.displayH, faceH * 2.4);
  const base = calculateCropRect(p.displayW, p.displayH, target.w, target.h, makeDefaultCrop());
  crop.zoom = Math.max(1, Math.min(1.35, Math.min(base.sw / needW, base.sh / needH)));

  const rect = calculateCropRect(p.displayW, p.displayH, target.w, target.h, crop);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2 - faceH * 0.12;
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
    ? `얼굴 ${p.faceDetections.length}명 중심 자동 맞춤`
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
    clearTimeout(debounce);
    debounce = setTimeout(applyProcessing, HEAVY_PARAMS.has(id) ? 150 : 80);
  });
}

$('apply-all-btn').addEventListener('click', () => {
  const current = state.photos[state.activeIdx];
  if (!current) return;
  state.photos.forEach(p => { p.params = { ...current.params }; });
  state.params = current.params;
  showToast(`${state.photos.length}장에 현재 보정 설정을 적용했습니다.`, 'info');
});

$('reset-photo-btn').addEventListener('click', () => {
  const current = state.photos[state.activeIdx];
  if (!current) return;
  current.params = makeDefaultParams();
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
    const result = await buildPhotoBlob(idx);
    downloadBlob(result.blob, result.filename);
  } catch (e) {
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
  p.autoCorr = computeAutoCorr(ctx.getImageData(0, 0, w, h));
  p.displayW = w;
  p.displayH = h;

  if (faceApiReadyPromise) await faceApiReadyPromise;
  if (state.faceApiLoaded) {
    try {
      p.faceDetections = await detectFacesForPhoto(p, w, h);
    } catch { p.faceDetections = []; }
  }
  autoFramePhoto(p);
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

  const fc = Object.assign(document.createElement('canvas'), { width: oW, height: oH });
  const fx = fc.getContext('2d', { willReadFrequently: true });
  drawImageOriented(fx, img, o, oW, oH);

  // reuse autoCorr computed at display size — statistically equivalent
  const id = fx.getImageData(0, 0, oW, oH);
  const d  = id.data;
  applyAutoLevels(d, p.autoCorr.levels);
  applyWhiteBalance(d, p.autoCorr.wb);
  applyBCS(d, params.brightness, params.contrast, params.saturation);
  applyTemperature(d, params.temperature);
  applyHighlightsShadows(d, params.highlights, params.shadows);
  fx.putImageData(id, 0, 0);

  if (params.noiseReduction > 0) applyNoiseReduction(fx, oW, oH, params.noiseReduction / 100);
  if (params.clarity > 0)        applyClarity(fx, oW, oH, params.clarity);
  if (params.sharpness > 0)      unsharpMask(fx, oW, oH, params.sharpness / 100);

  if (params.skinSmooth > 0) {
    if (p.faceDetections.length > 0) {
      const sx = oW / p.displayW, sy = oH / p.displayH;
      const scaled = p.faceDetections.map(det => ({
        ...det,
        landmarks: { positions: det.landmarks.positions.map(pt => ({ x: pt.x * sx, y: pt.y * sy })) },
      }));
      faceSmooth(fx, oW, oH, params.skinSmooth / 100, scaled);
    } else {
      skinToneSmooth(fx, oW, oH, (params.skinSmooth / 100) * 0.4);
    }
  }

  const target = getPrintTarget(p);
  const out = target ? resizeForPrint(fc, target.w, target.h, p.crop) : fc;

  const fmt  = $('format-select').value;
  const qual = +$('quality').value / 100;
  const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(out, mime, qual);
  const ext  = fmt === 'png' ? 'png' : 'jpg';
  const base = p.name.replace(/\.[^.]+$/, '');
  return { blob, filename: `${base}_retouched_${state.selectedSize}.${ext}` };
}

async function exportAll() {
  if (typeof JSZip === 'undefined') {
    showToast('ZIP 기능을 불러오지 못했습니다. 인터넷 연결 후 새로고침해주세요.');
    return;
  }
  downloadAllBtn.disabled = true;
  const total = state.photos.length;
  showProc('전체 사진 자동 처리 중...', `0 / ${total}장`);
  await tick();
  const zip = new JSZip();

  try {
    for (let i = 0; i < total; i++) {
      setProc('사진별 자동 보정 중...');
      procSub.textContent = `${i + 1} / ${total}장 — ${state.photos[i].name}`;
      await tick();
      await ensurePhotoAnalysis(i);
      const result = await buildPhotoBlob(i);
      zip.file(result.filename, result.blob);
    }

    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      info => {
        setProc(`ZIP 파일 만드는 중... ${Math.round(info.percent)}%`);
        procSub.textContent = `${total}장 묶는 중`;
      },
    );
    downloadBlob(blob, `AutoRetouch_${total}장_${state.selectedSize}.zip`);
    showToast(`${total}장을 ZIP 파일로 저장했습니다.`, 'info');
  } catch (e) {
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

function showProc(msg, sub = '') { procText.textContent = msg; procSub.textContent = sub; procOverlay.classList.remove('hidden'); }
function setProc(msg)  { procText.textContent = msg; }
function hideProc()    { procOverlay.classList.add('hidden'); }

function showToast(msg, type = 'error') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast${type === 'info' ? ' info' : ''}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

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
