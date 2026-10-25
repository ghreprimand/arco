// ── Chat row types ──

import type { OperatorQuestionState } from './operatorQuestions.js';
import type { PrimaryPhase } from './providers.js';

export interface ChatMessage {
  id: string;
  // CLUSTER_MODE_PLAN.md Phase 2 — peer-sent / peer-received are synthetic
  // role variants the cluster code injects when the WS dispatcher sees a
  // peer_message_sent / peer_message_received event. They render as colored
  // blocks in ChatPanel (color hashed from senderWorkflowId) and never
  // round-trip to the server. Persisted in localStorage like every other
  // chat row, so a reload preserves the visual peer-message timeline.
  role: 'user' | 'assistant' | 'system' | 'peer-sent' | 'peer-received' | 'ctx-divider';
  content: string;
  operatorQuestion?: OperatorQuestionState;
  operatorQuestionError?: string;
  isStreaming: boolean;
  // Phase 2 — sender identity for peer-* rows. `senderWorkflowId` is hashed
  // by the renderer to pick a stable color per sender. `senderDisplayName`
  // is the cluster's display-name policy result (8-char wfid prefix today).
  senderWorkflowId?: string;
  senderDisplayName?: string;
  // For peer-sent rows: the recipient's full workflowId so the chat renderer
  // can look up the recipient's current displayName + role from the cluster
  // store. Without this, peer-sent rows can only show the wfid prefix as the
  // "sent to" label.
  targetWorkflowId?: string;
  workerId?: string;
  phase?: PrimaryPhase;
  attachments?: string[];
  timestamp: number;
  // Operator sent this mid-turn and it's waiting in the server's interjection
  // queue. Cleared when the matching entry appears in sessionChat (Claude
  // has actually processed it). Rendered with a `[QUEUED]` pill.
  queued?: boolean;
  // Phase 4 — operator's intent for a queued message. 'steer' is "do this
  // now / change direction"; 'follow-up' is "after the current task lands."
  // Drives the queue-strip pill label. Phases 5–7 wire real mid-turn
  // delivery for steer per provider; Phase 4 ships visible/rebindable only.
  // Absent on non-queued chat rows.
  queueKind?: 'steer' | 'follow-up' | 'interrupt';
  // When set, this row renders as a compact tool-call pill instead of a chat
  // bubble. Sourced from Claude session JSONL tool_use blocks so the operator
  // sees what the agent did between text turns (and can click through to any
  // file the tool touched). `content` stays empty for pill rows.
  toolUse?: {
    tool: string;
    input: unknown;
    filePath?: string;
    toolUseId: string;
  };
  // Render-layer marker tying together the assistant chat messages produced
  // by one underlying turn whose visible output got split by a mid-turn steer.
  // Set on the "before" half (finalized at split time) and the "after" half
  // (new streaming bubble for incoming deltas) so future logic that needs
  // "all chat messages from one assistant turn" can reconstitute them.
  // Client-only: server never reads this. Absent on un-split bubbles.
  parentTurnId?: string;
}
