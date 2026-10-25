// ── Genesis scaffold writer + seed-doc generation (ARCHON_OPS_PLAN.md M2) ──
//
// Turns a ready GenesisSeed into a real project folder: deterministic seed docs
// (README.md / SPEC.md / TODO.md plus local ignored agent notes) written under a
// fresh project dir.
// The doc *text* is generated here from the seed (no model call); the writer is the
// hardened "graduation" step adapted from Seedbank's scaffold writer + tightened to
// Appendix D's security notes:
//
//   - relative, in-tree paths ONLY — reject absolute, `..` traversal, backslashes,
//     null bytes, and dotfile/hidden path components;
//   - never overwrite an existing file;
//   - reject symlinked ancestors (no writing *through* a symlink out of the target)
//     and non-regular existing targets (sockets/fifos/devices);
//   - cap the file count per scaffold run.
//
// This module does no workflow/cwd binding and spawns no repo — the M2 handler
// (Layer B) orchestrates: pick the dir, writeScaffold(), optionally `gh repo create`,
// then bind the cwd. Kept pure + I/O-narrow so scripts/smoke/genesis-scaffold.ts can
// exercise every rejection path headlessly.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GenesisSeed } from '@archon/shared';

// Hard ceiling on files a single scaffold run may write. The deterministic seed-doc
// set is small; the cap is the backstop against a future seed-driven generator looping.
export const SCAFFOLD_FILE_CAP = 24;

export interface ScaffoldFile {
  path: string;    // relative, in-tree (validated by assertSafeScaffoldPath)
  content: string;
}

// ── path helpers (adapted from Seedbank integrations/scaffold.ts) ──

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

// The hidden scratch ideation dir for a from-nothing genesis workflow, before it
// is scaffolded + rebound to a real project dir. The turn engine requires a cwd, so
// the staged conversation runs here; `genesis_scaffold` moves the on-disk store out
// of here into the real project dir and removes this. Lives under ~/.archon so it
// never pollutes the operator's project space.
export function genesisScratchDir(wfid: string): string {
  return path.join(os.homedir(), '.archon', 'genesis', wfid);
}

export function slugify(input: string): string {
  return (input || 'untitled-project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72) || 'untitled-project';
}

// Pick a non-colliding project dir under `root`, creating `root` if needed.
// Appends -2, -3, … until a free name is found (mirrors Seedbank). `root` is
// expandHome()'d by the caller; this only joins + probes.
export async function uniqueProjectDir(root: string, name: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const base = slugify(name);
  let candidate = path.join(root, base);
  let suffix = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await pathExists(candidate)) {
    candidate = path.join(root, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// ── path safety (Appendix D) ──

// Validate a scaffold-relative path and return its normalized form, or throw. This
// is the *string-level* guard (the filesystem-level symlink/overwrite checks happen
// in writeScaffold against the real target dir). Rejects:
//   - non-string / empty
//   - absolute paths and `~`-rooted paths
//   - backslashes (Windows-style separators that bypass POSIX `..` checks)
//   - NUL bytes
//   - any `.` / `..` / dotfile (hidden) path component, except the deterministic
//     root `.gitignore` scaffold file.
export function assertSafeScaffoldPath(rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim().length === 0) {
    throw new Error('scaffold path must be a non-empty string');
  }
  const raw = rel.trim();
  if (raw.includes('\0')) throw new Error(`scaffold path contains a NUL byte`);
  if (raw.includes('\\')) throw new Error(`scaffold path "${raw}" contains a backslash`);
  if (path.isAbsolute(raw) || raw.startsWith('~')) {
    throw new Error(`scaffold path "${raw}" must be relative and in-tree`);
  }
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`scaffold path "${raw}" is empty after normalization`);
  const allowRootGitignore = parts.length === 1 && parts[0] === '.gitignore';
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`scaffold path "${raw}" must not traverse with "." or ".."`);
    }
    if (part.startsWith('.') && !allowRootGitignore) {
      throw new Error(`scaffold path "${raw}" must not contain a hidden/dotfile component ("${part}")`);
    }
  }
  return parts.join('/');
}

// Reject if any existing ancestor of `target` (up to but not including `root`) is a
// symlink — writing through it would escape the target tree even though the string
// path looks in-tree. `root` itself must already exist and be a real directory.
async function assertNoSymlinkAncestor(root: string, target: string): Promise<void> {
  const rootResolved = path.resolve(root);
  let cur = path.dirname(path.resolve(target));
  const chain: string[] = [];
  while (cur.startsWith(rootResolved) && cur !== rootResolved) {
    chain.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Walk root→leaf so the first offending link is reported.
  for (const dir of chain.reverse()) {
    let st: import('node:fs').Stats | undefined;
    try {
      st = await fs.lstat(dir);
    } catch {
      continue; // doesn't exist yet — mkdir will create it as a real dir
    }
    if (st.isSymbolicLink()) {
      throw new Error(`scaffold refused: "${dir}" is a symlink`);
    }
    if (!st.isDirectory()) {
      throw new Error(`scaffold refused: "${dir}" exists and is not a directory`);
    }
  }
}

// ── the writer ──

export interface ScaffoldResult {
  written: string[]; // relative paths, in write order
}

// Write `files` under `targetDir`. `targetDir` must be a real directory (the caller
// creates it via uniqueProjectDir). Enforces the file-count cap, then per file:
// validate the rel path, reject symlinked ancestors, refuse to overwrite an existing
// path (regular or otherwise), create parent dirs, write atomically. Any failure
// throws before writing that file — partial scaffolds are possible (earlier files
// already on disk) but the throw surfaces the exact offending path.
export async function writeScaffold(targetDir: string, files: ScaffoldFile[]): Promise<ScaffoldResult> {
  if (files.length > SCAFFOLD_FILE_CAP) {
    throw new Error(`scaffold refused: ${files.length} files exceeds the cap of ${SCAFFOLD_FILE_CAP}`);
  }
  const root = path.resolve(targetDir);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`scaffold target "${targetDir}" is not a real directory`);
  }

  const written: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const safeRel = assertSafeScaffoldPath(file.path);
    if (seen.has(safeRel)) throw new Error(`scaffold has a duplicate path "${safeRel}"`);
    seen.add(safeRel);
    if (typeof file.content !== 'string') throw new Error(`scaffold file "${safeRel}" has non-string content`);

    const abs = path.join(root, safeRel);
    // Defense-in-depth: the joined path must still sit under root.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`scaffold path "${file.path}" escapes the target dir`);
    }

    await assertNoSymlinkAncestor(root, abs);

    // Never overwrite: lstat (not stat) so a symlink AT the target is also caught.
    const existing = await fs.lstat(abs).catch(() => null);
    if (existing) throw new Error(`scaffold refused: "${safeRel}" already exists`);

    await fs.mkdir(path.dirname(abs), { recursive: true });
    // wx flag: fail if the path appears between the lstat above and the write
    // (TOCTOU guard) — atomic create-or-fail.
    await fs.writeFile(abs, file.content, { encoding: 'utf8', flag: 'wx' });
    written.push(safeRel);
  }
  return { written };
}

// ── deterministic seed-doc generation ──

const orEmpty = (v: string | undefined, fallback: string): string => (v && v.trim() ? v.trim() : fallback);

function seedReadme(seed: GenesisSeed): string {
  const title = orEmpty(seed.title, 'Untitled Project');
  return [
    `# ${title}`,
    '',
    '## What it is',
    '',
    orEmpty(seed.concept, '_Concept not captured yet._'),
    '',
    '## Why build it',
    '',
    orEmpty(seed.theCase, '_The case for building this was not captured yet._'),
    '',
    '## Build direction',
    '',
    orEmpty(seed.buildDirection, '_No build direction captured yet._'),
    '',
  ].join('\n');
}

function seedSpec(seed: GenesisSeed): string {
  return [
    `# ${orEmpty(seed.title, 'Untitled Project')} — Spec`,
    '',
    '## The Spark',
    '',
    orEmpty(seed.spark, '_No spark captured._'),
    '',
    '## Concept',
    '',
    orEmpty(seed.concept, '_No concept captured._'),
    '',
    '## The Case',
    '',
    orEmpty(seed.theCase, '_No case captured._'),
    '',
    '## Build Direction',
    '',
    orEmpty(seed.buildDirection, '_No build direction captured._'),
    '',
    ...(seed.scope ? ['## Scope', '', seed.scope.trim(), ''] : []),
    ...(seed.stack ? ['## Stack', '', seed.stack.trim(), ''] : []),
  ].join('\n');
}

function seedTodo(seed: GenesisSeed): string {
  return [
    `# ${orEmpty(seed.title, 'Untitled Project')} — TODO`,
    '',
    'First steps, drawn from the build direction. Refine before starting.',
    '',
    '- [ ] Confirm the stack and scope boundaries',
    '- [ ] Stand up the minimal runnable skeleton',
    '- [ ] Build the smallest end-to-end slice of the core concept',
    ...(seed.buildDirection.trim()
      ? ['', '## Build-direction notes', '', seed.buildDirection.trim(), '']
      : ['']),
  ].join('\n');
}

function publicRepoSafety(seed: GenesisSeed): string[] {
  if (!seed.github?.create || seed.github.visibility !== 'public') return [];
  return [
    '## Public Repository Safety',
    '',
    'This project is configured for a public GitHub repository. Treat that as a hard publishing boundary:',
    '',
    '- Never commit, push, paste, or summarize secrets, credentials, API keys, tokens, private hostnames, private URLs, personal data, or local-only configuration.',
    '- Keep `.env`, machine-local config, generated credentials, and private notes untracked.',
    '- Before any commit or push, inspect staged changes for sensitive content and stop to ask the operator if anything looks ambiguous.',
    '',
  ];
}

function seedGitignore(): string {
  return [
    '# Arco Genesis local state',
    '.archon/',
    '',
    '# Local agent guidance generated from the Genesis seed',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '',
    '# Local/private configuration',
    '.env',
    '.env.*',
    '',
  ].join('\n');
}

function seedAgentNotes(seed: GenesisSeed, target: 'AGENTS.md' | 'CLAUDE.md' | 'GEMINI.md'): string {
  return [
    `# ${orEmpty(seed.title, 'Untitled Project')} — agent notes`,
    '',
    `Project brief for coding agents working in this repo. Generated by Arco Genesis for ${target}; keep it current locally as the project takes shape.`,
    '',
    'These notes are generated as local, gitignored files. Public project facts belong in README.md, SPEC.md, and TODO.md.',
    '',
    '## Concept',
    '',
    orEmpty(seed.concept, 'See README.md — concept not captured yet.'),
    '',
    '## Direction & constraints',
    '',
    orEmpty(seed.buildDirection, 'Choose a minimal stack that matches the concept; keep the first slice small.'),
    '',
    '## Why it matters',
    '',
    orEmpty(seed.theCase, 'See README.md.'),
    '',
    '## Operating rules',
    '',
    '- Treat README.md, SPEC.md, and TODO.md as the public project brief.',
    '- Keep local-only agent notes, workflow metadata, credentials, and machine-specific configuration out of commits.',
    '- Prefer small, reviewable changes and verify core behavior before adding visual polish.',
    '',
    ...publicRepoSafety(seed),
  ].join('\n');
}

// The deterministic seed-doc set written by every scaffold. Pure — no I/O.
export function buildSeedDocs(seed: GenesisSeed): ScaffoldFile[] {
  return [
    { path: '.gitignore', content: seedGitignore() },
    { path: 'README.md', content: seedReadme(seed) },
    { path: 'SPEC.md', content: seedSpec(seed) },
    { path: 'TODO.md', content: seedTodo(seed) },
    { path: 'AGENTS.md', content: seedAgentNotes(seed, 'AGENTS.md') },
    { path: 'CLAUDE.md', content: seedAgentNotes(seed, 'CLAUDE.md') },
    { path: 'GEMINI.md', content: seedAgentNotes(seed, 'GEMINI.md') },
  ];
}
