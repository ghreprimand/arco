import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBakeoff } from '../bakeoffStore.js';
import { bakeoffAttemptDiff } from '../gitBakeoff.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Read-only candidate diff for the BAKE-OFF tab.
//
// GET /api/git/bakeoffs/diff?wfid=<source>&bakeoffId=<id>&attemptId=<id>
//
// The manifest lookup binds all three ids back to the source cwd before any
// worktree path is read; gitBakeoff then reasserts the managed-root boundary.
export async function tryHandleGitBakeoffRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.method === 'GET' && req.url?.startsWith('/api/git/bakeoffs/diff'))) return false;
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const workflowId = url.searchParams.get('wfid') ?? '';
    const bakeoffId = url.searchParams.get('bakeoffId') ?? '';
    const attemptId = url.searchParams.get('attemptId') ?? '';
    const cwd = workflowCwds.get(workflowId);
    if (!cwd || !bakeoffId || !attemptId) {
      return send(400, { error: 'wfid, bakeoffId, and attemptId are required' });
    }
    const state = await readBakeoff(cwd, workflowId, bakeoffId);
    if (!state) return send(404, { error: 'bake-off not found' });
    const attempt = state.attempts.find((item) => item.id === attemptId);
    if (!attempt) return send(404, { error: 'attempt not found' });
    const patch = await bakeoffAttemptDiff(state, attempt);
    return send(200, {
      patch,
      from: state.baseRef,
      to: 'WORKTREE',
      branch: attempt.branch,
      cleaned: attempt.status === 'cleaned',
    });
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

