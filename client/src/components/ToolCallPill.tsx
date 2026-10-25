import React, { useMemo, useState } from 'react';
import { FileViewerModal } from './FileViewerModal';

interface Props {
  tool: string;
  input: unknown;
  filePath?: string;
  // EFFICIENCY_PLAN.md Phase C — when present, render a filter chip showing
  // the original→filtered byte counts and the pack name. `rawArtifactPath`
  // (workspace-relative) opens the gzipped raw output for operator recovery.
  filtered?: {
    filterName: string;
    originalBytes: number;
    filteredBytes: number;
    rawArtifactPath?: string;
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// Build a one-line human summary of the tool input. Falls back to the first
// JSON fragment for tools we don't special-case. Kept short (<= 90 chars)
// because the pill renders on a single row; click to expand for the full
// payload.
function summarizeInput(tool: string, input: unknown, filePath: string | undefined): string {
  if (filePath) return shortenPath(filePath);
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  if (tool === 'Bash') {
    const desc = typeof rec.description === 'string' ? rec.description : '';
    const cmd = typeof rec.command === 'string' ? rec.command : '';
    return desc || oneLine(cmd, 90);
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const pat = typeof rec.pattern === 'string' ? rec.pattern : '';
    const where = typeof rec.path === 'string' ? ` in ${shortenPath(rec.path)}` : '';
    return pat ? `${pat}${where}` : '';
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    const url = typeof rec.url === 'string' ? rec.url : typeof rec.query === 'string' ? rec.query : '';
    return oneLine(url, 90);
  }
  if (tool === 'TodoWrite') {
    const todos = Array.isArray(rec.todos) ? rec.todos : [];
    return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
  }
  // Unknown tool — print the first string-valued field we find.
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v.length > 0) return `${k}=${oneLine(v, 70)}`;
  }
  return '';
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function shortenPath(p: string): string {
  // Strip the home prefix so chat rows don't waste space on /home/<user>/...
  // (Linux), /Users/<user>/... (macOS) or C:\\Users\\<user>\\... (Windows).
  const home = /^(?:\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]/.exec(p);
  return home ? '~/' + p.slice(home[0].length) : p;
}

export function ToolCallPill({ tool, input, filePath, filtered }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const summary = summarizeInput(tool, input, filePath);
  const clickable = Boolean(filePath);

  const prettyInput = useMemo(() => {
    if (!expanded) return '';
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [expanded, input]);

  return (
    <div data-help="chat.tool-pill" style={{ marginBottom: '6px', marginLeft: '4px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '4px 10px',
          border: '1px solid var(--color-border-hairline)',
          borderLeft: '2px solid var(--color-accent-primary-dim)',
          borderRadius: '3px',
          fontSize: '12px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg-muted)',
          background: 'transparent',
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
            color: 'var(--color-accent-primary)',
            fontSize: '10px',
            letterSpacing: '1px',
            minWidth: '56px',
          }}
        >
          {tool.toUpperCase()}
        </span>
        {clickable ? (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            title={filePath}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-accent-secondary-dim)',
              cursor: 'pointer',
              padding: 0,
              fontSize: '12px',
              fontFamily: 'var(--font-body)',
              textAlign: 'left',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {summary}
          </button>
        ) : (
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
            title={summary}
          >
            {summary}
          </span>
        )}
        {filtered && filtered.originalBytes !== filtered.filteredBytes && (
          <FilteredChip filtered={filtered} />
        )}
      </div>
      {expanded && (
        <pre
          style={{
            marginTop: '4px',
            marginLeft: '20px',
            padding: '8px 12px',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
            lineHeight: '1.5',
            color: 'var(--color-fg-muted)',
            background: 'var(--color-bg-subtle, transparent)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '400px',
            overflow: 'auto',
          }}
        >
          {prettyInput}
        </pre>
      )}
      {viewerOpen && filePath && (
        <FileViewerModal path={filePath} onClose={() => setViewerOpen(false)} />
      )}
    </div>
  );
}

function FilteredChip({ filtered }: { filtered: NonNullable<Props['filtered']> }) {
  const { filterName, originalBytes, filteredBytes, rawArtifactPath } = filtered;
  const [copied, setCopied] = useState(false);
  const label = `filtered: ${formatBytes(originalBytes)} → ${formatBytes(filteredBytes)} · ${filterName}`;
  const tooltip = rawArtifactPath
    ? `Raw output gzipped to ${rawArtifactPath}\nClick to copy path. Recover with: zcat <path>`
    : `${filterName}: ${originalBytes} → ${filteredBytes} bytes`;
  const onClick = () => {
    if (!rawArtifactPath) return;
    navigator.clipboard?.writeText(rawArtifactPath).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
      () => { /* clipboard rejected — keep silent; tooltip still shows the path */ },
    );
  };
  const baseStyle: React.CSSProperties = {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '2px',
    border: '1px solid var(--color-border-hairline)',
    color: 'var(--color-fg-muted)',
    whiteSpace: 'nowrap',
    background: 'transparent',
  };
  if (rawArtifactPath) {
    return (
      <button type="button" onClick={onClick} title={tooltip} style={{ ...baseStyle, cursor: 'pointer' }}>
        {copied ? 'path copied' : label}
      </button>
    );
  }
  return <span title={tooltip} style={baseStyle}>{label}</span>;
}
