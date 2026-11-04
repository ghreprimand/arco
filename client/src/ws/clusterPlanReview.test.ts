import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { beginPlanReview } from '../components/terminalInput/planDraft.js';

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

test('cluster creation starts only the selected director draft in review mode', () => {
  const id = 'plan-start-fixture';
  useAppStore.getState().createJob(id, { name: 'fixture', primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: '/fixture', skipPermissions: false } as WorkflowConfig);
  const sent: Array<Record<string, unknown>> = [];
  const deps: WsDeps = { wsRef: { current: { readyState: 1, send: (body: string) => sent.push(JSON.parse(body)) } as unknown as WebSocket }, scheduleReconnect: () => {} };
  handleServerMessage({ type: 'cluster_created', clusterId: 'new-cluster', state: { clusterId: 'new-cluster', cwd: '/fixture', members: [{ workflowId: id, role: 'Director', displayName: 'Director' }] }, initialPlanDraft: { workflowId: id, goal: 'Make a small tool' } } as unknown as ServerMessage, deps);
  const request = sent.find((message) => message.type === 'user_message');
  assert.equal(request?.workflowId, id);
  assert.equal(request?.primitive, 'plan-review');
  assert.match(String(request?.content), /Make a small tool/);
  assert.equal(useAppStore.getState().jobs[id].pendingPlanCapture, 'review');
  assert.equal(sent.some((message) => message.type === 'cluster_plan_set'), false);
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
