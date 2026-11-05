export const LANGUAGES = [
  ['und', 'Unspecified'], ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'],
  ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['ara', 'Arabic'],
  ['zho', 'Chinese'], ['hin', 'Hindi'], ['jpn', 'Japanese'], ['kor', 'Korean'],
  ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['nld', 'Dutch'], ['pol', 'Polish'],
  ['tur', 'Turkish'], ['vie', 'Vietnamese'], ['tha', 'Thai'], ['ind', 'Indonesian'],
  ['swe', 'Swedish'], ['dan', 'Danish'], ['fin', 'Finnish'], ['nor', 'Norwegian'],
  ['heb', 'Hebrew'], ['ell', 'Greek'], ['ces', 'Czech'], ['ron', 'Romanian'],
  ['hun', 'Hungarian'], ['ben', 'Bengali'], ['tam', 'Tamil'], ['tel', 'Telugu'],
  ['msa', 'Malay'], ['fas', 'Persian'], ['urd', 'Urdu'], ['cat', 'Catalan'],
];

const aliases = { en: 'eng', es: 'spa', fr: 'fra', fre: 'fra', de: 'deu', ger: 'deu', it: 'ita', pt: 'por', ar: 'ara', zh: 'zho', chi: 'zho', hi: 'hin', ja: 'jpn', ko: 'kor', ru: 'rus', uk: 'ukr', nl: 'nld', pl: 'pol', tr: 'tur' };

export function guessLanguage(name) {
  const words = name.toLowerCase().replace(/\.srt$/, '').split(/[. _-]+/);
  for (const word of [...words].reverse()) {
    const match = LANGUAGES.find(([code, label]) => word === code || word === label.toLowerCase());
    if (match) return match[0];
    if (aliases[word]) return aliases[word];
  }
  return 'und';
}

export function validOffset(value) {
  const number = Number(value);
  return String(value).trim() !== '' && Number.isFinite(number) && Math.abs(number) <= 600 && Math.abs(number * 10 - Math.round(number * 10)) < 1e-7;
}

export function buildMuxArgs({ videoPath, tracks, sourceStreams, format }) {
  if (!['mkv', 'mp4'].includes(format)) throw new Error('Choose MKV or MP4.');
  if (!tracks.length) throw new Error('Add at least one subtitle track.');
  const existing = sourceStreams.filter((stream) => stream.codec_type === 'subtitle');
  if (format === 'mp4' && existing.some((stream) => ['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub'].includes(stream.codec_name))) {
    throw new Error('This video has image-based subtitles. Choose MKV to keep those existing tracks and add your new languages.');
  }
  const args = ['-nostdin', '-y', '-hide_banner', '-i', videoPath];
  tracks.forEach((_, index) => args.push('-i', `/subtitle-${index}.srt`));
  args.push('-map', '0:v?', '-map', '0:a?', '-map', '0:s?');
  if (format === 'mkv') args.push('-map', '0:t?');
  tracks.forEach((_, index) => args.push('-map', `${index + 1}:s:0`));
  args.push('-map_metadata', '0', '-map_chapters', '0', '-c', 'copy');
  if (format === 'mkv') args.push('-default_mode', 'passthrough');
  if (format === 'mp4') args.push('-c:s', 'mov_text', '-movflags', '+faststart');
  existing.forEach((stream, index) => {
    // Matroska cannot store MP4 timed text directly. Convert its text while
    // retaining language, title, and disposition. Copy other existing codecs.
    if (format === 'mkv' && stream.codec_name === 'mov_text') args.push(`-c:s:${index}`, 'srt');
    const flags = Object.entries(stream.disposition || {}).filter(([, enabled]) => enabled).map(([name]) => name).join('+') || '0';
    args.push(`-disposition:s:${index}`, flags);
  });
  tracks.forEach((track, index) => {
    const outputIndex = existing.length + index;
    if (format === 'mkv') args.push(`-c:s:${outputIndex}`, 'srt');
    args.push(`-metadata:s:s:${outputIndex}`, `language=${track.language}`, `-metadata:s:s:${outputIndex}`, `title=${track.title}`, `-disposition:s:${outputIndex}`, '0');
    if (format === 'mp4') args.push(`-metadata:s:s:${outputIndex}`, `handler_name=${track.title}`);
  });
  return [...args, `/output.${format}`];
}
