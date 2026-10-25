// M10 (LOCAL_AI_MASTER_PLAN Stage 4 / OLLAMA_HARDENING_PLAN §7) —
// relevant-tool subsetting for the Ollama primary path.
//
// ── Why subset at all ───────────────────────────────────────────────────────
// Archon advertises its ENTIRE tool registry on every /api/chat turn. On
// 7B–30B-class local models a large tool-schema payload degrades tool
// selection (wrong-tool / single-token-stop failures — odysseus #1567) AND
// burns input context (the schemas ride every request). We trim the advertised
// set to a relevant top-K so the schema stays small and selection stays sharp.
//
// ── Why a HEURISTIC (no embeddings) ─────────────────────────────────────────
// Archon's catalog is ~12 tools. Keyword/term-overlap ranking against the
// task context is more than enough; an embedding model + vector index (what
// odysseus's tool_index.py uses) is rejected as overkill for a 12-item set
// (Hardening §1 "Out"). Deterministic, readable, inspectable — the M10
// guardrail.
//
// ── THE load-bearing constraint: prefix-cache stability ─────────────────────
// Ollama's prefix cache keys on request BYTE-stability (M2/M3, load-bearing
// throughout this program — see ollama.ts header). The tool list sits early in
// the request body, so if the advertised subset changes EVERY turn we thrash
// the cache: the daemon re-prefills the whole prompt instead of just the new
// user-turn delta. A naïve "rank by the latest user message every turn" is
// therefore ACTIVELY HARMFUL — it trades a small quality gain for a large
// per-turn prefill cost (exactly the cost this whole program is trying to cut).
//
// The resolution (Hardening §7 "Open question"): rank against a signal that is
// STABLE across turns within a workflow — the task context (system prompt +
// appendSystemPrompt: handoff seed / role hints / task description), NOT the
// volatile last user message. The system block is set at spawn/config time and
// does not change turn-to-turn, so the chosen subset is byte-identical across
// turns and the prefix cache survives. We deliberately do NOT mix the current
// user prompt into the ranking signal: doing so would re-rank every turn and
// invalidate the cache. The cost we pay is that a mid-conversation topic shift
// won't surface a newly-relevant non-core tool until the workflow's system
// context changes — accepted, because the CORE set (Read/Grep/Glob/Bash + the
// cluster tools) already covers the near-universal needs, and the operator can
// always widen via the explicit allowlist or by disabling subsetting.

import type { OllamaToolDefinition } from './ollamaTools.js';

// ── Always-available CORE set (Hardening §7, odysseus ALWAYS_AVAILABLE) ──────
// These are cheap and near-universally needed by a coding agent, so they are
// never trimmed regardless of relevance ranking. Cluster tools join the core
// set when the workflow is a cluster member (they're the substrate the member
// MUST be able to reach every turn) — handled at call time via `clusterCore`,
// not baked into this constant, because a non-cluster workflow never sees them.
export const OLLAMA_CORE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Bash'];

// Cluster peer/plan tools — core ONLY when the workflow is a cluster member.
// A member needs the mailbox + plan reachable on every turn (peer_read fires
// when the system flags pending messages), so they bypass relevance ranking
// the same way the file/shell core does.
const OLLAMA_CLUSTER_CORE: readonly string[] = [
  'peer_list',
  'peer_read',
  'peer_send',
  'cluster_plan_read',
  'cluster_plan_tick',
  'cluster_plan_write',
];

// Total advertised-set cap. Hardening §7 specifies ~8–10; we default to 9 (mid
// of the band) so a full registry (~12 tools) gets meaningfully trimmed while
// leaving room for a few relevant non-core tools on top of the 4-tool core.
// Env-tunable for an operator who wants a tighter/looser cap.
const DEFAULT_CAP = 9;

function resolveCap(): number {
  const env = process.env.ARCHON_OLLAMA_TOOL_CAP;
  if (env) {
    const n = parseInt(env, 10);
    // Floor at the core size: a cap below the core would be meaningless (the
    // core is never trimmed). Ceiling generous — past ~20 the registry is the
    // limit anyway.
    if (Number.isFinite(n) && n >= OLLAMA_CORE_TOOLS.length && n <= 50) return n;
  }
  return DEFAULT_CAP;
}

// Subsetting is ON by default (it only ever NARROWS, and only when the full
// list exceeds the cap). An operator who wants the full kit every turn — e.g.
// debugging tool selection, or running a model big enough not to care — sets
// ARCHON_OLLAMA_TOOL_SUBSET to a falsey value to get the untouched list back.
// Reversibility guardrail: dropping a tool is non-destructive (it's just not
// advertised this turn); the disable flag restores the full set wholesale.
export function isSubsettingEnabled(): boolean {
  const env = process.env.ARCHON_OLLAMA_TOOL_SUBSET;
  if (env === undefined) return true;
  const lc = env.trim().toLowerCase();
  return !(lc === '0' || lc === 'off' || lc === 'false' || lc === 'no');
}

// Tokenize a relevance signal into a lowercased term set. Splits on
// non-alphanumerics so `file_path`, `webfetch`, `read-only` all break into
// usable terms. Single-character tokens are dropped (noise).
function termSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2) out.add(raw);
  }
  return out;
}

// Build the searchable term bag for a tool from its name + description +
// parameter names. The name carries the strongest signal (a task mentioning
// "write" should rank the Write tool), so it's weighted by repetition.
function toolTerms(def: OllamaToolDefinition): Set<string> {
  const parts: string[] = [
    def.function.name,
    def.function.name, // name counted twice — strongest relevance signal
    def.function.description ?? '',
    ...Object.keys(def.function.parameters?.properties ?? {}),
  ];
  return termSet(parts.join(' '));
}

// Relevance score = count of task-context terms that also appear in the tool's
// term bag. Pure term-overlap — readable, deterministic, no embeddings. Ties
// are broken by registry order downstream (stable sort) so the output is fully
// determined by (tool list, signal).
function relevanceScore(def: OllamaToolDefinition, signalTerms: Set<string>): number {
  let score = 0;
  const tt = toolTerms(def);
  for (const term of signalTerms) {
    if (tt.has(term)) score++;
  }
  return score;
}

export interface SubsetResult {
  // The trimmed (or pass-through) tool list to advertise this turn.
  tools: OllamaToolDefinition[];
  // True when subsetting actually narrowed the list (full > cap and enabled).
  // False on pass-through (small list, disabled, or no signal needed).
  applied: boolean;
  // Names kept and dropped — for the visible system_notice log (guardrail:
  // every reduction lands in events.jsonl, inspectable + reversible).
  kept: string[];
  dropped: string[];
  // The signal-stability provenance, surfaced in the log so transcript review
  // can confirm the subset was ranked against the STABLE task context (not the
  // volatile last user message) — the prefix-cache invariant.
  signalSource: 'task-context' | 'none';
  cap: number;
  reason: 'disabled' | 'under-cap' | 'subset';
}

export interface SubsetInput {
  // The full candidate list (already cluster-gated + allowlist-filtered by the
  // caller — subsetting only ever NARROWS what the caller already decided to
  // offer).
  tools: OllamaToolDefinition[];
  // The STABLE per-workflow relevance signal: system prompt + appendSystemPrompt
  // (task description / handoff seed / role hints). NOT the latest user turn —
  // see the prefix-cache rationale in the file header.
  taskContext: string;
  // Whether this workflow is a cluster member (promotes the cluster tools into
  // the core set so they're never trimmed).
  clusterMember?: boolean;
}

// Compute the advertised tool subset for a turn. PURE — no I/O, no clock; the
// output is fully determined by the inputs, which is what makes it both
// testable and prefix-cache-stable (stable inputs → byte-identical tool list →
// cache preserved across turns).
export function subsetOllamaTools(input: SubsetInput): SubsetResult {
  const { tools, taskContext } = input;
  const cap = resolveCap();

  const coreNames = new Set<string>(OLLAMA_CORE_TOOLS);
  if (input.clusterMember) {
    for (const n of OLLAMA_CLUSTER_CORE) coreNames.add(n);
  }

  // Disabled → full list, untouched (reversibility escape hatch).
  if (!isSubsettingEnabled()) {
    return {
      tools,
      applied: false,
      kept: tools.map((t) => t.function.name),
      dropped: [],
      signalSource: 'none',
      cap,
      reason: 'disabled',
    };
  }

  // Under (or at) the cap → nothing to trim; a small list passes through
  // untouched. This also keeps the common reviewer/allowlist case (already a
  // narrow set) byte-identical to pre-M10.
  if (tools.length <= cap) {
    return {
      tools,
      applied: false,
      kept: tools.map((t) => t.function.name),
      dropped: [],
      signalSource: 'none',
      cap,
      reason: 'under-cap',
    };
  }

  // Partition into core (always kept) and rankable remainder.
  const core: OllamaToolDefinition[] = [];
  const rankable: OllamaToolDefinition[] = [];
  for (const t of tools) {
    if (coreNames.has(t.function.name)) core.push(t);
    else rankable.push(t);
  }

  const signalTerms = termSet(taskContext);

  // Rank the remainder by relevance to the STABLE task context. Stable sort:
  // index-tagged so equal scores keep registry order — fully deterministic and
  // (given stable inputs) byte-identical across turns. Higher score first.
  const ranked = rankable
    .map((def, idx) => ({ def, idx, score: relevanceScore(def, signalTerms) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  // Fill up to the cap: core first (never trimmed, even if it alone exceeds the
  // cap — the core is load-bearing), then the highest-scoring remainder.
  const slotsForRanked = Math.max(0, cap - core.length);
  const chosenRanked = ranked.slice(0, slotsForRanked).map((r) => r.def);

  // Emit in REGISTRY order (the order they arrived) so the advertised array is
  // positionally stable regardless of score — appending the variable tail in a
  // jumbled order would itself perturb the request bytes. We rebuild from the
  // original `tools` order, keeping only the chosen names.
  const chosenNames = new Set<string>([
    ...core.map((t) => t.function.name),
    ...chosenRanked.map((t) => t.function.name),
  ]);
  const advertised = tools.filter((t) => chosenNames.has(t.function.name));
  const dropped = tools.filter((t) => !chosenNames.has(t.function.name)).map((t) => t.function.name);

  return {
    tools: advertised,
    applied: dropped.length > 0,
    kept: advertised.map((t) => t.function.name),
    dropped,
    signalSource: taskContext.trim() ? 'task-context' : 'none',
    cap,
    reason: dropped.length > 0 ? 'subset' : 'under-cap',
  };
}
