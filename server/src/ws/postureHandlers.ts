// §4.1 — posture-based toolsets: the set_tool_posture handler.
//
// SESSION-LOCAL + NON-PERSISTENT by design: we set WorkflowState.toolPosture
// (in-memory only — never meta.json), so a server restart / tab reload returns
// to 'full'. The pick is broadcast (persisted to events.jsonl) for transcript
// review and to keep every observer's pill in sync, and takes effect on the
// NEXT turn (buildToolDefs is rebuilt per messages.create). Native-only: a
// non-Native tab accepts the field but no provider reads it (no-op, no error).

import { WebSocket } from 'ws';
import { isToolPosture, type SetToolPostureMessage } from '@archon/shared';
import type { Session } from '../workflows/types.js';
import { send, broadcastWorkflow } from '../server/broadcast.js';
import { workflows } from '../server/state.js';

export function handleSetToolPosture(ws: WebSocket, _session: Session, msg: SetToolPostureMessage): void {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  if (!isToolPosture(msg.posture)) {
    send(ws, { type: 'error', message: `Invalid tool posture: ${String(msg.posture)}` });
    return;
  }
  // Runtime-only — deliberately NOT written to meta.json.
  wf.toolPosture = msg.posture;
  broadcastWorkflow(msg.workflowId, {
    type: 'tool_posture_set',
    workflowId: msg.workflowId,
    posture: msg.posture,
  });
}
