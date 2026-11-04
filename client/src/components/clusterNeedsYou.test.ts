import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerTask } from '@arco/shared';
import {
  blockedNeedsOperator,
  buildNeedsYouItems,
  filterVisibleBoardTasks,
  namedCommitsForTask,
  needsYouLabel,
  reviewNeedsOperator,
  reviewTasksWithMetSignoff,
  splitRecentAndOlderReview,
} from './clusterNeedsYou.js';

function task(partial: Partial<LedgerTask> & Pick<LedgerTask, 'id' | 'title' | 'status'>): LedgerTask {
  return {
    links: [],
    notes: '',
    priority: 50,
    parentIds: [],
    blockedReason: '',
    reviewRequired: false,
    goalMode: false,
    worktreeRequired: false,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test('review with sign-off needs the operator; review without does not', () => {
  assert.equal(reviewNeedsOperator(task({ id: 'a', title: 'A', status: 'review', signoff: { state: 'met', summary: 'ok', at: 2 } })), true);
  assert.equal(reviewNeedsOperator(task({ id: 'b', title: 'B', status: 'review' })), false);
  assert.equal(reviewNeedsOperator(task({ id: 'c', title: 'C', status: 'todo', signoff: { state: 'met', summary: 'ok', at: 2 } })), false);
});

test('blocked reason must address the operator', () => {
  assert.equal(blockedNeedsOperator(task({ id: 'a', title: 'A', status: 'blocked', blockedReason: 'Needs operator decision on the port' })), true);
  assert.equal(blockedNeedsOperator(task({ id: 'b', title: 'B', status: 'blocked', blockedReason: 'Waiting on Builder 1 for the patch' })), false);
  assert.equal(blockedNeedsOperator(task({ id: 'c', title: 'C', status: 'todo', blockedReason: 'Needs you' })), false);
});

test('ACCEPT ALL MET keeps partial and not_met', () => {
  const tasks = [
    task({ id: '1', title: 'met', status: 'review', signoff: { state: 'met', summary: 'landed', at: 1 } }),
    task({ id: '2', title: 'partial', status: 'review', signoff: { state: 'partial', summary: 'half', at: 1 } }),
    task({ id: '3', title: 'not', status: 'review', signoff: { state: 'not_met', summary: 'no', at: 1 } }),
    task({ id: '4', title: 'pending', status: 'review' }),
  ];
  assert.deepEqual(reviewTasksWithMetSignoff(tasks).map((t) => t.id), ['1']);
});

test('named commits come from notes and sign-off summary', () => {
  const t = task({
    id: '1',
    title: 'x',
    status: 'review',
    notes: 'Landed abcdef1 and abcdef1 again',
    signoff: { state: 'met', summary: 'see deadbeef01', at: 1 },
  });
  assert.deepEqual(namedCommitsForTask(t), ['abcdef1', 'deadbeef01']);
});

test('show done filter and older review fold', () => {
  const now = 1_000_000_000_000;
  const recent = task({ id: 'r', title: 'r', status: 'review', updatedAt: now - 1000 });
  const older = task({
    id: 'o',
    title: 'o',
    status: 'review',
    updatedAt: now - 8 * 24 * 60 * 60 * 1000,
    signoff: { state: 'met', summary: 'old', at: now - 8 * 24 * 60 * 60 * 1000 },
  });
  const done = task({ id: 'd', title: 'd', status: 'done', updatedAt: now });
  assert.deepEqual(filterVisibleBoardTasks([recent, older, done], { showDone: false }).map((t) => t.id), ['r', 'o']);
  assert.equal(filterVisibleBoardTasks([done], { showDone: true }).length, 1);
  const split = splitRecentAndOlderReview([recent, older], now);
  assert.deepEqual(split.recent.map((t) => t.id), ['r']);
  assert.deepEqual(split.older.map((t) => t.id), ['o']);
});

test('needs-you list merges review, operator-blocked and questions', () => {
  const items = buildNeedsYouItems({
    tasks: [
      task({ id: 'r1', title: 'Review me', status: 'review', signoff: { state: 'met', summary: 'ok', at: 1 } }),
      task({ id: 'b1', title: 'Blocked on you', status: 'blocked', blockedReason: 'Needs you to pick a port' }),
      task({ id: 'b2', title: 'Blocked on peer', status: 'blocked', blockedReason: 'Waiting on Builder' }),
    ],
    waitingQuestions: [{ workflowId: 'w1', displayName: 'Builder', label: 'Which branch?' }],
  });
  assert.equal(items.length, 3);
  assert.equal(needsYouLabel(items.length), '3 NEED YOU');
  assert.deepEqual(items.map((i) => i.kind), ['review', 'blocked', 'question']);
});

test('SHOW DONE is on by default and remembers an explicit choice', async () => {
  const { readBoardShowDone } = await import('./clusterNeedsYou.js');
  const store = (value: string | null) => ({ getItem: () => value });
  assert.equal(readBoardShowDone(store(null)), true);
  assert.equal(readBoardShowDone(store('1')), true);
  assert.equal(readBoardShowDone(store('0')), false);
  assert.equal(readBoardShowDone({ getItem: () => { throw new Error('unavailable'); } }), true);
});

test('release labels filter the board and summarize what is in, accepted and left', async () => {
  const { filterVisibleBoardTasks, releaseLabels, releaseSummary, NO_RELEASE } = await import('./clusterNeedsYou.js');
  const t = (id: string, status: string, release?: string) => ({ id, title: id, status, release, links: [], notes: '', priority: 0, parentIds: [], blockedReason: '', reviewRequired: false, goalMode: false, createdAt: 1, updatedAt: 1 }) as never;
  const tasks = [t('a', 'done', '0.1.4'), t('b', 'review', '0.1.4'), t('c', 'todo', '0.1.5'), t('d', 'todo'), t('e', 'archived', '0.1.4')];
  assert.deepEqual(releaseLabels(tasks), ['0.1.5', '0.1.4']);
  assert.equal(filterVisibleBoardTasks(tasks, { showDone: true }).length, 5, 'no release filter keeps every task');
  assert.equal(filterVisibleBoardTasks(tasks, { showDone: true, release: null }).length, 5);
  assert.deepEqual(filterVisibleBoardTasks(tasks, { showDone: true, release: '0.1.4' }).map((x) => x.id), ['a', 'b', 'e']);
  assert.deepEqual(filterVisibleBoardTasks(tasks, { showDone: false, release: '0.1.4' }).map((x) => x.id), ['b']);
  assert.deepEqual(filterVisibleBoardTasks(tasks, { showDone: true, release: NO_RELEASE }).map((x) => x.id), ['d']);
  assert.deepEqual(releaseSummary(tasks, '0.1.4'), { total: 2, accepted: 1, left: 1 });
  assert.deepEqual(releaseSummary(tasks, 'none'), { total: 0, accepted: 0, left: 0 });
});
