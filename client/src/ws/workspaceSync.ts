// Client half of the server-authoritative workspace (server/src/workspace.ts).
// The server owns which workflow / chat / cluster tabs are open; this module
// reconciles the local Zustand store to it so every browser pointed at one
// server shows the same tabs. Active tab stays per-browser. Incognito jobs are
// local-only by design and are never reported, removed, or adopted.
//
// Two reconcile modes:
//   - initial (`workspace_snapshot`, every (re)connect): drop every local
//     non-incognito tab the server no longer has — the tab was closed in
//     another browser while this one was away.
//   - live (`workspace_changed`): drop only ids that were in the PREVIOUS
//     snapshot and are now gone. A tab mid-creation (e.g. a cluster member
//     before its cluster_created lands) can be momentarily absent from a
//     snapshot; diffing against the last snapshot keeps that from closing it.

import type { WorkspaceSnapshotPayload } from '@archon/shared';
import { useAppStore } from '../stores/appStore';

// Per-origin flag: this browser's local tabs were merged into the server's set
// once. Afterwards the server is authoritative and local extras are dropped.
const ADOPTED_KEY = 'archon.workspaceAdopted';

let lastIds: Set<string> | null = null;
let lastClusterIds: Set<string> | null = null;

function readAdopted(): boolean {
  try { return localStorage.getItem(ADOPTED_KEY) === '1'; } catch { return false; }
}

function markAdopted(): void {
  try { localStorage.setItem(ADOPTED_KEY, '1'); } catch { /* private window — re-adopts next time, harmless */ }
}

export function sendWorkspaceSync(ws: WebSocket): void {
  const { jobs, clusters } = useAppStore.getState();
  const local = Object.values(jobs).filter((j) => !j.config.incognito);
  ws.send(JSON.stringify({
    type: 'workspace_sync',
    adopt: !readAdopted(),
    workflows: local.map((j) => ({
      workflowId: j.id,
      config: j.config,
      ...(j.parentWorkflowId ? { parentWorkflowId: j.parentWorkflowId } : {}),
    })),
    clusterIds: Object.keys(clusters),
  }));
}

export function applyWorkspace(ws: WebSocket | null, workspace: WorkspaceSnapshotPayload, initial: boolean): void {
  const store = useAppStore.getState();
  const wfIds = new Set(workspace.workflows.map((w) => w.workflowId));
  const clusterIds = new Set(workspace.clusters.map((c) => c.clusterId));
  const keep = new Set(wfIds);
  for (const c of workspace.clusters) {
    for (const m of c.memberIds) keep.add(m);
    for (const m of store.clusters[c.clusterId]?.members ?? []) keep.add(m.workflowId);
  }

  // ── removals ──
  for (const job of Object.values(store.jobs)) {
    if (job.config.incognito || keep.has(job.id)) continue;
    // Task children ride with their (still-open) parent.
    if (job.parentWorkflowId && keep.has(job.parentWorkflowId)) continue;
    if (!initial && !lastIds?.has(job.id)) continue;
    store.removeJob(job.id);
  }
  for (const clusterId of Object.keys(store.clusters)) {
    if (clusterIds.has(clusterId)) continue;
    if (!initial && !lastClusterIds?.has(clusterId)) continue;
    store.clearCluster(clusterId);
  }

  // ── additions ──
  const fresh: string[] = [];
  for (const w of workspace.workflows) {
    if (useAppStore.getState().jobs[w.workflowId]) {
      // Server config is authoritative — catches CONFIG edits made in another
      // browser while this one was disconnected (workflow_config_synced is
      // live-only).
      if (initial) store.replaceJobConfig(w.workflowId, w.config);
      continue;
    }
    // Background-create: opening a tab elsewhere must not steal this
    // browser's focus.
    store.createJob(w.workflowId, w.config, undefined, w.parentWorkflowId, true);
    fresh.push(w.workflowId);
  }

  lastIds = keep;
  lastClusterIds = clusterIds;
  if (initial) markAdopted();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // ── rehydrate ──
  // Initial: every retained local job (incl. incognito + cluster members) so
  // the server re-attaches this socket and replays the gap. Live: only the
  // newly materialized ones, replayed from seq 0.
  // The server replays sequentially in this order, so the focused tab goes
  // first (it's the one the operator is looking at), then visible tabs, then
  // hidden task children. Never-seen tabs replay tail-only.
  const { jobs, activeJobId } = useAppStore.getState();
  const freshSet = new Set(fresh);
  const rank = (j: (typeof jobs)[string]) => (j.id === activeJobId ? 0 : j.parentWorkflowId ? 2 : 1);
  const toRehydrate = (initial ? Object.values(jobs) : fresh.map((id) => jobs[id]).filter(Boolean))
    .sort((a, b) => rank(a) - rank(b));
  if (toRehydrate.length > 0) {
    ws.send(JSON.stringify({
      type: 'rehydrate_workflows',
      workflows: toRehydrate.map((j) => ({
        workflowId: j.id,
        config: j.config,
        currentSessionId: j.currentSessionId,
        lastSeq: j.lastSeq ?? 0,
        ...(freshSet.has(j.id) ? { tail: true } : {}),
      })),
    }));
  }
  const localClusters = useAppStore.getState().clusters;
  for (const clusterId of clusterIds) {
    if (!initial && localClusters[clusterId]) continue;
    ws.send(JSON.stringify({ type: 'cluster_subscribe', clusterId }));
  }
}
