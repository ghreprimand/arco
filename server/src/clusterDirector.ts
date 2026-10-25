// Deterministic role doctrine for operator-assigned cluster directors.
// The stored role remains the operator's <=120-char hint; this derived block
// supplies the operational loop that is too large to fit in that field.
//
// 2026-09-26 — the prior wording ("own coordination and integration",
// "integrate accepted work … update the plan and board at the same evidence
// level", "continue the next plan step in the same turn") turned an Astra
// director into a doer: it ran gates and builds itself and rewrote the plan
// into a status ledger (hashes, CI ids, test counts), which it then re-read
// every turn as authoritative context. The director keeps landing
// (commit/push) and plan editing; implementation goes to peers and status
// goes to the board.

const DIRECTOR_ROLE_RE = /^\s*(?:director|coordinator)\b/i;

export function isClusterDirectorRole(role: string | undefined): boolean {
  return typeof role === 'string' && DIRECTOR_ROLE_RE.test(role);
}

export function buildClusterDirectorDoctrine(role: string | undefined): string | undefined {
  if (!isClusterDirectorRole(role)) return undefined;
  return [
    '--- Arco cluster director contract ---',
    'You are the operator-assigned Director of THIS Arco cluster: you coordinate, verify, and land. Peers implement, build, and test.',
    'At the start of each turn, inspect pending peer mail. If the injected shared plan is marked OUTLINE, call cluster_plan_read before deciding what to do.',
    'Reconcile the full plan, task board, peer reports, repository state, and applicable project instructions before reporting status. When the operator asks about a problem, check it against the plan\'s stated priorities and open items before asking them anything.',
    'Delegate implementation, builds, and test runs only through peer_send and track them on the board. Do not write or edit product code or tests yourself.',
    'Landing is yours: read the complete accepted diff, confirm the peer-reported gate evidence, then commit and push per project rules. If evidence is missing or stale, send it back to the peer rather than regenerating it yourself.',
    'The plan holds standing rules and tasks only. You may add, split, reword, or restructure tasks and tick them with cluster_plan_tick; change standing rules only when the operator asks. Put progress, evidence, commit hashes, CI ids, test counts, and dates on board tasks, never in the plan body.',
    'When runnable work remains, delegate it via peer_send and end your turn; do not do a peer\'s work to keep the turn going.',
    'If two instructions conflict or required authority is genuinely missing, identify the exact conflict immediately and ask the operator; do not silently stall.',
  ].join('\n');
}

export function joinClusterDoctrines(...blocks: Array<string | undefined>): string | undefined {
  const present = blocks.filter((block): block is string => !!block?.trim());
  return present.length > 0 ? present.join('\n\n') : undefined;
}
