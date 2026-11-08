import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import type { WorkflowState, QueueItem } from '../workflows/types.js';
const home = mkdtempSync(join(tmpdir(), 'arco-queue-edit-'));
installIsolatedTestHome(home);
const { workflows } = await import('../server/state.js');
const { handleCancelQueuedMessage } = await import('./workflowHandlers.js');
const { drainSteerForWorker } = await import('./turnEngine.js');
after(() => fs.rm(home, { recursive: true, force: true }));
for (const kind of ['steer', 'follow-up', 'interrupt']) test(`EDIT atomically removes and returns ${kind}, and retries are idempotent`, () => {
  const messages: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const item: QueueItem = { content: 'Queued fixture', clientMessageId: 'queued', attachments: ['/projects/fixture/input.txt'], ...(kind === 'interrupt' ? { interrupt: true } : {}) };
  const wf = { config: { incognito: true }, primary: { provider: 'codex' }, observers: new Set([ws]), queue: { steering: kind === 'follow-up' ? [] : [item], followUp: kind === 'follow-up' ? [item] : [] } } as unknown as WorkflowState;
  workflows.set('fixture', wf);
  try {
    (handleCancelQueuedMessage as Function)(ws, 'fixture', 'queued', 'edit-request');
    assert.equal(wf.queue.steering.length + wf.queue.followUp.length, 0);
    const result = messages.find(m => m.type === 'queued_message_edit_result');
    assert.deepEqual(result, { type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'queued', requestId: 'edit-request', item: { content: item.content, attachments: item.attachments, kind } });
    (handleCancelQueuedMessage as Function)(ws, 'fixture', 'queued', 'edit-request');
    assert.deepEqual(messages.filter(m => m.type === 'queued_message_edit_result'), [result, result]);
    assert.equal(messages.filter(m => m.type === 'queued_message_cancelled').length, 1);
  } finally { workflows.delete('fixture'); }
});
test('a delivery that wins the race is never removed or returned for editing', () => {
  const messages: any[] = [];
  const ws = { readyState: 1, send: (raw: string) => messages.push(JSON.parse(raw)) } as unknown as WebSocket;
  const wf = { config: { incognito: true }, primary: { provider: 'codex' }, queue: { steering: [{clientMessageId:'delivered',content:'Delivered fixture'}], followUp: [] }, observers: new Set([ws]) } as unknown as WorkflowState;
  workflows.set('fixture', wf);
  try {
    assert.equal(drainSteerForWorker('fixture',ws)[0].content,'Delivered fixture');
    messages.length=0;
    (handleCancelQueuedMessage as Function)(ws, 'fixture', 'delivered', 'late-request');
    assert.deepEqual(messages, [{ type: 'queued_message_edit_result', workflowId: 'fixture', clientMessageId: 'delivered', requestId: 'late-request', error: 'Already sent, nothing to edit' }]);
  } finally { workflows.delete('fixture'); }
});
