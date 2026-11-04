import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface Props {
  name: string;
  cwd: string;
  workflowId: string;
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; contents: string; bytes: number }
  | { kind: 'error'; message: string };

// Collapsed marker rendered inline where the orchestrator wrote
// [artifact:<name>] in its chat text. Click to fetch + expand the file
// contents from `<cwd>/.arco/workflows/<wfid>/artifacts/<name>`. First
// expand triggers the fetch; toggle is free thereafter.
export function ArtifactPill({ name, cwd, workflowId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<FetchState>({ kind: 'idle' });

  const onToggle = () => {
    if (!expanded && state.kind === 'idle') {
      setState({ kind: 'loading' });
      const url = `/api/workflows/artifact?path=${encodeURIComponent(cwd)}&workflowId=${encodeURIComponent(workflowId)}&name=${encodeURIComponent(name)}`;
      fetch(url)
        .then(async (r) => {
          if (r.ok) return r.json() as Promise<{ contents: string; bytes: number }>;
          const body = await r.json().catch(() => ({ error: r.statusText })) as { error?: string };
          throw new Error(body.error || `HTTP ${r.status}`);
        })
        .then((d) => setState({ kind: 'ok', contents: d.contents, bytes: d.bytes }))
        .catch((err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
    }
    setExpanded((v) => !v);
  };

  return (
    <span style={{ display: 'inline-block', verticalAlign: 'baseline' }}>
      <button
        type="button"
        onClick={onToggle}
        className="display-font"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '1px 8px',
          background: 'var(--color-bg-sunken)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '3px',
          color: 'var(--color-accent-secondary)',
          fontSize: '11px',
          letterSpacing: '0.5px',
          cursor: 'pointer',
          fontFamily: 'var(--font-display)',
        }}
      >
        <span style={{ color: 'var(--color-accent-primary-dim)' }}>{expanded ? '▼' : '▶'}</span>
        <span>ARTIFACT</span>
        <span style={{ color: 'var(--color-fg)', fontFamily: 'var(--font-mono)', textTransform: 'none', letterSpacing: 0 }}>
          {name}
        </span>
        {state.kind === 'ok' && (
          <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
            {formatBytes(state.bytes)}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className="arco-markdown"
          style={{
            display: 'block',
            marginTop: '6px',
            marginBottom: '6px',
            padding: '10px 14px',
            border: '1px solid var(--color-border-hairline)',
            borderLeft: '2px solid var(--color-accent-secondary)',
            borderRadius: '3px',
            background: 'var(--color-bg-sunken)',
            fontSize: '13px',
            lineHeight: 1.6,
          }}
        >
          {state.kind === 'loading' && (
            <div style={{ color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>loading…</div>
          )}
          {state.kind === 'error' && (
            <div style={{ color: 'var(--color-accent-error, #ff6b6b)' }}>
              Error: {state.message}
            </div>
          )}
          {state.kind === 'ok' && (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {state.contents}
            </ReactMarkdown>
          )}
        </div>
      )}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
