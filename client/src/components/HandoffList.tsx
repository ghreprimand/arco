import { useEffect, useState } from 'react';
import type { HandoffEntry, JobState } from '../stores/appStore';

export interface HandoffEntryListRow {
  kind?: 'handoff';
  handoff: HandoffEntry;
  cwd: string;
  workflowId: string;
  provider: JobState['config']['primaryProvider'];
  label?: string;
}

export interface HandoffLockListRow {
  kind: 'lock';
  cwd: string;
  workflowId: string;
  provider: JobState['config']['primaryProvider'];
  label?: string;
  lockId: string;
  handoffId?: string;
  status: 'preparing' | 'running';
  startedAt: number;
}

export type HandoffListRow = HandoffEntryListRow | HandoffLockListRow;

interface HandoffListProps {
  rows: HandoffListRow[];
  emptyText: string;
  onCancelHandoff?: (workflowId: string, handoffId: string) => void;
  onClearLock?: (cwd: string, workflowId: string, handoffId?: string) => void;
}

function rowStartedAt(row: HandoffListRow): number {
  return row.kind === 'lock' ? row.startedAt : row.handoff.startedAt;
}

function rowKey(row: HandoffListRow): string {
  return row.kind === 'lock'
    ? `lock:${row.workflowId}:${row.lockId}`
    : `handoff:${row.workflowId}:${row.handoff.handoffId}`;
}

export function HandoffList({ rows, emptyText, onCancelHandoff, onClearLock }: HandoffListProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = [...rows].sort((a, b) => rowStartedAt(b) - rowStartedAt(a));

  if (sorted.length === 0) {
    return (
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
        {emptyText}
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      {sorted.map((row) => {
        const key = rowKey(row);
        const cancellable = row.provider !== 'antigravity';
        const cancelRow =
          row.kind === 'lock'
            ? onClearLock ? () => onClearLock(row.cwd, row.workflowId, row.handoffId) : undefined
            : cancellable && onCancelHandoff ? () => onCancelHandoff(row.workflowId, row.handoff.handoffId) : undefined;
        return (
          <HandoffRow
            key={key}
            row={row}
            open={expanded === key}
            onToggle={() => setExpanded(expanded === key ? null : key)}
            onCancel={cancelRow}
          />
        );
      })}
    </div>
  );
}

function HandoffRow({
  row,
  open,
  onToggle,
  onCancel,
}: {
  row: HandoffListRow;
  open: boolean;
  onToggle: () => void;
  onCancel?: () => void;
}) {
  const cwd = row.cwd;
  const workflowId = row.workflowId;
  const label = row.label;
  const isLock = row.kind === 'lock';
  const handoff = isLock ? null : row.handoff;
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const done = handoff ? Boolean(handoff.completedAt) : false;
  const inFlight = isLock || Boolean(handoff && !done && !handoff.error && !handoff.cancelled);

  useEffect(() => {
    if (!handoff) return;
    if (!open || body !== null || !handoff.artifactName || !cwd) return;
    let cancelled = false;
    const q = new URLSearchParams({ path: cwd, workflowId, name: handoff.artifactName });
    fetch(`/api/workflows/handoff?${q.toString()}`)
      .then((r) => r.ok ? r.json() as Promise<{ contents: string }> : Promise.reject(r.statusText))
      .then((d) => { if (!cancelled) setBody(d.contents); })
      .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    return () => { cancelled = true; };
  }, [open, handoff, cwd, workflowId, body]);

  const startedAt = isLock ? row.startedAt : handoff?.startedAt ?? Date.now();
  const stateText = isLock
    ? row.status === 'preparing' ? 'PREP' : 'LOCK'
    : handoff?.cancelled ? 'CANCEL'
      : handoff?.error ? 'ERROR'
      : inFlight ? 'RUN...'
      : 'OK';
  const stateColor = !handoff || (!handoff.cancelled && !handoff.error)
    ? 'var(--color-accent-primary)'
    : handoff.cancelled ? 'var(--color-fg-muted)' : 'var(--color-warning)';
  const summary = isLock
    ? `${label ? `${label} · ` : ''}${row.status === 'preparing' ? 'handoff preparing' : 'handoff lock'}${row.handoffId ? ` · ${row.handoffId}` : ''}`
    : `${label ? `${label} · ` : ''}${handoff?.mode}${typeof handoff?.turnCount === 'number' ? ` · ${handoff.turnCount} turn${handoff.turnCount === 1 ? '' : 's'}` : ''}${handoff?.archivedSessionId ? ` · ${handoff.archivedSessionId.slice(0, 8)} -> ${(handoff.newSessionId ?? '').slice(0, 8) || '...'}` : ''}`;

  return (
    <div style={{ borderBottom: '1px solid var(--color-accent-primary-a05)' }}>
      <button
        onClick={onToggle}
        className="display-font"
        style={{
          width: '100%',
          padding: '8px 14px',
          background: open ? 'var(--color-accent-primary-a08)' : 'transparent',
          border: 'none',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ color: stateColor, minWidth: '56px' }}>
          {stateText}
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <span style={{ opacity: 0.6 }}>{new Date(startedAt).toLocaleTimeString()}</span>
        {inFlight && onCancel && (
          <span
            role="button"
            tabIndex={0}
            title="Cancel handoff"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
              }
            }}
            style={{ color: 'var(--color-warning)', cursor: 'pointer', padding: '0 4px', fontSize: '12px' }}
          >
            x
          </span>
        )}
        <span style={{ opacity: 0.6 }}>{open ? 'v' : '>'}</span>
      </button>
      {open && (
        <div style={{ padding: '10px 14px 16px', background: 'var(--color-bg-sunken)' }}>
          {isLock && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px', lineHeight: 1.6 }}>
              Server lock only. Clear it if the handoff is stale or no matching RUN row appears.
            </div>
          )}
          {handoff?.cancelled && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px', marginBottom: '8px' }}>
              Handoff cancelled by operator.
            </div>
          )}
          {handoff?.error && !handoff.cancelled && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px', marginBottom: '8px' }}>
              Handoff failed: {handoff.error}
            </div>
          )}
          {!isLock && inFlight && (
            <div className="display-font" style={{ color: 'var(--color-fg-muted)', fontSize: '10px', letterSpacing: '1px' }}>
              Generating handoff document...
            </div>
          )}
          {loadError && (
            <div style={{ color: 'var(--color-warning)', fontSize: '11px' }}>
              Artifact load failed: {loadError}. Open `.archon/workflows/{workflowId.slice(0, 8)}/handoffs/{handoff?.artifactName ?? ''}` directly.
            </div>
          )}
          {body !== null && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '12px',
                fontFamily: 'var(--font-body)',
                color: 'var(--color-accent-primary)',
                margin: 0,
              }}
            >
              {body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
