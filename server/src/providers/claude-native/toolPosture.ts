// §4.1 — posture-based toolsets: the single source of truth mapping a
// ToolPosture onto its DETERMINISTIC tool-keep bundle, plus the filter the
// Native worker applies to buildToolDefs(). Mirrors clusterEfficiency.ts —
// one operator knob, fixed readable presets, reversible.
//
// Why: every advertised tool costs input tokens (its JSON schema) AND attention
// (the model weighs all of them every turn). A chat or review tab doesn't need
// Write/Edit/Bash/Task/web; a coding tab rarely needs web research. Filtering
// the union to a posture cuts both.
//
// 'full' is the default and a no-op (keeps everything) so existing tabs are
// byte-identical. The other postures keep a curated CORE set; tools OUTSIDE the
// known universe (operator-opted-in dynamic tools — MCP registry `mcp__*`,
// cluster `peer_*`, sandbox `ctx_*`) ALWAYS pass through: the operator added
// them explicitly, a posture shouldn't silently strip them.
//
// Three merged deltas live here:
//   (1) scrubCrossRefs — after filtering, drop "X is still available" clauses in
//       remaining tool descriptions that name a now-removed tool (live target:
//       sandboxTools.ts's "Read / Bash still available" note).
//   (2) non-empty guard — if a bundle would empty the set, fall back to full +
//       log (a filtered-to-nothing toolset would brick the turn).
//   (3) cache note — the filtered tools[] is part of the cached request prefix,
//       so flipping posture re-breaks that breakpoint once (then re-warms).

import { TOOL_POSTURE_DEFAULT, type ToolPosture } from '@arco/shared';

// The core Native tool universe this filter knows about. A name here that a
// bundle omits is genuinely DROPPED; a name NOT here is a dynamic opt-in and
// passes through. web_search/web_fetch/code_execution are the Anthropic server
// tools (kept only in 'full').
const KNOWN_CORE = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'TaskOutput',
  'TodoWrite', 'KillShell', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
]);
const KNOWN_SERVER = new Set(['web_search', 'web_fetch', 'code_execution']);

// Keep-sets per posture. null ⇒ keep everything (full). Each set lists the
// KNOWN tool names retained; anything in KNOWN_* but absent is dropped.
const BUNDLE: Record<ToolPosture, Set<string> | null> = {
  full: null,
  // Coding: the full local toolset minus web research noise.
  coding: new Set([
    'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'TaskOutput',
    'TodoWrite', 'KillShell', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  ]),
  // Review: read + inspect + run (tests/git), no mutation, no fan-out, no web.
  review: new Set(['Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'AskUserQuestion']),
  // Chat: conversational + light lookup only — no mutation, no shell, no web.
  chat: new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'AskUserQuestion']),
};

// Decide whether a tool name survives a posture. Dynamic opt-in tools (not in
// the known universe) always survive.
export function keepTool(name: string, posture: ToolPosture): boolean {
  const keep = BUNDLE[posture];
  if (keep === null) return true; // full
  if (KNOWN_CORE.has(name) || KNOWN_SERVER.has(name)) return keep.has(name);
  return true; // dynamic opt-in (mcp__*/peer_*/ctx_*) — never stripped by posture
}

// Minimal tool-def shape we touch: a name and an optional description. The real
// ClaudeNativeToolDef is wider; we operate structurally so server tools (which
// have a `name` but a different shape) filter too.
interface MinimalToolDef { name: string; description?: string }

export interface PostureFilterResult<T> {
  tools: T[];
  posture: ToolPosture;
  // names dropped by the bundle (for the log / smoke).
  removed: string[];
  // true when the non-empty guard kicked in and we fell back to full.
  fellBackToFull: boolean;
}

// Filter a tool-def array by posture, applying all three deltas. Pure; the
// worker calls this in buildToolDefs and logs the result.
export function filterToolDefsByPosture<T extends MinimalToolDef>(
  defs: T[],
  posture: ToolPosture | undefined,
): PostureFilterResult<T> {
  const p = posture ?? TOOL_POSTURE_DEFAULT;
  if (p === 'full' || BUNDLE[p] == null) {
    return { tools: defs, posture: 'full', removed: [], fellBackToFull: p !== 'full' };
  }
  const kept: T[] = [];
  const removed: string[] = [];
  for (const d of defs) {
    if (keepTool(d.name, p)) kept.push(d);
    else removed.push(d.name);
  }
  // Delta 2 — never advertise an empty toolset; that would brick the turn.
  if (kept.length === 0) {
    return { tools: defs, posture: p, removed: [], fellBackToFull: true };
  }
  // Delta 1 — scrub dangling cross-refs to removed tools in survivors.
  const removedSet = new Set(removed);
  const scrubbed = removedSet.size > 0
    ? kept.map((d) => scrubDef(d, removedSet))
    : kept;
  return { tools: scrubbed, posture: p, removed, fellBackToFull: false };
}

// Drop "still/also/remain available" clauses in a tool description that name a
// now-removed tool, so a filtered tab never reads a false "X is still available".
// Returns the same object when nothing changes (cheap identity for the common case).
function scrubDef<T extends MinimalToolDef>(def: T, removed: Set<string>): T {
  if (!def.description) return def;
  const next = scrubCrossRefs(def.description, removed);
  if (next === def.description) return def;
  return { ...def, description: next };
}

// Exported for the smoke. Splits description into sentence-ish spans and drops
// any span that BOTH makes an availability claim AND names a removed tool.
export function scrubCrossRefs(description: string, removed: Set<string>): string {
  if (removed.size === 0) return description;
  // Split on sentence terminators while keeping the delimiter attached. The
  // sandbox clause uses an em-dash mid-sentence, so we split on . ! ? only.
  const spans = description.split(/(?<=[.!?])\s+/);
  const availability = /\b(still|also|remain\w*)\s+available\b/i;
  const kept = spans.filter((span) => {
    if (!availability.test(span)) return true;
    for (const name of removed) {
      // word-boundary match so "Read"/"Write" as verbs in OTHER sentences are
      // untouched (we only scrub the availability-claim span itself).
      if (new RegExp(`\\b${escapeRe(name)}\\b`).test(span)) return false;
    }
    return true;
  });
  return kept.join(' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
