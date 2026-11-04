// Preserve original cue indices so filtered and paged rows seek and highlight
// the same captions that are used by playback and export.
export function getTranscriptPage(cues, query = '', requestedPage = 0, pageSize = 50) {
  const search = query.trim().toLocaleLowerCase();
  const matches = cues.flatMap((cue, index) => !search || cue.text.toLocaleLowerCase().includes(search) ? [{ cue, index }] : []);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const start = page * pageSize;
  return { entries: matches.slice(start, start + pageSize), total: matches.length, page, pageCount, start };
}
