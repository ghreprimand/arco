// LEDGER tab — the project task ledger (ARCHON_OPS_PLAN.md §D1, Part D).
//
// A DISTINCT persistent surface from the Plan tab (plan-scoped review) and the
// Tasks panel (in-turn subagent children). The ledger is cwd-scoped and durable
// across sessions; it mirrors the server's task_ledger_snapshot (keyed by cwd
// in the store). Mutations go out over WS and the server re-snapshots.
//
// Terminal statuses require an explicit operator click (the status select).
// Nothing on this surface auto-marks done/archived — mirroring the server-side
// §D1 acceptance invariant.

import { useState } from 'react';
import type { LedgerTask, LedgerTaskStatus, TaskLink } from '@archon/shared';
import { useAppStore } from '../../stores/appStore';
import type { JobState } from '../../stores/appStore';
import { LedgerLinks } from './LedgerLinks';

type WorktreeAwareLedgerTask = LedgerTask & { worktreeRequired?: boolean };
type LedgerTaskPatch = {
  title?: string;
  status?: LedgerTaskStatus;
  notes?: string;
  links?: TaskLink[];
  worktreeRequired?: boolean;
};

interface Props {
  job: JobState;
  onCreate?: (workflowId: string, title: string, notes?: string) => void;
  onUpdate?: (
    workflowId: string,
    id: string,
    patch: LedgerTaskPatch,
  ) => void;
  onDelete?: (workflowId: string, id: string) => void;
  // §K5 — spin / tear down an isolated git worktree for a task.
  onWorktreeCreate?: (workflowId: string, id: string) => void;
  onWorktreeRemove?: (workflowId: string, id: string) => void;
  // §D2 — resolve a clicked link to a destination (right-panel tab / workflow
  // tab / browser). Provided by RightPanel, which owns that state.
  onNavigate?: (link: TaskLink) => void;
}

const STATUSES: { id: LedgerTaskStatus; label: string }[] = [
  { id: 'triage', label: 'TRIAGE' },
  { id: 'todo', label: 'TODO' },
  { id: 'ready', label: 'READY' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'blocked', label: 'BLOCKED' },
  { id: 'review', label: 'REVIEW' },
  { id: 'done', label: 'DONE' },
  { id: 'archived', label: 'ARCHIVED' },
];

function statusColor(status: LedgerTaskStatus): string {
  switch (status) {
    case 'in_progress': return 'var(--color-accent-primary)';
    case 'done':        return 'var(--color-accent-secondary)';
    case 'ready':       return '#58a66c';
    case 'review':      return '#8a7cf0';
    case 'blocked':     return '#e0a030';
    case 'archived':    return '#777';
    default:            return 'var(--color-fg-muted)';
  }
}

export function LedgerTab({ job, onCreate, onUpdate, onDelete, onWorktreeCreate, onWorktreeRemove, onNavigate }: Props) {
  const cwd = job.config.workingDirectory;
  const tasks = (useAppStore((s) => (cwd ? s.taskLedger[cwd] : undefined)) ?? []) as WorktreeAwareLedgerTask[];
  const [newTitle, setNewTitle] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [draftWorktreeRequired, setDraftWorktreeRequired] = useState(false);

  if (!cwd) {
    return (
      <div style={{ padding: '16px', color: 'var(--color-fg-muted)', fontSize: '12px' }}>
        This workflow has no working directory, so it has no project task ledger.
      </div>
    );
  }

  const submitNew = () => {
    const title = newTitle.trim();
    if (!title) return;
    onCreate?.(job.id, title);
    setNewTitle('');
  };

  const beginEdit = (t: WorktreeAwareLedgerTask) => {
    setEditingId(t.id);
    setDraftTitle(t.title);
    setDraftNotes(t.notes);
    setDraftWorktreeRequired(Boolean(t.worktreeRequired));
  };

  const commitEdit = (t: WorktreeAwareLedgerTask) => {
    const patch: LedgerTaskPatch = {};
    const nextTitle = draftTitle.trim();
    if (nextTitle && nextTitle !== t.title) patch.title = nextTitle;
    if (draftNotes !== t.notes) patch.notes = draftNotes;
    if (draftWorktreeRequired !== Boolean(t.worktreeRequired)) patch.worktreeRequired = draftWorktreeRequired;
    if (Object.keys(patch).length > 0) onUpdate?.(job.id, t.id, patch);
    setEditingId(null);
  };

  // Sort: active tasks first (by created), terminal tasks sink to the bottom.
  const ordered = [...tasks].sort((a, b) => {
    const ad = a.status === 'done' || a.status === 'archived' ? 1 : 0;
    const bd = b.status === 'done' || b.status === 'archived' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return a.createdAt - b.createdAt;
  });
  const openCount = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Add-task row */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          padding: '10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          flexShrink: 0,
        }}
      >
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); }}
          placeholder="Add a task…"
          data-help="rightpanel.ledger.add"
          style={{
            flex: 1,
            background: 'var(--color-bg-inset)',
            border: '1px solid var(--color-border-hairline)',
            color: 'var(--color-fg)',
            padding: '6px 8px',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          onClick={submitNew}
          data-help="rightpanel.ledger.add"
          style={{
            background: 'var(--color-accent-primary-a08)',
            border: '1px solid var(--color-accent-primary)',
            color: 'var(--color-accent-primary)',
            padding: '6px 12px',
            fontSize: '11px',
            cursor: 'pointer',
            fontFamily: 'var(--font-display)',
            letterSpacing: '1px',
          }}
        >
          ADD
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px' }}>
        {ordered.length === 0 && (
          <div style={{ color: 'var(--color-fg-muted)', fontSize: '12px', padding: '8px' }}>
            No tasks yet. The ledger is durable per project folder — it persists
            across sessions and is rebuilt from <code>events.jsonl</code> if the
            snapshot is ever lost.
          </div>
        )}
        {ordered.map((t) => {
          const editing = editingId === t.id;
          return (
            <div
              key={t.id}
              style={{
                border: '1px solid var(--color-border-hairline)',
                borderLeft: `3px solid ${statusColor(t.status)}`,
                background: 'var(--color-bg-inset)',
                padding: '8px',
                marginBottom: '6px',
                opacity: t.status === 'done' || t.status === 'archived' ? 0.6 : 1,
              }}
            >
              {editing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    data-help="rightpanel.ledger.edit"
                    style={{
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border-hairline)',
                      color: 'var(--color-fg)',
                      padding: '4px 6px',
                      fontSize: '12px',
                      fontFamily: 'var(--font-mono)',
                    }}
                  />
                  <textarea
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Notes…"
                    rows={3}
                    data-help="rightpanel.ledger.edit"
                    style={{
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border-hairline)',
                      color: 'var(--color-fg)',
                      padding: '4px 6px',
                      fontSize: '12px',
                      fontFamily: 'var(--font-mono)',
                      resize: 'vertical',
                    }}
                  />
                  <label
                    data-help="rightpanel.ledger.worktree-required"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '11px',
                      color: 'var(--color-fg-muted)',
                      fontFamily: 'var(--font-display)',
                      letterSpacing: 0,
                    }}
                    title="Require an isolated worktree before automated task dispatch runs this task."
                  >
                    <input
                      type="checkbox"
                      checked={draftWorktreeRequired}
                      onChange={(e) => setDraftWorktreeRequired(e.target.checked)}
                    />
                    WORKTREE REQUIRED
                  </label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => commitEdit(t)}
                      style={btnStyle('var(--color-accent-primary)')}
                    >
                      SAVE
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      style={btnStyle('var(--color-fg-muted)')}
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                    <div
                      style={{
                        flex: 1,
                        fontSize: '13px',
                        color: 'var(--color-fg)',
                        textDecoration: t.status === 'done' || t.status === 'archived' ? 'line-through' : 'none',
                        wordBreak: 'break-word',
                      }}
                    >
                      {t.title}
                    </div>
                  </div>
                  {t.notes && (
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--color-fg-muted)',
                        marginTop: '4px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {t.notes}
                    </div>
                  )}
                  {/* §D2 — linked plan items / reviews / workflows / urls. Edits
                      send the full new links[] via the existing update sender. */}
                  <LedgerLinks
                    links={t.links}
                    onNavigate={(l) => onNavigate?.(l)}
                    onChange={(links) => onUpdate?.(job.id, t.id, { links })}
                  />
                  {t.worktreeRequired && (
                    <div
                      data-help="rightpanel.ledger.worktree-required"
                      style={{
                        marginTop: '6px',
                        fontSize: '10px',
                        fontFamily: 'var(--font-display)',
                        letterSpacing: 0,
                        color: t.worktree ? 'var(--color-accent-secondary)' : '#e0a030',
                      }}
                      title={t.worktree ? 'This required worktree is present.' : 'This task is marked worktree-required but has no worktree yet.'}
                    >
                      WORKTREE REQUIRED{t.worktree ? ' · READY' : ' · NOT ISOLATED'}
                    </div>
                  )}
                  {/* §K5 — isolated git worktree for this task. When present, show
                      the branch (committed work lives on it; REMOVE keeps it). */}
                  {t.worktree && (
                    <div
                      style={{
                        marginTop: '6px',
                        padding: '4px 6px',
                        border: '1px solid var(--color-border-hairline)',
                        background: 'var(--color-bg)',
                        fontSize: '10px',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-fg-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      data-help="rightpanel.ledger.worktree"
                    >
                      <span style={{ color: 'var(--color-accent-secondary)' }}>⎇ {t.worktree.branch}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.worktree.path}
                      </span>
                      <button
                        onClick={() => onWorktreeRemove?.(job.id, t.id)}
                        style={btnStyle('var(--color-fg-muted)')}
                        data-help="rightpanel.ledger.worktree"
                      >
                        REMOVE
                      </button>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
                    {/* Status select — the ONLY way to set 'done', and it's an
                        explicit operator action (mirrors the server invariant). */}
                    <select
                      value={t.status}
                      onChange={(e) => onUpdate?.(job.id, t.id, { status: e.target.value as LedgerTaskStatus })}
                      data-help="rightpanel.ledger.status"
                      style={{
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border-hairline)',
                        color: statusColor(t.status),
                        fontSize: '10px',
                        padding: '2px 4px',
                        fontFamily: 'var(--font-display)',
                        letterSpacing: '0.5px',
                      }}
                    >
                      {STATUSES.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </select>
                    <div style={{ flex: 1 }} />
                    {!t.worktree && onWorktreeCreate && (
                      <button
                        onClick={() => onWorktreeCreate(job.id, t.id)}
                        style={btnStyle('var(--color-fg-muted)')}
                        data-help="rightpanel.ledger.worktree"
                      >
                        ISOLATE
                      </button>
                    )}
                    <button onClick={() => beginEdit(t)} style={btnStyle('var(--color-fg-muted)')} data-help="rightpanel.ledger.edit">
                      EDIT
                    </button>
                    <button onClick={() => onDelete?.(job.id, t.id)} style={btnStyle('var(--color-fg-muted)')} data-help="rightpanel.ledger.delete">
                      DELETE
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer count */}
      <div
        style={{
          padding: '6px 10px',
          borderTop: '1px solid var(--color-border-hairline)',
          fontSize: '10px',
          color: 'var(--color-fg-muted)',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
          flexShrink: 0,
        }}
      >
        {openCount} OPEN · {tasks.length} TOTAL
      </div>
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${color}`,
    color,
    padding: '3px 8px',
    fontSize: '10px',
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    letterSpacing: '0.5px',
  };
}
