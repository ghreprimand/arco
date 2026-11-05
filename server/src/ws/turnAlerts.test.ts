import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, WorkflowState } from '../workflows/types.js';
import type { AttentionEventMessage, ServerMessage } from '@arco/shared';
import type WebSocket from 'ws';

// Turn alerts for real-shaped turns: the turn engine runs each turn through
// runPrimaryTurn, which reports its start and end through send(). Before, only
// broadcastWorkflow fed attention.ts, so no real turn ever raised "finished".
const temp = mkdtempSync(join(tmpdir(), 'arco-turn-alerts-')); installIsolatedTestHome(temp);
const engine = await import('./turnEngine.js');
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore } = await import('../workflowStore.js');
const { initNotifications } = await import('../notifications.js');
const attention = await import('../attention.js');
const clusterStore = await import('../clusterStore.js');
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { settleProjectWrites } = await import('../testSupport/projectWrites.js');

const events: AttentionEventMessage[] = [];
await initNotifications((message: ServerMessage) => { if (message.type === 'attention_event') events.push(message); });
attention._setChannelsPathForTest(join(temp, 'notification-channels.json'));
await attention.loadChannels();
await attention.saveChannels({ desktop: { finished: true, failed: true, waiting: true } });
engine.initTurnEngine({ previewAutoDetect: { noteAgentText: () => {}, notePotentialDevServerStart: () => {} } as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {} });
after(async () => { await settleProjectWrites(); await closeRecall(); rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

interface Fixture { id: string; cwd: string; wf: WorkflowState; ws: WebSocket; session: Session }

// A provider-shaped worker: emits text, completes, and lets the clock pass the
// 15-second floor so the finished alert is also eligible for the desktop.
function fixture(provider: string, extra: Record<string, unknown> = {}, socketOpen = true): Fixture {
  const id = randomUUID(); const cwd = join(temp, id); mkdirSync(cwd, { recursive: true });
  const ws = { readyState: socketOpen ? 1 : 3, send: () => undefined } as unknown as WebSocket;
  const manager = {
    spawn: (spec: { task: string }, emit: (event: unknown) => void) => new Promise((resolve) => {
      setImmediate(() => {
        const realNow = Date.now; const shifted = realNow() + attention.MIN_FINISHED_TURN_MS + 1000;
        Date.now = () => shifted;
        emit({ type: 'worker_text', text: 'answer ' + spec.task });
        emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 });
        resolve({ text: 'answer', costUsd: 0, durationMs: 1 });
        setImmediate(() => { Date.now = realNow; });
      });
    }),
    getWorkerPid: () => undefined,
  };
  const wf = {
    config: { name: `Fixture ${provider}`, workingDirectory: cwd, primaryProvider: provider, primaryModel: 'fixture', primaryEffort: 'medium', skipPermissions: false, ...extra },
    primary: { provider, model: 'fixture', effort: 'medium', skipPermissions: false },
    manager, busy: false, observers: new Set([ws]), queue: { steering: [], followUp: [] },
  } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  const session = { id: 'fixture', workflowIds: new Set([id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  return { id, cwd, wf, ws, session };
}

async function turn(f: Fixture): Promise<AttentionEventMessage[]> {
  await initWorkflowStore(f.cwd, f.id);
  const before = events.length;
  await engine.handleUserMessage(f.ws, f.session, f.id, 'hello', randomUUID(), undefined, false, undefined, undefined);
  for (let i = 0; i < 100 && events.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  return events.slice(before).filter((e) => e.workflowId === f.id);
}

for (const [label, provider, extra] of [
  ['Claude CLI', 'claude', { claudeTransport: 'cli' }],
  ['Claude Native', 'claude', { claudeTransport: 'native' }],
  ['Codex app-server', 'codex', {}],
  ['Ollama', 'ollama', {}],
] as const) {
  test(`${label}: an operator turn raises one finished alert`, async () => {
    const f = fixture(provider, extra);
    try {
      const raised = await turn(f);
      assert.deepEqual(raised.map((e) => [e.kind, e.workflowName, e.desktopEligible]), [['finished', `Fixture ${provider}`, true]]);
    } finally { workflows.delete(f.id); workflowCwds.delete(f.id); }
  });
}

test('an auto-pickup turn (no operator socket) raises the finished alert', async () => {
  const f = fixture('claude', {}, false);
  try {
    const raised = await turn(f);
    assert.deepEqual(raised.map((e) => e.kind), ['finished']);
  } finally { workflows.delete(f.id); workflowCwds.delete(f.id); }
});

test('cluster members: every finished turn reaches the BELL; the desktop follows the cluster finished source', async () => {
  const director = fixture('claude'); const builder = fixture('codex');
  const cluster = await clusterStore.createCluster({ cwd: director.cwd, memberWorkflowIds: [director.id, builder.id] });
  await clusterStore.setMemberRole(cluster.clusterId, director.id, 'Director');
  await clusterStore.setMemberRole(cluster.clusterId, builder.id, 'Builder');
  try {
    assert.deepEqual((await turn(builder)).map((e) => [e.kind, e.desktopEligible]), [['finished', false]]);
    assert.deepEqual((await turn(director)).map((e) => [e.kind, e.desktopEligible]), [['finished', true]]);
    await attention.saveChannels({ desktop: { finished: true, failed: true, waiting: true }, clusterFinished: 'all' });
    await new Promise((r) => setTimeout(r, 3100)); // one alert per workflow and kind every 3 seconds
    assert.deepEqual((await turn(builder)).map((e) => [e.kind, e.desktopEligible]), [['finished', true]]);
  } finally {
    await attention.saveChannels({ desktop: { finished: true, failed: true, waiting: true } });
    await clusterStore.deleteCluster(cluster.clusterId);
    for (const f of [director, builder]) { workflows.delete(f.id); workflowCwds.delete(f.id); }
  }
});

test('an incognito turn raises nothing', async () => {
  const f = fixture('claude', { incognito: true });
  try {
    assert.deepEqual(await turn(f), []);
  } finally { workflows.delete(f.id); workflowCwds.delete(f.id); }
});
