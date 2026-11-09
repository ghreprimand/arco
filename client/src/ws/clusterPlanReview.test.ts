import { submitClusterCreation } from '../utils/clusterCreation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { beginPlanRefine, beginPlanReview } from '../components/terminalInput/planDraft.js';

useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });

test('cluster plan review captures a candidate without saving it', () => {
  const id = 'plan-review-fixture';
  const config = { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig;
  useAppStore.getState().createJob(id, config);
  useAppStore.setState({ clusters: { cluster: { clusterId: 'cluster', members: [{ workflowId: id }] } } as never });
  useAppStore.getState().setPendingPlanCapture(id, 'review');
  const sent: string[] = [];
  const deps: WsDeps = { wsRef: { current: { readyState: 1, send: (body: string) => sent.push(body) } as unknown as WebSocket }, scheduleReconnect: () => {} };
  const emit = (message: object) => handleServerMessage(message as ServerMessage, deps);
  emit({ type: 'primary_turn_started', workflowId: id, startedAt: 1, seq: 1 });
  emit({ type: 'primary_text', workflowId: id, phase: 'passthrough', text: '# Plan\n\n- [ ] First\n- [ ] Second\n- [ ] Third', seq: 2 });
  emit({ type: 'primary_complete', workflowId: id, phase: 'passthrough', seq: 3 });
  assert.equal(sent.some((body) => JSON.parse(body).type === 'cluster_plan_set'), false);
  assert.equal(useAppStore.getState().jobs[id].planCandidate?.mode, 'review');
});

for (const outcome of ['success', 'failure', 'removed'] as const) test(`cluster creation precedes the public-choice refresh; draft ${outcome}`, async t => {
  const id = `plan-start-${outcome}`, clusterId = `cluster-${outcome}`;
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: `/projects/${outcome}`, skipPermissions: false } as WorkflowConfig);
  const sent: Array<Record<string, unknown>> = [];
  const deps: WsDeps = { wsRef: { current: { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket }, scheduleReconnect: () => {} };
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  handleServerMessage({ type: 'cluster_created', clusterId, state: { clusterId, cwd: `/projects/${outcome}`, members: [{ workflowId: id, role: 'Director', displayName: 'Director' }] }, initialPlanDraft: { workflowId: id, goal: 'Make a small tool' } } as unknown as ServerMessage, deps);
  assert.ok(useAppStore.getState().clusters[clusterId], 'the cluster is available before the choice request finishes');
  assert.equal(sent.some(message => message.type === 'user_message'), false, 'the draft still waits for the authoritative choice');
  await new Promise(resolve => setImmediate(resolve));
  if (outcome === 'removed') useAppStore.getState().clearCluster(clusterId);
  finish(outcome === 'failure' ? new Response('Unavailable', { status: 503 }) : Response.json({ choice: true }));
  await new Promise(resolve => setImmediate(resolve));
  const request = sent.find(message => message.type === 'user_message');
  if (outcome !== 'success') assert.equal(request, undefined);
  else {
    assert.equal(request?.workflowId, id); assert.equal(request?.primitive, 'plan-review');
    assert.match(String(request?.content), /Make a small tool/);
    assert.match(String(request?.content), /public/);
    assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture, 'review');
    assert.equal(sent.some(message => message.type === 'cluster_plan_set'), false);
  }
});

test('cluster creation pending clears on rejection and disconnection', () => {
  const deps: WsDeps = { wsRef: { current: null }, scheduleReconnect() {} };
  let requestId = '';
  submitClusterCreation(id => { requestId = id; });
  handleServerMessage({ type: 'error', message: 'Invalid cluster creation settings' } as ServerMessage, deps);
  assert.equal(useAppStore.getState().clusterCreationPending, true);
  handleServerMessage({ type: 'cluster_creation_finished', requestId } as ServerMessage, deps);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
  useAppStore.setState({ clusterCreationPending: true });
  useAppStore.getState().setConnected(false);
  assert.equal(useAppStore.getState().clusterCreationPending, false);
});

test('plan-shaped cluster replies are offered for review without an implicit save', () => {
  const id = 'detected-plan-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  useAppStore.setState({ clusters: { cluster: { clusterId: 'cluster', members: [{ workflowId: id }] } } as never });
  const sent: Array<Record<string, unknown>> = [];
  const deps: WsDeps = { wsRef: { current: { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket }, scheduleReconnect: () => {} };
  for (const message of [
    { type: 'primary_turn_started', workflowId: id, startedAt: 1, seq: 1 },
    { type: 'primary_text', workflowId: id, phase: 'passthrough', text: '# Plan\n\n- [ ] First\n- [ ] Second\n- [ ] Third', seq: 2 },
    { type: 'primary_complete', workflowId: id, phase: 'passthrough', seq: 3 },
  ]) handleServerMessage(message as ServerMessage, deps);
  assert.equal(useAppStore.getState().jobs[id].planCandidate?.mode, 'review');
  assert.equal(sent.some((message) => message.type === 'cluster_plan_set'), false);
});

test('review capture is not armed for a failed send or a busy worker', () => {
  const id = 'draft-send-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  assert.equal(beginPlanReview(id, () => false), false);
  assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture, null);
  useAppStore.setState((state) => ({ jobs: { ...state.jobs, [id]: { ...state.jobs[id], busy: true } } }));
  assert.equal(beginPlanReview(id, () => { throw new Error('busy worker must not send'); }), false);
  assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture, null);
});

test('cluster auto-save remains a review candidate', () => {
  const id = 'plan-autosave-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  useAppStore.setState({ clusters: { cluster: { clusterId: 'cluster', members: [{ workflowId: id }] } } as never });
  useAppStore.getState().setPendingPlanCapture(id, 'autosave');
  const sent: Array<Record<string, unknown>> = [];
  const deps: WsDeps = { wsRef: { current: { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket }, scheduleReconnect: () => {} };
  for (const message of [
    { type: 'primary_turn_started', workflowId: id, startedAt: 1, seq: 1 },
    { type: 'primary_text', workflowId: id, phase: 'passthrough', text: '# Plan\n\n- [ ] First', seq: 2 },
    { type: 'primary_complete', workflowId: id, phase: 'passthrough', seq: 3 },
  ]) handleServerMessage(message as ServerMessage, deps);
  assert.equal(sent.some((message) => message.type === 'cluster_plan_set'), false);
  assert.equal(useAppStore.getState().jobs[id].planCandidate?.mode, 'review');
});

test('refining a plan draft sends the draft and note, keeps the old draft until the reply, and guards busy or missing drafts', () => {
  const id = 'plan-refine-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const prompts: string[] = [];
  assert.equal(beginPlanRefine(id, (p) => { prompts.push(p); }, 'Add tests', false), false);
  useAppStore.getState().setPlanCandidate(id, { body: '# Old\n- [ ] One', mode: 'review', capturedAt: 1 });
  assert.equal(beginPlanRefine(id, (p) => { prompts.push(p); }, '   ', false), false);
  assert.equal(beginPlanRefine(id, (p) => { prompts.push(p); }, 'Add tests', true), true);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Add tests/);
  assert.match(prompts[0], /# Old/);
  assert.match(prompts[0], /Do not create, update, attach, or write/);
  assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture, 'review');
  assert.equal(useAppStore.getState().jobs[id].planCandidate?.body, '# Old\n- [ ] One');
  assert.equal(beginPlanRefine(id, (p) => { prompts.push(p); }, 'Again', false), false);
  useAppStore.getState().setPendingPlanCapture(id, null);
  assert.equal(beginPlanRefine(id, () => false, 'Rejected', false), false);
  assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture ?? null, null);
});
