// Claude Native in-place compact smoke — the replay invariant.
//
// Pure (no dev server, no Anthropic call): the load-bearing correctness for the
// native compact is that a persisted `native_compacted` event makes a restart
// REPLAY reconstruct the same compacted history the live worker had — i.e. it
// resets everything before the marker (like a handoff) and re-seeds the summary,
// with later turns replaying on top. The summarization round itself (one
// Anthropic call) is UI-acceptance — not reachable headlessly.
//
//   1. buildMessagesFromReplayEvents drops pre-marker turns, seeds the summary,
//      and replays post-marker turns on top.
//   2. The seed is byte-identical to compactSummarySeed (live worker uses the
//      same helper — no prompt-cache split between live and replayed history).
//   3. summarizeClaudeNativePriorTurns (the >1MB summary_tail path) resets prior
//      turns at the marker and folds the compact summary into its output.
//
// Run: npm run smoke:native-compact

import { step, assert, assertEq, summary } from './lib.js';
import {
  buildMessagesFromReplayEvents,
  summarizeClaudeNativePriorTurns,
  compactSummarySeed,
} from '../../server/src/providers/claude-native/resumeSummary.js';

// Minimal events the replay parser understands: user_message_echo opens a turn,
// primary_text accumulates the reply, primary_complete flushes the pair.
function turn(seq: number, user: string, reply: string) {
  return [
    { type: 'user_message_echo', content: user, seq },
    { type: 'primary_text', text: reply, seq: seq + 1 },
    { type: 'primary_complete', seq: seq + 2 },
  ];
}

async function main() {
  await step('marker resets pre-compact turns, seeds summary, keeps post-compact turns', async () => {
    const events = [
      ...turn(1, 'first thing', 'did the first thing'),
      ...turn(4, 'second thing', 'did the second thing'),
      { type: 'native_compacted', summary: 'SUMMARY: built first + second thing.', seq: 7 },
      ...turn(8, 'third thing', 'did the third thing'),
    ];
    const messages = buildMessagesFromReplayEvents(events);

    // Expect: [summary user, summary-ack assistant, third-thing user, third reply].
    assertEq(messages.length, 4, 'four messages after compact + one trailing turn');
    const firstUser = String(messages[0].content);
    assert(/SUMMARY: built first \+ second thing/.test(firstUser), 'first message carries the summary');
    assert(!/first thing|second thing/.test(firstUser) || /SUMMARY/.test(firstUser),
      'pre-compact user turns are gone (only the summary remains)');
    assertEq(messages[2].content, 'third thing', 'the post-compact turn replays on top');
  });

  await step('replay seed is byte-identical to the live worker seed (compactSummarySeed)', async () => {
    const s = 'SUMMARY: state of the world.';
    const seed = compactSummarySeed(s);
    const replayed = buildMessagesFromReplayEvents([
      ...turn(1, 'x', 'y'),
      { type: 'native_compacted', summary: s, seq: 4 },
    ]);
    assertEq(JSON.stringify(replayed), JSON.stringify(seed), 'replayed history equals the seed exactly');
  });

  await step('summary_tail path folds the compact summary and drops pre-marker turns', async () => {
    const events = [
      ...turn(1, 'old work', 'old reply that should be dropped'),
      { type: 'native_compacted', summary: 'COMPACTED EARLIER CONTEXT', seq: 4 },
      ...turn(5, 'newer work', 'newer reply that should be summarized'),
    ];
    const built = summarizeClaudeNativePriorTurns(events);
    assert(/COMPACTED EARLIER CONTEXT/.test(built.summary), 'compact summary is folded in');
    assert(!/old reply that should be dropped/.test(built.summary), 'pre-marker turns are dropped');
    assert(/newer work/.test(built.summary), 'post-marker turns are summarized');
  });

  summary('Claude Native in-place compact — replay invariant');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
