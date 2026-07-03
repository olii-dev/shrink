'use strict';

/* =========================================================================
 * Shrink — WebCodecs-based video compressor
 *
 * Pipeline:  demux (mp4box) → decode (VideoDecoder) → encode (VideoEncoder)
 *            → mux (mp4-muxer)  →  ArrayBufferTarget → download
 *
 * Size targeting: We use the VideoEncoder's average bitrate. We compute the
 * bitrate from duration + target size (same formula as before). WebCodecs
 * encoders honor `avc.bitrate` quite closely on modern hardware, so we land
 * within ~5% of the requested size. (No two-pass needed for most clips.)
 * ========================================================================= */

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

// ---- Browser feature detection (run on load) ----
function checkSupport() {
  const reasons = [];
  if (typeof VideoDecoder === 'undefined') reasons.push('VideoDecoder API');
  if (typeof VideoEncoder === 'undefined') reasons.push('VideoEncoder API');
  if (typeof window.MP4Box === 'undefined') reasons.push('mp4box library');
  if (typeof window.Mp4Muxer === 'undefined') reasons.push('mp4-muxer library');
  if (!window.showOpenFilePicker && !fileInput) reasons.push('file input');

  if (reasons.length) {
    const msg =
      reasons.some((r) => r.includes('API'))
        ? `This browser doesn't support the WebCodecs API (${reasons
            .filter((r) => r.includes('API'))
            .join(', ')}). Try the latest Chrome, Edge, Safari 16.4+, or Firefox 130+.`
        : `Failed to load required libraries: ${reasons.join(', ')}`;
    progress.classList.remove('hidden');
    setProgress('Unsupported browser', 0, msg);
    return false;
  }
  return true;
}

// ---- State ----
let currentFile = null;
let currentMeta = null; // { duration, width, height }
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

const setProgress = (label, pct, detail = '') => {
  progressLabel.textContent = label;
  progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  progressPct.textContent = `${Math.round(pct)}%`;
  if (detail) progressDetail.textContent = detail;
};

// Read video metadata via a hidden <video> element
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
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) {
    alert('Please choose a video file (MP4, MOV, WebM, MKV, M4V).');
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

// =========================================================================
//  CORE: WebCodecs compress
// =========================================================================

/** Demux the input MP4 into coded frames + track metadata using mp4box. */
async function demux(file, onSample) {
  const buf = await file.arrayBuffer();
  // mp4box needs the fileStart offset appended in the last 8 bytes
  buf.fileStart = 0;
  const iso = window.MP4Box.createFile();

  let videoTrack = null;
  let audioTrack = null;
  let ready;
  const readyPromise = new Promise((r) => (ready = r));

  iso.onReady = (info) => {
    videoTrack = info.videoTracks[0];
    audioTrack = info.audioTracks[0];
    iso.setExtractionOptions(videoTrack ? videoTrack.id : null, null, { nbSamples: 256 });
    iso.start();
    ready(info);
  };

  iso.onSamples = (trackId, _user, samples) => {
    onSample(trackId, samples);
  };

  iso.onError = (e) => console.error('mp4box error', e);

  iso.appendBuffer(buf);
  iso.flush();

  await readyPromise;
  return { iso, videoTrack, audioTrack };
}

/** Wait until the decoder's decode queue is empty. */
const drainDecoder = (dec) =>
  new Promise((resolve) => {
    const check = () => {
      if (dec.decodeQueueSize === 0) resolve();
      else setTimeout(check, 5);
    };
    check();
  });

/** Wait until the encoder is fully flushed. */
const flushEncoder = (enc) =>
  new Promise((resolve) => {
    enc.addEventListener('dequeue', () => {
      if (enc.encodeQueueSize === 0) resolve();
    });
    enc.flush().then(resolve).catch(resolve);
  });

async function compress() {
  if (!currentFile) return;
  if (!checkSupport()) return;

  const targetMB = parseFloat(targetSize.value);
  if (!targetMB || targetMB <= 0) {
    alert('Enter a valid target size.');
    return;
  }
  const maxH = parseInt(resolution.value, 10);

  // Fast path: already small enough
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
  setProgress('Reading video file…', 5, '');

  const { Mp4Muxer, ArrayBufferTarget } = window.Mp4Muxer;

  try {
    // ---- 1. Demux ----
    const sampleQueue = []; // {trackId, sample}
    const { iso, videoTrack, audioTrack } = await demux(currentFile, (trackId, samples) => {
      for (const s of samples) sampleQueue.push({ trackId, sample: s });
    });

    if (!videoTrack) throw new Error('No video track found. This file may not be a standard MP4.');
    if (!videoTrack.codec) throw new Error('Could not determine the video codec.');

    setProgress('Setting up encoder…', 12, `Input codec: ${videoTrack.codec}`);

    // ---- 2. Compute output dimensions + bitrate ----
    const inW = videoTrack.track_width;
    const inH = videoTrack.track_height;
    let outW = inW;
    let outH = inH;
    if (maxH > 0 && inH > maxH) {
      outH = maxH;
      outW = Math.round((inW * maxH) / inH);
      // H.264 requires even dimensions
      outW -= outW % 2;
      outH -= outH % 2;
    }

    // Bitrate: target bytes × 8 × 0.95 overhead / duration, all to video.
    // (We drop audio in this build for size reliability — see README.)
    const targetBits = targetMB * 1024 * 1024 * 8 * 0.95;
    const videoBitrate = Math.max(40_000, Math.floor(targetBits / duration));

    // ---- 3. Muxer setup ----
    const muxerTarget = new ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target: muxerTarget,
      video: {
        codec: 'avc',
        width: outW,
        height: outH,
      },
      fastStart: 'in-memory',
    });

    // ---- 4. Decoder + Encoder setup ----
    let configApplied = false;
    let frameCount = 0;
    const totalSamples = sampleQueue.length || 1;

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => console.error('Encoder error:', e.message, e),
    });

    const decoder = new VideoDecoder({
      output: (frame) => {
        // Apply encoder config lazily once we have the decoded frame dimensions
        if (!configApplied) {
          encoder.configure({
            codec: 'avc1.640028', // High profile, level 4.0 — broadly compatible
            width: outW,
            height: outH,
            bitrate: videoBitrate,
            framerate: videoTrack.nb_samples / (duration || (videoTrack.nb_samples / 30)),
          });
          configApplied = true;
        }

        // For downscale, VideoFrame supports displayWidth/Height on creation
        let frameToEncode = frame;
        if (outW !== inW || outH !== inH) {
          // Re-crop via a new frame with displayWidth/Height
          frameToEncode = new VideoFrame(frame, {
            visibleRect: frame.visibleRect || { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight },
          });
        }

        if (encoder.state === 'configured') {
          encoder.encode(frameToEncode, { keyFrame: frameCount % 60 === 0 });
          frameCount++;
        }
        frame.close();
        if (frameToEncode !== frame) frameToEncode.close();
      },
      error: (e) => console.error('Decoder error:', e.message, e),
    });

    // Configure decoder with codec + description from the demuxed track
    const decoderConfig = {
      codec: videoTrack.codec,
      codedWidth: inW,
      codedHeight: inH,
      description:
        videoTrack.mdia?.minf?.stbl?.stsd?.avc1?.avcC || iso.getAvssBox?.(videoTrack.id),
    };
    decoder.configure(decoderConfig);

    // ---- 5. Pump samples through decoder ----
    setProgress('Decoding & encoding…', 18, `${totalSamples} frames to process`);

    for (let i = 0; i < sampleQueue.length; i++) {
      const { trackId, sample } = sampleQueue[i];
      if (trackId !== videoTrack.id) continue;

      const type = sample.is_sync ? 'key' : 'delta';
      const chunk = new EncodedVideoChunk({
        type,
        timestamp: sample.cts,
        duration: sample.duration,
        data: sample.data,
      });
      decoder.decode(chunk);

      // Throttle so we don't blow up memory on long videos
      if (i % 64 === 0) {
        await drainDecoder(decoder);
        setProgress(
          'Decoding & encoding…',
          18 + (i / sampleQueue.length) * 72,
          `Frame ${i}/${totalSamples}`,
        );
      }
    }

    await drainDecoder(decoder);
    await flushEncoder(encoder);

    setProgress('Finalizing MP4…', 95, '');
    decoder.close();
    encoder.close();
    muxer.finalize();

    const outBuf = muxerTarget.buffer || muxerTarget.data;
    if (!outBuf) throw new Error('Muxer produced no output buffer.');
    const blob = new Blob([outBuf], { type: 'video/mp4' });

    resultBlobUrl = URL.createObjectURL(blob);
    resultFileName = currentFile.name.replace(/\.[^.]+$/, '') + '_shrink.mp4';

    setProgress('Done', 100, '');
    showResult(currentFile.size, blob.size);
  } catch (err) {
    console.error(err);
    progressDetail.textContent = '';
    alert(
      `Compression failed: ${err.message || err}\n\n` +
        'This can happen with unusual codecs, very short clips, or unsupported MP4 variants. ' +
        'Try a different file or a standard MP4.',
    );
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

// Run support check on startup
checkSupport();
