import type { MouseEventHandler } from 'react';

interface Props {
  messageCount: number;
  handoffCount: number;
  expanded: boolean;
  onToggle: MouseEventHandler<HTMLButtonElement>;
}

// One collapse pill that stands in for everything above the most-recent
// handoff seed. Default state is collapsed so the chat window shows only
// the current agent's transcript; expanding re-inlines the full prior
// history (intermediate handoff seeds still render as their own pills
// inside the expanded region, so stacked handoffs stay readable).
export function PriorSessionsSection({ messageCount, handoffCount, expanded, onToggle }: Props) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <button
        type="button"
        onClick={onToggle}
        data-help="chat.prior-sessions"
        title={expanded ? 'Collapse prior sessions' : 'Expand prior sessions'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          width: '100%',
          padding: '4px 10px',
          border: '1px solid var(--color-border-hairline)',
          borderLeft: '2px solid var(--color-fg-muted)',
          borderRadius: '3px',
          background: 'transparent',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'var(--font-body)',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            color: 'var(--color-accent-primary-dim)',
            fontSize: '10px',
            width: '10px',
            textAlign: 'center',
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        <span
          className="display-font"
          style={{
            color: 'var(--color-accent-primary-dim)',
            fontSize: '10px',
            letterSpacing: '1px',
            minWidth: '130px',
          }}
        >
          PRIOR SESSIONS
        </span>
        <span style={{ opacity: 0.8 }}>
          {messageCount} {messageCount === 1 ? 'message' : 'messages'} · {handoffCount}{' '}
          {handoffCount === 1 ? 'handoff' : 'handoffs'} · {expanded ? 'click to collapse' : 'click to expand'}
        </span>
      </button>
    </div>
  );
}
