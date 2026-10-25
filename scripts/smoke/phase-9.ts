// PHASE_9_FORKS_PLAN.md sub-phase 2 — branch-aware replay end-to-end smoke.
//
// Tests the rewind MECHANISM directly (no LLM turn, no WS, no API): builds a
// real events.jsonl on disk with the same on-disk envelope persistAndStampSeq
// writes ({seq, ts, parentEventSeq?, ...message}), then drives the REAL
// replayMessagesWithResumePolicy and asserts the load-bearing invariants:
//
//   1. leafSeq ABSENT  → flat replay includes every turn (byte-identical to
//      pre-Phase-9 behavior — the no-regression invariant).
//   2. leafSeq SET     → the rewound branch replays; the abandoned span is
//      pruned via the leaf_move redirect node.
//   3. Post-rewind turns are picked up WITHOUT advancing leafSeq (the walk
//      starts from the physical tail, honoring the redirect chain): a STALE
//      leafSeq value still yields the full active branch.
//   4. The events.jsonl file is byte-identical before/after replay — abandoned
//      branches survive on disk (contrast Purge, which destroys).
//
// Run: npm run smoke:phase-9   (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { replayMessagesWithResumePolicy } from '../../server/src/providers/claude-native/resumeSummary.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wfid = '99999999-0000-1111-2222-333333333333';

// One on-disk events.jsonl line, matching persistAndStampSeq's envelope.
function line(seq: number, parentEventSeq: number | undefined, body: Record<string, unknown>): string {
  return JSON.stringify({ seq, ts: 1000 + seq, ...(parentEventSeq !== undefined ? { parentEventSeq } : {}), ...body }) + '\n';
}

// A turn = echo + text + complete, three consecutive seqs.
function turn(startSeq: number, parent: number | undefined, userText: string, asstText: string): string {
  return (
    line(startSeq, parent, { type: 'user_message_echo', workflowId: wfid, content: userText }) +
    line(startSeq + 1, startSeq, { type: 'primary_text', workflowId: wfid, text: asstText }) +
    line(startSeq + 2, startSeq + 1, { type: 'primary_complete', workflowId: wfid })
  );
}

const userContents = (msgs: Awaited<ReturnType<typeof replayMessagesWithResumePolicy>>['messages']): string[] =>
  msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : ''));

async function main() {
  const cleanups: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'arco-phase9-'));
  cleanups.push(cwd);
  const eventsPath = join(cwd, '.arco', 'workflows', wfid, 'events.jsonl');
  mkdirSync(join(cwd, '.arco', 'workflows', wfid), { recursive: true });

  // Linear turns A, B, then a rewind to the end of turn A (seq 3) followed by a
  // new turn C. The leaf_move's own parent is the linear tail (9) — only its
  // targetSeq=3 redirect excludes turn B.
  const log =
    turn(1, undefined, 'A', 'a-resp') +              // seq 1..3
    turn(4, 3, 'B', 'b-resp') +                       // seq 4..6  (abandoned)
    line(7, 6, { type: 'leaf_move', workflowId: wfid, targetSeq: 3, source: 'revert', createdAt: 1700 }) +
    turn(8, 7, 'C', 'c-resp');                        // seq 8..10 (active branch)
  writeFileSync(eventsPath, log);
  const before = readFileSync(eventsPath, 'utf8');

  await step('1. leafSeq absent → flat replay includes every turn (no-regression)', async () => {
    const r = await replayMessagesWithResumePolicy(cwd, wfid);
    assertEq(r.mode, 'exact', 'small log replays exact');
    assert(JSON.stringify(userContents(r.messages)) === JSON.stringify(['A', 'B', 'C']),
      `expected [A,B,C], got ${JSON.stringify(userContents(r.messages))}`);
  });

  await step('2. leafSeq set → abandoned branch (turn B) is pruned', async () => {
    const r = await replayMessagesWithResumePolicy(cwd, wfid, undefined, { leafSeq: 10 });
    assert(JSON.stringify(userContents(r.messages)) === JSON.stringify(['A', 'C']),
      `expected [A,C], got ${JSON.stringify(userContents(r.messages))}`);
  });

  await step('3. stale leafSeq still picks up post-rewind turns (walk from tail)', async () => {
    // leafSeq=7 is the leaf_move's own seq (stale — turn C appended after it).
    // The walk starts from the physical tail (10), so turn C is still included.
    const r = await replayMessagesWithResumePolicy(cwd, wfid, undefined, { leafSeq: 7 });
    assert(JSON.stringify(userContents(r.messages)) === JSON.stringify(['A', 'C']),
      `expected [A,C] from a stale leafSeq, got ${JSON.stringify(userContents(r.messages))}`);
  });

  await step('4. events.jsonl is byte-identical after replay (abandoned branch survives)', async () => {
    const after = readFileSync(eventsPath, 'utf8');
    assertEq(after, before, 'replay must not mutate the append-only log');
  });

  await step('5. rotated-off ancestry → replay flags reconstructed (hygiene-B)', async () => {
    // A separate workflow whose log starts at seq 50 (1..49 rotated off).
    const wf2 = '88888888-0000-1111-2222-333333333333';
    const ev2 = join(cwd, '.arco', 'workflows', wf2, 'events.jsonl');
    mkdirSync(join(cwd, '.arco', 'workflows', wf2), { recursive: true });
    writeFileSync(ev2,
      line(50, 49, { type: 'user_message_echo', workflowId: wf2, content: 'X' }) +
      line(51, 50, { type: 'primary_text', workflowId: wf2, text: 'x-resp' }) +
      line(52, 51, { type: 'primary_complete', workflowId: wf2 }));
    const r = await replayMessagesWithResumePolicy(cwd, wf2, undefined, { leafSeq: 52 });
    assertEq(r.reconstructed, true, 'rotated-off ancestry must set reconstructed');
    // The surviving turn still replays — reconstructed, not empty.
    assert(userContents(r.messages).includes('X'), 'surviving turn X still replays');
  });

  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
  summary('phase-9');
}

void main();
