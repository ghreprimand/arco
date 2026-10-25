// Durable manifests for operator-armed worktree bake-offs.
//
// Manifests live under ~/.archon rather than inside either the source checkout
// or an attempt worktree, so recording status never dirties a candidate diff.
// The cwd hash only partitions storage; every read still validates the
// manifest's sourceCwd + sourceWorkflowId before returning it.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BakeoffState } from '@archon/shared';
import { atomicWriteFile } from './atomicFile.js';
import { archonHome } from './archonHome.js';

const ID_RE = /^[a-f0-9-]{8,64}$/i;

function cwdHash(cwd: string): string {
  return createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

function manifestsDir(cwd: string): string {
  return path.join(archonHome(), 'bakeoffs', cwdHash(cwd), 'manifests');
}

function manifestPath(cwd: string, bakeoffId: string): string {
  if (!ID_RE.test(bakeoffId)) throw new Error('invalid bake-off id');
  return path.join(manifestsDir(cwd), `${bakeoffId}.json`);
}

function isBakeoffState(value: unknown): value is BakeoffState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<BakeoffState>;
  return typeof v.id === 'string'
    && typeof v.sourceWorkflowId === 'string'
    && typeof v.sourceCwd === 'string'
    && typeof v.createdAt === 'number'
    && Array.isArray(v.attempts);
}

export async function writeBakeoff(state: BakeoffState): Promise<void> {
  await atomicWriteFile(manifestPath(state.sourceCwd, state.id), JSON.stringify(state, null, 2) + '\n');
}

export async function readBakeoff(
  cwd: string,
  sourceWorkflowId: string,
  bakeoffId: string,
): Promise<BakeoffState | null> {
  try {
    const raw = await fs.readFile(manifestPath(cwd, bakeoffId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isBakeoffState(parsed)) return null;
    if (path.resolve(parsed.sourceCwd) !== path.resolve(cwd)) return null;
    if (parsed.sourceWorkflowId !== sourceWorkflowId) return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listBakeoffs(cwd: string, sourceWorkflowId: string): Promise<BakeoffState[]> {
  let names: string[];
  try {
    names = await fs.readdir(manifestsDir(cwd));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const states = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const raw = await fs.readFile(path.join(manifestsDir(cwd), name), 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (!isBakeoffState(parsed)) return null;
          if (parsed.sourceWorkflowId !== sourceWorkflowId) return null;
          if (path.resolve(parsed.sourceCwd) !== path.resolve(cwd)) return null;
          return parsed;
        } catch {
          return null;
        }
      }),
  );
  return states
    .filter((state): state is BakeoffState => state !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

