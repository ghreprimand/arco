// WORKBENCH_EXPANSION_PLAN.md §B3 — knowledge "distill from session" WS handler.
//
// Split out of workflowHandlers.ts to keep that file under the 2000-line cap.
// Replays the current transcript, then spawns a bounded, READ-ONLY worker that
// PROPOSES a draft article. THE FENCE: the agent only drafts — nothing is
// saved. The draft rides back as `knowledge_distill_proposed` into the wizard,
// where the operator edits and explicitly Saves via POST /api/knowledge (the
// only persist path; no agent reaches it). Mirrors handleDocEditRequest's
// account-resolution + spawn shape.

import { WebSocket } from 'ws';
import { send } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import type { Session } from '../workflows/types.js';
import { replayEvents as replayWorkflowEvents } from '../workflowStore.js';
import { renderTranscript } from '../primitives/exportContext.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { runDistill } from '../knowledge/distill.js';
import type { KnowledgeDistillRequestMessage } from '@arco/shared';

export async function handleKnowledgeDistillRequest(
  ws: WebSocket,
  session: Session,
  msg: KnowledgeDistillRequestMessage,
): Promise<void> {
  void session;
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }

  let transcript = '';
  try {
    const events = await replayWorkflowEvents(cwd, msg.workflowId, 0);
    transcript = renderTranscript(events);
  } catch (err) {
    console.error(`[arco] [${msg.workflowId.slice(0, 8)}] distill transcript replay failed:`, err);
  }
  if (!transcript.trim()) {
    send(ws, { type: 'error', message: 'No transcript yet to distill from — run a turn first.' });
    return;
  }

  const drafterAccount = msg.drafter.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.drafter.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const drafter = drafterAccount
    ? { ...msg.drafter, providerAccountRef: drafterAccount.profile.id, codexHome: drafterAccount.codexHome }
    : msg.drafter;

  const handle = runDistill(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    { drafter, transcript, focus: msg.focus },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] knowledge distill ${handle.distillId} started (drafter=${msg.drafter.provider}:${msg.drafter.model}@${msg.drafter.effort})`);
  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] distill ${handle.distillId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] distill ${handle.distillId} drafted ("${r.title.slice(0, 40)}", ${r.body.length} chars) — awaiting operator Save`);
  }).catch((err) => {
    console.error(`[arco] distill ${handle.distillId} settle error:`, err);
  });
}
