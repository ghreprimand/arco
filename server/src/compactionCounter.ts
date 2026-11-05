// Counts compactions per conversation for auto-handoff (operator decision for
// 0.1.5: hand off after N compactions, not at a context percentage).
// Counted: Claude Native `native_compacted` (COMPACT and automatic), the Claude
// CLI's compact boundaries, Codex app-server compactions (its own and Arco's)
// and Arco's durable Ollama compactions. Not counted: Fold, which keeps the
// conversation and only trims older tool output.
//
// The count belongs to one primary session; a new session (handoff, new
// conversation) starts at 0. It is saved in meta.json so a restart keeps it.

import type { WorkflowState } from './workflows/types.js';
import { workflows, workflowCwds } from './server/state.js';
import { updateMeta, type WorkflowMeta } from './workflowMeta.js';
import { setCompactionSink, type CompactionReport } from './compactionReport.js';

function sameConversation(wf: WorkflowState): boolean {
  const { session } = wf.autoHandoff;
  return session === undefined || wf.primarySessionId === undefined || session === wf.primarySessionId;
}

// Compactions counted in the tab's current conversation.
export function compactionsThisConversation(wf: WorkflowState): number {
  return wf.autoHandoff && sameConversation(wf) ? wf.autoHandoff.compactions : 0;
}

function persist(workflowId: string, wf: WorkflowState): void {
  const cwd = workflowCwds.get(workflowId) ?? wf.config.workingDirectory;
  if (!cwd || wf.config.incognito) return;
  const { compactions, session } = wf.autoHandoff;
  const value: NonNullable<WorkflowMeta['autoHandoffCount']> = { count: compactions, ...(session ? { session } : {}) };
  void updateMeta(cwd, workflowId, (meta) => { meta.autoHandoffCount = value; }).catch(() => { /* the live count still applies */ });
}

export function recordCompaction(report: CompactionReport): number | undefined {
  const wf = workflows.get(report.workflowId);
  if (!wf?.autoHandoff) return undefined;
  if (report.sessionId && wf.primarySessionId && report.sessionId !== wf.primarySessionId) return undefined;
  const ah = wf.autoHandoff;
  if (!sameConversation(wf)) { ah.compactions = 0; ah.fired = false; }
  ah.compactions += 1;
  if (wf.primarySessionId) ah.session = wf.primarySessionId;
  persist(report.workflowId, wf);
  console.log(`[arco] [${report.workflowId.slice(0, 8)}] compaction counted (${report.source}): ${ah.compactions} this conversation`);
  return ah.compactions;
}

// A new conversation starts (handoff complete): the count starts again.
export function resetCompactions(workflowId: string, wf: WorkflowState): void {
  if (!wf.autoHandoff) return;
  const had = wf.autoHandoff.compactions !== 0 || wf.autoHandoff.session !== undefined;
  wf.autoHandoff.compactions = 0;
  wf.autoHandoff.fired = false;
  wf.autoHandoff.session = undefined;
  if (had) persist(workflowId, wf);
}

// Restore a saved count when the tab is loaded, if it belongs to the session
// the tab resumes.
export function restoreCompactions(wf: WorkflowState, saved: unknown): void {
  if (!wf.autoHandoff || !saved || typeof saved !== 'object') return;
  const r = saved as Record<string, unknown>;
  if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 0) return;
  const session = typeof r.session === 'string' ? r.session : undefined;
  if (session && wf.primarySessionId && session !== wf.primarySessionId) return;
  wf.autoHandoff.compactions = Math.min(r.count, 1000);
  wf.autoHandoff.session = session;
}

setCompactionSink((report) => { recordCompaction(report); });
