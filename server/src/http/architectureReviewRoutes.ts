// P8.5 Architecture review actions on a report in OUTPUTS: list its
// candidates, ADD TO PLAN and RECORD DECISION. Both write only to the plan
// attached to the conversation (its tab or its cluster), and only after the
// operator confirms in the client.
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { realpathWithinProjects } from '../projects.js';
import { outputDirectory } from '../outputStore.js';
import { workflows } from '../server/state.js';
import * as clusterStore from '../clusterStore.js';
import { readMeta } from '../workflowMeta.js';
import { readPlanSummary } from '../planStore.js';
import { addCandidateToPlan, readArchitectureReport, recordCandidateDecision } from '../architectureReview.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  catch { return null; }
}

async function projectFor(cwd: unknown): Promise<string | null> {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const key = await realpathWithinProjects(path.resolve(cwd));
  if (!key) return null;
  try { if ((await lstat(path.join(key, '.arco'))).isSymbolicLink()) return null; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  return key;
}

// The plan the conversation works from: its own attached plan, else its
// cluster's shared plan.
export async function attachedPlanId(cwd: string, workflowId: string): Promise<string | undefined> {
  const live = workflows.get(workflowId)?.planId;
  if (live) return live;
  const cluster = clusterStore.getClusterIdForWorkflow(workflowId);
  const shared = cluster ? clusterStore.getPlanId(cluster) : undefined;
  if (shared) return shared;
  return (await readMeta(cwd, workflowId).catch(() => null))?.planId;
}

export async function tryHandleArchitectureReviewRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  const match = /^\/api\/architecture-review\/(candidates|add-to-plan|record-decision)(?:\?|$)/.exec(url);
  if (!match) return false;
  if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
  const action = match[1];
  const body = await readJson(req);
  if (!body) { json(res, 400, { error: 'invalid_body' }); return true; }
  const project = await projectFor(body.path);
  if (!project) { json(res, 403, { error: 'Project is unavailable' }); return true; }
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
  if (typeof body.report !== 'string') { json(res, 400, { error: 'report required' }); return true; }
  try {
    const report = await readArchitectureReport(await outputDirectory(project, workflowId), body.report);
    const planId = await attachedPlanId(project, workflowId);
    const plan = planId ? await readPlanSummary(project, planId) : null;
    if (action === 'candidates') {
      json(res, 200, { ...report, plan: plan ? { id: plan.id, title: plan.title } : null });
      return true;
    }
    if (body.confirm !== true) { json(res, 400, { error: 'confirmation_required' }); return true; }
    if (!plan) { json(res, 409, { error: 'This conversation has no plan attached. Attach a plan with PLAN in the composer first.' }); return true; }
    if (typeof body.candidateId !== 'string') { json(res, 400, { error: 'candidateId required' }); return true; }
    if (action === 'add-to-plan') {
      const added = await addCandidateToPlan(project, plan.id, report, body.candidateId);
      json(res, 200, { ok: true, plan: { id: plan.id, title: plan.title }, ...added });
      return true;
    }
    await recordCandidateDecision(project, plan.id, report, body.candidateId, typeof body.reason === 'string' ? body.reason : '');
    json(res, 200, { ok: true, plan: { id: plan.id, title: plan.title } });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
