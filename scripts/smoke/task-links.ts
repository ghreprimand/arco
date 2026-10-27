// docs/TASK_LEDGER.md - ledger <-> plan/review/workflow link smoke.
//
// Headless / module-level (no live server, no API spend): D2 adds NO protocol —
// links flow through the existing task_ledger_update path — so the durable
// contract is the reverse-query capability (target→tasks) plus link survival
// through save/load. We drive the real taskLedger.ts pure helpers and a
// throwaway temp cwd:
//
//   (a) create tasks carrying links via newTask + applyUpdate;
//   (b) tasksLinkedTo returns exactly the tasks linking to a {kind, ref};
//   (c) same ref under a different kind does NOT cross-match;
//   (d) attach/detach a link via applyUpdate({links}) updates the reverse query;
//   (e) round-trip through save/load preserves links.
//
// Run: npm run smoke:task-links   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { step, assert, assertEq, summary } from './lib.js';
import * as taskLedger from '../../server/src/project/taskLedger.js';
import type { LedgerTask, TaskLink } from '../../shared/src/protocol/tasks.js';

const ids = (tasks: LedgerTask[]) => new Set(tasks.map((t) => t.id));

async function main(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-links-smoke-'));
  try {
    // A small fixed link set we can assert against. Note: PLAN_A and WF_X share
    // the literal ref string "alpha" under different kinds — the cross-match
    // guard (c) hinges on that.
    const PLAN_A: TaskLink = { kind: 'plan', ref: 'alpha', label: 'Plan Alpha' };
    const WF_X: TaskLink = { kind: 'workflow', ref: 'alpha' };
    const REVIEW_R: TaskLink = { kind: 'review', ref: 'review-2026-06-01.md' };

    let tasks: LedgerTask[] = [];

    await step('create tasks carrying links', async () => {
      const t1 = taskLedger.newTask({ title: 'links to plan alpha + review', links: [PLAN_A, REVIEW_R] });
      const t2 = taskLedger.newTask({ title: 'links to workflow alpha', links: [WF_X] });
      const t3 = taskLedger.newTask({ title: 'no links' });
      tasks = [t1, t2, t3];
      assertEq(tasks.length, 3, 'three tasks created');
      assertEq(t1.links.length, 2, 't1 carries both links through newTask');
      assertEq(t3.links.length, 0, 't3 has no links');
    });

    await step('tasksLinkedTo returns exactly the matching tasks', async () => {
      const linkedToPlanAlpha = taskLedger.tasksLinkedTo(tasks, { kind: 'plan', ref: 'alpha' });
      assertEq(linkedToPlanAlpha.length, 1, 'one task links to plan alpha');
      assert(ids(linkedToPlanAlpha).has(tasks[0].id), 'it is t1');

      const linkedToReview = taskLedger.tasksLinkedTo(tasks, { kind: 'review', ref: 'review-2026-06-01.md' });
      assertEq(linkedToReview.length, 1, 'one task links to the review');
      assert(ids(linkedToReview).has(tasks[0].id), 'it is t1');

      const linkedToNothing = taskLedger.tasksLinkedTo(tasks, { kind: 'plan', ref: 'nonexistent' });
      assertEq(linkedToNothing.length, 0, 'no task links to an absent ref');
    });

    await step('same ref under a different kind does NOT cross-match', async () => {
      const plan = taskLedger.tasksLinkedTo(tasks, { kind: 'plan', ref: 'alpha' });
      const wf = taskLedger.tasksLinkedTo(tasks, { kind: 'workflow', ref: 'alpha' });
      assertEq(plan.length, 1, 'plan:alpha matches exactly one task');
      assertEq(wf.length, 1, 'workflow:alpha matches exactly one task');
      assert(plan[0].id !== wf[0].id, 'they are different tasks — kind disambiguates the shared ref');
      assert(ids(wf).has(tasks[1].id), 'workflow:alpha is t2, not t1');
    });

    await step('attach/detach via applyUpdate({links}) updates the reverse query', async () => {
      // Attach plan:alpha to t2 (which previously only linked workflow:alpha).
      const attach = taskLedger.applyUpdate(tasks, tasks[1].id, { links: [WF_X, PLAN_A] });
      assert(attach, 'applyUpdate found t2');
      tasks = attach!.tasks;
      const afterAttach = taskLedger.tasksLinkedTo(tasks, { kind: 'plan', ref: 'alpha' });
      assertEq(afterAttach.length, 2, 'plan:alpha now matches t1 and t2');

      // Detach all links from t2.
      const detach = taskLedger.applyUpdate(tasks, tasks[1].id, { links: [] });
      assert(detach, 'applyUpdate found t2 again');
      tasks = detach!.tasks;
      const afterDetach = taskLedger.tasksLinkedTo(tasks, { kind: 'plan', ref: 'alpha' });
      assertEq(afterDetach.length, 1, 'plan:alpha back to just t1 after detach');
      const wfAfter = taskLedger.tasksLinkedTo(tasks, { kind: 'workflow', ref: 'alpha' });
      assertEq(wfAfter.length, 0, 'workflow:alpha no longer matches — t2 was cleared');
    });

    await step('save/load round-trip preserves links', async () => {
      await taskLedger.save(cwd, tasks);
      const reloaded = await taskLedger.load(cwd);
      assertEq(reloaded.length, 3, 'all tasks reload');
      const t1 = reloaded.find((t) => t.id === tasks[0].id);
      assert(t1, 't1 survives reload');
      assertEq(t1!.links.length, 2, 't1 keeps both links across save/load');
      const planLink = t1!.links.find((l) => l.kind === 'plan');
      assert(planLink, 'plan link preserved');
      assertEq(planLink!.ref, 'alpha', 'plan link ref preserved');
      assertEq(planLink!.label, 'Plan Alpha', 'optional label preserved');
      // Reverse query still works after a fresh load (not just in-memory).
      const linked = taskLedger.tasksLinkedTo(reloaded, { kind: 'review', ref: 'review-2026-06-01.md' });
      assertEq(linked.length, 1, 'reverse query holds across persistence');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-links');
}

void main();
