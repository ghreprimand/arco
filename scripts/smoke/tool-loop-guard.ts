// H9 — in-turn tool-loop guardrail smoke.
//
// Headless / module-level (no live server, no API spend). The guard is fed from
// the Native worker's dispatch loop, which would need real Anthropic turns to
// drive end-to-end. Instead we exercise the EXACT path the worker uses —
// ToolLoopGuard.record(name, hashArgs(input), outputHash(text)) — and assert the
// tool_loop_warning payload the worker's checkToolLoop would broadcast on the
// first trip, plus the warn/stop arming via toolLoopGuardMode().
//
// Run: npm run smoke:tool-loop-guard   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const {
    ToolLoopGuard,
    hashArgs,
    toolLoopGuardMode,
    describeToolLoop,
    NO_PROGRESS_THRESHOLD,
    IDENTICAL_REPEAT_THRESHOLD,
  } = await import('../../server/src/providers/claude-native/toolLoopGuard.js');
  const { outputHash } = await import('../../server/src/providers/outputSignature.js');

  // Mirror worker.checkToolLoop: record a dispatched call, and when it first
  // trips build the tool_loop_warning payload + decide stop from the mode.
  function feed(
    guard: InstanceType<typeof ToolLoopGuard>,
    mode: 'off' | 'warn' | 'stop',
    toolName: string,
    input: unknown,
    outText: string,
  ): { event: Record<string, unknown> | null; stop: boolean } {
    if (mode === 'off') return { event: null, stop: false };
    const v = guard.record(toolName, hashArgs(input), outputHash(outText));
    if (!v.firstTrip || v.signal === 'none') return { event: null, stop: false };
    const stop = mode === 'stop';
    return {
      event: {
        type: 'tool_loop_warning',
        toolUseId: 'tu_x',
        toolName: v.toolName,
        argsHash: v.argsHash,
        signal: v.signal,
        repeatCount: v.repeatCount,
        sameOutputCount: v.sameOutputCount,
        mode: stop ? 'stop' : 'warn',
      },
      stop,
    };
  }

  await step('H9.0 a single failing Bash does not warn', () => {
    const g = new ToolLoopGuard();
    const r = feed(g, 'warn', 'Bash', { cmd: 'make' }, 'error: build failed\n');
    assertEq(r.event, null, 'no event on first call');
    assertEq(r.stop, false, 'no stop');
  });

  await step('H9.1 no-progress loop trips with the right payload (warn mode)', () => {
    const g = new ToolLoopGuard();
    const sameErr = 'cc: error: undefined reference at line 42\n';
    let last: ReturnType<typeof feed> = { event: null, stop: false };
    for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) {
      last = feed(g, 'warn', 'Bash', { cmd: 'make' }, sameErr);
    }
    assert(last.event !== null, 'tripped on the threshold call');
    assertEq(last.event!.type, 'tool_loop_warning', 'event type');
    assertEq(last.event!.signal, 'no-progress', 'no-progress signal');
    assertEq(last.event!.mode, 'warn', 'warn mode → non-blocking');
    assertEq(last.stop, false, 'warn never stops');
    assert(typeof last.event!.argsHash === 'string' && (last.event!.argsHash as string).length > 0, 'argsHash present');
    assert(!('input' in last.event!) && !('cmd' in last.event!), 'raw args never in the event');
  });

  await step('H9.2 outputHash fuzziness collapses volatile lines (timestamps differ)', () => {
    const g = new ToolLoopGuard();
    // Same error, different timestamp/duration each run — outputHash normalizes
    // digits so these collapse to one no-progress loop.
    let last: ReturnType<typeof feed> = { event: null, stop: false };
    for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) {
      last = feed(g, 'warn', 'Bash', { cmd: 'pytest' }, `FAILED at ${1000 + i}ms — assertion error\n`);
    }
    assert(last.event !== null, 'volatile-but-equivalent output still trips');
    assertEq(last.event!.signal, 'no-progress', 'normalized to no-progress');
  });

  await step('H9.3 identical-repeat trips even when output changes', () => {
    const g = new ToolLoopGuard();
    // Genuinely distinct, digit-free output each call so outputHash does NOT
    // collapse them (no no-progress) — only the identical-args signal can fire.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    let last: ReturnType<typeof feed> = { event: null, stop: false };
    for (let i = 0; i < IDENTICAL_REPEAT_THRESHOLD; i++) {
      last = feed(g, 'warn', 'Read', { file: 'a.ts' }, `result word ${words[i]} unique\n`);
    }
    assert(last.event !== null, 'identical-args loop trips');
    assertEq(last.event!.signal, 'identical-repeat', 'identical-repeat signal');
  });

  await step('H9.4 armed stop mode requests an abort on trip', () => {
    const g = new ToolLoopGuard();
    let last: ReturnType<typeof feed> = { event: null, stop: false };
    for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) {
      last = feed(g, 'stop', 'Bash', { cmd: 'q' }, 'same\n');
    }
    assert(last.event !== null, 'tripped');
    assertEq(last.event!.mode, 'stop', 'event carries stop mode');
    assertEq(last.stop, true, 'stop requested');
    const desc = describeToolLoop(
      { toolName: 'Bash', argsHash: 'x', repeatCount: NO_PROGRESS_THRESHOLD, sameOutputCount: NO_PROGRESS_THRESHOLD, tripped: true, firstTrip: true, signal: 'no-progress' },
      'stop',
    );
    assert(desc.includes('stopping the tool loop'), 'description names the stop action');
  });

  await step('H9.5 off mode never warns', () => {
    const g = new ToolLoopGuard();
    let last: ReturnType<typeof feed> = { event: null, stop: false };
    for (let i = 0; i < NO_PROGRESS_THRESHOLD + 2; i++) {
      last = feed(g, 'off', 'Bash', { cmd: 'z' }, 'same\n');
    }
    assertEq(last.event, null, 'off → no events ever');
    assertEq(last.stop, false, 'off → no stop');
  });

  await step('H9.6 default mode (no env) is warn', () => {
    const prev = process.env.ARCHON_TOOL_LOOP_GUARD;
    delete process.env.ARCHON_TOOL_LOOP_GUARD;
    assertEq(toolLoopGuardMode(), 'warn', 'unset → warn default');
    process.env.ARCHON_TOOL_LOOP_GUARD = 'stop';
    assertEq(toolLoopGuardMode(), 'stop', 'stop arming honored');
    if (prev === undefined) delete process.env.ARCHON_TOOL_LOOP_GUARD;
    else process.env.ARCHON_TOOL_LOOP_GUARD = prev;
  });

  summary('tool-loop-guard');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
