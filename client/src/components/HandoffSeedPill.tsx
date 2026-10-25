import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useOperatorLabel } from '../utils/operatorLabel';

// Server-side seed prompt from handleHandoffRequest in server/src/index.ts.
// Stable exact-prefix match — the string lives at one site and hasn't changed
// since Phase 4 of the Lite refactor.
const HANDOFF_SEED_PREFIX = '[HANDOFF — new session initialized for this tab.';

export function isHandoffSeed(content: string): boolean {
  return content.startsWith(HANDOFF_SEED_PREFIX);
}

interface Props {
  content: string;
}

export function HandoffSeedPill({ content }: Props) {
  const [expanded, setExpanded] = useState(false);
  const operatorLabel = useOperatorLabel();

  // Split the bracketed instruction header from the handoff body. Format:
  // `${prefix}...beginning any work.]\n\n${handoffBody}`.
  const splitIdx = content.indexOf(']\n\n');
  const header = splitIdx === -1 ? content : content.slice(0, splitIdx + 1);
  const body = splitIdx === -1 ? '' : content.slice(splitIdx + 3);
  const lineCount = body ? body.split('\n').length : 0;

  return (
    <div data-help="chat.seed-pill.handoff" style={{ marginBottom: '16px' }}>
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
            HANDOFF SEED
          </span>
          <span style={{ opacity: 0.8 }}>
            {lineCount > 0 ? `${lineCount} lines · ` : ''}
            {expanded ? 'click to collapse' : 'click to expand'}
          </span>
        </button>
        {expanded && (
          <div
            style={{
              marginTop: '6px',
              padding: '8px 12px',
              border: '1px solid var(--color-border-hairline)',
              borderLeft: '2px solid var(--color-accent-secondary)',
              borderRadius: '3px',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                fontStyle: 'italic',
                color: 'var(--color-fg-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                marginBottom: body ? '12px' : 0,
                paddingBottom: body ? '10px' : 0,
                borderBottom: body ? '1px solid var(--color-border-hairline)' : 'none',
              }}
            >
              {header}
            </div>
            {body && (
              <div
                className="archon-markdown"
                style={{
                  fontSize: '13px',
                  color: 'var(--color-accent-secondary-dim)',
                  lineHeight: '1.7',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    a: ({ node: _node, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                  }}
                >
                  {body}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
