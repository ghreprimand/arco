import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerTask } from '@arco/shared';
import {
  blockedNeedsOperator,
  buildNeedsYouItems,
  filterVisibleBoardTasks,
  namedCommitsForTask,
  plainSignoffSummary,
  needsYouSummary,
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

test('incomplete verdict summaries use plain language', () => {
  assert.equal(plainSignoffSummary({ state: 'partial', summary: 'partial: waiting for real use', at: 1 }), 'Not finished: waiting for real use');
  assert.equal(plainSignoffSummary({ state: 'not_met', summary: 'not_met: needs a fix', at: 1 }), 'Not finished: needs a fix');
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

test('cluster attention names urgency without treating optional acceptance or async questions as stopped work', () => {
  const items = buildNeedsYouItems({
    tasks: [
      task({ id: 'r1', title: 'Review me', status: 'review', signoff: { state: 'met', summary: 'ok', at: 1 } }),
      task({ id: 'unsigned', title: 'Not signed off', status: 'review' }),
      task({ id: 'b1', title: 'Blocked on you', status: 'blocked', blockedReason: 'Needs you to pick a port' }),
      task({ id: 'b2', title: 'Blocked on peer', status: 'blocked', blockedReason: 'Waiting on Builder' }),
    ],
    waitingQuestions: [
      { workflowId: 'w1', displayName: 'Builder', label: 'Which branch?' },
      { workflowId: 'w2', displayName: 'Working member', mode: 'async' },
    ],
  });
  assert.equal(items.length, 3);
  const summary = needsYouSummary(items);
  assert.equal(summary.label, '1 WAITING · 1 BLOCKED · 1 ASKED');
  assert.equal(summary.stopped, 2);
  assert.equal(summary.compactLabel, '! 2');
  assert.deepEqual(summary.groups.map((group) => [group.label, group.stopped]), [
    ['WAITING', true], ['BLOCKED', true], ['ASKED', false],
  ]);
  assert.deepEqual(items.map((item) => item.kind), ['blocked', 'question', 'asked'], 'the existing list order and jump targets are retained');
  assert.equal(items.find((item) => item.kind === 'asked')?.workflowId, 'w2');
  const optional = needsYouSummary(items.filter((item) => item.kind === 'asked'));
  assert.equal(optional.label, '1 ASKED');
  assert.equal(optional.compactLabel, '1');
  assert.equal(optional.stopped, 0);
  assert.ok(optional.groups.every((group) => !group.stopped));
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
