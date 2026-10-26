import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@arco/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';

// A browser with no saved tabs that connects to a server already holding a
// cluster receives the cluster roster, asks the server for each member it has
// no job for (cluster_member_rehydrate), and gets workflow_created back. That
// restore focuses the member -- intended for a returning workspace -- but must
// not replace a creator the operator opened explicitly (+NEW, Ctrl+K, command
// palette) after connecting.

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

const sent: Array<Record<string, unknown>> = [];
const socket = {
  readyState: WebSocket.OPEN,
  send: (raw: string) => { sent.push(JSON.parse(raw) as Record<string, unknown>); },
} as unknown as WebSocket;
const deps: WsDeps = { wsRef: { current: socket }, scheduleReconnect: () => {} };
const deliver = (msg: Record<string, unknown>) =>
  handleServerMessage(msg as unknown as ServerMessage, deps);

const config = (name: string) => ({
  name,
  primaryModel: 'gpt-5.6-sol',
  primaryEffort: 'high',
  primaryProvider: 'codex',
}) as unknown as WorkflowConfig;

let run = 0;
function freshBrowser() {
  run += 1;
  sent.length = 0;
  useAppStore.setState({
    jobs: {}, clusters: {}, activeJobId: null, activeClusterId: null,
    showCreator: true, creatorRequested: false, showHome: false, creatorPrefill: null,
  });
  return { clusterId: `cluster-${run}`, member: `member-${run}` };
}

// The server's restore burst for one cluster member, in wire order.
function restoreMember(clusterId: string, member: string) {
  deliver({
    type: 'cluster_state',
    clusterId,
    state: { clusterId, name: 'restored', members: [{ workflowId: member, displayName: 'Builder' }] },
  });
  assert.ok(
    sent.some((m) => m.type === 'cluster_member_rehydrate' && m.workflowId === member),
    'the browser asks the server to materialize the missing member',
  );
  deliver({ type: 'workflow_created', workflowId: member, config: config('Builder') });
}

test('a late member restore still opens the returning workspace by default', () => {
  const { clusterId, member } = freshBrowser();
  restoreMember(clusterId, member);
  const s = useAppStore.getState();
  assert.ok(s.jobs[member]);
  assert.equal(s.activeJobId, member);
  assert.equal(s.showCreator, false);
});

test('a late member restore does not replace a creator the operator opened', () => {
  const { clusterId, member } = freshBrowser();
  useAppStore.getState().showJobCreator();
  restoreMember(clusterId, member);
  const s = useAppStore.getState();
  assert.ok(s.jobs[member], 'the restored member still materializes');
  assert.equal(s.showCreator, true, 'the creator stays open');
  assert.equal(s.activeJobId, null);
  assert.equal(s.activeClusterId, null);
});

test('a workflow the operator creates from that creator takes focus', () => {
  const { clusterId, member } = freshBrowser();
  useAppStore.getState().showJobCreator();
  restoreMember(clusterId, member);
  deliver({ type: 'workflow_created', workflowId: `new-${run}`, config: config('New') });
  const s = useAppStore.getState();
  assert.equal(s.activeJobId, `new-${run}`);
  assert.equal(s.showCreator, false);
  assert.equal(s.creatorRequested, false);
});

test('choosing a tab ends the creator request, so later restores behave as before', () => {
  const { clusterId, member } = freshBrowser();
  useAppStore.getState().createJob('open-tab', config('Open'), undefined, undefined, true);
  useAppStore.getState().showJobCreator();
  useAppStore.getState().setActiveJob('open-tab');
  assert.equal(useAppStore.getState().creatorRequested, false);
  restoreMember(clusterId, member);
  assert.equal(useAppStore.getState().activeJobId, member);
});

test('an explicitly opened Home survives a late member restore', () => {
  const { clusterId, member } = freshBrowser();
  useAppStore.setState({ showHome: false });
  useAppStore.getState().showHomeView();
  restoreMember(clusterId, member);
  const s = useAppStore.getState();
  assert.ok(s.jobs[member], 'the restored member still materializes');
  assert.equal(s.showHome, true);
  assert.equal(s.activeJobId, null);
});

test('Home start actions open the creator pre-filled once; the next creation leaves Home', () => {
  freshBrowser();
  useAppStore.getState().showHomeView();
  useAppStore.getState().openCreatorWith({ mode: 'cluster', workDir: '/projects/app' });
  let s = useAppStore.getState();
  assert.equal(s.showHome, false);
  assert.equal(s.showCreator, true);
  assert.equal(s.creatorRequested, true, 'a late restore does not replace this creator either');
  assert.deepEqual(s.takeCreatorPrefill(), { mode: 'cluster', workDir: '/projects/app' });
  assert.equal(useAppStore.getState().takeCreatorPrefill(), null, 'one-shot');
  useAppStore.getState().showHomeView();
  deliver({ type: 'workflow_created', workflowId: `made-${run}`, config: config('Made') });
  s = useAppStore.getState();
  assert.equal(s.activeJobId, `made-${run}`);
  assert.equal(s.showHome, false);
});

test('choosing a tab or a cluster leaves Home', () => {
  freshBrowser();
  useAppStore.getState().createJob('tab', config('Tab'), undefined, undefined, true);
  useAppStore.getState().showHomeView();
  useAppStore.getState().setActiveJob('tab');
  assert.equal(useAppStore.getState().showHome, false);
  useAppStore.getState().showHomeView();
  useAppStore.getState().setActiveCluster('c');
  assert.equal(useAppStore.getState().showHome, false);
  useAppStore.getState().showHomeView();
  useAppStore.getState().showJobCreator();
  assert.equal(useAppStore.getState().showHome, false);
});
