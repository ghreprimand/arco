import { spawnSync } from 'child_process';
import { IncomingMessage, ServerResponse } from 'http';
import { github, PrValidationError } from '../github.js';
import { PORT } from '../server/constants.js';
import { commitCountCache } from '../server/state.js';

// GitHub route group — peeled verbatim from router.ts (see
// docs/FILE_SIZE_REFACTOR_PLAN.md). Self-contained: defines its own
// sendGh / readBody helpers, takes no HttpDeps. Returns true when the
// GitHub prefix matched (request answered), false otherwise so the caller
// falls through to the next route group.
export async function tryHandleGithubRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // GitHub integration — gh-token-backed helper.
  // Commit-count results cached 60s per (owner/repo/sha) to avoid API hammering.
  if (!(req.url?.startsWith('/api/github/') && (req.method === 'GET' || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'))) {
    return false;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.replace(/^\/api\/github\//, '').split('/').filter(Boolean);
  const sendGh = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  const readBody = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  };
  try {
    if (parts[0] === 'user' && parts.length === 1 && req.method === 'GET') {
      return sendGh(200, await github.user());
    }
    // Resolve a local working-directory to its GitHub origin + current branch
    // so the right-panel can auto-scope to the repo the operator is actually
    // working in. 404 when cwd isn't a git repo or origin isn't GitHub.
    if (parts[0] === 'context' && parts.length === 1 && req.method === 'GET') {
      const cwd = url.searchParams.get('path') || '';
      if (!cwd) return sendGh(400, { error: 'path query required' });
      const remote = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
      if (remote.status !== 0) {
        return sendGh(404, { error: 'not a git working tree or no `origin` remote' });
      }
      const remoteUrl = remote.stdout.trim();
      // Accept: git@github.com:owner/name(.git)?, https://github.com/owner/name(.git)?, ssh://git@github.com/owner/name(.git)?
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!match) {
        return sendGh(404, { error: 'origin is not a github.com remote', remote: remoteUrl });
      }
      const branchProbe = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
      const branchRaw = branchProbe.status === 0 ? branchProbe.stdout.trim() : '';
      // Detached HEAD surfaces as 'HEAD' — treat as no branch so the repo
      // loads on its default_branch rather than a ref the UI can't resolve.
      const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
      return sendGh(200, { owner: match[1], name: match[2], branch });
    }
    if (parts[0] === 'repos' && parts.length === 1 && req.method === 'GET') {
      const search = url.searchParams.get('search') || undefined;
      const type = (url.searchParams.get('type') || 'owner') as 'all' | 'owner' | 'member' | 'public' | 'private';
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      return sendGh(200, await github.repos({ search, type, page }));
    }
    if (parts[0] === 'repos' && parts.length >= 3) {
      const owner = parts[1];
      const repo = parts[2];
      const rest = parts.slice(3);
      if (rest.length === 0 && req.method === 'GET') return sendGh(200, await github.repo(owner, repo));
      if (rest[0] === 'pulls' && rest.length === 1 && req.method === 'GET') {
        const state = (url.searchParams.get('state') || 'open') as 'open' | 'closed' | 'all';
        return sendGh(200, await github.pulls(owner, repo, state));
      }
      if (rest[0] === 'pulls' && rest.length === 2 && req.method === 'GET') return sendGh(200, await github.pull(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'files' && req.method === 'GET') return sendGh(200, await github.pullFiles(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'comments' && req.method === 'GET') return sendGh(200, await github.pullComments(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'checks' && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || '';
        if (!ref) return sendGh(400, { error: 'ref query required' });
        return sendGh(200, await github.pullChecks(owner, repo, ref));
      }
      if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'merge' && req.method === 'POST') {
        const body = (await readBody()) as { method?: 'merge' | 'squash' | 'rebase'; title?: string; message?: string };
        return sendGh(200, await github.mergePull(owner, repo, parseInt(rest[1], 10), {
          merge_method: body.method,
          commit_title: body.title,
          commit_message: body.message,
        }));
      }
      // Create a PR — operator-initiated outward action (the form submit IS the
      // confirmation). Title/body/base/head ride the JSON body to gh's REST
      // helper; never interpolated into a shell string. Validation error → 400
      // (distinct from a gh/network failure, which falls through to the 502
      // catch below).
      if (rest[0] === 'pulls' && rest.length === 1 && req.method === 'POST') {
        const body = (await readBody()) as { title?: string; body?: string; base?: string; head?: string };
        try {
          const pr = await github.createPullRequest(owner, repo, {
            title: body.title, body: body.body, base: body.base, head: body.head,
          });
          return sendGh(200, pr);
        } catch (err) {
          if (err instanceof PrValidationError) return sendGh(400, { error: err.message });
          throw err; // gh/network error → 502 catch
        }
      }
      if (rest[0] === 'issues' && rest.length === 1 && req.method === 'GET') {
        const state = (url.searchParams.get('state') || 'open') as 'open' | 'closed' | 'all';
        return sendGh(200, await github.issues(owner, repo, state));
      }
      if (rest[0] === 'issues' && rest.length === 2 && req.method === 'GET') return sendGh(200, await github.issue(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments' && req.method === 'GET') return sendGh(200, await github.issueComments(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments' && req.method === 'POST') {
        const body = (await readBody()) as { body?: string };
        if (!body.body) return sendGh(400, { error: 'body required' });
        return sendGh(200, await github.commentIssue(owner, repo, parseInt(rest[1], 10), body.body));
      }
      if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'close' && req.method === 'POST') return sendGh(200, await github.closeIssue(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'reopen' && req.method === 'POST') return sendGh(200, await github.reopenIssue(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'runs' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.runs(owner, repo));
      if (rest[0] === 'runs' && rest.length === 2 && req.method === 'GET') return sendGh(200, await github.run(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'runs' && rest.length === 3 && rest[2] === 'jobs' && req.method === 'GET') return sendGh(200, await github.runJobs(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'runs' && rest.length === 3 && rest[2] === 'rerun' && req.method === 'POST') return sendGh(200, await github.rerunRun(owner, repo, parseInt(rest[1], 10)));
      if (rest[0] === 'branches' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.branches(owner, repo));
      if (rest[0] === 'tags' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.tags(owner, repo));
      if (rest[0] === 'releases' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.releases(owner, repo));
      if (rest[0] === 'contributors' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.contributors(owner, repo));
      if (rest[0] === 'commits' && rest.length === 1 && req.method === 'GET') {
        const sha = url.searchParams.get('sha') || undefined;
        const path = url.searchParams.get('path') || undefined;
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        return sendGh(200, await github.commits(owner, repo, { sha, path, page }));
      }
      // Single-commit changed files (with inline patches) for the commit-detail
      // diff view. rest === ['commits', <sha>] (length 2) — distinct from the
      // commits-LIST route above (rest === ['commits'], length 1), so this
      // doesn't shadow it.
      if (rest[0] === 'commits' && rest.length === 2 && req.method === 'GET') {
        return sendGh(200, await github.commitFiles(owner, repo, rest[1]));
      }
      if (rest[0] === 'readme' && rest.length === 1 && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || undefined;
        return sendGh(200, await github.readme(owner, repo, ref));
      }
      if (rest[0] === 'tree' && rest.length === 1 && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || undefined;
        const path = url.searchParams.get('path') || '';
        const recursive = url.searchParams.get('recursive');
        if (recursive === '1') {
          if (!ref) return sendGh(400, { error: 'ref query required with recursive=1' });
          return sendGh(200, await github.fullTree(owner, repo, ref));
        }
        return sendGh(200, await github.tree(owner, repo, { ref, path }));
      }
      if (rest[0] === 'contents' && rest.length === 1 && req.method === 'GET') {
        const ref = url.searchParams.get('ref') || undefined;
        const path = url.searchParams.get('path') || '';
        if (!path) return sendGh(400, { error: 'path query required' });
        return sendGh(200, await github.fileContents(owner, repo, path, ref));
      }
      if (rest[0] === 'languages' && rest.length === 1 && req.method === 'GET') return sendGh(200, await github.languages(owner, repo));
      if (rest[0] === 'commit-count' && rest.length === 1 && req.method === 'GET') {
        const sha = url.searchParams.get('sha') || '';
        if (!sha) return sendGh(400, { error: 'sha query required' });
        const cacheKey = `${owner}/${repo}/${sha}`;
        const cached = commitCountCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 60_000) return sendGh(200, { count: cached.count });
        const count = await github.commitCount(owner, repo, sha);
        commitCountCache.set(cacheKey, { count, ts: Date.now() });
        return sendGh(200, { count });
      }
    }
    return sendGh(404, { error: 'Unknown GitHub endpoint' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendGh(502, { error: message });
  }
}
