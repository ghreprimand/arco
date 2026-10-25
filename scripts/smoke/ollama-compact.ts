// M8 (LOCAL_AI_MASTER_PLAN / Hardening §6 Phase 4) — Ollama auto-compaction unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It drives
// the exported primitives in server/src/providers/ollamaRecovery.ts directly
// (the deterministic core of the worker's private maybeCompact), plus the M7
// summary seam with a STUB fetch / unconfigured config, and asserts the
// load-bearing M8 invariants. Offline-runnable (CI has no daemon).
//
// Asserts (the M8 task's required list):
//   - trigger fires AT threshold and NOT below (shouldAutoCompact / warn band)
//   - the leading system block is preserved verbatim
//   - the current + last-10 messages are kept VERBATIM
//   - the older half is summarized (folded to one seed message)
//   - the DETERMINISTIC fallback fires when the seam returns null (compaction
//     still happens — never fails closed)
//   - tool-message sanitization removes orphans (no daemon-choking pairing)
//   - oversized tool-call args are truncated to the placeholder cap
//   - the ollama_compacted record carries before/after byte + token counts
//   - maxAutoRecoveries semantics (one compaction per turn) hold
//
// Run: npm run smoke:ollama-compact   (no dev server needed)

import {
  defaultCompactionConfig,
  shouldAutoCompact,
  shouldWarnContext,
  splitForCompaction,
  assembleCompacted,
  sanitizeToolMessages,
  truncateToolCallArgs,
  deterministicDigest,
  compactionStats,
  compactionSeedMessage,
  type CompactMessage,
} from '../../server/src/providers/ollamaRecovery.js';
import {
  runUtilitySummaryJob,
  type UtilityMessage,
} from '../../server/src/providers/ollamaUtility.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passes++;
    console.log(`  ok  ${name}`);
  } else {
    fails++;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SYSTEM: CompactMessage = { role: 'system', content: 'You are Arco. Tools: Read, Write, Bash.' };

// Build a synthetic transcript: system + 1 user + 30 alternating assistant/tool
// turns + a final user turn. Long enough that last-10 leaves a real older half.
function makeTranscript(): CompactMessage[] {
  const msgs: CompactMessage[] = [SYSTEM, { role: 'user', content: 'Refactor the auth module.' }];
  for (let i = 0; i < 15; i++) {
    msgs.push({
      role: 'assistant',
      content: `Step ${i}: I'll read and edit a file.`,
      tool_calls: [{ function: { name: i % 2 === 0 ? 'Read' : 'Write', arguments: { file_path: `/src/auth/file${i}.ts` } } }],
    });
    msgs.push({ role: 'tool', content: `result of step ${i}: ok (${'x'.repeat(200)})` });
  }
  msgs.push({ role: 'user', content: 'Now run the tests.' });
  return msgs;
}

const config = defaultCompactionConfig();

// ── 1. Config defaults mirror the reference ──────────────────────────────────
check('config.contextFillThreshold === 0.85', config.contextFillThreshold === 0.85);
check('config.warnThreshold === 0.75', config.warnThreshold === 0.75);
check('config.maxAutoRecoveries === 1', config.maxAutoRecoveries === 1);
check('config.keepLastMessages === 10', config.keepLastMessages === 10);
check('config.enabled default true', config.enabled === true);

// ── 2. Trigger gating ────────────────────────────────────────────────────────
const WINDOW = 8000;
check('shouldAutoCompact fires AT threshold', shouldAutoCompact(0.85 * WINDOW, WINDOW, 0.85) === true);
check('shouldAutoCompact fires ABOVE threshold', shouldAutoCompact(0.95 * WINDOW, WINDOW, 0.85) === true);
check('shouldAutoCompact does NOT fire below', shouldAutoCompact(0.5 * WINDOW, WINDOW, 0.85) === false);
check('shouldAutoCompact does NOT fire on unknown window', shouldAutoCompact(99999, undefined, 0.85) === false);
check('shouldWarnContext fires in [0.75,0.85)', shouldWarnContext(0.78 * WINDOW, WINDOW, 0.75, 0.85) === true);
check('shouldWarnContext does NOT fire at hard gate', shouldWarnContext(0.9 * WINDOW, WINDOW, 0.75, 0.85) === false);
check('shouldWarnContext does NOT fire below warn', shouldWarnContext(0.5 * WINDOW, WINDOW, 0.75, 0.85) === false);

// ── 3. Split preserves system block + keeps last-10 verbatim ─────────────────
const transcript = makeTranscript();
const split = splitForCompaction(transcript, config.keepLastMessages);
check('split.system is the leading system block', split.system.length === 1 && split.system[0] === SYSTEM);
check('split.tail length === keepLastMessages', split.tail.length === config.keepLastMessages);
check('split.tail is the last-N body messages verbatim', split.tail[split.tail.length - 1] === transcript[transcript.length - 1]);
check('split.older covers everything else', split.older.length === transcript.length - 1 - config.keepLastMessages);
check('split.older + tail + system === whole transcript count', split.system.length + split.older.length + split.tail.length === transcript.length);

// Short body: nothing to summarize.
const shortSplit = splitForCompaction([SYSTEM, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 10);
check('short body → older empty, tail = whole body', shortSplit.older.length === 0 && shortSplit.tail.length === 2);

// ── 4. Deterministic digest (fallback) summarizes the older half ─────────────
const digest = deterministicDigest(split.older);
check('digest is non-empty prose', digest.length > 0 && digest.includes('Progress recap'));
check('digest records files read', digest.includes('/src/auth/file0.ts'));
check('digest records files written/edited', digest.includes('### Files written/edited'));
check('digest records tool usage', digest.includes('Read:') && digest.includes('Write:'));

// ── 5. Assemble: system + seed + sanitized/truncated tail ────────────────────
const assembled = assembleCompacted(split, digest, config);
check('assembled keeps system block first', assembled[0] === SYSTEM);
check('assembled has exactly one summary seed user message', assembled.filter((m) => m.role === 'user' && m.content.includes('[Archon auto-compaction]')).length === 1);
check('assembled keeps the verbatim last user turn', assembled[assembled.length - 1].content === 'Now run the tests.');
check('assembled is shorter than original', assembled.length < transcript.length);

// ── 6. Tool-message sanitization removes orphans ─────────────────────────────
// Orphaned leading tool result (its assistant tool_calls got summarized away).
const orphanLeading: CompactMessage[] = [
  SYSTEM,
  { role: 'tool', content: 'orphan result with no preceding tool_calls' },
  { role: 'user', content: 'continue' },
];
const fixedLeading = sanitizeToolMessages(orphanLeading);
check('sanitize drops orphaned leading tool result', !fixedLeading.some((m) => m.role === 'tool'));

// Dangling assistant tool_calls (its result got cut) — keep text, drop tool_calls.
const dangling: CompactMessage[] = [
  SYSTEM,
  { role: 'assistant', content: 'calling a tool', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/x' } } }] },
  { role: 'user', content: 'never answered' },
];
const fixedDangling = sanitizeToolMessages(dangling);
const asstAfter = fixedDangling.find((m) => m.role === 'assistant');
check('sanitize strips dangling tool_calls but keeps text', !!asstAfter && asstAfter.content === 'calling a tool' && !asstAfter.tool_calls);

// Valid pairing is left intact.
const valid: CompactMessage[] = [
  SYSTEM,
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/x' } } }] },
  { role: 'tool', content: 'ok' },
  { role: 'user', content: 'thanks' },
];
const fixedValid = sanitizeToolMessages(valid);
check('sanitize leaves valid tool pairing intact', fixedValid.length === valid.length && fixedValid.some((m) => m.role === 'tool'));

// Trailing dangling tool_calls (assistant opened calls at the very end).
const trailing: CompactMessage[] = [
  SYSTEM,
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: 'doing', tool_calls: [{ function: { name: 'Bash', arguments: { command: 'ls' } } }] },
];
const fixedTrailing = sanitizeToolMessages(trailing);
check('sanitize strips trailing dangling tool_calls', !fixedTrailing.some((m) => m.tool_calls && m.tool_calls.length > 0));

// ── 7. Oversized tool-call args truncated ────────────────────────────────────
const huge: CompactMessage[] = [
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Write', arguments: { file_path: '/big.ts', content: 'A'.repeat(50_000) } } }] },
];
const truncated = truncateToolCallArgs(huge, config.maxToolCallArgChars);
const tc = truncated[0].tool_calls![0];
check('oversized tool-call args replaced with placeholder', '_truncated_for_context' in tc.function.arguments);
check('truncation preserves the function name', tc.function.name === 'Write');
check('truncation records the dropped size', typeof (tc.function.arguments as any)._truncated_for_context === 'number' && (tc.function.arguments as any)._truncated_for_context > 40_000);
// Small args left untouched.
const small = truncateToolCallArgs(huge.map(() => ({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/x' } } }] } as CompactMessage)), config.maxToolCallArgChars);
check('small tool-call args untouched', (small[0].tool_calls![0].function.arguments as any).file_path === '/x');

// ── 8. ollama_compacted stats carry before/after counts ──────────────────────
const stats = compactionStats(transcript, assembled, undefined);
check('stats.beforeBytes > afterBytes (history shrank)', stats.beforeBytes > stats.afterBytes);
check('stats.beforeTokens > afterTokens (estimate shrank)', stats.beforeTokens > stats.afterTokens);
check('stats.foldedMessages > 0', stats.foldedMessages > 0);
check('stats counts are positive', stats.beforeBytes > 0 && stats.afterBytes > 0 && stats.beforeTokens > 0 && stats.afterTokens > 0);

// ── 9. Deterministic fallback fires when the M7 seam returns null ────────────
// Unconfigured utility model ⇒ runUtilitySummaryJob returns null ⇒ caller must
// fall back to the deterministic digest. This is the never-fail-closed guarantee.
(async () => {
  const utilMessages: UtilityMessage[] = split.older.map((m) => ({
    role: m.role === 'tool' ? 'user' : (m.role === 'system' ? 'system' : (m.role as 'user' | 'assistant')),
    content: m.content || '[turn]',
  }));
  const nullSummary = await runUtilitySummaryJob({ messages: utilMessages, config: null });
  check('runUtilitySummaryJob returns null when unconfigured', nullSummary === null);

  // The compose step (mirrors maybeCompact): null → deterministic digest → still
  // produces a usable compacted stack.
  const summaryText = nullSummary ?? deterministicDigest(split.older);
  const fallbackAssembled = assembleCompacted(split, summaryText, config);
  check('compaction STILL happens on null seam (fallback)', fallbackAssembled.length < transcript.length && fallbackAssembled[0] === SYSTEM);
  const seed = fallbackAssembled.find((m) => m.role === 'user' && m.content.includes('[Archon auto-compaction]'));
  check('fallback seed carries the deterministic digest', !!seed && seed.content.includes('Progress recap'));

  // Empty older half ⇒ compactionSeedMessage still well-formed (defensive).
  const seedMsg = compactionSeedMessage('recap text', 5);
  check('compactionSeedMessage names the folded count', seedMsg.content.includes('5 message(s)') && seedMsg.role === 'user');

  // ── 10. maxAutoRecoveries semantics — one compaction per turn ──────────────
  // The worker increments a per-turn counter; once it equals maxAutoRecoveries
  // (1), a second compaction within the same turn is skipped. Model that here:
  let recoveriesUsed = 0;
  const tryCompact = (): boolean => {
    if (recoveriesUsed >= config.maxAutoRecoveries) return false;
    recoveriesUsed++;
    return true;
  };
  check('first compaction allowed', tryCompact() === true);
  check('second compaction blocked by maxAutoRecoveries', tryCompact() === false);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`ollama-compact smoke: ${passes} passed, ${fails} failed`);
  if (fails > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
