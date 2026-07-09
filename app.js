'use strict';

/* =========================================================================
 * Shrink — Video compressor targeting a file size
 *
 * Engine: ffmpeg.wasm, loaded from LOCAL same-origin files in /lib.
 *   - No CDN → no cross-origin worker blocks, no WASM import failures.
 *   - Full codec/container support: MP4, MOV, MKV, WebM, AVI, …
 *   - Audio preserved (re-encoded to AAC).
 *
 * Size targeting: two-pass H.264 encoding at a bitrate computed from
 *   duration × target size. Lands within ~2% of the requested size.
 * ========================================================================= */

// Capture alerts for testing (so headless tests can read error messages)
const _origAlert = window.alert;
window.alert = (msg) => {
  window.__lastAlert = msg;
  _origAlert.call(window, msg);
};

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
const customResolutionWrap = $('customResolutionWrap');
const customResolution = $('customResolution');
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
let currentMeta = null; // { duration, width, height }
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
  progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  progressPct.textContent = `${Math.round(pct)}%`;
  if (detail) progressDetail.textContent = detail;
};

// ---- ffmpeg.wasm loader (LOCAL multi-threaded core) ----
//
// Uses @ffmpeg/core-mt (multi-threaded) which spreads encoding across CPU
// cores via SharedArrayBuffer + pthreads — ~2-4x faster than single-threaded.
//
// Requires cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer.
// On GitHub Pages we get these via coi-serviceworker.js (see index.html),
// which injects the headers client-side. The catch: the service worker only
// activates AFTER a one-time page reload, so on the very first load
// `crossOriginIsolated` is false. We guard against that and tell the user to
// wait for the reload rather than crashing with a cryptic error.
//
// We deliberately do NOT pass `classWorkerURL`: when omitted, ffmpeg.js
// auto-detects publicPath from our <script src="lib/ffmpeg.js"> tag → correct
// wrapper-worker URL. Passing it would resolve against a hardcoded build
// path and throw a Security Error.
async function getFFmpeg(onLog) {
  if (ffmpegReady) return ffmpegInstance;

  // Multi-threaded core needs SharedArrayBuffer, which needs cross-origin
  // isolation. On first load (before coi-serviceworker reloads the page)
  // this is false — bail with a clear message.
  if (!self.crossOriginIsolated) {
    throw new Error(
      'Multi-threading is still activating. The page should reload shortly to ' +
        'enable it — if it does not, refresh manually and try again.',
    );
  }

  if (!window.FFmpegWASM || !window.FFmpegUtil) {
    throw new Error('ffmpeg libraries failed to load. Refresh the page.');
  }
  const { FFmpeg } = window.FFmpegWASM;

  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));

  setProgress('Starting engine…', 12, 'Loading multi-threaded ffmpeg core');

  // Resolve to ABSOLUTE URLs (relative to the page, not the worker).
  // The core does `importScripts(coreURL)` from inside the worker, where
  // relative paths resolve against the WORKER's URL — absolute avoids that.
  // workerURL is the new core-mt pthread worker (ffmpeg-core.worker.js).
  await ffmpeg.load({
    coreURL: new URL('lib/ffmpeg-core.js', document.baseURI).href,
    wasmURL: new URL('lib/ffmpeg-core.wasm', document.baseURI).href,
    workerURL: new URL('lib/ffmpeg-core.worker.js', document.baseURI).href,
  });

  ffmpegInstance = ffmpeg;
  ffmpegReady = true;
  return ffmpeg;
}

// ---- Read video metadata ----
function readMeta(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => {
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read video metadata.'));
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

  previewVideo.src = URL.createObjectURL(file);
  try {
    currentMeta = await readMeta(file);
    fileDuration.textContent = fmtTime(currentMeta.duration);
    fileRes.textContent = currentMeta.width ? `${currentMeta.width}×${currentMeta.height}` : '—';
  } catch {
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
dropzone.addEventListener('drop', (e) => e.dataTransfer?.files?.[0] && handleFile(e.dataTransfer.files[0]));
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', (e) => e.target.files?.[0] && handleFile(e.target.files[0]));

// ---- Size presets ----
sizePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-size]');
  if (!btn) return;
  targetSize.value = btn.dataset.size;
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
});
targetSize.addEventListener('input', () => {
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.size === targetSize.value));
});

// Show/hide the custom resolution input when "Custom…" is selected
resolution.addEventListener('change', () => {
  const isCustom = resolution.value === 'custom';
  customResolutionWrap.classList.toggle('hidden', !isCustom);
  if (isCustom) customResolution.focus();
});

// Resolve the chosen max height, honouring the custom input.
// Returns 0 for "keep original", or a clamped even number >= 2.
function getResolutionHeight() {
  if (resolution.value === 'custom') {
    let h = parseInt(customResolution.value, 10);
    if (!h || h < 2) h = 2;          // floor: H.264 yuv420p needs height >= 2
    if (h > 4320) h = 4320;          // cap at 8K to keep it sane
    return h;
  }
  return parseInt(resolution.value, 10);
}

// =========================================================================
//  CORE: compress via ffmpeg.wasm two-pass encoding
// =========================================================================
async function compress() {
  if (!currentFile) return;

  const targetMB = parseFloat(targetSize.value);
  if (!targetMB || targetMB <= 0) {
    alert('Enter a valid target size.');
    return;
  }
  const maxH = getResolutionHeight();

  // Fast path: already under target
  if (currentFile.size <= targetMB * 1024 * 1024) {
    resultBlobUrl = URL.createObjectURL(currentFile);
    resultFileName = currentFile.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';
    progress.classList.remove('hidden');
    config.classList.add('hidden');
    setProgress('Already small enough!', 100, 'Input was under the target — no recompression needed.');
    showResult(currentFile.size, currentFile.size);
    return;
  }

  const duration = currentMeta?.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    alert('Could not determine video duration. The file may be corrupted.');
    return;
  }

  config.classList.add('hidden');
  result.classList.add('hidden');
  progress.classList.remove('hidden');
  compressBtn.disabled = true;
  setProgress('Preparing…', 2, '');

  let lastLog = '';
  const onLog = (msg) => (lastLog = msg);

  try {
    const ffmpeg = await getFFmpeg(onLog);

    // ---- Compute target bitrate ----
    // total bits available, minus ~2% container overhead
    const targetBytes = targetMB * 1024 * 1024;
    const targetBits = targetBytes * 8 * 0.98;
    // Audio: AAC. 128k when there's room, 96k when tight.
    const audioBitrate = targetMB >= 10 ? '128k' : '96k';
    const audioBits = parseInt(audioBitrate, 10) * 1000 * duration;
    let videoBitrate = Math.floor((targetBits - audioBits) / duration);

    if (videoBitrate < 50_000) {
      videoBitrate = 50_000;
      setProgress('Preparing…', 4, '⚠ Target is very tight for this duration — quality will be low.');
    }
    const videoK = Math.max(40, Math.round(videoBitrate / 1000));

    // ---- Write input file ----
    const inName = `input.${ext(currentFile.name)}`;
    const outName = 'output.mp4';

    setProgress('Reading file…', 8, '');
    await ffmpeg.writeFile(inName, await window.FFmpegUtil.fetchFile(currentFile));

    // ---- Common args: H.264 video + AAC audio (preserved), MP4 output ----
    const filters = [];
    if (maxH > 0 && currentMeta?.height && currentMeta.height > maxH) {
      filters.push(`scale=-2:${maxH}`); // -2 keeps even dimensions
    }

    const commonArgs = [
      '-i', inName,
      '-c:v', 'libx264',
      '-preset', 'veryfast', // ~3x faster than 'medium', negligible quality drop at bitrate-constrained targets
      '-pix_fmt', 'yuv420p',
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      '-c:a', 'aac',       // ← audio preserved, re-encoded to AAC
      '-b:a', audioBitrate,
      '-threads', '0',     // auto-use all available CPU cores (multi-threaded core)
      '-movflags', '+faststart',
      '-y',
    ];

    // ---- Friendly progress detail parser ----
    // ffmpeg's raw log lines look like 'frame= 238 fps= 16 q=31.0 size=N/A ...'.
    // We pull out the bits a user actually cares about and format them nicely.
    const parseLog = (raw) => {
      if (!raw) return '';
      const get = (key) => {
        const m = new RegExp(`${key}=\\s*([0-9.]+)`).exec(raw);
        return m ? m[1] : null;
      };
      const fps = get('fps');
      const speed = get('speed');
      if (fps && speed) {
        const speedNum = parseFloat(speed);
        // ffmpeg reports speed as e.g. "0.214x" or "1x"
        const realtime = speedNum >= 1 ? 'faster than realtime' : `${(1 / speedNum).toFixed(1)}× slower than realtime`;
        return `${fps} fps · ${realtime}`;
      }
      return '';
    };

    // ---- Progress plumbing for two passes ----
    // Pass 1 (analysis) is fast → weight 0..22%. Pass 2 (encode) → 22..98%.
    const pass1End = 0.22;
    const makeHandler = (start, weight) => ({ progress }) => {
      const p = Math.max(0, Math.min(1, progress));
      setProgress(
        start === 0 ? 'Analysing (pass 1 of 2)…' : 'Encoding (pass 2 of 2)…',
        (start + p * weight) * 100,
        parseLog(lastLog),
      );
    };

    // ---- Pass 1: analysis ----
    const p1 = makeHandler(0, pass1End);
    ffmpeg.on('progress', p1);
    await ffmpeg.exec([
      ...commonArgs,
      '-pass', '1',
      '-an',
      '-f', 'null',
      '-',
    ]);
    ffmpeg.off('progress', p1);

    // ---- Pass 2: actual encode at computed bitrate ----
    const p2 = makeHandler(pass1End, 0.98 - pass1End);
    ffmpeg.on('progress', p2);
    await ffmpeg.exec([
      ...commonArgs,
      '-pass', '2',
      '-b:v', `${videoK}k`,
      '-maxrate', `${Math.round(videoK * 1.45)}k`,
      '-bufsize', `${videoK * 2}k`,
      outName,
    ]);
    ffmpeg.off('progress', p2);

    // ---- Read output + cleanup ----
    setProgress('Finalizing…', 99, '');
    const data = await ffmpeg.readFile(outName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });

    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
      await ffmpeg.deleteFile('ffmpeg2pass-0.log');
      await ffmpeg.deleteFile('ffmpeg2pass-0.log.mbtree');
    } catch { /* ignore */ }

    resultBlobUrl = URL.createObjectURL(blob);
    resultFileName = currentFile.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';

    setProgress('Done', 100, '');
    showResult(currentFile.size, blob.size);
  } catch (err) {
    console.error(err);
    alert(`Compression failed: ${err.message || err}\n\nThe video format may be unsupported.`);
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
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = resultFileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
});
