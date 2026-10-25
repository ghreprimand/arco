// ARCO_OPS_PLAN.md §D3 — cluster task board + task peer-tools smoke.
//
// Headless / module-level (no live server, no API spend). Drives the real
// clusterPeerOps task-ops against a real cluster + a real cwd-scoped task
// ledger. The load-bearing contracts:
//
//   (a) peerTaskClaim sets assignee = caller and status = in_progress.
//   (b) already_claimed guard — a DIFFERENT member's claim on an owned task
//       is rejected (no stomp).
//   (c) peerTaskUpdate to in_progress / blocked succeeds.
//   (d) peerTaskUpdate with status:'done' is REJECTED (operator_gated) — the
//       operator-confirmed-done invariant re-enforced at the peer layer.
//   (e) the operator path (applyUpdate with done) STILL succeeds — proving
//       done is operator-only, not globally blocked.
//   (f) the board groupByStatus helper buckets correctly.
//   (g) task drawer pure helpers pick a request workflow and summarize graph state.
//   (h) save/load round-trip preserves assignee.
//
// Cluster lifecycle writes under ~/.arco/clusters — we point HOME at a temp
// dir BEFORE importing clusterStore (its ARCO_HOME is computed at import
// time from os.homedir(), which honors $HOME on POSIX). All imports are
// therefore dynamic, after the HOME swap.
//
// Run: npm run smoke:task-board   (no server needed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  // Isolate cluster + workflow state under a throwaway HOME so the smoke never
  // touches the operator's real ~/.arco.
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-board-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-board-cwd-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;

  try {
    // Dynamic imports AFTER the HOME swap so clusterStore's ARCO_HOME picks
    // up the temp dir.
    const clusterStore = await import('../../server/src/clusterStore.js');
    const peerOps = await import('../../server/src/clusterPeerOps.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const { writeMeta } = await import('../../server/src/workflowMeta.js');
    const { initWorkflowStore, flushAll } = await import('../../server/src/workflowStore.js');
    const { workflows, workflowCwds } = await import('../../server/src/server/state.js');
    const { groupByStatus, taskGraphSummary, taskShowWorkflowId } = await import('../../client/src/components/clusterTaskBoard.helpers.js');

    const wfA = randomUUID();
    const wfB = randomUUID();

    // Two member workflows sharing the cwd (a cluster needs ≥2 members).
    for (const wfid of [wfA, wfB]) {
      await fs.mkdir(path.join(cwd, '.arco', 'workflows', wfid), { recursive: true });
      // Register a minimal workflow stub so broadcastWorkflow (which the
      // peer-ops use to append the durable task_ledger_event) runs
      // persistAndStampSeq. It only reads `.observers` + `workflowCwds` for our
      // event type — a no-observer stub is enough for a headless run.
      workflowCwds.set(wfid, cwd);
      workflows.set(wfid, { observers: new Set(), config: { workingDirectory: cwd } } as unknown as Parameters<typeof workflows.set>[1]);
      await writeMeta(cwd, {
        workflowId: wfid,
        name: 'board-smoke',
        cwd,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        primaryProvider: 'claude',
        primaryModel: 'sonnet',
        primaryEffort: 'medium',
        cliSessions: [],
        operator: 'smoke',
        lastEventSeq: null,
        lastTranscriptSeq: null,
        compactedAt: null,
      } as Parameters<typeof writeMeta>[1]);
      await initWorkflowStore(cwd, wfid);
    }

    const cluster = await clusterStore.createCluster({ cwd, memberWorkflowIds: [wfA, wfB] });

    // broadcastCluster sink — capture snapshots fired by the peer-ops so we can
    // assert the board would update. No real WS in a headless smoke.
    const boardKey = clusterStore.taskBoardKeyForCluster(cluster.clusterId, 'cluster');
    const snapshots: Array<{ type: string; cwd: string; boardKey?: string; tasks: unknown[] }> = [];
    const sink = (msg: { type: string; cwd?: string; boardKey?: string; tasks?: unknown[] }) => {
      if (msg.type === 'task_ledger_snapshot') {
        snapshots.push({ type: msg.type, cwd: msg.cwd ?? '', ...(msg.boardKey ? { boardKey: msg.boardKey } : {}), tasks: msg.tasks ?? [] });
      }
    };
    const ctx = (workflowId: string) => ({
      workflowId,
      clusterId: cluster.clusterId,
      broadcastSender: () => undefined,
      broadcastRecipient: () => undefined,
    });

    await step('setup: new clusters attach a project board by default (P12.1)', async () => {
      // §10.7 P12.1 — createCluster now defaults taskBoardMode to 'project', so
      // the board is live on arrival (no board_detached rejection). The project
      // board reads the cwd's normal ledger, which is empty here.
      assertEq(cluster.taskBoardMode, 'project', 'new cluster defaults to project board');
      const r = await peerOps.peerTaskList(ctx(wfA));
      assert(r.ok, 'attached board accepts task list');
      assertEq(r.ok && r.tasks.length, 0, 'project board starts empty');
      // The rest of the suite exercises the cluster-private board.
      await clusterStore.setTaskBoardMode(cluster.clusterId, 'cluster');
    });

    // Seed two tasks via the module (the operator-create path: never assigned,
    // never done).
    let taskId = '';
    let secondId = '';
    await step('setup: seed two unclaimed todo tasks', async () => {
      const t1 = taskLedger.newTask({ title: 'wire the board' });
      const t2 = taskLedger.newTask({ title: 'document peer-tools', links: [{ kind: 'plan', ref: 'p1' }] });
      assert(!('assignee' in t1) || t1.assignee === undefined, 'newTask never sets assignee');
      assertEq(t1.status, 'todo', 'newTask is todo');
      await taskLedger.save(cwd, [t1, t2], boardKey);
      assertEq((await taskLedger.load(cwd)).length, 0, 'project board remains empty');
      taskId = t1.id;
      secondId = t2.id;
    });

    await step('(a) peerTaskClaim sets assignee=caller + status in_progress', async () => {
      const r = await peerOps.peerTaskClaim(ctx(wfA), { id: taskId }, sink);
      assert(r.ok, `claim ok (got ${r.ok ? 'ok' : (r as { code: string }).code})`);
      assertEq(r.ok && r.task.assignee, wfA, 'assignee is the claimant');
      assertEq(r.ok && r.task.status, 'in_progress', 'claim moves task to in_progress');
      assert(snapshots.length >= 1, 'claim broadcast a task_ledger_snapshot');
      assertEq(snapshots.at(-1)?.boardKey, boardKey, 'snapshot targets the cluster-private board');
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === taskId);
      assertEq(persisted?.assignee, wfA, 'claim persisted to the ledger');
    });

    await step('(b) already_claimed: a different member cannot stomp the owner', async () => {
      const r = await peerOps.peerTaskClaim(ctx(wfB), { id: taskId }, sink);
      assert(!r.ok, 'second claim rejected');
      assertEq(!r.ok && r.code, 'already_claimed', 'rejection code is already_claimed');
      // The original owner is untouched.
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === taskId);
      assertEq(persisted?.assignee, wfA, 'owner unchanged after a rejected claim');
    });

    await step('(b2) re-claim by the SAME owner is idempotent', async () => {
      const r = await peerOps.peerTaskClaim(ctx(wfA), { id: taskId }, sink);
      assert(r.ok, 'owner re-claim succeeds (no-op)');
      assertEq(r.ok && r.task.assignee, wfA, 'still owned by wfA');
    });

    await step('(c) peerTaskUpdate to blocked / in_progress succeeds', async () => {
      const rBlocked = await peerOps.peerTaskUpdate(ctx(wfA), { id: taskId, status: 'blocked', notes: 'waiting on review' }, sink);
      assert(rBlocked.ok, 'update to blocked ok');
      assertEq(rBlocked.ok && rBlocked.task.status, 'blocked', 'status is blocked');
      assertEq(rBlocked.ok && rBlocked.task.notes, 'waiting on review', 'notes updated');

      const rBack = await peerOps.peerTaskUpdate(ctx(wfA), { id: taskId, status: 'in_progress' }, sink);
      assert(rBack.ok, 'update back to in_progress ok');
      assertEq(rBack.ok && rBack.task.status, 'in_progress', 'status is in_progress');
    });

    await step("(d) peerTaskUpdate status:'done' is REJECTED (operator_gated)", async () => {
      const r = await peerOps.peerTaskUpdate(ctx(wfA), { id: taskId, status: 'done' }, sink);
      assert(!r.ok, 'worker done is rejected');
      assertEq(!r.ok && r.code, 'operator_gated', 'rejection code is operator_gated');
      // The task did NOT flip to done.
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === taskId);
      assertEq(persisted?.status, 'in_progress', 'task is unchanged after the rejected done');
    });

    await step('(e) operator path: applyUpdate with done STILL succeeds', async () => {
      // Prove done is operator-only, not globally blocked — the operator WS
      // path goes straight through applyUpdate.
      const tasks = await taskLedger.load(cwd, boardKey);
      const applied = taskLedger.applyUpdate(tasks, taskId, { status: 'done' });
      assert(applied, 'operator applyUpdate found the task');
      assertEq(applied!.updated.status, 'done', 'operator can set done');
      await taskLedger.save(cwd, applied!.tasks, boardKey);
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === taskId);
      assertEq(persisted?.status, 'done', 'operator-set done persisted');
      // The operator path may also clear an assignee with empty string.
      const cleared = taskLedger.applyUpdate(applied!.tasks, secondId, { assignee: 'someone', });
      assert(cleared && cleared.updated.assignee === 'someone', 'assignee set');
      const unset = taskLedger.applyUpdate(cleared!.tasks, secondId, { assignee: '' });
      assert(unset && unset.updated.assignee === undefined, 'empty-string assignee clears the claim');
    });

    // H48 — cluster_task_complete guards. Runs on its own freshly-seeded task
    // so it stays decoupled from secondId (which step (h) re-claims for wfB).
    let thirdId = '';
    await step('(H48.0) seed a fresh unclaimed task for the completion guards', async () => {
      const t3 = taskLedger.newTask({ title: 'ship the guard' });
      const existing = await taskLedger.load(cwd, boardKey);
      await taskLedger.save(cwd, [...existing, t3], boardKey);
      thirdId = t3.id;
    });

    await step('(H48.1) complete: unknown id is rejected (not_found)', async () => {
      const r = await peerOps.peerTaskComplete(ctx(wfA), { id: 'deadbeef-not-a-real-task', summary: 'x' }, sink);
      assert(!r.ok, 'completing a fabricated id is rejected');
      assertEq(!r.ok && r.code, 'not_found', 'hallucinated-id gate returns not_found');
    });

    await step('(H48.2) complete: unassigned task is rejected (not_owner)', async () => {
      const r = await peerOps.peerTaskComplete(ctx(wfA), { id: thirdId, summary: 'done' }, sink);
      assert(!r.ok, 'completing an unassigned task is rejected');
      assertEq(!r.ok && r.code, 'not_owner', 'unassigned completion returns not_owner');
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === thirdId);
      assertEq(persisted?.status, 'todo', 'task is unchanged after the rejected completion');
    });

    await step('(H48.3) complete: another member cannot complete your task (not_owner)', async () => {
      const claim = await peerOps.peerTaskClaim(ctx(wfA), { id: thirdId }, sink);
      assert(claim.ok, 'wfA claims thirdId');
      const r = await peerOps.peerTaskComplete(ctx(wfB), { id: thirdId, summary: 'sneaky' }, sink);
      assert(!r.ok, "a non-owner's completion is rejected");
      assertEq(!r.ok && r.code, 'not_owner', 'cross-member completion returns not_owner');
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === thirdId);
      assertEq(persisted?.status, 'in_progress', 'task stays in_progress (owner unaffected)');
    });

    await step('(H48.4) complete: the owner can complete → review', async () => {
      const r = await peerOps.peerTaskComplete(ctx(wfA), { id: thirdId, summary: 'wired + tested' }, sink);
      assert(r.ok, `owner completion ok (got ${r.ok ? 'ok' : (r as { code: string }).code})`);
      assertEq(r.ok && r.task.status, 'review', 'owner completion moves task to review');
      const persisted = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === thirdId);
      assertEq(persisted?.status, 'review', 'review status persisted');
    });

    await step('(f) groupByStatus buckets correctly', async () => {
      const fixture = [
        { id: '1', title: 'a', status: 'todo', links: [], notes: '', createdAt: 1, updatedAt: 1 },
        { id: '2', title: 'b', status: 'in_progress', links: [], notes: '', createdAt: 2, updatedAt: 2 },
        { id: '3', title: 'c', status: 'blocked', links: [], notes: '', createdAt: 3, updatedAt: 3 },
        { id: '4', title: 'd', status: 'done', links: [], notes: '', createdAt: 4, updatedAt: 4 },
        { id: '5', title: 'e', status: 'todo', links: [], notes: '', createdAt: 5, updatedAt: 5 },
      ] as Parameters<typeof groupByStatus>[0];
      const grouped = groupByStatus(fixture);
      assertEq(grouped.todo.length, 2, 'two todo');
      assertEq(grouped.in_progress.length, 1, 'one in_progress');
      assertEq(grouped.blocked.length, 1, 'one blocked');
      assertEq(grouped.done.length, 1, 'one done');
      assertEq(grouped.todo[0].id, '1', 'todo preserves input order');
      assertEq(grouped.todo[1].id, '5', 'todo preserves input order (2nd)');
    });

    await step('(g) task drawer helpers pick request member + summarize graph', async () => {
      assertEq(taskShowWorkflowId([{ workflowId: wfA }, { workflowId: wfB }]), wfA, 'first member is used for task-show REST reads');
      assertEq(taskShowWorkflowId([]), null, 'no members means no task-show reader');
      const mk = (id: string, status: string) => ({
        id,
        title: id,
        status,
        links: [],
        notes: '',
        priority: 0,
        parentIds: [],
        blockedReason: '',
        reviewRequired: false,
        goalMode: false,
        createdAt: 1,
        updatedAt: 1,
      });
      const summary = taskGraphSummary({
        parents: [mk('p1', 'blocked'), mk('p2', 'done')],
        children: [mk('c1', 'todo'), mk('c2', 'archived'), mk('c3', 'review')],
      } as Parameters<typeof taskGraphSummary>[0]);
      assertEq(summary.parentCount, 2, 'two parents');
      assertEq(summary.childCount, 3, 'three children');
      assertEq(summary.blockedParentCount, 1, 'one blocked parent');
      assertEq(summary.openChildCount, 2, 'two non-terminal children');
    });

    await step('(h) save/load round-trip preserves assignee', async () => {
      // Re-claim the second task, then a fresh load() must reproduce assignee.
      const r = await peerOps.peerTaskClaim(ctx(wfB), { id: secondId }, sink);
      assert(r.ok, 'claim second task ok');
      const reloaded = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === secondId);
      assertEq(reloaded?.assignee, wfB, 'assignee survives a fresh load (snapshot round-trip)');
      // Destroy the snapshot → rebuildFromEvents must also carry assignee
      // (claims emit durable task_ledger_event through persistLedgerMutation).
      await flushAll();
      await fs.rm(path.join(cwd, '.arco', 'project', 'boards', boardKey, 'tasks.json'), { force: true });
      const rebuilt = (await taskLedger.load(cwd, boardKey)).find((t) => t.id === secondId);
      assertEq(rebuilt?.assignee, wfB, 'assignee replays from events.jsonl (rebuild)');
    });

    // ── §10.7 Board interaction overhaul (Phase 12) ──
    // These exercise the pure ledger logic the board's new operator surfaces
    // ride on: create-on-board (P12.2), drawer field edits + delete (P12.3),
    // and the plan/peer → task bridges (P12.5). All reuse the operator
    // task_ledger_create / applyUpdate / removeTask paths — no new server
    // surface — so asserting the helpers covers the wiring's contract.

    await step('(P12.2) create-on-board yields an unclaimed todo task', async () => {
      // Mirrors handleTaskLedgerCreate: newTask is always todo, never assigned.
      const t = taskLedger.newTask({ title: 'groom this' });
      assertEq(t.status, 'todo', 'board-composed task is todo');
      assert(t.assignee === undefined, 'board-composed task is unclaimed');
      const existing = await taskLedger.load(cwd, boardKey);
      await taskLedger.save(cwd, [...existing, t], boardKey);
      const persisted = (await taskLedger.load(cwd, boardKey)).find((x) => x.id === t.id);
      assertEq(persisted?.title, 'groom this', 'create-on-board persisted');
    });

    await step('(P12.3) drawer edits title/notes/priority/parents + delete', async () => {
      const t = taskLedger.newTask({ title: 'edit me' });
      const parent = taskLedger.newTask({ title: 'parent task' });
      let tasks = [...(await taskLedger.load(cwd, boardKey)), t, parent];
      await taskLedger.save(cwd, tasks, boardKey);

      // Field edits (one task_ledger_update with the changed subset).
      const edited = taskLedger.applyUpdate(tasks, t.id, {
        title: 'edited title',
        notes: 'edited notes',
        priority: 7,
        parentIds: [parent.id],
      });
      assert(edited, 'applyUpdate found the task');
      assertEq(edited!.updated.title, 'edited title', 'title edited');
      assertEq(edited!.updated.notes, 'edited notes', 'notes edited');
      assertEq(edited!.updated.priority, 7, 'priority edited');
      assertEq(edited!.updated.parentIds.length, 1, 'parent dependency added');
      assertEq(edited!.updated.parentIds[0], parent.id, 'parent id recorded');
      tasks = edited!.tasks;

      // Remove a parent dependency (× in the drawer).
      const unlinked = taskLedger.applyUpdate(tasks, t.id, { parentIds: [] });
      assertEq(unlinked!.updated.parentIds.length, 0, 'parent dependency removed');
      tasks = unlinked!.tasks;

      // Delete the task (DELETE TASK).
      const afterDelete = taskLedger.removeTask(tasks, t.id);
      assert(afterDelete, 'removeTask found the task');
      assert(!afterDelete!.some((x) => x.id === t.id), 'task removed from the board');
      await taskLedger.save(cwd, afterDelete!, boardKey);
      const gone = (await taskLedger.load(cwd, boardKey)).find((x) => x.id === t.id);
      assert(gone === undefined, 'delete persisted');
    });

    await step('(P12.5) plan/peer → task bridges create a linked todo task', async () => {
      // Plan→task: title from the checkbox text, a plan link for provenance.
      const fromPlan = taskLedger.newTask({ title: 'wire the renderer', links: [{ kind: 'plan', ref: 'cluster-plan' }] });
      assertEq(fromPlan.status, 'todo', 'plan-promoted task is todo');
      assertEq(fromPlan.links[0]?.kind, 'plan', 'plan link recorded');

      // Peer→task: title from the first line, notes carry the body, a workflow
      // link tags the sender.
      const content = 'please add retry logic\n\ndetails: exponential backoff';
      const firstLine = content.split('\n').map((s) => s.trim()).find(Boolean) ?? content;
      const fromPeer = taskLedger.newTask({
        title: firstLine,
        notes: `From peer ${wfB.slice(0, 8)}:\n\n${content}`,
        links: [{ kind: 'workflow', ref: wfB }],
      });
      assertEq(fromPeer.title, 'please add retry logic', 'peer task title is the first line');
      assert(fromPeer.notes.includes('exponential backoff'), 'peer task notes carry the body');
      assertEq(fromPeer.links[0]?.kind, 'workflow', 'sender tagged via workflow link');
      assertEq(fromPeer.links[0]?.ref, wfB, 'sender workflowId recorded');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-board');
}

void main();
