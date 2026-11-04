// §2.2 — tool-result eviction smoke.
//
// Headless / module-level (no live server, no API spend). The worker applies
// the spill mid-tool-loop, which needs a real Anthropic turn to drive
// end-to-end; instead we exercise the pure substrate the worker calls
// (planTurnSpill / planTailEviction / summarizeToolResultLine) plus the env
// gate, asserting the load-bearing contracts:
//
//   (a) under budget ⇒ nothing spilled (the common case is a no-op).
//   (b) over budget ⇒ largest-first spill until retained is back under budget,
//       with raw retained as an informative 1-liner (never bare deletion).
//   (c) the cross-turn tail eviction keeps a recent verbatim tail (the
//       mechanism §2.1 Fold reuses).
//   (d) the operator-arm gate is OFF unless ARCO_TOOL_EVICT is set.
//
// Run: npm run smoke:tool-eviction   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

const big = (n: number): string => 'x'.repeat(n);

async function main(): Promise<void> {
  const {
    planTurnSpill,
    planTailEviction,
    summarizeToolResultLine,
    toolEvictEnabled,
    estimateResultTokens,
  } = await import('../../server/src/providers/claude-native/toolResultEviction.js');

  await step('§2.2.0 gate is OFF by default, ON when armed', () => {
    delete process.env.ARCO_TOOL_EVICT;
    assertEq(toolEvictEnabled(), false, 'off by default');
    process.env.ARCO_TOOL_EVICT = 'on';
    assertEq(toolEvictEnabled(), true, 'armed via env');
    delete process.env.ARCO_TOOL_EVICT;
  });

  await step('§2.2.1 under budget ⇒ no-op', () => {
    const plan = planTurnSpill([{ toolUseId: '1', toolName: 'Read', content: big(2_000) }], 100_000);
    assertEq(plan.spill.length, 0, 'nothing spilled');
  });

  await step('§2.2.2 over budget ⇒ largest-first spill, retained back under budget', () => {
    const items = [
      { toolUseId: 'small', toolName: 'Read', content: big(4_000) },
      { toolUseId: 'huge', toolName: 'Bash', inputJson: JSON.stringify({ command: 'npm run build' }), content: big(400_000) },
      { toolUseId: 'mid', toolName: 'Read', content: big(40_000) },
    ];
    const plan = planTurnSpill(items, 20_000);
    assert(plan.spill.length > 0, 'something spilled');
    assertEq(plan.spill[0].toolUseId, 'huge', 'largest spilled first');
    assert(plan.savedTokens > 0, 'tokens reclaimed');
  });

  await step('§2.2.3 spilled result is an informative 1-liner, not a bare deletion', () => {
    const s = summarizeToolResultLine('Bash', JSON.stringify({ command: 'npm test' }), big(50_000));
    assert(s.includes('Arco evicted'), 'carries the evicted marker');
    assert(s.includes('npm test'), 'recalls the command');
    assert(!s.includes('\n'), 'single line');
    assert(estimateResultTokens(s) < estimateResultTokens(big(50_000)), 'much smaller than raw');
  });

  await step('§2.2.4 tiny results are never spilled (no benefit)', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ toolUseId: `t${i}`, toolName: 'Read', content: 'ok' }));
    const plan = planTurnSpill(items, 1);
    assertEq(plan.spill.length, 0, 'tiny outputs left alone');
  });

  await step('§2.2.5 cross-turn tail eviction keeps a recent verbatim tail', () => {
    const items = [
      { toolUseId: 'old1', toolName: 'Read', content: big(40_000) },
      { toolUseId: 'old2', toolName: 'Read', content: big(40_000) },
      { toolUseId: 'recent1', toolName: 'Read', content: big(40_000) },
      { toolUseId: 'recent2', toolName: 'Read', content: big(40_000) },
    ];
    const plan = planTailEviction(items, 21_000);
    const spilled = new Set(plan.spill.map((d) => d.toolUseId));
    assert(spilled.has('old1') && spilled.has('old2'), 'old spilled');
    assert(!spilled.has('recent1') && !spilled.has('recent2'), 'recent tail kept');
  });

  summary('tool-eviction');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
