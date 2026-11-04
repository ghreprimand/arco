import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useOperatorLabel } from '../utils/operatorLabel';

// Server-side spawn seed from handleSpawnFromHereRequest in server/src/index.ts
// has two shapes, both ending with a stable `\n\n---\n\n` separator + one of
// two instruction tails. Detecting on that suffix is more robust than a prefix
// match (the body is the handoff doc, which has no fixed header).
const NEW_DIRECTION_SEP = '\n\n---\n\nNew direction: ';
const READY_SEP = '\n\n---\n\nRead the handoff above. Acknowledge with "READY"';

export function isSpawnSeed(content: string): boolean {
  return content.includes(NEW_DIRECTION_SEP) || content.includes(READY_SEP);
}

function splitSpawnSeed(content: string): { body: string; footer: string } {
  const directionIdx = content.lastIndexOf(NEW_DIRECTION_SEP);
  if (directionIdx !== -1) {
    return {
      body: content.slice(0, directionIdx),
      footer: content.slice(directionIdx + '\n\n---\n\n'.length),
    };
  }
  const readyIdx = content.lastIndexOf(READY_SEP);
  if (readyIdx !== -1) {
    return {
      body: content.slice(0, readyIdx),
      footer: content.slice(readyIdx + '\n\n---\n\n'.length),
    };
  }
  return { body: content, footer: '' };
}

interface Props {
  content: string;
}

export function SpawnSeedPill({ content }: Props) {
  const [expanded, setExpanded] = useState(false);
  const operatorLabel = useOperatorLabel();
  const { body, footer } = splitSpawnSeed(content);
  const lineCount = body ? body.split('\n').length : 0;

  return (
    <div data-help="chat.seed-pill.spawn" style={{ marginBottom: '16px' }}>
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
            SPAWN SEED
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
            {body && (
              <div
                className="arco-markdown"
                style={{
                  fontSize: '13px',
                  color: 'var(--color-accent-secondary-dim)',
                  lineHeight: '1.7',
                  fontFamily: 'var(--font-body)',
                  marginBottom: footer ? '12px' : 0,
                  paddingBottom: footer ? '10px' : 0,
                  borderBottom: footer ? '1px solid var(--color-border-hairline)' : 'none',
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
            {footer && (
              <div
                style={{
                  fontSize: '12px',
                  fontStyle: 'italic',
                  color: 'var(--color-fg-muted)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {footer}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
