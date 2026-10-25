// Remote Control v2 — R1 smoke (docs/REMOTE_CLUSTER_CONTROL_PLAN.md §5 R1).
//
// Same shape as workflow-reporting.ts: REAL hub (scripts/management/hub.ts) +
// REAL connector (server/src/management/hubLink.ts) in-process, Arco seams
// faked (the turn engine isn't exercised; initHubLink.applyAction's semantics
// are mirrored against fake state). Asserts the R1 additions:
//
//   1. The enriched WorkflowSummary (context zone, queue, pending question,
//      pending gates + resolvable bit, canCompact/canFold, effort) survives
//      the service → hub → HTTP round-trip losslessly.
//   2. The five new verbs route and correlate: compact / fold /
//      answer_question / gate_resolve / cancel_queued.
//   3. The R1 error surface: busy (compact mid-turn), unsupported (fold on a
//      non-claude provider), gates-disabled (gate_resolve without the §9.2
//      arming), stale-target (answered question / unknown queued id).
//   4. The console assets ship the R1 UI (NEEDS-YOU strip, context meter,
//      queue rows) — same asset-level check management-hub.ts uses.
//
// Run: npm run smoke:remote-r1  (needs `npm run build -w shared`)

import { step, assert, assertEq, summary } from './lib.js';
import { generateHubKeypair } from '../agent/signing.js';
import { createHub } from '../management/hub.js';
import { createHubLink } from '../../server/src/management/hubLink.js';
import { consoleCss, consoleJs } from '../management/console.js';
import type {
  ClusterActionRequest,
  ClusterActionResult,
  ClusterReadKind,
  ClusterReadResponseMessage,
  ClusterSummary,
  InstanceActionRequest,
  InstanceActionResult,
  InstanceRollup,
  ManagedArcoInstance,
  WorkflowActionRequest,
  WorkflowActionResult,
  WorkflowSummary,
} from '../../shared/src/protocol/remoteManagement.js';

const INSTANCE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const WF_CLAUDE = 'wf-claude-0001'; // native-like: question + gate parked, queue
const WF_OLLAMA = 'wf-ollama-0002'; // canCompact but no fold, no gates arming
const QUESTION_ID = 'q-smoke-1';
const GATE_ID = 'gate-smoke-1';
const QUEUED_ID = 'msg-smoke-1';

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
    name: 'r1-smoke-box',
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

interface FakeWf {
  busy: boolean;
  title: string;
  provider: string;
  remoteGatesEnabled: boolean;
  questionPending: boolean;
  gatePending: boolean;
  queuedIds: string[];
}

async function main() {
  const { privateKey } = generateHubKeypair();

  const wfState = new Map<string, FakeWf>([
    [WF_CLAUDE, {
      busy: false, title: 'refactor the parser', provider: 'claude',
      remoteGatesEnabled: false, questionPending: true, gatePending: true,
      queuedIds: [QUEUED_ID],
    }],
    [WF_OLLAMA, {
      busy: false, title: 'local model docs', provider: 'ollama',
      remoteGatesEnabled: false, questionPending: false, gatePending: false,
      queuedIds: [],
    }],
  ]);
  const applied: WorkflowActionRequest[] = [];

  function snapshotWorkflows(): WorkflowSummary[] {
    return [...wfState.entries()].map(([workflowId, w]) => {
      const isClaude = w.provider === 'claude';
      return {
        workflowId,
        title: w.title,
        cwd: '/home/operator/Projects/Demo',
        provider: w.provider,
        model: isClaude ? 'claude-opus-4-8' : 'qwen3:32b',
        state: w.busy ? 'running' as const : 'idle' as const,
        busy: w.busy,
        effort: 'high',
        contextPct: 0.72,
        contextZone: 'amber' as const,
        ...(w.queuedIds.length
          ? {
              queueDepth: w.queuedIds.length,
              queued: w.queuedIds.map((id) => ({ id, preview: 'queued follow-up …' })),
            }
          : {}),
        ...(w.questionPending
          ? { pendingQuestion: { questionId: QUESTION_ID, text: 'Ship v1 or iterate?\nOptions: ship | iterate' } }
          : {}),
        ...(w.gatePending
          ? {
              pendingGates: [{
                gateId: GATE_ID,
                toolName: 'Bash',
                category: 'git-destructive',
                reason: 'force-push to main',
                argsPreview: '{"command":"git push --force origin main"}',
                resolvable: w.remoteGatesEnabled,
              }],
            }
          : {}),
        canCompact: true,
        ...(isClaude ? { canFold: true } : {}),
      };
    });
  }

  // Mirrors initHubLink.applyAction's R1 semantics against the fake state.
  async function applyAction(action: WorkflowActionRequest, actionId: string): Promise<WorkflowActionResult> {
    const base = { actionId, workflowId: action.workflowId };
    const wf = wfState.get(action.workflowId);
    if (!wf) return { ...base, ok: false, error: 'no-such-workflow' };
    switch (action.type) {
      case 'compact':
      case 'fold': {
        if (wf.busy) return { ...base, ok: false, error: 'busy' };
        const okProvider = action.type === 'fold' ? wf.provider === 'claude' : true;
        if (!okProvider) return { ...base, ok: false, error: 'unsupported' };
        applied.push(action);
        return { ...base, ok: true, applied: action.type };
      }
      case 'answer_question': {
        if (!action.questionId || !(action.body ?? '').trim()) return { ...base, ok: false, error: 'failed' };
        if (!wf.questionPending || action.questionId !== QUESTION_ID) return { ...base, ok: false, error: 'stale-target' };
        wf.questionPending = false;
        applied.push(action);
        return { ...base, ok: true, applied: 'answer_question' };
      }
      case 'gate_resolve': {
        if (!wf.remoteGatesEnabled) return { ...base, ok: false, error: 'gates-disabled' };
        if (!wf.gatePending || action.gateId !== GATE_ID) return { ...base, ok: false, error: 'stale-target' };
        wf.gatePending = false;
        applied.push(action);
        return { ...base, ok: true, applied: 'gate_resolve' };
      }
      case 'cancel_queued': {
        const i = wf.queuedIds.indexOf(action.queuedId ?? '');
        if (i < 0) return { ...base, ok: false, error: 'stale-target' };
        wf.queuedIds.splice(i, 1);
        applied.push(action);
        return { ...base, ok: true, applied: 'cancel_queued' };
      }
      default: {
        applied.push(action);
        return { ...base, ok: true, applied: action.type };
      }
    }
  }

  const hub = createHub({ privateKeyPem: privateKey, host: '127.0.0.1', port: 0, heartbeatIntervalMs: 5000, commandTimeoutMs: 3000 });
  const { host, port } = await hub.listen();
  const base = `http://${host}:${port}`;

  // R2 — transcript seam with sinceTurn slicing + totalTurns/busy.
  const fullConvo = [
    { role: 'user' as const, text: 'What is left?' },
    { role: 'assistant' as const, text: 'Two items remain … shall I proceed?' },
    { role: 'user' as const, text: 'proceed' },
  ];
  function getTranscript(wfid: string, sinceTurn?: number) {
    const w = wfState.get(wfid);
    const turns = typeof sinceTurn === 'number' && sinceTurn > 0 ? fullConvo.slice(sinceTurn) : fullConvo;
    return {
      ...(w ? { title: w.title } : {}),
      turns,
      totalTurns: fullConvo.length,
      busy: w?.busy === true,
    };
  }

  // A2 — auth-problem rollup + remote re-auth seam (mirrors initHubLink's
  // applyInstanceAction against fake bootstrap state).
  let authBroken = true;
  function rollup(): InstanceRollup {
    return {
      health: authBroken ? 'degraded' : 'ok',
      activeWorkflows: 0,
      waitingRequests: 2,
      ...(authBroken
        ? { authAlerts: [{ provider: 'claude', state: 'expired' as const, since: 1_900_000_000_000, detail: 'refresh failed (400)' }] }
        : {}),
    };
  }
  async function applyInstanceAction(action: InstanceActionRequest, actionId: string): Promise<InstanceActionResult> {
    if (action.type === 'start_reauth') {
      return { actionId, ok: true, authorizationUrl: 'https://claude.ai/oauth/authorize?code=true&test=1', manualFallback: true };
    }
    if (action.type === 'complete_reauth') {
      if (!action.url.includes('code=')) return { actionId, ok: false, error: 'no `code` in URL' };
      authBroken = false;
      return { actionId, ok: true };
    }
    return { actionId, ok: false, error: 'unsupported' };
  }

  // R3 — cluster snapshot + read seams (mirrors initHubLink's clusterRead
  // against fake cluster state).
  const CLUSTER_ID = 'cl-smoke-0001';
  let clusterRemote = true;
  async function snapshotClusters(): Promise<ClusterSummary[]> {
    if (!clusterRemote) return [];
    return [{
      clusterId: CLUSTER_ID,
      name: 'smoke cluster',
      cwd: '/home/operator/Projects/Demo',
      memberIds: [WF_CLAUDE, WF_OLLAMA],
      efficiencyLevel: 'balanced',
      autoTurnOnMailbox: true,
      idleNudgerEnabled: false,
      taskBoardMode: 'project',
      planHead: '# Plan\n1. build\n2. verify',
      planId: 'plan-1',
      mailboxDepth: { [WF_CLAUDE]: 2, [WF_OLLAMA]: 0 },
      roles: { [WF_CLAUDE]: 'director' },
    }];
  }
  async function clusterRead(
    clusterId: string,
    kind: ClusterReadKind,
  ): Promise<Pick<ClusterReadResponseMessage, 'ok' | 'error' | 'mailbox' | 'board' | 'plan'>> {
    if (!clusterRemote || clusterId !== CLUSTER_ID) return { ok: false, error: 'remote-disabled' };
    if (kind === 'mailbox') {
      return {
        ok: true,
        mailbox: {
          [WF_CLAUDE]: [
            { msgId: 'm1', from: WF_OLLAMA, fromName: 'local docs', preview: 'review my draft please', createdAt: '2026-07-17T00:00:00Z' },
            { msgId: 'm2', from: WF_OLLAMA, fromName: 'local docs', preview: 'second note', createdAt: '2026-07-17T00:01:00Z' },
          ],
          [WF_OLLAMA]: [],
        },
      };
    }
    if (kind === 'board') {
      return { ok: true, board: { tasks: [{ id: 't1', title: 'ship R3', status: 'in_progress', assignee: 'claude' }] } };
    }
    if (kind === 'activity') {
      return {
        ok: true,
        activity: [
          { ts: 1000, memberId: WF_CLAUDE, kind: 'turn-started', text: 'turn started' },
          { ts: 2000, memberId: WF_OLLAMA, kind: 'peer-sent', text: '→ wf-claud: draft ready' },
          { ts: 3000, memberId: WF_CLAUDE, kind: 'turn-complete', text: 'turn finished · 4 tool call(s) · 12s' },
        ],
      };
    }
    return { ok: true, plan: { body: '# Plan\n1. build\n2. verify\n3. ship' } };
  }

  // R4 — cluster-action seam (mirrors initHubLink.applyClusterAction).
  const clusterApplied: ClusterActionRequest[] = [];
  async function applyClusterAction(
    clusterId: string,
    action: ClusterActionRequest,
    actionId: string,
  ): Promise<ClusterActionResult> {
    const cbase = { actionId, clusterId };
    if (!clusterRemote || clusterId !== CLUSTER_ID) return { ...cbase, ok: false, error: 'remote-disabled' };
    const members = [WF_CLAUDE, WF_OLLAMA];
    switch (action.type) {
      case 'broadcast': {
        if (!(action.body ?? '').trim()) return { ...cbase, ok: false, error: 'empty-body' };
        if ((action.recipientIds ?? []).some((r) => !members.includes(r))) {
          return { ...cbase, ok: false, error: 'unknown-recipient' };
        }
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'broadcast', detail: `→ ${(action.recipientIds ?? members).length} member(s)` };
      }
      case 'nudge_member': {
        if (!members.includes(action.memberId)) return { ...cbase, ok: false, error: 'unknown-member' };
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'nudge_member', detail: '✉ 2 pending' };
      }
      case 'peer_send': {
        if (!members.includes(action.fromId) || !members.includes(action.toId)) {
          return { ...cbase, ok: false, error: 'unknown-member' };
        }
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'peer_send' };
      }
      case 'stop_all':
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'stop_all', detail: 'stopped 1 member(s)' };
      case 'set_efficiency':
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'set_efficiency', detail: action.level };
      case 'toggle_auto_turn':
      case 'toggle_idle_nudger':
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: action.type };
      case 'board_task_update':
        clusterApplied.push(action);
        return { ...cbase, ok: true, applied: 'board_task_update', detail: `${action.taskId} → ${action.status}` };
      default:
        return { ...cbase, ok: false, error: 'unsupported' };
    }
  }

  const link = createHubLink({
    hubUrl: `ws://${host}:${port}/instance`,
    instance: descriptor(),
    snapshotWorkflows,
    applyAction,
    applyInstanceAction,
    rollup,
    snapshotClusters,
    clusterRead,
    applyClusterAction,
    getTranscript,
    heartbeatMs: 300,
    workflowsPushMs: 200,
  });

  await step('R1 summary fields survive the service → hub → HTTP round-trip', async () => {
    link.start();
    await until(() => (hub.registry.get(INSTANCE_ID)?.workflows?.length ?? 0) === 2, 3000);
    const data = await fetch(`${base}/api/instances`).then((r) => r.json());
    const inst = (data as { instances: { instance: { instanceId: string }; workflows?: WorkflowSummary[] }[] })
      .instances.find((e) => e.instance.instanceId === INSTANCE_ID);
    const wf = inst?.workflows?.find((w) => w.workflowId === WF_CLAUDE);
    assert(wf, 'claude workflow reported');
    assertEq(wf!.contextZone, 'amber', 'context zone');
    assertEq(wf!.queueDepth, 1, 'queue depth');
    assertEq(wf!.queued?.[0]?.id, QUEUED_ID, 'queued id');
    assertEq(wf!.pendingQuestion?.questionId, QUESTION_ID, 'pending question id');
    assert((wf!.pendingQuestion?.text ?? '').includes('Options: ship | iterate'), 'question options text');
    assertEq(wf!.pendingGates?.[0]?.gateId, GATE_ID, 'pending gate id');
    assertEq(wf!.pendingGates?.[0]?.resolvable, false, 'gate NOT resolvable before arming');
    assert(wf!.canCompact === true && wf!.canFold === true, 'claude verbs available');
    const oll = inst?.workflows?.find((w) => w.workflowId === WF_OLLAMA);
    assert(oll!.canCompact === true && !oll!.canFold, 'ollama: compact yes, fold no');
  });

  await step('compact routes + correlates; busy is rejected', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'compact', workflowId: WF_CLAUDE });
    assert(r.ok && r.applied === 'compact', `compact ok: ${JSON.stringify(r)}`);
    wfState.get(WF_CLAUDE)!.busy = true;
    const busy = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'compact', workflowId: WF_CLAUDE });
    wfState.get(WF_CLAUDE)!.busy = false;
    assert(!busy.ok, 'busy compact fails');
    assertEq(busy.error, 'busy', 'busy reason');
  });

  await step('fold on a non-claude provider → unsupported', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, { type: 'fold', workflowId: WF_OLLAMA });
    assert(!r.ok, 'should fail');
    assertEq(r.error, 'unsupported', 'reason');
  });

  await step('gate_resolve without the §9.2 arming → gates-disabled', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, {
      type: 'gate_resolve', workflowId: WF_CLAUDE, gateId: GATE_ID, decision: 'approve',
    });
    assert(!r.ok, 'should fail');
    assertEq(r.error, 'gates-disabled', 'second arming enforced');
  });

  await step('gate_resolve with arming approves via HTTP', async () => {
    wfState.get(WF_CLAUDE)!.remoteGatesEnabled = true;
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflow-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'gate_resolve', workflowId: WF_CLAUDE, gateId: GATE_ID, decision: 'approve' } }),
    });
    assertEq(res.status, 200, 'HTTP 200');
    const b = (await res.json()) as WorkflowActionResult;
    assert(b.ok && b.applied === 'gate_resolve', 'gate approved');
    assert(applied.some((a) => a.type === 'gate_resolve' && a.decision === 'approve'), 'decision reached the service');
  });

  await step('answer_question round-trips; a second answer is stale', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, {
      type: 'answer_question', workflowId: WF_CLAUDE, questionId: QUESTION_ID, body: 'ship',
    });
    assert(r.ok && r.applied === 'answer_question', `answer ok: ${JSON.stringify(r)}`);
    const again = await hub.routeWorkflowAction(INSTANCE_ID, {
      type: 'answer_question', workflowId: WF_CLAUDE, questionId: QUESTION_ID, body: 'ship',
    });
    assert(!again.ok, 'second answer fails');
    assertEq(again.error, 'stale-target', 'stale question');
  });

  await step('cancel_queued removes the item; unknown id is stale', async () => {
    const r = await hub.routeWorkflowAction(INSTANCE_ID, {
      type: 'cancel_queued', workflowId: WF_CLAUDE, queuedId: QUEUED_ID,
    });
    assert(r.ok && r.applied === 'cancel_queued', 'cancel ok');
    assertEq(wfState.get(WF_CLAUDE)!.queuedIds.length, 0, 'queue drained');
    const ghost = await hub.routeWorkflowAction(INSTANCE_ID, {
      type: 'cancel_queued', workflowId: WF_CLAUDE, queuedId: 'ghost',
    });
    assert(!ghost.ok, 'ghost cancel fails');
    assertEq(ghost.error, 'stale-target', 'stale queued id');
  });

  await step('R2: /convo returns JSON turns with totalTurns + busy', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflows/${WF_CLAUDE}/convo`);
    assertEq(res.status, 200, 'HTTP 200');
    const b = await res.json() as { turns: unknown[]; totalTurns: number; busy: boolean };
    assertEq(b.turns.length, 3, 'full conversation');
    assertEq(b.totalTurns, 3, 'totalTurns anchor');
    assertEq(b.busy, false, 'busy flag');
  });

  await step('R2: /convo?since=N slices incrementally', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflows/${WF_CLAUDE}/convo?since=2`);
    const b = await res.json() as { turns: { text: string }[]; totalTurns: number };
    assertEq(b.turns.length, 1, 'only the new turn');
    assertEq(b.turns[0].text, 'proceed', 'sliced from the right anchor');
    assertEq(b.totalTurns, 3, 'total unchanged');
  });

  await step('R2: /chat serves the interactive conversation screen', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/workflows/${WF_CLAUDE}/chat`);
    assertEq(res.status, 200, 'HTTP 200');
    const html = await res.text();
    assert(html.includes('c-composer') && html.includes('/convo?since='), 'composer + poll loop present');
    assert(html.includes('refactor the parser'), 'title rendered');
  });

  await step('A2: authAlerts ride the heartbeat rollup to /api/instances', async () => {
    await until(() => {
      const e = hub.registry.get(INSTANCE_ID);
      return !!e?.rollup?.authAlerts?.length;
    }, 3000);
    const data = await fetch(`${base}/api/instances`).then((r) => r.json());
    const inst = (data as { instances: { instance: { instanceId: string }; rollup?: InstanceRollup }[] })
      .instances.find((e) => e.instance.instanceId === INSTANCE_ID);
    const alerts = inst?.rollup?.authAlerts;
    assert(alerts && alerts.length === 1, `auth alert present: ${JSON.stringify(inst?.rollup)}`);
    assertEq(alerts![0].provider, 'claude', 'provider');
    assert((alerts![0].detail ?? '').includes('refresh failed'), 'detail carried');
  });

  await step('A2: start_reauth returns the authorize URL over HTTP', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/instance-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'start_reauth', provider: 'claude' } }),
    });
    assertEq(res.status, 200, 'HTTP 200');
    const b = (await res.json()) as InstanceActionResult;
    assert(b.ok && (b.authorizationUrl ?? '').startsWith('https://claude.ai/oauth/authorize'), 'authorize URL');
    assertEq(b.manualFallback, true, 'manual fallback flagged');
  });

  await step('A2: complete_reauth paste-back clears the alert; bad URL errors', async () => {
    const bad = await fetch(`${base}/api/instances/${INSTANCE_ID}/instance-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'complete_reauth', provider: 'claude', url: 'http://localhost:53692/callback' } }),
    });
    assertEq(bad.status, 502, 'bad paste → 502');
    const good = await fetch(`${base}/api/instances/${INSTANCE_ID}/instance-action`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'complete_reauth', provider: 'claude', url: 'http://localhost:53692/callback?code=abc&state=xyz' } }),
    });
    const g = (await good.json()) as InstanceActionResult;
    assert(g.ok, 'completion accepted');
    await until(() => !(hub.registry.get(INSTANCE_ID)?.rollup?.authAlerts?.length), 3000);
    const e = hub.registry.get(INSTANCE_ID);
    assert(!e?.rollup?.authAlerts?.length, 'alert cleared on the next heartbeat');
  });

  await step('R3: instance_clusters lands in the registry + HTTP snapshot', async () => {
    await until(() => (hub.registry.get(INSTANCE_ID)?.clusters?.length ?? 0) === 1, 3000);
    const data = await fetch(`${base}/api/instances`).then((r) => r.json());
    const inst = (data as { instances: { instance: { instanceId: string }; clusters?: ClusterSummary[] }[] })
      .instances.find((e) => e.instance.instanceId === INSTANCE_ID);
    const c = inst?.clusters?.[0];
    assert(c, 'cluster reported');
    assertEq(c!.clusterId, CLUSTER_ID, 'cluster id');
    assertEq(c!.efficiencyLevel, 'balanced', 'efficiency');
    assertEq(c!.mailboxDepth[WF_CLAUDE], 2, 'mailbox depth');
    assert((c!.planHead ?? '').startsWith('# Plan'), 'plan head');
    assertEq(c!.roles?.[WF_CLAUDE], 'director', 'role map');
  });

  await step('R3: cluster reads round-trip (mailbox / board / plan)', async () => {
    const mb = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=mailbox`).then((r) => r.json()) as ClusterReadResponseMessage;
    assert(mb.ok && mb.mailbox, 'mailbox ok');
    assertEq(mb.mailbox![WF_CLAUDE].length, 2, 'pending messages listed');
    assertEq(mb.mailbox![WF_CLAUDE][0].fromName, 'local docs', 'sender name');
    const bd = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=board`).then((r) => r.json()) as ClusterReadResponseMessage;
    assert(bd.ok && bd.board!.tasks.length === 1 && bd.board!.tasks[0].status === 'in_progress', 'board tasks');
    const pl = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=plan`).then((r) => r.json()) as ClusterReadResponseMessage;
    assert(pl.ok && (pl.plan?.body ?? '').includes('3. ship'), 'plan body');
    const bad = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=nope`);
    assertEq(bad.status, 400, 'unknown kind rejected');
  });

  await step('R3: a remote-disabled cluster read is rejected by the service', async () => {
    clusterRemote = false;
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=mailbox`);
    clusterRemote = true;
    assertEq(res.status, 502, 'read rejected');
    const b = await res.json() as ClusterReadResponseMessage;
    assertEq(b.error, 'remote-disabled', 'reason');
  });

  await step('R5: merged activity timeline round-trips ordered', async () => {
    const res = await fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/read?kind=activity`);
    assertEq(res.status, 200, 'HTTP 200');
    const b = await res.json() as ClusterReadResponseMessage;
    assert(b.ok && b.activity!.length === 3, 'rows returned');
    assertEq(b.activity![1].memberId, WF_OLLAMA, 'cross-member interleave preserved');
    assert(b.activity![2].text.includes('4 tool call(s)'), 'tool count folded into turn row');
  });

  await step('R4: cluster actions route via HTTP (broadcast subset / nudge / peer / board)', async () => {
    const post = (action: ClusterActionRequest) =>
      fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    const bc = await post({ type: 'broadcast', body: 'status check please', recipientIds: [WF_CLAUDE] }).then((r) => r.json()) as ClusterActionResult;
    assert(bc.ok && bc.applied === 'broadcast' && (bc.detail ?? '').includes('1 member'), `broadcast: ${JSON.stringify(bc)}`);
    const nd = await post({ type: 'nudge_member', memberId: WF_CLAUDE }).then((r) => r.json()) as ClusterActionResult;
    assert(nd.ok && nd.applied === 'nudge_member', 'nudge applied');
    const ps = await post({ type: 'peer_send', fromId: WF_OLLAMA, toId: WF_CLAUDE, body: 'note' }).then((r) => r.json()) as ClusterActionResult;
    assert(ps.ok && ps.applied === 'peer_send', 'peer_send applied');
    const bu = await post({ type: 'board_task_update', taskId: 't1', status: 'review' }).then((r) => r.json()) as ClusterActionResult;
    assert(bu.ok && (bu.detail ?? '').includes('t1 → review'), 'board advance applied');
    const ef = await post({ type: 'set_efficiency', level: 'lean' }).then((r) => r.json()) as ClusterActionResult;
    assert(ef.ok && ef.detail === 'lean', 'efficiency set');
    assertEq(clusterApplied.length, 5, 'all five reached the service');
  });

  await step('R4: bad recipients + remote-off are rejected by the service', async () => {
    const post = (action: ClusterActionRequest) =>
      fetch(`${base}/api/instances/${INSTANCE_ID}/clusters/${CLUSTER_ID}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    const ghost = await post({ type: 'broadcast', body: 'hi', recipientIds: ['ghost-wf'] });
    assertEq(ghost.status, 502, 'unknown recipient → 502');
    const g = await ghost.json() as ClusterActionResult;
    assertEq(g.error, 'unknown-recipient', 'reason');
    clusterRemote = false;
    const off = await post({ type: 'stop_all' }).then((r) => r.json()) as ClusterActionResult;
    clusterRemote = true;
    assert(!off.ok, 'remote-off rejected');
    assertEq(off.error, 'remote-disabled', 'reason');
  });

  await step('console assets ship the R1 UI', async () => {
    const css = consoleCss();
    assert(css.includes('.needs') && css.includes('.ctx-meter') && css.includes('.queue-row'), 'R1 CSS present');
    const js = consoleJs();
    assert(js.includes('answer_question') && js.includes('gate_resolve') && js.includes('cancel_queued'), 'R1 verbs wired in console JS');
    assert(js.includes("'compact'") && js.includes("'fold'"), 'compact/fold buttons wired');
    assert(css.includes('.auth-banner'), 'A2 auth banner CSS present');
    assert(js.includes('start_reauth') && js.includes('complete_reauth'), 'A2 re-auth flow wired in console JS');
  });

  link.stop();
  await hub.close();
  summary('remote-r1 (enriched summary + new verbs)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
