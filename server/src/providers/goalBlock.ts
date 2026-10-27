// docs/GOTCHAS.md - operator-set persistent north-star block.
//
// Returns a small block of provider prompt text pinned into the stable
// per-turn prefix on every turn: a durable operator-set objective ("what is
// this whole session ultimately in service of"). Mirrors outputStyle.ts's
// shape exactly — a single pure helper, null-when-empty so the default path
// pays ZERO extra input tokens.
//
// The feature deliberately adopts only the *steering* half of Codex/Claude
// "goal mode": it carries ZERO model authority. It is context, not a
// controller — it never loops, never grades work, never spawns anything. The
// trailing sentence below is load-bearing: it forecloses the model reading a
// north-star as license to self-drive (the exact operator-absent-orchestration
// failure the feature is designed around). Do not soften it.
//
// Injected by every transport that already folds `clusterPlan`: Claude Native
// (buildSystemBlocks, immediately after FORCED_FIRST_BLOCK and before the
// cluster plan), CLI Claude / both Codex / Z.ai native (appendSystemPrompt
// fold), Ollama/llama.cpp (buildLocalClusterSystemPrompt). Operator-only to
// write, model read-only — there is NO model tool that mutates it.

// Hard cap on the stored north-star. Deliberately ~16× smaller than the 32 KB
// cluster plan cap — a north-star is a sentence or two, not a plan. The server
// trims to this on write; the client surfaces the soft-warn threshold.
export const GOAL_MAX_BYTES = 2048;
export const GOAL_SOFT_WARN_BYTES = 1536;

// Trim + byte-cap the operator's raw input to GOAL_MAX_BYTES for storage.
// Returns '' for blank input (the caller treats '' as a clear). Cuts on a
// UTF-8 boundary so a multibyte char is never split; the trailing partial /
// replacement char is dropped.
export function capGoal(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (Buffer.byteLength(t, 'utf8') <= GOAL_MAX_BYTES) return t;
  return Buffer.from(t, 'utf8')
    .subarray(0, GOAL_MAX_BYTES)
    .toString('utf8')
    .replace(/�+$/, '')
    .trimEnd();
}

// Returns the north-star block for the given objective, or null when unset /
// blank (status quo — no block, no extra input tokens, byte-identical to
// pre-feature behavior).
export function goalBlock(goal: string | undefined): string | null {
  const g = goal?.trim();
  if (!g) return null;
  return (
    `--- Session north-star (operator-set objective) ---\n${g}\n` +
    `Hold this as the standing objective for the session. It is context, not an instruction to ` +
    `act autonomously: keep doing normal operator-directed turns; let this steer priorities and ` +
    `"what does done look like", not trigger unrequested work.`
  );
}
