// Workbench Expansion §F2 — Recall conversation-summary smoke.
//
// Exercises summarizeWorkflow directly (no WS, no live LLM): seeds a workflow
// fixture (meta.json + events.jsonl) under a temp cwd, backfills the recall
// index so the entry exists, then:
//
//   1. STUBBED-OK spawn → asserts ~/.archon/recall/<wfid>/summary.md is written
//      with the canned LLM text, summaryRef is set in the index, ok=true, and
//      the FTS `summary` column carries the body (search hits the summary text).
//   2. STUBBED-FAIL spawn (error result) → asserts the DETERMINISTIC
//      summarizePriorTurns fallback is written to the same file (ok=false), NOT
//      an error — the fence's "never fails closed".
//
// HOME is pointed at a temp dir so the index singleton + summary dir + Claude
// JSONL all resolve to the temp home — the smoke NEVER writes to real ~/.archon.
//
// Run: npm run smoke:recall-summary  (no dev server needed)

import { step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowMeta } from '../../server/src/workflowMeta.js';

function writeMetaFixture(cwd: string, meta: WorkflowMeta): void {
  const dir = join(cwd, '.archon', 'workflows', meta.workflowId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

// Seed an events.jsonl with operator turns + tool use so summarizePriorTurns
// (the deterministic fallback) has real structure to digest.
function writeEvents(cwd: string, wfid: string): void {
  const dir = join(cwd, '.archon', 'workflows', wfid);
  mkdirSync(dir, { recursive: true });
  let seq = 1;
  const lines: string[] = [];
  const push = (o: Record<string, unknown>) => lines.push(JSON.stringify({ seq: seq++, ts: Date.now(), workflowId: wfid, ...o }));
  push({ type: 'workflow_created' });
  push({ type: 'user_message_echo', content: 'Add a recall summary feature' });
  push({ type: 'primary_tool_use', tool: 'Read', input: JSON.stringify({ file_path: '/x/index.ts' }) });
  push({ type: 'primary_tool_use', tool: 'Write', input: JSON.stringify({ file_path: '/x/summarize.ts' }) });
  push({ type: 'primary_text', phase: 'passthrough', text: 'Done — added summarize.ts.' });
  push({ type: 'primary_complete', phase: 'passthrough' });
  push({ type: 'user_message_echo', content: 'Now wire the smoke' });
  push({ type: 'primary_text', phase: 'passthrough', text: 'Wired the smoke.' });
  push({ type: 'primary_complete', phase: 'passthrough' });
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

// Stub WorkerManager.spawn: records the spec/opts, emits canned worker_text (OK
// path) or resolves with an error (FAIL path → deterministic fallback).
function makeStubManager(mode: 'ok' | 'fail', cannedText: string, captured: AnyMessage[]) {
  return {
    spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
      captured.push({ spec, opts } as unknown as AnyMessage);
      if (mode === 'ok') {
        onEvent({ type: 'worker_text', workerId: spec.id as string, text: cannedText });
        return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 1 });
      }
      // Failed spawn — runResearch/summarize treat r.error as "degrade".
      return Promise.resolve({ id: spec.id, text: '', error: 'stub spawn failure', costUsd: 0, durationMs: 1 });
    },
    kill() { return false; },
  };
}

async function main() {
  const cleanups: string[] = [];
  const fakeHome = mkdtempSync(join(tmpdir(), 'archon-recall-sum-home-'));
  cleanups.push(fakeHome);
  const realHome = homedir();
  process.env.HOME = fakeHome;
  assert(homedir() === fakeHome, `HOME override failed (got ${homedir()})`);

  const cwd = mkdtempSync(join(tmpdir(), 'archon-recall-sum-cwd-'));
  cleanups.push(cwd);
  const wfid = 'cccccccc-1111-2222-3333-444444444444';

  writeMetaFixture(cwd, {
    workflowId: wfid,
    name: 'sum',
    cwd,
    createdAt: 1000,
    lastActiveAt: 5000,
    primaryProvider: 'claude',
    primaryModel: 'claude-opus' as WorkflowMeta['primaryModel'],
    primaryEffort: 'high',
    cliSessions: [],
    operator: 'test',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
  });
  writeEvents(cwd, wfid);

  const archonDir = join(fakeHome, '.archon');
  mkdirSync(archonDir, { recursive: true });
  writeFileSync(join(archonDir, 'known-cwds.json'), JSON.stringify([cwd], null, 2) + '\n');

  // Import AFTER HOME override so the index singleton resolves the temp home.
  const { getRecallIndex } = await import('../../server/src/recall/index.js');
  const { summarizeWorkflow } = await import('../../server/src/recall/summarize.js');
  const index = getRecallIndex();

  await step('backfill seeds the recall entry', async () => {
    const n = await index.backfill();
    assertEq(n, 1, 'one workflow indexed');
    const e = index.get(wfid);
    assert(e != null, 'entry exists');
    assert(e!.summaryRef == null, 'no summaryRef before summarizing');
  });

  const summaryPath = join(fakeHome, '.archon', 'recall', wfid, 'summary.md');
  const LLM_TEXT = '# Recall summary\n\n**What:** add recall summaries.\n\n**Decisions:** reuse summarizePriorTurns.\n\n**State:** summarize.ts shipped.\n\n**Open:** wire on-close hook.';

  await step('OK path writes the LLM summary + sets summaryRef + indexes body', async () => {
    const captured: AnyMessage[] = [];
    const res = await summarizeWorkflow({
      wfid,
      summarizer: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager('ok', LLM_TEXT, captured) as any,
    });
    assertEq(res.ok, true, 'ok=true on the LLM path');
    assertEq(res.summaryRef, `${wfid}/summary.md`, 'summaryRef is the stable relative ref');
    assert(existsSync(summaryPath), 'summary.md written to recall home');
    const body = readFileSync(summaryPath, 'utf8');
    assert(body.includes('reuse summarizePriorTurns'), 'LLM body persisted verbatim');
    // Index reflects the ref.
    const e = index.get(wfid);
    assertEq(e!.summaryRef, `${wfid}/summary.md`, 'index summaryRef updated');
    // Spawn shape: read-only tools, normal output style.
    assertEq(captured.length, 1, 'exactly one spawn');
    const opts = (captured[0] as unknown as { opts: AnyMessage }).opts;
    assertEq(opts.outputStyle, 'normal', 'outputStyle forced normal');
    const spec = (captured[0] as unknown as { spec: AnyMessage }).spec;
    const tools = spec.tools as string[];
    assert(Array.isArray(tools) && tools.includes('Read') && !tools.includes('Write'), 'read-only tool allowlist');
  });

  await step('FTS search hits the summary BODY', async () => {
    const rows = index.searchFtsRaw({ match: 'summarizePriorTurns' });
    assert(rows.some((r) => r.entry.wfid === wfid), 'summary body is searchable via FTS');
  });

  await step('FAIL path degrades to the deterministic digest (NOT an error)', async () => {
    const captured: AnyMessage[] = [];
    const res = await summarizeWorkflow({
      wfid,
      summarizer: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager('fail', '', captured) as any,
    });
    assertEq(res.ok, false, 'ok=false (degraded) on spawn failure');
    assert(!res.error, `degraded is NOT an error (got error=${res.error})`);
    assertEq(res.summaryRef, `${wfid}/summary.md`, 'fallback still produces a summaryRef');
    const body = readFileSync(summaryPath, 'utf8');
    // The deterministic digest is built by summarizePriorTurns — it carries the
    // structural "Prior turns" heading + the files written, not the LLM text.
    assert(body.includes('Prior turns in this workflow'), 'deterministic digest written');
    assert(body.includes('summarize.ts'), 'digest captured a file the transcript wrote');
    assert(!body.includes('reuse summarizePriorTurns'), 'LLM text was overwritten by the fallback');
  });

  await step('unknown workflow → hard failure, never throws', async () => {
    const res = await summarizeWorkflow({
      wfid: 'dddddddd-0000-0000-0000-000000000000',
      summarizer: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager('ok', LLM_TEXT, []) as any,
    });
    assertEq(res.summaryRef, null, 'no ref for an unindexed workflow');
    assertEq(res.ok, false, 'not ok');
    assert(!!res.error, 'carries an error string for the unknown wfid');
  });

  index.close();
  process.env.HOME = realHome;
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  summary('F2 recall-summary');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
