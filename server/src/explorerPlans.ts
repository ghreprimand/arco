// Plans library — GET /api/explorer/plans. Every plan in every known project
// (~/.arco/known-cwds.json), so the operator can browse and review plans
// without attaching one to a workflow. Read-only aggregation; edits go through
// the ordinary /api/plans routes keyed by the `cwd` returned here.
//
// `cwd` is the known-cwds string as recorded (not its realpath): the plan
// routes and the attached-workflow broadcasts key on the workflow's own cwd
// string, so a symlinked project must round-trip the same spelling.

import { basename, join } from 'path';
import { open } from 'node:fs/promises';
import type { PlanLibraryProject } from '@arco/shared';
import { listPlans, listPlanRefs } from './planStore.js';
import { readKnownCwds, realpathWithinHome } from './explorerArtifacts.js';
import * as clusterStore from './clusterStore.js';

export function countPlanCheckboxes(body: string): { checkboxTotal: number; checkboxDone: number } {
  const boxes = [...body.matchAll(/^\s*[-*+]\s+\[([ xX])\]/gm)];
  return { checkboxTotal: boxes.length, checkboxDone: boxes.filter((m) => m[1].toLowerCase() === 'x').length };
}

async function checkboxCounts(cwd: string, id: string): Promise<{ checkboxTotal: number; checkboxDone: number }> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) return { checkboxTotal: 0, checkboxDone: 0 };
  let file;
  try {
    file = await open(join(cwd, '.arco', 'plans', `${id}.md`), 'r');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    // An incomplete body cannot safely establish that all boxes are checked.
    if (bytesRead > 256 * 1024) return { checkboxTotal: 0, checkboxDone: 0 };
    return countPlanCheckboxes(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { return { checkboxTotal: 0, checkboxDone: 0 }; }
  finally { await file?.close(); }
}

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
      return { ...p, ...await checkboxCounts(cwd, p.id), refCount: refs.length, attached: openSpan || bound.length > 0, clusters: bound };
    }));
    out.push({ cwd, name: basename(cwd) || cwd, plans: entries });
  }
  // Projects with the most recently touched plan first.
  out.sort((a, b) => Math.max(...b.plans.map((p) => p.updatedAt)) - Math.max(...a.plans.map((p) => p.updatedAt)));
  return out;
}
