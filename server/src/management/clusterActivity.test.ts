// R5 — cluster activity reconstruction contract. Event lines mirror REAL
// events.jsonl shapes (sampled 2026-07-17 from live cluster members): tool
// calls fold into their turn's completion row, peer messages keep bounded
// previews, and the merge is chronological + capped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemberActivity, mergeActivity, ACTIVITY_MAX_ROWS } from './clusterActivity.js';

const WF = 'wf-activity-test-0001';

function writeEvents(lines: object[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-activity-test-'));
  mkdirSync(join(cwd, '.archon', 'workflows', WF), { recursive: true });
  writeFileSync(
    join(cwd, '.archon', 'workflows', WF, 'events.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  return cwd;
}

test('reconstructs peer/turn/nudge rows and folds tool calls into the turn', () => {
  const cwd = writeEvents([
    { seq: 1, ts: 1000, type: 'primary_turn_started', workflowId: WF, startedAt: 1000 },
    { seq: 2, ts: 1100, type: 'primary_tool_use', workflowId: WF, tool: 'peer_list', input: '{}', status: 'started' },
    { seq: 3, ts: 1150, type: 'primary_tool_use', workflowId: WF, tool: 'peer_list', input: '{}', status: 'completed' },
    { seq: 4, ts: 1200, type: 'primary_tool_use', workflowId: WF, tool: 'Read', input: '{}', status: 'started' },
    { seq: 5, ts: 1300, type: 'peer_message_sent', workflowId: WF, msgId: 'm1', from: WF, to: 'aaaabbbb-1234', contentPreview: 'Hey — status update …' },
    { seq: 6, ts: 1400, type: 'primary_complete', workflowId: WF, phase: 'passthrough', costUsd: 0, durationMs: 20262 },
    { seq: 7, ts: 1500, type: 'peer_message_received', workflowId: WF, msgId: 'm2', from: 'ccccdddd-5678', fromName: 'Builder', content: 'Status check response: nothing claimed yet.' },
    { seq: 8, ts: 1600, type: 'cluster_member_nudged', workflowId: WF, reason: 'idle_with_pending', idleSeconds: 12, pendingCount: 2 },
    { seq: 9, ts: 1700, type: 'primary_text', workflowId: WF, text: 'noise — not an activity row' },
  ]);
  const rows = readMemberActivity(cwd, WF);
  assert.deepEqual(rows.map((r) => r.kind), [
    'turn-started', 'peer-sent', 'turn-complete', 'peer-received', 'nudged',
  ]);
  const complete = rows.find((r) => r.kind === 'turn-complete')!;
  assert.match(complete.text, /2 tool call\(s\)/, 'only status:started counts');
  assert.match(complete.text, /20s/, 'duration rendered');
  assert.match(rows.find((r) => r.kind === 'peer-sent')!.text, /^→ aaaabbbb: Hey/);
  assert.match(rows.find((r) => r.kind === 'peer-received')!.text, /^← Builder: Status check/);
  assert.match(rows.find((r) => r.kind === 'nudged')!.text, /✉ 2/);
  assert.ok(rows.every((r) => r.memberId === WF));
});

test('tool counter resets per turn', () => {
  const cwd = writeEvents([
    { ts: 1, type: 'primary_turn_started', workflowId: WF },
    { ts: 2, type: 'primary_tool_use', workflowId: WF, status: 'started' },
    { ts: 3, type: 'primary_complete', workflowId: WF, durationMs: 1000 },
    { ts: 4, type: 'primary_turn_started', workflowId: WF },
    { ts: 5, type: 'primary_complete', workflowId: WF, durationMs: 1000 },
  ]);
  const completes = readMemberActivity(cwd, WF).filter((r) => r.kind === 'turn-complete');
  assert.match(completes[0].text, /1 tool call/);
  assert.match(completes[1].text, /0 tool call/);
});

test('missing log yields empty, never throws', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-activity-empty-'));
  assert.deepEqual(readMemberActivity(cwd, WF), []);
});

test('merge is chronological across members and capped to the most recent', () => {
  const a = Array.from({ length: 150 }, (_, i) => ({
    ts: i * 2, memberId: 'a', kind: 'turn-started' as const, text: 'a',
  }));
  const b = Array.from({ length: 150 }, (_, i) => ({
    ts: i * 2 + 1, memberId: 'b', kind: 'turn-started' as const, text: 'b',
  }));
  const merged = mergeActivity([a, b]);
  assert.equal(merged.length, ACTIVITY_MAX_ROWS, 'capped');
  for (let i = 1; i < merged.length; i++) {
    assert.ok(merged[i].ts >= merged[i - 1].ts, 'sorted ascending');
  }
  assert.equal(merged[merged.length - 1].ts, 299, 'most recent kept');
});
