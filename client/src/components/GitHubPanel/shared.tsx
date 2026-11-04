import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import type { GhComment, GhWorkflowRun } from './types';

// ── Polling helper ──────────────────────────────────────────────────────
// Fires `fn` every `intervalMs` while enabled and the document is visible.
// Pauses on visibilitychange; resumes on visible. Skips the initial tick
// (caller is expected to have loaded on mount).
export function useVisiblePolling(enabled: boolean, intervalMs: number, fn: () => void) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => fnRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    const onVis = () => { document.hidden ? stop() : start(); };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled, intervalMs]);
}

// ── Status / empty / error presentational helpers ───────────────────────

export function Loading() {
  return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '2px' }}>LOADING...</div>;
}
export function ErrorBox({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div style={{ padding: '14px 20px', border: '1px solid var(--color-danger)', borderRadius: '4px', background: 'rgba(255, 80, 80, 0.05)', color: 'var(--color-danger)', fontFamily: 'var(--font-body)', fontSize: '12px', margin: '12px 20px' }}>
      {message}
      {onDismiss && <div style={{ marginTop: '8px' }}><button onClick={onDismiss} style={mergeBtnStyle}>BACK</button></div>}
    </div>
  );
}
export function EmptyBox({ label }: { label: string }) {
  return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', letterSpacing: '1.5px' }}>{label}</div>;
}

export function StateTabs({ value, onChange }: { value: 'open' | 'closed' | 'all'; onChange: (v: 'open' | 'closed' | 'all') => void }) {
  return (
    <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
      {(['open', 'closed', 'all'] as const).map((v) => (
        <button key={v} onClick={() => onChange(v)} style={selectChip(value === v)}>{v.toUpperCase()}</button>
      ))}
    </div>
  );
}

export function InlineStatus({ status, onDismiss }: { status: { kind: 'ok' | 'error'; message: string } | null; onDismiss: () => void }) {
  if (!status) return null;
  return (
    <div style={{
      padding: '8px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0,
      background: status.kind === 'ok' ? 'var(--color-accent-primary-a06)' : 'rgba(255, 80, 80, 0.06)',
      color: status.kind === 'ok' ? 'var(--color-accent-primary)' : 'var(--color-danger)',
      fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '0.5px',
      display: 'flex', alignItems: 'center', gap: '8px',
    }}>
      <span>{status.kind === 'ok' ? '✓' : '✗'}</span>
      <span style={{ flex: 1 }}>{status.message}</span>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.6, fontSize: '12px' }}>×</button>
    </div>
  );
}

export function CommentsView({ comments }: { comments: GhComment[] | null }) {
  if (comments === null) return <Loading />;
  if (comments.length === 0) return <EmptyBox label="No comments yet." />;
  return (
    <div>
      {comments.map((c) => (
        <div key={c.id} style={{ borderBottom: '1px solid var(--color-border-hairline)', padding: '10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <img src={c.user.avatar_url} alt={c.user.login} style={{ width: '20px', height: '20px', borderRadius: '50%' }} />
            <span style={{ color: 'var(--color-accent-secondary)', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{c.user.login}</span>
            <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>· {fmtDate(c.created_at)}</span>
          </div>
          <Markdown value={c.body} />
        </div>
      ))}
    </div>
  );
}

// ── Markdown ────────────────────────────────────────────────────────────

// slug matches GitHub's heading-id algorithm closely enough for most READMEs:
// lowercase, strip punctuation (but keep alnum + dashes), replace spaces with
// dashes. Handles headings that end up with identical slugs by tracking a
// per-render counter and appending -1, -2, etc.
function slugify(s: string): string {
  return s
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function renderChildrenToString(children: React.ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(renderChildrenToString).join('');
  // React element — pull out props.children recursively
  if (typeof children === 'object' && children !== null && 'props' in children) {
    return renderChildrenToString((children as { props?: { children?: React.ReactNode } }).props?.children ?? '');
  }
  return '';
}

interface MarkdownProps {
  value: string;
  // Click handler for internal, relative links. If provided, clicking
  // `[docs](./reports/thing.md)` calls this with 'reports/thing.md' (normalized
  // against basePath). Falls back to open-in-new-tab via the GH url if omitted.
  onOpenRelative?: (path: string) => void;
  // Current path inside the repo (for resolving relative links). Empty means
  // repo root; 'src/foo' means links resolve from there.
  basePath?: string;
  // GitHub base URL + ref — used to build fallback URLs for relatives when no
  // onOpenRelative handler is provided, and for external opens.
  ghBlobBase?: string; // e.g. https://github.com/owner/repo/blob/main
  ghRawBase?: string;  // e.g. https://raw.githubusercontent.com/owner/repo/main
}

export function Markdown({ value, onOpenRelative, basePath, ghBlobBase, ghRawBase }: MarkdownProps) {
  // Per-render counter to resolve duplicate slugs within a single document.
  const slugCounts = new Map<string, number>();
  const mkHeading = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
    ({ children, ...rest }: { children?: React.ReactNode }) => {
      const text = renderChildrenToString(children);
      const base = slugify(text) || `h${level}`;
      const n = slugCounts.get(base) ?? 0;
      slugCounts.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag id={id} {...rest}>{children}</Tag>;
    };

  const resolveRelative = (href: string): string => {
    if (!basePath) return href;
    // Handle ./foo, foo, ../foo
    const parts = (basePath.split('/').filter(Boolean));
    const hrefParts = href.split('/').filter(Boolean);
    for (const p of hrefParts) {
      if (p === '..') parts.pop();
      else if (p === '.') { /* no-op */ }
      else parts.push(p);
    }
    return parts.join('/');
  };

  const renderAnchor = ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => {
    if (!href) return <a {...rest}>{children}</a>;
    // Anchor within the same document
    if (href.startsWith('#')) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            const id = decodeURIComponent(href.slice(1));
            // Scope to the nearest .arco-markdown container so we don't
            // collide with ids elsewhere on the page.
            const root = (e.currentTarget as HTMLElement).closest('.arco-markdown') ?? document;
            const el = (root as HTMLElement).querySelector ? (root as Element).querySelector('#' + CSS.escape(id)) : null;
            (el as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }
    // External: open in new tab. mailto: also gets safe rel attrs.
    if (/^(https?:|mailto:)/i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      );
    }
    // Relative — prefer the in-panel file viewer for .md / other text files
    // when a handler is wired. Fall back to opening on GitHub otherwise.
    const cleanHref = href.replace(/^\.\//, '');
    const resolved = resolveRelative(cleanHref);
    if (onOpenRelative) {
      return (
        <a
          href={ghBlobBase ? `${ghBlobBase}/${resolved}` : href}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let modifier-clicks open externally
            e.preventDefault();
            onOpenRelative(resolved);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }
    const fallback = ghBlobBase ? `${ghBlobBase}/${resolved}` : href;
    return (
      <a href={fallback} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  };

  const renderImage = ({ src, alt, ...rest }: { src?: string; alt?: string }) => {
    if (!src) return <img src="" alt={alt ?? ''} {...rest} />;
    // Absolute URLs pass through
    if (/^https?:\/\//i.test(src)) return <img src={src} alt={alt ?? ''} style={{ maxWidth: '100%' }} {...rest} />;
    if (!ghRawBase) return <img src={src} alt={alt ?? ''} style={{ maxWidth: '100%' }} {...rest} />;
    const cleanSrc = src.replace(/^\.\//, '');
    const resolved = resolveRelative(cleanSrc);
    return <img src={`${ghRawBase}/${resolved}`} alt={alt ?? ''} style={{ maxWidth: '100%' }} {...rest} />;
  };

  return (
    <div className="arco-markdown" style={{ fontFamily: 'var(--font-body)', fontSize: '13px', lineHeight: 1.55, color: 'var(--color-accent-primary-dim)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: renderAnchor as never,
          img: renderImage as never,
          h1: mkHeading(1) as never,
          h2: mkHeading(2) as never,
          h3: mkHeading(3) as never,
          h4: mkHeading(4) as never,
          h5: mkHeading(5) as never,
          h6: mkHeading(6) as never,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

// ── Formatting helpers ──────────────────────────────────────────────────

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function detectLang(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', json: 'json',
    xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less', sql: 'sql',
    md: 'md', markdown: 'md', mdx: 'md',
    diff: 'diff', patch: 'diff',
  };
  return map[ext] || 'text';
}

export function fileStatusColor(status: string): string {
  if (status === 'added') return 'var(--color-accent-primary)';
  if (status === 'removed') return 'var(--color-danger)';
  if (status === 'modified') return 'var(--color-accent-secondary)';
  if (status === 'renamed') return 'var(--color-warning)';
  return 'var(--color-accent-primary-dim)';
}

// ── Style helpers ───────────────────────────────────────────────────────

export const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: '12px',
  outline: 'none',
};
export const closeButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg-muted)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1px',
};
export const mergeBtnStyle: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--color-accent-primary-a08)',
  border: '1px solid var(--color-accent-primary-dim)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  fontFamily: 'var(--font-display)',
  fontSize: '10px',
  letterSpacing: '1.5px',
};

export function selectChip(active: boolean, tabStyle: boolean = false): React.CSSProperties {
  return {
    padding: tabStyle ? '6px 14px' : '3px 10px',
    background: active ? 'var(--color-accent-secondary-a12)' : 'transparent',
    border: `1px solid ${active ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
    borderRadius: '3px',
    color: active ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)',
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: tabStyle ? '11px' : '10px',
    letterSpacing: '1.5px',
  };
}

export const rowStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  marginBottom: '6px',
  background: 'rgba(0, 12, 6, 0.4)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '4px',
  color: 'var(--color-accent-primary)',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'var(--font-body)',
};
export const repoRowStyle: React.CSSProperties = {
  ...rowStyle,
  marginBottom: '8px',
};

export function badgeStyle(tone: 'amber' | 'red' | 'dim'): React.CSSProperties {
  const map = { amber: 'var(--color-warning)', red: 'var(--color-danger)', dim: 'var(--color-fg-muted)' } as const;
  const color = map[tone];
  return {
    fontSize: '8px',
    letterSpacing: '1px',
    fontFamily: 'var(--font-display)',
    padding: '1px 4px',
    border: `1px solid ${color}`,
    borderRadius: '2px',
    color,
  };
}

export function prStateChip(p: { state: string; draft?: boolean; merged_at?: string | null; merged?: boolean }): React.CSSProperties {
  const merged = p.merged ?? Boolean(p.merged_at);
  const color = merged ? '#a080ff' : p.state === 'closed' ? 'var(--color-danger)' : p.draft ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)';
  return chipStyle(color);
}
export function issueStateChip(i: { state: string }): React.CSSProperties {
  const color = i.state === 'closed' ? 'var(--color-danger)' : 'var(--color-accent-primary)';
  return chipStyle(color);
}
export function runStateChip(r: { status: string; conclusion: string | null }): React.CSSProperties {
  const c = r.conclusion;
  const color =
    c === 'success' ? 'var(--color-accent-primary)' :
    c === 'failure' || c === 'cancelled' || c === 'timed_out' ? 'var(--color-danger)' :
    c === 'skipped' || c === 'neutral' ? 'var(--color-fg-muted)' :
    r.status === 'in_progress' ? 'var(--color-warning)' :
    'var(--color-accent-secondary-dim)';
  return chipStyle(color);
}
export function checkStateChip(c: { status: string; conclusion: string | null }): React.CSSProperties {
  return runStateChip(c as GhWorkflowRun);
}
export function chipStyle(color: string): React.CSSProperties {
  return {
    fontSize: '9px',
    letterSpacing: '1px',
    fontFamily: 'var(--font-display)',
    padding: '2px 6px',
    border: `1px solid ${color}`,
    borderRadius: '2px',
    color,
    whiteSpace: 'nowrap',
  };
}
