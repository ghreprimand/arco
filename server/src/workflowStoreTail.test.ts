// replayTailEvents — the tail-first replay a never-seen (mirrored) tab gets
// instead of a seq-0 full replay (2026-10-14 OOM).
//
// Run: npm run test:replay-tail -w server

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { replayTailEvents } from './workflowStore.js';

async function seed(lines: object[]): Promise<{ cwd: string; wfid: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-replay-tail-'));
  const wfid = randomUUID();
  const dir = path.join(cwd, '.arco', 'workflows', wfid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { cwd, wfid };
}

function turn(seq: number, pad: string): object[] {
  return [
    { seq, ts: seq, type: 'user_message_echo', workflowId: 'x', content: `turn ${seq}` },
    { seq: seq + 1, ts: seq, type: 'primary_text_delta', workflowId: 'x', text: pad },
    { seq: seq + 2, ts: seq, type: 'primary_complete', workflowId: 'x' },
  ];
}

test('small log: full replay, not truncated, ts stripped', async () => {
  const { cwd, wfid } = await seed([...turn(1, 'a'), ...turn(4, 'b')]);
  const r = await replayTailEvents(cwd, wfid, 1024 * 1024);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.events.map((e) => (e as { seq: number }).seq), [1, 2, 3, 4, 5, 6]);
  assert.equal('ts' in (r.events[0] as object), false);
});

test('big log: window starts at a turn boundary, never mid-turn', async () => {
  const lines: object[] = [];
  for (let i = 0; i < 200; i++) lines.push(...turn(1 + i * 3, 'x'.repeat(500)));
  const { cwd, wfid } = await seed(lines);
  const r = await replayTailEvents(cwd, wfid, 20 * 1024);
  assert.equal(r.truncated, true);
  assert.ok(r.events.length > 0 && r.events.length < lines.length);
  assert.equal((r.events[0] as { type: string }).type, 'user_message_echo');
  const seqs = r.events.map((e) => (e as { seq: number }).seq);
  assert.equal(seqs[seqs.length - 1], 600, 'reaches the head');
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'contiguous');
});

test('missing log: empty', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-replay-tail-'));
  const r = await replayTailEvents(cwd, randomUUID(), 1024);
  assert.deepEqual(r, { events: [], truncated: false });
});
