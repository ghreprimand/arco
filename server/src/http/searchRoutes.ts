import { IncomingMessage, ServerResponse } from 'http';
import { searchContent } from '../contentSearch.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Workbench Expansion A5 — Content search endpoint group.
//
//   GET /api/search/content?wfid&q[&path][&max]
//
// Thin HTTP glue over contentSearch.searchContent (the reusable rg engine F3
// also calls). Returns a structured hit list the CommandPalette renders; each
// hit clicks through to the FileViewerModal.
//
// Query params:
//   wfid — workflow id (validated; resolves the cwd when ?path is omitted).
//   q    — the search query (literal regex; empty → empty result).
//   path — explicit cwd (mirrors the other workflow-scoped routes).
//   max  — optional hit cap (1..1000; default from searchContent).
//
// Always 200 in non-fatal cases. When `rg` is missing the body carries
// { available:false } so the client shows a hint instead of choking on a 500.

// Mirrors diffRoutes.isValidWfid — UUID-ish ids only, no ref-namespace escapes.
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export async function tryHandleSearchRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/search/content') && req.method === 'GET')) {
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
      // No bound cwd is an empty result, not an error (the workflow may not
      // have started a turn yet).
      return send(200, { available: true, hits: [], capped: false });
    }
    const query = url.searchParams.get('q') || '';
    const maxRaw = parseInt(url.searchParams.get('max') || '', 10);
    const maxHits = Number.isInteger(maxRaw) && maxRaw > 0 && maxRaw <= 1000 ? maxRaw : undefined;
    const result = await searchContent({ cwd, query, maxHits });
    return send(200, result);
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
