// ARCHIVE (docs/CLIENT.md) - the /api/explorer/* HTTP surface backing the
// standalone chromeless file-explorer window. Read-only (v1): window launch,
// the artifacts join, the agent-writes ledger read, and the changed-within
// scan. All new listing/scan endpoints are $HOME-jailed with a post-resolution
// realpath check (§5 fencing), the same discipline as /api/docs/source.
//
// Phase 1: POST /api/explorer/open (launch, fail-soft so the client popup
// fallback engages). Later phases add GET /artifacts, /recents, /changed.

import { IncomingMessage, ServerResponse } from 'http';
import { realpath } from 'fs/promises';
import { launchExplorerWindow } from '../explorerLaunch.js';
import { collectArtifacts } from '../explorerArtifacts.js';
import { collectDocsPage } from '../explorerDocs.js';
import { readRecent } from '../recentFilesLedger.js';
import { scanChangedPage } from '../explorerChanged.js';
import { collectPlanLibrary } from '../explorerPlans.js';
import * as clusterStore from '../clusterStore.js';
import { attachExistingPlan } from '../clusterPlanBridge.js';
import { isValidPlanId } from '../planStore.js';
import { broadcastCluster, buildClusterStatePayload } from '../server/broadcast.js';
import { workflowCwds } from '../server/state.js';
import { PORT, UUID_PATTERN } from '../server/constants.js';

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

  if (new URL(url, 'http://localhost').pathname === '/api/explorer/plans/target' && req.method === 'GET') {
    try {
      const params = new URL(url, 'http://localhost').searchParams;
      const cwd = params.get('path');
      const kind = params.get('kind');
      const id = params.get('id');
      if (!cwd || !id || (kind !== 'workflow' && kind !== 'cluster')) return sendJson(res, 400, { error: 'Invalid attachment target.' });
      const targetCwd = kind === 'cluster' && UUID_PATTERN.test(id)
        ? (await clusterStore.readCluster(id))?.cwd
        : kind === 'workflow' ? workflowCwds.get(id) : undefined;
      if (!targetCwd) return sendJson(res, 404, { error: 'Target is no longer available.' });
      const [projectPath, targetPath] = await Promise.all([realpath(cwd), realpath(targetCwd)]);
      return sendJson(res, 200, { sameProject: projectPath === targetPath });
    } catch {
      return sendJson(res, 400, { error: 'Could not compare project folders.' });
    }
  }

  // This operator-only route attaches a plan to a cluster, not to a member.
  // Recheck the target folder on the server before looking up the plan.
  if (new URL(url, 'http://localhost').pathname === '/api/explorer/plans/attach' && req.method === 'POST') {
    try {
      const params = new URL(url, 'http://localhost').searchParams;
      const cwd = params.get('path');
      const clusterId = params.get('clusterId');
      const planId = params.get('planId');
      if (!cwd || !clusterId || !UUID_PATTERN.test(clusterId) || !planId || !isValidPlanId(planId)) return sendJson(res, 400, { error: 'Invalid attachment target.' });
      const cluster = await clusterStore.readCluster(clusterId);
      if (!cluster || await realpath(cluster.cwd) !== await realpath(cwd)) return sendJson(res, 400, { error: 'The cluster belongs to another project.' });
      const plan = await attachExistingPlan(clusterId, planId, cluster.cwd);
      if (!plan) return sendJson(res, 404, { error: 'Plan not found in this project.' });
      broadcastCluster(clusterId, { type: 'cluster_plan_changed', clusterId, body: plan.body, updatedAt: plan.updatedAt, bodyLength: plan.body.length });
      const state = await buildClusterStatePayload(clusterId);
      if (state) broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // POST /api/explorer/open — spawn the chromeless browser window (§3). Never
  // throws / never 5xxs on a launch failure: a `no-browser` / `spawn-failed`
  // result comes back 200 with { ok:false, code } so the client falls back to
  // window.open. A genuinely unexpected error still degrades to a soft result.
  if (url.startsWith('/api/explorer/open') && req.method === 'POST') {
    try {
      const params = new URL(url, 'http://localhost').searchParams;
      const targetKind = params.get('targetKind');
      const result = await launchExplorerWindow(deriveOrigin(req), { lens: params.get('lens') === 'plans' ? 'plans' : undefined, cwd: params.get('cwd') || undefined, targetKind: targetKind === 'workflow' || targetKind === 'cluster' ? targetKind : undefined, targetId: params.get('targetId') || undefined, targetName: params.get('targetName') || undefined, targetCwd: params.get('targetCwd') || undefined });
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
  // half the .arco artifacts join can't see. Global (known-cwds, bounded
  // per-project) or one project. Always 200; degrades to [] on error.
  if (url.startsWith('/api/explorer/docs') && req.method === 'GET') {
    try {
      const project = new URL(url, `http://localhost:${PORT}`).searchParams.get('project') || undefined;
      const result = await collectDocsPage(project ? { project } : {});
      return sendJson(res, 200, result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { entries: [], error });
    }
  }

  // GET /api/explorer/recents[?limit=100] — the file-write attribution ledger read
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

  // GET /api/explorer/changed[?within=48h][&project=<abs>]: bounded scan.
  // Returns { entries, partial }; traversal or result limits mark partial.
  // Always 200; errors return { entries: [], error }.
  if (url.startsWith('/api/explorer/changed') && req.method === 'GET') {
    try {
      const q = new URL(url, `http://localhost:${PORT}`).searchParams;
      const within = q.get('within') || undefined;
      const project = q.get('project') || undefined;
      const result = await scanChangedPage({ within, project });
      return sendJson(res, 200, result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return sendJson(res, 200, { entries: [], error });
    }
  }

  return false;
}
