import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@arco/shared';
import { findDirector, hasNewReply, initialFocus, latestReplyId, orderMembers } from './clusterSurface.helpers.js';

const m = (workflowId: string, role?: string) => ({ workflowId, role });
const members = [m('a', 'Builder'), m('b', 'Director role'), m('c')];
const msg = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content: id, isStreaming: false, timestamp: 1, ...patch });

test('director is found by role and listed first until the operator reorders', () => {
  assert.equal(findDirector(members)?.workflowId, 'b');
  assert.deepEqual(orderMembers(members, false).map((x) => x.workflowId), ['b', 'a', 'c']);
  assert.deepEqual(orderMembers(members, true).map((x) => x.workflowId), ['a', 'b', 'c']);
  assert.deepEqual(orderMembers([m('x'), m('y')], false).map((x) => x.workflowId), ['x', 'y']);
});

test('initial focus keeps a valid focus, else director, else first', () => {
  assert.equal(initialFocus(members, 'c'), 'c');
  assert.equal(initialFocus(members, 'gone'), 'b');
  assert.equal(initialFocus(members, undefined), 'b');
  assert.equal(initialFocus([m('x'), m('y')], undefined), 'x');
  assert.equal(initialFocus([], undefined), undefined);
});

test('NEW REPLY follows the latest finished assistant reply and clears when seen or focused', () => {
  const rows = [msg('r1'), msg('t1', { toolUse: { name: 'x', input: {} } as never }), msg('r2', { isStreaming: true })];
  assert.equal(latestReplyId(rows), 'r1');
  assert.equal(latestReplyId([]), null);
  assert.equal(hasNewReply('r1', null, false), true);
  assert.equal(hasNewReply('r1', 'r1', false), false);
  assert.equal(hasNewReply('r1', null, true), false);
  assert.equal(hasNewReply(null, null, false), false);
});
