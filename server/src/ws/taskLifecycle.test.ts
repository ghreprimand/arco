// Task card lifecycle outside a live turn: a late task_status still reaches the
// browser after STOP, and a reload settles a card whose final status was never
// recorded (the parent was stopped before the fix, or the server exited).
//
// Run: node --conditions development --import tsx --test src/ws/taskLifecycle.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverAfterTurnRevoked, unsettledTaskStatuses } from './taskLifecycle.js';

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
