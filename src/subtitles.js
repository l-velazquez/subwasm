export const MAX_SUBTITLE_SIZE = 5 * 1024 * 1024;

export function decodeSubtitle(buffer) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Save your subtitle file as UTF-8 or UTF-16, then try again.');
  }
}

function parseTimestamp(value) {
  const match = value.match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function plainText(value) {
  // SubRip styling and ASS overrides are removed so preview and added language tracks use
  // the same safe, plain text. Nothing from a subtitle is inserted as HTML.
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
      if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? entity;
      const code = key.toLowerCase().startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
    }).trim();
}

export function parseSRT(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error('This subtitle file is empty. Choose an .srt file with captions.');
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const cues = blocks.map((block, index) => {
    const lines = block.split('\n');
    const timingIndex = /^\d+\s*$/.test(lines[0]) ? 1 : 0;
    const timing = lines[timingIndex]?.trim().match(/^(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/);
    const start = timing ? parseTimestamp(timing[1]) : null;
    const end = timing ? parseTimestamp(timing[2]) : null;
    const caption = plainText(lines.slice(timingIndex + 1).join('\n'));
    if (start === null || end === null || end <= start || !caption) {
      throw new Error(`Caption ${index + 1} has invalid timing or no text. Check its start, end, and caption in the .srt file.`);
    }
    return { start, end, text: caption };
  });
  return cues.sort((a, b) => a.start - b.start);
}

export function shiftCues(cues, offset = 0) {
  return cues.map((cue) => ({ ...cue, start: Math.max(0, cue.start + offset), end: cue.end + offset }))
    .filter((cue) => cue.end > cue.start);
}

export function formatTime(seconds, milliseconds = false) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const secs = Math.floor(total / 1000) % 60;
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const base = `${hours || milliseconds ? `${pad(hours)}:` : ''}${pad(minutes)}:${pad(secs)}`;
  return milliseconds ? `${base},${pad(total % 1000, 3)}` : base;
}

export function serializeSRT(cues, offset = 0) {
  return shiftCues(cues, offset).map((cue, index) => {
    // Escape text that libass might otherwise treat as formatting on re-read.
    const text = cue.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
    return `${index + 1}\n${formatTime(cue.start, true)} --> ${formatTime(cue.end, true)}\n${text}\n`;
  }).join('\n');
}

