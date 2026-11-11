import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTaskAdmission, assertNativeTaskAllowed } from './taskAdmission.js';
import { ClaudeNativeWorker } from './worker.js';

const policy = { maxRunning: 1, maxStarts: 2 };
const tick = () => new Promise((r) => setTimeout(r, 0));

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
