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
const queue = []; // [{ id, file, meta, status, progress, resultUrl, resultName, resultSize, error, trimStart, trimEnd }]
let nextId = 1;
let ffmpegInstance = null;
let ffmpegReady = false;
let isProcessing = false;

// ---- Settings persistence (settings only — files can't be persisted) ----
const SETTINGS_KEY = 'shrink.settings.v1';
let saveTimer = null;

function saveSettings() {
  // Debounced so dragging a slider doesn't slam localStorage
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          targetSize: targetSize.value,
          resolution: resolution.value,
          customResolution: customResolution.value,
        }),
      );
    } catch { /* private mode / full storage — ignore */ }
  }, 300);
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (s.targetSize) targetSize.value = s.targetSize;
    if (s.resolution) {
      resolution.value = s.resolution;
      const isCustom = s.resolution === 'custom';
      customResolutionWrap.classList.toggle('hidden', !isCustom);
    }
    if (s.customResolution) customResolution.value = s.customResolution;
    // Sync preset highlight to restored value
    sizePresets.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.size === targetSize.value),
    );
    return true;
  } catch { return false; }
}

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
      trimStart: 0,   // seconds; 0 = start of video
      trimEnd: null,  // seconds; null = end of video (set after meta loads)
      trimOpen: false, // trim panel expanded?
    };
    queue.push(item);
    renderQueueItem(item);
    // Read metadata async (don't block — fills in as it arrives)
    try {
      item.meta = await readMeta(file);
      // Default trim = full video
      item.trimEnd = item.meta.duration || 0;
    } catch {
      item.meta = { duration: 0, width: 0, height: 0 };
      item.trimEnd = 0;
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
    <div class="qi-handle" aria-hidden="true">⠿</div>
    <div class="qi-thumb"><span>🎬</span></div>
    <div class="qi-info">
      <div class="qi-name"></div>
      <div class="qi-meta"></div>
      <div class="qi-progress-wrap hidden"><div class="qi-progress-bar"><div class="qi-progress-fill"></div></div></div>
      <div class="qi-status"></div>
      <div class="qi-trim-panel hidden">
        <div class="qi-trim-thumbs"></div>
        <div class="qi-trim-slider-wrap">
          <input type="range" class="qi-trim-start" min="0" max="100" step="0.1" value="0" />
          <input type="range" class="qi-trim-end" min="0" max="100" step="0.1" value="100" />
        </div>
        <div class="qi-trim-readout"></div>
      </div>
    </div>
    <div class="qi-actions"></div>
  `;
  queueList.appendChild(li);

  // Wire drag-to-reorder (only enabled when queued — see updateQueueItemRow)
  wireDragHandle(li, item);

  // Wire trim sliders
  wireTrim(li, item);

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
  const handleEl = li.querySelector('.qi-handle');

  nameEl.textContent = item.file.name;

  const sizeStr = fmtBytes(item.file.size);
  const metaParts = [sizeStr];
  if (item.meta?.duration) metaParts.push(fmtTime(item.meta.duration));
  if (item.meta?.width) metaParts.push(`${item.meta.width}×${item.meta.height}`);
  // Show trim indicator if a non-default trim is set
  if (hasTrim(item)) {
    const kept = item.trimEnd - item.trimStart;
    metaParts.push(`✂ ${fmtTime(item.trimStart)}–${fmtTime(item.trimEnd)} (${fmtTime(kept)} kept)`);
  }
  metaEl.textContent = metaParts.join(' · ');

  // Status + actions by state
  li.className = `queue-item status-${item.status}`;
  statusEl.className = 'qi-status';
  actionsEl.innerHTML = '';

  // Drag handle: only when queued (not during/after processing)
  handleEl.classList.toggle('hidden', item.status !== 'queued' || isProcessing);
  if (item.status === 'queued' && !isProcessing) {
    li.draggable = true;
  } else {
    li.draggable = false;
  }

  switch (item.status) {
    case 'queued':
      statusEl.textContent = '';
      if (!isProcessing) {
        // Trim toggle button
        const trim = document.createElement('button');
        trim.className = 'qi-trim-btn';
        trim.type = 'button';
        trim.textContent = '✂ Trim';
        trim.title = hasTrim(item) ? 'Edit trim' : 'Trim start/end';
        if (hasTrim(item)) trim.classList.add('active');
        trim.onclick = () => toggleTrimPanel(item);
        actionsEl.appendChild(trim);

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

// Does this item have a non-default trim applied?
function hasTrim(item) {
  return item.meta?.duration > 0 && (item.trimStart > 0.1 || item.trimEnd < item.meta.duration - 0.1);
}

// =========================================================================
//  TRIM
// =========================================================================

function toggleTrimPanel(item) {
  item.trimOpen = !item.trimOpen;
  const li = queueList.querySelector(`[data-id="${item.id}"]`);
  if (!li) return;
  const panel = li.querySelector('.qi-trim-panel');
  panel.classList.toggle('hidden', !item.trimOpen);
  if (item.trimOpen) {
    // Configure slider bounds to the real duration
    const dur = item.meta?.duration || 0;
    const startSlider = li.querySelector('.qi-trim-start');
    const endSlider = li.querySelector('.qi-trim-end');
    startSlider.min = 0;
    startSlider.max = dur;
    startSlider.value = item.trimStart;
    endSlider.min = 0;
    endSlider.max = dur;
    endSlider.value = item.trimEnd;
    updateTrimReadout(item);
    // Lazy-generate thumbnails once
    if (!panel.querySelector('img') && dur > 0) {
      generateThumbnails(item, li).catch((e) => console.warn('thumbnail gen failed', e));
    }
  }
}

function updateTrimReadout(item) {
  const li = queueList.querySelector(`[data-id="${item.id}"]`);
  if (!li) return;
  const readout = li.querySelector('.qi-trim-readout');
  const kept = item.trimEnd - item.trimStart;
  readout.textContent = `${fmtTime(item.trimStart)} → ${fmtTime(item.trimEnd)} (${fmtTime(kept)} kept of ${fmtTime(item.meta?.duration || 0)})`;
}

// Generate 6 evenly-spaced thumbnails from the video for the trim strip
async function generateThumbnails(item, li) {
  const dur = item.meta?.duration;
  if (!dur) return;
  const thumbsContainer = li.querySelector('.qi-trim-thumbs');
  const url = URL.createObjectURL(item.file);
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.crossOrigin = 'anonymous';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  // Thumb dimensions
  const THUMB_W = 64;
  canvas.width = THUMB_W;
  canvas.height = Math.max(36, Math.round((item.meta.height / item.meta.width) * THUMB_W) || 36);

  // Seek to each timestamp and capture
  const positions = Array.from({ length: 6 }, (_, i) => (dur * (i + 0.5)) / 6);
  for (const t of positions) {
    await new Promise((resolve) => {
      const onSeeked = () => {
        try {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = document.createElement('img');
          img.src = canvas.toDataURL('image/jpeg', 0.6);
          thumbsContainer.appendChild(img);
        } catch { /* tainted canvas etc — skip */ }
        v.removeEventListener('seeked', onSeeked);
        resolve();
      };
      v.addEventListener('seeked', onSeeked);
      v.currentTime = Math.min(t, dur - 0.05);
    });
  }
  URL.revokeObjectURL(url);
}

function wireTrim(li, item) {
  const startSlider = li.querySelector('.qi-trim-start');
  const endSlider = li.querySelector('.qi-trim-end');

  const onInput = (which) => (e) => {
    let start = parseFloat(startSlider.value);
    let end = parseFloat(endSlider.value);
    // Clamp: keep 0.1s gap between thumbs
    if (which === 'start' && start > end - 0.1) {
      start = end - 0.1;
      startSlider.value = start;
    }
    if (which === 'end' && end < start + 0.1) {
      end = start + 0.1;
      endSlider.value = end;
    }
    item.trimStart = start;
    item.trimEnd = end;
    updateTrimReadout(item);
  };

  startSlider.addEventListener('input', onInput('start'));
  endSlider.addEventListener('input', onInput('end'));
}

// =========================================================================
//  DRAG TO REORDER
// =========================================================================

let draggedId = null;

function wireDragHandle(li, item) {
  li.addEventListener('dragstart', (e) => {
    if (item.status !== 'queued' || isProcessing) {
      e.preventDefault();
      return;
    }
    draggedId = item.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox to start the drag
    e.dataTransfer.setData('text/plain', String(item.id));
  });

  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    draggedId = null;
    // Clean up any leftover drop indicators
    queueList.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  });

  li.addEventListener('dragover', (e) => {
    if (draggedId === null || draggedId === item.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Decide before/after based on mouse Y relative to row midpoint
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    li.classList.toggle('drop-before', !after);
    li.classList.toggle('drop-after', after);
  });

  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-before', 'drop-after');
  });

  li.addEventListener('drop', (e) => {
    if (draggedId === null || draggedId === item.id) return;
    e.preventDefault();
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    li.classList.remove('drop-before', 'drop-after');
    reorderQueue(draggedId, item.id, after);
  });
}

// Move `fromId` to be before/after `toId` in both the array and the DOM.
function reorderQueue(fromId, toId, after) {
  const fromIdx = queue.findIndex((q) => q.id === fromId);
  const toIdx = queue.findIndex((q) => q.id === toId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

  const [moved] = queue.splice(fromIdx, 1);
  // Recalculate target index after removal
  let targetIdx = queue.findIndex((q) => q.id === toId);
  if (after) targetIdx += 1;
  queue.splice(targetIdx, 0, moved);

  // Reorder the DOM to match
  const fromEl = queueList.querySelector(`[data-id="${fromId}"]`);
  const toEl = queueList.querySelector(`[data-id="${toId}"]`);
  if (fromEl && toEl) {
    if (after) {
      toEl.after(fromEl);
    } else {
      toEl.before(fromEl);
    }
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

  const sourceDuration = item.meta?.duration;
  const trimmed = hasTrim(item);
  // Effective duration for bitrate math = the part we're actually keeping
  const effectiveDuration = trimmed ? (item.trimEnd - item.trimStart) : sourceDuration;

  // Fast path: already under target AND no trim (trim requires re-encoding)
  if (!trimmed && item.file.size <= targetMB * 1024 * 1024) {
    item.resultUrl = URL.createObjectURL(item.file);
    item.resultName = item.file.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';
    item.resultSize = item.file.size;
    return { skipped: true };
  }

  if (!effectiveDuration || !isFinite(effectiveDuration) || effectiveDuration <= 0) {
    throw new Error('Could not determine video duration.');
  }

  // Compute target bitrate using the TRIMMED duration
  const targetBytes = targetMB * 1024 * 1024;
  const targetBits = targetBytes * 8 * 0.98;
  const audioBitrate = targetMB >= 10 ? '128k' : '96k';
  const audioBits = parseInt(audioBitrate, 10) * 1000 * effectiveDuration;
  let videoBitrate = Math.floor((targetBits - audioBits) / effectiveDuration);
  if (videoBitrate < 50_000) videoBitrate = 50_000;
  const videoK = Math.max(40, Math.round(videoBitrate / 1000));

  const inName = `input.${ext(item.file.name)}`;
  const outName = 'output.mp4';

  await ffmpeg.writeFile(inName, await window.FFmpegUtil.fetchFile(item.file));

  const filters = [];
  if (maxH > 0 && item.meta?.height && item.meta.height > maxH) {
    filters.push(`scale=-2:${maxH}`);
  }

  // -ss/-to go BEFORE -i for fast keyframe seek (much faster than after-input seek)
  const seekArgs = trimmed
    ? ['-ss', item.trimStart.toFixed(3), '-to', item.trimEnd.toFixed(3)]
    : [];

  const commonArgs = [
    ...seekArgs,
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
  saveSettings();
});
targetSize.addEventListener('input', () => {
  sizePresets.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.size === targetSize.value));
  saveSettings();
});

// Custom resolution
resolution.addEventListener('change', () => {
  const isCustom = resolution.value === 'custom';
  customResolutionWrap.classList.toggle('hidden', !isCustom);
  if (isCustom) customResolution.focus();
  saveSettings();
});
customResolution.addEventListener('input', saveSettings);

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

// ---- Load saved settings on startup ----
if (loadSettings()) {
  showToast('Settings restored from last visit');
}

function showToast(msg) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}
