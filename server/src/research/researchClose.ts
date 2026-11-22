// docs/RESEARCH.md - closing a research tab: the one moment of cleanup.
//
// The operator closes the tab; Arco writes a one-page log per researcher
// into the latest round.md, optionally moves files a researcher saved but
// never sent into sources/, then removes the researchers' workspaces and
// conversations. The research folder and the Research Director's
// conversation are kept. After a crash the startup sweep removes only the
// researcher folders of projects whose cluster no longer exists.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { clusterDir, isolatedWorkspaceFor, setBeforeClusterDelete } from '../clusterStore.js';
import { forgetResearchTripwires, RESEARCH_CANARY_FILE } from './researchTripwires.js';
import { atomicWriteFile } from '../atomicFile.js';
import { readLogLines } from '../eventLog.js';
import { researchMembersRoot } from './researchCreate.js';
import { roundDir, writeProjectFiles } from './researchFolder.js';
import { forgetResearch, loadResearch, researcherName, updateResearch, type ResearchResearcher, type ResearchState } from './researchState.js';

export interface UnsentFile { letter: string; path: string; bytes: number }

const MAX_LISTED_FILES = 200;
const MAX_DEPTH = 6;
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

async function walk(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_LISTED_FILES) return out;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_FILES) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, depth + 1, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function workspaceOf(state: ResearchState, r: ResearchResearcher): string {
  return isolatedWorkspaceFor(state.clusterId, r.workflowId);
}

// Files in a researcher's workspace whose content is not already in sources/.
export async function unsentFiles(state: ResearchState): Promise<UnsentFile[]> {
  const sent = new Set((await fs.readdir(join(state.folder, 'sources')).catch(() => [] as string[])).map((name) => name.slice(0, 12)));
  const out: UnsentFile[] = [];
  for (const r of state.researchers) {
    const root = workspaceOf(state, r);
    for (const path of await walk(root)) {
      if (state.isolationCanaries?.[r.workflowId] && path === join(root, RESEARCH_CANARY_FILE)) continue;
      const stat = await fs.stat(path).catch(() => null);
      if (!stat) continue;
      const hash = await hashFile(path).catch(() => '');
      if (!hash || sent.has(hash)) continue;
      out.push({ letter: r.letter, path: relative(root, path).split(sep).join('/'), bytes: stat.size });
    }
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
  try {
    for await (const line of readLogLines(workflowDir)) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (e.type === 'primary_turn_started') facts.turns++;
      else if (e.type === 'error' && typeof e.message === 'string') facts.failures.push(e.message.slice(0, 200));
      else if (e.type === 'primary_tool_use' && typeof e.tool === 'string') {
        const id = String(e.toolUseId ?? e.itemId ?? `${e.tool}:${e.input}`);
        if (e.status === 'failed') facts.failures.push(`${e.tool} failed${typeof e.output === 'string' ? `: ${e.output.slice(0, 160)}` : ''}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (/^(web_search|WebSearch)$/.test(e.tool)) facts.searches.push(inputField(e.input, 'query') ?? '(query not recorded)');
        else if (/^(web_fetch|WebFetch)$/.test(e.tool)) facts.sources.push(inputField(e.input, 'url') ?? '(address not recorded)');
      }
    }
  } catch { /* no conversation on disk: an empty log */ }
  return facts;
}

function list(items: string[]): string[] {
  const shown = items.slice(0, LOG_LIST_LIMIT).map((item) => `  - ${item.replace(/\s+/g, ' ')}`);
  return items.length > LOG_LIST_LIMIT ? [...shown, `  - and ${items.length - LOG_LIST_LIMIT} more`] : shown;
}

// One page per researcher: turns, searches made, sources opened, failures.
export async function researcherLogs(state: ResearchState, heading: '#' | '##' = '##'): Promise<string> {
  const lines = [...(heading === '##' ? [''] : []), `${heading} Researcher logs`, '', 'Written when the research tab was closed; the researchers\' conversations were then removed.', ''];
  for (const r of state.researchers) {
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
  | { ok: false; error: 'unknown_research' | 'researcher_busy'; letters?: string[] };

// `force` (a cluster deleted by another path) closes even while a
// researcher's turn is still settling.
export async function closeResearch(clusterId: string, opts: { moveUnsent: boolean; isBusy: (workflowId: string) => boolean; now?: () => number; waitMs?: number; force?: boolean }): Promise<CloseResult> {
  const state = await loadResearch(clusterId).catch(() => null);
  if (!state) return { ok: false, error: 'unknown_research' };
  if (state.closedAt) {
    await keepClosedRecord(state);
    return { ok: true, logsWrittenTo: '', moved: [], removed: 0 };
  }
  // The client closes the researcher tabs first, which cancels their turns;
  // give a cancelled turn a moment to settle before touching its files.
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  let busy = state.researchers.filter((r) => opts.isBusy(r.workflowId));
  while (busy.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    busy = busy.filter((r) => opts.isBusy(r.workflowId));
  }
  if (busy.length && !opts.force) return { ok: false, error: 'researcher_busy', letters: busy.map((r) => r.letter) };

  const moved: string[] = [];
  if (opts.moveUnsent) {
    await fs.mkdir(join(state.folder, 'sources'), { recursive: true });
    for (const file of await unsentFiles(state)) {
      const r = state.researchers.find((x) => x.letter === file.letter)!;
      const from = join(workspaceOf(state, r), ...file.path.split('/'));
      const hash = await hashFile(from);
      const safe = file.path.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
      const name = `${hash}-${safe}`;
      await fs.copyFile(from, join(state.folder, 'sources', name), fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      moved.push(`sources/${name}`);
    }
  }

  const latest = state.rounds.at(-1);
  const logsPath = latest ? join(roundDir(state.folder, latest.n), 'round.md') : join(state.folder, 'researcher-logs.md');
  await fs.mkdir(dirname(logsPath), { recursive: true });
  const moves = moved.length ? `\nFiles the researchers saved but never sent, moved on close:\n${moved.map((m) => `- ${m}`).join('\n')}\n` : '';
  await fs.appendFile(logsPath, await researcherLogs(state, latest ? '##' : '#') + moves);

  const closedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const updated = await updateResearch(clusterId, (s) => { s.closedAt = closedAt; });
  if (updated) await writeProjectFiles(updated).catch(() => undefined);
  await keepClosedRecord(updated ?? { ...state, closedAt });

  let removed = 0;
  for (const r of state.researchers) {
    await fs.rm(dirname(workspaceOf(state, r)), { recursive: true, force: true });
    removed++;
  }
  await fs.rm(state.membersCwd, { recursive: true, force: true });
  return { ok: true, logsWrittenTo: relative(state.folder, logsPath).split(sep).join('/'), moved, removed };
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
    try {
      const result = await closeResearch(cluster.clusterId, { moveUnsent: true, isBusy, waitMs: 0, force: true });
      if (!result.ok && result.error !== 'unknown_research') console.error(`[arco] research close before delete failed: ${result.error}`);
    } finally {
      forgetResearch(cluster.clusterId);
      forgetResearchTripwires(cluster.clusterId);
    }
  });
}
