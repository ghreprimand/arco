import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Thin typed wrapper around the GitHub REST API. We use `gh auth token` to
// fetch the CLI's active token instead of asking the operator to paste a PAT —
// this means the GitHub feature Just Works™ if they've already logged in with
// the CLI. Token refresh is handled by `gh`; we re-fetch on each call rather
// than caching, which is cheap locally and dodges the stale-token edge case.

const API_ROOT = 'https://api.github.com';

async function getToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const token = stdout.trim();
    if (!token) throw new Error('gh returned an empty token — run `gh auth login`');
    return token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gh token unavailable: ${message}`);
  }
}

type FetchInit = {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  accept?: string;
};

async function gh<T>(path: string, init: FetchInit = {}): Promise<T> {
  const token = await getToken();
  const url = new URL(`${API_ROOT}${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: init.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'archon-local',
  };
  const req: RequestInit = { method: init.method || 'GET', headers };
  if (init.body !== undefined) {
    (req.headers as Record<string, string>)['Content-Type'] = 'application/json';
    req.body = JSON.stringify(init.body);
  }
  const res = await fetch(url, req);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  // Diff endpoints return text/plain; others return JSON. Sniff the accept.
  if (init.accept && init.accept.includes('diff')) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

// Shape types — intentionally loose. The UI only cares about a subset.

export interface GhUser {
  login: string;
  name?: string;
  avatar_url: string;
  html_url: string;
  bio?: string;
  public_repos: number;
  followers: number;
  following: number;
}

export interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string; avatar_url: string };
  description?: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language?: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
}

export interface GhPullShort {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface GhPull extends GhPullShort {
  body: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  commits: number;
  comments: number;
  review_comments: number;
}

export interface GhIssueShort {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: { login: string; avatar_url: string };
  comments: number;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string; color: string }>;
  html_url: string;
  pull_request?: unknown; // present on PR issues, we filter in the UI
}

export interface GhIssue extends GhIssueShort {
  body: string | null;
}

export interface GhComment {
  id: number;
  user: { login: string; avatar_url: string };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  html_url: string;
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string;
  run_number: number;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  actor: { login: string; avatar_url: string };
}

export interface GhWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  html_url: string;
  steps?: Array<{ name: string; status: string; conclusion: string | null; number: number; started_at?: string; completed_at?: string }>;
}

export interface GhPullFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  // Set by GitHub on renames/copies — the path the file moved from. The client
  // diff-reconstruction needs this to build a correct `a/<old> b/<new>` header.
  previous_filename?: string;
  // GitHub's web URL for the file in this PR/commit — used as a fall-back link
  // for binary/oversized files that carry no inline `patch`.
  blob_url?: string;
}

export interface GhBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

export interface GhTreeEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  size?: number;
  sha: string;
  download_url?: string | null;
}

export interface GhFileContent {
  type: 'file';
  name: string;
  path: string;
  size: number;
  sha: string;
  encoding: 'base64' | 'none';
  content: string; // base64 when encoding='base64', raw otherwise
  download_url: string | null;
  html_url: string;
}

export interface GhReadme {
  name: string;
  path: string;
  content: string; // base64
  encoding: string;
  html_url: string;
}

export interface GhCommitShort {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  };
  author: { login: string; avatar_url: string } | null;
  committer: { login: string; avatar_url: string } | null;
  html_url: string;
}

export interface GhTag {
  name: string;
  commit: { sha: string };
}

export interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  author: { login: string; avatar_url: string };
  html_url: string;
}

export interface GhContributor {
  login: string;
  avatar_url: string;
  contributions: number;
  html_url: string;
}

// ── PR creation request builder (pure / testable) ──

export interface CreatePrInput {
  title?: string;
  body?: string;
  base?: string;
  head?: string;
}

export interface CreatePrRequest {
  path: string;
  method: 'POST';
  body: { title: string; head: string; base: string; body?: string };
}

// Thrown when operator-supplied PR fields fail validation. Carries a clean
// message the route surfaces as a 400 (vs. a gh/network 502).
export class PrValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrValidationError';
  }
}

// PURE: validate + shape the create-pull-request REST call. Factored out of
// `createPullRequest` so the smoke can unit-test it with no live `gh`. The
// result feeds the REST `body` helper (JSON, never interpolated into a shell
// string) — title/base/head go in the JSON body, dodging flag-injection from
// a title that begins with `-`.
export function buildCreatePrRequest(owner: string, name: string, input: CreatePrInput): CreatePrRequest {
  const title = (input.title ?? '').trim();
  const base = (input.base ?? '').trim();
  const head = (input.head ?? '').trim();
  const body = input.body?.trim() || undefined; // optional; empty → omit
  if (!title) throw new PrValidationError('PR title is required.');
  if (!base) throw new PrValidationError('Base branch is required.');
  if (!head) throw new PrValidationError('Head branch is required.');
  return {
    path: `/repos/${owner}/${name}/pulls`,
    method: 'POST',
    body: { title, head, base, ...(body ? { body } : {}) },
  };
}

// ── API calls ──

export const github = {
  async user(): Promise<GhUser> {
    return gh<GhUser>('/user');
  },

  async repos(params: { search?: string; type?: 'all' | 'owner' | 'member' | 'public' | 'private'; sort?: 'pushed' | 'full_name' | 'updated'; per_page?: number; page?: number }): Promise<GhRepo[]> {
    if (params.search) {
      const user = await this.user();
      const q = `${params.search} in:name user:${user.login}`;
      const out = await gh<{ items: GhRepo[] }>('/search/repositories', {
        query: { q, sort: 'updated', per_page: params.per_page ?? 30 },
      });
      return out.items;
    }
    const type = params.type === 'private' || params.type === 'public'
      ? undefined
      : (params.type ?? 'owner');
    return gh<GhRepo[]>('/user/repos', {
      query: {
        type,
        sort: params.sort || 'pushed',
        per_page: params.per_page ?? 30,
        page: params.page ?? 1,
        visibility: params.type === 'private' ? 'private' : params.type === 'public' ? 'public' : undefined,
      },
    });
  },

  async repo(owner: string, name: string): Promise<GhRepo> {
    return gh<GhRepo>(`/repos/${owner}/${name}`);
  },

  async pulls(owner: string, name: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GhPullShort[]> {
    return gh<GhPullShort[]>(`/repos/${owner}/${name}/pulls`, {
      query: { state, per_page: 50, sort: 'updated', direction: 'desc' },
    });
  },

  async pull(owner: string, name: string, number: number): Promise<GhPull> {
    return gh<GhPull>(`/repos/${owner}/${name}/pulls/${number}`);
  },

  async pullFiles(owner: string, name: string, number: number): Promise<GhPullFile[]> {
    return gh<GhPullFile[]>(`/repos/${owner}/${name}/pulls/${number}/files`, {
      query: { per_page: 50 },
    });
  },

  async pullComments(owner: string, name: string, number: number): Promise<GhComment[]> {
    // Issue-style comments on the PR (not the review line comments).
    return gh<GhComment[]>(`/repos/${owner}/${name}/issues/${number}/comments`, {
      query: { per_page: 50 },
    });
  },

  async pullChecks(owner: string, name: string, ref: string): Promise<{ check_runs: GhCheckRun[] }> {
    return gh<{ check_runs: GhCheckRun[] }>(`/repos/${owner}/${name}/commits/${ref}/check-runs`, {
      query: { per_page: 30 },
    });
  },

  async issues(owner: string, name: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GhIssueShort[]> {
    const list = await gh<GhIssueShort[]>(`/repos/${owner}/${name}/issues`, {
      query: { state, per_page: 50, sort: 'updated', direction: 'desc' },
    });
    // The /issues endpoint returns PRs too; UI asks for issues, strip them.
    return list.filter((i) => !i.pull_request);
  },

  async issue(owner: string, name: string, number: number): Promise<GhIssue> {
    return gh<GhIssue>(`/repos/${owner}/${name}/issues/${number}`);
  },

  async issueComments(owner: string, name: string, number: number): Promise<GhComment[]> {
    return gh<GhComment[]>(`/repos/${owner}/${name}/issues/${number}/comments`, {
      query: { per_page: 50 },
    });
  },

  async runs(owner: string, name: string): Promise<{ workflow_runs: GhWorkflowRun[] }> {
    return gh<{ workflow_runs: GhWorkflowRun[] }>(`/repos/${owner}/${name}/actions/runs`, {
      query: { per_page: 30 },
    });
  },

  async run(owner: string, name: string, runId: number): Promise<GhWorkflowRun> {
    return gh<GhWorkflowRun>(`/repos/${owner}/${name}/actions/runs/${runId}`);
  },

  async runJobs(owner: string, name: string, runId: number): Promise<{ jobs: GhWorkflowJob[] }> {
    return gh<{ jobs: GhWorkflowJob[] }>(`/repos/${owner}/${name}/actions/runs/${runId}/jobs`, {
      query: { per_page: 30 },
    });
  },

  // ── Write endpoints (small set; operator-confirmed via UI) ──

  async mergePull(owner: string, name: string, number: number, options?: { merge_method?: 'merge' | 'squash' | 'rebase'; commit_title?: string; commit_message?: string }): Promise<{ merged: boolean; message: string; sha?: string }> {
    return gh<{ merged: boolean; message: string; sha?: string }>(`/repos/${owner}/${name}/pulls/${number}/merge`, {
      method: 'PUT',
      body: options,
    });
  },

  // Create a PR via the REST API. Operator text (title/body) rides the JSON
  // `body` — we never build a `gh pr create` shell/argv string with it, so a
  // title beginning with `-` can't be read as a flag. Validation is the pure
  // `buildCreatePrRequest` (unit-tested in the smoke).
  async createPullRequest(owner: string, name: string, input: CreatePrInput): Promise<GhPullShort> {
    const reqSpec = buildCreatePrRequest(owner, name, input);
    return gh<GhPullShort>(reqSpec.path, { method: reqSpec.method, body: reqSpec.body });
  },

  // A single commit's changed files (same GhPullFile shape, `patch?` inline).
  // GitHub returns up to 300 files per page; we ask for the max and take the
  // first page — matching `pullFiles`' single-page behavior.
  async commitFiles(owner: string, name: string, sha: string): Promise<GhPullFile[]> {
    const data = await gh<{ files?: GhPullFile[] }>(`/repos/${owner}/${name}/commits/${sha}`, {
      query: { per_page: 300 },
    });
    return data.files ?? [];
  },

  async closeIssue(owner: string, name: string, number: number): Promise<GhIssue> {
    return gh<GhIssue>(`/repos/${owner}/${name}/issues/${number}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
  },

  async reopenIssue(owner: string, name: string, number: number): Promise<GhIssue> {
    return gh<GhIssue>(`/repos/${owner}/${name}/issues/${number}`, {
      method: 'PATCH',
      body: { state: 'open' },
    });
  },

  async commentIssue(owner: string, name: string, number: number, body: string): Promise<GhComment> {
    return gh<GhComment>(`/repos/${owner}/${name}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    });
  },

  async rerunRun(owner: string, name: string, runId: number): Promise<{ ok: true }> {
    await gh<unknown>(`/repos/${owner}/${name}/actions/runs/${runId}/rerun`, { method: 'POST' });
    return { ok: true };
  },

  // ── Code browsing ──

  async branches(owner: string, name: string): Promise<GhBranch[]> {
    return gh<GhBranch[]>(`/repos/${owner}/${name}/branches`, { query: { per_page: 100 } });
  },

  async tags(owner: string, name: string): Promise<GhTag[]> {
    return gh<GhTag[]>(`/repos/${owner}/${name}/tags`, { query: { per_page: 100 } });
  },

  async releases(owner: string, name: string): Promise<GhRelease[]> {
    return gh<GhRelease[]>(`/repos/${owner}/${name}/releases`, { query: { per_page: 30 } });
  },

  async contributors(owner: string, name: string): Promise<GhContributor[]> {
    return gh<GhContributor[]>(`/repos/${owner}/${name}/contributors`, { query: { per_page: 30 } });
  },

  async commits(owner: string, name: string, params?: { sha?: string; path?: string; per_page?: number; page?: number }): Promise<GhCommitShort[]> {
    return gh<GhCommitShort[]>(`/repos/${owner}/${name}/commits`, {
      query: {
        sha: params?.sha,
        path: params?.path,
        per_page: params?.per_page ?? 30,
        page: params?.page ?? 1,
      },
    });
  },

  async commitCount(owner: string, name: string, sha: string): Promise<number> {
    const token = await getToken();
    const url = new URL(`${API_ROOT}/repos/${owner}/${name}/commits`);
    url.searchParams.set('sha', sha);
    url.searchParams.set('per_page', '1');
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'archon-local',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const link = res.headers.get('link');
    if (link) {
      const lastPart = link.split(',').find((p) => p.includes('rel="last"'));
      if (lastPart) {
        const m = lastPart.match(/[?&]page=(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
    }
    // No Link header → all commits fit on one page
    const data = (await res.json()) as unknown[];
    return Array.isArray(data) ? data.length : 0;
  },

  async readme(owner: string, name: string, ref?: string): Promise<GhReadme> {
    return gh<GhReadme>(`/repos/${owner}/${name}/readme`, { query: { ref } });
  },

  // Tree listing at a path. Calling /contents with a directory path returns
  // an array; with a file path returns a file object. We normalize the
  // directory case to GhTreeEntry[] and leave single-file resolution to
  // `fileContents()`.
  async tree(owner: string, name: string, params: { ref?: string; path?: string }): Promise<GhTreeEntry[]> {
    const path = params.path ? encodeURIComponent(params.path).replace(/%2F/g, '/') : '';
    const raw = await gh<Array<Record<string, unknown>>>(`/repos/${owner}/${name}/contents/${path}`, {
      query: { ref: params.ref },
    });
    if (!Array.isArray(raw)) {
      throw new Error('Expected a directory — got a file. Use /contents for files.');
    }
    return raw.map((e) => ({
      type: e.type === 'dir' ? 'dir' : 'file',
      name: String(e.name),
      path: String(e.path),
      size: typeof e.size === 'number' ? e.size : undefined,
      sha: String(e.sha),
      download_url: (e.download_url as string | null) ?? null,
    }));
  },

  // Full recursive tree listing for a ref — used by go-to-file fuzzy search.
  // Returns a flat list of files only (directories dropped). GH sends one
  // entry per blob; we also surface `truncated` so the client can warn.
  async fullTree(owner: string, name: string, ref: string): Promise<{ entries: Array<{ path: string; size?: number }>; truncated: boolean }> {
    const raw = await gh<{ tree: Array<Record<string, unknown>>; truncated: boolean }>(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}`,
      { query: { recursive: '1' } }
    );
    const entries = (raw.tree || [])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: String(e.path), size: typeof e.size === 'number' ? e.size : undefined }));
    return { entries, truncated: !!raw.truncated };
  },

  async fileContents(owner: string, name: string, path: string, ref?: string): Promise<GhFileContent> {
    const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
    return gh<GhFileContent>(`/repos/${owner}/${name}/contents/${encoded}`, {
      query: { ref },
    });
  },

  // Bytes-per-language breakdown, e.g. { Python: 12345, JavaScript: 67890 }.
  // We convert to percentages client-side.
  async languages(owner: string, name: string): Promise<Record<string, number>> {
    return gh<Record<string, number>>(`/repos/${owner}/${name}/languages`);
  },
};
