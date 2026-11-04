import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeNativeWorker } from './worker.js';
import { workflows } from '../../server/state.js';
import { broadcastWorkflow } from '../../server/broadcast.js';
import { WebSocket } from 'ws';

test('pending question snapshot and settlement broadcast reach both observers', async () => {
  const worker = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'claude-opus-4-8', effort: 'low' } } as never);
  const seen: unknown[][] = [[], []];
  const observers = new Set(seen.map((received) => ({ readyState: WebSocket.OPEN, send: (payload: string) => received.push(JSON.parse(payload)) })));
  workflows.set('fixture', { config: { incognito: true }, observers } as never);
  worker.setWorkflowEventBroadcast((event) => broadcastWorkflow('fixture', event));
  const ask = (worker as unknown as { handleAskUserQuestion: (q: string, options?: string[]) => Promise<string> }).handleAskUserQuestion('Choose', ['Yes']);
  const id = worker.getPendingInteractions().question?.questionId;
  assert.ok(id, 'reconnect can read the pending question id');
  assert.equal(worker.resolveQuestion(id, 'Yes'), true);
  assert.equal(await ask, 'Yes');
  assert.equal(worker.getPendingInteractions().question, null);
  assert.deepEqual(seen, [[{ type: 'claude_native_question_settled', workflowId: 'fixture', questionId: id }], [{ type: 'claude_native_question_settled', workflowId: 'fixture', questionId: id }]]);
  const cancelled = (worker as unknown as { handleAskUserQuestion: (q: string) => Promise<string> }).handleAskUserQuestion('Next');
  const nextId = worker.getPendingInteractions().question!.questionId;
  worker.cancel();
  await assert.rejects(cancelled, /AbortError/);
  assert.equal(worker.getPendingInteractions().question, null);
  assert.deepEqual(seen[1][1], { type: 'claude_native_question_settled', workflowId: 'fixture', questionId: nextId });
  const ended = (worker as unknown as { handleAskUserQuestion: (q: string) => Promise<string> }).handleAskUserQuestion('Last');
  const lastId = worker.getPendingInteractions().question!.questionId;
  worker.settlePendingQuestion();
  await assert.rejects(ended, /turn ended/);
  assert.deepEqual(seen[1][2], { type: 'claude_native_question_settled', workflowId: 'fixture', questionId: lastId });
  workflows.delete('fixture');
});

test('status broadcast failure cannot prevent question delivery or cancellation', async () => {
  const worker = new ClaudeNativeWorker({ workflowId: 'fixture', config: { model: 'claude-opus-4-8', effort: 'low' } } as never);
  worker.setWorkflowEventBroadcast(() => { throw new Error('status unavailable'); });
  const call = (worker as unknown as { handleAskUserQuestion: (q: string) => Promise<string> }).handleAskUserQuestion.bind(worker);
  const first = call('Choose');
  assert.equal(worker.resolveQuestion(worker.getPendingInteractions().question!.questionId, 'Yes'), true);
  assert.equal(await first, 'Yes');
  const second = call('Again');
  worker.cancel();
  await assert.rejects(second, /turn cancelled/);
});
