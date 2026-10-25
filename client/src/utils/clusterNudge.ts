// Phrase the nudge as INTENT ("read your pending peer mail"), not as the
// mechanical "Call the `peer_read` tool…". Incident: the server already
// injects a pre-turn PEER MAILBOX notice (turnEngine.ts) that says "Call
// the `peer_read` tool to drain"; when the nudge prompt repeated that exact
// backtick-wrapped imperative, the model occasionally PARROTED it back as
// literal text (`<invoke name="peer_read">` rendered under ARCHON ::
// PASSTHROUGH) instead of issuing a real tool_use — so the mailbox never
// drained and the nudge had to be re-fired. The mechanism lives in the
// server notice + the model's own tool list; the operator nudge only needs
// to supply the behavioral directive.
export const NUDGE_PROMPT =
  '(nudge) You have peer mail waiting — read your pending peer messages and act on whatever they contain. ' +
  'If a message includes a review, findings, or work assignment that contradicts your current plan or claimed-complete state, ' +
  'un-tick affected plan items, assign follow-ups via peer_send, and re-engage on the work within your role (a director delegates rather than doing the peer\'s work). ' +
  'Do NOT report "standing by" when findings imply remaining work.';

export const ACTIVE_NUDGE_PROMPT =
  '(nudge) You are currently working. When you reach a convenient point in your current work, ' +
  'check your mailbox for pending peer messages and address them within your role, then continue with your assignment.';
