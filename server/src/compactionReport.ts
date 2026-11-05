// Where providers report a finished compaction of a tab's conversation. No
// imports on purpose: provider workers call this without pulling in server
// state. compactionCounter.ts installs the sink when the server loads.
// A Fold (context_folded) is not a compaction here.

export type CompactionSource = 'claude-native' | 'claude-cli' | 'codex' | 'ollama';
export interface CompactionReport {
  workflowId: string;
  source: CompactionSource;
  // The provider session the compaction happened in, when known. A report for
  // a session other than the tab's current one (a side worker) is ignored.
  sessionId?: string;
}

let sink: ((report: CompactionReport) => void) | null = null;
export function setCompactionSink(fn: ((report: CompactionReport) => void) | null): void { sink = fn; }
export function reportCompaction(report: CompactionReport): void {
  if (!report.workflowId) return;
  try { sink?.(report); } catch { /* counting must never break a provider */ }
}
