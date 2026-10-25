// R5 (REMOTE_CLUSTER_CONTROL_PLAN.md §5) — the merged cluster activity feed.
//
// There is NO server-side activity store: the desktop ClusterActivityTab
// aggregates client-side from live WS events. For the phone console we
// reconstruct the same signal from bounded tails of each member's
// events.jsonl — read-only, deterministic, capped. Tool calls are folded into
// their turn's completion row (a count, not one row per call) so the feed
// stays scannable on a phone.

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { ClusterActivityRow } from '@archon/shared';

const TAIL_BYTES = 256 * 1024; // per member
const PREVIEW_CHARS = 160;
export const ACTIVITY_MAX_ROWS = 200; // merged cap (most recent kept)

// Bounded tail read of one member's events.jsonl → activity rows. Best-effort:
// unreadable/absent logs yield []. Exported for the unit test.
export function readMemberActivity(cwd: string, wfid: string): ClusterActivityRow[] {
  let fd: number | undefined;
  try {
    const path = join(cwd, '.archon', 'workflows', wfid, 'events.jsonl');
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // drop the partial first line

    const rows: ClusterActivityRow[] = [];
    let toolCount = 0;
    for (const line of lines) {
      if (!line) continue;
      let ev: {
        type?: string; ts?: number; to?: string; from?: string; fromName?: string;
        content?: string; contentPreview?: string; status?: string;
        durationMs?: number; pendingCount?: number;
      };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = typeof ev.ts === 'number' ? ev.ts : 0;
      switch (ev.type) {
        case 'peer_message_sent':
          rows.push({
            ts, memberId: wfid, kind: 'peer-sent',
            text: `→ ${(ev.to ?? '').slice(0, 8)}: ${(ev.contentPreview ?? '').slice(0, PREVIEW_CHARS)}`,
          });
          break;
        case 'peer_message_received':
          rows.push({
            ts, memberId: wfid, kind: 'peer-received',
            text: `← ${ev.fromName ?? (ev.from ?? '').slice(0, 8)}: ${(ev.content ?? '').slice(0, PREVIEW_CHARS)}`,
          });
          break;
        case 'primary_turn_started':
          toolCount = 0;
          rows.push({ ts, memberId: wfid, kind: 'turn-started', text: 'turn started' });
          break;
        case 'primary_tool_use':
          if (ev.status === 'started') toolCount++;
          break;
        case 'primary_complete':
          rows.push({
            ts, memberId: wfid, kind: 'turn-complete',
            text: `turn finished · ${toolCount} tool call(s)` +
              (typeof ev.durationMs === 'number' ? ` · ${Math.round(ev.durationMs / 1000)}s` : ''),
          });
          break;
        case 'cluster_member_nudged':
          rows.push({
            ts, memberId: wfid, kind: 'nudged',
            text: `idle nudge (✉ ${ev.pendingCount ?? '?'})`,
          });
          break;
        default:
          break;
      }
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// Merge every member's rows chronologically, keeping the most recent
// ACTIVITY_MAX_ROWS. Pure so the unit test can drive it with canned rows.
export function mergeActivity(perMember: ClusterActivityRow[][]): ClusterActivityRow[] {
  const all = perMember.flat();
  all.sort((a, b) => a.ts - b.ts);
  return all.length > ACTIVITY_MAX_ROWS ? all.slice(-ACTIVITY_MAX_ROWS) : all;
}
