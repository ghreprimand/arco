// Agent-instruction-file tune-up primitive — see shared/src/protocol/mdTuneup.ts
// for the full flow + fence rationale. Mirrors runDocEdit.ts: a SHORT-LIVED,
// READ-ONLY worker (NO Write/Edit/Bash mutation) runs ONE bounded turn and
// PROPOSES a compacted version of the file. Its entire output is the proposal,
// surfaced to the operator as a diff via `md_tuneup_proposed`. The agent never
// touches disk; the operator reviews and approves, and the backup + write
// happen server-side in handleMdTuneupAccept (workflowHandlers.ts).

import { promises as fs } from 'fs';
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
} from '@arco/shared';

// Dirs never worth scanning for instruction files — heavy, vendored, or
// Arco's own state. Keeps discovery bounded on large repos.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.arco', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', 'vendor', '.venv', 'venv', '__pycache__', 'target',
]);
const DISCOVERY_MAX_DEPTH = 6;
const INSTRUCTION_NAME_SET = new Set<string>(INSTRUCTION_FILE_NAMES);

export async function discoverInstructionFiles(cwd: string): Promise<MdTuneupCandidate[]> {
  const found: MdTuneupCandidate[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > DISCOVERY_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip silently
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        await walk(path.join(dir, ent.name), depth + 1);
      } else if (ent.isFile() && INSTRUCTION_NAME_SET.has(ent.name)) {
        const abs = path.join(dir, ent.name);
        let bytes = 0;
        try { bytes = (await fs.stat(abs)).size; } catch { /* ignore */ }
        found.push({ path: path.relative(cwd, abs), baseName: ent.name, bytes });
      }
    }
  };
  await walk(cwd, 0);
  // Shallowest path first, then alphabetical — root CLAUDE.md/AGENTS.md lead.
  found.sort((a, b) => {
    const da = a.path.split(path.sep).length;
    const db = b.path.split(path.sep).length;
    return da !== db ? da - db : a.path.localeCompare(b.path);
  });
  return found;
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
): Promise<{ backupPath: string; bytesWritten: number }> {
  if (!proposed || !proposed.trim()) {
    throw new Error('Refusing to write an empty instruction file.');
  }
  const abs = resolveWithinCwd(cwd, filePath);
  const baseName = path.basename(abs);
  const current = await fs.readFile(abs, 'utf8');
  const backupDir = resolveWithinCwd(cwd, path.join('.arco', 'md-backups'));
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${baseName}.${stamp}.bak`);
  const fh = await fs.open(backupPath, 'w');
  try {
    await fh.writeFile(current, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.writeFile(abs, proposed, 'utf8');
  return { backupPath, bytesWritten: Buffer.byteLength(proposed, 'utf8') };
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
        // The proposal is read carefully as a diff — never caveman/lite.
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
