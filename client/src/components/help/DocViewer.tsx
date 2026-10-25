import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useAppStore } from '../../stores/appStore';
import { Panel } from '../primitives/Panel';

// In-app file viewer for repo-relative paths. Hits /api/docs?file=… (which
// reads from PROJECT_ROOT, whitelisted by extension) and renders the
// content. Markdown gets the full ReactMarkdown pipeline; everything else
// is wrapped in a fenced code block so rehype-highlight does the
// syntax-highlighting.
//
// Stacks above the Manual modal (z=9300) so it can sit on top while leaving
// the Manual visible behind. Click another <DocRef> from inside this modal
// and the path swaps in place — no nested stack.
//
// Escape closes only this modal (Manual's escape handler stays parked at
// window-level; ours runs first via useEffect order).

const MD_EXTS = new Set(['.md', '.markdown']);

function languageHintForExt(ext: string): string {
  switch (ext) {
    case '.ts': return 'ts';
    case '.tsx': return 'tsx';
    case '.js': return 'js';
    case '.jsx': return 'jsx';
    case '.json': return 'json';
    case '.css': return 'css';
    case '.html': return 'html';
    case '.sh': return 'bash';
    case '.yml':
    case '.yaml': return 'yaml';
    case '.toml': return 'toml';
    default: return '';
  }
}

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

export function DocViewer() {
  const activeDocRef = useAppStore((s) => s.activeDocRef);
  const setActiveDocRef = useAppStore((s) => s.setActiveDocRef);
  const path = activeDocRef?.path ?? null;

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset + fetch on every path change. AbortController makes a stale
  // response from a previous path stop resolving once the operator clicks
  // another DocRef.
  useEffect(() => {
    if (!path) return;
    setContent(null);
    setError(null);
    setLoading(true);
    const ctrl = new AbortController();
    fetch(`/api/docs?file=${encodeURIComponent(path)}`, { signal: ctrl.signal })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ctrl.signal.aborted) return;
        if (!ok) {
          setError(d.error ?? 'Failed to load');
          setContent(null);
        } else {
          setContent(d.content as string);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    // Snap to top on each new path so swap-in-place doesn't preserve a
    // misleading scroll position from the previous file.
    scrollRef.current?.scrollTo({ top: 0 });
    return () => ctrl.abort();
  }, [path]);

  // Escape closes this modal only — stop propagation so the underlying
  // Manual's window-level Escape doesn't also fire.
  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setActiveDocRef(null);
    };
    // capture-phase so we beat the Manual's window-level keydown handler
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [path, setActiveDocRef]);

  if (!path) return null;

  const ext = extOf(path);
  const isMarkdown = MD_EXTS.has(ext);
  const lang = languageHintForExt(ext);

  return (
    <div
      onClick={() => setActiveDocRef(null)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9520,
        padding: '20px',
      }}
    >
      <Panel
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '960px',
          height: 'calc(100vh - 60px)',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
            <span
              className="display-font"
              style={{
                fontSize: '10px',
                letterSpacing: '2px',
                color: 'var(--color-fg-muted)',
                flexShrink: 0,
              }}
            >
              FILE
            </span>
            <span
              style={{
                fontFamily: 'var(--font-code, monospace)',
                fontSize: '12px',
                color: 'var(--color-accent-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={path}
            >
              {path}
            </span>
            {loading && (
              <span
                className="display-font"
                style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}
              >
                LOADING…
              </span>
            )}
          </div>
          <button
            onClick={() => setActiveDocRef(null)}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '4px 10px',
              flexShrink: 0,
            }}
          >
            CLOSE ✕
          </button>
        </div>

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 24px 32px',
            fontFamily: 'var(--font-body)',
            fontSize: '13px',
            lineHeight: 1.6,
            color: 'var(--color-fg)',
          }}
        >
          {error && (
            <div
              style={{
                padding: '10px 12px',
                border: '1px solid var(--color-warning)',
                borderLeft: '3px solid var(--color-warning)',
                borderRadius: '3px',
                color: 'var(--color-warning)',
                fontFamily: 'var(--font-body)',
                fontSize: '12px',
              }}
            >
              <strong>Failed to load.</strong> {error}
            </div>
          )}
          {!error && content !== null && (
            isMarkdown ? (
              <div className="archon-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="archon-markdown">
                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                  {'```' + lang + '\n' + content + '\n```'}
                </ReactMarkdown>
              </div>
            )
          )}
        </div>
      </Panel>
    </div>
  );
}
