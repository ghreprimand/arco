// docs/PROTOCOL_CLUSTER.md - history rehydrate.
//
// Pending peer messages persist on disk as
// `~/.arco/clusters/<id>/mailbox/<recipientWfid>/<msgId>.json`. When a WS
// client reconnects (or the server reboots and a fresh subscribe lands),
// the on-disk mailbox still has the undelivered messages but no in-memory
// subscriber has seen the original peer_message_sent broadcast. Rehydrate
// re-emits one peer_message_sent per undelivered message so the cluster
// panel + each member's chat view light up with the pending activity.
//
// Trigger: first `cluster_subscribe` per cluster per server lifetime
// (tracked in-memory). Decision §13 — `cluster_subscribe` over server
// boot because:
//   - At server boot, no operator is watching yet; emitting events on
//     channels that have zero subscribers buys nothing and could fire
//     for clusters the operator may never reopen.
//   - At `cluster_subscribe`, we have a concrete operator-driven trigger.
//     One scan per cluster lifetime; in-memory Set prevents the duplicate.
//
// Already-drained messages do not re-emit because `clusterMailbox.drain`
// removes the file from disk. Anything left in the mailbox dir is by
// definition still pending.

import * as clusterStore from './clusterStore.js';
import * as clusterMailbox from './clusterMailbox.js';
import type { ServerMessage } from '@arco/shared';

const rehydratedClusters = new Set<string>();

// Test-only — drop the rehydrated-clusters memo so a fresh subscribe
// triggers a fresh rehydrate. Currently unused outside future smokes.
export function _resetForTesting(): void {
  rehydratedClusters.clear();
}

export async function rehydrateClusterOnce(
  clusterId: string,
  opts: {
    broadcastWorkflow: (workflowId: string, msg: ServerMessage) => void;
  },
): Promise<void> {
  if (rehydratedClusters.has(clusterId)) return;
  rehydratedClusters.add(clusterId);
  const state = await clusterStore.readCluster(clusterId).catch(() => null);
  if (!state) return;
  for (const wfid of state.members) {
    const pending = await clusterMailbox.peek(wfid).catch(() => []);
    for (const m of pending) {
      const evt: ServerMessage = {
        type: 'peer_message_sent',
        workflowId: m.fromWorkflowId,
        msgId: m.msgId,
        from: m.fromWorkflowId,
        to: m.toWorkflowId,
        contentPreview: m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content,
      };
      // broadcastWorkflow stamps the event into the SENDER's events.jsonl
      // and fans out to that workflow's live observers. The cluster
      // panel always subscribes to every member workflow on tab open
      // (the existing pattern shared with the original peer_message_sent
      // emit), so we don't ALSO fire via broadcastCluster — that would
      // double-deliver to any WS subscribed to both channels.
      //
      // Persistence note: this DOES write a new row to the sender's
      // events.jsonl. In practice the only path that hits rehydrate
      // after an original send is a server restart — the per-cluster
      // rehydratedClusters Set prevents a re-emit on subsequent
      // cluster_subscribes in the same server lifetime. Cross-restart
      // duplication is acceptable (audit-trail bloat, not a correctness
      // issue) and is documented in GOTCHAS.
      opts.broadcastWorkflow(m.fromWorkflowId, evt);
    }
  }
}
