import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage, WorkflowConfig } from '@archon/shared';
import { handleServerMessage, type WsDeps } from './handleServerMessage.js';
import { useAppStore } from '../stores/appStore.js';
import { streamingMsgs } from './streamState.js';

// Regression guard for the late-text fragmentation bug. The final answer can
// stream as many primary_text deltas that arrive AFTER primary_turn_ended (the
// server's settled.then microtask race). The original late-text guard minted
// one finalized "< ARCHON :: PASSTHROUGH" bubble per delta, so the answer split
// into a stack of one-token rows that then persisted to localStorage and
// reappeared on reload (while a clean seq-ordered RESUME replay showed it
// coalesced). The fix coalesces consecutive not-in-progress deltas into one
// bubble. See handleServerMessage.ts primary_text.

const deps: WsDeps = {
  wsRef: { current: null },
  scheduleReconnect: () => {},
};

const config = {
  name: 'late-text-test',
  primaryModel: 'claude-opus-4-8',
  primaryEffort: 'high',
  primaryProvider: 'claude',
} as unknown as WorkflowConfig;

function freshJob(wfid: string): void {
  // Reset module-level streaming state + store entry so tests don't bleed.
  streamingMsgs.delete(wfid);
  useAppStore.setState((s) => {
    const { [wfid]: _drop, ...rest } = s.jobs;
    return { jobs: rest };
  });
  useAppStore.getState().createJob(wfid, config, undefined, undefined);
}

function passthroughBubbles(wfid: string): string[] {
  return useAppStore
    .getState()
    .jobs[wfid].messages.filter((m) => m.role === 'assistant' && m.phase === 'passthrough')
    .map((m) => m.content);
}

// Tests send minimal message shapes (only the fields the handler reads); cast
// through unknown so tsc doesn't demand every required field of each variant.
const send = (msg: Record<string, unknown>) =>
  handleServerMessage(msg as unknown as ServerMessage, deps);

test('late primary_text after primary_turn_ended coalesces into one bubble', () => {
  const wfid = 'wf-late-1';
  freshJob(wfid);

  // Normal in-progress turn: two deltas coalesce into one streaming bubble.
  send({ type: 'primary_turn_started', workflowId: wfid, startedAt: 1000 });
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'Hello ', seq: 1 });
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'world', seq: 2 });
  send({ type: 'primary_complete', workflowId: wfid, phase: 'passthrough', seq: 3 });
  send({ type: 'primary_turn_ended', workflowId: wfid, endedAt: 2000, seq: 4 });

  // Late burst: three deltas arrive AFTER the turn ended.
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'Sum', seq: 5 });
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'ma', seq: 6 });
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'ry', seq: 7 });

  const bubbles = passthroughBubbles(wfid);
  // Exactly two assistant bubbles: the in-progress one and ONE coalesced late
  // one — not 1 + 3. Pre-fix this was ['Hello world', 'Sum', 'ma', 'ry'].
  assert.deepEqual(bubbles, ['Hello world', 'Summary']);
});

test('a new turn does not append onto the prior turn\'s late bubble', () => {
  const wfid = 'wf-late-2';
  freshJob(wfid);

  send({ type: 'primary_turn_started', workflowId: wfid, startedAt: 1000 });
  send({ type: 'primary_complete', workflowId: wfid, phase: 'passthrough', seq: 1 });
  send({ type: 'primary_turn_ended', workflowId: wfid, endedAt: 2000, seq: 2 });
  // Late text sets ref.passthrough as the coalesce target.
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'late', seq: 3 });

  // Next turn must clear the stale ref so its text lands in a fresh bubble.
  send({ type: 'primary_turn_started', workflowId: wfid, startedAt: 3000 });
  send({ type: 'primary_text', workflowId: wfid, phase: 'passthrough', text: 'next', seq: 4 });

  assert.deepEqual(passthroughBubbles(wfid), ['late', 'next']);
});
