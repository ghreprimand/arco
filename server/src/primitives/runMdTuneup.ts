import { projectFiles, scanBudget } from '../projectScan.js';
import { ensureProjectStateIgnore } from '../projectStateIgnore.js';
// Agent-instruction-file tune-up primitive — see shared/src/protocol/mdTuneup.ts
// for the full flow + fence rationale. Mirrors runDocEdit.ts: a SHORT-LIVED,
// READ-ONLY worker (NO Write/Edit/Bash mutation) runs ONE bounded turn and
// PROPOSES a compacted version of the file. Its entire output is the proposal,
// surfaced to the operator as a diff via `md_tuneup_proposed`. The agent never
// touches disk; the operator reviews and approves, and the backup + write
// happen server-side in handleMdTuneupAccept (workflowHandlers.ts).

import { promises as fs } from 'fs';
import { constants } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import { WorkerManager } from '../workers/WorkerManager.js';
import { resolveWithinCwd } from '../providers/ollamaTools.js';
import { buildMdTuneupPrompt, splitTuneupOutput, instructionFileKind } from '../mdTuneupPrompt.js';
import {
  INSTRUCTION_FILE_NAMES,
  type ServerMessage,
  type ProviderName,
  type ModelName,
  type EffortLevel,
  type MdTuneupCandidate,
  type MdTuneupSkippedLink,
} from '@arco/shared';

// Dirs never worth scanning for instruction files — heavy, vendored, or
// Arco's own state. Keeps discovery bounded on large repos.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.arco', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', 'vendor', '.venv', 'venv', '__pycache__', 'target',
]);
const DISCOVERY_MAX_DEPTH = 6;
const INSTRUCTION_NAME_SET = new Set<string>(INSTRUCTION_FILE_NAMES);
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function instructionMetrics(text: string, bytes: number): Pick<MdTuneupCandidate, 'lines' | 'approximateTokens' | 'hints'> {
  const rows = text.length ? text.split('\n') : [];
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  const approximateTokens = Math.ceil(bytes / 4);
  const hints: string[] = [];
  if (rows.some((line) => /^\s*#{1,6}\s+.*(?:\b\d{4}-\d{2}-\d{2}\b|\b(?:session|log)\b)/i.test(line))) hints.push('Dated or session-log headings found.');
  const seen = new Set<string>();
  if (rows.some((line) => { const value = line.trim(); if (value.length < 16) return false; if (seen.has(value)) return true; seen.add(value); return false; })) hints.push('Repeated lines found.');
  if (rows.length > 200 || approximateTokens > 2000) hints.push('Long file: over 200 lines or approximately 2,000 tokens.');
  return { lines: rows.length, approximateTokens, hints };
}

async function candidateMetrics(abs: string, bytes: number): Promise<Pick<MdTuneupCandidate, 'lines' | 'approximateTokens' | 'hints'>> {
  if (bytes > PREVIEW_MAX_BYTES) return { approximateTokens: Math.ceil(bytes / 4), hints: ['File exceeds the 2 MiB preview and analysis limit.'] };
  const handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PREVIEW_MAX_BYTES) return { approximateTokens: Math.ceil(stat.size / 4), hints: ['File exceeds the 2 MiB preview and analysis limit.'] };
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size) throw new Error('File changed during analysis.');
    try { return instructionMetrics(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset)), offset); }
    catch { return { approximateTokens: Math.ceil(offset / 4), hints: ['File is not valid UTF-8 and cannot be safely overwritten.'] }; }
  } finally { await handle.close(); }
}

// Discover recognized instruction files at the project root and in nested
// folders. Results use project-relative paths and sort shallowest-first so
// likely top-level guidance appears before files scoped to subdirectories.
export async function discoverInstructionFilesWithLinks(cwd: string): Promise<{ candidates: MdTuneupCandidate[]; skippedLinks: MdTuneupSkippedLink[]; partial: boolean }> {
  const found: MdTuneupCandidate[] = [];
  const links: string[] = [];
  const root = await fs.realpath(cwd);
  const budget = scanBudget(20_000, 1000);
  for await (const entry of projectFiles(cwd, { budget, skip: SKIP_DIRS, respectGitIgnore: true, includeLinks: true, maxDepth: DISCOVERY_MAX_DEPTH })) {
    if (!INSTRUCTION_NAME_SET.has(entry.name)) continue;
    const info = await fs.lstat(entry.path).catch(() => null);
    if (info?.isSymbolicLink()) { links.push(entry.path); continue; }
    if (!info?.isFile()) continue;
    const metrics = await candidateMetrics(entry.path, info.size).catch(() => ({ hints: ['File could not be analyzed.'] }));
    found.push({ path: path.relative(cwd, entry.path), baseName: entry.name, bytes: info.size, ...metrics });
  }
  // Shallowest path first, then alphabetical — root CLAUDE.md/AGENTS.md lead.
  found.sort((a, b) => {
    const da = a.path.split(path.sep).length;
    const db = b.path.split(path.sep).length;
    return da !== db ? da - db : a.path.localeCompare(b.path);
  });
  const targets = new Map<string, MdTuneupCandidate>();
  for (const candidate of found) {
    const abs = path.join(cwd, candidate.path);
    try {
      const stat = await fs.lstat(abs), real = await fs.realpath(abs);
      if (stat.isFile() && !stat.isSymbolicLink() && withinRoot(root, real)) targets.set(real, candidate);
    } catch { /* candidate disappeared during the scan */ }
  }
  const skippedLinks: MdTuneupSkippedLink[] = [];
  for (const link of links) {
    const relative = path.relative(cwd, link);
    try {
      const real = await fs.realpath(link);
      if (!withinRoot(root, real)) { skippedLinks.push({ path: relative, reason: 'Target is outside this project.' }); continue; }
      const target = targets.get(real);
      if (!target) { skippedLinks.push({ path: relative, reason: 'Target is not a discovered instruction file.' }); continue; }
      (target.alsoReadAs ??= []).push(relative);
    } catch { skippedLinks.push({ path: relative, reason: 'Target cannot be resolved.' }); }
  }
  for (const candidate of found) candidate.alsoReadAs?.sort();
  skippedLinks.sort((a, b) => a.path.localeCompare(b.path));
  return { candidates: found, skippedLinks, partial: budget.partial };
}

export async function discoverInstructionFiles(cwd: string): Promise<MdTuneupCandidate[]> {
  return (await discoverInstructionFilesWithLinks(cwd)).candidates;
}

export interface MdTuneupEditorConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface MdTuneupContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface MdTuneupHandle {
  tuneupId: string;
  settled: Promise<{ proposed?: string; notes?: string; error?: string }>;
}

// Read-only local tool sets — same posture as runDocEdit. The agent gets NO
// Write/Edit/Bash; it may Read/Grep/Glob to confirm a referenced file still
// exists before deciding keep-and-flag, but it mutates nothing.
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

function toolsFor(provider: ProviderName): string[] | undefined {
  if (provider === 'claude' || provider === 'ollama' || provider === 'llamacpp' || provider === 'lmstudio' || (provider === 'strata' || provider === 'deepseek')) {
    return READ_ONLY_TOOLS;
  }
  return undefined;
}

// Defensive unwrap (same as runDocEdit): a model may wrap the whole file in a
// single fenced block despite the instruction. Strip only when the ENTIRE
// pre-sentinel content is one fence.
function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fenceOpen = /^```[^\n]*\n/;
  if (!fenceOpen.test(trimmed) || !trimmed.endsWith('```')) return text;
  const withoutOpen = trimmed.replace(fenceOpen, '');
  return withoutOpen.replace(/\n?```$/, '');
}

// Accept-path file mutation, extracted so it's unit-testable and so the
// backup-before-overwrite ordering is a single source of truth. Snapshots the
// CURRENT on-disk file (not a cached copy), writes it to
// `.arco/md-backups/<name>.<ts>.bak` and fsync-flushes it BEFORE overwriting
// the original — a crash mid-write can never lose the original. Both paths are
// guarded by resolveWithinCwd. Returns the backup path + bytes written.
export async function backupAndWriteInstructionFile(
  cwd: string,
  filePath: string,
  proposed: string,
  ts: number,
  expectedOriginal?: string,
): Promise<{ backupPath: string; bytesWritten: number; backupHash: string }> {
  if (!proposed || !proposed.trim()) {
    throw new Error('Refusing to write an empty instruction file.');
  }
  const abs = resolveWithinCwd(cwd, filePath);
  const baseName = path.basename(abs);
  const handle = await openGuardedInstructionFile(cwd, abs);
  try {
    const current = await readGuardedContent(handle);
    if (expectedOriginal !== undefined && current !== expectedOriginal) {
      throw new Error('Instruction file changed since review. Run TUNE MD again and review the new diff. Nothing was overwritten.');
    }
    const backupPath = await createTuneupBackup(cwd, baseName, current, ts);
    if (await readGuardedContent(handle) !== current) throw new Error('Instruction file changed during backup. Nothing was overwritten.');
    await assertGuardedHandleCurrent(cwd, abs, handle);
    await writeGuardedContent(handle, proposed);
    return { backupPath, bytesWritten: Buffer.byteLength(proposed, 'utf8'), backupHash: createHash('sha256').update(current, 'utf8').digest('hex') };
  } finally { await handle.close(); }
}

function withinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function openGuardedInstructionFile(cwd: string, filePath: string): Promise<FileHandle> {
  const root = await fs.realpath(cwd);
  const abs = resolveWithinCwd(cwd, filePath);
  const resolved = await fs.realpath(abs);
  if (!withinRoot(root, resolved)) throw new Error('Instruction file escapes the project.');
  const entry = await fs.lstat(abs);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Instruction file must be a regular file.');
  const handle = await fs.open(abs, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const current = await fs.lstat(abs);
    const checked = await fs.realpath(abs);
    if (!withinRoot(root, checked) || checked !== resolved || !stat.isFile() || stat.nlink > 1 || stat.dev !== current.dev || stat.ino !== current.ino || current.isSymbolicLink()) throw new Error('Instruction file changed while opening or has multiple hard links.');
    if (stat.size > 16 * 1024 * 1024) throw new Error('Instruction file exceeds the 16 MiB safety limit.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function writeGuardedContent(handle: FileHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten <= 0) throw new Error('Could not write instruction file.');
    offset += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

export async function assertGuardedHandleCurrent(cwd: string, filePath: string, handle: FileHandle): Promise<void> {
  const abs = resolveWithinCwd(cwd, filePath);
  const [root, resolved, entry, stat] = await Promise.all([fs.realpath(cwd), fs.realpath(abs), fs.lstat(abs), handle.stat()]);
  if (!withinRoot(root, resolved) || entry.isSymbolicLink() || !entry.isFile() || stat.nlink > 1 || entry.dev !== stat.dev || entry.ino !== stat.ino) throw new Error('Instruction file changed while preparing the write.');
}

export async function readGuardedContent(handle: FileHandle): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Instruction file is not a supported regular file.');
  const data = Buffer.alloc(stat.size + 1);
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.read(data, offset, data.length - offset, offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  if (offset !== stat.size) throw new Error('File changed while it was being read. Try again.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data.subarray(0, offset)); }
  catch { throw new Error('Instruction file is not valid UTF-8. Nothing was overwritten.'); }
}

export async function createTuneupBackup(cwd: string, baseName: string, current: string, ts: number): Promise<string> {
  const root = await fs.realpath(cwd);
  const stateDir = path.join(cwd, '.arco');
  const existingState = await fs.realpath(stateDir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existingState && !withinRoot(root, existingState)) throw new Error('Backup directory escapes the project.');
  const backupDir = resolveWithinCwd(cwd, path.join('.arco', 'md-backups'));
  ensureProjectStateIgnore(cwd);
  await fs.mkdir(backupDir, { recursive: true });
  const realBackupDir = await fs.realpath(backupDir);
  if (!withinRoot(root, realBackupDir)) throw new Error('Backup directory escapes the project.');
  for (let attempt = 0; attempt < 100; attempt++) {
    const stamp = new Date(ts + attempt).toISOString().replace(/[:.]/g, '-');
    const candidate = path.join(realBackupDir, `${baseName}.${stamp}.bak`);
    try {
      const fh = await fs.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fh.writeFile(current, 'utf8'); await fh.sync(); } finally { await fh.close(); }
      return candidate;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error('Could not create a unique instruction-file backup.');
}

export function runMdTuneup(
  ctx: MdTuneupContext,
  args: {
    editor: MdTuneupEditorConfig;
    // Repo-relative or absolute path the handler resolved (e.g. "CLAUDE.md").
    filePath: string;
  },
): MdTuneupHandle {
  const tuneupId = `mdt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  const settled = (async (): Promise<{ proposed?: string; notes?: string; error?: string }> => {
    // Resolve + read the target file up front so we can report originalBytes on
    // the started event and fail fast if it's missing.
    let abs: string;
    let original: string;
    try {
      abs = resolveWithinCwd(ctx.cwd, args.filePath);
      original = await fs.readFile(abs, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error = `Could not read ${args.filePath}: ${msg}`;
      ctx.broadcast({
        type: 'md_tuneup_proposed',
        workflowId: ctx.workflowId,
        tuneupId,
        filePath: args.filePath,
        baseName: path.basename(args.filePath),
        original: '',
        proposed: '',
        notes: '',
        originalBytes: 0,
        proposedBytes: 0,
        error,
        completedAt: Date.now(),
      });
      return { error };
    }

    const baseName = path.basename(abs);
    const originalBytes = Buffer.byteLength(original, 'utf8');

    ctx.broadcast({
      type: 'md_tuneup_started',
      workflowId: ctx.workflowId,
      tuneupId,
      filePath: abs,
      baseName,
      originalBytes,
      editor: {
        provider: args.editor.provider,
        model: args.editor.model,
        effort: args.editor.effort,
        providerAccountRef: args.editor.providerAccountRef,
      },
      startedAt,
    });

    const task = buildMdTuneupPrompt({ filePath: abs, baseName, fileContent: original });

    let collected = '';
    const r = await ctx.manager.spawn(
      {
        id: tuneupId,
        task,
        model: args.editor.model,
        effort: args.editor.effort,
        provider: args.editor.provider,
        // NO Write/Edit/Bash — read-only local tools only. Text output IS the
        // proposal; the operator reviews the diff and the server does the write.
        tools: toolsFor(args.editor.provider),
      },
      (ev) => {
        if (ev.type === 'worker_text') {
          collected += ev.text;
        } else if (ev.type === 'worker_system_notice') {
          ctx.broadcast({ type: 'system_notice', workflowId: ctx.workflowId, content: ev.notice });
        }
      },
      {
        cwd: ctx.cwd,
        workflowId: ctx.workflowId,
        // Read-only proposal run, same gating as runDocEdit: Claude via the
        // `tools` allowlist, Codex via `-s read-only` sandbox, Ollama via its
        // allowlist (skipPermissions so SAFE mode doesn't refuse the read tools).
        skipPermissions: args.editor.provider === 'ollama',
        sandbox: 'read-only',
        // The proposal is read carefully as a diff — never plain/terse.
        outputStyle: 'normal',
        ...(args.editor.provider === 'codex' && args.editor.codexHome
          ? { providerAccountRef: args.editor.providerAccountRef, codexHome: args.editor.codexHome }
          : {}),
      },
    );

    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'md_tuneup_proposed',
        workflowId: ctx.workflowId,
        tuneupId,
        filePath: abs,
        baseName,
        original,
        proposed: '',
        notes: '',
        originalBytes,
        proposedBytes: 0,
        error: r.error,
        completedAt,
      });
      return { error: r.error };
    }

    const raw = collected || r.text || '';
    const { fileContent, notes } = splitTuneupOutput(raw);
    const proposed = unwrapFence(fileContent).trimEnd() + '\n';

    if (!proposed.trim()) {
      const error = `${instructionFileKind(baseName)} tune-up produced an empty file — refusing to propose a blank ${baseName}.`;
      ctx.broadcast({
        type: 'md_tuneup_proposed',
        workflowId: ctx.workflowId,
        tuneupId,
        filePath: abs,
        baseName,
        original,
        proposed: '',
        notes,
        originalBytes,
        proposedBytes: 0,
        error,
        completedAt,
      });
      return { error };
    }

    ctx.broadcast({
      type: 'md_tuneup_proposed',
      workflowId: ctx.workflowId,
      tuneupId,
      filePath: abs,
      baseName,
      original,
      proposed,
      notes,
      originalBytes,
      proposedBytes: Buffer.byteLength(proposed, 'utf8'),
      completedAt,
    });
    return { proposed, notes };
  })();

  return { tuneupId, settled };
}
