import { IncomingMessage, ServerResponse } from 'http';
import { computeDiff, WORKTREE } from '../gitDiff.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Workbench Expansion A3 — Diff endpoint group.
//
//   GET /api/workflows/diff?wfid&path&from&to
//
// Returns a unified patch (see gitDiff.computeDiff) for the in-app DiffView.
// The renderer is source-agnostic; this route is the only place that knows a
// diff might come from a shadow checkpoint ref, a working-tree comparison, or
// any other git revision.
//
// Query params:
//   wfid  — workflow id (validated; resolves the cwd when ?path is omitted).
//   path  — explicit cwd (mirrors the other workflow-scoped routes). Falls
//           back to the wfid's live cwd if absent.
//   from  — base revision (a shadow ref like refs/arco/<wfid>/<seq>, or any
//           git rev). Omit for "working tree vs HEAD".
//   to    — target revision, or the literal WORKTREE for a pre-commit diff
//           (the default when omitted).
//
// Returns 200 with a structured body in every non-fatal case (non-git dir,
// missing ref, clean tree) so the client renders an explanation rather than
// choking on a 500.

// Workflow ids are UUIDs; reject anything that could escape the ref namespace
// when interpolated into refs/arco/<wfid>/… by the caller. Mirrors the
// gitSnapshots.validateWfid pattern (kept local — no cross-module import for a
// one-line guard).
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export async function tryHandleDiffRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/workflows/diff') && req.method === 'GET')) {
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
    // Prefer an explicit ?path (the other workflow routes pass it); otherwise
    // resolve the workflow's live cwd. A diff against a workflow with no bound
    // cwd is a clean empty result, not an error.
    const cwd = url.searchParams.get('path') || workflowCwds.get(wfid) || '';
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || WORKTREE;
    const result = await computeDiff({ cwd, from, to });
    return send(200, result);
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
