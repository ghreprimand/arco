// ARCHIVE (docs/ARCHIVE_PLAN.md §4.2, Phase 3) — regression guard for the
// agent-writes ledger. `matchFileEvent` is the per-provider event-shape parser;
// it drifts as providers change, so it is pinned here (same rationale as
// hooks.test.ts). Also covers the append/read/compaction round-trip.
//
// Run: node --conditions development --import tsx --test src/recentFilesLedger.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ServerMessage } from '@archon/shared';

// Point the ledger at a temp file BEFORE importing the module (the path is
// captured at module load). Dynamic import so the env override is in effect.
const LEDGER = join(mkdtempSync(join(tmpdir(), 'archon-ledger-')), 'recent-files.jsonl');
process.env.ARCHON_RECENT_FILES_LEDGER = LEDGER;
const { matchFileEvent, appendRecord, readRecent, resolveMatchPath, LEDGER_PATH } =
  await import('./recentFilesLedger.js');

// Small helper to build a message with the right type without repeating casts.
const msg = (m: Partial<ServerMessage> & { type: string }): ServerMessage => m as ServerMessage;

// ── matchFileEvent: the Native write tools ─────────────────────────────────

test('Write completed → cwd-scoped match on file_path', () => {
  const m = matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Write', status: 'completed',
    input: JSON.stringify({ file_path: 'docs/PLAN.md', content: 'x' }),
  }));
  assert.deepEqual(m, { scope: 'cwd', rel: 'docs/PLAN.md', op: 'modified', tool: 'Write' });
});

test('Edit completed → match on file_path', () => {
  const m = matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Edit', status: 'completed',
    input: JSON.stringify({ file_path: '/abs/src/x.ts', old_string: 'a', new_string: 'b' }),
  }));
  assert.deepEqual(m, { scope: 'cwd', rel: '/abs/src/x.ts', op: 'modified', tool: 'Edit' });
});

test('NotebookEdit completed → match on notebook_path', () => {
  const m = matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'NotebookEdit', status: 'completed',
    input: JSON.stringify({ notebook_path: 'a.ipynb', new_source: 'y' }),
  }));
  assert.equal(m?.rel, 'a.ipynb');
  assert.equal(m?.tool, 'NotebookEdit');
});

test('Write with only status:started does NOT record (fires once on completion)', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Write', status: 'started',
    input: JSON.stringify({ file_path: 'a.md' }),
  })), null);
});

test('Write with no status does NOT record', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Write',
    input: JSON.stringify({ file_path: 'a.md' }),
  })), null);
});

test('failed Edit does NOT record', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Edit', status: 'failed',
    input: JSON.stringify({ file_path: 'a.ts' }),
  })), null);
});

test('non-writing tool (Read) does NOT record', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Read', status: 'completed',
    input: JSON.stringify({ file_path: 'a.ts' }),
  })), null);
});

test('malformed input JSON → null (never throws)', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Write', status: 'completed',
    input: '{not json',
  })), null);
});

test('Write completed but empty file_path → null', () => {
  assert.equal(matchFileEvent(msg({
    type: 'primary_tool_use', workflowId: 'w', tool: 'Write', status: 'completed',
    input: JSON.stringify({ file_path: '' }),
  })), null);
});

// ── matchFileEvent: Review + media ─────────────────────────────────────────

test('review_artifact_ready (no error) → artifact-scoped Review match', () => {
  const m = matchFileEvent(msg({
    type: 'review_artifact_ready', workflowId: 'w', reviewId: 'r',
    artifactName: 'review-123.md', completedAt: 1,
  }));
  assert.deepEqual(m, { scope: 'artifact', rel: 'review-123.md', op: 'created', tool: 'Review' });
});

test('review_artifact_ready WITH error → null (nothing was written)', () => {
  assert.equal(matchFileEvent(msg({
    type: 'review_artifact_ready', workflowId: 'w', reviewId: 'r',
    artifactName: 'review-123.md', error: 'boom', completedAt: 1,
  })), null);
});

test('media_op_result ok → cwd-scoped media:<op> match', () => {
  const m = matchFileEvent(msg({
    type: 'media_op_result', workflowId: 'w', op: 'clip', ok: true,
    summary: 's', relPath: 'out/clip.mp4', ts: 1,
  }));
  assert.deepEqual(m, { scope: 'cwd', rel: 'out/clip.mp4', op: 'created', tool: 'media:clip' });
});

test('media_op_result failure → null', () => {
  assert.equal(matchFileEvent(msg({
    type: 'media_op_result', workflowId: 'w', op: 'clip', ok: false, summary: 's', ts: 1,
  })), null);
});

test('media_stems_result ok → cwd-scoped stems match on relDir', () => {
  const m = matchFileEvent(msg({
    type: 'media_stems_result', workflowId: 'w', ok: true, model: 'htdemucs',
    count: 4, summary: 's', relDir: 'stems/song', ts: 1,
  }));
  assert.deepEqual(m, { scope: 'cwd', rel: 'stems/song', op: 'created', tool: 'stems' });
});

test('unrelated event (primary_text) → null', () => {
  assert.equal(matchFileEvent(msg({ type: 'primary_text', workflowId: 'w', text: 'hi' })), null);
});

// ── resolveMatchPath ───────────────────────────────────────────────────────

test('resolveMatchPath: cwd-relative joins cwd; absolute passes through; artifact joins artifactsDir', () => {
  assert.equal(resolveMatchPath({ scope: 'cwd', rel: 'docs/a.md', op: 'modified', tool: 'Write' }, '/home/u/proj', '/x'), '/home/u/proj/docs/a.md');
  assert.equal(resolveMatchPath({ scope: 'cwd', rel: '/abs/a.md', op: 'modified', tool: 'Edit' }, '/home/u/proj', '/x'), '/abs/a.md');
  assert.equal(resolveMatchPath({ scope: 'artifact', rel: 'review-1.md', op: 'created', tool: 'Review' }, '/home/u/proj', '/home/u/proj/.archon/w/art'), '/home/u/proj/.archon/w/art/review-1.md');
});

// ── append / read / compaction round-trip ──────────────────────────────────

test('append + read newest-first, and compaction keeps the newest 500 past 1000', async () => {
  assert.equal(LEDGER_PATH, LEDGER, 'env override took effect');
  // Append 1001 records; the module compacts in place to 500 (newest).
  for (let i = 0; i < 1001; i++) {
    await appendRecord({ ts: i, path: `/p/f${i}.md`, op: 'modified', workflowId: 'w', tabTitle: 't', provider: 'claude', tool: 'Write' });
  }
  assert.ok(existsSync(LEDGER));
  const recent = await readRecent(10);
  assert.equal(recent.length, 10);
  // Newest-first: the last appended (ts 1000) leads.
  assert.equal(recent[0].path, '/p/f1000.md');
  assert.equal(recent[0].ts, 1000);
  // Compaction: only the newest 500 survive, so f500 is the oldest kept.
  const all = await readRecent(10_000);
  assert.equal(all.length, 500);
  assert.equal(all[all.length - 1].path, '/p/f501.md');
});

test('readRecent skips malformed lines without throwing', async () => {
  const { appendFile } = await import('fs/promises');
  await appendFile(LEDGER, '{ broken json\n', 'utf8');
  const recent = await readRecent(5);
  assert.ok(Array.isArray(recent));
  assert.equal(recent[0].path, '/p/f1000.md'); // newest valid record still on top
});
