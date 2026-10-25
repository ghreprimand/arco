// Phase 7a — core tool surface for Claude Native transport.
//
// Eight tools: Read / Write / Edit / Bash / Grep / Glob / KillShell /
// TodoWrite. Where the shape matches the existing Ollama tooling, we
// import and adapt rather than duplicating. New here:
//
//   • Edit — refuses if file wasn't Read in this turn (Claude-Code parity)
//   • Bash — registers the spawned shell against the worker's per-turn
//     shell map so KillShell + cancel can target it
//   • KillShell — idempotent kill of a registered shell id
//   • TodoWrite — pure worker state + broadcast for the Activity tab
//
// Read gets a 256 KB cap (looser than Ollama's 32 KB — Claude windows
// are larger). 64 KB output cap for everything else.

import { promises as fs, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolveWithinCwd } from '../ollamaTools.js';
import { withFileMutationLock } from './file-mutation-queue.js';
import { OutputAccumulator, type SpillSink } from './outputAccumulator.js';
import { applyEdit } from './editApply.js';

export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const READ_BYTE_CAP = 256 * 1024;

const BASH_TIMEOUT_DEFAULT_MS = 60_000;
const BASH_TIMEOUT_MAX_MS = 600_000;
const BASH_TIMEOUT_MIN_MS = 1_000;
// DD2 — line cap for the model-visible bash tail (the full output spills to a
// tempfile, so this only bounds what's pasted back into context).
const BASH_TAIL_MAX_LINES = 2_000;
// DD2 — grace period between SIGTERM and the SIGKILL escalation in killTree.
const KILL_GRACE_MS = 2_000;

// JS-walker fallback only — `rg` path is unbounded.
const GREP_WALK_FILE_CAP = 5000;

// Detect ripgrep once at module load. CLI shells to rg (multi-threaded, Rust,
// gitignore-aware) and is dramatically faster than the JS walker on real repos.
// Cached at module scope: spawning rg --version per Grep call would defeat the
// point.
const RIPGREP_BIN: string | null = (() => {
  try {
    const r = spawnSync('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? 'rg' : null;
  } catch { return null; }
})();

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.arco', 'dist', 'build', '.next',
  '.cache', 'target', '.venv', 'venv',
]);

export interface ShellRegistry {
  // Map shellId → handle for registered Bash invocations (foreground +
  // background). KillShell and worker.cancel() both target this map.
  byId: Map<string, { kill: () => void; backgrounded: boolean }>;
  mintId(): string;
}

export interface NativeToolContext {
  cwd: string;
  abortSignal: AbortSignal;
  shells: ShellRegistry;
  // Per-turn read-set — file paths Read'd this turn. Edit refuses if its
  // target isn't in the set. Reset by the worker on each operator turn.
  readSet: Set<string>;
  // H62 — per-turn PARTIAL read-set: paths Read with offset/limit this turn (so
  // the model never saw the whole file). A later full-file Write to one of these
  // warns (partial-read-then-full-write silently nukes the unseen tail). A
  // subsequent FULL Read of the same path removes it. Reset alongside readSet.
  // Optional so non-Native callers / tests can omit it.
  partialReadSet?: Set<string>;
  // Plan-mode gate (7b). When true, Write/Edit refuse with a plan-mode
  // notice — except for paths under <cwd>/.arco/, which stay writable so
  // the agent can keep scratchpads / draft notes / plan-body updates
  // alongside the plan it's still authoring. The worker owns the field;
  // the tools read it through this accessor so EnterPlanMode/ExitPlanMode
  // can flip it during a turn.
  planMode: boolean;
  // TodoWrite broadcast hook. Worker wires this to a workflow-scoped
  // todos_updated event that the Activity tab renders.
  onTodos: (todos: Todo[]) => void;
  // Phase 7b primitives — plumbed when the worker exposes them. The 5 new
  // tools (EnterPlanMode / ExitPlanMode / AskUserQuestion / Task / TaskOutput)
  // call into these. Older callers wiring this struct without 7b support
  // can leave them undefined; the tools surface a clear [error] in that case.
  enterPlanMode?: (plan: string) => Promise<{ warnings: string[] }>;
  exitPlanMode?: (summary: string | undefined) => Promise<void>;
  askUserQuestion?: (question: string, options: string[] | undefined) => Promise<string>;
  spawnTask?: (args: { description: string; prompt: string; subagentType?: string; model?: string }) => Promise<string>;
  readTaskOutput?: (taskId: string) => Promise<string>;
  // Phase 7b — Task tool depth cap. The worker that mints a child sets this
  // to true on the child's context; the child's tool registry refuses to
  // spawn another Task. Defaults to false (parent / standalone tab).
  taskDisabled?: boolean;
  // WORKBENCH_EXPANSION_PLAN.md §C3 — post-write diagnostics hook. Called with
  // the absolute path AFTER a successful Write/Edit. FIRE-AND-FORGET: the tools
  // never await it and the call is wrapped so a hook error can't fail the
  // write (the write path is load-bearing P0). The worker wires this to the
  // LSP subsystem; absent ⇒ no diagnostics (e.g. tests, non-Native callers).
  onFileWritten?: (absPath: string) => void;
  // DD3 (Phase 3) — fired when a Write/Edit had to WAIT for an in-flight
  // mutation of the same real file path (cluster members / Task children
  // contending for one file). `path` is cwd-relative. Worker wires it to the
  // file_mutation_queued workflow event; absent ⇒ no event (tests / non-Native).
  onFileMutationQueued?: (info: { tool: 'Write' | 'Edit'; path: string; waitedForMs: number }) => void;
}

export interface Todo {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// Anthropic's `tool` shape. Different from Ollama's openai-compat shape
// (which wraps in `{type:'function', function:{name,description,parameters}}`).
export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolExec = (args: Record<string, unknown>, ctx: NativeToolContext) => Promise<string>;

interface Entry {
  def: ClaudeToolDef;
  execute: ToolExec;
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}
function asOptString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}
function asOptBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`argument "${name}" must be a boolean`);
  return v;
}
function asOptNumber(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`argument "${name}" must be a finite number`);
  return v;
}

function truncate(text: string, cap: number, what: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n[truncated — ${what} exceeded ${cap} bytes]`;
}

// Plan-mode write gate: refuses Write/Edit unless the resolved target
// lives strictly under <cwd>/.arco/. The agent legitimately needs
// scratchpad space (notes, draft plan bodies, etc.) while planning.
// `abs` must be the already-resolved absolute path (resolveWithinCwd's
// return value) so traversal like ".arco/../escape.txt" — which
// collapses to <cwd>/ before we get here — refuses correctly.
function refuseIfPlanModeOutsideArco(ctx: NativeToolContext, abs: string): void {
  if (!ctx.planMode) return;
  const arcoRoot = resolve(ctx.cwd, '.arco');
  const rel = relative(arcoRoot, abs);
  if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return;
  throw new Error('write tools disabled until ExitPlanMode (writes under <cwd>/.arco/ are exempt)');
}

// H47 — sensitive-path write floor. A small, fixed set of high-risk write
// targets (credential files, VCS internals, key material) that must get an
// explicit operator OK before the write lands — even outside plan mode. This is
// a FLOOR, not a tiered policy: model-proposes, operator-one-clicks, reversible.
// `abs` is the already-resolved absolute path.
const SENSITIVE_DIR_SEGMENTS = new Set(['.git', '.ssh']);
export function isSensitiveWritePath(abs: string): boolean {
  const parts = abs.split('/');
  const base = parts[parts.length - 1] ?? '';
  // .env and its variants (.env.local, .env.production, …).
  if (base === '.env' || base.startsWith('.env.')) return true;
  // SSH/host private keys.
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  // PEM key/cert material.
  if (base.endsWith('.pem')) return true;
  // Anything inside a .git or .ssh directory (a literal path component, so
  // `.gitignore` — a plain file, not the `.git` dir — does NOT match).
  if (parts.some((p) => SENSITIVE_DIR_SEGMENTS.has(p))) return true;
  return false;
}

// Gate a write to a sensitive path on explicit operator approval, reusing the
// existing AskUserQuestion machinery (no parallel approval system). Throws to
// abort the write when blocked. FAIL-CLOSED: if no approval channel is wired
// (tests / non-Native callers), the sensitive write is refused rather than
// silently allowed.
async function gateSensitiveWrite(ctx: NativeToolContext, abs: string, tool: 'Write' | 'Edit'): Promise<void> {
  if (!isSensitiveWritePath(abs)) return;
  const rel = relative(ctx.cwd, abs);
  if (!ctx.askUserQuestion) {
    throw new Error(`${tool} to sensitive path "${rel}" requires operator review, which is unavailable in this context`);
  }
  const answer = await ctx.askUserQuestion(
    `Allow ${tool} to sensitive path "${rel}"? It may hold secrets, key material, or VCS internals.`,
    ['Allow this write', 'Block'],
  );
  // Treat anything other than an explicit allow as a block (fail-closed).
  if (!/^allow/i.test(answer.trim())) {
    throw new Error(`${tool} to sensitive path "${rel}" was blocked by the operator`);
  }
}

// DD3 — run a Write/Edit's read-modify-write under the per-realpath mutation
// lock so concurrent mutations of the same file (cluster members / Task
// children) serialize instead of clobbering each other. Emits
// file_mutation_queued (via ctx) only when this write actually had to wait.
function runUnderMutationLock<T>(
  ctx: NativeToolContext,
  abs: string,
  tool: 'Write' | 'Edit',
  fn: () => Promise<T>,
): Promise<T> {
  let queuedAt = 0;
  return withFileMutationLock(
    abs,
    async () => {
      if (queuedAt) {
        ctx.onFileMutationQueued?.({ tool, path: relative(ctx.cwd, abs), waitedForMs: Math.max(0, Date.now() - queuedAt) });
      }
      return fn();
    },
    () => { queuedAt = Date.now(); },
  );
}

// ── Read ──
const ReadTool: Entry = {
  def: {
    name: 'Read',
    description: 'Read the contents of a file at the given path. Path must resolve inside the workflow cwd. Default returns up to 256 KB; pass `offset` (1-based line) + `limit` to chunk larger files.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file. Relative paths resolve against cwd.' },
        offset: { type: 'number', description: 'Optional 1-based starting line number.' },
        limit: { type: 'number', description: 'Optional max lines to return.' },
      },
      required: ['file_path'],
    },
  },
  execute: async (args, ctx) => {
    const filePath = asString(args.file_path, 'file_path');
    const offset = Math.max(1, Math.floor(asOptNumber(args.offset, 'offset') ?? 1));
    const rawLimit = asOptNumber(args.limit, 'limit');
    const limit = rawLimit !== undefined && rawLimit >= 1 ? Math.floor(rawLimit) : undefined;
    const abs = resolveWithinCwd(ctx.cwd, filePath);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`"${filePath}" is a directory; use Glob to list contents`);
    const buf = await fs.readFile(abs);
    const text = buf.toString('utf8');
    let body = text;
    let totalLines = -1;
    if (offset > 1 || limit !== undefined) {
      const lines = text.split('\n');
      totalLines = lines.length;
      const start = Math.min(offset - 1, lines.length);
      const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
      body = lines.slice(start, end).join('\n');
    }
    if (body.length > READ_BYTE_CAP) {
      const note = totalLines > 0
        ? `\n\n[truncated at ${READ_BYTE_CAP} bytes — file has ${totalLines} lines; use offset+limit to read a smaller range]`
        : `\n\n[truncated at ${READ_BYTE_CAP} bytes — pass offset+limit to read a specific line range]`;
      body = body.slice(0, READ_BYTE_CAP) + note;
    }
    ctx.readSet.add(abs);
    // H62 — flag a partial read (offset/limit) so a later full-file Write warns;
    // a FULL read clears any prior partial flag (the model has now seen it all).
    const partial = offset > 1 || limit !== undefined;
    if (partial) ctx.partialReadSet?.add(abs);
    else ctx.partialReadSet?.delete(abs);
    return body;
  },
};

// ── Write ──
const WriteTool: Entry = {
  def: {
    name: 'Write',
    description: 'Write `content` to a file at `file_path`, replacing existing contents. Creates parent directories as needed. Path must resolve inside the workflow cwd.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target path.' },
        content: { type: 'string', description: 'New file contents.' },
      },
      required: ['file_path', 'content'],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.cwd) throw new Error('Write requires a workflow cwd');
    const filePath = asString(args.file_path, 'file_path');
    const content = asString(args.content, 'content');
    const abs = resolveWithinCwd(ctx.cwd, filePath);
    refuseIfPlanModeOutsideArco(ctx, abs);
    await gateSensitiveWrite(ctx, abs, 'Write'); // H47 — operator OK for secret/VCS paths
    // DD3 — the stat→mkdir→writeFile RMW runs under the per-realpath lock so a
    // concurrent mutation of the same file can't interleave and lose this write.
    return runUnderMutationLock(ctx, abs, 'Write', async () => {
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) throw new Error(`"${filePath}" is an existing directory`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const parent = abs.slice(0, abs.lastIndexOf('/'));
      if (parent && parent !== resolve(ctx.cwd)) {
        await fs.mkdir(parent, { recursive: true });
      }
      await fs.writeFile(abs, content, 'utf8');
      // §C3 — fire-and-forget LSP diagnostics. Never awaited; wrapped so a hook
      // error can't fail the Write (diagnostics are best-effort).
      try { ctx.onFileWritten?.(abs); } catch { /* diagnostics are best-effort */ }
      return `wrote ${content.length} bytes to ${relative(ctx.cwd, abs)}`;
    });
  },
};

// ── Edit ──
const EditTool: Entry = {
  def: {
    name: 'Edit',
    description: 'Replace `old_string` with `new_string` in `file_path`. The file must have been Read in this turn (Claude-Code parity — prevents blind edits). Pass `replace_all: true` to replace every occurrence; otherwise `old_string` must be unique.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target file. Must have been Read in this turn.' },
        old_string: { type: 'string', description: 'Exact string to find. Must be unique unless replace_all is true.' },
        new_string: { type: 'string', description: 'Replacement string.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.cwd) throw new Error('Edit requires a workflow cwd');
    const filePath = asString(args.file_path, 'file_path');
    const oldStr = asString(args.old_string, 'old_string');
    const newStr = asString(args.new_string, 'new_string');
    const replaceAll = asOptBool(args.replace_all, 'replace_all') ?? false;
    const abs = resolveWithinCwd(ctx.cwd, filePath);
    refuseIfPlanModeOutsideArco(ctx, abs);
    await gateSensitiveWrite(ctx, abs, 'Edit'); // H47 — operator OK for secret/VCS paths
    if (!ctx.readSet.has(abs)) {
      throw new Error(`"${filePath}" was not Read in this turn — Read it first, then Edit`);
    }
    // DD3 — the readFile→splice→writeFile RMW runs under the per-realpath lock.
    // The read MUST be inside the lock: reading the pre-image outside it would
    // reintroduce the lost-write race (splice a stale copy, overwrite a peer's
    // change). The readSet check above is pure validation and stays outside.
    return runUnderMutationLock(ctx, abs, 'Edit', async () => {
      const buf = await fs.readFile(abs, 'utf8');
      // H50 — exact-first with a deterministic fuzzy fallback chain (escape-drift,
      // trailing-ws, indent). On a true no-match the result carries a "closest
      // lines" hint so the model can fix old_string without re-Reading.
      const r = applyEdit(buf, oldStr, newStr, replaceAll);
      if (!r.applied || r.updated === undefined) {
        throw new Error(`${r.reason ?? 'old_string not found'} (in ${filePath})`);
      }
      await fs.writeFile(abs, r.updated, 'utf8');
      // §C3 — fire-and-forget LSP diagnostics. Never awaited; wrapped so a hook
      // error can't fail the Edit (diagnostics are best-effort).
      try { ctx.onFileWritten?.(abs); } catch { /* diagnostics are best-effort */ }
      const via = r.strategy && r.strategy !== 'exact' ? ` (matched via ${r.strategy} fallback)` : '';
      const where = (r.count ?? 1) > 1 ? ` (${r.count} occurrences)` : '';
      return `applied edit to ${relative(ctx.cwd, abs)}${where}${via}`;
    });
  },
};

// ── Glob ──
const GlobTool: Entry = {
  def: {
    name: 'Glob',
    description: 'List files matching a glob pattern (e.g. "**/*.ts"). Searches under the workflow cwd unless `path` narrows the base. Doubles as the directory listing tool.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. Supports **, *, ?, {a,b}.' },
        path: { type: 'string', description: 'Optional base directory inside cwd.' },
      },
      required: ['pattern'],
    },
  },
  execute: async (args, ctx) => {
    const pattern = asString(args.pattern, 'pattern');
    const basePath = asOptString(args.path, 'path');
    const baseAbs = basePath ? resolveWithinCwd(ctx.cwd, basePath) : resolve(ctx.cwd);
    const out: string[] = [];
    const globIter = (fs as unknown as { glob: (p: string, o: { cwd: string }) => AsyncIterable<string> }).glob(pattern, { cwd: baseAbs });
    for await (const entry of globIter) {
      try { resolveWithinCwd(ctx.cwd, join(baseAbs, entry)); }
      catch { continue; }
      out.push(entry);
      if (out.length >= 1000) break;
    }
    if (out.length === 0) return '(no matches)';
    return truncate(out.join('\n'), MAX_TOOL_OUTPUT_BYTES, 'Glob result');
  },
};

// ── Grep ──
// ripgrep path. Spawns rg with output collected into a byte-capped buffer so
// huge results truncate cleanly without OOM. Note: rg uses Rust regex syntax,
// the JS walker uses JS regex — for simple patterns the two agree, complex
// ones may differ. CLI also shells to rg, so this is CLI-parity behavior.
async function runRipgrep(
  bin: string,
  pattern: string,
  baseAbs: string,
  cwd: string,
  opts: { ci: boolean; filesOnly: boolean },
): Promise<string> {
  const args: string[] = ['--no-messages', '--no-heading'];
  if (opts.ci) args.push('-i');
  if (opts.filesOnly) args.push('-l');
  else args.push('-n', '-H');
  args.push('-e', pattern, baseAbs);

  return new Promise((resolveP) => {
    const child = spawn(bin, args, { cwd });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    let killed = false;
    child.stdout.on('data', (buf: Buffer) => {
      if (capped) return;
      const room = MAX_TOOL_OUTPUT_BYTES - bytes;
      if (buf.length <= room) {
        chunks.push(buf);
        bytes += buf.length;
      } else {
        if (room > 0) { chunks.push(buf.subarray(0, room)); bytes += room; }
        capped = true;
        if (!killed) { killed = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }
      }
    });
    child.on('error', () => resolveP('(rg failed to spawn)'));
    child.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Rewrite absolute paths to cwd-relative for parity with JS walker.
      const rel = raw.split('\n').map((line) => {
        if (!line) return line;
        const idx = line.indexOf(baseAbs);
        if (idx !== 0) return line;
        const tail = line.slice(baseAbs.length).replace(/^\//, '');
        const baseRel = relative(cwd, baseAbs);
        return baseRel ? `${baseRel}/${tail}` : tail;
      }).join('\n').trimEnd();
      if (!rel) return resolveP('(no matches)');
      const suffix = capped ? `\n\n[truncated — Grep result exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]` : '';
      resolveP(rel + suffix);
    });
  });
}

async function* walkFiles(dir: string, skip: Set<string>, fileCap: number, counter: { n: number }): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (counter.n >= fileCap) return;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skip.has(ent.name)) continue;
      yield* walkFiles(full, skip, fileCap, counter);
    } else if (ent.isFile()) {
      counter.n++;
      yield full;
    }
  }
}

const GrepTool: Entry = {
  def: {
    name: 'Grep',
    description: 'Search file contents for a regex. Returns matched lines with file:line: prefix unless `files_only` is true. Recurses under cwd, skipping node_modules / .git / dist / etc.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex.' },
        path: { type: 'string', description: 'Optional base path inside cwd.' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive match.' },
        files_only: { type: 'boolean', description: 'Return only matching file paths.' },
      },
      required: ['pattern'],
    },
  },
  execute: async (args, ctx) => {
    const pattern = asString(args.pattern, 'pattern');
    const basePath = asOptString(args.path, 'path');
    const ci = asOptBool(args.case_insensitive, 'case_insensitive') ?? false;
    const filesOnly = asOptBool(args.files_only, 'files_only') ?? false;
    const baseAbs = basePath ? resolveWithinCwd(ctx.cwd, basePath) : resolve(ctx.cwd);

    if (RIPGREP_BIN) {
      return runRipgrep(RIPGREP_BIN, pattern, baseAbs, ctx.cwd, { ci, filesOnly });
    }

    // Fallback: JS walker (capped). Validate regex up-front so we surface a
    // sane error instead of silently no-op'ing on bad input.
    let regex: RegExp;
    try { regex = new RegExp(pattern, ci ? 'i' : ''); }
    catch (err) { throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`); }
    const out: string[] = [];
    let bytes = 0;
    const counter = { n: 0 };
    for await (const filePath of walkFiles(baseAbs, SKIP_DIRS, GREP_WALK_FILE_CAP, counter)) {
      let buf: Buffer;
      try { buf = await fs.readFile(filePath); } catch { continue; }
      if (buf.subarray(0, 1024).includes(0)) continue;
      const text = buf.toString('utf8');
      const rel = relative(ctx.cwd, filePath);
      if (filesOnly) {
        if (regex.test(text)) {
          out.push(rel);
          bytes += rel.length + 1;
        }
      } else {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const entry = `${rel}:${i + 1}: ${lines[i]}`;
            out.push(entry);
            bytes += entry.length + 1;
            if (bytes >= MAX_TOOL_OUTPUT_BYTES) break;
          }
        }
      }
      if (bytes >= MAX_TOOL_OUTPUT_BYTES) break;
    }
    if (out.length === 0) return '(no matches)';
    let suffix = '';
    if (counter.n >= GREP_WALK_FILE_CAP) {
      suffix = `\n\n[walk capped at ${GREP_WALK_FILE_CAP} files — narrow with \`path\` to see more]`;
    }
    return truncate(out.join('\n') + suffix, MAX_TOOL_OUTPUT_BYTES, 'Grep result');
  },
};

// ── Bash ──
//
// Foreground: spawn → capture stdout/stderr (combined cap 64 KB) → return
// after exit. Registered against ctx.shells for the duration of the call
// so KillShell + worker.cancel() can target it.
//
// Background: returns immediately with a shellId; the spawned tree keeps
// running and its lifecycle is the registry's responsibility (cleared on
// natural exit). v1 doesn't stream output — operators get the shellId
// and use KillShell to terminate; the TODO-tab notification path that
// PrimaryBackgroundTracker uses for Ollama isn't wired here yet (a
// straightforward 7b/post-7a follow-up).

interface BashRegistration {
  child: ChildProcess;
  killTree: () => void;
}

function spawnShell(command: string, cwd: string): BashRegistration {
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // DD2 — terminate gracefully (SIGTERM) then escalate to SIGKILL after a grace
  // period if the tree is still alive. A flat SIGKILL gives the child no chance
  // to flush/clean up (orphaned lockfiles, half-written output); SIGTERM-first
  // matches how a shell's Ctrl-C behaves. The escalation timer is unref'd so it
  // never keeps the server process alive on its own.
  const killTree = (): void => {
    const signalTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    signalTree('SIGTERM');
    const t = setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
  };
  return { child, killTree };
}

async function runBashForeground(
  command: string,
  timeoutMs: number,
  ctx: NativeToolContext,
): Promise<string> {
  const { child, killTree } = spawnShell(command, ctx.cwd);
  const shellId = ctx.shells.mintId();
  ctx.shells.byId.set(shellId, { kill: killTree, backgrounded: false });

  return new Promise<string>((resolveResult) => {
    let timedOut = false;
    let aborted = false;

    // DD2 — combined chronological stdout+stderr through one bounded accumulator.
    // The model sees the last ~64 KB; the COMPLETE output spills to a tempfile
    // (lazily, only once it exceeds 64 KB) and the process is NEVER killed on
    // cap (the old code head-truncated AND killTree()'d, turning a big-but-green
    // build into a truncated failure).
    let spillFd: number | null = null;
    const openSpill = (): SpillSink => {
      const p = join(tmpdir(), `arco-bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`);
      const fd = openSync(p, 'w');
      spillFd = fd;
      return { path: p, write: (b: Buffer) => { try { writeSync(fd, b); } catch { /* disk full / closed — keep the tail */ } } };
    };
    const acc = new OutputAccumulator({
      tailByteBudget: MAX_TOOL_OUTPUT_BYTES,
      maxLines: BASH_TAIL_MAX_LINES,
      spillThresholdBytes: MAX_TOOL_OUTPUT_BYTES,
      openSpill,
    });

    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);

    const onAbort = (): void => { aborted = true; killTree(); };
    if (ctx.abortSignal.aborted) onAbort();
    else ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => acc.push(b));
    child.stderr?.on('data', (b: Buffer) => acc.push(b));

    const finish = (exitDescription: string): void => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);
      ctx.shells.byId.delete(shellId);
      if (spillFd !== null) { try { closeSync(spillFd); } catch { /* already closed */ } }
      const r = acc.result();
      const parts: string[] = [];
      if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
      if (aborted) parts.push('[aborted]');
      if (r.truncated) {
        const total = r.truncatedBy === 'lines' ? `${r.totalLines} lines` : `${r.totalBytes.toLocaleString()} bytes`;
        const tailKb = Math.round(MAX_TOOL_OUTPUT_BYTES / 1024);
        const full = r.spillPath ? `; full output saved to ${r.spillPath} (read it with the Read tool if you need the head)` : '';
        parts.push(`[output truncated — showing the last ~${tailKb} KB of ${total}${full}]`);
      }
      parts.push(exitDescription);
      const body = r.text.trimEnd();
      if (body) parts.push('--- output (stdout+stderr) ---', body);
      else parts.push('(no output)');
      resolveResult(parts.join('\n'));
    };
    child.on('error', (err) => finish(`[error] failed to spawn shell: ${err.message}`));
    child.on('close', (code, signal) => {
      const desc = code === null ? `exit signal: ${signal ?? 'unknown'}` : `exit code: ${code}`;
      finish(desc);
    });
  });
}

function runBashBackground(command: string, ctx: NativeToolContext): string {
  const { child, killTree } = spawnShell(command, ctx.cwd);
  const shellId = ctx.shells.mintId();
  ctx.shells.byId.set(shellId, { kill: killTree, backgrounded: true });
  // Auto-deregister on natural exit so KillShell on a finished bg job
  // returns the "no such shell" message rather than reporting success.
  child.on('close', () => { ctx.shells.byId.delete(shellId); });
  // Don't accumulate output for background — the caller asked for a
  // detached shell. Drain to /dev/null so the pipe buffer doesn't
  // back-pressure the child.
  child.stdout?.resume();
  child.stderr?.resume();
  return `started background shell (id: ${shellId}, pid: ${child.pid ?? 'unknown'}). Use KillShell to terminate.`;
}

const BashTool: Entry = {
  def: {
    name: 'Bash',
    description: 'Run a shell command in the workflow cwd via /bin/sh -c. Foreground: returns stdout+stderr (combined cap 64 KB) + exit code. Default timeout 60s; max 600s. With run_in_background:true, returns a shellId immediately — the command keeps running until it finishes or KillShell terminates it.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command. Pipes / redirects / builtins all supported.' },
        description: { type: 'string', description: 'Optional one-line description.' },
        timeout: { type: 'number', description: 'Foreground timeout in ms. Clamped to [1000, 600000]. Default 60000.' },
        run_in_background: { type: 'boolean', description: 'If true, returns immediately with a shellId.' },
      },
      required: ['command'],
    },
  },
  execute: async (args, ctx) => {
    const command = asString(args.command, 'command');
    const background = asOptBool(args.run_in_background, 'run_in_background') ?? false;
    if (background) return runBashBackground(command, ctx);
    const rawTimeout = asOptNumber(args.timeout, 'timeout');
    const timeoutMs = rawTimeout !== undefined
      ? Math.max(BASH_TIMEOUT_MIN_MS, Math.min(BASH_TIMEOUT_MAX_MS, Math.round(rawTimeout)))
      : BASH_TIMEOUT_DEFAULT_MS;
    return runBashForeground(command, timeoutMs, ctx);
  },
};

// ── KillShell ──
const KillShellTool: Entry = {
  def: {
    name: 'KillShell',
    description: 'Terminate a running Bash shell by its shellId. Idempotent — killing an already-dead or unknown shell returns "no such shell" rather than erroring.',
    input_schema: {
      type: 'object',
      properties: {
        shellId: { type: 'string', description: 'Shell id returned by Bash(run_in_background:true), or assigned to a foreground Bash for the duration of its call.' },
      },
      required: ['shellId'],
    },
  },
  execute: async (args, ctx) => {
    const shellId = asString(args.shellId, 'shellId');
    const reg = ctx.shells.byId.get(shellId);
    if (!reg) return `no such shell: ${shellId}`;
    try { reg.kill(); }
    catch { /* already gone */ }
    ctx.shells.byId.delete(shellId);
    return `killed shell ${shellId}`;
  },
};

// ── TodoWrite ──
const TodoWriteTool: Entry = {
  def: {
    name: 'TodoWrite',
    description: 'Update the operator-visible todo list. Pass the full list each call (replaces, doesn\'t merge). Each item: { content, activeForm?, status: pending | in_progress | completed }. Surfaces in the Activity tab.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Full todo list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              activeForm: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  execute: async (args, ctx) => {
    const raw = args.todos;
    if (!Array.isArray(raw)) throw new Error('argument "todos" must be an array');
    const todos: Todo[] = raw.map((item, i) => {
      if (!item || typeof item !== 'object') throw new Error(`todo[${i}] must be an object`);
      const obj = item as Record<string, unknown>;
      const content = asString(obj.content, `todos[${i}].content`);
      const status = asString(obj.status, `todos[${i}].status`);
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
        throw new Error(`todos[${i}].status must be pending|in_progress|completed`);
      }
      return {
        content,
        activeForm: asOptString(obj.activeForm, `todos[${i}].activeForm`),
        status,
      };
    });
    ctx.onTodos(todos);
    return `saved ${todos.length} todos`;
  },
};

// ── EnterPlanMode (7b) ──
const EnterPlanModeTool: Entry = {
  def: {
    name: 'EnterPlanMode',
    description: 'Record a markdown plan body and gate write tools (Write / Edit) until ExitPlanMode. The plan is broadcast to the workflow so the operator can review it in the PLAN tab. Calling EnterPlanMode while already in plan mode replaces the plan body.',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Markdown plan body. Use H3 (`### Phase 1 — …`) phase headers and `- [ ]` checkbox tasks so the Plan-scoped Review parser can phase-split it.' },
      },
      required: ['plan'],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.enterPlanMode) return '[error] EnterPlanMode not available in this context';
    const plan = asString(args.plan, 'plan');
    const { warnings } = await ctx.enterPlanMode(plan);
    const head = 'plan recorded; write tools (Write / Edit) disabled until ExitPlanMode.';
    if (warnings.length === 0) return head;
    return `${head}\n\nplan-parser advisories:\n- ${warnings.join('\n- ')}`;
  },
};

// ── ExitPlanMode (7b) ──
const ExitPlanModeTool: Entry = {
  def: {
    name: 'ExitPlanMode',
    description: 'Clear plan mode and re-enable write tools. Optional `summary` is broadcast alongside the exit signal.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Optional one-paragraph summary of what plan-mode work concluded.' },
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.exitPlanMode) return '[error] ExitPlanMode not available in this context';
    const summary = asOptString(args.summary, 'summary');
    await ctx.exitPlanMode(summary);
    return 'plan mode exited; write tools re-enabled.';
  },
};

// ── AskUserQuestion (7b) ──
const AskUserQuestionTool: Entry = {
  def: {
    name: 'AskUserQuestion',
    description: 'Ask the operator a clarifying question and wait for their reply. The tool result is the operator\'s answer. Pass `options` to render selectable chips; otherwise the operator types a free-form reply. Only one open question per worker — a second call while one is pending returns an error.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to render to the operator.' },
        options: {
          type: 'array',
          description: 'Optional list of option labels for chip-style replies.',
          items: { type: 'string' },
        },
      },
      required: ['question'],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.askUserQuestion) return '[error] AskUserQuestion not available in this context';
    const question = asString(args.question, 'question');
    let options: string[] | undefined;
    if (args.options !== undefined && args.options !== null) {
      if (!Array.isArray(args.options)) throw new Error('argument "options" must be an array of strings');
      options = args.options.map((o, i) => {
        if (typeof o !== 'string') throw new Error(`options[${i}] must be a string`);
        return o;
      });
    }
    return await ctx.askUserQuestion(question, options);
  },
};

// ── Task (7b) ──
const TaskTool: Entry = {
  def: {
    name: 'Task',
    description: 'Spawn a child agent in a new tab to handle a self-contained sub-task. The child runs with the operator\'s visibility (its own tab) and inherits the parent\'s transport. Returns the child\'s final assistant reply when it settles. Depth-1 only — a child cannot itself call Task. Cancel of the parent cancels the child. Instruct the child to END with a concise, verifiable self-report: what it changed (files/paths), what it ran to verify (commands + outcome), and anything left undone or uncertain — so you can trust the result without re-deriving it.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short title shown on the child tab.' },
        prompt: { type: 'string', description: 'The seed prompt for the child agent.' },
        subagent_type: { type: 'string', description: 'Optional subagent label (informational; child still runs as the parent\'s configured provider).' },
        model: { type: 'string', description: 'Optional model override for the child. Defaults to the parent\'s model.' },
      },
      required: ['description', 'prompt'],
    },
  },
  execute: async (args, ctx) => {
    if (ctx.taskDisabled) return '[error] Task is depth-capped at 1; this child cannot spawn another Task.';
    if (!ctx.spawnTask) return '[error] Task not available in this context';
    const description = asString(args.description, 'description');
    const prompt = asString(args.prompt, 'prompt');
    const subagentType = asOptString(args.subagent_type, 'subagent_type');
    const model = asOptString(args.model, 'model');
    return await ctx.spawnTask({ description, prompt, subagentType, model });
  },
};

// ── TaskOutput (7b) ──
const TaskOutputTool: Entry = {
  def: {
    name: 'TaskOutput',
    description: 'Read the in-flight or final output of a Task-spawned child by its taskId. Returns the child\'s accumulated assistant text (cap 64 KB tail). The result is prefixed with `[in-flight]` or `[settled]` so the parent can decide whether to keep waiting. Only the spawning parent can read its children — cross-tab reads return an error.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'taskId returned by Task.' },
      },
      required: ['taskId'],
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.readTaskOutput) return '[error] TaskOutput not available in this context';
    const taskId = asString(args.taskId, 'taskId');
    return await ctx.readTaskOutput(taskId);
  },
};

// ── Registry ──
const REGISTRY: Record<string, Entry> = {
  Read: ReadTool,
  Write: WriteTool,
  Edit: EditTool,
  Bash: BashTool,
  Grep: GrepTool,
  Glob: GlobTool,
  KillShell: KillShellTool,
  TodoWrite: TodoWriteTool,
  EnterPlanMode: EnterPlanModeTool,
  ExitPlanMode: ExitPlanModeTool,
  AskUserQuestion: AskUserQuestionTool,
  Task: TaskTool,
  TaskOutput: TaskOutputTool,
};

export function getNativeToolDefinitions(opts?: { taskDisabled?: boolean; isolated?: boolean }): ClaudeToolDef[] {
  return Object.entries(REGISTRY)
    .filter(([name]) => {
      if (opts?.taskDisabled && name === 'Task') return false;
      // The shell can escape a cwd boundary with absolute paths. ISOLATED
      // therefore exposes only path-fenced file/search tools plus harmless
      // interaction tools; there is no Bash/KillShell escape hatch.
      if (opts?.isolated && (name === 'Bash' || name === 'KillShell' || name === 'Task' || name === 'TaskOutput')) return false;
      return true;
    })
    .map(([, e]) => e.def);
}

export function isKnownNativeTool(name: string): boolean {
  return name in REGISTRY;
}

// Execute a single tool. Errors stringify into the result so the model
// can correct on the next iteration; matches Ollama's posture.
export async function executeNativeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: NativeToolContext,
): Promise<string> {
  const entry = REGISTRY[name];
  if (!entry) {
    return `[error] unknown tool "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`;
  }
  try {
    return await entry.execute(args, ctx);
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
}
