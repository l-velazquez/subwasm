import './style.css';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_VERSION = '0.12.10';
const OPFS_DIRECTORY = 'subtitle-forge';
const CHUNK_SIZE = 8 * 1024 * 1024;
const MEMORY_FALLBACK_LIMIT = 512 * 1024 * 1024;

const state = {
  video: null,
  subtitle: null,
  ffmpeg: null,
  ffmpegLoading: null,
  ffmpegMode: null,
  opfsDirectory: null,
  opfsAvailable: false,
  storageEstimate: null,
  previewURL: null,
  outputURL: null,
  selectionToken: { video: 0, subtitle: 0 },
  processing: false,
  lastLog: '',
  duration: null,
  progress: 0,
  logLines: [],
  toastTimer: null,
};

const elements = {
  videoInput: document.querySelector('#video-input'),
  subtitleInput: document.querySelector('#subtitle-input'),
  videoDropzone: document.querySelector('#video-dropzone'),
  subtitleDropzone: document.querySelector('#subtitle-dropzone'),
  videoFileState: document.querySelector('#video-file-state'),
  subtitleFileState: document.querySelector('#subtitle-file-state'),
  videoPreview: document.querySelector('#video-preview'),
  previewStage: document.querySelector('#preview-stage'),
  stageEmpty: document.querySelector('#stage-empty'),
  previewName: document.querySelector('#preview-name'),
  outputName: document.querySelector('#output-name'),
  processButton: document.querySelector('#process-button'),
  processButtonLabel: document.querySelector('#process-button-label'),
  processHint: document.querySelector('#process-hint'),
  storageChip: document.querySelector('#storage-chip'),
  storageChipLabel: document.querySelector('#storage-chip-label'),
  runtimeSummary: document.querySelector('#runtime-summary'),
  workspaceStatus: document.querySelector('#workspace-status'),
  statusText: document.querySelector('#status-text'),
  processingOverlay: document.querySelector('#processing-overlay'),
  processingTitle: document.querySelector('#processing-title'),
  processingDetail: document.querySelector('#processing-detail'),
  progressFill: document.querySelector('#progress-fill'),
  progressLabel: document.querySelector('#progress-label'),
  logLabel: document.querySelector('#log-label'),
  completedOverlay: document.querySelector('#completed-overlay'),
  completedDetail: document.querySelector('#completed-detail'),
  toast: document.querySelector('#toast'),
  toastMessage: document.querySelector('#toast-message'),
  toastClose: document.querySelector('#toast-close'),
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  const precision = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function extensionOf(name) {
  const match = String(name).toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match ? match[1] : '';
}

function basenameOf(name) {
  return String(name).replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video';
}

function isVideoFile(file) {
  const extension = extensionOf(file.name);
  return file.type.startsWith('video/') || ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.ts'].includes(extension);
}

function isSubtitleFile(file) {
  return extensionOf(file.name) === '.srt';
}

function setWorkspaceStatus(message, kind = '') {
  elements.statusText.textContent = message;
  elements.workspaceStatus.classList.remove('is-error', 'is-success');
  if (kind) elements.workspaceStatus.classList.add(`is-${kind}`);
}

function showToast(message) {
  elements.toastMessage.textContent = message;
  elements.toast.hidden = false;
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 6000);
}

function setSignal(id, stateName, label) {
  const signal = document.querySelector(`#${id}`);
  if (!signal) return;
  signal.classList.remove('is-ready', 'is-warning', 'is-error');
  if (stateName) signal.classList.add(stateName);
  const strong = signal.querySelector('strong');
  if (strong) strong.textContent = label;
}

function detectJSPI() {
  return typeof WebAssembly !== 'undefined'
    && typeof WebAssembly.Suspending === 'function'
    && typeof WebAssembly.promising === 'function';
}

function updateRuntimeSignals() {
  const hasOPFS = typeof navigator.storage?.getDirectory === 'function';
  state.opfsAvailable = hasOPFS;
  setSignal('signal-opfs', hasOPFS ? 'is-ready' : 'is-warning', hasOPFS ? 'available' : 'fallback');
  setSignal('signal-worker', typeof Worker === 'function' ? 'is-ready' : 'is-error', typeof Worker === 'function' ? 'available' : 'unavailable');
  const hasJSPI = detectJSPI();
  setSignal('signal-jspi', hasJSPI ? 'is-ready' : 'is-warning', hasJSPI ? 'detected' : 'fallback');
  elements.runtimeSummary.textContent = hasOPFS
    ? hasJSPI
      ? 'Disk-first staging is available; this browser also reports JSPI support.'
      : 'Disk-first staging is available; FFmpeg will use its worker fallback.'
    : 'This browser can still run small files, but OPFS storage is not available.';
  return { hasOPFS, hasJSPI };
}

async function prepareOPFS() {
  if (!state.opfsAvailable) return;
  try {
    const root = await navigator.storage.getDirectory();
    state.opfsDirectory = await root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
    if (navigator.storage.estimate) state.storageEstimate = await navigator.storage.estimate();
    elements.storageChip.dataset.state = '';
    elements.storageChipLabel.textContent = 'OPFS ready';
    setSignal('signal-opfs', 'is-ready', 'ready');
  } catch (error) {
    state.opfsAvailable = false;
    state.opfsDirectory = null;
    elements.storageChip.dataset.state = 'warning';
    elements.storageChipLabel.textContent = 'Memory fallback';
    setSignal('signal-opfs', 'is-warning', 'fallback');
    elements.runtimeSummary.textContent = 'OPFS could not be opened; smaller files can use the memory fallback.';
    console.warn('OPFS is unavailable in this context.', error);
  }
}

async function removeOPFSRecord(record) {
  if (!record?.storageName || !state.opfsDirectory) return;
  try {
    await state.opfsDirectory.removeEntry(record.storageName);
  } catch {
    // The file may already have been replaced or removed by the browser.
  }
}

async function stageFileInOPFS(file, storageName, onProgress) {
  const handle = await state.opfsDirectory.getFileHandle(storageName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let written = 0;
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = await file.slice(offset, end).arrayBuffer();
      await writable.write(chunk);
      written += end - offset;
      onProgress(file.size ? written / file.size : 1, written);
    }
    await writable.close();
    return { handle, file: await handle.getFile() };
  } catch (error) {
    try { await writable.abort(); } catch { /* noop */ }
    try { await state.opfsDirectory.removeEntry(storageName); } catch { /* noop */ }
    throw error;
  }
}

function updateDropzone(slot, record) {
  const zone = slot === 'video' ? elements.videoDropzone : elements.subtitleDropzone;
  const stateElement = slot === 'video' ? elements.videoFileState : elements.subtitleFileState;
  const title = zone.querySelector('.drop-copy strong');
  const detail = zone.querySelector('.drop-copy small');
  const chooseLink = zone.querySelector('.choose-link');
  zone.classList.remove('has-file', 'is-staging');

  if (!record) {
    title.textContent = slot === 'video' ? 'Drop a video here' : 'Drop your subtitle file';
    detail.innerHTML = slot === 'video'
      ? 'MP4, MKV, MOV, WebM, AVI <span>·</span> any size'
      : 'SubRip subtitle <code>.srt</code> only';
    chooseLink.innerHTML = 'Choose file <b>↗</b>';
    stateElement.textContent = '';
    return;
  }

  title.textContent = record.originalName;
  detail.textContent = `${formatBytes(record.size)} · ${record.sourceLabel}`;
  chooseLink.innerHTML = 'Replace <b>↗</b>';
  if (record.phase === 'staging') {
    zone.classList.add('is-staging');
    stateElement.textContent = `Staging ${Math.round(record.progress * 100)}%`;
  } else if (record.phase === 'ready') {
    zone.classList.add('has-file');
    stateElement.textContent = record.sourceLabel === 'OPFS local disk' ? 'Stored locally ✓' : 'Ready · memory fallback';
  } else if (record.phase === 'error') {
    stateElement.textContent = 'Could not stage';
  }
}

function updatePreview() {
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  state.previewURL = null;
  if (state.video?.original) {
    state.previewURL = URL.createObjectURL(state.video.original);
    elements.videoPreview.src = state.previewURL;
    elements.previewStage.classList.add('has-video');
    elements.stageEmpty.hidden = true;
  } else {
    elements.videoPreview.removeAttribute('src');
    elements.videoPreview.load();
    elements.previewStage.classList.remove('has-video');
    elements.stageEmpty.hidden = false;
  }
}

function updateOutputName() {
  const name = state.video?.originalName ? `${basenameOf(state.video.originalName)}-subtitled.mp4` : 'subtitled-video.mp4';
  elements.outputName.textContent = name;
  return name;
}

function updateProcessControls() {
  const videoReady = state.video?.phase === 'ready';
  const subtitleReady = state.subtitle?.phase === 'ready';
  const ready = videoReady && subtitleReady && !state.processing;
  elements.processButton.disabled = !ready;
  if (state.processing) {
    elements.processButton.classList.add('is-processing');
    elements.processButtonLabel.textContent = 'Working locally…';
    elements.processHint.textContent = 'You can keep this tab open while FFmpeg works.';
  } else {
    elements.processButton.classList.remove('is-processing');
    elements.processButtonLabel.textContent = ready ? 'Burn subtitles' : 'Add both files to continue';
    elements.processHint.textContent = ready
      ? 'The engine runs in a background worker.'
      : 'The engine runs in a background worker.';
  }
  elements.previewName.textContent = state.video?.originalName || 'Waiting for a video';
  updateOutputName();
}

async function handleSelectedFile(slot, file) {
  if (!file) return;
  if (state.processing) return;
  if (slot === 'video' && !isVideoFile(file)) {
    showToast('That does not look like a supported video file.');
    setWorkspaceStatus('Choose an MP4, MKV, MOV, WebM, AVI, M4V, MPEG, or TS video.', 'error');
    return;
  }
  if (slot === 'subtitle' && !isSubtitleFile(file)) {
    showToast('Subwasm accepts SubRip .srt files for this MVP.');
    setWorkspaceStatus('Choose a subtitle file ending in .srt.', 'error');
    return;
  }

  const token = state.selectionToken[slot] + 1;
  state.selectionToken[slot] = token;
  const previous = state[slot];
  state[slot] = {
    original: file,
    originalName: file.name,
    size: file.size,
    phase: 'staging',
    progress: 0,
    sourceLabel: state.opfsAvailable ? 'OPFS local disk' : 'browser memory',
    storageName: slot === 'video' ? `source-video${extensionOf(file.name) || '.bin'}` : 'source-subtitles.srt',
    handle: null,
    mountFile: file,
  };
  await removeOPFSRecord(previous);
  updateDropzone(slot, state[slot]);
  updatePreview();
  updateProcessControls();
  elements.completedOverlay.hidden = true;
  if (state.outputURL) {
    URL.revokeObjectURL(state.outputURL);
    state.outputURL = null;
  }
  setWorkspaceStatus(`Staging ${file.name} locally in bounded chunks…`);

  if (state.opfsAvailable && state.opfsDirectory) {
    const remaining = state.storageEstimate?.quota && state.storageEstimate?.usage
      ? state.storageEstimate.quota - state.storageEstimate.usage
      : null;
    if (remaining && remaining < file.size * 1.05) {
      elements.storageChip.dataset.state = 'warning';
      elements.storageChipLabel.textContent = 'Check free space';
      setWorkspaceStatus('There may not be enough local storage for this source file. You can still try.', 'error');
    }
    try {
      const result = await stageFileInOPFS(file, state[slot].storageName, (progress, written) => {
        if (state.selectionToken[slot] !== token) return;
        state[slot].progress = progress;
        updateDropzone(slot, state[slot]);
        setWorkspaceStatus(`Staging ${file.name} · ${formatBytes(written)} of ${formatBytes(file.size)} written locally…`);
      });
      if (state.selectionToken[slot] !== token) {
        await removeOPFSRecord({ storageName: state[slot].storageName });
        return;
      }
      state[slot].handle = result.handle;
      state[slot].mountFile = result.file;
      state[slot].progress = 1;
      state[slot].phase = 'ready';
      state[slot].sourceLabel = 'OPFS local disk';
    } catch (error) {
      console.error('Could not stage file in OPFS.', error);
      if (state.selectionToken[slot] !== token) return;
      state[slot].phase = 'error';
      updateDropzone(slot, state[slot]);
      updateProcessControls();
      showToast(`Could not stage ${file.name} in local storage. ${error?.message || ''}`.trim());
      setWorkspaceStatus('Local staging failed. Check browser storage permissions or available disk space.', 'error');
      return;
    }
  } else {
    state[slot].phase = 'ready';
    state[slot].progress = 1;
  }

  updateDropzone(slot, state[slot]);
  updateProcessControls();
  const bothReady = state.video?.phase === 'ready' && state.subtitle?.phase === 'ready';
  setWorkspaceStatus(bothReady ? 'Both files are ready. The local engine is standing by.' : `${file.name} is ready. Add the other file to continue.`);
}

function bindDropzone(slot, zone, input) {
  input.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    handleSelectedFile(slot, file);
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'drop'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove('is-dragover');
    });
  });
  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    handleSelectedFile(slot, file);
  });
}

async function createEngine(useThreads) {
  const ffmpeg = new FFmpeg();
  const packageName = useThreads ? '@ffmpeg/core-mt' : '@ffmpeg/core';
  const baseURL = `https://cdn.jsdelivr.net/npm/${packageName}@${CORE_VERSION}/dist/esm`;
  const config = {
    // Keep the ESM URLs direct so the core can resolve its nested pthread
    // worker without a second blob-URL hop. jsDelivr sends the CORS headers
    // needed by the module worker.
    coreURL: `${baseURL}/ffmpeg-core.js`,
    wasmURL: `${baseURL}/ffmpeg-core.wasm`,
  };
  // A pthread worker must be same-origin under COEP. Blob-wrap only this
  // nested worker; keeping the ESM core URL direct avoids the Vite loader
  // edge case that can strand the main FFmpeg worker.
  if (useThreads) config.workerURL = await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript');

  ffmpeg.on('log', ({ message }) => {
    state.lastLog = message;
    state.logLines.push(message);
    if (state.logLines.length > 80) state.logLines.shift();
    const clean = message.replace(/^\s+/, '').replace(/\s+$/, '');
    if (state.processing && clean) {
      const timeMatch = clean.match(/time=(\d+):(\d+):(\d+)(?:[.,](\d+))?/);
      if (timeMatch && state.duration) {
        const seconds = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]) + Number(`0.${timeMatch[4] || 0}`);
        setProgress(Math.min(.99, seconds / state.duration));
      }
      const shortLog = clean.length > 37 ? `${clean.slice(-37)}…` : clean;
      elements.logLabel.textContent = shortLog;
    }
  });
  ffmpeg.on('progress', ({ progress, time }) => {
    if (!state.processing) return;
    if (Number.isFinite(progress) && progress >= 0) setProgress(Math.min(.99, progress));
    if (Number.isFinite(time) && state.duration) setProgress(Math.min(.99, time / 1_000_000 / state.duration));
  });
  const loadPromise = ffmpeg.load(config);
  const timeoutPromise = new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error('FFmpeg core took too long to initialize.')), 20_000);
  });
  await Promise.race([loadPromise, timeoutPromise]);
  return ffmpeg;
}

async function ensureEngine() {
  if (state.ffmpeg?.loaded) return state.ffmpeg;
  if (state.ffmpegLoading) return state.ffmpegLoading;
  // Prefer the faster core only when this origin has the isolation guarantees
  // required by SharedArrayBuffer. The catch below keeps the worker-only
  // single-thread path available for embedded or misconfigured hosts.
  const canThread = window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  state.ffmpegLoading = (async () => {
    setWorkspaceStatus('Loading the local FFmpeg engine…');
    elements.logLabel.textContent = canThread ? 'Loading multi-thread core' : 'Loading single-thread core';
    try {
      state.ffmpeg = await createEngine(canThread);
      state.ffmpegMode = canThread ? 'multi-thread' : 'single-thread';
    } catch (firstError) {
      if (!canThread) throw firstError;
      console.warn('Multi-thread core failed; retrying with the single-thread core.', firstError);
      try { state.ffmpeg?.terminate(); } catch { /* noop */ }
      state.ffmpeg = await createEngine(false);
      state.ffmpegMode = 'single-thread';
    } finally {
      state.ffmpegLoading = null;
    }
    setSignal('signal-worker', 'is-ready', state.ffmpegMode === 'multi-thread' ? 'multi-thread' : 'single-thread');
    return state.ffmpeg;
  })();
  try {
    return await state.ffmpegLoading;
  } catch (error) {
    state.ffmpegLoading = null;
    setSignal('signal-worker', 'is-error', 'failed');
    throw error;
  }
}

async function getDuration(ffmpeg, videoPath) {
  const probePath = '/probe-duration.txt';
  try {
    await ffmpeg.ffprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
      '-o', probePath,
    ]);
    const raw = await ffmpeg.readFile(probePath, 'utf8');
    await ffmpeg.deleteFile(probePath);
    const value = Number.parseFloat(String(raw).trim());
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    try { await ffmpeg.deleteFile(probePath); } catch { /* noop */ }
    console.warn('Unable to probe duration; progress will be approximate.', error);
    return Number.isFinite(elements.videoPreview.duration) ? elements.videoPreview.duration : null;
  }
}

async function mountSourceFiles(ffmpeg) {
  const video = state.video;
  const subtitle = state.subtitle;
  const videoPath = `/media/${video.storageName}`;
  // The video is the large source that must stay disk-backed. Keep the small
  // subtitle text in MEMFS because libass can read it reliably from every
  // FFmpeg execution thread.
  const subtitlePath = '/subtitle.srt';
  try { await ffmpeg.createDir('/media'); } catch { /* directory already exists */ }
  let mounted = false;
  try {
    const result = await ffmpeg.mount(FFFSType.WORKERFS, { files: [video.mountFile] }, '/media');
    if (!result) throw new Error('WORKERFS is not present in this FFmpeg core.');
    mounted = true;
  } catch (mountError) {
    console.warn('WORKERFS mount failed.', mountError);
    if (video.size > MEMORY_FALLBACK_LIMIT) {
      throw new Error('This browser could not mount the large source through WORKERFS. Try a Chromium-based browser with OPFS enabled.');
    }
    setWorkspaceStatus('WORKERFS is unavailable here, using a bounded-file memory fallback…');
    await ffmpeg.writeFile(videoPath, new Uint8Array(await video.mountFile.arrayBuffer()));
  }

  try {
    await ffmpeg.writeFile(subtitlePath, new Uint8Array(await subtitle.mountFile.arrayBuffer()));
  } catch (subtitleError) {
    if (mounted) {
      try { await ffmpeg.unmount('/media'); } catch { /* noop */ }
      mounted = false;
    }
    if (video.size > MEMORY_FALLBACK_LIMIT) {
      throw new Error('The local FFmpeg core could not read the subtitle file. Try a Chromium-based browser with OPFS enabled.');
    }
    console.warn('Subtitle file could not be written beside the source; using the bounded-file memory fallback.', subtitleError);
    setWorkspaceStatus('The local subtitle file needs a memory fallback for this browser…');
    await ffmpeg.writeFile(videoPath, new Uint8Array(await video.mountFile.arrayBuffer()));
  }

  return { videoPath, subtitlePath, mounted };
}

function setProgress(value) {
  state.progress = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const percent = Math.round(state.progress * 100);
  elements.progressFill.style.width = `${percent}%`;
  elements.progressLabel.textContent = `${percent}%`;
}

async function requestDestination(outputName) {
  if (typeof window.showSaveFilePicker !== 'function' || navigator.userActivation?.isActive === false) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName: outputName,
      types: [{ description: 'Subtitled MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    console.warn('Direct save picker was unavailable; using a browser download instead.', error);
    return null;
  }
}

async function saveResult(data, outputName, destination = null) {
  if (destination) {
    try {
      const writable = await destination.createWritable();
      await writable.write(data);
      await writable.close();
      return { direct: true, name: outputName };
    } catch (error) {
      // Some embedded browsers expose the picker but deny writes outside a
      // trusted user gesture. Keep the completed job useful in that case.
      if (error?.name !== 'NotAllowedError' && !/not allowed|permission/i.test(error?.message || '')) throw error;
      console.warn('Direct disk write was denied; falling back to a browser download.', error);
    }
  }

  const blob = new Blob([data], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = outputName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  return { direct: false, name: outputName };
}

async function cleanupFFmpegFiles(ffmpeg, mounted) {
  try { if (mounted) await ffmpeg.unmount('/media'); } catch { /* noop */ }
  try { await ffmpeg.deleteFile('/output.mp4'); } catch { /* noop */ }
  try { await ffmpeg.deleteFile('/probe-duration.txt'); } catch { /* noop */ }
  try { await ffmpeg.deleteFile('/subtitle.srt'); } catch { /* noop */ }
  if (!mounted) {
    try { await ffmpeg.deleteFile(`/media/${state.video?.storageName}`); } catch { /* noop */ }
  }
}

async function processVideo() {
  if (state.processing || state.video?.phase !== 'ready' || state.subtitle?.phase !== 'ready') return;
  const outputName = updateOutputName();
  let ffmpeg;
  let mountInfo;
  let outputData;
  let destination = null;
  state.processing = true;
  state.duration = null;
  state.lastLog = '';
  state.logLines = [];
  elements.processingOverlay.hidden = false;
  elements.completedOverlay.hidden = true;
  elements.processingTitle.textContent = 'Burning subtitles';
  elements.processingDetail.textContent = 'FFmpeg is working locally in a background worker…';
  elements.logLabel.textContent = 'Preparing worker';
  setProgress(0);
  updateProcessControls();
  setWorkspaceStatus('Preparing a private local processing job…');

  try {
    // Request the destination while the Process button's user activation is
    // still alive. The actual encode can take minutes for a large source.
    destination = await requestDestination(outputName);
    ffmpeg = await ensureEngine();
    setWorkspaceStatus(`Mounting ${formatBytes(state.video.size)} from local storage without copying it into WASM memory…`);
    mountInfo = await mountSourceFiles(ffmpeg);
    state.duration = await getDuration(ffmpeg, mountInfo.videoPath);
    // Keep the filter expression intentionally small so it parses predictably
    // across FFmpeg WebAssembly cores. libass supplies the default style.
    const subtitleFilter = `subtitles=${mountInfo.subtitlePath}`;
    const args = [
      '-nostdin',
      '-y',
      '-i', mountInfo.videoPath,
      '-vf', subtitleFilter,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '/output.mp4',
    ];
    setWorkspaceStatus('Burning captions frame by frame. Nothing is uploaded.');
    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      const logTail = state.logLines.slice(-6).join(' ').replace(/\s+/g, ' ').trim();
      throw new Error(`FFmpeg exited with code ${exitCode}. ${logTail || 'The command did not complete.'}`);
    }
    setProgress(1);
    elements.processingTitle.textContent = 'Finishing the file';
    elements.processingDetail.textContent = 'Writing the finished video back to your device…';
    outputData = await ffmpeg.readFile('/output.mp4');
    if (!(outputData instanceof Uint8Array) || outputData.byteLength === 0) {
      throw new Error('FFmpeg returned an empty output file. The source codec or subtitle track may not be supported by this core.');
    }
    console.info(`Subwasm produced ${formatBytes(outputData.byteLength)} of MP4 output.`);
    const result = await saveResult(outputData, outputName, destination);
    if (state.outputURL) URL.revokeObjectURL(state.outputURL);
    state.outputURL = URL.createObjectURL(new Blob([outputData], { type: 'video/mp4' }));
    elements.videoPreview.src = state.outputURL;
    elements.videoPreview.load();
    elements.completedOverlay.hidden = false;
    elements.completedDetail.textContent = result.direct
      ? `${outputName} was saved directly to your chosen location.`
      : `${outputName} was downloaded to your browser's downloads.`;
    setWorkspaceStatus(result.direct ? `Saved ${outputName} directly to disk.` : `Downloaded ${outputName}.`, 'success');
    elements.processingOverlay.hidden = true;
  } catch (error) {
    if (error?.name === 'AbortError') {
      elements.processingOverlay.hidden = true;
      setWorkspaceStatus('Save cancelled. Your source files are still local and ready.', 'error');
    } else {
      console.error('Subtitle burn failed.', error);
      elements.processingOverlay.hidden = true;
      const message = error?.message || 'FFmpeg could not complete this file.';
      showToast(message);
      setWorkspaceStatus('The local job stopped before producing an output file. See the message for details.', 'error');
    }
  } finally {
    try {
      if (ffmpeg && mountInfo) await cleanupFFmpegFiles(ffmpeg, mountInfo.mounted);
    } catch (cleanupError) {
      console.warn('Could not clean temporary FFmpeg files.', cleanupError);
    }
    state.processing = false;
    updateProcessControls();
  }
}

function clearFiles() {
  if (state.processing) return;
  removeOPFSRecord(state.video);
  removeOPFSRecord(state.subtitle);
  state.video = null;
  state.subtitle = null;
  state.selectionToken.video += 1;
  state.selectionToken.subtitle += 1;
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  if (state.outputURL) URL.revokeObjectURL(state.outputURL);
  state.previewURL = null;
  state.outputURL = null;
  updateDropzone('video', null);
  updateDropzone('subtitle', null);
  updatePreview();
  updateProcessControls();
  elements.completedOverlay.hidden = true;
  setWorkspaceStatus('Pick a video and an .srt file to get started.');
}

function bindEvents() {
  bindDropzone('video', elements.videoDropzone, elements.videoInput);
  bindDropzone('subtitle', elements.subtitleDropzone, elements.subtitleInput);
  elements.processButton.addEventListener('click', processVideo);
  elements.toastClose.addEventListener('click', () => { elements.toast.hidden = true; });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    if (!event.target.closest('.dropzone')) event.preventDefault();
  });
}

async function init() {
  updateRuntimeSignals();
  bindEvents();
  updateDropzone('video', null);
  updateDropzone('subtitle', null);
  updatePreview();
  updateProcessControls();
  await prepareOPFS();
}

init();
