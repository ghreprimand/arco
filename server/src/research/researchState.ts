// docs/RESEARCH.md - the Arco-side state of a research project.
//
// Kept in ~/.arco/clusters/<clusterId>/research.json, beside the cluster's
// meta.json, and never in the research folder: it holds the mapping from
// report letters to providers and models, and reports held until a round is
// released. The research folder receives only what the Director may read.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
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
  // The researcher is still on its catch-up: the round text is sent when
  // the catch-up settles, against the same deadline.
  deferred?: boolean;
  // The round mail from a Gemini Research Director still waits for the
  // operator's NUDGE: this entry does not time out, and the round deadline
  // counts from when the researcher reads that mail (docs/RESEARCH.md).
  heldMsgId?: string;
  // The operator's RETRY (docs/RESEARCH.md "Retry"): when it was pressed, and
  // for a released round the key of the retry run that answers it alone.
  retry?: { at: string; key?: number };
  // A report from a retry that settled after its round was released.
  late?: string;
}

export interface ResearchTargeted { at: string; from: 'director' | 'operator'; letter: string; text: string }

export interface ResearchRound {
  n: number;
  text: string;
  startedAt: string;
  deadline: string;
  // The round's time limit, kept so a held researcher gets the full limit
  // from when it reads the round mail.
  timeoutMs?: number;
  releasedAt?: string;
  entries: Record<string, ResearchEntry>;
  targeted: ResearchTargeted[];
  contaminated?: boolean;
  boundaryWarning?: boolean;
  // A catch-up: the round 1 text run alone for the researcher with this
  // letter, which joined after round 1. Its `n` is catchUpKey(letter).
  catchUp?: string;
  // A retry run: the round `round` text again for researcher `letter` alone,
  // after that round was released. Its `n` is retryKey(round, letter).
  lateFor?: { round: number; letter: string };
}

export interface ResearchResearcher {
  workflowId: string;
  letter: string;
  provider: ClusterMemberProvider;
  model: string;
  effort?: string;
  claudeTransport?: 'native' | 'cli';
  isolation?: 'checking' | 'sandboxed';
  signInNeeded?: 'claude' | 'codex';
  signInRemainingMs?: number;
  // Added after the project started (docs/RESEARCH.md).
  joinedAt?: string;
  joinedFromRound?: number;
  // Removed by the operator. It stays here so earlier rounds keep the letter.
  removedAt?: string;
}

export interface ResearchState {
  schemaVersion: 1;
  projectId: string;
  quick?: boolean;
  savedQuickChat?: boolean;
  clusterId: string;
  // The research project folder (the Director's working directory).
  folder: string;
  // Arco-state folder holding the researchers' workflow folders.
  membersCwd: string;
  sourceProject?: string;
  name: string;
  brief: string;
  blind: boolean;
  revealedAt?: string;
  // Set when the operator closed the research tab (docs/RESEARCH.md).
  closedAt?: string;
  // Set when the project was last reopened from the Research library.
  // Researchers removed at or before it belong to the earlier panel.
  reopenedAt?: string;
  createdAt: string;
  directorWorkflowId: string;
  researchers: ResearchResearcher[];
  rounds: ResearchRound[];
  // Catch-ups for researchers added after round 1.
  catchUps?: ResearchRound[];
  // Retry runs for researchers whose round was already released.
  retries?: ResearchRound[];
  // Targeted messages sent before the first round.
  targetedBeforeRounds: ResearchTargeted[];
  // Synthetic markers stay in Arco state, never in the Director's summary.
  isolationCanaries?: Record<string, { workspace: string; home: string }>;
  preRoundContaminated?: boolean;
  preRoundBoundaryWarning?: boolean;
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

// Researchers still in the project; removed ones stay in `researchers` for
// the records only.
export function activeResearchers(state: ResearchState): ResearchResearcher[] {
  return state.researchers.filter((r) => !r.removedAt);
}

export function researcherFor(state: ResearchState, workflowId: string): ResearchResearcher | undefined {
  return state.researchers.find((r) => r.workflowId === workflowId && !r.removedAt);
}

// A catch-up's key in place of a round number: negative, one per letter, so
// timers and independence checks never mix it up with a round.
export function catchUpKey(letter: string): number { return 64 - letter.charCodeAt(0); }
export function catchUpLetter(key: number): string { return String.fromCharCode(64 - key); }

export function openCatchUp(state: ResearchState, letter: string): ResearchRound | undefined {
  return state.catchUps?.find((c) => c.catchUp === letter && !c.releasedAt);
}

// A retry run's key: negative and below every catch-up key, one per round
// and letter.
export function retryKey(round: number, letter: string): number { return -(1000 + round * 32 + (letter.charCodeAt(0) - 65)); }

export function openRetry(state: ResearchState, letter: string): ResearchRound | undefined {
  return state.retries?.find((r) => r.lateFor?.letter === letter && !r.releasedAt);
}

// A round, catch-up or retry run by its number or key.
export function roundByKey(state: ResearchState, n: number): ResearchRound | undefined {
  if (n <= -1000) return state.retries?.find((r) => r.n === n);
  return n < 0 ? state.catchUps?.find((c) => c.n === n) : state.rounds.find((r) => r.n === n);
}

// Where a researcher's reply belongs: its open catch-up or retry run, else
// the open round when that round's text has been sent to it.
export function replyRound(state: ResearchState, letter: string): ResearchRound | undefined {
  const catchUp = openCatchUp(state, letter) ?? openRetry(state, letter);
  if (catchUp) return catchUp;
  const round = openRound(state);
  const entry = round?.entries[letter];
  return entry && !entry.deferred ? round : undefined;
}

// "B", "b", "Researcher B" or a researcher's workflow id.
export function researcherByRef(state: ResearchState, ref: string): ResearchResearcher | undefined {
  const text = ref.trim();
  const letter = /^(?:researcher\s+)?([a-z])$/i.exec(text)?.[1]?.toUpperCase();
  if (letter) return activeResearchers(state).find((r) => r.letter === letter);
  return activeResearchers(state).find((r) => r.workflowId === text);
}

export function researcherName(letter: string): string { return `Researcher ${letter}`; }

// A returned file's name in the research folder's sources/: content hash
// plus the sanitized original name, so equal files share one copy.
export function sourceFileName(artifact: ResearchArtifact): string {
  const data = Buffer.from(artifact.contentBase64, 'base64');
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
  const safe = artifact.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  return `${hash}-${safe}`;
}

export function researchLetter(index: number): string { return String.fromCharCode(65 + index); }

// Letters are never reused: removed researchers keep theirs.
export function nextResearchLetter(state: ResearchState): string { return researchLetter(state.researchers.length); }

export function researchSummary(state: ResearchState): ClusterResearchSummary {
  return {
    projectId: state.projectId,
    ...(state.quick ? { quick: true } : {}),
    folder: state.folder,
    ...(state.sourceProject ? { sourceProject: state.sourceProject } : {}),
    name: state.name,
    brief: state.brief,
    blind: state.blind,
    ...(state.revealedAt ? { revealedAt: state.revealedAt } : {}),
    directorWorkflowId: state.directorWorkflowId,
    ...(state.preRoundContaminated ? { preRoundContaminated: true } : {}),
    ...(state.preRoundBoundaryWarning ? { preRoundBoundaryWarning: true } : {}),
    researchers: state.researchers.map((r) => ({
      workflowId: r.workflowId, letter: r.letter, provider: r.provider, model: r.model,
      ...(r.effort ? { effort: r.effort } : {}), isolation: r.claudeTransport === 'cli' || r.provider === 'codex' || r.provider === 'cursor' || r.provider === 'antigravity-cli' ? (r.isolation ?? 'checking') : 'tool-fenced' as const,
      ...(r.signInNeeded ? { signInNeeded: r.signInNeeded } : {}),
      ...(r.provider === 'claude' ? { claudeTransport: r.claudeTransport ?? 'native' } : {}),
      ...(r.joinedFromRound ? { joinedFromRound: r.joinedFromRound } : {}),
      ...(r.removedAt ? { removedAt: r.removedAt } : {}),
    })),
    rounds: state.rounds.map((round) => roundSummary(round, state)),
    catchUps: (state.catchUps ?? []).map((round) => roundSummary(round, state)),
  };
}

function roundSummary(round: ResearchRound, state: ResearchState): ClusterResearchSummary['rounds'][number] {
  return {
      n: round.n,
      startedAt: round.startedAt,
      deadline: round.deadline,
      ...(round.releasedAt ? { releasedAt: round.releasedAt } : {}),
      ...(round.contaminated ? { contaminated: true } : {}),
      ...(round.boundaryWarning ? { boundaryWarning: true } : {}),
      entries: Object.fromEntries(Object.entries(round.entries).map(([letter, entry]) => [letter, {
        state: entry.state,
        ...(entry.at ? { at: entry.at } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.late ? { late: entry.late } : {}),
        // Returned files as writeReleasedRound copied them into sources/.
        ...(round.releasedAt && entry.state === 'replied' && entry.artifacts?.length ? { sources: entry.artifacts.map((a) => ({ name: a.name, path: `sources/${sourceFileName(a)}` })) } : {}),
        ...(retrying(state, round, letter, entry) ? { retrying: true } : {}),
      }])),
      targeted: round.targeted.length,
      ...(round.catchUp ? { catchUp: round.catchUp } : {}),
  };
}

// A RETRY still running for this entry: back to waiting in its open round,
// or a retry run for its released round.
function retrying(state: ResearchState, round: ResearchRound, letter: string, entry: ResearchEntry): boolean {
  if (!entry.retry) return false;
  if (entry.retry.key === undefined) return !round.releasedAt && entry.state === 'waiting';
  return !!state.retries?.some((r) => r.n === entry.retry!.key && !r.releasedAt);
}

// Session id of the turns Arco starts for research rounds, so they are not
// recorded as operator messages.
export const RESEARCH_SYNTHETIC_SESSION = 'research-synthetic';
