// M10 (LOCAL_AI_MASTER_PLAN Stage 4 / OLLAMA_HARDENING_PLAN §7) — relevant-tool
// subsetting unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It
// drives subsetOllamaTools() in server/src/providers/ollamaToolSubset.ts
// directly and asserts on the chosen subset. Offline-runnable.
//
// THE load-bearing assertion (Hardening §7 "Open question"): the subset must be
// STABLE across turns given a stable task-context signal. The tool list sits
// early in the /api/chat body; if the advertised set changes every turn we
// thrash Ollama's prefix cache. So this test proves that ranking off the stable
// per-workflow task context (NOT the volatile last user message) yields a
// byte-identical subset turn-over-turn — and that ranking off a volatile signal
// would NOT (the bug we are avoiding).
//
// Run: npm run smoke:ollama-tool-subset   (no dev server needed)

import {
  subsetOllamaTools,
  isSubsettingEnabled,
  OLLAMA_CORE_TOOLS,
} from '../../server/src/providers/ollamaToolSubset.js';
import {
  getOllamaToolDefinitions,
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

// Stable-input cleanliness: env flags must be unset for the default-on path.
delete process.env.ARCO_OLLAMA_TOOL_SUBSET;
delete process.env.ARCO_OLLAMA_TOOL_CAP;

// The real, full registry incl. cluster tools (12 tools) — the actual catalog
// that overwhelms small models today.
const fullCluster: OllamaToolDefinition[] = getOllamaToolDefinitions({ clusterEnabled: true });
const fullNoCluster: OllamaToolDefinition[] = getOllamaToolDefinitions({ clusterEnabled: false });

const names = (l: OllamaToolDefinition[]): string[] => l.map((t) => t.function.name);

check('registry sanity: full cluster list exceeds the cap (subsetting can engage)',
  fullCluster.length > 9);
check('registry sanity: non-cluster list is small (<= cap → realistic pass-through case)',
  fullNoCluster.length <= 9);

// For the "subsetting engages" cases we use the FULL cluster catalog (12 tools,
// > cap) with clusterMember:false so the cluster tools are rankable (not forced
// into core) — that exercises the ranking path with room to spare.

// ── CORE tools are always retained ───────────────────────────────────────────

// A task that mentions NONE of the core tools by name — they must still survive.
const webTask = 'Research the latest news online and fetch some web pages to summarize.';
const webResult = subsetOllamaTools({ tools: fullCluster, taskContext: webTask });

check('subsetting applied on a >cap list', webResult.applied);
for (const coreName of OLLAMA_CORE_TOOLS) {
  check(`core tool "${coreName}" always retained (even when task does not mention it)`,
    webResult.kept.includes(coreName));
}

// ── relevant tools are ranked IN ─────────────────────────────────────────────

check('a web-research task surfaces WebSearch (relevant non-core ranked in)',
  webResult.kept.includes('WebSearch'));
check('a web-research task surfaces WebFetch (relevant non-core ranked in)',
  webResult.kept.includes('WebFetch'));

const writeTask = 'Create a new file and write the implementation, then commit and report progress.';
const writeResult = subsetOllamaTools({ tools: fullCluster, taskContext: writeTask });
check('a write-the-code task surfaces Write (relevant non-core ranked in)',
  writeResult.kept.includes('Write'));

// ── cap is respected ─────────────────────────────────────────────────────────

check('advertised set never exceeds the cap', webResult.kept.length <= webResult.cap);
check('default cap is 9', webResult.cap === 9);
check('kept + dropped accounts for the whole input',
  webResult.kept.length + webResult.dropped.length === fullCluster.length);

// ── STABLE across turns given stable inputs (the prefix-cache guarantee) ──────

// Same task context, called twice (simulating two operator turns) → byte-
// identical advertised list. This is the whole point: a stable signal yields a
// stable subset → byte-stable request body → prefix cache survives.
const turn1 = subsetOllamaTools({ tools: fullCluster, taskContext: writeTask });
const turn2 = subsetOllamaTools({ tools: fullCluster, taskContext: writeTask });
check('STABLE: identical task context → identical advertised names across turns',
  JSON.stringify(names(turn1.tools)) === JSON.stringify(names(turn2.tools)));
check('STABLE: identical task context → byte-identical advertised tool defs',
  JSON.stringify(turn1.tools) === JSON.stringify(turn2.tools));

// And prove the ANTI-PATTERN we are avoiding would NOT be stable: ranking off a
// volatile per-turn signal (different user messages) CAN change the subset.
// (We don't ship that path — this just documents why the stable signal matters.)
const volatileA = subsetOllamaTools({ tools: fullCluster, taskContext: 'send a note to a peer about the plan' });
const volatileB = subsetOllamaTools({ tools: fullCluster, taskContext: 'search the web for docs and fetch them' });
check('CONTRAST: different signals CAN produce different subsets (why volatile-signal ranking would thrash the cache)',
  JSON.stringify(names(volatileA.tools)) !== JSON.stringify(names(volatileB.tools)));

// ── small lists pass through untouched ───────────────────────────────────────

const smallList = fullNoCluster.slice(0, 4);
const smallResult = subsetOllamaTools({ tools: smallList, taskContext: writeTask });
check('small list (<= cap) passes through untouched (not applied)', !smallResult.applied);
check('small list pass-through is byte-identical to input',
  JSON.stringify(smallResult.tools) === JSON.stringify(smallList));
check('small list pass-through reason is under-cap', smallResult.reason === 'under-cap');

// ── disable flag returns the full list ───────────────────────────────────────

process.env.ARCO_OLLAMA_TOOL_SUBSET = '0';
check('disable flag: isSubsettingEnabled() is false', !isSubsettingEnabled());
const disabled = subsetOllamaTools({ tools: fullCluster, taskContext: writeTask });
check('disable flag: full list returned untouched',
  JSON.stringify(disabled.tools) === JSON.stringify(fullCluster));
check('disable flag: not applied + reason disabled', !disabled.applied && disabled.reason === 'disabled');
delete process.env.ARCO_OLLAMA_TOOL_SUBSET;
check('flag unset: subsetting back on by default', isSubsettingEnabled());

// ── cluster tools become core for cluster members ────────────────────────────

const clusterTask = 'Coordinate with the team and report progress.';
const clusterResult = subsetOllamaTools({
  tools: fullCluster,
  taskContext: clusterTask,
  clusterMember: true,
});
// With 4 file/shell core + 6 cluster core = 10 forced (core exceeds the cap
// and is kept anyway) — proving cluster tools are never trimmed for a member.
for (const peerTool of ['peer_list', 'peer_read', 'peer_send']) {
  check(`cluster member: "${peerTool}" promoted to core, never trimmed`,
    clusterResult.kept.includes(peerTool));
}
// A NON-member ranking the same full list does NOT force the cluster tools in.
const nonMember = webResult;
check('non-member: cluster tools are NOT auto-promoted to core',
  !['peer_list', 'peer_read', 'peer_send', 'cluster_plan_read', 'cluster_plan_tick', 'cluster_plan_write']
    .every((n) => nonMember.kept.includes(n)));

// ── the chosen subset is logged (kept/dropped/provenance surfaced) ───────────

check('result carries kept names for the system_notice log', webResult.kept.length > 0);
check('result carries dropped names for the system_notice log', webResult.dropped.length > 0);
check('result carries signal provenance = task-context (stable signal)',
  writeResult.signalSource === 'task-context');
check('empty task context → signalSource none (no signal to rank on)',
  subsetOllamaTools({ tools: fullCluster, taskContext: '   ' }).signalSource === 'none');

// ── env cap override is honored ──────────────────────────────────────────────

process.env.ARCO_OLLAMA_TOOL_CAP = '6';
const tightCap = subsetOllamaTools({ tools: fullCluster, taskContext: writeTask });
check('env cap override honored (cap=6)', tightCap.cap === 6 && tightCap.kept.length <= 6);
delete process.env.ARCO_OLLAMA_TOOL_CAP;

// ── summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`ollama-tool-subset: ${passes}/${passes + fails} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
