# Shrink 🎬 — Browser Video Compressor

Compress any video to a target file size (default **15 MB**) — **100% in your browser, nothing is uploaded.**

Built with the native **WebCodecs API** (`VideoDecoder` + `VideoEncoder`) for hardware-accelerated, no-download compression. No WASM engine, no 30 MB download, no backend.

## Browser support

Requires the WebCodecs API — available in:
- ✅ Chrome / Edge 94+
- ✅ Safari 16.4+
- ✅ Firefox 130+
- ✅ Most modern mobile browsers

The app shows a friendly message if your browser is too old.

## Run it

Just serve the folder over HTTP (any static server works):

```bash
cd /path/to/compressor

# Python (built into macOS)
python3 -m http.server 8000

# Or Node
npx serve
```

Open **http://localhost:8000**.

## How it works

The pipeline runs entirely in the browser using native browser APIs:

```
input.mp4
   │
   ▼  mp4box.js (demux)
   ├── coded video frames (H.264, HEVC, AV1…)
   │     │
   │     ▼  VideoDecoder (native)
   │     raw VideoFrames
   │       │
   │       ▼  VideoEncoder (native, H.264 High@4.0)
   │       re-encoded chunks at computed bitrate
   │         │
   │         ▼  mp4-muxer (mux)
   └───────► output.mp4 ≤ target size
```

### Size targeting

Bitrate is computed from duration + target size:

```
videoBitrate = (targetBytes × 8 × 0.95) ÷ duration
```

(0.95 leaves headroom for MP4 container overhead.)

WebCodecs encoders honor `avc.bitrate` closely, so output typically lands within **~5% of the requested size**.

## Features

- 🎯 Adjustable target size with presets (8 / 10 / **15** / 25 MB) and free input
- 📐 Optional resolution cap (1080p / 720p / 480p / 360p)
- ⚡ Fast-path: skips recompression if input is already under target
- 🚀 Hardware-accelerated — no WASM, no engine download
- 📊 Before/after size + % saved
- 🔒 100% client-side — your video never leaves your device
- 📱 Responsive, works on mobile

## Limitations

- **Input must be a standard MP4** (most cameras, phones, screen recorders produce this). WebM/MOV/MKV support depends on browser codec availability — MP4 is the most reliable.
- **Audio is dropped** in this build for size predictability. Re-adding audio is a planned enhancement (see TODO in `app.js`).
- **Quality vs size**: if the target is very tight for a long video, quality will degrade gracefully (the encoder clamps to a minimum 40 kbps).
- The first keyframe interval is set to every 60 frames — adjustable in `app.js`.

## Files

```
index.html   — UI structure + library script tags
styles.css   — styling (dark theme)
app.js       — WebCodecs demux/decode/encode/mux pipeline
```

## Libraries

- [mp4box.js](https://github.com/gpac/mp4box.js) v0.5.3 — MP4 demuxer (gpac)
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) v5.2.2 — MP4 muxer with WebCodecs support

Both are loaded from jsDelivr CDN. No build step.

## Deploy

Fully static — drop the three files on any host (GitHub Pages, Netlify, Vercel, S3, USB stick served over HTTP). No environment variables or build configuration needed.
