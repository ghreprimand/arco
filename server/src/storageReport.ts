import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface StorageFile { path: string; bytes: number }
export interface StorageBucket { bytes: number; allocatedBytes: number; files: number }
// Every byte under a scanned root lands in exactly one bucket. Extra hard links
// to an already counted file are reported once in `hardLinkBytes` and are not
// added to any bucket. A nested state folder (another project's state, such as
// a chat or Genesis project inside the home folder) is skipped and counted in
// `nestedFolders`; it is measured as its own project.
export const STORAGE_BUCKETS = [
  'events', 'artifacts', 'handoffs', 'checkpoints', 'scratch', 'conversationFiles',
  'plans', 'boards', 'worktrees', 'savedClusters', 'voiceAndModels', 'caches',
  'providerData', 'logs', 'other',
] as const;
export type StorageBucketName = typeof STORAGE_BUCKETS[number];
export interface StorageWorkflow {
  id: string; open: boolean; lastActive: number; eventBytes: number;
  eventTypes: Record<string, number>; artifactBytes: number; handoffBytes: number;
  checkpointBytes: number; scratchBytes: number; otherBytes: number;
  largestFiles: StorageFile[]; largeFiles: StorageFile[]; errors: number;
}
export interface StorageReport {
  measuredAt: number; scope: 'project' | 'home'; stateBytes: number; allocatedBytes: number;
  hardLinkBytes: number; nestedFolders: number; checkpointBytes: number;
  buckets: Record<StorageBucketName, StorageBucket>;
  workflows: StorageWorkflow[]; largestFiles: StorageFile[]; largeFiles: StorageFile[]; errors: number;
}

export const LARGE_FILE_BYTES = 500 * 1024 * 1024;

// Parsing and directory traversal run in a worker: even one oversized JSONL
// record cannot stall the HTTP server. Symlinks are never followed.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createBrotliDecompress } = require('node:zlib');
const path = require('node:path');
const LIMIT = 10, LARGE = workerData.large, NAMES = workerData.names;
function emptyBuckets() { const b = {}; for (const n of NAMES) b[n] = { bytes: 0, allocatedBytes: 0, files: 0 }; return b; }
function pushLargest(list, item) { list.push(item); list.sort((a, b) => b.bytes - a.bytes); if (list.length > LIMIT) list.pop(); }
function isEventLog(name) { return name === 'events.jsonl' || /^events\.[0-9]+-[0-9]+\.jsonl\.br$/.test(name); }
// rel: path segments below the scanned root.
function classifyProject(rel) {
  if (rel[0] === 'workflows' && rel.length >= 3) {
    const part = rel[2];
    if (rel.length === 3 && isEventLog(part)) return 'events';
    if (part === 'artifacts') return 'artifacts';
    if (part === 'handoffs') return 'handoffs';
    if (part === 'checkpoints') return 'checkpoints';
    if (part === 'scratch') return 'scratch';
    return 'conversationFiles';
  }
  if (rel[0] === 'plans') return 'plans';
  if (rel[0] === 'project') return 'boards';
  if (rel[0] === 'worktrees') return 'worktrees';
  if (rel[0] === 'scratch') return 'scratch';
  if (rel.length === 1 && /\.log$/.test(rel[0])) return 'logs';
  return 'other';
}
function classifyHome(rel) {
  const top = rel[0];
  if (top === 'checkpoints') return 'checkpoints';
  if (top === 'worktrees' || top === 'bakeoffs') return 'worktrees';
  if (top === 'clusters' && rel[2] === 'isolates') return 'worktrees';
  if (top === 'cluster-snapshots') return 'savedClusters';
  if (top === 'voice' || top === 'models') return 'voiceAndModels';
  if (top === 'media-scratch') return 'scratch';
  if (top === 'cache' || top === 'browser-profile' || top === 'cli-snapshots' || /^camoufox-/.test(top)) return 'caches';
  if (top === 'provider-accounts') return 'providerData';
  if (top === 'logs' || (rel.length === 1 && /\.log$/.test(top))) return 'logs';
  return 'other';
}
async function eventTypes(file, counts) {
  try {
    const st = await fs.lstat(file); if (!st.isFile()) return 0;
    let stream = createReadStream(file);
    if (file.endsWith('.br')) stream = stream.pipe(createBrotliDecompress());
    let parts = [], length = 0;
    const type = () => {
      let t = '(unreadable)';
      try { const e = JSON.parse(Buffer.concat(parts, length).toString('utf8')); if (typeof e.type === 'string') t = e.type; } catch {}
      return t;
    };
    for await (const chunk of stream) {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
        const part = chunk.subarray(start, i); parts.push(part); length += part.length;
        const t = type(); counts[t] = (counts[t] || 0) + length + 1; parts = []; length = 0; start = i + 1;
      }
      if (start < chunk.length) { const part = chunk.subarray(start); parts.push(part); length += part.length; }
    }
    if (length) { const t = type(); counts[t] = (counts[t] || 0) + length; }
    return 0;
  } catch (e) { return e.code === 'ENOENT' ? 0 : 1; }
}
async function walk(root, scope, stateName, open) {
  const buckets = emptyBuckets(); const seen = new Set(); const workflows = new Map();
  let total = 0, allocated = 0, hardLinkBytes = 0, nestedFolders = 0, errors = 0;
  const largest = [], largeFiles = [];
  const classify = scope === 'home' ? classifyHome : classifyProject;
  const stack = [[root, []]];
  while (stack.length) {
    const [dir, rel] = stack.pop(); let entries;
    try { if (!(await fs.lstat(dir)).isDirectory()) continue; entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') errors++; continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name), r = rel.concat(entry.name);
      if (entry.isDirectory()) {
        if (entry.name === stateName) { nestedFolders++; continue; }
        stack.push([p, r]); continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try { st = await fs.lstat(p); if (!st.isFile()) continue; } catch { errors++; continue; }
      if (st.nlink > 1) {
        const key = st.dev + ':' + st.ino;
        if (seen.has(key)) { hardLinkBytes += st.size; continue; }
        seen.add(key);
      }
      const bucket = classify(r); const alloc = (st.blocks || 0) * 512;
      buckets[bucket].bytes += st.size; buckets[bucket].allocatedBytes += alloc; buckets[bucket].files++;
      total += st.size; allocated += alloc;
      if (st.size >= LARGE) largeFiles.push({ path: p, bytes: st.size });
      pushLargest(largest, { path: p, bytes: st.size });
      if (scope === 'project' && r[0] === 'workflows' && r.length >= 3 && /^[a-zA-Z0-9-]{1,64}$/.test(r[1])) {
        let w = workflows.get(r[1]);
        if (!w) {
          w = { id: r[1], open: open.includes(r[1]), lastActive: 0, eventBytes: 0, eventTypes: Object.create(null),
            artifactBytes: 0, handoffBytes: 0, checkpointBytes: 0, scratchBytes: 0, otherBytes: 0,
            largestFiles: [], largeFiles: [], errors: 0, logs: [] };
          workflows.set(r[1], w);
        }
        w.lastActive = Math.max(w.lastActive, st.mtimeMs);
        if (bucket === 'events') { w.eventBytes += st.size; w.logs.push(p); }
        else if (bucket === 'artifacts') w.artifactBytes += st.size;
        else if (bucket === 'handoffs') w.handoffBytes += st.size;
        else if (bucket === 'checkpoints') w.checkpointBytes += st.size;
        else if (bucket === 'scratch') w.scratchBytes += st.size;
        else w.otherBytes += st.size;
        if (st.size >= LARGE) w.largeFiles.push({ path: p, bytes: st.size });
        pushLargest(w.largestFiles, { path: p, bytes: st.size });
      }
    }
  }
  const list = [];
  for (const w of workflows.values()) {
    for (const log of w.logs.sort()) w.errors += await eventTypes(log, w.eventTypes);
    delete w.logs; list.push(w);
  }
  const size = (w) => w.eventBytes + w.artifactBytes + w.handoffBytes + w.checkpointBytes + w.scratchBytes + w.otherBytes;
  list.sort((a, b) => size(b) - size(a));
  return { buckets, total, allocated, hardLinkBytes, nestedFolders, errors, largest, largeFiles, workflows: list };
}
async function sizeOf(root) {
  let bytes = 0, errors = 0; const stack = [root];
  while (stack.length) {
    const dir = stack.pop(); let entries;
    try { if (!(await fs.lstat(dir)).isDirectory()) continue; entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') errors++; continue; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(p); continue; }
      if (!entry.isFile()) continue;
      try { const st = await fs.lstat(p); if (st.isFile()) bytes += st.size; } catch { errors++; }
    }
  }
  return { bytes, errors };
}
(async () => {
  const { root, scope, stateName, open, checkpointRoot } = workerData;
  const result = await walk(root, scope, stateName, open);
  const shared = checkpointRoot ? await sizeOf(checkpointRoot) : { bytes: 0, errors: 0 };
  parentPort.postMessage({ measuredAt: Date.now(), scope, stateBytes: result.total, allocatedBytes: result.allocated,
    hardLinkBytes: result.hardLinkBytes, nestedFolders: result.nestedFolders, checkpointBytes: shared.bytes,
    buckets: result.buckets, workflows: result.workflows, largestFiles: result.largest, largeFiles: result.largeFiles,
    errors: result.errors + shared.errors });
})().catch(e => { throw e; });
`;

export interface ScanOptions {
  scope?: 'project' | 'home';
  // Name of a state folder. A directory with this name below the scanned root
  // is another project's state and is skipped (it is measured on its own).
  stateName?: string;
  open?: string[];
}

export function scanStorage(stateRoot: string, checkpointRoot: string | null, opts: ScanOptions | string[] = {}): Promise<StorageReport> {
  const o: ScanOptions = Array.isArray(opts) ? { open: opts } : opts;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        root: stateRoot, checkpointRoot, scope: o.scope ?? 'project', names: [...STORAGE_BUCKETS],
        stateName: o.stateName ?? '.arco', open: o.open ?? [], large: LARGE_FILE_BYTES,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Storage scan failed (${code})`)); });
  });
}
export function projectCheckpointRoot(home: string, cwd: string): string {
  const hash = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(home, 'checkpoints', hash);
}
