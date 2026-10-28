import { useEffect, useState } from 'react';
import type { WorkerState } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { Panel } from './primitives/Panel';
import { formatModelLabel, totalTokens } from '../utils/format';
import { TokenBadge } from './TokenBadge';

interface Props {
  jobId: string;
  worker: WorkerState;
}

// Compact at-a-glance row. Click the whole card to open the WorkerDetailModal
// with full tools log, thinking, and output. The card shows the active work
// (task, latest tool, stats) so operators don't need to open the modal for a
// quick peek.
export function WorkerCard({ jobId, worker }: Props) {
  const openDetail = useAppStore((s) => s.setDetailWorker);
  const autoCompactThreshold: number | undefined = undefined;
  const [now, setNow] = useState(Date.now());

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
  const isDone = worker.status === 'completed';
  const latestTool = worker.toolCalls.length > 0 ? worker.toolCalls[worker.toolCalls.length - 1] : null;
  // Time since the latest tool started — the most useful signal for "is this
  // tool still running" especially for Gemini workers, which don't stream
  // stdout while a shell command is executing.
  const latestToolElapsed = isActive && latestTool ? now - latestTool.timestamp : 0;
  const sinceLastEvent = isActive && worker.lastActivityAt ? now - worker.lastActivityAt : 0;

  return (
    <Panel
      as="button"
      active={isActive}
      onClick={() => openDetail({ jobId, workerId: worker.id })}
      data-help="activity.worker-card"
      title="Click for full worker detail"
      className={isActive ? 'arco-scan-host' : undefined}
      style={{
        all: 'unset',
        cursor: 'pointer',
        border: `1px solid ${isActive ? 'var(--color-accent-secondary-dim)' : 'var(--color-border-hairline)'}`,
        borderRadius: '4px',
        background: 'var(--color-bg-sunken)',
        overflow: 'hidden',
        opacity: isDone ? 0.72 : 1,
        transition: 'opacity 0.2s, border-color 0.2s, background 0.2s',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-body)',
        textAlign: 'left',
        width: '100%',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(0, 18, 10, 0.75)';
        e.currentTarget.style.borderColor = 'var(--color-accent-secondary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--color-bg-sunken)';
        e.currentTarget.style.borderColor = isActive ? 'var(--color-accent-secondary-dim)' : 'var(--color-border-hairline)';
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 8px',
          fontFamily: 'var(--font-display)',
          fontSize: '10px',
          letterSpacing: '0.8px',
          color: 'var(--color-accent-primary-dim)',
          borderBottom: '1px solid var(--color-border-hairline)',
        }}
      >
        <span className={`status-dot status-dot--${worker.status}${isActive && worker.activity?.cpuActive ? ' status-dot--cpu-active' : ''}`} />
        <span style={{ color: 'var(--color-accent-primary)', fontWeight: 500 }}>{worker.id}</span>
        <span style={{ color: 'var(--color-fg-muted)' }}>{formatModelLabel(worker.model, worker.resolvedModel)}</span>
        {worker.effort && (
          <span
            title={effortBadgeTitle(worker.effort, worker.provider)}
            style={{ color: effortBadgeColor(worker.effort), fontSize: '9px', letterSpacing: '0.5px' }}
          >
            ·{worker.effort.toUpperCase()}
          </span>
        )}
        {worker.provider && worker.provider !== 'claude' && (
          <span
            style={{
              fontSize: '8px',
              letterSpacing: '1px',
              color: providerBadgeColor(worker.provider),
              border: `1px solid ${providerBadgeColor(worker.provider)}`,
              borderRadius: '2px',
              padding: '0 3px',
            }}
            title={providerBadgeTitle(worker.provider)}
          >
            {providerBadgeChar(worker.provider)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: 'var(--color-fg-muted)', fontSize: '9px' }}>{statusLabel}</span>
        {duration > 0 && (
          <span style={{ color: 'var(--color-fg-muted)', fontSize: '9px' }}>{formatDuration(duration)}</span>
        )}
        {isActive && sinceLastEvent > 5000 && (
          <span
            title="Time since last event from the worker — high values mean a tool is running silently (common for Gemini shell commands)"
            style={{ color: sinceLastEvent > 30000 ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontSize: '9px' }}
          >
            · idle {formatShort(sinceLastEvent)}
          </span>
        )}
        <span
          title="Open detail"
          style={{ color: 'var(--color-accent-secondary-dim)', fontSize: '10px' }}
        >
          ↗
        </span>
      </div>

      {/* Compact body */}
      <div style={{ padding: '8px 10px', flex: 1 }}>
        <div
          style={{
            fontSize: '12px',
            color: 'var(--color-accent-primary-dim)',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {worker.task}
        </div>
        {latestTool && (
          <div
            style={{
              marginTop: '6px',
              padding: '3px 6px',
              background: 'var(--color-accent-secondary-a06)',
              border: '1px solid var(--color-accent-secondary-glow)',
              borderRadius: '2px',
              fontSize: '10px',
              display: 'flex',
              gap: '6px',
              overflow: 'hidden',
              alignItems: 'center',
            }}
            title={latestTool.input}
          >
            <span className="glow-text-cyan" style={{ color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px', fontSize: '9px', flexShrink: 0 }}>
              {isActive ? '● ' : ''}{latestTool.tool.toUpperCase()}
            </span>
            <span style={{ color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {truncate(latestTool.input, 100)}
            </span>
            {isActive && latestToolElapsed > 1000 && (
              <span
                title="How long this tool has been running"
                style={{ color: latestToolElapsed > 60000 ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontSize: '9px', fontFamily: 'var(--font-display)', flexShrink: 0 }}
              >
                {formatShort(latestToolElapsed)}
              </span>
            )}
          </div>
        )}
        {!latestTool && isActive && (
          <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--color-fg-muted)', fontStyle: 'italic' }}>
            Starting up…
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div
        style={{
          padding: '4px 8px',
          fontSize: '9px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
          color: 'var(--color-fg-muted)',
          background: 'rgba(0, 0, 0, 0.25)',
          borderTop: '1px solid var(--color-border-hairline)',
          display: 'flex',
          gap: '10px',
          alignItems: 'center',
        }}
      >
        {worker.toolCalls.length > 0 && (
          <span title={`${worker.toolCalls.length} tool call(s)`} className="glow-text-cyan" style={{ color: 'var(--color-accent-secondary-dim)' }}>
            ⚡{worker.toolCalls.length}
          </span>
        )}
        {isActive && worker.activity && worker.activity.descendantCount > 0 && (
          <span
            title={`${worker.activity.descendantCount} subprocess(es) running below this worker`}
            style={{ color: 'var(--color-accent-secondary)' }}
          >
            ▶{worker.activity.descendantCount}
          </span>
        )}
        {isActive && worker.activity && worker.activity.rssBytes > 1024 * 1024 * 1024 && (
          <span
            title={`Worker process tree is using ${worker.activity.rssBytes.toLocaleString()} bytes of RAM. Auto-kill threshold is 4GB.`}
            style={{ color: worker.activity.rssBytes > 3 * 1024 ** 3 ? 'var(--color-danger)' : 'var(--color-warning)' }}
          >
            ⚠{formatRss(worker.activity.rssBytes)}
          </span>
        )}
        {worker.permissionDenials && worker.permissionDenials.length > 0 && (
          <span title={`${worker.permissionDenials.length} denied by SAFE`} style={{ color: 'var(--color-warning)' }}>
            ⛔{worker.permissionDenials.length}
          </span>
        )}
        {worker.tokens && totalTokens(worker.tokens, worker.provider) > 0 && (
          <TokenBadge
            turnTokens={worker.tokens}
            threshold={autoCompactThreshold}
            provider={worker.provider}
            style={{ fontSize: '9px', letterSpacing: '0.8px' }}
          />
        )}
      </div>
    </Panel>
  );
}

function effortBadgeColor(e: WorkerState['effort']): string {
  switch (e) {
    // 'ultra' is Codex-only and sits above 'max' — give it the brightest badge
    // rather than letting it fall through to the muted default.
    case 'ultra': return 'var(--color-accent-secondary)';
    case 'max': return 'var(--color-accent-secondary)';
    case 'xhigh': return 'var(--color-accent-secondary-dim)';
    case 'high': return 'var(--color-accent-primary-dim)';
    case 'medium': return 'var(--color-fg-muted)';
    case 'low': return 'var(--color-warning)';
    default: return 'var(--color-fg-muted)';
  }
}

function effortBadgeTitle(e: WorkerState['effort'], p: WorkerState['provider']): string {
  if (p === 'gemini') return `effort=${e} (ignored — Gemini CLI has no effort knob)`;
  // Codex used to top out at 'xhigh'. Since GPT-6 Astra (2026-09-03) it accepts
  // 'max' and 'ultra' too, and the effort is clamped per-model against the live
  // catalog rather than collapsed by a blanket rule — so don't claim a fixed
  // downgrade here.
  if (p === 'codex' && e === 'ultra') {
    return `effort=${e} (Codex: maximum reasoning with automatic task delegation; clamped down on models that don't support it)`;
  }
  if (p === 'codex' && (e === 'xhigh' || e === 'max')) {
    return `effort=${e} (clamped to the highest effort this Codex model supports)`;
  }

  if (p === 'ollama' || p === 'llamacpp') return `effort=${e} (local thinking toggle)`;
  return `effort=${e}`;
}

function providerBadgeChar(p: WorkerState['provider']): string {
  switch (p) {
    case 'gemini': return 'G';
    case 'codex': return 'C';
    case 'cursor': return 'R';
    case 'ollama': return 'O';
    case 'llamacpp': return 'L';
    default: return '?';
  }
}

function providerBadgeTitle(p: WorkerState['provider']): string {
  switch (p) {
    case 'gemini': return 'Gemini';
    case 'codex': return 'Codex (OpenAI)';
    case 'cursor': return 'Cursor (ACP · ~153 models)';
    case 'ollama': return 'Ollama (local)';
    case 'llamacpp': return 'llama.cpp (local)';
    default: return String(p);
  }
}

function providerBadgeColor(p: WorkerState['provider']): string {
  switch (p) {
    case 'gemini': return 'var(--color-accent-secondary)';
    case 'codex': return 'var(--color-accent-primary)';
    case 'cursor': return '#6cc6d6';
    case 'ollama': return 'var(--color-warning)';
    // llama.cpp shares the local-tier signal but uses the danger hue so a
    // worker badge tells the operator at a glance "this is the other local
    // backend" rather than blending into Ollama orange.
    case 'llamacpp': return 'var(--color-danger, #f04a4a)';
    default: return 'var(--color-fg-muted)';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m${rem.toFixed(0)}s`;
}

// Compact RAM/disk form for the MEM warning chip. Always shows enough
// precision to communicate "this is large".
function formatRss(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)}MB`;
}

// Compact form for tight inline spaces: "5s" / "1m20s" / "3m" — no decimals.
function formatShort(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}
