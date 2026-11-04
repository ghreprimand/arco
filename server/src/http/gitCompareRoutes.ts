import { IncomingMessage, ServerResponse } from 'http';
import { fetchRemote, getUpstreamComparison, getComparisonDiff } from '../gitWorking.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Workbench Expansion I2 — local ↔ remote comparison + fetch endpoints.
//
//   GET  /api/git/compare?wfid[&path]              → ahead/behind commit lists + diffstat
//   GET  /api/git/compare/diff?wfid&direction[&path] → per-direction unified diff (A3 DiffView)
//   POST /api/git/fetch  {wfid?,path?,remote?}      → `git fetch <remote>`
//
// Sibling to I1's gitDiffRoutes.ts and mirrors its conventions: wfid validated,
// ?path overrides the wfid's live cwd. I2 SHOWS state and fetches (refs only);
// the mutating push/pull lands in I3.
//
// Always 200 with a structured body in the non-fatal cases (non-git dir, no
// upstream, detached HEAD, offline/auth fetch failure) so the client renders an
// explanation, not a 500. Wired AFTER /api/git/status, /api/git/checkout and
// /api/git/diff so its startsWith guards can't shadow them (router.ts).

// Mirrors gitDiffRoutes.isValidWfid — UUID-ish ids only, no ref-namespace escapes.
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export async function tryHandleGitCompareRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const isCompare = req.url?.startsWith('/api/git/compare') && req.method === 'GET';
  const isFetch = req.url?.startsWith('/api/git/fetch') && req.method === 'POST';
  if (!isCompare && !isFetch) return false;

  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  try {
    if (isCompare) {
      const url = new URL(req.url!, `http://localhost:${PORT}`);
      const wfid = url.searchParams.get('wfid') || '';
      if (!wfid || !isValidWfid(wfid)) {
        return send(400, { error: 'valid wfid query required' });
      }
      const cwd = url.searchParams.get('path') || workflowCwds.get(wfid) || '';

      // /api/git/compare/diff — per-direction unified diff for the A3 renderer.
      if (url.pathname === '/api/git/compare/diff') {
        const dirRaw = url.searchParams.get('direction');
        const direction = dirRaw === 'behind' ? 'behind' : 'ahead';
        if (!cwd) {
          return send(200, { isRepo: false, patch: '', path: direction, staged: false });
        }
        const diff = await getComparisonDiff(cwd, direction);
        return send(200, diff);
      }

      if (!cwd) {
        return send(200, { isRepo: false });
      }
      const result = await getUpstreamComparison(cwd);
      return send(200, result);
    }

    // POST /api/git/fetch — body { wfid?, path?, remote? }.
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw || '{}') as { wfid?: string; path?: string; remote?: string };
    const wfid = typeof parsed.wfid === 'string' ? parsed.wfid : '';
    if (wfid && !isValidWfid(wfid)) {
      return send(400, { error: 'invalid wfid' });
    }
    const cwd = (typeof parsed.path === 'string' && parsed.path)
      || (wfid ? workflowCwds.get(wfid) : '')
      || '';
    if (!cwd) {
      return send(200, { ok: false, remote: parsed.remote ?? '', fetched: false, error: 'no working directory' });
    }
    const remote = typeof parsed.remote === 'string' ? parsed.remote : undefined;
    const result = await fetchRemote(cwd, remote);
    // ok:false (offline / auth) is a non-fatal operator-visible condition → 200.
    return send(200, result);
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
