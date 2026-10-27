// DEBAG - Durable Edit-Before-Approve Gate (docs/PROVIDERS.md).
//
// Per-workflow, session-scoped sidecar persisting (a) any UNRESOLVED gate so a
// systemd restart can re-surface it (rehydrateGatesOnce), and (b) standing
// "approve all like this" approvals (sub-phase 5). Lives at
// <cwd>/.arco/workflows/<wfid>/gate-approvals.json — NOT .arco/project/
// (that's cwd-shared across tabs; gates are per-workflow). events.jsonl remains
// the durable audit source of truth; this sidecar is the fast rehydrate lookup.
//
// No locking: tool dispatch is sequential per worker (only one gate parks at a
// time) and the file is per-wfid (no cross-member sharing on a shared cwd), so
// the read-modify-write here never races.

import { promises as fs } from 'fs';
import path from 'path';
import { workflowDir, WFID_PATTERN } from '../../workflowMeta.js';
import { atomicWriteFile } from '../../atomicFile.js';

export interface PendingGateRecord {
  gateId: string;
  toolName: string;
  category: string;
  reason: string;
  proposedArgs: Record<string, unknown>;
  signature: string;
  createdAt: number;
}

// Sub-phase 5 — a scoped standing approval keyed by the NON-lossy signature.
export interface StandingApproval {
  signature: string;
  toolName: string;
  approvedAt: number;
  // Human-readable sample of the approved call (for the operator's revoke list).
  sample?: string;
}

export interface GateStore {
  schemaVersion: 1;
  pending: PendingGateRecord[];
  standing: StandingApproval[];
}

function emptyStore(): GateStore {
  return { schemaVersion: 1, pending: [], standing: [] };
}

function validateWfid(wfid: string): void {
  if (!WFID_PATTERN.test(wfid)) {
    throw new Error(`gateStore: invalid wfid ${JSON.stringify(wfid)}`);
  }
}

export function gateStorePath(cwd: string, wfid: string): string {
  return path.join(workflowDir(cwd, wfid), 'gate-approvals.json');
}

export async function readGateStore(cwd: string, wfid: string): Promise<GateStore> {
  if (!cwd) return emptyStore();
  validateWfid(wfid);
  try {
    const raw = await fs.readFile(gateStorePath(cwd, wfid), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GateStore>;
    return {
      schemaVersion: 1,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      standing: Array.isArray(parsed.standing) ? parsed.standing : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

export async function writeGateStore(cwd: string, wfid: string, store: GateStore): Promise<void> {
  if (!cwd) return;
  validateWfid(wfid);
  await atomicWriteFile(gateStorePath(cwd, wfid), JSON.stringify(store, null, 2) + '\n');
}

// Record (or replace) a pending gate. Idempotent on gateId.
export async function recordPendingGate(cwd: string, wfid: string, rec: PendingGateRecord): Promise<void> {
  if (!cwd) return;
  const store = await readGateStore(cwd, wfid);
  store.pending = store.pending.filter((p) => p.gateId !== rec.gateId);
  store.pending.push(rec);
  await writeGateStore(cwd, wfid, store);
}

// Remove a pending gate by id (on resolve or abort). Returns the record removed,
// if any — the restart-resume path uses it to feed the approved action.
export async function clearPendingGate(cwd: string, wfid: string, gateId: string): Promise<PendingGateRecord | null> {
  if (!cwd) return null;
  const store = await readGateStore(cwd, wfid);
  const found = store.pending.find((p) => p.gateId === gateId) ?? null;
  if (!found) return null;
  store.pending = store.pending.filter((p) => p.gateId !== gateId);
  await writeGateStore(cwd, wfid, store);
  return found;
}

// ── Standing approvals (sub-phase 5 — "approve all like this") ───────────────

// True if the LIVE signature already has a standing approval. The caller passes
// a freshly-computed signature (live-args re-evaluation, §4.1) so a changed
// command — which hashes differently — never matches and re-prompts.
export async function hasStandingApproval(cwd: string, wfid: string, signature: string): Promise<boolean> {
  if (!cwd) return false;
  const store = await readGateStore(cwd, wfid);
  return store.standing.some((s) => s.signature === signature);
}

// Add (idempotent on signature). Used on an UNEDITED approve+remember.
export async function addStandingApproval(cwd: string, wfid: string, approval: StandingApproval): Promise<void> {
  if (!cwd) return;
  const store = await readGateStore(cwd, wfid);
  if (store.standing.some((s) => s.signature === approval.signature)) return;
  store.standing.push(approval);
  await writeGateStore(cwd, wfid, store);
}

// Revoke by signature. Returns true if one was removed.
export async function removeStandingApproval(cwd: string, wfid: string, signature: string): Promise<boolean> {
  if (!cwd) return false;
  const store = await readGateStore(cwd, wfid);
  const before = store.standing.length;
  store.standing = store.standing.filter((s) => s.signature !== signature);
  if (store.standing.length === before) return false;
  await writeGateStore(cwd, wfid, store);
  return true;
}
