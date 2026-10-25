// ── Genesis Creative mode: project-context snapshot + codebase assessment (M3) ──
//
// M3 runs the M1 staged-ideation process INSIDE an existing workflow to explore an
// alternative direction for a real project. Two deterministic, model-free reads of
// the existing cwd power that:
//
//   gatherProjectContext(cwd) → a labeled prose snapshot (name, description, README
//     summary, stack hints) that grounds the alternative-direction conversation so
//     the model anchors to what is really on disk instead of inventing it. Folded
//     into the genesis system block via seed.projectContext.
//
//   assessCodebase(cwd)       → fileCount + an "established" flag + an advisory
//     warning string — the operator's stated late-stage guardrail. Reads git's
//     tracked-file list when in a repo (cheap, ignores node_modules/build output),
//     else a capped directory walk that skips the usual heavy dirs.
//
// Both are pure reads — they never write, and the scaffold (genesisHandlers) is the
// only thing that touches disk. Cross-platform: execFile argv (no shell), POSIX fs.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GenesisCodebaseInfo } from '@archon/shared';

const execFileAsync = promisify(execFile);

// The sibling directory creative-mode scaffolds write into, relative to the existing
// cwd. Confines all creative output to one folder that never collides with project
// files (the scaffold writer additionally refuses to overwrite anything).
export const ALTERNATIVE_DIR = 'ALTERNATIVE';

// Dirs the capped walk skips — heavy/generated trees that would blow the cap without
// telling us anything about how established the *source* is.
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', 'target', '.venv', 'vendor', 'coverage']);

// Over this many source files we call the codebase "established" even without git
// history — enough that an operator should be warned a creative fork is non-trivial.
const ESTABLISHED_FILE_THRESHOLD = 40;
// Cap on the directory walk so a giant tree can't stall the arm. Once hit we report
// the cap as a floor ("400+ files") — still enough to flag "established".
const WALK_CAP = 400;

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? '';
const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// ── project-context snapshot ──

export interface ProjectContext {
  // Suggested working name for the alternative seed: the project's own name. The
  // operator renames freely — it's only a starting point.
  suggestedTitle: string;
  // Labeled prose block folded into the genesis system block (seed.projectContext).
  block: string;
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// Pull name + description from package.json without trusting it to be valid JSON.
async function readPackageJson(cwd: string): Promise<{ name?: string; description?: string } | null> {
  const raw = await readIfPresent(path.join(cwd, 'package.json'));
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw) as { name?: unknown; description?: unknown };
    return {
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
    };
  } catch {
    return null;
  }
}

// First markdown heading + the first non-empty, non-heading paragraph of a README.
function readmeSummary(readme: string): { heading?: string; blurb?: string } {
  const lines = readme.split('\n');
  let heading: string | undefined;
  let blurb: string | undefined;
  for (const line of lines) {
    const t = line.trim();
    if (!heading && t.startsWith('#')) { heading = t.replace(/^#+\s*/, '').trim(); continue; }
    if (!blurb && t.length > 0 && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('![')) {
      blurb = t;
      if (heading) break;
    }
  }
  return { heading, blurb };
}

// Detect a few stack markers by presence of well-known files — purely informational
// grounding, never a claim the alternative must reuse them.
async function detectStackHints(cwd: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ['package.json', 'Node/JS'],
    ['tsconfig.json', 'TypeScript'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pom.xml', 'Java/Maven'],
    ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'],
    ['Dockerfile', 'Docker'],
  ];
  const hints: string[] = [];
  for (const [file, label] of checks) {
    // eslint-disable-next-line no-await-in-loop
    if (await readIfPresent(path.join(cwd, file))) { if (!hints.includes(label)) hints.push(label); }
  }
  return hints;
}

export async function gatherProjectContext(cwd: string): Promise<ProjectContext> {
  const pkg = await readPackageJson(cwd);
  const readme = await readIfPresent(path.join(cwd, 'README.md'));
  const hasClaudeMd = !!(await readIfPresent(path.join(cwd, 'CLAUDE.md')));
  const hints = await detectStackHints(cwd);

  const dirName = path.basename(cwd.replace(/[\\/]+$/, '')) || 'this project';
  const suggestedTitle = (pkg?.name && pkg.name.trim()) || dirName;

  const summary = readme ? readmeSummary(readme) : {};
  const lines: string[] = [
    '--- Existing project (Creative mode) ---',
    'The operator is exploring an ALTERNATIVE direction for the project already in this working directory.',
    'The facts below are read from disk — treat them as the source of truth about what exists today.',
    'Do NOT assume the alternative must reuse this project\'s stack, scope, or name unless the operator says so; help them decide what to keep and what to rethink.',
    '',
    `Project name: ${suggestedTitle}`,
  ];
  if (pkg?.description && pkg.description.trim()) lines.push(`package.json description: ${clamp(firstLine(pkg.description), 240)}`);
  if (summary.heading) lines.push(`README heading: ${clamp(summary.heading, 160)}`);
  if (summary.blurb) lines.push(`README summary: ${clamp(summary.blurb, 320)}`);
  if (hints.length > 0) lines.push(`Detected stack markers: ${hints.join(', ')}`);
  if (hasClaudeMd) lines.push('A CLAUDE.md (agent brief) is present — consult it for existing conventions before proposing changes.');
  if (!pkg && !readme && hints.length === 0) {
    lines.push('(Little structured metadata found — the directory may be sparse or use an unrecognized stack.)');
  }

  return { suggestedTitle, block: lines.join('\n') };
}

// ── codebase size / "established" assessment ──

// git-tracked file count (fast, respects .gitignore). null when not a git repo.
async function gitTrackedCount(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd, maxBuffer: 64 * 1024 * 1024 });
    if (stdout.length === 0) return 0;
    // -z → NUL-separated; trailing NUL means split leaves an empty last element.
    const parts = stdout.split('\0').filter((p) => p.length > 0);
    return parts.length;
  } catch {
    return null; // not a repo / git unavailable → fall back to the walk
  }
}

// Has the repo any commits? An empty (just-init'd) repo is not "established".
async function gitHasCommits(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    return true;
  } catch {
    return false;
  }
}

// Bounded recursive file count, skipping heavy/generated dirs. Stops at WALK_CAP.
async function walkFileCount(cwd: string): Promise<number> {
  let count = 0;
  const stack: string[] = [cwd];
  while (stack.length > 0 && count < WALK_CAP) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (WALK_SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
        stack.push(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        count += 1;
        if (count >= WALK_CAP) break;
      }
    }
  }
  return count;
}

export async function assessCodebase(cwd: string): Promise<GenesisCodebaseInfo> {
  const tracked = await gitTrackedCount(cwd);
  const fileCount = tracked ?? (await walkFileCount(cwd));
  const hasCommits = tracked !== null ? await gitHasCommits(cwd) : false;
  const capped = tracked === null && fileCount >= WALK_CAP;

  const established = hasCommits || fileCount >= ESTABLISHED_FILE_THRESHOLD;
  let warning: string | undefined;
  if (established) {
    const sizeStr = capped ? `${WALK_CAP}+ files` : `${fileCount} file${fileCount === 1 ? '' : 's'}`;
    const histStr = hasCommits ? ' with commit history' : '';
    warning =
      `This is an established codebase (${sizeStr}${histStr}). Creative mode never edits it: ` +
      `the scaffold lands in a sibling ${ALTERNATIVE_DIR}/ dir and a separate plan. ` +
      `If the alternative diverges sharply, use Spawn-from-here to fork it into a fresh tab rather than building it here.`;
  }
  return { fileCount, established, warning };
}
