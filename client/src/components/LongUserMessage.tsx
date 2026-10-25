import { useState } from 'react';
import type { ChatMessage as ChatMessageType } from '@archon/shared';
import { AttachmentPill } from './AttachmentPill';
import { linkifyText } from '../utils/linkify';
import { useOperatorLabel } from '../utils/operatorLabel';

interface Props {
  message: ChatMessageType;
  onCancelQueued?: (clientMessageId: string) => void;
}

export function LongUserMessage({ message, onCancelQueued }: Props) {
  const [expanded, setExpanded] = useState(false);
  const operatorLabel = useOperatorLabel();
  const lineCount = message.content.split('\n').length;
  const charCount = message.content.length;
  const hasAttachments = !!message.attachments && message.attachments.length > 0;

  return (
    <div style={{ marginBottom: '16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
          fontSize: '11px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
        }}
      >
        <span className="glow-text-cyan">&gt; {operatorLabel}</span>
        {message.queued && (
          <span
            className="display-font"
            style={{
              fontSize: '10px',
              letterSpacing: '1.5px',
              padding: '1px 6px',
              border: '1px solid var(--color-accent-secondary-dim)',
              color: 'var(--color-accent-secondary-dim)',
              opacity: 0.85,
            }}
            title="Queued — will be sent when the current turn finishes"
          >
            QUEUED
          </span>
        )}
        {message.queued && onCancelQueued && (
          <button
            type="button"
            onClick={() => onCancelQueued(message.id)}
            className="display-font"
            title="Cancel this queued message"
            style={{
              fontSize: '10px',
              letterSpacing: '1.5px',
              padding: '1px 6px',
              border: '1px solid var(--color-accent-secondary-dim)',
              color: 'var(--color-accent-secondary-dim)',
              background: 'transparent',
              cursor: 'pointer',
              opacity: 0.75,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.75'; }}
          >
            CANCEL
          </button>
        )}
      </div>
      <div style={{ marginLeft: '4px' }}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            width: '100%',
            padding: '4px 10px',
            border: '1px solid var(--color-border-hairline)',
            borderLeft: '2px solid var(--color-accent-secondary-dim)',
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
              color: 'var(--color-accent-secondary)',
              fontSize: '10px',
              letterSpacing: '1px',
              minWidth: '110px',
            }}
          >
            LONG MESSAGE
          </span>
          <span style={{ opacity: 0.8 }}>
            {lineCount} lines · {charCount.toLocaleString()} chars · {expanded ? 'click to collapse' : 'click to expand'}
          </span>
        </button>
        {expanded && (
          <div
            style={{
              marginTop: '6px',
              padding: '8px 12px',
              borderLeft: '2px solid var(--color-accent-secondary)',
              color: 'var(--color-accent-secondary-dim)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '14px',
              lineHeight: '1.7',
            }}
          >
            {linkifyText(message.content)}
          </div>
        )}
        {hasAttachments && (
          <div
            style={{
              marginTop: '6px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}
          >
            {message.attachments!.map((p, i) => (
              <AttachmentPill key={i} path={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
