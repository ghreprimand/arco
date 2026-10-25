// Workbench Expansion §F1 — Recall index smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): drives RecallIndex against a
// temp DB and temp .archon/workflows fixtures under TWO different cwds, with a
// hand-written known-cwds.json so backfill discovers them. Asserts:
//
//   1. Both workflows are indexed after backfill.
//   2. BOTH have non-empty titles — the ai-title fixture uses its title; the
//      title-less one falls back to its first operator message.
//   3. project + provider are correct per entry.
//   4. Re-running backfill is IDEMPOTENT (still 2 entries, not 4).
//   5. Deleting the DB and rebuilding reconstructs both.
//
// The index + known-cwds + Claude session JSONL are all pointed at a temp
// HOME-equivalent so the smoke NEVER writes to the real ~/.archon.
//
// Run: npm run smoke:recall-index  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkflowMeta } from '../../server/src/workflowMeta.js';

// encodeProjectDir mirror (server/src/http/fileRead.ts) — for the Claude
// session JSONL path the ai-title fixture lives at.
function encodeProjectDir(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

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
    lines.push(JSON.stringify({ seq: seq++, ts: Date.now(), type: 'primary_turn_started', workflowId: wfid }));
  }
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

async function main() {
  const cleanups: string[] = [];

  // Temp HOME so the ai-title fixture + known-cwds resolution match what the
  // index reads. RecallIndex resolves known-cwds.json + Claude JSONL via
  // os.homedir(), so override HOME for this process.
  const fakeHome = mkdtempSync(join(tmpdir(), 'archon-recall-home-'));
  cleanups.push(fakeHome);
  const realHome = homedir();
  process.env.HOME = fakeHome;
  // homedir() reads $HOME on POSIX; assert the override took so the smoke can't
  // silently scribble in the real ~/.archon.
  assert(homedir() === fakeHome, `HOME override failed (got ${homedir()})`);
  assert(homedir() !== realHome, 'HOME must differ from the real home dir');

  // Two cwds, different projects + providers.
  const cwdA = mkdtempSync(join(tmpdir(), 'archon-recall-projA-'));
  const cwdB = mkdtempSync(join(tmpdir(), 'archon-recall-projB-'));
  cleanups.push(cwdA, cwdB);

  const wfA = 'aaaaaaaa-1111-2222-3333-444444444444'; // claude, WITH ai-title
  const wfB = 'bbbbbbbb-5555-6666-7777-888888888888'; // codex, WITHOUT ai-title

  const claudeSessionId = '99999999-0000-1111-2222-333333333333';
  writeMetaFixture(cwdA, {
    workflowId: wfA,
    name: 'A',
    cwd: cwdA,
    createdAt: 1000,
    lastActiveAt: 5000,
    primaryProvider: 'claude',
    primaryModel: 'claude-opus' as WorkflowMeta['primaryModel'],
    primaryEffort: 'medium',
    cliSessions: [{ provider: 'claude', sessionId: claudeSessionId, createdAt: 1000 }],
    operator: 'test',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  });
  writeEvents(cwdA, wfA, ['first operator message for A', 'second message A']);

  // The Claude ai-title fixture: a session JSONL under the fake HOME with an
  // ai-title entry, at the path findAiTitle() computes.
  const claudeProjDir = join(fakeHome, '.claude', 'projects', encodeProjectDir(cwdA));
  mkdirSync(claudeProjDir, { recursive: true });
  writeFileSync(
    join(claudeProjDir, `${claudeSessionId}.jsonl`),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Refactor the auth flow' }) + '\n',
  );

  writeMetaFixture(cwdB, {
    workflowId: wfB,
    name: 'B',
    cwd: cwdB,
    createdAt: 2000,
    lastActiveAt: 9000,
    primaryProvider: 'codex',
    primaryModel: 'gpt-5-codex' as WorkflowMeta['primaryModel'],
    primaryEffort: 'high',
    cliSessions: [],
    operator: 'test',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  });
  writeEvents(cwdB, wfB, ['Investigate the flaky CI run on main', 'more B']);

  // known-cwds.json under the fake HOME so backfill discovers both.
  const archonDir = join(fakeHome, '.archon');
  mkdirSync(archonDir, { recursive: true });
  writeFileSync(join(archonDir, 'known-cwds.json'), JSON.stringify([cwdA, cwdB], null, 2) + '\n');

  // Import AFTER HOME override so any module-load-time homedir() reads the temp.
  const { RecallIndex } = await import('../../server/src/recall/index.js');

  const dbPath = join(fakeHome, '.archon', 'recall', 'recall.db');
  let index = new RecallIndex(dbPath);

  await step('backfill indexes both workflows', async () => {
    index.load();
    const n = await index.backfill();
    assertEq(n, 2, 'backfill should index exactly 2 workflows');
    assertEq(index.count(), 2, 'index should hold 2 entries');
  });

  await step('both entries have non-empty titles via the fallback chain', async () => {
    const entries = index.query();
    assertEq(entries.length, 2, 'query should return 2 entries');
    for (const e of entries) {
      assert(e.title.trim().length > 0, `entry ${e.wfid} must have a non-empty title (got ${JSON.stringify(e.title)})`);
    }
    const a = entries.find((e) => e.wfid === wfA)!;
    const b = entries.find((e) => e.wfid === wfB)!;
    assertEq(a.title, 'Refactor the auth flow', 'A uses its Claude ai-title');
    assertEq(b.title, 'Investigate the flaky CI run on main', 'B falls back to its first operator message');
  });

  await step('project + provider are correct per entry', async () => {
    const entries = index.query();
    const a = entries.find((e) => e.wfid === wfA)!;
    const b = entries.find((e) => e.wfid === wfB)!;
    assertEq(a.provider, 'claude', 'A provider');
    assertEq(b.provider, 'codex', 'B provider');
    // project = cwd basename.
    assert(a.project.startsWith('archon-recall-projA-'), `A project basename (got ${a.project})`);
    assert(b.project.startsWith('archon-recall-projB-'), `B project basename (got ${b.project})`);
    assertEq(a.turnCount, 2, 'A turnCount = 2 user_message_echo events');
    assertEq(b.turnCount, 2, 'B turnCount = 2 user_message_echo events');
    // Default sort is lastActiveAt desc — B (9000) before A (5000).
    assertEq(index.query()[0].wfid, wfB, 'B sorts first (more recent lastActiveAt)');
  });

  await step('filters narrow by project and provider', async () => {
    assertEq(index.query({ provider: 'claude' }).length, 1, 'one claude entry');
    assertEq(index.query({ provider: 'codex' }).length, 1, 'one codex entry');
    const aProject = index.query().find((e) => e.wfid === wfA)!.project;
    assertEq(index.query({ project: aProject }).length, 1, 'project filter narrows to one');
  });

  await step('re-running backfill is idempotent (no duplicates)', async () => {
    const n = await index.backfill();
    assertEq(n, 2, 're-backfill still reports 2 workflows');
    assertEq(index.count(), 2, 'still exactly 2 entries, not 4');
  });

  await step('deleting the DB and rebuilding reconstructs both', async () => {
    index.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    assert(!existsSync(dbPath), 'recall.db should be gone before rebuild');

    index = new RecallIndex(dbPath);
    const n = await index.rebuild();
    assertEq(n, 2, 'rebuild reconstructs 2 workflows from disk');
    assertEq(index.count(), 2, 'rebuilt index holds 2 entries');
    const titles = index.query().map((e) => e.title);
    assert(titles.includes('Refactor the auth flow'), 'A title reconstructed');
    assert(titles.includes('Investigate the flaky CI run on main'), 'B title reconstructed');
    index.close();
  });

  process.env.HOME = realHome;
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('F1 recall-index');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
