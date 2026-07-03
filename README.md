# Shrink 🎬 — Browser Video Compressor

Compress any video to a target file size (default **15 MB**) — **100% in your browser, nothing is uploaded.**

Built with plain HTML/CSS/JS + [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). No build step, no backend, no dependencies to install.

## Run it

ffmpeg.wasm fetches its core via `fetch()`, which browsers block on `file://`. So serve the folder over HTTP — any static server works:

```bash
cd /Users/olimebberson/Downloads/compressor

# Option A: Python (built into macOS)
python3 -m http.server 8000

# Option B: Node
npx serve
```

Then open **http://localhost:8000**.

## How it works

To hit a specific target size accurately, Shrink uses **two-pass H.264 encoding**:

1. Read video duration + dimensions from a hidden `<video>` element.
2. Compute the video bitrate that produces the target size:
   ```
   videoBitrate = (targetBytes × 8 × 0.98 − audioBitrate × duration) ÷ duration
   ```
   (0.98 leaves headroom for the MP4 container overhead.)
3. **Pass 1** — fast analysis pass (no output written).
4. **Pass 2** — encode at the computed bitrate, with VBV buffering to stay near target.
5. Output: universal **MP4 (H.264 + AAC)** with `+faststart` for instant web playback.

This typically lands within **~2% of the requested size**.

## Features

- 🎯 Adjustable target size with presets (8 / 10 / **15** / 25 MB) and free input
- 📐 Optional resolution cap (1080p / 720p / 480p / 360p) for tight targets
- ⚡ Fast-path: if the input is already under target, it skips recompression
- 📊 Before/after size + % saved
- 🔒 Fully client-side — your video never leaves your device
- 📱 Responsive, works on mobile

## Files

```
index.html   — UI structure
styles.css   — styling (dark theme)
app.js       — ffmpeg loading, metadata, two-pass compression logic
```

## Notes & limitations

- **First run** downloads ~30 MB of ffmpeg core (cached by the browser afterwards).
- Uses the **single-threaded** ffmpeg core, so it works on any static host without COOP/COEP headers — at the cost of speed. A ~100 MB clip typically takes 1–3 minutes depending on your CPU.
- If the target is impossibly small for the duration (e.g. 1 MB for a 10-minute video), quality will degrade gracefully — it still produces a file, just at low bitrate.
- Some rare codecs/containers may not decode in ffmpeg.wasm. If so, re-save the file in a standard format first.

## Deploy

It's fully static — drop the three files on any host (Netlify, Vercel, GitHub Pages, S3, even a USB stick served over HTTP). No environment variables or build configuration needed.
