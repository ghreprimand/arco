import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { promises as fs, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-decisions-')));
installIsolatedTestHome(root);
const state = await import('./server/state.js');
const ledger = await import('./project/taskLedger.js');
const proposals = await import('./project/orchestrationProposals.js');
const clusterStore = await import('./clusterStore.js');
const handlers = await import('./ws/clusterHandlers.js');
const ledgerHandlers = await import('./ws/taskLedgerHandlers.js');
const store = await import('./workflowStore.js');
const { settleProjectWrites } = await import('./testSupport/projectWrites.js');
after(async () => { await settleProjectWrites(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await fs.mkdtemp(join(root, 'project-'));
  const messages: any[] = [], other: any[] = [];
  const socket = (out: any[]) => ({ readyState: 1, bufferedAmount: 0, send: (s: string) => out.push(JSON.parse(s)) }) as any;
  const ws = socket(messages), second = socket(other);
  const ids = [randomUUID(), randomUUID()];
  for (const [i, id] of ids.entries()) {
    state.workflowCwds.set(id, cwd);
    state.workflows.set(id, { busy: false, observers: new Set([i ? second : ws]), config: { workingDirectory: cwd }, primary: { provider: 'ollama', model: 'fixture', effort: 'medium' }, queue: { steering: [], followUp: [] } } as any);
    await (await import('./workflowMeta.js')).writeMeta(cwd, { workflowId: id, cwd, name: 'Fixture', createdAt: Date.now(), lastActiveAt: Date.now(), primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'medium', cliSessions: [], lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null } as any);
    await store.initWorkflowStore(cwd, id);
  }
  const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: ids });
  await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
  const proposal = (items: any[]) => proposals.create({ clusterId: cluster.clusterId, workflowId: ids[0]!, kind: 'task_graph', model: { provider: 'ollama' }, prompt: 'Fixture', items });
  const apply = (p: any, itemIds: string[]) => handlers.handleClusterOrchestrationProposalApply(ws, { type: 'cluster_orchestration_proposal_apply', clusterId: cluster.clusterId, workflowId: ids[0], proposalId: p.id, itemIds } as any);
  return { cwd, ws, second, messages, other, ids, cluster, proposal, apply };
}
test('B111: concurrent proposal requests preserve both drafts', async () => {
  const f = await fixture();
  await Promise.all(['first', 'second'].map(prompt => handlers.handleClusterOrchestrationAssistRequest(f.ws, { type: 'cluster_orchestration_assist_request', clusterId: f.cluster.clusterId, workflowId: f.ids[0], kind: 'task_graph', prompt } as any)));
  assert.equal((await proposals.load(f.cwd)).length, 2);
});
test('B111: concurrent rejections preserve both decisions', async () => {
  const f = await fixture(), one = f.proposal([]), two = f.proposal([]);
  await proposals.save(f.cwd, [one, two]);
  await Promise.all([one, two].map(p => handlers.handleClusterOrchestrationProposalReject(f.ws, { type: 'cluster_orchestration_proposal_reject', clusterId: f.cluster.clusterId, workflowId: f.ids[0], proposalId: p.id } as any)));
  assert.deepEqual((await proposals.load(f.cwd)).map(p => p.status), ['rejected', 'rejected']);
});
test('B111: simultaneous applies create one task per item', async () => {
  const f = await fixture(), p = f.proposal([{ id: 'one', type: 'task_create', title: 'Once' }]);
  await proposals.save(f.cwd, [p]); await Promise.all([f.apply(p, ['one']), f.apply(p, ['one'])]);
  assert.equal((await ledger.load(f.cwd)).length, 1);
});
for (const separate of [false, true]) test(`B112: dependencies survive ${separate ? 'separate applies' : 'reversed selection'}`, async () => {
  const f = await fixture(), p = f.proposal([{ id: 'parent', type: 'task_create', title: 'Parent' }, { id: 'child', type: 'task_create', title: 'Child', parentItemIds: ['parent'] }]);
  await proposals.save(f.cwd, [p]);
  if (separate) { await f.apply(p, ['parent']); await f.apply(p, ['child']); } else await f.apply(p, ['child', 'parent']);
  const tasks = await ledger.load(f.cwd), parent = tasks.find(t => t.title === 'Parent')!, child = tasks.find(t => t.title === 'Child')!;
  assert.ok(child); assert.deepEqual(child.parentIds, [parent.id]);
});
for (const change of ['assignee', 'dependency', 'busy', 'daemon'] as const) test(`B57: dispatch rechecks ${change} after selection`, async () => {
  const f = await fixture(), dispatcher = await import('./taskDispatcher.js');
  const task = ledger.newTask({ title: 'Selected' });
  const ready = ledger.applyUpdate([task], task.id, { status: 'ready', assignee: f.ids[1] })!.updated;
  await ledger.save(f.cwd, [ready]); let fired = 0, calls = 0;
  const result = await dispatcher.dispatchOnce({ clusterId: f.cluster.clusterId, requestedByWorkflowId: f.ids[0]!, source: change === 'daemon' ? 'daemon' : 'manual', dispatchTaskTurn: () => { fired++; }, shouldContinue: async () => {
    if (++calls === 1) {
      if (change === 'assignee' || change === 'dependency') await ledgerHandlers.persistLedgerMutation(f.ids[0]!, f.cwd, 'update', tasks => {
        const applied = ledger.applyUpdate(tasks, task.id, change === 'assignee' ? { assignee: f.ids[0] } : { parentIds: ['missing'] })!;
        return { tasks: applied.tasks, id: task.id, task: applied.updated };
      });
      if (change === 'busy') state.workflows.get(f.ids[1]!)!.busy = true;
    }
    return true;
  } });
  assert.ok(!('error' in result)); assert.equal(fired, 0);
  assert.equal((await ledger.load(f.cwd))[0]!.assignee, change === 'assignee' ? f.ids[0] : f.ids[1]);
});
test('B118: shared project snapshots reach both workflows once per socket', async () => {
  const f = await fixture(); state.workflows.get(f.ids[1]!)!.observers.add(f.ws);
  await ledgerHandlers.handleTaskLedgerCreate(f.ws, { type: 'task_ledger_create', workflowId: f.ids[0]!, title: 'Shared' });
  assert.equal(f.messages.filter(m => m.type === 'task_ledger_snapshot').length, 1);
  assert.equal(f.other.filter(m => m.type === 'task_ledger_snapshot').length, 1);
});
test('B114: a scaffold reserves the workflow before awaiting the migration', async (t) => {
  const f = await fixture(), genesis = await import('./ws/genesisHandlers.js');
  const scratch = join(root, '.arco', 'genesis', randomUUID()); await fs.mkdir(scratch, { recursive: true });
  const id = f.ids[0]!, wf = state.workflows.get(id)!;
  wf.config.workingDirectory = scratch; state.workflowCwds.set(id, scratch);
  wf.config.genesisSeed = { title: 'Fixture' } as any; await store.initWorkflowStore(scratch, id);
  const mkdir = fs.mkdir; let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => release = r);
  const target = join(root, 'scaffold-target'); let once = true;
  t.mock.method(fs, 'mkdir', async (...args: any[]) => {
    if (String(args[0]).startsWith(target) && once) { once = false; entered(); await blocked; throw new Error('Fixture folder failure'); }
    return Reflect.apply(mkdir, fs, args);
  }); syncBuiltinESMExports();
  const msg = { type: 'genesis_scaffold', workflowId: id, root: target } as any;
  const running = genesis.handleGenesisScaffold(f.ws, msg); await started;
  try {
    assert.equal(wf.busy, true);
    await genesis.handleGenesisScaffold(f.ws, msg);
    assert.ok(f.messages.some(m => m.type === 'error' && /while a turn/.test(m.message)));
  } finally { release(); await running; t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(wf.busy, false);
});

for (const kind of ['task_create', 'task_update', 'task_comment'] as const) test(`B111: ${kind} receipt survives a failed acceptance save and unrelated edits`, async (t) => {
  const f = await fixture(), base = ledger.newTask({ title: 'Original' });
  await ledger.save(f.cwd, [base]);
  const item = kind === 'task_create' ? { id: 'effect', type: kind, title: 'Created once' }
    : kind === 'task_update' ? { id: 'effect', type: kind, taskId: base.id, patch: { title: 'Proposal edit' } }
    : { id: 'effect', type: kind, taskId: base.id, body: 'Comment once' };
  const p = f.proposal([item]); await proposals.save(f.cwd, [p]);
  const rename = fs.rename; let fail = true;
  t.mock.method(fs, 'rename', async (...args: any[]) => {
    if (String(args[1]).endsWith('orchestration-proposals.json') && fail) { fail = false; throw Object.assign(new Error('Fixture acceptance failure'), { code: 'EIO' }); }
    return Reflect.apply(rename, fs, args);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.apply(p, ['effect']), /Fixture acceptance failure/);
    await ledgerHandlers.persistLedgerMutation(f.ids[0]!, f.cwd, 'update', tasks => {
      const applied = ledger.applyUpdate(tasks, base.id, { title: 'Later operator edit' })!;
      return { tasks: applied.tasks, id: base.id, task: applied.updated };
    });
    await f.apply(p, ['effect']);
    const saved = await ledger.loadKernel(f.cwd);
    assert.equal(saved.tasks.length, kind === 'task_create' ? 2 : 1);
    assert.equal(saved.tasks.find(task => task.id === base.id)!.title, 'Later operator edit');
    assert.equal(saved.comments.length, kind === 'task_comment' ? 1 : 0);
    assert.equal((await proposals.load(f.cwd))[0]!.status, 'accepted');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('B112: unresolved and cyclic parents refuse the selection before any task effect', async () => {
  for (const cycle of [false, true]) {
    const f = await fixture(), p = f.proposal([{ id: 'one', type: 'task_create', title: 'One', parentItemIds: ['two'] }, { id: 'two', type: 'task_create', title: 'Two', ...(cycle ? { parentItemIds: ['one'] } : {}) }]);
    await proposals.save(f.cwd, [p]); await f.apply(p, cycle ? ['one', 'two'] : ['one']);
    assert.deepEqual(await ledger.load(f.cwd), []);
    assert.ok(f.messages.some(m => m.type === 'error' && /dependency/.test(m.message)));
  }
});

test('B114: STOP cannot admit a new busy claim during a storage migration', async () => {
  const f = await fixture(), engine = await import('./ws/turnEngine.js'), wf = state.workflows.get(f.ids[0]!)!;
  const release = engine.reserveWorkflowMigration(wf);
  try {
    engine.revokeBusy(wf);
    assert.equal(wf.busy, true);
    assert.throws(() => engine.claimBusy(wf), /storage is moving/);
  } finally { release(); }
  assert.equal(wf.busy, false);
  const token = engine.claimBusy(wf); engine.releaseBusy(wf, token);
});

test('B111: event replay restores receipts alongside their ledger effects', async (t) => {
  const f = await fixture(), p = f.proposal([{ id: 'one', type: 'task_create', title: 'Durable once' }]);
  await proposals.save(f.cwd, [p]);
  const rename = fs.rename; let fail = true;
  t.mock.method(fs, 'rename', async (...args: any[]) => {
    if (String(args[1]).endsWith('orchestration-proposals.json') && fail) { fail = false; throw Object.assign(new Error('Fixture acceptance failure'), { code: 'EIO' }); }
    return Reflect.apply(rename, fs, args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(f.apply(p, ['one'])); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  await settleProjectWrites();
  await fs.writeFile(join(f.cwd, '.arco', 'project', 'tasks.json'), '{broken');
  assert.equal((await ledger.load(f.cwd)).length, 1);
  assert.equal(Object.keys((await ledger.loadKernel(f.cwd)).proposalReceipts ?? {}).length, 1);
  await f.apply(p, ['one']); assert.equal((await ledger.load(f.cwd)).length, 1);
});

test('B114: messages and STOP are refused before writing into a moving store', async () => {
  const f = await fixture(), engine = await import('./ws/turnEngine.js'), workflowHandlers = await import('./ws/workflowHandlers.js');
  const wf = state.workflows.get(f.ids[0]!)!, release = engine.reserveWorkflowMigration(wf);
  try {
    await engine.handleUserMessage(f.ws, { workflowIds: new Set(f.ids) } as any, f.ids[0]!, 'Must not be acknowledged yet', 'moving-message', undefined, false, undefined, undefined);
    workflowHandlers.handleCancel(f.ws, f.ids[0]!);
    assert.equal(wf.queue.followUp.length, 0);
    assert.ok(f.messages.some(m => m.type === 'error' && /Message not sent/.test(m.message)));
    assert.ok(!f.messages.some(m => m.type === 'user_message_echo' || m.type === 'turn_cancelled'));
    assert.equal(wf.busy, true);
  } finally { release(); }
});

test('B114: a message already preparing context prevents a scaffold reservation', async (t) => {
  const f = await fixture(), engine = await import('./ws/turnEngine.js'), wf = state.workflows.get(f.ids[0]!)!;
  const file = join(f.cwd, 'context.txt'); await fs.writeFile(file, 'Fixture context');
  const read = fs.open; let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => entered = r), blocked = new Promise<void>(r => release = r);
  t.mock.method(fs, 'open', async (...args: any[]) => {
    if (String(args[0]) === file) { entered(); await blocked; }
    return Reflect.apply(read, fs, args);
  }); syncBuiltinESMExports();
  const pending = engine.handleUserMessage(f.ws, { workflowIds: new Set(f.ids) } as any, f.ids[0]!, '@file:context.txt', 'preparing-message', undefined, true, 'follow-up', undefined);
  await started;
  try { assert.equal(wf.busy, false); assert.throws(() => engine.reserveWorkflowMigration(wf), /busy/); }
  finally { wf.busy = true; release(); await pending; t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(wf.queue.followUp.length, 1);
});

test('B118: a stale unrelated workflow folder cannot block a shared-board refresh', async () => {
  const f = await fixture(), stale = randomUUID();
  state.workflowCwds.set(stale, join(root, 'removed-project'));
  state.workflows.set(stale, { config: { workingDirectory: join(root, 'removed-project') }, observers: new Set() } as any);
  try {
    await ledgerHandlers.handleTaskLedgerCreate(f.ws, { type: 'task_ledger_create', workflowId: f.ids[0]!, title: 'Still shared' });
    assert.equal(f.other.filter(m => m.type === 'task_ledger_snapshot').length, 1);
  } finally { state.workflows.delete(stale); state.workflowCwds.delete(stale); }
});

test('B118: a member LEDGER keeps receiving project snapshots when its cluster uses a private board', async () => {
  const f = await fixture(); await clusterStore.setTaskBoardMode(f.cluster.clusterId, 'cluster');
  await ledgerHandlers.handleTaskLedgerCreate(f.ws, { type: 'task_ledger_create', workflowId: f.ids[0]!, title: 'Project task' });
  assert.equal(f.messages.filter(m => m.type === 'task_ledger_snapshot' && !m.boardKey).length, 1);
  assert.equal(f.other.filter(m => m.type === 'task_ledger_snapshot' && !m.boardKey).length, 1);
});
