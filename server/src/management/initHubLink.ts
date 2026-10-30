// Workflow-reporting layer — wires the real Arco turn engine to the hub link.
// This is the ONLY file that couples the hub link to server internals; the
// connector (hubLink.ts) stays turn-engine-free and independently smoke-tested.
//
// INERT BY DEFAULT: does nothing unless ARCO_HUB_URL is set, so an ordinary
// `npm run dev` / production boot is unchanged. When set, the live Arco
// registers to the hub as a 'service', pushes its workflow snapshot, and applies
// routed reply/stop/continue actions — re-validating against current state.

import { WebSocket } from 'ws';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { workflows, workflowCwds } from '../server/state.js';
import { handleUserMessage } from '../ws/turnEngine.js';
import { handleCancel, handleCancelQueuedMessage } from '../ws/workflowHandlers.js';
import { handleHandoffRequest } from '../ws/handoffHandlers.js';
import { handleCompactWorkflow, handleFoldWorkflow } from '../ws/compactHandlers.js';
import { resolveOrphanedGate } from '../ws/gateHandlers.js';
// NOTE: clusterHandlers imports refreshHubReporting from this module — a
// deliberate ESM cycle; both sides only touch the other's exports at call
// time (function bindings), never during module evaluation.
import {
  handleClusterBroadcast,
  handleClusterEfficiencySet,
  handleClusterIdleNudgerToggle,
  handleClusterAutoTurnToggle,
  handleOperatorPeerSend,
} from '../ws/clusterHandlers.js';
import { handleTaskLedgerUpdate } from '../ws/taskLedgerHandlers.js';
import {
  getClaudeNativePendingInteractions,
  routeClaudeNativeGateReply,
  routeClaudeNativeQuestionReply,
} from '../providers/claude-native/index.js';
import {
  completeBootstrap as claudeNativeCompleteBootstrap,
  getClaudeAuthProblem,
  setClaudeAuthProblemNotifier,
  startBootstrap as claudeNativeStartBootstrap,
} from '../providers/claude-native/oauth.js';
import { emit as emitWorkbenchNotice } from '../notifications.js';
import {
  getClusterCached,
  getClusterIdForWorkflow,
  isClusterGatesRemoteEnabled,
  isClusterRemoteEnabled,
  listKnownClusterIds,
  normalizeTaskBoardMode,
  taskBoardKeyForState,
} from '../clusterStore.js';
import { buildClusterStatePayload } from '../server/broadcast.js';
import { peek as peekMailbox, depthFor as mailboxDepthFor } from '../clusterMailbox.js';
import { readClusterPlan } from '../clusterPlanBridge.js';
import { mergeActivity, readMemberActivity } from './clusterActivity.js';
import * as taskLedger from '../project/taskLedger.js';
import type { Session, WorkflowState } from '../workflows/types.js';
import type {
  ClusterActionRequest,
  ClusterActionResult,
  ClusterMailboxEntry,
  ClusterReadKind,
  ClusterReadResponseMessage,
  ClusterSummary,
  InstanceActionRequest,
  InstanceActionResult,
  InstanceRollup,
  LedgerTaskStatus,
} from '@arco/shared';
import type {
  TranscriptTurn,
  WorkflowActionRequest,
  WorkflowActionResult,
  WorkflowSummary,
} from '@arco/shared';
import { createHubLink, type HubLink } from './hubLink.js';
import { buildServiceInstanceDescriptor } from './identity.js';

// Bounded read of the events.jsonl tail. Generous because ledger-snapshot
// events (task_ledger_snapshot can be large + frequent) crowd the tail and push
// the last assistant message back; 1MB covers a lot of that noise AND lets us
// reconstruct a long full message, while staying a cheap sync read.
const TAIL_BYTES = 1024 * 1024;
// Operator wants the FULL last response, not a tail. Cap only to avoid a runaway
// payload on a pathologically huge message; keep the tail if it exceeds (the
// actionable ask is at the end).
const MAX_MESSAGE_CHARS = 200_000;

// Read the last assistant message + activity time from a workflow's events.jsonl
// tail. The assistant's words are `primary_text` events between the most recent
// `primary_turn_started` and the turn end. Bounded + best-effort — never throws.
function readLastMessage(
  cwd: string,
  wfid: string,
): { text: string; role: 'assistant'; at: number; durationMs?: number } | undefined {
  let fd: number | undefined;
  try {
    const path = join(cwd, '.arco', 'workflows', wfid, 'events.jsonl');
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return undefined;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // drop the partial first line

    const chunks: string[] = [];
    let at = 0;
    let durationMs: number | undefined;
    // Walk backward: collect primary_text (skip thinking) until the turn start.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let ev: { type?: string; ts?: number; text?: string; phase?: string; durationMs?: number };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof ev.ts === 'number' && ev.ts > at) at = ev.ts;
      if (ev.type === 'primary_complete' && durationMs === undefined && typeof ev.durationMs === 'number') {
        durationMs = ev.durationMs;
      }
      if (ev.type === 'primary_text' && ev.phase !== 'thinking' && typeof ev.text === 'string') {
        chunks.push(ev.text);
      } else if (ev.type === 'primary_turn_started') {
        break; // reached the start of the last turn — stop collecting
      }
    }
    if (!chunks.length) return undefined;
    chunks.reverse();
    let text = chunks.join('').trim();
    if (text.length > MAX_MESSAGE_CHARS) text = '…' + text.slice(-MAX_MESSAGE_CHARS);
    return {
      text,
      role: 'assistant',
      at,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// R1 — context pressure for the phone's WHEN-to-compact/handoff judgment.
// 2026-07-18 fix: PRIMARY source is the stashed context_usage numbers — the
// exact data the desktop CTX chip renders — so phone === desktop (the old
function contextOf(wf: WorkflowState): {
  contextPct: number;
  contextZone: 'green' | 'amber' | 'red';
  contextTokens?: number;
  contextWindow?: number;
} | null {
  const usage = wf.lastContextUsage;
  const pct = usage && usage.window > 0
    ? usage.percent / 100
    : typeof wf.lastContextBudgetPct === 'number'
      ? wf.lastContextBudgetPct
      : typeof wf.lastContextPercent === 'number' && wf.lastContextPercent > 0
        ? wf.lastContextPercent / 100
        : undefined;
  if (pct === undefined) return null;
  const clamped = Math.max(0, Math.min(1, pct));
  return {
    contextPct: clamped,
    contextZone: clamped >= 0.85 ? 'red' : clamped >= 0.6 ? 'amber' : 'green',
    ...(usage ? { contextTokens: usage.tokens, contextWindow: usage.window } : {}),
  };
}

const QUEUE_PREVIEW_CHARS = 120;

// R3 §3 — the one visibility rule. Clustered workflows follow their CLUSTER's
// remote switch (member-level flags ignored, both directions); standalone
// workflows follow their own flag. Used by the snapshot filter, the action
// re-validation, and the monitored count — one function so they can't drift.
function isWorkflowRemoteVisible(wfid: string, wf: WorkflowState): boolean {
  if (wf.config.kind === 'cluster') return false; // parent tab: no worker
  const cid = getClusterIdForWorkflow(wfid);
  if (cid) return isClusterRemoteEnabled(cid);
  return wf.config.remoteEnabled === true;
}

// 2026-07-18 (§9.2 follow-up) — the gates-arming mirror of the rule above:
// clustered workflows follow the CLUSTER's ⛨ GATES switch (member flags
// ignored), standalone workflows their own remoteGatesEnabled. Same
// one-function discipline: snapshot `resolvable` bit + gate_resolve
// re-validation both call this.
function areGatesRemoteResolvable(wfid: string, wf: WorkflowState): boolean {
  const cid = getClusterIdForWorkflow(wfid);
  if (cid) return isClusterGatesRemoteEnabled(cid);
  return wf.config.remoteGatesEnabled === true;
}

// Snapshot the live workflow set → WorkflowSummary[]. Cluster parent tabs carry
// no primary worker, so they're skipped (nothing to report/control). Each
// summary carries the tail of the last assistant message so the console has
// enough context to decide (§13.5), plus the R1 decision-context fields
// (context zone, queue, parked question/gates) — all cheap in-memory reads.
function snapshotWorkflows(): WorkflowSummary[] {
  const out: WorkflowSummary[] = [];
  for (const [wfid, wf] of workflows.entries()) {
    // REMOTE_MANAGEMENT.md §1.4 + R3 §3 — opt-in gate. Default OFF: a workflow
    // is reported to the hub ONLY when opted in (own flag, or its cluster's
    // switch when clustered). Filtering at the source means the hub never sees
    // opted-out workflows, so the console omits them with no hub-side change.
    if (!isWorkflowRemoteVisible(wfid, wf)) continue;
    const clusterId = getClusterIdForWorkflow(wfid);
    const clusterState = clusterId ? getClusterCached(clusterId) : null;
    const cwd = workflowCwds.get(wfid) ?? wf.config.workingDirectory;
    const last = readLastMessage(cwd, wfid);
    const ctx = contextOf(wf);
    const queued = [...wf.queue.steering, ...wf.queue.followUp].map((q) => ({
      id: q.clientMessageId ?? '',
      preview: q.content.slice(0, QUEUE_PREVIEW_CHARS),
    }));
    // Parked interactions — live Native worker only (null on other providers /
    // disposed workers; a restart-orphaned gate stays resolvable via the
    // gate_reply orphan path, it's just not listed until re-parked).
    const pending = wf.primary.provider === 'claude' ? getClaudeNativePendingInteractions(wfid) : null;
    const gatesResolvable = areGatesRemoteResolvable(wfid, wf);
    // Compact needs codex/ollama, or Claude ON the native transport. The
    // cascade default is async, so approximate with config + a live Native
    // worker as the transport signal (a cascade-native tab shows the button
    // only after its first turn); the handler re-validates regardless.
    const claudeNativeLikely = wf.config.claudeTransport === 'native' || pending !== null;
    const p = wf.primary.provider;
    const canCompact = p === 'codex' || p === 'cursor' || p === 'ollama' || (p === 'claude' && claudeNativeLikely);
    const canFold = p === 'claude' && claudeNativeLikely;
    out.push({
      workflowId: wfid,
      title: wf.config.name,
      cwd,
      provider: p,
      model: wf.primary.model,
      state: wf.busy ? 'running' : 'idle',
      busy: wf.busy,
      ...(last
        ? {
            lastActivityAt: last.at,
            lastMessageRole: last.role,
            lastMessageText: last.text,
            ...(last.durationMs !== undefined ? { lastTurnDurationMs: last.durationMs } : {}),
          }
        : {}),
      ...(wf.primary.effort ? { effort: wf.primary.effort } : {}),
      ...(ctx ?? {}),
      ...(queued.length ? { queueDepth: queued.length, queued } : {}),
      ...(pending?.question ? { pendingQuestion: { questionId: pending.question.questionId, text: pending.question.text } } : {}),
      ...(pending?.gates.length
        ? {
            pendingGates: pending.gates.map((g) => ({
              gateId: g.gateId,
              toolName: g.toolName,
              category: g.category,
              reason: g.reason,
              argsPreview: g.argsPreview,
              resolvable: gatesResolvable,
            })),
          }
        : {}),
      ...(canCompact ? { canCompact } : {}),
      ...(canFold ? { canFold } : {}),
      ...(clusterId
        ? {
            cluster: {
              clusterId,
              ...(clusterState?.memberRoles?.[wfid] ? { role: clusterState.memberRoles[wfid] } : {}),
              ...(clusterState?.memberTiers?.[wfid] ? { tier: clusterState.memberTiers[wfid] } : {}),
              ...(clusterState?.memberFocuses?.[wfid] ? { focus: clusterState.memberFocuses[wfid] } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

// R3 — remote-enabled clusters → ClusterSummary[], pushed on the same cadence
// as the workflow snapshot. Reuses buildClusterStatePayload (it already
// computes members + status + mailboxDepth + plan + knobs).
async function snapshotClusters(): Promise<ClusterSummary[]> {
  const out: ClusterSummary[] = [];
  for (const clusterId of listKnownClusterIds()) {
    if (!isClusterRemoteEnabled(clusterId)) continue;
    const payload = await buildClusterStatePayload(clusterId).catch(() => null);
    if (!payload) continue;
    const st = getClusterCached(clusterId);
    out.push({
      clusterId,
      ...(payload.name ? { name: payload.name } : {}),
      cwd: payload.cwd,
      memberIds: payload.members.map((m) => m.workflowId),
      efficiencyLevel: payload.efficiencyLevel ?? 'thorough',
      autoTurnOnMailbox: payload.autoTurnOnMailboxEnabled === true,
      idleNudgerEnabled: payload.idleNudgerEnabled === true,
      taskBoardMode: payload.taskBoardMode,
      ...(payload.plan
        ? { planHead: payload.plan.body.slice(0, 500), planId: payload.plan.id }
        : {}),
      mailboxDepth: payload.mailboxDepth,
      ...(st?.memberRoles ? { roles: st.memberRoles } : {}),
      ...(st?.memberTiers ? { tiers: st.memberTiers } : {}),
      ...(st?.memberFocuses ? { focuses: st.memberFocuses } : {}),
    });
  }
  return out;
}

const MAILBOX_PREVIEW_CHARS = 300;
const BOARD_MAX_TASKS = 100;
const PLAN_MAX_BYTES = 65_536;

// R3 — correlated read-only cluster pulls (mailbox peek / board / plan). All
// re-validate the cluster's remote switch locally; mailbox uses the
// NON-destructive peek (never drain — GOTCHAS: drain destroys the file).
async function clusterRead(
  clusterId: string,
  kind: ClusterReadKind,
): Promise<Pick<ClusterReadResponseMessage, 'ok' | 'error' | 'mailbox' | 'board' | 'plan' | 'activity'>> {
  if (!isClusterRemoteEnabled(clusterId)) return { ok: false, error: 'remote-disabled' };
  const st = getClusterCached(clusterId);
  if (!st) return { ok: false, error: 'no-such-cluster' };
  switch (kind) {
    case 'mailbox': {
      const mailbox: Record<string, ClusterMailboxEntry[]> = {};
      for (const wfid of st.members) {
        const msgs = await peekMailbox(wfid).catch(() => []);
        mailbox[wfid] = msgs.map((m) => ({
          msgId: m.msgId,
          from: m.fromWorkflowId,
          fromName: m.fromDisplayName,
          preview: m.content.slice(0, MAILBOX_PREVIEW_CHARS),
          createdAt: m.createdAt,
        }));
      }
      return { ok: true, mailbox };
    }
    case 'board': {
      if (normalizeTaskBoardMode(st) === 'none') return { ok: true, board: { tasks: [] } };
      const tasks = await taskLedger.load(st.cwd, taskBoardKeyForState(st)).catch(() => []);
      return {
        ok: true,
        board: {
          tasks: tasks.slice(0, BOARD_MAX_TASKS).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            ...(t.assignee ? { assignee: t.assignee } : {}),
            ...(t.priority !== undefined ? { priority: String(t.priority) } : {}),
          })),
        },
      };
    }
    case 'plan': {
      const rec = await readClusterPlan(clusterId).catch(() => null);
      return rec
        ? { ok: true, plan: { body: rec.body.slice(0, PLAN_MAX_BYTES) } }
        : { ok: false, error: 'no-plan' };
    }
    case 'activity': {
      // R5 — merged member timeline from bounded events.jsonl tails.
      const perMember = st.members.map((wfid) => readMemberActivity(st.cwd, wfid));
      return { ok: true, activity: mergeActivity(perMember) };
    }
    default:
      return { ok: false, error: 'unsupported' };
  }
}

// Synthetic ws/session for server-originated turns — mirrors the cluster
// auto-turn dispatch pattern in index.ts (readyState CLOSED → persistence runs,
// socket writes skip; errors still land in the workflow's events.jsonl).
function fakeWs(): WebSocket {
  return { readyState: WebSocket.CLOSED, send: () => undefined } as unknown as WebSocket;
}
function fakeSession(wfid: string): Session {
  return {
    id: 'hub-link-synthetic',
    workflowIds: new Set([wfid]),
    clusterIds: new Set(),
    clusterObserved: new Map(),
  };
}

// Apply a routed action, RE-VALIDATING against the live workflow first. The hub
// only routes; this is where the local instance decides the action is valid.
async function applyAction(
  action: WorkflowActionRequest,
  actionId: string,
): Promise<WorkflowActionResult> {
  const base = { actionId, workflowId: action.workflowId };
  const wf = workflows.get(action.workflowId);
  if (!wf) return { ...base, ok: false, error: 'no-such-workflow' };
  // Defense-in-depth: even though an opted-out workflow is never reported to the
  // hub (snapshotWorkflows filters it), re-validate here so a stale hub snapshot
  // or a future console can't drive an action on a workflow the operator hasn't
  // opted in. The trust boundary is enforced locally (REMOTE_MANAGEMENT.md §1.2).
  // R3 §3 — clustered workflows follow the cluster's switch, not their own.
  if (!isWorkflowRemoteVisible(action.workflowId, wf)) {
    return { ...base, ok: false, error: 'remote-disabled' };
  }

  switch (action.type) {
    case 'stop': {
      if (!wf.busy) return { ...base, ok: false, error: 'not-running' };
      handleCancel(fakeWs(), action.workflowId);
      return { ...base, ok: true, applied: 'stop' };
    }
    case 'handoff': {
      // Same-worker rotation to free context (operator: "keep it simple").
      // Reject mid-turn — handoff summarizes settled context.
      if (wf.busy) return { ...base, ok: false, error: 'busy' };
      void handleHandoffRequest(fakeWs(), fakeSession(action.workflowId), {
        type: 'handoff_request',
        workflowId: action.workflowId,
        mode: 'original-worker', // same worker, default summarizer = tab's primary
      }).catch((err) =>
        console.error(`[hub-link] handoff failed for ${action.workflowId.slice(0, 8)}:`, err),
      );
      return { ...base, ok: true, applied: 'handoff' };
    }
    case 'reply':
    case 'continue': {
      const content =
        action.type === 'reply' ? (action.body ?? '').trim() : 'Continue.';
      if (action.type === 'reply' && !content) return { ...base, ok: false, error: 'failed' };
      // handleUserMessage routes to the queue if busy, or runs a turn if idle —
      // safe either way. Fire-and-forget: the action is "accepted"; the turn's
      // own events stream back through the workflow's normal broadcast path.
      void handleUserMessage(
        fakeWs(),
        fakeSession(action.workflowId),
        action.workflowId,
        content,
        undefined,
        undefined,
        false,
        wf.busy ? 'follow-up' : undefined,
        undefined,
      ).catch((err) =>
        console.error(`[hub-link] ${action.type} failed for ${action.workflowId.slice(0, 8)}:`, err),
      );
      return { ...base, ok: true, applied: action.type };
    }
    // -- R1 verbs (docs/REMOTE_MANAGEMENT.md) --
    case 'compact':
    case 'fold': {
      if (wf.busy) return { ...base, ok: false, error: 'busy' };
      const p = wf.primary.provider;
      const okProvider = action.type === 'fold'
        ? p === 'claude'
        : p === 'codex' || p === 'claude' || p === 'ollama';
      if (!okProvider) return { ...base, ok: false, error: 'unsupported' };
      // The handlers do the deep validation (transport cascade, busy re-check)
      // and surface their own error/system_notice on the workflow's broadcast
      // path; fire-and-forget mirrors the reply/handoff pattern.
      const fire = action.type === 'compact'
        ? handleCompactWorkflow(fakeWs(), fakeSession(action.workflowId), { type: 'compact_workflow', workflowId: action.workflowId })
        : handleFoldWorkflow(fakeWs(), fakeSession(action.workflowId), { type: 'fold_workflow', workflowId: action.workflowId });
      void fire.catch((err) =>
        console.error(`[hub-link] ${action.type} failed for ${action.workflowId.slice(0, 8)}:`, err),
      );
      return { ...base, ok: true, applied: action.type };
    }
    case 'answer_question': {
      const reply = (action.body ?? '').trim();
      if (!action.questionId || !reply) return { ...base, ok: false, error: 'failed' };
      // Routes to the live Native worker's parked promise; false = no such
      // question (already answered / worker rotated) — stale-console guard.
      const routed = routeClaudeNativeQuestionReply(action.workflowId, action.questionId, reply);
      return routed
        ? { ...base, ok: true, applied: 'answer_question' }
        : { ...base, ok: false, error: 'stale-target' };
    }
    case 'gate_resolve': {
      // §9.2 — remote conversation never implies remote approval authority:
      // gate resolution requires its own arming (the cluster's ⛨ GATES switch
      // for members, the workflow's own flag for solo tabs).
      if (!areGatesRemoteResolvable(action.workflowId, wf)) {
        return { ...base, ok: false, error: 'gates-disabled' };
      }
      if (!action.gateId || (action.decision !== 'approve' && action.decision !== 'reject')) {
        return { ...base, ok: false, error: 'failed' };
      }
      // NO remote arg-editing (v2 scope cut) — the parked proposal runs as-is.
      const routed = routeClaudeNativeGateReply(action.workflowId, action.gateId, action.decision);
      if (routed) return { ...base, ok: true, applied: 'gate_resolve' };
      // Not live-parked — try the restart-orphan path (re-issues an approved
      // call through a fresh turn; same fallback the desktop gate card uses).
      const orphaned = await resolveOrphanedGate(
        fakeWs(),
        fakeSession(action.workflowId),
        action.workflowId,
        action.gateId,
        action.decision,
        undefined, // finalArgs — no remote arg-editing
      );
      return orphaned
        ? { ...base, ok: true, applied: 'gate_resolve' }
        : { ...base, ok: false, error: 'stale-target' };
    }
    case 'cancel_queued': {
      if (!action.queuedId) return { ...base, ok: false, error: 'failed' };
      const inQueue =
        wf.queue.steering.some((q) => q.clientMessageId === action.queuedId) ||
        wf.queue.followUp.some((q) => q.clientMessageId === action.queuedId);
      if (!inQueue) return { ...base, ok: false, error: 'stale-target' };
      handleCancelQueuedMessage(fakeWs(), action.workflowId, action.queuedId);
      return { ...base, ok: true, applied: 'cancel_queued' };
    }
    default:
      return { ...base, ok: false, error: 'unsupported' };
  }
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // bounded tail for very long convos
const MAX_TURNS = 800;

// Reconstruct a workflow's full conversation from events.jsonl for the "open in
// a new tab" view: user_message_echo = operator turns, primary_text = assistant
// (skip thinking), grouped by turn. Bounded + best-effort.
// R2 — `sinceTurn` slices for the chat screen's incremental poll; the wrapper
// below adds totalTurns + busy.
function getTranscript(
  wfid: string,
  sinceTurn?: number,
): { title?: string; turns: TranscriptTurn[]; totalTurns?: number; busy?: boolean } {
  const full = readFullTranscript(wfid);
  const totalTurns = full.turns.length;
  const busy = workflows.get(wfid)?.busy === true;
  const turns =
    typeof sinceTurn === 'number' && sinceTurn > 0 ? full.turns.slice(sinceTurn) : full.turns;
  return { ...(full.title ? { title: full.title } : {}), turns, totalTurns, busy };
}

function readFullTranscript(wfid: string): { title?: string; turns: TranscriptTurn[] } {
  const wf = workflows.get(wfid);
  const title = wf?.config.name;
  const cwd = workflowCwds.get(wfid) ?? wf?.config.workingDirectory;
  if (!cwd) return { ...(title ? { title } : {}), turns: [] };
  let fd: number | undefined;
  try {
    const path = join(cwd, '.arco', 'workflows', wfid, 'events.jsonl');
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return { ...(title ? { title } : {}), turns: [] };
    const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();

    const turns: TranscriptTurn[] = [];
    let asst: string[] = [];
    let asstAt = 0;
    const flush = () => {
      if (!asst.length) return;
      const text = asst.join('').trim();
      if (text) turns.push({ role: 'assistant', text, ...(asstAt ? { at: asstAt } : {}) });
      asst = [];
      asstAt = 0;
    };
    for (const line of lines) {
      if (!line) continue;
      let ev: { type?: string; ts?: number; text?: string; phase?: string; content?: string; timestamp?: number };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'user_message_echo' && typeof ev.content === 'string') {
        flush();
        turns.push({ role: 'user', text: ev.content, ...(ev.timestamp || ev.ts ? { at: ev.timestamp ?? ev.ts } : {}) });
      } else if (ev.type === 'primary_text' && ev.phase !== 'thinking' && typeof ev.text === 'string') {
        asst.push(ev.text);
        if (typeof ev.ts === 'number') asstAt = ev.ts;
      } else if (ev.type === 'primary_turn_ended') {
        flush();
      }
    }
    flush();
    return { ...(title ? { title } : {}), turns: turns.length > MAX_TURNS ? turns.slice(-MAX_TURNS) : turns };
  } catch {
    return { ...(title ? { title } : {}), turns: [] };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const LEDGER_STATUSES: readonly string[] = [
  'triage', 'todo', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archived',
];

// R4 §6 — the manual nudge body. Server-fixed (deterministic), visible as a
// normal operator turn. One tap = one prompt; no standing behavior.
function nudgeBody(pendingCount: number): string {
  return `Operator nudge: you have ${pendingCount} pending peer message(s) — read your mailbox with peer_read and act on them.`;
}

// R4 (docs/REMOTE_MANAGEMENT.md) - cluster-scoped actions. Every
// verb re-validates the cluster's remote switch + membership locally, then
// delegates to the SAME deterministic handler the desktop uses (fakeWs
// swallows the handler's ws-only error echoes; pre-validation here returns
// the typed error instead).
async function applyClusterAction(
  clusterId: string,
  action: ClusterActionRequest,
  actionId: string,
): Promise<ClusterActionResult> {
  const base = { actionId, clusterId };
  if (!isClusterRemoteEnabled(clusterId)) return { ...base, ok: false, error: 'remote-disabled' };
  const st = getClusterCached(clusterId);
  if (!st) return { ...base, ok: false, error: 'no-such-cluster' };
  const isMember = (id: string) => st.members.includes(id);

  switch (action.type) {
    case 'broadcast': {
      const body = (action.body ?? '').trim();
      if (!body) return { ...base, ok: false, error: 'empty-body' };
      const recips = action.recipientIds ?? [];
      if (recips.some((r) => !isMember(r))) return { ...base, ok: false, error: 'unknown-recipient' };
      void handleClusterBroadcast(fakeWs(), fakeSession(''), {
        type: 'cluster_broadcast',
        clusterId,
        content: body,
        ...(recips.length ? { recipientWorkflowIds: recips } : {}),
      }).catch((err) => console.error(`[hub-link] cluster broadcast failed:`, err));
      return {
        ...base,
        ok: true,
        applied: 'broadcast',
        detail: recips.length ? `→ ${recips.length} member(s)` : `→ all ${st.members.length} member(s)`,
      };
    }
    case 'nudge_member': {
      if (!isMember(action.memberId)) return { ...base, ok: false, error: 'unknown-member' };
      const wf = workflows.get(action.memberId);
      if (!wf) return { ...base, ok: false, error: 'no-such-workflow' };
      const pending = await mailboxDepthFor(action.memberId).catch(() => 0);
      void handleUserMessage(
        fakeWs(),
        fakeSession(action.memberId),
        action.memberId,
        nudgeBody(pending),
        undefined,
        undefined,
        false,
        wf.busy ? 'follow-up' : undefined,
        undefined,
      ).catch((err) => console.error(`[hub-link] nudge failed:`, err));
      return { ...base, ok: true, applied: 'nudge_member', detail: `✉ ${pending} pending` };
    }
    case 'peer_send': {
      const body = (action.body ?? '').trim();
      if (!body) return { ...base, ok: false, error: 'empty-body' };
      if (!isMember(action.fromId) || !isMember(action.toId)) {
        return { ...base, ok: false, error: 'unknown-member' };
      }
      await handleOperatorPeerSend(fakeWs(), {
        type: 'operator_peer_send',
        clusterId,
        from: action.fromId,
        to: action.toId,
        content: body,
      });
      return { ...base, ok: true, applied: 'peer_send' };
    }
    case 'stop_all': {
      let stopped = 0;
      for (const wfid of st.members) {
        const wf = workflows.get(wfid);
        if (wf?.busy) {
          handleCancel(fakeWs(), wfid);
          stopped++;
        }
      }
      return { ...base, ok: true, applied: 'stop_all', detail: `stopped ${stopped} member(s)` };
    }
    case 'set_efficiency': {
      if (!['thorough', 'balanced', 'lean'].includes(action.level)) {
        return { ...base, ok: false, error: 'unknown-level' };
      }
      await handleClusterEfficiencySet(fakeWs(), clusterId, action.level);
      return { ...base, ok: true, applied: 'set_efficiency', detail: action.level };
    }
    case 'toggle_auto_turn': {
      await handleClusterAutoTurnToggle(fakeWs(), clusterId, action.enabled === true);
      return { ...base, ok: true, applied: 'toggle_auto_turn' };
    }
    case 'toggle_idle_nudger': {
      await handleClusterIdleNudgerToggle(fakeWs(), clusterId, action.enabled === true);
      return { ...base, ok: true, applied: 'toggle_idle_nudger' };
    }
    case 'board_task_update': {
      // §9.4 — tap-to-advance rides the operator-originated ledger path (the
      // only path allowed to set 'done'). cwd resolves via any live member.
      if (!LEDGER_STATUSES.includes(action.status)) return { ...base, ok: false, error: 'unknown-status' };
      if (normalizeTaskBoardMode(st) === 'none') return { ...base, ok: false, error: 'no-board' };
      const anchor = st.members.find((m) => workflows.has(m));
      if (!anchor) return { ...base, ok: false, error: 'no-live-member' };
      await handleTaskLedgerUpdate(fakeWs(), {
        type: 'task_ledger_update',
        workflowId: anchor,
        ...(taskBoardKeyForState(st) ? { boardKey: taskBoardKeyForState(st) } : {}),
        id: action.taskId,
        status: action.status as LedgerTaskStatus,
      });
      return { ...base, ok: true, applied: 'board_task_update', detail: `${action.taskId} → ${action.status}` };
    }
    default:
      return { ...base, ok: false, error: 'unsupported' };
  }
}

// A2 — the heartbeat rollup: default busy/waiting counts + auth alerts. The
// alert state lives in oauth.ts (set on fatal worker auth failure, cleared on
// a successful refresh/bootstrap); this just surfaces it every 15s beat.
function computeRollup(): InstanceRollup {
  let active = 0;
  let waiting = 0;
  for (const [wfid, wf] of workflows.entries()) {
    if (!isWorkflowRemoteVisible(wfid, wf)) continue;
    if (wf.busy) active++;
    else waiting++;
  }
  const problem = getClaudeAuthProblem();
  return {
    health: problem ? 'degraded' : 'ok',
    activeWorkflows: active,
    waitingRequests: waiting,
    ...(problem
      ? {
          authAlerts: [
            { provider: 'claude', state: 'expired', since: problem.since, detail: problem.detail },
          ],
        }
      : {}),
  };
}

// A2 — instance-level actions: the remote re-auth flow. start_reauth runs the
// same PKCE bootstrap the desktop RE-LOGIN uses and hands the authorize URL to
// the console; complete_reauth is the manual-paste completion (the phone
// browser can't reach localhost:53692, so the operator pastes the failed
// callback URL back). Both are logged; the auth-problem flag clears itself on
// a successful token grant.
async function applyInstanceAction(
  action: InstanceActionRequest,
  actionId: string,
): Promise<InstanceActionResult> {
  const base = { actionId };
  switch (action.type) {
    case 'start_reauth': {
      const r = await claudeNativeStartBootstrap();
      console.log('[hub-link] remote re-auth started (phone console)');
      return {
        ...base,
        ok: true,
        authorizationUrl: r.authorizationUrl,
        manualFallback: r.manualFallback,
        flow: r.flow,
      };
    }
    case 'complete_reauth': {
      try {
        const completed = await claudeNativeCompleteBootstrap(action.url, action.flowId);
        console.log('[hub-link] remote re-auth completed (phone console)');
        return { ...base, ok: true, flow: completed.flow };
      } catch (err) {
        return { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    default:
      return { ...base, ok: false, error: 'unsupported' };
  }
}

let link: HubLink | null = null;
let connected = false;
let connectedSince: number | undefined;
let cfg: { repoRoot: string; version: string } | null = null;
let statusListener: ((s: HubLinkStatus) => void) | null = null;

export interface HubLinkStatus {
  connected: boolean; // outbound link to the hub is open
  enabled: boolean; // operator hasn't killed it locally
  hubUrl?: string; // present when ARCO_HUB_URL is configured
  // Header transparency (REMOTE_MANAGEMENT.md §9): how many of this instance's
  // workflows are opted in to remote (= reported to the hub). Lets the HUB chip
  // show "N monitored" instead of a bare connected/disconnected dot.
  monitoredCount: number;
  connectedSince?: number; // ts the link last opened — tooltip "linked since …"
}

// Count workflows currently opted in to remote reporting. Cheap (no file reads,
// unlike snapshotWorkflows) so it's safe to call on every status emit. Mirrors
// the snapshot filter exactly (isWorkflowRemoteVisible).
function countRemoteEnabled(): number {
  let n = 0;
  for (const [wfid, wf] of workflows.entries()) {
    if (isWorkflowRemoteVisible(wfid, wf)) n++;
  }
  return n;
}

export function getHubLinkStatus(): HubLinkStatus {
  return {
    connected,
    enabled: link !== null,
    monitoredCount: countRemoteEnabled(),
    ...(connectedSince !== undefined ? { connectedSince } : {}),
    ...(process.env.ARCO_HUB_URL ? { hubUrl: process.env.ARCO_HUB_URL } : {}),
  };
}

// Called by the update_primary_config handler when a `remoteEnabled` toggle
// flips: push the new snapshot to the hub at once AND re-broadcast hub_link_status
// so the header monitored-count updates immediately. Safe (no-op link push) when
// no hub is configured. Kept here so workflowHandlers stays decoupled from the
// connector internals.
export function refreshHubReporting(): void {
  link?.pushNow();
  emitStatus();
}

// Register a single listener (the server's broadcast-to-clients fn).
export function onHubLinkStatus(fn: (s: HubLinkStatus) => void): void {
  statusListener = fn;
}

function emitStatus(): void {
  statusListener?.(getHubLinkStatus());
}

function startLink(): void {
  const hubUrl = process.env.ARCO_HUB_URL;
  if (!hubUrl || !cfg || link) return;
  const instance = buildServiceInstanceDescriptor(cfg.repoRoot, cfg.version);
  link = createHubLink({
    hubUrl,
    instance,
    snapshotWorkflows,
    applyAction,
    applyInstanceAction,
    rollup: computeRollup,
    snapshotClusters,
    clusterRead,
    applyClusterAction,
    getTranscript,
    onStatus: (c) => {
      connected = c;
      connectedSince = c ? Date.now() : undefined;
      emitStatus();
    },
    log: (m) => console.log(`[hub-link] ${m}`),
  });
  link.start();
  console.log(
    `[hub-link] workflow-reporting active → ${hubUrl} as "${instance.name}" (${instance.instanceId})`,
  );
  emitStatus();
}

// Called from the server bootstrap. The hub link itself is inert unless
// ARCO_HUB_URL is set; the auth-expired notice wiring below is NOT hub-gated
// (the J1 → ntfy path works standalone), so the phone learns about a dead
// Claude auth even on a hub-less install.
export function initHubLink(repoRoot: string, version: string): void {
  cfg = { repoRoot, version }; // captured so a local reconnect can restart it
  setClaudeAuthProblemNotifier((detail) => {
    emitWorkbenchNotice({
      category: 'auth-expired',
      severity: 'error',
      title: 'Claude auth expired — re-login needed',
      body: detail.slice(0, 200),
      provider: 'claude',
    });
  });
  startLink();
}

// Local kill switch / reconnect (operator-driven from the desktop UI).
export function setHubLinkEnabled(enabled: boolean): void {
  if (enabled) {
    startLink();
  } else {
    link?.stop();
    link = null;
    connected = false;
    emitStatus();
  }
}

export function stopHubLink(): void {
  link?.stop();
  link = null;
  connected = false;
  emitStatus();
}
