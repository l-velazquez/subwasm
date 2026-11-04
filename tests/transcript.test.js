import test from 'node:test';
import assert from 'node:assert/strict';
import { getTranscriptPage } from '../src/transcript.js';

const cues = Array.from({ length: 251 }, (_, index) => ({ start: index, end: index + .8, text: `Caption ${index + 1}` }));

test('makes captions beyond the former 200-row limit reachable without losing cue indices', () => {
  const result = getTranscriptPage(cues, '', 4);
  assert.equal(result.total, 251);
  assert.equal(result.pageCount, 6);
  assert.equal(result.entries[0].index, 200);
  assert.equal(result.entries[0].cue, cues[200]);
  assert.equal(result.entries.at(-1).index, 249);
  assert.equal(getTranscriptPage(cues, '', 5).entries[0].index, 250);
});

test('searches the whole track ignoring case and surrounding whitespace', () => {
  const result = getTranscriptPage(cues, '  CAPTION 251  ');
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].index, 250);
  assert.equal(cues.length, 251);
});

test('clamps pagination when filtering or a timing shift removes earlier pages', () => {
  const result = getTranscriptPage(cues, 'Caption 2', 99);
  assert.equal(result.page, result.pageCount - 1);
  assert.ok(result.entries.length > 0);
  assert.equal(getTranscriptPage(cues, '', -1).page, 0);
});

test('handles empty tracks and searches without matches', () => {
  for (const result of [getTranscriptPage([], '', 8), getTranscriptPage(cues, 'missing')]) {
    assert.deepEqual(result.entries, []);
    assert.equal(result.total, 0);
    assert.equal(result.page, 0);
    assert.equal(result.pageCount, 1);
  }
});
