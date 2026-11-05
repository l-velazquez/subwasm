# Subwasm

Subwasm adds **selectable subtitle language tracks** to a video entirely in the browser. It keeps the existing subtitle tracks and appends each new `.srt` as a separate language. Subtitles can be switched or turned off in a compatible player. Video and audio are copied without re-encoding; subtitles are never burned into the picture. Your media is never uploaded.

## Run it

```bash
npm ci
npm run dev
```

Open the local Vite URL in a Chromium-based browser. Choose a video and an `.srt` file, or select **Try a sample** to load the included eight-second landscape video and three captions.

1. Add a video and one or more `.srt` files using the pickers or drag and drop. Adding more subtitles appends tracks instead of replacing the previous language.
2. Select each added track, choose its language, give it a label, and adjust its timing independently. Search the full caption track, select a line to seek, and toggle preview subtitles on or off. Selecting a track for preview does not remove any other tracks from export.
3. Choose an output container and select **Add subtitle tracks & export**. The first export loads FFmpeg and inspects the source’s existing tracks. You can cancel while the engine loads or the video is packaged.
4. Download the completed video. Use your player’s subtitle menu to choose a language or turn subtitles off. The page continues showing the source preview; it does not claim to play the finished file or preview every existing embedded track.

**MKV is the default.** It retains existing supported subtitle codecs (including ASS and image-based tracks), attached fonts, chapters, track metadata, and subtitle defaults. MP4 timed text is converted to SubRip when exporting to MKV because Matroska cannot store `mov_text` directly. Choose a player with Matroska subtitle support, such as VLC.

**MP4 is available for text subtitles.** Existing and new text tracks are converted to `mov_text`. Image-based tracks require MKV; they are never silently removed. The original video and audio codecs must be compatible with the selected container. If a container cannot preserve a source stream, export fails rather than deliberately dropping that stream. Container conversion can lose subtitle-specific styling; MKV preserves existing ASS styling, while newly added SRT captions use player-controlled appearance.

New language tracks are requested as non-default so they do not override an existing default language. MKV preserves existing default and forced flags, including an all-off default. FFmpeg’s MP4 muxer enables the first subtitle if none is marked default, so MP4 cannot guarantee the same all-off default as MKV. All tracks remain selectable and can be turned off in a compatible player. The player ultimately controls which tracks it displays.

The finished file remains available until you change a video, add/remove/edit a track, change output format, or start over. Changing the preview language or preview visibility does not discard the export. **Start over** clears all files and settings and releases the FFmpeg worker. Loading a sample replaces the current job.

## Check it

```bash
npm test
npm run build
npm audit
```

The dependency-free Node tests cover SubRip validation, encoding, formatting normalization, independent timing, timestamps, caption search, track mapping, language metadata, and container compatibility. When native `ffmpeg` and `ffprobe` are installed, integration tests create MKV and MP4 sources with existing subtitles and verify exports to both containers, including unchanged video/audio packet hashes, all subtitle languages, default/forced flags, captions and timing, chapters, and MKV font attachments. Media integration tests are explicitly skipped when those binaries are unavailable. GitHub Actions runs these tests before deploying.

## How processing works

- Videos are staged in the Origin Private File System (OPFS) using an 8 MiB working buffer. Each tab gets its own directory and each replacement gets a unique filename. Replaced and reset files are deleted; page closure attempts to remove the session directory. A browser crash may leave staged data behind; browser site-data controls can clear it.
- FFmpeg reads the source through `WORKERFS`, avoiding a full copy into WebAssembly memory. If disk staging or mounting is unavailable, the in-memory fallback is limited to 512 MiB sources.
- Each added `.srt` must be nonempty and at most 5 MiB. UTF-8 and BOM-marked UTF-16 are supported. Newly added captions are normalized to plain text and held in browser memory. Each track has its own language, label, and sync offset. Invalid timing or an adjustment that removes every caption blocks export, including when that track is not currently selected.
- FFprobe inspects the source before export so new track metadata is indexed after the existing subtitles. Original video, audio, and supported subtitle streams are explicitly mapped; MKV also maps attachments. Source metadata and chapters are copied. Newly added tracks have separate subtitle streams, never a video filter.
- The source preview shows one added language at a time. Its styling is illustrative; the downloaded file’s player controls subtitle appearance. Browser support for input containers and embedded subtitles varies.
- FFmpeg downloads on the first export from jsDelivr. The multi-thread core is selected only when cross-origin isolation is available and its startup check passes, with a single-thread fallback for initialization failures. The sample and preview font are served with the app.
- Progress is monotonic, with the final portion reserved for reading the completed video. Cancelling terminates the worker; sources and subtitle settings remain available for another export.

## Large-file boundary

The final video is still materialized in WebAssembly memory and copied into a browser Blob. OPFS and `WORKERFS` improve the large-input path, but this is **not** a streaming output muxer and does not guarantee 8 GB+ end-to-end exports. Large outputs can exceed browser memory limits. A custom FFmpeg/WASM output protocol that writes encoded chunks directly to OPFS remains future work.

JSPI is only reported in the browser details; the shipped core uses its worker API. Some input containers can be processed by FFmpeg even when the browser cannot play them in the preview.

## Deploy to GitHub Pages

The workflow at `.github/workflows/deploy.yml` builds and tests the app, then publishes `dist` with `VITE_BASE_PATH=/subwasm/`.

1. Push to `main`.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. Push a commit or manually run **Deploy Subwasm to GitHub Pages**.

If the site is moved to the domain root, change the workflow base path to `/`. To check deployment asset paths locally:

```bash
VITE_BASE_PATH=/subwasm/ npm run build
VITE_BASE_PATH=/subwasm/ npm run preview
```

Open `/subwasm/` on the preview server. The Vite dev and preview servers add cross-origin isolation headers. GitHub Pages does not add these headers, so it uses the single-thread core.

## Assets

The sample landscape is generated for this project. Noto Sans Regular is distributed under the SIL Open Font License; see `public/fonts/LICENSE` and the [Noto font repository](https://github.com/notofonts/noto-fonts).
