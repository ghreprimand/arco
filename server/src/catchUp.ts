import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import type { UtilityJobFact } from '@arco/shared';
import { flushWorkflowBuffer } from './workflowStore.js';
import { readLogTail } from './eventLog.js';

const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_FACTS = 32;
const TEXT_LIMIT = 350;
const DAY_MS = 24 * 60 * 60 * 1000;
export interface CatchUpEvent { ts?: number; type?: string; text?: unknown; content?: unknown; contentPreview?: unknown; op?: unknown; task?: { title?: unknown; status?: unknown; release?: unknown }; }
export interface CatchUpSource { id: string; label: string; events: CatchUpEvent[]; truncated?: boolean; unavailable?: boolean; }

function catchUpValue(e: CatchUpEvent): { kind: string; value: string } | null {
  if (e.type === 'primary_text' && typeof e.text === 'string') return { kind: 'Reply', value: e.text };
  if (e.type === 'user_message_echo' && typeof e.content === 'string') return { kind: 'Operator', value: e.content };
  if (e.type === 'peer_message_received' && typeof e.content === 'string') return { kind: 'Peer mail', value: e.content };
  if (e.type === 'peer_message_sent' && typeof e.contentPreview === 'string') return { kind: 'Peer sent', value: e.contentPreview };
  if (e.type === 'task_ledger_event') {
    return {
      kind: 'Board',
      value: `${String(e.op ?? 'changed')}: ${typeof e.task?.title === 'string' ? e.task.title : 'task'}${typeof e.task?.status === 'string' ? ` (${e.task.status})` : ''}${typeof e.task?.release === 'string' && e.task.release ? ` [release ${e.task.release.slice(0, 24)}]` : ''}`,
    };
  }
  return null;
}

// Counts the board changes inside (from, to] by the status they left a task in
// and, if labeled, by release. Deterministic; null when the board did not move.
export function boardMovement(sources: CatchUpSource[], from: number, to: number): string | null {
  const byStatus = new Map<string, number>();
  const byRelease = new Map<string, number>();
  let changes = 0;
  for (const source of sources) {
    for (const e of source.events) {
      if (e.type !== 'task_ledger_event' || typeof e.ts !== 'number' || e.ts <= from || e.ts > to) continue;
      changes++;
      const status = typeof e.task?.status === 'string' ? e.task.status : 'changed';
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      if (typeof e.task?.release === 'string' && e.task.release) byRelease.set(e.task.release.slice(0, 24), (byRelease.get(e.task.release.slice(0, 24)) ?? 0) + 1);
    }
  }
  if (changes === 0) return null;
  const parts = [`${changes} board change${changes === 1 ? '' : 's'}`, [...byStatus].map(([s, n]) => `${n} ${s}`).join(', ')];
  if (byRelease.size) parts.push(`by release: ${[...byRelease].map(([r, n]) => `${r} ${n}`).join(', ')}`);
  return parts.join('; ');
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
  // One line on how the board moved in the range: changes by resulting status,
  // and by release label when any task carries one.
  const movement = boardMovement(sources, from, to);
  if (movement) facts.push({ label: 'Board movement in this range', value: movement });
  // A member that is not loaded or is incognito is skipped, and said so.
  for (const source of sources) if (source.unavailable) facts.push({ label: source.label.slice(0, 64), value: 'activity not available' });
  return { facts, truncated };
}

export async function readCatchUpEvents(cwd: string, id: string): Promise<{ events: CatchUpEvent[]; truncated: boolean }> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('Invalid workflow.');
  await flushWorkflowBuffer(cwd, id);
  const eventPath = join(cwd, '.arco', 'workflows', id, 'events.jsonl');
  try {
    const stat = await lstat(eventPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe workflow activity file.');
    const root = await realpath(cwd), resolved = await realpath(eventPath);
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Workflow activity escapes the project.');
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false }; throw error; }
  // The live tail, plus the newest sealed segments when it is short (P7.3).
  const tail = await readLogTail(dirname(eventPath), MAX_TAIL_BYTES);
  const lines = tail.text.split('\n');
  if (tail.truncated) lines.shift();
  const events: CatchUpEvent[] = [];
  for (const line of lines) { try { const value = JSON.parse(line); if (value && typeof value === 'object') events.push(value as CatchUpEvent); } catch { /* partial or invalid record */ } }
  return { events, truncated: tail.truncated };
}
