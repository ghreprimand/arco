// Director/workers Stage B — task-kernel snapshot smoke.
//
// Headless/module-level. Covers the additive kernel envelope without a live
// server:
//   (a) save() writes a versioned snapshot.
//   (b) legacy { tasks } snapshots still load and upgrade on save().
//   (c) Stage B task metadata round-trips through save/load.
//   (d) rebuildFromEvents normalizes old events into kernel-shaped tasks.
//
// Run: npm run smoke:task-ledger-kernel

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
import { TASK_KERNEL_VERSION, type LedgerTask, type TaskLedgerEventMessage } from '../../shared/src/protocol/tasks.js';

const tasksJsonPath = (cwd: string) => path.join(cwd, '.arco', 'project', 'tasks.json');

function minimalMeta(cwd: string, wfid: string): WorkflowMeta {
  const now = Date.now();
  return {
    workflowId: wfid,
    name: 'task-kernel-smoke',
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

function emitEvent(cwd: string, wfid: string, task: LedgerTask): void {
  const ev: TaskLedgerEventMessage = {
    type: 'task_ledger_event',
    workflowId: wfid,
    cwd,
    op: 'create',
    id: task.id,
    task,
    at: Date.now(),
  };
  persistAndStampSeq(cwd, wfid, ev);
}

async function readSnapshot(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(tasksJsonPath(cwd), 'utf8')) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-kernel-'));
  const wfid = randomUUID();
  try {
    await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
    await writeMeta(cwd, minimalMeta(cwd, wfid));
    await initWorkflowStore(cwd, wfid);

    await step('(a) save writes a versioned task-kernel snapshot', async () => {
      const task = taskLedger.newTask({ title: 'kernel task', priority: 4, parentIds: ['root'], reviewRequired: true });
      await taskLedger.save(cwd, [task]);
      const raw = await readSnapshot(cwd);
      assertEq(raw.version, TASK_KERNEL_VERSION, 'snapshot version is stamped');
      assert(Array.isArray(raw.tasks), 'snapshot keeps tasks array');
    });

    await step('(b) legacy { tasks } snapshots load and upgrade on save', async () => {
      const legacy = {
        id: randomUUID(),
        title: 'legacy task',
        status: 'todo',
        links: [],
        notes: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await fs.mkdir(path.dirname(tasksJsonPath(cwd)), { recursive: true });
      await fs.writeFile(tasksJsonPath(cwd), JSON.stringify({ tasks: [legacy] }, null, 2), 'utf8');
      const loaded = await taskLedger.load(cwd);
      assertEq(loaded.length, 1, 'legacy task loads');
      assertEq(loaded[0].priority, 0, 'legacy task gets default priority');
      assertEq(loaded[0].parentIds.length, 0, 'legacy task gets default parentIds');
      assertEq(loaded[0].reviewRequired, false, 'legacy task gets default reviewRequired');

      await taskLedger.save(cwd, loaded);
      const upgraded = await readSnapshot(cwd);
      assertEq(upgraded.version, TASK_KERNEL_VERSION, 'legacy snapshot upgrades to versioned envelope');
    });

    await step('(c) kernel metadata round-trips through save/load', async () => {
      const task = taskLedger.newTask({
        title: 'review-gated task',
        priority: 9,
        parentIds: ['parent-a', 'parent-a', 'parent-b'],
        reviewRequired: true,
        goalMode: true,
        goalMaxTurns: 3,
        createdBy: wfid,
      });
      const updated = taskLedger.applyUpdate([task], task.id, {
        status: 'review',
        blockedReason: 'waiting on reviewer',
        updatedBy: wfid,
      });
      assert(updated, 'metadata update applies');
      await taskLedger.save(cwd, updated!.tasks);
      const [loaded] = await taskLedger.load(cwd);
      assertEq(loaded.status, 'review', 'review status persists');
      assertEq(loaded.priority, 9, 'priority persists');
      assertEq(loaded.parentIds.join(','), 'parent-a,parent-b', 'parentIds dedupe and persist');
      assertEq(loaded.reviewRequired, true, 'reviewRequired persists');
      assertEq(loaded.goalMode, true, 'goalMode persists');
      assertEq(loaded.goalMaxTurns, 3, 'goalMaxTurns persists');
      assertEq(loaded.createdBy, wfid, 'createdBy persists');
      assertEq(loaded.updatedBy, wfid, 'updatedBy persists');
    });

    await step('(d) rebuildFromEvents normalizes old events into kernel tasks', async () => {
      const legacy = {
        id: randomUUID(),
        title: 'event legacy task',
        status: 'todo',
        links: [],
        notes: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as LedgerTask;
      emitEvent(cwd, wfid, legacy);
      await flushAll();
      await fs.rm(tasksJsonPath(cwd), { force: true });
      const rebuilt = await taskLedger.load(cwd);
      const task = rebuilt.find((t) => t.id === legacy.id);
      assert(task, 'legacy event task rebuilds');
      assertEq(task!.priority, 0, 'rebuilt legacy task gets default priority');
      assertEq(task!.blockedReason, '', 'rebuilt legacy task gets default blockedReason');
      assertEq(task!.goalMode, false, 'rebuilt legacy task gets default goalMode');
      const raw = await readSnapshot(cwd);
      assertEq(raw.version, TASK_KERNEL_VERSION, 'rebuild writes versioned snapshot');
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-ledger-kernel');
}

void main();
