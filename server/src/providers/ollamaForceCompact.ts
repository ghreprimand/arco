// WP3 — operator-armed one-shot "force compaction on next turn" flag for Ollama.
//
// WHY A MODULE-LEVEL REGISTRY (not WorkerConfig / not a callback):
// The manual COMPACT button can't compact Ollama immediately. Ollama's worker
// is STATELESS per turn — `run()` rebuilds the whole transcript from the
// replayed `appendSystemPrompt` every operator turn; there is no long-lived
// in-memory message array to summarize-and-replace between turns the way Claude
// Native's resident worker has. So the cleanest correct semantics is: arm a
// one-shot flag now, and have the NEXT turn's `maybeCompact` honor it (bypassing
// the fill-threshold gate) at the front of `run()`.
//
// The arming site (compactHandlers.ts) lives server-side; the consuming site
// (ollama.ts maybeCompact) lives provider-side. Threading the flag through
// WorkerConfig would mean editing turnEngine's dispatch (owned by another WP),
// and providers deliberately don't import server workflow state. This tiny
// keyed-by-workflowId registry bridges the two without either of those
// couplings: set on arm, read-and-clear on the next compaction check.
//
// Four-question test: operator-initiated (button), deterministic (one-shot,
// cleared on consume), visible (the handler emits a system_notice + the worker
// emits the existing ollama_compacted / nothing-to-compact notice to
// events.jsonl), reversible (the original transcript is reconstructable from
// prior turns' events, exactly like auto-compaction).

const forced = new Set<string>();

// Arm: the next interactive Ollama turn for this workflow will compact
// regardless of the fill threshold. Idempotent.
export function armOllamaForceCompact(workflowId: string): void {
  forced.add(workflowId);
}

// Consume: returns true at most once per arm, then clears the flag. Called at
// the front of the worker's compaction check.
export function consumeOllamaForceCompact(workflowId: string): boolean {
  return forced.delete(workflowId);
}
