import { isClusterCreationSettings, isClusterMessageGuard } from '@arco/shared';
// server/src/ws/clusterHandlers.ts — cluster WS handler region extracted from
// index.ts (docs/ARCHITECTURE.md). Behavior-preserving, move-only.
// The four index.ts-local back-edges (handleUserMessage / handleRemoveWorkflow /
// createBlankNativeWorkflow / assertAllMembersClaudeOrCodex) are injected once at
// startup via initClusterHandlers to avoid a cycle with the entry point.
import { isClusterOpen, workspaceAdoptFormerMembers, workspaceCloseCluster, workspaceOpenCluster } from '../workspace.js';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  isClusterMemberProvider,
  isClusterMemberAccessMode,
  isClusterEfficiencyLevel,
  isClusterTaskBoardMode,
  isClusterProgressMode,
  type ClusterTaskBoardMode,
  type ClusterEfficiencyLevel,
  type ClusterProgressMode,
  type ClusterOrchestrationAssistRequestMessage,
  type ClusterOrchestrationProposalAcceptMessage,
  type ClusterOrchestrationProposalApplyMessage,
  type ClusterOrchestrationProposalListMessage,
  type ClusterOrchestrationProposalRejectMessage,
  type ClusterSwarmCreateMessage,
  type ClusterMemberProvider,
  type ClusterMemberAccessMode,
  type EffortLevel,
  type LedgerTask,
  type ModelName,
  type OrchestrationProposal,
  type OrchestrationProposalItem,
  type WorkflowConfig,
} from '@arco/shared';
import { WebSocket } from 'ws';
import * as clusterAutoTurn from '../clusterAutoTurn.js';
import * as clusterBudget from '../clusterBudget.js';
import * as clusterIdleNudger from '../clusterIdleNudger.js';
import * as clusterPeerOps from '../clusterPeerOps.js';
import * as clusterPlanBridge from '../clusterPlanBridge.js';
import * as clusterRehydrate from '../clusterRehydrate.js';
import * as clusterStore from '../clusterStore.js';
import { refreshHubReporting } from '../management/initHubLink.js';
import { replayEvents } from '../workflowStore.js';
import { renderTranscript, summarizePriorTurns } from '../primitives/exportContext.js';
import * as taskDispatcher from '../taskDispatcher.js';
import * as taskLedger from '../project/taskLedger.js';
import * as orchestrationProposals from '../project/orchestrationProposals.js';
import { readCatalog as readLlamacppCatalog } from '../llamacppCatalog.js';
import * as mcpConfigWriter from '../mcp/mcpConfigWriter.js';
import { resolveRegistryWiring } from '../mcp/registryWiring.js';
import { readMeta, latestCliSessionFor, workflowConfigFromMeta } from '../workflowMeta.js';
import { isValidPlanId } from '../planStore.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { getCatalog as getClaudeNativeCatalog } from '../providers/claude-native/catalog.js';
import { getCodexCatalog } from '../providers/codex-appserver/catalog.js';
import {
  broadcastCluster,
  broadcastWorkflow,
  buildClusterStatePayload,
  releaseClusterPlansWatcher,
  send,
} from '../server/broadcast.js';
import { appendLedgerComment, broadcastSnapshot, persistLedgerMutation } from './taskLedgerHandlers.js';
import { PORT } from '../server/constants.js';
import {
  sessions,
  workflowCwds,
  workflows,
} from '../server/state.js';
import type { Session } from '../workflows/types.js';
import * as clusterSnapshots from '../clusterSnapshots.js';
import { WorkerManager } from '../workers/WorkerManager.js';
import { applyAutoHandoffDefault, deriveAutoHandoff, derivePrimaryConfig } from './turnEngine.js';
import { acquireProjectSettingsWatcher, readSettings } from '../settings.js';
import { setClusterPlanBody } from '../clusterPlanBridge.js';

export interface ClusterHandlerDeps {
  handleUserMessage: (ws: WebSocket, session: Session, workflowId: string, content: string, clientMessageId: string | undefined, attachments: string[] | undefined, interjection: boolean, kind: 'steer' | 'follow-up' | 'interrupt' | undefined, primitive: 'docs' | 'git' | undefined) => Promise<void>;
  handleRemoveWorkflow: (workflowId: string) => void;
  createBlankNativeWorkflow: (ws: WebSocket, session: Session, config: WorkflowConfig) => Promise<string>;
  assertAllMembersClaudeOrCodex: (memberIds: string[]) => Promise<string | null>;
}
let deps: ClusterHandlerDeps;
export function initClusterHandlers(d: ClusterHandlerDeps): void { deps = d; }

export function attachClusterObservers(ws: WebSocket, session: Session, clusterId: string, memberIds: readonly string[]): void {
  const attached = session.clusterObserved.get(clusterId) ?? new Set<string>();
  for (const wfid of memberIds) {
    const wf = workflows.get(wfid);
    if (!wf) continue;
    wf.observers.add(ws);
    attached.add(wfid);
  }
  if (attached.size > 0) session.clusterObserved.set(clusterId, attached);
}

// 2026-05-11 — counterpart to attachClusterObservers. Removes WS from each
// workflow's observers ONLY when the cluster-subscribe was the source of
// the add. Preserves observer entries that came from another source: an
// explicit tab subscribe (tracked in session.workflowIds) or a parallel
// subscribe to a different cluster that shares this member.
export function detachClusterObservers(ws: WebSocket, session: Session, clusterId: string): void {
  const attached = session.clusterObserved.get(clusterId);
  if (!attached) return;
  const stillObservedViaOtherCluster = new Set<string>();
  for (const [otherClusterId, wfids] of session.clusterObserved.entries()) {
    if (otherClusterId === clusterId) continue;
    for (const wfid of wfids) stillObservedViaOtherCluster.add(wfid);
  }
  for (const wfid of attached) {
    if (stillObservedViaOtherCluster.has(wfid)) continue;
    if (session.workflowIds.has(wfid)) continue;
    const wf = workflows.get(wfid);
    if (wf) wf.observers.delete(ws);
  }
  session.clusterObserved.delete(clusterId);
}

// 2026-05-11 — when a new member joins a cluster, every WS currently
// subscribed to that cluster should observe the new workflow so its
// per-member events fan out to those cluster tabs without requiring a
// member-tab open per worker.
export function attachNewMemberToClusterObservers(clusterId: string, newWorkflowId: string): void {
  const wf = workflows.get(newWorkflowId);
  if (!wf) return;
  for (const [obsWs, sess] of sessions.entries()) {
    if (!sess.clusterIds.has(clusterId)) continue;
    wf.observers.add(obsWs);
    const attached = sess.clusterObserved.get(clusterId) ?? new Set<string>();
    attached.add(newWorkflowId);
    sess.clusterObserved.set(clusterId, attached);
  }
}

// 2026-05-11 — when a member leaves a cluster, drop the cluster-installed
// observer entries from every subscribed WS (preserving observer adds from
// other sources — same rules as detachClusterObservers).
export function detachRemovedMemberFromClusterObservers(clusterId: string, removedWorkflowId: string): void {
  const wf = workflows.get(removedWorkflowId);
  for (const [obsWs, sess] of sessions.entries()) {
    const attached = sess.clusterObserved.get(clusterId);
    if (!attached || !attached.has(removedWorkflowId)) continue;
    attached.delete(removedWorkflowId);
    if (attached.size === 0) sess.clusterObserved.delete(clusterId);
    // Only remove the WS from observers if no other source still observes
    // (other cluster sub or explicit tab subscribe).
    let observedElsewhere = sess.workflowIds.has(removedWorkflowId);
    if (!observedElsewhere) {
      for (const [otherClusterId, wfids] of sess.clusterObserved.entries()) {
        if (otherClusterId === clusterId) continue;
        if (wfids.has(removedWorkflowId)) { observedElsewhere = true; break; }
      }
    }
    if (!observedElsewhere && wf) wf.observers.delete(obsWs);
  }
}

export async function handleClusterSubscribe(ws: WebSocket, session: Session, clusterId: string): Promise<void> {
  const payload = await buildClusterStatePayload(clusterId);
  if (!payload) {
    send(ws, { type: 'cluster_not_found', clusterId });
    workspaceCloseCluster(clusterId);
    return;
  }
  session.clusterIds.add(clusterId);
  // Subscribing IS opening the cluster tab (REOPEN, adopt, reconnect).
  workspaceOpenCluster(clusterId);
  // 2026-05-11 bug fix — also attach as observer on each member workflow so
  // per-member events (primary_tool_use, primary_thinking, ...) reach this
  // WS even when no member tab is open in the client. The cluster ACTIVITY
  // tab depends on these reaching the cluster-only WS.
  const memberIds = clusterStore.getMembers(clusterId) ?? payload.members.map((m) => m.workflowId);
  attachClusterObservers(ws, session, clusterId, memberIds);
  send(ws, { type: 'cluster_state', clusterId, state: payload });
  if (payload.taskBoardMode !== 'none') {
    const tasks = await taskLedger.load(payload.cwd, payload.taskBoardKey).catch(() => null);
    const workflowId = memberIds[0] ?? payload.members[0]?.workflowId;
    if (tasks && workflowId) {
      send(ws, {
        type: 'task_ledger_snapshot',
        workflowId,
        cwd: payload.cwd,
        ...(payload.taskBoardKey ? { boardKey: payload.taskBoardKey } : {}),
        tasks,
      });
    }
  }
  await sendProposalSnapshot(ws, clusterId);
  // Phase 5 — re-emit peer_message_sent for any undelivered mailbox file
  // on the FIRST subscribe per cluster per server lifetime. Subsequent
  // subscribes (same server, additional WS clients) skip the scan.
  await clusterRehydrate.rehydrateClusterOnce(clusterId, { broadcastWorkflow });
}

export async function handleClusterCreate(
  ws: WebSocket,
  session: Session,
  cwd: string,
  memberIds: string[],
  settings: import('@arco/shared').ClusterCreationSettings = {},
): Promise<void> {
  if (!cwd || memberIds.length < 2) {
    send(ws, { type: 'error', message: 'cwd and memberWorkflowIds (≥2) are required' });
    return;
  }
  const fence = await deps.assertAllMembersClaudeOrCodex(memberIds);
  if (fence) {
    send(ws, { type: 'error', message: `cluster_create rejected: ${fence}` });
    return;
  }
  let cluster: clusterStore.ClusterState;
  try {
    cluster = await clusterStore.createCluster({ ...settings, cwd, memberWorkflowIds: memberIds });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'create_failed';
    send(ws, { type: 'error', message: `cluster_create rejected: ${code}` });
    return;
  }
  // Auto-subscribe the creating WS so the new cluster tab opens with state
  // already available, no round-trip required.
  session.clusterIds.add(cluster.clusterId);
  // 2026-05-11 bug fix — symmetric to handleClusterSubscribe: attach the
  // creating WS as observer on each member workflow so its cluster tab
  // surfaces per-member primary_tool_use / primary_thinking events.
  attachClusterObservers(ws, session, cluster.clusterId, cluster.members);
  const payload = await buildClusterStatePayload(cluster.clusterId);
  if (payload) {
    send(ws, { type: 'cluster_created', clusterId: cluster.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${cluster.clusterId.slice(0, 8)} created with ${cluster.members.length} members`);
}

export async function handleClusterDelete(clusterId: string): Promise<void> {
  // Phase 3 — snapshot the member list BEFORE deleteCluster wipes the on-
  // disk state so we can clean up each member's `.arco/<wfid>/mcp-config.json`
  // (the CLI cluster wiring written by `mcpConfigWriter.writeFor`). The
  // next CLI spawn on a member with no clusterId would otherwise still
  // see the stale config and try to spawn an MCP child for a cluster
  // that no longer exists.
  const before = await clusterStore.readCluster(clusterId).catch(() => null);
  const membersToCleanup = before?.members ?? [];
  // Only an OPEN cluster's members inherit tabs — an orphan's members are
  // boot-registered in memory too, and deleting one from CLOSED CLUSTERS must
  // not pop its members open in every browser.
  const wasOpen = isClusterOpen(clusterId);
  releaseClusterPlansWatcher(clusterId);
  await clusterStore.deleteCluster(clusterId);
  for (const wfid of membersToCleanup) {
    const cwd = workflowCwds.get(wfid);
    // F9 — sync rather than unlink: members keep their workflow and may
    // still have codebase-memory attached. syncMcpConfigForWorkflow now
    // sees clusterId=undefined (cluster was just deleted) and rewrites or
    // unlinks based on whatever else is set.
    if (cwd) await syncMcpConfigForWorkflow(wfid).catch(() => undefined);
    // Phase 5 — drop the idle-nudger per-member state. Prevents
    // memory accumulation across long uptimes; if the member rejoins a
    // future cluster, the next turn_started rebuilds state cleanly.
    clusterIdleNudger.dropMember(wfid);
    clusterAutoTurn.dropMember(wfid);
  }
  clusterIdleNudger.dropCluster(clusterId);
  clusterAutoTurn.dropCluster(clusterId);
  taskDispatcher.dropCluster(clusterId);
  // Notify every subscribed WS so they can drop the cluster tab. The
  // members keep working as plain workflows; their next turn sees no
  // clusterId and the peer tools disappear (Phase 1 invariant).
  broadcastCluster(clusterId, { type: 'cluster_deleted', clusterId });
  if (wasOpen) workspaceAdoptFormerMembers(membersToCleanup);
  // 2026-05-11 bug fix — drop cluster-installed observer entries from
  // every subscribed session, preserving observer adds from other sources
  // (explicit tab subscribe, another cluster sub).
  for (const wfid of membersToCleanup) detachRemovedMemberFromClusterObservers(clusterId, wfid);
  for (const sess of sessions.values()) sess.clusterIds.delete(clusterId);
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} deleted`);
}

export async function handleClusterBroadcast(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterBroadcastMessage,
): Promise<void> {
  const state = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!state) {
    send(ws, { type: 'error', message: `Unknown cluster ${msg.clusterId.slice(0, 8)}` });
    return;
  }
  // 2026-05-11 — optional recipient subset. Validate every requested ID is
  // a current member; reject the whole request if any miss (operator
  // intent was a specific set, partial fan-out would be silently wrong).
  const memberSet = new Set(state.members);
  let targets: ReadonlyArray<string> = state.members;
  if (Array.isArray(msg.recipientWorkflowIds) && msg.recipientWorkflowIds.length > 0) {
    const unknown = msg.recipientWorkflowIds.find((id) => !memberSet.has(id));
    if (unknown) {
      send(ws, {
        type: 'error',
        message: `unknown_recipient: ${unknown.slice(0, 8)} is not a member of cluster ${msg.clusterId.slice(0, 8)}`,
      });
      return;
    }
    targets = msg.recipientWorkflowIds;
  }
  const idle: string[] = [];
  const queued: string[] = [];
  const failed: Array<{ workflowId: string; reason: string }> = [];
  // Decision: idle members get the broadcast as a fresh user_message;
  // busy members get it queued as 'follow-up' so it lands at end-of-turn
  // in the same shape the per-tab composer would produce. Reuse
  // handleUserMessage so events.jsonl ordering is identical to a manual
  // prompt — peer_message_received drains still fire BEFORE
  // user_message_echo on each idle member's turn.
  for (const wfid of targets) {
    const wf = workflows.get(wfid);
    if (!wf) {
      failed.push({ workflowId: wfid, reason: 'not_hydrated' });
      continue;
    }
    // Mint a per-member clientMessageId so the optimistic-add path on the
    // member-pane side correlates without colliding across panes.
    const perMemberId = msg.clientMessageId
      ? `${msg.clientMessageId}:${wfid.slice(0, 8)}`
      : undefined;
    const isInterjection = wf.busy === true;
    if (isInterjection) queued.push(wfid);
    else idle.push(wfid);
    deps.handleUserMessage(
      ws,
      session,
      wfid,
      msg.content,
      perMemberId,
      msg.attachments,
      isInterjection,
      isInterjection ? 'follow-up' : undefined,
      undefined,
    ).catch((err) => {
      console.error(`[arco] cluster_broadcast fan-out failed for ${wfid.slice(0, 8)}:`, err);
    });
  }
  send(ws, {
    type: 'cluster_broadcast_dispatched',
    clusterId: msg.clusterId,
    clientMessageId: msg.clientMessageId,
    idle,
    queued,
    failed,
  });
}

export async function handleClusterDispatchOnce(
  ws: WebSocket,
  msg: import('@arco/shared').ClusterDispatchOnceMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `cluster_dispatch_once rejected: unknown_cluster` });
    return;
  }
  if (!clusterStore.isTaskBoardEnabledForState(cluster)) {
    send(ws, { type: 'error', message: `cluster_dispatch_once rejected: board_detached` });
    return;
  }
  const result = await taskDispatcher.dispatchOnce({
    clusterId: msg.clusterId,
    requestedByWorkflowId: msg.workflowId,
    requestId: msg.requestId,
    maxTasks: msg.maxTasks,
    dispatchTaskTurn: dispatchTaskTurnSynthetic,
  });
  if ('error' in result) {
    send(ws, { type: 'error', message: result.error });
    return;
  }
  await broadcastTaskDispatchResult(result);
}

export async function handleClusterTaskBoardAttachSet(
  ws: WebSocket,
  clusterId: string,
  attached: boolean,
): Promise<void> {
  const updated = await clusterStore.setTaskBoardAttached(clusterId, attached === true);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_task_board_attach_set rejected: unknown_cluster` });
    return;
  }
  for (const wfid of updated.members) {
    await syncMcpConfigForWorkflow(wfid).catch(() => undefined);
  }
  if (attached === false) taskDispatcher.dropCluster(clusterId);
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
    if (payload.taskBoardMode !== 'none') {
      const tasks = await taskLedger.load(payload.cwd, payload.taskBoardKey).catch(() => null);
      const workflowId = updated.members[0];
      if (tasks && workflowId) {
        broadcastCluster(clusterId, {
          type: 'task_ledger_snapshot',
          workflowId,
          cwd: payload.cwd,
          ...(payload.taskBoardKey ? { boardKey: payload.taskBoardKey } : {}),
          tasks,
        });
      }
    }
  }
}

export async function handleClusterTaskBoardModeSet(
  ws: WebSocket,
  clusterId: string,
  mode: ClusterTaskBoardMode,
): Promise<void> {
  if (!isClusterTaskBoardMode(mode)) {
    send(ws, { type: 'error', message: `cluster_task_board_mode_set rejected: invalid_mode` });
    return;
  }
  const updated = await clusterStore.setTaskBoardMode(clusterId, mode);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_task_board_mode_set rejected: unknown_cluster` });
    return;
  }
  for (const wfid of updated.members) {
    await syncMcpConfigForWorkflow(wfid).catch(() => undefined);
  }
  if (mode === 'none') taskDispatcher.dropCluster(clusterId);
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
    if (payload.taskBoardMode !== 'none') {
      const tasks = await taskLedger.load(payload.cwd, payload.taskBoardKey).catch(() => null);
      const workflowId = updated.members[0];
      if (tasks && workflowId) {
        broadcastCluster(clusterId, {
          type: 'task_ledger_snapshot',
          workflowId,
          cwd: payload.cwd,
          ...(payload.taskBoardKey ? { boardKey: payload.taskBoardKey } : {}),
          tasks,
        });
      }
    }
  }
}

export function dispatchTaskTurnSynthetic(workflowId: string, prompt: string): void {
  if (process.env.ARCO_TEST_NO_TASK_DISPATCH === '1') return;
  setImmediate(() => {
    const fakeWs = {
      readyState: WebSocket.CLOSED,
      send: () => undefined,
    } as unknown as WebSocket;
    const fakeSession: Session = {
      id: 'task-dispatch-synthetic',
      workflowIds: new Set([workflowId]),
      clusterIds: new Set(),
      clusterObserved: new Map(),
    };
    deps.handleUserMessage(
      fakeWs,
      fakeSession,
      workflowId,
      prompt,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
    ).catch((err) => {
      console.error(`[arco] task-dispatch handleUserMessage failed for ${workflowId.slice(0, 8)}:`, err);
    });
  });
}

export async function broadcastTaskDispatchResult(result: taskDispatcher.DispatchOnceResult): Promise<void> {
  const cluster = await clusterStore.readCluster(result.clusterId).catch(() => null);
  if (cluster && result.fired.length > 0) {
    const boardKey = clusterStore.taskBoardKeyForState(cluster);
    const tasks = await taskLedger.load(cluster.cwd, boardKey).catch(() => null);
    if (tasks) broadcastCluster(result.clusterId, {
      type: 'task_ledger_snapshot',
      workflowId: result.workflowId,
      cwd: cluster.cwd,
      ...(boardKey ? { boardKey } : {}),
      tasks,
    });
  }
  broadcastCluster(result.clusterId, {
    type: 'cluster_dispatch_result',
    clusterId: result.clusterId,
    workflowId: result.workflowId,
    ...(result.requestId ? { requestId: result.requestId } : {}),
    source: result.source ?? 'manual',
    fired: result.fired,
    skipped: result.skipped,
    at: result.at,
  });
}

export async function handleClusterDispatchToggle(
  ws: WebSocket,
  msg: import('@arco/shared').ClusterDispatchToggleMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `cluster_dispatch_toggle rejected: unknown_cluster` });
    return;
  }
  if (!cluster.members.includes(msg.workflowId)) {
    send(ws, { type: 'error', message: `cluster_dispatch_toggle rejected: requester_not_member` });
    return;
  }
  if (msg.enabled === true && !clusterStore.isTaskBoardEnabledForState(cluster)) {
    send(ws, { type: 'error', message: `cluster_dispatch_toggle rejected: board_detached` });
    return;
  }
  const updated = await clusterStore.setTaskDispatcherEnabled(msg.clusterId, msg.enabled === true, msg.workflowId).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_dispatch_toggle rejected: unknown_cluster` });
    return;
  }
  taskDispatcher.notifyDispatcherSettingsChanged(msg.clusterId);
  const payload = await buildClusterStatePayload(msg.clusterId);
  if (payload) {
    broadcastCluster(msg.clusterId, { type: 'cluster_state', clusterId: msg.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${msg.clusterId.slice(0, 8)} task-dispatcher ${msg.enabled ? 'enabled' : 'disabled'} by ${msg.workflowId.slice(0, 8)}`);
}

export async function handleClusterDispatchSettingsUpdate(
  ws: WebSocket,
  msg: import('@arco/shared').ClusterDispatchSettingsUpdateMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `cluster_dispatch_settings_update rejected: unknown_cluster` });
    return;
  }
  if (!cluster.members.includes(msg.workflowId)) {
    send(ws, { type: 'error', message: `cluster_dispatch_settings_update rejected: requester_not_member` });
    return;
  }
  if (!msg.settings || typeof msg.settings !== 'object') {
    send(ws, { type: 'error', message: `cluster_dispatch_settings_update rejected: invalid_settings` });
    return;
  }
  const updated = await clusterStore.updateTaskDispatcherSettings(msg.clusterId, msg.settings, msg.workflowId).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_dispatch_settings_update rejected: unknown_cluster` });
    return;
  }
  taskDispatcher.notifyDispatcherSettingsChanged(msg.clusterId);
  const payload = await buildClusterStatePayload(msg.clusterId);
  if (payload) {
    broadcastCluster(msg.clusterId, { type: 'cluster_state', clusterId: msg.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${msg.clusterId.slice(0, 8)} task-dispatcher settings updated by ${msg.workflowId.slice(0, 8)}`);
}

const SWARM_GOAL_MAX = 8 * 1024;
const SWARM_WORKER_MAX = 12;

function swarmTitle(prefix: string, goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.trim() || 'Untitled swarm';
  return `${prefix}: ${firstLine}`.slice(0, 500);
}

function resolveClusterMember(cluster: clusterStore.ClusterState, ref: string | undefined): string | null {
  if (!ref || typeof ref !== 'string') return null;
  const resolved = clusterStore.resolvePeer(cluster.clusterId, ref.trim());
  return resolved && cluster.members.includes(resolved) ? resolved : null;
}

async function createSwarmTask(
  cwd: string,
  boardKey: string | undefined,
  workflowId: string,
  task: LedgerTask,
  patch?: Parameters<typeof taskLedger.applyUpdate>[2],
): Promise<LedgerTask | null> {
  await persistLedgerMutation(workflowId, cwd, 'create', (tasks) => ({
    tasks: [...tasks, task],
    id: task.id,
    task,
  }), { boardKey });
  if (!patch) return task;
  const updated = await persistLedgerMutation(workflowId, cwd, 'update', (tasks) => {
    const applied = taskLedger.applyUpdate(tasks, task.id, patch);
    return applied ? { tasks: applied.tasks, id: task.id, task: applied.updated } : null;
  }, { boardKey });
  return updated?.task ?? null;
}

export async function handleClusterSwarmCreate(
  ws: WebSocket,
  msg: ClusterSwarmCreateMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: unknown_cluster` });
    return;
  }
  if (!cluster.members.includes(msg.workflowId)) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: requester_not_member` });
    return;
  }
  if (!clusterStore.isTaskBoardEnabledForState(cluster)) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: board_detached` });
    return;
  }
  const boardKey = clusterStore.taskBoardKeyForState(cluster);
  const goal = typeof msg.goal === 'string' ? msg.goal.trim().slice(0, SWARM_GOAL_MAX) : '';
  if (!goal) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: empty_goal` });
    return;
  }
  const workerIds = [...new Set((Array.isArray(msg.workerWorkflowIds) ? msg.workerWorkflowIds : [])
    .map((ref) => resolveClusterMember(cluster, ref))
    .filter((ref): ref is string => typeof ref === 'string'))];
  if (workerIds.length === 0) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: no_workers` });
    return;
  }
  if (workerIds.length > SWARM_WORKER_MAX) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: too_many_workers` });
    return;
  }
  const verifierId = resolveClusterMember(cluster, msg.verifierWorkflowId);
  const synthesizerId = resolveClusterMember(cluster, msg.synthesizerWorkflowId);
  if (!verifierId || !synthesizerId) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: invalid_verifier_or_synthesizer` });
    return;
  }
  if (workerIds.includes(verifierId) || workerIds.includes(synthesizerId) || verifierId === synthesizerId) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: duplicate_roles` });
    return;
  }

  const root = taskLedger.newTask({
    title: swarmTitle('Swarm brief', goal),
    notes: [
      'Swarm blackboard task.',
      '',
      goal,
      '',
      'This task is operator-created context for the linked swarm graph.',
    ].join('\n'),
    priority: 100,
    createdBy: msg.workflowId,
  });
  const rootDone = await createSwarmTask(cluster.cwd, boardKey, msg.workflowId, root, {
    status: 'done',
    updatedBy: msg.workflowId,
  });
  if (!rootDone) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: root_create_failed` });
    return;
  }

  const workerTaskIds: string[] = [];
  for (let i = 0; i < workerIds.length; i += 1) {
    const assignee = workerIds[i];
    const task = taskLedger.newTask({
      title: swarmTitle(`Worker ${i + 1}`, goal),
      notes: [
        `Swarm worker task ${i + 1}/${workerIds.length}.`,
        '',
        'Goal:',
        goal,
        '',
        'Call cluster_task_show first. Write progress as comments or heartbeats. On completion, call cluster_task_complete with summary, changed files, tests, artifacts, and any follow-up tasks.',
      ].join('\n'),
      priority: 90 - i,
      parentIds: [root.id],
      reviewRequired: true,
      createdBy: msg.workflowId,
    });
    const updated = await createSwarmTask(cluster.cwd, boardKey, msg.workflowId, task, {
      status: 'ready',
      assignee,
      updatedBy: msg.workflowId,
    });
    if (!updated) {
      send(ws, { type: 'error', message: `cluster_swarm_create rejected: worker_create_failed` });
      return;
    }
    workerTaskIds.push(task.id);
  }

  const verifier = taskLedger.newTask({
    title: swarmTitle('Verify swarm work', goal),
    notes: [
      'Verifier task for the swarm.',
      '',
      'Review every worker task, inspect their comments/runs/artifacts, and call cluster_task_complete with PASS/FAIL findings and required fixes. Do not mark tasks done.',
    ].join('\n'),
    priority: 70,
    parentIds: workerTaskIds,
    reviewRequired: true,
    createdBy: msg.workflowId,
  });
  const verifierUpdated = await createSwarmTask(cluster.cwd, boardKey, msg.workflowId, verifier, {
    status: 'ready',
    assignee: verifierId,
    updatedBy: msg.workflowId,
  });
  if (!verifierUpdated) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: verifier_create_failed` });
    return;
  }

  const synthesizer = taskLedger.newTask({
    title: swarmTitle('Synthesize swarm result', goal),
    notes: [
      'Synthesizer task for the swarm.',
      '',
      'Read the worker tasks and verifier task, then produce the final synthesis as a comment/completion report. Do not mark work done.',
    ].join('\n'),
    priority: 60,
    parentIds: [verifier.id],
    reviewRequired: true,
    createdBy: msg.workflowId,
  });
  const synthesizerUpdated = await createSwarmTask(cluster.cwd, boardKey, msg.workflowId, synthesizer, {
    status: 'ready',
    assignee: synthesizerId,
    updatedBy: msg.workflowId,
  });
  if (!synthesizerUpdated) {
    send(ws, { type: 'error', message: `cluster_swarm_create rejected: synthesizer_create_failed` });
    return;
  }

  const tasks = await taskLedger.load(cluster.cwd, boardKey);
  broadcastCluster(msg.clusterId, {
    type: 'task_ledger_snapshot',
    workflowId: msg.workflowId,
    cwd: cluster.cwd,
    ...(boardKey ? { boardKey } : {}),
    tasks,
  });
  broadcastCluster(msg.clusterId, {
    type: 'cluster_swarm_created',
    clusterId: msg.clusterId,
    workflowId: msg.workflowId,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
    rootTaskId: root.id,
    workerTaskIds,
    verifierTaskId: verifier.id,
    synthesizerTaskId: synthesizer.id,
    armDispatch: msg.armDispatch === true,
    at: Date.now(),
  });

  if (msg.armDispatch === true) {
    const result = await taskDispatcher.dispatchOnce({
      clusterId: msg.clusterId,
      requestedByWorkflowId: msg.workflowId,
      requestId: msg.requestId,
      maxTasks: workerTaskIds.length,
      dispatchTaskTurn: dispatchTaskTurnSynthetic,
    });
    if ('error' in result) {
      send(ws, { type: 'error', message: result.error });
      return;
    }
    await broadcastTaskDispatchResult(result);
  }
}

async function readClusterForProposal(
  ws: WebSocket,
  clusterId: string,
  workflowId: string,
  surface: string,
): Promise<clusterStore.ClusterState | null> {
  const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `${surface} rejected: unknown_cluster` });
    return null;
  }
  if (!cluster.members.includes(workflowId)) {
    send(ws, { type: 'error', message: `${surface} rejected: requester_not_member` });
    return null;
  }
  return cluster;
}

function broadcastProposalSnapshot(clusterId: string, workflowId: string, proposals: OrchestrationProposal[]): void {
  const wireProposals = proposals.map(toWireProposal);
  broadcastCluster(clusterId, {
    type: 'cluster_orchestration_proposals_snapshot',
    clusterId,
    proposals: wireProposals,
  });
  broadcastWorkflow(workflowId, {
    type: 'cluster_orchestration_proposals_snapshot',
    clusterId,
    proposals: wireProposals,
  });
}

async function sendProposalSnapshot(ws: WebSocket, clusterId: string): Promise<void> {
  const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!cluster) return;
  const proposals = await orchestrationProposals.load(cluster.cwd);
  send(ws, {
    type: 'cluster_orchestration_proposals_snapshot',
    clusterId,
    proposals: proposals.filter((p) => p.clusterId === clusterId).map(toWireProposal),
  });
}

function proposalItemKind(item: OrchestrationProposalItem): string {
  if (item.type === 'task_create') return 'task';
  if (item.type === 'task_update') return item.patch?.assignee ? 'assignment' : 'task';
  if (item.type === 'task_comment') return 'synthesis';
  return 'synthesis';
}

function toWireProposal(proposal: OrchestrationProposal): OrchestrationProposal {
  return {
    ...proposal,
    proposalId: proposal.id,
    items: proposal.items.map((item) => {
      if (item.type === 'task_create') {
        return {
          ...item,
          kind: proposalItemKind(item),
          body: item.notes,
          assigneeWorkflowId: item.assignee,
          dependsOn: [...(item.parentTaskIds ?? []), ...(item.parentItemIds ?? [])],
        };
      }
      if (item.type === 'task_update') {
        return {
          ...item,
          kind: proposalItemKind(item),
          title: item.patch.title ?? `Update ${item.taskId.slice(0, 8)}`,
          body: item.patch.notes ?? item.rationale,
          assigneeWorkflowId: item.patch.assignee,
          dependsOn: item.patch.parentIds,
        };
      }
      if (item.type === 'task_comment') {
        return { ...item, kind: proposalItemKind(item), title: `Comment on ${item.taskId.slice(0, 8)}`, body: item.body };
      }
      return { ...item, kind: proposalItemKind(item), title: item.title ?? 'Proposal note' };
    }) as OrchestrationProposal['items'],
  };
}

function proposalKind(msg: ClusterOrchestrationAssistRequestMessage): NonNullable<ClusterOrchestrationAssistRequestMessage['kind']> | null {
  const kind = msg.kind ?? msg.mode;
  return kind && ['task_graph', 'assignments', 'swarm', 'recovery', 'synthesis'].includes(kind) ? kind : null;
}

function proposalModel(msg: ClusterOrchestrationAssistRequestMessage): NonNullable<ClusterOrchestrationAssistRequestMessage['model']> {
  if (msg.model?.provider) return msg.model;
  return {
    provider: 'claude',
    ...(msg.sourceWorkflowId ? { memberWorkflowId: msg.sourceWorkflowId } : {}),
  };
}

function terminalStatus(value: unknown): boolean {
  return value === 'done' || value === 'archived';
}

export async function handleClusterOrchestrationProposalList(
  ws: WebSocket,
  msg: ClusterOrchestrationProposalListMessage,
): Promise<void> {
  const cluster = await readClusterForProposal(ws, msg.clusterId, msg.workflowId, 'cluster_orchestration_proposal_list');
  if (!cluster) return;
  const proposals = await orchestrationProposals.load(cluster.cwd);
  broadcastProposalSnapshot(msg.clusterId, msg.workflowId, proposals.filter((p) => p.clusterId === msg.clusterId));
}

export async function handleClusterOrchestrationAssistRequest(
  ws: WebSocket,
  msg: ClusterOrchestrationAssistRequestMessage,
): Promise<void> {
  const cluster = await readClusterForProposal(ws, msg.clusterId, msg.workflowId, 'cluster_orchestration_assist_request');
  if (!cluster) return;
  const kind = proposalKind(msg);
  if (!kind) {
    send(ws, { type: 'error', message: `cluster_orchestration_assist_request rejected: invalid_kind` });
    return;
  }
  const model = proposalModel(msg);
  const modelMember = model.memberWorkflowId ?? msg.sourceWorkflowId;
  if (modelMember && !cluster.members.includes(modelMember)) {
    send(ws, { type: 'error', message: `cluster_orchestration_assist_request rejected: assist_member_not_member` });
    return;
  }
  const prompt = typeof msg.prompt === 'string' && msg.prompt.trim()
    ? msg.prompt.trim().slice(0, 16 * 1024)
    : `${kind} proposal requested by operator.`;

  broadcastWorkflow(msg.workflowId, {
    type: 'cluster_orchestration_assist_started',
    clusterId: msg.clusterId,
    workflowId: msg.workflowId,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
    kind,
    model,
    inputRefs: msg.inputRefs ?? [],
    startedAt: Date.now(),
  });
  broadcastWorkflow(msg.workflowId, {
    type: 'cluster_orchestration_proposal_started',
    clusterId: msg.clusterId,
    proposalId: msg.requestId ?? `assist-${Date.now().toString(36)}`,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
    workflowId: msg.workflowId,
    ...(modelMember ? { sourceWorkflowId: modelMember } : {}),
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    title: 'Draft assist running',
    rationale: prompt,
    inputRefs: (msg.inputRefs ?? []).map((ref) => ref.label ?? `${ref.kind}:${ref.ref}`),
    createdAt: Date.now(),
  });

  const proposals = await orchestrationProposals.load(cluster.cwd);
  const proposal = orchestrationProposals.create({
    clusterId: msg.clusterId,
    workflowId: msg.workflowId,
    ...(msg.requestId ? { requestId: msg.requestId } : {}),
    kind,
    prompt,
    inputRefs: msg.inputRefs ?? [],
    model,
    items: msg.draft?.items ?? [],
    rationale: msg.draft?.rationale ?? 'Model-call hook is not wired in this Stage K server/shared slice; proposal content came from the request draft.',
    raw: msg.draft?.raw,
  });
  const next = [proposal, ...proposals.filter((p) => p.id !== proposal.id)];
  await orchestrationProposals.save(cluster.cwd, next);
  broadcastCluster(msg.clusterId, {
    type: 'cluster_orchestration_proposal_proposed',
    clusterId: msg.clusterId,
    workflowId: msg.workflowId,
    proposal: toWireProposal(proposal),
  });
  broadcastWorkflow(msg.workflowId, {
    type: 'cluster_orchestration_proposal_proposed',
    clusterId: msg.clusterId,
    workflowId: msg.workflowId,
    proposal: toWireProposal(proposal),
  });
  broadcastProposalSnapshot(msg.clusterId, msg.workflowId, next.filter((p) => p.clusterId === msg.clusterId));
}

export async function handleClusterOrchestrationProposalReject(
  ws: WebSocket,
  msg: ClusterOrchestrationProposalRejectMessage,
): Promise<void> {
  const baseCluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!baseCluster) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_reject rejected: unknown_cluster` });
    return;
  }
  const proposals = await orchestrationProposals.load(baseCluster.cwd);
  const proposal = proposals.find((p) => p.id === msg.proposalId && p.clusterId === msg.clusterId);
  if (!proposal) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_reject rejected: proposal_not_found` });
    return;
  }
  const requester = msg.workflowId ?? proposal.workflowId;
  const cluster = await readClusterForProposal(ws, msg.clusterId, requester, 'cluster_orchestration_proposal_reject');
  if (!cluster) return;
  if (proposal.status === 'accepted') {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_reject rejected: proposal_accepted` });
    return;
  }
  const rejected = orchestrationProposals.withRejected(proposal, requester, msg.reason);
  await orchestrationProposals.save(cluster.cwd, proposals.map((p) => (p.id === rejected.id ? rejected : p)));
  broadcastCluster(msg.clusterId, {
    type: 'cluster_orchestration_proposal_rejected',
    clusterId: msg.clusterId,
    workflowId: requester,
    proposalId: rejected.id,
    ...(msg.reason ? { reason: msg.reason } : {}),
    at: rejected.updatedAt,
  });
  broadcastWorkflow(requester, {
    type: 'cluster_orchestration_proposal_rejected',
    clusterId: msg.clusterId,
    workflowId: requester,
    proposalId: rejected.id,
    ...(msg.reason ? { reason: msg.reason } : {}),
    at: rejected.updatedAt,
  });
  broadcastProposalSnapshot(msg.clusterId, requester, proposals.map((p) => (p.id === rejected.id ? rejected : p)).filter((p) => p.clusterId === msg.clusterId));
}

// Locked + fresh-state append — the old loadKernel/saveKernel here ran outside
// the ledger lock and wrote back `result.tasks`, reverting a claim that landed
// in between and dropping a concurrent comment.
async function appendProposalComment(cwd: string, boardKey: string | undefined, comment: ReturnType<typeof taskLedger.newTaskComment>): Promise<void> {
  await appendLedgerComment(cwd, comment, boardKey);
}

export async function handleClusterOrchestrationProposalApply(
  ws: WebSocket,
  msg: ClusterOrchestrationProposalApplyMessage | ClusterOrchestrationProposalAcceptMessage,
): Promise<void> {
  const selected = [...new Set((Array.isArray(msg.itemIds) ? msg.itemIds : [])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim()))];
  if (selected.length === 0) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: no_items` });
    return;
  }
  const baseCluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!baseCluster) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: unknown_cluster` });
    return;
  }
  const proposals = await orchestrationProposals.load(baseCluster.cwd);
  const proposal = proposals.find((p) => p.id === msg.proposalId && p.clusterId === msg.clusterId);
  if (!proposal) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: proposal_not_found` });
    return;
  }
  const requester = msg.workflowId ?? proposal.workflowId;
  const cluster = await readClusterForProposal(ws, msg.clusterId, requester, 'cluster_orchestration_proposal_apply');
  if (!cluster) return;
  if (!clusterStore.isTaskBoardEnabledForState(cluster)) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: board_detached` });
    return;
  }
  const boardKey = clusterStore.taskBoardKeyForState(cluster);
  if (proposal.status === 'rejected') {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: proposal_rejected` });
    return;
  }
  const accepted = new Set(proposal.acceptedItemIds ?? []);
  const itemById = new Map(proposal.items.map((item) => [item.id, item]));
  for (const itemId of selected) {
    if (accepted.has(itemId)) {
      send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: already_accepted:${itemId}` });
      return;
    }
    const item = itemById.get(itemId);
    if (!item) {
      send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: unknown_item:${itemId}` });
      return;
    }
    if ((item.type === 'task_create' && terminalStatus(item.status)) || (item.type === 'task_update' && terminalStatus(item.patch.status))) {
      send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: terminal_status_gated` });
      return;
    }
  }
  const itemTaskIds = new Map<string, string>();
  const appliedTaskIds: string[] = [];
  const itemEdits = msg.itemEdits && typeof msg.itemEdits === 'object' ? msg.itemEdits : {};
  const applyMode = msg.applyMode === 'comment' ? 'comment' : 'task_kernel';

  for (const itemId of selected) {
    const item = itemById.get(itemId);
    if (!item) continue;
    const edit = itemEdits[item.id];
    const editedTitle = typeof edit?.title === 'string' && edit.title.trim() ? edit.title.trim() : undefined;
    const editedBody = typeof edit?.body === 'string' && edit.body.trim() ? edit.body.trim() : undefined;
    if (item.type === 'task_create') {
      if (applyMode === 'comment') continue;
      const parentIds = [
        ...(item.parentTaskIds ?? []),
        ...(item.parentItemIds ?? []).map((id) => itemTaskIds.get(id)).filter((id): id is string => !!id),
      ];
      const task = taskLedger.newTask({
        title: editedTitle ?? item.title,
        notes: editedBody ?? item.notes,
        links: item.links,
        priority: item.priority,
        parentIds,
        reviewRequired: item.reviewRequired,
        goalMode: item.goalMode,
        goalMaxTurns: item.goalMaxTurns,
        worktreeRequired: item.worktreeRequired,
        createdBy: requester,
      });
      await persistLedgerMutation(requester, cluster.cwd, 'create', (tasks) => ({
        tasks: [...tasks, task],
        id: task.id,
        task,
      }), { boardKey });
      let finalTask = task;
      if (item.status || item.assignee || parentIds.length > 0) {
        const updated = await persistLedgerMutation(requester, cluster.cwd, 'update', (tasks) => {
          const applied = taskLedger.applyUpdate(tasks, task.id, {
            status: item.status,
            assignee: item.assignee,
            parentIds,
            updatedBy: requester,
          });
          return applied ? { tasks: applied.tasks, id: task.id, task: applied.updated } : null;
        }, { boardKey });
        finalTask = updated?.task ?? task;
      }
      itemTaskIds.set(item.id, finalTask.id);
      appliedTaskIds.push(finalTask.id);
    } else if (item.type === 'task_update') {
      if (applyMode === 'comment') {
        const body = [editedTitle ?? `Proposal note for ${item.taskId.slice(0, 8)}`, editedBody ?? item.rationale ?? 'Accepted orchestration proposal item.']
          .filter(Boolean)
          .join('\n\n');
        const comment = taskLedger.newTaskComment({
          taskId: item.taskId,
          body,
          authorWorkflowId: requester,
          authorLabel: clusterStore.displayNameFor(requester),
          metadata: { source: 'orchestration_proposal', proposalId: proposal.id, itemId: item.id, applyMode },
        });
        const result = await persistLedgerMutation(requester, cluster.cwd, 'comment', (tasks) => {
          const existing = tasks.find((task) => task.id === item.taskId);
          if (!existing) return null;
          return { tasks, id: item.taskId, payload: { comment } };
        }, { boardKey });
        if (result) {
          await appendProposalComment(cluster.cwd, boardKey, comment);
          appliedTaskIds.push(item.taskId);
        }
        continue;
      }
      const updated = await persistLedgerMutation(requester, cluster.cwd, 'update', (tasks) => {
        const applied = taskLedger.applyUpdate(tasks, item.taskId, {
          ...item.patch,
          ...(editedTitle ? { title: editedTitle } : {}),
          ...(editedBody ? { notes: editedBody } : {}),
          updatedBy: requester,
        });
        return applied ? { tasks: applied.tasks, id: item.taskId, task: applied.updated } : null;
      }, { boardKey });
      if (updated?.task) appliedTaskIds.push(updated.task.id);
    } else if (item.type === 'task_comment') {
      const comment = taskLedger.newTaskComment({
        taskId: item.taskId,
        body: editedBody ?? item.body,
        authorWorkflowId: requester,
        authorLabel: clusterStore.displayNameFor(requester),
        metadata: { source: 'orchestration_proposal', proposalId: proposal.id, itemId: item.id, applyMode },
      });
      const result = await persistLedgerMutation(requester, cluster.cwd, 'comment', (tasks) => {
        const existing = tasks.find((task) => task.id === item.taskId);
        if (!existing) return null;
        return { tasks, id: item.taskId, payload: { comment } };
      }, { boardKey });
      if (result) {
        await appendProposalComment(cluster.cwd, boardKey, comment);
        appliedTaskIds.push(item.taskId);
      }
    }
  }

  if (appliedTaskIds.length === 0) {
    send(ws, { type: 'error', message: `cluster_orchestration_proposal_apply rejected: no_applicable_items` });
    return;
  }
  const updatedProposal = orchestrationProposals.withAcceptedItems(proposal, requester, selected, appliedTaskIds);
  await orchestrationProposals.save(cluster.cwd, proposals.map((p) => (p.id === updatedProposal.id ? updatedProposal : p)));
  const tasks = await taskLedger.load(cluster.cwd, boardKey);
  broadcastCluster(msg.clusterId, {
    type: 'task_ledger_snapshot',
    workflowId: requester,
    cwd: cluster.cwd,
    ...(boardKey ? { boardKey } : {}),
    tasks,
  });
  broadcastCluster(msg.clusterId, {
    type: 'cluster_orchestration_proposal_applied',
    clusterId: msg.clusterId,
    workflowId: requester,
    proposalId: updatedProposal.id,
    itemIds: selected,
    taskIds: appliedTaskIds,
    at: updatedProposal.updatedAt,
  });
  broadcastWorkflow(requester, {
    type: 'cluster_orchestration_proposal_applied',
    clusterId: msg.clusterId,
    workflowId: requester,
    proposalId: updatedProposal.id,
    itemIds: selected,
    taskIds: appliedTaskIds,
    at: updatedProposal.updatedAt,
  });
  broadcastProposalSnapshot(msg.clusterId, requester, proposals.map((p) => (p.id === updatedProposal.id ? updatedProposal : p)).filter((p) => p.clusterId === msg.clusterId));
}

// Operator-driven transcript-send. Mirrors a model-issued peer_send but lets
// the operator pick the sender + recipient + content (transcript slice) from
// a worker's UI. Bypasses budget + dedupe (operator intent is explicit) and
// raises the content cap to 32 KB so "last few turns" fits without chunking.
// On policy rejection the operator sees the same error code surface model-
// driven sends produce; on success the recipient's mailbox is identical to
// what a normal peer_send would produce — pre-turn drain + injection works
// the same way.
export const OPERATOR_PEER_SEND_MAX_BYTES = 32 * 1024;
export async function handleOperatorPeerSend(
  ws: WebSocket,
  msg: import('@arco/shared').OperatorPeerSendMessage,
): Promise<void> {
  const state = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!state) {
    send(ws, { type: 'error', message: `Unknown cluster ${msg.clusterId.slice(0, 8)}` });
    return;
  }
  const memberSet = new Set(state.members);
  if (!memberSet.has(msg.from)) {
    send(ws, { type: 'error', message: `operator_peer_send: ${msg.from.slice(0, 8)} is not a member of cluster ${msg.clusterId.slice(0, 8)}` });
    return;
  }
  if (!memberSet.has(msg.to)) {
    send(ws, { type: 'error', message: `operator_peer_send: ${msg.to.slice(0, 8)} is not a member of cluster ${msg.clusterId.slice(0, 8)}` });
    return;
  }
  if (msg.from === msg.to) {
    send(ws, { type: 'error', message: 'operator_peer_send: cannot send to self' });
    return;
  }
  const result = await clusterPeerOps.peerSend(
    {
      workflowId: msg.from,
      clusterId: msg.clusterId,
      broadcastSender: (m) => broadcastWorkflow(msg.from, m),
      broadcastRecipient: (toWfId, m) => broadcastWorkflow(toWfId, m),
    },
    { to: msg.to, content: msg.content },
    { bypassBudget: true, bypassDedupe: true, maxContentBytes: OPERATOR_PEER_SEND_MAX_BYTES },
  );
  if (!result.ok) {
    send(ws, { type: 'error', message: `operator_peer_send: ${result.code}: ${result.message}` });
    return;
  }
}

// Slice 6a — operator renamed a cluster from the Members header. Empty
// `name` clears back to the derived `<basename(cwd)> · <short-id>` default;
// non-empty names cap at 64 chars. Pushes a fresh cluster_state to all
// subscribers so every open client sees the new label immediately.
export async function handleClusterRename(ws: WebSocket, clusterId: string, name: string): Promise<void> {
  if (typeof name !== 'string') {
    send(ws, { type: 'error', message: 'cluster_rename requires a string name' });
    return;
  }
  const updated = await clusterStore.renameCluster(clusterId, name);
  if (!updated) {
    send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} renamed → ${updated.name ?? '(default)'}`);
}

// Drop every per-workflow cluster module map entry (idle-nudger, auto-turn,
// send budget) for a workflow that's going away. Those maps are only cleared
// on cluster delete / member remove; a plain tab close or purge of a member
// otherwise left them for the life of the process. Idempotent, sync, safe to
// call for non-cluster workflows.
export function dropClusterWorkflowState(workflowId: string): void {
  clusterIdleNudger.dropMember(workflowId);
  clusterAutoTurn.dropMember(workflowId);
  clusterBudget.dropMember(workflowId);
}

// Slice 6a — operator clicked × on a member tab in the bottom row. Detach
// the member from the cluster + tear down the workflow itself (single
// confirmed × click in the UI = "I'm done with this member"). If detaching
// drops the cluster below 2 members, removeMember collapses the cluster —
// we forward a cluster_deleted in that case so subscribers drop the tab.
export async function handleClusterMemberRemove(clusterId: string, workflowId: string): Promise<void> {
  // Phase 3 — snapshot the member cwd BEFORE removeMember + the workflow
  // tear-down so we can clean up the member's `.arco/<wfid>/mcp-config.json`
  // even when removeMember collapses the cluster (collapse path implicitly
  // tears down meta + mailbox; we still need to drop the per-workflow
  // mcp-config for every member that's leaving).
  const cwdSnapshot = workflowCwds.get(workflowId);
  const collapseSnapshot = (await clusterStore.readCluster(clusterId).catch(() => null))?.members ?? [];
  const result = await clusterStore.removeMember(clusterId, workflowId);
  // 2026-05-11 bug fix — symmetric to attachNewMemberToClusterObservers.
  // Drop the cluster-installed observer entries from every subscribed WS;
  // explicit tab observers (session.workflowIds) are preserved.
  detachRemovedMemberFromClusterObservers(clusterId, workflowId);
  if (cwdSnapshot) await mcpConfigWriter.cleanupFor(cwdSnapshot, workflowId).catch(() => undefined);
  // Phase 5 — clear idle-nudger state for the departing member. If the
  // collapse path fires, drop state for every member that's leaving.
  clusterIdleNudger.dropMember(workflowId);
  clusterAutoTurn.dropMember(workflowId);
  clusterBudget.dropMember(workflowId);
  // Tear down the member's workflow regardless — operator's intent on the
  // bottom-row × is "remove from cluster AND close workflow".
  deps.handleRemoveWorkflow(workflowId);
  if (result.clusterDeleted) {
    // Cluster collapsed because <2 members remain. Sync the other member's
    // mcp-config.json — they downgraded to plain workflows but may still
    // have codebase-memory attached, in which case the file is rewritten
    // with just that entry rather than unlinked outright (F9).
    for (const otherWfid of collapseSnapshot) {
      if (otherWfid === workflowId) continue;
      const cwd = workflowCwds.get(otherWfid);
      if (cwd) await syncMcpConfigForWorkflow(otherWfid).catch(() => undefined);
      clusterIdleNudger.dropMember(otherWfid);
      clusterAutoTurn.dropMember(otherWfid);
    }
    clusterIdleNudger.dropCluster(clusterId);
    clusterAutoTurn.dropCluster(clusterId);
    taskDispatcher.dropCluster(clusterId);
    // Mirror handleClusterDelete: the collapse path never released the plans
    // watcher ref buildClusterStatePayload took, leaking one fs.watch per
    // collapsed cluster (and pinning the ref-count so the cwd never unwatched).
    releaseClusterPlansWatcher(clusterId);
    const wasOpen = isClusterOpen(clusterId);
    broadcastCluster(clusterId, { type: 'cluster_deleted', clusterId });
    if (wasOpen) workspaceAdoptFormerMembers(collapseSnapshot.filter((id) => id !== workflowId));
    // 2026-05-11 bug fix — detach cluster-installed observers for the
    // remaining members of the collapsing cluster. The departing member
    // was already detached above.
    for (const otherWfid of collapseSnapshot) {
      if (otherWfid === workflowId) continue;
      detachRemovedMemberFromClusterObservers(clusterId, otherWfid);
    }
    for (const sess of sessions.values()) sess.clusterIds.delete(clusterId);
    console.log(`[arco] cluster ${clusterId.slice(0, 8)} collapsed after member ${workflowId.slice(0, 8)} removed (sub-2 members)`);
    return;
  }
  broadcastCluster(clusterId, { type: 'cluster_member_removed', clusterId, workflowId });
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} member ${workflowId.slice(0, 8)} removed`);
}

// Phase 2.5 B2 — operator picked a Native tab and chose "Add to existing
// cluster…" from the right-click menu. Validates: cluster exists, workflow
// exists + Native + same cwd, not already in a cluster. Emits
// cluster_member_added + cluster_state to all subscribers.
export async function handleClusterMemberAdd(ws: WebSocket, clusterId: string, workflowId: string): Promise<void> {
  const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
    return;
  }
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  if (wf.config.workingDirectory !== cluster.cwd) {
    send(ws, { type: 'error', message: `cluster_member_add rejected: cwd_mismatch` });
    return;
  }
  const fence = await deps.assertAllMembersClaudeOrCodex([workflowId]);
  if (fence) {
    send(ws, { type: 'error', message: `cluster_member_add rejected: ${fence}` });
    return;
  }
  const existing = clusterStore.getClusterIdForWorkflow(workflowId);
  if (existing && existing !== clusterId) {
    send(ws, { type: 'error', message: `cluster_member_add rejected: member_already_in_cluster:${existing.slice(0, 8)}` });
    return;
  }
  try {
    await clusterStore.addMember(clusterId, workflowId);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'add_failed';
    send(ws, { type: 'error', message: `cluster_member_add rejected: ${code}` });
    return;
  }
  // 2026-05-11 bug fix — every WS currently subscribed to this cluster
  // needs to start observing the new member's workflow so its
  // primary_tool_use / primary_thinking events reach those cluster tabs.
  attachNewMemberToClusterObservers(clusterId, workflowId);
  const wfNow = workflows.get(workflowId);
  const member = {
    workflowId,
    displayName: clusterStore.displayNameFor(workflowId),
    status: (wfNow?.busy ? 'busy' : 'idle') as 'idle' | 'busy',
    role: undefined as string | undefined,
  };
  broadcastCluster(clusterId, { type: 'cluster_member_added', clusterId, member });
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} member ${workflowId.slice(0, 8)} added`);
}

// 2026-05-11 — pragmatic catalog validator for the cluster fresh-spawn
// picker. We prefer the live cached catalog (already populated by the
// /api/*/catalog HTTP endpoints + lazy refresh); cold-catalog falls back
// to a non-empty-string accept so a freshly-booted server doesn't false-
// reject. Deeper validation surfaces at spawn time (e.g. an unknown
// claude-foo string fails when the worker tries to start). Mirrors the
// "leave to spawn path" pattern noted in `update_primary_config`.
export async function isKnownCatalogModel(provider: ClusterMemberProvider, modelId: string): Promise<boolean> {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return false;
  try {
    if (provider === 'claude') {
      const snap = await getClaudeNativeCatalog(false);
      if (snap.models.length > 0) {
        return snap.models.some((m) => m.id === modelId);
      }
    } else if (provider === 'codex') {
      const snap = await getCodexCatalog(false);
      if (snap.models.length > 0) {
        return snap.models.some((m) => m.id === modelId);
      }
    } else if (provider === 'llamacpp') {
      const catalog = await readLlamacppCatalog();
      if (catalog.models.length > 0) {
        return catalog.models.some((m) => m.alias === modelId);
      }
    }
  } catch {
    // Catalog unavailable (cold start / OAuth not wired / daemon down).
    // Fall through so spawn-time validation surfaces the concrete failure.
  }
  return modelId.length > 0;
}

// §5.1 — catalog-availability probe for the primitive drift guard. Accepts any
// provider string; only the catalog-validated providers are checked, everything
// else fails open (returns true). Shared by the Review / Handoff / Spawn handlers
// so the "is this model still real?" knowledge lives in one place.
export function catalogDriftProbe(provider: string, model: string): Promise<boolean> {
  return isClusterMemberProvider(provider)
    ? isKnownCatalogModel(provider, model)
    : Promise.resolve(true);
}

export function inferClusterProviderFromModel(modelId: string): ClusterMemberProvider | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  // Cursor-exclusive ids first: bare `auto` (the Auto+Composer default) and the
  // grok-* family only reach Arco through Cursor today. NOTE: Cursor also
  // PROXIES the claude-*/gpt-*/glm-* families, so those prefixes below can't
  // distinguish Cursor from the native provider — model-id-only inference for a
  // Cursor member on a proxied model is impossible; the operator picks provider
  // explicitly (AddWorkerSection) and resolveClusterOverrideProvider trusts that
  // pick for Cursor rather than treating the proxied prefix as a mismatch.
  if (id === 'auto' || id.startsWith('grok-') || id.startsWith('grok/')) return 'cursor';
  if ((CLAUDE_MODELS as readonly string[]).includes(id) || id.startsWith('claude-')) return 'claude';
  if ((CODEX_MODELS as readonly string[]).includes(id) || id.startsWith('gpt-')) return 'codex';
  return undefined;
}

export function resolveClusterOverrideProvider(
  inheritedProvider: ClusterMemberProvider,
  requestedProvider: ClusterMemberProvider | undefined,
  requestedModel: string | undefined,
): { provider: ClusterMemberProvider; error?: string } {
  const modelProvider = typeof requestedModel === 'string'
    ? inferClusterProviderFromModel(requestedModel)
    : undefined;
  // Cursor proxies the claude-*/gpt-*/glm-* model families, so a model whose id
  if (requestedProvider && requestedProvider !== 'cursor' && modelProvider && requestedProvider !== modelProvider) {
    return { provider: requestedProvider, error: `provider_model_mismatch:${requestedProvider}:${requestedModel}` };
  }
  return { provider: requestedProvider ?? modelProvider ?? inheritedProvider };
}

// Phase 2.5 B3 — operator right-clicked a Native tab and chose "Create
// cluster with N fresh workers…". Creates N new workflows (each sharing the
// source tab's cwd + primary config), then creates the cluster with source +
// new members. additionalCount is clamped to [1, 4]. Native-only fence holds
// at every step.
export async function handleClusterCreateWithFreshWorkers(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterCreateWithFreshWorkersMessage,
): Promise<void> {
  if (!isClusterCreationSettings(msg)) { send(ws, { type: 'error', message: 'Invalid cluster creation settings' }); return; }
  const source = workflows.get(msg.sourceWorkflowId);
  if (!source) {
    send(ws, { type: 'error', message: `Unknown source workflow ${msg.sourceWorkflowId.slice(0, 8)}` });
    return;
  }
  const sourceCwd = source.config.workingDirectory;
  if (!sourceCwd) {
    send(ws, { type: 'error', message: 'Source workflow has no working directory configured.' });
    return;
  }
  const fence = await deps.assertAllMembersClaudeOrCodex([msg.sourceWorkflowId]);
  if (fence) {
    send(ws, { type: 'error', message: `cluster_create_with_fresh_workers rejected: ${fence}` });
    return;
  }
  // 2026-05-11 — operator-picked provider/model/effort override the inherit-
  // from-anchor default. Provider stays fenced to claude/codex (cluster fence).
  // Model is validated against the live catalog when present; cold-catalog
  // falls back to non-empty-string (deeper validation surfaces at spawn).
  // If provider differs from the anchor's provider, the operator MUST pass
  // a model — the anchor's model name doesn't make sense on the new provider.
  if (msg.provider !== undefined && !isClusterMemberProvider(msg.provider)) {
    send(ws, { type: 'error', message: `cluster_create_with_fresh_workers rejected: unknown_provider:${msg.provider}` });
    return;
  }
  const sourceProvider = source.config.primaryProvider ?? 'claude';
  const inheritedSourceProvider: ClusterMemberProvider = isClusterMemberProvider(sourceProvider) ? sourceProvider : 'claude';
  const providerResolution = resolveClusterOverrideProvider(inheritedSourceProvider, msg.provider, msg.model);
  if (providerResolution.error) {
    send(ws, { type: 'error', message: `cluster_create_with_fresh_workers rejected: ${providerResolution.error}` });
    return;
  }
  if (msg.model !== undefined) {
    if (typeof msg.model !== 'string' || msg.model.trim().length === 0) {
      send(ws, { type: 'error', message: 'cluster_create_with_fresh_workers rejected: unknown_model' });
      return;
    }
    if (!(await isKnownCatalogModel(providerResolution.provider, msg.model))) {
      send(ws, { type: 'error', message: `cluster_create_with_fresh_workers rejected: unknown_model:${msg.model}` });
      return;
    }
  }
  if (providerResolution.provider !== inheritedSourceProvider && msg.model === undefined) {
    send(ws, { type: 'error', message: 'cluster_create_with_fresh_workers rejected: unknown_model (provider changed without model)' });
    return;
  }
  const n = Math.max(1, Math.min(4, Math.floor(msg.additionalCount)));
  const newWorkflowIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const baseName = source.config.name || 'Worker';
    const childConfig: WorkflowConfig = {
      ...source.config,
      autoCompaction: undefined,
      name: `${baseName} #${i + 2}`,
      workingDirectory: sourceCwd,
      resumeSessionId: undefined,
      resumeWorkflowId: undefined,
    };
    if (msg.provider !== undefined || providerResolution.provider !== inheritedSourceProvider) {
      // WorkflowConfig stores undefined for the default-claude case (see
      // handleHandoff's mirror). Keep that invariant.
      childConfig.primaryProvider = providerResolution.provider === 'claude' ? undefined : providerResolution.provider;
      if (providerResolution.provider !== 'codex') childConfig.providerAccountRef = undefined;
    }
    if (msg.model !== undefined) childConfig.primaryModel = msg.model;
    if (msg.effort !== undefined) childConfig.primaryEffort = msg.effort as typeof childConfig.primaryEffort;
    const childProvider = childConfig.primaryProvider ?? 'claude';
    if (childProvider === 'codex') {
      const account = await resolveProviderAccount('codex', msg.providerAccountRef ?? childConfig.providerAccountRef, sourceCwd).catch(() => null);
      if (account) childConfig.providerAccountRef = account.profile.id;
    } else {
      childConfig.providerAccountRef = undefined;
    }
    try {
      const newId = await deps.createBlankNativeWorkflow(ws, session, childConfig);
      newWorkflowIds.push(newId);
    } catch (err) {
      console.error(`[arco] cluster_create_with_fresh_workers: child ${i + 1} create failed:`, err);
      send(ws, { type: 'error', message: `cluster_create_with_fresh_workers: child ${i + 1} create failed` });
      return;
    }
  }
  let cluster: clusterStore.ClusterState;
  try {
    cluster = await clusterStore.createCluster({
      ...msg,
      cwd: sourceCwd,
      memberWorkflowIds: [msg.sourceWorkflowId, ...newWorkflowIds],
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'create_failed';
    send(ws, { type: 'error', message: `cluster_create_with_fresh_workers rejected: ${code}` });
    return;
  }
  // Operator-typed name on creation, if any.
  if (msg.name && msg.name.trim().length > 0) {
    await clusterStore.renameCluster(cluster.clusterId, msg.name).catch(() => { /* best-effort */ });
  }
  session.clusterIds.add(cluster.clusterId);
  // 2026-05-11 bug fix — attach as cluster observer on every member so
  // per-member events fan out to this WS even when the operator only has
  // the cluster tab open. Mirrors handleClusterSubscribe.
  attachClusterObservers(ws, session, cluster.clusterId, cluster.members);
  const payload = await buildClusterStatePayload(cluster.clusterId);
  if (payload) {
    send(ws, { type: 'cluster_created', clusterId: cluster.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${cluster.clusterId.slice(0, 8)} created with ${1 + n} members (1 source + ${n} fresh)`);
}

// 2026-05-11 — operator picked CLUSTER mode in the +NEW WorkflowCreator
// and submitted. No source workflow: every member is minted fresh from the
// per-row config the operator built. Mirrors handleClusterCreateWithFreshWorkers
// for the validation + createBlankNativeWorkflow loop + cluster create + name
// rename, but role/tier/displayName flow through too.
//
// Validation order (server-side floor — client UI enforces stricter):
//   1. cwd is a non-empty string
//   2. ≥1 member (client enforces ≥2; we keep the server bottom at 1 for
//      defence-in-depth and let clusterStore.createCluster's own ≥2 rule
//      do the final rejection if the array is too short)
//   3. each member's provider is ClusterMemberProvider (cluster fence)
//   4. each member's model is known per isKnownCatalogModel (cold-catalog
//      falls back to non-empty-string, matching the existing pattern)
//   5. each member's tier (if set) passes isMemberTier
//
// On success, every minted workflow id is woven into clusterStore.createCluster,
// then per-member role/tier are persisted via setMemberRole/setMemberTier.
// Finally `msg.name` (when non-empty) is applied via renameCluster, and the
// requesting WS is attached as cluster observer + receives cluster_created.
export async function handleClusterCreateFromScratch(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterCreateFromScratchMessage,
): Promise<void> {
  if (!isClusterCreationSettings(msg)) { send(ws, { type: 'error', message: 'Invalid cluster creation settings' }); return; }
  if (typeof msg.cwd !== 'string' || msg.cwd.trim().length === 0) {
    send(ws, { type: 'error', message: 'cluster_create_from_scratch rejected: invalid_cwd' });
    return;
  }
  if (!Array.isArray(msg.members) || msg.members.length === 0) {
    send(ws, { type: 'error', message: 'cluster_create_from_scratch rejected: no_members' });
    return;
  }
  const localMemberCount = msg.members.filter((m) => m.provider === 'ollama' || m.provider === 'llamacpp').length;
  if (localMemberCount > 1 && process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL !== '1') {
    send(ws, { type: 'error', message: 'cluster_create_from_scratch rejected: multiple_local_members (default max is 1)' });
    return;
  }
  // Pre-flight validate every member before minting any workflow — we don't
  // want to leak 3 half-created workflows because the 4th had a bad model id.
  for (let i = 0; i < msg.members.length; i++) {
    const m = msg.members[i];
    if (!isClusterMemberProvider(m.provider)) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] unknown_provider:${m.provider}` });
      return;
    }
    if (typeof m.model !== 'string' || m.model.trim().length === 0) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] missing_model` });
      return;
    }
    const modelProvider = inferClusterProviderFromModel(m.model);
    if (modelProvider && modelProvider !== m.provider) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] provider_model_mismatch:${m.provider}:${m.model}` });
      return;
    }
    if (!(await isKnownCatalogModel(m.provider, m.model))) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] unknown_model:${m.model}` });
      return;
    }
    if (m.tier !== undefined && !clusterStore.isMemberTier(m.tier)) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] invalid_tier:${m.tier}` });
      return;
    }
    const accessMode = m.accessMode ?? 'standard';
    if (!isClusterMemberAccessMode(accessMode)) {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] invalid_access_mode` });
      return;
    }
    if (accessMode === 'isolated' && m.provider !== 'claude') {
      send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: member[${i}] isolated_requires_claude_native` });
      return;
    }
  }
  const newWorkflowIds: string[] = [];
  for (let i = 0; i < msg.members.length; i++) {
    const m = msg.members[i];
    const displayName = (m.displayName ?? '').trim();
    const childConfig: WorkflowConfig = {
      name: displayName.length > 0 ? displayName : `Member #${i + 1}`,
      // WorkflowConfig stores undefined for default-claude (mirrors handleHandoff).
      primaryProvider: m.provider === 'claude' ? undefined : m.provider,
      primaryModel: m.model as ModelName,
      primaryEffort: (m.effort ?? 'medium') as EffortLevel,
      skipPermissions: m.skipPermissions ?? true,
      workingDirectory: msg.cwd,
      ...(m.fastMode ? { fastMode: true } : {}),
      ...(m.efficiencyToolFilter && m.efficiencyToolFilter !== 'off' ? { efficiencyToolFilter: m.efficiencyToolFilter } : {}),
      ...(m.outputStyle && m.outputStyle !== 'normal' ? { outputStyle: m.outputStyle } : {}),
    };
    if (m.accessMode === 'isolated') {
      childConfig.claudeTransport = 'native';
      childConfig.ultracode = false;
    }
    if (m.provider === 'codex') {
      const account = await resolveProviderAccount('codex', m.providerAccountRef, msg.cwd).catch(() => null);
      if (account) childConfig.providerAccountRef = account.profile.id;
    }
    try {
      const newId = await deps.createBlankNativeWorkflow(ws, session, childConfig);
      newWorkflowIds.push(newId);
    } catch (err) {
      console.error(`[arco] cluster_create_from_scratch: member ${i + 1} create failed:`, err);
      send(ws, { type: 'error', message: `cluster_create_from_scratch: member ${i + 1} create failed` });
      return;
    }
  }
  let cluster: clusterStore.ClusterState;
  try {
    cluster = await clusterStore.createCluster({
      ...msg,
      cwd: msg.cwd,
      memberWorkflowIds: newWorkflowIds,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'create_failed';
    send(ws, { type: 'error', message: `cluster_create_from_scratch rejected: ${code}` });
    return;
  }
  // Per-member role + tier persistence (best-effort; the cluster is already
  // alive, a failure here just means the operator has to set it via the
  // Members sub-tab afterwards).
  for (let i = 0; i < msg.members.length; i++) {
    const m = msg.members[i];
    const wfid = newWorkflowIds[i];
    if (m.role && m.role.trim().length > 0) {
      await clusterStore.setMemberRole(cluster.clusterId, wfid, m.role).catch(() => { /* best-effort */ });
    }
    if (m.tier !== undefined) {
      await clusterStore.setMemberTier(cluster.clusterId, wfid, m.tier).catch(() => { /* best-effort */ });
    }
    if (m.focus && m.focus.trim().length > 0) {
      await clusterStore.setMemberFocus(cluster.clusterId, wfid, m.focus).catch(() => { /* best-effort */ });
    }
    if (m.accessMode && m.accessMode !== 'standard') {
      await clusterStore.setMemberAccessMode(cluster.clusterId, wfid, m.accessMode).catch(() => { /* best-effort */ });
    }
  }
  if (msg.name && msg.name.trim().length > 0) {
    await clusterStore.renameCluster(cluster.clusterId, msg.name).catch(() => { /* best-effort */ });
  }
  session.clusterIds.add(cluster.clusterId);
  attachClusterObservers(ws, session, cluster.clusterId, cluster.members);
  const payload = await buildClusterStatePayload(cluster.clusterId);
  if (payload) {
    send(ws, { type: 'cluster_created', clusterId: cluster.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${cluster.clusterId.slice(0, 8)} created from scratch with ${newWorkflowIds.length} fresh members`);
}

// Phase 2.5.1 — operator clicked "+ ADD WORKER" inside ClusterRightPanel
// and chose "spawn N fresh." Server picks the cluster's template from
// `members[0]` (cwd + primary config), validates Native, creates N new
// workflows, adds each to the cluster. Per-add cluster_member_added
// broadcast + a final cluster_state push.
export async function handleClusterAddFreshWorkers(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterAddFreshWorkersMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: unknown_cluster:${msg.clusterId.slice(0, 8)}` });
    return;
  }
  const templateId = cluster.members[0];
  const template = templateId ? workflows.get(templateId) : undefined;
  if (!template) {
    send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: template_missing` });
    return;
  }
  const fence = await deps.assertAllMembersClaudeOrCodex([templateId]);
  if (fence) {
    send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: ${fence}` });
    return;
  }
  // 2026-05-11 — same picker-override semantics as
  // handleClusterCreateWithFreshWorkers. Validate provider/model up front;
  // require model when provider differs from template's provider.
  if (msg.provider !== undefined && !isClusterMemberProvider(msg.provider)) {
    send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: unknown_provider:${msg.provider}` });
    return;
  }
  const accessMode: ClusterMemberAccessMode = msg.accessMode ?? 'standard';
  if (!isClusterMemberAccessMode(accessMode)) {
    send(ws, { type: 'error', message: 'cluster_add_fresh_workers rejected: invalid_access_mode' });
    return;
  }
  const templateProvider = template.config.primaryProvider ?? 'claude';
  const inheritedTemplateProvider: ClusterMemberProvider = isClusterMemberProvider(templateProvider) ? templateProvider : 'claude';
  const providerResolution = resolveClusterOverrideProvider(inheritedTemplateProvider, msg.provider, msg.model);
  if (providerResolution.error) {
    send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: ${providerResolution.error}` });
    return;
  }
  if (msg.model !== undefined) {
    if (typeof msg.model !== 'string' || msg.model.trim().length === 0) {
      send(ws, { type: 'error', message: 'cluster_add_fresh_workers rejected: unknown_model' });
      return;
    }
    if (!(await isKnownCatalogModel(providerResolution.provider, msg.model))) {
      send(ws, { type: 'error', message: `cluster_add_fresh_workers rejected: unknown_model:${msg.model}` });
      return;
    }
  }
  if (providerResolution.provider !== inheritedTemplateProvider && msg.model === undefined) {
    send(ws, { type: 'error', message: 'cluster_add_fresh_workers rejected: unknown_model (provider changed without model)' });
    return;
  }
  if (accessMode === 'isolated' && providerResolution.provider !== 'claude') {
    send(ws, { type: 'error', message: 'cluster_add_fresh_workers rejected: isolated_requires_claude_native' });
    return;
  }
  const n = Math.max(1, Math.min(4, Math.floor(msg.count)));
  const baseName = template.config.name || 'Worker';
  // Pick the next available "#k" suffix among current cluster members.
  const usedNumbers = new Set<number>();
  for (const memberId of cluster.members) {
    const m = workflows.get(memberId);
    if (!m) continue;
    const match = /#(\d+)$/.exec(m.config.name || '');
    if (match) usedNumbers.add(parseInt(match[1], 10));
    else usedNumbers.add(1); // unnumbered template is implicit #1
  }
  const newIds: string[] = [];
  for (let i = 0; i < n; i++) {
    let k = 2;
    while (usedNumbers.has(k)) k++;
    usedNumbers.add(k);
    const childConfig: WorkflowConfig = {
      ...template.config,
      autoCompaction: undefined,
      name: `${baseName.replace(/\s*#\d+$/, '')} #${k}`,
      workingDirectory: cluster.cwd,
      resumeSessionId: undefined,
      resumeWorkflowId: undefined,
    };
    if (msg.provider !== undefined || providerResolution.provider !== inheritedTemplateProvider) {
      childConfig.primaryProvider = providerResolution.provider === 'claude' ? undefined : providerResolution.provider;
      if (providerResolution.provider !== 'codex') childConfig.providerAccountRef = undefined;
    }
    if (msg.model !== undefined) childConfig.primaryModel = msg.model;
    if (msg.effort !== undefined) childConfig.primaryEffort = msg.effort as typeof childConfig.primaryEffort;
    if (accessMode === 'isolated') {
      childConfig.primaryProvider = undefined;
      childConfig.claudeTransport = 'native';
      childConfig.ultracode = false;
      childConfig.resumeSessionId = undefined;
      childConfig.resumeWorkflowId = undefined;
    }
    const childProvider = childConfig.primaryProvider ?? 'claude';
    if (childProvider === 'codex') {
      const account = await resolveProviderAccount('codex', msg.providerAccountRef ?? childConfig.providerAccountRef, cluster.cwd).catch(() => null);
      if (account) childConfig.providerAccountRef = account.profile.id;
    } else {
      childConfig.providerAccountRef = undefined;
    }
    try {
      const id = await deps.createBlankNativeWorkflow(ws, session, childConfig);
      newIds.push(id);
    } catch (err) {
      console.error(`[arco] cluster_add_fresh_workers: child ${i + 1} create failed:`, err);
      send(ws, { type: 'error', message: `cluster_add_fresh_workers: child ${i + 1} create failed` });
      return;
    }
  }
  for (const newId of newIds) {
    try {
      await clusterStore.addMember(msg.clusterId, newId);
      if (accessMode !== 'standard') {
        await clusterStore.setMemberAccessMode(msg.clusterId, newId, accessMode);
      }
      // 2026-05-11 bug fix — fan out the cluster-side observer entry to
      // every WS already subscribed to this cluster (incl. the creating
      // WS via its own cluster sub) so per-member events surface in their
      // cluster tab without requiring a tab open per worker.
      attachNewMemberToClusterObservers(msg.clusterId, newId);
      const newWf = workflows.get(newId);
      const member = {
        workflowId: newId,
        displayName: clusterStore.displayNameFor(newId),
        status: (newWf?.busy ? 'busy' : 'idle') as 'idle' | 'busy',
        role: undefined as string | undefined,
        ...(accessMode !== 'standard' ? { accessMode } : {}),
      };
      broadcastCluster(msg.clusterId, { type: 'cluster_member_added', clusterId: msg.clusterId, member });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'add_failed';
      console.error(`[arco] cluster_add_fresh_workers: addMember ${newId.slice(0, 8)} failed: ${code}`);
      send(ws, { type: 'error', message: `cluster_add_fresh_workers: addMember failed: ${code}` });
    }
  }
  const payload = await buildClusterStatePayload(msg.clusterId);
  if (payload) {
    broadcastCluster(msg.clusterId, { type: 'cluster_state', clusterId: msg.clusterId, state: payload });
  }
  console.log(`[arco] cluster ${msg.clusterId.slice(0, 8)} grew by ${newIds.length} fresh workers`);
}

const REPLACEMENT_HISTORY_MAX_BYTES = 512 * 1024;

// Replace a cluster slot without reusing the provider session. The cluster
// metadata swap is one atomic meta.json write; old workflow persistence stays
// on disk for audit/recovery, but no mailbox or provider state is inherited.
export async function handleClusterMemberReplace(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterMemberReplaceMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  const source = workflows.get(msg.workflowId);
  if (!cluster || !source || !cluster.members.includes(msg.workflowId)) {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: unknown_member' });
    return;
  }
  if (source.busy) {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: member_busy' });
    return;
  }
  const accessMode = msg.accessMode ?? clusterStore.getMemberAccessMode(msg.clusterId, msg.workflowId);
  if (!isClusterMemberAccessMode(accessMode)) {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: invalid_access_mode' });
    return;
  }
  if (accessMode === 'isolated' && (msg.includeHistory || msg.transferActiveTasks)) {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: isolated_requires_fresh_context_and_no_tasks' });
    return;
  }

  const inheritedProvider = source.config.primaryProvider ?? 'claude';
  const inheritedClusterProvider: ClusterMemberProvider = isClusterMemberProvider(inheritedProvider)
    ? inheritedProvider
    : 'claude';
  const providerResolution = resolveClusterOverrideProvider(inheritedClusterProvider, msg.provider, msg.model);
  if (providerResolution.error) {
    send(ws, { type: 'error', message: `cluster_member_replace rejected: ${providerResolution.error}` });
    return;
  }
  if (accessMode === 'isolated' && providerResolution.provider !== 'claude') {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: isolated_requires_claude_native' });
    return;
  }
  if (msg.model !== undefined && !(await isKnownCatalogModel(providerResolution.provider, msg.model))) {
    send(ws, { type: 'error', message: `cluster_member_replace rejected: unknown_model:${msg.model}` });
    return;
  }
  if (providerResolution.provider !== inheritedClusterProvider && msg.model === undefined) {
    send(ws, { type: 'error', message: 'cluster_member_replace rejected: provider_changed_without_model' });
    return;
  }

  let historySeed = '';
  if (msg.includeHistory) {
    const events = await replayEvents(cluster.cwd, msg.workflowId, 0).catch(() => []);
    const transcript = renderTranscript(events).trim();
    const actions = summarizePriorTurns(events).trim();
    historySeed = [
      '[REPLACEMENT CONTEXT — copied by explicit operator request; this is a new provider session]',
      transcript,
      actions ? `\n[Prior-turn action digest]\n${actions}` : '',
      '\nAcknowledge this imported context briefly, then wait for the operator.',
    ].filter(Boolean).join('\n\n');
    if (Buffer.byteLength(historySeed, 'utf8') > REPLACEMENT_HISTORY_MAX_BYTES) {
      send(ws, {
        type: 'error',
        message: `cluster_member_replace rejected: history_too_large (>${REPLACEMENT_HISTORY_MAX_BYTES} bytes)`,
      });
      return;
    }
  }

  const childConfig: WorkflowConfig = {
    ...source.config,
    workingDirectory: cluster.cwd,
    resumeSessionId: undefined,
    resumeWorkflowId: undefined,
    researchSpawnToken: undefined,
    templateSpawnToken: undefined,
  };
  if (msg.provider !== undefined || providerResolution.provider !== inheritedClusterProvider) {
    childConfig.primaryProvider = providerResolution.provider === 'claude' ? undefined : providerResolution.provider;
    if (providerResolution.provider !== 'codex') childConfig.providerAccountRef = undefined;
  }
  if (msg.model !== undefined) childConfig.primaryModel = msg.model;
  if (msg.effort !== undefined) childConfig.primaryEffort = msg.effort as EffortLevel;
  if (accessMode === 'isolated') {
    childConfig.primaryProvider = undefined;
    childConfig.claudeTransport = 'native';
    childConfig.ultracode = false;
    childConfig.providerAccountRef = undefined;
  } else if ((childConfig.primaryProvider ?? 'claude') === 'codex') {
    const account = await resolveProviderAccount(
      'codex',
      msg.providerAccountRef ?? childConfig.providerAccountRef,
      cluster.cwd,
    ).catch(() => null);
    if (account) childConfig.providerAccountRef = account.profile.id;
  }

  let newWorkflowId: string;
  try {
    newWorkflowId = await deps.createBlankNativeWorkflow(ws, session, childConfig);
    const replaced = await clusterStore.replaceMember(
      msg.clusterId,
      msg.workflowId,
      newWorkflowId,
      accessMode,
    );
    if (!replaced) throw new Error('atomic_replace_failed');
  } catch (err) {
    send(ws, {
      type: 'error',
      message: `cluster_member_replace failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  attachNewMemberToClusterObservers(msg.clusterId, newWorkflowId);
  detachRemovedMemberFromClusterObservers(msg.clusterId, msg.workflowId);

  let transferredTaskCount = 0;
  let lastTasks: LedgerTask[] | undefined;
  if (msg.transferActiveTasks) {
    const boardKey = clusterStore.taskBoardKeyForState(cluster);
    const tasks = await taskLedger.load(cluster.cwd, boardKey).catch(() => []);
    for (const task of tasks) {
      if (task.assignee !== msg.workflowId || task.status === 'done' || task.status === 'archived') continue;
      const result = await persistLedgerMutation(
        newWorkflowId,
        cluster.cwd,
        'update',
        (current) => {
          const updated = taskLedger.applyUpdate(current, task.id, {
            assignee: newWorkflowId,
            updatedBy: newWorkflowId,
          });
          return updated
            ? { tasks: updated.tasks, id: task.id, task: updated.updated, payload: { replacementFrom: msg.workflowId } }
            : null;
        },
        { boardKey },
      );
      if (result) {
        transferredTaskCount++;
        lastTasks = result.tasks;
      }
    }
    if (lastTasks) broadcastSnapshot(newWorkflowId, cluster.cwd, lastTasks, boardKey);
  }

  const oldCwd = workflowCwds.get(msg.workflowId);
  if (oldCwd) await mcpConfigWriter.cleanupFor(oldCwd, msg.workflowId).catch(() => undefined);
  clusterIdleNudger.dropMember(msg.workflowId);
  clusterAutoTurn.dropMember(msg.workflowId);
  deps.handleRemoveWorkflow(msg.workflowId);

  const newWf = workflows.get(newWorkflowId);
  broadcastCluster(msg.clusterId, {
    type: 'cluster_member_replaced',
    clusterId: msg.clusterId,
    oldWorkflowId: msg.workflowId,
    newWorkflowId,
    accessMode,
    historyIncluded: !!msg.includeHistory,
    transferredTaskCount,
    member: {
      workflowId: newWorkflowId,
      displayName: childConfig.name || newWorkflowId.slice(0, 8),
      status: newWf?.busy ? 'busy' : 'idle',
      ...(clusterStore.getMemberRole(msg.clusterId, newWorkflowId)
        ? { role: clusterStore.getMemberRole(msg.clusterId, newWorkflowId) }
        : {}),
      ...(clusterStore.tierFor(newWorkflowId)
        ? { tier: clusterStore.tierFor(newWorkflowId) }
        : {}),
      ...(clusterStore.focusFor(newWorkflowId)
        ? { focus: clusterStore.focusFor(newWorkflowId) }
        : {}),
      ...(accessMode !== 'standard' ? { accessMode } : {}),
    },
  });
  const payload = await buildClusterStatePayload(msg.clusterId);
  if (payload) broadcastCluster(msg.clusterId, { type: 'cluster_state', clusterId: msg.clusterId, state: payload });

  if (historySeed) {
    await deps.handleUserMessage(
      ws,
      session,
      newWorkflowId,
      historySeed,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
    );
  }
}

// Operator saved the shared cluster plan from ClusterPlanTab (or hit
// PROMOTE TO CLUSTER from a per-workflow PLAN tab). The body is written to
// the cluster's active per-cwd plan; when no active plan exists, a new normal
// plan is created and attached to the cluster automatically.
export async function handleClusterPlanSet(ws: WebSocket, clusterId: string, body: string): Promise<void> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) {
    send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
    return;
  }
  if (typeof body !== 'string') {
    send(ws, { type: 'error', message: 'cluster_plan_set requires a string body' });
    return;
  }
  if (body.length > clusterPlanBridge.PLAN_MAX_BYTES) {
    send(ws, { type: 'error', message: `cluster_plan_set rejected: body_too_large (${body.length} > ${clusterPlanBridge.PLAN_MAX_BYTES})` });
    return;
  }
  if (body.trim().length === 0) {
    send(ws, { type: 'error', message: 'cluster_plan_set rejected: empty_body (use cluster_plan_clear to wipe)' });
    return;
  }
  let rec: { body: string; updatedAt: number };
  try {
    const written = await clusterPlanBridge.setClusterPlanBody(clusterId, body);
    if (!written) {
      send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
      return;
    }
    rec = written;
  } catch (err) {
    const code = err instanceof clusterPlanBridge.PlanTooLargeError ? `body_too_large:${err.actual}` : (err instanceof Error ? err.message : 'write_failed');
    send(ws, { type: 'error', message: `cluster_plan_set rejected: ${code}` });
    return;
  }
  broadcastCluster(clusterId, {
    type: 'cluster_plan_changed',
    clusterId,
    body: rec.body,
    updatedAt: rec.updatedAt,
    bodyLength: rec.body.length,
  });
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} plan set (${rec.body.length} chars)`);
}

export async function handleClusterPlanAttach(ws: WebSocket, clusterId: string, planId: string): Promise<void> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) {
    send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
    return;
  }
  if (!isValidPlanId(planId)) {
    send(ws, { type: 'error', message: 'cluster_plan_attach rejected: invalid_plan_id' });
    return;
  }
  let rec: { body: string; updatedAt: number } | null = null;
  try {
    rec = await clusterPlanBridge.attachExistingPlan(clusterId, planId);
  } catch (err) {
    const code = err instanceof clusterPlanBridge.PlanTooLargeError ? `body_too_large:${err.actual}` : (err instanceof Error ? err.message : 'attach_failed');
    send(ws, { type: 'error', message: `cluster_plan_attach rejected: ${code}` });
    return;
  }
  if (!rec) {
    send(ws, { type: 'error', message: `cluster_plan_attach rejected: plan ${planId.slice(0, 8)} not found in this workspace` });
    return;
  }
  broadcastCluster(clusterId, {
    type: 'cluster_plan_changed',
    clusterId,
    body: rec.body,
    updatedAt: rec.updatedAt,
    bodyLength: rec.body.length,
  });
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} attached plan ${planId.slice(0, 8)}`);
}

// Operator hit "Clear plan" from ClusterPlanTab. This detaches the cluster
// from its active plan; the canonical .arco/plans/<id>.md file remains
// available to future workers and clusters in the same cwd.
export async function handleClusterPlanClear(ws: WebSocket, clusterId: string): Promise<void> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) {
    send(ws, { type: 'error', message: `Unknown cluster ${clusterId.slice(0, 8)}` });
    return;
  }
  await clusterPlanBridge.clearClusterPlan(clusterId);
  const updatedAt = Date.now();
  broadcastCluster(clusterId, {
    type: 'cluster_plan_changed',
    clusterId,
    body: '',
    updatedAt,
    bodyLength: 0,
  });
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} plan cleared`);
}

// Phase 2.6 — operator typed a role hint into a member row (pencil-edit
// affordance in ClusterRightPanel's Members sub-tab) or cleared it.
// Empty / whitespace clears the field. Length clamps to MEMBER_ROLE_MAX.
// Pushes a fresh cluster_state so every subscriber sees the new role
// inline; no dedicated event — role changes are cluster-state-shaped
// (mirrors role-on-member-payload).
export async function handleClusterMemberRoleSet(ws: WebSocket, clusterId: string, workflowId: string, role: string): Promise<void> {
  if (typeof role !== 'string') {
    send(ws, { type: 'error', message: 'cluster_member_role_set requires a string role' });
    return;
  }
  const updated = await clusterStore.setMemberRole(clusterId, workflowId, role).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_member_role_set rejected: unknown_cluster_or_member` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  const stored = updated.memberRoles?.[workflowId];
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} member ${workflowId.slice(0, 8)} role ${stored ? `→ "${stored.slice(0, 40)}"` : 'cleared'}`);
}

// 2026-05-11 — operator picked a builder-tier from a member row's tier
// picker (or chose UNSET). Mirrors handleClusterMemberRoleSet: persists
// in cluster meta.json, pushes a fresh cluster_state. Pure metadata —
// the server does NO routing (autonomy-test hard fence: orchestrator
// LLM stays rejected). `null` clears; unknown strings reject with an
// error. The director sees the new tier in peer_list rows next time
// the peer tool is called.
export async function handleClusterMemberTierSet(
  ws: WebSocket,
  clusterId: string,
  workflowId: string,
  tier: clusterStore.MemberTier | null,
): Promise<void> {
  if (tier !== null && !clusterStore.isMemberTier(tier)) {
    send(ws, { type: 'error', message: `cluster_member_tier_set rejected: invalid tier (must be one of ${clusterStore.MEMBER_TIERS.join(' / ')} or null)` });
    return;
  }
  const updated = await clusterStore.setMemberTier(clusterId, workflowId, tier).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_member_tier_set rejected: unknown_cluster_or_member` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  const stored = updated.memberTiers?.[workflowId];
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} member ${workflowId.slice(0, 8)} tier ${stored ? `→ ${stored}` : 'cleared'}`);
}

// 2026-05-11 — operator edited a member's focus (sub-specialty) from the
// Members sub-tab or the WorkflowCreator member-row editor. Mirrors the
// tier-set handler shape: clamp + persist + rebroadcast cluster_state.
export async function handleClusterMemberFocusSet(
  ws: WebSocket,
  clusterId: string,
  workflowId: string,
  focus: string | null,
): Promise<void> {
  if (focus !== null && typeof focus !== 'string') {
    send(ws, { type: 'error', message: `cluster_member_focus_set rejected: invalid focus (must be string or null)` });
    return;
  }
  const updated = await clusterStore.setMemberFocus(clusterId, workflowId, focus).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_member_focus_set rejected: unknown_cluster_or_member` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  const stored = updated.memberFocuses?.[workflowId];
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} member ${workflowId.slice(0, 8)} focus ${stored ? `→ "${stored.slice(0, 40)}${stored.length > 40 ? '…' : ''}"` : 'cleared'}`);
}

// docs/PROTOCOL_CLUSTER.md - operator flipped the idle-nudger chip in
// the ClusterRightPanel header. Default OFF; enabling arms the detector,
// disabling tears it down (idempotent — the detector polls on a single
// timer and gates per-cluster via `isIdleNudgerEnabled`). Pushes a fresh
// cluster_state so every subscriber sees the new value.
export async function handleClusterIdleNudgerToggle(
  ws: WebSocket,
  clusterId: string,
  enabled: boolean,
): Promise<void> {
  const updated = await clusterStore.setIdleNudgerEnabled(clusterId, enabled === true).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_idle_nudger_toggle rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} idle-nudger ${enabled ? 'enabled' : 'disabled'}`);
}

// 2026-06-15 — operator set the cluster's efficiency level (+ optional
// doctrine addendum) from the ClusterRightPanel chip. Mirrors the idle-nudger
// handler: persist to meta.json, then push a fresh cluster_state so every
// subscriber sees the new level inline. The new level takes effect on each
// member's NEXT turn (in-flight turns untouched). Rejects unknown levels.
export async function handleClusterAutoCompactionSet(
  ws: WebSocket, clusterId: string, policy: import('@arco/shared').AutoCompactionPolicy | null,
): Promise<void> {
  const result = await clusterStore.setAutoCompactionWithChange(clusterId, policy).catch(() => null);
  if (!result) { send(ws, { type: 'error', message: 'Invalid auto-compaction policy or unknown cluster.' }); return; }
  if (!result.changed) return;
  const updated = result.state;
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  for (const workflowId of updated.members) broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content: policy ? `[AUTO-COMPACT] Cluster default ${policy.enabled ? `enabled at ${policy.thresholdPercent}%` : 'disabled'}; worker overrides remain in effect.` : '[AUTO-COMPACT] Cluster default cleared; worker overrides or legacy behavior apply.' });
}

export async function handleClusterEfficiencySet(
  ws: WebSocket,
  clusterId: string,
  level: ClusterEfficiencyLevel,
  addendum?: string,
  messageGuard?: import('@arco/shared').ClusterMessageGuard,
): Promise<void> {
  if (!isClusterEfficiencyLevel(level)) {
    send(ws, { type: 'error', message: `cluster_efficiency_set rejected: unknown_level` });
    return;
  }
  if (messageGuard !== undefined && !isClusterMessageGuard(messageGuard)) {
    send(ws, { type: 'error', message: 'cluster_efficiency_set rejected: invalid_message_guard' });
    return;
  }
  const updated = await clusterStore.setEfficiency(clusterId, level, addendum, messageGuard).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_efficiency_set rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} efficiency → ${level}${addendum !== undefined ? ' (addendum updated)' : ''}`);
}

// R3 (docs/REMOTE_MANAGEMENT.md) - operator flipped the cluster-level
// ◉ REMOTE chip. Persist, rebroadcast cluster_state, and re-push the hub
// snapshot immediately so the phone console reflects the flip without waiting
// for the 4s tick (mirrors the per-workflow remoteEnabled semantics).
export async function handleClusterRemoteSet(
  ws: WebSocket,
  clusterId: string,
  enabled: boolean,
): Promise<void> {
  const updated = await clusterStore.setRemoteEnabled(clusterId, enabled === true).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_remote_set rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  refreshHubReporting();
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} remote → ${enabled ? 'ON' : 'OFF'}`);
}

// 2026-07-18 (§9.2 follow-up) — operator flipped the cluster-level ⛨ GATES
// chip. Mirrors handleClusterRemoteSet: persist, rebroadcast, re-push the hub
// snapshot so per-gate `resolvable` bits flip on the phone at once.
export async function handleClusterGatesSet(
  ws: WebSocket,
  clusterId: string,
  enabled: boolean,
): Promise<void> {
  const updated = await clusterStore.setRemoteGatesEnabled(clusterId, enabled === true).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_gates_set rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  refreshHubReporting();
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} remote-gates → ${enabled ? 'ON' : 'OFF'}`);
}

// 2026-07-17 — operator drag-reordered the member grid. setMemberOrder
// validates the permutation; rebroadcast lets every surface re-render in the
// new order. Rejections are silent-ish (error to the sender only) — a stale
// drag is not worth a modal.
export async function handleClusterMemberReorder(
  ws: WebSocket,
  clusterId: string,
  memberIds: string[],
): Promise<void> {
  if (!Array.isArray(memberIds) || memberIds.some((m) => typeof m !== 'string')) {
    send(ws, { type: 'error', message: `cluster_member_reorder rejected: bad_payload` });
    return;
  }
  const updated = await clusterStore.setMemberOrder(clusterId, memberIds).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_member_reorder rejected: unknown_cluster_or_stale_order` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} members reordered`);
}

// 2026-06-29 — operator set the cluster's progress-tracking mode (plan / board
// / both) from the ClusterRightPanel chip. Mirrors handleClusterEfficiencySet:
// persist to meta.json, then push a fresh cluster_state so every subscriber
// sees the new mode inline. Takes effect on each member's NEXT turn (in-flight
// turns untouched). Rejects unknown modes.
export async function handleClusterProgressSet(
  ws: WebSocket,
  clusterId: string,
  mode: ClusterProgressMode,
): Promise<void> {
  if (!isClusterProgressMode(mode)) {
    send(ws, { type: 'error', message: `cluster_progress_set rejected: unknown_mode` });
    return;
  }
  const updated = await clusterStore.setProgressTracking(clusterId, mode).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_progress_set rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} progress-tracking → ${mode}`);
}

// docs/PROTOCOL_CLUSTER.md - operator flipped the auto-turn-on-mailbox
// chip in the ClusterRightPanel header. Default OFF; enabling arms the
// detector (which runs inline off broadcastWorkflow's peer_message_sent
// branch — no separate poll timer), disabling tears it down (idempotent —
// `isAutoTurnOnMailboxEnabled` returns false on the next event). Pushes a
// fresh cluster_state so every subscriber sees the new value.
export async function handleClusterAutoTurnToggle(
  ws: WebSocket,
  clusterId: string,
  enabled: boolean,
): Promise<void> {
  const updated = await clusterStore.setAutoTurnOnMailbox(clusterId, enabled === true).catch(() => null);
  if (!updated) {
    send(ws, { type: 'error', message: `cluster_auto_turn_toggle rejected: unknown_cluster` });
    return;
  }
  const payload = await buildClusterStatePayload(clusterId);
  if (payload) {
    broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
  }
  console.log(`[arco] cluster ${clusterId.slice(0, 8)} auto-turn-on-mailbox ${enabled ? 'enabled' : 'disabled'}`);
}

// docs/PROVIDERS.md - recompute the desired MCP wiring for a
// workflow from in-memory state (cluster membership + codebase-memory
// intent) and rewrite `.arco/<wfid>/mcp-config.json` accordingly. The
// writer unlinks the file when neither entry applies, so toggling both
// off leaves nothing on disk to poison a future CLI spawn. Used by attach
// / detach handlers and cluster-context-change paths where the workflow
// itself stays alive.
export async function syncMcpConfigForWorkflow(workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const cwd = wf.config.workingDirectory;
  if (!cwd) return;
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  const cbm = wf.config.codebaseMemory;
  const codebaseMemoryIndexPath = cbm?.attached === true
    ? (cbm.indexPath || cwd)
    : undefined;
  // §E1 — keep operator-enabled registry servers in the deterministically
  // rewritten file too, so toggling cluster/codebase-memory off-path doesn't
  // drop the registry entries. The dangerous-tool denials are only consumed
  // at turn time (CLI argv), so they aren't part of the on-disk config.
  let registryServers: import('@arco/shared').ResolvedMcpServer[] = [];
  try {
    const meta = await readMeta(cwd, workflowId);
    registryServers = (await resolveRegistryWiring(meta?.mcpAllow ?? [])).registryServers;
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] mcp registry resolve failed:`, err);
  }
  await mcpConfigWriter.writeFor(cwd, workflowId, {
    clusterId,
    taskBoardAttached: clusterId ? clusterStore.isTaskBoardAttached(clusterId) : false,
    port: PORT,
    codebaseMemoryIndexPath,
    registryServers,
  });
}

// ── Cluster snapshots (2026-06-12) ──────────────────────────────────────────
//
// Full save/list/restore/delete of a cluster's config + member histories.
// Mirrors the cluster-preset surface (clusterPresets.ts) but heavyweight: a
// snapshot captures every member's events.jsonl so restore reproduces full
// conversation history in a brand-new cluster (fork semantics — new ids).
//
// The on-disk + id-minting work lives in clusterSnapshots.ts; these handlers
// own the in-memory registration (workflows map + observers) + the broadcast
// that makes connected clients rehydrate the restored cluster.

// Re-push the full snapshot list to the requesting WS. Used after save/delete
// so the operator's list view stays current without a manual refresh.
async function sendSnapshotList(ws: WebSocket): Promise<void> {
  const snapshots = await clusterSnapshots.listSnapshots();
  send(ws, { type: 'cluster_snapshot_list', snapshots });
}

export async function handleClusterSnapshotSave(
  ws: WebSocket,
  msg: import('@arco/shared').ClusterSnapshotSaveMessage,
): Promise<void> {
  const cluster = await clusterStore.readCluster(msg.clusterId).catch(() => null);
  if (!cluster) {
    send(ws, { type: 'cluster_snapshot_error', op: 'save', message: `unknown cluster ${msg.clusterId.slice(0, 8)}` });
    return;
  }
  // Requester-is-member fence, mirroring the other cluster operator surfaces.
  if (!cluster.members.includes(msg.workflowId)) {
    send(ws, { type: 'cluster_snapshot_error', op: 'save', message: 'requester_not_member' });
    return;
  }
  // Refuse to snapshot mid-turn: saveSnapshot flushes the event buffer then
  // reads events.jsonl, but a busy member keeps appending, so the read could
  // capture a torn final line. A snapshot is a point-in-time capture; require a
  // quiescent cluster so the captured history is well-formed.
  const busyMember = cluster.members.find((wfid) => workflows.get(wfid)?.busy);
  if (busyMember) {
    send(ws, { type: 'cluster_snapshot_error', op: 'save', message: 'a member is mid-turn — wait for the cluster to be idle before saving' });
    return;
  }
  try {
    const memberConfigs = Object.fromEntries(
      cluster.members.flatMap((id) => {
        const config = workflows.get(id)?.config;
        return config ? [[id, structuredClone(config)] as const] : [];
      }),
    );
    const snapshot = await clusterSnapshots.saveSnapshot({
      clusterId: msg.clusterId,
      name: msg.name,
      memberConfigs,
      ...(msg.replaceSnapshotId ? { replaceSnapshotId: msg.replaceSnapshotId } : {}),
    });
    send(ws, { type: 'cluster_snapshot_saved', snapshot });
    await sendSnapshotList(ws);
    console.log(`[arco] cluster ${msg.clusterId.slice(0, 8)} snapshot saved → "${snapshot.name}" (${snapshot.memberCount} members)`);
  } catch (err) {
    if (err instanceof clusterSnapshots.SnapshotConflictError) {
      send(ws, {
        type: 'cluster_snapshot_conflict',
        clusterId: msg.clusterId,
        requestedName: msg.name.trim(),
        existing: err.existing,
      });
      return;
    }
    const message = err instanceof clusterSnapshots.SnapshotValidationError ? err.message : 'snapshot save failed';
    send(ws, { type: 'cluster_snapshot_error', op: 'save', message });
  }
}

export async function handleClusterSnapshotList(ws: WebSocket): Promise<void> {
  try {
    await sendSnapshotList(ws);
  } catch (err) {
    console.error('[arco] cluster_snapshot_list failed:', err);
    send(ws, { type: 'cluster_snapshot_error', op: 'list', message: 'snapshot list failed' });
  }
}

export async function handleClusterSnapshotDelete(
  ws: WebSocket,
  msg: import('@arco/shared').ClusterSnapshotDeleteMessage,
): Promise<void> {
  try {
    const removed = await clusterSnapshots.deleteSnapshot(msg.snapshotId);
    if (!removed) {
      send(ws, { type: 'cluster_snapshot_error', op: 'delete', message: `unknown snapshot ${msg.snapshotId.slice(0, 8)}` });
      return;
    }
    await sendSnapshotList(ws);
    console.log(`[arco] cluster snapshot ${msg.snapshotId.slice(0, 8)} deleted`);
  } catch (err) {
    console.error('[arco] cluster_snapshot_delete failed:', err);
    send(ws, { type: 'cluster_snapshot_error', op: 'delete', message: 'snapshot delete failed' });
  }
}

// Restore a snapshot into a fresh cluster. clusterSnapshots.restoreSnapshot
// does the on-disk work (mint ids, rewrite meta + events, register the cluster,
// reattach roles/tiers/focus/dispatcher/plan id). Here we register each restored
// member in the in-memory `workflows` map (so live broadcasts + rehydrate find
// them), attach the requesting WS as an observer, then broadcast cluster_created
// + cluster_state so the client opens the cluster tab and replays member history
// through its normal rehydrate path.
export async function handleClusterSnapshotRestore(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ClusterSnapshotRestoreMessage,
): Promise<void> {
  let result: Awaited<ReturnType<typeof clusterSnapshots.restoreSnapshot>>;
  try {
    result = await clusterSnapshots.restoreSnapshot(msg.snapshotId, msg.targetCwd, msg.turnsPerMember);
  } catch (err) {
    const message = err instanceof clusterSnapshots.SnapshotValidationError ? err.message : 'snapshot restore failed';
    send(ws, { type: 'cluster_snapshot_error', op: 'restore', message, snapshotId: msg.snapshotId });
    return;
  }

  const { cluster, members, targetCwd } = result;
  acquireProjectSettingsWatcher(targetCwd);

  // Register each restored member in the in-memory registry FIRST — no client
  // sends yet. The restored meta is the source of truth for the synthesized
  // WorkflowConfig (mirrors what handleRehydrateWorkflows builds).
  const memberConfigs = new Map<string, WorkflowConfig>();
  for (const member of members) {
    const m = member.meta;
    const captured = member.config ?? workflowConfigFromMeta(m, targetCwd);
    const config: WorkflowConfig = {
      ...captured,
      name: m.name,
      workingDirectory: targetCwd,
    };
    // Restores are always operator-inspected before any remote control is
    // re-armed. Cluster-level gates already override these while attached, but
    // clearing the member flags also makes a later detach safe.
    delete config.remoteEnabled;
    delete config.remoteGatesEnabled;
    // These are creation/resume commands, not durable worker settings. Letting
    // them ride a portable restore could fire a stale client workflow action or
    // reconnect the replacement to a machine-local provider session.
    delete config.researchSpawnToken;
    delete config.templateSpawnToken;
    delete config.resumeSessionId;
    delete config.resumeWorkflowId;
    const cascade = await readSettings(targetCwd).catch(() => null);
    applyAutoHandoffDefault(config, cascade?.autoHandoffDefaults);
    // Provider-session resume wiring — without it the restored chat window is
    // cosmetic: the member's NEXT turn starts a fresh provider session with no
    // memory of the restored conversation. Per transport:
    //  - claude Native ignores primarySessionId for context: it rebuilds the
    //    model's messages from the restored events.jsonl itself
    //    (replayMessagesFromEvents), so truncation depth = restored context.
    //  - claude CLI: `claude -p --resume <id>` FORKS into a fresh session
    //    file, so resuming the snapshot's last session is safe even while the
    //    original member is still open. Session files are keyed by cwd on
    //    disk, so only wire same-cwd restores (cross-cwd resume errors out).
    //  - codex: `exec resume <uuid>` APPENDS to the one thread — no fork — so
    //    only wire when the original member is no longer live; two live
    //    workflows pinned to one thread would interleave their turns.
    const lastCli = latestCliSessionFor(m, m.primaryProvider);
    let resumeSessionId: string | undefined;
    if (lastCli) {
      if (m.primaryProvider === 'claude' && targetCwd === result.sourceCwd) {
        resumeSessionId = lastCli.sessionId;
      } else if (m.primaryProvider === 'codex' && !workflows.has(member.oldWorkflowId)) {
        resumeSessionId = lastCli.sessionId;
      }
    }
    const newId = member.newWorkflowId;
    if (!workflows.has(newId)) {
      workflows.set(newId, {
        config,
        busy: false,
        manager: new WorkerManager(),
        primary: derivePrimaryConfig(config),
        ...(resumeSessionId ? { primarySessionId: resumeSessionId } : {}),
        queue: { steering: [], followUp: [] },
        observers: new Set([ws]),
        autoHandoff: deriveAutoHandoff(config),
        lastContextPercent: 0,
        previewHistory: [],
      });
    } else {
      workflows.get(newId)!.observers.add(ws);
    }
    workflowCwds.set(newId, targetCwd);
    session.workflowIds.add(newId);
    memberConfigs.set(newId, config);
  }

  // Re-create the plan in the target cwd when the snapshot carried a body but
  // the reattached plan id doesn't resolve there (restore into a new cwd).
  if (result.planBody && result.planBody.trim().length > 0 && !cluster.planId) {
    await setClusterPlanBody(cluster.clusterId, result.planBody).catch(() => { /* best-effort */ });
  }

  // GROUP FIRST — send cluster_created + cluster_state BEFORE streaming any
  // member history. LOAD-BEARING: a restored member's events.jsonl can be tens
  // of thousands of events; if we streamed those before cluster_created the
  // members would sit as STANDALONE tabs for the whole multi-second flood (and
  // never regroup if the operator closed the tab — the 2026-06-12 bug). With the
  // cluster registered first, each member created below is immediately a cluster
  // member and never appears standalone.
  session.clusterIds.add(cluster.clusterId);
  attachClusterObservers(ws, session, cluster.clusterId, cluster.members);
  const payload = await buildClusterStatePayload(cluster.clusterId);
  if (payload) {
    send(ws, { type: 'cluster_created', clusterId: cluster.clusterId, state: payload });
    broadcastCluster(cluster.clusterId, { type: 'cluster_state', clusterId: cluster.clusterId, state: payload });
  }

  // Now deliver each member: workflow_created builds the JobState, then ONE
  // replay_batch carries its whole compacted history. LOAD-BEARING that this
  // is a single message, not a stream of N live events: the client ingests
  // the batch in one synchronous task (run-to-completion), so its persisted
  // lastSeq can never outrun its persisted chat. Streaming let an interrupt
  // mid-flood persist lastSeq≈head with no messages — reconnect's
  // replay-since-seq then had nothing left to resend and the member rendered
  // as a permanently blank worker (2026-06-12). Skip the embedded
  // workflow_created line so the client's createJob isn't clobbered.
  for (const member of members) {
    const newId = member.newWorkflowId;
    const config = memberConfigs.get(newId)!;
    send(ws, { type: 'workflow_created', workflowId: newId, config });
    try {
      const events = (await replayEvents(targetCwd, newId, 0))
        .filter((ev) => (ev as { type?: string }).type !== 'workflow_created');
      if (events.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'replay_batch', workflowId: newId, events }));
      }
    } catch (err) {
      console.error(`[arco] restore replay failed for ${newId.slice(0, 8)}:`, err);
    }
  }
  console.log(`[arco] cluster ${cluster.clusterId.slice(0, 8)} restored from snapshot ${msg.snapshotId.slice(0, 8)} (${members.length} members → ${targetCwd})`);
}
