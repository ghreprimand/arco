// §2.3 — token-budget meter smoke.
//
// Headless / module-level (no live server, no API spend). The budget event is
// emitted from turnEngine's Native post-turn branch, which would need a real
// Anthropic turn to drive end-to-end. Instead we exercise the EXACT wiring path
// turnEngine uses — the model's own params (lookupCtx + chooseMaxTokens) feeding
// computeContextBudget + crossedThresholds — and assert the event payload the
// branch would broadcast. That pins the integration (right window, right reserved
// budget, effective-window arithmetic, fold crossing) without spend.
//
// Run: npm run smoke:context-budget   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const { computeContextBudget, crossedThresholds } = await import(
    '../../server/src/providers/claude-native/contextBudget.js'
  );
  const { lookupCtx, chooseMaxTokens } = await import(
    '../../server/src/providers/claude-native/modelParams.js'
  );

  // Mirror the turnEngine Native branch: build the budget the way it does for a
  // real settled turn, then the context_budget payload.
  function meterFor(model: string, effort: string, lastPromptTokens: number, foldAt?: number) {
    const win = lookupCtx(model);
    if (typeof win !== 'number' || win <= 0) throw new Error(`no window for ${model}`);
    const reserved = chooseMaxTokens(model, effort);
    const budget = computeContextBudget(lastPromptTokens, win, reserved);
    const thresholds = { ...(typeof foldAt === 'number' ? { foldAt } : {}) };
    return {
      type: 'context_budget' as const,
      usedTokens: budget.usedTokens,
      windowSize: budget.windowSize,
      reservedOutput: budget.reservedOutput,
      effectiveWindow: budget.effectiveWindow,
      pct: budget.pct,
      thresholds,
      crossed: crossedThresholds(budget.pct, thresholds),
    };
  }

  await step('§2.3.0 opus-4-8 window resolves + reserves a real output budget', () => {
    assertEq(lookupCtx('claude-opus-4-8'), 1_000_000, 'opus window');
    const reserved = chooseMaxTokens('claude-opus-4-8', 'high');
    assert(reserved > 0 && reserved < 1_000_000, `reserved output sane: ${reserved}`);
  });

  await step('§2.3.1 effective window = window − reserved (denominator delta)', () => {
    const m = meterFor('claude-opus-4-8', 'high', 500_000);
    assertEq(m.windowSize, 1_000_000, 'raw window');
    assertEq(m.effectiveWindow, m.windowSize - m.reservedOutput, 'effective = window − reserved');
    assert(m.effectiveWindow < m.windowSize, 'effective is strictly smaller than raw');
  });

  await step('§2.3.2 effective-window pct reads higher than a raw-window pct', () => {
    const used = 600_000;
    const m = meterFor('claude-opus-4-8', 'high', used);
    const rawPct = Math.round((used / m.windowSize) * 100);
    assert(m.pct > rawPct, `effective ${m.pct}% > raw ${rawPct}%`);
  });

  await step('§2.3.3 without foldAt nothing is crossed, even near a full window', () => {
    const win = lookupCtx('claude-opus-4-8')!;
    const reserved = chooseMaxTokens('claude-opus-4-8', 'high');
    const used = Math.round((win - reserved) * 0.92); // ~92% effective
    const m = meterFor('claude-opus-4-8', 'high', used);
    assert(m.pct >= 90, `pct ${m.pct} near full`);
    assertEq(m.crossed.fold, false, 'fold not configured ⇒ false');
  });

  await step('§2.3.4 fold crossing fires only with foldAt configured', () => {
    const win = lookupCtx('claude-opus-4-8')!;
    const reserved = chooseMaxTokens('claude-opus-4-8', 'high');
    const eff = win - reserved;
    const used = Math.round(eff * 0.65); // ~65% effective
    const m = meterFor('claude-opus-4-8', 'high', used, 60);
    assert(m.pct >= 60 && m.pct < 75, `pct ${m.pct} above foldAt`);
    assertEq(m.crossed.fold, true, 'fold crossed');
    assertEq(meterFor('claude-opus-4-8', 'high', Math.round(eff * 0.5), 60).crossed.fold, false, 'below foldAt');
  });

  await step('§2.3.5 haiku 200K window resolves with its own reserved budget', () => {
    const m = meterFor('claude-haiku-4-5-20251001', 'low', 90_000);
    assertEq(m.windowSize, 200_000, 'haiku window');
    assert(m.effectiveWindow < 200_000 && m.effectiveWindow > 0, 'haiku effective window sane');
    assert(m.pct > 0 && m.pct <= 100, `haiku pct sane: ${m.pct}`);
  });

  summary('context-budget');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
