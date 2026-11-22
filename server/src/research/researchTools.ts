// docs/RESEARCH.md - the research_round tool, shared by Claude Native, the
// cluster MCP server and the local-model tool runtime.

import { RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES, RESEARCH_ROUND_TIMEOUT_MAX_MINUTES } from '@arco/shared';
import type { ResearchRoundResult } from './researchRounds.js';

export const RESEARCH_ROUND_TOOL = {
  name: 'research_round',
  description:
    'Research Director only. Send one research round: Arco sends the identical text to every researcher at once, holds each reply until every researcher has replied, failed, been stopped or timed out, then delivers all replies to you together in one message, labelled Researcher A, B, C, and writes them to rounds/round-N/ in the research folder. Only one round can be open at a time. For a question to a single researcher, use peer_send to "Researcher B" instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The research brief for this round, sent unchanged to every researcher. Say what to answer, the report format and the sources to cite.' },
      timeout_minutes: { type: 'number', description: `Minutes before researchers that have not replied are marked timed out. Default ${RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES}, maximum ${RESEARCH_ROUND_TIMEOUT_MAX_MINUTES}.` },
    },
    required: ['text'],
  },
};

export function formatResearchRoundResult(result: ResearchRoundResult): string {
  if (!result.ok) return `[error] ${result.code}: ${result.message}`;
  return JSON.stringify({
    round: result.round,
    sentTo: result.researchers,
    deadline: result.deadline,
    note: 'Replies are held until every researcher has replied, failed, been stopped or timed out; they then arrive together in your mail. End your turn now; Arco starts your next turn when the round is released.',
  }, null, 2);
}

// A negative number is a catch-up (catchUpKey): the round 1 text, answered alone.
export function researchHeldNote(round: number): string {
  if (round < 0) return 'Received for your catch-up on the round 1 brief. It is delivered to the Research Director on its own.';
  return `Received for round ${round}. It is held until every researcher has replied, then delivered to the Research Director with the others.`;
}
