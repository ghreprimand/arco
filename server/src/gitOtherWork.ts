// Read-only survey of the repository's other work for the GIT dialog: linked
// worktrees and local branches (not the tab's own), how far each is ahead of
// and behind the default branch, uncommitted file counts for checked-out trees
// and, when `gh` works, the open pull request for the branch. Nothing here
// changes the repository.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OtherWorkResponse, OtherWorkRow } from '@arco/shared';
import { runGit } from './git.js';
import { listWorktrees } from './project/taskWorktree.js';

const execFileAsync = promisify(execFile);
const MAX_ROWS = 60;
const PARALLEL = 6;

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

export function parseLeftRight(out: string): { behind: number; ahead: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

async function defaultBranchOf(cwd: string, branches: string[]): Promise<string | null> {
  const sym = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0 && sym.stdout.trim().startsWith('origin/')) return sym.stdout.trim().slice('origin/'.length);
  return ['main', 'master'].find((c) => branches.includes(c)) ?? null;
}

async function openPullRequests(cwd: string): Promise<Map<string, { number: number; url: string; title: string }> | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,title,url'], { cwd, timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    const map = new Map<string, { number: number; url: string; title: string }>();
    for (const p of parsed as Array<{ number?: number; headRefName?: string; title?: string; url?: string }>) {
      if (typeof p.headRefName === 'string' && typeof p.number === 'number' && typeof p.url === 'string') map.set(p.headRefName, { number: p.number, url: p.url, title: String(p.title ?? '').slice(0, 120) });
    }
    return map;
  } catch { return null; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function surveyOtherWork(cwd: string): Promise<OtherWorkResponse> {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false, defaultBranch: null, rows: [], prStatus: 'unavailable', truncated: false };
  const refs = await runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = refs.code === 0 ? refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const defaultBranch = await defaultBranchOf(cwd, branches);
  const worktrees = await listWorktrees(cwd);
  const own = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const ownTop = own.code === 0 ? own.stdout.trim() : cwd;

  type Target = { branch: string | null; worktreePath: string | null; isMain: boolean; ref: string };
  const targets: Target[] = [];
  const checkedOut = new Set<string>();
  for (const w of worktrees) {
    if (samePath(w.path, ownTop)) { if (w.branch) checkedOut.add(w.branch); continue; }
    if (w.branch) checkedOut.add(w.branch);
    targets.push({ branch: w.branch, worktreePath: w.path, isMain: w.isMain, ref: 'HEAD' });
  }
  for (const b of branches) {
    if (checkedOut.has(b) || b === defaultBranch) continue;
    targets.push({ branch: b, worktreePath: null, isMain: false, ref: b });
  }
  const truncated = targets.length > MAX_ROWS;
  const shown = targets.slice(0, MAX_ROWS);

  const prs = await openPullRequests(cwd);
  const rows = await mapLimit(shown, PARALLEL, async (t): Promise<OtherWorkRow> => {
    const where = t.worktreePath ?? cwd;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (defaultBranch) {
      const lr = await runGit(where, ['rev-list', '--left-right', '--count', `${defaultBranch}...${t.ref}`]);
      const parsed = lr.code === 0 ? parseLeftRight(lr.stdout) : null;
      if (parsed) { ahead = parsed.ahead; behind = parsed.behind; }
    }
    let dirtyCount: number | null = null;
    if (t.worktreePath) {
      const st = await runGit(t.worktreePath, ['status', '--porcelain']);
      if (st.code === 0) dirtyCount = st.stdout.split('\n').filter((l) => l.trim()).length;
    }
    return { branch: t.branch, worktreePath: t.worktreePath, isMain: t.isMain, ahead, behind, dirtyCount, pr: t.branch ? prs?.get(t.branch) ?? null : null };
  });
  return { isRepo: true, defaultBranch, rows, prStatus: prs ? 'ok' : 'unavailable', truncated };
}
