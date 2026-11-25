// docs/RESEARCH.md - closing a research tab: the one moment of cleanup.
//
// The operator closes the tab; Arco writes a one-page log per researcher
// into the latest round.md, optionally moves files a researcher saved but
// never sent into sources/, then removes the researchers' workspaces and
// conversations. The research folder and the Research Director's
// conversation are kept. After a crash the startup sweep removes only the
// researcher folders of projects whose cluster no longer exists.
import { createHash } from 'node:crypto';
import { researchSearchDetails } from '@arco/shared';
import { saveQuickResearchChat } from './quickResearchChat.js';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { clusterDir, isolatedWorkspaceFor, setBeforeClusterDelete } from '../clusterStore.js';
import { forgetResearchTripwires, RESEARCH_CANARY_FILE } from './researchTripwires.js';
import { atomicWriteFile } from '../atomicFile.js';
import { readLogLines } from '../eventLog.js';
import { flushWorkflowBuffer } from '../workflowStore.js';
import { researchMembersRoot } from './researchCreate.js';
import { roundDir, writeProjectFiles } from './researchFolder.js';
import { forgetResearch, loadResearch, researcherName, updateResearch, type ResearchResearcher, type ResearchState } from './researchState.js';

export interface UnsentFile { letter: string; path: string; bytes: number }

const MAX_LISTED_FILES = 200;
const LOG_LIST_LIMIT = 15;
const SWEEP_MIN_AGE_MS = 10 * 60_000;

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest('hex').slice(0, 12);
}

async function* walk(root: string, missingOk = false): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (missingOk && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function workspaceOf(state: ResearchState, r: ResearchResearcher): string {
  return isolatedWorkspaceFor(state.clusterId, r.workflowId);
}

// Stream the full workspace for close. Only the dialog preview is capped.
async function* filesToKeep(state: ResearchState, letters?: string[]) {
  const sources = join(state.folder, 'sources');
  const entries = await fs.readdir(sources, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const sent = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const hash = entry.name.slice(0, 12);
    const names = sent.get(hash);
    if (names) names.push(entry.name);
    else sent.set(hash, [entry.name]);
  }
  for (const r of state.researchers) {
    if (letters && !letters.includes(r.letter)) continue;
    const root = workspaceOf(state, r);
    for await (const from of walk(root, true)) {
      if (state.isolationCanaries?.[r.workflowId] && from === join(root, RESEARCH_CANARY_FILE)) continue;
      const hash = await hashFile(from);
      const safe = basename(from).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
      const name = `${hash}-kept-${safe}`;
      let alreadySent = false;
      for (const candidate of sent.get(hash) ?? []) {
        // Include copies from an earlier close attempt so a retried Quick
        // research save still attaches the same files.
        if (!candidate.startsWith(`${hash}-kept-`) && await hashFile(join(sources, candidate)) === hash) {
          alreadySent = true;
          break;
        }
      }
      if (!alreadySent) yield { from, name, hash, letter: r.letter, path: relative(root, from).split(sep).join('/'), bytes: (await fs.stat(from)).size };
    }
  }
}

export async function unsentFiles(state: ResearchState, letters?: string[]): Promise<UnsentFile[]> {
  const out: UnsentFile[] = [];
  for await (const { letter, path, bytes } of filesToKeep(state, letters)) {
    out.push({ letter, path, bytes });
    if (out.length >= MAX_LISTED_FILES) break;
  }
  return out;
}

interface LogFacts { turns: number; searches: string[]; sources: string[]; failures: string[] }

function inputField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const value = parsed?.[key];
    return typeof value === 'string' ? value : undefined;
  } catch { return undefined; }
}

async function logFacts(workflowDir: string): Promise<LogFacts> {
  const facts: LogFacts = { turns: 0, searches: [], sources: [], failures: [] };
  const seen = new Set<string>();
  for await (const line of readLogLines(workflowDir)) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.type === 'primary_turn_started') facts.turns++;
    else if (e.type === 'error' && typeof e.message === 'string') facts.failures.push(e.message.slice(0, 200));
    else if (e.type === 'primary_tool_use' && typeof e.tool === 'string') {
      const id = String(e.itemId ?? e.toolUseId ?? `${e.tool}:${e.input}`);
      if (e.status === 'failed') facts.failures.push(`${e.tool} failed${typeof e.output === 'string' ? `: ${e.output.slice(0, 160)}` : ''}`);
      if (seen.has(id)) continue;
      seen.add(id);
      // Cursor names the search text `searchTerm`.
      const search = researchSearchDetails(e.tool, e.input);
      if (search.search) facts.searches.push(search.query ?? '(query not recorded)');
      else if (/^(web_fetch|WebFetch)$/.test(e.tool)) facts.sources.push(inputField(e.input, 'url') ?? '(address not recorded)');
    }
  }
  return facts;
}

function list(items: string[]): string[] {
  const shown = items.slice(0, LOG_LIST_LIMIT).map((item) => `  - ${item.replace(/\s+/g, ' ')}`);
  return items.length > LOG_LIST_LIMIT ? [...shown, `  - and ${items.length - LOG_LIST_LIMIT} more`] : shown;
}

// One page per researcher: turns, searches made, sources opened, failures.
export async function researcherLogs(state: ResearchState, heading: '#' | '##' = '##'): Promise<string> {
  const lines = [...(heading === '##' ? [''] : []), `${heading} Researcher logs`, '', 'Written when the research tab was closed; the researchers\' conversations were then removed.', ''];
  // A reopened project's earlier panel was logged when it first closed.
  for (const r of state.researchers.filter((x) => !(state.reopenedAt && x.removedAt && x.removedAt <= state.reopenedAt))) {
    const f = await logFacts(join(state.membersCwd, '.arco', 'workflows', r.workflowId));
    lines.push(`${heading}# ${researcherName(r.letter)}`, '',
      `- Turns: ${f.turns}`,
      `- Web searches: ${f.searches.length}`, ...list(f.searches),
      `- Sources opened: ${new Set(f.sources).size}`, ...list([...new Set(f.sources)]),
      `- Failed tool calls Arco recorded: ${f.failures.length}`, ...list(f.failures), '');
  }
  return lines.join('\n');
}

// The Arco-side record of a closed project: author mapping, rounds and
// dates. Kept in Arco's data, never in the research folder, so a resumed
// Director still cannot read who wrote which report. Never swept.
export function closedResearchRecordPath(projectId: string): string {
  return join(researchMembersRoot(), 'closed', `${projectId}.json`);
}

async function keepClosedRecord(state: ResearchState): Promise<void> {
  const path = closedResearchRecordPath(state.projectId);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, JSON.stringify(state, null, 2) + '\n');
  await fs.chmod(path, 0o600).catch(() => undefined);
}

export type CloseResult =
  | { ok: true; logsWrittenTo: string; moved: string[]; removed: number }
  | { ok: false; error: 'unknown_research' | 'researcher_busy' | 'director_busy'; letters?: string[] };

// Copies files researchers saved but never sent into sources/; returns
// their project-relative names.
export async function moveUnsentFiles(state: ResearchState, letters?: string[]): Promise<string[]> {
  const moved = new Set<string>();
  await fs.mkdir(join(state.folder, 'sources'), { recursive: true });
  for await (const { from, name, hash } of filesToKeep(state, letters)) {
    const target = join(state.folder, 'sources', name);
    await fs.copyFile(from, target, fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await fs.lstat(target)).isFile() || await hashFile(target) !== hash || await hashFile(from) !== hash) {
      throw new Error('A researcher file could not be copied safely. Its workspace was kept.');
    }
    moved.add(`sources/${name}`);
  }
  return [...moved];
}

// A removed researcher's private workspace and provider home.
export async function removeResearcherWorkspace(state: ResearchState, workflowId: string): Promise<void> {
  const r = state.researchers.find((x) => x.workflowId === workflowId);
  if (r) await fs.rm(dirname(workspaceOf(state, r)), { recursive: true, force: true });
}

// `force` is a cluster deletion under the cluster lock. It refuses active
// work without waiting for a promotion that might need the same lock.
export async function closeResearch(clusterId: string, opts: { moveUnsent: boolean; isBusy: (workflowId: string) => boolean; now?: () => number; waitMs?: number; force?: boolean }): Promise<CloseResult> {
  let current = await loadResearch(clusterId);
  if (!current) return { ok: false, error: 'unknown_research' };
  if (current.quick) {
    const promotion = await import('./quickPromotion.js');
    // A forced close runs under the cluster lock. Do not wait for a copy that
    // might itself be waiting for that lock; leave the cluster intact instead.
    if (opts.force) {
      if (promotion.stopQuickPromotionTimer(clusterId)) return { ok: false, error: 'director_busy' };
    } else {
      await promotion.cancelQuickPromotion(clusterId);
      current = await loadResearch(clusterId);
      if (!current) return { ok: false, error: 'unknown_research' };
    }
  }
  const state = current;
  if (state.quick && opts.isBusy(state.directorWorkflowId)) return { ok: false, error: 'director_busy' };
  if (state.closedAt) {
    await keepClosedRecord(state);
    return { ok: true, logsWrittenTo: '', moved: [], removed: await removeResearchWorkspaces(state) };
  }
  // The client closes the researcher tabs first, which cancels their turns;
  // give a cancelled turn a moment to settle before touching its files.
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  let busy = state.researchers.filter((r) => opts.isBusy(r.workflowId));
  while (busy.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    busy = busy.filter((r) => opts.isBusy(r.workflowId));
  }
  if (busy.length) return { ok: false, error: 'researcher_busy', letters: busy.map((r) => r.letter) };

  // Hold the sources idle while the logs and attachments are copied.
  const releases: Array<() => void> = [];
  const ids = state.researchers.map(r => r.workflowId);
  if (state.quick) ids.push(state.directorWorkflowId);
  const { workflows } = await import('../server/state.js');
  const { reserveWorkflowMigration } = await import('../ws/turnEngine.js');
  for (const id of ids) {
    const wf = workflows.get(id);
    if (!wf) continue;
    try { releases.push(reserveWorkflowMigration(wf)); }
    catch {
      for (const release of releases.reverse()) release();
      return id === state.directorWorkflowId
        ? { ok: false, error: 'director_busy' }
        : { ok: false, error: 'researcher_busy', letters: state.researchers.filter(r => r.workflowId === id).map(r => r.letter) };
    }
  }
  try {
    await Promise.all(state.researchers.map(r => flushWorkflowBuffer(state.membersCwd, r.workflowId)));
    const moved = opts.moveUnsent ? await moveUnsentFiles(state) : [];
    if (state.quick) await saveQuickResearchChat(state, moved);

    const latest = state.rounds.at(-1);
    const logsPath = latest ? join(roundDir(state.folder, latest.n), 'round.md') : join(state.folder, 'researcher-logs.md');
    const moves = moved.length ? `\nFiles the researchers saved but never sent, moved on close:\n${moved.map((m) => `- ${m}`).join('\n')}\n` : '';
    const logs = await researcherLogs(state, latest ? '##' : '#') + moves;
    const previous = await fs.readFile(logsPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    if (!previous.endsWith(logs)) await atomicWriteFile(logsPath, previous + logs);

    const closedAt = new Date((opts.now ?? Date.now)()).toISOString();
    const closing = { ...state, closedAt };
    await keepClosedRecord(closing);
    await writeProjectFiles(closing);
    if (!await updateResearch(clusterId, (s) => { s.closedAt = closedAt; })) throw new Error('The research state could not be closed.');
    const removed = await removeResearchWorkspaces(state);
    return { ok: true, logsWrittenTo: relative(state.folder, logsPath).split(sep).join('/'), moved, removed };
  } finally { for (const release of releases.reverse()) release(); }
}

async function removeResearchWorkspaces(state: ResearchState): Promise<number> {
  for (const r of state.researchers) await removeResearcherWorkspace(state, r.workflowId);
  await fs.rm(state.membersCwd, { recursive: true, force: true });
  return state.researchers.length;
}

// Startup: researcher conversation folders whose project has no cluster any
// more belong to a closed tab whose cleanup did not finish. Never touches a
// research folder. Recently changed folders are left for a project that is
// being created right now.
export async function sweepClosedResearch(liveProjectIds: Set<string>, nowMs = Date.now()): Promise<string[]> {
  const root = researchMembersRoot();
  const removed: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // Only project folders (uuid names); `closed/` holds the kept records.
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name) || liveProjectIds.has(entry.name)) continue;
    const path = join(root, entry.name);
    const stat = await fs.stat(path).catch(() => null);
    if (!stat || nowMs - stat.mtimeMs < SWEEP_MIN_AGE_MS) continue;
    await fs.rm(path, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

// Project ids of every cluster folder that still holds research state. An
// unreadable research.json stops the sweep: a folder is kept when in doubt.
export async function researchProjectIdsOnDisk(): Promise<Set<string> | null> {
  let clusterIds: string[];
  try { clusterIds = await fs.readdir(dirname(clusterDir('probe'))); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Set() : null;
  }
  const ids = new Set<string>();
  for (const id of clusterIds) {
    let raw: string;
    try { raw = await fs.readFile(join(clusterDir(id), 'research.json'), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return null;
    }
    try {
      const projectId = (JSON.parse(raw) as { projectId?: unknown }).projectId;
      if (typeof projectId !== 'string') return null;
      ids.add(projectId);
    } catch { return null; }
  }
  return ids;
}

// docs/RESEARCH.md - every deletion of a research cluster (tab close, a
// dissolve, a delete from elsewhere) runs the same close first: logs, unsent
// files moved into sources/, the closed record kept. The tab close has
// already done it, so this is a no-op then.
export function installResearchCloseOnDelete(isBusy: (workflowId: string) => boolean): void {
  setBeforeClusterDelete(async (cluster) => {
    if (!cluster.research) return;
    let quick = false;
    try {
      quick = (await loadResearch(cluster.clusterId))?.quick === true;
      const result = await closeResearch(cluster.clusterId, { moveUnsent: true, isBusy, waitMs: 0, force: true });
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      const label = quick ? 'Quick research' : 'Research';
      throw Object.assign(new Error(`${label} could not be saved; the research tab remains open.`), { code: 'preserve_research', cause: error });
    }
    forgetResearch(cluster.clusterId);
    forgetResearchTripwires(cluster.clusterId);
  });
}
