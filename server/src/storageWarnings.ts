import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StorageWarningItem } from '@arco/shared';
import { atomicWriteFile, withFileLock } from './atomicFile.js';
import { isKept, readKeep } from './keepStore.js';

// Artifact size warnings (P7.4, docs/STORAGE_PLAN.md). Checked when a turn
// ends: an artifact file at or above the file threshold, or a conversation's
// artifacts at or above the conversation threshold, warns once. Thresholds are
// high on purpose (in the measured state 7 files and 2 conversations out of
// 1,895 would have warned). Kept items never warn.
const GiB = 1024 * 1024 * 1024;
function envBytes(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
export function fileWarnBytes(): number { return envBytes('ARCO_ARTIFACT_WARN_FILE_BYTES', GiB); }
export function conversationWarnBytes(): number { return envBytes('ARCO_ARTIFACT_WARN_CONVERSATION_BYTES', 5 * GiB); }

const STATE_FILE = 'storage-warnings.json';
const MAX_ENTRIES = 50_000;
interface WarnState { version: 1; files: Record<string, number>; conversationBytes: number }

async function readState(dir: string): Promise<WarnState> {
  try {
    const v = JSON.parse(await fs.readFile(path.join(dir, STATE_FILE), 'utf8')) as Partial<WarnState>;
    if (v.version === 1 && v.files && typeof v.files === 'object' && typeof v.conversationBytes === 'number') return v as WarnState;
  } catch { /* missing or unreadable: start fresh */ }
  return { version: 1, files: {}, conversationBytes: 0 };
}

// Sizes under artifacts/, links never followed, bounded.
async function artifactSizes(dir: string): Promise<{ total: number; large: Array<{ rel: string; bytes: number }> }> {
  const root = path.join(dir, 'artifacts');
  const limit = fileWarnBytes();
  let total = 0, seen = 0;
  const large: Array<{ rel: string; bytes: number }> = [];
  const stack = [root];
  while (stack.length && seen < MAX_ENTRIES) {
    const folder = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) break;
      const p = path.join(folder, entry.name);
      if (entry.isDirectory()) { stack.push(p); continue; }
      if (!entry.isFile()) continue;
      try {
        const st = await fs.lstat(p);
        if (!st.isFile()) continue;
        total += st.size;
        if (st.size >= limit) large.push({ rel: path.relative(dir, p).split(path.sep).join('/'), bytes: st.size });
      } catch { /* vanished */ }
    }
  }
  return { total, large };
}

// Returns the items that newly cross a threshold and records them, so each
// warns once. A conversation total warns again only after it grows by
// another conversation threshold.
export async function checkArtifactSizes(conversationDir: string): Promise<StorageWarningItem[]> {
  return withFileLock(path.join(conversationDir, STATE_FILE), async () => {
    const { total, large } = await artifactSizes(conversationDir);
    const convLimit = conversationWarnBytes();
    if (!large.length && total < convLimit) return [];
    const keep = await readKeep(conversationDir);
    const kept = keep.ok ? keep.items : [];
    const state = await readState(conversationDir);
    const items: StorageWarningItem[] = [];
    for (const file of large) {
      if (isKept(kept, file.rel) || state.files[file.rel] !== undefined) continue;
      state.files[file.rel] = file.bytes;
      items.push({ path: file.rel, bytes: file.bytes, kind: 'file' });
    }
    const next = state.conversationBytes ? state.conversationBytes + convLimit : convLimit;
    if (total >= next && !isKept(kept, 'artifacts')) {
      state.conversationBytes = total;
      items.push({ path: 'artifacts', bytes: total, kind: 'conversation' });
    }
    if (items.length) await atomicWriteFile(path.join(conversationDir, STATE_FILE), JSON.stringify(state) + '\n');
    return items;
  });
}
