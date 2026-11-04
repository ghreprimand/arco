import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipientContext } from './peerRecipientContext.js';
import { newTask } from './project/taskLedger.js';

test('recipient context chooses the latest active task and latest reply first line', () => {
  const tasks = [
    { ...newTask({ title: 'Older' }), assignee: 'recipient', status: 'in_progress' as const, updatedAt: 10 },
    { ...newTask({ title: 'Current' }), assignee: 'recipient', status: 'in_progress' as const, updatedAt: 20 },
    { ...newTask({ title: 'Other' }), assignee: 'sender', status: 'in_progress' as const, updatedAt: 30 },
  ];
  assert.deepEqual(buildRecipientContext(true, tasks, 'recipient', [
    { content: 'old', timestamp: 1000 }, { content: 'new reply\nmore', timestamp: 5000 },
  ], 9000), { state: 'busy', task: { id: tasks[1]!.id, title: 'Current' }, lastMessage: { firstLine: 'new reply', ageSeconds: 4 } });
  assert.deepEqual(buildRecipientContext(false, [], 'recipient', [], 9000), { state: 'idle', task: null, lastMessage: null });
  assert.equal(buildRecipientContext(undefined, [], 'recipient', [], 9000).state, 'unknown');
});
