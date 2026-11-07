import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usePlanGenesisStore } from './planGenesisStore';

test('Genesis origin binds once and only its project can complete it', () => {
  const store = usePlanGenesisStore.getState();
  const origin = { kind: 'cluster' as const, cwd: '/projects/one', clusterId: 'cluster' };
  store.begin('token', origin);
  assert.equal(store.bind('wrong', 'workflow'), null);
  assert.deepEqual(store.bind('token', 'workflow'), origin);
  assert.equal(store.bind('token', 'other'), null);
  assert.equal(store.finish('workflow', '/projects/other', 'plan'), null);
  assert.deepEqual(store.finish('workflow', '/projects/one', 'plan'), origin);
  assert.deepEqual(usePlanGenesisStore.getState().results.workflow, { origin, planId: 'plan' });
  assert.equal(store.cancel('workflow'), null);
  store.clearResult('workflow');
});

test('closing a Genesis draft returns the origin without a plan', () => {
  const store = usePlanGenesisStore.getState();
  const origin = { kind: 'creator' as const, cwd: '/projects/one', creatorDraftKey: 'draft' };
  store.begin('token-2', origin);
  store.bind('token-2', 'workflow-2');
  assert.deepEqual(store.cancel('workflow-2'), origin);
  assert.deepEqual(usePlanGenesisStore.getState().results['workflow-2'], { origin, planId: null });
  store.clearResult('workflow-2');
});

test('saved offers from separate Genesis drafts do not replace one another', () => {
  const store = usePlanGenesisStore.getState();
  const a = { kind: 'cluster' as const, cwd: '/projects/a', clusterId: 'a' };
  const b = { kind: 'cluster' as const, cwd: '/projects/b', clusterId: 'b' };
  store.begin('a', a); store.bind('a', 'wa');
  store.begin('b', b); store.bind('b', 'wb');
  store.finish('wa', a.cwd, 'pa'); store.finish('wb', b.cwd, 'pb');
  assert.deepEqual(usePlanGenesisStore.getState().results, { wa: { origin: a, planId: 'pa' }, wb: { origin: b, planId: 'pb' } });
  store.clearResult('wa');
  assert.deepEqual(usePlanGenesisStore.getState().results, { wb: { origin: b, planId: 'pb' } });
  store.clearResult('wb');
});

test('changing the creator choice removes its pending and active return paths', () => {
  const store = usePlanGenesisStore.getState();
  const origin = { kind: 'creator' as const, cwd: '/projects/one', creatorDraftKey: 'draft' };
  store.begin('pending', origin);
  store.begin('active', origin); store.bind('active', 'workflow');
  store.cancelCreator('draft');
  assert.equal(store.bind('pending', 'late'), null);
  assert.equal(store.finish('workflow', origin.cwd, 'plan'), null);
});

test('a single-tab origin returns on save or close without selecting a plan on close', () => {
  const store = usePlanGenesisStore.getState();
  const origin = { kind: 'workflow' as const, cwd: '/projects/one', workflowId: 'original' };
  store.begin('single-save', origin); store.bind('single-save', 'genesis-save');
  assert.deepEqual(store.finish('genesis-save', origin.cwd, 'plan'), origin);
  assert.deepEqual(usePlanGenesisStore.getState().results['genesis-save'], { origin, planId: 'plan' });
  store.clearResult('genesis-save');
  store.begin('single-close', origin); store.bind('single-close', 'genesis-close');
  assert.deepEqual(store.cancel('genesis-close'), origin);
  assert.deepEqual(usePlanGenesisStore.getState().results['genesis-close'], { origin, planId: null });
  store.clearResult('genesis-close');
});
