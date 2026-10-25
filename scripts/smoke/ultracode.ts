// Acceptance smoke for ULTRACODE mode (docs/ULTRACODE_PLAN.md).
//
// What it guards: an ultracode turn runs the harness WorkflowTool, which fans
// out a BACKGROUND subagent fleet. A background workflow emits TWO `result`
// events on one `claude -p` process — an early "workflow launched" ack, then
// the real synthesis when the fleet finishes (the process waits and exits 0
// only after the last). The naive integration settled the turn on the FIRST
// result (WorkerManager `settled` flag, fed by ClaudeWorker emitting `result`
// per parser event), so the operator saw "I've launched a workflow…" as the
// final answer and the real synthesis was dropped.
//
// The fix (claude.ts, gated on config.ultracode): HOLD each result instead of
// emitting; flush the LAST one on process exit; surface superseded
// intermediates as progress system_notices. This smoke proves the final answer
// is the synthesis, not the ack — i.e. the coalescing held and flushed.
//
// NOTE: like web-search-tool-loop, this spends REAL Anthropic quota — a small
// but genuine ultracode turn (a 2-subagent classify workflow). There is no way
// to exercise the background-workflow two-result path without a real round-trip.
// NOT wired into any default/CI bundle — run by hand when touching the ultracode
// path or the ClaudeWorker result lifecycle:
//   npm run dev:server &
//   npm run smoke:ultracode
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An ultracode workflow runs subagents in the background — slow. Generous ceiling.
const TURN_TIMEOUT_MS = 300_000;

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-ultracode-'));
  // Seed files with distinct line counts so the classification answer is
  // deterministic and only knowable by the fleet actually reading them.
  writeFileSync(join(cwd, 'alpha.txt'), 'one\n');                       // 1 line → short
  writeFileSync(join(cwd, 'bravo.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\n');    // 6 lines → long

  console.log(`ultracode smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';

  await step('create CLI Opus workflow with ultracode ON', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'ultracode acceptance',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-8',
        primaryEffort: 'high', // server forces xhigh under ultracode regardless
        skipPermissions: true,
        workingDirectory: cwd,
        // ultracode forces CLI at turn time, but set it explicitly so the smoke
        // is unambiguous even if the cascade default were ever 'native'.
        claudeTransport: 'cli',
        ultracode: true,
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
    const cfg = (m as AnyMessage & { config?: { ultracode?: boolean } }).config;
    assert(cfg?.ultracode === true, 'workflow_created config carries ultracode:true');
  });

  await step('ultracode turn fans out a Workflow and coalesces to the synthesis', async () => {
    c.send({
      type: 'user_message',
      workflowId: wfid,
      content:
        'ultracode: Using a workflow, classify each .txt file in the current directory as ' +
        '"short" (under 5 lines) or "long" (5 or more lines). Spawn at most 2 subagents. ' +
        'Keep the workflow minimal. Return a JSON object mapping filename to classification.',
    });

    // Wait for the turn to settle (same broadcast the token panel feeds from).
    await c.waitFor(
      (x) => x.type === 'primary_turn_token_usage' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_turn_token_usage',
    );

    // (1) The WorkflowTool actually fired — this is what makes it ultracode and
    // not a plain turn. Tool-use events accumulated in the buffer while we waited.
    const sawWorkflow = c
      .peekMessages()
      .some(
        (m) =>
          m.type === 'primary_tool_use' &&
          (m as { workflowId?: string }).workflowId === wfid &&
          (m as { tool?: string }).tool === 'Workflow',
      );
    assert(sawWorkflow, 'a Workflow tool_use fired this turn (ultracode genuinely engaged the harness WorkflowTool)');

    // (2) THE REGRESSION GUARD: the final assistant text is the synthesis, not
    // the early "workflow launched" ack. The classification is only knowable by
    // the fleet reading the seeded files, so its presence proves we coalesced to
    // the last result on process exit rather than settling on the first.
    const answerText = c
      .peekMessages()
      .filter((m) => m.type === 'primary_text' && (m as { workflowId?: string }).workflowId === wfid)
      .map((m) => (m as { text?: string }).text ?? '')
      .join('');
    const lower = answerText.toLowerCase();
    assert(lower.includes('short'), `final answer states a "short" classification (got ${answerText.length} chars)`);
    assert(lower.includes('long'), 'final answer states a "long" classification');
    assert(
      lower.includes('alpha') && lower.includes('bravo'),
      'final answer names both seeded files — it is the per-file synthesis, not the launch ack',
    );

    // (3) Soft signal: the coalescing surfaced ≥1 superseded intermediate as a
    // progress notice. This depends on the model running the workflow in the
    // background (the common case); logged, not asserted, so a single-result
    // workflow (still correct via the exit flush) doesn't fail the smoke.
    const sawCheckpoint = c
      .peekMessages()
      .some(
        (m) =>
          m.type === 'system_notice' &&
          (m as { workflowId?: string }).workflowId === wfid &&
          /\[ultracode\] workflow checkpoint/i.test((m as { content?: string }).content ?? ''),
      );
    console.log(
      sawCheckpoint
        ? '  ✓ observed an [ultracode] workflow checkpoint notice (two-result coalescing exercised)'
        : '  · no checkpoint notice (single-result workflow — final still flushed on exit)',
    );
  });

  await step('teardown: remove_workflow + rm cwd', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('ultracode smoke');
}

main().catch((err) => {
  console.error('ultracode smoke crashed:', err);
  process.exit(2);
});
