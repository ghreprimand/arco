import { useAppStore } from '../../stores/appStore';
import { HandoffList, type HandoffListRow } from '../HandoffList';
import type { ClusterStatePayload } from '@archon/shared';
import type { HandoffLockEntry } from '../../stores/appStore';

const EMPTY_HANDOFF_LOCKS: HandoffLockEntry[] = [];

export function ClusterHandoffsTab({
  cluster,
  onCancelHandoff,
  onClearHandoffLock,
}: {
  cluster: ClusterStatePayload;
  onCancelHandoff?: (workflowId: string, handoffId: string) => void;
  onClearHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const locks = useAppStore((s) => s.handoffLocksByCwd[cluster.cwd] ?? EMPTY_HANDOFF_LOCKS);
  const memberLabels = new Map(cluster.members.map((member) => [member.workflowId, member.displayName]));
  const rows: HandoffListRow[] = Object.values(jobs).flatMap((job) => {
    if (job.config.workingDirectory !== cluster.cwd || job.handoffs.length === 0) return [];
    const memberLabel = memberLabels.get(job.id);
    const label = memberLabel ?? `${job.config.name || job.id.slice(0, 8)} (same cwd)`;
    return job.handoffs.map((handoff) => ({
      handoff,
      cwd: job.config.workingDirectory,
      workflowId: job.id,
      provider: job.config.primaryProvider,
      label,
    }));
  });
  const lockRows: HandoffListRow[] = locks
    .filter((lock) => !rows.some((row) => row.kind !== 'lock' && row.workflowId === lock.workflowId && row.handoff.handoffId === lock.handoffId))
    .map((lock) => {
      const job = jobs[lock.workflowId];
      const memberLabel = memberLabels.get(lock.workflowId);
      return {
        kind: 'lock',
        cwd: cluster.cwd,
        workflowId: lock.workflowId,
        provider: job?.config.primaryProvider ?? 'claude',
        label: memberLabel ?? `${lock.workflowName || job?.config.name || lock.workflowId.slice(0, 8)} (same cwd)`,
        lockId: lock.handoffId ?? `preparing:${lock.workflowId}:${lock.startedAt}`,
        handoffId: lock.handoffId,
        status: lock.status,
        startedAt: lock.startedAt,
      };
    });

  return (
    <HandoffList
      rows={[...rows, ...lockRows]}
      emptyText="No handoffs yet for live workflows in this cwd."
      onCancelHandoff={onCancelHandoff}
      onClearLock={onClearHandoffLock}
    />
  );
}
