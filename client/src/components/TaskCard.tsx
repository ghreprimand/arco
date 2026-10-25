import { useEffect, useState } from 'react';
import { useAppStore, type TaskChildEntry } from '../stores/appStore';

interface Props {
  // Parent workflow id — taskChildren live on this JobState.
  parentJobId: string;
  // Block id of the parent assistant's Task tool_use — used to look up
  // the matching taskChildren entry. The chat renderer passes this from
  // `message.toolUse.toolUseId`.
  toolUseId: string;
  // Description fallback when the task_started event hasn't landed yet
  // (rare race: chat replay reaches the synthetic tool_use row before
  // the lifecycle WS message). Sourced from the synthetic message's
  // toolUse.input.description so the card always renders something.
  fallbackDescription?: string;
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

export function TaskCard({ parentJobId, toolUseId, fallbackDescription }: Props) {
  const entry = useAppStore((s) => {
    const job = s.jobs[parentJobId];
    if (!job?.taskChildren) return undefined;
    return Object.values(job.taskChildren).find((t) => t.toolUseId === toolUseId);
  });
  const childJob = useAppStore((s) => entry ? s.jobs[entry.childWorkflowId] : undefined);
  const promoteTaskChild = useAppStore((s) => s.promoteTaskChild);
  const wsSendRaw = useAppStore((s) => s.wsSendRaw);
  const [expanded, setExpanded] = useState(false);

  // Tick for the "running" elapsed counter. Stops on settle.
  const [, force] = useState(0);
  useEffect(() => {
    if (!entry || entry.phase !== 'running') return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [entry?.phase, entry?.taskId]);

  const description = entry?.description ?? fallbackDescription ?? '(unknown task)';
  const phase = entry?.phase ?? 'running';
  const elapsed = entry
    ? (entry.phase === 'running' ? Date.now() - entry.startedAt : (entry.elapsedMs ?? 0))
    : 0;
  const promoted = childJob?.promoted === true;
  const canCancel = entry && phase === 'running';

  const handleCancel = () => {
    if (!entry || !wsSendRaw) return;
    wsSendRaw({ type: 'cancel', workflowId: entry.childWorkflowId });
  };

  const handlePromote = () => {
    if (!entry) return;
    promoteTaskChild(entry.childWorkflowId);
  };

  return (
    <div
      data-help="chat.task-card"
      style={{
        marginBottom: '6px',
        marginLeft: '4px',
        border: '1px solid var(--color-border-hairline)',
        borderLeft: `2px solid ${phaseColor(phase)}`,
        borderRadius: '3px',
        background: 'transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 10px',
          fontSize: '12px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg-muted)',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-accent-primary-dim)',
            cursor: 'pointer',
            fontSize: '10px',
            padding: 0,
            width: '10px',
            textAlign: 'center',
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          className="display-font"
          style={{
            color: phaseColor(phase),
            fontSize: '10px',
            letterSpacing: '1.5px',
            minWidth: '40px',
          }}
        >
          TASK
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
          title={description}
        >
          {description}
        </span>
        <span
          className="display-font"
          style={{ fontSize: '10px', letterSpacing: '0.5px', color: phaseColor(phase) }}
          title={`${phase}${entry?.summary ? ` — ${entry.summary}` : ''}`}
        >
          {fmtElapsed(elapsed)} {phaseGlyph(phase)} {phase.toUpperCase()}
        </span>
      </div>
      {expanded && (
        <div
          style={{
            display: 'flex',
            gap: '12px',
            padding: '4px 10px 8px 28px',
            borderTop: '1px solid var(--color-border-hairline)',
            fontSize: '11px',
            color: 'var(--color-fg-muted)',
          }}
        >
          {entry && !promoted && (
            <button
              type="button"
              onClick={handlePromote}
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
              title="Open this child workflow in the top tab strip"
            >
              PROMOTE TO TAB
            </button>
          )}
          {entry && promoted && (
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
          {canCancel && (
            <button
              type="button"
              onClick={handleCancel}
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
              title="Cancel this child workflow"
            >
              CANCEL
            </button>
          )}
          {entry?.summary && (
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontStyle: 'italic',
              }}
              title={entry.summary}
            >
              {entry.summary}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
