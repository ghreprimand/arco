import { useMemo, useState } from 'react';
import { useAppStore, type JobState, type HistoryEventEntry } from '../stores/appStore';
import type { ProviderName, ModelName, EffortLevel, ReviewContextRef, WorkflowConfig, ServerMessage } from '@archon/shared';
import { ReviewDialog } from './ReviewDialog';
import { SpawnDialog } from './SpawnDialog';
import { FileViewerModal } from './FileViewerModal';
import { CheckpointActions } from './CheckpointActions';
import { PurgeConversationModal } from './PurgeConversationModal';
import { narrativeEventFromMessage } from '../utils/historyEvents';

// Phase 8 — read-only timeline of a workflow's narrative events. Filter
// strip + selection state + action bar; LABEL pins a note to the chosen
// seq, REVIEW dispatches a since-event review, SPAWN dispatches a
// spawn_from_here_request with cutoffEventSeq. Everything reads from
// `job.historyEvents` (populated in useWebSocket via narrativeEventFromMessage).

interface Props {
  job: JobState;
}

type FilterPreset = 'all' | 'turns' | 'tools' | 'labels' | 'handoffs' | 'reviews' | 'checkpoints' | 'forks';

const FILTERS: { id: FilterPreset; label: string; categories: HistoryEventEntry['category'][] | null }[] = [
  { id: 'all', label: 'ALL', categories: null },
  { id: 'turns', label: 'TURNS ONLY', categories: ['user', 'primary'] },
  { id: 'tools', label: 'TOOL CALLS', categories: ['tool', 'task'] },
  { id: 'labels', label: 'LABELS', categories: ['label'] },
  { id: 'handoffs', label: 'HANDOFFS', categories: ['handoff'] },
  { id: 'reviews', label: 'REVIEWS', categories: ['review'] },
  { id: 'checkpoints', label: 'CHECKPOINTS', categories: ['checkpoint'] },
  { id: 'forks', label: 'REWINDS', categories: ['fork'] },
];

const FILTER_KEY_PREFIX = 'archon.historyFilter.byWorkflow';

function loadFilter(workflowId: string): FilterPreset {
  try {
    const raw = localStorage.getItem(FILTER_KEY_PREFIX);
    if (!raw) return 'turns';
    const parsed = JSON.parse(raw) as Record<string, FilterPreset>;
    const v = parsed?.[workflowId];
    if (v && FILTERS.some((f) => f.id === v)) return v;
  } catch { /* no-op */ }
  return 'turns';
}

function saveFilter(workflowId: string, preset: FilterPreset): void {
  try {
    const raw = localStorage.getItem(FILTER_KEY_PREFIX);
    const parsed = raw ? (JSON.parse(raw) as Record<string, FilterPreset>) : {};
    parsed[workflowId] = preset;
    localStorage.setItem(FILTER_KEY_PREFIX, JSON.stringify(parsed));
  } catch { /* no-op */ }
}

function compareHistoryEntriesForUi(a: HistoryEventEntry, b: HistoryEventEntry): number {
  const aKey = a.category === 'label' && a.anchorSeq !== undefined ? a.anchorSeq : a.seq;
  const bKey = b.category === 'label' && b.anchorSeq !== undefined ? b.anchorSeq : b.seq;
  if (aKey !== bKey) return aKey - bKey;
  if (a.category === 'label' && b.category !== 'label') return 1;
  if (a.category !== 'label' && b.category === 'label') return -1;
  return a.seq - b.seq;
}

function resolveHistoryLabelTimes(events: HistoryEventEntry[]): HistoryEventEntry[] {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  return events.map((e) => {
    if (e.category !== 'label' || e.at !== undefined || e.anchorSeq === undefined) return e;
    return { ...e, at: bySeq.get(e.anchorSeq)?.at ?? e.pinnedAt };
  });
}

function formatTime(ms?: number): string {
  if (!ms) return '— : — : —';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function HistoryTab({ job }: Props) {
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const flashChatMessage = useAppStore((s) => s.flashChatMessage);
  const [preset, setPreset] = useState<FilterPreset>(() => loadFilter(job.id));
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [labelText, setLabelText] = useState('');
  const [labelSubmitting, setLabelSubmitting] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [rewindConfirm, setRewindConfirm] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [viewerArtifact, setViewerArtifact] = useState<string | null>(null);
  const [pagedEvents, setPagedEvents] = useState<HistoryEventEntry[]>([]);
  const [historyHasEarlier, setHistoryHasEarlier] = useState(true);
  const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
  // Reviews live under .archon/workflows/<id>/artifacts/, handoffs under
  // .archon/workflows/<id>/handoffs/ — same modal, different subdir.
  const [viewerArtifactKind, setViewerArtifactKind] = useState<'review' | 'handoff'>('review');

  const events = useMemo(() => {
    const bySeq = new Map<number, HistoryEventEntry>();
    for (const e of pagedEvents) bySeq.set(e.seq, e);
    for (const e of job.historyEvents ?? []) bySeq.set(e.seq, e);
    return resolveHistoryLabelTimes([...bySeq.values()].sort(compareHistoryEntriesForUi));
  }, [job.historyEvents, pagedEvents]);
  const visible = useMemo(() => {
    const filt = FILTERS.find((f) => f.id === preset);
    if (!filt || !filt.categories) return events;
    const cats = new Set(filt.categories);
    return events.filter((e) => cats.has(e.category));
  }, [events, preset]);

  const selected = selectedSeq != null
    ? events.find((e) => e.seq === selectedSeq) ?? null
    : null;

  const setFilter = (next: FilterPreset) => {
    setPreset(next);
    saveFilter(job.id, next);
  };

  const loadEarlierHistory = async () => {
    if (loadingEarlierHistory || events.length === 0) return;
    setLoadingEarlierHistory(true);
    try {
      const beforeSeq = Math.min(...events.map((e) => e.seq));
      const q = new URLSearchParams({
        path: job.config.workingDirectory,
        workflowId: job.id,
        beforeSeq: String(beforeSeq),
        limit: '500',
      });
      const r = await fetch(`/api/workflows/events?${q.toString()}`);
      if (!r.ok) return;
      const d: { events?: ServerMessage[]; hasEarlier?: boolean } = await r.json();
      const rows = (d.events ?? [])
        .map(narrativeEventFromMessage)
        .filter((e): e is HistoryEventEntry => e !== null);
      setHistoryHasEarlier(!!d.hasEarlier);
      if (rows.length > 0) {
        setPagedEvents((prev) => {
          const bySeq = new Map<number, HistoryEventEntry>();
          for (const e of rows) bySeq.set(e.seq, e);
          for (const e of prev) bySeq.set(e.seq, e);
          return resolveHistoryLabelTimes([...bySeq.values()].sort(compareHistoryEntriesForUi));
        });
      }
    } finally {
      setLoadingEarlierHistory(false);
    }
  };

  const handleSelect = (entry: HistoryEventEntry) => {
    setSelectedSeq(entry.seq);
    setRewindConfirm(false);
    if (entry.chatMessageId) {
      flashChatMessage(job.id, entry.chatMessageId);
    }
    // Review / handoff rows open the artifact in FileViewerModal — same UX
    // as clicking a file pill elsewhere in the app. Reviews live under
    // artifacts/, handoffs under handoffs/.
    if (entry.category === 'review' && entry.reviewArtifactName) {
      setViewerArtifactKind('review');
      setViewerArtifact(entry.reviewArtifactName);
    } else if (entry.category === 'handoff' && entry.handoffArtifactName) {
      setViewerArtifactKind('handoff');
      setViewerArtifact(entry.handoffArtifactName);
    }
  };

  const handleLabelSubmit = () => {
    if (!selected || !wsSendRaw) return;
    const text = labelText.trim();
    if (!text || text.length > 200) return;
    setLabelSubmitting(true);
    wsSendRaw({
      type: 'create_label_request',
      workflowId: job.id,
      text,
      targetEventSeq: selected.seq,
    });
    // Optimistic-free: server's broadcast lands as operator_label and
    // appendHistoryEvent inserts the row.
    setLabelText('');
    setTimeout(() => setLabelSubmitting(false), 250);
  };

  // PHASE_9_FORKS_PLAN.md — REWIND CONVERSATION. Two-click confirm (the action
  // is reversible — "undo the undo" is just another rewind — so an inline
  // confirm is enough; no modal). The server validates range + busy and forks a
  // child of the selected seq, leaving the abandoned branch intact on disk.
  const handleRewind = () => {
    if (!selected || !wsSendRaw || job.busy) return;
    if (!rewindConfirm) {
      setRewindConfirm(true);
      return;
    }
    wsSendRaw({
      type: 'revert_to_point_request',
      workflowId: job.id,
      targetSeq: selected.seq,
    });
    setRewindConfirm(false);
  };

  const handleReviewConfirm = (
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    contextRef: ReviewContextRef,
    includeGitDiff: boolean,
  ) => {
    setReviewOpen(false);
    if (!wsSendRaw) return;
    wsSendRaw({
      type: 'review_request',
      workflowId: job.id,
      reviewer,
      contextRef,
      includeGitDiff,
    });
  };

  const handleSpawnConfirm = (newConfig: WorkflowConfig, newDirection: string, includePlan: boolean) => {
    setSpawnOpen(false);
    if (!wsSendRaw || !selected) return;
    wsSendRaw({
      type: 'spawn_from_here_request',
      parentWorkflowId: job.id,
      newConfig,
      mode: 'original-worker',
      ...(newDirection.trim() ? { newDirection: newDirection.trim() } : {}),
      ...(includePlan ? { includePlan: true } : {}),
      cutoffEventSeq: selected.seq,
    });
  };

  // Build a human-readable scope label for the locked-since-event review.
  // "FROM 07:39:02 — research checkpoint" when the anchor is a label;
  // "FROM 07:39:02 — USER prompt" for any other anchor.
  const reviewScopeLabel = (() => {
    if (!selected) return undefined;
    const time = formatTime(selected.at);
    const tail = selected.category === 'label'
      ? selected.summary ?? 'label'
      : `${selected.label} event`;
    return `FROM ${time} — ${tail}`;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Filter strip */}
      <div
        className="display-font"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          padding: '8px 10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          flexShrink: 0,
        }}
      >
        {FILTERS.map((f) => {
          const active = preset === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="display-font"
              style={{
                padding: '4px 8px',
                background: active ? 'var(--color-accent-primary-a10)' : 'transparent',
                border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
                borderRadius: '3px',
                color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                letterSpacing: '1px',
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 0' }}>
        {events.length > 0 && historyHasEarlier && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 10px' }}>
            <button
              type="button"
              onClick={loadEarlierHistory}
              disabled={loadingEarlierHistory}
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-fg-muted)',
                color: 'var(--color-fg-muted)',
                padding: '5px 12px',
                fontSize: '10px',
                letterSpacing: '1px',
                cursor: loadingEarlierHistory ? 'default' : 'pointer',
                opacity: loadingEarlierHistory ? 0.5 : 1,
              }}
            >
              {loadingEarlierHistory ? 'LOADING...' : 'LOAD EARLIER HISTORY'}
            </button>
          </div>
        )}
        {visible.length === 0 ? (
          <div
            className="display-font"
            style={{
              padding: '24px 18px',
              color: 'var(--color-fg-muted)',
              fontSize: '11px',
              letterSpacing: '0.5px',
              lineHeight: 1.6,
            }}
          >
            {events.length === 0
              ? 'No narrative events yet. Send a message to start populating the timeline.'
              : 'No events match the current filter. Switch to ALL to see everything.'}
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            {/* Vertical rail */}
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: '20px',
                top: 0,
                bottom: 0,
                width: '1px',
                background: 'var(--color-border-hairline)',
              }}
            />
            {visible.map((e) => (
              <TimelineRow
                key={e.seq}
                entry={e}
                selected={selectedSeq === e.seq}
                onSelect={() => handleSelect(e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Action bar */}
      <div
        style={{
          flexShrink: 0,
          borderTop: '1px solid var(--color-border-hairline)',
          padding: '10px 12px',
          background: 'var(--color-bg)',
        }}
      >
        <div
          className="display-font"
          style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginBottom: '8px' }}
        >
          {selected
            ? `SELECTED · seq ${selected.seq} · ${selected.label}${selected.summary ? ` · ${selected.summary}` : ''}`
            : 'SELECT A ROW TO ENABLE LABEL / REVIEW / SPAWN'}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder="Label this point…"
            disabled={!selected}
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !labelSubmitting && selected && labelText.trim().length > 0) {
                handleLabelSubmit();
              }
            }}
            style={{
              flex: '1 1 160px',
              minWidth: '120px',
              padding: '6px 8px',
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg)',
              fontFamily: 'var(--font-body)',
              fontSize: '12px',
              opacity: selected ? 1 : 0.5,
            }}
          />
          <ActionBtn
            disabled={!selected || labelText.trim().length === 0 || labelSubmitting}
            onClick={handleLabelSubmit}
          >
            LABEL THIS
          </ActionBtn>
          <ActionBtn
            disabled={!selected}
            onClick={() => setReviewOpen(true)}
          >
            REVIEW FROM HERE
          </ActionBtn>
          {/* Server refuses spawn from a busy parent (a Codex app-server
              original-worker reflection would kill the live turn), so don't
              offer it. */}
          <ActionBtn
            disabled={!selected || !!job.busy}
            onClick={() => setSpawnOpen(true)}
            title={job.busy ? 'Wait for the in-flight turn to finish (or cancel it) before spawning from here' : undefined}
          >
            SPAWN FROM HERE
          </ActionBtn>
          {/* PHASE_9_FORKS_PLAN.md — conversation rewind (distinct from the git
              working-tree RESTORE FILES on checkpoint rows). Native-only in v1
              (server gates the claude-CLI / cascade edge); we hide it for
              non-Claude providers so it's never offered where it can't work.
              Two-click confirm. */}
          {(job.config.primaryProvider ?? 'claude') === 'claude' && (
            <>
              <ActionBtn
                disabled={!selected || !!job.busy}
                danger={rewindConfirm}
                onClick={handleRewind}
                title={job.busy ? 'Cancel the in-flight turn before rewinding' : 'Move the live head to this point; the current branch is kept and can be returned to (Claude Native)'}
              >
                {rewindConfirm ? 'CONFIRM REWIND ↩' : 'REWIND CONVERSATION'}
              </ActionBtn>
              {rewindConfirm && (
                <ActionBtn disabled={false} onClick={() => setRewindConfirm(false)}>
                  CANCEL
                </ActionBtn>
              )}
            </>
          )}
        </div>
        {/* A4 — checkpoint rows get revert + view-diff actions. Reverted
            markers ("REVERTED ↩") are themselves history, so no revert offered. */}
        {selected && selected.category === 'checkpoint' && !selected.reverted && (
          <div style={{ marginTop: '8px' }}>
            <CheckpointActions
              entry={selected}
              workflowId={job.id}
              cwd={job.config.workingDirectory}
              busy={!!job.busy}
            />
          </div>
        )}
        {/* Danger zone — irreversibly purge the whole conversation (not a single
            row). Separated from the row-scoped actions above. */}
        {job.config.workingDirectory && (
          <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px dashed var(--color-border-hairline)', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setPurgeOpen(true)}
              data-help="rightpanel.history.purge"
              className="display-font"
              title="Permanently delete this entire conversation and everything associated with it"
              style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
            >
              ⌦ PURGE CONVERSATION
            </button>
          </div>
        )}
      </div>

      {reviewOpen && selected && (
        <ReviewDialog
          primary={{
            provider: job.config.primaryProvider ?? 'claude',
            model: job.config.primaryModel,
            effort: job.config.primaryEffort,
            providerAccountRef: job.config.providerAccountRef,
          }}
          prefilledSinceEventRef={{ kind: 'since-event', anchorEventSeq: selected.seq }}
          prefilledScopeLabel={reviewScopeLabel}
          onConfirm={handleReviewConfirm}
          onCancel={() => setReviewOpen(false)}
        />
      )}

      {spawnOpen && selected && (
        <SpawnDialog
          parentConfig={job.config}
          parentPlanTitle={job.plan?.title ?? null}
          onConfirm={handleSpawnConfirm}
          onCancel={() => setSpawnOpen(false)}
        />
      )}

      {viewerArtifact && job.config.workingDirectory && (
        <FileViewerModal
          path={`${job.config.workingDirectory}/.archon/workflows/${job.id}/${viewerArtifactKind === 'handoff' ? 'handoffs' : 'artifacts'}/${viewerArtifact}`}
          fallback={{ cwd: job.config.workingDirectory, workflowId: job.id }}
          onClose={() => setViewerArtifact(null)}
        />
      )}

      {purgeOpen && job.config.workingDirectory && (
        <PurgeConversationModal
          workflowId={job.id}
          cwd={job.config.workingDirectory}
          name={job.config.name}
          onClose={() => setPurgeOpen(false)}
          onPurged={() => {
            // Server already tore the workflow down (handleRemoveWorkflow); drop
            // the tab locally so the purged conversation disappears at once.
            setPurgeOpen(false);
            useAppStore.getState().removeJob(job.id);
          }}
        />
      )}
    </div>
  );
}

function TimelineRow({
  entry,
  selected,
  onSelect,
}: {
  entry: HistoryEventEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const dotColor = entry.category === 'checkpoint'
    ? entry.reverted ? 'var(--color-danger)' : '#4dd0e1'
    : entry.category === 'fork'
    ? '#b478ff'
    : entry.category === 'label'
    ? 'var(--color-accent-primary)'
    : entry.category === 'review'
      ? entry.reviewVerdict === 'BLOCKING' ? '#ff4d4d' : entry.reviewVerdict === 'MINOR' ? '#ffbf4d' : 'var(--color-accent-primary-dim)'
      : entry.category === 'task' && entry.taskPhase === 'error'
        ? '#ff4d4d'
        : 'var(--color-accent-primary-dim)';

  return (
    <button
      type="button"
      onClick={onSelect}
      className="display-font"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: selected ? 'var(--color-accent-primary-a08)' : 'transparent',
        border: 'none',
        borderLeft: selected ? '2px solid var(--color-accent-primary)' : '2px solid transparent',
        padding: '6px 12px 6px 16px',
        cursor: 'pointer',
        position: 'relative',
        fontFamily: 'inherit',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: '14px',
          top: '12px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: dotColor,
          boxShadow: '0 0 0 2px var(--color-bg)',
        }}
      />
      <div style={{ marginLeft: '24px', display: 'flex', gap: '10px', alignItems: 'baseline' }}>
        <span
          style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', minWidth: '60px' }}
        >
          {formatTime(entry.at)}
        </span>
        <span
          style={{
            fontSize: '10px',
            letterSpacing: '1.5px',
            color: selected ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
            minWidth: '90px',
          }}
        >
          {entry.label}
        </span>
        {entry.summary && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--color-fg)',
              fontFamily: 'var(--font-body)',
              flex: 1,
              wordBreak: 'break-word',
              opacity: 0.85,
            }}
          >
            {entry.summary}
          </span>
        )}
      </div>
      {entry.category === 'label' && entry.pinnedAt !== undefined && entry.pinnedAt !== entry.at && (
        <div
          style={{
            marginLeft: '24px',
            paddingLeft: '70px',
            fontSize: '10px',
            color: 'var(--color-fg-muted)',
            fontFamily: 'var(--font-body)',
            opacity: 0.7,
            marginTop: '2px',
          }}
        >
          (pinned {formatTime(entry.pinnedAt)})
        </div>
      )}
    </button>
  );
}

function ActionBtn({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const accent = danger ? 'var(--color-danger)' : 'var(--color-accent-primary)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="display-font"
      style={{
        padding: '6px 10px',
        background: disabled ? 'transparent' : danger ? 'var(--color-danger)' : 'var(--color-accent-primary-a10)',
        border: `1px solid ${disabled ? 'var(--color-border-hairline)' : accent}`,
        borderRadius: '3px',
        color: disabled ? 'var(--color-fg-muted)' : danger ? 'var(--color-bg)' : 'var(--color-accent-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '10px',
        letterSpacing: '1.5px',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
