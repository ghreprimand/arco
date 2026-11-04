import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type WebSocket from 'ws';
import { workflows, workflowCwds } from './server/state.js';
import { broadcastCluster } from './server/broadcast.js';
import * as clusterStore from './clusterStore.js';
import { handleTaskLedgerCreate, handleTaskLedgerList } from './ws/taskLedgerHandlers.js';
import { flushWorkflowBuffer, initWorkflowStore, replayEvents } from './workflowStore.js';
import { writeMeta } from './workflowMeta.js';
import * as taskLedger from './project/taskLedger.js';
import { planBodyHash, planHistoryDir } from './planHistory.js';
import { listPlans } from './planStore.js';
import type { WorkflowState } from './workflows/types.js';
import type { WorkflowMeta } from './workflowMeta.js';

// P7.2 (docs/STORAGE_PLAN.md): full board copies are sent live but never
// written to events.jsonl; the per-change records still are, and they rebuild
// the board. Plan bodies are stored once and the log carries their hash.

function fakeObserver(): { ws: WebSocket; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data: string) => { sent.push(JSON.parse(data)); } } as unknown as WebSocket;
  return { ws, sent };
}

async function project(id: string): Promise<{ cwd: string; observer: ReturnType<typeof fakeObserver> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-waste-'));
  const observer = fakeObserver();
  workflows.set(id, { config: { kind: 'single', workingDirectory: cwd }, observers: new Set([observer.ws]), queue: { steering: [], followUp: [] } } as unknown as WorkflowState);
  workflowCwds.set(id, cwd);
  await initWorkflowStore(cwd, id);
  await writeMeta(cwd, { workflowId: id, cwd, name: 'w', createdAt: 1, lastActiveAt: 1, cliSessions: [], primaryProvider: 'ollama', primaryModel: 'fixture' } as unknown as WorkflowMeta);
  return { cwd, observer };
}

async function logTypes(cwd: string, id: string): Promise<string[]> {
  await flushWorkflowBuffer(cwd, id);
  const text = await readFile(path.join(cwd, '.arco', 'workflows', id, 'events.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { type: string }).type);
}

test('board copies reach open tabs but are not written to the log; changes still rebuild the board', async () => {
  const id = 'waste-board-0001';
  const { cwd, observer } = await project(id);
  try {
    const ws = fakeObserver().ws;
    await handleTaskLedgerCreate(ws, { type: 'task_ledger_create', workflowId: id, title: 'first' });
    await handleTaskLedgerCreate(ws, { type: 'task_ledger_create', workflowId: id, title: 'second' });
    await handleTaskLedgerList(ws, { type: 'task_ledger_list', workflowId: id });
    const types = await logTypes(cwd, id);
    assert.equal(types.filter((t) => t === 'task_ledger_snapshot').length, 0);
    assert.equal(types.filter((t) => t === 'task_ledger_event').length, 2);
    const live = observer.sent.filter((m) => m.type === 'task_ledger_snapshot');
    assert.equal(live.length, 3);
    assert.equal(live.every((m) => m.seq === undefined), true);
    assert.deepEqual((live[2].tasks as Array<{ title: string }>).map((t) => t.title).sort(), ['first', 'second']);
    // Losing the ledger store: the board comes back from the change records.
    await rm(path.join(cwd, '.arco', 'project'), { recursive: true, force: true });
    const rebuilt = await taskLedger.rebuildFromEvents(cwd);
    assert.deepEqual(rebuilt.map((t) => t.title).sort(), ['first', 'second']);
  } finally {
    workflows.delete(id); workflowCwds.delete(id);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an old log with board copies still replays them', async () => {
  const id = 'waste-board-0002';
  const { cwd } = await project(id);
  try {
    const legacy = [
      { seq: 1, ts: 1, type: 'workflow_created', workflowId: id },
      { seq: 2, ts: 2, parentEventSeq: 1, type: 'task_ledger_snapshot', workflowId: id, cwd, tasks: [] },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(path.join(cwd, '.arco', 'workflows', id, 'events.jsonl'), legacy);
    const replayed = await replayEvents(cwd, id, 0);
    assert.deepEqual(replayed.map((m) => m.type), ['workflow_created', 'task_ledger_snapshot']);
  } finally {
    workflows.delete(id); workflowCwds.delete(id);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('plan bodies are stored once and the member log carries the hash', async () => {
  const ids = ['waste-plan-0001', 'waste-plan-0002'];
  const cwd = await mkdtemp(path.join(tmpdir(), 'arco-waste-'));
  const live = fakeObserver();
  for (const id of ids) {
    workflows.set(id, { config: { kind: 'single', workingDirectory: cwd }, observers: new Set([live.ws]), queue: { steering: [], followUp: [] } } as unknown as WorkflowState);
    workflowCwds.set(id, cwd);
    await initWorkflowStore(cwd, id);
  }
  const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: ids });
  const clusterId = cluster.clusterId;
  try {
    await mkdir(path.join(cwd, '.arco', 'plans'), { recursive: true });
    const body = '# Plan\n\n- [ ] one\n';
    for (const updatedAt of [1, 2]) broadcastCluster(clusterId, { type: 'cluster_plan_changed', clusterId, body, updatedAt, bodyLength: body.length });
    broadcastCluster(clusterId, { type: 'cluster_plan_changed', clusterId, body: '', updatedAt: 3, bodyLength: 0 });
    const hash = planBodyHash(body);
    assert.deepEqual(await readdir(planHistoryDir(cwd)), [`${hash}.md`]);
    assert.equal(await readFile(path.join(planHistoryDir(cwd), `${hash}.md`), 'utf8'), body);
    for (const id of ids) {
      await flushWorkflowBuffer(cwd, id);
      const rows = (await readFile(path.join(cwd, '.arco', 'workflows', id, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const plans = rows.filter((r) => r.type === 'cluster_plan_changed');
      assert.equal(plans.length, 3);
      assert.equal(plans[0].body, undefined); assert.equal(plans[0].bodySha256, hash); assert.equal(plans[0].bodyLength, body.length);
      // A cleared plan has no body to store; it is logged as before.
      assert.equal(plans[2].body, ''); assert.equal(plans[2].bodySha256, undefined);
    }
    // History files never show up as plans.
    assert.deepEqual(await listPlans(cwd), []);
  } finally {
    await clusterStore.deleteCluster(clusterId).catch(() => undefined);
    for (const id of ids) { workflows.delete(id); workflowCwds.delete(id); }
    await rm(cwd, { recursive: true, force: true });
  }
});
