import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTaskAdmission, assertNativeTaskAllowed, nativeTaskBatchApprovalReasons } from './taskAdmission.js';
import { ClaudeNativeWorker } from './worker.js';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policy = { maxRunning: 1, maxStarts: 2 };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('batch approval considers cumulative starts and does not assume unknown model prices', () => {
  const reasons = (starts: number, parentModel: string, effectiveModels: string[]) =>
    nativeTaskBatchApprovalReasons({ starts, parentModel, effectiveModels });
  assert.deepEqual(reasons(2, 'sonnet', ['sonnet', 'sonnet']), []);
  assert.deepEqual(reasons(3, 'sonnet', ['sonnet', 'sonnet']), ['count']);
  assert.deepEqual(reasons(0, 'sonnet', ['opus']), ['unknown_cost']);
  assert.deepEqual(reasons(0, 'sonnet', ['new-model']), ['unknown_cost']);
  assert.deepEqual(reasons(0, 'new-model', ['new-model']), []);
  assert.deepEqual(nativeTaskBatchApprovalReasons({ starts: 0, parentModel: 'sonnet', effectiveModels: ['haiku'], requestedModels: ['opus'] }), ['unknown_cost']);
});

test('worker counts only children reported started in its current turn', async () => {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'haiku', effort: 'low' } });
  let notifyStarted!: () => void;
  worker.setTaskHandler(async (args: any) => {
    notifyStarted = args.onStarted;
    return { taskId: 'fixture-task', childWorkflowId: 'fixture-child', finalText: Promise.resolve('done'), read: () => ({ output: '', settled: true }), cancel() {} };
  });
  try {
    await worker.handleSpawnTask({ description: 'Fixture', prompt: 'work', toolUseId: 'fixture-tool' });
    assert.equal(worker.taskStartsThisTurn, 0);
    notifyStarted(); assert.equal(worker.taskStartsThisTurn, 1);
    worker.taskTurn = new AbortController();
    notifyStarted(); assert.equal(worker.taskStartsThisTurn, 1);
  } finally { await worker.dispose(); }
});

test('a batch waits for one validated decision before child dispatch', async () => {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'sonnet', effort: 'low' } });
  worker.batchCatalog = async () => ({ models: ['haiku', 'sonnet', 'opus'].map((id) => ({ id })), fresh: true });
  const blocks = [{ type: 'tool_use', id: 'one', name: 'Task', input: { description: 'First', prompt: 'work', model: 'opus' } }];
  try {
    const approval = worker.approveTaskBatch(blocks);
    await tick();
    const id = worker.getPendingInteractions().question.questionId;
    assert.equal(worker.approvedTaskModels.size, 0);
    assert.equal(worker.resolveQuestion(id, 'invalid'), false);
    assert.equal(worker.resolveQuestion(id, 'model:haiku'), true);
    assert.equal(worker.resolveQuestion(id, 'deny'), false);
    assert.equal(await approval, true);
    assert.equal(worker.approvedTaskModels.get('one').model, 'haiku');
    let actualModel = '';
    worker.setTaskHandler(async (args: any) => {
      actualModel = args.policy.model;
      return { taskId: 'fixture-task', childWorkflowId: 'fixture-child', finalText: Promise.resolve('done'), read: () => ({ output: '', settled: true }), cancel() {} };
    });
    await worker.handleSpawnTask({ description: 'First', prompt: 'work', model: 'opus', toolUseId: 'one' });
    assert.equal(actualModel, 'haiku');
    worker.approvedTaskModels.clear();
    const denied = worker.approveTaskBatch(blocks); await tick();
    assert.equal(worker.resolveQuestion(worker.getPendingInteractions().question.questionId, 'deny'), true);
    assert.equal(await denied, false);
    assert.equal(worker.approvedTaskModels.size, 0);
    worker.batchCatalog = async (force: boolean) => force
      ? { models: [], fresh: false }
      : { models: [{ id: 'opus' }], fresh: true };
    const unavailable = worker.approveTaskBatch(blocks); await tick();
    assert.equal(worker.resolveQuestion(worker.getPendingInteractions().question.questionId, 'allow'), true);
    assert.equal(await unavailable, false);
    assert.match(worker.taskBatchRefusal, /availability could not be checked/);
    assert.equal(worker.approvedTaskModels.size, 0);
    worker.batchCatalog = async () => ({ models: ['haiku', 'sonnet', 'opus'].map((model) => ({ id: model })), fresh: true });
    const cancelled = worker.approveTaskBatch(blocks); await tick(); worker.cancel();
    await assert.rejects(cancelled, /AbortError/);
    assert.equal(worker.approvedTaskModels.size, 0);
  } finally { await worker.dispose(); }
});

test('restart cancels an unfinished approval and tells the resumed parent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-batch-approval-'));
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { cwd, model: 'sonnet', effort: 'low' } });
  const marker = worker.batchMarkerPath(); const notices: string[] = [];
  worker.on('system_notice', (text: string) => notices.push(text));
  try {
    await mkdir(join(cwd, '.arco', 'workflows', 'fixture'), { recursive: true });
    await writeFile(marker, '{"pending":true}\n');
    await worker.restoreSavedHistory();
    assert.ok(notices.some((notice) => notice.includes('cancelled when the service restarted')));
    assert.ok(worker.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('No child was started')));
    await assert.rejects(access(marker));
  } finally { await worker.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test('FIFO admission bounds running and cumulative starts across rounds', async () => {
  const admission = new NativeTaskAdmission();
  const turn = new AbortController();
  const first = await admission.acquire(turn.signal, policy);
  first.started();
  let secondStarted = false;
  const secondPending = admission.acquire(turn.signal, policy).then((p) => { secondStarted = true; return p; });
  await tick();
  assert.equal(secondStarted, false);
  await assert.rejects(admission.acquire(turn.signal, policy), /limit of 2/);
  first.release();
  const second = await secondPending; second.started(); second.release();
  await assert.rejects(admission.acquire(turn.signal, policy), /limit of 2/);
  const nextTurn = new AbortController();
  const next = await admission.acquire(nextTurn.signal, policy); next.release();
});

test('queued cancellation refunds reservation; new generation cannot bypass old running capacity', async () => {
  const admission = new NativeTaskAdmission(); const turn = new AbortController();
  const first = await admission.acquire(turn.signal, policy); first.started();
  const cancel = new AbortController();
  const waiting = admission.acquire(turn.signal, policy, cancel.signal);
  cancel.abort(); await assert.rejects(waiting, /AbortError/);
  const waitingAgain = admission.acquire(turn.signal, policy);
  turn.abort(); await assert.rejects(waitingAgain, /AbortError/);
  let entered = false; const nextTurn = new AbortController();
  const next = admission.acquire(nextTurn.signal, policy).then((p) => { entered = true; return p; });
  await tick(); assert.equal(entered, false);
  first.release(); (await next).release();
});

test('admission snapshot is fixed per turn and init failure releases both reservations', async () => {
  const admission = new NativeTaskAdmission(); const turn = new AbortController();
  const first = await admission.acquire(turn.signal, policy);
  const queued = admission.acquire(turn.signal, { maxRunning: 10, maxStarts: 50 });
  await assert.rejects(admission.acquire(turn.signal, policy), /limit of 2/);
  first.release(); const second = await queued; second.release();
  const retry = await admission.acquire(turn.signal, policy); retry.release();
});

test('spawn guard rejects Chat, cluster membership and depth-capped children', () => {
  for (const context of [{ interactionMode: 'chat' }, { inCluster: true }, { taskDisabled: true }]) {
    assert.throws(() => assertNativeTaskAllowed(context), /Task.*not available/);
  }
  assert.doesNotThrow(() => assertNativeTaskAllowed({}));
});

test('worker refuses replayed Task before the spawn callback for cluster, Chat and child contexts', async () => {
  for (const config of [{ clusterId: 'fixture-cluster' }, { interactionMode: 'chat' as const }, { claudeNativeTaskDisabled: true }]) {
    const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'haiku', effort: 'low', ...config }, taskDisabled: config.claudeNativeTaskDisabled });
    let spawned = 0; worker.setTaskHandler(async () => { spawned++; throw Error('unexpected spawn'); });
    try {
      await assert.rejects(worker.handleSpawnTask({ description: 'fixture', prompt: 'work', toolUseId: 'tool' }), /Task.*not available/);
      assert.equal(spawned, 0);
    } finally { await worker.dispose(); }
  }
});

test('aborting several queued calls never admits another aborted waiter', async () => {
  const admission = new NativeTaskAdmission(); const turn = new AbortController();
  const limits = { maxRunning: 1, maxStarts: 4 };
  const first = await admission.acquire(turn.signal, limits); first.started();
  const waiters = [admission.acquire(turn.signal, limits), admission.acquire(turn.signal, limits)];
  const settled = Promise.allSettled(waiters);
  turn.abort(); first.release();
  const outcomes = await settled;
  assert.ok(outcomes.every((r) => r.status === 'rejected'));
});

test('cancellation during async child initialization cancels the late handle and emits no running row', async () => {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'haiku', effort: 'low' } });
  let finish!: (value: unknown) => void; let entered = false; let cancelled = 0;
  worker.setTaskHandler(async (args: any) => {
    args.onQueued('haiku'); entered = true;
    return await new Promise((resolve) => { finish = resolve; });
  });
  const starts: any[] = []; const statuses: any[] = [];
  worker.on('task_started', (ev: any) => starts.push(ev)); worker.on('task_status', (ev: any) => statuses.push(ev));
  try {
    const spawning = worker.handleSpawnTask({ description: 'Fixture', prompt: 'work', toolUseId: 'fixture-tool' });
    assert.equal(entered, true);
    worker.cancel();
    finish({ taskId: starts[0].taskId, childWorkflowId: 'late', finalText: Promise.resolve('late'), cancel: () => cancelled++, read: () => ({ output: '', settled: true }) });
    await assert.rejects(spawning, /AbortError/);
    assert.equal(cancelled, 1);
    assert.equal(starts.length, 1); assert.equal(starts[0].phase, 'queued');
    assert.equal(statuses.length, 1); assert.equal(statuses[0].phase, 'cancelled');
  } finally { await worker.dispose(); }
});

test('cancel during settings snapshot reports completion without starting the provider', async () => {
  const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'haiku', effort: 'low' } });
  let started = false; const errors: string[] = [];
  worker.ensureStarted = async () => { started = true; throw Error('unexpected provider start'); };
  worker.on('error', (error: string) => errors.push(error));
  try {
    const turn = worker.runTurn('fixture'); worker.cancel(); await turn;
    assert.equal(started, false); assert.deepEqual(errors, ['Worker killed']);
  } finally { await worker.dispose(); }
});

test('Task replies add a model notice only for an actual operator override of an explicit request', async () => {
  for (const scenario of [
    { selected: '', requested: 'sonnet', notice: false },
    { selected: 'haiku', requested: undefined, notice: false },
    { selected: 'haiku', requested: 'haiku', notice: false },
    { selected: 'haiku', requested: 'sonnet', notice: true },
  ]) {
    const worker: any = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'haiku', effort: 'low' } });
    worker.taskPolicy = { maxRunning: 4, maxStarts: 8, model: scenario.selected };
    worker.setTaskHandler(async () => ({ taskId: 'fixture-task', childWorkflowId: 'fixture-child', model: 'haiku', finalText: Promise.resolve('fixture answer'), read: () => ({ output: '', settled: true }), cancel() {} }));
    try {
      const result = await worker.handleSpawnTask({ description: 'Fixture', prompt: 'work', toolUseId: 'fixture-tool', model: scenario.requested });
      if (scenario.notice) { assert.match(result, /haiku/); assert.match(result, /overrid/i); }
      else assert.equal(result, 'fixture answer');
    } finally { await worker.dispose(); }
  }
});
