import { IncomingMessage, ServerResponse } from 'http';
import type { WorktreeListResponse } from '@archon/shared';
import { listWorktrees } from '../project/taskWorktree.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Worktree-aware diff views — enumerate a repo's linked worktrees so the
// FilesTab picker can point LIVE / CHANGES / SOURCE / REMOTE at the tree a
// worker is actually editing.
//
//   GET /api/git/worktrees?wfid[&path]  → { isRepo, worktrees[] }
//
// Cluster members share the main checkout but do their edits inside an Archon
// task worktree (~/.archon/worktrees/…) or one they created themselves — both
// live OUTSIDE the shared cwd, so `git status` there reads clean. This endpoint
// surfaces those trees so the operator can watch the right one.
//
// Mirrors gitDiffRoutes: 200 with a structured body (isRepo:false) in the
// non-git case rather than a 500; `path` wins, falling back to the wfid's cwd.

function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export async function tryHandleGitWorktreeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/git/worktrees') && req.method === 'GET')) {
    return false;
  }
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const wfid = url.searchParams.get('wfid') || '';
    if (!wfid || !isValidWfid(wfid)) {
      return send(400, { error: 'valid wfid query required' });
    }
    const cwd = url.searchParams.get('path') || workflowCwds.get(wfid) || '';
    if (!cwd) {
      return send(200, { isRepo: false, worktrees: [] } satisfies WorktreeListResponse);
    }
    const worktrees = await listWorktrees(cwd);
    return send(200, { isRepo: worktrees.length > 0, worktrees } satisfies WorktreeListResponse);
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
