// Cluster snapshots — operator-saved whole-cluster artifacts (config + members
// + full conversation histories) persisted server-side at
// ~/.archon/cluster-snapshots/<id>/. Mirrors cluster PRESETS, but presets ride
// HTTP and capture only member CONFIGS; snapshots ride WS (the four
// cluster_snapshot_* ClientMessages) and capture full state + history.
//
// State here is just the summary list + a restoringId spinner flag. The store
// holds a module-level sender registered by useWebSocket (the liveChangesStore
// pattern), so any component can dispatch save/list/restore/delete without
// prop-threading the WS handle. Server replies land in handleServerMessage and
// fold back through the onList / onSaved / onError reducers below.

import { create } from 'zustand';
import type { ClientMessage, ClusterSnapshotSummary } from '@archon/shared';

type Sender = (msg: ClientMessage) => void;

let sender: Sender | null = null;
let pendingSave: {
  clusterId: string;
  workflowId: string;
  name: string;
  saveToCloud: boolean;
  replaceSnapshotId?: string;
} | null = null;

export function registerClusterSnapshotSender(fn: Sender | null) {
  sender = fn;
}

// Request senders — each maps 1-to-1 to a ClientMessage variant. No-op when the
// socket isn't registered yet (server replies are the source of truth anyway).
export function requestClusterSnapshotList() {
  sender?.({ type: 'cluster_snapshot_list' });
}

export function requestClusterSnapshotSave(
  clusterId: string,
  workflowId: string,
  name: string,
  saveToCloud = false,
  replaceSnapshotId?: string,
) {
  pendingSave = { clusterId, workflowId, name, saveToCloud, ...(replaceSnapshotId ? { replaceSnapshotId } : {}) };
  sender?.({
    type: 'cluster_snapshot_save',
    clusterId,
    workflowId,
    name,
    ...(replaceSnapshotId ? { replaceSnapshotId } : {}),
  });
}

// Upload one completed local snapshot. Cloud names are also unique
// case-insensitively: the first collision asks; the retry carries the exact
// cloud row id returned by the conflict, so a stale confirmation cannot
// overwrite a different snapshot or accumulate same-name copies.
export async function uploadClusterSnapshotToCloud(
  snapshotId: string,
  replaceSnapshotId?: string,
  confirmReplacement = true,
): Promise<boolean> {
  const response = await fetch(
    `/api/cluster-snapshots/${encodeURIComponent(snapshotId)}/cloud${
      replaceSnapshotId ? `?replaceSnapshotId=${encodeURIComponent(replaceSnapshotId)}` : ''
    }`,
    { method: 'POST' },
  );
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    existing?: { id?: string; name?: string; uploadedAt?: string };
  };
  if (response.status === 409 && body.code === 'duplicate_name' && !replaceSnapshotId && body.existing?.id) {
    const when = body.existing?.uploadedAt
      ? ` from ${new Date(body.existing.uploadedAt).toLocaleString()}`
      : '';
    if (
      confirmReplacement &&
      !window.confirm(`A cloud snapshot named "${body.existing?.name ?? 'this name'}" already exists${when}. Replace it?`)
    ) {
      return false;
    }
    return uploadClusterSnapshotToCloud(snapshotId, body.existing.id, false);
  }
  if (!response.ok) throw new Error(body.error ?? 'cloud save failed');
  return true;
}

// `turnsPerMember` is the operator's "last N turns per worker" choice, applied
// uniformly to every restored member. Omit (undefined) to restore ALL turns;
// pass a positive integer to keep only the last N turns. We only include the
// field on the wire when it's a positive integer (the server treats omitted /
// 0 / negative identically as "all", but keeping the message lean is cleaner).
export function requestClusterSnapshotRestore(snapshotId: string, targetCwd?: string, turnsPerMember?: number) {
  useClusterSnapshotsStore.getState().markRestoring(snapshotId);
  sender?.({
    type: 'cluster_snapshot_restore',
    snapshotId,
    ...(targetCwd && targetCwd.trim() ? { targetCwd: targetCwd.trim() } : {}),
    ...(typeof turnsPerMember === 'number' && turnsPerMember > 0 ? { turnsPerMember } : {}),
  });
}

export function requestClusterSnapshotDelete(snapshotId: string) {
  sender?.({ type: 'cluster_snapshot_delete', snapshotId });
}

interface ClusterSnapshotsState {
  snapshots: ClusterSnapshotSummary[];
  // snapshotId currently being restored — drives a per-row spinner until the
  // cluster_created (success) or cluster_snapshot_error (failure) lands.
  restoringId: string | null;
  // Last save/restore/delete error, surfaced near the list. Cleared on the next
  // successful list push.
  error: string | null;
  onList: (snapshots: ClusterSnapshotSummary[]) => void;
  onSaved: (snapshot: ClusterSnapshotSummary) => void;
  onConflict: (clusterId: string, requestedName: string, existing: ClusterSnapshotSummary) => void;
  onError: (message: string, op: 'save' | 'list' | 'restore' | 'delete', snapshotId?: string) => void;
  markRestoring: (snapshotId: string) => void;
  // Cleared by the cluster_created handler once a restore-minted cluster lands.
  clearRestoring: () => void;
}

export const useClusterSnapshotsStore = create<ClusterSnapshotsState>((set) => ({
  snapshots: [],
  restoringId: null,
  error: null,
  // Server pushes the authoritative newest-first list after every save/delete
  // (and as the reply to an explicit list request), so replace wholesale.
  onList: (snapshots) => set({ snapshots, error: null }),
  // Optimistic prepend on save — the follow-up cluster_snapshot_list replaces
  // it with the canonical ordering, so a brief duplicate can't persist.
  onSaved: (snapshot) => {
    set((s) => ({
      snapshots: s.snapshots.some((x) => x.id === snapshot.id)
        ? s.snapshots
        : [snapshot, ...s.snapshots],
      error: null,
    }));
    const pending = pendingSave;
    pendingSave = null;
    if (pending?.saveToCloud && pending.name.trim().toLowerCase() === snapshot.name.trim().toLowerCase()) {
      void uploadClusterSnapshotToCloud(snapshot.id, undefined, pending.replaceSnapshotId === undefined)
        .catch((err) => set({ error: err instanceof Error ? err.message : String(err) }));
    }
  },
  onConflict: (clusterId, requestedName, existing) => {
    const pending = pendingSave;
    if (
      !pending ||
      pending.clusterId !== clusterId ||
      pending.name.trim().toLowerCase() !== requestedName.trim().toLowerCase()
    ) {
      pendingSave = null;
      set({ error: `Snapshot "${existing.name}" already exists. Refresh and try again.` });
      return;
    }
    const when = new Date(existing.createdAt).toLocaleString();
    const cloudNote = pending.saveToCloud
      ? ' The cloud snapshot with this name will also be replaced.'
      : '';
    if (window.confirm(`A local snapshot named "${existing.name}" already exists from ${when}. Replace it?${cloudNote}`)) {
      requestClusterSnapshotSave(
        pending.clusterId,
        pending.workflowId,
        pending.name,
        pending.saveToCloud,
        existing.id,
      );
    } else {
      pendingSave = null;
      set({ error: null });
    }
  },
  onError: (message, op, snapshotId) => {
    if (op === 'save') pendingSave = null;
    set((s) => ({
      error: message,
      // A restore failure echoes the attempted id so we clear that row's spinner.
      restoringId: op === 'restore' && (snapshotId === undefined || snapshotId === s.restoringId) ? null : s.restoringId,
    }));
  },
  markRestoring: (snapshotId) => {
    set({ restoringId: snapshotId, error: null });
    // Safety net: the spinner is normally cleared by the cluster_created
    // (success) or cluster_snapshot_error (failure) reply. But if the socket
    // drops between request and reply — e.g. a server restart mid-restore — that
    // reply is lost and the row would sit on RESTORING… forever (the store isn't
    // persisted, so only a full page reload would clear it). Bound it.
    setTimeout(() => {
      const st = useClusterSnapshotsStore.getState();
      if (st.restoringId === snapshotId) st.clearRestoring();
    }, 30000);
  },
  clearRestoring: () => set({ restoringId: null }),
}));
