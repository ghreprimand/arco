import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import { workflows } from '../server/state.js';
import { canAnswerFor } from './operatorQuestionHandlers.js';

// The fault: a browser that opened a cluster without restoring its member tabs
// (a phone, a second computer) observes the members through the cluster only,
// and could not answer a member's question.
test('a question can be answered from a browser that observes the workflow through its cluster', () => {
  const ws = {} as WebSocket;
  const other = {} as WebSocket;
  workflows.set('member-1', { observers: new Set([ws]) } as never);
  try {
    const viaCluster = { workflowIds: new Set<string>(), clusterObserved: new Map([['cluster-1', new Set(['member-1'])]]) };
    assert.equal(canAnswerFor(ws, viaCluster, 'member-1'), true);
    assert.equal(canAnswerFor(ws, { workflowIds: new Set(['member-1']), clusterObserved: new Map() }, 'member-1'), true);
    // Not observing the workflow, or neither route: refused.
    assert.equal(canAnswerFor(other, viaCluster, 'member-1'), false);
    assert.equal(canAnswerFor(ws, { workflowIds: new Set<string>(), clusterObserved: new Map() }, 'member-1'), false);
    assert.equal(canAnswerFor(ws, viaCluster, 'missing'), false);
  } finally {
    workflows.delete('member-1');
  }
});
