// Unit tests for taskLedger.formatBoardForModel — the compact, model-facing
// board view. Run with: `npm run test:board-view -w server`.
//
// Regression context: cluster_task_list used to dump the whole ledger (all
// statuses, oldest-first, full notes) into a worker's tool result, where the
// 64KB cap byte-sliced it mid-object — dropping exactly the newest/active rows
// and leaving invalid JSON. These assertions pin the four properties of the fix:
// done/archived hidden, notes stripped, active-first, always-valid + bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerTask, LedgerTaskStatus } from '@arco/shared';
import { formatBoardForModel } from './taskLedger.js';

function mk(over: Partial<LedgerTask> & { id: string; status: LedgerTaskStatus }): LedgerTask {
  return {
    title: `task ${over.id}`,
    links: [],
    notes: '',
    priority: 0,
    parentIds: [],
    blockedReason: '',
    reviewRequired: false,
    goalMode: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

test('hides done/archived from tasks but still counts them', () => {
  const board = JSON.parse(formatBoardForModel([
    mk({ id: 'a', status: 'todo' }),
    mk({ id: 'b', status: 'in_progress' }),
    mk({ id: 'c', status: 'done' }),
    mk({ id: 'd', status: 'archived' }),
    mk({ id: 'e', status: 'done' }),
  ]));
  assert.equal(board.activeCount, 2);
  assert.equal(board.completedCount, 3);
  assert.deepEqual(board.tasks.map((t: { id: string }) => t.id).sort(), ['a', 'b']);
  assert.ok(board.tasks.every((t: { status: string }) => t.status !== 'done' && t.status !== 'archived'));
});

test('surfaces recently-finished tasks as compact one-liners', () => {
  const completed = Array.from({ length: 15 }, (_, i) =>
    mk({ id: `c${i}`, status: 'done', updatedAt: 2000 + i }));
  const board = JSON.parse(formatBoardForModel([mk({ id: 'a', status: 'todo' }), ...completed]));
  assert.equal(board.recentlyCompleted.length, 10); // BOARD_RECENT_DONE
  // most-recently-updated first
  assert.equal(board.recentlyCompleted[0].id, 'c14');
  // one-liner shape: no notesPreview/priority, just id/title/status/updatedAt
  assert.deepEqual(Object.keys(board.recentlyCompleted[0]).sort(), ['id', 'status', 'title', 'updatedAt']);
});

test('orders active rows newest-updated-first', () => {
  const board = JSON.parse(formatBoardForModel([
    mk({ id: 'old', status: 'todo', updatedAt: 100 }),
    mk({ id: 'new', status: 'todo', updatedAt: 900 }),
    mk({ id: 'mid', status: 'in_progress', updatedAt: 500 }),
  ]));
  assert.deepEqual(board.tasks.map((t: { id: string }) => t.id), ['new', 'mid', 'old']);
});

test('strips fat notes to a one-line preview + length', () => {
  const fat = 'x'.repeat(3000) + '\n\nsecond para';
  const board = JSON.parse(formatBoardForModel([mk({ id: 'a', status: 'todo', notes: fat })]));
  const row = board.tasks[0];
  assert.ok(row.notesPreview.length <= 161, `preview ${row.notesPreview.length} chars`); // 160 + ellipsis
  assert.equal(row.notesLength, fat.length);
  assert.ok(!row.notes, 'full notes must not be serialized into the list');
});

test('short notes inline with no length field; collapses whitespace', () => {
  const board = JSON.parse(formatBoardForModel([mk({ id: 'a', status: 'todo', notes: 'hi   there\n\nfriend' })]));
  const row = board.tasks[0];
  assert.equal(row.notesPreview, 'hi there friend');
  assert.equal(row.notesLength, undefined);
});

test('bounds output to valid JSON under budget, reporting omitted active rows', () => {
  // 400 active tasks, each with a chunky note — far past the 48KB budget.
  const many = Array.from({ length: 400 }, (_, i) =>
    mk({ id: `t${i}`, status: 'todo', updatedAt: i, notes: 'n'.repeat(2000) }));
  const out = formatBoardForModel(many);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 48 * 1024, `output ${Buffer.byteLength(out, 'utf8')} bytes exceeds budget`);
  const board = JSON.parse(out); // must not throw — the old byte-slice produced invalid JSON
  assert.equal(board.activeCount, 400);
  assert.ok(board.omittedActive > 0, 'should report dropped rows');
  assert.equal(board.tasks.length + board.omittedActive, 400);
  // dropped from the tail (oldest-updated) — the newest row survives
  assert.equal(board.tasks[0].id, 't399');
});

test('empty board is valid and explicit', () => {
  const board = JSON.parse(formatBoardForModel([]));
  assert.equal(board.activeCount, 0);
  assert.equal(board.completedCount, 0);
  assert.deepEqual(board.tasks, []);
});

test('blocked tasks carry their reason; only blocked ones do', () => {
  const board = JSON.parse(formatBoardForModel([
    mk({ id: 'a', status: 'blocked', blockedReason: 'waiting on TH3' }),
    mk({ id: 'b', status: 'todo', blockedReason: 'stale leftover' }),
  ]));
  const byId = Object.fromEntries(board.tasks.map((t: { id: string }) => [t.id, t]));
  assert.equal(byId.a.blockedReason, 'waiting on TH3');
  assert.equal(byId.b.blockedReason, undefined);
});
