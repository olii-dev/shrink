'use strict';

/* =========================================================================
 * Shrink — Multi-file video compressor targeting a file size
 *
 * Architecture: a queue of files, processed sequentially through one shared
 * ffmpeg.wasm engine. Each file gets its own status row in the UI with
 * live progress, then a download button on completion.
 *
 * Size targeting: two-pass H.264 encoding at a bitrate computed from
 *   duration × target size. Lands within ~2% of the requested size.
 * ========================================================================= */

// Capture alerts for testing
const _origAlert = window.alert;
window.alert = (msg) => {
  window.__lastAlert = msg;
  _origAlert.call(window, msg);
};

// ---- Element refs ----
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const addMoreBtn = $('addMoreBtn');
const queueSection = $('queueSection');
const queueList = $('queueList');
const queueCount = $('queueCount');
const targetSize = $('targetSize');
const sizePresets = $('sizePresets');
const resolution = $('resolution');
const customResolutionWrap = $('customResolutionWrap');
const customResolution = $('customResolution');
const compressAllBtn = $('compressAllBtn');
const batchProgress = $('batchProgress');
const batchLabel = $('batchLabel');
const batchPct = $('batchPct');
const batchFill = $('batchFill');
const batchDetail = $('batchDetail');
const downloadAllBtn = $('downloadAllBtn');

// ---- State ----
const queue = []; // [{ id, file, meta, status, progress, resultUrl, resultName, resultSize, error }]
let nextId = 1;
let ffmpegInstance = null;
let ffmpegReady = false;
let isProcessing = false;

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

const setBatchProgress = (label, pct, detail = '') => {
  batchLabel.textContent = label;
  batchFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  batchPct.textContent = `${Math.round(pct)}%`;
  if (detail) batchDetail.textContent = detail;
};

// ---- ffmpeg.wasm loader (LOCAL single-threaded core) ----
async function getFFmpeg(onLog) {
  if (ffmpegReady) return ffmpegInstance;
  if (!window.FFmpegWASM || !window.FFmpegUtil) {
    throw new Error('ffmpeg libraries failed to load. Refresh the page.');
  }
  const { FFmpeg } = window.FFmpegWASM;
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));
  setBatchProgress('Starting engine…', 2, 'Loading ffmpeg core');
  await ffmpeg.load({
    coreURL: new URL('lib/ffmpeg-core.js', document.baseURI).href,
    wasmURL: new URL('lib/ffmpeg-core.wasm', document.baseURI).href,
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

// ---- Resolution helper ----
function getResolutionHeight() {
  if (resolution.value === 'custom') {
    let h = parseInt(customResolution.value, 10);
    if (!h || h < 2) h = 2;
    if (h > 4320) h = 4320;
    return h;
  }
  return parseInt(resolution.value, 10);
}

// ---- Friendly ffmpeg log parser ----
const parseLog = (raw) => {
  if (!raw) return '';
  const get = (key) => {
    const m = new RegExp(`${key}=\\s*([0-9.]+)`).exec(raw);
    return m ? m[1] : null;
  };
  const fps = get('fps');
  const speed = get('speed');
  if (fps && speed) {
    const n = parseFloat(speed);
    const rt = n >= 1 ? 'faster than realtime' : `${(1 / n).toFixed(1)}× slower than realtime`;
    return `${fps} fps · ${rt}`;
  }
  return '';
};

// =========================================================================
//  QUEUE MANAGEMENT
// =========================================================================

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi|m4v|wmv|flv|ts|3gp)$/i.test(file.name)) {
      continue;
    }
    const item = {
      id: nextId++,
      file,
      meta: null,
      status: 'queued', // queued | processing | done | error | skipped
      progress: 0,
      resultUrl: null,
      resultName: null,
      resultSize: 0,
      error: null,
    };
    queue.push(item);
    renderQueueItem(item);
    // Read metadata async (don't block — fills in as it arrives)
    try {
      item.meta = await readMeta(file);
    } catch {
      item.meta = { duration: 0, width: 0, height: 0 };
    }
    updateQueueItemRow(item);
  }
  updateQueueVisibility();
  updateQueueCount();
}

function renderQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.dataset.id = item.id;
  li.innerHTML = `
    <div class="qi-thumb"><span>🎬</span></div>
    <div class="qi-info">
      <div class="qi-name"></div>
      <div class="qi-meta"></div>
      <div class="qi-progress-wrap hidden"><div class="qi-progress-bar"><div class="qi-progress-fill"></div></div></div>
      <div class="qi-status"></div>
    </div>
    <div class="qi-actions"></div>
  `;
  queueList.appendChild(li);
  updateQueueItemRow(item);
}

function updateQueueItemRow(item) {
  const li = queueList.querySelector(`[data-id="${item.id}"]`);
  if (!li) return;

  const nameEl = li.querySelector('.qi-name');
  const metaEl = li.querySelector('.qi-meta');
  const statusEl = li.querySelector('.qi-status');
  const actionsEl = li.querySelector('.qi-actions');
  const progWrap = li.querySelector('.qi-progress-wrap');
  const progFill = li.querySelector('.qi-progress-fill');

  nameEl.textContent = item.file.name;

  const sizeStr = fmtBytes(item.file.size);
  const metaParts = [sizeStr];
  if (item.meta?.duration) metaParts.push(fmtTime(item.meta.duration));
  if (item.meta?.width) metaParts.push(`${item.meta.width}×${item.meta.height}`);
  metaEl.textContent = metaParts.join(' · ');

  // Status + actions by state
  li.className = `queue-item status-${item.status}`;
  statusEl.className = 'qi-status';
  actionsEl.innerHTML = '';

  switch (item.status) {
    case 'queued':
      statusEl.textContent = '';
      if (!isProcessing) {
        const rm = document.createElement('button');
        rm.className = 'qi-remove-btn';
        rm.textContent = '✕';
        rm.title = 'Remove';
        rm.onclick = () => removeFromQueue(item.id);
        actionsEl.appendChild(rm);
      }
      break;
    case 'processing':
      statusEl.textContent = item.progressDetail || 'Processing…';
      progWrap.classList.remove('hidden');
      progFill.style.width = `${item.progress}%`;
      break;
    case 'done': {
      progWrap.classList.add('hidden');
      const saved = item.file.size > 0 ? Math.max(0, (1 - item.resultSize / item.file.size) * 100) : 0;
      statusEl.innerHTML = `<span class="qi-result">✓ ${fmtBytes(item.resultSize)} <span class="qi-saved">(${saved.toFixed(0)}% smaller)</span></span>`;
      const dl = document.createElement('button');
      dl.className = 'qi-download-btn';
      dl.textContent = '⬇';
      dl.title = `Download ${item.resultName}`;
      dl.onclick = () => downloadBlob(item.resultUrl, item.resultName);
      actionsEl.appendChild(dl);
      break;
    }
    case 'error':
      progWrap.classList.add('hidden');
      statusEl.innerHTML = `<span class="qi-error">✗ ${item.error || 'Failed'}</span>`;
      break;
    case 'skipped':
      progWrap.classList.add('hidden');
      statusEl.innerHTML = `<span class="qi-skipped">✓ Already under target</span>`;
      const dl2 = document.createElement('button');
      dl2.className = 'qi-download-btn';
      dl2.textContent = '⬇';
      dl2.title = `Download ${item.resultName}`;
      dl2.onclick = () => downloadBlob(item.resultUrl, item.resultName);
      actionsEl.appendChild(dl2);
      break;
  }
}

function removeFromQueue(id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0 || isProcessing) return;
  queue.splice(idx, 1);
  queueList.querySelector(`[data-id="${id}"]`)?.remove();
  updateQueueVisibility();
  updateQueueCount();
}

function updateQueueVisibility() {
  const hasItems = queue.length > 0;
  queueSection.classList.toggle('hidden', !hasItems);
  dropzone.classList.toggle('hidden', hasItems && isProcessing);
}

function updateQueueCount() {
  const done = queue.filter((q) => q.status === 'done' || q.status === 'skipped').length;
  queueCount.textContent = queue.length === 0 ? '0' : `${done}/${queue.length}`;
}

function downloadBlob(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// =========================================================================
//  CORE: compress a single file (extracted from the original single-file flow)
// =========================================================================

async function compressOne(item, targetMB, maxH, onProgress) {
  const ffmpeg = ffmpegInstance;

  // Fast path: already under target
  if (item.file.size <= targetMB * 1024 * 1024) {
    item.resultUrl = URL.createObjectURL(item.file);
    item.resultName = item.file.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';
    item.resultSize = item.file.size;
    return { skipped: true };
  }

  const duration = item.meta?.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine video duration.');
  }

  // Compute target bitrate
  const targetBytes = targetMB * 1024 * 1024;
  const targetBits = targetBytes * 8 * 0.98;
  const audioBitrate = targetMB >= 10 ? '128k' : '96k';
  const audioBits = parseInt(audioBitrate, 10) * 1000 * duration;
  let videoBitrate = Math.floor((targetBits - audioBits) / duration);
  if (videoBitrate < 50_000) videoBitrate = 50_000;
  const videoK = Math.max(40, Math.round(videoBitrate / 1000));

  const inName = `input.${ext(item.file.name)}`;
  const outName = 'output.mp4';

  await ffmpeg.writeFile(inName, await window.FFmpegUtil.fetchFile(item.file));

  const filters = [];
  if (maxH > 0 && item.meta?.height && item.meta.height > maxH) {
    filters.push(`scale=-2:${maxH}`);
  }

  const commonArgs = [
    '-i', inName,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-movflags', '+faststart',
    '-y',
  ];

  // Pass 1
  const p1 = ({ progress }) => {
    const p = Math.max(0, Math.min(1, progress));
    onProgress(0 + p * 0.22, 'Analysing (pass 1 of 2)…');
  };
  ffmpeg.on('progress', p1);
  await ffmpeg.exec([...commonArgs, '-pass', '1', '-an', '-f', 'null', '-']);
  ffmpeg.off('progress', p1);

  // Pass 2
  const p2 = ({ progress }) => {
    const p = Math.max(0, Math.min(1, progress));
    onProgress(0.22 + p * 0.76, 'Encoding (pass 2 of 2)…');
  };
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

  // Read output + cleanup
  const data = await ffmpeg.readFile(outName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  try {
    await ffmpeg.deleteFile(inName);
    await ffmpeg.deleteFile(outName);
    await ffmpeg.deleteFile('ffmpeg2pass-0.log');
    await ffmpeg.deleteFile('ffmpeg2pass-0.log.mbtree');
  } catch { /* ignore */ }

  item.resultUrl = URL.createObjectURL(blob);
  item.resultName = item.file.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';
  item.resultSize = blob.size;
  return { skipped: false };
}

// =========================================================================
//  BATCH RUNNER — processes the queue sequentially
// =========================================================================

async function compressAll() {
  if (isProcessing) return;
  const pending = queue.filter((q) => q.status === 'queued' || q.status === 'error');
  if (pending.length === 0) {
    alert('Add some videos to the queue first.');
    return;
  }

  const targetMB = parseFloat(targetSize.value);
  if (!targetMB || targetMB <= 0) {
    alert('Enter a valid target size.');
    return;
  }
  const maxH = getResolutionHeight();

  isProcessing = true;
  compressAllBtn.disabled = true;
  compressAllBtn.textContent = 'Compressing…';
  compressAllBtn.classList.add('processing');
  batchProgress.classList.remove('hidden');
  downloadAllBtn.classList.add('hidden');
  // Lock the queue (hide remove buttons)
  queue.forEach((q) => updateQueueItemRow(q));

  let lastLog = '';
  try {
    await getFFmpeg((msg) => (lastLog = msg));
  } catch (err) {
    console.error('Engine load error:', err);
    alert(`Could not start the compression engine: ${err.message || err}`);
    isProcessing = false;
    compressAllBtn.disabled = false;
    compressAllBtn.textContent = 'Compress all';
    compressAllBtn.classList.remove('processing');
    batchProgress.classList.add('hidden');
    return;
  }

  let completed = 0;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    item.status = 'processing';
    item.progress = 0;
    updateQueueItemRow(item);

    // Overall progress: (completed + per-file fraction) / total
    const fileBase = i;
    const fileSpan = 1;
    const onProgress = (frac, label) => {
      item.progress = frac * 100;
      item.progressDetail = label + (parseLog(lastLog) ? ' · ' + parseLog(lastLog) : '');
      const overall = ((fileBase + frac * fileSpan) / pending.length) * 100;
      setBatchProgress(`Compressing ${i + 1} of ${pending.length}: ${item.file.name}`, overall, item.progressDetail);
      updateQueueItemRow(item);
    };

    try {
      const result = await compressOne(item, targetMB, maxH, onProgress);
      item.status = result.skipped ? 'skipped' : 'done';
      completed++;
    } catch (err) {
      console.error(`Failed to compress ${item.file.name}:`, err);
      item.status = 'error';
      let msg;
      if (err && typeof err === 'object') {
        msg = err.message || err.toString?.() || JSON.stringify(err).slice(0, 120) || 'Unknown error';
      } else if (typeof err === 'string') {
        msg = err;
      } else {
        msg = 'Unknown error';
      }
      item.error = String(msg).slice(0, 80);
    }
    updateQueueItemRow(item);
    updateQueueCount();
  }

  isProcessing = false;
  compressAllBtn.disabled = false;
  compressAllBtn.textContent = 'Compress all';
  compressAllBtn.classList.remove('processing');

  const failed = pending.length - completed;
  if (failed === 0) {
    setBatchProgress(`All ${completed} done!`, 100, '');
  } else {
    setBatchProgress(`${completed} done, ${failed} failed`, 100, '');
  }

  // Show "Download all" if more than one succeeded
  const successes = queue.filter((q) => (q.status === 'done' || q.status === 'skipped') && q.resultUrl);
  if (successes.length >= 1) {
    downloadAllBtn.classList.remove('hidden');
    downloadAllBtn.textContent = `⬇ Download all (${successes.length})`;
  }
}

// =========================================================================
//  EVENT WIRING
// =========================================================================

// Drag & drop
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
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', (e) => {
  if (e.target.files?.length) addFiles(e.target.files);
  fileInput.value = ''; // allow re-selecting the same files
});
addMoreBtn.addEventListener('click', () => fileInput.click());

// Size presets
sizePresets.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-size]');
  if (!btn) return;
  targetSize.value = btn.dataset.size;
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
});
targetSize.addEventListener('input', () => {
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.size === targetSize.value));
});

// Custom resolution
resolution.addEventListener('change', () => {
  const isCustom = resolution.value === 'custom';
  customResolutionWrap.classList.toggle('hidden', !isCustom);
  if (isCustom) customResolution.focus();
});

// Compress + download all
compressAllBtn.addEventListener('click', compressAll);
downloadAllBtn.addEventListener('click', () => {
  const successes = queue.filter((q) => (q.status === 'done' || q.status === 'skipped') && q.resultUrl);
  // Browsers block multiple downloads unless they're user-initiated and spaced.
  // Stagger them slightly so the browser doesn't block subsequent ones.
  successes.forEach((item, i) => {
    setTimeout(() => downloadBlob(item.resultUrl, item.resultName), i * 300);
  });
});
