// Chat tabs are projectless: Handoff / Spawn-from-here / Review would run
// Agent workers with project tools, so the server refuses them outright
// (before any busy claim or disk read) with a plain `error`.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { workflows } from '../server/state.js';
import type { Session, WorkflowState } from '../workflows/types.js';
import { handleHandoffRequest, handleSpawnFromHere } from './handoffHandlers.js';
import { handleReviewRequest } from './workflowHandlers.js';

function fakeWs(): { ws: WebSocket; sent: Array<{ type: string; message?: string }> } {
  const sent: Array<{ type: string; message?: string }> = [];
  const ws = { readyState: 1, OPEN: 1, send: (raw: string) => { sent.push(JSON.parse(raw)); } } as unknown as WebSocket;
  return { ws, sent };
}

function chatWf(id: string): WorkflowState {
  const wf = { config: { kind: 'chat', workingDirectory: `/nonexistent/chats/${id}` }, busy: false } as unknown as WorkflowState;
  workflows.set(id, wf);
  return wf;
}

const session = { workflowIds: new Set<string>() } as unknown as Session;

test('handoff_request on a chat tab is rejected without claiming busy', async () => {
  const wf = chatWf('chat-handoff-00000000');
  const { ws, sent } = fakeWs();
  await handleHandoffRequest(ws, session, { type: 'handoff_request', workflowId: 'chat-handoff-00000000' } as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.match(sent[0].message ?? '', /not available in Chat/);
  assert.equal(wf.busy, false);
  workflows.delete('chat-handoff-00000000');
});

test('spawn_from_here on a chat parent is rejected', async () => {
  const wf = chatWf('chat-spawn-000000000');
  const { ws, sent } = fakeWs();
  await handleSpawnFromHere(ws, session, {
    type: 'spawn_from_here',
    parentWorkflowId: 'chat-spawn-000000000',
    mode: 'fresh-summarizer',
    newConfig: { workingDirectory: '/tmp' },
  } as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.match(sent[0].message ?? '', /not available in Chat/);
  assert.equal(wf.busy, false);
  assert.equal(session.workflowIds.size, 0, 'no child tab created');
  workflows.delete('chat-spawn-000000000');
});

test('review_request on a chat tab is rejected', async () => {
  chatWf('chat-review-00000000');
  const { ws, sent } = fakeWs();
  await handleReviewRequest(ws, session, {
    type: 'review_request',
    workflowId: 'chat-review-00000000',
    contextRef: { kind: 'last-turn' },
  } as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.match(sent[0].message ?? '', /not available in Chat/);
  workflows.delete('chat-review-00000000');
});
