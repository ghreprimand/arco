// docs/RESEARCH.md - the Arco-side state of a research project.
//
// Kept in ~/.arco/clusters/<clusterId>/research.json, beside the cluster's
// meta.json, and never in the research folder: it holds the mapping from
// report letters to providers and models, and reports held until a round is
// released. The research folder receives only what the Director may read.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ClusterMemberProvider, ClusterResearchSummary, ResearchEntryState } from '@arco/shared';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { clusterDir } from '../clusterStore.js';

export interface ResearchArtifact { name: string; contentBase64: string; byteLength: number }

export interface ResearchEntry {
  state: ResearchEntryState;
  at?: string;
  reason?: string;
  source?: 'mail' | 'final_reply';
  report?: string;
  artifacts?: ResearchArtifact[];
  wakes?: number;
}

export interface ResearchTargeted { at: string; from: 'director' | 'operator'; letter: string; text: string }

export interface ResearchRound {
  n: number;
  text: string;
  startedAt: string;
  deadline: string;
  releasedAt?: string;
  entries: Record<string, ResearchEntry>;
  targeted: ResearchTargeted[];
}

export interface ResearchResearcher {
  workflowId: string;
  letter: string;
  provider: ClusterMemberProvider;
  model: string;
  effort?: string;
}

export interface ResearchState {
  schemaVersion: 1;
  projectId: string;
  clusterId: string;
  // The research project folder (the Director's working directory).
  folder: string;
  // Arco-state folder holding the researchers' workflow folders.
  membersCwd: string;
  name: string;
  brief: string;
  blind: boolean;
  revealedAt?: string;
  // Set when the operator closed the research tab (docs/RESEARCH.md).
  closedAt?: string;
  createdAt: string;
  directorWorkflowId: string;
  researchers: ResearchResearcher[];
  rounds: ResearchRound[];
  // Targeted messages sent before the first round.
  targetedBeforeRounds: ResearchTargeted[];
}

const cache = new Map<string, ResearchState>();

export function researchStatePath(clusterId: string): string {
  return join(clusterDir(clusterId), 'research.json');
}

export function cachedResearch(clusterId: string | undefined): ResearchState | undefined {
  return clusterId ? cache.get(clusterId) : undefined;
}

// Projects made before the name and brief fields (question and conditions)
// read as name and brief.
export function upgradeResearchState(state: ResearchState): ResearchState {
  const old = state as ResearchState & { question?: unknown; conditions?: unknown };
  if (typeof state?.brief === 'string' && typeof state.name === 'string') return state;
  const question = typeof old.question === 'string' ? old.question : '';
  const conditions = typeof old.conditions === 'string' && old.conditions ? `\n\nConditions: ${old.conditions}` : '';
  return { ...state, name: typeof state?.name === 'string' && state.name ? state.name : (question.slice(0, 60) || 'Research'), brief: typeof state?.brief === 'string' ? state.brief : question + conditions };
}

export async function loadResearch(clusterId: string | undefined): Promise<ResearchState | null> {
  if (!clusterId) return null;
  const hit = cache.get(clusterId);
  if (hit) return hit;
  try {
    const parsed = upgradeResearchState(JSON.parse(await fs.readFile(researchStatePath(clusterId), 'utf8')) as ResearchState);
    if (parsed?.schemaVersion !== 1 || parsed.clusterId !== clusterId) return null;
    cache.set(clusterId, parsed);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function persist(state: ResearchState): Promise<void> {
  await fs.mkdir(clusterDir(state.clusterId), { recursive: true });
  await atomicWriteFile(researchStatePath(state.clusterId), JSON.stringify(state, null, 2) + '\n');
  cache.set(state.clusterId, state);
}

export async function initResearch(state: ResearchState): Promise<void> {
  await withFileLock(researchStatePath(state.clusterId), () => persist(state));
}

// Serialized read-modify-write. The mutator works on a copy; returning
// false leaves the stored state untouched.
export async function updateResearch(
  clusterId: string,
  mutate: (state: ResearchState) => boolean | void | Promise<boolean | void>,
): Promise<ResearchState | null> {
  return withFileLock(researchStatePath(clusterId), async () => {
    const current = await loadResearch(clusterId);
    if (!current) return null;
    const next = structuredClone(current);
    if (await mutate(next) === false) return current;
    await persist(next);
    return next;
  });
}

export function forgetResearch(clusterId: string): void { cache.delete(clusterId); }

export function openRound(state: ResearchState): ResearchRound | undefined {
  const last = state.rounds.at(-1);
  return last && !last.releasedAt ? last : undefined;
}

export function researcherFor(state: ResearchState, workflowId: string): ResearchResearcher | undefined {
  return state.researchers.find((r) => r.workflowId === workflowId);
}

// "B", "b", "Researcher B" or a researcher's workflow id.
export function researcherByRef(state: ResearchState, ref: string): ResearchResearcher | undefined {
  const text = ref.trim();
  const letter = /^(?:researcher\s+)?([a-z])$/i.exec(text)?.[1]?.toUpperCase();
  if (letter) return state.researchers.find((r) => r.letter === letter);
  return state.researchers.find((r) => r.workflowId === text);
}

export function researcherName(letter: string): string { return `Researcher ${letter}`; }

export function researchLetter(index: number): string { return String.fromCharCode(65 + index); }

export function researchSummary(state: ResearchState): ClusterResearchSummary {
  return {
    projectId: state.projectId,
    folder: state.folder,
    name: state.name,
    brief: state.brief,
    blind: state.blind,
    ...(state.revealedAt ? { revealedAt: state.revealedAt } : {}),
    directorWorkflowId: state.directorWorkflowId,
    researchers: state.researchers.map((r) => ({
      workflowId: r.workflowId, letter: r.letter, provider: r.provider, model: r.model,
      ...(r.effort ? { effort: r.effort } : {}), isolation: 'tool-fenced' as const,
    })),
    rounds: state.rounds.map((round) => ({
      n: round.n,
      startedAt: round.startedAt,
      deadline: round.deadline,
      ...(round.releasedAt ? { releasedAt: round.releasedAt } : {}),
      entries: Object.fromEntries(Object.entries(round.entries).map(([letter, entry]) => [letter, {
        state: entry.state,
        ...(entry.at ? { at: entry.at } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.source ? { source: entry.source } : {}),
      }])),
      targeted: round.targeted.length,
    })),
  };
}

// Session id of the turns Arco starts for research rounds, so they are not
// recorded as operator messages.
export const RESEARCH_SYNTHETIC_SESSION = 'research-synthetic';
