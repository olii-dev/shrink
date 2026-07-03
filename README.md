# Shrink 🎬 — Browser Video Compressor

Compress any video to a target file size (default **15 MB**) — **100% in your browser, nothing is uploaded.** Audio is preserved.

Built with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), **bundled locally** in the repo so there's no CDN download on use and no cross-origin worker issues.

## Features

- 🎯 Adjustable target size with presets (8 / 10 / **15** / 25 MB) and free input
- 📐 Optional resolution cap (1080p / 720p / 480p / 360p) for tight targets
- 🔊 **Audio preserved** (re-encoded to AAC)
- 🎞 **Broad format support** — MP4, MOV, MKV, WebM, AVI, M4V, and more
- ⚡ Fast-path: skips recompression if input is already under target
- 📊 Before/after size + % saved
- 🔒 100% client-side — your video never leaves your device
- 🚀 **Engine bundled** in `/lib` — no runtime CDN fetch, fully self-contained

## Run it

Serve the folder over HTTP (ffmpeg.wasm uses `fetch()`, which browsers block on `file://`):

```bash
cd /path/to/compressor

# Python (built into macOS)
python3 -m http.server 8000

# Or Node
npx serve
```

Open **http://localhost:8000**.

## How it works

To hit a specific target size accurately, Shrink uses **two-pass H.264 encoding**:

1. Read video duration + dimensions from a hidden `<video>` element.
2. Compute the video bitrate that produces the target size:
   ```
   videoBitrate = (targetBytes × 8 × 0.98 − audioBitrate × duration) ÷ duration
   ```
3. **Pass 1** — fast analysis pass (no output written).
4. **Pass 2** — encode at the computed bitrate, with VBV buffering to stay near target.
5. Output: universal **MP4 (H.264 video + AAC audio)** with `+faststart`.

Lands within **~2% of the requested size**.

## Why bundled locally?

Earlier versions loaded ffmpeg from a CDN. This was unreliable:
- Cross-origin Web Workers are silently blocked by browsers → infinite hangs.
- WASM modules can't be `import`'d cross-origin → "failed to import ffmpeg-core.js" errors.

Bundling the ffmpeg files in `/lib` makes everything **same-origin**. The worker spawns cleanly, `importScripts()` works, no special headers needed. The trade-off is a one-time ~32 MB addition to the repo.

## Files

```
index.html    — UI structure
styles.css    — styling (dark theme)
app.js        — ffmpeg loading + two-pass compression logic
lib/          — ffmpeg.wasm engine (bundled, ~32 MB)
  ffmpeg.js         — ffmpeg main library (UMD)
  814.ffmpeg.js     — ffmpeg worker bundle
  ffmpeg-core.js    — ffmpeg core (WASM loader)
  ffmpeg-core.wasm  — ffmpeg compiled to WebAssembly (~32 MB)
  util.js           — ffmpeg utility helpers
.gitattributes — marks /lib as binary for clean git history
```

## Notes

- **First run in a session** still takes a moment to instantiate ffmpeg (parsing the WASM), but no network fetch happens — it's already on disk.
- Uses the **single-threaded** ffmpeg core (works on any static host without COOP/COEP headers), but with the `-preset veryfast` x264 setting for ~3× faster encoding than the default. A ~100 MB clip typically takes 30–90 seconds depending on your CPU.
- If the target is impossibly small for the duration (e.g. 1 MB for a 10-minute video), quality degrades gracefully — the encoder clamps to a minimum 40 kbps.

## Deploy

Fully static — push to GitHub Pages, Netlify, Vercel, S3, or any static host. The repo is self-contained; no build step or environment variables required.
