// Bounded per-turn git numstat parsing. The caller compares captured refs;
// paths are data, never command arguments assembled into shell strings.
export interface TurnChangeSummary {
  fileCount: number;
  added: number;
  removed: number;
  binaryFiles: number;
  paths: string[];
  pathsTruncated: boolean;
}
const PATH_LIMIT = 12;
const PATH_LENGTH = 200;

export function parseTurnNumstat(output: string): TurnChangeSummary | null {
  let fileCount = 0, added = 0, removed = 0, binaryFiles = 0;
  const paths: string[] = [];
  let pathTextTruncated = false;
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) return null;
    const [, additions, deletions, path] = match;
    if ((additions === '-') !== (deletions === '-')) return null;
    if (additions === '-') binaryFiles++;
    else {
      const a = Number(additions), d = Number(deletions);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(d) || !Number.isSafeInteger(added + a) || !Number.isSafeInteger(removed + d)) return null;
      added += a; removed += d;
    }
    fileCount++;
    if (paths.length < PATH_LIMIT) {
      if (path.length > PATH_LENGTH) pathTextTruncated = true;
      paths.push(path.length > PATH_LENGTH ? path.slice(0, PATH_LENGTH - 1) + '…' : path);
    }
  }
  return { fileCount, added, removed, binaryFiles, paths, pathsTruncated: fileCount > PATH_LIMIT || pathTextTruncated };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { checkpointStoreRoot } from './gitSnapshots.js';
const execGit = promisify(execFile);
const CHECKPOINT_REF = /^refs\/arco\/([A-Za-z0-9._-]+)\/(\d+)$/;

// Compare immutable checkpoint refs only. A failed or oversized git command
// returns null, never a partial count that could imply an exact diff.
export async function summarizeTurnChanges(cwd: string, from: string, to: string): Promise<TurnChangeSummary | null> {
  const start = CHECKPOINT_REF.exec(from), end = CHECKPOINT_REF.exec(to);
  if (!cwd || !start || !end || start[1] !== end[1] || from === to) return null;
  try {
    let prefix: string[] = [];
    try {
      const probe = await execGit('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000, maxBuffer: 4096 });
      if (probe.stdout.trim() !== 'true') prefix = ['--git-dir', join(checkpointStoreRoot(cwd), 'git')];
    } catch { prefix = ['--git-dir', join(checkpointStoreRoot(cwd), 'git')]; }
    const result = await execGit('git', [...prefix, 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '--no-renames', '-z', from, to, '--'], {
      cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
    return parseTurnNumstat(result.stdout);
  } catch { return null; }
}

// A timed-out pre-turn capture may finish later, but its result is discarded:
// the worker can already be editing by then and the ref is not a safe baseline.
export async function timelyCheckpoint<T>(capture: Promise<T | null>, timeoutMs = 2000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      capture.catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// Only a known read-only allowlist can prove that a primary cannot edit files.
// Other providers may expose dynamic or CLI tools outside their nominal list.
export function shouldCaptureTurn(opts: { chatMode: boolean; planMode: boolean; isolated: boolean; provider: string; tools?: string[] }): boolean {
  if (opts.chatMode || opts.planMode || opts.isolated) return false;
  const safe = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'AskUserQuestion']);
  if (opts.provider === 'ollama' && opts.tools && opts.tools.every(tool => safe.has(tool))) return false;
  return true;
}
