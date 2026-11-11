import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getClusterIdForWorkflow, getMemberAccessMode } from './clusterStore.js';
import { readMeta, updateMeta, workflowDir, type WorkflowMeta } from './workflowMeta.js';
import { flushWorkflowBuffer, getHeadSeq } from './workflowStore.js';

/** Server-owned references. Never accepted from WorkflowConfig or tool input. */
export interface HandoffHistorySource {
  key: string;
  workflowId: string;
  cwd: string;
  name: string;
  throughSeq: number;
  grantedAtSeq: number;
  createdAt: number;
}

export function historyEligible(config: { kind?: string; incognito?: boolean }, mode = 'standard'): boolean {
  return config.kind !== 'chat' && !config.incognito && mode === 'standard';
}

export function historyAccessAllowed(workflowId: string, config: { kind?: string; incognito?: boolean }): boolean {
  const cluster = getClusterIdForWorkflow(workflowId);
  return historyEligible(config, cluster ? getMemberAccessMode(cluster, workflowId) : 'standard');
}

export function buildHandoffHistory(
  source: Pick<WorkflowMeta, 'workflowId' | 'cwd' | 'name'>,
  throughSeq: number,
  grantedAtSeq: number,
  ancestors: HandoffHistorySource[],
): HandoffHistorySource[] {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 1) return [];
  return [
    { key: randomUUID(), ...source, throughSeq, grantedAtSeq, createdAt: Date.now() },
    ...ancestors.filter(r => r.grantedAtSeq <= throughSeq && !(r.workflowId === source.workflowId && r.cwd === source.cwd))
      .map(r => ({ ...r, grantedAtSeq })),
  ];
}

/** Reject symlinked state components before reading a saved conversation. */
export async function safeHistoryMeta(cwd: string, workflowId: string): Promise<WorkflowMeta | null> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(workflowId)) return null;
  try {
    const root = await realpath(cwd);
    for (const target of [path.join(root, '.arco'), path.join(root, '.arco', 'workflows'), workflowDir(root, workflowId), path.join(workflowDir(root, workflowId), 'meta.json')]) {
      if ((await lstat(target)).isSymbolicLink()) return null;
    }
    const meta = await readMeta(root, workflowId);
    return meta && historyAccessAllowed(workflowId, meta) ? meta : null;
  } catch { return null; }
}

/** Capture before a summarizer can append reflection or handoff events. */
export async function captureHandoffHistory(cwd: string, workflowId: string, cutoff?: number): Promise<HandoffHistorySource[]> {
  const source = await safeHistoryMeta(cwd, workflowId);
  if (!source) return [];
  await flushWorkflowBuffer(cwd, workflowId);
  const head = await getHeadSeq(cwd, workflowId);
  const through = cutoff === undefined ? head : Math.min(head, Math.max(0, Math.floor(cutoff)));
  return buildHandoffHistory({ workflowId, cwd, name: source.name }, through, 0, source.handoffHistory ?? []);
}

/** Link persistence is optional: failure must never discard a successful handoff. */
export async function saveHandoffHistory(cwd: string, workflowId: string, refs: HandoffHistorySource[], stillOwned: () => boolean = () => true): Promise<boolean> {
  if (!refs.length) return false;
  try {
    const grantSeq = (await getHeadSeq(cwd, workflowId)) + 1;
    let previous: HandoffHistorySource[] | undefined;
    const saved = await updateMeta(cwd, workflowId, meta => {
      if (!stillOwned() || !historyAccessAllowed(workflowId, meta)) return false;
      previous = meta.handoffHistory;
      meta.handoffHistory = refs.map(ref => ({ ...ref, grantedAtSeq: grantSeq }));
    });
    if (!saved) throw new Error('Handoff source could not be saved.');
    if (!stillOwned()) {
      await updateMeta(cwd, workflowId, meta => {
        if (meta.handoffHistory?.[0]?.key !== refs[0].key) return false;
        meta.handoffHistory = previous;
      });
      return false;
    }
    return saved.handoffHistory?.[0]?.key === refs[0].key;
  } catch (error) {
    console.error('[arco] Handoff source link was not saved; continuing without it:', error);
    return false;
  }
}
