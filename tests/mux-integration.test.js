import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMuxArgs } from '../src/media-export.js';
import { serializeSRT, parseSRT } from '../src/subtitles.js';

const available = ['ffmpeg', 'ffprobe'].every((command) => spawnSync(command, ['-version']).status === 0);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}
const probe = (path) => JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path]));
const hash = (path, stream) => run('ffmpeg', ['-v', 'error', '-i', path, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();

test('real exports retain existing subtitles, audio, video, fonts, chapters, and independent new languages', { skip: !available && 'Install FFmpeg and ffprobe to run media integration tests.' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'subwasm-mux-'));
  try {
    const video = fileURLToPath(new URL('../public/demo/quiet-mountains.mp4', import.meta.url));
    const font = fileURLToPath(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url));
    const english = join(directory, 'english.srt');
    const french = join(directory, 'french.srt');
    writeFileSync(english, '1\n00:00:00,100 --> 00:00:02,000\nOriginal English\n');
    writeFileSync(french, '1\n00:00:00,100 --> 00:00:02,000\nOriginal French\n');
    const chapters = join(directory, 'chapters.txt');
    writeFileSync(chapters, ';FFMETADATA1\ntitle=Original movie\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=8000\ntitle=The beginning\n');
    for (const sourceFormat of ['mkv', 'mp4']) {
      const source = join(directory, `source.${sourceFormat}`);
      run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-i', english, '-i', french, '-i', chapters,
        '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s', '-map_metadata', '4', '-map_chapters', '4', '-c:v', 'copy', '-c:a', 'aac',
        '-c:s', sourceFormat === 'mkv' ? 'srt' : 'mov_text', ...(sourceFormat === 'mkv' ? ['-c:s:1', 'ass', '-attach', font, '-metadata:s:t:0', 'mimetype=application/x-truetype-font'] : []),
        '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Original English', '-metadata:s:s:1', 'language=fra', '-metadata:s:s:1', 'title=Original French', '-disposition:s:0', 'default+forced', '-disposition:s:1', '0', source]);
      const sourceInfo = probe(source);
      const tracks = [{ language: 'spa', title: 'Spanish', cues: [{ start: .2, end: 1.8, text: 'Hola' }], offset: .5 }, { language: 'jpn', title: 'Japanese', cues: [{ start: .4, end: 2.2, text: 'こんにちは' }], offset: -.2 }];
      tracks.forEach((track, index) => writeFileSync(join(directory, `subtitle-${index}.srt`), serializeSRT(track.cues, track.offset)));
      for (const format of ['mkv', 'mp4']) {
        const output = join(directory, `output-${sourceFormat}.${format}`);
        const args = buildMuxArgs({ videoPath: source, tracks, sourceStreams: sourceInfo.streams, format }).map((value) => value.startsWith('/subtitle-') ? join(directory, value.slice(1)) : value === `/output.${format}` ? output : value);
        run('ffmpeg', args);
        const info = probe(output);
        const subtitles = info.streams.filter((stream) => stream.codec_type === 'subtitle');
        assert.equal(subtitles.length, 4);
        assert.deepEqual(subtitles.map((stream) => stream.tags.language), ['eng', 'fra', 'spa', 'jpn']);
        assert.equal(subtitles[0].disposition.default, 1);
        assert.equal(subtitles[0].disposition.forced, 1);
        assert.equal(subtitles[2].disposition.default, 0);
        assert.equal(subtitles[3].disposition.default, 0);
        assert.equal(subtitles[2].tags.title || subtitles[2].tags.handler_name, 'Spanish');
        assert.equal(subtitles[3].tags.title || subtitles[3].tags.handler_name, 'Japanese');
        assert.ok(Number(info.format.duration) >= 7.9, 'subtitle end time must not truncate the video');
        assert.equal(hash(output, '0:v:0'), hash(source, '0:v:0'), 'video packets must be unchanged');
        assert.equal(hash(output, '0:a:0'), hash(source, '0:a:0'), 'audio packets must be unchanged');
        assert.equal(info.chapters[0].tags.title, 'The beginning');
        for (const [index, text] of ['Original English', 'Original French', 'Hola', 'こんにちは'].entries()) {
          const cues = parseSRT(run('ffmpeg', ['-v', 'error', '-i', output, '-map', `0:s:${index}`, '-c:s', 'srt', '-f', 'srt', '-']));
          assert.equal(cues[0].text, text);
          if (index === 2) assert.ok(Math.abs(cues[0].start - .7) < .05);
          if (index === 3) assert.ok(Math.abs(cues[0].start - .2) < .05);
        }
        if (format === 'mkv' && sourceFormat === 'mkv') {
          assert.equal(subtitles[1].codec_name, 'ass');
          assert.equal(info.streams.filter((stream) => stream.codec_type === 'attachment').length, 1);
        }
      }
    }
    // Matroska preserves all-off defaults. FFmpeg's MP4 muxer enables its first
    // subtitle when none is default; players still offer language and Off.
    for (const format of ['mkv', 'mp4']) {
      const output = join(directory, `no-existing.${format}`);
      const sourceInfo = probe(video);
      const tracks = [{ language: 'spa', title: 'Spanish' }, { language: 'jpn', title: 'Japanese' }];
      const args = buildMuxArgs({ videoPath: video, tracks, sourceStreams: sourceInfo.streams, format }).map((value) => value.startsWith('/subtitle-') ? join(directory, value.slice(1)) : value === `/output.${format}` ? output : value);
      run('ffmpeg', args);
      const subtitles = probe(output).streams.filter((stream) => stream.codec_type === 'subtitle');
      assert.equal(subtitles.length, 2);
      assert.deepEqual(subtitles.map((stream) => stream.disposition.default), format === 'mkv' ? [0, 0] : [1, 0], format);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
