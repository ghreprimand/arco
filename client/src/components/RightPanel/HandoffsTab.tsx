import { useAppStore, type JobState, type HandoffLockEntry } from '../../stores/appStore';
import { HandoffList } from '../HandoffList';

const EMPTY_HANDOFF_LOCKS: HandoffLockEntry[] = [];

export function HandoffsTab({
  job,
  onCancelHandoff,
  onClearHandoffLock,
}: {
  job: JobState;
  onCancelHandoff?: (handoffId: string) => void;
  onClearHandoffLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const locks = useAppStore((s) => s.handoffLocksByCwd[job.config.workingDirectory] ?? EMPTY_HANDOFF_LOCKS);
  const normalRows = job.handoffs.map((handoff) => ({
    handoff,
    cwd: job.config.workingDirectory,
    workflowId: job.id,
    provider: job.config.primaryProvider,
  }));
  const lockRows = locks
    .filter((lock) => !job.handoffs.some((handoff) => handoff.handoffId === lock.handoffId))
    .map((lock) => {
      const lockJob = jobs[lock.workflowId];
      return {
        kind: 'lock' as const,
        cwd: job.config.workingDirectory,
        workflowId: lock.workflowId,
        provider: lockJob?.config.primaryProvider ?? 'claude',
        label: lock.workflowId === job.id
          ? undefined
          : `${lock.workflowName || lockJob?.config.name || lock.workflowId.slice(0, 8)} (same cwd)`,
        lockId: lock.handoffId ?? `preparing:${lock.workflowId}:${lock.startedAt}`,
        handoffId: lock.handoffId,
        status: lock.status,
        startedAt: lock.startedAt,
      };
    });
  return (
    <HandoffList
      rows={[...normalRows, ...lockRows]}
      emptyText="No handoffs yet. Use the HANDOFF button near the composer to rotate this session."
      onCancelHandoff={onCancelHandoff ? (_workflowId, handoffId) => onCancelHandoff(handoffId) : undefined}
      onClearLock={onClearHandoffLock}
    />
  );
}
