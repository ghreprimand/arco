import { useAppStore } from '../stores/appStore';

// Track per-workflow streaming message IDs keyed by OrchestratorPhase. Each
// turn can produce up to one streaming message per phase ('planning',
// 'synthesis', 'passthrough'). Module-level on purpose so streaming state
// survives React re-renders within a tab. We prune entries when a workflow
// is removed from the store (via the subscription below) so long-lived
// sessions with many workflow churn don't leak entries forever.
//
// `parentTurnId` is set on the first mid-turn steer split (Phase 4 follow-up)
// and stays set until the turn ends, so every after-half bubble created in
// the same turn shares the same tag. Cleared in primary_turn_ended /
// turn_cancelled.
export type StreamRef = {
  planning: string | null;
  synthesis: string | null;
  passthrough: string | null;
  parentTurnId: string | null;
};
export const streamingMsgs = new Map<string, StreamRef>();

export function getStreamRef(workflowId: string): StreamRef {
  if (!streamingMsgs.has(workflowId)) {
    streamingMsgs.set(workflowId, {
      planning: null,
      synthesis: null,
      passthrough: null,
      parentTurnId: null,
    });
  }
  return streamingMsgs.get(workflowId)!;
}

// Drop entries for workflows that no longer exist in the store. Subscribed
// once at module load — Zustand's subscribe fires on every state change, so
// this is a constant-time check on every store update (cheap).
useAppStore.subscribe((state) => {
  if (streamingMsgs.size === 0) return;
  for (const id of streamingMsgs.keys()) {
    if (!state.jobs[id]) streamingMsgs.delete(id);
  }
});

// Detection fallback for the plan-candidate banner. When the operator
// didn't pre-arm via the PLAN composer button but the assistant reply is
// clearly plan-shaped, still surface the choice banner so the operator
// isn't stranded without an attach button. Conservative match: first
// non-empty line must be an H1 (`# Title`), and the body must contain at
// least 3 markdown checkbox lines (`- [ ]` / `- [x]`). Anything narrower
// rules out long-form regular replies; anything wider would false-positive
// on bulleted lists.
export function looksLikePlan(body: string): boolean {
  const lines = body.split('\n');
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!/^#\s+\S/.test(firstNonEmpty)) return false;
  let checkboxes = 0;
  for (const l of lines) {
    if (/^\s*[-*]\s+\[[ xX]\]\s/.test(l)) {
      checkboxes++;
      if (checkboxes >= 3) return true;
    }
  }
  return false;
}
