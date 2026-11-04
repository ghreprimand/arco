import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useAppStore } from './appStore.js';
import { startTabStatusTracking, tabKey, useTabStatusStore } from './tabStatusStore.js';

const job = (id: string, busy: boolean) => ({ id, busy, messages: [], reviews: [], handoffs: [], workers: {}, config: { name: id } }) as never;

test('a turn that ends away from its tab is marked and opening the tab clears it', () => {
  startTabStatusTracking();
  useAppStore.setState({ jobs: { a: job('a', true), b: job('b', false) }, clusters: {}, activeJobId: 'b', activeClusterId: null, showHome: false, showCreator: false, showGithub: false });
  useAppStore.setState({ jobs: { a: job('a', false), b: job('b', false) } });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'a')], true);
  useAppStore.setState({ activeJobId: 'a' });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'a')], undefined);
});

test('a turn that ends on the open tab is never marked', () => {
  useAppStore.setState({ jobs: { a: job('a', true) }, clusters: {}, activeJobId: 'a', activeClusterId: null, showHome: false, showCreator: false, showGithub: false });
  useAppStore.setState({ jobs: { a: job('a', false) } });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'a')], undefined);
});

test('a cluster member finishing marks the cluster tab, not a job tab', () => {
  const cluster = { clusterId: 'c', members: [{ workflowId: 'm', displayName: 'm', status: 'idle' }] } as never;
  useAppStore.setState({ jobs: { m: job('m', true) }, clusters: { c: cluster }, activeJobId: null, activeClusterId: null, showHome: false, showCreator: false, showGithub: false });
  useAppStore.setState({ jobs: { m: job('m', false) } });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('cluster', 'c')], true);
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'm')], undefined);
  useAppStore.setState({ activeClusterId: 'c' });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('cluster', 'c')], undefined);
});

test('showing Home counts as away from the open tab and reopening it clears the mark', () => {
  useAppStore.setState({ jobs: { a: job('a', true) }, clusters: {}, activeJobId: 'a', activeClusterId: null, showHome: false, showCreator: false, showGithub: false });
  useAppStore.setState({ showHome: true });
  useAppStore.setState({ jobs: { a: job('a', false) } });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'a')], true);
  useAppStore.setState({ showHome: false });
  assert.equal(useTabStatusStore.getState().unviewed[tabKey('job', 'a')], undefined);
});
