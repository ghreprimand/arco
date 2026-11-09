import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useAppStore } from '../stores/appStore';
import { submitClusterCreation, finishClusterCreation } from './clusterCreation';
useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });

test('creator unlocks after no send, preparation exceptions and send exceptions', () => {
  for (const send of [() => false, () => { throw new Error('preparation failed'); }, () => { throw new Error('send failed'); }]) {
    submitClusterCreation(send);
    assert.equal(useAppStore.getState().clusterCreationPending, false);
  }
});

test('only the matching completion finishes an attempt; timeout and disconnect allow retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let first = '', second = '';
  submitClusterCreation(id => { first = id; });
  finishClusterCreation('another-request');
  assert.equal(useAppStore.getState().clusterCreationPending, true);
  t.mock.timers.tick(30_000);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
  submitClusterCreation(id => { second = id; });
  finishClusterCreation(first);
  assert.equal(useAppStore.getState().clusterCreationPending, true);
  finishClusterCreation(second);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
  submitClusterCreation(() => {});
  useAppStore.getState().setConnected(false);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
  t.mock.timers.tick(30_000);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
});
