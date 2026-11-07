import { test } from 'node:test';
import assert from 'node:assert/strict';
import { substituteArgs } from './prompts.js';

test('positional replacement values are literal and never expanded again', () => {
  for (const value of ['$2', '${2}', '$@', '$*', '$$']) {
    assert.equal(substituteArgs('${1}', [value, 'SECOND']), value);
  }
});

test('escaped dollars protect every recognized placeholder', () => {
  assert.equal(substituteArgs('$$1 $${1} $$@ $$* $$$$', ['FIRST']), '$1 ${1} $@ $* $$');
});

test('normal argument expansion preserves multi-digit and unbound slots', () => {
  assert.equal(substituteArgs('$1 ${2} $@ $* $99', ['one', 'two']), 'one two one two one two ');
});
