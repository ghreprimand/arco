import assert from 'node:assert/strict';
import { test } from 'node:test';
import { membersWithMail, requestNudgeAll } from './clusterNudge.js';

test('NUDGE ALL WITH MAIL picks members with waiting mail, idle or busy, in roster order', () => {
  const members = [{ workflowId: 'a' }, { workflowId: 'b' }, { workflowId: 'c' }, { workflowId: 'd' }];
  assert.deepEqual(membersWithMail(members, { c: 2, a: 1, d: 0, gone: 5 }), ['a', 'c']);
  assert.deepEqual(membersWithMail(members, undefined), []);
  assert.deepEqual(membersWithMail(members, {}), []);
});

test('the palette request reports unhandled without a window', () => {
  assert.equal(requestNudgeAll('cluster-a'), false);
});
