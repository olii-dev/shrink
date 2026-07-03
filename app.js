'use strict';

// ---- Element refs ----
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const config = $('config');
const previewVideo = $('previewVideo');
const fileName = $('fileName');
const fileSize = $('fileSize');
const fileDuration = $('fileDuration');
const fileRes = $('fileRes');
const targetSize = $('targetSize');
const sizePresets = $('sizePresets');
const resolution = $('resolution');
const compressBtn = $('compressBtn');
const progress = $('progress');
const progressLabel = $('progressLabel');
const progressPct = $('progressPct');
const progressFill = $('progressFill');
const progressDetail = $('progressDetail');
const result = $('result');
const beforeSize = $('beforeSize');
const afterSize = $('afterSize');
const savedPct = $('savedPct');
const resultVideo = $('resultVideo');
const downloadBtn = $('downloadBtn');
const resetBtn = $('resetBtn');

// ---- State ----
let currentFile = null;
let currentMeta = null;       // { duration, width, height }
let ffmpegInstance = null;
let ffmpegReady = false;
let resultBlobUrl = null;
let resultFileName = 'compressed.mp4';

// ---- Helpers ----
const fmtBytes = (b) => {
  if (b === 0 || b == null) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(i >= 2 ? 2 : 1)} ${units[i]}`;
};

const fmtTime = (s) => {
  if (!isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const ext = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : 'mp4';
};

const setProgress = (label, pct, detail = '') => {
  progressLabel.textContent = label;
  progressFill.style.width = `${Math.round(pct)}%`;
  progressPct.textContent = `${Math.round(pct)}%`;
  if (detail) progressDetail.textContent = detail;
};

// ---- ffmpeg.wasm loader (lazy, with progress on first load) ----
//
// Three reliability fixes vs. the naive setup:
//  1. `classWorkerURL` is passed as a blob URL so the worker spawns same-origin
//     — otherwise the browser silently blocks the cross-origin CDN worker and
//     load() hangs forever with no error.
//  2. jsDelivr instead of unpkg (better uptime + edge caching).
//  3. 60s timeout + explicit error handling so it can never hang silently.
const FFMPEG_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd';
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

async function fetchWithTimeout(url, ms, onProgress) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function getFFmpeg(onLog) {
  if (ffmpegReady) return ffmpegInstance;

  if (!window.FFmpegWASM || !window.FFmpegUtil) {
    throw new Error('ffmpeg libraries failed to load. Check your connection and refresh.');
  }
  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL } = window.FFmpegUtil;

  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));

  setProgress('Loading compression engine…', 10, 'Fetching ffmpeg core (~30 MB, cached after first run)');

  // Fetch each asset as a same-origin blob URL. This is the key fix:
  // Workers and WASM loaded from blob: URLs are same-origin, so the browser
  // won't block them with a silent cross-origin error.
  const [coreURL, wasmURL, workerURL] = await Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    // 814.ffmpeg.js is the actual worker bundle for the UMD build
    toBlobURL(`${FFMPEG_BASE}/814.ffmpeg.js`, 'text/javascript'),
  ]);

  setProgress('Starting engine…', 25, '');

  // load() resolves when the worker reports it's ready. Give it a hard timeout
  // so we never hang forever if something goes wrong inside the worker.
  await Promise.race([
    ffmpeg.load({ coreURL, wasmURL, classWorkerURL: workerURL }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Engine failed to start within 60s. Refresh and try again.')), 60000),
    ),
  ]);

  ffmpegInstance = ffmpeg;
  ffmpegReady = true;
  return ffmpeg;
}

// ---- Read video metadata via a hidden <video> element ----
function readMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const meta = {
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read video metadata. The file may be unsupported.'));
    };
  });
}

// ---- File selection ----
async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi|m4v|wmv|flv|ts|3gp)$/i.test(file.name)) {
    alert('Please choose a video file.');
    return;
  }

  currentFile = file;
  result.classList.add('hidden');
  progress.classList.add('hidden');

  fileName.textContent = file.name;
  fileSize.textContent = fmtBytes(file.size);

  // Show preview + read metadata
  previewVideo.src = URL.createObjectURL(file);
  try {
    currentMeta = await readMeta(file);
    fileDuration.textContent = fmtTime(currentMeta.duration);
    fileRes.textContent = currentMeta.width ? `${currentMeta.width}×${currentMeta.height}` : '—';
  } catch (e) {
    currentMeta = { duration: 0, width: 0, height: 0 };
    fileDuration.textContent = '?';
    fileRes.textContent = '?';
  }

  config.classList.remove('hidden');
  config.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Drag & drop ----
['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }),
);
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files?.[0]) handleFile(e.target.files[0]);
});

// ---- Size presets ----
sizePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-size]');
  if (!btn) return;
  targetSize.value = btn.dataset.size;
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
});
targetSize.addEventListener('input', () => {
  sizePresets.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.size === targetSize.value);
  });
});

// ---- Core compression ----
async function compress() {
  if (!currentFile) return;

  const targetMB = parseFloat(targetSize.value);
  if (!targetMB || targetMB <= 0) {
    alert('Enter a valid target size.');
    return;
  }
  const maxH = parseInt(resolution.value, 10);

  // UI: show progress, hide config
  config.classList.add('hidden');
  result.classList.add('hidden');
  progress.classList.remove('hidden');
  setProgress('Preparing…', 2, '');

  compressBtn.disabled = true;

  // If file is already under target, fast-path: pass-through copy.
  if (currentFile.size <= targetMB * 1024 * 1024) {
    resultBlobUrl = URL.createObjectURL(currentFile);
    resultFileName = currentFile.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';
    showResult(currentFile.size, currentFile.size);
    setProgress('Already small enough!', 100, 'Input was under the target — no recompression needed.');
    return;
  }

  const duration = currentMeta?.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    alert('Could not determine video duration. The file may be corrupted or unsupported.');
    resetUI();
    return;
  }

  let logBuf = '';
  const onLog = (msg) => {
    logBuf = msg; // keep last line
  };

  try {
    const ffmpeg = await getFFmpeg(onLog);

    // ---- Compute target bitrate ----
    // Total bits available = targetBytes * 8, minus ~2% container overhead.
    const targetBytes = targetMB * 1024 * 1024;
    const targetBits = targetBytes * 8 * 0.98;
    // Audio bitrate: 128k when there's room, 96k when target is tight.
    const audioBitrate = targetMB >= 10 ? '128k' : '96k';
    const audioBits = (parseInt(audioBitrate, 10) * 1000) * duration;
    let videoBitrate = Math.floor((targetBits - audioBits) / duration);

    if (videoBitrate < 50_000) {
      // Impossibly low — clamp and warn. Output will still be created; quality just degrades.
      videoBitrate = 50_000;
      progressDetail.textContent = '⚠ Target is very tight for this duration — quality will be low.';
    }
    const videoK = Math.max(40, Math.round(videoBitrate / 1000));

    // ---- Build filter chain (resolution + faststart) ----
    const inName = `input.${ext(currentFile.name)}`;
    const outName = 'output.mp4';

    const filters = [];
    if (maxH > 0 && currentMeta?.height && currentMeta.height > maxH) {
      // Scale down keeping aspect; -2 keeps dimensions even (required by most encoders).
      filters.push(`scale=-2:${maxH}`);
    }

    const writePct = 4;
    setProgress('Reading file…', writePct, '');
    await ffmpeg.writeFile(inName, await FFmpegUtil.fetchFile(currentFile));

    const commonArgs = [
      '-i', inName,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-pix_fmt', 'yuv420p',
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-movflags', '+faststart',
      '-y',
    ];

    // ---- Two-pass for accurate size targeting ----
    // Pass 1 weight: 0..20% (analysis is fast). Pass 2 weight: 20..100%.
    const pass1Weight = 0.2;

    const onPass = (passStart, passWeight) => ({ progress }) => {
      const p = Math.max(0, Math.min(1, progress));
      setProgress(
        passStart === 0 ? 'Analyzing (pass 1 of 2)…' : 'Encoding (pass 2 of 2)…',
        (passStart + p * passWeight) * 100,
        logBuf,
      );
    };

    // Pass 1
    const p1 = onPass(0, pass1Weight);
    const h1 = ffmpeg.on('progress', p1);
    await ffmpeg.exec([
      ...commonArgs,
      '-pass', '1',
      '-an',
      '-f', 'null',
      '/dev/null',
    ]);
    ffmpeg.off('progress', p1);

    // Pass 2
    const p2 = onPass(pass1Weight, 1 - pass1Weight);
    const h2 = ffmpeg.on('progress', p2);
    await ffmpeg.exec([
      ...commonArgs,
      '-pass', '2',
      '-b:v', `${videoK}k`,
      '-maxrate', `${Math.round(videoK * 1.45)}k`,
      '-bufsize', `${videoK * 2}k`,
      outName,
    ]);
    ffmpeg.off('progress', p2);

    // ---- Read output ----
    setProgress('Finalizing…', 99, '');
    const data = await ffmpeg.readFile(outName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });

    // Cleanup ffmpeg FS for next run
    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
      await ffmpeg.deleteFile('ffmpeg2pass-0.log');
      await ffmpeg.deleteFile('ffmpeg2pass-0.log.mbtree');
    } catch { /* ignore */ }

    resultBlobUrl = URL.createObjectURL(blob);
    const baseName = currentFile.name.replace(/\.[^.]+$/, '');
    resultFileName = `${baseName}_shrink.mp4`;

    setProgress('Done', 100, '');
    showResult(currentFile.size, blob.size);
  } catch (err) {
    console.error(err);
    alert(`Compression failed: ${err.message || err}\n\nThe video format may be unsupported by the in-browser encoder.`);
    resetUI();
  }
}

function showResult(before, after) {
  progress.classList.add('hidden');
  result.classList.remove('hidden');

  beforeSize.textContent = fmtBytes(before);
  afterSize.textContent = fmtBytes(after);
  const saved = before > 0 ? Math.max(0, (1 - after / before) * 100) : 0;
  savedPct.textContent = `${saved.toFixed(0)}%`;

  resultVideo.src = resultBlobUrl;
  downloadBtn.href = resultBlobUrl;
  downloadBtn.download = resultFileName;
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetUI() {
  progress.classList.add('hidden');
  result.classList.add('hidden');
  if (currentFile) config.classList.remove('hidden');
  compressBtn.disabled = false;
}

compressBtn.addEventListener('click', compress);

// ---- Reset / new video ----
resetBtn.addEventListener('click', () => {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  result.classList.add('hidden');
  config.classList.remove('hidden');
  compressBtn.disabled = false;
});

downloadBtn.addEventListener('click', () => {
  // Anchor download — browser handles the file save.
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = resultFileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
