// CLUSTER_MODE_PLAN.md Phase 5 — operator-armed idle nudger.
//
// The four-question test (plan §2):
//   1. Operator-initiated — per-cluster toggle, default OFF.
//   2. Bounded by deterministic rules — fires only when
//      `idle ≥ IDLE_FLOOR_SECONDS AND pending ≥ 1`, hard-capped at
//      NUDGES_PER_TURN per member per operator turn. Suppressed during
//      any other member's active thinking block.
//   3. events.jsonl visible — `cluster_member_nudged` rides through
//      broadcastCluster + broadcastWorkflow so transcripts replay
//      identically.
//   4. Reversible — operator toggles OFF in one click. Default OFF means
//      "off by inaction" is the resting state.
//
// The nudger NEVER sends a prompt to any worker. It only nudges the
// operator (chip + toast). This is the autonomy-test-passing alternative
// to the archived "auto-advance" pattern.

import * as clusterStore from './clusterStore.js';
import { emit as emitNotice } from './notifications.js';
import * as clusterMailbox from './clusterMailbox.js';
import type { ServerMessage } from '@arco/shared';

// Idle floor. Production default 10s. Smoke can drop to 1s via the
// ARCO_CLUSTER_IDLE_FLOOR_SECONDS env var so the test doesn't sit on a
// 10s wait for every nudge cycle. Documented in CLUSTER_MODE_PLAN.md §13.
export const IDLE_FLOOR_SECONDS = (() => {
  const raw = process.env.ARCO_CLUSTER_IDLE_FLOOR_SECONDS;
  if (!raw) return 10;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0.1) return 10;
  return parsed;
})();

// Hard cap per operator turn per member. Operator turns are per-member; the
// counter resets on each member's `primary_turn_started`. Three nudges is
// "enough to get the operator's attention; not enough to be spam."
export const NUDGES_PER_TURN = 3;

// Polling cadence. Half the idle floor (clamped to 500ms minimum) so a
// member that just became idle gets caught within ~1.5× the floor on the
// next tick. With floor=10s the poller fires every 5s; with smoke's 1s
// floor every 500ms.
const POLL_INTERVAL_MS = Math.max(500, Math.floor((IDLE_FLOOR_SECONDS * 1000) / 2));

interface MemberNudgeState {
  // Wall-clock ms when the member last transitioned from busy → idle.
  // Cleared on transition to busy. The detector compares
  // (now - idleSince) ≥ IDLE_FLOOR_SECONDS * 1000.
  idleSince?: number;
  // Wall-clock ms when the last nudge fired for this member. Used as a
  // cooldown: subsequent nudges require a fresh IDLE_FLOOR_SECONDS of
  // continued idleness, so the operator gets a steady drumbeat rather
  // than a burst.
  lastNudgedAt?: number;
  // Nudges fired in the member's current operator turn. Reset on the
  // member's primary_turn_started. Capped at NUDGES_PER_TURN.
  nudgesThisTurn: number;
}

// Keyed by workflowId. State for any workflow that has ever been observed
// idle in any cluster; cleaned up when the workflow leaves all clusters.
const memberState = new Map<string, MemberNudgeState>();

// Last-seen busy snapshot per workflow, so the detector can distinguish
// "still busy" from "transitioned busy→idle". Populated by the busy-flip
// hooks below.
const lastBusy = new Map<string, boolean>();

let timer: NodeJS.Timeout | undefined;
let broadcastWorkflowFn: ((workflowId: string, msg: ServerMessage) => void) | undefined;
let resolveMembersFn: (() => Map<string, { workflowId: string; busy: boolean }[]> | undefined) | undefined;

// Configure the module with the broadcast surfaces from index.ts. Called
// once at server boot.
export function configure(opts: {
  broadcastWorkflow: (workflowId: string, msg: ServerMessage) => void;
  resolveMembers: () => Map<string, { workflowId: string; busy: boolean }[]> | undefined;
}): void {
  broadcastWorkflowFn = opts.broadcastWorkflow;
  resolveMembersFn = opts.resolveMembers;
}

export function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

// Phase 5 — reset the per-turn counter when a member starts a new operator
// turn. Called from the primary_turn_started broadcast site in index.ts.
export function onMemberTurnStarted(workflowId: string): void {
  const s = memberState.get(workflowId);
  if (s) {
    s.nudgesThisTurn = 0;
    s.lastNudgedAt = undefined;
  }
  // Member is busy now — clear idleSince. Will be re-set when the turn ends.
  lastBusy.set(workflowId, true);
  if (s) s.idleSince = undefined;
}

// Phase 5 — member ended a turn. Stamp idleSince so the detector can
// compute "idle for ≥ floor". Called from primary_turn_ended.
export function onMemberTurnEnded(workflowId: string): void {
  lastBusy.set(workflowId, false);
  let s = memberState.get(workflowId);
  if (!s) {
    s = { nudgesThisTurn: 0 };
    memberState.set(workflowId, s);
  }
  s.idleSince = Date.now();
}

// Drop a workflow from the per-member state when it leaves all clusters or
// the cluster is deleted. Prevents memory accumulation across long server
// uptimes. Called on cluster_delete + cluster_member_remove.
export function dropMember(workflowId: string): void {
  memberState.delete(workflowId);
  lastBusy.delete(workflowId);
}

// Drop a cluster's transient state — called when a cluster is deleted. The
// detector itself doesn't keep per-cluster state; this is a hook for the
// drop-all-members fan-out at the call site.
export function dropCluster(_clusterId: string): void {
  // Members are dropped via dropMember at the call site. Hook left in
  // place for symmetry with future per-cluster state.
}

async function tick(): Promise<void> {
  if (!broadcastWorkflowFn || !resolveMembersFn) return;
  const now = Date.now();
  const clusterIds = clusterStore.listKnownClusterIds();
  if (clusterIds.length === 0) return;
  const membersByCluster = resolveMembersFn();
  if (!membersByCluster) return;
  for (const clusterId of clusterIds) {
    if (!clusterStore.isIdleNudgerEnabled(clusterId)) continue;
    const liveMembers = membersByCluster.get(clusterId);
    if (!liveMembers || liveMembers.length === 0) continue;
    // Suppression: if any member is busy, skip nudges for the entire
    // cluster this tick. The brief says "suppressed during any other
    // member's active thinking block" — we apply this cluster-wide for
    // simplicity (a busy member's own idleSince is undefined, so it
    // wouldn't fire for itself; the suppression matters for peers).
    if (liveMembers.some((m) => m.busy)) continue;
    for (const m of liveMembers) {
      if (m.busy) continue;
      const state = memberState.get(m.workflowId);
      // No idle baseline yet (server just booted, or never observed a
      // turn_ended). Bootstrap on first observation.
      if (!state || state.idleSince === undefined) {
        if (!state) {
          memberState.set(m.workflowId, { nudgesThisTurn: 0, idleSince: now });
        } else {
          state.idleSince = now;
        }
        continue;
      }
      if (state.nudgesThisTurn >= NUDGES_PER_TURN) continue;
      // Cooldown — require fresh IDLE_FLOOR_SECONDS since last nudge.
      const sinceLastNudge = state.lastNudgedAt ? now - state.lastNudgedAt : Infinity;
      if (sinceLastNudge < IDLE_FLOOR_SECONDS * 1000) continue;
      const idleMs = now - state.idleSince;
      if (idleMs < IDLE_FLOOR_SECONDS * 1000) continue;
      // Predicate ingredient #2: pending ≥ 1.
      const pending = await clusterMailbox.depthFor(m.workflowId).catch(() => 0);
      if (pending < 1) continue;
      const msg: ServerMessage = {
        type: 'cluster_member_nudged',
        clusterId,
        workflowId: m.workflowId,
        reason: 'idle_with_pending',
        idleSeconds: Math.round(idleMs / 1000),
        pendingCount: pending,
      };
      // Fan out via broadcastWorkflow only. The cluster panel always
      // subscribes to every member workflow on tab open (the existing
      // pattern shared with peer_message_sent), so broadcastWorkflow
      // reaches both the workflow observers AND the cluster panel
      // through that path. Double-broadcasting via broadcastCluster
      // would deliver every nudge twice to a WS that's subscribed to
      // both channels — smoke clients in particular subscribe to both
      // and would see the cap appear to break (server-side cap holds
      // at NUDGES_PER_TURN, but client sees 2× events).
      broadcastWorkflowFn(m.workflowId, msg);
      // R6 — when the cluster is remote-shared, the nudge also rides the J1 →
      // ntfy path so the PHONE learns a member is idle with pending mail.
      // Notification only (prompt-not-command); the muting UI can silence the
      // whole category. Gated on the cluster switch so a desk-only cluster
      // never pushes.
      if (clusterStore.isClusterRemoteEnabled(clusterId)) {
        emitNotice({
          category: 'cluster-nudge',
          severity: 'info',
          title: `Cluster member idle with ${pending} peer message(s)`,
          body: `member ${m.workflowId.slice(0, 8)} idle ${Math.round(idleMs / 1000)}s — nudge or open the console to act`,
          workflowId: m.workflowId,
        });
      }
      state.nudgesThisTurn += 1;
      state.lastNudgedAt = now;
    }
  }
}
