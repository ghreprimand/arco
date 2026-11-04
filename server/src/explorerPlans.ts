// Plans library — GET /api/explorer/plans. Every plan in every known project
// (~/.arco/known-cwds.json), so the operator can browse and review plans
// without attaching one to a workflow. Read-only aggregation; edits go through
// the ordinary /api/plans routes keyed by the `cwd` returned here.
//
// `cwd` is the known-cwds string as recorded (not its realpath): the plan
// routes and the attached-workflow broadcasts key on the workflow's own cwd
// string, so a symlinked project must round-trip the same spelling.

import { basename } from 'path';
import type { PlanLibraryProject } from '@arco/shared';
import { listPlans, listPlanRefs } from './planStore.js';
import { readKnownCwds, realpathWithinHome } from './explorerArtifacts.js';
import * as clusterStore from './clusterStore.js';

export async function collectPlanLibrary(): Promise<PlanLibraryProject[]> {
  const known = [...new Set(await readKnownCwds())];
  const clusters = await clusterStore.loadAllClustersFromDisk().catch(() => []);
  const out: PlanLibraryProject[] = [];
  for (const cwd of known) {
    if (!(await realpathWithinHome(cwd))) continue;
    const plans = await listPlans(cwd).catch(() => []);
    if (plans.length === 0) continue;
    const entries = await Promise.all(plans.map(async (p) => {
      const refs = await listPlanRefs(cwd, p.id).catch(() => []);
      const bound = clusters
        .filter((c) => c.cwd === cwd && c.planId === p.id)
        .map((c) => ({ clusterId: c.clusterId, name: c.name || `${c.clusterId.slice(0, 8)} cluster` }));
      const openSpan = (p.attachments ?? []).some((a) => a.detachedAt === null);
      return { ...p, refCount: refs.length, attached: openSpan || bound.length > 0, clusters: bound };
    }));
    out.push({ cwd, name: basename(cwd) || cwd, plans: entries });
  }
  // Projects with the most recently touched plan first.
  out.sort((a, b) => Math.max(...b.plans.map((p) => p.updatedAt)) - Math.max(...a.plans.map((p) => p.updatedAt)));
  return out;
}
