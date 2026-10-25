// Workbench Expansion §F3 — Recall search smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): seeds 3 workflows under two
// cwds with KNOWN DISTINCT tokens in their titles (via first-operator-message
// fallback), backfills the F1 index (which now also builds the §F3 FTS5 rows),
// then drives recall/search.ts. Asserts:
//
//   1. A token in ONE conversation's title returns THAT wfid + a snippet.
//   2. A token in ANOTHER returns the other.
//   3. project filter narrows correctly.
//   4. provider filter narrows correctly.
//   5. A token present in NONE returns empty.
//   6. Empty query returns the recent list (non-fatal).
//   7. Transcript full-text (toggle ON) finds a transcript-only token via the
//      reused A5 ripgrep engine — skipped gracefully if `rg` isn't on PATH.
//
// Everything is pointed at a temp HOME + temp cwds so the smoke NEVER writes to
// the real ~/.archon.
//
// Run: npm run smoke:recall-search  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
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

function meta(wfid: string, cwd: string, provider: ProviderShim, lastActiveAt: number): WorkflowMeta {
  return {
    workflowId: wfid,
    name: wfid.slice(0, 4),
    cwd,
    createdAt: 1000,
    lastActiveAt,
    primaryProvider: provider,
    primaryModel: 'm' as WorkflowMeta['primaryModel'],
    primaryEffort: 'medium',
    cliSessions: [],
    operator: 'test',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  };
}
type ProviderShim = WorkflowMeta['primaryProvider'];

async function main() {
  const cleanups: string[] = [];
  const fakeHome = mkdtempSync(join(tmpdir(), 'archon-recall-search-home-'));
  cleanups.push(fakeHome);
  const realHome = homedir();
  process.env.HOME = fakeHome;
  assert(homedir() === fakeHome, `HOME override failed (got ${homedir()})`);

  const cwdA = mkdtempSync(join(tmpdir(), 'archon-rsearch-projA-'));
  const cwdB = mkdtempSync(join(tmpdir(), 'archon-rsearch-projB-'));
  cleanups.push(cwdA, cwdB);

  // Distinct tokens: zebracorn (A1 title), narwhalflux (B1 title), and a
  // transcript-only token quokkaprime (in A2's events, NOT its title).
  const wfA1 = 'aaaaaaaa-1111-1111-1111-111111111111'; // claude, project A
  const wfB1 = 'bbbbbbbb-2222-2222-2222-222222222222'; // codex,  project B
  const wfA2 = 'cccccccc-3333-3333-3333-333333333333'; // claude, project A, transcript-only token

  writeMetaFixture(cwdA, meta(wfA1, cwdA, 'claude', 5000));
  writeEvents(cwdA, wfA1, ['Build the zebracorn dashboard widget']);

  writeMetaFixture(cwdB, meta(wfB1, cwdB, 'codex', 9000));
  writeEvents(cwdB, wfB1, ['Investigate the narwhalflux regression']);

  writeMetaFixture(cwdA, meta(wfA2, cwdA, 'claude', 3000));
  // Title token is generic; the distinctive token lives only in a later turn.
  writeEvents(cwdA, wfA2, ['Some ordinary task', 'now also handle the quokkaprime edge case']);

  const archonDir = join(fakeHome, '.archon');
  mkdirSync(archonDir, { recursive: true });
  writeFileSync(join(archonDir, 'known-cwds.json'), JSON.stringify([cwdA, cwdB], null, 2) + '\n');

  const { RecallIndex } = await import('../../server/src/recall/index.js');
  const { search } = await import('../../server/src/recall/search.js');
  const { RIPGREP_BIN } = await import('../../server/src/contentSearch.js');

  const dbPath = join(fakeHome, '.archon', 'recall', 'recall.db');
  const index = new RecallIndex(dbPath);

  await step('backfill indexes all three workflows + builds FTS', async () => {
    index.load();
    const n = await index.backfill();
    assertEq(n, 3, 'backfill should index 3 workflows');
  });

  await step('a title token in one conversation returns THAT wfid with a snippet', async () => {
    const res = await search({ q: 'zebracorn' }, index);
    assertEq(res.hits.length, 1, 'exactly one hit for zebracorn');
    assertEq(res.hits[0].wfid, wfA1, 'zebracorn → wfA1');
    assertEq(res.hits[0].matchedIn, 'title', 'matched in title');
    assert(res.hits[0].snippet.length > 0, 'hit carries a snippet');
  });

  await step('a token in another conversation returns the other wfid', async () => {
    const res = await search({ q: 'narwhalflux' }, index);
    assertEq(res.hits.length, 1, 'exactly one hit for narwhalflux');
    assertEq(res.hits[0].wfid, wfB1, 'narwhalflux → wfB1');
  });

  await step('project filter narrows correctly', async () => {
    const aProject = index.get(wfA1)!.project;
    const bProject = index.get(wfB1)!.project;
    // zebracorn is in project A — searching it with project=B yields nothing.
    const wrong = await search({ q: 'zebracorn', project: bProject }, index);
    assertEq(wrong.hits.length, 0, 'zebracorn not found under project B');
    const right = await search({ q: 'zebracorn', project: aProject }, index);
    assertEq(right.hits.length, 1, 'zebracorn found under project A');
  });

  await step('provider filter narrows correctly', async () => {
    const wrong = await search({ q: 'narwhalflux', provider: 'claude' }, index);
    assertEq(wrong.hits.length, 0, 'narwhalflux (codex) not found under provider claude');
    const right = await search({ q: 'narwhalflux', provider: 'codex' }, index);
    assertEq(right.hits.length, 1, 'narwhalflux found under provider codex');
  });

  await step('a token present in none returns empty', async () => {
    const res = await search({ q: 'flibbertigibbetxyz' }, index);
    assertEq(res.hits.length, 0, 'unknown token → empty');
  });

  await step('empty query returns the recent list (non-fatal)', async () => {
    const res = await search({ q: '' }, index);
    assert(res.hits.length >= 3, 'empty query lists recent conversations');
    // Recent list is lastActiveAt desc — wfB1 (9000) first.
    assertEq(res.hits[0].wfid, wfB1, 'most-recent conversation sorts first');
  });

  await step('transcript full-text (toggle ON) finds a transcript-only token', async () => {
    if (!RIPGREP_BIN) {
      // Engine degrades gracefully — assert the flag, skip the positive case.
      const res = await search({ q: 'quokkaprime', includeTranscripts: true, rgBin: null }, index);
      assertEq(res.hits.length, 0, 'no transcript hits without rg');
      assertEq(res.transcriptsAvailable, false, 'transcriptsAvailable=false when rg absent');
      console.log('    (rg not on PATH — transcript positive case skipped, graceful-degrade asserted)');
      return;
    }
    // Without the toggle, the transcript-only token is invisible (FTS indexes
    // title/summary/tags only).
    const off = await search({ q: 'quokkaprime' }, index);
    assertEq(off.hits.length, 0, 'transcript-only token invisible without the toggle');
    // With the toggle, ripgrep over events.jsonl surfaces it.
    const on = await search({ q: 'quokkaprime', includeTranscripts: true }, index);
    assertEq(on.hits.length, 1, 'transcript-only token found with the toggle');
    assertEq(on.hits[0].wfid, wfA2, 'quokkaprime → wfA2');
    assertEq(on.hits[0].matchedIn, 'transcript', 'matched in transcript');
    assertEq(on.transcriptsAvailable, true, 'transcriptsAvailable=true when rg present');
  });

  index.close();
  process.env.HOME = realHome;
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('F3 recall-search');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
