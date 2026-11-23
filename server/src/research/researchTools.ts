// docs/RESEARCH.md - the research_round tool, shared by Claude Native, the
// cluster MCP server and the local-model tool runtime.

import type { ResearchRoundResult } from './researchRounds.js';
import { loadResearch } from './researchState.js';
import { selectResearchFiles, type ResearchSelection } from './resultSelection.js';

type ResearchProposal = ResearchSelection & { action?: 'send' | 'start' | 'chat' | 'export' | 'rerun' };
const sendProposals = new Map<string, ResearchProposal>();
export function researchSendProposal(clusterId: string): ResearchProposal | undefined { return sendProposals.get(clusterId); }
export function clearResearchSendProposal(clusterId: string): void { sendProposals.delete(clusterId); }
export async function proposeResearchSend(clusterId: string, caller: string, selection: ResearchProposal): Promise<void> {
  if (selection.action !== undefined && selection.action !== 'send' && selection.action !== 'start' && selection.action !== 'chat' && selection.action !== 'export' && selection.action !== 'rerun') throw new Error('Choose a valid results action.');
  if (selection.action === 'chat' && selection.kind !== 'synthesis') throw new Error('Choose a released summary for Chat.');
  const state = await loadResearch(clusterId);
  if (!state || state.directorWorkflowId !== caller) throw new Error('Only the Research Director can propose sending results.');
  await selectResearchFiles(state, selection);
  sendProposals.set(clusterId, selection);
}
export const RESEARCH_SEND_TOOL = {
  name: 'research_send_to_project',
  description: 'Propose sending or exporting released research, starting a project, or continuing a summary in Chat, or rerunning research. The operator chooses the destination and confirms in RESULTS; this tool does not write to another project.',
  input_schema: { type: 'object' as const, properties: {
    action: { type: 'string', enum: ['send', 'start', 'chat', 'export', 'rerun'], description: 'Send, start a project, continue a summary in Chat, export, or rerun. Default send.' },
    kind: { type: 'string', enum: ['report', 'synthesis', 'project'], description: 'The released result to use.' },
    round: { type: 'number', description: 'Round number for a report or synthesis.' },
    letter: { type: 'string', description: 'Researcher letter for a report.' },
    catchUp: { type: 'string', description: 'Researcher letter for a catch-up report, instead of round and letter.' },
  }, required: ['kind'] },
};

export const RESEARCH_ROUND_TOOL = {
  name: 'research_round',
  description:
    'Research Director only. Send one research round: Arco sends the identical text to every researcher at once, holds each reply until every researcher has replied, failed, been stopped or timed out, then delivers all replies to you together in one message, labelled Researcher A, B, C, and writes them to rounds/round-N/ in the research folder. A researcher that has not replied within the research time limit set by the operator is timed out. Only one round can be open at a time. For a question to a single researcher, use peer_send to "Researcher B" instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The research brief for this round, sent unchanged to every researcher. Say what to answer, the report format and the sources to cite.' },
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
