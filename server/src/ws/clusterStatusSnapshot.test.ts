import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';

const home = mkdtempSync(join(tmpdir(), 'arco-cluster-status-'));
installIsolatedTestHome(home);
const clusters = await import('../clusterStore.js');
const { workflows, sessions } = await import('../server/state.js');
const { handleClusterSubscribe } = await import('./clusterHandlers.js');
const { notifyClusterStateForWorkflow } = await import('../server/broadcast.js');
// Load the browser mirror at runtime without adding client sources to the server build.
const clientMessageModule = '../../../client/src/ws/handleServerMessage.js';
const clientStoreModule = '../../../client/src/stores/appStore.js';
const { handleServerMessage } = await import(clientMessageModule);
const { useAppStore } = await import(clientStoreModule);
useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
const deps = { wsRef: { current: null }, scheduleReconnect: () => {} };
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

for (const initialBusy of [false, true]) test(`late cluster subscription keeps ${initialBusy ? 'settled' : 'started'} member status`, async (t) => {
  const cwd = join(home, randomUUID()); mkdirSync(cwd);
  const id = randomUUID(), other = randomUUID();
  const wf = { busy: initialBusy, config: { name: 'Fixture', workingDirectory: cwd }, primary: { provider: 'claude' }, observers: new Set() } as any;
  workflows.set(id, wf);
  const cluster = await clusters.createCluster({ cwd, memberWorkflowIds: [id, other], taskBoardMode: 'none' });
  const received: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => { const message = JSON.parse(raw); if (message.type === 'cluster_state') { received.push(message); handleServerMessage(message, deps); } } } as any;
  const session = { id: 'fixture', workflowIds: new Set(), clusterIds: new Set([cluster.clusterId]), clusterObserved: new Map() } as any;
  sessions.set(ws, session);
  let proceed!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => { proceed = resolve; });
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const realRead = fs.readdir.bind(fs); let intercepted = false;
  t.mock.method(fs, 'readdir', (async (path: any, ...args: any[]) => {
    if (!intercepted && String(path) === join(clusters.clusterMailboxRoot(cluster.clusterId), id)) { intercepted = true; entered(); await hold; }
    return (realRead as any)(path, ...args);
  }) as typeof fs.readdir);
  let subscription: Promise<void> | undefined;
  try {
    subscription = handleClusterSubscribe(ws, session, cluster.clusterId);
    await blocked;
    wf.busy = !initialBusy;
    await notifyClusterStateForWorkflow(id);
    assert.equal(received.at(-1)?.state.members.find((m: any) => m.workflowId === id)?.status, wf.busy ? 'busy' : 'idle');
    proceed(); await subscription;
    const expected = wf.busy ? 'busy' : 'idle';
    assert.equal(received.at(-1)?.state.members.find((m: any) => m.workflowId === id)?.status, expected, 'late subscription must use current status');
    assert.equal(useAppStore.getState().clusters[cluster.clusterId]?.members.find((m: any) => m.workflowId === id)?.status, expected, 'client mirror must keep current status');
  } finally {
    proceed(); await subscription; sessions.delete(ws); workflows.delete(id);
    useAppStore.getState().clearCluster(cluster.clusterId);
    await clusters.deleteCluster(cluster.clusterId);
  }
});

test('direct created replies and unrelated cluster broadcasts refresh status at send time', async () => {
  const { buildClusterStatePayload, broadcastCluster, send } = await import('../server/broadcast.js');
  const cwd = join(home, randomUUID()); mkdirSync(cwd);
  const id = randomUUID(), other = randomUUID();
  const wf = { busy: false, config: { name: 'Fixture', workingDirectory: cwd }, primary: { provider: 'claude' }, observers: new Set() } as any;
  workflows.set(id, wf);
  const cluster = await clusters.createCluster({ cwd, memberWorkflowIds: [id, other], taskBoardMode: 'none' });
  const received: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => received.push(JSON.parse(raw)) } as any;
  const session = { id: 'fixture', workflowIds: new Set(), clusterIds: new Set([cluster.clusterId]), clusterObserved: new Map() } as any;
  sessions.set(ws, session);
  try {
    const stale = await buildClusterStatePayload(cluster.clusterId); assert.ok(stale);
    wf.busy = true;
    send(ws, { type: 'cluster_created', clusterId: cluster.clusterId, state: stale });
    broadcastCluster(cluster.clusterId, { type: 'cluster_state', clusterId: cluster.clusterId, state: stale });
    assert.deepEqual(received.filter((m) => m.type === 'cluster_created' || m.type === 'cluster_state').map((m) => m.state.members.find((member: any) => member.workflowId === id)?.status), ['busy', 'busy']);
  } finally { sessions.delete(ws); workflows.delete(id); await clusters.deleteCluster(cluster.clusterId); }
});
