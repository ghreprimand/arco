// Server-authoritative open-tab set ("workspace"). Before this, each browser
// owned its tab list in localStorage, so the MacBook (tailnet) and the workstation's
// own browser showed disjoint tabs, and a tab closed in one browser was
// resurrected by the other's next `rehydrate_workflows`. Now the server holds
// which workflow + cluster tabs are open; every browser reconciles to it on
// connect (`workspace_sync` → `workspace_snapshot`) and live on change
// (`workspace_changed`, fanned to every socket). Active tab stays per-browser.
//
// Scope: top-level workflow + chat tabs and cluster tabs. Incognito is NEVER
// tracked (memory-only boundary — it stays per-browser). Cluster members are
// filtered at snapshot time (their cluster carries them). Task children
// (parentWorkflowId) are NOT tabs and are never tracked: mirroring them made a
// fresh browser replay 64 hidden logs (three at 103 MB) and OOM'd the server
// on 2026-10-14; the parent's TaskCard covers them. Config is stored so a
// browser that has never seen a workflow can materialize it after a server
// restart, when the in-memory registry is empty; the live registry's config
// wins whenever the workflow is registered.
//
// One file per port so a smoke server on 3099 sharing ~/.arco can't clobber
// prod's set (same reason the session cookie name carries the port).

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { WorkflowConfig, WorkspaceSnapshotPayload, WorkspaceWorkflowEntry } from '@arco/shared';
import { atomicWriteFile } from './atomicFile.js';
import { workflows } from './server/state.js';
import * as clusterStore from './clusterStore.js';
import { arcoHome } from './arcoHome.js';

const PORT = parseInt(process.env.ARCO_PORT || '3001', 10);
const WORKSPACE_FILE = join(arcoHome(), PORT === 3001 ? 'workspace.json' : `workspace-${PORT}.json`);
const WFID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const MAX_ENTRIES = 256;

interface StoredWorkflow {
  config: WorkflowConfig;
  parentWorkflowId?: string;
  openedAt: number;
}

interface WorkspaceFile {
  version: 1;
  workflows: Record<string, StoredWorkflow>;
  clusters: string[];
}

let state: WorkspaceFile = { version: 1, workflows: {}, clusters: [] };
// False until the file exists. An unseeded workspace adopts whatever the first
// syncing browser holds locally, so the deploy doesn't blank everyone's tabs.
let seeded = false;
let loaded: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();
let listener: ((snap: WorkspaceSnapshotPayload) => void) | null = null;

export function onWorkspaceChange(fn: (snap: WorkspaceSnapshotPayload) => void): void {
  listener = fn;
}

export function loadWorkspace(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await fs.readFile(WORKSPACE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<WorkspaceFile>;
        const wfs = parsed.workflows && typeof parsed.workflows === 'object' ? parsed.workflows : {};
        for (const [id, e] of Object.entries(wfs)) if (e?.parentWorkflowId) delete wfs[id];
        state = {
          version: 1,
          workflows: wfs,
          clusters: Array.isArray(parsed.clusters) ? parsed.clusters.filter((c) => typeof c === 'string') : [],
        };
        seeded = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[arco] workspace.json unreadable — starting empty (will re-seed from browsers):', err);
        }
      }
    })();
  }
  return loaded;
}

function liveConfig(id: string, stored: StoredWorkflow): WorkflowConfig {
  const wf = workflows.get(id);
  // A boot-materialized config is a meta.json reconstruction missing
  // client-only fields — the stored one is more complete.
  return wf && !wf.bootMaterialized ? wf.config : stored.config;
}

function persist(): void {
  seeded = true;
  // Refresh stored configs from the live registry so a post-restart
  // materialization reflects the latest model / transport swaps.
  for (const [id, entry] of Object.entries(state.workflows)) entry.config = liveConfig(id, entry);
  const body = JSON.stringify(state, null, 2);
  writeChain = writeChain
    .then(() => atomicWriteFile(WORKSPACE_FILE, body))
    .catch((err) => console.error('[arco] workspace.json write failed:', err));
}

function changed(): void {
  persist();
  listener?.(snapshot());
}

export function snapshot(): WorkspaceSnapshotPayload {
  const out: WorkspaceWorkflowEntry[] = [];
  const ordered = Object.entries(state.workflows).sort((a, b) => a[1].openedAt - b[1].openedAt);
  for (const [id, entry] of ordered) {
    if (clusterStore.getClusterIdForWorkflow(id)) continue;
    out.push({
      workflowId: id,
      config: liveConfig(id, entry),
      ...(entry.parentWorkflowId ? { parentWorkflowId: entry.parentWorkflowId } : {}),
    });
  }
  return {
    workflows: out,
    clusters: state.clusters.map((clusterId) => ({ clusterId, memberIds: clusterStore.getMembers(clusterId) ?? [] })),
  };
}

function trackable(id: string, config: WorkflowConfig | undefined, parentWorkflowId?: string): config is WorkflowConfig {
  return WFID_RE.test(id) && !!config && !config.incognito && !parentWorkflowId && typeof config.workingDirectory === 'string';
}

export function workspaceOpenWorkflow(id: string, config: WorkflowConfig | undefined, parentWorkflowId?: string): void {
  if (!trackable(id, config, parentWorkflowId)) return;
  if (state.workflows[id]) {
    // Re-announce (resume / handoff re-send) — keep position, refresh config.
    state.workflows[id].config = config;
    persist();
    return;
  }
  if (Object.keys(state.workflows).length >= MAX_ENTRIES) return;
  state.workflows[id] = { config, openedAt: Date.now(), ...(parentWorkflowId ? { parentWorkflowId } : {}) };
  changed();
}

export function workspaceCloseWorkflow(id: string): void {
  if (!state.workflows[id]) return;
  delete state.workflows[id];
  changed();
}

export function workspaceOpenCluster(clusterId: string): void {
  if (!WFID_RE.test(clusterId) || state.clusters.includes(clusterId)) return;
  state.clusters.push(clusterId);
  changed();
}

export function workspaceCloseCluster(clusterId: string): void {
  if (!state.clusters.includes(clusterId)) return;
  state.clusters = state.clusters.filter((c) => c !== clusterId);
  changed();
}

// Members of a deleted / collapsed cluster keep running as plain workflows and
// need their own tabs — otherwise the next reconcile drops their jobs.
export function workspaceAdoptFormerMembers(ids: string[]): void {
  for (const id of ids) {
    const wf = workflows.get(id);
    if (wf) workspaceOpenWorkflow(id, wf.config);
  }
}

export function isClusterOpen(clusterId: string): boolean {
  return state.clusters.includes(clusterId);
}

// Only an UNSEEDED server adopts a browser's local tabs (first connect after
// the deploy, or workspace.json deleted). Once seeded the server's set is
// authoritative: a second browser's stale localStorage must not push its old
// tabs onto every other screen (2026-10-14 — the MacBook's first connect
// re-opened three long-closed tabs on workstation). `_adopt` is the client's
// per-browser hint, kept for wire compat but no longer honoured.
export async function syncWorkspace(
  _adopt: boolean,
  localWorkflows: Array<{ workflowId: string; config: WorkflowConfig; parentWorkflowId?: string }>,
  localClusters: string[],
): Promise<WorkspaceSnapshotPayload> {
  await loadWorkspace();
  if (!seeded) {
    let n = 0;
    for (const w of localWorkflows.slice(0, MAX_ENTRIES)) {
      if (!trackable(w.workflowId, w.config, w.parentWorkflowId) || state.workflows[w.workflowId]) continue;
      if (clusterStore.getClusterIdForWorkflow(w.workflowId)) continue;
      state.workflows[w.workflowId] = {
        config: w.config,
        openedAt: Date.now() + n++,
        ...(w.parentWorkflowId ? { parentWorkflowId: w.parentWorkflowId } : {}),
      };
    }
    for (const c of localClusters) {
      if (WFID_RE.test(c) && !state.clusters.includes(c)) state.clusters.push(c);
    }
    changed();
  }
  return snapshot();
}
