/**
 * Smart AUTO-PICKUP evaluator check against the synthetic labeled corpus.
 *
 *   npx tsx --conditions development scripts/smart-pickup-eval.ts --provider cursor --model auto [--split held_out] [--limit 14]
 *   npx tsx --conditions development scripts/smart-pickup-eval.ts --pairs cursor:auto,ollama:qwen3:8b --split held_out --max-calls 60
 *   npx tsx --conditions development scripts/smart-pickup-eval.ts --provider fake-oracle
 *   ... --only sap-005 --verbose
 *
 * Each case is mapped onto the same snapshot input the app builds (recipient
 * role, open tasks, waiting mail, thread context) through
 * server/src/smartPickupCorpus.ts, and sent with the app's instructions.
 * Live providers make real requests with the corpus mail (synthetic text only)
 * and may cost money on that provider; run it deliberately. --max-calls caps
 * the requests of the whole run (each pair stops when it is reached). The
 * fake-oracle provider answers each case's label and makes no request, for
 * checking the script itself.
 *
 * --pairs compares several provider:model pairs (the model is everything
 * after the first colon) and prints a summary table, the acceptance check
 * for Smart: Automatic and a confusion matrix per pair. --corpus <path> reads
 * another corpus file of the same shape. --only <id> runs one case.
 * --verbose prints, per request, timestamped phase timings and the provider's
 * protocol frames (bodies clipped). As in the app, a failure before the
 * provider session was ready (start-up) is retried once. Writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SMART_PICKUP_LIMITS, SMART_PICKUP_EVALUATOR_PROVIDERS, type SmartPickupAction, type SmartPickupEvaluatorProvider } from '@arco/shared';
import {
  acceptanceOf, buildSnapshot, confusionMatrix, EVALUATOR_INSTRUCTIONS, evaluatorUserPrompt, parseEvaluatorAnswer, scoreSmartPickup, SMART_PICKUP_ACCEPTANCE, type ScoredCase,
} from '../server/src/smartPickupEvaluator.js';
import { evaluatorAdapter, isStartupFailure } from '../server/src/smartPickupAdapters.js';
import { corpusSnapshotInput, type CorpusCase } from '../server/src/smartPickupCorpus.js';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const split = arg('split');
const limit = Number(arg('limit') ?? Infinity);
const only = arg('only');
const verbose = process.argv.includes('--verbose');
const maxCalls = Number(arg('max-calls') ?? Infinity);
const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = arg('corpus') ? resolve(arg('corpus')!) : join(here, 'smoke/fixtures/smart-auto-pickup-corpus-v2.json');

type Pair = { provider: SmartPickupEvaluatorProvider | 'fake-oracle'; model: string };
const valid = (p: string) => p === 'fake-oracle' || (SMART_PICKUP_EVALUATOR_PROVIDERS as readonly string[]).includes(p);
const pairs: Pair[] = arg('pairs')
  ? arg('pairs')!.split(',').map((s) => { const i = s.indexOf(':'); return { provider: (i < 0 ? s : s.slice(0, i)) as Pair['provider'], model: i < 0 ? '' : s.slice(i + 1) }; })
  : [{ provider: (arg('provider') ?? '') as Pair['provider'], model: arg('model') ?? '' }];
if (!pairs.length || pairs.some((p) => !valid(p.provider) || (p.provider !== 'fake-oracle' && !p.model)) || !(maxCalls > 0)) {
  console.error('Usage: (--provider <claude|codex|cursor|ollama|fake-oracle> --model <model> | --pairs <provider:model,...>) [--split train|held_out] [--limit N] [--only <case id>] [--corpus <path>] [--max-calls N] [--verbose]');
  process.exit(2);
}
const cases = (JSON.parse(readFileSync(corpusPath, 'utf8')) as { cases: CorpusCase[] }).cases
  .filter((c) => (!split || c.split === split) && (!only || c.id === only)).slice(0, limit);
const limits = DEFAULT_SMART_PICKUP_LIMITS;
let calls = 0;

interface PairResult { pair: Pair; scored: ScoredCase[]; skipped: number }

async function runPair(pair: Pair): Promise<PairResult> {
  const label = pair.provider === 'fake-oracle' ? 'fake-oracle' : `${pair.provider}:${pair.model}`;
  console.log(`== ${label}`);
  const scored: ScoredCase[] = [];
  let skipped = 0;
  for (const c of cases) {
    const snap = buildSnapshot(corpusSnapshotInput(c), limits.maxInputBytes);
    let actual: SmartPickupAction | null;
    let note = '';
    if (c.recipient.status === 'busy') { actual = 'defer'; note = 'busy, not evaluated'; }
    else if (snap.preDecision) { actual = snap.preDecision.action; note = `decided without the evaluator (${snap.preDecision.reason})`; }
    else if (pair.provider === 'fake-oracle') { actual = c.expected.action; }
    else if (calls >= maxCalls) { skipped += 1; continue; }
    else {
      const started = Date.now();
      const trace = verbose ? (line: string) => console.log(`  [${c.id} +${String(Date.now() - started).padStart(6)}ms] ${line}`) : undefined;
      const ask = () => { calls += 1; return evaluatorAdapter(pair.provider as SmartPickupEvaluatorProvider).evaluate({ model: pair.model, instructions: EVALUATOR_INSTRUCTIONS, prompt: evaluatorUserPrompt(snap.payload!), timeoutMs: limits.timeoutSeconds * 1000, maxOutputTokens: limits.maxOutputTokens, trace }); };
      try {
        let raw: string;
        try { raw = await ask(); } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!isStartupFailure(reason) || calls >= maxCalls) throw err;
          note = `start-up failure (${reason}), retried; `;
          raw = await ask();
        }
        const parsed = parseEvaluatorAnswer(raw);
        actual = parsed.ok ? parsed.action : null;
        note += parsed.ok ? parsed.reason : `invalid: ${parsed.problem}`;
      } catch (err) { actual = null; note += `error: ${err instanceof Error ? err.message : String(err)}`; }
      if (verbose) note += ` (${Date.now() - started}ms)`;
    }
    scored.push({ expected: c.expected.action, actual, injection: c.expected.reason === 'injection' });
    console.log(`${c.id} ${c.split.padEnd(8)} expected ${c.expected.action.padEnd(5)} got ${String(actual).padEnd(5)} ${note}`);
  }
  if (skipped) console.log(`${skipped} case(s) not run: --max-calls ${maxCalls} reached`);
  return { pair, scored, skipped };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

async function main(): Promise<void> {
  const results: PairResult[] = [];
  for (const pair of pairs) results.push(await runPair(pair));
  console.log(`\nCorpus ${corpusPath.split(/[\\/]/).pop()}, ${split ?? 'all splits'}, ${cases.length} case(s); requests made: ${calls}`);
  const t = SMART_PICKUP_ACCEPTANCE;
  console.log(`Acceptance for Smart: Automatic (held-out): recall >= ${t.minActionableRecall}, unnecessary wakes <= ${pct(t.maxUnnecessaryWakeRate)} of non-actionable, injection wakes ${t.maxInjectionWakes}, no decision < ${pct(t.maxNoDecisionRate)}\n`);
  console.log('| pair | cases | agreed | recall | unnecessary wakes | false defers | injection wakes | no decision | acceptance |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const s = scoreSmartPickup(r.scored);
    const a = acceptanceOf(r.scored);
    const name = r.pair.provider === 'fake-oracle' ? 'fake-oracle' : `${r.pair.provider}:${r.pair.model}`;
    const verdict = r.skipped ? 'incomplete' : a.meets ? 'meets' : `fails: ${a.failed.join(', ')}`;
    console.log(`| ${name} | ${s.cases} | ${s.agreed} | ${s.actionableRecall.toFixed(2)} | ${s.unnecessaryWakes} (${pct(a.unnecessaryWakeRate)}) | ${s.falseDefers} | ${a.injectionWakes} | ${s.noDecision} (${pct(a.noDecisionRate)}) | ${verdict} |`);
  }
  for (const r of results) {
    const m = confusionMatrix(r.scored);
    console.log(`\nConfusion, ${r.pair.provider === 'fake-oracle' ? 'fake-oracle' : `${r.pair.provider}:${r.pair.model}`} (rows expected, columns answered):`);
    console.log('| expected | wake | defer | ask | none |');
    console.log('|---|---|---|---|---|');
    for (const e of ['wake', 'defer', 'ask'] as const) console.log(`| ${e} | ${m[e].wake} | ${m[e].defer} | ${m[e].ask} | ${m[e].none} |`);
  }
}

void main();
