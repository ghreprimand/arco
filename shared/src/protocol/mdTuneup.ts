// ── Agent-instruction-file tune-up (CLAUDE.md / AGENTS.md / GEMINI.md compaction) ──
//
// A long-lived project's instruction file accretes cruft — dated session logs,
// resolved TODOs, restated rules — and since it is re-read on EVERY turn of
// EVERY worker, that bloat is a fixed per-turn token tax. This primitive runs
// ONE bounded, READ-ONLY worker turn that PROPOSES a compacted version of the
// file. The proposal comes back as `md_tuneup_proposed`; the client previews it
// as an A3 diff (original vs proposed) plus the agent's notes, and the operator
// Accepts or Rejects. On Accept the client fires `md_tuneup_accept`; the server
// backs up the original to `.arco/md-backups/<name>.<ts>.bak` and only THEN
// writes the proposed content through the `resolveWithinCwd`-guarded path.
//
// Fence note (CLAUDE.md "hard fences" → "LLM-mutated instructions across
// sessions"): the REJECTED pattern is autonomous, trace-derived, silent
// mutation (`headroom learn`). This is the opposite — operator-initiated
// (button), source is the file itself (not session traces), the agent only
// PROPOSES (NO Write tool), the operator reviews the diff and approves, and the
// write is backed up + reversible. Maps onto the documented "operator-reviewed"
// narrowing (EFFICIENCY_PLAN.md §13.7); same posture as docEdit.ts.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Which instruction file to tune. 'auto' lets the server pick by the
// workflow's primary provider (claude→CLAUDE.md, codex→AGENTS.md,
// gemini→GEMINI.md); otherwise a repo-RELATIVE path (e.g. 'CLAUDE.md',
// 'packages/api/AGENTS.md') chosen from the discovered candidates. The server
// resolves it through resolveWithinCwd and refuses anything escaping the cwd.
export type MdTuneupTarget = string;

// The set of filenames Arco treats as agent-instruction files when scanning a
// repo for tune-up candidates. Single source of truth for client + server.
export const INSTRUCTION_FILE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md'] as const;

// One discovered instruction file (repo-relative path, base name, byte size).
export interface MdTuneupCandidate {
  // Path relative to the workflow cwd (what the request echoes back as target).
  path: string;
  baseName: string;
  bytes: number;
}

// Client asks the server which instruction files exist in the cwd (so the
// dialog can offer a pick list instead of guessing). Fired when the operator
// opens the TUNE MD dialog.
export interface MdTuneupCandidatesRequestMessage {
  type: 'md_tuneup_candidates_request';
  workflowId: string;
}

// Server's answer (server→client). `defaultPath` is the candidate matching the
// tab's primary provider (pre-selected in the dialog), if present.
export interface MdTuneupCandidatesMessage {
  type: 'md_tuneup_candidates';
  workflowId: string;
  candidates: MdTuneupCandidate[];
  defaultPath?: string;
}

export interface MdTuneupRequestMessage {
  type: 'md_tuneup_request';
  workflowId: string;
  // Who runs the tune-up turn — RUN AS picker output, resolved like the
  // reviewer / doc-edit config. Read-only worker; never writes.
  editor: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  // 'auto' (server picks by provider) or a repo-relative path from the
  // discovered candidates. Guarded by resolveWithinCwd server-side.
  target: MdTuneupTarget;
}

// Fired when the tune-up worker is spawned (progress signal + authoritative id).
export interface MdTuneupStartedMessage {
  type: 'md_tuneup_started';
  workflowId: string;
  tuneupId: string;
  // Absolute path of the resolved instruction file, and its base name.
  filePath: string;
  baseName: string;
  // Byte length of the current (pre-tune) file, for the "before" stat.
  originalBytes: number;
  editor: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  startedAt: number;
}

// The proposal (server→client). `original` and `proposed` are the full file
// contents for the diff; `notes` is the agent's operator-facing summary of what
// it removed/condensed (NOT written to disk). On failure `error` is set and the
// content fields are empty.
export interface MdTuneupProposedMessage {
  type: 'md_tuneup_proposed';
  workflowId: string;
  tuneupId: string;
  filePath: string;
  baseName: string;
  original: string;
  proposed: string;
  notes: string;
  originalBytes: number;
  proposedBytes: number;
  error?: string;
  completedAt: number;
}

// Operator accepted the proposal (client→server). The server re-reads the
// current file, backs it up, then writes `proposed`. `tuneupId` + `filePath`
// are echoed for correlation/logging; `proposed` is the authoritative content
// to write (the server does not trust a cached copy).
export interface MdTuneupAcceptMessage {
  type: 'md_tuneup_accept';
  workflowId: string;
  tuneupId: string;
  filePath: string;
  proposed: string;
}

// Result of the accept (server→client). On success `backupPath` is the absolute
// path of the saved original; on failure `error` is set and nothing was written.
export interface MdTuneupAppliedMessage {
  type: 'md_tuneup_applied';
  workflowId: string;
  tuneupId: string;
  filePath: string;
  ok: boolean;
  backupPath?: string;
  bytesWritten?: number;
  error?: string;
  ts: number;
}
