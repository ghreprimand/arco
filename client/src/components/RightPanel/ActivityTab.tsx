import { useState, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import type { JobState, ActivityEntry, HistoryEventEntry } from '../../stores/appStore';
import type { PrimaryBackgroundJob, PrimaryTurnTokenUsageMessage, DiagnosticItem } from '@arco/shared';
import { EmptyState } from './FilesTab';
import { FileViewerModal } from '../FileViewerModal';
import {
  formatTokens,
  formatBytes,
  formatAge,
  abbreviateToolInput,
  displayToolLabel,
  sameToolSummary,
  truncate,
  cacheUnreported,
} from './format';

// Live feed of the current turn's tool invocations + reasoning deltas. Feeds
// from JobState.activity which is populated by the primary_tool_use /
// primary_thinking WS events. Auto-scrolls to newest when pinned to bottom.
export function ActivityTab({ job }: { job: JobState }) {
  const entries = job.activity;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 24;
  };

  // Depend on the array reference, not the length: once the feed reaches
  // MAX_ACTIVITY_ENTRIES the length is pinned at the cap (slice(-N) keeps
  // it constant on every push), so a length-only dep silently stops firing
  // exactly when the feed is busiest. The store creates a fresh array on
  // every append, so this re-runs on each new event without overshooting.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const bgJobs = job.primaryBackgroundJobs ?? [];
  const turnUsage = job.turnTokenUsage ?? [];
  // A4 — per-turn checkpoint markers. Derived from the same historyEvents the
  // HISTORY tab reads (checkpoint_created / checkpoint_reverted), shown here as
  // a compact at-a-glance list so the operator sees snapshot points without
  // switching tabs. Revert actions live in HISTORY (selection-driven).
  const checkpoints = (job.historyEvents ?? []).filter((e) => e.category === 'checkpoint');
  // §C3 — LSP diagnostics, flattened to {file, item} rows. Errors first.
  const diagFiles = job.diagnosticsByFile ?? {};
  const diagFileNames = Object.keys(diagFiles).filter((f) => (diagFiles[f] ?? []).length > 0);
  const hasDiagnostics = diagFileNames.length > 0;
  // ULTRACODE_PLAN.md — background-fleet panel. Present only while/after an
  // ultracode turn fanned out subagents; the most-load-bearing surface here,
  // since the parent stream goes quiet during a fan-out.
  const fleet = job.ultracodeFleet;
  const hasFleet = !!fleet && fleet.total > 0;

  if (entries.length === 0 && bgJobs.length === 0 && turnUsage.length === 0 && checkpoints.length === 0 && !hasDiagnostics && !hasFleet) {
    return (
      <EmptyState
        text={
          job.busy
            ? 'Turn in flight — waiting for the first tool call or thinking delta…'
            : 'No activity yet. Tool invocations and reasoning snippets from the primary appear here while a turn is in flight.'
        }
      />
    );
  }

  // Coalesce consecutive thinking entries into a single block so the feed
  // isn't a wall of one-word-at-a-time rows. Tool uses stay as standalone
  // rows (one per invocation).
  const coalesced: ActivityEntry[] = [];
  for (const e of entries) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.kind === 'thinking' && e.kind === 'thinking') {
      coalesced[coalesced.length - 1] = {
        ...prev,
        text: (prev.text ?? '') + (e.text ?? ''),
        at: e.at,
      };
    } else if (prev && prev.kind === 'tool_use' && e.kind === 'tool_use' && sameToolSummary(prev, e)) {
      coalesced[coalesced.length - 1] = {
        ...e,
        text: String((Number(prev.text) || 1) + 1),
      };
    } else {
      coalesced.push(e);
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}
    >
      {hasFleet && <FleetSection fleet={fleet!} />}
      {hasDiagnostics && (
        <DiagnosticsSection
          diagFiles={diagFiles}
          fileNames={diagFileNames}
          cwd={job.config.workingDirectory}
          workflowId={job.id}
        />
      )}
      {checkpoints.length > 0 && <CheckpointsSection checkpoints={checkpoints} />}
      {turnUsage.length > 0 && <TokenUsageSection usage={turnUsage} />}
      {bgJobs.length > 0 && <BackgroundJobsSection jobs={bgJobs} />}
      {coalesced.map((e) => (
        <ActivityRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

// Per-turn token rows are collapsed by default: on a long-lived tab the list
// grows to TURN_TOKEN_USAGE_CAP (200) rows and pushes the live tool/thinking
// feed — the thing the tab is named after — entirely off-screen. The session
// summary above it is the at-a-glance number; the per-turn breakdown is a
// drill-down. Preference is global (not per-workflow): it's a reading habit,
// not workflow state.
const TOKEN_ROWS_KEY = 'arco.activity.tokenUsageRowsExpanded';

function loadTokenRowsExpanded(): boolean {
  try { return localStorage.getItem(TOKEN_ROWS_KEY) === '1'; } catch { return false; }
}

// Cap the expanded list so it scrolls internally instead of consuming the
// pane — expanding is a drill-down, not a takeover.
const TOKEN_ROWS_MAX_PX = 260;

// EFFICIENCY_PLAN.md Phase A — per-turn token telemetry. Sticky session
// header + one row per turn, capped at TURN_TOKEN_USAGE_CAP in the store.
// Token counts are API ground truth; thinking/tool fields are byte counts
// (deliberately labeled "B" / "KB" not "tk" to avoid claiming false token-
// precision). CLI/Codex transports report toolResultBytes=-1 (unknown);
// we render those as "—".
function TokenUsageSection({ usage }: { usage: PrimaryTurnTokenUsageMessage[] }) {
  const [expanded, setExpanded] = useState(loadTokenRowsExpanded);
  const session = useMemo(() => {
    let input = 0, output = 0, cacheRead = 0, cacheCreate = 0, lastPromptTokens = 0, thinkingBytes = 0, toolBytes = 0, serverToolBytes = 0, anyToolKnown = false;
    for (const u of usage) {
      input += u.input;
      output += u.output;
      cacheRead += u.cacheRead;
      cacheCreate += u.cacheCreate;
      lastPromptTokens += u.lastPromptTokens ?? 0;
      thinkingBytes += u.thinkingBytes;
      if (u.toolResultBytes >= 0) { toolBytes += u.toolResultBytes; anyToolKnown = true; }
      if ((u.serverToolResultBytes ?? 0) > 0) { serverToolBytes += u.serverToolResultBytes ?? 0; anyToolKnown = true; }
    }
    return { input, output, cacheRead, cacheCreate, lastPromptTokens, thinkingBytes, toolBytes, serverToolBytes, anyToolKnown };
  }, [usage]);

  const promptProcessed = session.input + session.cacheRead + session.cacheCreate;
  const cachedShare = promptProcessed > 0 ? Math.round((session.cacheRead / promptProcessed) * 100) : 0;
  const toolLine = formatToolByteSummary(session.toolBytes, session.serverToolBytes, session.anyToolKnown);
  const sessionCacheUnreported = usage.every((u) => cacheUnreported(u.provider));

  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={() => setExpanded((v) => {
          const next = !v;
          try { localStorage.setItem(TOKEN_ROWS_KEY, next ? '1' : '0'); } catch { /* no-op */ }
          return next;
        })}
        title={expanded ? 'Hide the per-turn breakdown' : 'Show the per-turn breakdown'}
        className="display-font"
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '2px 14px 6px', background: 'transparent', border: 'none',
          cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px',
          color: 'var(--color-fg-muted)', textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>TOKEN USAGE · {usage.length} turn{usage.length === 1 ? '' : 's'}</span>
      </button>
      <div
        style={{
          padding: '4px 14px 8px',
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg)',
          lineHeight: 1.5,
        }}
      >
        <div>
          Session · {formatTokens(promptProcessed)} prompt
          {session.cacheRead > 0 ? ` (${cachedShare}% cached)` : ''}
          {session.lastPromptTokens > 0 ? ` · ${formatTokens(session.lastPromptTokens)} ctx` : ''}
          {' · '}{formatTokens(session.output)} out
        </div>
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '2px' }}>
          {sessionCacheUnreported
            ? 'cache: not reported by daemon'
            : `${formatTokens(session.input)} fresh · ${formatTokens(session.cacheRead)} cache-read · ${formatTokens(session.cacheCreate)} cache-write`}
        </div>
        <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '2px' }}>
          thinking {formatBytes(session.thinkingBytes)} · tools {toolLine}
        </div>
      </div>
      {expanded && (
        <div style={{ maxHeight: `${TOKEN_ROWS_MAX_PX}px`, overflowY: 'auto' }}>
          {usage.slice().reverse().map((u, i) => (
            <TokenUsageRow key={`${u.turnStartedAt}-${i}`} usage={u} index={usage.length - i} />
          ))}
        </div>
      )}
      <div
        style={{
          height: '1px',
          margin: '8px 14px 4px',
          background: 'var(--color-border-hairline)',
        }}
      />
    </div>
  );
}

// §C3 — LSP diagnostics surface. A count badge (errors + warnings) plus an
// expandable per-file list. Clicking a diagnostic opens the file in a viewer
// (best-effort: the viewer doesn't yet scroll to the line — see docs/LSP.md
// "open-at-line gap"). Errors sort ahead of warnings within a file.
// Browser-side POSIX-ish join: absolutize a cwd-relative diagnostic path. If
// the path is already absolute (defensive) we pass it through.
function joinPath(cwd: string, rel: string): string {
  if (rel.startsWith('/')) return rel;
  return `${cwd.replace(/\/+$/, '')}/${rel}`;
}

const SEVERITY_RANK: Record<DiagnosticItem['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 };
const SEVERITY_COLOR: Record<DiagnosticItem['severity'], string> = {
  error: 'var(--color-danger)',
  warning: '#e0a030',
  info: 'var(--color-fg-muted)',
  hint: 'var(--color-fg-muted)',
};

function DiagnosticsSection({
  diagFiles,
  fileNames,
  cwd,
  workflowId,
}: {
  diagFiles: Record<string, DiagnosticItem[]>;
  fileNames: string[];
  cwd: string | undefined;
  workflowId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [openPath, setOpenPath] = useState<string | null>(null);

  let errorCount = 0;
  let warnCount = 0;
  for (const f of fileNames) {
    for (const d of diagFiles[f] ?? []) {
      if (d.severity === 'error') errorCount++;
      else if (d.severity === 'warning') warnCount++;
    }
  }

  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        data-help="rightpanel.activity.diagnostics"
        className="display-font"
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '2px 14px 6px', background: 'transparent', border: 'none',
          cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px',
          color: 'var(--color-fg-muted)', textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>DIAGNOSTICS</span>
        {errorCount > 0 && (
          <span style={{ color: 'var(--color-danger)' }}>· {errorCount} error{errorCount === 1 ? '' : 's'}</span>
        )}
        {warnCount > 0 && (
          <span style={{ color: SEVERITY_COLOR.warning }}>· {warnCount} warning{warnCount === 1 ? '' : 's'}</span>
        )}
      </button>
      {expanded && fileNames.sort().map((file) => {
        const items = (diagFiles[file] ?? []).slice().sort(
          (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line,
        );
        return (
          <div key={file} style={{ marginBottom: '4px' }}>
            <div style={{ padding: '2px 14px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', wordBreak: 'break-all' }}>
              {file}
            </div>
            {items.map((d, i) => (
              <button
                key={`${file}:${d.line}:${i}`}
                onClick={() => setOpenPath(file)}
                title={`Open ${file} (line ${d.line})`}
                style={{
                  display: 'flex', gap: '8px', alignItems: 'baseline', width: '100%',
                  padding: '3px 14px 3px 22px', background: 'transparent', border: 'none',
                  cursor: 'pointer', textAlign: 'left',
                  fontSize: '11px', fontFamily: 'var(--font-body)', color: 'var(--color-fg)', lineHeight: 1.4,
                }}
              >
                <span style={{ color: SEVERITY_COLOR[d.severity], fontVariantNumeric: 'tabular-nums', minWidth: '52px' }}>
                  {d.line}:{d.column ?? 1}
                </span>
                <span style={{ flex: 1, wordBreak: 'break-word' }}>
                  {d.message}
                  {d.code != null ? <span style={{ color: 'var(--color-fg-muted)' }}> ({d.code})</span> : null}
                </span>
              </button>
            ))}
          </div>
        );
      })}
      <div style={{ height: '1px', margin: '8px 14px 4px', background: 'var(--color-border-hairline)' }} />
      {openPath && cwd && (
        <FileViewerModal
          // Diagnostics carry a cwd-relative path; the file-content endpoint
          // resolves against the SERVER cwd, so absolutize against the
          // workflow cwd here. (No line-scroll yet — see docs/LSP.md open-at-
          // line gap.)
          path={joinPath(cwd, openPath)}
          onClose={() => setOpenPath(null)}
          fallback={{ cwd, workflowId }}
          editContext={{ cwd, workflowId }}
        />
      )}
    </div>
  );
}

// A4 — compact checkpoint marker list. Newest first. Read-only here; the
// HISTORY tab owns revert + view-diff (it has the selection model + dialogs).
// ULTRACODE_PLAN.md — live readout of an ultracode background fleet. The count
// strip answers "is it still going?"; the per-agent rows surface what each
// subagent is doing (its task label + most recent tool) — the activity the
// parent stream never shows. Running agents sort first so the active wave is
// always visible at the top.
function FleetSection({ fleet }: { fleet: NonNullable<JobState['ultracodeFleet']> }) {
  const ordered = fleet.agents
    .slice()
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'running' ? -1 : 1));
  const allDone = fleet.running === 0 && fleet.total > 0;
  return (
    <div style={{ marginBottom: '10px' }} data-help="rightpanel.activity.fleet">
      <div
        className="display-font"
        style={{
          padding: '2px 14px 6px',
          fontSize: '10px',
          letterSpacing: '1.5px',
          color: allDone ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
          display: 'flex',
          gap: '8px',
          alignItems: 'baseline',
        }}
      >
        <span>⚡ FLEET</span>
        <span style={{ color: 'var(--color-fg-muted)' }}>
          {fleet.done}/{fleet.total} done{fleet.running > 0 ? ` · ${fleet.running} running` : ''}
        </span>
      </div>
      {ordered.map((a) => (
        <div
          key={a.agentId}
          style={{
            padding: '3px 14px',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
            color: 'var(--color-fg)',
            display: 'flex',
            gap: '8px',
            alignItems: 'baseline',
          }}
        >
          <span
            style={{ color: a.status === 'running' ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)', minWidth: '10px' }}
            title={a.status}
          >
            {a.status === 'running' ? '◐' : '●'}
          </span>
          <span style={{ flex: 1, opacity: a.status === 'running' ? 1 : 0.7, wordBreak: 'break-word' }}>
            {a.label}
          </span>
          {a.lastTool && (
            <span
              className="display-font"
              style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-secondary)', opacity: 0.85 }}
            >
              {a.lastTool}
            </span>
          )}
        </div>
      ))}
      <div style={{ height: '1px', margin: '8px 14px 4px', background: 'var(--color-border-hairline)' }} />
    </div>
  );
}

// One checkpoint lands per turn, so a long-lived tab accumulates dozens and
// the list shoved the live tool/thinking feed off-screen. Cap it to a few
// rows with internal scroll, and let the operator collapse it entirely —
// same shape as the token-usage drill-down. Preference is global.
const CHECKPOINTS_COLLAPSED_KEY = 'arco.activity.checkpointsCollapsed';
const CHECKPOINTS_MAX_PX = 120;

function loadCheckpointsCollapsed(): boolean {
  try { return localStorage.getItem(CHECKPOINTS_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function CheckpointsSection({ checkpoints }: { checkpoints: HistoryEventEntry[] }) {
  const [collapsed, setCollapsed] = useState(loadCheckpointsCollapsed);
  const ordered = checkpoints.slice().sort((a, b) => b.seq - a.seq);
  return (
    <div style={{ marginBottom: '10px' }}>
      <button
        onClick={() => setCollapsed((v) => {
          const next = !v;
          try { localStorage.setItem(CHECKPOINTS_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* no-op */ }
          return next;
        })}
        title={collapsed ? 'Show checkpoints' : 'Hide checkpoints'}
        className="display-font"
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '2px 14px 6px', background: 'transparent', border: 'none',
          cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px',
          color: 'var(--color-fg-muted)', textAlign: 'left',
        }}
      >
        <span>{collapsed ? '▸' : '▾'}</span>
        <span>CHECKPOINTS · {checkpoints.length}</span>
      </button>
      {!collapsed && (
        <div style={{ maxHeight: `${CHECKPOINTS_MAX_PX}px`, overflowY: 'auto' }}>
          {ordered.map((c) => (
            <div
              key={c.seq}
              style={{
                padding: '3px 14px',
                fontSize: '11px',
                fontFamily: 'var(--font-body)',
                color: 'var(--color-fg)',
                display: 'flex',
                gap: '8px',
                alignItems: 'baseline',
              }}
            >
              <span style={{ color: c.reverted ? 'var(--color-danger)' : '#4dd0e1' }}>
                {c.reverted ? '↩' : '●'}
              </span>
              <span style={{ color: 'var(--color-fg-muted)', fontSize: '10px' }}>
                {c.label}
              </span>
              <span style={{ flex: 1, opacity: 0.85, wordBreak: 'break-word' }}>{c.summary}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ height: '1px', margin: '8px 14px 4px', background: 'var(--color-border-hairline)' }} />
    </div>
  );
}

function TokenUsageRow({ usage, index }: { usage: PrimaryTurnTokenUsageMessage; index: number }) {
  const transportLabel = usage.transport ? ` · ${usage.transport}` : '';
  const promptProcessed = usage.input + usage.cacheRead + usage.cacheCreate;
  const cachedShare = promptProcessed > 0
    ? Math.round((usage.cacheRead / promptProcessed) * 100)
    : 0;
  const toolLine = formatToolByteSummary(usage.toolResultBytes, usage.serverToolResultBytes ?? 0, usage.toolResultBytes >= 0 || (usage.serverToolResultBytes ?? 0) > 0);
  return (
    <div
      style={{
        padding: '3px 14px',
        fontSize: '11px',
        fontFamily: 'var(--font-body)',
        color: 'var(--color-fg)',
        lineHeight: 1.4,
      }}
      title={`${usage.provider}${transportLabel} · ${new Date(usage.turnStartedAt).toLocaleTimeString()}`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ color: 'var(--color-fg-muted)', fontVariantNumeric: 'tabular-nums' }}>#{index}</span>
        <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {usage.lastPromptTokens ? `${formatTokens(usage.lastPromptTokens)} ctx · ` : ''}
          {formatTokens(promptProcessed)} prompt
          {usage.cacheRead > 0 ? ` · ${cachedShare}% cached` : ''}
          {' · '}{formatTokens(usage.output)} out
        </span>
      </div>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '1px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {cacheUnreported(usage.provider)
          ? 'cache: not reported by daemon'
          : `${formatTokens(usage.input)} fresh · ${formatTokens(usage.cacheRead)} cache-read · ${formatTokens(usage.cacheCreate)} cache-write`}
      </div>
      <div style={{ color: 'var(--color-fg-muted)', fontSize: '10px', marginTop: '1px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        thinking {usage.thinkingBytes > 0 ? formatBytes(usage.thinkingBytes) : '—'}
        {' · '}tools {toolLine}
      </div>
    </div>
  );
}

function formatToolByteSummary(localBytes: number, serverBytes: number, known: boolean): string {
  if (!known) return '—';
  const local = localBytes >= 0 ? localBytes : 0;
  const total = local + serverBytes;
  if (serverBytes > 0) return `${formatBytes(total)} (${formatBytes(serverBytes)} server)`;
  return localBytes >= 0 ? formatBytes(localBytes) : '—';
}

// Long-running children the primary spawned (Bash with run_in_background, or
// any descendant that outlived its turn). Persists across turns until the
// process exits + a short linger window. Rendered above the per-turn feed
// so the operator notices it without scrolling.
function BackgroundJobsSection({ jobs }: { jobs: PrimaryBackgroundJob[] }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <div
        className="display-font"
        style={{
          padding: '2px 14px 6px',
          fontSize: '10px',
          letterSpacing: '1.5px',
          color: 'var(--color-fg-muted)',
        }}
      >
        BACKGROUND · {jobs.length}
      </div>
      {jobs.map((job) => (
        <BackgroundJobRow key={job.id} job={job} />
      ))}
      <div
        style={{
          height: '1px',
          margin: '8px 14px 4px',
          background: 'var(--color-border-hairline)',
        }}
      />
    </div>
  );
}

function BackgroundJobRow({ job }: { job: PrimaryBackgroundJob }) {
  // Keep the age counter ticking even when the server hasn't pushed a new
  // snapshot yet — otherwise a 60s-between-polls feed looks frozen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!job.alive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job.alive]);
  const ageMs = job.alive ? (now - job.startedAt) : job.ageMs;

  const accent = job.alive ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)';
  const pulseColor = job.cpuActive ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)';
  return (
    <div
      style={{
        padding: '5px 14px',
        fontSize: '11px',
        fontFamily: 'var(--font-body)',
        color: accent,
        lineHeight: 1.4,
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-start',
        opacity: job.alive ? 1 : 0.55,
      }}
      title={`pid ${job.pid} · ${job.command}`}
    >
      <span
        style={{
          flex: '0 0 8px',
          width: '8px',
          height: '8px',
          marginTop: '4px',
          borderRadius: '50%',
          background: job.alive ? pulseColor : 'transparent',
          border: job.alive ? 'none' : `1px solid ${accent}`,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textDecoration: job.alive ? 'none' : 'line-through',
          }}
        >
          {job.command}
        </div>
        <div
          className="display-font"
          style={{
            fontSize: '9px',
            letterSpacing: '1px',
            color: 'var(--color-fg-muted)',
            marginTop: '2px',
          }}
        >
          {job.alive ? 'LIVE' : 'DONE'} · PID {job.pid} · {formatBytes(job.rssBytes)} · {formatAge(ageMs)}
          {job.cpuActive && job.alive ? ' · CPU' : ''}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'native_event') {
    return (
      <div
        style={{
          padding: '5px 14px',
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-fg-muted)',
          lineHeight: 1.4,
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-start',
        }}
      >
        <span
          className="display-font"
          style={{
            fontSize: '9px',
            letterSpacing: '1.5px',
            color: 'var(--color-fg-muted)',
            minWidth: '48px',
            paddingTop: '2px',
          }}
        >
          {entry.tool ?? 'NATIVE'}
        </span>
        <span style={{ flex: 1, color: 'var(--color-fg-muted)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
          {entry.text}
        </span>
      </div>
    );
  }

  if (entry.kind === 'tool_use') {
    const label = displayToolLabel(entry.tool);
    return (
      <div
        style={{
          padding: '5px 14px',
          fontSize: '11px',
          fontFamily: 'var(--font-body)',
          color: 'var(--color-accent-primary)',
          lineHeight: 1.4,
          display: 'flex',
          gap: '8px',
          alignItems: 'flex-start',
        }}
      >
        <span
          className="display-font"
          style={{
            fontSize: '9px',
            letterSpacing: '1.5px',
            color: 'var(--color-accent-secondary)',
            minWidth: '48px',
            paddingTop: '2px',
          }}
        >
          {label}
          {entry.status && entry.status !== 'completed' ? ` · ${entry.status.toUpperCase()}` : ''}
        </span>
        <span style={{ flex: 1, color: 'var(--color-fg-muted)', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
          {abbreviateToolInput(entry.tool, entry.input)}
          {entry.text ? ` ×${entry.text}` : ''}
          {typeof entry.exitCode === 'number' && entry.exitCode !== 0 ? ` · exit ${entry.exitCode}` : ''}
          {entry.output ? `\n↳ ${truncate(entry.output.replace(/\s+/g, ' ').trim(), 240)}` : ''}
        </span>
      </div>
    );
  }

  const snippet = (entry.text ?? '').trim();
  if (!snippet) return null;
  return (
    <div
      data-help="chat.message.thinking"
      style={{
        padding: '5px 14px 5px 74px',
        fontSize: '11px',
        fontFamily: 'var(--font-body)',
        fontStyle: 'italic',
        color: 'var(--color-fg-muted)',
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {snippet}
    </div>
  );
}
