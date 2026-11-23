import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { posix } from 'node:path';
import * as clusterStore from '../clusterStore.js';
import { prepareIsolatedCliHome } from '../workers/isolatedCliHome.js';
import { WORKER_SANDBOX_HOME } from '../workers/linuxWorkerSandbox.js';
import { cachedResearch, replyRound, researcherFor, roundByKey, updateResearch, type ResearchState } from './researchState.js';

export const RESEARCH_CANARY_FILE = '.arco-independence-canary';
const token = () => `arco-canary-${randomBytes(32).toString('hex')}`;

async function marker(path: string, value: string, created: string[]): Promise<void> {
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created.push(path);
    try { await file.writeFile(value); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(value)
        || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
        || await file.readFile('utf8') !== value) throw new Error('A researcher independence marker is missing or changed.');
    } finally { await file.close(); }
  }
}

/** Place private, distinct synthetic markers before any researcher in the round starts. */
export async function ensureResearchTripwires(clusterId: string): Promise<ResearchState | null> {
  const created: string[] = [];
  try {
    return await updateResearch(clusterId, async state => {
      const canaries = state.isolationCanaries ?? {};
      for (const researcher of state.researchers) {
        if (researcher.removedAt) continue;
        const pair = canaries[researcher.workflowId] ?? { workspace: token(), home: token() };
        const home = await prepareIsolatedCliHome(clusterId, researcher.workflowId);
        await marker(join(clusterStore.isolatedWorkspaceFor(clusterId, researcher.workflowId), RESEARCH_CANARY_FILE), pair.workspace, created);
        await marker(join(home, RESEARCH_CANARY_FILE), pair.home, created);
        canaries[researcher.workflowId] = pair;
      }
      state.isolationCanaries = canaries;
    });
  } catch (error) {
    await Promise.allSettled(created.map(path => rm(path, { force: true })));
    throw error;
  }
}

/** A researcher may encounter its own markers; only another member's marker is a breach. */
export function containsForeignCanary(state: ResearchState, workflowId: string, text: string): boolean {
  return Object.entries(state.isolationCanaries ?? {}).some(([owner, pair]) => owner !== workflowId
    && (text.includes(pair.workspace) || text.includes(pair.home)));
}

let onBreach: ((clusterId: string, round: number, kind: 'contaminated' | 'boundary') => void) | undefined;
const tails = new Map<string, string>();
const hits = new Set<string>();
const boundaryHits = new Set<string>();
const turnRounds = new Map<string, number>();
export function setResearchTripwireReporter(reporter?: (clusterId: string, round: number, kind: 'contaminated' | 'boundary') => void): void {
  onBreach = reporter;
  if (!reporter) { tails.clear(); hits.clear(); boundaryHits.clear(); turnRounds.clear(); }
}
export function startResearchTripwireTurn(clusterId: string | undefined, workflowId: string): void {
  if (!clusterId) return;
  const state = cachedResearch(clusterId);
  const researcher = state && researcherFor(state, workflowId);
  if (state && researcher) {
    // A catch-up turn is keyed by its catch-up, so a hit never marks an
    // unrelated round.
    const n = replyRound(state, researcher.letter)?.n ?? state.rounds.at(-1)?.n ?? 0;
    const old = turnRounds.get(`${clusterId}:${workflowId}`);
    if (old !== undefined && old !== n) {
      const prefix = `${clusterId}:${old}:${workflowId}:`;
      for (const key of tails.keys()) if (key.startsWith(prefix)) tails.delete(key);
    }
    turnRounds.set(`${clusterId}:${workflowId}`, n);
  }
}
export function forgetResearchTripwires(clusterId: string): void {
  const prefix = `${clusterId}:`;
  for (const key of tails.keys()) if (key.startsWith(prefix)) tails.delete(key);
  for (const key of hits) if (key.startsWith(prefix)) hits.delete(key);
  for (const key of boundaryHits) if (key.startsWith(prefix)) boundaryHits.delete(key);
  for (const key of turnRounds.keys()) if (key.startsWith(prefix)) turnRounds.delete(key);
}
function observedRound(state: ResearchState, workflowId: string) {
  const n = turnRounds.get(`${state.clusterId}:${workflowId}`);
  return n === undefined ? state.rounds.at(-1) : roundByKey(state, n);
}
export function researchTripwireHit(clusterId: string, round: number): boolean { return hits.has(`${clusterId}:${round}`); }
export function researchBoundaryHit(clusterId: string, round: number): boolean { return boundaryHits.has(`${clusterId}:${round}`); }
export function clearResearchTripwireTails(clusterId: string, round: number): void {
  const prefix = `${clusterId}:${round}:`;
  const active = [...turnRounds.entries()].filter(([key, n]) => key.startsWith(`${clusterId}:`) && n === round)
    .map(([key]) => `${prefix}${key.slice(clusterId.length + 1)}:`);
  for (const key of tails.keys()) if (key.startsWith(prefix) && !active.some(value => key.startsWith(value))) tails.delete(key);
  hits.delete(`${clusterId}:${round}`);
  boundaryHits.delete(`${clusterId}:${round}`);
}

/** Inspect only live researcher output; keep a short tail for split text chunks. */
export function observeResearchText(clusterId: string | undefined, workflowId: string, text: string, append = false, channel = 'text'): boolean {
  if (!clusterId || !text) return false;
  const state = cachedResearch(clusterId);
  const round = state && observedRound(state, workflowId);
  if (!state || !researcherFor(state, workflowId) || !state.isolationCanaries) return false;
  const n = round?.n ?? 0;
  const key = `${clusterId}:${n}:${workflowId}:${channel}`;
  const combined = append ? (tails.get(key) ?? '') + text : text;
  if (append) tails.set(key, combined.slice(-100));
  const found = containsForeignCanary(state, workflowId, combined);
  const hit = `${clusterId}:${n}`;
  if (found && !hits.has(hit)) { hits.add(hit); onBreach?.(clusterId, n, 'contaminated'); }
  return found;
}

// Cursor's own tool output and transcripts inside its sandbox home. Typed as
// string so the emitted declaration does not spell the path out.
export const CURSOR_OWN_OUTPUT: string = `${WORKER_SANDBOX_HOME}/.cursor/projects`;

/** Flag explicit foreign paths and loopback addresses in the file and shell calls Arco receives. */
export function researchToolBoundaryWarning(tool: string, input: string): boolean {
  const name = tool.split('__').at(-1) ?? tool;
  if (!['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'read_file', 'write_file'].includes(name)) return false;
  let inspected = input;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = name === 'Bash' ? ['command', 'cwd'] : ['file_path', 'path', 'directory', 'cwd'];
      inspected = keys.map(key => typeof parsed[key] === 'string' ? parsed[key] : '').join(' ');
    }
  } catch { /* Inspect the original provider input if it is not JSON. */ }
  if (/(?:\b(?:127(?:\.\d{1,3}){3}|localhost)\b|\[::1\]|(?:^|[\s"'])::1(?:$|[\s"']))/i.test(inspected)) return true;
  if (/(?:^|[\s"'=])(?:~(?:\/|[\s"']|$)|\.\.(?:\/|[\s"']|$))/.test(inspected)) return true;
  const paths = Array.from(inspected.matchAll(/(?:^|[\s"'`=([{<>|;&,])((?:\/)(?=[A-Za-z0-9._~\-])(?:[^\s"'`<>|;&),}\\]|\\\/)+)/g), match => match[1]);
  // Cursor keeps its own tool output and transcripts under its sandbox home
  // (`.cursor/projects`); reading them back is not an access outside the sandbox.
  const allowed = ['/work', '/usr', '/bin', '/lib', '/lib64', '/tmp', '/dev/null', '/etc/ssl', CURSOR_OWN_OUTPUT];
  return paths.some(raw => {
    const path = posix.normalize(raw.replace(/\\\//g, '/'));
    return !allowed.some(root => path === root || path.startsWith(`${root}/`));
  });
}

export function observeResearchTool(clusterId: string | undefined, workflowId: string, tool: string, input: string): boolean {
  if (!clusterId || !researchToolBoundaryWarning(tool, input)) return false;
  const state = cachedResearch(clusterId), round = state && observedRound(state, workflowId);
  if (!state || !state.isolationCanaries || !researcherFor(state, workflowId)) return false;
  const n = round?.n ?? 0;
  const hit = `${clusterId}:${n}`;
  if (!boundaryHits.has(hit)) { boundaryHits.add(hit); onBreach?.(clusterId, n, 'boundary'); }
  return true;
}
