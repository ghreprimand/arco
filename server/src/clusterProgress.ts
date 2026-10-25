// 2026-06-29 — per-cluster progress-tracking doctrine: the single source of
// truth that maps a ClusterProgressMode onto the standing instruction telling
// members to keep the plan and/or the board CURRENT as work advances.
//
// Problem this solves: the shared cluster plan was injected as inert read-only
// context ("here's what we're doing"), while the task board carried all the
// action-shaped tools (claim / update / complete / sign-off). Directors
// naturally worked the board and let the plan's `- [ ]` / `- [x]` state drift —
// even when the operator's role hint literally said "keep plan current". The
// plan needs a STANDING DIRECTIVE, not just availability of cluster_plan_tick.
//
// This module codifies that directive as one operator-set knob:
//   plan  → only the plan-upkeep clause
//   board → only the board-upkeep clause
//   both  → both clauses + a reconciliation line (default)
//
// Each clause is gated on whether the surface actually exists for the cluster
// (hasPlan / hasBoard), so a 'both' cluster with no plan never gets dangling
// plan instructions, and a cluster with no board never gets board instructions.
//
// Unlike clusterEfficiency's 'thorough' default (a deliberate no-op so
// pre-feature meta.json is byte-identical), the 'both' default here is
// INTENTIONALLY non-empty: existing clusters with a plan SHOULD start getting
// the upkeep nudge — that is the fix. The text is deterministic + reversible
// (flip the chip), satisfying the §2 four-question test.

import {
  CLUSTER_PROGRESS_DEFAULT,
  isClusterProgressMode,
  type ClusterProgressMode,
} from '@archon/shared';

// Imperative, short clauses so they read as a system directive, not prose.
const PLAN_CLAUSE = [
  'The shared cluster plan holds standing rules and tasks only; keep its checkboxes current as you work.',
  'When you finish a plan checkbox item, flip it with cluster_plan_tick in the same turn (match by the item text).',
  'The director owns plan upkeep — do not let the plan\'s [ ]/[x] state fall behind the real state of the work.',
  'Never write progress, evidence, commit hashes, CI ids, test counts, or dated status notes into the plan body; those belong on board tasks or in artifacts.',
].join(' ');

const BOARD_CLAUSE = [
  'Keep the task board current.',
  'Move each task through its statuses (todo → in_progress → review) as the work actually progresses, and report completion so the operator can mark it done (done/archived stay operator-only).',
  'Do not leave finished work sitting in an earlier status.',
].join(' ');

const RECONCILE_CLAUSE =
  'The plan and the board track the same work at different granularities — keep BOTH reflecting reality. ' +
  'When you complete a board task that corresponds to a plan item, tick the plan item too.';

// Build the system-prompt doctrine block for a cluster. Returns undefined when
// there is nothing to inject (e.g. mode 'plan' but no plan attached, or mode
// 'board' but no board) so the caller can skip the block entirely.
export function buildProgressDoctrine(
  mode: ClusterProgressMode | undefined,
  hasPlan: boolean,
  hasBoard: boolean,
): string | undefined {
  const m = mode && isClusterProgressMode(mode) ? mode : CLUSTER_PROGRESS_DEFAULT;
  const wantsPlan = (m === 'plan' || m === 'both') && hasPlan;
  const wantsBoard = (m === 'board' || m === 'both') && hasBoard;
  if (!wantsPlan && !wantsBoard) return undefined;
  const parts: string[] = ['--- Cluster progress tracking ---'];
  if (wantsPlan) parts.push(PLAN_CLAUSE);
  if (wantsBoard) parts.push(BOARD_CLAUSE);
  // Only worth the reconciliation line when BOTH surfaces are live.
  if (wantsPlan && wantsBoard) parts.push(RECONCILE_CLAUSE);
  return parts.join('\n');
}
