// Public-project guardrails: suggestion from the Git remote and the check that
// Arco's project state stays out of Git. Read-only except for the two explicit
// fixes (restore the ignore file, stop tracking). Every git call is argv-only.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_PROJECT_IGNORE, ignoreWithShares, sharedSkillSlugs } from './projectStateIgnore.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 4_000;
const CACHE_MS = 24 * 60 * 60 * 1000;
export const PUBLIC_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'];

export interface ParsedRemote { name: string; host: string; owner: string; repo: string }
export type RemoteSuggestion =
  | { state: 'none' }
  | { state: 'hosted'; host: string }
  | { state: 'public'; host: string };

export function projectGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return env;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8', env: projectGitEnv() });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '' };
  }
}

export function parseRemoteUrl(url: string): Omit<ParsedRemote, 'name'> | null {
  const text = url.trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (!PUBLIC_HOSTS.includes(host)) return null;
  return { host, owner: m[2]!, repo: m[3]! };
}

/** Parse `git remote -v` output; fetch lines only, origin first. */
export function parseRemotes(text: string): ParsedRemote[] {
  const out: ParsedRemote[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (!m) continue;
    const parsed = parseRemoteUrl(m[2]!);
    if (parsed) out.push({ name: m[1]!, ...parsed });
  }
  return out.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
}

type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** One unauthenticated request. 200 with private:false means public; anything else is unknown. */
export async function githubIsPublic(owner: string, repo: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { signal: ctl.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'arco' } });
    if (res.status !== 200) return false;
    const body = await res.json() as { private?: unknown };
    return body.private === false;
  } catch { return false; } finally { clearTimeout(timer); }
}

const cache = new Map<string, { at: number; value: RemoteSuggestion }>();
export function clearRemoteCache(): void { cache.clear(); }

export async function suggestFromRemote(cwd: string, opts: { fetchImpl?: FetchLike; now?: number } = {}): Promise<RemoteSuggestion> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const listed = await git(cwd, ['remote', '-v']);
  const remote = listed.code === 0 ? parseRemotes(listed.stdout)[0] : undefined;
  let value: RemoteSuggestion = { state: 'none' };
  if (remote) {
    value = remote.host === 'github.com' && await githubIsPublic(remote.owner, remote.repo, opts.fetchImpl)
      ? { state: 'public', host: remote.host }
      : { state: 'hosted', host: remote.host };
  }
  cache.set(cwd, { at: now, value });
  return value;
}

export interface ProjectStateReport {
  isGit: boolean;
  hasState: boolean;
  // Tracked files in .arco, not counting the files of shared skills.
  tracked: number;
  trackedSample: string[];
  ignored: boolean;
  // 'default' also when the only additions are SHARE WITH REPOSITORY blocks.
  ignoreFile: 'default' | 'missing' | 'edited';
  // Skills shared with SHARE WITH REPOSITORY (read from .arco/.gitignore).
  sharedSkills: string[];
}

// The ignore file's text, or '' when it is missing or not a plain file.
function readIgnoreText(file: string): string {
  try { return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

// A tracked path belongs to a shared skill when it lies under .arco/skills/<slug>/.
function isSharedSkillPath(rel: string, shared: string[]): boolean {
  return shared.some((slug) => rel.startsWith(`.arco/skills/${slug}/`));
}

// Pathspecs for `.arco` without the shared skills' folders.
function stateOutsideSharedSkills(shared: string[]): string[] {
  return ['.arco', ...shared.map((slug) => `:(exclude,literal).arco/skills/${slug}/`)];
}

export async function checkProjectState(cwd: string): Promise<ProjectStateReport> {
  const base: ProjectStateReport = { isGit: false, hasState: false, tracked: 0, trackedSample: [], ignored: true, ignoreFile: 'default', sharedSkills: [] };
  if (/[\\/]isolates[\\/]/.test(cwd)) return base;
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return base;
  base.isGit = true;
  const dir = join(cwd, '.arco');
  const file = join(dir, '.gitignore');
  const ignoreText = readIgnoreText(file);
  const shared = sharedSkillSlugs(ignoreText);
  base.sharedSkills = shared;
  const listed = await git(cwd, ['ls-files', '--', '.arco']);
  const all = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
  const tracked = all.filter((rel) => !isSharedSkillPath(rel, shared));
  base.tracked = tracked.length;
  base.trackedSample = tracked.slice(0, 5);
  base.hasState = all.length > 0 || (existsSync(dir) && statSync(dir).isDirectory());
  if (!base.hasState) return base;
  base.ignoreFile = !existsSync(file) ? 'missing' : ignoreText === ignoreWithShares(DEFAULT_PROJECT_IGNORE, shared) ? 'default' : 'edited';
  base.ignored = (await git(cwd, ['check-ignore', '-q', '--no-index', '--', '.arco/workflows/.probe'])).code === 0;
  return base;
}

/**
 * Write the default ignore file, followed by the SHARE WITH REPOSITORY blocks
 * of the skills the current file shares; an existing different file is moved
 * aside first.
 */
export function restoreIgnoreFile(cwd: string): { backup?: string } {
  const dir = join(cwd, '.arco');
  const file = join(dir, '.gitignore');
  // Never through a link: the folder must be a real folder and the file, if
  // present, a real file (the route refuses links first; this is the backstop).
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('The project state folder is not a plain folder.');
  try { if (!lstatSync(file).isFile()) throw new Error('.arco/.gitignore is not a plain file.'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  let backup: string | undefined;
  let target = DEFAULT_PROJECT_IGNORE;
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8');
    target = ignoreWithShares(DEFAULT_PROJECT_IGNORE, sharedSkillSlugs(current));
    if (current === target) return {};
    backup = `.gitignore.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, join(dir, backup));
  }
  writeFileSync(file, target, { encoding: 'utf8', flag: 'wx' });
  return backup ? { backup } : {};
}

/**
 * Remove .arco from the index only, except the files of skills shared with
 * SHARE WITH REPOSITORY. Files stay on disk.
 */
export async function stopTrackingState(cwd: string): Promise<{ ok: boolean; removed: number; error?: string }> {
  const shared = sharedSkillSlugs(readIgnoreText(join(cwd, '.arco', '.gitignore')));
  const pathspecs = stateOutsideSharedSkills(shared);
  const before = await git(cwd, ['ls-files', '--', ...pathspecs]);
  const count = before.stdout.split('\n').filter((rel) => rel && !isSharedSkillPath(rel, shared)).length;
  if (count === 0) return { ok: true, removed: 0 };
  const res = await git(cwd, ['rm', '-r', '-q', '--cached', '--', ...pathspecs]);
  return res.code === 0 ? { ok: true, removed: count } : { ok: false, removed: 0, error: 'git could not stop tracking the folder' };
}
