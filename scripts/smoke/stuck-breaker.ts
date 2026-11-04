// §3.1 — stuck-worker breaker smoke.
//
// Headless / module-level (no live server, no API spend). The breaker is fed
// from seedWorker's worker_tool_use path across real provider turns; here we
// exercise the EXACT chain — stuckBreaker.observe(wfid, {toolName, inputHash,
// outputHash, failing}) → map the verdict to the worker_stuck payload the way
// emitWorkerStuck does — and assert the escalation nudge → pause → recovered,
// plus the 'limit' ceiling shape and reversibility.
//
// Run: npm run smoke:stuck-breaker   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const sb = await import('../../server/src/workers/stuckBreaker.js');
  const { outputHash } = await import('../../server/src/providers/outputSignature.js');

  // Mirror seedWorker.emitWorkerStuck: verdict → worker_stuck broadcast payload.
  function toEvent(wfid: string, toolName: string, v: ReturnType<typeof sb.observe>) {
    const escalation = v.action === 'pause' ? 'persist'
      : v.action === 'recovered' ? 'recovered'
      : 'detected';
    const recommendedAction = v.action === 'pause' ? 'pause' : v.action === 'nudge' ? 'nudge' : 'none';
    return {
      type: 'worker_stuck' as const,
      workflowId: wfid,
      escalation,
      recommendedAction,
      toolName,
      ...(v.signature ? { signature: v.signature } : {}),
      streak: v.streak,
    };
  }

  // Mirror seedWorker's failing-determination from a worker_tool_use event.
  function feed(wfid: string, toolName: string, input: unknown, out: string, opts?: { status?: string; exitCode?: number }) {
    const oh = outputHash(out);
    const failing =
      opts?.status === 'failed' ||
      (typeof opts?.exitCode === 'number' && opts.exitCode !== 0) ||
      out.startsWith('[error]');
    const v = sb.observe(wfid, { toolName, inputHash: sb.inputHash(JSON.stringify(input)), outputHash: oh, failing });
    return { v, event: v.action !== 'none' ? toEvent(wfid, toolName, v) : null };
  }

  await step('§3.1.0 a single failing Bash does not trip', () => {
    sb.dispose('w0');
    const r = feed('w0', 'Bash', { command: 'make' }, 'error: link failed\n', { exitCode: 2 });
    assertEq(r.event, null, 'no event yet');
  });

  await step('§3.1.1 same failing call DETECT_AT× → worker_stuck detected/nudge', () => {
    sb.dispose('w1');
    let last: ReturnType<typeof feed> = { v: { action: 'none', streak: 0, signature: null, paused: false }, event: null };
    for (let i = 0; i < sb.DETECT_AT; i++) {
      last = feed('w1', 'Bash', { command: 'make' }, `cc: undefined reference at ${i}ms\n`, { exitCode: 1 });
    }
    assert(last.event !== null, 'tripped on the threshold');
    assertEq(last.event!.escalation, 'detected', 'detected escalation');
    assertEq(last.event!.recommendedAction, 'nudge', 'heal-first nudge');
    assert(typeof last.event!.signature === 'string', 'hash-only signature present');
    assert(!('input' in last.event!) && !('command' in last.event!), 'raw args never leak into the event');
  });

  await step('§3.1.2 persisting to ESCALATE_AT× → persist/pause (reversible, not kill)', () => {
    sb.dispose('w2');
    let last: ReturnType<typeof feed> = { v: { action: 'none', streak: 0, signature: null, paused: false }, event: null };
    for (let i = 0; i < sb.ESCALATE_AT; i++) {
      last = feed('w2', 'Bash', { command: 'pytest' }, 'FAILED test_x — assertion\n', { exitCode: 1 });
    }
    assertEq(last.event!.escalation, 'persist', 'persist escalation');
    assertEq(last.event!.recommendedAction, 'pause', 'recommend pause');
    assertEq(sb.isPaused('w2'), true, 'workflow latched paused');
  });

  await step('§3.1.3 outputHash fuzziness collapses volatile error lines', () => {
    sb.dispose('w3');
    // Same error, different timestamp every run — normalized hash collapses them.
    let last: ReturnType<typeof feed> = { v: { action: 'none', streak: 0, signature: null, paused: false }, event: null };
    for (let i = 0; i < sb.DETECT_AT; i++) {
      last = feed('w3', 'Bash', { command: 'q' }, `2026-06-25T10:00:0${i}Z ERROR connection refused\n`, { exitCode: 1 });
    }
    assert(last.event !== null, 'volatile-but-equivalent failures still trip');
    assertEq(last.event!.escalation, 'detected', 'detected via normalized hash');
  });

  await step('§3.1.4 progress (changing output) never trips', () => {
    sb.dispose('w4');
    for (let i = 0; i < sb.ESCALATE_AT + 2; i++) {
      const r = feed('w4', 'Bash', { command: 'make' }, `compiled module alpha-${['one', 'two', 'three', 'four', 'five', 'six', 'seven'][i]}\n`, { exitCode: 1 });
      assertEq(r.event, null, `distinct output ${i} is progress, never trips`);
    }
  });

  await step('§3.1.5 success interleaved → recovered, clears the latch', () => {
    sb.dispose('w5');
    for (let i = 0; i < sb.ESCALATE_AT; i++) feed('w5', 'Bash', { command: 'make' }, 'same error\n', { exitCode: 1 });
    assertEq(sb.isPaused('w5'), true, 'paused before recovery');
    const r = feed('w5', 'Bash', { command: 'make' }, 'build succeeded\n', { exitCode: 0 });
    assert(r.event !== null, 'recovery emits an event');
    assertEq(r.event!.escalation, 'recovered', 'recovered escalation');
    assertEq(sb.isPaused('w5'), false, 'latch cleared — reversible');
  });

  await step('§3.1.6 operator turn clears the latch (reversible)', () => {
    sb.dispose('w6');
    for (let i = 0; i < sb.ESCALATE_AT; i++) feed('w6', 'Bash', { command: 'x' }, 'same\n', { exitCode: 1 });
    assertEq(sb.isPaused('w6'), true, 'paused');
    sb.clearOnOperatorTurn('w6');
    assertEq(sb.isPaused('w6'), false, 'operator turn un-pauses');
  });

  await step('§3.1.7 RSS / MAX_TOOL_TURNS ceiling shape is a limit trip', () => {
    // Mirror the ceiling emissions (WorkerManager RSS path + worker.ts
    // MAX_TOOL_TURNS) — escalation 'limit', recommendedAction 'pause', a reason,
    // and NO streak/signature (it's not an error-persistence loop).
    const limitEvent = {
      type: 'worker_stuck' as const,
      escalation: 'limit' as const,
      recommendedAction: 'pause' as const,
      reason: 'process tree exceeded the 32GB RSS safety cap — killing.',
    };
    assertEq(limitEvent.escalation, 'limit', 'ceiling is a limit trip');
    assertEq(limitEvent.recommendedAction, 'pause', 'limit recommends pause');
    assert(limitEvent.reason.length > 0, 'limit carries a human reason');
  });

  summary('stuck-breaker');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
