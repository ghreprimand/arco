import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SegmentJoiner } from './acpSegments.js';

function run(steps: Array<string | 'boundary'>): string {
  const j = new SegmentJoiner();
  let out = '';
  for (const s of steps) {
    if (s === 'boundary') j.boundary();
    else out += j.chunk(s, out);
  }
  return out;
}

test('chunks of one segment are joined untouched', () => {
  assert.equal(run(['I will ', 'fix ', 'it.']), 'I will fix it.');
});

test('a chunk after reasoning or a tool update gets a paragraph break when the text ran on', () => {
  assert.equal(run(['I will fix.', 'boundary', 'While here']), 'I will fix.\n\nWhile here');
  assert.equal(run(['One.', 'boundary', 'boundary', 'Two.']), 'One.\n\nTwo.');
});

test('no break is added when whitespace is already there or nothing was said yet', () => {
  assert.equal(run(['One.\n', 'boundary', 'Two.']), 'One.\nTwo.');
  assert.equal(run(['One. ', 'boundary', 'Two.']), 'One. Two.');
  assert.equal(run(['boundary', 'First']), 'First');
  assert.equal(run(['One.', 'boundary', ' Two.']), 'One. Two.');
});

test('reset forgets a pending boundary', () => {
  const j = new SegmentJoiner();
  j.boundary();
  j.reset();
  assert.equal(j.chunk('Next', 'Prev.'), 'Next');
});
