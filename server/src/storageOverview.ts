import { promises as fs } from 'node:fs';
import path from 'node:path';
import { arcoHome } from './arcoHome.js';
import { projectPaths, isChatStorage } from './projects.js';
import { readKnownCwds } from './explorerArtifacts.js';
import { snapshot } from './workspace.js';
import { workflows } from './server/state.js';
import { scanStorage, type StorageBucketName, type StorageFile } from './storageReport.js';
import { archiveConversation, listArchives } from './storageArchive.js';
import { atomicWriteFile } from './atomicFile.js';
import { readKeep, isKept } from './keepStore.js';

// The all-projects STORAGE view, the disk-budget notice and the optional
// auto-archive rule (P7.5, docs/STORAGE_PLAN.md). Reads use the bounded,
// read-only storage report; the only write is archiving, and only when the
// operator turned the rule on.

const GiB = 1024 * 1024 * 1024;
export interface StoragePolicy { version: 1; autoArchiveClosedDays: number | null; budgetGiB: number; budgetNotice: boolean }
export const DEFAULT_POLICY: StoragePolicy = { version: 1, autoArchiveClosedDays: null, budgetGiB: 100, budgetNotice: true };

function policyPath(): string { return path.join(arcoHome(), 'storage-policy.json'); }

export async function readPolicy(): Promise<StoragePolicy> {
  try {
    const v = JSON.parse(await fs.readFile(policyPath(), 'utf8')) as Partial<StoragePolicy>;
    return sanitizePolicy(v);
  } catch { return { ...DEFAULT_POLICY }; }
}

export function sanitizePolicy(v: Partial<StoragePolicy>): StoragePolicy {
  const days = v.autoArchiveClosedDays;
  const budget = v.budgetGiB;
  return {
    version: 1,
    autoArchiveClosedDays: typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null,
    budgetGiB: typeof budget === 'number' && Number.isFinite(budget) && budget >= 1 && budget <= 1_000_000 ? budget : DEFAULT_POLICY.budgetGiB,
    budgetNotice: typeof v.budgetNotice === 'boolean' ? v.budgetNotice : DEFAULT_POLICY.budgetNotice,
  };
}

export async function writePolicy(patch: Partial<StoragePolicy>): Promise<StoragePolicy> {
  const next = sanitizePolicy({ ...(await readPolicy()), ...patch });
  await atomicWriteFile(policyPath(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function openWorkflowIds(): Set<string> {
  const ws = snapshot();
  return new Set([...ws.workflows.map((w) => w.workflowId), ...ws.clusters.flatMap((c) => c.memberIds)]);
}

export interface ProjectOverview {
  path: string; kind: 'project' | 'chat'; stateBytes: number;
  buckets: Partial<Record<StorageBucketName, number>>;
  biggest: StorageFile | null; conversations: number; openConversations: number;
  archives: Array<{ workflowId: string; bytes: number; archivedAt: number }>; errors: number;
}
export interface StorageOverview {
  measuredAt: number; totalBytes: number;
  home: { stateBytes: number; buckets: Partial<Record<StorageBucketName, number>>; biggest: StorageFile | null };
  projects: ProjectOverview[];
  budget: { enabled: boolean; limitBytes: number; over: boolean };
}

function bucketBytes(buckets: Record<string, { bytes: number }>): Partial<Record<StorageBucketName, number>> {
  const out: Partial<Record<StorageBucketName, number>> = {};
  for (const [name, b] of Object.entries(buckets)) if (b.bytes > 0) out[name as StorageBucketName] = b.bytes;
  return out;
}

async function stateFolders(): Promise<Array<{ path: string; kind: 'project' | 'chat' }>> {
  const seen = new Set<string>();
  const out: Array<{ path: string; kind: 'project' | 'chat' }> = [];
  const add = (p: string, kind: 'project' | 'chat') => { const r = path.resolve(p); if (!seen.has(r)) { seen.add(r); out.push({ path: r, kind }); } };
  for (const p of await projectPaths().catch(() => [])) add(p, 'project');
  for (const p of await readKnownCwds().catch(() => [])) if (isChatStorage(p)) add(p, 'chat');
  return out;
}

async function stateDir(cwd: string): Promise<string | null> {
  const dir = path.join(cwd, '.arco');
  try { const st = await fs.lstat(dir); return st.isDirectory() ? dir : null; } catch { return null; }
}

let cached: { promise: Promise<StorageOverview>; at: number } | null = null;

// One scan of every known project and chat state folder and Arco's own
// folder, one worker at a time. Cached; `refresh` measures again.
export function storageOverview(refresh = false): Promise<StorageOverview> {
  if (!cached || refresh) {
    const promise = measureAll();
    cached = { promise, at: Date.now() };
    promise.catch(() => { if (cached?.promise === promise) cached = null; });
  }
  return cached.promise;
}

export function cachedOverviewAge(): number | null { return cached ? Date.now() - cached.at : null; }

async function measureAll(): Promise<StorageOverview> {
  const open = openWorkflowIds();
  const projects: ProjectOverview[] = [];
  for (const folder of await stateFolders()) {
    const dir = await stateDir(folder.path);
    if (!dir) continue;
    const report = await scanStorage(dir, null, { open: [...open] });
    projects.push({
      path: folder.path, kind: folder.kind, stateBytes: report.stateBytes, buckets: bucketBytes(report.buckets),
      biggest: report.largestFiles[0] ?? null, conversations: report.workflows.length,
      openConversations: report.workflows.filter((w) => w.open).length,
      archives: await listArchives(folder.path), errors: report.errors,
    });
  }
  projects.sort((a, b) => b.stateBytes - a.stateBytes);
  const home = await scanStorage(arcoHome(), null, { scope: 'home' });
  const totalBytes = home.stateBytes + projects.reduce((n, p) => n + p.stateBytes, 0);
  const policy = await readPolicy();
  const limitBytes = policy.budgetGiB * GiB;
  return {
    measuredAt: Date.now(), totalBytes,
    home: { stateBytes: home.stateBytes, buckets: bucketBytes(home.buckets), biggest: home.largestFiles[0] ?? null },
    projects,
    budget: { enabled: policy.budgetNotice, limitBytes, over: policy.budgetNotice && totalBytes > limitBytes },
  };
}

// Conversations closed for at least `days` days: not open, not working, not
// wholly kept, last written (meta.json or a log file) before the cutoff.
export async function staleConversations(cwd: string, days: number, now = Date.now()): Promise<string[]> {
  const root = path.join(cwd, '.arco', 'workflows');
  const open = openWorkflowIds();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let names: string[] = [];
  try { names = await fs.readdir(root); } catch { return []; }
  const out: string[] = [];
  for (const id of names) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || open.has(id) || workflows.get(id)?.busy) continue;
    const dir = path.join(root, id);
    let latest = 0;
    try {
      for (const name of await fs.readdir(dir)) {
        if (name !== 'meta.json' && !name.startsWith('events.')) continue;
        latest = Math.max(latest, (await fs.lstat(path.join(dir, name))).mtimeMs);
      }
    } catch { continue; }
    if (!latest || latest > cutoff) continue;
    const keep = await readKeep(dir);
    if (!keep.ok || isKept(keep.items, '.')) continue;
    out.push(id);
  }
  return out;
}

// The opt-in rule: archive conversations closed for more than N days. Never
// deletes. Returns how many were archived.
export async function runAutoArchive(): Promise<number> {
  const policy = await readPolicy();
  if (!policy.autoArchiveClosedDays) return 0;
  let archived = 0;
  for (const folder of await stateFolders()) {
    for (const id of await staleConversations(folder.path, policy.autoArchiveClosedDays)) {
      try { await archiveConversation(folder.path, id, { open: false, busy: false, by: 'policy' }); archived++; }
      catch (err) { console.error(`[arco] auto-archive skipped ${id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
  return archived;
}

let timer: NodeJS.Timeout | null = null;
// Daily: the auto-archive rule (when on) and a fresh measurement for the
// disk-budget notice (when on). The first run waits ten minutes after start.
export function startStoragePolicy(): void {
  if (timer || process.env.ARCO_STORAGE_POLICY === '0') return;
  const run = async () => {
    try {
      const policy = await readPolicy();
      if (policy.autoArchiveClosedDays) await runAutoArchive();
      if (policy.budgetNotice) await storageOverview(true);
    } catch (err) { console.error('[arco] storage policy run failed:', err); }
  };
  timer = setTimeout(function tick() { void run().finally(() => { timer = setTimeout(tick, 24 * 60 * 60 * 1000); timer.unref(); }); }, 10 * 60 * 1000);
  timer.unref();
}
