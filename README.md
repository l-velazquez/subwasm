# Subwasm

Subwasm is a local-first MVP for burning an `.srt` subtitle track into a video in the browser. The UI is intentionally small: choose one video, choose one SubRip file, and process the result with FFmpeg WebAssembly.

## Run it

```bash
npm install
npm run dev
```

Open the local Vite URL in a Chromium-based browser. The Vite server adds the cross-origin isolation headers needed by the multi-thread FFmpeg core when the browser supports it.

## What is implemented

- Video and `.srt` drag-and-drop / file-picker inputs.
- Chunked staging into the Origin Private File System (OPFS), using an 8 MiB working buffer.
- FFmpeg `WORKERFS` mounting, so the staged source is readable by FFmpeg without first copying the whole video into the WebAssembly virtual filesystem.
- Burn-in using the `subtitles` video filter, H.264 video, AAC audio, and MP4 output.
- Progress and log updates from the FFmpeg worker.
- File System Access API save picker when available, with a normal browser download fallback.
- Capability indicators for OPFS, FFmpeg workers, and JSPI support.

## MVP boundary

`ffmpeg.wasm` still materializes the final MP4 when `readFile()` is called. This MVP therefore demonstrates the important large-input path—local disk staging plus `WORKERFS` reads—but it does not yet implement a streaming output muxer for arbitrarily large output files. The next step for 8GB+ end-to-end processing is a custom FFmpeg/WASM build or output protocol that can write encoded chunks directly into an OPFS sink while the command is running.

The shipped FFmpeg core is built around its worker API; the JSPI badge reports browser capability so a JSPI-enabled custom core can be adopted in the next iteration.

The subtitle file and the FFmpeg runtime may be fetched by the browser; user media is never sent to an application server.
