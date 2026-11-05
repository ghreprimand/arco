import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AFTER_TURN_ORDER, runAfterTurn, type AfterTurnSteps } from './afterTurn.js';

// The post-settle steps: order, and where the list stops.

function steps(context: 'continue' | 'stop', queued: boolean) {
  const calls: string[] = [];
  const s: AfterTurnSteps = {
    computer: async () => { calls.push('computer'); },
    calibrate: async () => { calls.push('calibrate'); },
    context: async () => { calls.push('context'); return context; },
    drainQueue: async () => { calls.push('queue'); return queued; },
    goalRun: async () => { calls.push('goal-run'); },
  };
  return { s, calls };
}

test('every step runs in order when nothing stops the list', async () => {
  const { s, calls } = steps('continue', false);
  assert.deepEqual(await runAfterTurn(s), [...AFTER_TURN_ORDER]);
  assert.deepEqual(calls, ['computer', 'calibrate', 'context', 'queue', 'goal-run']);
});

test('a context action that stops ends the list before the queue and the goal run', async () => {
  const { s, calls } = steps('stop', false);
  assert.deepEqual(await runAfterTurn(s), ['computer', 'calibrate', 'context']);
  assert.deepEqual(calls, ['computer', 'calibrate', 'context']);
});

test('a queued turn that starts runs its own steps, so the goal run waits', async () => {
  const { s, calls } = steps('continue', true);
  assert.deepEqual(await runAfterTurn(s), ['computer', 'calibrate', 'context', 'queue']);
  assert.equal(calls.includes('goal-run'), false);
});
