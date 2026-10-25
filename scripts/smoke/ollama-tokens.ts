// M6 (LOCAL_AI_MASTER_PLAN / Hardening §5) — Ollama token-accounting unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It
// drives the pre-turn estimator + context_usage builder in
// server/src/providers/ollamaTokens.ts directly and asserts on the numbers.
// Offline-runnable (CI has no daemon); exercises the ACCOUNTING logic, not a
// real model response.
//
// The load-bearing assertion (Hardening §5, odysseus 6973c54): a tool-CALL
// assistant turn carries empty `content` with the whole payload in
// `tool_calls[].function.arguments`. A naïve content-only estimate undershoots
// 20-30% there and the M8 compaction gate goes blind. So this test proves the
// estimator counts tool-call argument JSON (and tool-result bodies + schemas),
// not just visible text.
//
// Run: npm run smoke:ollama-tokens   (no dev server needed)

import {
  estimateMessageTokens,
  estimateToolSchemaTokens,
  estimatePromptTokens,
  ollamaContextUsage,
  OLLAMA_DEFAULT_WINDOW,
  genSpeedFromOllamaDone,
  addGenSpeed,
  type EstimableMessage,
  type EstimableToolDef,
} from '../../server/src/providers/ollamaTokens.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passes++;
    console.log(`  ok  ${name}`);
  } else {
    fails++;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

// ── THE deliverable: tool-call args are counted, not just visible text ───────

// Two messages with IDENTICAL (tiny) visible content. One is a plain text turn;
// the other is a tool-CALL turn whose arguments carry a large payload (e.g. a
// Write of a whole file). The naïve content-only count would call them equal —
// the correct estimate must rank the tool-call turn far higher.
const bigArgPayload = 'x'.repeat(4000); // ~ a 4 KB Write body in the args
const plainTurn: EstimableMessage = { role: 'assistant', content: 'ok' };
const toolCallTurn: EstimableMessage = {
  role: 'assistant',
  content: '', // tool-only turns have empty content — the gotcha
  tool_calls: [
    { function: { name: 'Write', arguments: { file_path: 'src/big.ts', content: bigArgPayload } } },
  ],
};

const plainTokens = estimateMessageTokens(plainTurn);
const toolCallTokens = estimateMessageTokens(toolCallTurn);

check('tool-call turn estimates HIGHER than its visible text (args are counted)',
  toolCallTokens > plainTokens * 10);

check('tool-call args drive the estimate into the ~1k-token range (4KB args → counted)',
  toolCallTokens > 1000);

// A content-only estimator (the bug we are guarding against) would have seen
// only the empty content + per-message overhead — prove the gap is real.
const naiveContentOnly = estimateMessageTokens({ role: 'assistant', content: '' });
check('the args contribute the bulk (counted >> the content-only baseline)',
  toolCallTokens - naiveContentOnly > 1000);

// ── tool-RESULT bodies are counted (a 32 KB Read dump lands in content) ──────

const bigResult: EstimableMessage = { role: 'tool', content: 'y'.repeat(32 * 1024) };
const resultTokens = estimateMessageTokens(bigResult);
check('tool-result body is counted (32 KB Read result → thousands of tokens)',
  resultTokens > 8000);

// ── thinking is counted (round-tripped across tool-loop turns) ───────────────

const withThinking: EstimableMessage = { role: 'assistant', content: 'a', thinking: 'z'.repeat(1000) };
const withoutThinking: EstimableMessage = { role: 'assistant', content: 'a' };
check('round-tripped thinking is counted',
  estimateMessageTokens(withThinking) > estimateMessageTokens(withoutThinking) + 200);

// ── tool SCHEMAS are counted (they ride every request) ───────────────────────

const tools: EstimableToolDef[] = [
  {
    function: {
      name: 'Read',
      description: 'Read the contents of a file at the given path. '.repeat(5),
      parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'path' } }, required: ['file_path'] },
    },
  },
  {
    function: {
      name: 'Grep',
      description: 'Search file contents with a regex pattern. '.repeat(5),
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
    },
  },
];
const schemaTokens = estimateToolSchemaTokens(tools);
check('tool schemas contribute a non-trivial fixed floor', schemaTokens > 50);
check('no tools → zero schema cost', estimateToolSchemaTokens(undefined) === 0 && estimateToolSchemaTokens([]) === 0);

// ── combined pre-turn estimate folds messages + schemas ──────────────────────

const transcript: EstimableMessage[] = [
  { role: 'system', content: 'You are a coding agent. '.repeat(40) },
  { role: 'user', content: 'Refactor the parser.' },
  toolCallTurn,
  bigResult,
];
const combined = estimatePromptTokens({ messages: transcript, tools });
const messagesOnly = estimatePromptTokens({ messages: transcript });
check('combined estimate >= messages-only (schemas add to the budget)', combined >= messagesOnly);
check('combined estimate folds the big tool-call + tool-result turns',
  combined > toolCallTokens + resultTokens);

// ── context_usage builder: shape + denominator handling ──────────────────────

const usageProbed = ollamaContextUsage(8000, 32768, 1234);
check('context_usage: present with a ground-truth prompt count', usageProbed !== null);
check('context_usage: method is ground-truth', usageProbed?.method === 'ground-truth');
check('context_usage: uses the PROBED window as denominator (M3/M4)', usageProbed?.windowSize === 32768);
check('context_usage: percent = round(8000/32768*100) = 24', usageProbed?.percentOfWindow === 24);
check('context_usage: estimatedTokens = the ground-truth prompt count', usageProbed?.estimatedTokens === 8000);
check('context_usage: carries calibratedAt timestamp', usageProbed?.calibratedAt === 1234);

const usageNoProbe = ollamaContextUsage(1500, undefined);
check('context_usage: unknown window falls back to Ollama 2048 default',
  usageNoProbe?.windowSize === OLLAMA_DEFAULT_WINDOW);
check('context_usage: percent clamps at 100 when over the default window',
  ollamaContextUsage(5000, undefined)?.percentOfWindow === 100);

check('context_usage: null when no ground truth yet (no turn reported a count)',
  ollamaContextUsage(0, 32768) === null && ollamaContextUsage(undefined, 32768) === null);

// ── generation speed: done-envelope timings → decode / prefill ──────────────

// Real-shaped done envelope: durations are NANOSECONDS.
const doneA = genSpeedFromOllamaDone({
  done: true, eval_count: 140, eval_duration: 2_000_000_000,
  prompt_eval_count: 1600, prompt_eval_duration: 2_000_000_000,
});
check('genSpeed: ns durations convert to ms', doneA !== null && doneA.decodeMs === 2000 && doneA.prefillMs === 2000);
check('genSpeed: counts carried through', doneA !== null && doneA.decodeTokens === 140 && doneA.prefillTokens === 1600);
check('genSpeed: envelope without timings → null', genSpeedFromOllamaDone({ done: true, eval_count: 5 }) === null);

// Tool loop: a tiny tool-call round must not skew the turn — sums, not averages.
const doneB = genSpeedFromOllamaDone({ done: true, eval_count: 1, eval_duration: 1_000_000, prompt_eval_count: 0, prompt_eval_duration: 0 });
const summed = addGenSpeed(addGenSpeed(null, doneA), doneB);
check('genSpeed: addGenSpeed sums counts + durations',
  summed !== null && summed.decodeTokens === 141 && summed.decodeMs === 2001 && summed.prefillTokens === 1600);
check('genSpeed: addGenSpeed(null, null) stays null', addGenSpeed(null, null) === null);

// ── summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`ollama-tokens: ${passes}/${passes + fails} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
