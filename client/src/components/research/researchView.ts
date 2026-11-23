import { researchSearchDetails, type ClusterResearchSummary, type ResearchEntryState, type ResearchRoundSummary } from '@arco/shared';
import type { JobState } from '../../stores/appStore';

// docs/RESEARCH.md - pure helpers for the research project screen.

export const ENTRY_WORDS: Record<ResearchEntryState, string> = {
  waiting: 'working', replied: 'replied', failed: 'failed', stopped: 'stopped', timed_out: 'timed out', removed: 'removed',
};

// Rounds and catch-ups in the order they started, for the rounds strip.
export function roundsAndCatchUps(research: Pick<ClusterResearchSummary, 'rounds' | 'catchUps'>): ResearchRoundSummary[] {
  return [...research.rounds, ...(research.catchUps ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// Web searches this researcher made in its loaded activity. Tool calls live
// in the activity list, not in chat messages; one call can report several
// status updates, so calls are counted once by their id.
export function searchCount(job: Pick<JobState, 'activity'> | undefined): number {
  const seen = new Set<string>();
  for (const entry of job?.activity ?? []) {
    if (entry.kind !== 'tool_use' || !researchSearchDetails(entry.tool, entry.input).search) continue;
    seen.add(entry.itemId ?? entry.toolUseId ?? entry.id);
  }
  return seen.size;
}

export function elapsedLabel(fromIso: string, toIso: string | undefined, now: number): string {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso));
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'under 1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function roundSummaryLine(round: ResearchRoundSummary): string {
  const entries = Object.values(round.entries);
  const replied = entries.filter((e) => e.state === 'replied').length;
  const failed = entries.filter((e) => e.state !== 'replied' && e.state !== 'waiting').length;
  return `${replied} of ${entries.length} replied${failed ? `, ${failed} without a report` : ''}${round.releasedAt ? ', released' : ', collecting'}`;
}

// The line on a researcher's card: letter, provider and model, isolation,
// searches and the state in the latest round.
export function researcherCardLine(research: ClusterResearchSummary, workflowId: string, job: JobState | undefined): string | undefined {
  const r = research.researchers.find((x) => x.workflowId === workflowId);
  if (!r) return workflowId === research.directorWorkflowId ? 'Research Director' : undefined;
  const latest = research.rounds.at(-1);
  const entry = latest?.entries[r.letter];
  const searches = searchCount(job);
  const provider = r.provider === 'claude' ? (r.claudeTransport === 'cli' ? 'Claude CLI' : 'Claude Native') : r.provider;
  return [`${r.letter}`, `${provider}, ${r.model}`, r.isolation, `${searches} search${searches === 1 ? '' : 'es'}`,
    ...(latest && entry ? [`round ${latest.n}: ${entry.retrying ? 'retrying' : `${ENTRY_WORDS[entry.state]}${entry.late ? ' (late)' : ''}`}`] : [])].join(' · ');
}

// The narrow member rail: RD for the Research Director.
// The researcher's letter, so the rail buttons are told apart.
export function researchRailLabel(research: Pick<ClusterResearchSummary, 'directorWorkflowId' | 'researchers'>, workflowId: string): string | undefined {
  if (workflowId === research.directorWorkflowId) return 'RD';
  return research.researchers.find((r) => r.workflowId === workflowId)?.letter;
}

// A researcher's card preview: a markdown link to a path inside its sandbox
// (/work/...) cannot be opened from the host, so only its text is shown.
export function withoutSandboxLinks(text: string): string {
  return text.replace(/\[([^\]\n]*)\]\(\/work\/[^)\s]*\)/g, '$1');
}
