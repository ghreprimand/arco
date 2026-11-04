import { IncomingMessage, ServerResponse } from 'http';
import { getWorkingChanges, getFileDiff } from '../gitWorking.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Workbench Expansion I1 — Working-tree changes endpoint.
//
//   GET /api/git/diff?wfid[&path]                  → grouped status list
//   GET /api/git/diff?wfid[&path]&file=<p>&staged  → that file's unified diff
//
// Distinct from A3's GET /api/workflows/diff (whole-tree / ref-vs-ref patch).
// This one powers the "Source Control"-style file list: list the changed
// files grouped staged/unstaged/untracked, then fetch one file's diff on
// click. Both feed the same source-agnostic DiffView.
//
// Query params:
//   wfid   — workflow id (validated; resolves the cwd when ?path is omitted).
//   path   — explicit cwd (mirrors diffRoutes / searchRoutes). Falls back to
//            the wfid's live cwd.
//   file   — repo-relative path of a single file. Present → per-file diff
//            mode; absent → grouped list mode.
//   staged — "1"/"true" to diff the staged (index vs HEAD) change; otherwise
//            the unstaged (work tree vs index) change. Ignored for untracked.
//
// Always 200 with a structured body in the non-fatal cases (non-git dir,
// missing/invalid file) so the client renders an explanation, not a 500.

// Mirrors diffRoutes.isValidWfid — UUID-ish ids only, no ref-namespace escapes.
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export async function tryHandleGitDiffRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/git/diff') && req.method === 'GET')) {
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
    const file = url.searchParams.get('file');

    if (file) {
      const stagedRaw = url.searchParams.get('staged') || '';
      const staged = stagedRaw === '1' || stagedRaw === 'true';
      if (!cwd) {
        return send(200, { isRepo: false, patch: '', path: file, staged });
      }
      const result = await getFileDiff(cwd, { path: file, staged });
      return send(200, result);
    }

    if (!cwd) {
      return send(200, { isRepo: false, staged: [], unstaged: [], untracked: [] });
    }
    const result = await getWorkingChanges(cwd);
    return send(200, result);
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
