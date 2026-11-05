import { ensureProjectStateIgnore } from '../projectStateIgnore.js';
// Server fan-out + persistence primitives, the cluster-state notifier, and the
// per-cwd plans watcher. These three subsystems form one cohesive cyclic
// cluster (broadcastWorkflow -> notifyClusterStateForWorkflow -> plans watcher
// -> broadcastWorkflow), so they live together. Pulled out of index.ts in
// Phase 4 Milestone B; imports only leaf modules + ./state.js, never index.ts.
// See docs/ARCHITECTURE.md.

import { WebSocket } from 'ws';
import { observeConditionMessage } from '../voice/conditionFacts.js';
import { watch as fsWatch, mkdirSync, type FSWatcher } from 'fs';
import { basename, join } from 'path';
import type { ClusterTaskBoardMode, ServerMessage } from '@arco/shared';
import type { PlansWatcher, WorkflowState } from '../workflows/types.js';
import {
  sessions,
  workflows,
  workflowCwds,
  cwdHandoffChain,
  plansWatchers,
  clusterPlanWatcherCwds,
} from './state.js';
import { WS_BACKPRESSURE_DROP_BYTES } from './constants.js';
import { persistAndStampSeq } from '../workflowStore.js';
import { rememberPlanBody } from '../planHistory.js';
import { checkArtifactSizes, conversationWarnBytes, fileWarnBytes } from '../storageWarnings.js';
import { readMeta, updateMeta } from '../workflowMeta.js';
import { appendRecord, matchFileEvent, resolveMatchPath } from '../recentFilesLedger.js';
import { artifactsDir } from '../workers/limits.js';
import { closeOpenSpansForWorkflow, reconcilePlanFile, isValidPlanId } from '../planStore.js';
import * as clusterStore from '../clusterStore.js';
import { autoPickupStateFor } from '../smartPickup.js';
import { onSmartPickupMail } from '../smartPickupObserver.js';
import { isSmartPickupMode } from '@arco/shared';
import { workspaceCloseCluster, workspaceOpenCluster, workspaceOpenWorkflow } from '../workspace.js';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPlanBridge from '../clusterPlanBridge.js';
import * as clusterAutoTurn from '../clusterAutoTurn.js';
import * as clusterIdleNudger from '../clusterIdleNudger.js';
import * as attention from '../attention.js';
import * as notifications from '../notifications.js';
import { stopTurnSizes, watchTurnSizes } from '../storageTurnWatch.js';

export function handoffLockSnapshot(cwd: string): ServerMessage {
  const slot = cwdHandoffChain.get(cwd);
  const wf = slot ? workflows.get(slot.workflowId) : undefined;
  return {
    type: 'handoff_lock_snapshot',
    cwd,
    locks: slot
      ? [{
          workflowId: slot.workflowId,
          ...(wf?.config.name ? { workflowName: wf.config.name } : {}),
          ...(slot.handoffId ? { handoffId: slot.handoffId } : {}),
          status: slot.handoffId ? 'running' : 'preparing',
          startedAt: slot.startedAt,
        }]
      : [],
  };
}

export function broadcastHandoffLockSnapshot(cwd: string): void {
  const payload = JSON.stringify(handoffLockSnapshot(cwd));
  for (const ws of sessions.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function sendAllHandoffLockSnapshots(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const cwds = new Set(cwdHandoffChain.keys());
  for (const cwd of cwds) ws.send(JSON.stringify(handoffLockSnapshot(cwd)));
}

export function isLossyEventType(t: string): boolean {
  return t === 'worker_thinking';
}

function recordIncognitoEvent(workflowId: string, message: ServerMessage): void {
  const wf = workflows.get(workflowId);
  const events = wf?.incognitoEvents;
  if (!wf?.config.incognito || !events) return;
  if (!(wf.config.voiceOperator && message.type === 'primary_tool_use') && message.type !== 'user_message_echo'
      && message.type !== 'primary_text'
      && message.type !== 'primary_thinking'
      && message.type !== 'primary_complete') return;
  const last = events[events.length - 1];
  if (message.type === 'primary_text' && last?.type === 'primary_text' && last.phase === message.phase) {
    last.text += message.text;
    return;
  }
  if (message.type === 'primary_thinking' && last?.type === 'primary_thinking') {
    last.text += message.text;
    return;
  }
  events.push({ ...message });
}

// ARCHIVE (docs/CLIENT.md) - feed the agent-writes ledger from the
// persisting broadcast chokepoints. Both send() (workflow-scoped operator
// turns: Native Write/Edit/NotebookEdit ride here) and broadcastWorkflow()
// (Review artifacts, media results) call this after stamping. Pure match →
// resolve → fire-and-forget append; a non-file event returns immediately, so
// the hot primary_text path pays one type check. Never throws (appendRecord
// swallows its own errors).
function recordFilesLedger(workflowId: string, msg: ServerMessage): void {
  const match = matchFileEvent(msg);
  if (!match) return;
  const cwd = workflowCwds.get(workflowId);
  if (!cwd) return;
  const wf = workflows.get(workflowId);
  const abs = resolveMatchPath(match, cwd, artifactsDir(cwd, workflowId));
  void appendRecord({
    ts: Date.now(),
    path: abs,
    op: match.op,
    workflowId,
    tabTitle: wf?.config.name || workflowId.slice(0, 8),
    provider: wf?.config.primaryProvider || 'unknown',
    tool: match.tool,
    project: basename(cwd),
  });
}

// stash the latest context_usage on the workflow so the hub link
// reports the exact numbers the desktop CTX chip shows. One hook covering both
// fan-outs beats touching every per-provider emit site.
export function recordContextUsage(workflowId: string, message: ServerMessage): void {
  if (message.type === 'codex_token_snapshot') {
    const wf = workflows.get(workflowId);
    const window = message.modelContextWindow;
    if (wf?.config.voiceOperator && typeof window === 'number' && window > 0) {
      wf.lastContextUsage = { tokens: message.tokens.input, window, percent: message.tokens.input / window * 100 };
    }
    return;
  }
  if (message.type !== 'context_usage') return;
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const m = message as { estimatedTokens?: number; windowSize?: number; percentOfWindow?: number };
  if (typeof m.estimatedTokens !== 'number' || typeof m.windowSize !== 'number') return;
  wf.lastContextUsage = {
    tokens: m.estimatedTokens,
    window: m.windowSize,
    percent: typeof m.percentOfWindow === 'number' ? m.percentOfWindow : 0,
  };
}

export function send(ws: WebSocket, message: ServerMessage): void {
  // Persist workflow-scoped messages BEFORE checking ws state. events.jsonl
  // is the authoritative log; a closed socket must not lose events (replay
  // on reconnect rebuilds the client from the log). Previously the
  // readyState guard short-circuited persist too — interjection-drain
  // events emitted against a disconnected ws vanished.
  const wfid = (message as { workflowId?: string }).workflowId;
  let stamped = message;
  if (typeof wfid === 'string') {
    const source = workflows.get(wfid);
    if (source && !source.config.incognito && !source.config.voiceOperator) observeConditionMessage(wfid, clusterStore.getClusterIdForWorkflow(wfid), message);
    recordIncognitoEvent(wfid, message);
    recordContextUsage(wfid, message);
    // Operator turns, auto-pickup turns and peer-mail turns all report their
    // start and end through send(), so turn boundaries are observed here as
    // well as in broadcastWorkflow. Plain request errors are left out: they
    // answer one request and are not a failed turn.
    if (source && message.type !== 'error') observeTurnBoundary(wfid, source, message);
    const cwd = workflowCwds.get(wfid);
    // Skip persistence for reasoning events from local thinking models.
    // Qwen3.6 et al emit thousands of reasoning tokens per turn; persisting
    // every one bloats events.jsonl 5-10x with no replay benefit (Layer 2's
    // deterministic summary captures cross-turn state, and the legacy
    // <think>...</think> isn't fed back across turns for llama.cpp). Live
    // stream still fans out to observers below — operators see thinking
    // happen in real time, just don't see a wall of it on page reload.
    const provForThinking = workflows.get(wfid)?.primary.provider;
    const isLocalThinking =
      message.type === 'primary_thinking'
      && (provForThinking === 'llamacpp' || provForThinking === 'lmstudio');
    if (cwd && !isLocalThinking) {
      stamped = persistAndStampSeq(cwd, wfid, message);
    }
    // ARCHIVE — agent-writes ledger. Native Write/Edit/NotebookEdit tool events
    // ride the operator turn through send(); record them here.
    recordFilesLedger(wfid, stamped);
    // Fan out to every observer of this workflow. Multi-observer so a
    // second browser window attached to the same workflowId also sees the
    // stream; previously the single-slot pointer got overwritten on the
    // second attach and the first window went silent.
    const wf = workflows.get(wfid);
    const observers = wf?.observers;
    const lossy = isLossyEventType(stamped.type);
    if (observers && observers.size > 0) {
      const payload = JSON.stringify(stamped);
      for (const obs of observers) {
        if (obs.readyState !== WebSocket.OPEN) continue;
        if (lossy && obs.bufferedAmount > WS_BACKPRESSURE_DROP_BYTES) continue;
        obs.send(payload);
      }
    } else if (ws.readyState === WebSocket.OPEN) {
      // Fallback: the workflow entry was removed or the registry is stale.
      // Deliver to the originating ws so producers don't swallow errors.
      if (!(lossy && ws.bufferedAmount > WS_BACKPRESSURE_DROP_BYTES)) {
        ws.send(JSON.stringify(stamped));
      }
    }
    // Tab-open chokepoint for the server-authoritative workspace: create,
    // resume, spawn, handoff, bake-off and genesis all announce through here.
    // After the fan-out so the creating browser sees workflow_created before
    // workspace_changed. Incognito / malformed configs are filtered inside.
    if (stamped.type === 'workflow_created') {
      workspaceOpenWorkflow(wfid, stamped.config, stamped.parentWorkflowId);
    }
    return;
  }
  // Non-workflow messages (connected, quota_status, etc.) deliver to the
  // originating ws only.
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(stamped));
  if (stamped.type === 'cluster_created') workspaceOpenCluster(stamped.clusterId);
}

// Fan out to all observers WITHOUT persisting to events.jsonl. Used for
// session_entry messages (Phase 1) which are derived from Claude's own
// session JSONL — redundant to persist since they're re-emitted on every
// reconnect by restarting the watcher.
export function broadcastTransient(workflowId: string, message: ServerMessage): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  if (!wf.config.incognito && !wf.config.voiceOperator) observeConditionMessage(workflowId, clusterStore.getClusterIdForWorkflow(workflowId), message);
  recordContextUsage(workflowId, message);
  const payload = JSON.stringify(message);
  for (const obs of wf.observers) {
    if (obs.readyState === WebSocket.OPEN) obs.send(payload);
  }
}

export function ensureClusterPlansWatcher(clusterId: string, cwd: string): void {
  if (!cwd) return;
  const existing = clusterPlanWatcherCwds.get(clusterId);
  if (existing === cwd) return;
  if (existing) releasePlansWatcher(existing);
  acquirePlansWatcher(cwd);
  clusterPlanWatcherCwds.set(clusterId, cwd);
}

export function releaseClusterPlansWatcher(clusterId: string): void {
  const cwd = clusterPlanWatcherCwds.get(clusterId);
  if (!cwd) return;
  clusterPlanWatcherCwds.delete(clusterId);
  releasePlansWatcher(cwd);
}

export function plansDir(cwd: string): string {
  return join(cwd, '.arco', 'plans');
}

export function acquirePlansWatcher(cwd: string): void {
  if (!cwd) return;
  const existing = plansWatchers.get(cwd);
  if (existing) {
    existing.refCount += 1;
    return;
  }
  const dir = plansDir(cwd);
  // Make sure the directory exists — fsWatch errors with ENOENT if it
  // doesn't, and a brand-new workspace might have plans/ missing until the
  // first POST creates it. (Idempotent; we don't await elsewhere.)
  try { ensureProjectStateIgnore(cwd); fsWatchEnsureDir(dir); } catch { /* fall through; watch will surface error */ }
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(dir, { persistent: false });
  } catch (err) {
    console.error(`[arco] plans watcher start failed for ${dir}:`, err);
    return;
  }
  const state: PlansWatcher = {
    watcher,
    refCount: 1,
    pending: new Set(),
    timer: null,
    skipNext: new Set(),
  };
  watcher.on('change', (_event, filename) => {
    const name = typeof filename === 'string' ? filename : filename?.toString();
    if (!name || !name.endsWith('.md')) return;
    const planId = name.slice(0, -3);
    if (!isValidPlanId(planId)) return;
    state.pending.add(planId);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => flushPlansWatcher(cwd, state), 200);
  });
  watcher.on('error', (err) => {
    console.error(`[arco] plans watcher error for ${dir}:`, err);
  });
  plansWatchers.set(cwd, state);
}

export function releasePlansWatcher(cwd: string): void {
  const state = plansWatchers.get(cwd);
  if (!state) return;
  state.refCount -= 1;
  if (state.refCount > 0) return;
  if (state.timer) clearTimeout(state.timer);
  try { state.watcher.close(); } catch { /* already closed */ }
  plansWatchers.delete(cwd);
}

// Best-effort sync mkdir. Avoids racing the watcher's startup against a
// brand-new directory; the cost is one stat-on-mkdir-EEXIST per acquire
// which is negligible.
export function fsWatchEnsureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export async function flushPlansWatcher(cwd: string, state: PlansWatcher): Promise<void> {
  state.timer = null;
  const planIds = [...state.pending];
  state.pending.clear();
  for (const planId of planIds) {
    if (state.skipNext.has(planId)) {
      state.skipNext.delete(planId);
      continue;
    }
    try {
      const result = await reconcilePlanFile(cwd, planId);
      if (result.kind === 'updated') {
        // Tell every workflow attached to this plan that its body bumped.
        // The Plan tab refetches body + list when plan?.updatedAt advances.
        for (const [wfid, wf] of workflows) {
          if (wf.planId !== planId) continue;
          if (workflowCwds.get(wfid) !== cwd) continue;
          broadcastWorkflow(wfid, {
            type: 'plan_attached',
            workflowId: wfid,
            planId: result.summary.id,
            title: result.summary.title,
            updatedAt: result.summary.updatedAt,
          });
        }
        for (const cid of clusterStore.listKnownClusterIds()) {
          const cluster = await clusterStore.readCluster(cid).catch(() => null);
          if (!cluster || cluster.cwd !== cwd || cluster.planId !== planId) continue;
          const payload = await buildClusterStatePayload(cid);
          if (payload) broadcastCluster(cid, { type: 'cluster_state', clusterId: cid, state: payload });
        }
      } else if (result.kind === 'deleted') {
        // The agent (or operator) rm'd the file from under us. Detach every
        // attached workflow, mirroring the cleanup buildPlanPrefix already
        // does when readPlan returns null mid-turn.
        for (const [wfid, wf] of workflows) {
          if (wf.planId !== planId) continue;
          if (workflowCwds.get(wfid) !== cwd) continue;
          wf.planId = undefined;
          try {
            await updateMeta(cwd, wfid, (meta) => {
              if (!meta.planId) return false;
              delete meta.planId;
              delete meta.planLastSeenUpdatedAt;
            });
          } catch { /* meta missing — nothing to clear */ }
          await closeOpenSpansForWorkflow(cwd, wfid).catch(() => { /* best-effort */ });
          broadcastWorkflow(wfid, { type: 'plan_detached', workflowId: wfid });
          releasePlansWatcher(cwd);
        }
        for (const cid of clusterStore.listKnownClusterIds()) {
          const cluster = await clusterStore.readCluster(cid).catch(() => null);
          if (!cluster || cluster.cwd !== cwd || cluster.planId !== planId) continue;
          await clusterStore.clearPlanId(cid).catch(() => null);
          releaseClusterPlansWatcher(cid);
          const payload = await buildClusterStatePayload(cid);
          if (payload) broadcastCluster(cid, { type: 'cluster_state', clusterId: cid, state: payload });
        }
      }
    } catch (err) {
      console.error(`[arco] reconcile failed for ${cwd}/.arco/plans/${planId}.md:`, err);
    }
  }
}

async function reportArtifactSizes(workflowId: string, cwd: string): Promise<void> {
  try {
    const items = await checkArtifactSizes(join(cwd, '.arco', 'workflows', workflowId));
    if (items.length) {
      broadcastWorkflow(workflowId, {
        type: 'storage_warning', workflowId, items,
        fileThresholdBytes: fileWarnBytes(), conversationThresholdBytes: conversationWarnBytes(),
      });
    }
  } catch (err) {
    console.error(`[arco] artifact size check failed for ${workflowId.slice(0, 8)}:`, err);
  }
}

// Turn state per workflow as last seen by observeTurnBoundary. A STOP sends
// primary_turn_ended itself and the killed worker's settled path sends a
// second one; a start or end already seen is not acted on twice. An end with
// no recorded start (a turn begun before a restart) still runs the end hooks.
const turnBoundaryState = new Map<string, 'open' | 'closed'>();

// Everything that happens at a turn's start and end, called from both fan-out
// paths so a turn is seen whichever one carries its start and end:
// turn-finished, failed and waiting alerts (attention.ts), the long-turn notice
// (notifications.ts, §J1), artifact size checks during and after the turn
// (storageTurnWatch.ts, P7.4), the idle nudger's busy/idle baseline, the
// auto-turn chain-depth marker and the auto-pickup idle-resume sweep
// (docs/PROTOCOL_CLUSTER.md).
function observeTurnBoundary(workflowId: string, wf: WorkflowState, message: ServerMessage): void {
  // attention.ts sees every message (questions, gates and errors too) and
  // ignores a repeated start or end itself.
  attention.observeAttention(workflowId, message, { name: wf.config.name ?? '', incognito: !!wf.config.incognito });
  if (message.type === 'primary_turn_started') {
    if (turnBoundaryState.get(workflowId) === 'open') return;
    turnBoundaryState.set(workflowId, 'open');
    onTurnStarted(workflowId, wf);
  } else if (message.type === 'primary_turn_ended') {
    if (turnBoundaryState.get(workflowId) === 'closed') return;
    turnBoundaryState.set(workflowId, 'closed');
    onTurnEnded(workflowId, wf);
  }
}

function onTurnStarted(workflowId: string, wf: WorkflowState): void {
  // Feed the idle-nudger detector's busy/idle baseline. The detector runs on
  // its own polling timer; this clears idleSince and resets the per-turn
  // nudge counter.
  clusterIdleNudger.onMemberTurnStarted(workflowId);
  clusterAutoTurn.onMemberTurnStarted(workflowId);
  if (wf.config.incognito) return;
  // §J1 long-turn notice: onTurnEnded emits one if the turn ran long.
  notifications.onTurnStarted(workflowId);
  const cwd = workflowCwds.get(workflowId);
  // A closed tab stops its check at the next tick.
  if (cwd) watchTurnSizes(workflowId, async () => { if (workflows.has(workflowId)) await reportArtifactSizes(workflowId, cwd); else stopTurnSizes(workflowId); });
}

function onTurnEnded(workflowId: string, wf: WorkflowState): void {
  stopTurnSizes(workflowId);
  clusterIdleNudger.onMemberTurnEnded(workflowId);
  // P7.4: warn once about very large artifacts written during the turn.
  const cwd = workflowCwds.get(workflowId);
  if (!wf.config.incognito) {
    if (cwd) void reportArtifactSizes(workflowId, cwd);
    notifications.onTurnEnded(workflowId, { provider: wf.config.primaryProvider, workflowName: wf.config.name });
  }
  // Clear the in-flight auto-turn depth marker once the recipient's turn
  // ends. The next operator turn starts at depth 0; the next auto-turn
  // dispatch re-sets the marker.
  clusterAutoTurn.clearAutoTurnDepth(workflowId);
  // Idle-resume sweep for auto-pickup. If peer messages arrived while this
  // member was mid-turn, the detector emitted `recipient_busy` skips and
  // nothing else re-fires when the turn ends, so fan-in directors get stuck
  // until the operator nudges. Re-enter the detector with the chain depth of
  // that mail and let its depth, cooldown, rate-cap and busy guards do the
  // gating. Gated on the cluster's auto-pickup setting so the off path stays a
  // map lookup.
  const endedClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!endedClusterId) return;
  if (isSmartPickupMode(clusterStore.getAutoPickupMode(endedClusterId))) {
    setImmediate(() => { void onSmartPickupMail(endedClusterId, workflowId).catch(() => undefined); });
  }
  if (clusterStore.isAutoTurnOnMailboxEnabled(endedClusterId)) {
    setImmediate(() => {
      void (async () => {
        const pending = await clusterMailbox.peek(workflowId).catch(() => []);
        if (pending.length === 0) return;
        clusterAutoTurn.onPeerMessageSent({
          clusterId: endedClusterId,
          senderWfid: pending[0].fromWorkflowId,
          recipientWfid: workflowId,
          incomingChainDepth: clusterAutoTurn.pendingChainDepth(workflowId),
        });
      })();
    });
  }
}

export function broadcastWorkflow(workflowId: string, message: ServerMessage): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  if (!wf.config.incognito && !wf.config.voiceOperator) observeConditionMessage(workflowId, clusterStore.getClusterIdForWorkflow(workflowId), message);
  // docs/PROTOCOL_CLUSTER.md - stamp chainDepth on outbound
  // peer_message_sent BEFORE persistAndStampSeq runs. The marker is set by
  // clusterAutoTurn.markAutoTurnDepth (via onPeerMessageSent's fire path)
  // and cleared on primary_turn_ended. peerOps doesn't know about
  // auto-turns (strict editing-lane fence), so the stamping happens here.
  // Operator-initiated turns have no marker → chainDepth = 0.
  let outgoing: ServerMessage = message;
  if (message.type === 'peer_message_sent') {
    const depth = clusterAutoTurn.currentAutoTurnDepth(workflowId);
    if (typeof (message as { chainDepth?: number }).chainDepth !== 'number') {
      outgoing = { ...message, chainDepth: depth };
    }
  }
  observeTurnBoundary(workflowId, wf, message);
  recordIncognitoEvent(workflowId, outgoing);
  const cwd = workflowCwds.get(workflowId);
  const stamped = cwd ? persistAndStampSeq(cwd, workflowId, outgoing) : outgoing;
  // ARCHIVE — agent-writes ledger. Review artifacts + media-op results ride
  // broadcastWorkflow(); record them here (Native tool writes ride send()).
  recordFilesLedger(workflowId, stamped);
  if (wf.observers.size > 0) {
    const payload = JSON.stringify(stamped);
    for (const obs of wf.observers) {
      if (obs.readyState === WebSocket.OPEN) obs.send(payload);
    }
  }
  // docs/PROTOCOL_CLUSTER.md - push cluster_state to subscribers when a
  // workflow-scoped event has changed something the cluster tab cares about
  // (member busy state, mailbox depth). Per-message gate keeps the fan-out
  // tight: a `primary_text` chunk every few hundred ms would otherwise
  // generate a cluster_state per delta with no observable change.
  if (CLUSTER_STATE_TRIGGERS.has(message.type)) {
    void notifyClusterStateForWorkflow(workflowId);
  }
  // docs/PROTOCOL_CLUSTER.md - invoke the auto-turn detector on every
  // peer_message_sent that lands. The detector reads the cluster toggle
  // and the three guards (cooldown / rate cap / depth cap) inline; OFF
  // clusters short-circuit at the first lookup.
  if (outgoing.type === 'task_ledger_event' || outgoing.type === 'cluster_plan_changed') {
    const changedClusterId = clusterStore.getClusterIdForWorkflow(workflowId);
    if (changedClusterId) clusterAutoTurn.rulePickupWorkChanged(changedClusterId);
  }
  if (outgoing.type === 'peer_message_sent') {
    const peerMsg = outgoing as { from: string; to: string; chainDepth?: number };
    const clusterId = clusterStore.getClusterIdForWorkflow(peerMsg.from);
    if (clusterId) {
      clusterAutoTurn.onPeerMessageSent({
        clusterId,
        senderWfid: peerMsg.from,
        recipientWfid: peerMsg.to,
        incomingChainDepth: peerMsg.chainDepth ?? 0,
      });
      if (isSmartPickupMode(clusterStore.getAutoPickupMode(clusterId))) void onSmartPickupMail(clusterId, peerMsg.to, peerMsg.chainDepth ?? 0).catch(() => undefined);
    }
  }
}

// docs/PROTOCOL_CLUSTER.md - workflow-scoped events that may have
// changed cluster_state. busy flips on turn_started/ended; mailbox depth
// flips on peer_message_sent/received (sent → recipient depth +1; received →
// recipient depth 0 since drain consumed the file).
export const CLUSTER_STATE_TRIGGERS = new Set<ServerMessage['type']>([
  'primary_turn_started',
  'primary_turn_ended',
  'peer_message_sent',
  'peer_message_received',
  'cluster_auto_turn_fired',
]);

// docs/PROTOCOL_CLUSTER.md - fan out to every WS whose Session.clusterIds
// contains the target id. Cluster events do NOT persist to events.jsonl;
// the durable record lives in each member's events.jsonl (peer_message_*),
// the on-disk cluster meta (members), and the mailbox files (depth). The
// cluster_state push is a derived snapshot the client mirrors verbatim.
export function broadcastCluster(clusterId: string, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const [ws, sess] of sessions.entries()) {
    if (!sess.clusterIds.has(clusterId)) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  if (message.type === 'cluster_deleted') workspaceCloseCluster(clusterId);
  // Cluster fan-out is live-push only — no seq, no events.jsonl. That is fine
  // for state pushes the client rebuilds on subscribe (cluster_state), but
  // `cluster_plan_changed` is an AUDIT record: it says the shared plan every
  // member reads in its system prompt was rewritten. It was documented as
  // landing in events.jsonl (see the client's no-op handler, and peerTools.ts's
  // "the event still lands in the sender's events.jsonl" fallback) but never
  // did, so a plan rewrite left no durable trace of what it replaced.
  //
  // Mirror it per member so the audit is real. The client handler is a no-op,
  // so the duplicate delivery to a client subscribed to both scopes is inert.
  if (message.type === 'cluster_plan_changed') {
    clusterAutoTurn.rulePickupWorkChanged(clusterId);
    const members = clusterStore.getMembers(clusterId) ?? [];
    // P7.2: the audit copy carries the body's hash; the body itself is
    // stored once in the project's plan history (never deleted with plans).
    const hashes = new Map<string, string | null>();
    for (const wfid of members) broadcastWorkflow(wfid, planAuditCopy(message, workflowCwds.get(wfid), hashes));
  }
}

function planAuditCopy(
  message: Extract<ServerMessage, { type: 'cluster_plan_changed' }>,
  cwd: string | undefined,
  hashes: Map<string, string | null>,
): ServerMessage {
  if (!cwd || !message.body) return message;
  let hash = hashes.get(cwd);
  if (hash === undefined) { hash = rememberPlanBody(cwd, message.body); hashes.set(cwd, hash); }
  if (!hash) return message;
  const { body: _body, ...rest } = message;
  void _body;
  return { ...rest, bodySha256: hash };
}

// Live-only fan-out to a workflow's open tabs: no sequence number, nothing
// written to events.jsonl. For full task-board copies (P7.2): the board lives
// in the ledger store, reconnecting tabs get a fresh copy
// (sendTaskLedgerSnapshot / task_ledger_list), and recovery folds the
// persisted task_ledger_event records.
export function sendWorkflowLive(workflowId: string, message: ServerMessage): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const payload = JSON.stringify(message);
  for (const obs of wf.observers) {
    if (obs.readyState === WebSocket.OPEN) obs.send(payload);
  }
}

export async function buildClusterStatePayload(clusterId: string): Promise<{
  clusterId: string;
  cwd: string;
  members: Array<{
    workflowId: string;
    displayName: string;
    status: 'idle' | 'busy';
    role?: string;
    tier?: clusterStore.MemberTier;
    focus?: string;
    accessMode?: import('@arco/shared').ClusterMemberAccessMode;
  }>;
  mailboxDepth: Record<string, number>;
  createdAt: string;
  taskBoardMode: ClusterTaskBoardMode;
  taskBoardKey?: string;
  taskBoardAttached: boolean;
  name?: string;
  plan?: { id: string; title: string; body: string; updatedAt: number };
  idleNudgerEnabled?: boolean;
  autoTurnOnMailboxEnabled?: boolean;
  autoPickup?: import('@arco/shared').ClusterAutoPickupState;
  autoCompaction?: import('@arco/shared').AutoCompactionPolicy;
  efficiencyLevel?: clusterStore.ClusterEfficiencyLevel;
  efficiencyAddendum?: string;
  messageGuard?: import('@arco/shared').ClusterMessageGuard;
  progressTracking?: clusterStore.ClusterProgressMode;
  dispatcher?: ReturnType<typeof clusterStore.normalizeTaskDispatcherSettings>;
} | null> {
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) return null;
  // resolve each member's displayName with a disk fallback to
  // meta.name when the workflow object isn't loaded into memory yet. Race
  // pattern: on first cluster_subscribe after server restart, some cluster
  // members may not have been rehydrated via handleRehydrateWorkflows yet
  // (e.g. members not in the client's localStorage). displayNameFor would
  // fall back to the wfid 8-char prefix for those, and the initial
  // cluster_state would ship with missing names. Reading meta.name from
  // disk closes the gap. Members already in memory keep the synchronous
  // path; only the cold members pay the meta.json read.
  const members = await Promise.all(state.members.map(async (wfid) => {
    const wf = workflows.get(wfid);
    const role = clusterStore.getMemberRole(clusterId, wfid);
    const tier = state.memberTiers?.[wfid];
    const focus = state.memberFocuses?.[wfid];
    const accessMode = clusterStore.getMemberAccessMode(clusterId, wfid);
    let displayName = clusterStore.displayNameFor(wfid);
    if (!wf && displayName === wfid.slice(0, 8)) {
      const meta = await readMeta(state.cwd, wfid).catch(() => null);
      if (meta?.name && meta.name.trim().length > 0) {
        displayName = meta.name.trim();
      }
    }
    return {
      workflowId: wfid,
      displayName,
      status: (wf?.busy ? 'busy' : 'idle') as 'idle' | 'busy',
      ...(role && role.length > 0 ? { role } : {}),
      ...(tier ? { tier } : {}),
      ...(focus && focus.length > 0 ? { focus } : {}),
      ...(accessMode !== 'standard' ? { accessMode } : {}),
    };
  }));
  const mailboxDepth: Record<string, number> = {};
  for (const wfid of state.members) {
    mailboxDepth[wfid] = await clusterMailbox.depthFor(wfid).catch(() => 0);
  }
  // Unified plans — surface the active per-cwd plan body in the cluster
  // state push so the client doesn't need a separate fetch. This also lazily
  // migrates legacy ~/.arco/clusters/<id>/plan.md bodies into
  // <cwd>/.arco/plans/.
  const planRec = await clusterPlanBridge.readClusterPlan(clusterId).catch(() => null);
  if (planRec) {
    ensureClusterPlansWatcher(clusterId, state.cwd);
  } else {
    releaseClusterPlansWatcher(clusterId);
  }
  return {
    clusterId,
    cwd: state.cwd,
    members,
    mailboxDepth,
    createdAt: state.createdAt,
    taskBoardMode: clusterStore.normalizeTaskBoardMode(state),
    ...(clusterStore.taskBoardKeyForState(state) ? { taskBoardKey: clusterStore.taskBoardKeyForState(state) } : {}),
    taskBoardAttached: clusterStore.isTaskBoardEnabledForState(state),
    name: state.name,
    ...(planRec ? { plan: { id: planRec.planId, title: planRec.title, body: planRec.body, updatedAt: planRec.updatedAt } } : {}),
    ...(state.idleNudgerEnabled ? { idleNudgerEnabled: true } : {}),
    ...(clusterStore.autoPickupModeOf(state) === 'rule' ? { autoTurnOnMailboxEnabled: true } : {}),
    autoPickup: await autoPickupStateFor(state),
    // efficiency level echo. Absent ≡ thorough (default); only
    // emitted when non-default so pre-feature clients/snapshots stay clean.
    ...(state.autoCompaction ? { autoCompaction: state.autoCompaction } : {}),
    ...(state.efficiencyLevel && state.efficiencyLevel !== 'thorough' ? { efficiencyLevel: state.efficiencyLevel } : {}),
    messageGuard: clusterStore.getMessageGuard(clusterId),
    ...(state.efficiencyAddendum && state.efficiencyAddendum.length > 0 ? { efficiencyAddendum: state.efficiencyAddendum } : {}),
    // progress-tracking echo. Absent ≡ 'both' (default); only
    // emitted when non-default so pre-feature clients/snapshots stay clean.
    ...(state.progressTracking && state.progressTracking !== 'both' ? { progressTracking: state.progressTracking } : {}),
    // R3 — cluster-level remote opt-in echo (◉ REMOTE chip). Absent ≡ OFF.
    ...(state.remoteEnabled ? { remoteEnabled: true } : {}),
    // cluster-level gates arming echo (⛨ GATES chip). Absent ≡ OFF.
    ...(state.remoteGatesEnabled ? { remoteGatesEnabled: true } : {}),
    dispatcher: clusterStore.normalizeTaskDispatcherSettings(state.dispatcher),
  };
}

export async function notifyClusterStateForWorkflow(workflowId: string): Promise<void> {
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (!clusterId) return;
  const payload = await buildClusterStatePayload(clusterId);
  if (!payload) return;
  broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
}
