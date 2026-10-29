import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';
import { useAppStore } from '../stores/appStore';
import { formatModelLabel, totalTokens } from '../utils/format';
import { TokenBadge } from './TokenBadge';
import type { WorkerState } from '@arco/shared';

// Click a WorkerCard to inspect it here. Live-updates from the store while the
// worker streams. Esc / X / backdrop closes. Mounted at App level next to
// ArtifactModal so it sits on top of everything.
export function WorkerDetailModal() {
  const target = useAppStore((s) => s.detailWorker);
  const close = useAppStore((s) => s.setDetailWorker);
  const worker = useAppStore((s) =>
    target ? s.jobs[target.jobId]?.workers[target.workerId] : undefined,
  );

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, close]);

  // Worker disappeared (workflow removed mid-modal). Auto-dismiss.
  useEffect(() => {
    if (target && !worker) close(null);
  }, [target, worker, close]);

  if (!target || !worker) return null;
  return <WorkerDetailBody worker={worker} onClose={() => close(null)} />;
}

function WorkerDetailBody({ worker, onClose }: { worker: WorkerState; onClose: () => void }) {
  const [showThinking, setShowThinking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const autoCompactThreshold: number | undefined = undefined;

  useEffect(() => {
    if (worker.status !== 'running' && worker.status !== 'spawning') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [worker.status]);

  const statusLabel = {
    spawning: 'SPAWNING',
    running: 'RUNNING',
    completed: 'DONE',
    failed: 'FAILED',
  }[worker.status];

  const duration = worker.durationMs !== undefined
    ? worker.durationMs
    : worker.spawnedAt ? now - worker.spawnedAt : 0;

  const isActive = worker.status === 'running' || worker.status === 'spawning';
  const denials = worker.permissionDenials ?? [];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(3px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{
          // Frosted token so frosted mode + the opacity slider reach this modal.
          background: 'var(--color-bg-elevated)',
          border: `1px solid ${isActive ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)'}`,
          borderRadius: '6px',
          width: 'min(960px, calc(94vw / var(--ui-scale, 1)))',
          maxHeight: 'calc(90vh / var(--ui-scale, 1))',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 0 36px var(--color-accent-secondary-a25)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-border-hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontFamily: 'var(--font-display)',
            fontSize: '11px',
            letterSpacing: '1.5px',
          }}
        >
          <span className={`status-dot status-dot--${worker.status}${isActive && worker.activity?.cpuActive ? ' status-dot--cpu-active' : ''}`} />
          <span className="glow-text" style={{ color: 'var(--color-accent-primary)', fontSize: '13px' }}>
            {worker.id.toUpperCase()}
          </span>
          <span style={{ color: 'var(--color-fg-muted)' }}>
            {formatModelLabel(worker.model, worker.resolvedModel)}
          </span>
          {worker.provider && worker.provider !== 'claude' && (
            <span
              style={{
                fontSize: '8px',
                letterSpacing: '1px',
                color: worker.provider === 'ollama' ? 'var(--color-warning)'
                  : worker.provider === 'llamacpp' ? 'var(--color-danger, #f04a4a)'
                  : worker.provider === 'codex' ? 'var(--color-accent-primary)'
                  : 'var(--color-accent-secondary)',
                border: `1px solid ${worker.provider === 'ollama' ? 'var(--color-warning)'
                  : worker.provider === 'llamacpp' ? 'var(--color-danger, #f04a4a)'
                  : worker.provider === 'codex' ? 'var(--color-accent-primary)'
                  : 'var(--color-accent-secondary-dim)'}`,
                borderRadius: '2px',
                padding: '0 4px',
              }}
            >
              {worker.provider === 'codex' ? 'CODEX · OPENAI'
                : worker.provider === 'llamacpp' ? 'LLAMA.CPP · LOCAL'
                : 'OLLAMA · LOCAL'}
            </span>
          )}
          <span style={{ color: 'var(--color-fg-muted)' }}>·</span>
          <span style={{ color: isActive ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)' }}>
            {statusLabel}
          </span>
          {duration > 0 && (
            <>
              <span style={{ color: 'var(--color-fg-muted)' }}>·</span>
              <span style={{ color: 'var(--color-fg-muted)' }}>{formatDuration(duration)}</span>
            </>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              background: 'none',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '0 8px',
              lineHeight: '22px',
            }}
          >
            ×
          </button>
        </div>

        {/* Scroll body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Task */}
          <Section title="TASK">
            <div
              style={{
                padding: '8px 14px 12px',
                fontSize: '13px',
                lineHeight: 1.55,
                color: 'var(--color-accent-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {worker.task}
            </div>
          </Section>

          {denials.length > 0 && (
            <Section title={`⛔ BLOCKED BY SAFE MODE (${denials.length})`} accent="amber">
              <div style={{ padding: '4px 0' }}>
                {denials.map((d, i) => (
                  <div key={i} style={detailRowStyle}>
                    <span style={{ minWidth: '60px', color: 'var(--color-warning)' }}>{d.tool}</span>
                    <span style={{ color: 'var(--color-fg-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                      {d.input}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {worker.toolCalls.length > 0 && (
            <Section title={`TOOLS (${worker.toolCalls.length})`}>
              <div style={{ padding: '4px 0' }}>
                {worker.toolCalls.map((call, i) => (
                  <ToolCallRow key={i} tool={call.tool} input={call.input} />
                ))}
              </div>
            </Section>
          )}

          {worker.thinking && (
            <Section title={`THINKING ${showThinking ? '▼' : '▶'}`} onTitleClick={() => setShowThinking((v) => !v)}>
              {showThinking && (
                <div
                  style={{
                    padding: '8px 14px 14px',
                    fontSize: '12px',
                    color: 'var(--color-fg-muted)',
                    fontStyle: 'italic',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {worker.thinking}
                </div>
              )}
            </Section>
          )}

          <Section title="OUTPUT">
            <div
              className="arco-markdown"
              style={{
                padding: '10px 14px 14px',
                fontSize: '13px',
                lineHeight: 1.6,
                color: 'var(--color-accent-primary)',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-body)',
              }}
            >
              {worker.output ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {worker.output}
                </ReactMarkdown>
              ) : isActive ? (
                <ProcessHint worker={worker} />
              ) : (
                <span style={{ color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
                  No output
                </span>
              )}
              {worker.status === 'running' && worker.output && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '12px',
                    background: 'var(--color-accent-primary)',
                    marginLeft: '2px',
                    verticalAlign: 'text-bottom',
                    animation: 'cursor-blink 1s step-end infinite',
                  }}
                />
              )}
            </div>
          </Section>
        </div>

        {/* Footer stats */}
        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--color-border-hairline)',
            display: 'flex',
            gap: '14px',
            alignItems: 'center',
            fontFamily: 'var(--font-display)',
            fontSize: '10px',
            letterSpacing: '1.2px',
            color: 'var(--color-fg-muted)',
            background: 'rgba(0, 0, 0, 0.3)',
          }}
        >
          <span>{worker.toolCalls.length} TOOL{worker.toolCalls.length === 1 ? '' : 'S'}</span>
          {denials.length > 0 && (
            <span style={{ color: 'var(--color-warning)' }}>{denials.length} DENIED</span>
          )}
          {worker.tokens && totalTokens(worker.tokens, worker.provider) > 0 && (
            <TokenBadge
              turnTokens={worker.tokens}
              threshold={autoCompactThreshold}
              provider={worker.provider}
              showBar
              style={{ fontSize: '10px', letterSpacing: '1.2px', minWidth: '120px' }}
            />
          )}
          {duration > 0 && <span>{formatDuration(duration)}</span>}
          {isActive && worker.activity && (
            <>
              {worker.activity.descendantCount > 0 && (
                <span style={{ color: 'var(--color-accent-secondary)' }}>
                  ▶{worker.activity.descendantCount} PROC
                </span>
              )}
              {worker.activity.rssBytes > 0 && (
                <span title={`${worker.activity.rssBytes.toLocaleString()} bytes RSS`}>
                  {formatBytes(worker.activity.rssBytes)}
                </span>
              )}
              <span style={{ color: worker.activity.cpuActive ? 'var(--color-accent-secondary)' : 'var(--color-fg-muted)' }}>
                {worker.activity.cpuActive ? 'CPU●' : 'CPU○'}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

function ProcessHint({ worker }: { worker: WorkerState }) {
  const a = worker.activity;
  const baseStyle: React.CSSProperties = { color: 'var(--color-fg-muted)', fontStyle: 'italic', fontFamily: 'var(--font-body)' };
  if (!a) {
    return <span style={baseStyle}>Waiting for output…</span>;
  }
  if (!a.alive) {
    return <span style={{ ...baseStyle, color: 'var(--color-danger)' }}>Process exited (no output yet).</span>;
  }
  if (a.descendantCount > 0) {
    const noun = a.descendantCount === 1 ? 'subprocess' : 'subprocesses';
    return (
      <div style={baseStyle}>
        Worker is executing — {a.descendantCount} {noun} running.{' '}
        <span style={{ color: 'var(--color-accent-secondary-dim)' }}>
          Output will appear when the current tool finishes.
        </span>
      </div>
    );
  }
  if (a.cpuActive) {
    return (
      <div style={baseStyle}>
        Worker is processing —{' '}
        <span style={{ color: 'var(--color-accent-secondary-dim)' }}>
          CPU active. Output will appear when the model emits an event.
        </span>
      </div>
    );
  }
  return (
    <div style={baseStyle}>
      Worker is alive but quiet — likely{' '}
      <span style={{ color: 'var(--color-warning-dim)' }}>
        waiting on the model API
      </span>{' '}
      (common between tool calls).
    </div>
  );
}

function Section({
  title,
  accent,
  onTitleClick,
  children,
}: {
  title: string;
  accent?: 'amber';
  onTitleClick?: () => void;
  children: React.ReactNode;
}) {
  const titleColor = accent === 'amber' ? 'var(--color-warning)' : 'var(--color-accent-primary-dim)';
  return (
    <div style={{ borderBottom: '1px solid var(--color-border-hairline)' }}>
      {onTitleClick ? (
        <button
          onClick={onTitleClick}
          style={{
            ...sectionHeaderStyle,
            color: titleColor,
            background: 'var(--color-accent-primary-a04)',
            border: 'none',
            width: '100%',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {title}
        </button>
      ) : (
        <div style={{ ...sectionHeaderStyle, color: titleColor, background: 'var(--color-accent-primary-a04)' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: '10px',
  fontFamily: 'var(--font-display)',
  letterSpacing: '1.5px',
};

const detailRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '10px',
  padding: '4px 14px',
  fontSize: '12px',
  lineHeight: 1.5,
  fontFamily: 'var(--font-body)',
  borderBottom: '1px solid var(--color-accent-primary-a05)',
};

// One row per tool call. Shows a terse one-line summary by default (e.g.
// "READ  server/src/index.ts"); clicking expands to the pretty-printed full
// JSON input. Handles legacy empty `{}` inputs gracefully too.
function ToolCallRow({ tool, input }: { tool: string; input: string }) {
  const [expanded, setExpanded] = useState(false);
  const { summary, pretty, isEmpty } = parseToolInput(input);
  const canExpand = !isEmpty;
  return (
    <div
      style={{
        ...detailRowStyle,
        cursor: canExpand ? 'pointer' : 'default',
        flexDirection: 'column',
        gap: '4px',
      }}
      onClick={() => canExpand && setExpanded((v) => !v)}
    >
      <div style={{ display: 'flex', gap: '10px' }}>
        <span
          className="glow-text-cyan"
          style={{ minWidth: '60px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px', fontSize: '10px', flexShrink: 0 }}
        >
          {tool.toUpperCase()}
        </span>
        <span style={{ color: 'var(--color-accent-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, opacity: isEmpty ? 0.5 : 1 }}>
          {summary}
        </span>
        {canExpand && (
          <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px', fontFamily: 'var(--font-display)', flexShrink: 0 }}>
            {expanded ? '▼' : '▶'}
          </span>
        )}
      </div>
      {expanded && pretty && (
        <pre
          style={{
            margin: '4px 0 0 70px',
            padding: '8px 10px',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-accent-primary-a15)',
            borderRadius: '3px',
            fontSize: '11px',
            color: 'var(--color-accent-primary-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '400px',
            overflow: 'auto',
          }}
        >
          {pretty}
        </pre>
      )}
    </div>
  );
}

// Extract a one-line summary from a tool-call input JSON string. The summary
// picks the most useful field for the common Claude tool set (file_path,
// pattern, command, path, url). Falls back to the raw JSON truncated for
// unknown shapes. `isEmpty` flags the legacy `{}` case so the caller can
// suppress the expand affordance.
function parseToolInput(input: string): { summary: string; pretty: string | null; isEmpty: boolean } {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '{}') {
    return { summary: '(no input)', pretty: null, isEmpty: true };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const pretty = JSON.stringify(parsed, null, 2);
    // Pick a terse summary based on the most common fields across Claude's
    // tool set. Order matters — file_path (Read/Edit/Write) wins over
    // pattern (Grep) wins over command (Bash), etc.
    const fields = ['file_path', 'path', 'pattern', 'command', 'url', 'notebook_path', 'query'];
    for (const f of fields) {
      if (typeof parsed[f] === 'string' && parsed[f].length > 0) {
        const value = parsed[f] as string;
        // Add a second useful field as hint when present.
        let extra = '';
        if (f === 'pattern' && typeof parsed.path === 'string') extra = ` in ${parsed.path}`;
        if (f === 'file_path' && typeof parsed.old_string === 'string') {
          const snippet = (parsed.old_string as string).replace(/\s+/g, ' ').slice(0, 40);
          extra = snippet ? ` · "${snippet}${(parsed.old_string as string).length > 40 ? '…' : ''}"` : '';
        }
        return { summary: `${value}${extra}`, pretty, isEmpty: false };
      }
    }
    // No known field — show a compact rendering with key=value pairs.
    const keys = Object.keys(parsed);
    if (keys.length === 0) return { summary: '(empty object)', pretty, isEmpty: true };
    const firstPairs = keys.slice(0, 2).map((k) => {
      const v = parsed[k];
      const vs = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${vs.length > 30 ? vs.slice(0, 30) + '…' : vs}`;
    }).join(' · ');
    return { summary: firstPairs + (keys.length > 2 ? ` · +${keys.length - 2} more` : ''), pretty, isEmpty: false };
  } catch {
    // Not JSON — show raw, truncated.
    return { summary: trimmed.length > 80 ? trimmed.slice(0, 80) + '…' : trimmed, pretty: trimmed, isEmpty: false };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m${rem.toFixed(0)}s`;
}
