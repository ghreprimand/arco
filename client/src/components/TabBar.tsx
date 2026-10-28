import { layoutPoint } from '../utils/pointer';
import { useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore, type JobState } from '../stores/appStore';
import { TabContextMenu } from './TabContextMenu';
import type { ClusterMemberProvider, ClusterStatePayload, ArcoSettings, ProviderName } from '@arco/shared';

interface Props {
  // Server-side lifecycle: tells the server to tear down the WorkflowState +
  // any in-flight worker for this workflow. Keeps `removeJob` local so the
  // UI stays responsive even if the socket is temporarily closed.
  onRemoveWorkflow: (workflowId: string) => void;
  // docs/PROTOCOL_CLUSTER.md - operator clicked "CREATE CLUSTER" in the
  // right-click menu, or hit × on a cluster tab. Implemented at App.tsx via
  // useWebSocket's createCluster / deleteCluster helpers.
  onCreateCluster: (cwd: string, memberWorkflowIds: string[]) => void;
  onDeleteCluster: (clusterId: string) => void;
  // Phase 2.5 B2 — add a Native tab to an existing same-cwd cluster.
  onAddClusterMember: (clusterId: string, workflowId: string) => void;
  // Phase 2.5 B3 — create a cluster with the right-clicked tab + N fresh
  // workers (cwd + primary inherited). Operator picks N (1-4) + optional
  // name.
  // 2026-05-11 — `opts` carries the optional name + provider/model/effort
  // picker. Undefined → server inherits everything from the anchor.
  onCreateClusterWithFreshWorkers: (
    sourceWorkflowId: string,
    additionalCount: number,
    opts?: { name?: string; provider?: ClusterMemberProvider; model?: string; effort?: string },
  ) => void;
}

// Slice 6a — derived display name for a cluster. Operator-renamed wins;
// otherwise `<basename(cwd)> · <short-id>` so newly created clusters carry
// the cwd context immediately. The default is computed; not persisted.
export function clusterDisplayName(cluster: ClusterStatePayload): string {
  if (cluster.name && cluster.name.trim().length > 0) return cluster.name;
  const cwd = cluster.cwd || '';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const basename = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const short = cluster.clusterId.slice(0, 8);
  return basename ? `${basename} · ${short}` : short;
}

type TopRowItem =
  | { kind: 'workflow'; id: string; job: JobState }
  | { kind: 'cluster'; id: string; cluster: ClusterStatePayload };

function workflowProvider(job: JobState): ProviderName {
  return job.config.primaryProvider ?? 'claude';
}

export function accountBadgeForJob(job: JobState, settings: ArcoSettings | null | undefined): string | null {
  const provider = workflowProvider(job);
  if (provider !== 'codex') return null;
  const ref = job.config.providerAccountRef;
  if (!ref) return null;
  const account = settings?.providerAccounts?.codex?.find((a) => a.id === ref);
  const raw = account?.shortLabel || account?.label || ref;
  return raw.trim().slice(0, 4).toUpperCase() || null;
}

export function AccountBadge({ label }: { label: string }) {
  return (
    <span
      title={`Account profile ${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '16px',
        height: '16px',
        padding: '0 4px',
        border: '1px solid var(--color-accent-primary)',
        borderRadius: '3px',
        color: 'var(--color-accent-primary)',
        background: 'var(--color-accent-primary-a08)',
        fontSize: '9px',
        lineHeight: 1,
        letterSpacing: '0',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

// Sort top-row items by settings.tabOrder; unknown ids fall to the end in
// natural map-iteration order (workflow create order, then cluster create
// order). Stable across reloads — operator drag-rearrange writes back to
// settings.tabOrder.
function applyTabOrder<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const orderIdx = new Map<string, number>();
  order.forEach((id, i) => orderIdx.set(id, i));
  // Stable partition: known items by their ordering, unknown items appended
  // in their original sequence.
  const known = items.filter((it) => orderIdx.has(it.id))
    .sort((a, b) => (orderIdx.get(a.id)! - orderIdx.get(b.id)!));
  const unknown = items.filter((it) => !orderIdx.has(it.id));
  return [...known, ...unknown];
}

export function TabBar({ onRemoveWorkflow, onCreateCluster, onDeleteCluster, onAddClusterMember, onCreateClusterWithFreshWorkers }: Props) {
  const jobs = useAppStore((s) => s.jobs);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const showCreator = useAppStore((s) => s.showCreator);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const showJobCreator = useAppStore((s) => s.showJobCreator);
  const showHome = useAppStore((s) => s.showHome);
  const showHomeView = useAppStore((s) => s.showHomeView);
  const removeJob = useAppStore((s) => s.removeJob);
  const clusters = useAppStore((s) => s.clusters);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const settings = useAppStore((s) => s.settings);
  const setTabOrder = useAppStore((s) => s.setTabOrder);

  const [contextAnchor, setContextAnchor] = useState<{ jobId: string; x: number; y: number } | null>(null);

  // 2026-05-11 — teardown picker. window.confirm gave a binary OK/Cancel that
  // only covered "keep members working". The new flow offers a third path —
  // close the cluster AND close each member workflow in one operator gesture.
  // memberIds is snapshotted at click time so the dialog text stays consistent
  // if cluster_state churns between open and confirm.
  const [closeTarget, setCloseTarget] = useState<{
    clusterId: string;
    label: string;
    memberIds: string[];
  } | null>(null);

  // Phase 7b — Task children mint a JobState (so promote can flip it into
  // the strip without a server round-trip) but are scoped to the parent's
  // view (inline card + TASKS sub-tab) until the operator promotes them.
  const allJobs = Object.values(jobs).filter((j) => !j.config.voiceOperator && (!j.parentWorkflowId || j.promoted === true));
  const clusterList = Object.values(clusters);

  // Slice 6a — split workflows into "in a cluster" and "standalone". Cluster
  // members get no tab (reach them via the cluster's member cards);
  // standalone workflows + cluster tabs share the top row.
  const memberWorkflowIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of clusterList) for (const m of c.members) set.add(m.workflowId);
    return set;
  }, [clusterList]);

  const standaloneJobs = allJobs.filter((j) => !memberWorkflowIds.has(j.id));

  // Slice 6a — top-row sortable items. Workflows + clusters share one
  // ordering (operator can interleave them).
  const topRowItems: TopRowItem[] = useMemo(() => {
    const raw: TopRowItem[] = [
      ...standaloneJobs.map((job) => ({ kind: 'workflow' as const, id: job.id, job })),
      ...clusterList.map((c) => ({ kind: 'cluster' as const, id: c.clusterId, cluster: c })),
    ];
    return applyTabOrder(raw, settings?.tabOrder);
  }, [standaloneJobs, clusterList, settings?.tabOrder]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = topRowItems.map((it) => it.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    void setTabOrder(next);
  };

  // Home stays reachable even when no tab is open (the bar otherwise hides).
  const homeButton = (
      <button
        type="button"
        onClick={() => { showHomeView(); document.getElementById('home-title')?.focus(); }}
        aria-current={showHome ? 'page' : undefined}
        aria-label="Home: projects, open work and saved sessions"
        className="display-font"
        style={{
          padding: '8px 14px',
          background: showHome ? 'var(--color-accent-primary-a06)' : 'transparent',
          border: 'none',
          borderBottom: showHome ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
          color: showHome ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '13px',
          letterSpacing: '1px',
          flexShrink: 0,
        }}
      >
        HOME
      </button>
  );

  if (allJobs.length === 0 && clusterList.length === 0 && showCreator) {
    return (
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border-hairline)', background: 'var(--color-bg-panel)', flexShrink: 0 }}>
        {homeButton}
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          borderBottom: '1px solid var(--color-border-hairline)',
          background: 'var(--color-bg-panel)',
          flexShrink: 0,
        }}
      >
        {/* Top row — clusters + standalone workflow tabs, drag-reorderable */}
        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            overflowX: 'auto',
          }}
        >
          {homeButton}
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <SortableContext items={topRowItems.map((it) => it.id)} strategy={horizontalListSortingStrategy}>
              {topRowItems.map((item) => {
                if (item.kind === 'workflow') {
                  return (
                    <SortableWorkflowTab
                      key={item.id}
                      job={item.job}
                      isActive={item.id === activeJobId && !showCreator && !showHome && !activeClusterId}
                      onActivate={() => setActiveJob(item.id)}
                      // §F2 step 3 (DEFERRED — graceful TODO): when the recall
                      // store's `summarizeOnClose` arm is ON, this close handler
                      // should OFFER to summarize (a confirm toast → fire
                      // requestRecallSummary) BEFORE the workflow is torn down,
                      // since teardown drops the in-memory worker. The toggle +
                      // its default-OFF state are real (recallStore.summarizeOnClose)
                      // and the per-row Summarize button is the shipped path; the
                      // on-close offer is the only deferred piece. It must NEVER
                      // auto-summarize without the operator's explicit arm + confirm.
                      onClose={() => { onRemoveWorkflow(item.id); removeJob(item.id); }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextAnchor({ jobId: item.id, ...layoutPoint(e) });
                      }}
                    />
                  );
                }
                return (
                  <SortableClusterTab
                    key={item.id}
                    cluster={item.cluster}
                    isActive={item.id === activeClusterId && !showCreator}
                    onActivate={() => setActiveCluster(item.id)}
                    onClose={() => {
                      setCloseTarget({
                        clusterId: item.id,
                        label: clusterDisplayName(item.cluster),
                        memberIds: item.cluster.members.map((m) => m.workflowId),
                      });
                    }}
                  />
                );
              })}
            </SortableContext>
          </DndContext>

          <button
            onClick={showJobCreator}
            data-help="tabbar.new"
            className="display-font"
            style={{
              padding: '8px 14px',
              background: showCreator && !showHome ? 'var(--color-accent-primary-a06)' : 'transparent',
              border: 'none',
              borderBottom: showCreator && !showHome ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
              color: showCreator && !showHome ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '13px',
              letterSpacing: '1px',
              transition: 'all 0.15s ease',
            }}
          >
            + NEW
          </button>
        </div>

        {/* 2026-09-30 — the per-member bottom row was removed: the cluster's
            left-pane member cards already focus a member, the account badge
            moved to the MemberPane header, and Detach lives in the MEMBERS
            sub-tab. */}
      </div>

      {contextAnchor && (
        <TabContextMenu
          anchorJobId={contextAnchor.jobId}
          position={{ x: contextAnchor.x, y: contextAnchor.y }}
          onClose={() => setContextAnchor(null)}
          onCreateCluster={onCreateCluster}
          onAddClusterMember={onAddClusterMember}
          onCreateClusterWithFreshWorkers={onCreateClusterWithFreshWorkers}
        />
      )}
      {closeTarget && (
        <ClusterCloseConfirm
          label={closeTarget.label}
          memberCount={closeTarget.memberIds.length}
          onCancel={() => setCloseTarget(null)}
          onKeepMembers={() => {
            onDeleteCluster(closeTarget.clusterId);
            setCloseTarget(null);
          }}
          onCloseAll={() => {
            for (const wfid of closeTarget.memberIds) {
              onRemoveWorkflow(wfid);
              removeJob(wfid);
            }
            onDeleteCluster(closeTarget.clusterId);
            setCloseTarget(null);
          }}
        />
      )}
    </>
  );
}

function ClusterCloseConfirm({
  label,
  memberCount,
  onCancel,
  onKeepMembers,
  onCloseAll,
}: {
  label: string;
  memberCount: number;
  onCancel: () => void;
  onKeepMembers: () => void;
  onCloseAll: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          padding: '20px 22px',
          maxWidth: '480px',
          width: '90%',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          className="display-font"
          style={{
            fontSize: '11px',
            letterSpacing: '2px',
            color: 'var(--color-accent-primary)',
            marginBottom: '12px',
          }}
        >
          TEAR DOWN CLUSTER
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-fg)', marginBottom: '6px' }}>
          Tear down <strong>{label}</strong>?
        </div>
        <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', marginBottom: '20px', lineHeight: 1.5 }}>
          {memberCount === 0
            ? 'No members attached.'
            : `${memberCount} member workflow${memberCount === 1 ? '' : 's'} attached. Choose what happens to ${memberCount === 1 ? 'it' : 'them'}.`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={onKeepMembers}
            className="display-font"
            style={{
              padding: '10px 14px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              color: 'var(--color-fg)',
              cursor: 'pointer',
              fontSize: '11px',
              letterSpacing: '1.5px',
              textAlign: 'left',
            }}
          >
            KEEP MEMBERS WORKING
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', marginTop: '3px', textTransform: 'none' }}>
              Members continue as plain workflows. Peer tools drop on their next turn.
            </div>
          </button>
          <button
            onClick={onCloseAll}
            disabled={memberCount === 0}
            className="display-font"
            style={{
              padding: '10px 14px',
              background: memberCount === 0 ? 'transparent' : 'var(--color-danger-a08)',
              border: '1px solid var(--color-danger)',
              color: memberCount === 0 ? 'var(--color-fg-muted)' : 'var(--color-danger)',
              cursor: memberCount === 0 ? 'default' : 'pointer',
              fontSize: '11px',
              letterSpacing: '1.5px',
              textAlign: 'left',
              opacity: memberCount === 0 ? 0.5 : 1,
            }}
          >
            CLOSE CLUSTER + {memberCount} MEMBER{memberCount === 1 ? '' : 'S'}
            <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', marginTop: '3px', textTransform: 'none' }}>
              Removes every member workflow tab. Worker state on disk is preserved per the usual remove_workflow path.
            </div>
          </button>
          <button
            onClick={onCancel}
            className="display-font"
            style={{
              padding: '8px 14px',
              background: 'transparent',
              border: '1px solid transparent',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '11px',
              letterSpacing: '1.5px',
              marginTop: '4px',
            }}
          >
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
}

// Slice 6a — sortable workflow tab. Whole tab is the drag handle.
interface WorkflowTabProps {
  job: JobState;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function SortableWorkflowTab({ job, isActive, onActivate, onClose, onContextMenu }: WorkflowTabProps) {
  const settings = useAppStore((s) => s.settings);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: job.id });
  const activeWorkers = Object.values(job.workers).filter(
    (w) => w.status === 'running' || w.status === 'spawning'
  ).length;
  const hasStreaming = job.messages.some((m) => m.isStreaming);
  const isBusy = activeWorkers > 0 || hasStreaming;
  const accountBadge = accountBadgeForJob(job, settings);

  return (
    <div
      ref={setNodeRef}
      data-help="tabbar.tab"
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        position: 'relative',
        background: isActive ? 'var(--color-accent-primary-a06)' : 'transparent',
        borderBottom: isActive ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
        transition: transition ?? 'all 0.15s ease',
        transform: CSS.Transform.toString(transform),
        opacity: isDragging ? 0.4 : 1,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      <button
        onClick={onActivate}
        className="display-font"
        style={{
          padding: '8px 4px 8px 16px',
          background: 'transparent',
          border: 'none',
          color: isActive ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '1px',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        {isBusy && (
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--color-accent-primary)',
              animation: 'pulse-glow 1.5s ease-in-out infinite',
              flexShrink: 0,
            }}
          />
        )}
        {job.config.name.toUpperCase()}
        {accountBadge && <AccountBadge label={accountBadge} />}
      </button>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          // Close tears down the in-memory worker (and any active turn); an
          // incognito chat is gone for good. One stray click shouldn't do that.
          const notes: string[] = [];
          if (isBusy) notes.push('A turn is in progress and will be cancelled.');
          if (job.config.incognito) notes.push('This incognito chat is not saved and will be lost.');
          const msg = `Close ${job.config.name}?${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
          if (window.confirm(msg)) onClose();
        }}
        aria-label={`Close ${job.config.name}`}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '12px',
          padding: '0 10px 0 4px',
          opacity: 0.5,
        }}
      >
        ×
      </button>
    </div>
  );
}

interface ClusterTabProps {
  cluster: ClusterStatePayload;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function SortableClusterTab({ cluster, isActive, onActivate, onClose }: ClusterTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cluster.clusterId });
  const anyBusy = cluster.members.some((m) => m.status === 'busy');
  const label = clusterDisplayName(cluster);
  return (
    <div
      ref={setNodeRef}
      data-help="tabbar.cluster"
      {...attributes}
      {...listeners}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        position: 'relative',
        background: isActive ? 'var(--color-accent-primary-a06)' : 'transparent',
        borderBottom: isActive ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
        transition: transition ?? 'all 0.15s ease',
        transform: CSS.Transform.toString(transform),
        opacity: isDragging ? 0.4 : 1,
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
    >
      <button
        onClick={onActivate}
        className="display-font"
        style={{
          padding: '8px 4px 8px 16px',
          background: 'transparent',
          border: 'none',
          color: isActive ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '11px',
          letterSpacing: '1px',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        {anyBusy && (
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--color-accent-primary)',
              animation: 'pulse-glow 1.5s ease-in-out infinite',
              flexShrink: 0,
            }}
          />
        )}
        {label.toUpperCase()}
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>[{cluster.members.length}]</span>
      </button>
      <button
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        aria-label={`Delete cluster ${label}`}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '12px',
          padding: '0 10px 0 4px',
          opacity: 0.5,
        }}
      >
        ×
      </button>
    </div>
  );
}
