// Workflow-reporting layer smoke (docs/REMOTE_MANAGEMENT.md §2 workflow layer).
//
// Wires the REAL service connector (server/src/management/hubLink.ts) to a REAL
// hub (scripts/management/hub.ts) in-process — with the Arco-specific seams
// (snapshotWorkflows + applyAction) faked, since the turn engine isn't exercised
// here. Asserts:
//
//   1. The service registers (role 'service') + pushes its workflow snapshot;
//      the hub registry + /api/instances surface the workflows.
//   2. routeWorkflowAction('reply') reaches the service, applyAction runs with
//      re-validation, and the result returns by actionId.
//   3. stop on a running workflow / reply on idle round-trip; the HTTP
//      POST /api/instances/:id/workflow-action path works.
//   4. An action for an unknown workflow is rejected by the service's
//      re-validation (no-such-workflow), not by the hub.
//
// Run: npm run smoke:workflow-reporting  (needs `npm run build -w shared`)

import { step, assert, assertEq, summary } from './lib.js';
import { generateHubKeypair } from '../agent/signing.js';
import { createHub } from '../management/hub.js';
import { createHubLink } from '../../server/src/management/hubLink.js';
import type {
  ManagedArcoInstance,
  TranscriptTurn,
  WorkflowActionRequest,
  WorkflowActionResult,
  WorkflowSummary,
} from '../../shared/src/protocol/remoteManagement.js';

const INSTANCE_ID = 'eeeeeeee-ffff-0000-1111-222222222222';
const WF_RUNNING = 'wf-running-0001';
const WF_IDLE = 'wf-idle-0002';

async function until(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function descriptor(): ManagedArcoInstance {
  return {
    instanceId: INSTANCE_ID,
    name: 'wf-smoke-box',
    platform: 'linux',
    hostname: 'smoke',
    version: '0.0.0',
    gitRevision: 'cafe123',
    serviceMode: 'dev',
    capabilities: {
      workflows: true,
      requests: true,
      approvals: true,
      serviceRestart: false,
      diagnostics: true,
      resourceStats: true,
    },
    lastHeartbeatAt: 0,
  };
}

async function main() {
  const { privateKey } = generateHubKeypair();

  // Fake workflow state the connector reports + acts on.
  const wfState = new Map<string, { busy: boolean; title: string }>([
    [WF_RUNNING, { busy: true, title: 'build the parser' }],
    [WF_IDLE, { busy: false, title: 'write the docs' }],
  ]);
  const applied: WorkflowActionRequest[] = [];

  function snapshotWorkflows(): WorkflowSummary[] {
    return [...wfState.entries()].map(([workflowId, w]) => ({
      workflowId,
      title: w.title,
      cwd: '/home/operator/Projects/Demo',
      provider: 'claude',
      model: 'claude-opus-4-8',
      state: w.busy ? 'running' : 'idle',
      busy: w.busy,
      lastActivityAt: 1_900_000_000_000,
      lastMessageRole: 'assistant' as const,
      lastMessageText: `(${w.title}) full review text … Want me to implement any of these?`,
    }));
  }

  // Mirrors initHubLink.applyAction's re-validation, against the fake state.
  async function applyAction(action: WorkflowActionRequest, actionId: string): Promise<WorkflowActionResult> {
    const base = { actionId, workflowId: action.workflowId };
    const wf = wfState.get(action.workflowId);
    if (!wf) return { ...base, ok: false, error: 'no-such-workflow' };
    if (action.type === 'stop') {
      if (!wf.busy) return { ...base, ok: false, error: 'not-running' };
      wf.busy = false;
      applied.push(action);
      return { ...base, ok: true, applied: 'stop' };
    }
    if (action.type === 'handoff') {
      if (wf.busy) return { ...base, ok: false, error: 'busy' };
      applied.push(action);
      return { ...base, ok: true, applied: 'handoff' };
    }
    if (action.type === 'reply' && !(action.body ?? '').trim()) {
      return { ...base, ok: false, error: 'failed' };
    }
    applied.push(action);
    return { ...base, ok: true, applied: action.type };
  }

  function getTranscript(wfid: string): { title?: string; turns: TranscriptTurn[] } {
    const w = wfState.get(wfid);
    return {
      ...(w ? { title: w.title } : {}),
      turns: [
        { role: 'user', text: 'What do you think of this website?' },
        { role: 'assistant', text: 'Here is my full review … Want me to implement any of these?' },
      ],
    };
  }

  const hub = createHub({ privateKeyPem: privateKey, host: '127.0.0.1', port: 0, heartbeatIntervalMs: 5000, commandTimeoutMs: 3000 });
  const { host, port } = await hub.listen();
  const base = `http://${host}:${port}`;

  const link = createHubLink({
    hubUrl: `ws://${host}:${port}/instance`,
    instance: descriptor(),
    snapshotWorkflows,
    applyAction,
    getTranscript,
    heartbeatMs: 1000,
    workflowsPushMs: 500,
  });

  await step('service registers + pushes workflow snapshot to the hub', async () => {
    link.start();
    await until(() => (hub.registry.get(INSTANCE_ID)?.workflows?.length ?? 0) === 2, 3000);
    const entry = hub.registry.get(INSTANCE_ID);
    assert(entry, 'instance registered');
    assertEq(entry!.workflows!.length, 2, 'two workflows reported');
    const running = entry!.workflows!.find((w) => w.workflowId === WF_RUNNING);
    assertEq(running?.state, 'running', 'running workflow state');
  });

  await step('GET /api/instances surfaces the workflows', async () => {
    const data = await fetch(`${base}/api/instances`).then((r) => r.json());
    const inst = (data as { instances: { instance: { instanceId: string }; workflows?: WorkflowSummary[] }[] })
      .instances.find((e) => e.instance.instanceId === INSTANCE_ID);
    assert(inst && inst.workflows && inst.workflows.length === 2, 'workflows in HTTP snapshot');
    const wf = inst!.workflows!.find((w) => w.workflowId === WF_IDLE)!;
    assertEq(wf.lastMessageRole, 'assistant', 'decision-context role survives the round-trip');
    assert((wf.lastMessageText || '').includes('implement'), 'full last-message text survives the round-trip');
  });

  await step('routeWorkflowAction(reply) reaches the service + returns by actionId', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'reply', workflowId: WF_IDLE, body: 'use a recursive-descent parser' });
    assert(r.ok, `reply ok: ${JSON.stringify(r)}`);
    assertEq(r.applied, 'reply', 'applied reply');
    assert(applied.some((a) => a.type === 'reply' && a.workflowId === WF_IDLE), 'service applied the reply');
  });

  await step('stop on a running workflow via HTTP', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflow-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'stop', workflowId: WF_RUNNING } }),
    });
    assertEq(res.status, 200, 'HTTP 200');
    const b = (await res.json()) as WorkflowActionResult;
    assert(b.ok && b.applied === 'stop', 'stop applied');
    assertEq(wfState.get(WF_RUNNING)!.busy, false, 'workflow marked not busy by re-validation');
  });

  await step('re-validation rejects an unknown workflow (service, not hub)', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'continue', workflowId: 'ghost-wf' });
    assert(!r.ok, 'should fail');
    assertEq(r.error, 'no-such-workflow', 'service re-validation rejected it');
  });

  await step('stop on an already-idle workflow → not-running', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'stop', workflowId: WF_IDLE });
    assert(!r.ok, 'should fail');
    assertEq(r.error, 'not-running', 'reason');
  });

  await step('handoff (same-worker) on an idle workflow', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'handoff', workflowId: WF_IDLE });
    assert(r.ok, `handoff ok: ${JSON.stringify(r)}`);
    assertEq(r.applied, 'handoff', 'applied handoff');
    assert(applied.some((a) => a.type === 'handoff'), 'service applied the handoff');
  });

  await step('handoff is rejected mid-turn (busy)', async () => {
    wfState.get(WF_IDLE)!.busy = true;
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'handoff', workflowId: WF_IDLE });
    wfState.get(WF_IDLE)!.busy = false;
    assert(!r.ok, 'should fail while busy');
    assertEq(r.error, 'busy', 'reason');
  });

  await step('transcript request returns the full conversation', async () => {
    const t = await hub.requestTranscript(INSTANCE_ID, WF_IDLE);
    assert(t && t.turns.length === 2, `transcript turns: ${JSON.stringify(t)}`);
    assertEq(t!.turns[0].role, 'user', 'first turn is the operator');
    assert(t!.turns[1].text.includes('implement'), 'assistant turn present');
  });

  await step('transcript HTTP route renders a read-only page', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflows/${WF_IDLE}/transcript`);
    assertEq(res.status, 200, 'HTTP 200');
    assert((res.headers.get('content-type') || '').includes('text/html'), 'html');
    const html = await res.text();
    assert(html.includes('implement') && html.includes('read-only'), 'renders the transcript');
  });

  link.stop();
  await hub.close();
  summary('workflow-reporting layer');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
