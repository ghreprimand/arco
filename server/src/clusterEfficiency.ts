// 2026-06-15 — per-cluster efficiency level: the single source of truth that
// maps a ClusterEfficiencyLevel onto its DETERMINISTIC behavioural bundle.
//
// Problem this solves: clusters fall into over-review loops — members ping
// each other constantly, re-verify already-finished work, and chunk plans
// into tiny single-step assignments. Operators were hand-writing "efficiency
// doctrines" into the cluster plan to fight it. This module codifies that
// doctrine as one operator-set knob with three levels, each a fixed bundle of:
//
//   1. a restraint DOCTRINE injected into every member's system prompt
//      (chunk bigger, trust peers, review only on signal, terse reports),
//   2. a per-turn peer-send BUDGET (shrinks at higher efficiency so a chatty
//      cluster hits a hard backstop, not just advisory text), and
//   3. a mailbox-notice VARIANT (softens the aggressive "re-engage on every
//      inbound" pre-turn notice that is itself a driver of the loop).
//
// `thorough` is the default and a no-op (no doctrine, budget 15, full notice)
// so existing clusters and pre-feature meta.json are byte-identical to before.
//
// Four-question test (CLAUDE.md / docs/PROTOCOL_CLUSTER.md): operator-set level,
// deterministic presets the operator can read here, logged via cluster_state +
// the efficiency-set event, reversible by flipping back to thorough. These are
// STATIC operator-selected strings — explicitly not LLM-mutated instructions.

import {
  CLUSTER_EFFICIENCY_DEFAULT,
  CLUSTER_EFFICIENCY_ADDENDUM_MAX,
  isClusterEfficiencyLevel,
  type ClusterEfficiencyLevel,
} from '@arco/shared';

// Per-turn peer-send budget by level. thorough keeps the historical 15
// (matches the old clusterBudget constant). balanced/lean tighten it so the
// hard cap actually bites on a chatty cluster.
const SEND_BUDGET_BY_LEVEL: Record<ClusterEfficiencyLevel, number> = {
  thorough: 15,
  balanced: 8,
  lean: 4,
};

export function sendBudgetFor(level: ClusterEfficiencyLevel | undefined): number {
  const lvl = level && isClusterEfficiencyLevel(level) ? level : CLUSTER_EFFICIENCY_DEFAULT;
  return SEND_BUDGET_BY_LEVEL[lvl];
}

// Canned doctrine per level. thorough has none (the absence of restraint text
// IS the thorough behaviour). The strings are deliberately imperative and
// short so they read as a system directive, not prose.
const DOCTRINE_BY_LEVEL: Record<ClusterEfficiencyLevel, string | null> = {
  thorough: null,
  balanced: [
    '--- Cluster efficiency: BALANCED ---',
    'Work in substantial chunks — group related tasks into one assignment instead of dispatching them one at a time.',
    "Trust a peer's completed work by default. Re-review it only when the operator asks, or when you hit concrete evidence it is wrong (a failing test, an error, a direct contradiction with your own work).",
    'Skip acknowledgements and progress pings. When you finish assigned work, send ONE concise PASS/FAIL (or DONE/BLOCKED) report to whoever assigned it, then stop. Do not poll peers for status.',
  ].join('\n'),
  lean: [
    '--- Cluster efficiency: LEAN ---',
    'Maximize chunk size — assign whole phases, not single steps.',
    "Do NOT review or verify a peer's work unless the operator explicitly asks for a review. Assume completed work is correct and move on.",
    "Send no acknowledgements, no status pings, no 'still working' updates. Report only once per assignment: a single DONE or BLOCKED line at the end.",
    'Keep peer messages to the minimum needed to unblock work.',
  ].join('\n'),
};

// Build the system-prompt doctrine block for a cluster. Returns undefined when
// there is nothing to inject (thorough + no addendum). The optional addendum
// is appended under the canned doctrine; for thorough, an addendum alone still
// produces a minimal block so operator-typed restraint notes are never
// silently dropped.
export function buildDoctrine(
  level: ClusterEfficiencyLevel | undefined,
  addendum?: string,
): string | undefined {
  const lvl = level && isClusterEfficiencyLevel(level) ? level : CLUSTER_EFFICIENCY_DEFAULT;
  const canned = DOCTRINE_BY_LEVEL[lvl];
  const note = (addendum ?? '').trim().slice(0, CLUSTER_EFFICIENCY_ADDENDUM_MAX);
  if (!canned && note.length === 0) return undefined;
  const parts: string[] = [];
  if (canned) parts.push(canned);
  else parts.push('--- Cluster efficiency ---'); // header so a bare addendum has context
  if (note.length > 0) parts.push(`Operator note: ${note}`);
  return parts.join('\n\n');
}

export type MailboxNoticeVariant = 'full' | 'softened' | 'minimal';

export function mailboxNoticeVariantFor(level: ClusterEfficiencyLevel | undefined): MailboxNoticeVariant {
  const lvl = level && isClusterEfficiencyLevel(level) ? level : CLUSTER_EFFICIENCY_DEFAULT;
  if (lvl === 'lean') return 'minimal';
  if (lvl === 'balanced') return 'softened';
  return 'full';
}

// Build the pre-turn PEER MAILBOX notice for the cluster's level. Centralized
// here (rather than inline in turnEngine) so all three variants live next to
// the doctrine they have to stay consistent with — at lean/balanced the
// doctrine says "don't re-review unless signalled", so the notice must NOT also
// shout "re-engage on every inbound" (that contradiction is the bug we're
// fixing). The 'full' text is byte-identical to the historical notice.
export function buildPeerMailboxNotice(
  level: ClusterEfficiencyLevel | undefined,
  pendingDepth: number,
): string {
  const plural = pendingDepth === 1 ? '' : 's';
  const head = `--- PEER MAILBOX ---\nYou have ${pendingDepth} pending peer message${plural} waiting. `;
  switch (mailboxNoticeVariantFor(level)) {
    case 'minimal':
      return head + 'Read them with the peer_read tool before reporting status.';
    case 'softened':
      return (
        head +
        'Read them with the peer_read tool and act on what they contain. ' +
        'Re-open work you already finished only if a message contains concrete findings that contradict it — otherwise keep moving.'
      );
    case 'full':
    default:
      return (
        head +
        'Read them now with the peer_read tool and act on their contents. ' +
        'If any contain a review, findings, or work assignment that contradicts your current plan or claimed-complete items, ' +
        'un-tick affected plan items, assign follow-ups via peer_send, and re-engage within your role (a director re-engages by delegating, not by doing the peer\'s work). ' +
        'Do NOT report "standing by" or "no work remaining" when findings imply remaining work.'
      );
  }
}
