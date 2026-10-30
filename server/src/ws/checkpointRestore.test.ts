import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'arco-restore-guard-'));
installIsolatedTestHome(root);
const { trackRecallFixture } = await import('../testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
const { workflows, workflowCwds } = await import('../server/state.js');
const { initWorkflowStore, flushAll } = await import('../workflowStore.js');
const { createCheckpoint, checkpointRestoreScopes } = await import('../gitSnapshots.js');
const { handleRevertToCheckpoint } = await import('./workflowHandlers.js');
const { claimBusy, releaseBusy, revokeBusy, handleUserMessage } = await import('./turnEngine.js');
const { WorkerManager } = await import('../workers/WorkerManager.js');
const { maybeFreshComputerContext } = await import('../voice/computerContext.js');
const { handleSpawnFromHere } = await import('./handoffHandlers.js');
const { broadcastWorkflow } = await import('../server/broadcast.js');
const { releaseProjectSettingsWatcher } = await import('../settings.js');
const { readSessionIndex } = await import('../workflows/sessionIndex.js');
const ownership = await import('../checkoutOwnership.js');
after(async () => { await flushAll(); await closeRecall(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function fixture() {
  const cwd = join(root, randomUUID()); mkdirSync(cwd);
  git(cwd, 'init', '-q');
  writeFileSync(join(cwd, '.gitignore'), '.arco/\n');
  writeFileSync(join(cwd, 'file.txt'), 'checkpoint');
  git(cwd, 'add', '.');
  git(cwd, '-c', 'user.name=arco-test', '-c', 'user.email=test@arco.local', 'commit', '-qm', 'fixture');
  const id = randomUUID();
  await initWorkflowStore(cwd, id);
  assert.ok(await createCheckpoint({ cwd, workflowId: id, seq: 1 }));
  writeFileSync(join(cwd, 'file.txt'), 'active work');
  const sent: Array<Record<string, unknown>> = [];
  const ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { config: { workingDirectory: cwd }, primary: { provider: 'codex' }, queue: { steering: [], followUp: [] }, busy: false, observers: new Set([ws]), manager: { workerCount: 0 } } as unknown as WorkflowState;
  workflows.set(id, wf); workflowCwds.set(id, cwd);
  return { cwd, id, sent, ws, wf };
}

test('idle requester cannot restore a checkout used by a busy peer', async () => {
  const f = await fixture(); const peer = randomUUID();
  workflows.set(peer, { config: { workingDirectory: f.cwd }, busy: true } as WorkflowState);
  try {
    await handleRevertToCheckpoint(f.ws, { type: 'revert_to_checkpoint', workflowId: f.id, seq: 1 });
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    assert.ok(f.sent.some(m => m.type === 'error'));
    assert.ok(!f.sent.some(m => m.type === 'checkpoint_created' || m.type === 'checkpoint_reverted'));
  } finally { workflows.delete(peer); workflows.delete(f.id); workflowCwds.delete(f.id); }
});

function forget(id: string): void { workflows.delete(id); workflowCwds.delete(id); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function restore(f: Awaited<ReturnType<typeof fixture>>) {
  return handleRevertToCheckpoint(f.ws, { type: 'revert_to_checkpoint', workflowId: f.id, seq: 1 });
}

for (const scope of ['child', 'parent', 'alias', 'auxiliary', 'additional directory'] as const) {
  test(`restore refuses conflicting ${scope} work before a safety snapshot`, async () => {
    const f = await fixture(); const id = randomUUID();
    let cwd = f.cwd;
    if (scope === 'child') { cwd = join(cwd, 'nested'); mkdirSync(cwd); }
    if (scope === 'parent') cwd = root;
    if (scope === 'alias') { cwd = join(root, randomUUID()); symlinkSync(f.cwd, cwd, 'junction'); }
    const peer = { config: { workingDirectory: cwd }, busy: scope !== 'auxiliary', manager: { workerCount: scope === 'auxiliary' ? 1 : 0 } } as unknown as WorkflowState;
    if (scope === 'additional directory') { peer.config.workingDirectory = join(root, 'elsewhere'); peer.primary = { additionalDirectories: [f.cwd] } as WorkflowState['primary']; }
    workflows.set(id, peer);
    try {
      await restore(f);
      assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
      assert.ok(f.sent.some(m => m.type === 'error' && String(m.message).includes('in use')));
      assert.ok(!f.sent.some(m => m.type === 'checkpoint_created'));
    } finally { forget(f.id); forget(id); }
  });
}

test('segment boundaries allow an independent similarly named checkout and preserve recovery', async () => {
  const f = await fixture(); const id = randomUUID();
  const other = `${f.cwd}-other`; mkdirSync(other);
  workflows.set(id, { config: { workingDirectory: other }, busy: true } as WorkflowState);
  const head = git(f.cwd, 'rev-parse', 'HEAD'), index = git(f.cwd, 'write-tree'), branch = git(f.cwd, 'symbolic-ref', 'HEAD');
  try {
    await restore(f);
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'checkpoint');
    const reverted = f.sent.find(m => m.type === 'checkpoint_reverted'); assert.ok(reverted);
    await handleRevertToCheckpoint(f.ws, { type: 'revert_to_checkpoint', workflowId: f.id, seq: reverted.safetySnapshotSeq as number });
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), head);
    assert.equal(git(f.cwd, 'write-tree'), index);
    assert.equal(git(f.cwd, 'symbolic-ref', 'HEAD'), branch);
  } finally { forget(f.id); forget(id); }
});

test('Git effective scope matches explicit git-dir for subdirectories and core.worktree', async () => {
  const f = await fixture();
  const sub = join(f.cwd, 'nested'); mkdirSync(sub);
  const other = root;
  try {
    // The existing backend passes --git-dir and therefore selects the
    // configured subdirectory as its work tree, rather than ordinary -C discovery.
    assert.deepEqual(new Set(await checkpointRestoreScopes(sub)), new Set([await fs.realpath(sub)]));
    git(f.cwd, 'config', 'core.worktree', other);
    assert.deepEqual(new Set(await checkpointRestoreScopes(sub)), new Set([await fs.realpath(sub), await fs.realpath(other)]));
    const id = randomUUID();
    workflows.set(id, { config: { workingDirectory: other }, busy: true } as WorkflowState);
    try {
      await restore(f);
      assert.ok(f.sent.some(m => m.type === 'error' && String(m.message).includes('in use')));
      assert.ok(!f.sent.some(m => m.type === 'checkpoint_created'));
    } finally { forget(id); }
  } finally { forget(f.id); }
});

test('linked worktrees remain isolated despite a shared Git object store', async () => {
  const f = await fixture(); const id = randomUUID();
  const linked = `${f.cwd}-linked`;
  git(f.cwd, 'worktree', 'add', '-q', '--detach', linked);
  await initWorkflowStore(linked, id);
  assert.ok(await createCheckpoint({ cwd: linked, workflowId: id, seq: 1 }));
  writeFileSync(join(linked, 'file.txt'), 'linked work');
  f.wf.busy = true;
  const linkedWf = { ...f.wf, config: { workingDirectory: linked }, busy: false } as WorkflowState;
  workflows.set(id, linkedWf); workflowCwds.set(id, linked);
  try {
    await handleRevertToCheckpoint(f.ws, { type: 'revert_to_checkpoint', workflowId: id, seq: 1 });
    assert.equal(readFileSync(join(linked, 'file.txt'), 'utf8'), 'checkpoint');
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
  } finally { forget(f.id); forget(id); }
});

test('a turn admitted during asynchronous scope discovery prevents restore', async () => {
  const f = await fixture(); const peer = { ...f.wf } as WorkflowState; const id = randomUUID();
  workflows.set(id, peer);
  const reached = deferred(), proceed = deferred(); const realpath = fs.realpath.bind(fs);
  const hook = mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    reached.resolve(); await proceed.promise; return result;
  });
  let token: number | undefined; const pending = restore(f);
  try {
    await reached.promise;
    token = claimBusy(peer);
    proceed.resolve(); await pending;
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    assert.ok(!f.sent.some(m => m.type === 'checkpoint_created'));
  } finally { proceed.resolve(); await pending; hook.mock.restore(); if (token !== undefined) releaseBusy(peer, token); forget(f.id); forget(id); }
});

test('reservation fences turns, queue drains, workers, captures and competing restores through safety and restore', async () => {
  const f = await fixture(); const peer = { ...f.wf, config: { ...f.wf.config, kind: 'chat' }, queue: { steering: [], followUp: [{ content: 'queued input', clientMessageId: 'fixture-input' }] } } as unknown as WorkflowState;
  const id = randomUUID(); workflows.set(id, peer);
  const reached = deferred(), proceed = deferred(); const realpath = fs.realpath.bind(fs); let calls = 0;
  const hook = mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    if (++calls === 3) { reached.resolve(); await proceed.promise; }
    return result;
  });
  const queue = JSON.stringify(peer.queue);
  const pending = restore(f);
  try {
    await reached.promise;
    assert.throws(() => claimBusy(peer), ownership.CheckoutInUseError);
    assert.equal(peer.busy, false);
    const blockedManager = new WorkerManager();
    mock.method(blockedManager as unknown as { spawnAdmitted: () => Promise<unknown> }, 'spawnAdmitted', () => assert.fail('provider must not be created'));
    await assert.rejects(blockedManager.spawn({ id: 'blocked-worker', task: 'fixture', model: 'fixture', effort: 'low' }, () => assert.fail('provider must not be created'), { cwd: f.cwd }), ownership.CheckoutInUseError);
    await assert.rejects(handleUserMessage(f.ws, {} as Session, id, '', undefined, undefined, false, undefined, undefined, undefined, { fromQueue: true }), ownership.CheckoutInUseError);
    assert.equal(JSON.stringify(peer.queue), queue);
    assert.equal(await createCheckpoint({ cwd: f.cwd, workflowId: id, seq: 2 }), null);
    await restore(f);
    assert.ok(f.sent.some(m => m.type === 'error' && String(m.message).includes('in use')));
    const independent = await fixture();
    try { await restore(independent); assert.ok(independent.sent.some(m => m.type === 'checkpoint_reverted')); }
    finally { forget(independent.id); }
    // The successful safety marker is emitted before restore starts. Admission
    // must still be closed at that second boundary.
    const send = f.ws.send.bind(f.ws);
    mock.method(f.ws, 'send', (raw: string) => {
      if (JSON.parse(raw).type === 'checkpoint_created') assert.throws(() => claimBusy(peer), ownership.CheckoutInUseError);
      send(raw);
    });
    proceed.resolve(); await pending;
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'checkpoint');
    const token = claimBusy(peer); releaseBusy(peer, token);
  } finally { proceed.resolve(); await pending; hook.mock.restore(); forget(f.id); forget(id); }
});

test('canonical admission includes missing descendants and rejects stale safety ownership', async () => {
  const f = await fixture(); const alias = join(root, randomUUID()); symlinkSync(f.cwd, alias, 'junction');
  const writer = ownership.acquireCheckoutWriter([join(alias, 'not-created', 'child')]);
  try {
    assert.throws(() => ownership.acquireCheckoutRestore([f.cwd], []), ownership.CheckoutInUseError);
  } finally { writer(); }
  const lease = ownership.acquireCheckoutRestore([f.cwd], []);
  try {
    assert.throws(() => ownership.acquireCheckoutWriter([f.cwd], Symbol('foreign')), ownership.CheckoutInUseError);
    const capture = ownership.acquireCheckoutWriter([alias], lease.owner); capture();
    assert.throws(() => ownership.acquireCheckoutRestore([f.cwd], []), ownership.CheckoutInUseError);
  } finally { lease.release(); forget(f.id); }
  assert.throws(() => ownership.acquireCheckoutWriter([f.cwd], lease.owner), ownership.CheckoutInUseError);
  assert.throws(() => ownership.acquireCheckoutRestore([f.cwd], [[]]), ownership.CheckoutInUseError);
});

test('symlink parent traversal is resolved by the filesystem before lexical normalization', async () => {
  const f = await fixture(); const holder = join(root, randomUUID()); mkdirSync(holder);
  const nested = join(f.cwd, 'nested'); mkdirSync(nested);
  const alias = join(holder, 'alias'); symlinkSync(nested, alias, 'junction');
  const raw = `${alias}/..`;
  // Resolve native platform traversal semantics, including Windows junctions.
  const actual = realpathSync.native(raw);
  const release = ownership.acquireCheckoutWriter([raw]);
  try { assert.throws(() => ownership.acquireCheckoutRestore([actual], []), ownership.CheckoutInUseError); }
  finally { release(); forget(f.id); }
});

test('auxiliary worker ownership outlives revoked busy and workflow removal', async () => {
  const f = await fixture(); const manager = new WorkerManager(); const settled = deferred();
  const id = randomUUID(); const peer = { ...f.wf, manager } as WorkflowState;
  workflows.set(id, peer);
  // Provider fixture below the real WorkerManager admission boundary.
  mock.method(manager as unknown as { spawnAdmitted: () => Promise<unknown> }, 'spawnAdmitted', async () => {
    await settled.promise; return { id: 'fixture', text: '', costUsd: 0, durationMs: 0 };
  });
  const token = claimBusy(peer);
  const worker = manager.spawn({ id: 'fixture', task: 'fixture', model: 'fixture', effort: 'low' }, () => {}, { cwd: f.cwd });
  revokeBusy(peer); forget(id);
  assert.equal(releaseBusy(peer, token), false);
  try {
    await restore(f);
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    settled.resolve(); await worker;
    f.sent.length = 0; await restore(f);
    assert.ok(f.sent.some(m => m.type === 'checkpoint_reverted'));
  } finally { settled.resolve(); await worker; forget(f.id); }
});

test('a background checkpoint capture remains an owner after the primary turn settles', async () => {
  const f = await fixture(); const reached = deferred(), proceed = deferred();
  const realpath = fs.realpath.bind(fs); let first = true;
  const hook = mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    if (first) { first = false; reached.resolve(); await proceed.promise; }
    return result;
  });
  const capture = createCheckpoint({ cwd: f.cwd, workflowId: f.id, seq: 30 });
  try {
    await reached.promise;
    await restore(f);
    assert.ok(f.sent.some(m => m.type === 'error' && String(m.message).includes('in use')));
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    proceed.resolve(); assert.ok(await capture);
    f.sent.length = 0; await restore(f);
    assert.ok(f.sent.some(m => m.type === 'checkpoint_reverted'));
  } finally { proceed.resolve(); await capture; hook.mock.restore(); forget(f.id); }
});

test('failed safety snapshot leaves files intact and releases ownership', async () => {
  const f = await fixture();
  // An invalid ref namespace makes Git's safety snapshot fail before restore.
  // Existing target ref remains present and could otherwise be restored.
  git(f.cwd, 'update-ref', `refs/arco/${f.id}/0/blocked`, 'HEAD');
  try {
    await restore(f);
    assert.equal(readFileSync(join(f.cwd, 'file.txt'), 'utf8'), 'active work');
    assert.ok(f.sent.some(m => m.type === 'error' && String(m.message).includes('safety snapshot')));
    assert.ok(!f.sent.some(m => m.type === 'checkpoint_created' || m.type === 'checkpoint_reverted'));
    const token = claimBusy(f.wf); releaseBusy(f.wf, token);
    git(f.cwd, 'update-ref', '-d', `refs/arco/${f.id}/0/blocked`);
    f.sent.length = 0; await restore(f);
    assert.ok(f.sent.some(m => m.type === 'checkpoint_reverted'));
  } finally { forget(f.id); }
});

test('refused Computer reset keeps the pending request and does not strand the reset flag', async () => {
  const f = await fixture();
  Object.assign(f.wf.config, { kind: 'chat', voiceOperator: true, incognito: true, computerContext: { keepContext: false, resets: 0, pendingFresh: true } });
  const lease = ownership.acquireCheckoutRestore([f.cwd], []);
  try {
    await maybeFreshComputerContext(f.id);
    assert.notEqual(f.wf.computerResetting, true);
    assert.equal(f.wf.busy, false);
    assert.equal(f.wf.config.computerContext?.pendingFresh, true);
    assert.equal(f.wf.config.computerContext?.resets, 0);
  } finally { lease.release(); forget(f.id); }
});

test('a fork refused at admission does not register a stranded busy workflow', async () => {
  const f = await fixture(); const initial = new Set(workflows.keys());
  broadcastWorkflow(f.id, { type: 'user_message_echo', workflowId: f.id, content: 'fixture source', timestamp: 1 });
  const lease = ownership.acquireCheckoutRestore([f.cwd], []);
  const session = { id: 'fixture', workflowIds: new Set([f.id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  try {
    await assert.rejects(handleSpawnFromHere(f.ws, session, { type: 'spawn_from_here_request', parentWorkflowId: f.id, mode: 'fresh-summarizer', newConfig: { name: 'fixture fork', skipPermissions: false, workingDirectory: f.cwd, primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'low' } }), ownership.CheckoutInUseError);
    assert.deepEqual(new Set(workflows.keys()), initial);
  } finally {
    lease.release();
    for (const [id, wf] of workflows) if (!initial.has(id)) { revokeBusy(wf); releaseProjectSettingsWatcher(wf.config.workingDirectory); forget(id); }
    forget(f.id);
  }
});

test('a parent restore admitted during fork setup releases the new workflow busy claim', async () => {
  const f = await fixture(); const initial = new Set(workflows.keys());
  f.wf.primary.provider = 'claude'; f.wf.config.claudeTransport = 'native';
  broadcastWorkflow(f.id, { type: 'user_message_echo', workflowId: f.id, content: 'fixture source', timestamp: 1 });
  const child = join(root, randomUUID()); mkdirSync(child);
  let lease: ReturnType<typeof ownership.acquireCheckoutRestore> | undefined;
  const send = f.ws.send.bind(f.ws);
  mock.method(f.ws, 'send', (raw: string) => {
    if (JSON.parse(raw).type === 'workflow_created') lease = ownership.acquireCheckoutRestore([f.cwd], []);
    send(raw);
  });
  const session = { id: 'fixture', workflowIds: new Set([f.id]), clusterIds: new Set(), clusterObserved: new Map() } as Session;
  try {
    await handleSpawnFromHere(f.ws, session, { type: 'spawn_from_here_request', parentWorkflowId: f.id, mode: 'original-worker', newConfig: { name: 'fixture fork', skipPermissions: false, workingDirectory: child, primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'low' } }).catch(error => { assert.ok(error instanceof ownership.CheckoutInUseError); });
    assert.ok(lease, 'restore entered while independent child setup was in progress');
    const newWorkflows = [...workflows].filter(([id]) => !initial.has(id));
    assert.equal(newWorkflows.length, 1);
    assert.equal(newWorkflows[0][1].busy, false);
    assert.equal(f.wf.busy, false);
    assert.ok(f.sent.some(m => m.type === 'spawn_from_here_complete' && typeof m.error === 'string'));
    // writeMeta starts a rebuildable projection in the background. Wait for
    // its atomic rename before tearing down the fixture directory.
    const deadline = Date.now() + 10_000;
    while (!(await readSessionIndex(child)).entries.length) {
      assert.ok(Date.now() < deadline, 'session projection did not settle');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    lease?.release();
    for (const [id, wf] of workflows) if (!initial.has(id)) { revokeBusy(wf); releaseProjectSettingsWatcher(wf.config.workingDirectory); forget(id); }
    forget(f.id);
  }
});
