// Reads the live stores and hands the readings to the pure fact builders.
import type { UtilityJobFact } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useLiveChangesStore } from '../stores/liveChangesStore';
import { hasWaitingQuestion } from '../questions/waitingQuestion';
import { collectBoardFacts, collectClusterFacts, collectWorkerFacts } from './briefFacts';

const CLOSED = new Set(['done', 'archived']);

function changedFilesFor(workflowId: string): number | null {
  let best: { ts: number; count: number } | null = null;
  for (const [key, snap] of Object.entries(useLiveChangesStore.getState().snapshots)) {
    if (!key.startsWith(`${workflowId}\0`) || !snap.data.isRepo) continue;
    const paths = new Set([...snap.data.staged, ...snap.data.unstaged, ...snap.data.untracked].map((e) => e.path));
    if (!best || snap.ts > best.ts) best = { ts: snap.ts, count: paths.size };
  }
  return best ? best.count : null;
}

export function workerBriefFacts(workflowId: string, now = Date.now()): { name: string; facts: UtilityJobFact[]; blocked: boolean } {
  const s = useAppStore.getState();
  const cluster = Object.values(s.clusters).find((c) => c.members.some((m) => m.workflowId === workflowId));
  const member = cluster?.members.find((m) => m.workflowId === workflowId);
  const job = s.jobs[workflowId];
  const name = member?.displayName ?? job?.config?.name ?? workflowId.slice(0, 8);
  const ledgerKey = cluster?.cwd && cluster.taskBoardKey ? `${cluster.cwd}::${cluster.taskBoardKey}` : (cluster?.cwd ?? job?.config?.workingDirectory ?? '');
  const open = (s.taskLedger[ledgerKey] ?? []).filter((t) => t.assignee === workflowId && !CLOSED.has(t.status));
  const depth = cluster?.mailboxDepth?.[workflowId];
  const facts = collectWorkerFacts({
    name,
    role: member?.role,
    job,
    hasQuestion: hasWaitingQuestion(job),
    pendingMail: Number.isSafeInteger(depth) && (depth as number) > 0 ? (depth as number) : 0,
    tasks: open,
    changedFiles: changedFilesFor(workflowId),
    now,
  });
  return { name, facts, blocked: open.some((t) => t.status === 'blocked') };
}

export function clusterBriefFacts(clusterId: string, now = Date.now()): UtilityJobFact[] {
  const cluster = useAppStore.getState().clusters[clusterId];
  if (!cluster) return [];
  const s = useAppStore.getState();
  const ledgerKey = cluster.cwd && cluster.taskBoardKey ? `${cluster.cwd}::${cluster.taskBoardKey}` : (cluster.cwd ?? '');
  return [
    ...collectClusterFacts(cluster.members.map((m) => workerBriefFacts(m.workflowId, now))),
    ...collectBoardFacts(ledgerKey ? s.taskLedger[ledgerKey] ?? [] : [], now),
  ];
}
