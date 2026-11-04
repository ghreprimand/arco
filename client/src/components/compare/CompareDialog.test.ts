import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opinionContext } from './CompareDialog';

test('context summary reflects the exact text retained by the server limit', () => {
  const simple = opinionContext('selected', 'recent');
  assert.equal(simple.selected, 'included');
  assert.equal(simple.turns, 'included');
  assert.match(simple.context, /selected[\s\S]*recent/);
  const clipped = opinionContext('x'.repeat(30_000), 'recent');
  assert.equal(clipped.context.length, 24 * 1024);
  assert.equal(clipped.selected, 'partly included (context limit)');
  assert.equal(clipped.turns, 'included');
  const gone = opinionContext('selected', 'r'.repeat(30_000));
  assert.equal(gone.selected, 'omitted (context limit)');
  assert.equal(gone.turns, 'partly included (context limit)');
  assert.equal(opinionContext('', '').selected, 'not included');
});
