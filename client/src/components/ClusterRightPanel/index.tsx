import { AutoCompactionThreshold } from '../AutoCompactionThreshold';
import { useOutputNavigation } from '../../utils/outputNavigation';
import { useVoicePanelRequest } from '../../voice/panels';
// docs/PROTOCOL_CLUSTER.md - replaces the per-member RightPanel for
// cluster tabs. Later phases added shared-cwd mirrors and a member-scoped
// CONFIG view so operators do not have to leave the cluster tab for routine
// per-worker settings.
//
// Members — list of {workflowId, displayName, status} from cluster_state.
// Mailbox — per-member mailbox depth (live), with a recent peer-message
//   preview pulled from each member's chat-side messages[] (the synthetic
//   peer-sent / peer-received entries that §7d injects).
// Activity — combined event stream filtered to peer_message_* across all
//   members. Reads from each member's job.activity (already in store) and
//   filters on entry kind.

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { clusterDisplayName } from '../TabBar';
import { ClusterPlanTab } from '../ClusterPlanTab';
import { ClusterTaskBoardTab } from '../ClusterTaskBoardTab';
import { ClusterActivityTab } from '../ClusterActivityTab';
import { GitHubPanel } from '../GitHubPanel';
import { HistoryTab } from '../HistoryTab';
import { PreviewTab } from '../PreviewTab';
import { ConfigTab } from '../RightPanel/ConfigTab';
import { ClusterFilesTabBody, type ClusterFilesSubTab } from '../RightPanel/FilesTab';
import type { ClusterStatePayload, ClusterTaskBoardMode } from '@arco/shared';
import type { PeerMessage, Props, SubTab } from './types';
import { MemberRow } from './MemberRow';
import { AddWorkerSection } from './AddWorkerSection';
import { ClusterHandoffsTab } from './ClusterHandoffsTab';
import { ClusterReviewsList } from './ClusterReviewsList';
import { MailboxModal } from './MailboxModal';
import { EfficiencyControl } from './EfficiencyControl';
import { ProjectTrustChip } from './ProjectTrustChip';
import { ProgressControl } from './ProgressControl';
import { SavedClustersList } from '../SavedClustersList';
import { requestClusterSnapshotSave } from '../../stores/clusterSnapshotsStore';

const TABS: { id: SubTab; label: string }[] = [
  { id: 'members', label: 'MEMBERS' },
  { id: 'files', label: 'FILES' },
  { id: 'activity', label: 'ACTIVITY' },
  { id: 'reviews', label: 'REVIEWS' },
  { id: 'handoffs', label: 'HANDOFFS' },
  { id: 'plan', label: 'PLAN' },
  { id: 'board', label: 'BOARD' },
  { id: 'mailbox', label: 'MAILBOX' },
  { id: 'history', label: 'HISTORY' },
  { id: 'preview', label: 'PREVIEW' },
  { id: 'config', label: 'CONFIG' },
  { id: 'github', label: 'GITHUB' },
];

type GroupId = 'workspace' | 'agent' | 'memory' | 'runtime';
const GROUPS: { id: GroupId; label: string; tabs: SubTab[] }[] = [
  { id: 'workspace', label: 'WORKSPACE', tabs: ['members', 'files'] },
  { id: 'agent', label: 'AGENT', tabs: ['activity', 'reviews', 'handoffs', 'plan', 'board', 'mailbox'] },
  { id: 'memory', label: 'MEMORY', tabs: ['history'] },
  { id: 'runtime', label: 'RUNTIME', tabs: ['preview', 'config', 'github'] },
];
const STORAGE_KEY = 'arco.clusterSidePanelTab.byCluster';
const NARROW_PX = 360;

function labelOf(id: SubTab): string {
  return TABS.find((t) => t.id === id)?.label ?? id.toUpperCase();
}

function groupOf(tab: SubTab): GroupId {
  return GROUPS.find((g) => g.tabs.includes(tab))?.id ?? 'workspace';
}

function loadTabsByCluster(): Record<string, SubTab> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, SubTab>;
  } catch { /* no-op */ }
  return {};
}

function tabForCluster(map: Record<string, SubTab>, clusterId: string): SubTab {
  const v = map[clusterId];
  if (v && TABS.some((t) => t.id === v)) return v;
  return 'members';
}

export function ClusterRightPanel({ cluster, onFocusMember, onRename, onAddFreshWorkers, onAddExistingMember, onSetPlan, onAttachPlan, onClearPlan, onSetMemberRole, onSetMemberTier, onSetMemberFocus, onDetachMember, onToggleIdleNudger, onToggleAutoTurn, onSetTaskBoardMode, onSetTaskBoardAttached, onSetEfficiency, onSetAutoCompaction, onSetRemote, onSetGates, onSetProgress, onDispatchOnce, onToggleDispatcher, onUpdateDispatcherSettings, onUpdateTaskStatus, onReassignTask, onReclaimRun, onTerminateRun, onCreateSwarm, onSpawnPhase, onReviewMember, onCancelReview, onCancelHandoff, onClearHandoffLock, onReviewViaMember, onAttachPlanToMember, onUpdateMemberPrimary, onAttachCodebaseMemory, onDetachCodebaseMemory, mcp }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [tabsByCluster, setTabsByCluster] = useState<Record<string, SubTab>>(loadTabsByCluster);
  const tab = tabForCluster(tabsByCluster, cluster.clusterId);
  const setTab = (next: SubTab) => {
    setTabsByCluster((prev) => {
      const updated = { ...prev, [cluster.clusterId]: next };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* no-op */ }
      return updated;
    });
  };
  const voicePanel = useVoicePanelRequest((s) => s.request);
  useEffect(() => {
    if (voicePanel?.id === cluster.clusterId && TABS.some((t) => t.id === voicePanel.panel)) setTab(voicePanel.panel as SubTab);
  }, [voicePanel, cluster.clusterId]);
  const jobs = useAppStore((s) => s.jobs);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const activeGroup = groupOf(tab);

  // §10.7 P12.5 — peer→task bridge. Promote a pending peer message into a
  // durable board task via the operator task_ledger_create path (first member is
  // the cwd-derived sender; boardKey follows the cluster's board mode). The
  // sender is tagged via a workflow link for provenance. Only when attached.
  const onMakeTaskFromMessage = (content: string, fromWorkflowId: string) => {
    const anchor = cluster.members[0]?.workflowId;
    if (!anchor || !wsSendRaw || cluster.taskBoardMode === 'none') return;
    const fromName = cluster.members.find((m) => m.workflowId === fromWorkflowId)?.displayName ?? fromWorkflowId.slice(0, 8);
    const firstLine = content.split('\n').map((s) => s.trim()).find(Boolean) ?? content.trim();
    const title = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
    wsSendRaw({
      type: 'task_ledger_create',
      workflowId: anchor,
      ...(cluster.taskBoardKey ? { boardKey: cluster.taskBoardKey } : {}),
      title,
      notes: `From peer ${fromName}:\n\n${content}`,
      links: [{ kind: 'workflow', ref: fromWorkflowId }],
    });
  };
  const activeGroupTabs = GROUPS.find((g) => g.id === activeGroup)?.tabs ?? [];
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(w < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Mailbox modal — operator clicked a member row in the Mailbox tab to
  // inspect/cancel pending peer messages. State holds the recipient wfid
  // (null = closed) plus the most recently fetched message list. Refetches
  // whenever the depth count for the selected wfid changes (cluster_state
  // push) so cancels + new arrivals propagate without a manual refresh.
  const [mailboxWfid, setMailboxWfid] = useState<string | null>(null);
  const [mailboxMsgs, setMailboxMsgs] = useState<PeerMessage[] | null>(null);
  const [mailboxLoading, setMailboxLoading] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);
  const [filesSubTab, setFilesSubTab] = useState<ClusterFilesSubTab>('files');
  useOutputNavigation(cluster.members.map(member => member.workflowId), () => { setTab('files'); setFilesSubTab('outputs'); });
  const selectedDepth = mailboxWfid ? (cluster.mailboxDepth[mailboxWfid] ?? 0) : 0;
  useEffect(() => {
    if (!mailboxWfid) return;
    let cancelled = false;
    setMailboxLoading(true);
    setMailboxError(null);
    fetch(`/api/clusters/${cluster.clusterId}/mailbox/${mailboxWfid}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as PeerMessage[];
      })
      .then((rows) => { if (!cancelled) setMailboxMsgs(rows); })
      .catch((err) => { if (!cancelled) setMailboxError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setMailboxLoading(false); });
    return () => { cancelled = true; };
  }, [mailboxWfid, selectedDepth, cluster.clusterId]);
  const onCancelMessage = async (msgId: string) => {
    if (!mailboxWfid) return;
    try {
      const r = await fetch(`/api/clusters/${cluster.clusterId}/mailbox/${mailboxWfid}/${msgId}`, { method: 'DELETE' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        setMailboxError(body.error ?? `cancel failed (${r.status})`);
        return;
      }
      // Optimistic — strip the row immediately so the modal feels responsive
      // before the cluster_state push lands and reruns the fetch.
      setMailboxMsgs((prev) => prev?.filter((m) => m.msgId !== msgId) ?? prev);
    } catch (err) {
      setMailboxError(err instanceof Error ? err.message : String(err));
    }
  };
  // Slice 6a — rename UI lives on the Members tab header. Edit mode toggles
  // an inline input pre-filled with the current effective name.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // SAVE STATE — capture the whole live cluster (config + members + full
  // histories) as a named, restorable snapshot. The name input toggles inline
  // (same affordance shape as RENAME). The requesting member is the cluster
  // anchor (members[0]); the server fences that it's a current member.
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotDraft, setSnapshotDraft] = useState('');
  const anchorWfid = cluster.members[0]?.workflowId;
  const submitSnapshot = (saveToCloud = false) => {
    const name = snapshotDraft.trim();
    if (!name || !anchorWfid) return;
    requestClusterSnapshotSave(cluster.clusterId, anchorWfid, name, saveToCloud);
    setSnapshotOpen(false);
    setSnapshotDraft('');
  };
  const effectiveName = clusterDisplayName(cluster);
  // Re-sync the draft if the underlying name changes while the editor is
  // closed (e.g. another tab renamed it).
  useEffect(() => {
    if (!renameOpen) setRenameDraft(cluster.name ?? '');
  }, [cluster.name, renameOpen]);

  return (
    <div
      style={{
        // 2026-05-11 — fills the outer splitter wrapper in ClusterTab. The
        // wrapper carries the fraction-flex; this panel fills 100% of its
        // parent and keeps a sane minimum so the operator can't drag the
        // outer splitter narrow enough to crush the panel.
        flex: 1,
        minWidth: '240px',
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--color-border-hairline)',
        background: 'var(--color-bg-panel)',
      }}
    >
      {/* Phase 5 — idle-nudger chip lives above the sub-tab bar so the
          armed/disarmed state is always visible. One-click toggle; the
          server caps + suppression invariants live there. The 2026-06-15
          efficiency selector rides the same bar. The bar renders when either
          arming surface is wired (both come from the same parent). */}
      {(onToggleIdleNudger || onSetTaskBoardMode || onSetTaskBoardAttached || onSetEfficiency || onSetRemote || onSetProgress) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            borderBottom: '1px solid var(--color-border-hairline)',
            fontSize: '10px',
            flexWrap: 'wrap',
          }}
        >
          {onToggleIdleNudger && (
          <>
          <span
            className="display-font"
            data-help="cluster.nudger"
            style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px' }}
          >
            MAIL ALERTS
          </span>
          <button
            onClick={() => onToggleIdleNudger(cluster.clusterId, !cluster.idleNudgerEnabled)}
            aria-label={`Mail alerts ${cluster.idleNudgerEnabled ? 'enabled' : 'off'}`}
            aria-pressed={!!cluster.idleNudgerEnabled}
            data-help="cluster.nudger"
            className="display-font"
            style={{
              padding: '3px 8px',
              background: cluster.idleNudgerEnabled
                ? 'var(--color-accent-primary-a06)'
                : 'transparent',
              border: '1px solid ' + (cluster.idleNudgerEnabled
                ? 'var(--color-accent-primary)'
                : 'var(--color-border-hairline)'),
              color: cluster.idleNudgerEnabled
                ? 'var(--color-accent-primary)'
                : 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
            }}
            title={cluster.idleNudgerEnabled
              ? 'Alerts the operator when an idle worker has pending mail. Does not start worker turns. Click to turn off.'
              : 'Mail alerts are off. Enable operator alerts for idle workers with pending mail. Does not start worker turns.'}
          >
            {cluster.idleNudgerEnabled ? 'ENABLED' : 'OFF'}
          </button>
          </>
          )}
          {/* Phase 5b — auto-turn-on-mailbox toggle. Sits next to MAIL ALERTS with
              the same pill style so the operator sees both arming surfaces at
              once. Unlike nudges (toast-only), this one DOES send synthetic
              turns to recipients — the three guards (cooldown / rate cap /
              chain depth) plus the operator-OFF default cover the autonomy
              four-question test. */}
          {onToggleAutoTurn && (
            <>
              <span
                className="display-font"
                data-help="cluster.auto-turn"
                style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}
              >
                AUTO-PICKUP
              </span>
              <button
                onClick={() => onToggleAutoTurn(cluster.clusterId, !cluster.autoTurnOnMailboxEnabled)}
                data-help="cluster.auto-turn"
                className="display-font"
                style={{
                  padding: '3px 8px',
                  background: cluster.autoTurnOnMailboxEnabled
                    ? 'var(--color-accent-primary-a06)'
                    : 'transparent',
                  border: '1px solid ' + (cluster.autoTurnOnMailboxEnabled
                    ? 'var(--color-accent-primary)'
                    : 'var(--color-border-hairline)'),
                  color: cluster.autoTurnOnMailboxEnabled
                    ? 'var(--color-accent-primary)'
                    : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '9px',
                  letterSpacing: '1px',
                }}
                title={cluster.autoTurnOnMailboxEnabled
                  ? 'When ON, members fire a turn automatically when a peer message arrives and they’re idle. Rate-capped + chain-depth-capped to prevent runaway loops.'
                  : 'Off — idle recipients won’t auto-pick-up peer mail. Click to arm.'}
              >
                {cluster.autoTurnOnMailboxEnabled ? 'ENABLED' : 'OFF'}
              </button>
            </>
          )}
          {onSetAutoCompaction && (
            <label title="Applied separately to inheriting members on Claude Native, Codex app-server or Ollama. Other transports cannot use the policy." className="arco-field-label">Auto-compaction: <select className="arco-field" aria-label="Cluster auto-compaction" value={cluster.autoCompaction ? (cluster.autoCompaction.enabled ? 'on' : 'off') : 'legacy'} onChange={(e) => onSetAutoCompaction(cluster.clusterId, e.target.value === 'legacy' ? null : { enabled: e.target.value === 'on', thresholdPercent: cluster.autoCompaction?.thresholdPercent ?? 80 })}>
              <option value="legacy">Legacy behavior</option><option value="off">Off</option><option value="on">On</option>
            </select>{cluster.autoCompaction && <AutoCompactionThreshold key={`${cluster.clusterId}:${cluster.autoCompaction.enabled}`} label="Cluster auto-compaction threshold percent" value={cluster.autoCompaction.thresholdPercent} onCommit={(thresholdPercent) => onSetAutoCompaction(cluster.clusterId, { ...cluster.autoCompaction!, thresholdPercent })} />} </label>
          )}
          {onSetEfficiency && (
            <EfficiencyControl
              clusterId={cluster.clusterId}
              level={cluster.efficiencyLevel ?? 'thorough'}
              addendum={cluster.efficiencyAddendum}
              messageGuard={cluster.messageGuard}
              onSetEfficiency={onSetEfficiency}
            />
          )}
          {/* DD7 — cluster-wide project trust for the pinned cwd. Self-hiding
              when the repo ships nothing the gate suppresses. */}
          <ProjectTrustChip cwd={cluster.cwd} />
          {onSetProgress && (
            <ProgressControl
              clusterId={cluster.clusterId}
              mode={cluster.progressTracking ?? 'both'}
              onSetProgress={onSetProgress}
            />
          )}
          {onSetRemote && (
            <button
              className="display-font"
              data-help="cluster.remote"
              onClick={() => onSetRemote(cluster.clusterId, !cluster.remoteEnabled)}
              title={cluster.remoteEnabled
                ? 'This cluster (all members) is shared with the management hub — visible and controllable from the phone console. Click to stop sharing.'
                : 'Share this cluster with the management hub: every member becomes visible/controllable from the phone console. One switch covers all members. Off by default.'}
              style={{
                padding: '3px 8px',
                background: cluster.remoteEnabled ? 'var(--color-accent-secondary-a30, transparent)' : 'transparent',
                border: `1px solid ${cluster.remoteEnabled ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '3px',
                color: cluster.remoteEnabled ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
                whiteSpace: 'nowrap',
              }}
            >
              {cluster.remoteEnabled ? '◉ REMOTE' : '◎ REMOTE: OFF'}
            </button>
          )}
          {onSetGates && cluster.remoteEnabled && (
            <button
              className="display-font"
              data-help="cluster.remote-gates"
              onClick={() => onSetGates(cluster.clusterId, !cluster.remoteGatesEnabled)}
              title={cluster.remoteGatesEnabled
                ? 'Review gates on EVERY member can be approved/rejected from the phone console. Click to make them desk-only again.'
                : 'Allow approving/rejecting parked review gates on ANY member from the phone console. One switch covers all members. Off by default — remote conversation never implies remote approval authority.'}
              style={{
                padding: '3px 8px',
                background: cluster.remoteGatesEnabled ? 'var(--color-accent-secondary-a30, transparent)' : 'transparent',
                border: `1px solid ${cluster.remoteGatesEnabled ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '3px',
                color: cluster.remoteGatesEnabled ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
                whiteSpace: 'nowrap',
              }}
            >
              {cluster.remoteGatesEnabled ? '⛨ GATES' : '⛨ GATES: DESK'}
            </button>
          )}
          {(onSetTaskBoardMode || onSetTaskBoardAttached) && (
            <BoardModeControl
              cluster={cluster}
              onSetMode={onSetTaskBoardMode}
              onSetAttached={onSetTaskBoardAttached}
            />
          )}
        </div>
      )}

      {/* Cluster tabs use the same two-level grouping as the standalone
          RightPanel. Cluster-only surfaces stay where their semantics belong:
          MEMBERS/FILES under workspace, plan/workflow coordination under
          agent, HISTORY under memory, and PREVIEW/CONFIG/GITHUB under runtime. */}
      <div
        ref={rootRef}
        className="display-font"
        style={{
          borderBottom: '1px solid var(--color-border-hairline)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '2px 2px 0' }}>
          {GROUPS.map((g) => {
            const active = activeGroup === g.id;
            return (
              <button
                key={g.id}
                onClick={() => { if (!active) setTab(g.tabs[0]); }}
                data-help={`cluster.right-panel.group.${g.id}`}
                style={{
                  flex: '0 0 auto',
                  padding: '5px 12px',
                  background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                  border: 'none',
                  borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                  cursor: 'pointer',
                  fontSize: '10px',
                  letterSpacing: '2px',
                  fontFamily: 'var(--font-display)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        {narrow ? (
          <div style={{ padding: '4px' }}>
            <select
              value={tab}
              onChange={(e) => setTab(e.target.value as SubTab)}
              data-help={`cluster.right-panel.tab.${tab}`}
              style={{
                width: '100%',
                background: 'var(--color-bg-panel)',
                color: 'var(--color-accent-primary)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                padding: '4px 6px',
                fontSize: '10px',
                letterSpacing: '1.5px',
                fontFamily: 'var(--font-display)',
              }}
            >
              {GROUPS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.tabs.map((id) => (
                    <option key={id} value={id}>{labelOf(id)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '0 2px 2px' }}>
            {activeGroupTabs.map((t) => {
              const active = tab === t;
              const helpKey =
                t === 'members'
                  ? 'cluster.right-panel.members'
                  : t === 'mailbox'
                    ? 'cluster.mailbox'
                    : t === 'plan'
                      ? 'cluster.plan-tab'
                      : t === 'board'
                        ? 'cluster.board-tab'
                        : t === 'github'
                          ? 'cluster.right-panel.github'
                          : t === 'files'
                            ? 'cluster.right-panel.files'
                            : t === 'history'
                              ? 'cluster.right-panel.history'
                              : t === 'preview'
                                ? 'cluster.right-panel.preview'
                                : `cluster.right-panel.tab.${t}`;
              return (
            <button
              key={t}
              onClick={() => setTab(t)}
              data-help={helpKey}
              style={{
                flex: '0 0 auto',
                padding: '5px 10px',
                background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
                border: 'none',
                borderBottom: active ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1.5px',
                fontFamily: 'var(--font-display)',
              }}
            >
              {labelOf(t)}
            </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {tab === 'members' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {/* Slice 6a — cluster name + rename affordance. Click the
                pencil to edit; ↵ commits, Esc cancels, empty input clears
                to the derived default. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 8px',
                border: '1px solid var(--color-border-hairline)',
                background: 'var(--color-bg)',
                fontSize: '11px',
              }}
            >
              {renameOpen ? (
                <>
                  <input
                    autoFocus
                    value={renameDraft}
                    placeholder={`${(cluster.cwd.split(/[/\\]/).filter(Boolean).pop() ?? '')} · ${cluster.clusterId.slice(0, 8)}`}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRename?.(cluster.clusterId, renameDraft);
                        setRenameOpen(false);
                      } else if (e.key === 'Escape') {
                        setRenameDraft(cluster.name ?? '');
                        setRenameOpen(false);
                      }
                    }}
                    maxLength={64}
                    style={{
                      flex: 1,
                      background: 'var(--color-bg)',
                      color: 'var(--color-fg)',
                      border: '1px solid var(--color-accent-primary)',
                      padding: '4px 6px',
                      fontSize: '11px',
                      fontFamily: 'var(--font-code)',
                    }}
                  />
                  <button
                    onClick={() => {
                      onRename?.(cluster.clusterId, renameDraft);
                      setRenameOpen(false);
                    }}
                    className="display-font"
                    style={{
                      padding: '4px 10px',
                      background: 'var(--color-accent-primary)',
                      border: 'none',
                      color: 'var(--color-bg)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    SAVE
                  </button>
                  <button
                    onClick={() => {
                      setRenameDraft(cluster.name ?? '');
                      setRenameOpen(false);
                    }}
                    className="display-font"
                    style={{
                      padding: '4px 8px',
                      background: 'transparent',
                      border: '1px solid var(--color-border-hairline)',
                      color: 'var(--color-fg-muted)',
                      cursor: 'pointer',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    CANCEL
                  </button>
                </>
              ) : (
                <>
                  <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }} className="display-font">
                    NAME
                  </span>
                  <span style={{ color: 'var(--color-fg)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {effectiveName}
                  </span>
                  {onRename && (
                    <button
                      onClick={() => { setRenameDraft(cluster.name ?? ''); setRenameOpen(true); }}
                      className="display-font"
                      style={{
                        padding: '4px 10px',
                        background: 'transparent',
                        border: '1px solid var(--color-border-hairline)',
                        color: 'var(--color-fg-muted)',
                        cursor: 'pointer',
                        fontSize: '10px',
                        letterSpacing: '1px',
                      }}
                    >
                      RENAME
                    </button>
                  )}
                  <button
                    onClick={() => { setSnapshotDraft(effectiveName); setSnapshotOpen(true); }}
                    disabled={!anchorWfid}
                    className="display-font"
                    title={anchorWfid
                      ? 'Save this whole cluster — config, members, and their full conversation history — as a restorable snapshot.'
                      : 'Add a member before saving cluster state.'}
                    style={{
                      padding: '4px 10px',
                      background: 'transparent',
                      border: '1px solid var(--color-accent-secondary-dim)',
                      color: anchorWfid ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
                      cursor: anchorWfid ? 'pointer' : 'not-allowed',
                      fontSize: '10px',
                      letterSpacing: '1px',
                    }}
                  >
                    SAVE STATE
                  </button>
                </>
              )}
            </div>
            {/* SAVE STATE — inline name input. Shares the RENAME affordance
                shape: ↵ commits, Esc cancels, ≤64 chars (server re-validates +
                fences uniqueness). */}
            {snapshotOpen && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 8px',
                  border: '1px solid var(--color-accent-secondary-dim)',
                  background: 'var(--color-bg)',
                  fontSize: '11px',
                }}
              >
                <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }} className="display-font">
                  SNAPSHOT
                </span>
                <input
                  autoFocus
                  value={snapshotDraft}
                  placeholder="Snapshot name (≤64)"
                  maxLength={64}
                  onChange={(e) => setSnapshotDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSnapshot(false);
                    else if (e.key === 'Escape') { setSnapshotOpen(false); setSnapshotDraft(''); }
                  }}
                  style={{
                    flex: 1,
                    background: 'var(--color-bg)',
                    color: 'var(--color-fg)',
                    border: '1px solid var(--color-accent-secondary-dim)',
                    padding: '4px 6px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-code)',
                  }}
                />
                <button
                  onClick={() => submitSnapshot(false)}
                  disabled={!snapshotDraft.trim()}
                  className="display-font"
                  style={{
                    padding: '4px 10px',
                    background: snapshotDraft.trim() ? 'var(--color-accent-secondary)' : 'transparent',
                    border: 'none',
                    color: snapshotDraft.trim() ? 'var(--color-bg)' : 'var(--color-fg-muted)',
                    cursor: snapshotDraft.trim() ? 'pointer' : 'not-allowed',
                    fontSize: '10px',
                    letterSpacing: '1px',
                  }}
                >
                  SAVE LOCAL
                </button>
                <button
                  onClick={() => submitSnapshot(true)}
                  disabled={!snapshotDraft.trim()}
                  data-help="cluster.snapshot-cloud"
                  className="display-font"
                  style={{
                    padding: '4px 10px',
                    background: 'transparent',
                    border: '1px solid var(--color-accent-primary)',
                    color: snapshotDraft.trim() ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                    cursor: snapshotDraft.trim() ? 'pointer' : 'not-allowed',
                    fontSize: '10px',
                    letterSpacing: '1px',
                  }}
                >
                  SAVE CLOUD
                </button>
                <button
                  onClick={() => { setSnapshotOpen(false); setSnapshotDraft(''); }}
                  className="display-font"
                  style={{
                    padding: '4px 8px',
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    color: 'var(--color-fg-muted)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1px',
                  }}
                >
                  CANCEL
                </button>
              </div>
            )}
            {(onAddFreshWorkers || onAddExistingMember) && (
              <AddWorkerSection
                cluster={cluster}
                onAddFresh={onAddFreshWorkers}
                onAddExisting={onAddExistingMember}
              />
            )}
            {cluster.members.map((m) => (
              <MemberRow
                key={m.workflowId}
                cluster={cluster}
                member={m}
                memberName={jobs[m.workflowId]?.config.name?.toUpperCase() ?? m.workflowId.slice(0, 8)}
                onFocus={onFocusMember}
                onSetRole={onSetMemberRole}
                onSetTier={onSetMemberTier}
                onSetFocus={onSetMemberFocus}
                onDetach={onDetachMember}
              />
            ))}
            {/* SAVED CLUSTERS — restore a previously captured snapshot as a
                fresh cluster. Restore lands as a normal cluster_created
                broadcast, so the new cluster tab opens with members + full
                history replayed. No targetCwd here → restores into the
                snapshot's original cwd. */}
            <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--color-border-hairline)' }}>
              <SavedClustersList />
            </div>
          </div>
        )}

        {tab === 'mailbox' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {cluster.members.map((m) => {
              const depth = cluster.mailboxDepth[m.workflowId] ?? 0;
              const hasPending = depth > 0;
              return (
                <button
                  key={m.workflowId}
                  type="button"
                  onClick={() => hasPending && setMailboxWfid(m.workflowId)}
                  disabled={!hasPending}
                  title={hasPending
                    ? `Inspect / cancel the ${depth} pending message${depth === 1 ? '' : 's'} addressed to ${m.displayName}`
                    : 'Mailbox empty — nothing to inspect'}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid var(--color-border-hairline)',
                    fontSize: '11px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    background: 'transparent',
                    color: 'var(--color-fg)',
                    textAlign: 'left',
                    cursor: hasPending ? 'pointer' : 'default',
                    opacity: hasPending ? 1 : 0.7,
                    font: 'inherit',
                  }}
                >
                  <span>{m.displayName}</span>
                  <span style={{ marginLeft: 'auto', color: hasPending ? 'var(--color-warning)' : 'var(--color-fg-muted)' }}>
                    {depth} pending
                  </span>
                  {hasPending && (
                    <span className="display-font" style={{ color: 'var(--color-accent-primary)', fontSize: '9px', letterSpacing: '1px' }}>
                      INSPECT →
                    </span>
                  )}
                </button>
              );
            })}
            <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--color-fg-muted)' }}>
              Click a row with pending mail to inspect / cancel undelivered
              messages. Drain destroys files; the durable record lives in
              each member&apos;s events.jsonl.
            </div>
          </div>
        )}
        {mailboxWfid && (
          <MailboxModal
            cluster={cluster}
            wfid={mailboxWfid}
            messages={mailboxMsgs}
            loading={mailboxLoading}
            error={mailboxError}
            onClose={() => { setMailboxWfid(null); setMailboxMsgs(null); setMailboxError(null); }}
            onCancel={onCancelMessage}
            onMakeTask={cluster.taskBoardMode !== 'none' && wsSendRaw ? onMakeTaskFromMessage : undefined}
          />
        )}

        {tab === 'plan' && (
          <ClusterPlanTab
            cluster={cluster}
            onSetPlan={onSetPlan}
            onAttachPlan={onAttachPlan}
            onClearPlan={onClearPlan}
            onSpawnPhase={onSpawnPhase}
            onReviewMember={onReviewMember}
            onReviewViaMember={onReviewViaMember}
            onAttachPlanToMember={onAttachPlanToMember}
          />
        )}
        {tab === 'board' && (
          cluster.taskBoardMode !== 'none' && cluster.taskBoardAttached ? (
            <ClusterTaskBoardTab
              cluster={cluster}
              onDispatchOnce={onDispatchOnce}
              onToggleDispatcher={onToggleDispatcher}
              onUpdateDispatcherSettings={onUpdateDispatcherSettings}
              onUpdateTaskStatus={onUpdateTaskStatus}
              onReassignTask={onReassignTask}
              onReclaimRun={onReclaimRun}
              onTerminateRun={onTerminateRun}
              onCreateSwarm={onCreateSwarm}
            />
          ) : (
            <DetachedBoardPanel cluster={cluster} onSetMode={onSetTaskBoardMode} onAttach={onSetTaskBoardAttached} />
          )
        )}
        {tab === 'activity' && <ClusterActivityTab cluster={cluster} />}
        {tab === 'reviews' && <ClusterReviewsList cluster={cluster} onCancelReview={onCancelReview} />}
        {tab === 'handoffs' && <ClusterHandoffsTab cluster={cluster} onCancelHandoff={onCancelHandoff} onClearHandoffLock={onClearHandoffLock} />}
        {tab === 'github' && <GitHubPanel initialCwd={cluster.cwd} />}
        {tab === 'files' && <ClusterFilesTabBody cluster={cluster} subTab={filesSubTab} onSubTab={setFilesSubTab} />}
        {/* HISTORY + PREVIEW are intrinsically per-workflow (they emit WS
            messages keyed by workflowId and read JobState fields like
            taskChildren / preview.port). Cluster-scoped variants would
            require a server-side aggregation pass; the simpler win is to
            pin them to the cluster anchor (members[0]) — the template
            worker, same one SPAWN PHASE inherits from. If no member exists
            yet (empty cluster), show an empty state. */}
        {tab === 'history' && <ClusterAnchoredHistory cluster={cluster} />}
        {tab === 'preview' && <ClusterAnchoredPreview cluster={cluster} />}
        {tab === 'config' && (
          <ClusterConfigTab
            cluster={cluster}
            onUpdateMemberPrimary={onUpdateMemberPrimary}
            onAttachCodebaseMemory={onAttachCodebaseMemory}
            onDetachCodebaseMemory={onDetachCodebaseMemory}
            mcp={mcp}
          />
        )}
      </div>
    </div>
  );
}

function boardModeLabel(mode: ClusterTaskBoardMode): string {
  if (mode === 'project') return 'PROJECT';
  if (mode === 'cluster') return 'CLUSTER';
  return 'NONE';
}

function BoardModeControl({
  cluster,
  onSetMode,
  onSetAttached,
}: {
  cluster: ClusterStatePayload;
  onSetMode?: (clusterId: string, mode: ClusterTaskBoardMode) => void;
  onSetAttached?: (clusterId: string, attached: boolean) => void;
}) {
  const mode = cluster.taskBoardMode ?? (cluster.taskBoardAttached ? 'project' : 'none');
  const setMode = (next: ClusterTaskBoardMode) => {
    if (onSetMode) onSetMode(cluster.clusterId, next);
    else onSetAttached?.(cluster.clusterId, next !== 'none');
  };
  const modes: ClusterTaskBoardMode[] = ['none', 'project', 'cluster'];
  return (
    <>
      <span className="display-font" style={{ color: 'var(--color-fg-muted)', letterSpacing: '1px', marginLeft: '10px' }}>
        BOARD
      </span>
      <div style={{ display: 'flex', border: '1px solid var(--color-border-hairline)' }}>
        {modes.map((candidate) => {
          const active = mode === candidate;
          return (
            <button
              key={candidate}
              onClick={() => setMode(candidate)}
              data-help="cluster.board.mode"
              className="display-font"
              style={{
                padding: '3px 7px',
                background: active ? 'var(--color-accent-primary-a06)' : 'transparent',
                border: 'none',
                borderLeft: candidate === 'none' ? 'none' : '1px solid var(--color-border-hairline)',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
              }}
              title={candidate === 'none'
                ? 'Disable board use for this cluster.'
                : candidate === 'project'
                  ? 'Use the cwd project task board shared with normal workflow tabs.'
                  : 'Use this cluster’s private fresh board for this cwd.'}
            >
              {boardModeLabel(candidate)}
            </button>
          );
        })}
      </div>
    </>
  );
}

function DetachedBoardPanel({
  cluster,
  onSetMode,
  onAttach,
}: {
  cluster: ClusterStatePayload;
  onSetMode?: (clusterId: string, mode: ClusterTaskBoardMode) => void;
  onAttach?: (clusterId: string, attached: boolean) => void;
}) {
  const setMode = (mode: ClusterTaskBoardMode) => {
    if (onSetMode) onSetMode(cluster.clusterId, mode);
    else onAttach?.(cluster.clusterId, mode !== 'none');
  };
  return (
    <div
      style={{
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        color: 'var(--color-fg)',
      }}
    >
      <div className="display-font" style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
        BOARD DETACHED
      </div>
      <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
        This cluster is not using a task board for <code>{cluster.cwd}</code>.
        Choose the shared project board or start a private cluster board to enable <code>cluster_task_*</code> tools for members on their next turn.
      </div>
      {(onSetMode || onAttach) && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setMode('project')}
          className="display-font"
          style={{
            alignSelf: 'flex-start',
            padding: '6px 10px',
            background: 'var(--color-accent-primary-a06)',
            color: 'var(--color-accent-primary)',
            border: '1px solid var(--color-accent-primary)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          USE PROJECT BOARD
        </button>
        <button
          type="button"
          onClick={() => setMode('cluster')}
          className="display-font"
          style={{
            alignSelf: 'flex-start',
            padding: '6px 10px',
            background: 'var(--color-accent-secondary-a06)',
            color: 'var(--color-accent-secondary)',
            border: '1px solid var(--color-accent-secondary)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          CREATE CLUSTER BOARD
        </button>
        </div>
      )}
    </div>
  );
}

function ClusterConfigTab({
  cluster,
  onUpdateMemberPrimary,
  onAttachCodebaseMemory,
  onDetachCodebaseMemory,
  mcp,
}: Pick<Props, 'cluster' | 'onUpdateMemberPrimary' | 'onAttachCodebaseMemory' | 'onDetachCodebaseMemory' | 'mcp'>) {
  const jobs = useAppStore((s) => s.jobs);
  const [selectedWfid, setSelectedWfid] = useState<string>('');
  const available = cluster.members.filter((m) => jobs[m.workflowId]);
  const effectiveWfid = available.some((m) => m.workflowId === selectedWfid)
    ? selectedWfid
    : available[0]?.workflowId ?? '';
  const selectedMember = available.find((m) => m.workflowId === effectiveWfid);
  const job = effectiveWfid ? jobs[effectiveWfid] : undefined;

  if (!job || !selectedMember) {
    return (
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', padding: '8px' }}>
        No hydrated member yet — CONFIG edits are member-scoped.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px',
          border: '1px solid var(--color-border-hairline)',
          background: 'var(--color-bg)',
          marginBottom: '10px',
        }}
      >
        <span className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>
          MEMBER
        </span>
        <select
          value={effectiveWfid}
          onChange={(e) => setSelectedWfid(e.target.value)}
          className="display-font"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--color-bg-panel)',
            color: 'var(--color-accent-primary)',
            border: '1px solid var(--color-border-hairline)',
            padding: '4px 6px',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          {available.map((m) => (
            <option key={m.workflowId} value={m.workflowId}>
              {m.displayName} · {(jobs[m.workflowId]?.config.primaryProvider ?? 'claude').toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <ConfigTab
        job={job}
        onUpdatePrimary={onUpdateMemberPrimary
          ? (update) => onUpdateMemberPrimary(effectiveWfid, update)
          : undefined}
        onAttachCodebaseMemory={onAttachCodebaseMemory}
        onDetachCodebaseMemory={onDetachCodebaseMemory}
        mcp={mcp}
      />
    </div>
  );
}

// Pull the cluster anchor's JobState from the store and hand it to HistoryTab
// unmodified. Empty-state when the cluster has no members (just-detached
// last member, or in-flight teardown).
function ClusterAnchoredHistory({ cluster }: { cluster: ClusterStatePayload }) {
  const anchorWfid = cluster.members[0]?.workflowId;
  const job = useAppStore((s) => (anchorWfid ? s.jobs[anchorWfid] : undefined));
  if (!anchorWfid || !job) {
    return (
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', padding: '8px' }}>
        No anchor member yet — HISTORY is sourced from the cluster&apos;s first
        member. Add a worker from the MEMBERS tab to populate.
      </div>
    );
  }
  return <HistoryTab job={job} />;
}

// PREVIEW is wired through the App-level setPreviewPort / clearPreviewPort
// senders, which route to wsSendRaw under the hood. Reach for wsSendRaw
// directly so we don't have to thread two more props from ClusterTab.
function ClusterAnchoredPreview({ cluster }: { cluster: ClusterStatePayload }) {
  const anchorWfid = cluster.members[0]?.workflowId;
  const job = useAppStore((s) => (anchorWfid ? s.jobs[anchorWfid] : undefined));
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  if (!anchorWfid || !job) {
    return (
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '11px', padding: '8px' }}>
        No anchor member yet — PREVIEW is sourced from the cluster&apos;s first
        member. Add a worker from the MEMBERS tab to populate.
      </div>
    );
  }
  const onSetPort = (port: number, framework?: string) => {
    if (!wsSendRaw) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    wsSendRaw({
      type: 'set_preview_port',
      workflowId: anchorWfid,
      port,
      ...(framework ? { framework } : {}),
      manual: true,
    });
  };
  const onClear = () => {
    if (!wsSendRaw) return;
    wsSendRaw({ type: 'clear_preview_port', workflowId: anchorWfid });
  };
  return <PreviewTab job={job} onSetPort={onSetPort} onClear={onClear} />;
}
