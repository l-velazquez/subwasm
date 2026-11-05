import './style.css';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { MAX_SUBTITLE_SIZE, decodeSubtitle, parseSRT, shiftCues, formatTime, serializeSRT } from './subtitles.js';
import { getTranscriptPage } from './transcript.js';
import { LANGUAGES, guessLanguage, validOffset, buildMuxArgs } from './media-export.js';

const CORE_VERSION = '0.12.10';
const CHUNK_SIZE = 8 * 1024 * 1024;
const MEMORY_FALLBACK_LIMIT = 512 * 1024 * 1024;
const SESSION_ID = crypto.randomUUID();
const elements = Object.fromEntries([
  'video-input', 'subtitle-input', 'video-dropzone', 'subtitle-dropzone', 'video-file-state', 'subtitle-file-state',
  'video-preview', 'preview-stage', 'stage-empty', 'preview-name', 'video-details', 'preview-badge', 'preview-description', 'preview-error',
  'caption-layer', 'caption-text', 'caption-offset', 'export-format', 'format-help', 'format-chip',
  'cue-summary', 'cue-list', 'output-name', 'process-button', 'process-button-label', 'process-hint',
  'storage-chip', 'storage-chip-label', 'runtime-summary', 'workspace-status', 'status-text',
  'processing-overlay', 'processing-title', 'processing-detail', 'progress-track', 'progress-fill', 'progress-label', 'log-label', 'cancel-button',
  'result-card', 'completed-detail', 'download-link', 'clear-button', 'demo-button', 'demo-label', 'toast', 'toast-message', 'toast-close',
  'preview-demo-button', 'step-files', 'step-style', 'step-export', 'step-files-detail', 'step-style-detail', 'step-export-detail',
  'caption-search', 'transcript-tools', 'transcript-pagination', 'caption-page-status', 'caption-page-prev', 'caption-page-next',
  'offset-earlier', 'offset-later', 'offset-reset', 'offset-error',
  'track-editor', 'track-select', 'track-language', 'track-title', 'remove-track', 'preview-captions', 'existing-track-summary', 'existing-track-list',
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

const state = {
  video: null, subtitle: null, tracks: [], sourceStreams: null, cues: [], shiftedCues: [], activeCues: '',
  settings: { format: 'mkv' },
  ffmpeg: null, engineCandidate: null, ffmpegLoading: null, ffmpegMode: null,
  storageReady: null, opfsDirectory: null, storageRoot: null,
  selectionToken: { video: 0, subtitle: 0 }, validationToken: { video: 0, subtitle: 0 }, validating: { video: false, subtitle: false }, previewURL: null, outputURL: null, outputBlob: null, outputName: null,
  processing: false, controller: null, saving: false, demoLoading: false, demoToken: 0,
  duration: null, progress: 0, encoding: false, logLines: [], toastTimer: null,
  transcriptPage: 0, transcriptPageCount: 1,
};
const engineAssets = new WeakMap();

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

function extensionOf(name) { return String(name).toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] || ''; }
function basenameOf(name) { return String(name).replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'video'; }
function isVideoFile(file) { return file.type.startsWith('video/') || ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.mpeg', '.mpg', '.ts'].includes(extensionOf(file.name)); }

function setStatus(message, kind = '') {
  elements.statusText.textContent = message;
  elements.workspaceStatus.classList.toggle('is-error', kind === 'error');
  elements.workspaceStatus.classList.toggle('is-success', kind === 'success');
}

function showToast(message) {
  elements.toastMessage.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 9000);
}

function setSignal(id, kind, label) {
  const signal = document.getElementById(id);
  signal.className = `signal ${kind ? `is-${kind}` : ''}`;
  signal.querySelector('strong').textContent = label;
}

async function prepareStorage() {
  const hasJSPI = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
  setSignal('signal-jspi', '', hasJSPI ? 'available · unused' : 'not required');
  setSignal('signal-worker', typeof Worker === 'function' ? '' : 'error', typeof Worker === 'function' ? 'loads on export' : 'unavailable');
  try {
    if (typeof navigator.storage?.getDirectory !== 'function') throw new Error('OPFS is unavailable.');
    const root = await navigator.storage.getDirectory();
    state.storageRoot = await root.getDirectoryHandle('subtitle-forge', { create: true });
    state.opfsDirectory = await state.storageRoot.getDirectoryHandle(SESSION_ID, { create: true });
    elements.storageChipLabel.textContent = 'Local disk ready';
    setSignal('signal-opfs', 'ready', 'disk staging ready');
    elements.runtimeSummary.textContent = 'Video is staged in chunks on local disk. The FFmpeg engine loads when you export.';
  } catch {
    state.opfsDirectory = null;
    elements.storageChip.dataset.state = 'warning';
    elements.storageChipLabel.textContent = 'Memory fallback';
    setSignal('signal-opfs', 'warning', 'memory fallback');
    elements.runtimeSummary.textContent = 'Local disk staging is unavailable. Files up to 512 MB can use the memory fallback.';
  }
}

async function removeRecord(record) {
  if (!record?.storageName || !state.opfsDirectory) return;
  try { await state.opfsDirectory.removeEntry(record.storageName); } catch { /* Already removed or still being written. */ }
}

async function stageFile(file, record, slot, token) {
  const handle = await state.opfsDirectory.getFileHandle(record.storageName, { create: true });
  const writable = await handle.createWritable();
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      if (state.selectionToken[slot] !== token) throw new DOMException('File replaced.', 'AbortError');
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      await writable.write(await file.slice(offset, end).arrayBuffer());
      record.progress = end / file.size;
      if (state.selectionToken[slot] === token) updateDropzone(slot);
    }
    await writable.close();
    return await handle.getFile();
  } catch (error) {
    try { await writable.abort(); } catch { /* The stream may already be closed. */ }
    await removeRecord(record);
    throw error;
  }
}

function updateDropzone(slot) {
  if (slot === 'subtitle') {
    const count = state.tracks.length;
    const zone = elements.subtitleDropzone;
    zone.classList.toggle('has-file', count > 0);
    zone.querySelector('.drop-copy strong').textContent = count ? `${count} subtitle ${count === 1 ? 'track' : 'tracks'} added` : 'Add subtitle languages';
    zone.querySelector('.drop-copy small').textContent = 'Add one or more .srt files · existing tracks stay';
    zone.querySelector('.choose-link').textContent = count ? 'Add more ↗' : 'Browse ↗';
    elements.subtitleFileState.textContent = state.validating.subtitle ? 'Checking subtitle files…' : count ? 'Choose a track below to label its language.' : '';
    return;
  }
  const record = state[slot];
  const zone = elements[`${slot}Dropzone`];
  const copy = zone.querySelector('.drop-copy');
  zone.classList.toggle('has-file', record?.phase === 'ready');
  zone.classList.toggle('is-staging', record?.phase === 'staging');
  zone.querySelector('.choose-link').textContent = record ? 'Replace ↗' : 'Browse ↗';
  copy.querySelector('strong').textContent = record?.originalName || (slot === 'video' ? 'Drop your video here' : 'Drop your subtitles here');
  copy.querySelector('small').textContent = record ? `${formatBytes(record.size)} · ${record.sourceLabel}`
    : slot === 'video' ? 'MP4, MOV, MKV, WebM & more' : 'SubRip file (.srt)';
  elements[`${slot}FileState`].textContent = !record ? '' : record.phase === 'staging' ? `Preparing ${Math.round(record.progress * 100)}%`
    : record.phase === 'ready' ? slot === 'subtitle' ? `${state.cues.length} captions · ready ✓` : 'Ready ✓' : 'Could not prepare · replace to retry';
}

function invalidateOutput() {
  if (state.outputURL) URL.revokeObjectURL(state.outputURL);
  state.outputURL = null;
  state.outputName = null;
  state.outputBlob = null;
  elements.resultCard.hidden = true;
  elements.downloadLink.removeAttribute('href');
}

function loadSourcePreview() {
  elements.previewError.hidden = true;
  elements.previewBadge.textContent = 'SOURCE PREVIEW';
  elements.previewDescription.textContent = 'Preview an added language here. Subtitle appearance in the exported file is controlled by your player.';
  elements.stageEmpty.hidden = Boolean(state.video);
  elements.previewStage.classList.toggle('has-video', Boolean(state.video));
  if (state.previewURL) URL.revokeObjectURL(state.previewURL);
  state.previewURL = state.video ? URL.createObjectURL(state.video.original) : null;
  if (state.previewURL) elements.videoPreview.src = state.previewURL;
  else elements.videoPreview.removeAttribute('src');
  elements.videoPreview.load();
  elements.videoDetails.textContent = 'Source resolution preserved';
  state.activeCues = '';
  updateCaption();
}

function updateOutputName() {
  const name = `${basenameOf(state.video?.originalName || 'video')}-subtitled.${state.settings.format}`;
  elements.outputName.textContent = name;
  elements.outputName.title = name;
  return name;
}

function syncControls() {
  const videoReady = state.video?.phase === 'ready';
  const subtitleReady = state.tracks.length > 0;
  const validTiming = elements.captionOffset.validity.valid;
  const tracksValid = state.tracks.every((track) => validOffset(track.offsetInput) && shiftCues(track.cues, track.offset).length > 0);
  const ready = videoReady && subtitleReady && validTiming && tracksValid && typeof Worker === 'function';
  const validating = state.validating.video || state.validating.subtitle;
  const locked = state.processing || state.saving;
  elements.offsetError.hidden = validTiming;
  elements.captionOffset.setAttribute('aria-invalid', String(!validTiming));
  elements.offsetEarlier.disabled = locked || !subtitleReady || !validTiming || Number(elements.captionOffset.value) <= -600;
  elements.offsetLater.disabled = locked || !subtitleReady || !validTiming || Number(elements.captionOffset.value) >= 600;
  elements.offsetReset.disabled = locked || !subtitleReady || (validTiming && Number(elements.captionOffset.value) === 0);
  for (const field of [elements.trackSelect, elements.trackLanguage, elements.trackTitle, elements.removeTrack]) field.disabled = locked || !subtitleReady;
  elements.previewCaptions.disabled = state.processing || !subtitleReady;
  elements.trackEditor.hidden = !subtitleReady;
  elements.captionSearch.disabled = state.processing;
  elements.previewDemoButton.disabled = state.processing || state.demoLoading || state.saving;
  elements.previewDemoButton.lastChild.textContent = state.demoLoading ? ' Loading sample…' : ' Try the sample video';
  const currentStep = !videoReady || !subtitleReady ? 0 : state.processing || state.outputURL ? 2 : 1;
  [elements.stepFiles, elements.stepStyle, elements.stepExport].forEach((step, index) => {
    step.dataset.state = index < currentStep || (index === 2 && state.outputURL) ? 'complete' : index === currentStep ? 'current' : 'pending';
    if (index === currentStep) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  elements.stepFilesDetail.textContent = videoReady && subtitleReady ? `${state.tracks.length} new language tracks ready` : videoReady ? 'Add your .srt subtitles' : subtitleReady ? 'Add your video' : 'Video + .srt language tracks';
  elements.stepStyleDetail.textContent = !tracksValid || !validTiming ? 'Check track timing' : state.processing || state.outputURL ? 'Languages and timing applied' : 'Label languages and check timing';
  elements.stepExportDetail.textContent = state.processing ? 'Adding subtitle tracks…' : state.outputURL ? 'Your video is ready to save' : 'Save with selectable subtitles';
  elements.processButton.disabled = !ready || state.processing || state.demoLoading || state.saving || validating;
  elements.processButton.classList.toggle('is-processing', state.processing);
  elements.processButtonLabel.textContent = state.processing ? 'Exporting on your device…' : validating ? 'Checking your files…' : ready ? 'Add subtitle tracks & export' : !videoReady && !subtitleReady ? 'Add your files to continue' : !videoReady ? 'Add a video to continue' : !subtitleReady ? 'Add subtitles to continue' : 'Check subtitle track timing';
  elements.processHint.textContent = state.processing ? 'Keep this tab open while your video exports.' : !videoReady || !subtitleReady ? 'Add a video and one or more .srt subtitle files.' : !validTiming || !tracksValid ? 'Each track needs valid timing and at least one caption after time zero. Check each track above.' : 'Existing subtitles are kept. New languages are added as selectable tracks.';
  elements.clearButton.disabled = state.processing || state.saving || (!state.video && !state.subtitle && !state.demoLoading && !validating);
  elements.demoButton.disabled = state.processing || state.demoLoading || state.saving;
  elements.videoInput.disabled = state.processing || state.demoLoading || state.saving;
  elements.subtitleInput.disabled = state.processing || state.demoLoading || state.saving || state.validating.subtitle;
  elements.videoDropzone.setAttribute('aria-disabled', String(state.processing || state.demoLoading || state.saving));
  elements.subtitleDropzone.setAttribute('aria-disabled', String(elements.subtitleInput.disabled));
  elements.captionOffset.disabled = locked || !subtitleReady;
  elements.exportFormat.disabled = locked;
  elements.formatChip.textContent = state.settings.format.toUpperCase();
  elements.formatHelp.textContent = state.settings.format === 'mkv' ? 'MKV keeps existing subtitle formats and fonts. Play it in VLC or another player with subtitle selection.' : 'MP4 converts text subtitles to selectable timed text. Image-based subtitles need MKV. Source video and audio must be MP4-compatible.';
  elements.downloadLink.setAttribute('aria-disabled', String(state.saving));
  for (const button of elements.cueList.querySelectorAll('button')) button.disabled = state.processing || !state.video;
  elements.captionPagePrev.disabled = state.processing || state.transcriptPage === 0;
  elements.captionPageNext.disabled = state.processing || state.transcriptPage >= state.transcriptPageCount - 1;
  elements.previewName.textContent = state.video?.originalName || 'Waiting for your video';
  elements.previewName.title = elements.previewName.textContent;
  updateOutputName();
}

function renderTranscript() {
  state.shiftedCues = shiftCues(state.cues, state.subtitle?.offset || 0);
  let lastEnd = 0;
  state.cueEndPrefix = state.shiftedCues.map((cue) => { lastEnd = Math.max(lastEnd, cue.end); return lastEnd; });
  renderCaptionRows();
  positionCaption();
}

function renderCaptionRows() {
  state.activeCues = null;
  elements.cueList.replaceChildren();
  elements.transcriptTools.hidden = !state.cues.length;
  elements.transcriptPagination.hidden = !state.cues.length;
  const result = getTranscriptPage(state.shiftedCues, elements.captionSearch.value, state.transcriptPage);
  state.transcriptPage = result.page;
  state.transcriptPageCount = result.pageCount;
  const first = result.start + 1;
  const last = result.start + result.entries.length;
  const range = first === last ? String(first) : `${first}–${last}`;
  const noun = elements.captionSearch.value.trim() ? result.total === 1 ? 'match' : 'matches' : result.total === 1 ? 'caption' : 'captions';
  elements.captionPageStatus.textContent = result.total ? `${range} of ${result.total} ${noun}` : 'No matching captions';
  if (!state.cues.length) {
    const empty = document.createElement('p');
    empty.className = 'transcript-empty';
    empty.textContent = 'Your captions will appear here. Select a line to jump to it.';
    elements.cueList.append(empty);
    elements.cueSummary.textContent = 'No subtitles yet';
  } else {
    elements.cueSummary.textContent = `${state.shiftedCues.length} captions · ${formatTime(state.cueEndPrefix.at(-1) || 0)}`;
    for (const { index, cue } of result.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cue-button';
      button.dataset.index = index;
      button.setAttribute('aria-label', `Seek to ${formatTime(cue.start)}: ${cue.text}`);
      const time = document.createElement('time');
      time.textContent = formatTime(cue.start);
      const text = document.createElement('span');
      text.textContent = cue.text;
      button.append(time, text);
      button.addEventListener('click', () => {
        if (!state.video || state.processing) return;
        const duration = elements.videoPreview.duration;
        elements.videoPreview.currentTime = Number.isFinite(duration) ? Math.min(cue.start + .001, Math.max(0, duration - .001)) : cue.start + .001;
        updateCaption();
        elements.videoPreview.focus();
      });
      elements.cueList.append(button);
    }
    if (!result.entries.length) {
      const note = document.createElement('p');
      note.className = 'transcript-empty';
      note.textContent = !state.shiftedCues.length ? 'This adjustment moves every caption before the video starts. Try a later time.' : 'No captions match your search. Try another word or clear the search.';
      elements.cueList.append(note);
    }
  }
  updateCaption();
  syncControls();
}

function positionCaption() {
  const video = elements.videoPreview;
  const stage = elements.previewStage;
  if (!video.videoWidth || !video.videoHeight) return;
  const ratio = Math.min(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight);
  const width = video.videoWidth * ratio;
  const height = video.videoHeight * ratio;
  Object.assign(elements.captionLayer.style, {
    left: `${(stage.clientWidth - width) / 2}px`, top: `${(stage.clientHeight - height) / 2}px`,
    width: `${width}px`, height: `${height}px`, padding: `${height * 20 / 288}px ${width * .045}px`,
    fontSize: `${height * 16 / 288}px`,
    color: '#ffffff',
  });
}

function updateCaption() {
  const time = elements.videoPreview.currentTime || 0;
  let low = 0;
  let high = state.shiftedCues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (state.shiftedCues[mid].start <= time) low = mid + 1;
    else high = mid;
  }
  const active = [];
  for (let index = low - 1; index >= 0 && state.cueEndPrefix[index] > time; index -= 1) {
    const cue = state.shiftedCues[index];
    if (time < cue.end) active.unshift({ cue, index });
  }
  const key = active.map(({ index }) => index).join(',');
  if (key !== state.activeCues) {
    state.activeCues = key;
    elements.captionText.textContent = active.map(({ cue }) => cue.text).join('\n');
    for (const button of elements.cueList.querySelectorAll('.cue-button')) {
      const selected = active.some(({ index }) => String(index) === button.dataset.index);
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-current', String(selected));
    }
  }
  elements.captionLayer.hidden = !active.length || !state.video || !elements.previewCaptions.checked || !elements.previewError.hidden;
}

function markExportChanged() {
  if (!state.outputURL) return;
  invalidateOutput();
  elements.previewDescription.textContent = 'Preview an added language here. Subtitle appearance in the exported file is controlled by your player.';
  setStatus('Subtitle tracks changed. Export again to save the updated video.');
}

function renderTrackOptions() {
  elements.trackSelect.replaceChildren(...state.tracks.map((track) => new Option(`${track.title} · ${track.cues.length} captions`, track.id)));
  elements.trackSelect.value = state.subtitle?.id || '';
  updateDropzone('subtitle');
}

function selectTrack(track) {
  state.subtitle = track || null;
  state.cues = track?.cues || [];
  elements.trackSelect.value = track?.id || '';
  elements.trackLanguage.value = track?.language || 'und';
  elements.trackTitle.value = track?.title || '';
  elements.captionOffset.value = track?.offsetInput ?? '0';
  state.transcriptPage = 0; elements.captionSearch.value = '';
  renderTranscript();
}

async function addSubtitles(files) {
  if (!files.length || state.processing || state.saving || state.validating.subtitle) return;
  const token = ++state.validationToken.subtitle;
  state.validating.subtitle = true;
  updateDropzone('subtitle'); syncControls();
  let lastTrack;
  const errors = [];
  try {
    for (const file of files) {
      try {
        if (extensionOf(file.name) !== '.srt' || !file.size || file.size > MAX_SUBTITLE_SIZE) throw new Error('Choose a nonempty .srt file up to 5 MB.');
        const cues = parseSRT(decodeSubtitle(await file.arrayBuffer()));
        if (state.validationToken.subtitle !== token) return;
        const track = { id: crypto.randomUUID(), originalName: file.name, cues, offset: 0, offsetInput: '0', language: guessLanguage(file.name), title: basenameOf(file.name).slice(0, 80), phase: 'ready' };
        state.tracks.push(track);
        lastTrack = track;
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    if (state.validationToken.subtitle !== token) return;
    if (lastTrack) { markExportChanged(); state.subtitle = lastTrack; renderTrackOptions(); selectTrack(lastTrack); }
    if (errors.length) { showToast(errors.join(' ')); setStatus(errors.join(' '), 'error'); }
    else setStatus(`${state.tracks.length} new subtitle tracks ready. Label their languages, then export to add them alongside the existing subtitles.`);
  } finally {
    if (state.validationToken.subtitle === token) { state.validating.subtitle = false; updateDropzone('subtitle'); syncControls(); }
  }
}

async function selectFile(slot, file) {
  if (slot === 'subtitle') return addSubtitles(file ? [file] : []);
  if (!file || state.processing || state.saving) return;
  if (!file.size || !isVideoFile(file)) {
    const message = !file.size ? 'This file is empty. Choose a file with content.' : 'Choose an MP4, MOV, MKV, WebM, AVI, M4V, MPEG, or TS video.';
    showToast(message); setStatus(message, 'error'); return;
  }
  const validationToken = ++state.validationToken[slot];
  state.validating[slot] = true;
  syncControls();
  try {
    await state.storageReady;
    if (state.validationToken[slot] !== validationToken || state.processing || state.saving) return;
    if (!state.opfsDirectory && file.size > MEMORY_FALLBACK_LIMIT) throw new Error('Local disk storage is unavailable. Choose a video smaller than 512 MB or use a browser with local disk support.');
  } catch (error) {
    if (state.validationToken[slot] !== validationToken) return;
    showToast(error.message); setStatus(error.message, 'error'); return;
  } finally {
    if (state.validationToken[slot] === validationToken) { state.validating[slot] = false; syncControls(); }
  }
  const token = ++state.selectionToken[slot];
  const previous = state[slot];
  const record = {
    original: file, originalName: file.name, size: file.size, phase: 'staging', progress: 0,
    sourceLabel: state.opfsDirectory ? 'local disk' : 'browser memory',
    storageName: `${slot}-${token}${extensionOf(file.name)}`, mountFile: file,
  };
  state[slot] = record;
  invalidateOutput();
  state.sourceStreams = null;
  renderExistingTracks();
  loadSourcePreview();
  updateDropzone(slot);
  syncControls();
  setStatus(`Preparing ${file.name} on your device…`);
  await removeRecord(previous);
  try {
    if (state.opfsDirectory) record.mountFile = await stageFile(file, record, slot, token);
    if (state.selectionToken[slot] !== token) { await removeRecord(record); return; }
    record.phase = 'ready';
    record.progress = 1;
    updateDropzone(slot);
    syncControls();
    const ready = state.video?.phase === 'ready' && state.tracks.length > 0;
    setStatus(ready ? 'Files are ready. Check each language track, then export.' : `${file.name} is ready. Add your ${slot === 'video' ? 'subtitle track' : 'video'} to continue.`);
  } catch (error) {
    if (state.selectionToken[slot] !== token) return;
    record.phase = 'error';
    updateDropzone(slot); syncControls();
    const message = error.name === 'QuotaExceededError' ? 'There isn’t enough browser storage for this file. Free some space or choose a smaller video.' : `Could not prepare ${file.name}. Check available storage, then replace the file to retry.`;
    showToast(message); setStatus(message, 'error');
  }
}

function bindDropzone(slot) {
  const zone = elements[`${slot}Dropzone`];
  const input = elements[`${slot}Input`];
  input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; void (slot === 'subtitle' ? addSubtitles(files) : selectFile(slot, files[0])); });
  for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    zone.addEventListener(name, (event) => {
      event.preventDefault(); event.stopPropagation();
      zone.classList.toggle('is-dragover', !state.processing && !state.demoLoading && !state.saving && ['dragenter', 'dragover'].includes(name));
      if (name === 'drop' && !input.disabled) {
        const files = Array.from(event.dataTransfer?.files || []);
        void (slot === 'subtitle' ? addSubtitles(files) : selectFile(slot, files[0]));
      }
    });
  }
}

function terminateEngine(ffmpeg) {
  if (!ffmpeg) return;
  ffmpeg.terminate();
  for (const url of engineAssets.get(ffmpeg) || []) URL.revokeObjectURL(url);
  engineAssets.delete(ffmpeg);
}

async function createEngine(useThreads, signal) {
  const ffmpeg = new FFmpeg();
  const urls = [];
  engineAssets.set(ffmpeg, urls);
  state.engineCandidate = ffmpeg;
  const base = `https://cdn.jsdelivr.net/npm/${useThreads ? '@ffmpeg/core-mt' : '@ffmpeg/core'}@${CORE_VERSION}/dist/esm`;
  const config = { coreURL: `${base}/ffmpeg-core.js`, wasmURL: `${base}/ffmpeg-core.wasm` };
  let timer;
  try {
    if (useThreads) {
      const response = await fetch(`${base}/ffmpeg-core.worker.js`, { signal });
      if (!response.ok) throw new Error('Could not download the FFmpeg worker.');
      config.workerURL = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
      urls.push(config.workerURL);
    }
    signal.throwIfAborted();
    ffmpeg.on('log', ({ message }) => {
      if (!state.processing || signal.aborted || !state.encoding) return;
      state.logLines.push(message);
      if (state.logLines.length > 80) state.logLines.shift();
      const match = message.match(/time=(\d+):(\d+):(\d+(?:[.,]\d+)?)/);
      if (match && state.duration) setProgress(Math.min(.95, (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3].replace(',', '.'))) / state.duration * .95));
    });
    ffmpeg.on('progress', ({ progress, time }) => {
      if (!state.processing || !state.encoding) return;
      if (state.duration && Number.isFinite(time)) setProgress(Math.min(.95, time / 1_000_000 / state.duration * .95));
      else if (Number.isFinite(progress)) setProgress(Math.min(.95, Math.max(0, progress) * .95));
    });
    await Promise.race([
      ffmpeg.load(config, { signal }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The engine download timed out. Check your connection and try again.')), 120_000); }),
    ]);
    signal.throwIfAborted();
    // Some embedded browsers can initialize the pthread core but fail when
    // the first command actually starts. Exercise it before choosing a core.
    if (await ffmpeg.exec(['-version']) !== 0) throw new Error('The FFmpeg engine did not pass its startup check.');
    signal.throwIfAborted();
    return ffmpeg;
  } catch (error) {
    terminateEngine(ffmpeg);
    throw error;
  } finally {
    clearTimeout(timer);
    if (state.engineCandidate === ffmpeg) state.engineCandidate = null;
  }
}

async function ensureEngine(signal) {
  if (state.ffmpeg?.loaded) return state.ffmpeg;
  const canThread = window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  state.ffmpegLoading = (async () => {
    setSignal('signal-worker', '', 'downloading');
    try {
      state.ffmpeg = await createEngine(canThread, signal);
      state.ffmpegMode = canThread ? 'multi-thread' : 'single-thread';
    } catch (error) {
      if (!canThread || signal.aborted) throw error;
      elements.processingDetail.textContent = 'Starting the compatible single-thread engine…';
      state.ffmpeg = await createEngine(false, signal);
      state.ffmpegMode = 'single-thread';
    }
    setSignal('signal-worker', 'ready', state.ffmpegMode);
    return state.ffmpeg;
  })();
  try { return await state.ffmpegLoading; }
  finally { state.ffmpegLoading = null; }
}

async function mountSources(ffmpeg) {
  const video = state.video;
  const videoPath = `/media/${video.storageName}`;
  try { await ffmpeg.createDir('/media'); } catch { /* Directory exists. */ }
  let mounted = false;
  try {
    // WORKERFS filenames must match the chosen virtual path, even when the
    // original File or an OPFS fallback carries a different name.
    mounted = await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: video.storageName, data: video.mountFile }] }, '/media');
  } catch { /* Use the bounded memory fallback below. */ }
  try {
    if (!mounted) {
      if (video.size > MEMORY_FALLBACK_LIMIT) throw new Error('The engine could not read this large video from disk. Try a smaller source or another Chromium browser.');
      await ffmpeg.writeFile(videoPath, new Uint8Array(await video.mountFile.arrayBuffer()));
    }
    for (const [index, track] of state.tracks.entries()) {
      await ffmpeg.writeFile(`/subtitle-${index}.srt`, new TextEncoder().encode(serializeSRT(track.cues, track.offset)));
    }
    return { videoPath, mounted };
  } catch (error) {
    await cleanupEngineFiles(ffmpeg, { videoPath, mounted });
    throw error;
  }
}

async function inspectSource(ffmpeg, videoPath) {
  const code = await ffmpeg.ffprobe(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath, '-o', '/source-info.json']);
  if (code !== 0) throw new Error('Could not inspect the existing tracks. Export stopped so no subtitles are accidentally discarded.');
  const info = JSON.parse(await ffmpeg.readFile('/source-info.json', 'utf8'));
  if (!Array.isArray(info.streams) || !info.streams.some((stream) => stream.codec_type === 'video')) throw new Error('This file has no readable video stream.');
  state.sourceStreams = info.streams;
  renderExistingTracks();
  const duration = Number(info.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function verifySubtitleCount(ffmpeg, outputPath) {
  const code = await ffmpeg.ffprobe(['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'json', outputPath, '-o', '/output-info.json']);
  if (code !== 0) throw new Error('Could not verify the finished subtitle tracks. Please try exporting again.');
  const info = JSON.parse(await ffmpeg.readFile('/output-info.json', 'utf8'));
  const expected = state.sourceStreams.filter((stream) => stream.codec_type === 'subtitle').length + state.tracks.length;
  if (info.streams?.length !== expected) throw new Error('The finished file did not contain every expected subtitle track. Export stopped to avoid losing a language.');
}

function renderExistingTracks() {
  const existing = state.sourceStreams?.filter((stream) => stream.codec_type === 'subtitle');
  elements.existingTrackSummary.textContent = existing ? `${existing.length} existing subtitle ${existing.length === 1 ? 'track' : 'tracks'} found. All will be kept alongside your new languages.` : 'Existing subtitle tracks are kept. They’re checked when you export.';
  elements.existingTrackList.hidden = !existing?.length;
  elements.existingTrackList.replaceChildren(...(existing || []).map((stream) => {
    const row = document.createElement('li');
    row.textContent = `${stream.tags?.title || 'Existing track'} · ${stream.tags?.language || 'unspecified'} · ${stream.codec_name}`;
    return row;
  }));
}

function setProgress(value, reset = false) {
  state.progress = reset ? 0 : Math.max(state.progress, Math.min(1, value));
  const percent = Math.floor(state.progress * 100);
  elements.progressFill.style.width = `${percent}%`;
  elements.progressLabel.textContent = `${percent}%`;
  elements.progressTrack.setAttribute('aria-valuenow', percent);
}

async function cleanupEngineFiles(ffmpeg, mount) {
  if (!ffmpeg?.loaded) return;
  if (mount?.mounted) { try { await ffmpeg.unmount('/media'); } catch { /* Mount was removed. */ } }
  for (const path of ['/output.mp4', '/output.mkv', '/source-info.json', '/output-info.json', ...state.tracks.map((_, index) => `/subtitle-${index}.srt`), !mount?.mounted && mount?.videoPath].filter(Boolean)) {
    try { await ffmpeg.deleteFile(path); } catch { /* File was not created. */ }
  }
}

async function processVideo() {
  if (elements.processButton.disabled || state.processing) return;
  const outputName = updateOutputName();
  state.controller = new AbortController();
  const { signal } = state.controller;
  state.processing = true; state.encoding = false; state.duration = null; state.logLines = [];
  elements.videoPreview.pause();
  invalidateOutput();
  elements.processingOverlay.hidden = false;
  elements.processingTitle.textContent = 'Starting your local engine';
  elements.processingDetail.textContent = 'First export downloads the engine. Your files stay on your device.';
  elements.logLabel.textContent = 'Preparing';
  elements.cancelButton.disabled = false;
  setProgress(0, true); syncControls();
  setStatus('Loading the engine on your device…');
  let ffmpeg;
  let mount;
  let succeeded = false;
  try {
    ffmpeg = await ensureEngine(signal);
    signal.throwIfAborted();
    elements.processingTitle.textContent = 'Preparing your captions';
    elements.processingDetail.textContent = 'Checking existing subtitles and applying each new track’s timing.';
    mount = await mountSources(ffmpeg);
    signal.throwIfAborted();
    state.duration = await inspectSource(ffmpeg, mount.videoPath);
    signal.throwIfAborted();
    elements.processingTitle.textContent = 'Adding your language tracks';
    elements.processingDetail.textContent = 'Keeping existing subtitles and copying your video and audio without re-encoding.';
    elements.logLabel.textContent = state.ffmpegMode;
    state.encoding = true;
    setStatus('Adding selectable subtitles on your device. Keep this tab open.');
    const code = await ffmpeg.exec(buildMuxArgs({ videoPath: mount.videoPath, tracks: state.tracks, sourceStreams: state.sourceStreams, format: state.settings.format }));
    state.encoding = false;
    signal.throwIfAborted();
    if (code !== 0) throw new Error('The container could not keep these source codecs. Try MKV for broader compatibility, or a smaller video if browser memory is exhausted. No subtitle tracks were deliberately dropped.');
    elements.processingTitle.textContent = 'Finishing your video';
    elements.processingDetail.textContent = 'Preparing your video with selectable subtitle languages.';
    elements.logLabel.textContent = `Finalizing ${state.settings.format.toUpperCase()}`;
    setProgress(.97);
    await verifySubtitleCount(ffmpeg, `/output.${state.settings.format}`);
    signal.throwIfAborted();
    const data = await ffmpeg.readFile(`/output.${state.settings.format}`);
    signal.throwIfAborted();
    if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error('The export was empty. Try another source video.');
    state.outputBlob = new Blob([data], { type: state.settings.format === 'mkv' ? 'video/x-matroska' : 'video/mp4' });
    state.outputURL = URL.createObjectURL(state.outputBlob);
    state.outputName = outputName;
    elements.downloadLink.href = state.outputURL;
    elements.downloadLink.download = outputName;
    elements.downloadLink.textContent = 'Download ↓';
    const existingCount = state.sourceStreams.filter((stream) => stream.codec_type === 'subtitle').length;
    elements.completedDetail.textContent = `${formatBytes(data.byteLength)} · ${state.settings.format.toUpperCase()} · ${existingCount} existing + ${state.tracks.length} added subtitle tracks. Choose a language or Off in your player.`;
    elements.resultCard.hidden = false;
    elements.previewBadge.textContent = 'SOURCE PREVIEW';
    elements.previewDescription.textContent = 'Export ready. This preview shows the source and selected added language. Download the file to use all subtitle tracks in your player.';
    setProgress(1);
    succeeded = true;
    setStatus(`${outputName} is ready. Download it and choose a subtitle language, or turn subtitles off, in your player.`, 'success');
  } catch (error) {
    if (signal.aborted) setStatus('Export cancelled. Your files and caption settings are ready to try again.');
    else {
      const message = error?.message || String(error) || 'The export stopped. Try again with a smaller video.';
      showToast(message); setStatus(message, 'error');
      setSignal('signal-worker', 'error', 'retry available');
      console.error('Local export failed:', error, state.logLines.slice(-8));
    }
    terminateEngine(state.ffmpeg);
    state.ffmpeg = null;
  } finally {
    state.encoding = false;
    await cleanupEngineFiles(ffmpeg, mount);
    state.processing = false;
    state.controller = null;
    elements.processingOverlay.hidden = true;
    syncControls();
    updateCaption();
    if (succeeded) elements.downloadLink.focus();
  }
}

function cancelExport() {
  if (!state.processing || state.saving) return;
  elements.cancelButton.disabled = true;
  state.controller?.abort();
  terminateEngine(state.engineCandidate);
  terminateEngine(state.ffmpeg);
  state.ffmpeg = null;
  setSignal('signal-worker', '', 'loads on export');
}

async function saveOutput(event) {
  if (!state.outputURL || state.saving) { event.preventDefault(); return; }
  if (typeof window.showSaveFilePicker !== 'function') return;
  event.preventDefault();
  state.saving = true;
  syncControls();
  const url = state.outputURL;
  const blob = state.outputBlob;
  const outputName = state.outputName;
  let writable;
  try {
    const destination = await window.showSaveFilePicker({ suggestedName: outputName, types: [{ description: 'Video with selectable subtitles', accept: { [blob.type]: [`.${state.settings.format}`] } }] });
    writable = await destination.createWritable();
    await writable.write(blob);
    await writable.close();
    setStatus(`Saved ${outputName} to your chosen location.`, 'success');
  } catch (error) {
    if (writable) { try { await writable.abort(); } catch { /* Stream is already closed. */ } }
    if (error.name !== 'AbortError') {
      // Keep the finished artifact available if a direct save is denied.
      const link = document.createElement('a');
      link.href = url; link.download = outputName; link.click();
      setStatus('Direct save was unavailable. A browser download was requested; your export remains available.', 'success');
    }
  } finally { state.saving = false; syncControls(); }
}

function clearFiles() {
  if (state.processing || state.saving) return;
  state.demoToken += 1;
  state.demoLoading = false;
  elements.demoLabel.textContent = 'Try a sample';
  state.selectionToken.video += 1;
  state.selectionToken.subtitle += 1;
  state.validationToken.video += 1;
  state.validationToken.subtitle += 1;
  state.validating.video = false; state.validating.subtitle = false;
  void removeRecord(state.video);
  state.video = null; state.subtitle = null; state.cues = []; state.tracks = []; state.sourceStreams = null;
  state.transcriptPage = 0; elements.captionSearch.value = '';
  terminateEngine(state.ffmpeg); state.ffmpeg = null;
  setSignal('signal-worker', '', 'loads on export');
  elements.captionOffset.value = '0'; elements.exportFormat.value = 'mkv'; elements.previewCaptions.checked = true;
  state.settings = { format: 'mkv' };
  renderTrackOptions(); selectTrack(null); renderExistingTracks();
  invalidateOutput();
  updateDropzone('video'); updateDropzone('subtitle');
  loadSourcePreview(); renderTranscript();
  elements.toast.hidden = true;
  setStatus('Everything happens on your device. Add your files when you’re ready.');
}

async function loadDemo() {
  if (state.processing || state.demoLoading || state.saving) return;
  clearFiles();
  const token = ++state.demoToken;
  state.demoLoading = true;
  elements.demoLabel.textContent = 'Loading sample…';
  syncControls();
  try {
    const results = await Promise.all(['quiet-mountains.mp4', 'quiet-mountains.srt'].map(async (name) => {
      const response = await fetch(`${import.meta.env.BASE_URL}demo/${name}`);
      if (!response.ok) throw new Error('The sample couldn’t load. Try adding your own files.');
      return new File([await response.blob()], name, { type: name.endsWith('.mp4') ? 'video/mp4' : 'application/x-subrip' });
    }));
    if (state.demoToken !== token) return;
    await selectFile('video', results[0]);
    if (state.demoToken !== token) return;
    await selectFile('subtitle', results[1]);
    if (state.demoToken !== token) return;
    setStatus('Sample loaded. Select a caption to preview it, or export the eight-second video.');
    document.getElementById('workbench').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  } catch (error) {
    if (state.demoToken === token) showToast(error.message);
  } finally {
    if (state.demoToken === token) { state.demoLoading = false; elements.demoLabel.textContent = 'Try a sample'; syncControls(); }
  }
}

function updateSettings() {
  if (state.processing || state.saving) return;
  markExportChanged();
  state.settings.format = elements.exportFormat.value;
  if (state.subtitle) {
    state.subtitle.language = elements.trackLanguage.value;
    state.subtitle.title = elements.trackTitle.value.trim() || basenameOf(state.subtitle.originalName);
    state.subtitle.offsetInput = elements.captionOffset.value;
    if (elements.captionOffset.validity.valid) state.subtitle.offset = Number(elements.captionOffset.value);
    renderTrackOptions();
  }
  renderTranscript();
}

function bindEvents() {
  bindDropzone('video'); bindDropzone('subtitle');
  elements.processButton.addEventListener('click', () => { void processVideo(); });
  elements.clearButton.addEventListener('click', clearFiles);
  elements.demoButton.addEventListener('click', () => { void loadDemo(); });
  elements.previewDemoButton.addEventListener('click', () => { void loadDemo(); });
  elements.captionSearch.addEventListener('input', () => { state.transcriptPage = 0; renderCaptionRows(); });
  for (const [button, direction] of [[elements.captionPagePrev, -1], [elements.captionPageNext, 1]]) {
    button.addEventListener('click', () => {
      state.transcriptPage += direction;
      renderCaptionRows();
      elements.cueList.scrollTop = 0;
      // A disabled pagination button should not strand keyboard focus.
      if (button.disabled) (direction > 0 ? elements.captionPagePrev : elements.captionPageNext).focus();
    });
  }
  for (const [button, delta] of [[elements.offsetEarlier, -.5], [elements.offsetLater, .5], [elements.offsetReset, 0]]) {
    button.addEventListener('click', () => {
      const value = delta === 0 ? 0 : Number(elements.captionOffset.value) + delta;
      elements.captionOffset.value = String(Math.round(Math.max(-600, Math.min(600, value)) * 10) / 10);
      updateSettings();
    });
  }
  elements.cancelButton.addEventListener('click', cancelExport);
  elements.downloadLink.addEventListener('click', saveOutput);
  elements.toastClose.addEventListener('click', () => { elements.toast.hidden = true; });
  for (const field of [elements.trackLanguage, elements.trackTitle, elements.captionOffset, elements.exportFormat]) field.addEventListener('input', updateSettings);
  elements.trackSelect.addEventListener('change', () => selectTrack(state.tracks.find((track) => track.id === elements.trackSelect.value)));
  elements.previewCaptions.addEventListener('change', updateCaption);
  elements.removeTrack.addEventListener('click', () => {
    if (state.processing || state.saving) return;
    const index = state.tracks.indexOf(state.subtitle);
    state.tracks.splice(index, 1);
    markExportChanged();
    state.subtitle = state.tracks[Math.min(index, state.tracks.length - 1)] || null;
    renderTrackOptions(); selectTrack(state.subtitle);
  });
  elements.videoPreview.addEventListener('timeupdate', updateCaption);
  elements.videoPreview.addEventListener('seeked', updateCaption);
  elements.videoPreview.addEventListener('loadedmetadata', () => {
    elements.previewError.hidden = true;
    const video = elements.videoPreview;
    elements.videoDetails.textContent = `${video.videoWidth} × ${video.videoHeight} · ${formatTime(video.duration)}`;
    updateCaption();
    positionCaption();
  });
  elements.videoPreview.addEventListener('error', () => { if (state.video) { elements.previewError.hidden = false; updateCaption(); } });
  new ResizeObserver(positionCaption).observe(elements.previewStage);
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  window.addEventListener('beforeunload', (event) => {
    if (state.processing || state.saving) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    cancelExport();
    void state.storageRoot?.removeEntry(SESSION_ID, { recursive: true }).catch(() => {});
  });
  // Keep the selected language synchronized while the player is running.
  if ('requestVideoFrameCallback' in elements.videoPreview) {
    const onFrame = () => { updateCaption(); elements.videoPreview.requestVideoFrameCallback(onFrame); };
    elements.videoPreview.requestVideoFrameCallback(onFrame);
  }
}

elements.trackLanguage.replaceChildren(...LANGUAGES.map(([code, label]) => new Option(label, code)));
state.storageReady = prepareStorage();
bindEvents();
updateDropzone('video'); updateDropzone('subtitle');
renderTranscript();
