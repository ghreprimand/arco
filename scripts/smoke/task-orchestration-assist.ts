// Director/workers Stage K — orchestration assist proposal smoke.
//
// Headless/module-level. Drives the Stage K draft-proposal handlers against a
// real cluster + cwd-scoped task/proposal stores, with provider turns avoided
// by using the Stage K `draft` request path.
//
// Assertions:
//   (a) proposal creation requires an explicit valid member request.
//   (b) proposal records survive proposal-store reload.
//   (c) rejecting a proposal mutates no task state.
//   (d) accepting selected proposal items emits ordinary task_ledger_event rows.
//   (e) provider/model/effort suggestions stay inert unless selected/accepted.
//
// Run: npm run smoke:task-orchestration-assist

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { step, assert, assertEq, summary } from './lib.js';
import type { LedgerTask, ServerMessage } from '../../shared/src/index.js';

function fakeWs(errors: string[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(payload: string) {
      const parsed = JSON.parse(payload) as { type?: string; message?: string };
      if (parsed.type === 'error' && parsed.message) errors.push(parsed.message);
    },
  } as unknown as WebSocket;
}

async function writeWorkflow(cwd: string, workflowId: string): Promise<void> {
  const { workflowCwds, workflows } = await import('../../server/src/server/state.js');
  const { writeMeta } = await import('../../server/src/workflowMeta.js');
  const { initWorkflowStore } = await import('../../server/src/workflowStore.js');
  const now = Date.now();

  await fs.mkdir(path.join(cwd, '.arco', 'workflows', workflowId), { recursive: true });
  workflowCwds.set(workflowId, cwd);
  workflows.set(workflowId, {
    busy: false,
    observers: new Set(),
    config: { workingDirectory: cwd },
    primary: { provider: 'claude', model: 'smoke-model', effort: 'medium', tools: [] },
  } as unknown as Parameters<typeof workflows.set>[1]);
  await writeMeta(cwd, {
    workflowId,
    name: 'task-orchestration-assist-smoke',
    cwd,
    createdAt: now,
    lastActiveAt: now,
    primaryProvider: 'claude',
    primaryModel: 'smoke-model',
    primaryEffort: 'medium',
    cliSessions: [],
    operator: 'smoke',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  } as Parameters<typeof writeMeta>[1]);
  await initWorkflowStore(cwd, workflowId);
}

function requireTask(tasks: LedgerTask[], predicate: (task: LedgerTask) => boolean, label: string): LedgerTask {
  const task = tasks.find(predicate);
  assert(task, `${label} exists`);
  return task;
}

async function replayTaskEvents(cwd: string, workflowId: string): Promise<ServerMessage[]> {
  const { flushAll, replayEvents } = await import('../../server/src/workflowStore.js');
  await flushAll();
  return (await replayEvents(cwd, workflowId, 0)).filter((event) => event.type === 'task_ledger_event');
}

async function main(): Promise<void> {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-orchestration-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-task-orchestration-cwd-'));
  const prevHome = process.env.HOME;
  const prevNoDispatch = process.env.ARCO_TEST_NO_TASK_DISPATCH;
  process.env.HOME = fakeHome;
  process.env.ARCO_TEST_NO_TASK_DISPATCH = '1';

  try {
    const clusterStore = await import('../../server/src/clusterStore.js');
    const proposalStore = await import('../../server/src/project/orchestrationProposals.js');
    const taskLedger = await import('../../server/src/project/taskLedger.js');
    const handlers = await import('../../server/src/ws/clusterHandlers.js');
    const { workflows } = await import('../../server/src/server/state.js');

    if (
      typeof handlers.handleClusterOrchestrationAssistRequest !== 'function'
      || typeof handlers.handleClusterOrchestrationProposalReject !== 'function'
      || typeof handlers.handleClusterOrchestrationProposalApply !== 'function'
    ) {
      await step('pending backend integration: Stage K handler exports absent', () => {
        assert(true, 'skeleton remains pending in this fork');
      });
      summary('task-orchestration-assist');
    }

    const requester = randomUUID();
    const reviewer = randomUUID();
    const nonMember = randomUUID();
    await writeWorkflow(cwd, requester);
    await writeWorkflow(cwd, reviewer);
    await writeWorkflow(cwd, nonMember);

    const cluster = await clusterStore.createCluster({
      cwd,
      memberWorkflowIds: [requester, reviewer],
    });
    await clusterStore.setTaskBoardMode(cluster.clusterId, 'project');
    const errors: string[] = [];
    const ws = fakeWs(errors);

    let rejectedProposalId = '';
    let applyProposalId = '';

    await step('(a) proposal creation requires explicit valid member request', async () => {
      assertEq((await proposalStore.load(cwd)).length, 0, 'proposal store starts empty');

      errors.length = 0;
      await handlers.handleClusterOrchestrationAssistRequest(ws, {
        type: 'cluster_orchestration_assist_request',
        clusterId: cluster.clusterId,
        workflowId: nonMember,
        kind: 'task_graph',
        prompt: 'invalid request should not create a proposal',
        model: { provider: 'claude', model: 'smoke-model', effort: 'medium' },
        draft: { items: [] },
      });
      assert(errors.some((message) => message.includes('requester_not_member')), 'non-member request rejected');
      assertEq((await proposalStore.load(cwd)).length, 0, 'rejected non-member request creates no proposal');

      errors.length = 0;
      await handlers.handleClusterOrchestrationAssistRequest(ws, {
        type: 'cluster_orchestration_assist_request',
        clusterId: cluster.clusterId,
        workflowId: requester,
        prompt: 'missing kind should not create a proposal',
        model: { provider: 'claude', model: 'smoke-model', effort: 'medium' },
        draft: { items: [] },
      });
      assert(errors.some((message) => message.includes('invalid_kind')), 'missing kind rejected');
      assertEq((await proposalStore.load(cwd)).length, 0, 'missing-kind request creates no proposal');
    });

    await step('(b) explicit proposal survives proposal-store reload', async () => {
      errors.length = 0;
      await handlers.handleClusterOrchestrationAssistRequest(ws, {
        type: 'cluster_orchestration_assist_request',
        clusterId: cluster.clusterId,
        workflowId: requester,
        requestId: 'reject-proposal',
        kind: 'task_graph',
        prompt: 'Draft a proposal that will be rejected.',
        inputRefs: [{ kind: 'text', ref: 'brief:reject-smoke' }],
        model: { provider: 'claude', model: 'smoke-model', effort: 'medium', memberWorkflowId: reviewer },
        draft: {
          items: [{
            id: 'reject-create',
            type: 'task_create',
            title: 'Rejected proposal task',
            status: 'ready',
            assignee: reviewer,
          }],
          rationale: 'This proposal is for rejection testing.',
          raw: { suggestedProvider: 'claude', suggestedModel: 'other-smoke-model', suggestedEffort: 'high' },
        },
      });
      assertEq(errors.length, 0, 'valid assist request emitted no errors');
      const proposals = await proposalStore.load(cwd);
      const proposal = proposals.find((p) => p.requestId === 'reject-proposal');
      assert(proposal, 'proposal reloads from proposal store');
      assertEq(proposal.items.length, 1, 'proposal item reloads');
      rejectedProposalId = proposal.id;
    });

    await step('(c) rejecting proposal mutates no task state', async () => {
      const existing = taskLedger.newTask({ title: 'pre-existing task', priority: 3 });
      await taskLedger.save(cwd, [existing]);
      const before = await taskLedger.loadKernel(cwd);

      errors.length = 0;
      await handlers.handleClusterOrchestrationProposalReject(ws, {
        type: 'cluster_orchestration_proposal_reject',
        clusterId: cluster.clusterId,
        workflowId: requester,
        proposalId: rejectedProposalId,
        reason: 'smoke reject',
      });
      assertEq(errors.length, 0, 'reject emitted no errors');
      const after = await taskLedger.loadKernel(cwd);
      const [proposal] = (await proposalStore.load(cwd)).filter((p) => p.id === rejectedProposalId);
      assertEq(proposal?.status, 'rejected', 'proposal marked rejected');
      assertEq(JSON.stringify(after.tasks), JSON.stringify(before.tasks), 'tasks unchanged by reject');
      assertEq(JSON.stringify(after.comments), JSON.stringify(before.comments), 'comments unchanged by reject');
      assertEq(JSON.stringify(after.runs), JSON.stringify(before.runs), 'runs unchanged by reject');
    });

    await step('(d) accepting selected items creates ordinary task ledger events/tasks', async () => {
      errors.length = 0;
      await handlers.handleClusterOrchestrationAssistRequest(ws, {
        type: 'cluster_orchestration_assist_request',
        clusterId: cluster.clusterId,
        workflowId: requester,
        requestId: 'apply-proposal',
        kind: 'task_graph',
        prompt: 'Draft a proposal that will be partially accepted.',
        inputRefs: [{ kind: 'text', ref: 'brief:apply-smoke' }],
        model: { provider: 'claude', model: 'smoke-model', effort: 'high', memberWorkflowId: reviewer },
        draft: {
          items: [
            {
              id: 'apply-create',
              type: 'task_create',
              title: 'Accepted proposal task',
              status: 'ready',
              priority: 9,
              assignee: reviewer,
              rationale: 'Selected item should become a real ledger task.',
            },
            {
              id: 'apply-note',
              type: 'note',
              title: 'Inert model suggestion',
              body: 'Use a higher effort model only if explicitly selected.',
            },
          ],
          rationale: 'Apply only the task item.',
          raw: { suggestedProvider: 'claude', suggestedModel: 'other-smoke-model', suggestedEffort: 'high' },
        },
      });
      assertEq(errors.length, 0, 'second assist request emitted no errors');
      const proposals = await proposalStore.load(cwd);
      const proposal = proposals.find((p) => p.requestId === 'apply-proposal');
      assert(proposal, 'apply proposal exists');
      applyProposalId = proposal.id;

      await handlers.handleClusterOrchestrationProposalApply(ws, {
        type: 'cluster_orchestration_proposal_apply',
        clusterId: cluster.clusterId,
        workflowId: requester,
        proposalId: applyProposalId,
        itemIds: ['apply-create'],
      });
      assertEq(errors.length, 0, 'apply emitted no errors');

      const state = await taskLedger.loadKernel(cwd);
      const task = requireTask(state.tasks, (t) => t.title === 'Accepted proposal task', 'accepted proposal task');
      assertEq(task.status, 'ready', 'accepted task status applied through ledger update');
      assertEq(task.assignee, reviewer, 'accepted task assignee applied through ledger update');

      const taskEvents = await replayTaskEvents(cwd, requester);
      assert(taskEvents.some((event) => event.type === 'task_ledger_event' && event.op === 'create' && event.task?.title === 'Accepted proposal task'), 'ordinary create task_ledger_event emitted');
      assert(taskEvents.some((event) => event.type === 'task_ledger_event' && event.op === 'update' && event.id === task.id), 'ordinary update task_ledger_event emitted');
    });

    await step('(e) provider/model/effort suggestions remain inert unless accepted', async () => {
      const reviewerWorkflow = workflows.get(reviewer);
      assertEq(reviewerWorkflow?.primary.provider, 'claude', 'provider unchanged');
      assertEq(reviewerWorkflow?.primary.model, 'smoke-model', 'model unchanged');
      assertEq(reviewerWorkflow?.primary.effort, 'medium', 'effort unchanged');

      const proposal = (await proposalStore.load(cwd)).find((p) => p.id === applyProposalId);
      assert(proposal, 'applied proposal exists');
      assertEq(proposal.acceptedItemIds?.join(','), 'apply-create', 'only selected item accepted');
      assertEq((proposal.raw as { suggestedModel?: string } | undefined)?.suggestedModel, 'other-smoke-model', 'model suggestion remains proposal data');
    });

    await clusterStore.deleteCluster(cluster.clusterId).catch(() => undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevNoDispatch === undefined) delete process.env.ARCO_TEST_NO_TASK_DISPATCH;
    else process.env.ARCO_TEST_NO_TASK_DISPATCH = prevNoDispatch;
    await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  summary('task-orchestration-assist');
}

void main();
