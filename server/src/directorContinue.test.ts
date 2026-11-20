import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerTask, TaskComment } from '@arco/shared';
import { applyUpdate } from './project/taskLedger.js';
import { pickContinueOffer, type ContinueState } from './directorContinue.js';

const DIRECTOR = 'director-1';
const BUILDER = 'builder-1';

function task(over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    id: 'task-1', title: 'Prepare the Linux try build', status: 'todo', links: [], notes: 'Build it.',
    priority: 0, parentIds: [], blockedReason: '', reviewRequired: false, goalMode: false,
    createdAt: 1, updatedAt: 1, ...over,
  };
}

function approved(t: LedgerTask): LedgerTask {
  return applyUpdate([t], t.id, { approved: true })!.updated;
}

function handoff(msgId: string, approvalId: string | undefined, at = 10): TaskComment {
  return { id: `c-${msgId}`, taskId: 'task-1', authorLabel: 'Director', body: 'Handoff sent.', createdAt: at, metadata: { kind: 'handoff', toWorkflowId: BUILDER, msgId, ...(approvalId ? { approvalId } : {}) } };
}

function state(over: Partial<ContinueState>): ContinueState {
  return {
    directorId: DIRECTOR, members: [DIRECTOR, BUILDER], tasks: [], comments: [], pending: new Map(),
    busy: () => false, autoPickupWakes: false, ...over,
  };
}

// The fault: a Director turn can end with approved work that nobody was handed.
test('an approved task left without a handoff is offered once, and only while it qualifies', () => {
  const ready = approved(task());
  const approvalId = ready.operatorApproval!.id;
  assert.deepEqual(pickContinueOffer(state({ tasks: [ready] })), { kind: 'continue', taskId: 'task-1', approvalId });

  // Board status alone, or an edit after approval, confers nothing.
  assert.equal(pickContinueOffer(state({ tasks: [task()] })), null);
  const edited = applyUpdate([ready], ready.id, { notes: 'Build it for Windows too.' })!.updated;
  assert.equal(pickContinueOffer(state({ tasks: [edited] })), null);

  // Underway, blocked, dismissed or already continued: quiet.
  assert.equal(pickContinueOffer(state({ tasks: [{ ...ready, status: 'in_progress' }] })), null);
  assert.equal(pickContinueOffer(state({ tasks: [{ ...ready, status: 'blocked' }] })), null);
  assert.equal(pickContinueOffer(state({ tasks: [applyUpdate([ready], ready.id, { approvalOffer: 'dismissed', approvalOfferFor: approvalId })!.updated] })), null);
  assert.equal(pickContinueOffer(state({ tasks: [applyUpdate([ready], ready.id, { approvalOffer: 'continued', approvalOfferFor: approvalId })!.updated] })), null);

  // A recorded handoff still unread by an idle member nothing will wake
  // points to NUDGE; read, busy or AUTO-PICKUP on keeps quiet.
  const queued = new Map([[BUILDER, [{ msgId: 'm1', fromWorkflowId: DIRECTOR }]]]);
  assert.deepEqual(pickContinueOffer(state({ tasks: [ready], comments: [handoff('m1', approvalId)], pending: queued })),
    { kind: 'nudge', taskId: 'task-1', approvalId, memberWorkflowId: BUILDER });
  assert.equal(pickContinueOffer(state({ tasks: [ready], comments: [handoff('m1', approvalId)] })), null);
  assert.equal(pickContinueOffer(state({ tasks: [ready], comments: [handoff('m1', approvalId)], pending: queued, busy: () => true })), null);
  assert.equal(pickContinueOffer(state({ tasks: [ready], comments: [handoff('m1', approvalId)], pending: queued, autoPickupWakes: true })), null);

  // Unrecorded Director mail already waiting with the assignee is uncertain.
  assert.equal(pickContinueOffer(state({ tasks: [{ ...ready, assignee: BUILDER }], pending: queued })), null);
  // An assignee whose mailbox could not be read is unknown, not empty.
  assert.equal(pickContinueOffer(state({ tasks: [{ ...ready, assignee: BUILDER }] })), null);
  assert.ok(pickContinueOffer(state({ tasks: [{ ...ready, assignee: BUILDER }], pending: new Map([[BUILDER, []]]) })));
});

// Review findings: dependencies and stale offers.
test('an approved task waits for its parents, and a stale offer cannot close a newer approval', () => {
  const parent = task({ id: 'parent-1', title: 'Parent', status: 'in_progress' });
  const child = approved(task({ parentIds: ['parent-1'] }));
  assert.equal(pickContinueOffer(state({ tasks: [parent, child] })), null);
  assert.equal(pickContinueOffer(state({ tasks: [child] })), null, 'a missing parent blocks too');
  assert.equal(pickContinueOffer(state({ tasks: [{ ...parent, status: 'done' }, child] }))?.kind, 'continue');

  const first = approved(task());
  const second = approved(applyUpdate([first], first.id, { approved: false })!.updated);
  assert.notEqual(second.operatorApproval!.id, first.operatorApproval!.id);
  const stale = applyUpdate([second], second.id, { approvalOffer: 'dismissed', approvalOfferFor: first.operatorApproval!.id })!.updated;
  assert.equal(stale.operatorApproval?.offer, undefined);
  assert.equal(pickContinueOffer(state({ tasks: [stale] }))?.approvalId, second.operatorApproval!.id);
});

// Review finding: a handoff counts only for the approval it was sent under.
test('a read handoff from an earlier approval does not cover an edited, re-approved task', () => {
  const first = approved(task());
  const read = [handoff('m1', first.operatorApproval!.id)];
  // Same approval, handoff read: delivered, no second handoff offered.
  assert.equal(pickContinueOffer(state({ tasks: [first], comments: read })), null);
  // Edited and approved again: the old handoff delivered the old scope.
  const edited = applyUpdate([first], first.id, { notes: 'Build it for Windows too.' })!.updated;
  const again = approved(edited);
  assert.equal(pickContinueOffer(state({ tasks: [again], comments: read }))?.kind, 'continue');
  // A handoff recorded before any approval does not count either.
  assert.equal(pickContinueOffer(state({ tasks: [first], comments: [handoff('m0', undefined)] }))?.kind, 'continue');
});
