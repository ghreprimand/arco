// docs/PROTOCOL_CLUSTER.md "Gemini members". Whether each workflow's current
// turn was started by the operator's own action (NUDGE or a typed message
// from the operator's client) or by something automatic (AUTO-PICKUP, Smart
// pickup, reminders, dispatch, timers, retries). The mailbox drain uses it:
// mail sent by a Gemini member is delivered only in an operator-started
// turn. handleUserMessage (ws/turnEngine.ts) records the origin when a turn
// starts; a turn that continues with queued operator input becomes
// operator-started.

const operatorTurns = new Set<string>();

export function setTurnOrigin(workflowId: string, operatorAction: boolean): void {
  if (operatorAction) operatorTurns.add(workflowId);
  else operatorTurns.delete(workflowId);
}

export function isOperatorStartedTurn(workflowId: string): boolean {
  return operatorTurns.has(workflowId);
}
