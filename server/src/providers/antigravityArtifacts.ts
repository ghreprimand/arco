import { constants } from 'fs';
import { access, copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { artifactsDir } from '../workers/limits.js';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS]);
const EXCLUDED_DIRS = new Set([
  '.archon',
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.system_generated',
  '__pycache__',
  'target',
  'vendor',
]);
const MAX_SCAN_FILES = 10_000;
const MAX_COPY_BYTES = 25 * 1024 * 1024;

export interface AntigravityArtifactSnapshotEntry {
  size: number;
  mtimeMs: number;
}

export type AntigravityArtifactSnapshot = Map<string, AntigravityArtifactSnapshotEntry>;

export interface AntigravityArtifactRecord {
  sourcePath: string;
  copiedPath: string;
  artifactName: string;
  kind: 'text' | 'image';
  detectedFrom: 'workflow-cwd' | 'brain-dir' | 'explicit-step';
  workflowId: string;
  cascadeId?: string;
  copiedAt: string;
  size: number;
}

export interface AntigravityArtifactIngestResult {
  records: AntigravityArtifactRecord[];
  metadataPath: string;
  rejectedCount: number;
  scanned: {
    workflowCwd: boolean;
    brainDir?: string;
  };
}

export function antigravityBrainDir(cascadeId: string): string {
  return path.join(homedir(), '.gemini', 'antigravity', 'brain', cascadeId);
}

export function shouldScanWorkflowCwdForArtifacts(prompt: string): boolean {
  return /\b(save|saved|create|created|write|wrote|generate|generated|export|artifact|file|markdown|image|png|jpe?g|webp|gif|json|txt|md)\b/i.test(prompt);
}

function promptNamedArtifactBasenames(prompt: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z0-9._/-]+\.(?:md|txt|json|png|jpe?g|webp|gif)\b/gi;
  for (const match of prompt.matchAll(re)) {
    const raw = match[0].replace(/^[`'"]+|[`'",.;:)]+$/g, '');
    const base = path.basename(raw);
    if (base && artifactKindForPath(base)) out.add(base.toLowerCase());
  }
  return out;
}

export async function snapshotAntigravityArtifactFiles(root: string): Promise<AntigravityArtifactSnapshot> {
  const out: AntigravityArtifactSnapshot = new Map();
  const resolvedRoot = path.resolve(root);
  let seen = 0;

  async function walk(dir: string): Promise<void> {
    if (seen >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= MAX_SCAN_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.gemini') {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      try {
        const st = await stat(full);
        if (!st.isFile()) continue;
        if (st.size <= 0 || st.size > MAX_COPY_BYTES) continue;
        seen += 1;
        out.set(path.resolve(full), { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Best-effort snapshot; unreadable files are not candidates.
      }
    }
  }

  await walk(resolvedRoot);
  return out;
}

function artifactKindForPath(filePath: string): 'text' | 'image' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function sanitizeFileName(name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const safeStem = stem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'antigravity-artifact';
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `${safeStem}${safeExt}`;
}

async function chooseCollisionSafePath(dir: string, sourcePath: string): Promise<{ dest: string; name: string }> {
  const base = sanitizeFileName(path.basename(sourcePath));
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = path.join(dir, base);
  let n = 0;
  while (true) {
    try {
      await access(candidate, constants.F_OK);
      n += 1;
      candidate = path.join(dir, `${stem}-${n}${ext}`);
    } catch {
      return { dest: candidate, name: path.basename(candidate) };
    }
  }
}

async function readExistingSourceMap(metadataPath: string): Promise<Map<string, AntigravityArtifactRecord>> {
  const out = new Map<string, AntigravityArtifactRecord>();
  try {
    const body = await readFile(metadataPath, 'utf8');
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as AntigravityArtifactRecord;
        if (rec.sourcePath && rec.copiedPath) out.set(path.resolve(rec.sourcePath), rec);
      } catch {
        // Ignore malformed historical rows; keep appending valid JSONL.
      }
    }
  } catch {
    // Missing metadata file is normal.
  }
  return out;
}

function isPathInsideRoot(candidateRealPath: string, rootRealPath: string): boolean {
  const rel = path.relative(rootRealPath, candidateRealPath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function realDirectoryOrNull(dir: string): Promise<string | null> {
  try {
    const resolved = await realpath(dir);
    const st = await stat(resolved);
    return st.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function copyOneArtifact(args: {
  cwd: string;
  workflowId: string;
  cascadeId?: string;
  sourcePath: string;
  detectedFrom: AntigravityArtifactRecord['detectedFrom'];
  allowedRootRealPaths: string[];
  existingBySource: Map<string, AntigravityArtifactRecord>;
}): Promise<AntigravityArtifactRecord | null> {
  const sourcePath = path.resolve(args.sourcePath);
  const kind = artifactKindForPath(sourcePath);
  if (!kind) return null;
  let sourceRealPath: string;
  try {
    sourceRealPath = await realpath(sourcePath);
  } catch {
    return null;
  }
  if (!args.allowedRootRealPaths.some((root) => isPathInsideRoot(sourceRealPath, root))) return null;
  const existing = args.existingBySource.get(sourcePath) ?? args.existingBySource.get(sourceRealPath);
  if (existing) return null;
  let st;
  try {
    st = await stat(sourceRealPath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_COPY_BYTES) return null;

  const root = artifactsDir(args.cwd, args.workflowId);
  const destDir = kind === 'image' ? path.join(root, 'images') : root;
  await mkdir(destDir, { recursive: true });
  const { dest, name } = await chooseCollisionSafePath(destDir, sourcePath);
  await copyFile(sourceRealPath, dest);
  const rec: AntigravityArtifactRecord = {
    sourcePath,
    copiedPath: dest,
    artifactName: name,
    kind,
    detectedFrom: args.detectedFrom,
    workflowId: args.workflowId,
    ...(args.cascadeId ? { cascadeId: args.cascadeId } : {}),
    copiedAt: new Date().toISOString(),
    size: st.size,
  };
  args.existingBySource.set(sourcePath, rec);
  args.existingBySource.set(sourceRealPath, rec);
  return rec;
}

function newSinceSnapshot(
  after: AntigravityArtifactSnapshot,
  before: AntigravityArtifactSnapshot,
  turnStartedAt: number,
): string[] {
  const out: string[] = [];
  const threshold = turnStartedAt - 1000;
  for (const [filePath, entry] of after) {
    if (before.has(filePath)) continue;
    if (entry.mtimeMs < threshold) continue;
    out.push(filePath);
  }
  return out;
}

export async function ingestAntigravityArtifacts(args: {
  cwd: string;
  workflowId: string;
  cascadeId?: string;
  prompt: string;
  turnStartedAt: number;
  workflowSnapshotBefore?: AntigravityArtifactSnapshot;
  explicitSourcePaths?: string[];
}): Promise<AntigravityArtifactIngestResult> {
  const root = artifactsDir(args.cwd, args.workflowId);
  await mkdir(root, { recursive: true });
  const metadataPath = path.join(root, 'antigravity-artifacts.jsonl');
  const existingBySource = await readExistingSourceMap(metadataPath);
  const records: AntigravityArtifactRecord[] = [];
  let rejectedCount = 0;
  const scanned: AntigravityArtifactIngestResult['scanned'] = {
    workflowCwd: false,
  };
  const cwdRealPath = await realDirectoryOrNull(args.cwd);

  let brainRealPath: string | null = null;
  let brainDir: string | null = null;
  if (args.cascadeId) {
    brainDir = antigravityBrainDir(args.cascadeId);
    brainRealPath = await realDirectoryOrNull(brainDir);
  }

  const candidates: Array<{
    path: string;
    detectedFrom: AntigravityArtifactRecord['detectedFrom'];
    allowedRootRealPaths: string[];
  }> = [];
  for (const sourcePath of args.explicitSourcePaths ?? []) {
    candidates.push({
      path: sourcePath,
      detectedFrom: 'explicit-step',
      allowedRootRealPaths: [cwdRealPath, brainRealPath].filter((p): p is string => !!p),
    });
  }

  if (cwdRealPath && shouldScanWorkflowCwdForArtifacts(args.prompt) && args.workflowSnapshotBefore) {
    scanned.workflowCwd = true;
    const named = promptNamedArtifactBasenames(args.prompt);
    const after = await snapshotAntigravityArtifactFiles(args.cwd);
    for (const sourcePath of newSinceSnapshot(after, args.workflowSnapshotBefore, args.turnStartedAt)) {
      if (named.size > 0 && !named.has(path.basename(sourcePath).toLowerCase())) continue;
      candidates.push({ path: sourcePath, detectedFrom: 'workflow-cwd', allowedRootRealPaths: [cwdRealPath] });
    }
  }

  if (brainDir && brainRealPath) {
    scanned.brainDir = brainDir;
    const brainSnapshot = await snapshotAntigravityArtifactFiles(brainDir);
    for (const [sourcePath, entry] of brainSnapshot) {
      if (entry.mtimeMs >= args.turnStartedAt - 1000) {
        candidates.push({ path: sourcePath, detectedFrom: 'brain-dir', allowedRootRealPaths: [brainRealPath] });
      }
    }
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    const sourcePath = path.resolve(c.path);
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);
    const rec = await copyOneArtifact({
      cwd: args.cwd,
      workflowId: args.workflowId,
      cascadeId: args.cascadeId,
      sourcePath,
      detectedFrom: c.detectedFrom,
      allowedRootRealPaths: c.allowedRootRealPaths,
      existingBySource,
    });
    if (rec) records.push(rec);
    else rejectedCount += 1;
  }

  if (records.length > 0) {
    const append = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(metadataPath, append, { encoding: 'utf8', flag: 'a' });
  }

  return { records, metadataPath, rejectedCount, scanned };
}

export function formatAntigravityArtifactAppendix(records: AntigravityArtifactRecord[]): string {
  if (records.length === 0) return '';
  const lines = ['', '', 'Antigravity artifacts ingested:'];
  for (const rec of records) {
    if (rec.kind === 'text') {
      lines.push(`- [artifact:${rec.artifactName}] copied to \`${rec.copiedPath}\` (source: \`${rec.sourcePath}\`)`);
    } else {
      lines.push(`- image copied to \`${rec.copiedPath}\` (source: \`${rec.sourcePath}\`)`);
    }
  }
  return lines.join('\n');
}
