// Structured clarification questions. Approval requests use their own surface.
export interface OperatorQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  allowOther: boolean;
  secret: boolean;
}
export interface OperatorQuestionState {
  requestId: string;
  provider: 'codex';
  threadId: string;
  turnId: string;
  itemId: string;
  mode: 'blocking' | 'async';
  questions: OperatorQuestion[];
  status: 'pending' | 'answered' | 'cancelled';
  createdAt: number;
  answers?: Record<string, string[]>; // Secret answers are redacted before broadcast.
  reason?: string;
}
export interface OperatorQuestionMessage {
  type: 'operator_question';
  workflowId: string;
  question: OperatorQuestionState;
}
export interface OperatorQuestionReplyMessage {
  type: 'operator_question_reply';
  workflowId: string;
  requestId: string;
  answers: Record<string, string[]>;
}
export interface OperatorQuestionReplyResultMessage {
  type: 'operator_question_reply_result';
  workflowId: string;
  requestId: string;
  ok: boolean;
  error?: string;
}
