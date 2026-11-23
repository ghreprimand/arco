// Task card lifecycle outside a live turn: a late task_status still reaches the
// browser after STOP, and a reload settles a card whose final status was never
// recorded (the parent was stopped before the fix, or the server exited).
//
// Run: node --conditions development --import tsx --test src/ws/taskLifecycle.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverAfterTurnRevoked, restartStoppedBackgroundTasks, restartStoppedNotice, taskStartedBroadcast, unsettledTaskStatuses } from './taskLifecycle.js';

test('only task status passes the stale-turn gate', () => {
  assert.equal(deliverAfterTurnRevoked({ type: 'task_status' }), true);
  for (const type of ['primary_text', 'primary_complete', 'task_started', 'tool_use', 'error', 'primary_turn_ended']) {
    assert.equal(deliverAfterTurnRevoked({ type }), false, type);
  }
});

test('reload settles Task cards that never got a final status and whose child is not running', () => {
  const events = [
    { type: 'task_started', workflowId: 'p', taskId: 'a', childWorkflowId: 'ca', toolUseId: 'ua', description: 'A', startedAt: 1_000 },
    { type: 'task_started', workflowId: 'p', taskId: 'b', childWorkflowId: 'cb', toolUseId: 'ub', description: 'B', startedAt: 1_100 },
    { type: 'task_started', workflowId: 'p', taskId: 'c', childWorkflowId: 'cc', toolUseId: 'uc', description: 'C', startedAt: 1_200 },
    { type: 'task_started', workflowId: 'p', taskId: 'd', childWorkflowId: 'cd', toolUseId: 'ud', description: 'D', startedAt: 1_300 },
    { type: 'task_status', workflowId: 'p', taskId: 'a', toolUseId: 'ua', phase: 'done', elapsedMs: 50 },
    { type: 'task_status', workflowId: 'p', taskId: 'b', toolUseId: 'ub', phase: 'running', elapsedMs: 10 },
    { type: 'primary_turn_ended', workflowId: 'p', endedAt: 9_000 },
  ];
  const out = unsettledTaskStatuses('p', events, (child) => child === 'cd');
  assert.deepEqual(out, [
    { type: 'task_status', workflowId: 'p', taskId: 'b', toolUseId: 'ub', phase: 'cancelled', elapsedMs: 7_900, summary: 'Ended without a recorded result.' },
    { type: 'task_status', workflowId: 'p', taskId: 'c', toolUseId: 'uc', phase: 'cancelled', elapsedMs: 7_800, summary: 'Ended without a recorded result.' },
  ]);
});

test('without a later turn end the elapsed time is left at zero', () => {
  const events = [{ type: 'task_started', workflowId: 'p', taskId: 'a', childWorkflowId: 'ca', toolUseId: 'ua', description: 'A', startedAt: 5_000 },
    { type: 'primary_turn_ended', workflowId: 'p', endedAt: 4_000 }];
  assert.equal(unsettledTaskStatuses('p', events, () => false)[0].elapsedMs, 0);
  assert.deepEqual(unsettledTaskStatuses('p', [], () => false), []);
});

test('reload preserves a live queued Task and cancels an orphaned queue row', () => {
  const events = [{ type: 'task_started', taskId: 'queued', toolUseId: 'uq', phase: 'queued', model: 'haiku', startedAt: 1000 }];
  assert.deepEqual(unsettledTaskStatuses('p', events, () => false, (id) => id === 'queued'), []);
  const orphaned = unsettledTaskStatuses('p', events, () => false, () => false);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0].phase, 'cancelled');
});

test('a background Task start keeps its background mark on the parent broadcast', () => {
  const base = { taskId: 't', childWorkflowId: 'c', toolUseId: 'u', description: 'D', startedAt: 1 };
  assert.equal(taskStartedBroadcast('p', { ...base, background: true }).background, true);
  assert.equal('background' in taskStartedBroadcast('p', base), false);
});

test('background children a restart stopped are reported once, then never again', () => {
  const events: unknown[] = [
    { type: 'task_started', taskId: 'r', toolUseId: 'ur', description: 'Sleep R', startedAt: 1, phase: 'queued', background: true },
    { type: 'task_started', taskId: 'r', childWorkflowId: 'cr', toolUseId: 'ur', description: 'Sleep R', startedAt: 1, background: true },
    { type: 'task_started', taskId: 'done', childWorkflowId: 'cd', toolUseId: 'ud', description: 'Done', startedAt: 1, background: true },
    { type: 'task_status', taskId: 'done', toolUseId: 'ud', phase: 'done' },
    { type: 'task_started', taskId: 'fg', childWorkflowId: 'cf', toolUseId: 'uf', description: 'Foreground', startedAt: 1 },
    { type: 'task_started', taskId: 'live', childWorkflowId: 'cl', toolUseId: 'ul', description: 'Live', startedAt: 1, background: true },
  ];
  const stopped = restartStoppedBackgroundTasks(events, (id) => id === 'live');
  assert.deepEqual(stopped, [{ taskId: 'r', toolUseId: 'ur', description: 'Sleep R' }]);
  assert.match(restartStoppedNotice(stopped), /^Background sub-agent stopped by a server restart: Sleep R \(r\)\nIts result was not received/);
  events.push({ type: 'task_status', taskId: 'r', toolUseId: 'ur', phase: 'cancelled', summary: 'Stopped by restart.' });
  assert.deepEqual(restartStoppedBackgroundTasks(events, () => false).map((t) => t.taskId), ['live']);
});
