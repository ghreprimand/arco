// Slot 11 — server crash recovery. On startup, scans known cwds for workflows
// active in the last 24h; pre-inits workflowStore so seq continuity holds
// across the restart and `send()` can resolve cwds for recovered workflows
// before the first client reconnect. Also exposes event-log scanners for
// operator-queue + pending-plan-artifact restoration (gap resolutions #2 and
// #6 in UNIFIED_IMPLEMENTATION_PLAN.md).
//
// "Known cwds" design: option (a) from the Slot-11 prompt — maintain a
// registry at ~/.archon/known-cwds.json written on workflow create /
// rehydrate. Chosen over option (b) (client-driven lazy rehydration only)
// so the startup "Recovered N workflows from disk" log has a real count.
// Option (c) (belt-and-suspenders) was rejected because a single source beats
// the drift risk when two lookup paths disagree.
//
// Running workers are NOT restored — they were child subprocesses of the
// crashed server and don't survive kill -9. Only the workflow identity,
// transcript, build-log, and event log survive. Next operator message drives
// the orchestrator back to steady state via the same first-turn injection
// path Slot 9 / Slot 10 already exercise.

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { listWorkflowMetas, readMeta, type WorkflowMeta } from './workflowMeta.js';
import { initWorkflowStore } from './workflowStore.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

const REGISTRY_PATH = path.join(os.homedir(), '.archon', 'known-cwds.json');
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

async function readRegistry(): Promise<string[]> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

async function writeRegistry(cwds: string[]): Promise<void> {
  // Atomic: a torn write here loses the registry crash-recovery reads on the
  // next boot, so recovered workflows would silently drop to zero.
  await atomicWriteFile(REGISTRY_PATH, JSON.stringify(cwds, null, 2) + '\n');
}

// Append `cwd` to the known-cwds registry if missing. Called on workflow
// create + rehydrate so crash-recovery can find it on next startup. Failure
// to write isn't fatal — the next create/rehydrate retries. The caller is
// expected to pass a consistent resolved path (server uses config.workingDirectory
// which the client already resolves before submit).
export async function rememberCwd(cwd: string): Promise<void> {
  if (!cwd) return;
  // Serialized: read-modify-write over one shared file, and several workflows
  // can be created or rehydrated concurrently on boot. Unserialized, two
  // appends racing would drop one cwd from the registry.
  return withFileLock(REGISTRY_PATH, async () => {
    try {
      const existing = await readRegistry();
      if (existing.includes(cwd)) return;
      existing.push(cwd);
      await writeRegistry(existing);
    } catch (err) {
      console.error('[archon] known-cwds write failed:', err);
    }
  });
}

export interface RecoveredWorkflow {
  cwd: string;
  meta: WorkflowMeta;
}

// Startup scan. Walks the registry, lists each cwd's recent workflows (24h
// window), pre-inits workflowStore (per Slot-5 discovery: initWorkflowStore
// MUST run before the first broadcast, or seqs restart from 0 and duplicate
// on disk). Returns the surviving workflows for the caller to register into
// its in-memory cwd lookup + emit the acceptance-criterion startup log.
export async function recoverWorkflowsFromDisk(): Promise<RecoveredWorkflow[]> {
  const cwds = await readRegistry();
  const now = Date.now();
  const recovered: RecoveredWorkflow[] = [];
  for (const cwd of cwds) {
    let summaries;
    try {
      summaries = await listWorkflowMetas(cwd);
    } catch (err) {
      console.error(`[archon] recovery scan failed for ${cwd}:`, err);
      continue;
    }
    for (const s of summaries) {
      if (now - s.lastActiveAt > RECOVERY_WINDOW_MS) continue;
      let meta: WorkflowMeta | null = null;
      try {
        meta = await readMeta(cwd, s.workflowId);
      } catch { /* skip unreadable */ }
      if (!meta) continue;
      try {
        await initWorkflowStore(cwd, meta.workflowId);
      } catch (err) {
        console.error(`[archon] workflowStore init failed for ${meta.workflowId.slice(0, 8)}:`, err);
        continue;
      }
      recovered.push({ cwd, meta });
    }
  }
  return recovered;
}

