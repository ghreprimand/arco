// Workbench Expansion §F4 — Recall tags + pin-as-memory + links smoke.
//
// Tests the MECHANISM directly (no WS, no LLM, no server): drives RecallIndex
// against a temp DB + temp .archon/workflows fixtures, then exercises the F4
// mutations and asserts persistence + that a meta-write save() upsert does NOT
// clobber operator-set tags / pin / links (the ON CONFLICT guarantee). Asserts:
//
//   1. setTags persists AND survives a meta-write save() upsert.
//   2. setPinned persists AND survives a meta-write save() upsert (+ pinned
//      sorts to the top of query()).
//   3. addLink / removeLink persist (deduped on type+id).
//   4. backlinks(type, id, cwd) returns the linking entry, cwd-scoped.
//   5. The idempotent F4 migration runs cleanly on a DB created WITHOUT the new
//      columns (open an OLD-shape DB by hand, then let load() migrate it), and
//      load() is safe to call twice.
//
// Run: npm run smoke:recall-tags  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkflowMeta } from '../../server/src/workflowMeta.js';

function writeMetaFixture(cwd: string, meta: WorkflowMeta): void {
  const dir = join(cwd, '.archon', 'workflows', meta.workflowId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

function writeEvents(cwd: string, wfid: string, userMessages: string[]): void {
  const dir = join(cwd, '.archon', 'workflows', wfid);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  let seq = 1;
  lines.push(JSON.stringify({ seq: seq++, ts: Date.now(), type: 'workflow_created', workflowId: wfid }));
  for (const content of userMessages) {
    lines.push(JSON.stringify({ seq: seq++, ts: Date.now(), type: 'user_message_echo', workflowId: wfid, content }));
  }
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

function metaFixture(cwd: string, wfid: string, lastActiveAt: number): WorkflowMeta {
  return {
    workflowId: wfid,
    name: 'F4',
    cwd,
    createdAt: 1000,
    lastActiveAt,
    primaryProvider: 'codex',
    primaryModel: 'gpt-5-codex' as WorkflowMeta['primaryModel'],
    primaryEffort: 'high',
    cliSessions: [],
    operator: 'test',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  };
}

async function main() {
  const cleanups: string[] = [];

  const fakeHome = mkdtempSync(join(tmpdir(), 'archon-recall4-home-'));
  cleanups.push(fakeHome);
  const realHome = homedir();
  process.env.HOME = fakeHome;
  assert(homedir() === fakeHome, `HOME override failed (got ${homedir()})`);

  const cwdA = mkdtempSync(join(tmpdir(), 'archon-recall4-projA-'));
  const cwdB = mkdtempSync(join(tmpdir(), 'archon-recall4-projB-'));
  cleanups.push(cwdA, cwdB);

  const wfA = 'aaaaaaaa-1111-2222-3333-444444444444';
  const wfB = 'bbbbbbbb-5555-6666-7777-888888888888';

  writeMetaFixture(cwdA, metaFixture(cwdA, wfA, 5000));
  writeEvents(cwdA, wfA, ['first operator message for A']);
  writeMetaFixture(cwdB, metaFixture(cwdB, wfB, 9000));
  writeEvents(cwdB, wfB, ['first operator message for B']);

  const archonDir = join(fakeHome, '.archon');
  mkdirSync(archonDir, { recursive: true });
  writeFileSync(join(archonDir, 'known-cwds.json'), JSON.stringify([cwdA, cwdB], null, 2) + '\n');

  const { RecallIndex } = await import('../../server/src/recall/index.js');

  const dbPath = join(fakeHome, '.archon', 'recall', 'recall.db');
  const index = new RecallIndex(dbPath);

  await step('backfill indexes both workflows', async () => {
    index.load();
    const n = await index.backfill();
    assertEq(n, 2, 'backfill should index 2 workflows');
    // F1 defaults: nothing pinned, no tags, no links.
    const a = index.get(wfA)!;
    assertEq(a.pinned, false, 'A starts unpinned');
    assertEq(a.tags.length, 0, 'A starts untagged');
    assertEq(a.links.length, 0, 'A starts with no links');
  });

  await step('setTags persists and survives a meta-write save() upsert', async () => {
    const updated = index.setTags(wfA, ['auth', 'refactor', 'auth' /* dupe */]);
    assert(updated != null, 'setTags returns the updated entry');
    assertEq(updated!.tags.join(','), 'auth,refactor', 'tags deduped + stored');
    // Simulate the meta-write hot path re-upserting the F1 projection (no tags).
    await index.upsertFromMeta(metaFixture(cwdA, wfA, 6000));
    const after = index.get(wfA)!;
    assertEq(after.tags.join(','), 'auth,refactor', 'ON CONFLICT did NOT clobber tags');
    assertEq(after.lastActiveAt, 6000, 'F1 projection columns DID update (lastActiveAt)');
  });

  await step('setPinned persists, survives upsert, and sorts to the top', async () => {
    const updated = index.setPinned(wfA, true);
    assert(updated != null && updated!.pinned === true, 'setPinned returns pinned entry');
    await index.upsertFromMeta(metaFixture(cwdA, wfA, 6500));
    assertEq(index.get(wfA)!.pinned, true, 'ON CONFLICT did NOT clobber pinned');
    // A (5000/pinned) now sorts before B (9000/unpinned) despite older activity.
    assertEq(index.query()[0].wfid, wfA, 'pinned A sorts first');
    // pinned-only filter.
    const pinned = index.query({ pinned: true });
    assertEq(pinned.length, 1, 'one pinned entry');
    assertEq(pinned[0].wfid, wfA, 'pinned filter returns A');
    // Reversible.
    index.setPinned(wfA, false);
    assertEq(index.get(wfA)!.pinned, false, 'unpin is reversible');
  });

  await step('addLink / removeLink persist and dedupe', async () => {
    const kbId = 'article-1234';
    index.addLink(wfA, { type: 'kb', id: kbId });
    index.addLink(wfA, { type: 'kb', id: kbId }); // dupe — no-op
    index.addLink(wfA, { type: 'task', id: 'task-9' }); // E2 not built; persists as inert id
    const a = index.get(wfA)!;
    assertEq(a.links.length, 2, 'two links, dupe collapsed');
    // Survives a meta-write upsert.
    await index.upsertFromMeta(metaFixture(cwdA, wfA, 7000));
    assertEq(index.get(wfA)!.links.length, 2, 'ON CONFLICT did NOT clobber links');
    // removeLink.
    index.removeLink(wfA, { type: 'task', id: 'task-9' });
    const after = index.get(wfA)!;
    assertEq(after.links.length, 1, 'task link removed');
    assertEq(after.links[0].type, 'kb', 'kb link remains');
  });

  await step('backlinks(type, id, cwd) returns the linking entry, cwd-scoped', async () => {
    const kbId = 'article-1234';
    const links = index.backlinks('kb', kbId, cwdA);
    assertEq(links.length, 1, 'one conversation links to the article');
    assertEq(links[0].wfid, wfA, 'A is the back-link');
    // cwd-scoping: the same id under a DIFFERENT cwd returns nothing.
    assertEq(index.backlinks('kb', kbId, cwdB).length, 0, 'cwd-scoped: none under cwdB');
    // unknown id → empty.
    assertEq(index.backlinks('kb', 'nope', cwdA).length, 0, 'unknown article id → empty');
    index.close();
  });

  await step('idempotent F4 migration runs cleanly on an old-shape DB', async () => {
    // Build a DB WITHOUT the F4 columns by hand (the F1/F2 on-disk shape), insert
    // a row, close it, then open it with RecallIndex — load() must ALTER TABLE
    // the missing columns and read the row with pinned=false / links=[].
    const oldDbDir = mkdtempSync(join(tmpdir(), 'archon-recall4-old-'));
    cleanups.push(oldDbDir);
    const oldDbPath = join(oldDbDir, 'recall.db');
    const raw = new Database(oldDbPath);
    raw.exec(`
      CREATE TABLE entries (
        wfid TEXT PRIMARY KEY, cwd TEXT NOT NULL, project TEXT NOT NULL,
        provider TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL,
        lastActiveAt INTEGER NOT NULL, turnCount INTEGER NOT NULL,
        summaryRef TEXT, tags TEXT NOT NULL DEFAULT '[]'
      );
    `);
    raw.prepare(
      `INSERT INTO entries (wfid, cwd, project, provider, title, createdAt, lastActiveAt, turnCount, summaryRef, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('cccccccc-0000-1111-2222-333333333333', oldDbDir, 'old', 'claude', 'Legacy convo', 1, 2, 1, null, '[]');
    raw.close();

    const migrated = new RecallIndex(oldDbPath);
    migrated.load(); // must add pinned + links columns
    migrated.load(); // safe to call twice
    const e = migrated.get('cccccccc-0000-1111-2222-333333333333')!;
    assert(e != null, 'legacy row survives migration');
    assertEq(e.pinned, false, 'migrated row defaults pinned=false');
    assertEq(e.links.length, 0, 'migrated row defaults links=[]');
    assertEq(e.title, 'Legacy convo', 'legacy data intact');
    // And the F4 mutations work on the migrated DB.
    migrated.setPinned('cccccccc-0000-1111-2222-333333333333', true);
    assertEq(migrated.get('cccccccc-0000-1111-2222-333333333333')!.pinned, true, 'pin works post-migration');
    migrated.close();
  });

  process.env.HOME = realHome;
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('F4 recall-tags');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
