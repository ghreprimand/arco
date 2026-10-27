// docs/PERSISTENCE.md - branch-aware replay pre-pass.
//
// Proves the load-bearing invariants:
//  - leafSeq ABSENT ⇒ identity ⇒ byte-identical to pre-Phase-9 flat replay.
//  - A `leaf_move` event acts as a REDIRECT node: walking ancestry from the
//    leaf jumps to its targetSeq, pruning the abandoned branch.
//  - "Undo the undo" (a second leaf_move) moves the head freely between
//    branches, including back onto a previously-abandoned span.
//  - Malformed lineage (self-referential leaf_move) terminates (cycle guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterEventsToBranch,
  buildMessagesFromReplayEvents,
  walkBranchSeqs,
} from './resumeSummary.js';

// A linear three-turn transcript (A, B, C), each turn = echo + text + complete.
// parentEventSeq is the linear predecessor, exactly as persistAndStampSeq stamps.
function linearTurns() {
  return [
    { seq: 1, type: 'user_message_echo', content: 'A' },
    { seq: 2, parentEventSeq: 1, type: 'primary_text', text: 'a-resp' },
    { seq: 3, parentEventSeq: 2, type: 'primary_complete' },
    { seq: 4, parentEventSeq: 3, type: 'user_message_echo', content: 'B' },
    { seq: 5, parentEventSeq: 4, type: 'primary_text', text: 'b-resp' },
    { seq: 6, parentEventSeq: 5, type: 'primary_complete' },
    { seq: 7, parentEventSeq: 6, type: 'user_message_echo', content: 'C' },
    { seq: 8, parentEventSeq: 7, type: 'primary_text', text: 'c-resp' },
    { seq: 9, parentEventSeq: 8, type: 'primary_complete' },
  ];
}

const userContents = (msgs: ReturnType<typeof buildMessagesFromReplayEvents>): string[] =>
  msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : ''));

test('leafSeq absent → identity (no-regression): all turns replay, flat order', () => {
  const events = linearTurns();
  assert.deepEqual(filterEventsToBranch(events, undefined), events, 'returns the same array reference content');
  const msgs = buildMessagesFromReplayEvents(events as any);
  assert.deepEqual(userContents(msgs), ['A', 'B', 'C']);
});

test('leafSeq at physical tail (linear) → keeps the whole chain', () => {
  const events = linearTurns();
  const scoped = filterEventsToBranch(events, 9);
  assert.deepEqual(scoped.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('leaf_move redirect prunes the abandoned branch', () => {
  // After turn A (seq 3) the operator rewinds, then takes a NEW turn C'. The
  // leaf_move's own parent is the linear tail (6) — only the targetSeq redirect
  // excludes turn B.
  const events = [
    { seq: 1, type: 'user_message_echo', content: 'A' },
    { seq: 2, parentEventSeq: 1, type: 'primary_text', text: 'a-resp' },
    { seq: 3, parentEventSeq: 2, type: 'primary_complete' },
    { seq: 4, parentEventSeq: 3, type: 'user_message_echo', content: 'B' },
    { seq: 5, parentEventSeq: 4, type: 'primary_text', text: 'b-resp' },
    { seq: 6, parentEventSeq: 5, type: 'primary_complete' },
    { seq: 7, parentEventSeq: 6, type: 'leaf_move', targetSeq: 3 },
    { seq: 8, parentEventSeq: 7, type: 'user_message_echo', content: 'C' },
    { seq: 9, parentEventSeq: 8, type: 'primary_text', text: 'c-resp' },
    { seq: 10, parentEventSeq: 9, type: 'primary_complete' },
  ];
  const scoped = filterEventsToBranch(events, 10);
  assert.deepEqual(scoped.map((e) => e.seq), [1, 2, 3, 7, 8, 9, 10], 'turn B (4,5,6) is pruned');
  // The abandoned events are untouched in the source array (byte-identical on disk).
  assert.equal(events.length, 10);

  const msgs = buildMessagesFromReplayEvents(events as any, [], undefined, 10);
  assert.deepEqual(userContents(msgs), ['A', 'C'], 'turn B does not replay on the rewound branch');
});

test('undo the undo → a second leaf_move re-selects the abandoned branch', () => {
  // Same fork as above, then the operator rewinds AGAIN to seq 6 (end of the
  // once-abandoned turn B). The head now sits on the original linear branch.
  const events = [
    { seq: 1, type: 'user_message_echo', content: 'A' },
    { seq: 2, parentEventSeq: 1, type: 'primary_text', text: 'a-resp' },
    { seq: 3, parentEventSeq: 2, type: 'primary_complete' },
    { seq: 4, parentEventSeq: 3, type: 'user_message_echo', content: 'B' },
    { seq: 5, parentEventSeq: 4, type: 'primary_text', text: 'b-resp' },
    { seq: 6, parentEventSeq: 5, type: 'primary_complete' },
    { seq: 7, parentEventSeq: 6, type: 'leaf_move', targetSeq: 3 },
    { seq: 8, parentEventSeq: 7, type: 'user_message_echo', content: 'C' },
    { seq: 9, parentEventSeq: 8, type: 'primary_text', text: 'c-resp' },
    { seq: 10, parentEventSeq: 9, type: 'primary_complete' },
    { seq: 11, parentEventSeq: 10, type: 'leaf_move', targetSeq: 6 },
  ];
  const scoped = filterEventsToBranch(events, 11);
  assert.deepEqual(scoped.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 11], 'turn C (7..10) is now off-branch');
  const msgs = buildMessagesFromReplayEvents(events as any, [], undefined, 11);
  assert.deepEqual(userContents(msgs), ['A', 'B'], 'back on the original branch');
});

test('absent parentEventSeq → linear seq-1 fallback', () => {
  // Pre-Phase-0 events have no parentEventSeq; the walk must still chain via seq-1.
  const events = [
    { seq: 1, type: 'user_message_echo', content: 'A' },
    { seq: 2, type: 'primary_text', text: 'a-resp' },
    { seq: 3, type: 'primary_complete' },
  ];
  assert.deepEqual(filterEventsToBranch(events, 3).map((e) => e.seq), [1, 2, 3]);
});

test('full ancestry present → not truncated', () => {
  const { truncated, inScope } = walkBranchSeqs(linearTurns(), 9);
  assert.equal(truncated, false);
  assert.equal(inScope.size, 9);
});

test('ancestry rotated off → truncated (reconstructed signal)', () => {
  // Events 1..49 have rotated off the size-capped log; the surviving file
  // starts at seq 50, whose parentEventSeq (49) is no longer loaded.
  const events = [
    { seq: 50, parentEventSeq: 49, type: 'user_message_echo', content: 'X' },
    { seq: 51, parentEventSeq: 50, type: 'primary_text', text: 'x-resp' },
    { seq: 52, parentEventSeq: 51, type: 'primary_complete' },
  ];
  const { truncated, inScope } = walkBranchSeqs(events, 52);
  assert.equal(truncated, true, 'walk hit ancestry below the surviving range');
  // It still keeps what survived (50..52) so the branch is reconstructed, not empty.
  assert.deepEqual([...inScope].sort((a, b) => a - b), [50, 51, 52]);
});

test('self-referential leaf_move terminates (cycle guard)', () => {
  const events = [
    { seq: 1, type: 'user_message_echo', content: 'A' },
    { seq: 2, parentEventSeq: 1, type: 'leaf_move', targetSeq: 2 },
  ];
  // Must not hang. Visits 2 (redirect→2 already seen → stop).
  const scoped = filterEventsToBranch(events, 2);
  assert.deepEqual(scoped.map((e) => e.seq), [2]);
});
