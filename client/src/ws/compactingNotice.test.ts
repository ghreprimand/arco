// NATIVE_COMPACTION_PLAN Phase 3 — pins the compaction-takeover-clear contract:
// the `isCompactionFailureNotice` predicate (handleServerMessage) MUST match the
// terminal failure system_notices the server emits on the no-`native_compacted`
// path, and MUST NOT match the start-of-compaction notices (which would clear
// the overlay the instant it should appear). If either side drifts, the
// "Compacting…" takeover either strands forever (failure missed) or never shows
// (start matched). The strings below are copied verbatim from the server emit
// sites — keep them in sync with compactHandlers.ts / turnEngine.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompactionFailureNotice } from './handleServerMessage.js';

// Verbatim terminal-failure notices from the server (these have NO
// `native_compacted`, so the predicate is the ONLY clear signal).
const FAILURE_NOTICES = [
  // compactHandlers.ts — manual COMPACT button, Claude/Codex failure.
  '[claude] Compact failed: summary came back empty',
  '[codex] Compact failed: no saved Codex thread for this workflow — run a turn first',
  // turnEngine.ts — between-turn auto path, fail-soft skip.
  '[AUTO-COMPACT] Compaction skipped: a turn is in flight — wait for it to finish. History left untouched — fire COMPACT or HANDOFF manually if context stays high.',
];

// Notices that fire at/around the START or SUCCESS of compaction — must NOT
// clear the takeover (the native_compacting/native_compacted handlers own
// begin/end; a false match here would fight them).
const NON_FAILURE_NOTICES = [
  '[claude] Compacting conversation… (native /compact)',
  '[AUTO-COMPACT] Context at 85%. Compacting conversation in place (between-turn)…',
  '[claude] Conversation compacted (3 turn(s) folded) — history replaced with a summary. Next turn continues from it.',
  '[AUTO-CONTINUE] Resuming from the compacted summary (auto-continue is ON for this tab).',
  '[CONTEXT] 70% — Native auto-compaction at 80% (conservative).',
];

test('isCompactionFailureNotice matches every terminal compaction-failure notice', () => {
  for (const n of FAILURE_NOTICES) {
    assert.ok(isCompactionFailureNotice(n), `should match failure notice: ${n}`);
  }
});

test('isCompactionFailureNotice does NOT match start/success/progress notices', () => {
  for (const n of NON_FAILURE_NOTICES) {
    assert.ok(!isCompactionFailureNotice(n), `should NOT match non-failure notice: ${n}`);
  }
});
