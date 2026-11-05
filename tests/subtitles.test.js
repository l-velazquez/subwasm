import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSubtitle, parseSRT, shiftCues, serializeSRT, formatTime } from '../src/subtitles.js';

const source = '1\n00:00:01,500 --> 00:00:03,000\nHello, world.\nA second line.\n\n2\n00:00:04,000 --> 00:00:05,250\nGoodbye.';

test('reads a real multi-line subtitle track with Windows line endings and a BOM', () => {
  assert.deepEqual(parseSRT(`\uFEFF${source.replaceAll('\n', '\r\n')}`), [
    { start: 1.5, end: 3, text: 'Hello, world.\nA second line.' },
    { start: 4, end: 5.25, text: 'Goodbye.' },
  ]);
});

test('sorts cues by start time without discarding overlapping captions', () => {
  const cues = parseSRT('2\n00:00:02,000 --> 00:00:04,000\nSecond\n\n1\n00:00:01,000 --> 00:00:03,000\nFirst');
  assert.deepEqual(cues.map((cue) => cue.start), [1, 2]);
  assert.equal(cues.length, 2);
});

test('accepts dot-separated milliseconds and cue timing without sequence numbers', () => {
  assert.equal(parseSRT('00:00:00.200 --> 00:00:01.400\nA caption')[0].end, 1.4);
});

test('rejects empty, malformed, backwards, and missing-text captions with an actionable error', () => {
  for (const invalid of ['', 'garbage', '1\n00:61:00,000 --> 00:62:00,000\nBad minute', '1\n00:00:04,000 --> 00:00:03,000\nBackwards', '1\n00:00:01,000 --> 00:00:02,000']) {
    assert.throws(() => parseSRT(invalid), /empty|Caption 1/);
  }
});

test('reports the actual malformed cue instead of silently exporting a partial track', () => {
  assert.throws(() => parseSRT(`${source}\n\n3\ninvalid timing\nBad cue`), /Caption 3/);
});

test('normalizes newly added captions to safe text', () => {
  const cue = parseSRT('1\n00:00:01,000 --> 00:00:02,000\n<i>Tom &amp; Jerry</i> {\\an8}&lt;hello&gt;')[0];
  assert.equal(cue.text, 'Tom & Jerry <hello>');
  assert.ok(!serializeSRT([cue]).includes('<hello>'));
  assert.ok(!serializeSRT([cue]).includes('\\an8'));
});

test('decodes both common UTF-16 BOM encodings and rejects damaged UTF-8', () => {
  const le = new Uint8Array([255, 254, 65, 0, 233, 0]);
  const be = new Uint8Array([254, 255, 0, 65, 0, 233]);
  assert.equal(decodeSubtitle(le.buffer), 'Aé');
  assert.equal(decodeSubtitle(be.buffer), 'Aé');
  assert.throws(() => decodeSubtitle(new Uint8Array([0xc3]).buffer), /UTF-8/);
});

test('shifts captions later without changing their duration or mutating the source', () => {
  const cues = parseSRT(source);
  const shifted = shiftCues(cues, 2.5);
  assert.equal(shifted[0].start, 4);
  assert.equal(shifted[0].end, 5.5);
  assert.equal(cues[0].start, 1.5);
});

test('clips captions at time zero and omits cues that move fully before the video', () => {
  const shifted = shiftCues(parseSRT(source), -2);
  assert.equal(shifted[0].start, 0);
  assert.equal(shifted[0].end, 1);
  assert.equal(shiftCues(parseSRT(source), -6).length, 0);
});

test('exports the adjusted timing as a valid, renumbered SubRip track', () => {
  const adjusted = serializeSRT(parseSRT(source), -3.5);
  assert.equal(adjusted, '1\n00:00:00,500 --> 00:00:01,750\nGoodbye.\n');
  assert.equal(parseSRT(adjusted)[0].start, .5);
});

test('keeps time labels and export timestamps correct across hour boundaries', () => {
  assert.equal(formatTime(3600.005, true), '01:00:00,005');
  assert.equal(formatTime(125), '02:05');
  assert.equal(formatTime(-1, true), '00:00:00,000');
});

