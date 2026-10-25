// DD7 — project-trust: the set_project_trust handler.
//
// Records the operator's decision in ~/.archon/trust.json keyed by the canonical
// cwd, so future turns (and cluster peers sharing the cwd) honor it without
// re-prompting. The decision takes effect on the NEXT turn — the trust gate is
// re-resolved per turn in handleUserMessage. PERSISTED to disk (trust.json) AND
// broadcast to events.jsonl (the four-question test's visibility leg). Reversible:
// the operator can flip the decision later or delete the entry by hand.

import { WebSocket } from 'ws';
import type { SetProjectTrustMessage } from '@archon/shared';
import type { Session } from '../workflows/types.js';
import { send, broadcastWorkflow } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import * as projectTrust from '../projectTrust.js';

export async function handleSetProjectTrust(
  ws: WebSocket,
  _session: Session,
  msg: SetProjectTrustMessage,
): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  if (msg.decision !== 'always' && msg.decision !== 'never') {
    send(ws, { type: 'error', message: `Invalid trust decision: ${String(msg.decision)}` });
    return;
  }
  const cwd = msg.cwd || wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'No working directory to record trust for.' });
    return;
  }
  try {
    const key = await projectTrust.writeTrustDecision(cwd, msg.decision, Date.now());
    // Dismiss the pending prompt for this cwd (and any cluster peer's) — a
    // decision is recorded, so no member should re-raise it.
    projectTrust.clearPromptPending(cwd);
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] project trust recorded: ${msg.decision} for ${key}`);
  } catch (err) {
    send(ws, {
      type: 'error',
      message: `Failed to record project trust: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  broadcastWorkflow(msg.workflowId, {
    type: 'project_trust_set',
    workflowId: msg.workflowId,
    cwd,
    decision: msg.decision,
  });
}
