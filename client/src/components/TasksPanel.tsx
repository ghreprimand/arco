import { useEffect, useState } from 'react';
import { useAppStore, type JobState, type TaskChildEntry } from '../stores/appStore';

interface Props {
  job: JobState;
}

function phaseGlyph(phase: TaskChildEntry['phase']): string {
  switch (phase) {
    case 'running': return '⚡';
    case 'done':    return '✓';
    case 'error':   return '✕';
    case 'cancelled': return '⊘';
    default: return '·';
  }
}

function phaseColor(phase: TaskChildEntry['phase']): string {
  switch (phase) {
    case 'running':   return 'var(--color-accent-primary)';
    case 'done':      return 'var(--color-accent-secondary)';
    case 'error':     return 'var(--color-fg-muted)';
    case 'cancelled': return 'var(--color-fg-muted)';
    default:          return 'var(--color-fg-muted)';
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
}

export function TasksPanel({ job }: Props) {
  const promoteTaskChild = useAppStore((s) => s.promoteTaskChild);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const allChildren = useAppStore((s) => s.jobs);
  const [, force] = useState(0);

  const entries = job.taskChildren ? Object.values(job.taskChildren) : [];
  const hasRunning = entries.some((e) => e.phase === 'running');
  // Tick the running counters at 1Hz. Stops when nothing is in-flight.
  useEffect(() => {
    if (!hasRunning) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  if (entries.length === 0) {
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
        No Task children. The agent will populate this tab when it calls the Task tool.
      </div>
    );
  }

  // Newest first.
  const sorted = [...entries].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div
        className="display-font"
        style={{
          padding: '8px 14px',
          color: 'var(--color-fg-muted)',
          fontSize: '10px',
          letterSpacing: '1.5px',
          borderBottom: '1px solid var(--color-border-hairline)',
        }}
      >
        TASKS · {entries.length}
      </div>
      {sorted.map((entry) => {
        const child = allChildren[entry.childWorkflowId];
        const promoted = child?.promoted === true;
        const elapsed = entry.phase === 'running'
          ? Date.now() - entry.startedAt
          : (entry.elapsedMs ?? 0);
        return (
          <div
            key={entry.taskId}
            style={{
              padding: '8px 14px',
              borderBottom: '1px solid var(--color-border-hairline)',
              fontFamily: 'var(--font-body)',
              fontSize: '12px',
              color: 'var(--color-fg-muted)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: phaseColor(entry.phase), fontSize: '13px', minWidth: '14px' }}>
                {phaseGlyph(entry.phase)}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={entry.description}
              >
                {entry.description}
              </span>
              <span
                className="display-font"
                style={{ fontSize: '10px', letterSpacing: '0.5px', color: phaseColor(entry.phase) }}
              >
                {fmtElapsed(elapsed)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              {!promoted && (
                <button
                  type="button"
                  onClick={() => promoteTaskChild(entry.childWorkflowId)}
                  className="display-font"
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    color: 'var(--color-accent-primary-dim)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1px',
                    padding: '2px 8px',
                  }}
                >
                  PROMOTE
                </button>
              )}
              {promoted && (
                <span
                  className="display-font"
                  style={{
                    fontSize: '10px',
                    letterSpacing: '1px',
                    color: 'var(--color-accent-secondary-dim)',
                    padding: '2px 8px',
                    border: '1px solid var(--color-border-hairline)',
                  }}
                >
                  PROMOTED
                </span>
              )}
              {entry.phase === 'running' && (
                <button
                  type="button"
                  onClick={() => wsSendRaw && wsSendRaw({ type: 'cancel', workflowId: entry.childWorkflowId })}
                  className="display-font"
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--color-border-hairline)',
                    color: 'var(--color-fg-muted)',
                    cursor: 'pointer',
                    fontSize: '10px',
                    letterSpacing: '1px',
                    padding: '2px 8px',
                  }}
                >
                  CANCEL
                </button>
              )}
            </div>
            {entry.summary && (
              <div
                style={{
                  marginTop: '6px',
                  paddingLeft: '24px',
                  fontSize: '11px',
                  fontStyle: 'italic',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={entry.summary}
              >
                {entry.summary}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
