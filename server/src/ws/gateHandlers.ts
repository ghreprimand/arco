// DEBAG — Durable Edit-Before-Approve Gate: restart survival (docs/DEBAG_PLAN.md §4).
//
// Two server-side pieces that only matter ACROSS a server restart:
//
//  1. rehydrateGatesOnce — on the first rehydrate per workflow per server
//     lifetime, re-emit `gate_required` for every UNRESOLVED gate in the
//     sidecar so the approval card reappears even when the client's event-replay
//     cursor already sat past the original gate_required. The synthetic
//     `gate::<id>` message dedupes on the client, so a double-delivery (replay +
//     rehydrate) is harmless. Set-guarded, mirroring clusterRehydrate.
//
//  2. resolveOrphanedGate — the genuinely novel piece (§4.5). A gate that
//     survived a restart cannot resume the dead in-process tool-loop: the
//     Promise it parked on is gone. So when a gate_reply finds no live parked
//     gate, we fall back to the durable sidecar and feed the approved action as
//     the operator's NEXT-TURN input — an honest re-issue, not a seamless
//     continuation. Reject just clears + records. This is operator-initiated
//     (the approve click), deterministic, logged, and reversible → within the
//     fence. The discontinuity is documented in docs/GOTCHAS.md.

import type { WebSocket } from 'ws';
import type { Session } from '../workflows/types.js';
import { workflows } from '../server/state.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { handleUserMessage } from './turnEngine.js';
import { readGateStore, clearPendingGate, removeStandingApproval, type PendingGateRecord } from '../providers/claude-native/gateStore.js';
import type { GateCategory } from '@arco/shared';

const rehydratedGates = new Set<string>();

// Test-only — drop the memo so a fresh rehydrate re-emits.
export function _resetForTesting(): void {
  rehydratedGates.clear();
}

// Emit the current standing-approval set for a workflow (snapshot). Shared by
// rehydrate and the revoke handler so the CONFIG list stays in sync.
async function broadcastStanding(workflowId: string, cwd: string): Promise<void> {
  const store = await readGateStore(cwd, workflowId).catch(() => null);
  broadcastWorkflow(workflowId, {
    type: 'gate_standing',
    workflowId,
    approvals: (store?.standing ?? []).map((s) => ({
      signature: s.signature,
      toolName: s.toolName,
      approvedAt: s.approvedAt,
      sample: s.sample,
    })),
  });
}

export async function rehydrateGatesOnce(workflowId: string, cwd: string): Promise<void> {
  if (!cwd) return;
  if (rehydratedGates.has(workflowId)) return;
  rehydratedGates.add(workflowId);
  const store = await readGateStore(cwd, workflowId).catch(() => null);
  // Always re-emit the standing-approval list so the CONFIG list rehydrates,
  // even when no gate is currently pending.
  await broadcastStanding(workflowId, cwd);
  if (!store || store.pending.length === 0) return;
  for (const g of store.pending) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] re-surfacing pending review gate ${g.gateId.slice(0, 8)} after restart`);
    broadcastWorkflow(workflowId, {
      type: 'gate_required',
      workflowId,
      gateId: g.gateId,
      toolUseId: g.gateId,
      toolName: g.toolName,
      category: g.category as GateCategory,
      reason: g.reason,
      proposedArgs: g.proposedArgs,
      signature: g.signature,
      createdAt: g.createdAt,
    });
  }
}

// Render the approved call for the synthetic re-issue prompt: a Bash command
// shows its command line; any other tool shows pretty JSON of its input.
function renderCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof args.command === 'string') return args.command;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// Restart-resume. Returns true if it handled a sidecar-pending (orphaned) gate,
// false if there was nothing pending (a truly stale reply — caller logs a drop).
export async function resolveOrphanedGate(
  ws: WebSocket,
  session: Session,
  workflowId: string,
  gateId: string,
  decision: 'approve' | 'reject',
  finalArgs: Record<string, unknown> | undefined,
): Promise<boolean> {
  const wf = workflows.get(workflowId);
  const cwd = wf?.config.workingDirectory;
  if (!cwd) return false;
  const record = await clearPendingGate(cwd, workflowId, gateId).catch(() => null);
  if (!record) return false;

  const wasEdited = !!finalArgs;
  broadcastWorkflow(workflowId, {
    type: 'gate_resolved',
    workflowId,
    gateId,
    toolUseId: gateId,
    toolName: record.toolName,
    decision,
    wasEdited,
    ...(wasEdited ? { finalArgs } : {}),
    liveArgsAtFire: record.proposedArgs,
    createdAt: Date.now(),
  });

  if (decision === 'reject') {
    broadcastWorkflow(workflowId, {
      type: 'system_notice',
      workflowId,
      content: `[review gate] Rejected a ${record.toolName} call that was pending across a restart. It was not run.`,
    });
    return true;
  }

  // Approve — feed the approved action as the next-turn input (§4.5). The model
  // re-issues it; if review safe-mode is still armed the re-issued call will gate
  // again LIVE (a fresh park resolved normally), which is the documented cost of
  // a restart-orphaned approval, not a loop.
  const effective = (wasEdited ? finalArgs : record.proposedArgs) as Record<string, unknown>;
  const prompt =
    `[review gate approved after restart] You proposed a ${record.toolName} call that was paused for ` +
    `operator review across a server restart, so it could not resume inline. The operator APPROVED it` +
    `${wasEdited ? ' (with edits)' : ''}. Re-issue exactly this call now:\n\n` +
    `${renderCall(record.toolName, effective)}`;
  await handleUserMessage(ws, session, workflowId, prompt, undefined, undefined, false, undefined, undefined).catch((err) => {
    console.error(`[arco] [${workflowId.slice(0, 8)}] orphaned-gate re-issue failed:`, err);
  });
  return true;
}

// DEBAG sub-phase 5 — revoke a standing approval, then re-broadcast the list.
export async function handleGateRevoke(workflowId: string, signature: string): Promise<void> {
  const wf = workflows.get(workflowId);
  const cwd = wf?.config.workingDirectory;
  if (!cwd) return;
  const removed = await removeStandingApproval(cwd, workflowId, signature).catch(() => false);
  if (removed) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] revoked standing review approval ${signature.slice(0, 8)}`);
    await broadcastStanding(workflowId, cwd);
  }
}

export type { PendingGateRecord };
