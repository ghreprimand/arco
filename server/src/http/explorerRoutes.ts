// ARCHIVE (docs/ARCHIVE_PLAN.md) — the /api/explorer/* HTTP surface backing the
// standalone chromeless file-explorer window. Read-only (v1): window launch,
// the artifacts join, the agent-writes ledger read, and the changed-within
// scan. All new listing/scan endpoints are $HOME-jailed with a post-resolution
// realpath check (§5 fencing), the same discipline as /api/docs/source.
//
// Phase 1: POST /api/explorer/open (launch, fail-soft so the client popup
// fallback engages). Later phases add GET /artifacts, /recents, /changed.

import { IncomingMessage, ServerResponse } from 'http';
import { launchExplorerWindow } from '../explorerLaunch.js';
import { collectArtifacts } from '../explorerArtifacts.js';
import { collectDocs } from '../explorerDocs.js';
import { readRecent } from '../recentFilesLedger.js';
import { scanChanged } from '../explorerChanged.js';
import { collectPlanLibrary } from '../explorerPlans.js';
import { PORT } from '../server/constants.js';

function sendJson(res: ServerResponse, code: number, body: unknown): true {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

// Derive the page origin the explorer window should load. Prefer the browser-
// supplied Origin header (the operator's actual page origin — dev 5173 / prod
// 3001 / a tunnel host all resolve correctly without config); fall back to the
// Host header with an http scheme when Origin is absent (some fetch paths).
function deriveOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) return origin;
  const host = req.headers.host;
  if (typeof host === 'string' && host.length > 0) return `http://${host}`;
  return `http://localhost:${PORT}`;
}

export async function tryHandleExplorerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || '';

  // POST /api/explorer/open — spawn the chromeless browser window (§3). Never
  // throws / never 5xxs on a launch failure: a `no-browser` / `spawn-failed`
  // result comes back 200 with { ok:false, code } so the client falls back to
  // window.open. A genuinely unexpected error still degrades to a soft result.
  if (url.startsWith('/api/explorer/open') && req.method === 'POST') {
    try {
      const result = await launchExplorerWindow(deriveOrigin(req));
      return sendJson(res, 200, result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { ok: false, code: 'spawn-failed', error });
    }
  }

  // GET /api/explorer/artifacts[?project=<abs cwd>] — the server-side artifacts
  // join (§4.1). Global (known-cwds.json) when no project; per-project when
  // scoped. Always 200 with { entries }; degrades to [] on error (never 5xx).
  if (url.startsWith('/api/explorer/artifacts') && req.method === 'GET') {
    try {
      const project = new URL(url, `http://localhost:${PORT}`).searchParams.get('project') || undefined;
      const entries = await collectArtifacts(project ? { project } : {});
      return sendJson(res, 200, { entries });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { entries: [], error });
    }
  }

  // GET /api/explorer/plans — the PLANS lens: every plan across known
  // projects, with ref counts + attachment status. Always 200; [] on error.
  if (url.startsWith('/api/explorer/plans') && req.method === 'GET') {
    try {
      return sendJson(res, 200, { projects: await collectPlanLibrary() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { projects: [], error });
    }
  }

  // GET /api/explorer/docs[?project=<abs cwd>] — project-tree DOCUMENTS (§4.1).
  // The docs written FOR a project (Reports/*.md, root *.md, docs/*.md), the
  // half the .archon artifacts join can't see. Global (known-cwds, bounded
  // per-project) or one project. Always 200; degrades to [] on error.
  if (url.startsWith('/api/explorer/docs') && req.method === 'GET') {
    try {
      const project = new URL(url, `http://localhost:${PORT}`).searchParams.get('project') || undefined;
      const entries = await collectDocs(project ? { project } : {});
      return sendJson(res, 200, { entries });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { entries: [], error });
    }
  }

  // GET /api/explorer/recents[?limit=100] — the AGENT WRITES ledger read
  // (§4.2), newest-first. Always 200; degrades to [] on error. Filtering (DOCS
  // / IMAGES / ALL, per-project) is client-side.
  if (url.startsWith('/api/explorer/recents') && req.method === 'GET') {
    try {
      const raw = new URL(url, `http://localhost:${PORT}`).searchParams.get('limit');
      const limit = Math.min(1000, Math.max(1, Number(raw) || 100));
      const records = await readRecent(limit);
      return sendJson(res, 200, { records });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { records: [], error });
    }
  }

  // GET /api/explorer/changed[?within=48h][&project=<abs>] — the exhaustive
  // changed-within scan (§4.2). Portable Node walk, pruned + depth/count-capped.
  // Always 200; degrades to [] on error.
  if (url.startsWith('/api/explorer/changed') && req.method === 'GET') {
    try {
      const q = new URL(url, `http://localhost:${PORT}`).searchParams;
      const within = q.get('within') || undefined;
      const project = q.get('project') || undefined;
      const entries = await scanChanged({ within, project });
      return sendJson(res, 200, { entries });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { entries: [], error });
    }
  }

  return false;
}
