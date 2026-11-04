import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, guessLanguage, validOffset, buildMuxArgs } from '../src/media-export.js';

const tracks = [{ language: 'spa', title: 'Spanish' }, { language: 'jpn', title: 'Japanese' }];
const sourceStreams = [
  { codec_type: 'video', codec_name: 'h264' },
  { codec_type: 'subtitle', codec_name: 'ass', disposition: { default: 1, forced: 1 } },
  { codec_type: 'subtitle', codec_name: 'subrip', disposition: { default: 0 } },
];

test('keeps every original subtitle and appends separately labeled languages without burning or re-encoding', () => {
  const args = buildMuxArgs({ videoPath: '/video.mkv', tracks, sourceStreams, format: 'mkv' });
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-map'), ['0:v?', '0:a?', '0:s?', '0:t?', '1:s:0', '2:s:0']);
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.ok(!args.includes('-vf'));
  assert.ok(!args.includes('-shortest'));
  assert.equal(args[args.indexOf('-disposition:s:0') + 1], 'default+forced');
  assert.equal(args[args.indexOf('-disposition:s:1') + 1], '0');
  assert.equal(args[args.indexOf('-metadata:s:s:2') + 1], 'language=spa');
  assert.equal(args[args.indexOf('-metadata:s:s:3') + 1], 'language=jpn');
  assert.equal(args[args.indexOf('-disposition:s:2') + 1], '0');
  assert.equal(args.at(-1), '/output.mkv');
});

test('converts MP4 timed text for Matroska while retaining other existing subtitle codecs', () => {
  const args = buildMuxArgs({ videoPath: '/video.mp4', tracks, sourceStreams: [...sourceStreams, { codec_type: 'subtitle', codec_name: 'mov_text' }], format: 'mkv' });
  assert.equal(args[args.indexOf('-c:s:2') + 1], 'srt');
  assert.ok(!args.includes('-c:s:0'));
});

test('supports MP4 text tracks and refuses to discard incompatible image-based subtitles', () => {
  const args = buildMuxArgs({ videoPath: '/video.mkv', tracks, sourceStreams, format: 'mp4' });
  assert.equal(args[args.indexOf('-c:s') + 1], 'mov_text');
  assert.ok(args.includes('handler_name=Japanese'));
  for (const codec_name of ['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub']) {
    assert.throws(() => buildMuxArgs({ videoPath: '/video.mkv', tracks, sourceStreams: [{ codec_type: 'subtitle', codec_name }], format: 'mp4' }), /Choose MKV/);
    assert.doesNotThrow(() => buildMuxArgs({ videoPath: '/video.mkv', tracks, sourceStreams: [{ codec_type: 'subtitle', codec_name }], format: 'mkv' }));
  }
});

test('guesses common filename language tags and uses unspecified for unknown names', () => {
  for (const [file, expected] of [['movie.es.srt', 'spa'], ['movie.EN.srt', 'eng'], ['film.french.srt', 'fra'], ['movie.pt-BR.srt', 'por'], ['quiet-mountains.srt', 'und']]) assert.equal(guessLanguage(file), expected);
  assert.equal(new Set(LANGUAGES.map(([code]) => code)).size, LANGUAGES.length);
});

test('validates timing independently for every language, including inactive tracks', () => {
  for (const value of ['', ' ', 'bad', '600.1', '-600.1', '0.01', Infinity]) assert.equal(validOffset(value), false, String(value));
  for (const value of ['0', '-600', '600', '0.1', '-0.5', '12.3']) assert.equal(validOffset(value), true, value);
});
