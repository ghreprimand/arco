// Local runtime capacity (Ollama, llama.cpp): how many cluster members may
// use each runtime at once, set in Connections (default 1). Checked only when
// a change adds a local member, so unrelated edits to an existing cluster are
// never refused. ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1 lifts the limit.
import { isLocalClusterRuntime, localCapacityProblem, type LocalClusterCapacity } from '@arco/shared';
import { workflows } from './server/state.js';
import { readSettings } from './settings.js';

export function memberProvider(workflowId: string): string {
  return workflows.get(workflowId)?.config.primaryProvider ?? 'claude';
}

export async function localCapacityRefusal(
  resulting: readonly string[],
  added: readonly string[],
  readCapacity: () => Promise<LocalClusterCapacity | undefined> = async () => (await readSettings().catch(() => null))?.localClusterCapacity,
): Promise<string | null> {
  if (!added.some(isLocalClusterRuntime)) return null;
  if (process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL === '1') return null;
  const problem = localCapacityProblem(resulting, await readCapacity());
  return problem ? `local_capacity: ${problem}` : null;
}
