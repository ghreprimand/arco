// H42 part B — shutdown forensics line (BORROWED_IMPROVEMENTS_EXECUTION.md Phase 2).
//
// When systemd (or a Ctrl-C) stops the server, every in-flight turn dies mid-
// flight: the SIGTERM→SIGKILL reap in onSignal kills the detached worker process
// groups, and any running Anthropic/Codex turn is truncated. Today that loss is
// invisible — the log just ends. This emits ONE structured line on the way down
// capturing what the stop actually truncated: how many turns were live (by
// provider), the reap tally, PTY sessions, RSS, and uptime.
//
// Deliberately a single server-log line, NOT per-workflow events: we're inside
// the ~100 ms flush budget before process.exit, the WS is already closing, and a
// burst of per-workflow broadcasts would race the flush and may never reach a
// client whose socket is tearing down. The operator greps this line out of the
// log file (it rides the file-logging tee like the H46 mem lines) to answer
// "what was running when it went down?" after the fact.
//
// Part A (the diagnostics probe in shutdownWindow.ts) checks the stop *budget*;
// part B records what happened *within* it. Pure formatter here is unit-tested;
// the gather + emit lives in index.ts onSignal.

export interface ShutdownForensics {
  signal: string;
  uptimeSec: number;
  rssBytes: number;
  // Reap outcomes for the durable worker-PID registry (start-time-verified).
  reaped: { killed: number; reused: number; gone: number };
  // Turns that were still spawning/running when the stop arrived — the truncated
  // work. busyByProvider breaks it down (claude-native:1, codex:1) when non-empty.
  inflightTurns: number;
  busyByProvider?: Record<string, number>;
  ptySessions: number;
  flushBudgetMs: number;
}

const MB = 1024 * 1024;
const mb = (n: number): string => `${(n / MB).toFixed(1)}MB`;

// Compact human duration: "3h12m", "45m", "8s". Trend-readable, not precise.
export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

// Pure formatter (unit-tested). Renders the single forensics line.
export function formatShutdownForensics(f: ShutdownForensics): string {
  const parts = [
    `signal=${f.signal}`,
    `uptime=${formatUptime(f.uptimeSec)}`,
    `rss=${mb(f.rssBytes)}`,
  ];

  // In-flight turns are the headline — what got truncated. Annotate the
  // provider breakdown only when there's something to show.
  const byProvider = f.busyByProvider ?? {};
  const breakdown = Object.keys(byProvider)
    .sort()
    .map((p) => `${p}:${byProvider[p]}`)
    .join(',');
  parts.push(`inflight-turns=${f.inflightTurns}${breakdown ? `(${breakdown})` : ''}`);

  parts.push(
    `reaped=${f.reaped.killed + f.reaped.reused + f.reaped.gone}` +
      `(killed=${f.reaped.killed} reused=${f.reaped.reused} gone=${f.reaped.gone})`,
  );
  parts.push(`pty=${f.ptySessions}`);
  parts.push(`flush-budget=${f.flushBudgetMs}ms`);

  return `[archon][shutdown] ${parts.join(' ')}`;
}
