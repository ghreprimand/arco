import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectKeptTailByTokens } from './workerHelpers.js';
import { ClaudeNativeWorker } from './worker.js';
import type { MessageParam } from './contentBlocks.js';

for (const reply of ['answer', 'answer'.repeat(100)]) test('B89: the newest complete exchange survives a small tail budget', () => {
  const messages: MessageParam[] = [{ role: 'user', content: 'Keep this question' }, { role: 'assistant', content: reply }];
  const tail = projectKeptTailByTokens(messages, 2);
  assert.equal(tail.length, 2);
  assert.equal(tail[0].content, 'Keep this question');
  assert.deepEqual(tail[1].content, [{ type: 'text', text: reply }]);
});

test('B89: Fold keeps the newest exchange even when it is the whole history', async () => {
  const worker = new ClaudeNativeWorker({ workflowId: 'fold-tail', config: { model: 'claude-opus-4-8', effort: 'low' } });
  const state = worker as unknown as { messages: MessageParam[]; replayed: boolean };
  state.messages = [{ role: 'user', content: 'Keep this question verbatim' }, { role: 'assistant', content: 'Keep this answer verbatim' }];
  state.replayed = true;
  const events: Array<Record<string, unknown>> = [];
  worker.setWorkflowEventBroadcast((event) => events.push(event as unknown as Record<string, unknown>));
  try {
    assert.equal((await worker.foldInPlace({ tailTokenBudget: 1 })).ok, true);
    const folded = events.find((event) => event.type === 'context_folded');
    assert.equal((folded?.keptTail as unknown[])?.length, 2);
  } finally { await worker.dispose(); }
});
