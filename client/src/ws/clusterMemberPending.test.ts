import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { openWork, standaloneTabJobs } from '../utils/homeModel.js';

// Creating or growing a cluster: the server announces each new member
// (workflow_created) before the cluster state that lists it. No member may
// show as its own tab, in Home or take focus at any point of that sequence.

const persisted = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return persisted.size; },
    clear: () => persisted.clear(),
    getItem: (key: string) => persisted.get(key) ?? null,
    key: (index: number) => [...persisted.keys()][index] ?? null,
    removeItem: (key: string) => persisted.delete(key),
    setItem: (key: string, value: string) => persisted.set(key, value),
  } satisfies Storage,
});

const socket = { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket;
const deps: WsDeps = { wsRef: { current: socket }, scheduleReconnect: () => {} };
const deliver = (msg: Record<string, unknown>) => handleServerMessage(msg as unknown as ServerMessage, deps);
const config = (name: string) => ({ name, primaryModel: 'claude-sonnet-4-6', primaryEffort: 'high', primaryProvider: 'claude', workingDirectory: '/fixture' }) as unknown as WorkflowConfig;
const state = (clusterId: string, ids: string[]) => ({ clusterId, name: 'Team', cwd: '/fixture', createdAt: '2026-11-07T00:00:00Z', mailboxDepth: {},
  members: ids.map((workflowId) => ({ workflowId, displayName: workflowId, status: 'idle' })) });

function reset() {
  useAppStore.setState({ jobs: {}, clusters: {}, activeJobId: null, activeClusterId: null, showCreator: true, creatorRequested: true, showHome: false });
}
function standaloneIds(): string[] {
  const s = useAppStore.getState();
  return standaloneTabJobs(Object.values(s.jobs), Object.values(s.clusters)).map((j) => j.id);
}
function homeIds(): string[] {
  const s = useAppStore.getState();
  return openWork(s.jobs, s.clusters).filter((i) => i.kind !== 'cluster').map((i) => i.id);
}
function assertNoMemberOutside(members: string[], step: string) {
  const s = useAppStore.getState();
  for (const id of members) {
    assert.ok(!standaloneIds().includes(id), `${step}: ${id} has its own tab`);
    assert.ok(!homeIds().includes(id), `${step}: ${id} is listed in Home as a workflow`);
    assert.notEqual(s.activeJobId, id, `${step}: ${id} took focus`);
  }
}

test('a seven-member cluster never shows a member as its own tab, then opens as one cluster tab', () => {
  reset();
  const members = Array.from({ length: 7 }, (_, i) => `m${i + 1}`);
  for (const id of members) {
    deliver({ type: 'workflow_created', workflowId: id, config: config(id), clusterMemberPending: true });
    assertNoMemberOutside(members, `after workflow_created ${id}`);
  }
  deliver({ type: 'cluster_created', clusterId: 'c7', state: state('c7', members) });
  assertNoMemberOutside(members, 'after cluster_created');
  const s = useAppStore.getState();
  assert.equal(s.activeClusterId, 'c7');
  assert.deepEqual(standaloneIds(), []);
  assert.ok(members.every((id) => s.jobs[id] && !s.jobs[id].pendingClusterMember), 'members are no longer pending once listed');
});

test('ADD WORKERS and REPLACE keep the new member inside the cluster', () => {
  reset();
  deliver({ type: 'workflow_created', workflowId: 'own', config: config('own') });
  deliver({ type: 'workflow_created', workflowId: 'a', config: config('a'), clusterMemberPending: true });
  deliver({ type: 'workflow_created', workflowId: 'b', config: config('b'), clusterMemberPending: true });
  deliver({ type: 'cluster_created', clusterId: 'c2', state: state('c2', ['a', 'b']) });
  // ADD WORKERS: the new member arrives, then cluster_member_added and cluster_state.
  deliver({ type: 'workflow_created', workflowId: 'c', config: config('c'), clusterMemberPending: true });
  assertNoMemberOutside(['a', 'b', 'c'], 'add: after workflow_created');
  deliver({ type: 'cluster_member_added', clusterId: 'c2', member: { workflowId: 'c', displayName: 'c', status: 'idle' } });
  assertNoMemberOutside(['a', 'b', 'c'], 'add: after cluster_member_added');
  deliver({ type: 'cluster_state', clusterId: 'c2', state: state('c2', ['a', 'b', 'c']) });
  assertNoMemberOutside(['a', 'b', 'c'], 'add: after cluster_state');
  // REPLACE b with d.
  deliver({ type: 'workflow_created', workflowId: 'd', config: config('d'), clusterMemberPending: true });
  assertNoMemberOutside(['a', 'b', 'c', 'd'], 'replace: after workflow_created');
  deliver({ type: 'cluster_member_replaced', clusterId: 'c2', oldWorkflowId: 'b', newWorkflowId: 'd', accessMode: 'standard' });
  deliver({ type: 'cluster_state', clusterId: 'c2', state: state('c2', ['a', 'c', 'd']) });
  assertNoMemberOutside(['a', 'c', 'd'], 'replace: after cluster_state');
  assert.deepEqual(standaloneIds(), ['own'], 'an ordinary workflow keeps its tab');
});

test('a failed cluster create shows the members it made as standalone tabs', () => {
  reset();
  deliver({ type: 'workflow_created', workflowId: 'x', config: config('x'), clusterMemberPending: true });
  deliver({ type: 'workflow_created', workflowId: 'y', config: config('y'), clusterMemberPending: true });
  assert.deepEqual(standaloneIds(), []);
  deliver({ type: 'error', message: 'cluster_create_from_scratch rejected: create_failed' });
  assert.deepEqual(standaloneIds().sort(), ['x', 'y']);
});

test('an unrelated error does not reveal members still being created', () => {
  reset();
  deliver({ type: 'workflow_created', workflowId: 'p', config: config('p'), clusterMemberPending: true });
  deliver({ type: 'error', message: 'Unknown workflow 12345678' });
  assert.deepEqual(standaloneIds(), []);
});

test('B35: a fresh socket retries a member lost before rehydrate completed', () => {
  reset();
  const frames: string[] = [];
  const connection = () => ({ readyState: WebSocket.OPEN, send: (value: string) => frames.push(value) }) as unknown as WebSocket;
  deps.wsRef.current = connection();
  deliver({type:'cluster_state',clusterId:'retry-cluster',state:state('retry-cluster',['lost-member'])});
  deps.wsRef.current = connection();
  deliver({type:'cluster_state',clusterId:'retry-cluster',state:state('retry-cluster',['lost-member'])});
  assert.equal(frames.filter(frame => JSON.parse(frame).type === 'cluster_member_rehydrate').length,2);
});
