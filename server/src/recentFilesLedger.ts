// ARCHIVE (docs/ARCHIVE_PLAN.md §4.2) — the AGENT WRITES ledger. A global,
// append-only record of agent-produced files, so the RECENTS lens can answer
// "what did an agent just write for me, and in which tab?" WITH attribution
// (the exhaustive changed-within scan is the unattributed catch-all — §4.2).
//
// Written server-side at the persisting broadcast chokepoints (send() +
// broadcastWorkflow() in server/broadcast.ts, plus the manual POST
// /api/files/write). `matchFileEvent` is the regression-prone part — per-
// provider event shapes drift — so it is a PURE function unit-tested by
// recentFilesLedger.test.ts (same rationale as hooks.test.ts). This module
// imports NO server state; the callers resolve cwd / tab title / provider and
// the absolute path, keeping the matcher trivially testable.
//
// Coverage is incremental (§4.2): v1 matches Claude Native Write/Edit/
// NotebookEdit, the Review primitive artifact, media-op/stems results, and the
// manual file-write. CLI/Codex/Cursor tool-event extraction is best-effort
// follow-up — the gap is acceptable because RECENTLY MODIFIED is the catch-all.

import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import type { ServerMessage } from '@archon/shared';
import { atomicWriteFile } from './atomicFile.js';
import { archonHome } from './archonHome.js';

// Path is env-overridable purely as a test seam (recentFilesLedger.test.ts
// points it at a temp file); in prod it is always ~/.archon/recent-files.jsonl.
export const LEDGER_PATH =
  process.env.ARCHON_RECENT_FILES_LEDGER || join(archonHome(), 'recent-files.jsonl');
// Bounds (§4.2): append-only, compacted in place past 1000 lines → newest 500.
const MAX_LINES = 1000;
const KEEP_LINES = 500;

export interface LedgerRecord {
  ts: number;
  path: string;                       // absolute
  op: 'created' | 'modified';
  workflowId: string;
  tabTitle: string;
  provider: string;
  tool: string;
  // Owning project (basename of the cwd) — powers the RECENTS per-project
  // filter. Optional for back-compat with any pre-field lines on disk.
  project?: string;
}

// What the matcher can derive from the event ALONE. The caller resolves `rel`
// to an absolute path: 'cwd' → resolve(cwd, rel); 'artifact' → the workflow's
// artifacts dir + rel (a bare filename).
export interface FileEventMatch {
  scope: 'cwd' | 'artifact';
  rel: string;
  op: 'created' | 'modified';
  tool: string;
}

// The file-producing Native tools + the input key each carries the path under.
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
};

// PURE. Given a persisted workflow event, return a match descriptor or null.
// Never throws (malformed JSON input → null). op fidelity is best-effort: the
// Native tool result doesn't distinguish create vs overwrite, so writes default
// to 'modified' (§4.2 permits this); artifacts/media outputs are fresh writes.
export function matchFileEvent(msg: ServerMessage): FileEventMatch | null {
  switch (msg.type) {
    case 'primary_tool_use': {
      // Fire once, on successful completion — the terminal event. 'started' /
      // 'in_progress' / 'failed' don't record.
      if (msg.status !== 'completed') return null;
      const key = WRITE_TOOLS[msg.tool];
      if (!key) return null;
      let input: unknown;
      try { input = JSON.parse(msg.input); } catch { return null; }
      if (!input || typeof input !== 'object') return null;
      const p = (input as Record<string, unknown>)[key];
      if (typeof p !== 'string' || p.length === 0) return null;
      return { scope: 'cwd', rel: p, op: 'modified', tool: msg.tool };
    }
    case 'review_artifact_ready': {
      // A completed Review writes review-<ts>.md into the workflow's artifacts
      // dir. Skip the error case (no artifact was written).
      if (msg.error) return null;
      if (!msg.artifactName) return null;
      return { scope: 'artifact', rel: msg.artifactName, op: 'created', tool: 'Review' };
    }
    case 'media_op_result': {
      if (!msg.ok || !msg.relPath) return null;
      return { scope: 'cwd', rel: msg.relPath, op: 'created', tool: `media:${msg.op}` };
    }
    case 'media_stems_result': {
      if (!msg.ok || !msg.relDir) return null;
      return { scope: 'cwd', rel: msg.relDir, op: 'created', tool: 'stems' };
    }
    default:
      return null;
  }
}

// Resolve a match to the absolute on-disk path. `artifactsDirOf` is injected so
// this module stays state-free (the caller passes the workers/limits helper).
export function resolveMatchPath(
  match: FileEventMatch,
  cwd: string,
  artifactsDir: string,
): string {
  if (match.scope === 'artifact') return join(artifactsDir, match.rel);
  // resolve() returns rel verbatim when it's already absolute, else cwd/rel.
  return resolve(cwd, match.rel);
}

// Append one record + compact in place past the cap. Best-effort telemetry:
// failures are swallowed (never disrupt a broadcast). Atomic rewrite on compact
// (tmp + rename — the persistence discipline).
export async function appendRecord(rec: LedgerRecord): Promise<void> {
  try {
    await mkdir(dirname(LEDGER_PATH), { recursive: true });
    await appendFile(LEDGER_PATH, JSON.stringify(rec) + '\n', 'utf8');
    await compactIfNeeded();
  } catch {
    /* ledger is advisory — a write failure must never break the broadcast */
  }
}

async function compactIfNeeded(): Promise<void> {
  const raw = await readFile(LEDGER_PATH, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length <= MAX_LINES) return;
  const kept = lines.slice(-KEEP_LINES).join('\n') + '\n';
  // Advisory: this ledger is best-effort telemetry whose caller already
  // swallows failures, so it skips the fsync the durable stores pay for.
  await atomicWriteFile(LEDGER_PATH, kept, { durability: 'advisory' });
}

// Read the newest `limit` records (newest-first). Malformed lines are skipped.
export async function readRecent(limit = 100): Promise<LedgerRecord[]> {
  const raw = await readFile(LEDGER_PATH, 'utf8').catch(() => '');
  const out: LedgerRecord[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as LedgerRecord;
      if (rec && typeof rec.path === 'string') out.push(rec);
    } catch { /* skip malformed */ }
  }
  return out;
}
