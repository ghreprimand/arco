// ARCO_OPS_PLAN.md §D1 (Part D) — project task ledger smoke.
//
// Headless / module-level (no live server, no API spend): the durable contract
// — JSON snapshot round-trip + rebuild-from-events + the operator-confirmed-
// `done` invariant — is best proven against the taskLedger.ts module + the real
// workflowStore events.jsonl path directly. We drive a throwaway temp cwd:
//
//   (1) create tasks via the module → assert load() returns them.
//   (2) Persistence: re-load() reads the same tasks from tasks.json (snapshot
//       round-trip); then DELETE the snapshot and prove rebuildFromEvents()
//       reconstructs the SAME state from the events.jsonl log alone.
//   (3) `done` requires explicit action: creating a task never yields `done`,
//       a notes/title update never flips status to `done`, and applyUpdate is
//       the only path that sets it (and only when the operator's patch says so).
//
// Run: npm run smoke:task-ledger   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';
import * as taskLedger from '../../server/src/project/taskLedger.js';
import {
  initWorkflowStore,
  persistAndStampSeq,
  flushAll,
} from '../../server/src/workflowStore.js';
import { writeMeta, type WorkflowMeta } from '../../server/src/workflowMeta.js';
import type { LedgerTask, TaskLedgerEventMessage } from '../../shared/src/protocol/tasks.js';

const tasksJsonPath = (cwd: string) => path.join(cwd, '.arco', 'project', 'tasks.json');

// Minimal valid meta.json so listWorkflowMetas (used by rebuildFromEvents)
// enumerates this workflow.
function minimalMeta(cwd: string, wfid: string): WorkflowMeta {
  const now = Date.now();
  return {
    workflowId: wfid,
    name: 'smoke',
    cwd,
    createdAt: now,
    lastActiveAt: now,
    primaryProvider: 'claude',
    primaryModel: 'sonnet' as WorkflowMeta['primaryModel'],
    primaryEffort: 'medium' as WorkflowMeta['primaryEffort'],
    cliSessions: [],
    operator: 'smoke',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  };
}

// Append a task_ledger_event to the workflow's events.jsonl exactly as the
// server does (broadcastWorkflow → persistAndStampSeq). This is what
// rebuildFromEvents folds.
function emitEvent(
  cwd: string,
  wfid: string,
  op: 'create' | 'update' | 'delete',
  id: string,
  task?: LedgerTask,
): void {
  const ev: TaskLedgerEventMessage = {
    type: 'task_ledger_event',
    workflowId: wfid,
    cwd,
    op,
    id,
    ...(task ? { task } : {}),
    at: Date.now(),
  };
  persistAndStampSeq(cwd, wfid, ev);
}

async function main(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-ledger-smoke-'));
  const wfid = randomUUID();
  try {
    await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
    await writeMeta(cwd, minimalMeta(cwd, wfid));
    await initWorkflowStore(cwd, wfid);

    let created: LedgerTask[] = [];

    await step('create: tasks appear in load()', async () => {
      const tasks0 = await taskLedger.load(cwd);
      assertEq(tasks0.length, 0, 'fresh cwd starts empty');

      // Mirror the server handler: load → newTask → save → emit event.
      for (const title of ['write spec', 'wire protocol', 'ship smoke']) {
        const tasks = await taskLedger.load(cwd);
        const t = taskLedger.newTask({ title });
        const next = [...tasks, t];
        await taskLedger.save(cwd, next);
        emitEvent(cwd, wfid, 'create', t.id, t);
      }
      await flushAll();

      created = await taskLedger.load(cwd);
      assertEq(created.length, 3, 'three tasks present');
      assert(created.every((t) => t.status === 'todo'), 'all created tasks are todo (never done on create)');
      assert(created.some((t) => t.title === 'wire protocol'), 'title round-trips');
    });

    await step('persistence: snapshot round-trips across a fresh load', async () => {
      // Simulate a "restart" — a new load() with no in-memory state. The JSON
      // snapshot on disk must reproduce the tasks verbatim.
      const reloaded = await taskLedger.load(cwd);
      assertEq(reloaded.length, 3, 'snapshot reload preserves count');
      const byId = new Map(reloaded.map((t) => [t.id, t]));
      for (const t of created) {
        const r = byId.get(t.id);
        assert(r, `task ${t.id.slice(0, 8)} survives reload`);
        assertEq(r!.title, t.title, 'title preserved');
        assertEq(r!.status, t.status, 'status preserved');
      }
    });

    await step('persistence: rebuild-from-events reconstructs the same state', async () => {
      // Destroy the snapshot. load() must fall back to rebuildFromEvents() and
      // fold the durable events.jsonl log into the identical task set.
      await fs.rm(tasksJsonPath(cwd), { force: true });
      const rebuilt = await taskLedger.load(cwd);
      assertEq(rebuilt.length, 3, 'rebuild reconstructs all three tasks from events.jsonl');
      const titles = new Set(rebuilt.map((t) => t.title));
      assert(titles.has('write spec') && titles.has('wire protocol') && titles.has('ship smoke'), 'rebuilt titles match');
      assert(rebuilt.every((t) => t.status === 'todo'), 'rebuilt tasks keep their recorded status');
      // load() also re-materialized the cache.
      const stat = await fs.stat(tasksJsonPath(cwd)).catch(() => null);
      assert(stat, 'rebuild re-materializes tasks.json cache');
    });

    await step('done: never set by create or a non-status update', async () => {
      const tasks = await taskLedger.load(cwd);
      const target = tasks[0];

      // A title/notes update must NOT touch status.
      const r1 = taskLedger.applyUpdate(tasks, target.id, { title: 'write spec v2', notes: 'edited' });
      assert(r1, 'update found the task');
      assertEq(r1!.updated.status, 'todo', 'editing title/notes never flips status to done');

      // newTask never produces done.
      const fresh = taskLedger.newTask({ title: 'x' });
      assertEq(fresh.status, 'todo', 'newTask is always todo — no create-as-done path');
    });

    await step('done: ONLY an explicit operator status update sets it', async () => {
      const tasks = await taskLedger.load(cwd);
      const target = tasks[0];
      // The explicit, operator-originated path.
      const r = taskLedger.applyUpdate(tasks, target.id, { status: 'done' });
      assert(r, 'update found the task');
      assertEq(r!.updated.status, 'done', 'explicit status:done is honored (operator-confirmed path)');
      await taskLedger.save(cwd, r!.tasks);
      emitEvent(cwd, wfid, 'update', target.id, r!.updated);
      await flushAll();

      // Rebuild again — the done state is durable because it was recorded as an
      // operator update event, not inferred.
      await fs.rm(tasksJsonPath(cwd), { force: true });
      const rebuilt = await taskLedger.load(cwd);
      const reTarget = rebuilt.find((t) => t.id === target.id);
      assert(reTarget, 'target survives rebuild');
      assertEq(reTarget!.status, 'done', 'done state replays from the recorded operator event');
    });

    await step('delete: removes the task and the delete replays', async () => {
      const tasks = await taskLedger.load(cwd);
      const victim = tasks[tasks.length - 1];
      const next = taskLedger.removeTask(tasks, victim.id);
      assert(next, 'removeTask found the task');
      await taskLedger.save(cwd, next!);
      emitEvent(cwd, wfid, 'delete', victim.id);
      await flushAll();

      await fs.rm(tasksJsonPath(cwd), { force: true });
      const rebuilt = await taskLedger.load(cwd);
      assert(!rebuilt.some((t) => t.id === victim.id), 'deleted task does not reappear after rebuild');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-ledger');
}

void main();
