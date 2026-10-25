// NATIVE_COMPACTION_PLAN Phase 2 — headless WS smoke for between-turn Native
// auto-compaction.
//
// Drives the REAL `maybeAutoCompactNative` trigger (the same post-turn site as
// auto-handoff) and the REAL `compactInPlace` keep-tail, but via the
// ARCHON_TEST-gated `__debug_native_auto_compact_probe` hook so there's NO
// Anthropic API spend: the probe worker uses a canned summary and a caller-
// seeded history, and the threshold is driven by a synthetic
// `lastContextPercent` rather than actually filling 800K tokens.
//
// Asserts:
//   1. mode 'off' → the trigger no-ops (no native_compacted) even over threshold.
//   2. mode 'conservative' over the compact threshold → exactly ONE
//      native_compacted at the (synthetic) turn boundary.
//   3. The keep-last-N verbatim tail survived after the seed (the recent
//      user/assistant turns are present, byte-identical to the projection).
//   4. Bounded-once: a second probe at the same fill does NOT fire a second
//      native_compacted (wf.autoCompactFired latches until context drops).
//   5. The next turn continues from the seed (a fresh native_compacted after a
//      context-drop reset re-arms the trigger).
//
// Run with the dev server up AND ARCHON_TEST=1 on the server:
//   ARCHON_TEST=1 npm run dev:server  &
//   npm run smoke:native-auto-compact
//
// Exits 0 on all-pass, 1 on any failure. Do NOT run against prod (the hook is
// ARCHON_TEST-gated and a no-op otherwise).

import { connect, step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectKeptTail } from '../../server/src/providers/claude-native/workerHelpers.js';
import { compactSummarySeed } from '../../server/src/providers/claude-native/resumeSummary.js';

// A probe history that mixes clean turns with a tool_use-bearing assistant and a
// tool_result user, so the keep-tail projection (skip non-text turns, collapse
// consecutive same-role, start on a user boundary) is genuinely exercised.
const PROBE_MESSAGES = [
  { role: 'user' as const, content: 'task one: read the config' },
  { role: 'assistant' as const, content: [{ type: 'text', text: 'reading config now' }] },
  { role: 'user' as const, content: 'task two: refactor the module' },
  {
    role: 'assistant' as const,
    content: [
      { type: 'text', text: 'planning the refactor' },
      { type: 'tool_use', id: 'tu_x', name: 'Read', input: { file_path: 'mod.ts' } },
    ],
  },
  { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'module body' }] },
  { role: 'assistant' as const, content: [{ type: 'text', text: 'refactor complete — all tests pass' }] },
];

const CANNED_SUMMARY = 'Canned probe summary: older history folded for the auto-compact smoke.';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-autocompact-'));
  console.log(`native-auto-compact smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';

  await step('connect + create Native workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Auto-compact smoke',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-8',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
        efficiencyAutoCompact: 'conservative',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
  });

  // 1. mode 'off' over threshold → no compaction.
  await step("mode 'off' does NOT fire native_compacted even over threshold", async () => {
    c.send({
      type: '__debug_native_auto_compact_probe',
      workflowId: wfid,
      messages: PROBE_MESSAGES,
      contextPercent: 95,
      mode: 'off',
    });
    // Give the server a beat; assert no native_compacted lands.
    let fired = false;
    try {
      await c.waitFor(
        (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
        1500,
        'native_compacted (should NOT arrive)',
      );
      fired = true;
    } catch {
      fired = false;
    }
    assert(!fired, "mode 'off' must not auto-compact");
  });

  // 2 + 3. conservative over the 80% compact threshold → exactly one
  // native_compacted, with the kept tail after the seed. Phase 3 also asserts
  // the EVENT ORDER: native_compacting (pre) MUST precede native_compacted.
  let firstCompacted: AnyMessage | undefined;
  await step("mode 'conservative' over threshold fires native_compacting THEN exactly one native_compacted with keep-tail", async () => {
    c.send({
      type: '__debug_native_auto_compact_probe',
      workflowId: wfid,
      messages: PROBE_MESSAGES,
      contextPercent: 85, // >= conservative compact threshold (80)
      mode: 'conservative',
    });
    // NATIVE_COMPACTION_PLAN Phase 3 — the pre-compaction marker fires BEFORE the
    // summary round. waitFor consumes in arrival order and splices the buffer up
    // to the match, so resolving native_compacting first and native_compacted
    // second asserts the ordering: native_compacted is the LATER message.
    const compacting = await c.waitFor(
      (x) => x.type === 'native_compacting' && (x as { workflowId?: string }).workflowId === wfid,
      4000,
      'native_compacting (pre, must arrive first)',
    );
    assertEq((compacting as { foldedTurns?: number }).foldedTurns, 3, 'native_compacting carries the pre-fold turn count');
    firstCompacted = await c.waitFor(
      (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
      4000,
      'native_compacted (conservative, after native_compacting)',
    );
    const compacted = firstCompacted as AnyMessage & { summary: string; keptTail?: unknown[] };

    assertEq(compacted.summary, CANNED_SUMMARY, 'native_compacted carries the canned summary');

    // The expected kept tail is exactly what projectKeptTail produces — and the
    // event must carry it so a replayed worker round-trips byte-identically.
    const expectedTail = projectKeptTail(PROBE_MESSAGES as never, 6);
    assert(expectedTail.length > 0, 'projection produced a non-empty tail to keep');
    const eventTail = compacted.keptTail ?? [];
    assertEq(
      JSON.stringify(eventTail),
      JSON.stringify(expectedTail),
      'native_compacted.keptTail equals the projection (replay round-trips byte-identical)',
    );

    // The most recent user/assistant turns survived verbatim in the tail.
    const tailStr = JSON.stringify(eventTail);
    assert(tailStr.includes('refactor complete — all tests pass'), 'recent assistant reply kept verbatim');
    assert(tailStr.includes('task two: refactor the module'), 'recent user prompt kept verbatim');

    // Drain a short window and assert no SECOND native_compacted from this fire.
    let second = false;
    try {
      await c.waitFor(
        (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
        1200,
        'second native_compacted (should NOT arrive)',
      );
      second = true;
    } catch {
      second = false;
    }
    assert(!second, 'exactly one native_compacted per settled turn');
  });

  // Sanity: the live seed the worker built = compactSummarySeed(summary, keptTail)
  // (this is what the next turn continues from — byte-identical to replay).
  await step('next turn continues from seed + kept tail (compactSummarySeed shape)', async () => {
    const keptTail = ((firstCompacted as unknown as { keptTail?: never[] })?.keptTail) ?? [];
    const seed = compactSummarySeed(CANNED_SUMMARY, keptTail as never);
    assert(seed.length >= 2, 'seed has the summary user + ack assistant');
    assertEq(String(seed[1].content && (seed[1].content as Array<{ text: string }>)[0]?.text),
      'Understood. I\'ll continue from this summary.', 'seed ack is the canonical helper text');
    // The kept tail follows the seed ack, starting on a user boundary.
    assert(seed.length > 2 && seed[2].role === 'user', 'kept tail starts on a user boundary after the seed');
  });

  // 4. Bounded-once: a repeat probe at the SAME fill (still over threshold) must
  // NOT fire again — autoCompactFired latches until context drops below warn-5.
  await step('bounded-once: repeat probe at same fill does NOT re-fire', async () => {
    c.send({
      type: '__debug_native_auto_compact_probe',
      workflowId: wfid,
      messages: PROBE_MESSAGES,
      contextPercent: 85,
      mode: 'conservative',
    });
    let refired = false;
    try {
      await c.waitFor(
        (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
        1500,
        'native_compacted (should NOT re-fire while latched)',
      );
      refired = true;
    } catch {
      refired = false;
    }
    assert(!refired, 'bounded to one auto-compaction until context drops');
  });

  // 5. Re-arm: a probe with a LOW fill (below warn-5) resets the latch, then a
  // subsequent high-fill probe fires a fresh native_compacted.
  await step('re-arm after context drops, then fires again on next pressure', async () => {
    // Low fill → resets autoCompactFired / autoCompactWarnFired.
    c.send({
      type: '__debug_native_auto_compact_probe',
      workflowId: wfid,
      messages: PROBE_MESSAGES,
      contextPercent: 10,
      mode: 'conservative',
    });
    // No compaction at 10%.
    let firedLow = false;
    try {
      await c.waitFor(
        (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
        1000,
        'native_compacted at low fill (should NOT arrive)',
      );
      firedLow = true;
    } catch {
      firedLow = false;
    }
    assert(!firedLow, 'no compaction below threshold');

    // High fill again → fresh fire.
    c.send({
      type: '__debug_native_auto_compact_probe',
      workflowId: wfid,
      messages: PROBE_MESSAGES,
      contextPercent: 90,
      mode: 'conservative',
    });
    const again = await c.waitFor(
      (x) => x.type === 'native_compacted' && (x as { workflowId?: string }).workflowId === wfid,
      4000,
      'native_compacted re-fires after re-arm',
    );
    assert(again, 'trigger re-arms after context drops');
  });

  await step('teardown: remove_workflow + rm cwd', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('native-auto-compact smoke');
}

main().catch((err) => {
  console.error('native-auto-compact smoke crashed:', err);
  process.exit(2);
});
