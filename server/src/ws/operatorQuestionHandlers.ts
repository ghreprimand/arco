import { WebSocket } from 'ws';
import type { OperatorQuestionReplyMessage } from '@arco/shared';
import type { Session } from '../workflows/types.js';
import { workflows } from '../server/state.js';
import { replyToOperatorQuestion } from '../providers/codex-appserver/operatorQuestions.js';
import { handleUserMessage } from './turnEngine.js';
import { broadcastWorkflow } from '../server/broadcast.js';

export async function handleOperatorQuestionReply(ws: WebSocket, session: Session, msg: OperatorQuestionReplyMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  let result: { ok: boolean; error?: string };
  if (!wf || !wf.observers.has(ws) || !session.workflowIds.has(msg.workflowId)) {
    result = { ok: false, error: 'Subscribe to this workflow before answering.' };
  } else {
    result = await replyToOperatorQuestion(msg.workflowId, msg.requestId, msg.answers, async (content, question) => {
      if (wf.primary.provider !== question.provider || wf.primarySessionId !== question.threadId) throw new Error('The workflow has changed providers or sessions.');
      // Same operator-initiated dispatch as the composer: queue a steer while
      // busy, start a normal turn while idle. No autonomous continuation.
      void handleUserMessage(ws, session, msg.workflowId, content, undefined, undefined, wf.busy, 'steer', undefined).catch(() => {
        broadcastWorkflow(msg.workflowId, { type: 'system_notice', workflowId: msg.workflowId, content: 'The question answer could not be dispatched. Send it again from the composer.' });
      });
    });
  }
  // Transport acknowledgement only. Public question state is persisted by the
  // publisher; failed/stale reply attempts do not become transcript events.
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'operator_question_reply_result', workflowId: msg.workflowId, requestId: msg.requestId, ...result }));
}
