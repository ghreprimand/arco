import { useAppStore } from '../stores/appStore';

// Which workflow a terminal opened "from here" binds to, plus its root. Shared
// by the header's TERMINAL launcher and the auth LOGIN-in-terminal buttons.
//
// A CLUSTER tab has NO active job (activeJobId is null when a cluster is
// active — they're mutually exclusive), but its members share one cwd and ARE
// real workflows. Bind to the focused member (else the first member), so a
// cluster tab can still open a terminal in the cluster root. The cluster
// PARENT isn't a server-side workflow, so it can't be the target; a member can.
// Selectors return PRIMITIVES only — returning a fresh object from a Zustand
// selector makes useSyncExternalStore see a new snapshot every render
// ("getSnapshot should be cached" → infinite loop).
export function useTerminalTarget(): { workflowId?: string; root?: string } {
  const activeJobId = useAppStore((s) => s.activeJobId);
  const activeJobRoot = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId]?.config.workingDirectory : undefined));
  const clusterMemberId = useAppStore((s) => {
    if (!s.activeClusterId) return undefined;
    const cluster = s.clusters[s.activeClusterId];
    if (!cluster) return undefined;
    const focused = s.clusterFocusedMember[s.activeClusterId];
    if (focused && cluster.members.some((m) => m.workflowId === focused)) return focused;
    return cluster.members[0]?.workflowId;
  });
  const clusterRoot = useAppStore((s) => {
    if (!s.activeClusterId) return undefined;
    const cluster = s.clusters[s.activeClusterId];
    if (!cluster) return undefined;
    const focused = s.clusterFocusedMember[s.activeClusterId];
    const memberId = (focused && cluster.members.some((m) => m.workflowId === focused))
      ? focused
      : cluster.members[0]?.workflowId;
    return (memberId ? s.jobs[memberId]?.config.workingDirectory : undefined) ?? cluster.cwd;
  });
  const workflowId = activeJobId ?? clusterMemberId ?? undefined;
  const root = activeJobId ? activeJobRoot : clusterRoot;
  return { workflowId, root };
}
