import assert from 'node:assert/strict';
import test from 'node:test';
import { takeQueuedTurn } from './messageQueue.js';
import { drainSteerForWorker, projectQueue } from './turnEngine.js';
import { workflows } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';

test('interrupts run ahead of older messages, retaining attachments, refs, picks and IDs', () => {
  const urgent = { content: 'correct course', interrupt: true, clientMessageId: 'urgent', attachments: ['image.png'],
    expandedContext: 'file context', pickedSkills: [{ scope: 'global' as const, slug: 'skill' }] };
  const queue = { steering: [{ content: 'earlier steer' }, urgent, { content: 'second correction', interrupt: true }],
    followUp: [{ content: 'follow up' }] };
  assert.deepEqual(takeQueuedTurn(queue), [urgent, { content: 'second correction', interrupt: true }]);
  assert.deepEqual(takeQueuedTurn(queue), [{ content: 'earlier steer' }, { content: 'follow up' }]);
  assert.deepEqual(takeQueuedTurn(queue), []);
  assert.deepEqual(projectQueue([urgent]), [{ content: 'correct course', interrupt: true, clientMessageId: 'urgent' }]);
});

test('a cancelling worker and an interrupt turn cannot consume earlier steering', () => {
  const wf = { queue: { steering: [{ content: 'earlier' }, { content: 'urgent', interrupt: true }], followUp: [] } } as unknown as WorkflowState;
  workflows.set('interrupt-test', wf);
  try {
    assert.deepEqual(drainSteerForWorker('interrupt-test', {} as any), []);
    assert.equal(wf.queue.steering.length, 2);
    takeQueuedTurn(wf.queue);
    wf.primaryTurn = { token: 1, holdSteer: true };
    assert.deepEqual(drainSteerForWorker('interrupt-test', {} as any), []);
    assert.equal(wf.queue.steering.length, 1);
  } finally { workflows.delete('interrupt-test'); }
});
