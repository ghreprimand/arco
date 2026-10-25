// Workbench Expansion §D3 — Usage analytics over time smoke.
//
// Tests the MECHANISM directly (no WS, no LLM, no dev server):
//
//   1. Unit-test the pure aggregateUsage() over a hand-built array of
//      primary_turn_token_usage events spanning 2 providers × 2 days with KNOWN
//      numbers. Assert per-(provider,day) sums, per-provider totals, grand
//      totals, day axis.
//   2. Assert the per-provider cache-hit-ratio denominator: a Claude event and
//      a Codex event with IDENTICAL raw numbers must yield DIFFERENT ratios
//      (Claude denom = input+cacheRead+cacheCreate; Codex denom = input).
//   3. Assert a malformed event is SKIPPED (not summed, doesn't throw).
//   4. Integration leg: write a temp <tmp>/.archon/workflows/<wfid>/events.jsonl
//      with seeded events + noise lines, call aggregateUsageForCwd() against the
//      temp cwd, assert totals match the hand-count. Clean up.
//
// Run: npm run smoke:usage-stats   (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateUsage, aggregateUsageForCwd } from '../../server/src/http/usageStatsRoutes.js';

// Build one primary_turn_token_usage event with the fields the aggregator
// reads. Defaults keep call sites terse.
function ev(opts: {
  provider: string;
  day: string; // YYYY-MM-DD local
  hour?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}): Record<string, unknown> {
  // Construct turnStartedAt from a LOCAL calendar date so localDay() buckets it
  // onto the intended day regardless of the runner's timezone.
  const [y, m, d] = opts.day.split('-').map(Number);
  const ts = new Date(y, m - 1, d, opts.hour ?? 12, 0, 0, 0).getTime();
  return {
    type: 'primary_turn_token_usage',
    workflowId: 'wf-smoke',
    turnStartedAt: ts,
    durationMs: 1000,
    provider: opts.provider,
    input: opts.input,
    output: opts.output,
    cacheRead: opts.cacheRead,
    cacheCreate: opts.cacheCreate,
    thinkingBytes: 0,
    toolResultBytes: -1,
    toolResultBytesRaw: -1,
  };
}

async function main() {
  const cleanups: string[] = [];

  // ── 2 providers × 2 days, known numbers ──
  // claude, day1: two turns → input 100+50, output 10+5, cacheRead 200+100,
  //   cacheCreate 30+20. claude prompt (disjoint) = input+cacheRead+cacheCreate.
  // claude, day2: one turn.
  // codex, day1: one turn.  codex, day2: one turn.
  const claudeD1a = ev({ provider: 'claude', day: '2026-05-01', hour: 9, input: 100, output: 10, cacheRead: 200, cacheCreate: 30 });
  const claudeD1b = ev({ provider: 'claude', day: '2026-05-01', hour: 14, input: 50, output: 5, cacheRead: 100, cacheCreate: 20 });
  const claudeD2 = ev({ provider: 'claude', day: '2026-05-02', hour: 10, input: 40, output: 8, cacheRead: 60, cacheCreate: 0 });
  const codexD1 = ev({ provider: 'codex', day: '2026-05-01', hour: 11, input: 1000, output: 100, cacheRead: 400, cacheCreate: 0 });
  const codexD2 = ev({ provider: 'codex', day: '2026-05-02', hour: 16, input: 500, output: 50, cacheRead: 250, cacheCreate: 0 });

  const events = [claudeD1a, claudeD1b, claudeD2, codexD1, codexD2];

  await step('per-(provider,day) sums are correct', () => {
    const agg = aggregateUsage(events);
    const claude = agg.perProvider.claude!;
    const codex = agg.perProvider.codex!;
    assert(!!claude && !!codex, 'both providers present');

    // claude day1 bucket
    const cD1 = claude.byDay.find((b) => b.day === '2026-05-01')!;
    assertEq(cD1.input, 150, 'claude d1 input');
    assertEq(cD1.output, 15, 'claude d1 output');
    assertEq(cD1.cacheRead, 300, 'claude d1 cacheRead');
    assertEq(cD1.cacheCreate, 50, 'claude d1 cacheCreate');
    assertEq(cD1.turns, 2, 'claude d1 turns');
    // claude prompt = input + cacheRead + cacheCreate = 150 + 300 + 50 = 500
    assertEq(cD1.promptTokens, 500, 'claude d1 promptTokens (disjoint sum)');

    // claude day2 bucket
    const cD2 = claude.byDay.find((b) => b.day === '2026-05-02')!;
    assertEq(cD2.promptTokens, 40 + 60 + 0, 'claude d2 promptTokens');
    assertEq(cD2.turns, 1, 'claude d2 turns');

    // codex day1 bucket — prompt = input (1000), cacheRead subset (400)
    const xD1 = codex.byDay.find((b) => b.day === '2026-05-01')!;
    assertEq(xD1.input, 1000, 'codex d1 input');
    assertEq(xD1.promptTokens, 1000, 'codex d1 promptTokens (input is full prompt)');
    assertEq(xD1.turns, 1, 'codex d1 turns');
  });

  await step('per-provider totals + grand totals are correct', () => {
    const agg = aggregateUsage(events);
    const claude = agg.perProvider.claude!;
    const codex = agg.perProvider.codex!;

    assertEq(claude.totals.input, 100 + 50 + 40, 'claude total input');
    assertEq(claude.totals.output, 10 + 5 + 8, 'claude total output');
    assertEq(claude.totals.cacheRead, 200 + 100 + 60, 'claude total cacheRead');
    assertEq(claude.totals.cacheCreate, 30 + 20 + 0, 'claude total cacheCreate');
    assertEq(claude.totals.turns, 3, 'claude total turns');
    // claude prompt total = 500 (d1) + 100 (d2) = 600
    assertEq(claude.totals.promptTokens, 600, 'claude total promptTokens');

    assertEq(codex.totals.input, 1500, 'codex total input');
    assertEq(codex.totals.promptTokens, 1500, 'codex total promptTokens');
    assertEq(codex.totals.turns, 2, 'codex total turns');

    assertEq(agg.grandTotals.turns, 5, 'grand total turns');
    assertEq(agg.grandTotals.input, 190 + 1500, 'grand total input');
    assertEq(agg.grandTotals.promptTokens, 600 + 1500, 'grand total promptTokens');
    assertEq(agg.turnsAggregated, 5, 'turnsAggregated');

    // Shared day axis = union, ascending.
    assertEq(agg.days.join(','), '2026-05-01,2026-05-02', 'day axis is the sorted union');
  });

  await step('cache-hit ratio uses the provider-correct denominator', () => {
    // Two events, IDENTICAL raw numbers, different providers → DIFFERENT ratios.
    const raw = { input: 100, output: 0, cacheRead: 25, cacheCreate: 75 };
    const c = ev({ provider: 'claude', day: '2026-05-03', ...raw });
    const x = ev({ provider: 'codex', day: '2026-05-03', ...raw });
    const agg = aggregateUsage([c, x]);

    // Claude denom = input + cacheRead + cacheCreate = 100 + 25 + 75 = 200
    //   ratio = 25 / 200 = 0.125
    const claudeRatio = agg.perProvider.claude!.totals.cacheHitRatio;
    // Codex denom = input = 100 → ratio = 25 / 100 = 0.25
    const codexRatio = agg.perProvider.codex!.totals.cacheHitRatio;

    assert(Math.abs(claudeRatio - 0.125) < 1e-9, `claude ratio should be 0.125 (got ${claudeRatio})`);
    assert(Math.abs(codexRatio - 0.25) < 1e-9, `codex ratio should be 0.25 (got ${codexRatio})`);
    assert(claudeRatio !== codexRatio, 'identical raw numbers MUST yield different ratios per provider');
  });

  await step('no-cache provider yields a 0 ratio (no throw)', () => {
    const oll = ev({ provider: 'ollama', day: '2026-05-04', input: 500, output: 100, cacheRead: 0, cacheCreate: 0 });
    const agg = aggregateUsage([oll]);
    assertEq(agg.perProvider.ollama!.totals.cacheHitRatio, 0, 'ollama ratio is 0 (no cache)');
    assertEq(agg.perProvider.ollama!.totals.promptTokens, 500, 'ollama prompt = input');
  });

  await step('malformed / partial events are skipped', () => {
    const bad1 = { type: 'primary_turn_token_usage', provider: 'claude' }; // missing numbers
    const bad2 = { type: 'primary_turn_token_usage', provider: 'claude', turnStartedAt: 'nope', input: 1, output: 1, cacheRead: 0, cacheCreate: 0 };
    const bad3 = { type: 'something_else', provider: 'claude', turnStartedAt: 1, input: 1, output: 1, cacheRead: 0, cacheCreate: 0 };
    const bad4 = null;
    const good = ev({ provider: 'claude', day: '2026-05-05', input: 10, output: 2, cacheRead: 0, cacheCreate: 0 });
    const agg = aggregateUsage([bad1, bad2, bad3, bad4, good]);
    assertEq(agg.turnsAggregated, 1, 'only the one good event is aggregated');
    assertEq(agg.grandTotals.input, 10, 'malformed events did not poison the sum');
  });

  await step('from/to window filters by turnStartedAt', () => {
    const agg = aggregateUsage(events, {
      // Only day 2 (2026-05-02) onward.
      from: new Date(2026, 4, 2, 0, 0, 0, 0).getTime(),
    });
    assertEq(agg.turnsAggregated, 2, 'window keeps only the two day-2 turns');
    assert(agg.days.join(',') === '2026-05-02', `day axis narrowed to day 2 (got ${agg.days.join(',')})`);
  });

  // ── Integration leg: fs-scan + aggregate against a temp cwd ──
  await step('aggregateUsageForCwd scans events.jsonl and totals match the hand-count', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-usage-cwd-'));
    cleanups.push(cwd);

    // Two workflows, each with a mix of usage events + noise lines (other
    // event types, a deliberately-corrupt JSON line) the scanner must skip.
    const wf1 = 'aaaaaaaa-1111-2222-3333-444444444444';
    const wf2 = 'bbbbbbbb-5555-6666-7777-888888888888';
    for (const [wfid, evs] of [
      [wf1, [claudeD1a, claudeD1b]],
      [wf2, [codexD1, claudeD2]],
    ] as [string, Record<string, unknown>[]][]) {
      const dir = join(cwd, '.archon', 'workflows', wfid);
      mkdirSync(dir, { recursive: true });
      const lines: string[] = [];
      lines.push(JSON.stringify({ type: 'workflow_created', workflowId: wfid }));
      for (const e of evs) lines.push(JSON.stringify({ ...e, workflowId: wfid }));
      lines.push('{ this is not valid json'); // corrupt line — must be skipped
      lines.push(JSON.stringify({ type: 'user_message_echo', workflowId: wfid, content: 'hi' }));
      writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    }

    const agg = await aggregateUsageForCwd(cwd);
    // Hand-count: claudeD1a + claudeD1b + claudeD2 (3 claude) + codexD1 (1 codex)
    assertEq(agg.turnsAggregated, 4, 'four usage events aggregated across two workflows');
    assertEq(agg.workflowsScanned, 2, 'two workflows scanned');
    assertEq(agg.perProvider.claude!.totals.turns, 3, 'claude turns from fs');
    assertEq(agg.perProvider.claude!.totals.promptTokens, 500 + 100, 'claude prompt from fs (d1 500 + d2 100)');
    assertEq(agg.perProvider.codex!.totals.turns, 1, 'codex turns from fs');
    assertEq(agg.perProvider.codex!.totals.promptTokens, 1000, 'codex prompt from fs');
    assertEq(agg.grandTotals.turns, 4, 'grand turns from fs');
  });

  await step('aggregateUsageForCwd on a missing cwd returns an empty aggregation', async () => {
    const agg = await aggregateUsageForCwd(join(tmpdir(), 'archon-usage-does-not-exist-xyz'));
    assertEq(agg.turnsAggregated, 0, 'no turns for a missing cwd');
    assertEq(agg.days.length, 0, 'no days');
    assertEq(agg.from, null, 'from null when nothing matched');
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('D3 usage-stats');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
