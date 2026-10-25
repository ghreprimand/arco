import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerWatches } from './watchStore.js';

test('exact worker and generation; another builder or a later run never fires the watch', () => {
  const events: string[] = []; const s = new ComputerWatches([], (w) => events.push(w.status));
  const w = s.create('computer', 'Builder 1', [{ id: 'b1', name: 'Builder 1', token: 7 }]);
  s.settle('b2', 7, 'finished'); s.settle('b1', 8, 'finished');
  assert.equal(s.list()[0].status, 'watching');
  s.settle('b1', 7, 'finished'); s.settle('b1', 7, 'finished');
  assert.deepEqual(events, ['finished']); assert.equal(s.list()[0].id, w.id);
});
test('cluster watch binds busy members once and waits for every selected run', () => {
  const s = new ComputerWatches();
  s.create('c', 'SignalQueue', [{ id: 'b1', name: 'Builder 1', token: 1 }, { id: 'b2', name: 'Builder 2', token: 2 }, { id: 'idle', name: 'Idle' }]);
  assert.equal(s.list()[0].targets.length, 2);
  s.settle('b1', 1, 'finished'); assert.equal(s.list()[0].status, 'watching');
  s.settle('new-member', 3, 'finished'); s.settle('b1', 4, 'finished');
  s.settle('b2', 2, 'finished'); assert.equal(s.list()[0].status, 'finished');
  assert.throws(() => s.create('c', 'Idle', [{ id: 'x', name: 'x' }]), /already idle/);
});
test('errors, cancellations, deletion and restart are never reported as success', () => {
  const s = new ComputerWatches();
  s.create('c', 'group', [{ id: 'a', name: 'a', token: 1 }, { id: 'b', name: 'b', token: 2 }]);
  s.settle('a', 1, 'failed'); s.settle('b', 2, 'finished'); assert.equal(s.list()[0].status, 'failed');
  const w = s.create('c', 'next', [{ id: 'a', name: 'a', token: 3 }]);
  const recovered = new ComputerWatches(s.saved()); assert.equal(recovered.list().find((x) => x.id === w.id)?.status, 'interrupted');
  s.cancel(w.id, 'c'); s.settle('a', 3, 'finished'); assert.equal(s.list().find((x) => x.id === w.id)?.status, 'cancelled');
});
test('private watches are owner-scoped, never persisted and discarded on full clear', () => {
  const s = new ComputerWatches(); const w = s.create('private-owner', 'secret', [{ id: 'b', name: 'b', token: 1 }], true);
  assert.deepEqual(s.list(), []); assert.deepEqual(s.saved(), []); assert.equal(s.list('private-owner').length, 1);
  assert.throws(() => s.cancel(w.id, 'someone-else'), /No such/);
  s.clearPrivate('private-owner'); assert.deepEqual(s.list('private-owner'), []);
});

test('only one browser can claim the terminal announcement', () => {
  const s = new ComputerWatches(); const w = s.create('c', 'b', [{id:'b',name:'b',token:1}]);
  assert.equal(s.claimAnnouncement(w.id, 'c'), false);
  s.settle('b', 1, 'finished'); assert.equal(s.claimAnnouncement(w.id, 'c'), true);
  assert.equal(s.claimAnnouncement(w.id, 'other-browser'), false);
});
