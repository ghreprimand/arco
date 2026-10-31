import { buildClusterAutoPickup } from '@arco/shared';
// docs/PROTOCOL_CLUSTER.md - operator-armed auto-turn-on-mailbox detector.
//
// The four-question test (plan §2) is the gate:
//   1. Operator-initiated — per-cluster toggle, default OFF (absent in
//      meta.json ≡ disarmed; pre-5b clusters load disarmed).
//   2. Bounded by deterministic rules — fires only when:
//        • cluster has autoTurnOnMailboxEnabled === true
//        • recipient is idle (wf.busy === false)
//        • recipient has had no auto-turn fired in the last 20s (cooldown)
//        • cluster has fired < 10 auto-turns in the last 60s (rate cap)
//        • triggering peer message's chainDepth < 3 (depth cap)
//      All caps are env-overridable for smoke (ARCO_CLUSTER_AUTO_TURN_*).
//   3. events.jsonl visible — cluster_auto_turn_fired { fired: true |
//      false, reason } rides through broadcastWorkflow on every fire AND on
//      every guard refusal. Skip events are rate-limited (1/min/cluster) so
//      a tight loop can't spam the log.
//   4. Reversible — operator toggles OFF; in-flight auto-turn finishes
//      normally; no more fire.
//
// Unlike clusterIdleNudger (which never sends a prompt to the worker — it
// only nudges the operator), THIS detector DOES dispatch a synthetic primary
// turn on the recipient. That's the whole point: it closes the UX gap where
// the operator has to manually wake every recipient. The three guards are
// the price of safety; without them, peer→peer cascades would loop forever.
//
// ChainDepth propagation. peerOps.peerSend doesn't know about auto-turns —
// per the strict editing lane we don't modify clusterPeerOps.ts. Instead:
//   • Before firing an auto-turn for recipient R, the detector calls
//     `markAutoTurnDepth(R, parentDepth + 1)`. This stores the new depth
//     against R's workflowId.
//   • broadcastWorkflow intercepts every `peer_message_sent` event and
//     stamps `msg.chainDepth = currentAutoTurnDepth(senderWfid) ?? 0`
//     BEFORE persistAndStampSeq runs. So the next peer_send from R during
//     that auto-turn carries chainDepth = parentDepth + 1.
//   • On primary_turn_ended the depth is cleared.
// Operator-initiated turns never set the marker → chainDepth = 0 on the
// outbound peer_message_sent.

import * as clusterStore from './clusterStore.js';
import * as clusterMailbox from './clusterMailbox.js';
import type { ServerMessage } from '@arco/shared';

// Per-recipient cooldown — once an auto-turn fires for R, the next auto-turn
// for R is suppressed until this many ms have passed. Prevents tight A↔B
// ping-pong even if the rate cap hasn't been reached.
export const AUTO_TURN_COOLDOWN_MS = (() => {
  const raw = process.env.ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS;
  if (!raw) return 20000;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 20000;
  return parsed;
})();

// Per-cluster rate cap — at most this many auto-turns fire in any rolling
// 60-second window across the entire cluster. A runaway loop hits this
// before it hits the depth cap when the loop is wide (many members).
export const AUTO_TURN_RATE_CAP_PER_MINUTE = (() => {
  const raw = process.env.ARCO_CLUSTER_AUTO_TURN_RATE_CAP_PER_MINUTE;
  if (!raw) return 10;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return parsed;
})();

// Chain depth cap — peer_send messages produced during an auto-turn carry
// `chainDepth = parentDepth + 1`. The detector refuses to auto-turn on an
// incoming message whose chainDepth ≥ this cap. Operator-initiated peer_sends
// have chainDepth 0, so the first auto-turn lands at depth 1; if the
// recipient peer_sends as a result, depth=2; the next auto-turn lands at
// depth 2; depth=3 from that send means no further auto-turn.
export const AUTO_TURN_MAX_CHAIN_DEPTH = (() => {
  const raw = process.env.ARCO_CLUSTER_AUTO_TURN_MAX_CHAIN_DEPTH;
  if (!raw) return 3;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return parsed;
})();

// Skip-event spam guard — at most this many cluster_auto_turn_fired events
// with fired=false fire from any single cluster per 60s. The operator gets
// the signal "the detector is rejecting auto-turns" without 100 entries
// landing in events.jsonl per minute when an enthusiastic peer loop is
// hammering against the depth cap.
const SKIP_EVENT_RATE_LIMIT_MS = 60000;

interface ClusterRateState {
  // Rolling 60s window of fire timestamps. Trimmed at the head on every
  // check.
  fireTimestamps: number[];
  // Last-skip-event emission per reason. Keeps the spam-guard per-reason so
  // a fresh class of refusal still produces one event even if another reason
  // recently fired.
  lastSkipAt: Map<string, number>;
}

const clusterState = new Map<string, ClusterRateState>();

interface MemberState {
  // ms-epoch of the last auto-turn fired for this member, used for the
  // cooldown gate. Undefined ≡ never auto-turned.
  lastFiredAt?: number;
  // ChainDepth currently in flight for this member's auto-turn. Set by
  // `markAutoTurnDepth` immediately before dispatch and cleared by
  // `clearAutoTurnDepth` on primary_turn_ended. broadcastWorkflow reads
  // this when stamping peer_message_sent.chainDepth.
  currentAutoTurnDepth?: number;
}

const memberState = new Map<string, MemberState>();

let broadcastWorkflowFn: ((workflowId: string, msg: ServerMessage) => void) | undefined;
let dispatchAutoTurnFn: ((workflowId: string, content: string) => void) | undefined;
let isBusyFn: ((workflowId: string) => boolean) | undefined;
let resolveMembersFn: (() => Map<string, { workflowId: string; busy: boolean }[]> | undefined) | undefined;
let sweepTimer: NodeJS.Timeout | undefined;

// Resume-sweep cadence. The cooldown is 20s by default, so a 5s sweep gives
// up to 4 retry chances per cooldown window — enough to catch members that
// idled with stale mail without spamming the rate cap.
const SWEEP_INTERVAL_MS = (() => {
  const raw = process.env.ARCO_CLUSTER_AUTO_TURN_SWEEP_INTERVAL_MS;
  if (!raw) return 5000;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 500) return 5000;
  return parsed;
})();

export function configure(opts: {
  broadcastWorkflow: (workflowId: string, msg: ServerMessage) => void;
  dispatchAutoTurn: (workflowId: string, content: string) => void;
  isBusy: (workflowId: string) => boolean;
  resolveMembers?: () => Map<string, { workflowId: string; busy: boolean }[]> | undefined;
}): void {
  broadcastWorkflowFn = opts.broadcastWorkflow;
  dispatchAutoTurnFn = opts.dispatchAutoTurn;
  isBusyFn = opts.isBusy;
  if (opts.resolveMembers) resolveMembersFn = opts.resolveMembers;
}

// Resume-sweep poller. Covers gaps the event path can't:
//   • messages landed while recipient was busy AND `primary_turn_ended` already
//     fired before our event-driven re-entry was wired
//   • server restart with pending mail + idle recipient (no turn_ended ever
//     fires)
//   • operator just flipped auto-pickup ON with stale messages already sitting
// Walks every auto-pickup-enabled cluster, finds idle members with depth ≥ 1,
// and re-enters the detector with chainDepth=0 (chain broken — recipient is
// fully idle). The existing cooldown / rate-cap guards still apply; a member
// already auto-turned in the last 20s gets a `cooldown` skip, not a fire.
export function start(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void sweep();
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

export function stop(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

async function sweep(): Promise<void> {
  if (!resolveMembersFn || !isBusyFn) return;
  const membersByCluster = resolveMembersFn();
  if (!membersByCluster) return;
  for (const clusterId of clusterStore.listKnownClusterIds()) {
    if (!clusterStore.isAutoTurnOnMailboxEnabled(clusterId)) continue;
    const liveMembers = membersByCluster.get(clusterId);
    if (!liveMembers || liveMembers.length === 0) continue;
    for (const m of liveMembers) {
      if (m.busy) continue;
      const pending = await clusterMailbox.peek(m.workflowId).catch(() => []);
      if (pending.length === 0) continue;
      onPeerMessageSent({
        clusterId,
        senderWfid: pending[0].fromWorkflowId,
        recipientWfid: m.workflowId,
        incomingChainDepth: 0,
      });
    }
  }
}

function getClusterState(clusterId: string): ClusterRateState {
  let s = clusterState.get(clusterId);
  if (!s) {
    s = { fireTimestamps: [], lastSkipAt: new Map() };
    clusterState.set(clusterId, s);
  }
  return s;
}

function getMemberState(workflowId: string): MemberState {
  let s = memberState.get(workflowId);
  if (!s) {
    s = {};
    memberState.set(workflowId, s);
  }
  return s;
}

// Trim fire timestamps older than 60s. Called at the head of every guard
// check so the rate-cap check is O(window-size).
function trimWindow(state: ClusterRateState, now: number): void {
  const cutoff = now - 60000;
  while (state.fireTimestamps.length > 0 && state.fireTimestamps[0] < cutoff) {
    state.fireTimestamps.shift();
  }
}

// broadcastWorkflow reads this when stamping peer_message_sent.chainDepth.
// Returns the in-flight auto-turn depth for the SENDER workflow (i.e., the
// recipient of a prior auto-turn who is now itself sending). 0 for
// operator-initiated turns (no marker set).
export function currentAutoTurnDepth(workflowId: string): number {
  return memberState.get(workflowId)?.currentAutoTurnDepth ?? 0;
}

// Clear the auto-turn marker for a member. Called from broadcastWorkflow
// when primary_turn_ended fires for this member. The next operator turn
// starts at depth 0, the next auto-turn dispatch re-sets the marker.
export function clearAutoTurnDepth(workflowId: string): void {
  const s = memberState.get(workflowId);
  if (s) s.currentAutoTurnDepth = undefined;
}

// Drop a workflow from the per-member state when it leaves all clusters or
// the cluster is deleted. Mirrors clusterIdleNudger.dropMember.
export function dropMember(workflowId: string): void {
  memberState.delete(workflowId);
}

// Drop a cluster's transient rate state. Called on cluster deletion.
export function dropCluster(clusterId: string): void {
  clusterState.delete(clusterId);
}

// Emit a skip event (cluster_auto_turn_fired { fired: false }) if the
// rate-limit for skip events permits. The fired-true path bypasses this guard.
function emitSkip(
  clusterId: string,
  recipientWfid: string,
  senderWfid: string,
  chainDepth: number,
  reason: 'rate_capped' | 'depth_capped' | 'cooldown' | 'recipient_busy' | 'disabled',
  now: number,
): void {
  if (!broadcastWorkflowFn) return;
  const cs = getClusterState(clusterId);
  const lastSkip = cs.lastSkipAt.get(reason) ?? 0;
  if (now - lastSkip < SKIP_EVENT_RATE_LIMIT_MS) return;
  cs.lastSkipAt.set(reason, now);
  const msg: ServerMessage = {
    type: 'cluster_auto_turn_fired',
    clusterId,
    workflowId: recipientWfid,
    sender: senderWfid,
    chainDepth,
    reason,
    fired: false,
  };
  broadcastWorkflowFn(recipientWfid, msg);
}

// Public entry point — called from broadcastWorkflow's `peer_message_sent`
// branch (server/src/index.ts). The detector runs synchronously against the
// in-memory cluster + member state, dispatches via the configured callback
// when all guards pass, and emits the audit event either way.
//
// `incomingChainDepth` is the chainDepth carried on the just-broadcast
// peer_message_sent (stamped by broadcastWorkflow from
// `currentAutoTurnDepth(senderWfid)`). The detector treats undefined as 0
// per the operator-initiated default.
export function onPeerMessageSent(opts: {
  clusterId: string;
  senderWfid: string;
  recipientWfid: string;
  incomingChainDepth: number;
}): void {
  if (!broadcastWorkflowFn || !dispatchAutoTurnFn || !isBusyFn) return;
  const { clusterId, senderWfid, recipientWfid, incomingChainDepth } = opts;
  const now = Date.now();

  // Guard 0: cluster toggle armed. Most clusters won't have this on; the
  // gate is the first check so the hot path is one map lookup when off.
  if (!clusterStore.isAutoTurnOnMailboxEnabled(clusterId)) return;

  // Guard 1: depth cap. An incoming chainDepth of (cap - 1) is the last one
  // we'll auto-turn on; the auto-turn it produces will land at cap, so the
  // recipient's outbound peer_sends would carry chainDepth = cap (skipped).
  if (incomingChainDepth >= AUTO_TURN_MAX_CHAIN_DEPTH) {
    emitSkip(clusterId, recipientWfid, senderWfid, incomingChainDepth, 'depth_capped', now);
    return;
  }

  // Guard 2: recipient idle. We never auto-turn over an in-flight turn —
  // the operator's existing follow-up queue path covers mid-turn delivery.
  if (isBusyFn(recipientWfid)) {
    emitSkip(clusterId, recipientWfid, senderWfid, incomingChainDepth, 'recipient_busy', now);
    return;
  }

  // Guard 3: per-recipient cooldown.
  const ms = getMemberState(recipientWfid);
  if (ms.lastFiredAt !== undefined && now - ms.lastFiredAt < AUTO_TURN_COOLDOWN_MS) {
    emitSkip(clusterId, recipientWfid, senderWfid, incomingChainDepth, 'cooldown', now);
    return;
  }

  // Guard 4: per-cluster rate cap (rolling 60s).
  const cs = getClusterState(clusterId);
  trimWindow(cs, now);
  if (cs.fireTimestamps.length >= AUTO_TURN_RATE_CAP_PER_MINUTE) {
    emitSkip(clusterId, recipientWfid, senderWfid, incomingChainDepth, 'rate_capped', now);
    return;
  }

  // All guards pass — fire. Mark the new depth BEFORE dispatch so the
  // peer_send broadcast hook in broadcastWorkflow can read it during the
  // recipient's turn. Stamp the cooldown timestamp + rate-cap entry.
  const newDepth = incomingChainDepth + 1;
  ms.lastFiredAt = now;
  ms.currentAutoTurnDepth = newDepth;
  cs.fireTimestamps.push(now);

  const fireMsg: ServerMessage = {
    type: 'cluster_auto_turn_fired',
    clusterId,
    workflowId: recipientWfid,
    sender: senderWfid,
    chainDepth: newDepth,
    reason: 'mailbox_arrival',
    fired: true,
  };
  // The event lands on the recipient's workflow channel — that's the side
  // of interest (the audit row sits with the rest of the recipient's turn).
  broadcastWorkflowFn(recipientWfid, fireMsg);

  // Dispatch the synthetic primary turn. The prompt is the operator-
  // equivalent body documented in docs/PROTOCOL_CLUSTER.md; the recipient's
  // worker.ts treats it like any other user_message (pre-turn mailbox drain
  // fires first, then this prompt runs).
  //
  // Defer via setImmediate so the dispatch path can't re-enter the broadcast
  // chain that triggered us. The current call stack is mid-broadcast for
  // the original peer_message_sent — handleUserMessage may emit its own
  // broadcasts (user_message_echo, primary_turn_started) which would then
  // run through broadcastWorkflow synchronously. Pushing to the next tick
  // lets the outer broadcast unwind cleanly first.
  const prompt = buildClusterAutoPickup(clusterStore.getEfficiencyLevel(clusterId), clusterStore.getMemberRole(clusterId, recipientWfid));
  const dispatch = dispatchAutoTurnFn;
  setImmediate(() => {
    try {
      dispatch(recipientWfid, prompt);
      } catch (err) {
      // Dispatch failure leaves the cooldown + rate-cap entries in place
      // (intentional — we still consumed the budget; the operator can see
      // the dropped fire via the absence of a corresponding primary_turn_started
      // following the cluster_auto_turn_fired event).
      console.error(`[arco] auto-turn dispatch failed for ${recipientWfid.slice(0, 8)}:`, err);
    }
  });
}

// Test/debug surface — dump in-memory state for the smoke harness.
export function _peekState(): {
  clusters: Array<{ clusterId: string; firesInWindow: number }>;
  members: Array<{ workflowId: string; lastFiredAt?: number; currentAutoTurnDepth?: number }>;
} {
  const now = Date.now();
  return {
    clusters: Array.from(clusterState.entries()).map(([clusterId, s]) => {
      const cutoff = now - 60000;
      return {
        clusterId,
        firesInWindow: s.fireTimestamps.filter((t) => t >= cutoff).length,
      };
    }),
    members: Array.from(memberState.entries()).map(([workflowId, s]) => ({
      workflowId,
      lastFiredAt: s.lastFiredAt,
      currentAutoTurnDepth: s.currentAutoTurnDepth,
    })),
  };
}
