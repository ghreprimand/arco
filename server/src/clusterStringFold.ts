// Budgeting for the string-form cluster fold (CLI Claude / Codex /
// Cursor members reach the model via an appendSystemPrompt-style prefix, not
// forced system blocks — see turnEngine's needsStringFormCluster).
//
// 2026-07-09 incident (docs/CODEX_GPT56_CLUSTER_INCOMPAT.md §10): the first
// live gpt-5.6 cluster member got an 18 KB shared plan folded FIRST into the
// combined block, and the old tail-slicing 16 KB cap silently chopped
// everything behind it — the peer-mailbox notice, the role hint, the
// code-mode addendum, and the efficiency doctrine. The member then acted as
// OpenAI's /root (native list_agents, plan-item freelancing) instead of
// reading its mailbox. The plan is the only unbounded block in the fold, so
// it alone absorbs the cap: small blocks are reserved first and the plan is
// truncated to the remaining budget, never the other way around. A truncated
// plan is recoverable by the model via the cluster_plan_* tools; a missing
// role/addendum/notice is not recoverable at all.

export const APPEND_CLUSTER_MAX = 16 * 1024;

// app-server transports use JSON-RPC over stdin, so they do not share the
// CLI argv ceiling that motivated APPEND_CLUSTER_MAX. Keep a separate bound
// above PLAN_MAX_BYTES plus the small role/doctrine blocks. This lets the
// complete maximum-size plan through without making the input unbounded.
export const CODEX_APP_SERVER_CLUSTER_MAX = 48 * 1024;

const PLAN_TRUNCATION_MARKER =
  '\n\n[... shared plan truncated to fit the cluster appendSystemPrompt cap — call cluster_plan_read for the full plan]';

export interface ClusterFoldResult {
  /** Joined block ready to prepend to finalAppend; undefined when nothing to fold. */
  combined: string | undefined;
  /** Original plan-block byte length when the plan didn't fit; undefined otherwise. */
  planTruncatedFrom?: number;
  /** True when the outline fallback was substituted for the full plan. */
  usedFallback?: boolean;
}

/**
 * Join the cluster blocks with the plan first (matching Native's
 * buildSystemBlocks ordering) while guaranteeing every tail block survives
 * verbatim. `reservedBytes` is the length of content already sitting in
 * finalAppend (peer-mailbox notice, operator append) — it folded earlier and
 * would otherwise be re-exposed to the tail slice. When the full plan
 * overflows the budget, `planFallback` (a deterministic outline — see
 * clusterPlanOutline.ts) is substituted first; only if even that overflows
 * does head-truncation kick in.
 */
export function composeClusterAppend(
  planBlock: string | undefined,
  tailBlocks: string[],
  reservedBytes = 0,
  cap: number = APPEND_CLUSTER_MAX,
  planFallback?: string,
): ClusterFoldResult {
  const tail = tailBlocks.filter((b) => b.length > 0);
  let plan = planBlock && planBlock.length > 0 ? planBlock : undefined;
  let planTruncatedFrom: number | undefined;
  let usedFallback: boolean | undefined;
  if (plan) {
    // Each join costs the 2-byte '\n\n'; reserved content joins once more.
    const tailLen = tail.reduce((n, b) => n + b.length + 2, 0);
    const budget = cap - tailLen - (reservedBytes > 0 ? reservedBytes + 2 : 0);
    if (plan.length > budget) {
      planTruncatedFrom = plan.length;
      if (planFallback && planFallback.length > 0 && planFallback.length <= budget) {
        plan = planFallback;
        usedFallback = true;
      } else {
        // Truncate the denser of the two — the fallback when present.
        const base = planFallback && planFallback.length > 0 ? planFallback : plan;
        usedFallback = base !== planBlock ? true : undefined;
        plan =
          base.slice(0, Math.max(0, budget - PLAN_TRUNCATION_MARKER.length)) +
          PLAN_TRUNCATION_MARKER;
      }
    }
  }
  const blocks = plan ? [plan, ...tail] : tail;
  if (blocks.length === 0) return { combined: undefined };
  return { combined: blocks.join('\n\n'), planTruncatedFrom, usedFallback };
}
