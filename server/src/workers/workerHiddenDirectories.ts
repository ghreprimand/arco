import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { arcoHome } from '../arcoHome.js';
import * as clusterStore from '../clusterStore.js';

/** Real host paths that a worker must not read through the outer namespace. */
export function workerHiddenDirectories(cluster: clusterStore.ClusterState, extra: readonly string[] = []): string[] {
  const home = homedir();
  return [...new Set([
    home, arcoHome(), cluster.cwd, join(home, '.claude'), join(home, '.codex'),
    ...(process.env.CLAUDE_CONFIG_DIR ? [resolve(process.env.CLAUDE_CONFIG_DIR)] : []),
    ...(process.env.CODEX_HOME ? [resolve(process.env.CODEX_HOME)] : []),
    ...extra.map(path => resolve(path)),
    ...cluster.members.flatMap(id => [clusterStore.memberCwdFor(cluster, id), clusterStore.isolatedWorkspaceFor(cluster.clusterId, id)]),
  ])];
}
