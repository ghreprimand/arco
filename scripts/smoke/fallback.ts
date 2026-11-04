// Workbench Expansion C2 — provider fallback-chain runner unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live providers. Drives
// runWithFallbackChain (server/src/providers/fallbackChain.ts) with a stubbed
// `spawnLeg` and asserts the deterministic advancing rule end to end:
//
//   1. A throttle (rate_limit → backoff_then_rotate) on leg 0 ADVANCES to
//      leg 1, which succeeds; result is leg 1's, fellBack=true, exactly one
//      provider_fell_back captured with the right from/to/reason.
//   2. A context_overflow (compress) on leg 0 does NOT advance even with legs
//      remaining — guards the fence; returns leg 0's error, no fall-back.
//   3. A single-leg chain with a throttle returns the error without firing
//      onFellBack (nowhere to advance to).
//   4. buildChain de-dupes a configured leg equal to the primary, and an unset
//      config yields a single-leg chain (no-regression invariant).
//   5. actionAdvances matches the documented advancing/non-advancing split,
//      including bare `backoff` (NO) vs `backoff_then_rotate` (YES).
//
// Run: npm run smoke:fallback  (no dev server needed)

import { runWithFallbackChain, buildChain, actionAdvances } from '../../server/src/providers/fallbackChain.js';
import type { FallbackLeg } from '../../server/src/providers/fallbackChain.js';
import type { FailoverAction, FailoverReason } from '../../server/src/providers/errorClassifier.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    console.log(`  FAIL  ${label}`);
    failures.push(label);
    fails++;
  }
}

// A minimal leg-result shape for the stub — only `error` matters to the runner
// (via the isError accessor). Mirrors WorkerResult structurally.
interface StubResult {
  error?: string;
  text?: string;
}

type FellBack = { from: FallbackLeg; to: FallbackLeg; reason: FailoverReason; action: FailoverAction };

const claudeLeg: FallbackLeg = { provider: 'claude', model: 'opus', effort: 'high' };
const codexLeg: FallbackLeg = { provider: 'codex', model: 'gpt-5', effort: 'high' };
const ollamaLeg: FallbackLeg = { provider: 'ollama', model: 'qwen', effort: 'high' };

async function main(): Promise<void> {
// ── Scenario 1: throttle on leg 0 → advance to leg 1 (success) ──
{
  const ranLegs: number[] = [];
  const fellBack: FellBack[] = [];
  const result = await runWithFallbackChain<StubResult>({
    legs: [claudeLeg, codexLeg, ollamaLeg],
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg: async (_leg, i) => {
      ranLegs.push(i);
      if (i === 0) return { error: 'rate_limit_error: Number of requests has exceeded your rate limit' };
      return { text: 'review body' };
    },
    onFellBack: (info) => fellBack.push(info),
  });

  assert('S1: leg 0 then leg 1 ran (leg 2 never reached)', JSON.stringify(ranLegs) === '[0,1]');
  assert('S1: result is leg 1 success (no error)', result.result.error === undefined && result.result.text === 'review body');
  assert('S1: legIndex === 1', result.legIndex === 1);
  assert('S1: legUsed is the codex leg', result.legUsed.provider === 'codex' && result.legUsed.model === 'gpt-5');
  assert('S1: fellBack === true', result.fellBack === true);
  assert('S1: exactly one provider_fell_back captured', fellBack.length === 1);
  assert('S1: from = claude/opus', fellBack[0]?.from.provider === 'claude' && fellBack[0]?.from.model === 'opus');
  assert('S1: to = codex/gpt-5', fellBack[0]?.to.provider === 'codex' && fellBack[0]?.to.model === 'gpt-5');
  assert('S1: reason = rate_limit', fellBack[0]?.reason === 'rate_limit');
  assert('S1: action = backoff_then_rotate', fellBack[0]?.action === 'backoff_then_rotate');
}

// ── Scenario 2: context_overflow (compress) on leg 0 → NO advance (fence) ──
{
  const ranLegs: number[] = [];
  const fellBack: FellBack[] = [];
  const result = await runWithFallbackChain<StubResult>({
    legs: [claudeLeg, codexLeg],
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg: async (_leg, i) => {
      ranLegs.push(i);
      return { error: 'prompt is too long: 250000 tokens > 200000 maximum' };
    },
    onFellBack: (info) => fellBack.push(info),
  });

  assert('S2: only leg 0 ran (compress does NOT advance)', JSON.stringify(ranLegs) === '[0]');
  assert('S2: result is leg 0 error surfaced', result.result.error?.includes('prompt is too long') === true);
  assert('S2: legIndex === 0', result.legIndex === 0);
  assert('S2: fellBack === false', result.fellBack === false);
  assert('S2: no provider_fell_back captured', fellBack.length === 0);
}

// ── Scenario 3: single-leg chain with a throttle → error, no onFellBack ──
{
  const fellBack: FellBack[] = [];
  const result = await runWithFallbackChain<StubResult>({
    legs: [claudeLeg],
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg: async () => ({ error: '429 Too Many Requests' }),
    onFellBack: (info) => fellBack.push(info),
  });

  assert('S3: result is the error (nowhere to advance)', result.result.error === '429 Too Many Requests');
  assert('S3: legIndex === 0', result.legIndex === 0);
  assert('S3: fellBack === false', result.fellBack === false);
  assert('S3: onFellBack never fired', fellBack.length === 0);
}

// ── Scenario 3b: leg 0 succeeds → never touches the fallback leg ──
{
  const ranLegs: number[] = [];
  const fellBack: FellBack[] = [];
  const result = await runWithFallbackChain<StubResult>({
    legs: [claudeLeg, codexLeg],
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg: async (_leg, i) => { ranLegs.push(i); return { text: 'ok' }; },
    onFellBack: (info) => fellBack.push(info),
  });
  assert('S3b: only leg 0 ran', JSON.stringify(ranLegs) === '[0]');
  assert('S3b: fellBack === false on first-leg success', result.fellBack === false);
  assert('S3b: onFellBack never fired', fellBack.length === 0);
}

// ── Scenario 4: buildChain semantics ──
{
  // Unset config → single-leg (no-regression invariant).
  const c1 = buildChain(claudeLeg, undefined);
  assert('S4: unset config → single-leg chain', c1.length === 1 && c1[0].provider === 'claude');

  // Empty config → single-leg.
  const c2 = buildChain(claudeLeg, []);
  assert('S4: empty config → single-leg chain', c2.length === 1);

  // Configured legs append, primary-equal leg dropped.
  const c3 = buildChain(claudeLeg, [{ provider: 'claude', model: 'opus' }, codexLeg, ollamaLeg]);
  assert('S4: primary-equal configured leg dropped', c3.length === 3);
  assert('S4: chain order is primary then configured', c3[0].provider === 'claude' && c3[1].provider === 'codex' && c3[2].provider === 'ollama');

  // Same provider, different model is NOT a dup.
  const c4 = buildChain(claudeLeg, [{ provider: 'claude', model: 'sonnet' }]);
  assert('S4: same-provider different-model is kept', c4.length === 2 && c4[1].model === 'sonnet');
}

// ── Scenario 5: actionAdvances matches the documented split ──
{
  assert('S5: fallback advances', actionAdvances('fallback') === true);
  assert('S5: rotate advances', actionAdvances('rotate') === true);
  assert('S5: backoff_then_rotate advances', actionAdvances('backoff_then_rotate') === true);
  assert('S5: bare backoff does NOT advance', actionAdvances('backoff') === false);
  assert('S5: compress does NOT advance', actionAdvances('compress') === false);
  assert('S5: no_retry does NOT advance', actionAdvances('no_retry') === false);
  assert('S5: fail does NOT advance', actionAdvances('fail') === false);
}

// ── Scenario 6: a non-advancing classified action with legs remaining stops ──
// (e.g. content_policy → no_retry). Guards that ONLY advancing actions move on.
{
  const ranLegs: number[] = [];
  const fellBack: FellBack[] = [];
  const result = await runWithFallbackChain<StubResult>({
    legs: [claudeLeg, codexLeg],
    isError: (r) => r.error,
    provider: (leg) => leg.provider,
    spawnLeg: async (_leg, i) => { ranLegs.push(i); return { error: 'Output blocked by content policy' }; },
    onFellBack: (info) => fellBack.push(info),
  });
  assert('S6: only leg 0 ran (no_retry does NOT advance)', JSON.stringify(ranLegs) === '[0]');
  assert('S6: fellBack === false', result.fellBack === false);
  assert('S6: no provider_fell_back captured', fellBack.length === 0);
}
}

main().then(() => {
  // ── Summary ──
  const total = passes + fails;
  console.log('');
  console.log(`fallback: ${passes}/${total} checks passed`);
  if (fails > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}).catch((err) => {
  console.error('fallback smoke threw:', err);
  process.exit(1);
});
