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

// ── State ─────────────────────────────────────────────────────
const state = {
  originalImage: null,
  displayW: 0,
  displayH: 0,
  faceDetections: [],
  faceApiLoaded: false,
  selectedSize: 'original',
  sliderPos: 0.5,
  params: { brightness: 0, contrast: 0, saturation: 0, sharpness: 30, skinSmooth: 50 },
  autoCorr: { levels: null, wb: null },
};

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const uploadZone      = $('upload-zone');
const uploadContent   = $('upload-content');
const fileInput       = $('file-input');
const editor          = $('editor');
const procOverlay     = $('processing-overlay');
const procText        = $('processing-text');
const canvasBefore    = $('canvas-before');
const canvasAfter     = $('canvas-after');
const ctxBefore       = canvasBefore.getContext('2d');
const ctxAfter        = canvasAfter.getContext('2d');
const cmpSlider       = $('comparison-slider');
const faceStatusEl    = $('face-status');
const downloadBtn     = $('download-btn');
const resetBtn        = $('reset-btn');

// ── Face API ──────────────────────────────────────────────────
async function loadFaceApi() {
  const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    state.faceApiLoaded = true;
  } catch (e) {
    console.warn('face-api models failed:', e);
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
  const file = e.dataTransfer.files[0];
  if (file?.type.startsWith('image/')) loadFile(file);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

resetBtn.addEventListener('click', () => {
  editor.classList.add('hidden');
  uploadZone.style.display = '';
  fileInput.value = '';
  state.originalImage = null;
  state.faceDetections = [];
});

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.originalImage = img;
    URL.revokeObjectURL(url);
    startEditor(img);
  };
  img.onerror = () => alert('이미지를 불러올 수 없습니다.');
  img.src = url;
}

// ── Editor Init ───────────────────────────────────────────────
async function startEditor(img) {
  uploadZone.style.display = 'none';
  editor.classList.remove('hidden');
  showProc('사진 분석 중...');

  const maxW = window.innerWidth - 320;
  const maxH = window.innerHeight - 80;
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const dW = Math.round(img.naturalWidth * scale);
  const dH = Math.round(img.naturalHeight * scale);
  state.displayW = dW;
  state.displayH = dH;

  canvasBefore.width = dW;  canvasBefore.height = dH;
  canvasAfter.width  = dW;  canvasAfter.height  = dH;

  ctxBefore.drawImage(img, 0, 0, dW, dH);
  computeAutoCorr(ctxBefore.getImageData(0, 0, dW, dH));

  if (state.faceApiLoaded) {
    setProc('얼굴 감지 중...');
    try {
      state.faceDetections = await faceapi
        .detectAllFaces(canvasBefore, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.4 }))
        .withFaceLandmarks();
      const n = state.faceDetections.length;
      faceStatusEl.textContent = n > 0 ? `얼굴 ${n}명 감지 ✓` : '얼굴 미감지 — 색조 기반 보정 적용';
      faceStatusEl.classList.toggle('detected', n > 0);
    } catch {
      state.faceDetections = [];
      faceStatusEl.textContent = '얼굴 감지 실패 — 색조 기반 보정 적용';
    }
  } else {
    faceStatusEl.textContent = '피부 색조 기반 자동 보정';
  }

  setProc('자동 보정 적용 중...');
  applyProcessing();
  hideProc();
  initSlider();
}

// ── Auto Correction (compute once from display canvas) ────────
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
  state.autoCorr.levels = [
    [pct(hR, clip), pct(hR, n - clip)],
    [pct(hG, clip), pct(hG, n - clip)],
    [pct(hB, clip), pct(hB, n - clip)],
  ];

  const avg = (rS + gS + bS) / (3 * n);
  state.autoCorr.wb = [avg / (rS / n), avg / (gS / n), avg / (bS / n)];
}

// ── Main Processing Pipeline ──────────────────────────────────
function applyProcessing() {
  const { displayW: W, displayH: H } = state;
  const id = ctxBefore.getImageData(0, 0, W, H);
  const d  = id.data;

  applyAutoLevels(d);
  applyWhiteBalance(d);
  applyBCS(d, state.params.brightness, state.params.contrast, state.params.saturation);

  ctxAfter.putImageData(id, 0, 0);

  if (state.params.sharpness > 0) unsharpMask(ctxAfter, W, H, state.params.sharpness / 100);
  if (state.params.skinSmooth > 0) skinSmooth(ctxAfter, W, H, state.params.skinSmooth / 100, state.faceDetections);

  updateClip();
}

function applyAutoLevels(d) {
  const lv = state.autoCorr.levels;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const [lo, hi] = lv[c];
      const rng = hi - lo;
      if (rng > 0) d[i+c] = clamp(Math.round(((d[i+c] - lo) / rng) * 255));
    }
  }
}

function applyWhiteBalance(d) {
  const [rS, gS, bS] = state.autoCorr.wb;
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

// ── Sharpening (unsharp mask) ─────────────────────────────────
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
  if (detections.length > 0) {
    faceSmooth(ctx, W, H, amount, detections);
  } else {
    skinToneSmooth(ctx, W, H, amount * 0.4);
  }
}

function faceSmooth(ctx, W, H, amount, detections) {
  const orig = ctx.getImageData(0, 0, W, H);
  const blur = new ImageData(new Uint8ClampedArray(orig.data), W, H);
  const r = Math.max(2, Math.round(amount * 5));
  boxBlur(blur, r); boxBlur(blur, r); boxBlur(blur, r);

  // Build mask via offscreen canvas
  const mc = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const mx = mc.getContext('2d');
  mx.fillStyle = '#000';
  mx.fillRect(0, 0, W, H);

  for (const det of detections) {
    const pts = det.landmarks.positions;
    // Fill face polygon (jaw 0-16)
    mx.fillStyle = '#fff';
    mx.beginPath();
    mx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= 16; i++) mx.lineTo(pts[i].x, pts[i].y);
    // Close over forehead
    mx.lineTo(pts[26].x, pts[26].y - 25);
    mx.lineTo(pts[17].x, pts[17].y - 25);
    mx.closePath();
    mx.fill();

    // Erase eyes, eyebrows, lips
    mx.fillStyle = '#000';
    eraseRegion(mx, pts.slice(17, 22)); // left brow
    eraseRegion(mx, pts.slice(22, 27)); // right brow
    eraseRegion(mx, pts.slice(36, 42)); // left eye  (expanded)
    eraseRegion(mx, pts.slice(42, 48)); // right eye
    eraseRegion(mx, pts.slice(48, 68)); // lips
  }

  // Feather mask
  const mid = mx.getImageData(0, 0, W, H);
  boxBlur(mid, 10); boxBlur(mid, 10);
  mx.putImageData(mid, 0, 0);

  const mask = mx.getImageData(0, 0, W, H).data;
  const d = orig.data, b = blur.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = (mask[i] / 255) * amount;
    d[i]   = d[i]   * (1 - a) + b[i]   * a;
    d[i+1] = d[i+1] * (1 - a) + b[i+1] * a;
    d[i+2] = d[i+2] * (1 - a) + b[i+2] * a;
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

// ── Box Blur (separable, in-place) ────────────────────────────
function boxBlur(imageData, radius) {
  const { data: d, width: W, height: H } = imageData;
  const tmp = new Uint8ClampedArray(d);

  // Horizontal
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.max(0, Math.min(W - 1, x + dx));
        const k = (y * W + nx) * 4;
        r += tmp[k]; g += tmp[k+1]; b += tmp[k+2]; n++;
      }
      const k = (y * W + x) * 4;
      d[k] = r/n; d[k+1] = g/n; d[k+2] = b/n;
    }
  }
  tmp.set(d);

  // Vertical
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.max(0, Math.min(H - 1, y + dy));
        const k = (ny * W + x) * 4;
        r += tmp[k]; g += tmp[k+1]; b += tmp[k+2]; n++;
      }
      const k = (y * W + x) * 4;
      d[k] = r/n; d[k+1] = g/n; d[k+2] = b/n;
    }
  }
}

// ── Comparison Slider ─────────────────────────────────────────
function initSlider() {
  updateClip();
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
}

function updateClip() {
  const p = state.sliderPos;
  canvasAfter.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`;
  cmpSlider.style.left = `${p * 100}%`;
}

// ── Controls ──────────────────────────────────────────────────
const PARAM_MAP = {
  'brightness': 'brightness',
  'contrast':   'contrast',
  'saturation': 'saturation',
  'sharpness':  'sharpness',
  'skin-smooth': 'skinSmooth',
};

let debounce = null;
for (const id of Object.keys(PARAM_MAP)) {
  const input = $(id);
  const valEl = $(`${id}-val`);
  input.addEventListener('input', () => {
    valEl.textContent = input.value;
    state.params[PARAM_MAP[id]] = +input.value;
    clearTimeout(debounce);
    debounce = setTimeout(applyProcessing, 80);
  });
}

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedSize = btn.dataset.size;
  });
});

$('quality').addEventListener('input', function () {
  $('quality-val').textContent = `${this.value}%`;
});

// ── Export ────────────────────────────────────────────────────
downloadBtn.addEventListener('click', exportImage);

async function exportImage() {
  downloadBtn.disabled = true;
  downloadBtn.textContent = '처리 중...';
  showProc('고화질로 처리 중...');
  await tick();

  const img = state.originalImage;
  const oW = img.naturalWidth, oH = img.naturalHeight;

  const fc = Object.assign(document.createElement('canvas'), { width: oW, height: oH });
  const fx = fc.getContext('2d');
  fx.drawImage(img, 0, 0, oW, oH);

  // Recompute auto correction at full resolution
  const saved = { ...state.autoCorr };
  computeAutoCorr(fx.getImageData(0, 0, oW, oH));

  const id = fx.getImageData(0, 0, oW, oH);
  const d  = id.data;
  applyAutoLevels(d);
  applyWhiteBalance(d);
  applyBCS(d, state.params.brightness, state.params.contrast, state.params.saturation);
  fx.putImageData(id, 0, 0);

  if (state.params.sharpness > 0) unsharpMask(fx, oW, oH, state.params.sharpness / 100);

  if (state.params.skinSmooth > 0) {
    if (state.faceDetections.length > 0) {
      const sx = oW / state.displayW, sy = oH / state.displayH;
      const scaled = state.faceDetections.map(det => ({
        ...det,
        landmarks: {
          positions: det.landmarks.positions.map(p => ({ x: p.x * sx, y: p.y * sy })),
        },
      }));
      faceSmooth(fx, oW, oH, state.params.skinSmooth / 100, scaled);
    } else {
      skinToneSmooth(fx, oW, oH, (state.params.skinSmooth / 100) * 0.4);
    }
  }

  state.autoCorr = saved;

  // Resize for print
  const size = PRINT_SIZES[state.selectedSize];
  const out  = size ? resizeForPrint(fc, size.w, size.h) : fc;

  const fmt  = $('format-select').value;
  const qual = +$('quality').value / 100;
  const url  = out.toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', qual);

  const a = document.createElement('a');
  a.href = url;
  a.download = `retouched_${state.selectedSize}.${fmt === 'png' ? 'png' : 'jpg'}`;
  a.click();

  hideProc();
  downloadBtn.disabled = false;
  downloadBtn.textContent = '다운로드';
}

function resizeForPrint(canvas, tW, tH) {
  const sAR = canvas.width / canvas.height;
  const tAR = tW / tH;
  let sx = 0, sy = 0, sw = canvas.width, sh = canvas.height;
  if (sAR > tAR) { sw = sh * tAR; sx = (canvas.width - sw) / 2; }
  else           { sh = sw / tAR; sy = (canvas.height - sh) / 2; }
  const out = Object.assign(document.createElement('canvas'), { width: tW, height: tH });
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, tW, tH);
  return out;
}

// ── Utilities ─────────────────────────────────────────────────
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
const tick  = () => new Promise(r => setTimeout(r, 30));

function showProc(msg) { procText.textContent = msg; procOverlay.classList.remove('hidden'); }
function setProc(msg)  { procText.textContent = msg; }
function hideProc()    { procOverlay.classList.add('hidden'); }

// ── Boot ──────────────────────────────────────────────────────
loadFaceApi();
