// M11 (LOCAL_AI_MASTER_PLAN Stage 4 / Excellence LE-5, superset of
// OLLAMA_HARDENING_PLAN §8) — capability-gated tool handling unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It
// drives the M11 fenced-tools module + the gate directly and asserts on the
// outputs. Offline-runnable.
//
// Asserts the M11 contract:
//   - the GATE picks native for a tools-capable probe and fenced for a non-tool
//     probe; the override flag (ARCO_OLLAMA_TOOL_MODE) forces either way.
//   - the injected protocol block is STABLE across turns (prefix-cache safe) —
//     byte-identical for a stable tool subset.
//   - the parser extracts a well-formed fenced call AND a messy one (prose
//     around it, drift in keys, alternate fence char, bare JSON fallback).
//   - parsed calls map to the SAME shape the native execution path consumes.
//   - the loop TERMINATES (a final answer with no fenced block → zero calls).
//   - M6's estimator counts the fenced protocol text.
//   - the prompt-inject-vs-expose partition (LE-5) splits context readers out.
//
// Run: npm run smoke:ollama-fenced-tools   (no dev server needed)

import {
  resolveToolMode,
  resolveToolModeOverride,
  buildFencedToolPrompt,
  partitionFencedTools,
  estimateFencedPromptTokens,
  parseFencedToolCalls,
  formatFencedToolResult,
} from '../../server/src/providers/ollamaFencedTools.js';
import {
  getOllamaToolDefinitions,
  isKnownOllamaTool,
  type OllamaToolDefinition,
} from '../../server/src/providers/ollamaTools.js';

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

// Clean env for the default-auto path.
delete process.env.ARCO_OLLAMA_TOOL_MODE;

const fullCluster: OllamaToolDefinition[] = getOllamaToolDefinitions({ clusterEnabled: true });
const fullNoCluster: OllamaToolDefinition[] = getOllamaToolDefinitions({ clusterEnabled: false });

// ── 1. The gate ──────────────────────────────────────────────────────────────
console.log('\n[1] capability gate (native vs fenced, + override)');

check('auto: tools-capable probe → native',
  resolveToolMode({ hasTools: true, nativeCapable: true }) === 'native');
check('auto: non-tool probe → fenced',
  resolveToolMode({ hasTools: true, nativeCapable: false }) === 'fenced');
check('no tools this turn → none (regardless of capability)',
  resolveToolMode({ hasTools: false, nativeCapable: true }) === 'none' &&
  resolveToolMode({ hasTools: false, nativeCapable: false }) === 'none');

check('override native: forces native even for a non-tool model (reverts to pre-M11 fallback)',
  resolveToolMode({ hasTools: true, nativeCapable: false, override: 'native' }) === 'native');
check('override fenced: forces fenced even for a tools-capable model',
  resolveToolMode({ hasTools: true, nativeCapable: true, override: 'fenced' }) === 'fenced');

// Override env parsing.
process.env.ARCO_OLLAMA_TOOL_MODE = 'fenced';
check('env override fenced parsed', resolveToolModeOverride() === 'fenced');
process.env.ARCO_OLLAMA_TOOL_MODE = 'NATIVE';
check('env override native parsed (case-insensitive)', resolveToolModeOverride() === 'native');
process.env.ARCO_OLLAMA_TOOL_MODE = 'garbage';
check('env override garbage → auto', resolveToolModeOverride() === 'auto');
delete process.env.ARCO_OLLAMA_TOOL_MODE;
check('env override unset → auto', resolveToolModeOverride() === 'auto');

// ── 2. Stable protocol block (prefix-cache safety) ───────────────────────────
console.log('\n[2] injected protocol block is byte-stable across turns');

const subset = fullNoCluster.filter((t) => ['Read', 'Grep', 'Glob', 'Bash', 'Write'].includes(t.function.name));
const block1 = buildFencedToolPrompt(subset);
const block2 = buildFencedToolPrompt(subset);
const block3 = buildFencedToolPrompt(subset.slice()); // fresh array, same content
check('protocol block non-empty', block1.length > 0);
check('protocol block byte-identical across rebuilds (prefix-cache safe)',
  block1 === block2 && block2 === block3);
check('protocol block names each action tool',
  ['Read', 'Grep', 'Glob', 'Bash', 'Write'].every((n) => block1.includes(n)));
check('protocol block carries the fenced syntax example',
  block1.includes('```tool') && block1.includes('"name"') && block1.includes('"arguments"'));
check('protocol block has no volatile content (no digits-only timestamp-ish tokens)',
  !/\b\d{10,}\b/.test(block1));
check('empty tool list → empty block', buildFencedToolPrompt([]) === '');

// ── 3. Parser: well-formed call ──────────────────────────────────────────────
console.log('\n[3] parser — well-formed fenced call');

const clean = [
  'I will read the file now.',
  '```tool',
  '{"name": "Read", "arguments": {"file_path": "/abs/x.ts"}}',
  '```',
].join('\n');
const cleanCalls = parseFencedToolCalls(clean, isKnownOllamaTool);
check('well-formed: one call parsed', cleanCalls.length === 1);
check('well-formed: name extracted', cleanCalls[0]?.name === 'Read');
check('well-formed: args extracted', (cleanCalls[0]?.arguments as { file_path?: string })?.file_path === '/abs/x.ts');
check('well-formed: no argError', cleanCalls[0]?.argError === undefined);

// ── 4. Parser: messy output (robustness) ─────────────────────────────────────
console.log('\n[4] parser — messy output (prose, drift, alt fence, bare JSON)');

// Prose around it + alternate fence char + alias key "args".
const messy1 = [
  'Sure! Let me check that.',
  'Here is the call I need to make:',
  '~~~tool',
  'okay -> {"tool": "Grep", "args": {"pattern": "TODO", "path": "/repo"}}',
  '~~~',
  'After this I will summarize.',
].join('\n');
const m1 = parseFencedToolCalls(messy1, isKnownOllamaTool);
check('messy(alt-fence+prose+alias-key): one call', m1.length === 1);
check('messy: name from "tool" alias key', m1[0]?.name === 'Grep');
check('messy: args from "args" alias key', (m1[0]?.arguments as { pattern?: string })?.pattern === 'TODO');

// Multiple blocks in one response.
const messy2 = [
  '```tool',
  '{"name": "Read", "arguments": {"file_path": "/a"}}',
  '```',
  'and also',
  '```json',
  '{"name": "Glob", "arguments": {"pattern": "**/*.ts"}}',
  '```',
].join('\n');
const m2 = parseFencedToolCalls(messy2, isKnownOllamaTool);
check('messy(multi-block, ```json tag): two calls in order', m2.length === 2 && m2[0].name === 'Read' && m2[1].name === 'Glob');

// Bare JSON, no fence at all (open-webui brace-slice fallback), known tool.
const bare = 'Here you go: {"name": "Bash", "arguments": {"command": "ls"}} done';
const b = parseFencedToolCalls(bare, isKnownOllamaTool);
check('bare-JSON fallback (known tool): one call', b.length === 1 && b[0].name === 'Bash');

// Bare JSON that is NOT a tool call (ordinary config object) → no false call.
const notACall = 'The config is {"timeout": 30, "retries": 2} as shown.';
check('bare-JSON that is not a tool → zero calls (no false positive)',
  parseFencedToolCalls(notACall, isKnownOllamaTool).length === 0);

// Malformed JSON inside a fence, no good call → surfaced as an argError so the
// model gets feedback (not a silent no-op).
const broken = '```tool\n{"name": "Read", "arguments": {bad json}}\n```';
const br = parseFencedToolCalls(broken, isKnownOllamaTool);
check('malformed fenced JSON → argError feedback (not silent)',
  br.length === 1 && br[0].argError !== undefined);

// arguments wrong-type → argError.
const wrongArgs = '```tool\n{"name": "Read", "arguments": "just a string"}\n```';
const wa = parseFencedToolCalls(wrongArgs, isKnownOllamaTool);
check('arguments wrong-type → argError', wa.length === 1 && wa[0].argError !== undefined && wa[0].name === 'Read');

// ── 5. Loop termination ──────────────────────────────────────────────────────
console.log('\n[5] loop termination — final answer with no fenced block → zero calls');

const finalAnswer = 'The file defines two exports and a helper. No further tool calls are needed.';
check('plain final answer → zero parsed calls (loop terminates)',
  parseFencedToolCalls(finalAnswer, isKnownOllamaTool).length === 0);
check('empty string → zero calls', parseFencedToolCalls('', isKnownOllamaTool).length === 0);

// ── 6. Parsed calls map to the native execution shape ────────────────────────
console.log('\n[6] parsed calls map onto the native execution path');

// The native dispatchToolCalls consumes { function: { name, arguments }, argError? }.
// Mirror the run-loop mapping and assert the shape is dispatch-ready.
const mapped = cleanCalls.map((p) => ({
  function: { name: p.name, arguments: p.arguments },
  ...(p.argError ? { argError: p.argError } : {}),
}));
check('mapped call has function.name + function.arguments (native shape)',
  mapped[0]?.function?.name === 'Read' && typeof mapped[0]?.function?.arguments === 'object');
check('mapped call name is a known tool (dispatches through the same allowlist)',
  isKnownOllamaTool(mapped[0].function.name));

// Result feedback framing.
const fb = formatFencedToolResult('Read', 'file contents here');
check('tool result framed for the fenced model (labeled inline)',
  fb.includes('[tool result: Read]') && fb.includes('file contents here'));

// ── 7. M6 estimator counts the fenced protocol text ──────────────────────────
console.log('\n[7] M6 estimator counts the fenced protocol injection');

check('fenced prompt token estimate > 0 (it is real prompt tokens)',
  estimateFencedPromptTokens(block1) > 0);
check('empty prompt → 0 tokens', estimateFencedPromptTokens('') === 0);
// Bigger block (more tools) costs more tokens — the gate moves with the surface.
const bigBlock = buildFencedToolPrompt(fullNoCluster);
check('more tools → more estimated tokens (gate tracks the surface size)',
  estimateFencedPromptTokens(bigBlock) > estimateFencedPromptTokens(block1));

// ── 8. LE-5 prompt-inject-vs-expose partition ────────────────────────────────
console.log('\n[8] LE-5 partition — context readers injected, not exposed');

const { action, contextInjected } = partitionFencedTools(fullCluster);
const actionNames = action.map((t) => t.function.name);
const ctxNames = contextInjected.map((t) => t.function.name);
check('cluster context readers partitioned OUT of the action protocol',
  ['peer_read', 'peer_list', 'cluster_plan_tick'].every((n) => ctxNames.includes(n)));
check('peer_send (action) stays in the action protocol',
  actionNames.includes('peer_send'));
check('file/shell tools stay in the action protocol',
  ['Read', 'Grep', 'Glob', 'Bash'].every((n) => actionNames.includes(n)));
check('fenced protocol block omits the context readers',
  ['peer_read', 'cluster_plan_tick'].every((n) => !buildFencedToolPrompt(action).includes(`- ${n} `)));
// Non-cluster subset has no context readers → partition is a no-op.
const { contextInjected: noCtx } = partitionFencedTools(fullNoCluster);
check('non-cluster subset → no context readers to inject', noCtx.length === 0);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passes}/${passes + fails} checks passed`);
if (fails > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('ollama-fenced-tools smoke: PASS');
