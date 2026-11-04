import test from 'node:test';
import assert from 'node:assert/strict';
import { readTally, recordPick, resetTally, sortedTally } from './secondOpinionTally';

function fakeStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

test('picks accumulate per provider and model and sort by count', () => {
  const s = fakeStore();
  recordPick({ provider: 'claude', model: 'opus' }, s);
  recordPick({ provider: 'codex', model: 'gpt-5' }, s);
  recordPick({ provider: 'codex', model: 'gpt-5' }, s);
  assert.deepEqual(sortedTally(readTally(s)), [['codex/gpt-5', 2], ['claude/opus', 1]]);
  resetTally(s);
  assert.deepEqual(readTally(s), {});
});
test('a corrupt stored value reads as empty', () => {
  const s = fakeStore();
  s.setItem('arco.secondOpinion.picks', '[1,"x"');
  assert.deepEqual(readTally(s), {});
  s.setItem('arco.secondOpinion.picks', JSON.stringify({ a: -1, b: 'x', c: 3 }));
  assert.deepEqual(readTally(s), { c: 3 });
});
