import { readFileSync, realpathSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { join } from 'node:path';
import { atomicWriteFileSync, withFileLock } from '../atomicFile.js';
import { workflowDir, WFID_PATTERN } from '../workflowMeta.js';

export interface OllamaBoundary {
  version: 2;
  projectDigest: string;
  workflowId: string;
  sessionEpoch: number;
  throughSeq: number;
  digest: string;
  summary: string;
  foldedCount: number;
}

function pathFor(cwd: string, workflowId: string): string {
  if (!cwd || !WFID_PATTERN.test(workflowId)) throw new Error('Invalid workflow boundary identity');
  return join(workflowDir(cwd, workflowId), 'ollama-compact-boundary.json');
}
export function ollamaProjectDigest(cwd: string): string {
  return createHash('sha256').update(realpathSync(cwd)).digest('hex');
}
function valid(x: unknown, workflowId: string, projectDigest: string): x is OllamaBoundary {
  if (!x || typeof x !== 'object') return false;
  const b = x as OllamaBoundary;
  return b.version === 2 && b.workflowId === workflowId && b.projectDigest === projectDigest && Number.isSafeInteger(b.sessionEpoch) && b.sessionEpoch >= 0
    && Number.isSafeInteger(b.throughSeq) && b.throughSeq > b.sessionEpoch && /^[a-f0-9]{64}$/.test(b.digest)
    && typeof b.summary === 'string' && b.summary.length > 0 && b.summary.length <= 1024 * 1024
    && Number.isSafeInteger(b.foldedCount) && b.foldedCount > 0;
}
export function readOllamaBoundary(cwd: string, workflowId: string): OllamaBoundary | null {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(cwd, workflowId), 'utf8'));
    return valid(value, workflowId, ollamaProjectDigest(cwd)) ? value : null;
  } catch { return null; }
}

// The owner guard and atomic rename run without an intervening await, so STOP
// cannot revoke this turn between the last check and the commit. Newer cuts
// win; a stale worker never replaces a more recent boundary.
export async function saveOllamaBoundary(cwd: string, boundary: OllamaBoundary, stillOwner: () => boolean, onCommit?: () => void): Promise<boolean> {
  if (!valid(boundary, boundary.workflowId, ollamaProjectDigest(cwd))) return false;
  const file = pathFor(cwd, boundary.workflowId);
  return withFileLock(file, async () => {
    const directory = workflowDir(cwd, boundary.workflowId);
    await fs.mkdir(directory, { recursive: true });
    const release = await lockfile.lock(directory, { retries: { retries: 5, minTimeout: 25, maxTimeout: 250 } });
    try {
      if (!stillOwner()) return false;
      const previous = readOllamaBoundary(cwd, boundary.workflowId);
      if (previous && previous.sessionEpoch > boundary.sessionEpoch) return false;
      if (previous && previous.sessionEpoch === boundary.sessionEpoch && previous.throughSeq >= boundary.throughSeq) return false;
      atomicWriteFileSync(file, JSON.stringify(boundary), { mode: 0o600 });
      onCommit?.();
      return true;
    } finally { await release(); }
  });
}
