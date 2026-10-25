// §2.1 — Fold smoke.
//
// Headless / module-level (no live server, no API spend). The Fold is fully
// DETERMINISTIC (no model round), so — unlike compact — its core can be
// exercised end-to-end without mocking an LLM. We drive the real pure pieces
// the worker.foldInPlace() composes and assert the load-bearing acceptance:
//
//   (a) the digest summarizes the folded prefix (task/files/cmds/todos);
//   (b) the token-budget tail keeps the most-recent verbatim turns;
//   (c) the reseed shape (compactSummarySeed(digest, tail)) is orphan-free;
//   (d) RESTART SURVIVES BYTE-IDENTICALLY — a persisted context_folded event
//       replayed through buildMessagesFromReplayEvents reconstructs exactly the
//       same messages[] the live fold produced (the load-bearing gotcha).
//
// Run: npm run smoke:fold   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const { buildFoldDigest } = await import('../../server/src/providers/claude-native/foldDigest.js');
  const { projectKeptTailByTokens } = await import('../../server/src/providers/claude-native/workerHelpers.js');
  const { compactSummarySeed, buildMessagesFromReplayEvents } = await import('../../server/src/providers/claude-native/resumeSummary.js');
  const { fullListOrphanToolUseIds } = await import('../../server/src/providers/claude-native/contentBlocks.js');

  // A realistic live messages[] with interleaved tool turns + a recent tail.
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'Build the Fold feature.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'foldDigest.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(50_000) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Build is green.' }] },
    { role: 'user', content: 'Now add the smoke.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Added the smoke; it passes.' }] },
  ];

  let digest = '';
  let keptTail: ReturnType<typeof projectKeptTailByTokens> = [];
  let liveSeed: ReturnType<typeof compactSummarySeed> = [];

  await step('§2.1.a digest summarizes the folded prefix', () => {
    const tailBudget = 200; // tokens — small so the prefix is most of history
    keptTail = projectKeptTailByTokens(messages as never, tailBudget);
    const rawPrefix = keptTail.length > 0 && keptTail.length < messages.length
      ? messages.slice(0, messages.length - keptTail.length)
      : messages;
    digest = buildFoldDigest(rawPrefix as never, [{ content: 'ship it', status: 'pending' }]);
    assert(digest.includes('Build the Fold feature'), 'original task in digest');
    assert(digest.includes('foldDigest.ts'), 'written file in digest');
    assert(digest.includes('npm run build'), 'command in digest');
    assert(digest.includes('ship it'), 'open todo re-injected');
  });

  await step('§2.1.b token-budget tail keeps the most-recent verbatim turn(s)', () => {
    assert(keptTail.length > 0, 'tail non-empty');
    assertEq(keptTail[0].role, 'user', 'tail starts on a user boundary');
    const tailText = JSON.stringify(keptTail);
    assert(tailText.includes('Now add the smoke') || tailText.includes('Added the smoke'), 'recent turn kept verbatim');
  });

  await step('§2.1.c reseed shape is orphan-free (no wedge)', () => {
    liveSeed = compactSummarySeed(digest, keptTail);
    const orphans = fullListOrphanToolUseIds(liveSeed as never);
    assertEq(orphans.length, 0, 'no orphan tool_use in the folded history');
  });

  await step('§2.1.d survives restart byte-identically (replay reconstructs the live fold)', () => {
    // Persisted marker the live worker would emit.
    const foldedEvent = { type: 'context_folded', summary: digest, keptTail };
    const replayed = buildMessagesFromReplayEvents([foldedEvent as never]);
    assertEq(JSON.stringify(replayed), JSON.stringify(liveSeed), 'replayed messages match the live fold byte-for-byte');
  });

  await step('§2.1.e a fold marker resets prior history then re-seeds (handoff-like)', () => {
    // Older turns before the marker must be discarded; only the seed survives.
    const events = [
      { type: 'user_message_echo', content: 'old turn' },
      { type: 'primary_text', text: 'old reply' },
      { type: 'primary_complete' },
      { type: 'context_folded', summary: digest, keptTail },
    ];
    const replayed = buildMessagesFromReplayEvents(events as never);
    assertEq(JSON.stringify(replayed), JSON.stringify(liveSeed), 'pre-fold history discarded, seed re-applied');
  });

  summary('fold');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
