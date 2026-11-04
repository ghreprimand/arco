import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { UtilityJobFact } from '@arco/shared';
import { flushWorkflowBuffer } from './workflowStore.js';

const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_FACTS = 32;
const TEXT_LIMIT = 350;
const DAY_MS = 24 * 60 * 60 * 1000;
export interface CatchUpEvent { ts?: number; type?: string; text?: unknown; content?: unknown; contentPreview?: unknown; op?: unknown; task?: { title?: unknown; status?: unknown }; }
export interface CatchUpSource { id: string; label: string; events: CatchUpEvent[]; truncated?: boolean; unavailable?: boolean; }

function catchUpValue(e: CatchUpEvent): { kind: string; value: string } | null {
  if (e.type === 'primary_text' && typeof e.text === 'string') return { kind: 'Reply', value: e.text };
  if (e.type === 'user_message_echo' && typeof e.content === 'string') return { kind: 'Operator', value: e.content };
  if (e.type === 'peer_message_received' && typeof e.content === 'string') return { kind: 'Peer mail', value: e.content };
  if (e.type === 'peer_message_sent' && typeof e.contentPreview === 'string') return { kind: 'Peer sent', value: e.contentPreview };
  if (e.type === 'task_ledger_event') {
    return {
      kind: 'Board',
      value: `${String(e.op ?? 'changed')}: ${typeof e.task?.title === 'string' ? e.task.title : 'task'}${typeof e.task?.status === 'string' ? ` (${e.task.status})` : ''}`,
    };
  }
  return null;
}

/** When no visit marker exists: empty tab, or from = tab start / last 24 hours. */
export function resolveCatchUpWindow(sources: CatchUpSource[], end: number): { empty: true } | { from: number } {
  let earliest: number | null = null;
  for (const source of sources) {
    if (source.unavailable) continue;
    for (const e of source.events) {
      if (typeof e.ts !== 'number' || e.ts > end) continue;
      const parsed = catchUpValue(e);
      if (!parsed || !parsed.value.trim()) continue;
      if (earliest === null || e.ts < earliest) earliest = e.ts;
    }
  }
  if (earliest === null) return { empty: true };
  const floor = Math.max(0, end - DAY_MS);
  // collectCatchUpFacts skips e.ts <= from. Young tabs start just before the
  // first event; older tabs cover only the last day.
  return { from: earliest >= floor ? Math.max(0, earliest - 1) : floor };
}

// Select only transcript and board activity, in timestamp order. Text fragments
// adjacent within one worker are joined before applying the per-fact limit.
export function collectCatchUpFacts(sources: CatchUpSource[], from: number, to: number): { facts: UtilityJobFact[]; truncated: boolean } {
  const rows: Array<{ ts: number; label: string; value: string; kind: string; id: string }> = [];
  let truncated = sources.some((s) => s.truncated);
  for (const source of sources) {
    for (const e of source.events) {
      if (typeof e.ts !== 'number' || e.ts <= from || e.ts > to) continue;
      const parsed = catchUpValue(e);
      if (!parsed || !parsed.value.trim()) continue;
      const { kind, value } = parsed;
      const last = rows.at(-1);
      if (kind === 'Reply' && last?.id === source.id && last.kind === kind) { last.value += value; continue; }
      rows.push({ ts: e.ts, label: source.label.slice(0, 64), value, kind, id: source.id });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (rows.length > MAX_FACTS) truncated = true;
  const facts = rows.slice(-MAX_FACTS).map((row) => {
    if (row.value.length > TEXT_LIMIT) truncated = true;
    return { label: `${new Date(row.ts).toISOString()} ${row.label} ${row.kind}`, value: row.value.slice(0, TEXT_LIMIT) };
  });
  // A member that is not loaded or is incognito is skipped, and said so.
  for (const source of sources) if (source.unavailable) facts.push({ label: source.label.slice(0, 64), value: 'activity not available' });
  return { facts, truncated };
}

export async function readCatchUpEvents(cwd: string, id: string): Promise<{ events: CatchUpEvent[]; truncated: boolean }> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('Invalid workflow.');
  await flushWorkflowBuffer(cwd, id);
  let file;
  const eventPath = join(cwd, '.arco', 'workflows', id, 'events.jsonl');
  try {
    const stat = await lstat(eventPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe workflow activity file.');
    const root = await realpath(cwd), resolved = await realpath(eventPath);
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Workflow activity escapes the project.');
    file = await open(eventPath, 'r');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false }; throw error; }
  try {
    const size = (await file.stat()).size, length = Math.min(size, MAX_TAIL_BYTES), data = Buffer.alloc(length);
    const { bytesRead } = await file.read(data, 0, length, size - length);
    const lines = data.subarray(0, bytesRead).toString('utf8').split('\n');
    if (size > length) lines.shift();
    const events: CatchUpEvent[] = [];
    for (const line of lines) { try { const value = JSON.parse(line); if (value && typeof value === 'object') events.push(value as CatchUpEvent); } catch { /* partial or invalid record */ } }
    return { events, truncated: size > length };
  } finally { await file.close(); }
}
